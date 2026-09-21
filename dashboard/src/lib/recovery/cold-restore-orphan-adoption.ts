/**
 * Cold-restore orphan adoption / self-heal sweep.
 *
 * Cold-restore runs synchronously inside the user's Start request, but
 * `restore-vm-cold.sh` (qmrestore + cold Docker pull + ACME + up-to-300s
 * health probe) routinely outlives the serverless function. When the
 * function dies first, the VM finishes cloning + booting on the host, but
 * NOTHING persists its coordinates or applies routing: the row is frozen at
 * `lifecycle_substate='restoring_starting'` with a NULL `proxmox_vmid`, then
 * later stamped `failed`. The gateway never finalizes (no Caddy site, no DNS)
 * so the user sees "could not connect to gateway". Worse: the `failed` row is
 * still `isFailedButRestorable` (vmid null + archive present), so every retry
 * CLONES ANOTHER VM — the orphans accumulate (live incident 2026-06-26:
 * instance fixturecase10 had THREE `hermes-<id>` clones on fixturenodea, all running, none
 * adopted, while its row sat at `failed`).
 *
 * `recover-stuck-restoring` can't help: it only promotes rows whose public
 * gateway already answers /health, and these have no routing/coords to probe.
 *
 * This sweep closes that gap by automating the manual recovery:
 *   1. Find rows stranded at `restoring_starting` with a null vmid + a valid
 *      archive (the unambiguous "restore started, never finalized" signature),
 *      older than the function-timeout window.
 *   2. Scan the active fleet for `hermes-<instanceId>` VMs.
 *   3a. If a healthy clone exists: ADOPT it — persist coords, apply routing
 *       (Caddy + DNS), promote to running — and REAP the duplicate clones.
 *   3b. If no clone exists (the restore failed before/at clone): RESET the row
 *       to a clean `cold_archived` state so the user can wake it normally and
 *       the next Start runs a clean single restore.
 *
 * Everything is idempotent and guarded: reaping only ever destroys a VM whose
 * name STILL matches `hermes-<instanceId>` and is NOT the adopted keeper and is
 * NOT claimed by any non-deleted DB row.
 */

import { applyRestoreRouting } from "@/lib/services/cold-storage-restore-routing";
import {
  buildClearedArchivePointerPatch,
  buildInstanceLifecyclePatch,
} from "@/lib/instance-lifecycle";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import {
  resolveProxmoxHostEnv,
  runProxmoxHostScript,
  type HostScriptResult,
  type ProxmoxHostRoutingConfig,
} from "@/lib/services/proxmox-instance-service";
import { supabaseAdmin } from "@/lib/supabase";

const SOURCE = "cold-restore-orphan-adoption";

/**
 * Only adopt restores older than the serverless function ceiling
 * (`recover-stuck-instances` route maxDuration = 300s). A row younger than
 * this could still be an in-flight restore whose function hasn't returned, and
 * we must never race a live `restore-vm-cold.sh`. 8 min gives a comfortable
 * margin past the 300s ceiling.
 */
const ORPHAN_RESTORE_STALE_MS = 8 * 60 * 1000;

/** Cap candidates per sweep so one bad run can't fan out unbounded SSH/host work. */
const MAX_CANDIDATES_PER_SWEEP = 25;

/** Per-host SSH budget for the reap script. */
const HOST_SCRIPT_TIMEOUT_MS = 30_000;

/**
 * Per-host SSH budget for the DISCOVERY script. Discovery serially curls each
 * running hermes VM's /health with a 5s ceiling, so a busy host blows a 30s
 * budget long before the scan completes (fixturenodea runs ~19 hermes VMs → worst
 * case ~100s). Under the old shared 30s budget the scan on exactly the
 * leak-prone hosts ALWAYS failed, was reported as "no clones", and the sweep
 * reset the row to cold — re-arming the Start retry while the clone kept
 * running (the 2026-07-07 fixturecase11 accumulation: the "reset to cold — no live
 * clone" ops event fired 9 minutes after a clone was born on fixturenodea).
 */
