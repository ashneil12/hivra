import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import {
  recordCronHeartbeat,
  runCronHeartbeatWatchdog,
  type CronHeartbeatWatchdogResult,
} from "@/lib/cron-heartbeat";
import { log } from "@/lib/logger";
import {
  MIGRATION_DRIFT_LOG_SOURCE,
  runMigrationDriftCheck,
  type MigrationDriftResult,
} from "@/lib/migration-drift";
import { reportOpsEvent } from "@/lib/ops-events";

/**
 * Drift detector for Supabase migrations.
 *
 * On 2026-05-12 four migrations landed in the repo (and were merged to
 * main) but never reached prod, causing 70+ "column does not exist"
 * errors plus 12 user-facing 500s on managed-venice/summary. The gap
 * was invisible — `npm run build` succeeded, CI passed, the dashboard
 * deployed; only the synthetic probes and angry user paths surfaced it.
 *
 * This route compares the build-time migrations manifest against
 * `supabase_migrations.schema_migrations` and emits a per-migration ops
 * event for each name that's local-only. Fingerprint-deduped so each
 * missing migration stays a single row in the ops feed.
 */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error(
      "CRON_SECRET is not configured; refusing to run",
      new Error("CRON_SECRET missing"),
      {
        source: MIGRATION_DRIFT_LOG_SOURCE,
        route: "/api/cron/migration-drift-check",
        method: "GET",
        failureType: "cron_secret_missing",
      }
    );
    return apiError("Cron secret is not configured", 500);
  }
  if (!verifyBearerHeader(req, cronSecret)) {
    return apiError("Unauthorized", 401);
  }

  let result: MigrationDriftResult;
  try {
    result = await runMigrationDriftCheck();
  } catch (err) {
    log.error("migration-drift-check failed", err, {
      source: MIGRATION_DRIFT_LOG_SOURCE,
      route: "/api/cron/migration-drift-check",
      method: "GET",
      failureType: "migration_drift_check_failed",
    });
    const message =
      err instanceof Error ? err.message : "Migration drift check failed";
    return apiError(message, 500);
  }

  // One ops event per missing migration. Severity is "fatal" — this is
  // the exact class of issue that produced the 2026-05-12 incident, and
  // having it surface in the same feed as runtime fatals (rather than
  // buried in warnings) is the whole point of building this.
  for (const entry of result.missing) {
    try {
      await reportOpsEvent({
        source: MIGRATION_DRIFT_LOG_SOURCE,
        severity: "fatal",
        title: `Supabase migration missing in prod: ${entry.name}`,
        message:
          `Local repo has ${entry.version}_${entry.name}.sql but the ` +
          `migration has not been applied to prod. Apply via supabase CLI ` +
          `or MCP before more code depends on this schema.`,
        route: "/api/cron/migration-drift-check",
        metadata: {
          failureType: "supabase_migration_missing_in_prod",
          migrationVersion: entry.version,
          migrationName: entry.name,
          recoveryAction: "apply_migration",
        },
      });
    } catch (err) {
      // Best-effort — never let ops-event emission break the cron loop.
      log.warn("migration-drift-check could not report ops event", {
        source: MIGRATION_DRIFT_LOG_SOURCE,
        migrationName: entry.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (result.missing.length > 0) {
    log.error(
      "migration drift detected — missing migrations in prod",
      new Error(
        `${result.missing.length} migration(s) missing in prod: ${result.missing.map((m) => m.name).join(", ")}`
      ),
      {
        source: MIGRATION_DRIFT_LOG_SOURCE,
        failureType: "supabase_migration_drift",
        missingCount: result.missing.length,
        missingNames: result.missing.map((m) => m.name),
      }
    );
  }

  if (result.unexpected.length > 0) {
    // Lower-severity warn — out-of-band migrations (e.g. emergency DDL)
    // are real but not actively breaking anything. We just want them
    // visible so they eventually get back-ported into the repo.
    log.warn(
      "migration drift detected — unexpected migrations in prod",
      {
        source: MIGRATION_DRIFT_LOG_SOURCE,
        failureType: "supabase_migration_unexpected_in_prod",
        unexpectedCount: result.unexpected.length,
        unexpectedNames: result.unexpected.map((m) => m.name),
      }
    );
  }

  // Cron dead-man watchdog. Co-located here because migration-drift-check runs
  // every 10 min and is itself one of the most reliable crons (pure DB read,
  // no SSH/network fan-out), so it's a stable host for the heartbeat sweep.
  // Best-effort: a watchdog hiccup must not fail the drift check it rides on.
  let cronWatchdog: CronHeartbeatWatchdogResult | null = null;
  try {
    cronWatchdog = await runCronHeartbeatWatchdog();
    if (cronWatchdog.stale.length > 0) {
      log.error(
        "cron dead-man watchdog detected stalled crons",
        new Error(
          `${cronWatchdog.stale.length} cron(s) stale: ${cronWatchdog.stale.map((s) => s.name).join(", ")}`,
        ),
        {
          source: MIGRATION_DRIFT_LOG_SOURCE,
          failureType: "cron_heartbeat_stale",
          staleCrons: cronWatchdog.stale.map((s) => s.name),
        },
      );
    }
  } catch (err) {
    log.warn("cron dead-man watchdog failed", {
      source: MIGRATION_DRIFT_LOG_SOURCE,
      failureType: "cron_heartbeat_watchdog_failed",
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }

  // Self-heartbeat. The dead-man watchdog for the WHOLE fleet is parasitically
  // hosted in THIS route, yet migration-drift-check has no heartbeat of its own
  // and (currently) isn't in CRON_REGISTRY — so if it ever stops being
  // scheduled, the watchdog goes dark with no self-detection. Stamping its own
  // heartbeat here means that once it's added to CRON_REGISTRY (a one-line
  // change in src/lib/cron-heartbeat.ts — see note; that file is owned
  // elsewhere) the watchdog will detect its own silence on the next run that
  // DOES fire. Best-effort.
  await recordCronHeartbeat("migration-drift-check");

  return apiSuccess({
    totalLocal: result.totalLocal,
    totalApplied: result.totalApplied,
    missing: result.missing,
    unexpected: result.unexpected,
    versionMismatched: result.versionMismatched,
    cronWatchdog,
  });
}
