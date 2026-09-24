/**
 * Recover-unhealthy-active-instances sweeper.
 *
 * Companion to recover-stuck-instances. That sweep handles rows in
 * failed/provisioning/redeploying state — the obviously-broken cases.
 * This one handles the silent failure mode: rows still flagged
 * lifecycle_state='active', status='running' in the DB, but whose agent
 * containers have crashed under the hood. The gateway returns 521 or
 * refuses connections, the DB row never changed, and the older sweep's
 * lifecycle/status filter never matched them.
 *
 * The trigger was a class of active rows that remained gateway-unhealthy for
 * days with auto_restart_attempts=0 because the older filter never caught
 * them. Manual redeploy rescued them; this sweep automates that repair path.
 *
 * Detection signal: instance-health-sweep emits a
 * source='synthetic.instance-health' ops_event on every probe failure,
 * fingerprint-deduped so first_seen_at marks when the outage began. If
 * first_seen_at is older than UNHEALTHY_FOR_THRESHOLD_MS AND the event
 * is unarchived AND the row is still active/running AND a fresh probe
 * confirms the gateway is still unhealthy, fire a redeploy via
 * applyLiveUpdate — the same path the user-driven "repair_runtime"
 * button uses.
 *
 * Rate limiting: piggybacks on auto_restart_attempts +
 * last_auto_restart_at exactly like recover-stuck. Once the cap is hit
 * we emit a fatal synthetic.auto-repair-exhausted event (fingerprint-
 * deduped so a stuck row produces one event, not one per cron tick) and
 * stop attempting. The fatal event surfaces in /dashboard/ops for an
 * operator. When the row eventually recovers (manual repair, or
 * recover-stuck flipping it back to running on a healthy probe), the
 * existing reset path on the recover-stuck side clears the counter.
 *
 * In-flight turns: the repair is a system update, so it passes the in-flight
 * gate first. A gateway can be down while official-dashboard keeps running a
 * web-chat turn; a repair that finds a positively running turn is deferred
 * (not counted as an attempt, no cooldown stamp) and retried next tick, for at
 * most one hour or four deferrals, so a hung turn cannot hold a repair for long.
 * When the box cannot tell whether a turn is running, which is often part of
 * the breakage, the repair goes ahead (SYSTEM_UPDATE_DEFERRAL_POLICY
 * .unhealthy_recovery in inflight-update-gate.ts).
 *
 * Scope:
 *   - webfree backends only (backend in WEBFREE_BACKENDS) — matches the
 *     user-driven repair path and the manual
 *     /api/cron/redeploy-webui-instances rescue endpoint. applyLiveUpdate
 *     handles Proxmox and Hetzner webfree rows uniformly, so both
 *     providers are covered.
 *   - entitlement_state NOT IN ('suspended','paused') so we don't
 *     auto-restart rows the user has deliberately taken offline.
 */

import { fetchFirstReachableGatewayResponse } from "@/lib/agent-gateway";
import { loadGlobalHermesSettingsForUser } from "@/lib/clerk-hermes-settings";
import { buildGatewayProbeUrls } from "@/lib/gateway-probe";
import { buildInstanceLifecyclePatch } from "@/lib/instance-lifecycle";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import { recoverProxmoxInstanceAcrossFleet } from "@/lib/recovery/recover-orphan-provisioning";
import {
  getProxmoxHostRoutingConfigFromInfrastructure,
  getProxmoxInfrastructure,
  getProxmoxInstanceStatus,
  stripProxmoxInfrastructure,
} from "@/lib/services/proxmox-instance-service";
import {
  applyLiveUpdate,
  resolveInstanceIpv4,
  type InstanceRowForOrchestration,
} from "@/lib/services/instance-orchestrator";
import { systemLiveUpdate } from "@/lib/services/live-update-initiator";
import { supabaseAdmin } from "@/lib/supabase";
import { WEBFREE_BACKENDS } from "@/lib/types/instance";

const SOURCE = "recover-unhealthy-active-instances";

