/**
 * Tier change service — single chokepoint for "user moved between tiers".
 *
 * Two callers feed this:
 *   1. Stripe webhook (subscription.created / .updated / .deleted)
 *   2. Token snapshot watcher cron (wallet balance crossed a threshold)
 *
 * What it does, per call:
 *   1. Update `hermes_instances.resource_tier` for every instance owned by the
 *      user (DB write).
 *   2. Resolve each instance's TARGET SIZE against the new tier (see
 *      resolveTargetSize below) and write it.
 *   3. For each instance, kick a live VM resize to that target (Proxmox
 *      `qm set --cpulimit X --memory Y`). Hetzner instances are a separate,
 *      more disruptive code path (full container recreate); MVP defers
 *      Hetzner live resize to next provisioning.
 *
 * `resource_tier` is the ENTITLEMENT LABEL and is uniform across the user's
 * instances. cpu_limit/ram_limit are the box's ACTUAL SIZE and are per-row —
 * they are NOT the same thing, and conflating them is what this service used
 * to get wrong. See resolveTargetSize for why.
 *
 * Why one service instead of inline-in-each-caller: the resize path has
 * real moving parts (SSH to Proxmox host, error handling, partial-failure
 * recovery). Centralizing keeps both webhook and cron consistent and
 * avoids drift.
 */

import "server-only";

import { supabaseAdmin } from "@/lib/supabase";
import {
  resolveEffectiveTierSpec,
  resolveTierProvisioningLimits,
  type TierKey,
} from "@/lib/services/tier-specs";
import {
  getProxmoxHostRoutingConfigFromInfrastructure,
  type ProxmoxInfrastructure,
} from "@/lib/services/proxmox-infrastructure";
import { resizeProxmoxVm } from "@/lib/services/proxmox-instance-service";
import { priorityToCpuUnits } from "@/lib/proxmox/cpu-priority";
import { priorityForResourceTier } from "@/lib/subscription/agent-slots";
import { isVeniceBoostEligible } from "@/lib/billing/venice-compute-boost";
import { log } from "@/lib/logger";

const LOG_SOURCE = "tier-change-service";

export interface ApplyTierChangeParams {
  userId: string;
  /** New canonical tier key. */
  newTier: TierKey;
  /** Where the change came from — used for audit logging. */
  source: "stripe" | "token_snapshot" | "manual" | "apple_iap";
  /** Optional human-readable note (e.g. "operator plan via Stripe checkout"). */
  reason?: string;
  /**
   * Whether the user currently earns the Venice compute boost (holds ≥ $199
   * of VVV). When omitted, applyTierChange self-resolves it from the
   * persisted qualification — so every caller (Stripe webhook, "fix my caps"
   * resize) gets correct boost behavior without threading it through. The
   * cron passes it explicitly to avoid a per-user round-trip. The boost only
   * takes effect on paid tiers (see resolveEffectiveTierSpec).
   */
  veniceBoost?: boolean;
}

export interface TierChangeOutcome {
  userId: string;
  newTier: TierKey;
  instancesUpdated: number;
  resizesAttempted: number;
  resizesSucceeded: number;
  resizesFailed: Array<{ instanceId: string; error: string }>;
}

interface InstanceRow {
  id: string;
  config: { infrastructure?: Partial<ProxmoxInfrastructure> } | null;
  hetzner_server_id: number | null;
  cpu_limit: number | null;
  ram_limit: number | null;
  resource_tier: string | null;
  gateway_url: string | null;
  host_id: string | null;
}

interface TargetSize {
  cpu: number;
  ramMb: number;
}

/**
 * Resolve the size each instance should end up at for the new tier.
 *
 * Why this isn't just "write the tier spec to every row": a plan is a COMPUTE
 * POOL the user splits across their agents (see lib/subscription/plans.ts).
 * On every plan `totalCpu === maxCpuPerAgent` while `maxAgents` is 3/5/8, so
 * only a single-agent user can sit at the per-agent cap — anyone running two
 * or more MUST be below it. Stamping spec.cpuLimit/spec.ramLimitMb onto every
 * row therefore handed each agent the full pool: a Power user with 3 agents
 * came out of any tier event allocated 12 vCPU against the 4 they pay for,
 * and it silently overwrote whatever split they had chosen. The create path
 * and the per-instance PATCH both honour sub-cap sizes (PATCH explicitly
 * grandfathers shrinking); this path was the odd one out.
 *
 * Rule (product intent confirmed with Ash 2026-08-04) — clamp down, and grow
 * only when growth is unambiguous:
 *
 *   - ONE instance  → snap to the full tier spec. With a single agent there is
 *     exactly one way to fill the pool, so an upgrade still does the thing the
 *     user paid for ("my box got bigger") with no risk of overcommit.
 *   - TWO OR MORE   → clamp DOWN only. A downgrade still shrinks anything over
 *     the new per-agent cap, but we never raise a size, because re-splitting a
 *     bigger pool across N agents has no single correct answer and guessing
 *     would clobber a deliberate choice.
 *
 * A null cpu_limit/ram_limit means the row never recorded a size; adopt the
 * spec rather than leaving the VM unsized.
 *
 * NOTE: this clamps to the PER-AGENT cap, not to the pool. A user already
 * over-pooled by the old flatten behaviour is not silently re-split here —
 * shrinking a running agent's RAM out from under it is a destructive call that
 * wants a human. Such a user is logged loudly instead (see the overcommit
 * warning in applyTierChange).
 */
