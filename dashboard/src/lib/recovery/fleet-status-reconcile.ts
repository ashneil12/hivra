/**
 * Fleet status reconciler.
 *
 * THE DRIFT
 * ─────────
 * The inactivity-sweep cron pauses a dormant free-tier agent by `qm shutdown`
 * + marking its row lifecycle_state='paused' / status='stopped' /
 * paused_reason='inactivity'. But every provisioned VM is created with
 * `onboot: 1`, so when a Proxmox HOST reboots (kernel update, power event,
 * crash) the hypervisor auto-starts ALL its VMs — including the ones we
 * deliberately paused. Nothing flips the DB row back, so the row keeps
 * claiming "stopped" while the VM is live and burning RAM/CPU. On
 * 2026-06-23 this measured as ~168 free-tier VMs running while the DB
 * believed them stopped — hidden overcommit the placement scheduler can't
 * see (it sums DB rows, not real qemu state).
 *
 * WHAT THIS DOES
 * ──────────────
 * For each active/draining proxmox_hosts row, SSH in once (`qm list`), and for
 * every VMID the host reports `running` whose hermes_instances row is parked at
 * status='stopped' (paused for inactivity), flip the row back to running/active.
 * This is the ONE-WAY repair the host reboot left undone — bringing the DB into
 * agreement with the source of truth (`qm list`).
 *
 * SAFETY (this mutates customer rows, so the bar is high)
 * ──────────────────────────────────────────────────────
 *  - AUTHORITATIVE-VERIFY: we only ever upgrade a row to running when the LIVE
 *    `qm list` for that VMID says `running`. We never trust the DB's own claim
 *    and never invert (running → stopped) — a row the DB calls running that the
 *    host calls stopped is left ALONE (that is the inactivity-sweep's job, and
 *    inverting here would race a legitimately-running agent into "stopped").
 *  - REVERSIBLE-BIAS: the only write is a status/lifecycle field correction
 *    (fix-the-DB, never delete/destroy/suspend). It touches no billing amount,
 *    subscription, wallet, or VM power state. The status field IS what billing
 *    reads, but we only move it from stopped→running for a VM that is in fact
 *    running, which is the truthful value.
 *  - NARROW MATCH: only rows the inactivity-sweep itself parked
 *    (status='stopped', paused_reason='inactivity', lifecycle_state in the
 *    paused family) are eligible. cold_archived / suspended / failed /
 *    provisioning / deleting rows are deliberately skipped — their "stopped" is
 *    not inactivity drift, and a cold_archived VM that briefly auto-booted must
 *    NOT be promoted (its data lives elsewhere; the cold-restore path owns it).
 *  - CONCURRENCY-GUARDED: the UPDATE re-asserts the same predicate so we never
 *    clobber a row a user-driven resume moved between read and write.
 *  - BATCH-LIMITED: at most RECONCILE_BATCH_LIMIT writes per run.
 *  - DEFAULT DRY-RUN: writes only happen when FLEET_STATUS_RECONCILE_LIVE=true.
 *    Off by default, the sweep logs every intended change and returns them in
 *    `wouldReconcile` without touching a single row.
 */

import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import {
  resolveProxmoxHostEnv,
  runProxmoxHostScript,
  type HostScriptResult,
  type ProxmoxHostRoutingConfig,
} from "@/lib/services/proxmox-instance-service";
import { supabaseAdmin } from "@/lib/supabase";

const SOURCE = "fleet-status-reconcile";

/**
 * VMIDs >= this are bake templates (Hermes uses 9000+), never tenant agents.
 * Mirrors proxmox-orphan-detection.ts so a running template is never matched.
 */
export const TEMPLATE_VMID_THRESHOLD = 9000;

/** Per-host SSH budget. A single `qm list` is fast. */
const HOST_SCRIPT_TIMEOUT_MS = 25_000;