const RECOVERY_PROBE_TIMEOUT_MS = 6_000;

// How long an instance must show as unhealthy before we auto-redeploy.
// probe-instance-health runs every 5 min; first_seen_at on the ops event
// marks the initial detection. 2 hours gives an operator time to spot a
// genuine external outage (Cloudflare edge, registrar DNS, certificate
// auth) before we start mutating runtime state. Past 2 hours every
// minute of silent breakage hurts the user more than the cost of a
// restart we maybe didn't strictly need.
const UNHEALTHY_FOR_THRESHOLD_MS = 2 * 60 * 60 * 1000;

const MAX_AUTO_RESTART_ATTEMPTS = 3;

// WebUI redeploys take ~30-90s. 30 min gives the recover-stuck-instances
// cron (2 min cadence) ~14 probe ticks to notice the redeploy succeeded
// and reset the counter before we'd retry.
const AUTO_REPAIR_COOLDOWN_MS = 30 * 60 * 1000;

// Per-run cap. Each redeploy holds an SSH session for ~30-90s. Beyond
// ~5 in flight the ghcr.io pull bandwidth on a host becomes the
// bottleneck and unrelated provisions start timing out.
const MAX_REPAIRS_PER_RUN = 5;

const HEALTH_EVENT_SOURCE = "synthetic.instance-health";

// PostgREST encodes .in() filters in the GET query string. Past a few
// hundred UUIDs the URL exceeds the gateway's request-line limit and the
// whole query 400s ("Bad Request") — which is how a grown backlog of open
// health events (964 instance ids ≈ 36KB of query string) killed this
// cron fleet-wide on 2026-06-10. Every id-list query must be chunked.
const ID_CHUNK_SIZE = 100;

// The route's maxDuration is 300s and each healthy-probe can take up to
// RECOVERY_PROBE_TIMEOUT_MS. With a large candidate backlog the probe
// loop alone could eat the whole envelope; stop iterating with enough
// headroom left for an in-flight repair's SSH session to finish.
const SWEEP_DEADLINE_MS = 240_000;

type UnhealthyInstanceRow = InstanceRowForOrchestration & {
  status: string | null;
  lifecycle_state: string | null;
  entitlement_state: string | null;
  scheduled_deletion_at: string | null;
  deleted_at: string | null;
  last_auto_restart_at: string | null;
  auto_restart_attempts: number | null;
};

interface CandidateWithEvent {
  row: UnhealthyInstanceRow;
  firstUnhealthyAt: string;
}

export interface RecoverUnhealthyActiveInstancesSummary {
  candidates: number;
  alreadyHealthy: number;
  archivedHealthy: number;
  redeployAttempted: number;
  redeployFailed: number;
  // Repairs held back because an agent turn was in flight on the box (see the
  // in-flight gate). Not an attempt: retried next tick.
  redeployDeferred: number;
  cooldownSkipped: number;
  deadlineSkipped: number;
  exhausted: number;
  // Rows whose Proxmox VM `qm status` reported MISSING: released (error +
  // null proxmox_vmid + infrastructureReleased marker) so the
  // recover-missing-vm-instances cron recreates them, instead of burning
  // SSH redeploys against a dead VM until the attempt cap pages an operator.
  vmReleased: number;
  errors: number;
}

const INSTANCE_SELECT = [
  "id",
  "user_id",
  "provider",
  "name",
  "status",
  "lifecycle_state",
  "backend",
  "subdomain",
  "hetzner_server_id",
  "gateway_url",
  "api_key_encrypted",
  "api_server_key_encrypted",
  "honcho_api_key_encrypted",
  "config",
  "host_id",
  "proxmox_node",
  "ipv4_address",
  "cpu_limit",
  "ram_limit",
  "entitlement_state",
  "scheduled_deletion_at",
  "deleted_at",
  "last_auto_restart_at",
  "auto_restart_attempts",
].join(", ");

function truncateMessage(message: string, max = 240): string {
  return message.length > max ? `${message.slice(0, max)}…` : message;
}