const DISCOVERY_SCRIPT_TIMEOUT_MS = 120_000;

/**
 * Lifecycle states a stranded-restore candidate row may sit in. The
 * unambiguous stranded signature is lifecycle_substate='restoring_starting'
 * with a NULL proxmox_vmid + a valid archive — only the restore CAS ever
 * writes that substate. 'restoring' = the function died mid-restore;
 * 'failed' = later stamped failed; 'provisioning' = a subsequent user
 * Redeploy / auto-restart stamped status='redeploying'
 * (buildInstanceLifecyclePatch maps it to lifecycle_state='provisioning')
 * OVER the stranded row without touching the substate — the Platinum
 * fixturecase12 shape (stuck since 2026-07-04, clone burning 4 GB on fixturenodea,
 * invisible to this sweep until 'provisioning' was included here).
 */
export const ORPHAN_RESTORE_CANDIDATE_LIFECYCLE_STATES = [
  "restoring",
  "failed",
  "provisioning",
] as const;

/** Templates live at 9000+; never touch them. */
const TEMPLATE_VMID_THRESHOLD = 9000;

type SupabaseAdmin = NonNullable<typeof supabaseAdmin>;
type ResolvedHostEnv = ReturnType<typeof resolveProxmoxHostEnv>;

interface OrphanRestoreCandidate {
  id: string;
  gateway_url: string;
  /** Last PVE host before archive (for routing cleanup); may be null. */
  proxmox_node: string | null;
  config: { infrastructure?: Record<string, unknown> } | null;
}

/** A running `hermes-<id>` VM observed on a host. */
export interface DiscoveredAgentVm {
  hostSlug: string;
  vmid: number;
  name: string;
  privateIp: string | null;
  /** HTTP code from a host-side `curl http://<privateIp>/health`; 0/null when unprobed. */
  healthCode: number | null;
}

export interface ColdRestoreAdoptionSummary {
  candidates: number;
  adopted: number;
  resetToCold: number;
  reaped: number;
  /** Clone found but not yet healthy / routing pending — left for the next sweep. */
  stillPending: number;
  errors: number;
  /**
   * True when at least one active host's discovery scan failed (SSH error /
   * timeout / unresolved env). While the fleet view is incomplete, "no clone
   * found" is NOT trustworthy, so reset-to-cold is withheld — resetting on a
   * failed scan is exactly how the 2026-07 leak re-armed itself (the clone was
   * on the unscanned host, the row went back to cold_archived, and the next
   * Start cloned ANOTHER VM).
   */
  scanIncomplete: boolean;
  /** Hosts whose discovery scan failed this sweep. */
  failedHosts: string[];
}

/** Outcome of one host's discovery scan. */
export interface HostDiscoveryOutcome {
  hostSlug: string;
  ok: boolean;
  vms: DiscoveredAgentVm[];
}

/**
 * Pure fold over per-host discovery outcomes: the flattened VM list plus
 * whether the fleet view is complete. Exported for tests — the sweep's
 * no-clone → reset-to-cold decision must be provably gated on `complete`.
 */
export function summarizeFleetDiscovery(outcomes: readonly HostDiscoveryOutcome[]): {
  vms: DiscoveredAgentVm[];
  complete: boolean;
  failedHosts: string[];
} {
  const failedHosts = outcomes.filter((o) => !o.ok).map((o) => o.hostSlug);
  return {
    vms: outcomes.flatMap((o) => (o.ok ? o.vms : [])),
    complete: failedHosts.length === 0,
    failedHosts,
  };
}

/**
 * Parse `VMINFO <vmid> <name> <ip|none> <healthCode>` lines emitted by the
 * discovery script. Ignores any other output (harmless stderr that slipped to
 * stdout) and drops template-range VMIDs defensively.
 */
