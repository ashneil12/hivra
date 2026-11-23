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
// either seen at least once or past the expected-since grace (a never-seen
// cron gets a watchdog-planted marker row on first sight and pages once the
// marker outlives its period budget — wiring may trail the registry, so the
// grace is the same 3x a rough start gets).
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
  // Both backup crons stamped a heartbeat but were never registered, so the
  // watchdog could not page on their silence — the exact failure mode they
  // guard against (a fleet-wide backup stop) was the one nothing would notice.
  // These cover PAID tenants' data, so silence is a data-loss risk, not noise.
  // vercel.json: "30 2 * * *" and "0 4 * * *" — daily, so 1440.
  { name: "daily-vm-backups", periodMinutes: 1440 },
  { name: "daily-instance-backups", periodMinutes: 1440 },
  // The incident evaluator watches every other cron's heartbeat — if IT dies,
  // nothing evaluates incidents, including its own. Registering it here lets
  // migration-drift-check's independent watchdog page on its silence (2x5min).
  { name: "customer-incidents", periodMinutes: 5 },
];

/**
 * How a cron run ended. Default (or `ok: true`) is a fully clean run. Pass
 * `{ ok: false, detail }` when the handler completed but its own summary shows
 * per-item failures: run_count still bumps, but ok_count and last_success_at
 * do NOT move and consecutive_failures increments — so a cron that fails every
 * tick stops looking 100% healthy to the ops feed and the customer-incidents
 * cron_unhealthy rule.
 */
export interface CronHeartbeatOutcome {
  ok?: boolean;
  /** Short operator-facing reason (counts only, no secrets). Stored in last_detail. */
  detail?: string;
}

/**
 * Stamp a cron run. Upserts the heartbeat row: bumps last_run_at, and on a
 * fully-ok run also bumps last_success_at and resets consecutive_failures.
 * Best-effort — a heartbeat write failing must NEVER fail the cron it's
 * instrumenting, so this swallows all errors and only logs a warning.
 */
