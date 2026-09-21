/**
 * Recover-stuck-instances sweeper.
 *
 * The /api/instances/[id] route handler promotes provisioning → running
 * (and self-heals error → running) on every poll, but those promotions
 * only fire when the user's frontend is actively polling. If the user
 * gives up before the agent's bootstrap finishes, the row stays stuck
 * forever — the gateway probe never re-runs.
 *
 * On 2026-05-08 this manifested as 12 fixturenodea users seeing
 * "failed" / "provisioning" in the dashboard for 2-8 hours while their
 * agents were actually serving 200 OK from /health. Same pattern bit
 * dozens more on fixturenodea (rows tagged with the legacy "fixturelegacy" node).
 *
 * This sweeper runs every 2 min, finds rows in failed/provisioning
 * with a populated gateway_url, probes the gateway, and flips healthy
 * ones to running/active. Idempotent and safe to run alongside the
 * route-handler promotion path.
 *
 * When the probe FAILS on a Proxmox row, the sweeper also attempts to
 * power-cycle the VM via `qm start`. Support tickets keep reporting
 * "agent keeps dropping into error state and requires a manual
 * restart" — this is the auto-restart that the marketing page promises
 * but that previously only existed as a button the user had to click.
 * Rate-limited via auto_restart_attempts + last_auto_restart_at to
 * stop a row that crashes on every boot from being restarted forever.
 *
 * Filters
 *  - gateway_url IS NOT NULL (no URL = nothing to probe)
 *  - created_at older than RECOVERY_GRACE_MS so we don't race a fresh
 *    provision that's legitimately still in Phase 2
 *  - lifecycle_state IN ('failed','provisioning') OR status = 'redeploying'
 *    (belt-and-suspenders: redeploying rows sit at lifecycle_state='provisioning'
 *    after the orchestrator-side fix, but matching on status='redeploying' too
 *    means any future status/lifecycle desync still recovers)
 *  - scheduled_deletion_at IS NULL (don't restart instances the user
 *    has scheduled for deletion)
 *  - Provider-agnostic: Hetzner rows go through the probe-and-flip path too;
 *    auto-restart still gates on proxmox_vmid + proxmox_node, so Hetzner rows
 *    naturally skip qm start.
 */

import { fetchFirstReachableGatewayResponse } from "@/lib/agent-gateway";
import { decryptApiKey } from "@/lib/crypto";
import { buildGatewayProbeUrls } from "@/lib/gateway-probe";
import {
  buildClearedArchivePointerPatch,
  buildInstanceLifecyclePatch,
} from "@/lib/instance-lifecycle";
import { reconcileSoulSeedAfterReady } from "@/lib/recovery/soul-seed-reconcile";

// SCRIPTURE_ANCHOR: recover-lost | Luke 15:4 | Verse: Which of you, if he has one hundred sheep and loses one of them, doesn't leave the ninety-nine?
import { log } from "@/lib/logger";
import {
  getProxmoxHostRoutingConfigFromInfrastructure,
  isProxmoxVmMissingResult,
  startProxmoxInstance,
} from "@/lib/services/proxmox-instance-service";
import { supabaseAdmin } from "@/lib/supabase";

const RECOVERY_PROBE_TIMEOUT_MS = 6_000;
const RECOVERY_GRACE_MS = 90_000;

// Auto-restart guardrails. We cap restart attempts to avoid restart
// loops on rows that crash on every boot (e.g. free-tier OOM kills),
// and require a cooldown between attempts so we don't restart while
// the previous restart is still booting Phase 2.
const MAX_AUTO_RESTART_ATTEMPTS = 3;
const AUTO_RESTART_COOLDOWN_MS = 15 * 60 * 1000;

