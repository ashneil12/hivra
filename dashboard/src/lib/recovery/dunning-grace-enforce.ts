import "server-only";

import { supabaseAdmin } from "@/lib/supabase";
import { log } from "@/lib/logger";
import {
  getProxmoxHostRoutingConfigFromInfrastructure,
  getProxmoxInfrastructure,
  isProxmoxVmMissingResult,
  shutdownProxmoxInstance,
  type ProxmoxInfrastructure,
} from "@/lib/services/proxmox-instance-service";
import {
  hasTokenTierInGrace,
  resolveEffectiveSubscription,
} from "@/lib/billing/instance-entitlement";

/**
 * Billing-lapse compute enforcer (legacy Hermes lane).
 *
 * Why this exists
 * ---------------
 * A billing suspend (`suspendInstancesForBilling`) only flips DB flags —
 * `status='stopped'`, `lifecycle_state='suspended'` — it never powers the VM
 * off. Nothing else stops a billing-suspended box either: `fleet-status-reconcile`
 * explicitly skips `suspended`, there's no warden, and `stale-suspended-sweep`
 * doesn't touch compute for weeks. So after a failed payment, or a cancelled
 * subscription, the agent's VM keeps running and stays reachable over the direct
 * WS/gateway lane even though the dashboard says "suspended" (leak #3 of the
 * dunning audit).
 *
 * What this does
 * --------------
 * For a user whose subscription is cancelled, or whose past_due grace window has
 * expired, AND who has NO effective entitlement left (no token/yearly tier
 * underneath, so `resolveEffectiveSubscription` returns null), physically
 * `qm shutdown` their still-running Proxmox VMs and pin them to a
 * terminal-for-now `subscription_grace_expired` reason so compute genuinely
 * stops. Recoverable: `resumeBillingSuspendedInstances` (on invoice.paid or a
 * re-subscribe) starts them back up.
 *
 * Policy: 48h keep-alive for past_due (handled by the entitlement resolver's
 * grace cutoff), then hard-stop here. Callers: the existing
 * `reconcile-subscription-grace` cron once per grace-expired past_due row, and
 * `handleSubscriptionDeleted` right after it suspends a cancelled owner's
 * instances. No new cron (Vercel is near its schedule cap).
 *
 * Safety
 * ------
 *  - DARK BY DEFAULT: the actual shutdown only fires when
 *    `DUNNING_GRACE_ENFORCE_LIVE=true`. Off → dry-run (logs `wouldStop`, touches
 *    no VM and no row). Mirrors FLEET_STATUS_RECONCILE_LIVE.
 *  - ENTITLEMENT-GUARDED: a user who still resolves to ANY entitlement (token
 *    holding, yearly $HERMESOS, a recovered sub) is skipped — we never stop a
 *    box the user is still entitled to. A token tier still inside its 24 hour
 *    breach grace counts too (the breach email promises it), as in the
 *    Hivra lapse gate.
 *  - SHUTDOWN, NOT DESTROY: `qm shutdown` (graceful, `setOnboot:0` so a host
 *    reboot won't auto-start it). Disks/chats/volumes untouched; the laddered
 *    stale-suspended sweep still owns eventual teardown with its warning emails.
 *  - FAIL OPEN: the entitlement read throws on a database error
 *    (`throwOnQueryError`), and a thrown read stops nothing. A failed read must
 *    never look like "no plan" and power off a paying customer.
 *  - RETRY: only the past_due path is retried, because the grace cron keeps
 *    scanning past_due rows. A cancelled owner is stopped when
 *    `handleSubscriptionDeleted` runs; if that stop fails (or the read above
 *    fails) nothing re-runs it until Stripe redelivers the event. Known gap.
 *  - IDEMPOTENT: only rows still at `subscription_past_due` or
 *    `subscription_canceled` are eligible; a stopped row is flipped to
 *    `subscription_grace_expired` and drops out of the next scan.
 *  - Per-instance try/catch: one VM failure never aborts the user's batch.
 */

