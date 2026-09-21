/**
 * Cron: archive paused free-tier instances to cold storage.
 *
 * Daily sweep — finds tenants that have been `paused` (by the inactivity
 * cron) for more than the configured threshold, ships their state to the
 * Hetzner Storage Box via `archiveInstance()`, then destroys the source VM
 * to reclaim host pool space. Per `docs/cold-storage-orchestration.md §3`.
 *
 * Auth: Bearer CRON_SECRET (Vercel Cron sends this automatically; manual
 * triggers via curl require the same header).
 *
 * Trigger: vercel.json registers this at 03:00 UTC daily.
 *
 * Env knobs:
 *   COLD_STORAGE_ARCHIVE_ENABLED          "true" to actually archive; default false
 *                                         keeps the cron a no-op while the
 *                                         feature is being staged.
 *   COLD_STORAGE_ARCHIVE_THRESHOLD_HOURS  Default 48. How long since the
 *                                         row's last lifecycle transition
 *                                         before it's eligible.
 *   COLD_STORAGE_ARCHIVE_BATCH_SIZE       Default 50. Cap on rows per run so
 *                                         the cron stays within Vercel's
 *                                         function timeout.
 *   COLD_STORAGE_ARCHIVE_TIERS            CSV of resource_tier values that
 *                                         this cron should sweep. Default
 *                                         "credit_base" (free tier only).
 *                                         Paid tier needs the qcow2 archive
 *                                         path which is Phase 8.
 *
 * The archive flow itself is in src/lib/services/cold-storage-service.ts.
 * That module owns the CAS lock + integrity verify + destroy. This route
 * is purely the candidate-query + dispatch loop.
 */

import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { recordCronHeartbeat } from "@/lib/cron-heartbeat";
import { archiveInstance, type ColdArchiveResult } from "@/lib/services/cold-storage-service";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import { promoteNext } from "@/lib/reservations/promote-next";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const maxDuration = 800;

// Wall-clock budget for the archive dispatch loop. Each archive ships a tenant's
// data volume to the Storage Box and then destroys the source VM. The failure
// this guards against: a single slow archive running past Vercel's maxDuration
// and getting SIGKILLed mid-run, which strands the row in `archiving` AND (fatally)
// skips the recordCronHeartbeat() at the end of this route — so the dead-man
// watchdog sees the cron as stale for days and pages on every 10-min tick.
// (That is exactly what happened: prod's archive gave each host-script a fixed
// 15-min timeout that EXCEEDS the 800s function ceiling, so one big archive
// killed the function before it could stamp its heartbeat.)
//
// The fix is budget discipline, not a fixed gate: we compute the time left before
// the function ceiling and (a) never START an archive without MIN_VIABLE_ARCHIVE_MS
// of runway, and (b) hand each archive a host-script timeout equal to its remaining
// runway (see ArchiveInstanceOptions.maxScriptTimeoutMs), so NO archive can run
// past the deadline. The loop therefore always returns, stamps the heartbeat, and
// responds before maxDuration. Deferred candidates are re-selected next run.
// Candidate SELECTION (which VMs, thresholds, batch cap, oldest-first) is UNCHANGED.
const MAX_DURATION_MS = maxDuration * 1000;
// Headroom reserved after the LOOP for promoteNext() + the heartbeat stamp +
// building the response, all before Vercel's SIGKILL.
const STAMP_HEADROOM_MS = 25_000;
// maxScriptTimeoutMs bounds only the FIRST host-script (archive-vm-cold.sh). But
// archiveInstance() then runs an unbudgeted tail INSIDE cold-storage-service:
// manifest re-fetch (30s) + cold_archived DB write + `qm destroy` (60s) +
// Cloudflare DNS removal + host-Caddy cleanup (60s) ≈ 150s. That tail is NOT
// covered by maxScriptTimeoutMs, so we must reserve room for it before the hard
// deadline — otherwise a slow archive ending near the deadline plus its ~150s
// tail overshoots maxDuration and the function is SIGKILLed before it can stamp
// the heartbeat (re-triggering the dead-man flood) OR mid-tail (leaving a
// cold_archived row whose VM still physically exists). 180s = the 150s tail
// scripts + DNS/DB writes + slack.
const ARCHIVE_TAIL_BUDGET_MS = 180_000;
// Don't start an archive whose SCRIPT can't get a meaningful shot — below this it
// is deferred to the next run rather than started-and-aborted. Production archives
// on fixturenodea averaged ~110s, and a fifth same-host archive started with only 150s
// left then timed out after quiescing the guest. Three minutes leaves enough room
// for normal size variance while still preserving the separate 180s tail budget.
const MIN_VIABLE_ARCHIVE_MS = 180_000;

