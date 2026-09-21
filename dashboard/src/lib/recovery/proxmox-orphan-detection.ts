/**
 * Detect Proxmox VMs running on a fleet host that have no corresponding
 * `hermes_instances` row. These accumulate when a provision flow partly
 * succeeds (template clone landed, post-provision UPDATE never landed AND
 * the recover-orphan-provisioning cron's name-prefix probe failed to
 * reconcile — e.g. a manual `qm clone` from a debug session that was
 * never associated with a user row).
 *
 * 2026-05-12 incident: `canary-407` on fixturenodea — a 4 GB / 2-core VM cloned
 * from the template but with no DB row, accumulating since at least
 * early May. Destroying it dropped fixturenodea from 97.8% to 53.9% RAM. The
 * placement scheduler sums DB rows, not real qemu allocations, so a
 * single forgotten orphan can quietly eat a third of a host's RAM
 * budget while the dashboard thinks the host has plenty of room.
 *
 * Orphan VMs are visibility-only: we log structured warnings, never destroy.
 * Destroying a VM without a row would risk wiping a manual debug VM that the
 * operator forgot to register.
 *
 * This sweep ALSO detects orphaned LOGICAL VOLUMES — `vm-<vmid>-*` LVs whose
 * VMID has no qemu-server config. Those are the doom-loop landmines a crashed
 * `qm clone` leaves behind (incident 2026-06-13, vmid 1246 on fixturenodea): qm list
 * can't see them, so the allocator re-picks the slot forever and every clone
 * dies "lvcreate ... already exists". The provisioner now prevents new ones
 * (skips LV-owning VMIDs + tears its own partial LVs down), but pre-existing
 * orphans still need reclaiming. Orphan-LV reaping (`lvremove`) is GATED behind
 * HERMES_ORPHAN_LV_REAP_ENABLED and OFF by default — detection ships first as
 * visibility, and reaping (config-less re-check + DB cross-check) is an
 * explicit opt-in because removing an LV destroys a disk.
 *
 * This sweep ALSO classifies LEAKED RESTORE CLONES (incident 2026-07-07: 24
 * orphan VMs across fixturenodea/11/19): a failed cold-restore leaves a running
 * onboot=1 clone named `hermes-<instanceId>` while the instance row is
 * cold_archived/deleted with proxmox_vmid NULL — a row that points at
 * NOTHING, so the vmid-keyed orphan match above is the ONLY thing that sees
 * the VM, and nothing acted on it. When an orphan VM's name carries an
 * instance UUID whose row is in a slot-freeing lifecycle state with a NULL
 * vmid, it is restore debris burning RAM/thin-pool for nobody. Action is
 * GATED behind HERMES_RESTORE_CLONE_REAPER_ENABLED (OFF by default) and is
 * deliberately `qm stop` + ops_events flag — NEVER destroy: destruction stays
 * a human/approved action (the archive-verified destroy run of 2026-07-07 is
 * the template). The stop script re-checks the exact VM name at run time so a
 * recycled VMID can never be touched.
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

const SOURCE = "detect-proxmox-orphans";

/**
 * VMIDs >= this value are treated as templates and skipped. Hermes uses
 * 9000+ for bake templates (current production: 9004; fixturenodea has 9004 +
 * 9005 as of 2026-05-12; future hosts may have more). The awk filter
 * already drops stopped VMs, but a running template in this range
 * (extremely unusual) would otherwise look like an orphan.
 */
export const TEMPLATE_VMID_THRESHOLD = 9000;

/**
 * Per-host SSH budget. Discovery also scans LVM metadata for config-less
 * volumes; on the current production thin pools that can exceed 25 seconds.
 * Keep this below the route's 800-second ceiling while allowing a real scan.
 */
export const PROXMOX_ORPHAN_DISCOVERY_TIMEOUT_MS = 90_000;

type SupabaseAdmin = NonNullable<typeof supabaseAdmin>;

type ProxmoxHostRow = {
  id: string;
  status: "active" | "draining" | "maintenance";
};

interface DbInstanceVmidRow {
  proxmox_vmid: number | null;
}

/** A running VM observed on a Proxmox host. */
export interface ProxmoxLiveVm {
  vmid: number;
  name: string | null;
  memoryMb: number | null;
  cores: number | null;
}

/** A live VM with no matching `hermes_instances` row. */
export interface ProxmoxOrphanVm extends ProxmoxLiveVm {
  hostId: string;
}