/**
 * Max DB writes (status corrections) per cron run. The drift is bounded by the
 * number of host reboots, so a tight cap is plenty; it also blast-radius-limits
 * the very first LIVE run. Remaining drift is picked up on the next tick.
 */
export const RECONCILE_BATCH_LIMIT = 200;

/**
 * A row is considered a STUCK archive once it has sat in
 * lifecycle_state='archiving' this long without producing an archive_uri. The
 * cold-storage archive starts by CAS-ing the row to 'archiving'; if the
 * serverless function dies before the archive completes (or a host reboot
 * auto-boots the VM mid-archive), the row strands in 'archiving' while the VM
 * is live — the same drift class as a paused-but-running ghost, just from the
 * archive path. Mirrors COLD_STORAGE_STUCK_RECOVERY_MINUTES (20m) so the two
 * recoveries agree on what "stuck" means.
 */
export const STUCK_ARCHIVING_RECOVERY_MS = 20 * 60 * 1000;

type SupabaseAdmin = NonNullable<typeof supabaseAdmin>;

type ProxmoxHostRow = {
  id: string;
  status: "active" | "draining" | "maintenance";
};

/**
 * Host statuses the reconciler scans. We INCLUDE 'maintenance' deliberately:
 * a host can sit at status='maintenance' for capacity reasons (full, excluded
 * from new placement) while still running live tenants — fixturenodea/fixturenodea on
 * 2026-06-23 carried 50+ running agents between them, all invisible to a
 * scan limited to active/draining. Reconciling a maintenance host is safe
 * because the repair is strictly ONE-WAY and qm-authoritative: we only ever
 * promote a row to running when `qm list` says the VM is running, never the
 * inverse, so a host genuinely mid-decommission (VMs being migrated as STOPPED
 * disks, never "running") produces no drift. A genuinely powered-off
 * maintenance host simply fails the SSH probe and is skipped gracefully (it is
 * also short-circuited earlier when it has zero parked rows). The alternative —
 * forcing operators to flip over-tenant hosts to 'draining' purely so the
 * reconciler sees them — is the manual toil this removes.
 */
export const RECONCILABLE_HOST_STATUSES = [
  "active",
  "draining",
  "maintenance",
] as const;

/**
 * A free-tier row the inactivity-sweep parked: the DB believes it is stopped
 * (paused for inactivity) but the VM may have auto-booted on a host reboot.
 * These are the ONLY rows eligible for stopped→running promotion.
 */
export interface InactivityPausedRow {
  id: string;
  user_id: string;
  proxmox_vmid: number;
  proxmox_node: string;
  status: string | null;
  lifecycle_state: string | null;
  paused_reason: string | null;
}

/** One reconcilable drift: a parked row whose VM `qm list` reports running. */
export interface FleetStatusDrift {
  instanceId: string;
  userId: string;
  hostId: string;
  vmid: number;
  fromStatus: string | null;
  fromLifecycle: string | null;
}

interface FleetStatusHostSummary {
  hostId: string;
  /** Parked (stopped/inactivity) rows the DB has for this host. */
  pausedRows: number;
  /** Of those, how many `qm list` reports running (the drift). */
  driftDetected: number;
  /** How many were actually written to running (0 in dry-run). */
  reconciled: number;
  /** Stuck-archiving rows on this host whose VM `qm list` reports running. */
  archivingStuckDetected: number;
  /** How many stuck-archiving rows were promoted to running (0 in dry-run). */
  archivingReconciled: number;
  /** Write failures / CAS-lost rows. */
  errors: number;
  /** True when SSH/env was unreachable; drift was not computed for this host. */
  skipped: boolean;
  skipReason?: string;
}