async function probeHealth(row: UnhealthyInstanceRow): Promise<boolean> {
  if (!row.gateway_url) return false;
  const startedAt = Date.now();
  try {
    const { response, url } = await fetchFirstReachableGatewayResponse({
      baseUrl: row.gateway_url,
      pathname: "/health",
      instanceIpv4: row.ipv4_address ?? undefined,
      timeoutMs: RECOVERY_PROBE_TIMEOUT_MS,
    });
    await response.text().catch(() => {});
    if (!response.ok) {
      log.warn("recover-unhealthy-active probe returned non-ok", {
        source: SOURCE,
        failureType: "recover_unhealthy_probe_failed",
        instanceId: row.id,
        userId: row.user_id,
        gatewayUrl: row.gateway_url,
        probeUrl: url,
        status: response.status,
        elapsedMs: Date.now() - startedAt,
      });
      return false;
    }
    return true;
  } catch (err) {
    const probeUrls = buildGatewayProbeUrls(
      row.gateway_url.replace(/\/$/, ""),
      "/health",
      { instanceIpv4: row.ipv4_address ?? undefined },
    );
    const errorName = err instanceof Error ? err.name : typeof err;
    const rawMessage = err instanceof Error ? err.message : String(err);
    log.warn("recover-unhealthy-active probe threw", {
      source: SOURCE,
      failureType: "recover_unhealthy_probe_failed",
      instanceId: row.id,
      userId: row.user_id,
      gatewayUrl: row.gateway_url,
      probeUrls,
      errorName,
      errorMessage: truncateMessage(rawMessage),
      elapsedMs: Date.now() - startedAt,
    });
    return false;
  }
}

async function loadCandidates(
  db: NonNullable<typeof supabaseAdmin>,
  cutoffIso: string,
): Promise<CandidateWithEvent[]> {
  // Step 1: gather instance_ids from open synthetic.instance-health
  // events that have been unhealthy ≥ UNHEALTHY_FOR_THRESHOLD_MS. We
  // dedupe to the EARLIEST first_seen_at per instance — multiple events
  // may exist for the same instance if the gateway_url changed between
  // outages, and the cumulative outage is anchored on the earliest one.
  const { data: events, error: eventsError } = await db
    .from("ops_events")
    .select("instance_id, first_seen_at")
    .eq("source", HEALTH_EVENT_SOURCE)
    .is("archived_at", null)
    .lt("first_seen_at", cutoffIso)
    .not("instance_id", "is", null);

  if (eventsError) {
    throw new Error(eventsError.message || "Failed to load unhealthy events");
  }

  const firstUnhealthyByInstance = new Map<string, string>();
  for (const event of (events ?? []) as Array<{
    instance_id: string | null;
    first_seen_at: string | null;
  }>) {
    if (typeof event.instance_id !== "string" || !event.instance_id) continue;
    if (typeof event.first_seen_at !== "string" || !event.first_seen_at) continue;
    const existing = firstUnhealthyByInstance.get(event.instance_id);
    if (!existing || event.first_seen_at < existing) {
      firstUnhealthyByInstance.set(event.instance_id, event.first_seen_at);
    }
  }
  if (firstUnhealthyByInstance.size === 0) return [];

  // Step 2: load the matching instance rows and gate on lifecycle, status,
  // and backend. The "active+running+webfree" combination is the silent-
  // failure signature: lifecycle stays active because nothing flipped it,
  // status stays running because the gateway never reported a transition,
  // and the synthetic probe is the only signal that anything's wrong.
  const unhealthyIds = Array.from(firstUnhealthyByInstance.keys());
  const rows: UnhealthyInstanceRow[] = [];
  for (let i = 0; i < unhealthyIds.length; i += ID_CHUNK_SIZE) {
    const { data: chunk, error: rowsError } = await db
      .from("hermes_instances")
      .select(INSTANCE_SELECT)
      .in("id", unhealthyIds.slice(i, i + ID_CHUNK_SIZE))
      .eq("lifecycle_state", "active")
      .eq("status", "running")
      .in("backend", WEBFREE_BACKENDS)
      .not("gateway_url", "is", null)
      .is("deleted_at", null)
      .is("scheduled_deletion_at", null);

    if (rowsError) {
      throw new Error(rowsError.message || "Failed to load unhealthy instances");
    }
    rows.push(...((chunk ?? []) as unknown as UnhealthyInstanceRow[]));
  }

  const candidates: CandidateWithEvent[] = [];
  for (const raw of rows) {
    if (typeof raw.gateway_url !== "string" || raw.gateway_url.trim().length === 0) {
      continue;
    }
    // Don't auto-repair rows the user has deliberately taken offline at
    // the billing layer. lifecycle_state='active' is the lifecycle
    // signal; entitlement_state is the billing signal — they can diverge.
    if (
      raw.entitlement_state === "suspended" ||
      raw.entitlement_state === "paused"
    ) {
      continue;
    }
    const firstUnhealthyAt = firstUnhealthyByInstance.get(raw.id);
    if (!firstUnhealthyAt) continue;
    candidates.push({ row: raw, firstUnhealthyAt });
  }
  return candidates;
}