/**
 * A leftover `vm-<vmid>-*` logical volume whose VMID has NO qemu-server config
 * on the host. These are the doom-loop landmines a crashed `qm clone` leaves
 * behind: `qm list` can't see them, so the VMID allocator keeps re-picking the
 * slot and every clone dies "lvcreate ... already exists" (incident
 * 2026-06-13, vmid 1246 on fixturenodea). The provisioner now skips LV-owning VMIDs
 * and tears its own partial LVs down, but pre-existing orphans still need a
 * reaper to reclaim the disk space and keep the skip-list from growing.
 */
export interface ProxmoxOrphanLv {
  vmid: number;
  /** "<vg>/<lv>" device path, e.g. "vg0/vm-1246-cloudinit". */
  vgLv: string;
}

/** Per-host outcome of an orphan-LV reap pass. Values are "<vg>/<lv>" paths. */
export interface OrphanLvReapResult {
  removed: string[];
  /** Skipped because the VMID gained a config (live/half-built VM) — never reaped. */
  skipped: string[];
  failed: string[];
}

/**
 * An orphan VM classified as cold-restore debris: its name carries an
 * instance UUID whose `hermes_instances` row is cold_archived/deleted with a
 * NULL proxmox_vmid (the row points at nothing — the vmid-keyed detection
 * above can see the VM but no other sweep will ever act on it).
 */
export interface LeakedRestoreClone {
  hostId: string;
  vmid: number;
  /** Exact observed VM name; the stop script re-checks this at run time. */
  name: string;
  instanceId: string;
  lifecycleState: string;
}

interface ProxmoxOrphanHostSummary {
  hostId: string;
  liveCount: number;
  dbCount: number;
  orphanCount: number;
  /** Count of config-less `vm-<vmid>-*` LV groups detected on this host. */
  orphanLvCount: number;
  /** Count of orphan LVs actually lvremove'd (0 unless reaping is enabled). */
  orphanLvReaped: number;
  /** Orphan VMs classified as leaked restore clones on this host. */
  restoreClonesDetected: number;
  /** Leaked restore clones stopped (0 unless the clone reaper is enabled). */
  restoreClonesStopped: number;
  /** True when the host's SSH/env wasn't reachable; orphans were not computed. */
  skipped: boolean;
  skipReason?: string;
}

export interface ProxmoxOrphanSweepSummary {
  hostsScanned: number;
  hostsSkipped: number;
  orphansDetected: number;
  orphanLvsDetected: number;
  orphanLvsReaped: number;
  /** Whether HERMES_ORPHAN_LV_REAP_ENABLED was set for this sweep. */
  reapEnabled: boolean;
  /** Orphan VMs classified as leaked restore clones across the fleet. */
  restoreClonesDetected: number;
  /** Leaked restore clones `qm stop`ped (0 unless the clone reaper is enabled). */
  restoreClonesStopped: number;
  /** Whether HERMES_RESTORE_CLONE_REAPER_ENABLED was set for this sweep. */
  restoreCloneReaperEnabled: boolean;
  hosts: ProxmoxOrphanHostSummary[];
}

/**
 * Parse the bundled SSH script output. Format (one block per running VM):
 *
 *   BEGIN <vmid>
 *   name: <name>
 *   memory: <mb>
 *   cores: <n>
 *   END <vmid>
 *
 * Only the keys we care about are emitted by the script (`grep -E`). Lines
 * outside any BEGIN/END pair are ignored — this keeps the parser robust to
 * harmless shell stderr that slipped onto stdout.
 *
 * Filters out VMIDs >= TEMPLATE_VMID_THRESHOLD so a template that happens
 * to be marked running doesn't get reported as an orphan.
 */
export function parseLiveVmsFromHostScript(stdout: string): ProxmoxLiveVm[] {
  const out: ProxmoxLiveVm[] = [];
  const lines = stdout.split("\n");
  let currentVmid: number | null = null;
  let fields: Record<string, string> = {};

  const flush = () => {
    if (currentVmid === null) return;
    if (currentVmid < TEMPLATE_VMID_THRESHOLD) {
      const memoryRaw = fields.memory ? Number.parseInt(fields.memory, 10) : Number.NaN;
      const coresRaw = fields.cores ? Number.parseInt(fields.cores, 10) : Number.NaN;
      out.push({
        vmid: currentVmid,
        name: fields.name?.trim() || null,
        memoryMb: Number.isFinite(memoryRaw) ? memoryRaw : null,
        cores: Number.isFinite(coresRaw) ? coresRaw : null,
      });
    }
    currentVmid = null;
    fields = {};
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const beginMatch = /^BEGIN\s+(\d+)$/.exec(line);
    if (beginMatch) {
      flush();
      const parsed = Number.parseInt(beginMatch[1] ?? "", 10);
      currentVmid = Number.isFinite(parsed) ? parsed : null;
      continue;
    }
    const endMatch = /^END\s+(\d+)$/.exec(line);
    if (endMatch) {
      flush();
      continue;
    }
    if (currentVmid === null) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key === "name" || key === "memory" || key === "cores") {
      fields[key] = value;
    }
  }
  flush();
  return out;
}

