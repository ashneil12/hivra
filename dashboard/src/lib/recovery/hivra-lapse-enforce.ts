import "server-only";

import { supabaseAdmin } from "@/lib/supabase";
import { log } from "@/lib/logger";
import { isHivraLapseEnforceLive } from "@/lib/hivra/lapse-flags";
import { ownerHasNoPaidPlan } from "@/lib/hivra/lapse-gate";
import { sendHivraComputerStoppedEmail } from "@/lib/email/hivra-computer-stopped";
import { stopHivraManagedComputer } from "./stop-deleted-user-computers";
import { rotatingContainmentBatch } from "./orphaned-instances";

/**
 * Stops running Hivra Cloud computers whose owner no longer has a paid plan.
 *
 * "No paid plan" is read from resolveEffectiveSubscription: no entitlement,
 * only the Free account, or only a trial. That one rule already covers a card
 * failure inside its 48 hour window (entitled, so left running), a cancelled
 * or unpaid plan, an ended Apple or yearly plan, and a lost token tier. The
 * computer is stopped, never deleted: its disk and files stay.
 *
 * Runs from the reconcile-subscription-grace cron (every 15 minutes). Nothing is stored: a
 * stopped computer is no longer 'running', so it is not picked again.
 * Fails open: any error reading a plan means that owner is skipped.
 * Until HIVRA_LAPSE_ENFORCE_LIVE is "true" it only logs who it would stop.
 */

export const HIVRA_LAPSE_MAX_STOPS_PER_RUN = 5;
const SOURCE = "hivra-lapse-enforce";
const PAGE_SIZE = 500;
const OWNER_CHECKS_AT_ONCE = 10;

interface RunningComputer { id: string; user_id: string; name: string | null }

export interface HivraLapseSweepResult {
  live: boolean;
  running: number;
  lapsed: number;
  stopped: number;
  failed: number;
}

async function listRunningCloudComputers(): Promise<RunningComputer[]> {
  if (!supabaseAdmin) throw new Error("Database not configured");
  const rows: RunningComputer[] = [];
  let cursor: string | null = null;
  for (;;) {
    let query = supabaseAdmin
      .from("hivra_agents")
      .select("id,user_id,name")
      .eq("status", "running")
      .eq("deployment_mode", "hivra-managed")
      .eq("computer_substrate", "proxmox-kvm")
      .is("deployment_target_id", null)
      .is("infrastructure_connection_id", null)
      .order("id")
      .limit(PAGE_SIZE);
    if (cursor) query = query.gt("id", cursor);
    const { data, error } = await query;
    if (error) throw new Error(`Computer inventory unavailable: ${error.message}`);
    rows.push(...((data ?? []) as RunningComputer[]));
    if (!data || data.length < PAGE_SIZE) return rows;
    cursor = data[data.length - 1].id;
  }
}

export async function runHivraLapseSweep(now = new Date()): Promise<HivraLapseSweepResult> {
  const live = isHivraLapseEnforceLive();
  const running = await listRunningCloudComputers();

  const byOwner = new Map<string, RunningComputer[]>();
  for (const computer of running) byOwner.set(computer.user_id, [...(byOwner.get(computer.user_id) ?? []), computer]);
  const owners = [...byOwner.keys()];
  const lapsed: RunningComputer[] = [];
  for (let i = 0; i < owners.length; i += OWNER_CHECKS_AT_ONCE) {
    const batch = owners.slice(i, i + OWNER_CHECKS_AT_ONCE);
    const verdicts = await Promise.all(batch.map((owner) => ownerHasNoPaidPlan(owner)));
    batch.forEach((owner, index) => { if (verdicts[index]) lapsed.push(...byOwner.get(owner)!); });
  }

  if (!live) {
    if (lapsed.length > 0) {
      log.warn("hivra lapse sweep (dry run): these computers would be stopped", {
        source: SOURCE, failureType: "hivra_lapse_dry_run", running: running.length, lapsed: lapsed.length,
        computerIds: lapsed.map((computer) => computer.id),
      });
    }
    return { live, running: running.length, lapsed: lapsed.length, stopped: 0, failed: 0 };
  }

  let stopped = 0;
  let failed = 0;
  for (const computer of rotatingContainmentBatch(lapsed, HIVRA_LAPSE_MAX_STOPS_PER_RUN, now)) {
    // The verdicts above can be minutes old by the time an earlier stop finishes:
    // ask again so an owner who has just paid is not stopped.
    if (!(await ownerHasNoPaidPlan(computer.user_id))) continue;
    try {
      await stopHivraManagedComputer(computer.user_id, computer.id);
    } catch (error) {
      failed += 1;
      log.warn("could not stop a computer whose owner has no paid plan", {
        source: SOURCE, failureType: "hivra_lapse_stop_failed", userId: computer.user_id, agentId: computer.id,
      }, error);
      continue;
    }
    stopped += 1;
    // Best effort: the stop stands whether or not the email goes.
    try {
      const sent = await sendHivraComputerStoppedEmail({ userId: computer.user_id, agentId: computer.id, computerName: computer.name });
      if (!sent.sent) log.warn("stopped computer email was not sent", { source: SOURCE, failureType: "hivra_lapse_email_not_sent", userId: computer.user_id, agentId: computer.id, reason: sent.reason });
    } catch (error) {
      log.warn("stopped computer email failed", { source: SOURCE, failureType: "hivra_lapse_email_failed", userId: computer.user_id, agentId: computer.id }, error);
    }
    log.warn("stopped a computer whose owner has no paid plan", {
      source: SOURCE, failureType: "hivra_lapse_stopped", userId: computer.user_id, agentId: computer.id,
    });
  }
  return { live, running: running.length, lapsed: lapsed.length, stopped, failed };
}