function isInCooldown(row: UnhealthyInstanceRow, now: number): boolean {
  if (!row.last_auto_restart_at) return false;
  const last = Date.parse(row.last_auto_restart_at);
  return Number.isFinite(last) && now - last < AUTO_REPAIR_COOLDOWN_MS;
}

async function emitExhaustedEvent(
  candidate: CandidateWithEvent,
): Promise<void> {
  const { row, firstUnhealthyAt } = candidate;
  await reportOpsEvent({
    source: "synthetic.auto-repair-exhausted",
    severity: "fatal",
    title: `Auto-repair exhausted for instance ${row.id}`,
    message:
      `Instance ${row.id} (gateway ${row.gateway_url}) has been ` +
      `gateway-unhealthy since ${firstUnhealthyAt} and auto_restart_` +
      `attempts has hit the ${MAX_AUTO_RESTART_ATTEMPTS}-attempt cap. ` +
      `The recover-unhealthy-active-instances cron will stop redeploying ` +
      `it. Recovery: investigate the VM directly, then either repair ` +
      `manually from /dashboard/instances/${row.id}/console or rescue ` +
      `via POST /api/cron/redeploy-webui-instances. Once /health comes ` +
      `back 200 the recover-stuck-instances cron will reset the counter.`,
    instanceId: row.id,
    userId: row.user_id,
    metadata: {
      failureOwner: "runtime",
      failurePhase: "runtime",
      failureType: "auto_repair_exhausted",
      recoveryAction: "repair_runtime",
      gatewayUrl: row.gateway_url,
      attempts: row.auto_restart_attempts ?? 0,
      firstUnhealthyAt,
      lastAutoRestartAt: row.last_auto_restart_at,
    },
  });
}

/**
 * If this row's Proxmox VM is GONE (`qm status` → missing), release the row's
 * Proxmox handle so the recover-missing-vm-instances cron can rebuild it on a
 * healthy host, and return true. Otherwise (not Proxmox, no resolvable handle,
 * status unknown, or VM still present) return false so the caller falls through
 * to the normal SSH redeploy repair.
 *
 * Why this belongs here: a box whose Phase-2 cleanup trap (or a host purge)
 * destroyed the VM can never be repaired by `applyLiveUpdate` — the SSH
 * redeploy just fails against a dead IP every attempt until the cap, then emits
 * a fatal auto-repair-exhausted ops event, and the row sits at status='running'
 * forever, invisible to the recreate cron (whose candidate query needs
 * proxmox_vmid IS NULL + a release marker). Releasing it here turns that dead
 * end into an auto-recovery. Mirrors the [id] and list reconcile vmMissing
 * guards: flip to "error" (not "deleted") + null proxmox_vmid + strip
 * config.infrastructure with the marker.
 */