/**
 * Pure set-subtract: live VMIDs not represented in the DB result.
 * Both inputs are pre-filtered (templates already dropped from live;
 * DB query already excludes `lifecycle_state='deleted'`).
 */
export function findOrphanVmids(
  liveVmids: readonly number[],
  dbVmids: readonly number[],
): number[] {
  const dbSet = new Set(dbVmids);
  const orphans: number[] = [];
  for (const vmid of liveVmids) {
    if (!dbSet.has(vmid)) orphans.push(vmid);
  }
  return orphans;
}

/**
 * Pure entry point for tests: given a host's parsed `qm list` + a DB VMID
 * list, return the orphan VMs (with metadata). The cron route uses this
 * after fetching both sides from real sources.
 */
export function computeOrphansForHost(
  hostId: string,
  liveVms: readonly ProxmoxLiveVm[],
  dbVmids: readonly number[],
): ProxmoxOrphanVm[] {
  const dbSet = new Set(dbVmids);
  const out: ProxmoxOrphanVm[] = [];
  for (const vm of liveVms) {
    if (vm.vmid >= TEMPLATE_VMID_THRESHOLD) continue;
    if (dbSet.has(vm.vmid)) continue;
    out.push({ ...vm, hostId });
  }
  return out;
}

export const PROXMOX_ORPHAN_DISCOVERY_SCRIPT = `set -uo pipefail
qm list 2>/dev/null | awk 'NR>1 && $3=="running" {print $1}' | while read vmid; do
  if [ -z "$vmid" ]; then continue; fi
  echo "BEGIN $vmid"
  qm config "$vmid" 2>/dev/null | grep -E '^(name|memory|cores):' || true
  echo "END $vmid"
done
# Orphan-LV scan: vm-<vmid>-* logical volumes whose VMID has neither a QEMU
# nor an LXC config are the doom-loop landmines a crashed clone leaves behind (incident
# 2026-06-13, vmid 1246 on fixturenodea). qm list can't see them. Emit one ORPHAN_LV
# line per leftover LV so the sweep can report (and, when reaping is enabled,
# remove) it. Read-only here — this script never destroys anything.
lvs --noheadings -o vg_name,lv_name 2>/dev/null | while read -r vg lv; do
  case "$lv" in
    vm-*-*) ;;
    *) continue ;;
  esac
  lv_vmid="$(printf '%s' "$lv" | sed -n 's/^vm-\\([0-9][0-9]*\\)-.*/\\1/p')"
  if [ -z "$lv_vmid" ]; then continue; fi
  if [ "$lv_vmid" -ge ${TEMPLATE_VMID_THRESHOLD} ]; then continue; fi
  if qm config "$lv_vmid" >/dev/null 2>&1 || pct config "$lv_vmid" >/dev/null 2>&1; then continue; fi
  echo "ORPHAN_LV $lv_vmid $vg/$lv"
done
`;

/**
 * Parse `ORPHAN_LV <vmid> <vg>/<lv>` lines emitted by HOST_DISCOVERY_SCRIPT.
 * Drops template-range VMIDs defensively and ignores any other output (the
 * BEGIN/END VM blocks, harmless stderr) so it composes with
 * parseLiveVmsFromHostScript over the same stdout.
 */
export function parseOrphanLvsFromHostScript(stdout: string): ProxmoxOrphanLv[] {
  const out: ProxmoxOrphanLv[] = [];
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    const m = /^ORPHAN_LV\s+(\d+)\s+(\S+)$/.exec(line);
    if (!m) continue;
    const vmid = Number.parseInt(m[1] ?? "", 10);
    const vgLv = m[2] ?? "";
    if (!Number.isFinite(vmid) || vmid <= 0 || vmid >= TEMPLATE_VMID_THRESHOLD) continue;
    if (!isSafeVgLvPath(vgLv)) continue;
    out.push({ vmid, vgLv });
  }
  return out;
}

/**
 * Missing QEMU and LXC configs are not sufficient proof that an LV is abandoned:
 * the database may still own that VMID after a host/config failure. Exclude every
 * VMID referenced by a non-deleted row before building the destructive reap script.
 */