const DUNNING_ENFORCE_LOG_SOURCE = "dunning-grace-enforce";

/** Terminal-for-now reason set once compute is actually stopped post-grace. */
export const GRACE_EXPIRED_ENTITLEMENT_REASON = "subscription_grace_expired";

/** The reasons a billing suspend leaves on the row; our eligibility marker. */
const STOPPABLE_ENTITLEMENT_REASONS = ["subscription_past_due", "subscription_canceled"];

/** Lifecycle states that mean the slot is gone — never re-touch these. */
const TERMINAL_LIFECYCLE_STATES = ["deleted", "deleting", "cold_archived"];

export function isDunningGraceEnforceLive(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return env.DUNNING_GRACE_ENFORCE_LIVE === "true";
}

type GraceEnforceOutcome =
  | "stopped"
  | "skipped_entitled"
  | "skipped_entitlement_unknown"
  | "skipped_no_instances"
  | "dry_run"
  | "error";

export interface GraceEnforceResult {
  userId: string;
  outcome: GraceEnforceOutcome;
  /** VMs actually stopped (live mode) or that WOULD stop (dry-run). */
  affected: number;
  detail?: string;
}

interface EnforceCandidate {
  id: string;
  user_id: string;
  proxmox_node: string | null;
  proxmox_vmid: number | null;
  host_id: string | null;
  config: Record<string, unknown> | null;
  infrastructure_provider: string | null;
}

function resolveInfra(candidate: EnforceCandidate): ProxmoxInfrastructure | null {
  return (
    getProxmoxInfrastructure(candidate.config) ??
    (candidate.proxmox_vmid && candidate.proxmox_node
      ? ({
          provider: "proxmox" as const,
          node: candidate.proxmox_node,
          vmid: candidate.proxmox_vmid,
          privateIpv4: "",
          gatewayHost: "",
        } satisfies ProxmoxInfrastructure)
      : null)
  );
}

/**
 * Stop compute for a single user who has no entitlement left: a cancelled
 * owner, or a past_due owner whose grace has expired.
 *
 * @param userId  the cancelled, or past_due and grace-expired, subscriber
 * @param opts.live  override the env flag (tests / explicit callers)
 */