const LOG_SOURCE = "cron:archive-stopped-vms";

type ArchiveCandidate = {
  id: string;
  user_id: string | null;
  proxmox_node: string | null;
  proxmox_vmid: number | null;
  resource_tier: string | null;
  last_lifecycle_transition_at: string | null;
};

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  if (!v) return fallback;
  return v === "true" || v === "1" || v === "yes";
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name]?.trim();
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envList(name: string, fallback: string[]): string[] {
  const v = process.env[name]?.trim();
  if (!v) return fallback;
  return v
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function handle(req: NextRequest) {
  // Captured at the very top so the archive deadline accounts for the auth +
  // candidate/payer queries that precede the loop, keeping the whole invocation
  // safely under maxDuration.
  const functionStart = Date.now();
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error("CRON_SECRET not configured; refusing to run", new Error("CRON_SECRET missing"), {
      source: LOG_SOURCE,
      route: "/api/cron/archive-stopped-vms",
      failureType: "cron_secret_missing",
    });
    return apiError("Cron secret is not configured", 500);
  }
  if (!verifyBearerHeader(req, cronSecret)) {
    return apiError("Unauthorized", 401);
  }
  if (!supabaseAdmin) {
    return apiError("Database not configured", 500);
  }

  const enabled = envBool("COLD_STORAGE_ARCHIVE_ENABLED", false);
  const thresholdHours = Math.max(1, envInt("COLD_STORAGE_ARCHIVE_THRESHOLD_HOURS", 48));
  const batchSize = Math.max(1, Math.min(200, envInt("COLD_STORAGE_ARCHIVE_BATCH_SIZE", 50)));
  const tiers = envList("COLD_STORAGE_ARCHIVE_TIERS", ["credit_base"]);
  const stuckRecoveryMinutes = Math.max(
    5,
    envInt("COLD_STORAGE_STUCK_RECOVERY_MINUTES", 20)
  );

  // Recover rows stuck in `archiving` from a previous run whose function
  // timed out mid-archive (Vercel SIGTERM before the DB transition could
  // run). Bump timestamp so the recovered rows go to the back of the
  // candidate queue rather than getting picked up again immediately.
  const stuckCutoff = new Date(
    Date.now() - stuckRecoveryMinutes * 60_000
  ).toISOString();
  const { data: recoveredRows, error: recoveryError } = await supabaseAdmin
    .from("hermes_instances")
    .update({
      lifecycle_state: "paused",
      lifecycle_substate: null,
      last_lifecycle_transition_at: new Date().toISOString(),
    })
    .eq("lifecycle_state", "archiving")
    .lt("last_lifecycle_transition_at", stuckCutoff)
    .is("deleted_at", null)
    .select("id, proxmox_node, proxmox_vmid");
  if (recoveryError) {
    log.warn("stuck-archiving recovery sweep failed (non-fatal)", {
      source: LOG_SOURCE,
      failureType: "stuck_recovery_query_failed",
      error: recoveryError.message,
    });
  } else if (recoveredRows && recoveredRows.length > 0) {
    log.warn(`reverted ${recoveredRows.length} stuck archiving rows to paused`, {
      source: LOG_SOURCE,
      recoveredCount: recoveredRows.length,
      stuckRecoveryMinutes,
      sample: recoveredRows.slice(0, 5),
    });
  }

  const cutoff = new Date(Date.now() - thresholdHours * 3600_000).toISOString();

  const { data: candidates, error: queryError } = await supabaseAdmin
    .from("hermes_instances")
    .select("id, user_id, proxmox_node, proxmox_vmid, resource_tier, last_lifecycle_transition_at")
    .eq("lifecycle_state", "paused")
    .eq("status", "stopped")
    .is("deleted_at", null)
    .is("archive_uri", null)
    .in("resource_tier", tiers)
    .lt("last_lifecycle_transition_at", cutoff)
    .order("last_lifecycle_transition_at", { ascending: true })
    .limit(batchSize);

  if (queryError) {
    log.error("candidate query failed", queryError, {
      source: LOG_SOURCE,
      failureType: "archive_candidates_query_failed",
    });
    return apiError(`candidate query failed: ${queryError.message}`, 500);
  }

  const rawMatched = (candidates ?? []) as ArchiveCandidate[];

  // ── Payer guard (fail-closed) ────────────────────────────────────────────
  // The candidate query selects by resource_tier='credit_base' as a proxy for
  // "free". That proxy can drift (a webhook miss after upgrade, a stale tier)
  // and this path qm-destroy's the VM, so NEVER trust tier alone: exclude any
  // owner with a live paid subscription. Mirrors resume-mispaused-paid-instances.
  // 'active','trialing','past_due' all count as paying so a dunning/grace-window
  // customer is never archived. On query error we ABORT the run, not archive.
  const ownerIds = [...new Set(rawMatched.map((c) => c.user_id).filter(Boolean))] as string[];
  let payingOwners = new Set<string>();
  if (ownerIds.length > 0) {
    const { data: paidRows, error: paidErr } = await supabaseAdmin
      .from("hermes_subscriptions")
      .select("user_id")
      .in("user_id", ownerIds)
      .in("status", ["active", "trialing", "past_due"])
      .neq("plan", "free");
    if (paidErr) {
      log.error("archive payer-guard query failed; aborting run", paidErr, {
        source: LOG_SOURCE,
        failureType: "archive_payer_guard_query_failed",
      });
      return apiError(`subscription guard query failed: ${paidErr.message}`, 500);
    }
    payingOwners = new Set((paidRows ?? []).map((r) => r.user_id as string));
  }
  const matched = rawMatched.filter((c) => !c.user_id || !payingOwners.has(c.user_id));
  if (rawMatched.length !== matched.length) {
    log.info("archive cron excluded paying-user candidates", {
      source: LOG_SOURCE,
      excluded: rawMatched.length - matched.length,
    });
  }

  if (!enabled) {
    log.info("cold-storage archive cron dry-run (set COLD_STORAGE_ARCHIVE_ENABLED=true to actually archive)", {
      source: LOG_SOURCE,
      candidates: matched.length,
      thresholdHours,
      batchSize,
      tiers,
    });
    // Dead-man heartbeat: a disabled/dry-run sweep still ran to completion. The
    // cron is registered in CRON_REGISTRY but previously never stamped a
    // heartbeat, so the watchdog gave it false coverage. Stamp it here too so a
    // dry-run night doesn't look like the cron going dark.
    await recordCronHeartbeat("archive-stopped-vms");
    return apiSuccess({
      ok: true,
      mode: "dry_run",
      candidates: matched.length,
      thresholdHours,
      batchSize,
      tiers,
      stuckRecovered: recoveredRows?.length ?? 0,
      sample: matched.slice(0, 5).map((r) => ({
        id: r.id,
        proxmox_node: r.proxmox_node,
        proxmox_vmid: r.proxmox_vmid,
        last_lifecycle_transition_at: r.last_lifecycle_transition_at,
      })),
    });
  }

  const results = {
    candidates: matched.length,
    archived: 0,
    skipped: 0,
    failed: 0,
    // Candidates left untouched because the per-run wall-clock budget ran out
    // before we could start their archive. They are NOT a failure — the row is
    // unchanged and re-selected next daily run.
    deferred: 0,
    timedOut: false,
    perInstance: [] as Array<{
      id: string;
      ok: boolean;
      reason?: string;
      message?: string;
    }>,
  };

  // No archiveInstance() (archive script + its manifest/destroy/caddy tail) may run
  // past this instant. The loop then stamps the heartbeat and returns within
  // STAMP_HEADROOM_MS, all under maxDuration.
  const archiveHardDeadline = functionStart + MAX_DURATION_MS - STAMP_HEADROOM_MS;

  // Per-host parallel, serial within host. Invariant I6
  // (docs/cold-storage-orchestration.md): one archive at a time per host
  // — preserved by keeping the inner loop serial. Different hosts have
  // independent disks + SSH sessions, safe to run in parallel.
  const byHost = new Map<string, ArchiveCandidate[]>();
  for (const c of matched) {
    const host = c.proxmox_node ?? "__unknown__";
    if (!byHost.has(host)) byHost.set(host, []);
    byHost.get(host)!.push(c);
  }

  async function processCandidate(
    candidate: ArchiveCandidate,
    scriptTimeoutMs: number
  ): Promise<void> {
    let result: ColdArchiveResult;
    try {
      result = await archiveInstance(supabaseAdmin!, candidate.id, undefined, {
        maxScriptTimeoutMs: scriptTimeoutMs,
      });
    } catch (err) {
      results.failed += 1;
      results.perInstance.push({
        id: candidate.id,
        ok: false,
        reason: "exception",
        message: err instanceof Error ? err.message : String(err),
      });
      log.error("archiveInstance threw", err, {
        source: LOG_SOURCE,
        instanceId: candidate.id,
        proxmox_node: candidate.proxmox_node,
        proxmox_vmid: candidate.proxmox_vmid,
        failureType: "archive_instance_threw",
      });
      return;
    }

    if (result.ok) {
      results.archived += 1;
      results.perInstance.push({ id: candidate.id, ok: true });
      log.info("archived instance to cold storage", {
        source: LOG_SOURCE,
        instanceId: candidate.id,
        archiveUri: result.archiveUri,
        archiveSizeBytes: result.archiveSizeBytes,
        archiveSha256: result.archiveSha256,
      });
    } else if (result.reason === "lock_not_acquired" || result.reason === "instance_not_archivable") {
      results.skipped += 1;
      results.perInstance.push({
        id: candidate.id,
        ok: false,
        reason: result.reason,
        message: result.message,
      });
    } else {
      results.failed += 1;
      results.perInstance.push({
        id: candidate.id,
        ok: false,
        reason: result.reason,
        message: result.message,
      });
      log.warn("archive failed", {
        source: LOG_SOURCE,
        instanceId: candidate.id,
        failureType: "archive_failed",
        reason: result.reason,
        message: result.message,
      });
    }
  }

  await Promise.all(
    Array.from(byHost.entries()).map(async ([, candidates]) => {
      for (const candidate of candidates) {
        // Budget gate: only start an archive whose WHOLE flow (archive script +
        // the manifest/destroy/caddy tail) finishes before the hard deadline. We
        // reserve ARCHIVE_TAIL_BUDGET_MS for that unbudgeted tail and hand the
        // archive SCRIPT the rest as its timeout, so it can never run past
        // archiveHardDeadline − tail. Below MIN_VIABLE_ARCHIVE_MS of script runway
        // we defer (row untouched, re-selected next run) rather than
        // start-and-abort. This guarantees the loop returns in time to stamp the
        // heartbeat instead of being SIGKILLed (the failure that flooded alerts).
        const scriptBudgetMs = archiveHardDeadline - Date.now() - ARCHIVE_TAIL_BUDGET_MS;
        if (scriptBudgetMs < MIN_VIABLE_ARCHIVE_MS) {
          results.timedOut = true;
          results.deferred += 1;
          continue;
        }
        await processCandidate(candidate, scriptBudgetMs);
      }
    })
  );

  // Capacity-freed hook: archives just destroyed VMs → released host slots.
  // Top up waitlist invites to fill the newly-available free capacity.
  // promoteNext() recomputes available slots itself, so it's safe regardless of
  // how many we archived. Best-effort — never fails the archive run.
  if (results.archived > 0) {
    try {
      const promo = await promoteNext();
      if (promo.promoted > 0) {
        log.info("archive cron promoted waitlist reservations", {
          source: LOG_SOURCE,
          promoted: promo.promoted,
          available: promo.available,
        });
      }
    } catch (e) {
      log.warn("archive cron promoteNext failed (non-fatal)", {
        source: LOG_SOURCE,
        error: String(e),
      });
    }
  }

  if (results.timedOut) {
    log.warn("archive-stopped-vms hit time budget; remaining candidates deferred to next run", {
      source: LOG_SOURCE,
      failureType: "archive_budget_exhausted",
      archived: results.archived,
      deferred: results.deferred,
      candidates: results.candidates,
    });
  }

  log.info("cold-storage archive cron complete", {
    source: LOG_SOURCE,
    candidates: results.candidates,
    archived: results.archived,
    skipped: results.skipped,
    failed: results.failed,
  });

  // Surface failures: previously a run where every archive failed returned HTTP
  // 200 with ok:true and no ops-event, so a silently-broken cold-storage
  // pipeline looked healthy. Emit a warn event when any instance failed and
  // report an honest ok flag in the body. Best-effort — never let alerting mask
  // the result.
  if (results.failed > 0) {
    await reportOpsEvent({
      source: "cron.archive_stopped_vms_failed",
      severity: "warn",
      title: `Archive-stopped-vms: ${results.failed} of ${results.candidates} failed`,
      message:
        `archive-stopped-vms completed with ${results.failed} failed and ${results.archived} ` +
        `archived out of ${results.candidates} candidate(s). Free-tier cold-storage archival ` +
        `may be stuck — check the per-instance reasons and the PVE host / Storage Box.`,
      route: "/api/cron/archive-stopped-vms",
      metadata: {
        candidates: results.candidates,
        archived: results.archived,
        skipped: results.skipped,
        failed: results.failed,
        failed_instances: results.perInstance
          .filter((r) => !r.ok && r.reason !== "lock_not_acquired" && r.reason !== "instance_not_archivable")
          .map((r) => ({ id: r.id, reason: r.reason })),
      },
    });
  }

  // Dead-man heartbeat: the sweep ran to completion (per-instance failures are
  // recorded in `results`, not a route-level failure). Best-effort.
  await recordCronHeartbeat("archive-stopped-vms");

  return apiSuccess({
    ok: results.failed === 0,
    mode: "applied",
    thresholdHours,
    batchSize,
    tiers,
    stuckRecovered: recoveredRows?.length ?? 0,
    ...results,
  });
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
