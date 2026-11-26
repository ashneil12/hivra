/**
 * Tier change service — single chokepoint for "user moved between tiers".
 *
 * Two callers feed this:
 *   1. Stripe webhook (subscription.created / .updated / .deleted)
 *   2. Token snapshot watcher cron (wallet balance crossed a threshold)
 *
 * What it does, per call:
 *   1. Update `hermes_instances.resource_tier` for every instance owned by the
 *      user in the affected funding cohort (DB write).
 *   2. Resolve each instance's TARGET SIZE against the new tier (see
 *      resolveTargetSize below) and write it.
 *   3. For each instance, kick a live VM resize to that target (Proxmox
 *      `qm set --cpulimit X --memory Y`). Hetzner instances are a separate,
 *      more disruptive code path (full container recreate); MVP defers
 *      Hetzner live resize to next provisioning.
 *
 * `resource_tier` is the ENTITLEMENT LABEL and is uniform within the funding
 * cohort. cpu_limit/ram_limit are the box's ACTUAL SIZE and are per-row —
 * they are NOT the same thing, and conflating them is what this service used
 * to get wrong. See resolveTargetSize for why.
 *
 * Why one service instead of inline-in-each-caller: the resize path has
 * real moving parts (SSH to Proxmox host, error handling, partial-failure
 * recovery). Centralizing keeps both webhook and cron consistent and
 * avoids drift.
 */

import "server-only";

import { randomUUID } from "crypto";

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
import {
  PROXMOX_RESIZE_VM_CONFIG_APPLIED_MARKER,
  isProxmoxResizeOutcomeIndeterminateConservative,
  resizeProxmoxVm,
} from "@/lib/services/proxmox-instance-service";
import { priorityToCpuUnits } from "@/lib/proxmox/cpu-priority";
import { proxmoxPlacementRpcPolicy } from "@/lib/proxmox/placement-policy";
import { priorityForResourceTier } from "@/lib/subscription/agent-slots";
import { isVeniceBoostEligible } from "@/lib/billing/venice-compute-boost";
import { log } from "@/lib/logger";
import {
  blocksInstanceLiveMutation,
  readInstanceLiveMutationBlock,
  type InstanceLiveMutationState,
} from "./instance-live-mutation";

const LOG_SOURCE = "tier-change-service";

export interface ApplyTierChangeParams {
  userId: string;
  /** New canonical tier key. */
  newTier: TierKey;
  /** Where the change came from — used for audit logging. */
  source: "stripe" | "token_snapshot" | "manual" | "apple_iap" | "token_yearly";
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
  /** Token admissions own their cohort separately from account-wide paid changes. */
  holderSeats?: boolean;
}

export interface TierChangeOutcome {
  userId: string;
  newTier: TierKey;
  instancesUpdated: number;
  resizesAttempted: number;
  resizesSucceeded: number;
  resizesFailed: Array<{ instanceId: string; error: string }>;
}

interface InstanceRow extends InstanceLiveMutationState {
  id: string;
  config: { infrastructure?: Partial<ProxmoxInfrastructure> } | null;
  hetzner_server_id: number | null;
  proxmox_node: string | null;
  resize_operation_id: string | null;
  resize_target_cpu: number | null;
  resize_target_ram_mb: number | null;
  cpu_limit: number | null;
  ram_limit: number | null;
  resource_tier: string | null;
  seat_funding: string | null;
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
  singleAllocation: boolean
): TargetSize {
  if (singleAllocation) {
    return { cpu: spec.cpuLimit, ramMb: spec.ramLimitMb };
  }
  return {
    cpu: Math.min(row.cpu_limit ?? spec.cpuLimit, spec.cpuLimit),
    ramMb: Math.min(row.ram_limit ?? spec.ramLimitMb, spec.ramLimitMb),
  };
}

