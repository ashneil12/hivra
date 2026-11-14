import "server-only";

import { supabaseAdmin } from "@/lib/supabase";
import { log } from "@/lib/logger";
import { isHivraLapseEnforceLive } from "@/lib/hivra/lapse-flags";
import { ownerHasNoPaidPlan } from "@/lib/hivra/lapse-gate";
import { sendHivraComputerStoppedEmail } from "@/lib/email/hivra-computer-stopped";
import { buildInstanceLifecyclePatch } from "@/lib/instance-lifecycle";
import {
  getProxmoxHostRoutingConfigFromInfrastructure,
  getProxmoxInfrastructure,
  isProxmoxVmMissingResult,
  shutdownProxmoxInstance,
  type ProxmoxInfrastructure,
} from "@/lib/services/proxmox-instance-service";
import { rotatingContainmentBatch } from "./orphaned-instances";

/**
 * Stops running hosted computers on the older lane (hermes_instances) whose
 * owner no longer has a paid plan: the twin of hivra-lapse-enforce for that
 * table. Free never includes a hosted computer, so this reaches the Free and
 * former Starter owners and the lost token tiers that the billing suspend
 * never sees (it only runs on a Stripe lapse).
 *
 * "No paid plan" is ownerHasNoPaidPlan, the same rule as the Hivra sweep and
 * both Start checks: a card failure inside its 48 hour window, a token tier
 * inside its 24 hour grace, or any paid lane leaves the computer running, and
 * a failed plan read stops nothing.
 *
 * Owners whose subscription is still past_due are left to the grace
 * reconciler, which asks Stripe before stopping anything.
 *
 * The computer is shut down (onboot 0) and the row is marked
 * paused/no_paid_plan, never suspended: the stale-suspended sweep deletes
 * suspended Free computers after 8 days, and the owner chose to keep the disk.
 * Start is refused while the owner has no paid plan (the instance route), and
 * works again the moment they pay. Until HIVRA_LAPSE_ENFORCE_LIVE is "true" it
 * only logs who it would stop.
 */

export const HERMES_LAPSE_MAX_STOPS_PER_RUN = 5;
/** Stops starting new shutdowns after this long, so it cannot starve the other sweeps in the same cron run. */
export const HERMES_LAPSE_BUDGET_MS = 45_000;
export const NO_PAID_PLAN_PAUSED_REASON = "no_paid_plan";
const SOURCE = "hermes-lapse-enforce";
const PAGE_SIZE = 500;
const OWNER_CHECKS_AT_ONCE = 10;
/** A hung host must not hold a cron run: give up on one shutdown after this long. */
const SHUTDOWN_CALL_TIMEOUT_MS = 60_000;

interface RunningInstance {
  id: string;
  user_id: string;
  name: string | null;
  proxmox_node: string | null;
  proxmox_vmid: number | null;
  host_id: string | null;
  config: Record<string, unknown> | null;
}

export interface HermesLapseSweepResult {
  live: boolean;
  running: number;
  lapsed: number;
  stopped: number;
  failed: number;
}

function resolveInfra(row: RunningInstance): ProxmoxInfrastructure | null {
  return (
    getProxmoxInfrastructure(row.config) ??
    (row.proxmox_vmid && row.proxmox_node
      ? { provider: "proxmox", node: row.proxmox_node, vmid: row.proxmox_vmid, privateIpv4: "", gatewayHost: "" }
      : null)
  );
}

async function listRunningInstances(): Promise<RunningInstance[]> {
  if (!supabaseAdmin) throw new Error("Database not configured");
  const rows: RunningInstance[] = [];
  let cursor: string | null = null;
  for (;;) {
    let query = supabaseAdmin
      .from("hermes_instances")
      .select("id,user_id,name,proxmox_node,proxmox_vmid,host_id,config")
      .eq("status", "running")
      .eq("lifecycle_state", "active")
      .eq("infrastructure_provider", "proxmox")
      .is("deleted_at", null)
      .order("id")
      .limit(PAGE_SIZE);
    if (cursor) query = query.gt("id", cursor);
    const { data, error } = await query;
    if (error) throw new Error(`Instance inventory unavailable: ${error.message}`);
    rows.push(...((data ?? []) as RunningInstance[]));
    if (!data || data.length < PAGE_SIZE) return rows;
    cursor = data[data.length - 1].id;
  }
}

async function listPastDueOwners(): Promise<Set<string>> {
  if (!supabaseAdmin) throw new Error("Database not configured");
  const { data, error } = await supabaseAdmin.from("hermes_subscriptions").select("user_id").eq("status", "past_due");
  if (error) throw new Error(`past_due subscriptions unavailable: ${error.message}`);
  return new Set(((data ?? []) as Array<{ user_id: string }>).map((row) => row.user_id));
}