export function filterUnownedOrphanLvs(
  candidates: readonly ProxmoxOrphanLv[],
  dbOwnedVmids: readonly number[],
): ProxmoxOrphanLv[] {
  const owned = new Set(dbOwnedVmids);
  return candidates.filter((candidate) => !owned.has(candidate.vmid));
}

/**
 * LVM VG/LV names are restricted to `[A-Za-z0-9+_.-]`. Reject anything else so
 * a malformed/hostile `lvs` line can never reach an interpolated `lvremove`.
 */
export function isSafeVgLvPath(vgLv: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9+_.-]*\/[A-Za-z0-9][A-Za-z0-9+_.-]*$/.test(vgLv);
}

function shQuote(value: string | number): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Reaping is OFF unless explicitly enabled — destroying disks is opt-in. */
export function isOrphanLvReapEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.HERMES_ORPHAN_LV_REAP_ENABLED?.trim().toLowerCase() === "true";
}

/**
 * Stopping leaked restore clones is OFF unless explicitly enabled. Even when
 * ON the action is `qm stop` + an ops_events flag — this sweep NEVER destroys
 * a VM (destruction stays a human/approved action; see the 2026-07-07
 * archive-verified destroy run for the manual procedure).
 */
export function isRestoreCloneReaperEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.HERMES_RESTORE_CLONE_REAPER_ENABLED?.trim().toLowerCase() === "true";
}

const INSTANCE_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Extract the instance UUID from a VM name when — and only when — the whole
 * name is a restore-clone signature: `hermes-<uuid>` (what
 * restore-vm-cold.sh stamps via `qm clone --name`) or a bare `<uuid>`.
 * Provisioned tenant VMs are named `hermes-<instanceName>-<id8>` and can
 * never match (an 8-char id fragment is not a UUID).
 */
export function instanceIdFromVmName(name: string | null | undefined): string | null {
  if (!name) return null;
  const trimmed = name.trim();
  const candidate = trimmed.startsWith("hermes-") ? trimmed.slice("hermes-".length) : trimmed;
  return INSTANCE_UUID_RE.test(candidate) ? candidate : null;
}

/** Instance-row shape the leaked-clone classifier needs. */
export interface InstanceLifecycleRow {
  id: string;
  lifecycle_state: string | null;
  proxmox_vmid: number | null;
}

/**
 * Lifecycle states in which a row's VM should not exist at all: the archive /
 * deletion flow destroyed it (or it never adopted). A running VM named after
 * such a row is restore debris.
 */
const LEAKED_CLONE_LIFECYCLE_STATES = ["cold_archived", "deleted"] as const;

/**
 * Pure classifier: which of a host's orphan VMs are leaked restore clones?
 * An orphan qualifies only when ALL hold:
 *   - its name encodes an instance UUID (see instanceIdFromVmName);
 *   - a `hermes_instances` row with that id exists;
 *   - that row's lifecycle_state is cold_archived/deleted; AND
 *   - the row's proxmox_vmid is NULL (points at nothing — if it pointed at a
 *     vmid, other reconcilers own it and this classifier must stay away).
 * Rows in any live/transitional state (active, restoring, provisioning, …)
 * never qualify: a restore in flight CASes the row OUT of the slot-freeing
 * states before its clone is even created.
 */
export function classifyLeakedRestoreClones(
  hostId: string,
  orphans: readonly ProxmoxOrphanVm[],
  rowsById: ReadonlyMap<string, InstanceLifecycleRow>,
): LeakedRestoreClone[] {
  const out: LeakedRestoreClone[] = [];
  for (const orphan of orphans) {
    if (orphan.vmid >= TEMPLATE_VMID_THRESHOLD) continue;
    const instanceId = instanceIdFromVmName(orphan.name);
    if (!instanceId || !orphan.name) continue;
    const row = rowsById.get(instanceId);
    if (!row) continue;
    if (row.proxmox_vmid !== null) continue;
    const state = row.lifecycle_state ?? "";
    if (!(LEAKED_CLONE_LIFECYCLE_STATES as readonly string[]).includes(state)) continue;
    out.push({
      hostId,
      vmid: orphan.vmid,
      name: orphan.name,
      instanceId,
      lifecycleState: state,
    });
  }
  return out;
}

/**
 * Build the guarded stop script for leaked restore clones. STOP ONLY — this
 * script contains no `qm destroy` and never will; destruction of restore
 * debris is a human action taken after archive verification.
 *
 * Run-time TOCTOU guard mirrors buildOrphanLvReapScript: each VMID is only
 * stopped when `qm config` STILL reports the exact name observed at detection
 * time, so a VMID recycled to another tenant between detect and stop is
 * skipped. Template-range VMIDs and non-signature names are dropped at build
 * time on top of that.
 */