// Provisioning rows are normally exempt from auto-restart because the
// gateway may not be reachable yet (Phase 2 bootstrap takes 3-7 min).
// But rows that stay in 'provisioning' for far longer than that are
// genuinely stuck — observed 2026-05-11 with fixturenodea sitting on multiple
// 30+ min provisioning rows that never moved without manual user
// intervention. Past this threshold, we treat them like 'failed' and
// let the same qm-start path take over. 15 min = 2-5× the documented
// Phase 2 budget; the next cron tick (2 min later) picks them up.
const STALE_PROVISIONING_MS = 15 * 60 * 1000;

type StuckInstanceRow = {
  id: string;
  user_id: string;
  host_id: string | null;
  proxmox_vmid: number | null;
  proxmox_node: string | null;
  gateway_url: string;
  ipv4_address: string | null;
  status: string | null;
  lifecycle_state: string | null;
  backend: string | null;
  api_server_key_encrypted: string | null;
  created_at: string;
  last_auto_restart_at: string | null;
  auto_restart_attempts: number | null;
};

export interface RecoverStuckInstancesSummary {
  candidates: number;
  recovered: number;
  stillUnreachable: number;
  restartAttempted: number;
  restartFailed: number;
  errors: number;
}

function truncateMessage(message: string, max = 240): string {
  return message.length > max ? `${message.slice(0, max)}…` : message;
}

// Probe target, mirroring buildReadinessProbeOptions in the instance routes.
// This sweep runs every 2 minutes with only a 90s grace, so a shell-only
// '/health' probe (served by the official-dashboard container) would promote a
// fresh webfree box while the gateway that actually answers chat is still down
// — reopening the dead-first-message window the instance routes closed
// (measured 2026-07-10: canary run fixturecase04 8s gap, prod run fixturecase05 >190s).
// backend='gateway' rows probe the bearer-authed chat lane instead; keyless
// rows and legacy 'webui' images (no sessions route) fail open to '/health'.
function buildStuckProbeTarget(row: StuckInstanceRow): {
  pathname: string;
  headers?: Record<string, string>;
} {
  if (row.backend === "gateway" && row.api_server_key_encrypted) {
    try {
      const key = decryptApiKey(row.api_server_key_encrypted);
      return {
        pathname: "/api/sessions",
        headers: { Authorization: `Bearer ${key}` },
      };
    } catch {
      // Undecryptable key — fall through to the legacy public probe.
    }
  }
  return { pathname: "/health" };
}

