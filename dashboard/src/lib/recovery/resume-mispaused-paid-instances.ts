import "server-only";

import { supabaseAdmin } from "@/lib/supabase";
import { log } from "@/lib/logger";
import {
  getProxmoxHostRoutingConfigFromInfrastructure,
  getProxmoxInfrastructure,
  isProxmoxVmMissingResult,
  startProxmoxInstance,
  type ProxmoxInfrastructure,
} from "@/lib/services/proxmox-instance-service";
import { buildInstanceLifecyclePatch } from "@/lib/instance-lifecycle";
import { reportOpsEvent } from "@/lib/ops-events";

/**
 * Resume-mispaused-paid sweep.
 *
 * One-shot remediation + standing safety net for paid-tier agents that the
 * inactivity-sweep cron paused while paid tiers were (wrongly) in-scope. Paid
 * tiers are now EXEMPT from the inactivity sweep by default (see
 * inactivity-sweep.ts readPaidIdleDays), but that change only stops NEW pauses;
 * agents paused before it shipped stay `lifecycle_state='paused',
 * paused_reason='inactivity'` — i.e. paying customers whose "always-on" agents
 * are silently stopped (scheduled tasks + Telegram dark until they next open
 * the dashboard, since wake-on-access is dashboard-triggered).
 *
 * This resumes them via the SAME path the dashboard Start button uses
 * (startProxmoxInstance + buildInstanceLifecyclePatch("running")), so it runs
 * on Vercel with the real registry-driven host routing and reaches every host.
 *
 * Safety:
 *   - Only paid tiers (operator/fleet/command) whose owner has an ACTIVE paid
 *     subscription — a paused paid instance on a lapsed/cancelled sub is left
 *     alone (it's effectively downgraded; resuming would waste capacity).
 *   - Only paused_reason='inactivity' — never touches cold_archived /
 *     dormant_reclaimed / suspended / ram_cap_hit rows (those have their own
 *     restore paths).
 *   - Per-run cap (default 10) so a wake wave can be staged across hosts.
 *   - Idempotent by selection: a resumed row is no longer paused, so re-runs
 *     skip it.
 *   - Per-instance try/catch: one failure never aborts the run.
 *   - dryRun returns the eligible count without touching any VM.
 */

const LOG_SOURCE = "resume-mispaused-paid";
const PAID_TIER_VALUES = ["operator", "fleet", "command"] as const;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

type ResumeCandidate = {
  id: string;
  user_id: string;
  resource_tier: string | null;
  proxmox_node: string | null;
  proxmox_vmid: number | null;
  host_id: string | null;
  config: Record<string, unknown> | null;
};

export type ResumeMispausedSummary = {
  scanned: number;
  eligible: number;
  resumed: number;
  failed: number;
  vmMissing: number;
  skippedLapsed: number;
  skippedNotProxmox: number;
  dryRun: boolean;
  limit: number;
};

type ResumeOutcome = "resumed" | "vm_missing" | "not_proxmox_backed";

function resolveResumeLimit(raw: number | null | undefined): number {
  if (raw == null || !Number.isFinite(raw) || raw <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.trunc(raw));
}

