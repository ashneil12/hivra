import "server-only";

import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import { supabaseAdmin } from "@/lib/supabase";

// Cron dead-man switch.
//
// Vercel Cron failures are silent: a route that 500s, times out, or simply
// stops being scheduled produces NO signal in the ops feed — the very crons
// that surface fleet breakage can themselves die unnoticed (the prober going
// dark looks identical to "fleet healthy"). This module gives each critical
// cron a heartbeat it stamps at the END of a successful run, plus a watchdog
// that fires a FATAL ops event when any registered cron is stale beyond 2x
// its expected period.
//
// Wiring: call recordCronHeartbeat(<name>) on the success path of a cron
// route (after the work resolves, before the response). Register the cron's
// expected period in CRON_REGISTRY below so the watchdog knows its staleness
// budget. The watchdog (runCronHeartbeatWatchdog) is invoked from a
// frequently-run cron — see /api/cron/migration-drift-check.

export interface CronHeartbeatDefinition {
  /** Stable key, matches the recordCronHeartbeat() call and the heartbeat row. */
  name: string;
  /** Expected gap between successful runs, in minutes (from vercel.json schedule). */
  periodMinutes: number;
}

// The crons whose silence is a real incident. periodMinutes mirrors the
// schedule in vercel.json. The watchdog only alerts on crons listed here AND
// already seen at least once (a never-run cron has no baseline — we don't want
// a false page the first time the registry grows ahead of the wiring).
export const CRON_REGISTRY: readonly CronHeartbeatDefinition[] = [
  { name: "probe-instance-health", periodMinutes: 5 },
  { name: "recover-unhealthy-active-instances", periodMinutes: 15 },
  { name: "autoheal-llm-transport-failures", periodMinutes: 15 },
  { name: "purge-expired", periodMinutes: 1440 },
  // Runs every 4h (vercel.json "0 */4 * * *"), so a genuinely stalled archive
  // cron pages within ~8h (2x) instead of ~2 days. See archive-stopped-vms route.
  { name: "archive-stopped-vms", periodMinutes: 240 },
  { name: "inactivity-sweep", periodMinutes: 60 },
  { name: "redeploy-webui-instances", periodMinutes: 1440 },
  { name: "migration-drift-check", periodMinutes: 10 },
  { name: "fleet-status-reconcile", periodMinutes: 30 },
  { name: "reconcile-soul-seeds", periodMinutes: 20 },
  { name: "daily-config-snapshot", periodMinutes: 1440 },
  { name: "reservation-claim-expiry", periodMinutes: 120 },
  // Both backup crons stamped a heartbeat but were never registered, so the
  // watchdog could not page on their silence — the exact failure mode they
  // guard against (a fleet-wide backup stop) was the one nothing would notice.
  // These cover PAID tenants' data, so silence is a data-loss risk, not noise.
  // vercel.json: "30 2 * * *" and "0 4 * * *" — daily, so 1440.
  { name: "daily-vm-backups", periodMinutes: 1440 },
  { name: "daily-instance-backups", periodMinutes: 1440 },
];

/**
 * Stamp a successful cron run. Upserts the heartbeat row: bumps last_run_at +
 * last_success_at to now and increments the counters. Best-effort — a
 * heartbeat write failing must NEVER fail the cron it's instrumenting, so this
 * swallows all errors and only logs a warning.
 */