export interface FleetStatusReconcileSummary {
  /** false = dry-run (default). true = FLEET_STATUS_RECONCILE_LIVE set. */
  live: boolean;
  hostsScanned: number;
  hostsSkipped: number;
  driftDetected: number;
  reconciled: number;
  /**
   * Rows stuck in lifecycle_state='archiving' (archive never produced a URI)
   * whose VM `qm list` reports running — a half-started archive that died and
   * left a live agent stranded. Counted + promoted separately from the
   * inactivity drift so the two repair paths stay legible.
   */
  archivingStuckDetected: number;
  archivingReconciled: number;
  errors: number;
  /** Per-drift detail. In dry-run this is the "would reconcile" set. */
  drifts: FleetStatusDrift[];
  hosts: FleetStatusHostSummary[];
}

/**
 * Writes are OFF unless explicitly enabled. The reconciler mutates customer
 * rows that billing reads, so going live is a deliberate env opt-in, mirroring
 * HERMES_INACTIVITY_SWEEP_ENABLED / HERMES_ORPHAN_LV_REAP_ENABLED.
 */
export function isFleetStatusReconcileLive(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.FLEET_STATUS_RECONCILE_LIVE?.trim().toLowerCase() === "true";
}

/**
 * Host script: emit `<vmid> running` for every running tenant VM (one `qm
 * list`, NR>1 to skip the header). We only care about the running set — a VM
 * the host reports stopped is in agreement with a parked row and needs no
 * action. Template VMIDs are filtered in the parser, not here, so the script
 * stays a trivial passthrough that's easy to reason about.
 */
export const HOST_RUNNING_VMS_SCRIPT = `set -uo pipefail
qm list 2>/dev/null | awk 'NR>1 && $3=="running" {print $1}'
`;

/**
 * Parse the running-VMID list emitted by HOST_RUNNING_VMS_SCRIPT. Drops
 * template-range and malformed VMIDs. Returns a Set for O(1) membership.
 */
export function parseRunningVmids(stdout: string): Set<number> {
  const out = new Set<number>();
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    // Defensive: take the first whitespace-delimited token in case the awk
    // ever changes to emit more columns.
    const token = line.split(/\s+/, 1)[0] ?? "";
    const vmid = Number.parseInt(token, 10);
    if (!Number.isInteger(vmid) || vmid <= 0) continue;
    if (vmid >= TEMPLATE_VMID_THRESHOLD) continue;
    out.add(vmid);
  }
  return out;
}

/**
 * Pure core (unit-testable without SSH/DB): given the parked rows for a host
 * and the set of VMIDs `qm list` reports running, return the drifts — parked
 * rows whose VM is actually running. This is a strict ONE-WAY filter: a parked
 * row whose VMID is NOT in the running set produces no drift (correct: it is
 * genuinely stopped, leave it parked).
 */
export function computeDriftsForHost(
  hostId: string,
  pausedRows: readonly InactivityPausedRow[],
  runningVmids: ReadonlySet<number>,
): FleetStatusDrift[] {
  const out: FleetStatusDrift[] = [];
  for (const row of pausedRows) {
    if (row.proxmox_vmid >= TEMPLATE_VMID_THRESHOLD) continue;
    if (!runningVmids.has(row.proxmox_vmid)) continue;
    out.push({
      instanceId: row.id,
      userId: row.user_id,
      hostId,
      vmid: row.proxmox_vmid,
      fromStatus: row.status,
      fromLifecycle: row.lifecycle_state,
    });
  }
  return out;
}

async function loadReconcilableProxmoxHosts(
  supabase: SupabaseAdmin,
): Promise<ProxmoxHostRow[]> {
  // active + draining + maintenance (see RECONCILABLE_HOST_STATUSES). Scanning
  // maintenance hosts catches over-tenant hosts that are full-but-live; the
  // one-way/qm-authoritative repair makes it safe.
  const { data, error } = await supabase
    .from("proxmox_hosts")
    .select("id, status")
    .in("status", [...RECONCILABLE_HOST_STATUSES]);
  if (error) {
    throw new Error(`proxmox_hosts query failed: ${error.message}`);
  }
  return (data ?? []) as ProxmoxHostRow[];
}