async function releaseIfProxmoxVmMissing(
  db: NonNullable<typeof supabaseAdmin>,
  row: UnhealthyInstanceRow,
): Promise<boolean> {
  const infra = getProxmoxInfrastructure(row.config);
  if (!infra) return false;

  let vmMissing = false;
  try {
    const ps = await getProxmoxInstanceStatus(infra, {
      hostConfig: getProxmoxHostRoutingConfigFromInfrastructure(infra, {
        host_id: row.host_id ?? null,
      }),
    });
    vmMissing = ps.vmMissing === true;
  } catch {
    // Can't determine liveness (SSH/host env error) — don't release on a
    // guess; let the normal repair path handle it.
    return false;
  }
  if (!vmMissing) return false;

  const recovery = await recoverProxmoxInstanceAcrossFleet({
    id: row.id,
    user_id: row.user_id,
    status: row.status,
    lifecycle_state: row.lifecycle_state,
    proxmox_node: infra.node ?? null,
    proxmox_vmid: infra.vmid,
    proxmox_template_vmid: infra.templateVmid ?? null,
    ipv4_address: row.ipv4_address ?? null,
    gateway_url: row.gateway_url ?? null,
    api_server_key_encrypted: row.api_server_key_encrypted ?? null,
    config: row.config ?? null,
    subdomain: row.subdomain ?? null,
  });
  if (recovery.status === "recovered") return true;
  if (recovery.status !== "gone") return false;

  const nowIso = new Date().toISOString();
  const { error } = await db
    .from("hermes_instances")
    .update({
      ...buildInstanceLifecyclePatch("error", { now: nowIso }),
      proxmox_vmid: null,
      config: stripProxmoxInfrastructure(row.config, "vm_missing_across_fleet"),
      updated_at: nowIso,
    })
    .eq("id", row.id);

  if (error) {
    log.error(
      "recover-unhealthy-active failed to release missing-VM row",
      new Error(error.message || "release update failed"),
      {
        source: SOURCE,
        failureType: "recover_unhealthy_vm_release_failed",
        instanceId: row.id,
        userId: row.user_id,
        proxmoxVmid: infra.vmid,
        proxmoxNode: infra.node ?? null,
      },
    );
    return false;
  }

  log.warn("recover-unhealthy-active released missing-VM row for auto-recovery", {
    source: SOURCE,
    failureType: "proxmox_vm_missing_on_routed_host",
    instanceId: row.id,
    userId: row.user_id,
    proxmoxVmid: infra.vmid,
    proxmoxNode: infra.node ?? null,
  });
  return true;
}