function resizeOperationIdForTarget(row: InstanceRow, target: TargetSize): string {
  if (
    row.resize_operation_id
    && row.resize_target_cpu != null
    && row.resize_target_ram_mb != null
    && Number(row.resize_target_cpu) === target.cpu
    && Number(row.resize_target_ram_mb) === target.ramMb
  ) {
    return row.resize_operation_id;
  }
  return randomUUID();
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
  let veniceBoost = params.holderSeats ? false : params.veniceBoost;
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
    .select("id, config, hetzner_server_id, host_id, proxmox_node, resize_operation_id, resize_target_cpu, resize_target_ram_mb, cpu_limit, ram_limit, resource_tier, seat_funding, gateway_url, status, lifecycle_state, archive_uri, archive_sha256, proxmox_vmid")
    .eq("user_id", params.userId)
    .not("status", "in", '("deleted","scheduled_for_deletion")');

  if (listErr) {
    throw new Error(`Failed to list user instances: ${listErr.message}`);
  }

  const rows = ((instances || []) as InstanceRow[]).filter(
    (row) => (row.seat_funding === "holder") === Boolean(params.holderSeats)
  );
  if (rows.length === 0) {
    log.info("no active instances, no-op", {
      source: LOG_SOURCE,
      userId: params.userId,
      newTier: params.newTier,
      tierChangeSource: params.source,
    });
    return outcome;
  }

  let singleAllocation = rows.length === 1;
  if (params.holderSeats && singleAllocation
    && ((rows[0].cpu_limit ?? 0) < spec.cpuLimit || (rows[0].ram_limit ?? 0) < spec.ramLimitMb)) {
    // The holder pool spans Hermes and Hivra. A lone Hermes row sharing
    // with a stopped computer or an in-flight claim is still a split pool.
    const { data, error } = await supabaseAdmin.rpc("holder_admission_existing_usage", {
      p_user_id: params.userId, p_exclude_hermes_instance_id: rows[0].id,
    });
    const other = data?.[0];
    if (error || other?.cpu == null || other?.ram_mb == null) {
      throw new Error("Could not verify other token-holder allocations.");
    }
    singleAllocation = Number(other.cpu) === 0 && Number(other.ram_mb) === 0;
  }
  const targets = new Map<string, TargetSize>(
    rows.map((r) => [r.id, resolveTargetSize(r, spec, singleAllocation)])
  );

  // Commit the whole cohort and its pending container resizes together. An
  // allocation changed by a concurrent worker invalidates the entire batch.
  const changes = rows.map(row => {
    const target = targets.get(row.id)!;
    return {
      id: row.id,
      previous_tier: row.resource_tier ?? null,
      previous_cpu: row.cpu_limit,
      previous_ram: row.ram_limit,
      cpu_limit: target.cpu,
      ram_limit: target.ramMb,
      operation_id: resizeOperationIdForTarget(row, target),
    };
  });
  const { data: written, error } = await supabaseAdmin.rpc("apply_hermes_tier_allocations", {
    p_owner: params.userId,
    p_holder: Boolean(params.holderSeats),
    p_tier: params.newTier,
    p_changes: changes,
    ...proxmoxPlacementRpcPolicy(process.env),
  });
  if (error || written !== rows.length) {
    throw new Error(`Failed to write new tier: ${error?.message ?? "allocation changed"}`);
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

  // A cold-storage transition may have happened while the tier writes ran.
  // Never resize a missing guest or one owned by another lifecycle operation.
  const liveRowIds = new Set<string>();
  for (const row of rows) {
    // Proxmox topology changes can restart a guest. Keep a paused holder offline.
    if (params.holderSeats && (row.status !== "running" || row.lifecycle_state !== "active")) continue;
    if (!blocksInstanceLiveMutation(row)
      && !(await readInstanceLiveMutationBlock(supabaseAdmin, row.id, row))) {
      liveRowIds.add(row.id);
    }
  }
  const capsChangedRowIds = rows
    .filter((r) => {
      if (r.lifecycle_state === "deleting" || r.lifecycle_state === "deleted") return false;
      const target = targets.get(r.id)!;
      return r.cpu_limit !== target.cpu || r.ram_limit !== target.ramMb;
    })
    .map((r) => r.id);

  // 3. For Proxmox-backed instances, kick a live VM resize. Hetzner
  //    instances would need a docker-compose recreate (drops in-flight chats);
  //    MVP defers that path — they pick up new caps on next provision.
  for (const row of rows) {
    if (!liveRowIds.has(row.id)) continue;
    const provider = row.config?.infrastructure?.provider;
    const vmid = row.config?.infrastructure?.vmid;
    if (provider === "proxmox" && typeof vmid === "number") {
      const target = targets.get(row.id)!;
      const resizeOperationId =
        changes.find((change) => change.id === row.id)?.operation_id ?? null;
      const allocationFenced =
        Boolean(row.proxmox_node)
        && (row.lifecycle_state === "provisioning" || row.lifecycle_state === "active")
        && (row.cpu_limit !== target.cpu || row.ram_limit !== target.ramMb || row.resize_operation_id === resizeOperationId);
      const resizeClaim = resizeOperationId && allocationFenced
        ? { operationId: resizeOperationId, cpu: target.cpu, ramMb: target.ramMb }
        : undefined;
      if (await readInstanceLiveMutationBlock(
        supabaseAdmin,
        row.id,
        row,
        params.holderSeats ? target : undefined,
        resizeClaim
      )) continue;
      outcome.resizesAttempted += 1;
      try {
        const result = await resizeProxmoxVm({
          vmid,
          expectedInstanceId: row.id,
          node: row.config?.infrastructure?.node,
          cpuLimit: target.cpu,
          memoryMb: target.ramMb,
          cpuUnits: priorityToCpuUnits(priorityForResourceTier(params.newTier)),
        }, {
          hostConfig: getProxmoxHostRoutingConfigFromInfrastructure(row.config?.infrastructure, {
            host_id: row.host_id ?? null,
          }),
        });
        const vmConfigApplied = result.ok || (result.stdout ?? "").includes(PROXMOX_RESIZE_VM_CONFIG_APPLIED_MARKER);
        if (resizeOperationId && allocationFenced) {
          if (vmConfigApplied) {
            const { data: completed, error: completionError } = await supabaseAdmin.rpc(
              "complete_hermes_instance_resize_allocation",
              { p_instance_id: row.id, p_user_id: params.userId, p_operation_id: resizeOperationId }
            );
            if (completionError || completed !== true) {
              throw new Error(`Proxmox resize applied, but allocation completion failed: ${completionError?.message ?? "resize operation fence mismatch"}`);
            }
          } else if (!isProxmoxResizeOutcomeIndeterminateConservative(result)) {
            const { data: rolledBack, error: rollbackError } = await supabaseAdmin.rpc(
              "rollback_hermes_instance_resize_allocation",
              { p_instance_id: row.id, p_user_id: params.userId, p_operation_id: resizeOperationId }
            );
            if (rollbackError || rolledBack !== true) {
              throw new Error(`Proxmox resize allocation rollback failed: ${rollbackError?.message ?? "resize operation fence mismatch"}`);
            }
          }
        }
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