/**
 * Load the inactivity-parked rows for a host. The match is the EXACT shape the
 * inactivity-sweep writes (status='stopped', paused_reason='inactivity') under
 * a paused-family lifecycle_state. We do NOT match on cold_archived / suspended
 * / failed / pending_deletion / archiving — those "stopped" rows are not
 * inactivity drift and must never be auto-promoted to running.
 */
async function loadInactivityPausedRowsForHost(
  supabase: SupabaseAdmin,
  hostId: string,
): Promise<InactivityPausedRow[]> {
  const { data, error } = await supabase
    .from("hermes_instances")
    .select(
      "id, user_id, proxmox_vmid, proxmox_node, status, lifecycle_state, paused_reason",
    )
    .eq("proxmox_node", hostId)
    .eq("status", "stopped")
    .eq("paused_reason", "inactivity")
    .eq("lifecycle_state", "paused")
    .not("proxmox_vmid", "is", null)
    .is("deleted_at", null);
  if (error) {
    throw new Error(`hermes_instances query failed: ${error.message}`);
  }
  const rows = (data ?? []) as Array<
    Omit<InactivityPausedRow, "proxmox_vmid" | "proxmox_node"> & {
      proxmox_vmid: number | null;
      proxmox_node: string | null;
    }
  >;
  const out: InactivityPausedRow[] = [];
  for (const row of rows) {
    if (
      typeof row.proxmox_vmid === "number" &&
      Number.isFinite(row.proxmox_vmid) &&
      typeof row.proxmox_node === "string"
    ) {
      out.push({ ...row, proxmox_vmid: row.proxmox_vmid, proxmox_node: row.proxmox_node });
    }
  }
  return out;
}

/**
 * Load rows STUCK in lifecycle_state='archiving' for a host: the cold-storage
 * archive CAS'd them to 'archiving' but never produced an archive (archive_uri
 * IS NULL) and they have sat past the stuck threshold. `archive_uri IS NULL` is
 * the critical guard — once an archive exists the row is moments from
 * cold_archived + `qm destroy`, and promoting it to running would fight a
 * nearly-complete archive. With no archive produced, the data still lives on
 * the VM, so a still-running VM is safe to restore to running/active. Returns
 * the InactivityPausedRow shape so it can reuse computeDriftsForHost.
 */
async function loadStuckArchivingRowsForHost(
  supabase: SupabaseAdmin,
  hostId: string,
  stuckCutoffIso: string,
): Promise<InactivityPausedRow[]> {
  const { data, error } = await supabase
    .from("hermes_instances")
    .select(
      "id, user_id, proxmox_vmid, proxmox_node, status, lifecycle_state, paused_reason",
    )
    .eq("proxmox_node", hostId)
    .eq("lifecycle_state", "archiving")
    .is("archive_uri", null)
    .lt("last_lifecycle_transition_at", stuckCutoffIso)
    .not("proxmox_vmid", "is", null)
    .is("deleted_at", null);
  if (error) {
    throw new Error(`stuck-archiving query failed: ${error.message}`);
  }
  const rows = (data ?? []) as Array<
    Omit<InactivityPausedRow, "proxmox_vmid" | "proxmox_node"> & {
      proxmox_vmid: number | null;
      proxmox_node: string | null;
    }
  >;
  const out: InactivityPausedRow[] = [];
  for (const row of rows) {
    if (
      typeof row.proxmox_vmid === "number" &&
      Number.isFinite(row.proxmox_vmid) &&
      typeof row.proxmox_node === "string"
    ) {
      out.push({ ...row, proxmox_vmid: row.proxmox_vmid, proxmox_node: row.proxmox_node });
    }
  }
  return out;
}

type ResolvedHostEnv = ReturnType<typeof resolveProxmoxHostEnv>;