async function attemptRepair(
  db: NonNullable<typeof supabaseAdmin>,
  candidate: CandidateWithEvent,
  now: number,
): Promise<"attempted" | "failed" | "deferred"> {
  const { row, firstUnhealthyAt } = candidate;
  const nowIso = new Date(now).toISOString();
  const nextAttempts = (row.auto_restart_attempts ?? 0) + 1;

  let ipv4 = "";
  try {
    ipv4 = await resolveInstanceIpv4(row, db);
  } catch (err) {
    log.warn("recover-unhealthy-active ip resolve failed", {
      source: SOURCE,
      failureType: "recover_unhealthy_ip_resolution_failed",
      instanceId: row.id,
      userId: row.user_id,
      errorName: err instanceof Error ? err.name : typeof err,
    });
    await db
      .from("hermes_instances")
      .update({
        last_auto_restart_at: nowIso,
        auto_restart_attempts: nextAttempts,
        updated_at: nowIso,
      })
      .eq("id", row.id);
    return "failed";
  }
  if (!ipv4) {
    log.warn("recover-unhealthy-active no ipv4 resolved", {
      source: SOURCE,
      failureType: "recover_unhealthy_missing_ipv4",
      instanceId: row.id,
      userId: row.user_id,
    });
    await db
      .from("hermes_instances")
      .update({
        last_auto_restart_at: nowIso,
        auto_restart_attempts: nextAttempts,
        updated_at: nowIso,
      })
      .eq("id", row.id);
    return "failed";
  }

  const globalSettings = await loadGlobalHermesSettingsForUser(row.user_id, {
    instanceId: row.id,
  });

  const result = await applyLiveUpdate(row, ipv4, globalSettings, db, {
    initiator: systemLiveUpdate("unhealthy_recovery"),
  });

  if (result.deferred) {
    // The box is running an agent turn. Nothing was touched, so this is not an
    // attempt: no counter bump and no cooldown stamp, and the next tick retries.
    log.info("recover-unhealthy-active repair deferred: agent turn in flight", {
      source: SOURCE,
      failureType: "recover_unhealthy_repair_deferred_busy",
      instanceId: row.id,
      userId: row.user_id,
      deferrals: result.inFlightGate.deferrals,
      firstUnhealthyAt,
    });
    return "deferred";
  }

  if (!result.applied) {
    await db
      .from("hermes_instances")
      .update({
        last_auto_restart_at: nowIso,
        auto_restart_attempts: nextAttempts,
        updated_at: nowIso,
      })
      .eq("id", row.id);
    log.warn("recover-unhealthy-active redeploy launch failed", {
      source: SOURCE,
      failureType: "recover_unhealthy_redeploy_launch_failed",
      instanceId: row.id,
      userId: row.user_id,
      attempt: nextAttempts,
      errorMessage: truncateMessage(result.error || "applyLiveUpdate returned not applied"),
    });
    return "failed";
  }

  // applyLiveUpdate has already flipped status=redeploying and
  // lifecycle_state=provisioning. Layer our auto-restart bookkeeping on
  // top so subsequent cron ticks respect the cooldown and the cap.
  await db
    .from("hermes_instances")
    .update({
      last_auto_restart_at: nowIso,
      auto_restart_attempts: nextAttempts,
    })
    .eq("id", row.id);

  log.info("recover-unhealthy-active redeploy launched", {
    source: SOURCE,
    instanceId: row.id,
    userId: row.user_id,
    attempt: nextAttempts,
    firstUnhealthyAt,
  });
  return "attempted";
}