export function buildRestoreCloneStopScript(
  targets: ReadonlyArray<{ vmid: number; expectedName: string }>,
): string {
  const calls = targets
    .filter(
      (t) =>
        Number.isInteger(t.vmid) &&
        t.vmid > 0 &&
        t.vmid < TEMPLATE_VMID_THRESHOLD &&
        instanceIdFromVmName(t.expectedName) !== null,
    )
    .map((t) => `stop_one ${shQuote(t.vmid)} ${shQuote(t.expectedName)}`)
    .join("\n");
  return `set -uo pipefail
stop_one() {
  vmid="$1"; expect="$2"
  name=$(qm config "$vmid" 2>/dev/null | awk -F': ' '/^name:/{print $2; exit}')
  if [ "\${name:-}" != "$expect" ]; then echo "CLONE_STOP_SKIP_NAME $vmid \${name:-absent}"; return 0; fi
  if qm stop "$vmid" --timeout 25 >/dev/null 2>&1; then
    echo "CLONE_STOP_OK $vmid"
  else
    echo "CLONE_STOP_FAIL $vmid"
  fi
}
${calls}
`;
}

/** Per-host outcome of a leaked-clone stop pass. Values are VMIDs. */
export interface RestoreCloneStopResult {
  stopped: number[];
  skipped: number[];
  failed: number[];
}

/** Parse the CLONE_STOP_* lines emitted by buildRestoreCloneStopScript. */
export function parseRestoreCloneStopOutput(stdout: string): RestoreCloneStopResult {
  const result: RestoreCloneStopResult = { stopped: [], skipped: [], failed: [] };
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    const m = /^(CLONE_STOP_[A-Z_]+)\s+(\d+)/.exec(line);
    if (!m) continue;
    const vmid = Number.parseInt(m[2] ?? "", 10);
    if (!Number.isFinite(vmid)) continue;
    if (m[1] === "CLONE_STOP_OK") result.stopped.push(vmid);
    else if (m[1] === "CLONE_STOP_FAIL") result.failed.push(vmid);
    else if (m[1]?.startsWith("CLONE_STOP_SKIP")) result.skipped.push(vmid);
  }
  return result;
}

/**
 * Build the host script that lvremoves confirmed orphan LVs. Every candidate is
 * re-checked at run time: an LV is only removed when its VMID STILL has no
 * QEMU or LXC config (TOCTOU guard against a guest that started between detect
 * and reap) and the LV path still ends in "vm-<vmid>-...". A VMID that gained a
 * config is a live/half-built VM — its disks are never touched.
 */
export function buildOrphanLvReapScript(
  candidates: ReadonlyArray<ProxmoxOrphanLv>,
): string {
  const calls = candidates
    .filter((c) => Number.isFinite(c.vmid) && c.vmid > 0 && isSafeVgLvPath(c.vgLv))
    .map((c) => `reap_one ${shQuote(c.vmid)} ${shQuote(c.vgLv)}`)
    .join("\n");
  return `set -uo pipefail
reap_one() {
  vmid="$1"
  lvpath="$2"
  # Only reap a VMID that STILL has neither a QEMU nor an LXC config. Either
  # config means a live or in-flight guest, so its disks must not be touched.
  if qm config "$vmid" >/dev/null 2>&1 || pct config "$vmid" >/dev/null 2>&1; then
    echo "ORPHAN_LV_REAP_SKIP_HAS_CONFIG $vmid $lvpath"
    return 0
  fi
  case "$lvpath" in
    */vm-"$vmid"-*) ;;
    *) echo "ORPHAN_LV_REAP_SKIP_BAD_PATH $vmid $lvpath"; return 0 ;;
  esac
  if lvremove -f "$lvpath" >/dev/null 2>&1; then
    echo "ORPHAN_LV_REAP_OK $vmid $lvpath"
  else
    echo "ORPHAN_LV_REAP_FAIL $vmid $lvpath"
  fi
}
${calls}
`;
}

/** Parse the ORPHAN_LV_REAP_* lines emitted by buildOrphanLvReapScript. */
export function parseOrphanLvReapOutput(stdout: string): OrphanLvReapResult {
  const result: OrphanLvReapResult = { removed: [], skipped: [], failed: [] };
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    const m = /^(ORPHAN_LV_REAP_[A-Z_]+)\s+\d+\s+(\S+)$/.exec(line);
    if (!m) continue;
    const tag = m[1];
    const vgLv = m[2] ?? "";
    if (tag === "ORPHAN_LV_REAP_OK") result.removed.push(vgLv);
    else if (tag === "ORPHAN_LV_REAP_FAIL") result.failed.push(vgLv);
    else if (tag?.startsWith("ORPHAN_LV_REAP_SKIP")) result.skipped.push(vgLv);
  }
  return result;
}