function resolveTargetSize(
  row: InstanceRow,
  spec: { cpuLimit: number; ramLimitMb: number },
  instanceCount: number
): TargetSize {
  if (instanceCount === 1) {
    return { cpu: spec.cpuLimit, ramMb: spec.ramLimitMb };
  }
  return {
    cpu: Math.min(row.cpu_limit ?? spec.cpuLimit, spec.cpuLimit),
    ramMb: Math.min(row.ram_limit ?? spec.ramLimitMb, spec.ramLimitMb),
  };
}

export async function applyTierChange(
  params: ApplyTierChangeParams
): Promise<TierChangeOutcome> {
  if (!supabaseAdmin) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY not configured");
  }

  // Self-resolve the Venice boost when the caller didn't pass it, so the
  // Stripe webhook and the resize route apply/drop it correctly. The boost
  // only stacks on paid tiers — resolveEffectiveTierSpec enforces that.
  // Best-effort: a boost-table read hiccup must never fail a tier change, so
  // an error degrades to "no boost" rather than throwing.
  let veniceBoost = params.veniceBoost;
  if (veniceBoost === undefined) {
    try {
      veniceBoost = await isVeniceBoostEligible(params.userId);
    } catch {
      veniceBoost = false;
    }
  }
  const spec = resolveEffectiveTierSpec(params.newTier, veniceBoost);
  const outcome: TierChangeOutcome = {
    userId: params.userId,
    newTier: params.newTier,
    instancesUpdated: 0,
    resizesAttempted: 0,
    resizesSucceeded: 0,
    resizesFailed: [],
  };

  // 1. Find all instances owned by this user that aren't deleted/scheduled
  const { data: instances, error: listErr } = await supabaseAdmin
    .from("hermes_instances")
    .select("id, config, hetzner_server_id, host_id, cpu_limit, ram_limit, resource_tier, gateway_url")
    .eq("user_id", params.userId)
    .not("status", "in", '("deleted","scheduled_for_deletion")');

  if (listErr) {
    throw new Error(`Failed to list user instances: ${listErr.message}`);
  }

  const rows = (instances || []) as InstanceRow[];
  if (rows.length === 0) {
    log.info("no active instances, no-op", {
      source: LOG_SOURCE,
      userId: params.userId,
      newTier: params.newTier,
      tierChangeSource: params.source,
    });
    return outcome;
  }

  // 2. Resolve each row's target size, then write.
  //
  //    The entitlement label (resource_tier) is uniform and goes to every row
  //    in one atomic write, so the user is never left half-tiered. Sizes are
  //    per-row, so they're written grouped by identical target — when every
  //    row lands on the same size (the common case: a single instance) that
  //    collapses back into the one base write it has always been.
  //
  //    Every write here throws on failure so the Stripe webhook retries; the
  //    tier write is load-bearing for billing/delivery correctness. Retry is
  //    safe because resolveTargetSize is idempotent — clamping only ever moves
  //    a row toward its target, never past it.
  const targets = new Map<string, TargetSize>(
    rows.map((r) => [r.id, resolveTargetSize(r, spec, rows.length)])
  );

  const sizeGroups = new Map<string, { size: TargetSize; rowIds: string[] }>();
  for (const row of rows) {
    const target = targets.get(row.id)!;
    const key = `${target.cpu}:${target.ramMb}`;
    const group = sizeGroups.get(key);
    if (group) group.rowIds.push(row.id);
    else sizeGroups.set(key, { size: target, rowIds: [row.id] });
  }

  const updatedAt = new Date().toISOString();
  const uniformSize =
    sizeGroups.size === 1 ? [...sizeGroups.values()][0].size : null;

  const baseUpdate = {
    resource_tier: params.newTier,
    ...(uniformSize
      ? { cpu_limit: uniformSize.cpu, ram_limit: uniformSize.ramMb }
      : {}),
    updated_at: updatedAt,
  };

  const { error: updateErr } = await supabaseAdmin
    .from("hermes_instances")
    .update(baseUpdate)
    .eq("user_id", params.userId)
    .in("id", rows.map((r) => r.id));

  if (updateErr) {
    throw new Error(`Failed to write new tier: ${updateErr.message}`);
  }

  // Mixed sizes: one follow-up write per distinct target. Skipped entirely
  // when the base write already carried a uniform size.
  if (!uniformSize) {
    for (const { size, rowIds } of sizeGroups.values()) {
      const { error: sizeErr } = await supabaseAdmin
        .from("hermes_instances")
        .update({ cpu_limit: size.cpu, ram_limit: size.ramMb, updated_at: updatedAt })
        .eq("user_id", params.userId)
        .in("id", rowIds);
      if (sizeErr) {
        throw new Error(`Failed to write instance sizes: ${sizeErr.message}`);
      }
    }
  }
  outcome.instancesUpdated = rows.length;

  // Surface — but do not silently "fix" — a user whose total allocation sits
  // above their plan pool. The usual cause is the old flatten behaviour having
  // already over-allocated them; re-splitting a running fleet is a human call.
  const limits = resolveTierProvisioningLimits(params.newTier);
  const allocatedCpu = rows.reduce((acc, r) => acc + targets.get(r.id)!.cpu, 0);
  const allocatedRamMb = rows.reduce((acc, r) => acc + targets.get(r.id)!.ramMb, 0);
  if (allocatedCpu > limits.totalCpu || allocatedRamMb > limits.totalRam) {
    log.warn("user allocation exceeds plan pool after tier change", {
      source: LOG_SOURCE,
      failureType: "tier_change_pool_overcommit",
      userId: params.userId,
      newTier: params.newTier,
      instanceCount: rows.length,
      allocatedCpu,
      allocatedRamMb,
      poolCpu: limits.totalCpu,
      poolRamMb: limits.totalRam,
    });
  }

  // 2b. Raise tier_change_pending on every instance whose per-container caps
  //     ACTUALLY changed — BOTH backends. The CPU/RAM limits are baked into
  //     the container's compose (`deploy.resources.limits`), so even a Proxmox
  //     VM (whose VM-level ceiling is raised live by the qm-set in step 3)
  //     still needs a volume-safe container redeploy to pick up the new cgroup
  //     limits — otherwise the extra compute (e.g. the Venice boost) never
  //     reaches the agent. The instant unlock flow and the apply-pending-resizes
  //     cron consume this flag (run applyLiveUpdate, then clear it).
  //
  //     Only flag rows whose caps differ from what they already had, so a
  //     steady-state re-apply (same tier, same boost) doesn't trigger a
  //     needless container restart. NON-FATAL: a failed flag just means the
  //     redeploy waits for the next fleet sync.
  const capsChangedRowIds = rows
    .filter((r) => {
      const target = targets.get(r.id)!;
      return r.cpu_limit !== target.cpu || r.ram_limit !== target.ramMb;
    })
    .map((r) => r.id);

  if (capsChangedRowIds.length > 0) {
    const { error: flagErr } = await supabaseAdmin
      .from("hermes_instances")
      .update({ tier_change_pending: true })
      .eq("user_id", params.userId)
      .in("id", capsChangedRowIds);
    if (flagErr) {
      log.error("failed to raise tier_change_pending", flagErr, {
        source: LOG_SOURCE,
        failureType: "tier_change_pending_flag_failed",
        userId: params.userId,
        affectedInstanceCount: capsChangedRowIds.length,
      });
    }
  }

  // 3. For Proxmox-backed instances, kick a live VM resize. Hetzner
  //    instances would need a docker-compose recreate (drops in-flight chats);
  //    MVP defers that path — they pick up new caps on next provision.
  for (const row of rows) {
    const provider = row.config?.infrastructure?.provider;
    const vmid = row.config?.infrastructure?.vmid;
    if (provider === "proxmox" && typeof vmid === "number") {
      const target = targets.get(row.id)!;
      outcome.resizesAttempted += 1;
      try {
        const result = await resizeProxmoxVm({
          vmid,
          node: row.config?.infrastructure?.node,
          cpuLimit: target.cpu,
          memoryMb: target.ramMb,
          cpuUnits: priorityToCpuUnits(priorityForResourceTier(params.newTier)),
        }, {
          hostConfig: getProxmoxHostRoutingConfigFromInfrastructure(row.config?.infrastructure, {
            host_id: row.host_id ?? null,
          }),
        });
        if (!result.ok) {
          throw new Error("Proxmox resize failed");
        }
        outcome.resizesSucceeded += 1;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        outcome.resizesFailed.push({ instanceId: row.id, error: msg });
        log.error("resize failed", err, {
          source: LOG_SOURCE,
          failureType: "tier_change_resize_failed",
          userId: params.userId,
          instanceId: row.id,
          vmid,
          newTier: params.newTier,
        });
      }
    }
  }

  log.info("tier change applied", {
    source: LOG_SOURCE,
    userId: params.userId,
    newTier: params.newTier,
    veniceBoost,
    // The per-agent CAP for this tier…
    effectiveCpuLimit: spec.cpuLimit,
    effectiveRamLimitMb: spec.ramLimitMb,
    // …and what was actually allocated across the user's instances, which
    // only equals the cap × instanceCount for a single-instance user.
    allocatedCpu,
    allocatedRamMb,
    sizesResized: capsChangedRowIds.length,
    tierChangeSource: params.source,
    reason: params.reason || "",
    instancesUpdated: outcome.instancesUpdated,
    resizesSucceeded: outcome.resizesSucceeded,
    resizesAttempted: outcome.resizesAttempted,
  });

  return outcome;
}