function resolveInfra(candidate: ResumeCandidate): ProxmoxInfrastructure | null {
  // Mirror pauseInstance's resolution: prefer the stored infrastructure block,
  // fall back to the proxmox_node/vmid columns for rows that predate it.
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

async function resumeInstance(candidate: ResumeCandidate): Promise<ResumeOutcome> {
  const supabase = supabaseAdmin;
  if (!supabase) throw new Error("Database not configured");

  const infra = resolveInfra(candidate);
  if (!infra) {
    // Hetzner-backed legacy box — not part of pve packing; leave it alone.
    return "not_proxmox_backed";
  }

  const result = await startProxmoxInstance(infra, {
    expectedInstanceId: candidate.id,
    hostConfig: getProxmoxHostRoutingConfigFromInfrastructure(infra, {
      host_id: candidate.host_id,
    }),
  });

  if (isProxmoxVmMissingResult(result)) {
    // VM is gone (destroyed after a failed bootstrap). Flip to error so the UI
    // offers re-create instead of a start that can never succeed — exactly what
    // the dashboard Start path does for a missing VM.
    const nowIso = new Date().toISOString();
    const { error: updateError } = await supabase
      .from("hermes_instances")
      .update(buildInstanceLifecyclePatch("error", { now: nowIso }))
      .eq("id", candidate.id);
    if (updateError) {
      throw new Error(
        `Failed to mark missing-VM instance ${candidate.id} as error: ${updateError.message}`
      );
    }
    return "vm_missing";
  }

  if (!result.ok) {
    throw new Error(
      result.error || result.stderr || "Proxmox start returned non-zero"
    );
  }

  // Same patch the Start button writes: status=running, lifecycle_state=active,
  // paused_reason=null, scheduled_deletion_at=null.
  const { error: updateError } = await supabase
    .from("hermes_instances")
    .update(buildInstanceLifecyclePatch("running"))
    .eq("id", candidate.id);
  if (updateError) {
    throw new Error(
      `Failed to mark instance ${candidate.id} as running: ${updateError.message}`
    );
  }
  return "resumed";
}

export async function runResumeMispausedPaidSweep(
  options: { limit?: number; dryRun?: boolean } = {}
): Promise<ResumeMispausedSummary> {
  const limit = resolveResumeLimit(options.limit);
  const dryRun = options.dryRun ?? false;
  const summary: ResumeMispausedSummary = {
    scanned: 0,
    eligible: 0,
    resumed: 0,
    failed: 0,
    vmMissing: 0,
    skippedLapsed: 0,
    skippedNotProxmox: 0,
    dryRun,
    limit,
  };

  const supabase = supabaseAdmin;
  if (!supabase) throw new Error("Database not configured");

  // Paid-tier agents paused by the inactivity sweep. Pull a generous window
  // (3x limit) so the active-sub filter still has enough to fill the cap.
  const { data: rows, error } = await supabase
    .from("hermes_instances")
    .select(
      "id, user_id, resource_tier, proxmox_node, proxmox_vmid, host_id, config"
    )
    .eq("lifecycle_state", "paused")
    .eq("paused_reason", "inactivity")
    .is("deleted_at", null)
    .in("resource_tier", Array.from(PAID_TIER_VALUES))
    .limit(Math.max(limit * 3, limit));
  if (error) {
    throw new Error(`Failed to load mispaused paid candidates: ${error.message}`);
  }
  const candidates = (rows ?? []) as ResumeCandidate[];
  summary.scanned = candidates.length;
  if (candidates.length === 0) return summary;

  // Keep only owners with an ACTIVE paid subscription. A paused paid instance
  // on a lapsed sub is effectively downgraded — leave it stopped.
  const userIds = [...new Set(candidates.map((c) => c.user_id))];
  const { data: subRows, error: subErr } = await supabase
    .from("hermes_subscriptions")
    .select("user_id, plan, status")
    .in("user_id", userIds)
    .eq("status", "active")
    .in("plan", Array.from(PAID_TIER_VALUES));
  if (subErr) {
    throw new Error(`Failed to load active paid subscriptions: ${subErr.message}`);
  }
  const activePaidUsers = new Set(
    (subRows ?? []).map((r: { user_id: string }) => r.user_id)
  );

  const eligible = candidates.filter((c) => activePaidUsers.has(c.user_id));
  summary.skippedLapsed = candidates.length - eligible.length;
  summary.eligible = eligible.length;

  const batch = eligible.slice(0, limit);

  if (dryRun) {
    log.info("resume-mispaused-paid dry run", {
      source: LOG_SOURCE,
      scanned: summary.scanned,
      eligible: summary.eligible,
      wouldResume: batch.length,
    });
    return summary;
  }

  for (const candidate of batch) {
    try {
      const outcome = await resumeInstance(candidate);
      if (outcome === "resumed") {
        summary.resumed += 1;
        log.info("resume-mispaused-paid resumed instance", {
          source: LOG_SOURCE,
          instanceId: candidate.id,
          userId: candidate.user_id,
          resourceTier: candidate.resource_tier,
          proxmoxNode: candidate.proxmox_node,
        });
      } else if (outcome === "vm_missing") {
        summary.vmMissing += 1;
        log.warn("resume-mispaused-paid found missing VM, marked error", {
          source: LOG_SOURCE,
          failureType: "resume_mispaused_vm_missing",
          instanceId: candidate.id,
          userId: candidate.user_id,
        });
      } else {
        summary.skippedNotProxmox += 1;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      summary.failed += 1;
      log.error("resume-mispaused-paid failed to resume instance", err, {
        source: LOG_SOURCE,
        failureType: "resume_mispaused_failed",
        instanceId: candidate.id,
        userId: candidate.user_id,
      });
      try {
        await reportOpsEvent({
          source: LOG_SOURCE,
          title: "resume_mispaused_failed",
          message: "failed to resume a wrongly-paused paid instance",
          severity: "error",
          instanceId: candidate.id,
          userId: candidate.user_id,
          metadata: { error: message },
        });
      } catch {
        // Ops-event logging is best-effort.
      }
    }
  }

  return summary;
}