export async function runRecoverUnhealthyActiveInstancesSweep(): Promise<RecoverUnhealthyActiveInstancesSummary> {
  const db = supabaseAdmin;
  if (!db) {
    throw new Error("Supabase admin client not configured");
  }

  const now = Date.now();
  const cutoffIso = new Date(now - UNHEALTHY_FOR_THRESHOLD_MS).toISOString();

  const candidates = await loadCandidates(db, cutoffIso);

  let alreadyHealthy = 0;
  let redeployAttempted = 0;
  let redeployFailed = 0;
  let redeployDeferred = 0;
  let cooldownSkipped = 0;
  let exhausted = 0;
  let vmReleased = 0;
  let errors = 0;

  // Sort by firstUnhealthyAt ascending so the longest-broken instances
  // are repaired first when MAX_REPAIRS_PER_RUN bites.
  const sorted = [...candidates].sort((a, b) => {
    const at = Date.parse(a.firstUnhealthyAt);
    const bt = Date.parse(b.firstUnhealthyAt);
    return (Number.isFinite(at) ? at : Infinity) -
      (Number.isFinite(bt) ? bt : Infinity);
  });

  let repaired = 0;
  let deadlineSkipped = 0;
  const healthyInstanceIds: string[] = [];
  for (const candidate of sorted) {
    if (repaired >= MAX_REPAIRS_PER_RUN) break;
    if (Date.now() - now > SWEEP_DEADLINE_MS) {
      deadlineSkipped = sorted.length - alreadyHealthy - exhausted -
        cooldownSkipped - repaired - redeployDeferred - errors;
      break;
    }

    // Re-probe in case the row recovered on its own between cron ticks.
    // The synthetic.instance-health event can be stale by several
    // minutes — probe-instance-health runs every 5 min, but ops_events
    // rows are not deleted on success, so an instance that's already
    // healthy again still shows up in our SELECT.
    const healthy = await probeHealth(candidate.row);
    if (healthy) {
      alreadyHealthy += 1;
      healthyInstanceIds.push(candidate.row.id);
      continue;
    }

    // Before burning a repair attempt: if the VM is GONE (Phase-2 trap
    // destroyed it, or a host purge), an SSH redeploy can never succeed.
    // Release the row so the recover-missing-vm-instances cron rebuilds it
    // instead of looping failed redeploys until the cap pages an operator.
    try {
      if (await releaseIfProxmoxVmMissing(db, candidate.row)) {
        vmReleased += 1;
        continue;
      }
    } catch (err) {
      errors += 1;
      log.error("recover-unhealthy-active vm-missing release threw", err, {
        source: SOURCE,
        failureType: "recover_unhealthy_vm_release_threw",
        instanceId: candidate.row.id,
        userId: candidate.row.user_id,
      });
    }

    const attempts = candidate.row.auto_restart_attempts ?? 0;
    if (attempts >= MAX_AUTO_RESTART_ATTEMPTS) {
      exhausted += 1;
      try {
        await emitExhaustedEvent(candidate);
      } catch (err) {
        errors += 1;
        log.error(
          "recover-unhealthy-active exhausted event failed",
          err,
          {
            source: SOURCE,
            failureType: "recover_unhealthy_exhausted_emit_failed",
            instanceId: candidate.row.id,
            userId: candidate.row.user_id,
          },
        );
      }
      continue;
    }

    if (isInCooldown(candidate.row, now)) {
      cooldownSkipped += 1;
      continue;
    }

    try {
      const outcome = await attemptRepair(db, candidate, now);
      if (outcome === "deferred") {
        // Not a repair: it must not use up the per-run cap, or a few busy
        // boxes would hold every slot while other broken boxes wait.
        redeployDeferred += 1;
        continue;
      }
      if (outcome === "attempted") {
        redeployAttempted += 1;
      } else {
        redeployFailed += 1;
      }
      repaired += 1;
    } catch (err) {
      errors += 1;
      log.error("recover-unhealthy-active repair threw", err, {
        source: SOURCE,
        failureType: "recover_unhealthy_repair_threw",
        instanceId: candidate.row.id,
        userId: candidate.row.user_id,
      });
    }
  }

  // Archive the open health events for instances that probed healthy.
  // Without this the open-event backlog only ever grows (the prober
  // never archives on recovery), each sweep re-probes the same healed
  // fleet, and eventually the candidate query itself collapses under
  // its own id list. reportOpsEvent revives an archived fingerprint on
  // the next genuine outage, so archiving here loses nothing.
  let archivedHealthy = 0;
  for (let i = 0; i < healthyInstanceIds.length; i += ID_CHUNK_SIZE) {
    const { data: archivedRows, error: archiveError } = await db
      .from("ops_events")
      .update({ archived_at: new Date().toISOString() })
      .eq("source", HEALTH_EVENT_SOURCE)
      .is("archived_at", null)
      .in("instance_id", healthyInstanceIds.slice(i, i + ID_CHUNK_SIZE))
      .select("id");
    if (archiveError) {
      errors += 1;
      log.warn("recover-unhealthy-active healthy-event archive failed", {
        source: SOURCE,
        failureType: "recover_unhealthy_archive_failed",
        errorMessage: archiveError.message,
      });
    } else {
      archivedHealthy += archivedRows?.length ?? 0;
    }
  }

  const summary: RecoverUnhealthyActiveInstancesSummary = {
    candidates: candidates.length,
    alreadyHealthy,
    archivedHealthy,
    redeployAttempted,
    redeployFailed,
    redeployDeferred,
    cooldownSkipped,
    deadlineSkipped,
    exhausted,
    vmReleased,
    errors,
  };

  if (summary.candidates > 0) {
    log.info("recover-unhealthy-active sweep summary", {
      source: SOURCE,
      ...summary,
    });
  }

  return summary;
}