export async function recordCronHeartbeat(name: string): Promise<void> {
  const db = supabaseAdmin;
  if (!db) return;

  try {
    const { error } = await db.rpc("record_cron_heartbeat", { p_cron_name: name });
    if (error) {
      log.warn("recordCronHeartbeat failed", {
        source: "cron-heartbeat",
        failureType: "cron_heartbeat_write_failed",
        cronName: name,
        errorMessage: error.message,
      });
    }
  } catch (err) {
    log.warn("recordCronHeartbeat threw", {
      source: "cron-heartbeat",
      failureType: "cron_heartbeat_write_threw",
      cronName: name,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }
}

interface CronHeartbeatRow {
  cron_name: string;
  last_success_at: string | null;
  last_run_at: string | null;
  ok_count: number | null;
  run_count: number | null;
}

export interface CronHeartbeatWatchdogResult {
  checked: number;
  stale: Array<{ name: string; lastSuccessAt: string | null; staleMinutes: number; periodMinutes: number }>;
}

// A cron is "stale" once it has gone longer than this multiple of its period
// without a successful run. 2x absorbs one missed tick + a slow run before it
// pages — matches the brief's "> 2x its period" bar.
const STALE_PERIOD_MULTIPLIER = 2;

/**
 * Dead-man check across CRON_REGISTRY. For each registered cron that has been
 * seen at least once but whose last_success_at is older than 2x its period,
 * emit a fatal ops event. Fingerprint-deduped per cron name (via reportOpsEvent),
 * so a long-dead cron stays one trending row and pages admins once. Returns the
 * stale set so the calling route can surface it in its response.
 */
export async function runCronHeartbeatWatchdog(): Promise<CronHeartbeatWatchdogResult> {
  const db = supabaseAdmin;
  if (!db) {
    throw new Error("Supabase admin client not configured");
  }

  const { data, error } = await db
    .from("ops_cron_heartbeats")
    .select("cron_name, last_success_at, last_run_at, ok_count, run_count");
  if (error) {
    throw new Error(error.message || "Failed to read cron heartbeats");
  }

  const byName = new Map<string, CronHeartbeatRow>();
  for (const row of (data ?? []) as CronHeartbeatRow[]) {
    byName.set(row.cron_name, row);
  }

  const now = Date.now();
  const stale: CronHeartbeatWatchdogResult["stale"] = [];

  for (const def of CRON_REGISTRY) {
    const row = byName.get(def.name);
    // Never-seen cron: no baseline. Skip — wiring may trail the registry.
    if (!row || !row.last_success_at) continue;

    const lastSuccessMs = new Date(row.last_success_at).getTime();
    if (!Number.isFinite(lastSuccessMs)) continue;

    const staleMinutes = (now - lastSuccessMs) / 60000;
    const budgetMinutes = def.periodMinutes * STALE_PERIOD_MULTIPLIER;
    if (staleMinutes <= budgetMinutes) continue;

    stale.push({
      name: def.name,
      lastSuccessAt: row.last_success_at,
      staleMinutes: Math.round(staleMinutes),
      periodMinutes: def.periodMinutes,
    });

    // Title + message MUST be STABLE for a given ongoing stall. reportOpsEvent
    // fingerprints on (source, title, message, route, …) and pages an admin only
    // on the INSERT branch (first sighting). Embedding the live staleMinutes in
    // the title/message — as this did originally — mints a fresh fingerprint
    // every watchdog tick (~every 10 min via migration-drift-check), so every
    // tick looked like a first sighting and re-paged: a single stalled cron
    // became an admin email every 10 minutes (observed: 372 emails / ~2.5 days).
    // The volatile numbers (staleMinutes, lastSuccessAt) live in metadata, which
    // is NOT part of the fingerprint, so a prolonged stall now pages exactly once
    // and subsequent ticks take reportOpsEvent's UPDATE branch (bumping
    // occurrence_count + last_seen_at) without re-paging.
    await reportOpsEvent({
      source: "synthetic.cron-dead-man",
      severity: "fatal",
      title: `Cron stalled: ${def.name}`,
      message:
        `Cron '${def.name}' is expected to run every ${def.periodMinutes} min but has not ` +
        `recorded a successful run within its ${budgetMinutes} min dead-man budget. It is ` +
        `likely 500ing, timing out, or no longer scheduled. Check Vercel Cron + the route ` +
        `logs for /api/cron/${def.name}; a silent prober/recovery cron means fleet breakage ` +
        `now goes unnoticed. Exact staleness + last-success time are in this event's metadata.`,
      route: `/api/cron/${def.name}`,
      metadata: {
        failureOwner: "control-plane",
        failurePhase: "scheduling",
        failureType: "cron_heartbeat_stale",
        recoveryAction: "investigate_cron",
        cronName: def.name,
        periodMinutes: def.periodMinutes,
        budgetMinutes,
        staleMinutes: Math.round(staleMinutes),
        lastSuccessAt: row.last_success_at,
        lastRunAt: row.last_run_at,
        okCount: row.ok_count,
        runCount: row.run_count,
      },
    });
  }

  return { checked: CRON_REGISTRY.length, stale };
}