export async function recordCronHeartbeat(
  name: string,
  outcome?: CronHeartbeatOutcome,
): Promise<void> {
  const db = supabaseAdmin;
  if (!db) return;

  const ok = outcome?.ok !== false;
  try {
    // Callers that pass no outcome keep the original one-argument RPC shape:
    // it resolves against both the pre-migration record_cron_heartbeat(text)
    // and the outcome-aware (text, boolean, text) whose extra params default.
    // Passing p_ok/p_detail unconditionally would break every heartbeat write
    // in the window between deploy and migration apply.
    const { error } = await db.rpc(
      "record_cron_heartbeat",
      outcome === undefined
        ? { p_cron_name: name }
        : { p_cron_name: name, p_ok: ok, p_detail: outcome.detail ?? null },
    );
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
  created_at: string | null;
}

export interface CronHeartbeatWatchdogResult {
  checked: number;
  stale: Array<{ name: string; lastSuccessAt: string | null; staleMinutes: number; periodMinutes: number }>;
}

// A cron is "stale" once it has gone longer than this multiple of its period
// without a successful run. 2x absorbs one missed tick + a slow run before it
// pages — matches the brief's "> 2x its period" bar.
const STALE_PERIOD_MULTIPLIER = 2;
// Never-succeeded crons get a slightly wider window: their first runs may
// legitimately fail while a fix deploys, but 3 missed periods without ANY
// success is a dead cron, not a rough start.
const NEVER_SUCCEEDED_PERIOD_MULTIPLIER = 3;

/**
 * Plant the watchdog's expected-since marker for a registered cron with no
 * heartbeat row. The row (run_count = 0, created_at = now) is the baseline a
 * later tick ages: once it outlives the never-succeeded budget the cron pages
 * as never-reported. Without it a cron that always dies before its first
 * heartbeat write would be invisible forever. ignoreDuplicates so a heartbeat
 * row racing this write wins. Best-effort like the heartbeat itself — a
 * failed marker must never break the watchdog's page loop.
 */
async function markCronExpectedSince(
  db: NonNullable<typeof supabaseAdmin>,
  cronName: string,
): Promise<void> {
  try {
    const { error } = await db.from("ops_cron_heartbeats").upsert(
      {
        cron_name: cronName,
        run_count: 0,
        ok_count: 0,
        last_detail: "watchdog expected-since marker: awaiting first heartbeat",
      },
      { onConflict: "cron_name", ignoreDuplicates: true },
    );
    if (error) {
      log.warn("cron expected-since marker write failed", {
        source: "cron-heartbeat",
        failureType: "cron_expected_since_marker_failed",
        cronName,
        errorMessage: error.message,
      });
    }
  } catch (err) {
    log.warn("cron expected-since marker write threw", {
      source: "cron-heartbeat",
      failureType: "cron_expected_since_marker_threw",
      cronName,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }
}

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
    .select("cron_name, last_success_at, last_run_at, ok_count, run_count, created_at");
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
    // Never reported: no row at all. A cron that times out on EVERY
    // invocation dies before it can write its first heartbeat, and without a
    // baseline it would stay invisible forever — plant the watchdog's
    // expected-since marker (first-seen-missing ≈ deploy/registration time)
    // so a later tick can age it like any other never-succeeded row. The
    // insert only fills an empty slot: a heartbeat row that lands between the
    // SELECT above and this write is kept (ignoreDuplicates).
    if (!row) {
      await markCronExpectedSince(db, def.name);
      continue;
    }

    // A cron that ran but never succeeded has no last_success_at, and failing
    // runs keep refreshing last_run_at — staleness alone can never see it (the
    // route 500s every tick forever while looking "fresh"). When run_count > 0
    // with no success ever, age the dead-man budget from the row's creation:
    // 3x its period without a single success is just as dead as 2x without a
    // recent one. A marker row (run_count = 0) is the same shape one step
    // earlier: the cron never reported at all.
    const neverReported = (row.run_count ?? 0) === 0;
    const neverSucceeded =
      !neverReported && row.last_success_at == null;
    const referenceRaw = neverReported || neverSucceeded ? row.created_at : row.last_success_at;
    const referenceMs = referenceRaw ? new Date(referenceRaw).getTime() : NaN;
    if (!Number.isFinite(referenceMs)) continue;

    const staleMinutes = (now - referenceMs) / 60000;
    const budgetMinutes = def.periodMinutes * (neverReported || neverSucceeded ? NEVER_SUCCEEDED_PERIOD_MULTIPLIER : STALE_PERIOD_MULTIPLIER);
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
      message: neverReported
        ? `Cron '${def.name}' is expected to run every ${def.periodMinutes} min but has never ` +
          `recorded a heartbeat, and its watchdog-planted expected-since marker is past the ` +
          `${budgetMinutes} min dead-man budget. It is likely timing out before its first ` +
          `run completes, 500ing before the heartbeat write, or not scheduled at all. Check Vercel ` +
          `Cron + the route logs for /api/cron/${def.name}; a silent prober/recovery cron means ` +
          `fleet breakage now goes unnoticed. Exact marker age and run counts are in this ` +
          `event's metadata.`
        : `Cron '${def.name}' is expected to run every ${def.periodMinutes} min but has not ` +
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
        neverSucceeded,
        neverReported,
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

type CronHeartbeatDayQuery = {
  select: (columns: string) => CronHeartbeatDayQuery;
  eq: (column: string, value: string) => CronHeartbeatDayQuery;
  limit: (count: number) => CronHeartbeatDayQuery;
  then: Promise<{ data?: unknown; error: { message?: string } | null }>["then"];
};

function utcDayKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

/**
 * True when `now` lands on a later UTC calendar day than the cron's previous
 * recorded run — this tick is the first of a new UTC day. Batch jobs use it
 * to run once-a-day work (retrying rows the per-tick age cutoff excluded) on
 * exactly one tick. It requires an observed previous tick: no heartbeat row,
 * an unreadable last_run_at, or a failed read all answer false, because
 * "exactly one tick per UTC day" cannot be proven without the previous
 * tick's timestamp.
 */
export async function isFirstCronTickOfUtcDay(
  db: { from: (name: string) => unknown } | null | undefined,
  cronName: string,
  now: Date,
): Promise<boolean> {
  if (!db) return false;
  let lastRunAt: string | null = null;
  try {
    const { data, error } = await (
      db.from("ops_cron_heartbeats") as unknown as CronHeartbeatDayQuery
    )
      .select("last_run_at")
      .eq("cron_name", cronName)
      .limit(1);
    if (error) {
      log.warn("cron heartbeat day check failed; treating tick as same-day", {
        source: "cron-heartbeat",
        failureType: "cron_heartbeat_day_check_failed",
        cronName,
        errorMessage: error.message ?? "unknown",
      });
      return false;
    }
    const row = Array.isArray(data) ? (data[0] as { last_run_at?: unknown } | undefined) : undefined;
    lastRunAt = typeof row?.last_run_at === "string" ? row.last_run_at : null;
  } catch (error) {
    log.warn("cron heartbeat day check threw; treating tick as same-day", {
      source: "cron-heartbeat",
      failureType: "cron_heartbeat_day_check_threw",
      cronName,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
  if (!lastRunAt) return false;
  const previousMs = Date.parse(lastRunAt);
  if (!Number.isFinite(previousMs)) return false;
  return utcDayKey(now) !== utcDayKey(new Date(previousMs));
}

type CronHeartbeatClaimQuery = {
  eq: (column: string, value: string) => CronHeartbeatClaimQuery;
  lt: (column: string, value: string) => CronHeartbeatClaimQuery;
  select: (columns: string) => {
    then: Promise<{ data?: unknown; error: { message?: string } | null }>["then"];
  };
};

type CronHeartbeatClaimTable = {
  update: (patch: Record<string, unknown>) => CronHeartbeatClaimQuery;
  upsert: (
    row: Record<string, unknown>,
    options: { onConflict: string; ignoreDuplicates: boolean },
  ) => {
    then: Promise<{ data?: unknown; error: { message?: string } | null }>["then"];
  };
};

/**
 * Atomically claim a cron's once-per-UTC-day slot. isFirstCronTickOfUtcDay is
 * only a read: two overlapping authorized invocations can both observe
 * "previous tick was yesterday" before either heartbeats at the end of its
 * run, so it cannot decide who runs once-a-day work. This update can: the
 * first writer to move last_run_at into today owns the day. Under READ
 * COMMITTED a loser blocks on the row lock, then re-evaluates the guard
 * against the winner's commit — last_run_at is no longer before today, so
 * its update matches nothing and it skips the daily work.
 *
 * Uses the cron's own heartbeat row: no previous run recorded means no
 * baseline and no claim (last_run_at NULL fails the guard), matching the
 * day-check's contract. A claimant that crashes before heartbeating leaves
 * last_run_at inside today, so the day's once-only work defers to tomorrow —
 * deferral, not loss, which is the right trade for a daily retry. The claim
 * marker in last_detail survives only on that crash path (a heartbeat
 * overwrites it at run end), where it explains why the day was skipped.
 * Best-effort like the rest of this module: a failed claim answers false
 * rather than throwing into the cron it guards.
 */
export async function claimCronUtcDay(
  db: { from: (name: string) => unknown } | null | undefined,
  cronName: string,
  now: Date,
  options?: { claimKey?: string },
): Promise<boolean> {
  if (!db) return false;
  // A claim key owns a dedicated heartbeat row ("<cron>:<key>") so the
  // once-daily slot is claimed by the tick that RAN the work — not by the
  // run's heartbeat. Without it, a tick that starts just before UTC midnight
  // claims its start day, then the end-of-run heartbeat lands last_run_at in
  // the NEW day and the next day's pass is skipped: the day's work is
  // claimed for the day it ran, on a row the heartbeat never overwrites.
  const rowName = options?.claimKey ? `${cronName}:${options.claimKey}` : cronName;
  const utcDayStart = new Date(now);
  utcDayStart.setUTCHours(0, 0, 0, 0);
  const claim = () =>
    (db.from("ops_cron_heartbeats") as unknown as CronHeartbeatClaimTable)
      .update({
        last_run_at: now.toISOString(),
        last_detail: `utc day ${utcDayKey(now)} claimed for once-daily work; awaiting run heartbeat`,
        updated_at: now.toISOString(),
      })
      .eq("cron_name", rowName)
      .lt("last_run_at", utcDayStart.toISOString())
      .select("cron_name");
  try {
    const { data, error } = await claim();
    if (error) {
      log.warn("cron utc-day claim failed; skipping once-daily work", {
        source: "cron-heartbeat",
        failureType: "cron_utc_day_claim_failed",
        cronName: rowName,
        errorMessage: error.message ?? "unknown",
      });
      return false;
    }
    if (Array.isArray(data) && data.length > 0) return true;
    // A claim without a key keys off the cron's own heartbeat row: no match
    // means the day is taken (or there is no baseline) — nothing else to do.
    if (!options?.claimKey) return false;

    // A keyed row is dedicated: nothing else creates it, so a miss can also
    // mean it was never planted. Distinguish "claimed today" from "missing"
    // before giving up — an existing row means the guard already decided.
    const { data: existing, error: readError } = await (
      db.from("ops_cron_heartbeats") as unknown as CronHeartbeatDayQuery
    )
      .select("cron_name")
      .eq("cron_name", rowName)
      .limit(1);
    if (readError) {
      log.warn("cron utc-day claim row read failed; skipping once-daily work", {
        source: "cron-heartbeat",
        failureType: "cron_utc_day_claim_row_read_failed",
        cronName: rowName,
        errorMessage: readError.message ?? "unknown",
      });
      return false;
    }
    if (Array.isArray(existing) && existing.length > 0) return false;

    // First sight: plant the row seeded from the cron's own previous tick
    // when one exists, so a claim key adopted mid-life inherits the same
    // "previous day" baseline the heartbeat gave it and does not re-run a
    // day the old scheme already covered; with no baseline at all the first
    // observed tick only plants (claim fails below), matching the
    // day-check's "requires an observed previous tick" contract.
    const { data: baseRows, error: baseError } = await (
      db.from("ops_cron_heartbeats") as unknown as CronHeartbeatDayQuery
    )
      .select("last_run_at")
      .eq("cron_name", cronName)
      .limit(1);
    if (baseError) {
      log.warn("cron utc-day claim baseline read failed; skipping once-daily work", {
        source: "cron-heartbeat",
        failureType: "cron_utc_day_claim_baseline_failed",
        cronName: rowName,
        errorMessage: baseError.message ?? "unknown",
      });
      return false;
    }
    const baseRow = Array.isArray(baseRows)
      ? (baseRows[0] as { last_run_at?: unknown } | undefined)
      : undefined;
    const baseline =
      typeof baseRow?.last_run_at === "string" ? baseRow.last_run_at : now.toISOString();
    const { error: plantError } = await (
      db.from("ops_cron_heartbeats") as unknown as CronHeartbeatClaimTable
    ).upsert(
      {
        cron_name: rowName,
        run_count: 0,
        ok_count: 0,
        last_run_at: baseline,
        last_detail: "utc-day claim row planted; first claim pending",
      },
      { onConflict: "cron_name", ignoreDuplicates: true },
    );
    if (plantError) {
      log.warn("cron utc-day claim row plant failed; skipping once-daily work", {
        source: "cron-heartbeat",
        failureType: "cron_utc_day_claim_row_plant_failed",
        cronName: rowName,
        errorMessage: plantError.message ?? "unknown",
      });
      return false;
    }
    // Retry the SAME guarded update: a baseline before today claims now, a
    // same-day (or just-planted) baseline defers the pass to tomorrow.
    const { data: retryData, error: retryError } = await claim();
    if (retryError) {
      log.warn("cron utc-day claim retry failed; skipping once-daily work", {
        source: "cron-heartbeat",
        failureType: "cron_utc_day_claim_retry_failed",
        cronName: rowName,
        errorMessage: retryError.message ?? "unknown",
      });
      return false;
    }
    return Array.isArray(retryData) && retryData.length > 0;
  } catch (error) {
    log.warn("cron utc-day claim threw; skipping once-daily work", {
      source: "cron-heartbeat",
      failureType: "cron_utc_day_claim_threw",
      cronName: rowName,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