async function discoverRunningVmidsForHost(
  hostId: string,
): Promise<{ ok: true; running: Set<number> } | { ok: false; reason: string }> {
  const hostConfig: ProxmoxHostRoutingConfig = {
    hostId,
    hostSlug: hostId,
    failClosed: false,
  };
  let env: ResolvedHostEnv;
  try {
    env = resolveProxmoxHostEnv(hostConfig, process.env);
  } catch (err) {
    return {
      ok: false,
      reason: `host env unresolved: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let result: HostScriptResult;
  try {
    result = await runProxmoxHostScript(HOST_RUNNING_VMS_SCRIPT, env, HOST_SCRIPT_TIMEOUT_MS);
  } catch (err) {
    return {
      ok: false,
      reason: `host script threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!result.ok) {
    const detail = (result.error || result.stderr || "host script failed").slice(0, 240);
    return { ok: false, reason: detail };
  }
  return { ok: true, running: parseRunningVmids(result.stdout) };
}

/**
 * Persist a single stopped→running correction. Re-asserts the parked predicate
 * in the WHERE clause so a user-driven resume that landed between read and
 * write is never clobbered (the update simply matches 0 rows). Sets the exact
 * inverse of the inactivity pause: status='running', lifecycle_state='active',
 * paused_reason=NULL, and bumps the lifecycle transition timestamp.
 */
async function writeReconcile(
  supabase: SupabaseAdmin,
  drift: FleetStatusDrift,
): Promise<"reconciled" | "noop" | "error"> {
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from("hermes_instances")
    .update({
      status: "running",
      lifecycle_state: "active",
      paused_reason: null,
      last_lifecycle_transition_at: nowIso,
      updated_at: nowIso,
    })
    .eq("id", drift.instanceId)
    .eq("status", "stopped")
    .eq("paused_reason", "inactivity")
    .eq("lifecycle_state", "paused")
    .select("id");

  if (error) {
    log.warn("fleet-status-reconcile update failed", {
      source: SOURCE,
      failureType: "fleet_status_reconcile_update_failed",
      instanceId: drift.instanceId,
      userId: drift.userId,
      hostId: drift.hostId,
      vmid: drift.vmid,
      errorMessage: error.message,
    });
    return "error";
  }
  // 0 rows = CAS lost (a concurrent resume already moved the row). Not an error.
  if (!data || data.length === 0) {
    return "noop";
  }
  return "reconciled";
}

/**
 * Promote a stuck-archiving row whose VM is running back to running/active.
 * Re-asserts the archiving + archive_uri-null predicate in the WHERE clause so
 * a concurrent archive that just produced a URI (and is about to cold_archive +
 * destroy) is never clobbered — that update simply matches 0 rows (noop). Same
 * truthful target as the inactivity promotion: status='running',
 * lifecycle_state='active', paused_reason=NULL, lifecycle_substate cleared.
 */
async function writeArchivingPromotion(
  supabase: SupabaseAdmin,
  drift: FleetStatusDrift,
): Promise<"reconciled" | "noop" | "error"> {
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from("hermes_instances")
    .update({
      status: "running",
      lifecycle_state: "active",
      lifecycle_substate: null,
      paused_reason: null,
      last_lifecycle_transition_at: nowIso,
      updated_at: nowIso,
    })
    .eq("id", drift.instanceId)
    .eq("lifecycle_state", "archiving")
    .is("archive_uri", null)
    .select("id");

  if (error) {
    log.warn("fleet-status-reconcile archiving promotion failed", {
      source: SOURCE,
      failureType: "fleet_status_reconcile_archiving_update_failed",
      instanceId: drift.instanceId,
      userId: drift.userId,
      hostId: drift.hostId,
      vmid: drift.vmid,
      errorMessage: error.message,
    });
    return "error";
  }
  if (!data || data.length === 0) {
    return "noop";
  }
  return "reconciled";
}

export async function runFleetStatusReconcile(): Promise<FleetStatusReconcileSummary> {
  const supabase = supabaseAdmin;
  if (!supabase) {
    throw new Error("Database not configured");
  }

  const live = isFleetStatusReconcileLive();
  const hosts = await loadReconcilableProxmoxHosts(supabase);

  const summary: FleetStatusReconcileSummary = {
    live,
    hostsScanned: 0,
    hostsSkipped: 0,
    driftDetected: 0,
    reconciled: 0,
    archivingStuckDetected: 0,
    archivingReconciled: 0,
    errors: 0,
    drifts: [],
    hosts: [],
  };

  let writeBudget = RECONCILE_BATCH_LIMIT;
  const stuckArchivingCutoffIso = new Date(
    Date.now() - STUCK_ARCHIVING_RECOVERY_MS,
  ).toISOString();

  // Apply a set of drifts with the given writer, honoring dry-run and the
  // shared per-run write budget. Records every drift in summary.drifts (in
  // dry-run that IS the "would reconcile" set) and returns this batch's
  // reconciled/error counts. Used for both the inactivity-paused and the
  // stuck-archiving promotion paths so they share one budget + log shape.
  const applyDrifts = async (
    drifts: readonly FleetStatusDrift[],
    write: (
      s: SupabaseAdmin,
      d: FleetStatusDrift,
    ) => Promise<"reconciled" | "noop" | "error">,
  ): Promise<{ reconciled: number; errors: number }> => {
    let reconciled = 0;
    let errors = 0;
    for (const drift of drifts) {
      summary.drifts.push(drift);
      if (!live) {
        log.info("fleet-status-reconcile would promote drifted row (dry-run)", {
          source: SOURCE,
          instanceId: drift.instanceId,
          userId: drift.userId,
          hostId: drift.hostId,
          vmid: drift.vmid,
          fromStatus: drift.fromStatus,
          fromLifecycle: drift.fromLifecycle,
          to: "running/active",
          live: false,
        });
        continue;
      }
      if (writeBudget <= 0) {
        // Hit the per-run cap; the rest carries to the next tick.
        break;
      }
      const outcome = await write(supabase, drift);
      if (outcome === "reconciled") {
        writeBudget -= 1;
        reconciled += 1;
        log.info("fleet-status-reconcile promoted drifted row to running", {
          source: SOURCE,
          instanceId: drift.instanceId,
          userId: drift.userId,
          hostId: drift.hostId,
          vmid: drift.vmid,
          fromStatus: drift.fromStatus,
          fromLifecycle: drift.fromLifecycle,
          live: true,
        });
      } else if (outcome === "error") {
        errors += 1;
      }
      // "noop" (CAS lost) is silently fine — a concurrent resume won the row.
    }
    return { reconciled, errors };
  };

  for (const host of hosts) {
    // Pull the parked + stuck-archiving rows first: if the host has neither,
    // there is nothing to reconcile and we can skip the SSH round-trip.
    let pausedRows: InactivityPausedRow[];
    let archivingRows: InactivityPausedRow[];
    try {
      pausedRows = await loadInactivityPausedRowsForHost(supabase, host.id);
      archivingRows = await loadStuckArchivingRowsForHost(
        supabase,
        host.id,
        stuckArchivingCutoffIso,
      );
    } catch (err) {
      summary.hostsSkipped += 1;
      const reason = err instanceof Error ? err.message : String(err);
      summary.hosts.push({
        hostId: host.id,
        pausedRows: 0,
        driftDetected: 0,
        reconciled: 0,
        archivingStuckDetected: 0,
        archivingReconciled: 0,
        errors: 0,
        skipped: true,
        skipReason: reason,
      });
      log.warn("fleet-status-reconcile: db lookup failed", {
        source: SOURCE,
        failureType: "fleet_status_reconcile_db_lookup_failed",
        hostId: host.id,
        reason,
      });
      continue;
    }

    if (pausedRows.length === 0 && archivingRows.length === 0) {
      summary.hostsScanned += 1;
      summary.hosts.push({
        hostId: host.id,
        pausedRows: 0,
        driftDetected: 0,
        reconciled: 0,
        archivingStuckDetected: 0,
        archivingReconciled: 0,
        errors: 0,
        skipped: false,
      });
      continue;
    }

    const discovery = await discoverRunningVmidsForHost(host.id);
    if (!discovery.ok) {
      summary.hostsSkipped += 1;
      summary.hosts.push({
        hostId: host.id,
        pausedRows: pausedRows.length,
        driftDetected: 0,
        reconciled: 0,
        archivingStuckDetected: 0,
        archivingReconciled: 0,
        errors: 0,
        skipped: true,
        skipReason: discovery.reason,
      });
      log.warn("fleet-status-reconcile: host skipped", {
        source: SOURCE,
        failureType: "fleet_status_reconcile_host_skipped",
        hostId: host.id,
        reason: discovery.reason,
      });
      continue;
    }

    // Both repairs key off the SAME live running set (one qm list per host).
    const drifts = computeDriftsForHost(host.id, pausedRows, discovery.running);
    const archivingDrifts = computeDriftsForHost(
      host.id,
      archivingRows,
      discovery.running,
    );
    summary.hostsScanned += 1;
    summary.driftDetected += drifts.length;
    summary.archivingStuckDetected += archivingDrifts.length;

    const inactivityOutcome = await applyDrifts(drifts, writeReconcile);
    const archivingOutcome = await applyDrifts(
      archivingDrifts,
      writeArchivingPromotion,
    );

    summary.reconciled += inactivityOutcome.reconciled;
    summary.archivingReconciled += archivingOutcome.reconciled;
    summary.errors += inactivityOutcome.errors + archivingOutcome.errors;

    summary.hosts.push({
      hostId: host.id,
      pausedRows: pausedRows.length,
      driftDetected: drifts.length,
      reconciled: inactivityOutcome.reconciled,
      archivingStuckDetected: archivingDrifts.length,
      archivingReconciled: archivingOutcome.reconciled,
      errors: inactivityOutcome.errors + archivingOutcome.errors,
      skipped: false,
    });
  }

  const totalDetected = summary.driftDetected + summary.archivingStuckDetected;
  const totalReconciled = summary.reconciled + summary.archivingReconciled;
  if (totalDetected > 0) {
    log.info("fleet-status-reconcile sweep summary", {
      source: SOURCE,
      ...summary,
      // Avoid dumping the full per-row array into the summary log line.
      drifts: summary.drifts.length,
    });
    try {
      await reportOpsEvent({
        source: SOURCE,
        title: live
          ? "fleet_status_reconcile_applied"
          : "fleet_status_reconcile_drift_detected",
        message: live
          ? `Reconciled ${totalReconciled}/${totalDetected} drifted rows back to running across ${summary.hostsScanned} hosts (${summary.reconciled} paused-but-running, ${summary.archivingReconciled} stuck-archiving)`
          : `Detected ${totalDetected} drifted rows across ${summary.hostsScanned} hosts (${summary.driftDetected} paused-but-running, ${summary.archivingStuckDetected} stuck-archiving) (dry-run; set FLEET_STATUS_RECONCILE_LIVE=true to apply)`,
        severity: "warn",
        metadata: {
          live,
          driftDetected: summary.driftDetected,
          reconciled: summary.reconciled,
          archivingStuckDetected: summary.archivingStuckDetected,
          archivingReconciled: summary.archivingReconciled,
          errors: summary.errors,
          hostsScanned: summary.hostsScanned,
          hostsSkipped: summary.hostsSkipped,
        },
      });
    } catch {
      // Ops-event logging is best-effort; never derail the sweep.
    }
  }

  return summary;
}