async function loadActiveProxmoxHosts(
  supabase: SupabaseAdmin,
): Promise<ProxmoxHostRow[]> {
  const { data, error } = await supabase
    .from("proxmox_hosts")
    .select("id, status")
    .in("status", ["active", "draining"]);
  if (error) {
    throw new Error(`proxmox_hosts query failed: ${error.message}`);
  }
  return (data ?? []) as ProxmoxHostRow[];
}

async function loadDbVmidsForHost(
  supabase: SupabaseAdmin,
  hostId: string,
  liveVmids: number[],
): Promise<number[]> {
  if (liveVmids.length === 0) return [];
  const { data, error } = await supabase
    .from("hermes_instances")
    .select("proxmox_vmid")
    .eq("proxmox_node", hostId)
    .in("proxmox_vmid", liveVmids)
    .neq("lifecycle_state", "deleted");
  if (error) {
    throw new Error(`hermes_instances query failed: ${error.message}`);
  }
  const rows = (data ?? []) as DbInstanceVmidRow[];
  const vmids: number[] = [];
  for (const row of rows) {
    if (typeof row.proxmox_vmid === "number" && Number.isFinite(row.proxmox_vmid)) {
      vmids.push(row.proxmox_vmid);
    }
  }
  return vmids;
}

/**
 * Load the instance rows named by orphan VMs (uuid extracted from the VM
 * name) so classifyLeakedRestoreClones can cross-check lifecycle state. Reads
 * only; soft-deleted rows are INCLUDED on purpose — a deleted row with a
 * running VM is exactly the leak signature.
 */
async function loadInstanceRowsByIds(
  supabase: SupabaseAdmin,
  ids: readonly string[],
): Promise<Map<string, InstanceLifecycleRow>> {
  const out = new Map<string, InstanceLifecycleRow>();
  if (ids.length === 0) return out;
  const { data, error } = await supabase
    .from("hermes_instances")
    .select("id, lifecycle_state, proxmox_vmid")
    .in("id", [...ids]);
  if (error) {
    throw new Error(`hermes_instances id lookup failed: ${error.message}`);
  }
  for (const row of (data ?? []) as InstanceLifecycleRow[]) {
    if (typeof row.id === "string" && row.id.length > 0) out.set(row.id, row);
  }
  return out;
}

type ResolvedHostEnv = ReturnType<typeof resolveProxmoxHostEnv>;

async function discoverLiveVmsForHost(hostId: string): Promise<
  | { ok: true; vms: ProxmoxLiveVm[]; orphanLvs: ProxmoxOrphanLv[]; env: ResolvedHostEnv }
  | { ok: false; reason: string }
> {
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
    result = await runProxmoxHostScript(
      PROXMOX_ORPHAN_DISCOVERY_SCRIPT,
      env,
      PROXMOX_ORPHAN_DISCOVERY_TIMEOUT_MS,
    );
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
  return {
    ok: true,
    vms: parseLiveVmsFromHostScript(result.stdout),
    orphanLvs: parseOrphanLvsFromHostScript(result.stdout),
    env,
  };
}

/**
 * Run the (gated) reap script for a host. Best-effort: a thrown/failed call
 * leaves the candidates in place for the next sweep rather than guessing.
 */
async function reapOrphanLvsForHost(
  env: ResolvedHostEnv,
  candidates: ReadonlyArray<ProxmoxOrphanLv>,
): Promise<OrphanLvReapResult> {
  if (candidates.length === 0) return { removed: [], skipped: [], failed: [] };
  let result: HostScriptResult;
  try {
    result = await runProxmoxHostScript(
      buildOrphanLvReapScript(candidates),
      env,
      PROXMOX_ORPHAN_DISCOVERY_TIMEOUT_MS,
    );
  } catch {
    return { removed: [], skipped: [], failed: candidates.map((c) => c.vgLv) };
  }
  if (!result.ok) {
    return { removed: [], skipped: [], failed: candidates.map((c) => c.vgLv) };
  }
  return parseOrphanLvReapOutput(result.stdout);
}