export function parseDiscoveredVms(
  hostSlug: string,
  stdout: string,
): DiscoveredAgentVm[] {
  const out: DiscoveredAgentVm[] = [];
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    const m = /^VMINFO\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)$/.exec(line);
    if (!m) continue;
    const vmid = Number.parseInt(m[1] ?? "", 10);
    if (!Number.isFinite(vmid) || vmid <= 0 || vmid >= TEMPLATE_VMID_THRESHOLD) continue;
    const name = m[2] ?? "";
    if (!name.startsWith("hermes-")) continue;
    const ipRaw = m[3] ?? "none";
    const code = Number.parseInt(m[4] ?? "", 10);
    out.push({
      hostSlug,
      vmid,
      name,
      privateIp: ipRaw === "none" ? null : ipRaw,
      healthCode: Number.isFinite(code) ? code : null,
    });
  }
  return out;
}

/**
 * Group discovered `hermes-<id>` VMs by the instance id encoded in their name,
 * keeping only ids we actually have candidates for.
 */
export function matchVmsToCandidates(
  vms: readonly DiscoveredAgentVm[],
  candidateIds: ReadonlySet<string>,
): Map<string, DiscoveredAgentVm[]> {
  const byId = new Map<string, DiscoveredAgentVm[]>();
  for (const vm of vms) {
    const id = vm.name.slice("hermes-".length);
    if (!candidateIds.has(id)) continue;
    const list = byId.get(id) ?? [];
    list.push(vm);
    byId.set(id, list);
  }
  return byId;
}

/**
 * A clone counts as "serving" when its `/health` probe came back with any
 * 2xx/3xx/401/403. Post the Jun-2026 auth-hardening `/health` sits behind the
 * login gate and 302-redirects to `/login`, so a fully-healthy restored clone
 * no longer returns a bare 200 — demanding 200 here left healthy restores
 * unadopted forever (and the user's restored agent never came back). This
 * mirrors the provisioning readiness probe and isHandoffProbeReachable: a
 * 3xx/401/403 proves Caddy + the dashboard are up and routing. 5xx (Caddy up,
 * dashboard not ready yet), 404 (unknown-agent / no Caddy route) and 0
 * (unreachable) are still rejected so a half-booted clone is left for the next
 * sweep rather than adopted prematurely. (The discovery curl also follows
 * redirects, so in practice a serving clone now reports 200 again — this
 * predicate is the belt to that suspenders.)
 */
export function isAdoptableHealthCode(code: number | null): boolean {
  if (code === null) return false;
  return (code >= 200 && code <= 399) || code === 401 || code === 403;
}

/**
 * Choose which clone to keep when a restore left duplicates. Prefer a serving
 * VM (see isAdoptableHealthCode) with a known private IP; tie-break on the
 * lowest VMID for a deterministic, testable choice. Returns null when no clone
 * is adoptable (none serving / none has an IP) so the caller leaves the row for
 * the next sweep.
 */
export function pickKeeper(
  vms: readonly DiscoveredAgentVm[],
): { keeper: DiscoveredAgentVm; dupes: DiscoveredAgentVm[] } | null {
  const adoptable = vms
    .filter((v) => v.privateIp && isAdoptableHealthCode(v.healthCode))
    .sort((a, b) => a.vmid - b.vmid);
  if (adoptable.length === 0) return null;
  const keeper = adoptable[0]!;
  const dupes = vms.filter((v) => v.vmid !== keeper.vmid || v.hostSlug !== keeper.hostSlug);
  return { keeper, dupes };
}