async function stopInstance(row: RunningInstance, infra: ProxmoxInfrastructure): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    shutdownProxmoxInstance(infra, {
      expectedInstanceId: row.id,
      hostConfig: getProxmoxHostRoutingConfigFromInfrastructure(infra, { host_id: row.host_id }),
      // onboot 0 so a host reboot does not bring the computer back up.
      setOnboot: 0,
      shutdownTimeoutSeconds: 30,
    }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("qm shutdown timed out")), SHUTDOWN_CALL_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
  // A missing VM is already not running: still mark the row so it is not picked again.
  if (!result.ok && !isProxmoxVmMissingResult(result)) {
    throw new Error(result.error || result.stderr || "qm shutdown returned non-zero");
  }

  const { data, error } = await supabaseAdmin!
    .from("hermes_instances")
    .update({ ...buildInstanceLifecyclePatch("stopped"), lifecycle_state: "paused", paused_reason: NO_PAID_PLAN_PAUSED_REASON })
    .eq("id", row.id)
    // Only a row still running: a Start or a delete that landed meanwhile wins.
    .eq("status", "running")
    .eq("lifecycle_state", "active")
    .select("id");
  if (error) throw new Error(`row update failed after stop: ${error.message}`);
  return (data ?? []).length > 0;
}

export async function runHermesLapseSweep(
  now: Date = new Date(),
  budgetMs: number = HERMES_LAPSE_BUDGET_MS,
): Promise<HermesLapseSweepResult> {
  const live = isHivraLapseEnforceLive();
  const running = await listRunningInstances();
  const reconcilerOwned = await listPastDueOwners();

  const byOwner = new Map<string, RunningInstance[]>();
  for (const row of running) {
    if (reconcilerOwned.has(row.user_id)) continue;
    byOwner.set(row.user_id, [...(byOwner.get(row.user_id) ?? []), row]);
  }
  const owners = [...byOwner.keys()];
  const lapsed: RunningInstance[] = [];
  for (let i = 0; i < owners.length; i += OWNER_CHECKS_AT_ONCE) {
    const batch = owners.slice(i, i + OWNER_CHECKS_AT_ONCE);
    const verdicts = await Promise.all(batch.map((owner) => ownerHasNoPaidPlan(owner)));
    batch.forEach((owner, index) => { if (verdicts[index]) lapsed.push(...byOwner.get(owner)!); });
  }

  if (!live) {
    if (lapsed.length > 0) {
      log.warn("hermes lapse sweep (dry run): these computers would be stopped", {
        source: SOURCE, failureType: "hermes_lapse_dry_run", running: running.length, lapsed: lapsed.length,
        instanceIds: lapsed.map((row) => row.id),
      });
    }
    return { live, running: running.length, lapsed: lapsed.length, stopped: 0, failed: 0 };
  }

  let stopped = 0;
  let failed = 0;
  const startedAt = Date.now();
  let visited = 0;
  for (const row of rotatingContainmentBatch(lapsed, HERMES_LAPSE_MAX_STOPS_PER_RUN, now)) {
    if (visited > 0 && Date.now() - startedAt >= budgetMs) break;
    visited += 1;
    // The verdicts above can be minutes old by the time an earlier stop finishes:
    // ask again so an owner who has just paid is not stopped.
    if (!(await ownerHasNoPaidPlan(row.user_id))) continue;
    const infra = resolveInfra(row);
    if (!infra) continue;
    try {
      if (!(await stopInstance(row, infra))) continue;
    } catch (error) {
      failed += 1;
      log.warn("could not stop a computer whose owner has no paid plan", {
        source: SOURCE, failureType: "hermes_lapse_stop_failed", userId: row.user_id, instanceId: row.id,
      }, error);
      continue;
    }
    stopped += 1;
    // Best effort: the stop stands whether or not the email goes.
    try {
      const sent = await sendHivraComputerStoppedEmail({ userId: row.user_id, agentId: row.id, computerName: row.name });
      if (!sent.sent) log.warn("stopped computer email was not sent", { source: SOURCE, failureType: "hermes_lapse_email_not_sent", userId: row.user_id, instanceId: row.id, reason: sent.reason });
    } catch (error) {
      log.warn("stopped computer email failed", { source: SOURCE, failureType: "hermes_lapse_email_failed", userId: row.user_id, instanceId: row.id }, error);
    }
    log.warn("stopped a computer whose owner has no paid plan", {
      source: SOURCE, failureType: "hermes_lapse_stopped", userId: row.user_id, instanceId: row.id,
    });
  }
  return { live, running: running.length, lapsed: lapsed.length, stopped, failed };
}