export async function runProxmoxOrphanSweep(): Promise<ProxmoxOrphanSweepSummary> {
  if (!supabaseAdmin) {
    throw new Error("Database not configured");
  }

  const reapEnabled = isOrphanLvReapEnabled();
  const restoreCloneReaperEnabled = isRestoreCloneReaperEnabled();
  const hosts = await loadActiveProxmoxHosts(supabaseAdmin);
  const summary: ProxmoxOrphanSweepSummary = {
    hostsScanned: 0,
    hostsSkipped: 0,
    orphansDetected: 0,
    orphanLvsDetected: 0,
    orphanLvsReaped: 0,
    reapEnabled,
    restoreClonesDetected: 0,
    restoreClonesStopped: 0,
    restoreCloneReaperEnabled,
    hosts: [],
  };

  for (const host of hosts) {
    const discovery = await discoverLiveVmsForHost(host.id);
    if (!discovery.ok) {
      summary.hostsSkipped += 1;
      summary.hosts.push({
        hostId: host.id,
        liveCount: 0,
        dbCount: 0,
        orphanCount: 0,
        orphanLvCount: 0,
        orphanLvReaped: 0,
        restoreClonesDetected: 0,
        restoreClonesStopped: 0,
        skipped: true,
        skipReason: discovery.reason,
      });
      log.warn("proxmox orphan sweep: host skipped", {
        source: SOURCE,
        failureType: "proxmox_orphan_host_skipped",
        hostId: host.id,
        reason: discovery.reason,
      });
      continue;
    }

    const liveVms = discovery.vms.filter((vm) => vm.vmid < TEMPLATE_VMID_THRESHOLD);
    const liveVmids = liveVms.map((vm) => vm.vmid);
    const observedVmids = [
      ...new Set([...liveVmids, ...discovery.orphanLvs.map((lv) => lv.vmid)]),
    ];
    let dbVmids: number[];
    try {
      dbVmids = await loadDbVmidsForHost(supabaseAdmin, host.id, observedVmids);
    } catch (err) {
      summary.hostsSkipped += 1;
      const reason = err instanceof Error ? err.message : String(err);
      summary.hosts.push({
        hostId: host.id,
        liveCount: liveVms.length,
        dbCount: 0,
        orphanCount: 0,
        orphanLvCount: 0,
        orphanLvReaped: 0,
        restoreClonesDetected: 0,
        restoreClonesStopped: 0,
        skipped: true,
        skipReason: reason,
      });
      log.warn("proxmox orphan sweep: db lookup failed", {
        source: SOURCE,
        failureType: "proxmox_orphan_db_lookup_failed",
        hostId: host.id,
        reason,
      });
      continue;
    }

    const orphans = computeOrphansForHost(host.id, liveVms, dbVmids);
    const orphanLvs = filterUnownedOrphanLvs(discovery.orphanLvs, dbVmids);
    summary.hostsScanned += 1;
    summary.orphansDetected += orphans.length;
    summary.orphanLvsDetected += orphanLvs.length;

    for (const orphan of orphans) {
      log.warn("proxmox orphan VM detected", {
        source: SOURCE,
        failureType: "proxmox_orphan_vm",
        hostId: orphan.hostId,
        vmid: orphan.vmid,
        name: orphan.name,
        memoryMb: orphan.memoryMb,
        cores: orphan.cores,
      });
    }

    // Leaked-restore-clone pass: orphan VMs whose name carries an instance
    // UUID are cross-checked against their DB row; cold_archived/deleted rows
    // with a NULL vmid mark the VM as restore debris. DB read happens AFTER
    // the VM was observed, so an in-flight restore (row CASed to 'restoring'
    // before its clone exists) can never classify.
    let leakedClones: LeakedRestoreClone[] = [];
    const namedIds = [
      ...new Set(
        orphans
          .map((o) => instanceIdFromVmName(o.name))
          .filter((id): id is string => id !== null),
      ),
    ];
    if (namedIds.length > 0) {
      try {
        const rowsById = await loadInstanceRowsByIds(supabaseAdmin, namedIds);
        leakedClones = classifyLeakedRestoreClones(host.id, orphans, rowsById);
      } catch (err) {
        // Classification is best-effort on top of detection; a failed lookup
        // just means these orphans stay in the generic-orphan bucket.
        log.warn("proxmox orphan sweep: leaked-clone row lookup failed", {
          source: SOURCE,
          failureType: "proxmox_leaked_clone_lookup_failed",
          hostId: host.id,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    summary.restoreClonesDetected += leakedClones.length;
    for (const clone of leakedClones) {
      log.warn("leaked cold-restore clone detected (running VM for archived/deleted row)", {
        source: SOURCE,
        failureType: "proxmox_leaked_restore_clone",
        hostId: clone.hostId,
        vmid: clone.vmid,
        name: clone.name,
        instanceId: clone.instanceId,
        lifecycleState: clone.lifecycleState,
        reaperEnabled: restoreCloneReaperEnabled,
      });
    }

    let restoreClonesStopped = 0;
    if (restoreCloneReaperEnabled && leakedClones.length > 0) {
      // STOP + FLAG only. Never destroy from a cron: a stopped clone costs
      // thin-pool but no RAM, survives for the operator to verify the archive
      // and destroy by hand, and a mistaken stop is fully reversible.
      const stopScript = buildRestoreCloneStopScript(
        leakedClones.map((c) => ({ vmid: c.vmid, expectedName: c.name })),
      );
      let stopResult: RestoreCloneStopResult = { stopped: [], skipped: [], failed: [] };
      try {
        const result = await runProxmoxHostScript(
          stopScript,
          discovery.env,
          PROXMOX_ORPHAN_DISCOVERY_TIMEOUT_MS,
        );
        if (result.ok) stopResult = parseRestoreCloneStopOutput(result.stdout);
      } catch {
        // best-effort; clones stay running and re-flag on the next sweep.
      }
      restoreClonesStopped = stopResult.stopped.length;
      summary.restoreClonesStopped += restoreClonesStopped;
      for (const clone of leakedClones) {
        const wasStopped = stopResult.stopped.includes(clone.vmid);
        await reportOpsEvent({
          source: "cron.detect_proxmox_orphans",
          severity: "warn",
          title: wasStopped
            ? "Leaked restore clone stopped (destroy left to operator)"
            : "Leaked restore clone flagged (stop did not land)",
          message: `VM ${clone.vmid} on ${clone.hostId} (name=${clone.name}) is a running clone of ${clone.lifecycleState} instance ${clone.instanceId} whose row has no vmid — cold-restore debris. ${
            wasStopped
              ? "qm stop applied; verify the archive before any destroy."
              : "qm stop was skipped or failed; VM left running for the next sweep."
          }`,
          instanceId: clone.instanceId,
          metadata: {
            failureType: "proxmox_leaked_restore_clone",
            hostId: clone.hostId,
            vmid: clone.vmid,
            name: clone.name,
            lifecycleState: clone.lifecycleState,
            stopped: wasStopped,
          },
        });
      }
    }

    for (const lv of orphanLvs) {
      log.warn("proxmox orphan LV detected", {
        source: SOURCE,
        failureType: "proxmox_orphan_lv",
        hostId: host.id,
        vmid: lv.vmid,
        lv: lv.vgLv,
        reapEnabled,
      });
    }

    let orphanLvReaped = 0;
    if (reapEnabled && orphanLvs.length > 0) {
      // Defense-in-depth before destroying disks: never reap a VMID still
      // claimed by a non-deleted DB row (e.g. a missing-VM row awaiting
      // re-provision). If that lookup fails, skip reaping this host entirely
      // rather than guess — the allocator already skips LV-owning VMIDs, so a
      // deferred reap only costs disk space, never a doom-loop. The reap
      // script ALSO re-checks `qm config` per VMID at run time.
      let dbClaimed: Set<number> | null;
      try {
        dbClaimed = new Set(
          await loadDbVmidsForHost(
            supabaseAdmin,
            host.id,
            orphanLvs.map((l) => l.vmid),
          ),
        );
      } catch (err) {
        dbClaimed = null;
        log.warn("proxmox orphan sweep: reap DB guard failed, skipping reap", {
          source: SOURCE,
          failureType: "proxmox_orphan_lv_reap_guard_failed",
          hostId: host.id,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
      if (dbClaimed) {
        const reapable = orphanLvs.filter((l) => !dbClaimed.has(l.vmid));
        const reap = await reapOrphanLvsForHost(discovery.env, reapable);
        orphanLvReaped = reap.removed.length;
        summary.orphanLvsReaped += orphanLvReaped;
        log.warn("proxmox orphan LV reap complete", {
          source: SOURCE,
          failureType: "proxmox_orphan_lv_reaped",
          hostId: host.id,
          candidates: reapable.length,
          removed: reap.removed,
          skipped: reap.skipped,
          failed: reap.failed,
        });
      }
    }

    summary.hosts.push({
      hostId: host.id,
      liveCount: liveVms.length,
      dbCount: dbVmids.length,
      orphanCount: orphans.length,
      orphanLvCount: orphanLvs.length,
      orphanLvReaped,
      restoreClonesDetected: leakedClones.length,
      restoreClonesStopped,
      skipped: false,
    });
  }

  return summary;
}