/** Derive the public gateway host (FQDN) from a stored gateway_url. */
export function gatewayHostFromUrl(gatewayUrl: string): string | null {
  try {
    const h = new URL(gatewayUrl).host;
    return h || null;
  } catch {
    return gatewayUrl.replace(/^https?:\/\//, "").split("/")[0] || null;
  }
}

export const DISCOVERY_SCRIPT = `set -uo pipefail
qm list 2>/dev/null | awk 'NR>1 && $3=="running"{print $1}' | while read vmid; do
  [ -z "$vmid" ] && continue
  name=$(qm config "$vmid" 2>/dev/null | awk -F': ' '/^name:/{print $2; exit}')
  case "$name" in hermes-*) ;; *) continue ;; esac
  ip=$(qm config "$vmid" 2>/dev/null | grep -oE 'ip=[0-9.]+' | head -1 | cut -d= -f2)
  code=000
  if [ -n "$ip" ]; then
    code=$(curl -sSL -o /dev/null -w '%{http_code}' --max-time 5 "http://$ip/health" 2>/dev/null || echo 000)
  fi
  echo "VMINFO $vmid $name \${ip:-none} $code"
done
`;

/**
 * Build the guarded reap script. Each VMID is re-checked at run time: it is
 * only destroyed when `qm config` STILL reports the exact expected
 * `hermes-<id>` name (TOCTOU guard against a recycled VMID), so we can never
 * wipe a different tenant's VM.
 */
export function buildReapScript(
  targets: ReadonlyArray<{ vmid: number; expectedName: string }>,
): string {
  const calls = targets
    .filter((t) => Number.isFinite(t.vmid) && t.vmid > 0 && t.vmid < TEMPLATE_VMID_THRESHOLD)
    .filter((t) => /^hermes-[0-9a-fA-F-]{36}$/.test(t.expectedName))
    .map((t) => `reap_one ${t.vmid} ${t.expectedName}`)
    .join("\n");
  return `set -uo pipefail
reap_one() {
  vmid="$1"; expect="$2"
  name=$(qm config "$vmid" 2>/dev/null | awk -F': ' '/^name:/{print $2; exit}')
  if [ "$name" != "$expect" ]; then echo "REAP_SKIP_NAME $vmid $name"; return 0; fi
  qm stop "$vmid" --timeout 25 >/dev/null 2>&1 || true
  if qm destroy "$vmid" --purge 1 --destroy-unreferenced-disks 1 >/dev/null 2>&1; then
    echo "REAP_OK $vmid"
  else
    echo "REAP_FAIL $vmid"
  fi
}
${calls}
`;
}

/** Count `REAP_OK` lines from the reap script output. */
export function countReaped(stdout: string): number {
  let n = 0;
  for (const line of stdout.split("\n")) {
    if (/^REAP_OK\s+\d+$/.test(line.trim())) n += 1;
  }
  return n;
}

async function loadActiveHostSlugs(supabase: SupabaseAdmin): Promise<string[]> {
  const { data, error } = await supabase
    .from("proxmox_hosts")
    .select("id, status")
    .in("status", ["active", "draining"]);
  if (error) throw new Error(`proxmox_hosts query failed: ${error.message}`);
  return (data ?? [])
    .map((r) => (r as { id: string }).id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

async function loadOrphanRestoreCandidates(
  supabase: SupabaseAdmin,
  cutoffIso: string,
): Promise<OrphanRestoreCandidate[]> {
  // Signature of a restore that started (CAS set restoring_starting) but never
  // finalized: substate still 'restoring_starting', no live vmid, a valid
  // archive to fall back on, and a populated gateway_url to route. See
  // ORPHAN_RESTORE_CANDIDATE_LIFECYCLE_STATES for why 'provisioning' is in the
  // state list alongside 'restoring' and 'failed'.
  const { data, error } = await supabase
    .from("hermes_instances")
    .select("id, gateway_url, proxmox_node, config")
    .eq("lifecycle_substate", "restoring_starting")
    .is("proxmox_vmid", null)
    .not("gateway_url", "is", null)
    .not("archive_uri", "is", null)
    .not("archive_sha256", "is", null)
    .is("deleted_at", null)
    .in("lifecycle_state", [...ORPHAN_RESTORE_CANDIDATE_LIFECYCLE_STATES])
    .lt("last_lifecycle_transition_at", cutoffIso)
    .limit(MAX_CANDIDATES_PER_SWEEP);
  if (error) throw new Error(`orphan-restore candidate query failed: ${error.message}`);
  return (data ?? []).filter(
    (r): r is OrphanRestoreCandidate =>
      typeof (r as OrphanRestoreCandidate).gateway_url === "string" &&
      (r as OrphanRestoreCandidate).gateway_url.trim().length > 0,
  );
}

async function discoverAgentVmsForHost(hostSlug: string): Promise<HostDiscoveryOutcome> {
  // A failed scan must be DISTINGUISHABLE from "host has no clones": returning
  // [] for both is what made the sweep reset rows to cold while their clones
  // kept running on the host it couldn't scan (2026-07-07 leak class).
  const hostConfig: ProxmoxHostRoutingConfig = {
    hostId: hostSlug,
    hostSlug,
    failClosed: false,
  };
  let env: ResolvedHostEnv;
  try {
    env = resolveProxmoxHostEnv(hostConfig, process.env);
  } catch {
    return { hostSlug, ok: false, vms: [] };
  }
  let result: HostScriptResult;
  try {
    result = await runProxmoxHostScript(DISCOVERY_SCRIPT, env, DISCOVERY_SCRIPT_TIMEOUT_MS);
  } catch {
    return { hostSlug, ok: false, vms: [] };
  }
  if (!result.ok) return { hostSlug, ok: false, vms: [] };
  return { hostSlug, ok: true, vms: parseDiscoveredVms(hostSlug, result.stdout) };
}

async function resetCandidateToCold(
  supabase: SupabaseAdmin,
  candidate: OrphanRestoreCandidate,
): Promise<boolean> {
  // No live clone found — the restore failed before/at clone. Return the row to
  // a clean, wake-able cold_archived state (canonical shape: stopped +
  // cold_archived + paused_reason='cold_archived' + null coords).
  const { error } = await supabase
    .from("hermes_instances")
    .update({
      status: "stopped",
      lifecycle_state: "cold_archived",
      lifecycle_substate: null,
      paused_reason: "cold_archived",
      proxmox_node: null,
      proxmox_vmid: null,
      ipv4_address: null,
      auto_restart_attempts: 0,
      last_lifecycle_transition_at: new Date().toISOString(),
    })
    .eq("id", candidate.id)
    .eq("lifecycle_substate", "restoring_starting");
  if (error) {
    log.warn("cold-restore self-heal: reset-to-cold failed", {
      source: SOURCE,
      failureType: "cold_restore_reset_to_cold_failed",
      instanceId: candidate.id,
      reason: error.message,
    });
    return false;
  }
  return true;
}

async function adoptKeeper(
  supabase: SupabaseAdmin,
  candidate: OrphanRestoreCandidate,
  keeper: DiscoveredAgentVm,
): Promise<"adopted" | "pending" | "error"> {
  const gatewayHost = gatewayHostFromUrl(candidate.gateway_url);
  if (!gatewayHost || !keeper.privateIp) return "error";

  // 1. Persist the discovered VM's coordinates and re-claim the row as
  //    'restoring' so a concurrent pass doesn't double-adopt. Guard on the
  //    stranded signature so we never clobber a row that moved on.
  const infra = {
    ...(candidate.config?.infrastructure ?? {}),
    node: keeper.hostSlug,
    vmid: keeper.vmid,
    hostSlug: keeper.hostSlug,
    provider: "proxmox",
    privateIpv4: keeper.privateIp,
    gatewayHost,
    hostEnvPrefix: `PROXMOX_${keeper.hostSlug.toUpperCase()}_`,
  };
  const claim = await supabase
    .from("hermes_instances")
    .update({
      lifecycle_state: "restoring",
      lifecycle_substate: "restore_health_pending",
      status: "provisioning",
      proxmox_node: keeper.hostSlug,
      proxmox_vmid: keeper.vmid,
      ipv4_address: keeper.privateIp,
      config: { ...(candidate.config ?? {}), infrastructure: infra },
      last_lifecycle_transition_at: new Date().toISOString(),
    })
    .eq("id", candidate.id)
    .eq("lifecycle_substate", "restoring_starting")
    .is("proxmox_vmid", null)
    .select("id")
    .maybeSingle();
  if (claim.error || !claim.data) {
    // Another pass claimed it, or it moved — not our row to adopt.
    return "pending";
  }

  // 2. Apply routing: host Caddy site + Cloudflare A record + old-host cleanup.
  const routing = await applyRestoreRouting({
    instanceId: candidate.id,
    gatewayHost,
    newPrivateIp: keeper.privateIp,
    newHostSlug: keeper.hostSlug,
    oldHostSlug: candidate.proxmox_node,
  });
  if (!routing.hostCaddy.ok) {
    // Leave the row 'restoring' (coords now persisted) for the next sweep to
    // retry routing; the VM is live and claimed, so we won't re-clone.
    log.warn("cold-restore self-heal: routing host-caddy failed, leaving for retry", {
      source: SOURCE,
      failureType: "cold_restore_adopt_routing_failed",
      instanceId: candidate.id,
      hostSlug: keeper.hostSlug,
      reason: routing.hostCaddy.reason,
    });
    return "pending";
  }

  // 3. Origin is healthy (we discovered it serving 200) and routing landed →
  //    promote to running/active. We gate promotion on the origin health from
  //    discovery rather than a public probe so Cloudflare propagation lag can't
  //    bounce a genuinely-recovered box back to pending.
  //
  // Origin confirmed serving, so the adopted clone is live: drop the archive
  // pointer, or a later re-pause leaves the row permanently un-archivable. See
  // buildClearedArchivePointerPatch.
  const promote = await supabase
    .from("hermes_instances")
    .update({
      ...buildInstanceLifecyclePatch("running"),
      ...buildClearedArchivePointerPatch(),
      lifecycle_substate: null,
    })
    .eq("id", candidate.id)
    .eq("lifecycle_state", "restoring");
  if (promote.error) {
    log.warn("cold-restore self-heal: promote failed", {
      source: SOURCE,
      failureType: "cold_restore_adopt_promote_failed",
      instanceId: candidate.id,
      reason: promote.error.message,
    });
    return "error";
  }
  return "adopted";
}

async function reapDuplicates(
  dupes: readonly DiscoveredAgentVm[],
  instanceId: string,
): Promise<number> {
  const byHost = new Map<string, DiscoveredAgentVm[]>();
  for (const d of dupes) {
    const list = byHost.get(d.hostSlug) ?? [];
    list.push(d);
    byHost.set(d.hostSlug, list);
  }
  let reaped = 0;
  for (const [hostSlug, vms] of byHost) {
    let env: ResolvedHostEnv;
    try {
      env = resolveProxmoxHostEnv({ hostId: hostSlug, hostSlug, failClosed: false }, process.env);
    } catch {
      continue;
    }
    const script = buildReapScript(
      vms.map((v) => ({ vmid: v.vmid, expectedName: `hermes-${instanceId}` })),
    );
    try {
      const result = await runProxmoxHostScript(script, env, HOST_SCRIPT_TIMEOUT_MS);
      if (result.ok) reaped += countReaped(result.stdout);
    } catch {
      // best-effort; the orphan-detection sweep will keep flagging leftovers.
    }
  }
  return reaped;
}

export async function runColdRestoreOrphanAdoptionSweep(): Promise<ColdRestoreAdoptionSummary> {
  const db = supabaseAdmin;
  if (!db) throw new Error("Supabase admin client not configured");

  const summary: ColdRestoreAdoptionSummary = {
    candidates: 0,
    adopted: 0,
    resetToCold: 0,
    reaped: 0,
    stillPending: 0,
    errors: 0,
    scanIncomplete: false,
    failedHosts: [],
  };

  const cutoffIso = new Date(Date.now() - ORPHAN_RESTORE_STALE_MS).toISOString();
  const candidates = await loadOrphanRestoreCandidates(db, cutoffIso);
  summary.candidates = candidates.length;
  if (candidates.length === 0) return summary;

  // Only pay for a fleet scan when there's actually a stranded restore.
  const candidateIds = new Set(candidates.map((c) => c.id));
  const hostSlugs = await loadActiveHostSlugs(db);
  const perHost = await Promise.all(hostSlugs.map((h) => discoverAgentVmsForHost(h)));
  const discovery = summarizeFleetDiscovery(perHost);
  summary.scanIncomplete = !discovery.complete;
  summary.failedHosts = discovery.failedHosts;
  if (!discovery.complete) {
    log.warn("cold-restore self-heal: fleet scan incomplete; reset-to-cold withheld this sweep", {
      source: SOURCE,
      failureType: "cold_restore_discovery_incomplete",
      failedHosts: discovery.failedHosts,
    });
  }
  const vmsById = matchVmsToCandidates(discovery.vms, candidateIds);

  for (const candidate of candidates) {
    const matches = vmsById.get(candidate.id) ?? [];
    try {
      if (matches.length === 0) {
        // "No clone anywhere" is only actionable when EVERY host was actually
        // scanned. With a failed host in the mix the clone may simply be
        // invisible, and resetting the row to cold re-arms the Start retry
        // loop that leaks a fresh clone per attempt.
        if (!discovery.complete) {
          summary.stillPending += 1;
          continue;
        }
        if (await resetCandidateToCold(db, candidate)) {
          summary.resetToCold += 1;
          await reportOpsEvent({
            source: "cron.cold_restore_self_heal",
            severity: "info",
            title: "Cold-restore self-heal: stranded restore reset to cold",
            message: `Instance ${candidate.id} was stranded at restoring_starting with no live clone; reset to cold_archived so it wakes cleanly on the next Start.`,
            instanceId: candidate.id,
            metadata: { failureType: "cold_restore_reset_to_cold", instanceId: candidate.id },
          });
        }
        continue;
      }

      const picked = pickKeeper(matches);
      if (!picked) {
        // Clone(s) exist but none healthy yet — let the box finish booting.
        summary.stillPending += 1;
        continue;
      }

      const outcome = await adoptKeeper(db, candidate, picked.keeper);
      if (outcome === "adopted") {
        summary.adopted += 1;
        const reaped = await reapDuplicates(picked.dupes, candidate.id);
        summary.reaped += reaped;
        log.info("cold-restore self-heal: adopted orphaned restore", {
          source: SOURCE,
          instanceId: candidate.id,
          hostSlug: picked.keeper.hostSlug,
          vmid: picked.keeper.vmid,
          dupesReaped: reaped,
        });
        await reportOpsEvent({
          source: "cron.cold_restore_self_heal",
          severity: "info",
          title: "Cold-restore self-heal: adopted orphaned restore",
          message: `Adopted live clone hermes-${candidate.id} on ${picked.keeper.hostSlug} (vmid=${picked.keeper.vmid}) and promoted to running; reaped ${reaped} duplicate clone(s).`,
          instanceId: candidate.id,
          metadata: {
            failureType: "cold_restore_adopted",
            instanceId: candidate.id,
            hostSlug: picked.keeper.hostSlug,
            vmid: picked.keeper.vmid,
            dupesReaped: reaped,
          },
        });
      } else if (outcome === "pending") {
        summary.stillPending += 1;
      } else {
        summary.errors += 1;
      }
    } catch (err) {
      summary.errors += 1;
      log.warn("cold-restore self-heal: candidate failed", {
        source: SOURCE,
        failureType: "cold_restore_self_heal_candidate_failed",
        instanceId: candidate.id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (summary.candidates > 0) {
    log.info("cold-restore self-heal sweep summary", { source: SOURCE, ...summary });
  }
  return summary;
}