export async function enforceGraceExpiredComputeStop(
  userId: string,
  opts: { live?: boolean } = {}
): Promise<GraceEnforceResult> {
  const db = supabaseAdmin;
  if (!db) {
    return { userId, outcome: "error", affected: 0, detail: "db not configured" };
  }

  // Never stop a box the user is still entitled to. A past_due Stripe row can
  // sit on top of a token-holding or yearly-$HERMESOS entitlement; the resolver
  // (with the grace cutoff already applied) returns non-null only when the user
  // still has SOME access. Non-null → leave everything running.
  let effective: Awaited<ReturnType<typeof resolveEffectiveSubscription>>;
  let inTokenGrace = false;
  try {
    effective = await resolveEffectiveSubscription(userId, { throwOnQueryError: true });
    if (!effective) inTokenGrace = await hasTokenTierInGrace(userId);
  } catch (err) {
    // Could not tell whether the user pays: stop nothing.
    log.error("dunning grace enforce could not read the entitlement; stopping nothing", err, {
      source: DUNNING_ENFORCE_LOG_SOURCE,
      failureType: "grace_enforce_entitlement_unreadable",
      userId,
    });
    return {
      userId,
      outcome: "skipped_entitlement_unknown",
      affected: 0,
      detail: err instanceof Error ? err.message : "entitlement read failed",
    };
  }
  if (effective || inTokenGrace) {
    return {
      userId,
      outcome: "skipped_entitled",
      affected: 0,
      detail: effective
        ? `still entitled via ${effective.source}`
        : "token tier still inside its grace",
    };
  }

  const { data: rows, error } = await db
    .from("hermes_instances")
    .select(
      "id, user_id, proxmox_node, proxmox_vmid, host_id, config, infrastructure_provider"
    )
    .eq("user_id", userId)
    .in("entitlement_reason", STOPPABLE_ENTITLEMENT_REASONS)
    .not("lifecycle_state", "in", `(${TERMINAL_LIFECYCLE_STATES.join(",")})`)
    .is("deleted_at", null);

  if (error) {
    log.error("failed to load grace-expired enforce candidates", error, {
      source: DUNNING_ENFORCE_LOG_SOURCE,
      failureType: "grace_enforce_query_failed",
      userId,
    });
    return { userId, outcome: "error", affected: 0, detail: error.message };
  }

  const candidates = (rows as EnforceCandidate[] | null) ?? [];
  if (candidates.length === 0) {
    return { userId, outcome: "skipped_no_instances", affected: 0 };
  }

  const live = opts.live ?? isDunningGraceEnforceLive();
  if (!live) {
    log.info("dunning grace enforce (dry-run) — would stop compute", {
      source: DUNNING_ENFORCE_LOG_SOURCE,
      userId,
      wouldStop: candidates.length,
    });
    return { userId, outcome: "dry_run", affected: candidates.length };
  }

  let stopped = 0;
  const nowIso = new Date().toISOString();
  for (const candidate of candidates) {
    try {
      const infra = resolveInfra(candidate);
      if (!infra) {
        // Non-Proxmox (legacy Hetzner) box — no packing power path here.
        continue;
      }

      const result = await shutdownProxmoxInstance(infra, {
        expectedInstanceId: candidate.id,
        hostConfig: getProxmoxHostRoutingConfigFromInfrastructure(infra, {
          host_id: candidate.host_id,
        }),
        // onboot:0 so a host reboot doesn't silently resurrect a lapsed box.
        setOnboot: 0,
        // This runs inside the webhook and the reconcilers' loops: keep the
        // graceful window short (the script hard-stops after it), as the
        // orphan shutdown does.
        shutdownTimeoutSeconds: 30,
      });

      // A missing VM is already "not running" — still pin the reason so it
      // stops matching. A non-zero shutdown that isn't "missing" is a real
      // failure: leave the row as-is (a past_due row is retried by the grace
      // cron; a cancelled row is not, see RETRY above).
      if (!result.ok && !isProxmoxVmMissingResult(result)) {
        throw new Error(
          result.error || result.stderr || "qm shutdown returned non-zero"
        );
      }

      const { error: updateError } = await db
        .from("hermes_instances")
        .update({
          status: "stopped",
          lifecycle_state: "suspended",
          entitlement_state: "suspended",
          entitlement_reason: GRACE_EXPIRED_ENTITLEMENT_REASON,
          entitlement_suspended_at: nowIso,
          last_lifecycle_transition_at: nowIso,
          updated_at: nowIso,
        })
        .eq("id", candidate.id)
        // CAS: only flip a row still at the pre-enforce reason, so a concurrent
        // resume (invoice.paid) that already moved it isn't clobbered.
        .in("entitlement_reason", STOPPABLE_ENTITLEMENT_REASONS);

      if (updateError) {
        throw new Error(updateError.message || "reason flip failed after stop");
      }
      stopped += 1;
      log.info("dunning grace enforce stopped compute", {
        source: DUNNING_ENFORCE_LOG_SOURCE,
        userId,
        instanceId: candidate.id,
        proxmoxNode: candidate.proxmox_node,
        proxmoxVmid: candidate.proxmox_vmid,
      });
    } catch (err) {
      log.error("dunning grace enforce failed for instance", err, {
        source: DUNNING_ENFORCE_LOG_SOURCE,
        failureType: "grace_enforce_stop_failed",
        userId,
        instanceId: candidate.id,
      });
    }
  }

  return {
    userId,
    outcome: stopped > 0 ? "stopped" : "error",
    affected: stopped,
    detail: stopped < candidates.length ? `${stopped}/${candidates.length} stopped` : undefined,
  };
}