async function probeHealth(row: StuckInstanceRow): Promise<boolean> {
  const startedAt = Date.now();
  const target = buildStuckProbeTarget(row);
  try {
    const { response, url } = await fetchFirstReachableGatewayResponse({
      baseUrl: row.gateway_url,
      pathname: target.pathname,
      instanceIpv4: row.ipv4_address ?? undefined,
      headers: target.headers,
      timeoutMs: RECOVERY_PROBE_TIMEOUT_MS,
    });
    await response.text().catch(() => {});
    if (!response.ok) {
      log.warn("recover-stuck-instances probe returned non-ok", {
        source: "recover-stuck-instances",
        failureType: "recover_stuck_probe_failed",
        instanceId: row.id,
        userId: row.user_id,
        proxmoxVmid: row.proxmox_vmid,
        proxmoxNode: row.proxmox_node,
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
      target.pathname,
      { instanceIpv4: row.ipv4_address ?? undefined },
    );
    const errorName = err instanceof Error ? err.name : typeof err;
    const rawMessage = err instanceof Error ? err.message : String(err);
    log.warn("recover-stuck-instances probe threw", {
      source: "recover-stuck-instances",
      failureType: "recover_stuck_probe_failed",
      instanceId: row.id,
      userId: row.user_id,
      proxmoxVmid: row.proxmox_vmid,
      proxmoxNode: row.proxmox_node,
      gatewayUrl: row.gateway_url,
      probeUrls,
      errorName,
      errorMessage: truncateMessage(rawMessage),
      elapsedMs: Date.now() - startedAt,
    });
    return false;
  }
}

function shouldAttemptAutoRestart(row: StuckInstanceRow, now: number): boolean {
  // Two eligible cases:
  //   - lifecycle_state = 'failed'         → always
  //   - lifecycle_state = 'provisioning'   → only once the row is OLDER
  //     than STALE_PROVISIONING_MS. Fresh provisions are still in Phase 2
  //     bootstrap; restarting them would just abort the boot. Past 15
  //     min the gateway probe in the same sweep has had 7+ chances to
  //     promote it to 'running' — if it's still provisioning, it's stuck.
  const isFailed = row.lifecycle_state === "failed";
  let isStaleProvisioning = false;
  if (row.lifecycle_state === "provisioning") {
    const createdAt = Date.parse(row.created_at);
    if (Number.isFinite(createdAt) && now - createdAt >= STALE_PROVISIONING_MS) {
      isStaleProvisioning = true;
    }
  }
  if (!isFailed && !isStaleProvisioning) return false;
  if (row.proxmox_vmid == null || !row.proxmox_node) return false;
  const attempts = row.auto_restart_attempts ?? 0;
  if (attempts >= MAX_AUTO_RESTART_ATTEMPTS) return false;
  if (row.last_auto_restart_at) {
    const last = Date.parse(row.last_auto_restart_at);
    if (Number.isFinite(last) && now - last < AUTO_RESTART_COOLDOWN_MS) {
      return false;
    }
  }
  return true;
}

async function attemptAutoRestart(
  db: NonNullable<typeof supabaseAdmin>,
  row: StuckInstanceRow,
): Promise<"attempted" | "vm_missing" | "failed"> {
  const vmid = row.proxmox_vmid as number;
  const node = row.proxmox_node as string;
  const hostConfig = getProxmoxHostRoutingConfigFromInfrastructure(
    { hostSlug: node, node },
    { host_id: row.host_id ?? null },
  );
  const result = await startProxmoxInstance({ vmid, node }, { hostConfig });

  const nowIso = new Date().toISOString();
  const nextAttempts = (row.auto_restart_attempts ?? 0) + 1;

  if (isProxmoxVmMissingResult(result)) {
    // VM no longer exists on the host. Flip to error so the dashboard
    // surfaces a clear "delete and re-create" path; cap attempts so we
    // don't keep retrying a phantom VM.
    await db
      .from("hermes_instances")
      .update({
        ...buildInstanceLifecyclePatch("error", { now: nowIso }),
        last_auto_restart_at: nowIso,
        auto_restart_attempts: MAX_AUTO_RESTART_ATTEMPTS,
      })
      .eq("id", row.id);
    log.warn("recover-stuck-instances auto-restart found missing VM", {
      source: "recover-stuck-instances",
      failureType: "auto_restart_vm_missing",
      instanceId: row.id,
      userId: row.user_id,
      proxmoxVmid: row.proxmox_vmid,
      proxmoxNode: row.proxmox_node,
    });
    return "vm_missing";
  }

  if (!result.ok) {
    // Proxmox host issue (SSH, qm start error). Bump the counter so we
    // eventually give up, but keep lifecycle_state where it was.
    await db
      .from("hermes_instances")
      .update({
        last_auto_restart_at: nowIso,
        auto_restart_attempts: nextAttempts,
        updated_at: nowIso,
      })
      .eq("id", row.id);
    log.warn("recover-stuck-instances auto-restart failed", {
      source: "recover-stuck-instances",
      failureType: "auto_restart_failed",
      instanceId: row.id,
      userId: row.user_id,
      proxmoxVmid: row.proxmox_vmid,
      proxmoxNode: row.proxmox_node,
      attempt: nextAttempts,
      errorMessage: result.error || result.stderr || null,
    });
    return "failed";
  }

  // VM start succeeded. Flip to provisioning so the existing
  // probe-and-promote path takes over once the agent is up; the next
  // healthy probe resets auto_restart_attempts to 0.
  await db
    .from("hermes_instances")
    .update({
      ...buildInstanceLifecyclePatch("provisioning", { now: nowIso }),
      last_auto_restart_at: nowIso,
      auto_restart_attempts: nextAttempts,
    })
    .eq("id", row.id);
  log.info("recover-stuck-instances auto-restart attempted", {
    source: "recover-stuck-instances",
    instanceId: row.id,
    userId: row.user_id,
    proxmoxVmid: row.proxmox_vmid,
    proxmoxNode: row.proxmox_node,
    fromLifecycle: row.lifecycle_state,
    attempt: nextAttempts,
  });
  return "attempted";
}

// ──────────────────────────────────────────────────────────────────────────────
// Stuck-'restoring' recovery
//
// Cold-restore (POST /api/instances/[id] action=start on a cold_archived row)
// holds a CAS lock by flipping the row to lifecycle_state='restoring', then runs
// restore-vm-cold.sh synchronously. Two ways the row can strand in 'restoring':
//   1. The serverless function is killed mid-restore (exceeds the function
//      ceiling) before it can flip the row to 'active'. The VM may be live.
//   2. restore-vm-cold.sh restored the data + started the VM but the gateway
//      health probe hadn't gone green inside the script's window, so the script
//      emits RESULT status=health_pending and the orchestrator parks the row in
//      lifecycle_substate='restore_health_pending' (see cold-storage-service).
// In BOTH cases the VM is alive on the new host with routing already written
// (proxmox_vmid/ipv4_address/gateway_url populated). This sweep probes the
// gateway and promotes a healthy row to active/running — mirroring the
// provisioning/failed recovery above. It deliberately does NOT auto-restart or
// teardown: an unreachable restoring row is left for ops, because we can't tell
// a still-finalizing restore from a genuinely-broken one without the VM context.
//
// Grace: 25 min on last_lifecycle_transition_at (the moment the CAS lock was
// taken), matching the route-handler PROXMOX_PROVISIONING_STALE_MS so we never
// race a legitimately in-flight restore (qmrestore + cold Docker pull + ACME +
// 300s health probe can run long).
const RESTORING_STALE_MS = 25 * 60 * 1000;

type StuckRestoringRow = {
  id: string;
  user_id: string;
  host_id: string | null;
  proxmox_vmid: number | null;
  proxmox_node: string | null;
  gateway_url: string;
  ipv4_address: string | null;
  status: string | null;
  lifecycle_state: string | null;
  lifecycle_substate: string | null;
  backend: string | null;
  api_server_key_encrypted: string | null;
  last_lifecycle_transition_at: string | null;
};

export interface RecoverStuckRestoringSummary {
  candidates: number;
  recovered: number;
  stillUnreachable: number;
  errors: number;
}

export async function runRecoverStuckRestoringSweep(): Promise<RecoverStuckRestoringSummary> {
  const db = supabaseAdmin;
  if (!db) {
    throw new Error("Supabase admin client not configured");
  }

  const now = Date.now();
  const cutoffIso = new Date(now - RESTORING_STALE_MS).toISOString();

  const { data, error } = await db
    .from("hermes_instances")
    .select(
      "id, user_id, host_id, proxmox_vmid, proxmox_node, gateway_url, ipv4_address, status, lifecycle_state, lifecycle_substate, backend, api_server_key_encrypted, last_lifecycle_transition_at",
    )
    .eq("lifecycle_state", "restoring")
    .not("gateway_url", "is", null)
    .lt("last_lifecycle_transition_at", cutoffIso)
    .is("deleted_at", null);

  if (error) {
    throw new Error(error.message || "Failed to load stuck restoring instances");
  }

  const candidates = (data ?? []).filter(
    (row): row is StuckRestoringRow =>
      typeof row.gateway_url === "string" && row.gateway_url.trim().length > 0,
  );

  let recovered = 0;
  let stillUnreachable = 0;
  let errors = 0;

  await Promise.all(
    candidates.map(async (row) => {
      const healthy = await probeHealth({
        ...row,
        // probeHealth only reads gateway_url + ipv4_address + identity fields.
        created_at: row.last_lifecycle_transition_at ?? new Date(now).toISOString(),
        last_auto_restart_at: null,
        auto_restart_attempts: null,
      });
      if (!healthy) {
        stillUnreachable += 1;
        // Leave it in 'restoring' for ops. A row stuck health_pending will
        // typically go green on the next sweep once the cold Docker pull
        // finishes; a genuinely-dead restore needs human eyes (we won't
        // teardown a VM that may still hold the only copy of live data).
        return;
      }

      // Promote to active/running. Guard with the same CAS predicate so we
      // never clobber a row a concurrent restore finished between probe and
      // write.
      //
      // The gateway answered, so the restored VM is confirmed live: this row is
      // no longer a cold-storage row and must drop its archive pointer, or a
      // later re-pause leaves it permanently un-archivable. See
      // buildClearedArchivePointerPatch.
      const { error: updateError } = await db
        .from("hermes_instances")
        .update({
          ...buildInstanceLifecyclePatch("running"),
          ...buildClearedArchivePointerPatch(),
          lifecycle_substate: null,
        })
        .eq("id", row.id)
        .eq("lifecycle_state", "restoring");

      if (updateError) {
        errors += 1;
        log.warn("recover-stuck-restoring update failed", {
          source: "recover-stuck-instances",
          failureType: "recover_stuck_restoring_update_failed",
          instanceId: row.id,
          userId: row.user_id,
          proxmoxVmid: row.proxmox_vmid,
          proxmoxNode: row.proxmox_node,
          lifecycleSubstate: row.lifecycle_substate,
          errorMessage: updateError.message,
        });
        return;
      }

      recovered += 1;
      log.info("recover-stuck-restoring promoted finalized restore to running", {
        source: "recover-stuck-instances",
        instanceId: row.id,
        userId: row.user_id,
        proxmoxVmid: row.proxmox_vmid,
        proxmoxNode: row.proxmox_node,
        lifecycleSubstate: row.lifecycle_substate,
        gatewayUrl: row.gateway_url,
      });
    }),
  );

  const summary: RecoverStuckRestoringSummary = {
    candidates: candidates.length,
    recovered,
    stillUnreachable,
    errors,
  };

  if (summary.candidates > 0) {
    log.info("recover-stuck-restoring sweep summary", {
      source: "recover-stuck-instances",
      ...summary,
    });
  }

  return summary;
}

export async function runRecoverStuckInstancesSweep(): Promise<RecoverStuckInstancesSummary> {
  const db = supabaseAdmin;
  if (!db) {
    throw new Error("Supabase admin client not configured");
  }

  const now = Date.now();
  const cutoffIso = new Date(now - RECOVERY_GRACE_MS).toISOString();

  const { data, error } = await db
    .from("hermes_instances")
    .select(
      "id, user_id, host_id, proxmox_vmid, proxmox_node, gateway_url, ipv4_address, status, lifecycle_state, backend, api_server_key_encrypted, created_at, last_auto_restart_at, auto_restart_attempts",
    )
    .or("lifecycle_state.in.(failed,provisioning),status.eq.redeploying")
    .not("gateway_url", "is", null)
    .lt("created_at", cutoffIso)
    .is("deleted_at", null)
    .is("scheduled_deletion_at", null);

  if (error) {
    throw new Error(error.message || "Failed to load stuck instances");
  }

  const candidates = (data ?? []).filter(
    (row): row is StuckInstanceRow => {
      if (typeof row.gateway_url !== "string" || row.gateway_url.trim().length === 0) {
        return false;
      }
      // Rows with NO infrastructure handle (no proxmox vmid AND no host)
      // cannot legitimately be "running" — there's no VM to serve their
      // /health, and any 200 they return is from leftover Caddy state.
      // Recovering them flips them back to active+running and produces
      // the "zombie" pattern observed on 2026-05-17 (10 long-stale rows
      // active+running with NULL host) and again on 2026-05-19 ("Artoo",
      // same shape). They can't be auto-restarted either (auto-restart
      // gates on proxmox_vmid+node). Skip them; the proper cleanup is
      // to terminal-delete them, not revive.
      const hasProxmoxHandle = row.proxmox_vmid != null && row.proxmox_node != null;
      const hasHetznerHandle = row.host_id != null;
      if (!hasProxmoxHandle && !hasHetznerHandle) {
        return false;
      }
      return true;
    },
  );

  let recovered = 0;
  let stillUnreachable = 0;
  let restartAttempted = 0;
  let restartFailed = 0;
  let errors = 0;

  await Promise.all(
    candidates.map(async (row) => {
      const healthy = await probeHealth(row);
      if (healthy) {
        const patch = {
          ...buildInstanceLifecyclePatch("running"),
          auto_restart_attempts: 0,
        };
        // Guard against racing a user-driven promotion: only write
        // "running" if the row is STILL in a state we'd consider stuck.
        // Mirrors the SELECT filter so we don't clobber a row that
        // moved on between probe and write.
        const { error: updateError } = await db
          .from("hermes_instances")
          .update(patch)
          .eq("id", row.id)
          .or("lifecycle_state.in.(failed,provisioning),status.eq.redeploying");

        if (updateError) {
          errors += 1;
          log.warn("recover-stuck-instances update failed", {
            source: "recover-stuck-instances",
            failureType: "update_failed",
            instanceId: row.id,
            userId: row.user_id,
            proxmoxVmid: row.proxmox_vmid,
            proxmoxNode: row.proxmox_node,
            fromStatus: row.status,
            fromLifecycle: row.lifecycle_state,
            errorMessage: updateError.message,
          });
          return;
        }

        recovered += 1;
        log.info("recover-stuck-instances recovered row", {
          source: "recover-stuck-instances",
          instanceId: row.id,
          userId: row.user_id,
          proxmoxVmid: row.proxmox_vmid,
          proxmoxNode: row.proxmox_node,
          fromStatus: row.status,
          fromLifecycle: row.lifecycle_state,
          gatewayUrl: row.gateway_url,
        });
        // Post-ready SOUL.md seed. This promotion IS the "slow provision came
        // up after nobody was polling" path where the in-band seed lost the
        // race to the agent's own factory-default write — heal it now instead
        // of leaving the box factory-default until the 20-min reconcile cron.
        // Best-effort by contract (never throws); webfree/paused/authored
        // gating happens inside.
        await reconcileSoulSeedAfterReady({
          instanceId: row.id,
          trigger: "recover_stuck_promote",
          db,
        });
        return;
      }

      stillUnreachable += 1;

      if (!shouldAttemptAutoRestart(row, now)) {
        return;
      }

      try {
        const outcome = await attemptAutoRestart(db, row);
        if (outcome === "attempted") {
          restartAttempted += 1;
        } else {
          restartFailed += 1;
        }
      } catch (err) {
        errors += 1;
        log.error("recover-stuck-instances auto-restart threw", err, {
          source: "recover-stuck-instances",
          failureType: "auto_restart_threw",
          instanceId: row.id,
          userId: row.user_id,
          proxmoxVmid: row.proxmox_vmid,
          proxmoxNode: row.proxmox_node,
        });
      }
    }),
  );

  const summary: RecoverStuckInstancesSummary = {
    candidates: candidates.length,
    recovered,
    stillUnreachable,
    restartAttempted,
    restartFailed,
    errors,
  };

  if (summary.candidates > 0) {
    log.info("recover-stuck-instances sweep summary", {
      source: "recover-stuck-instances",
      ...summary,
    });
  }

  return summary;
}
