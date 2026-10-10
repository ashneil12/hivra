import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import { runActivityRetention } from "@/lib/ops/activity-retention";
import { supabaseAdmin } from "@/lib/supabase";

/**
 * Cron-triggered retention for Hivra agent activity records
 * (hivra_agent_events, hivra_activity_collectors). Deletes records older than
 * ACTIVITY_RETENTION_DAYS (default 90) and leftovers of deleted computers, in
 * bounded batches. See src/lib/ops/activity-retention.ts.
 *
 * OFF unless ACTIVITY_RETENTION_ENABLED=true: until then every run is a dry run
 * that reports counts and deletes nothing. Force a preview with ?dryRun=1.
 *
 * Schedule: daily via vercel.json.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error("CRON_SECRET is not configured; refusing to run", new Error("CRON_SECRET missing"), {
      source: "prune-hivra-activity",
      route: "/api/cron/prune-hivra-activity",
      method: "GET",
      failureType: "cron_secret_missing",
    });
    return apiError("Cron secret is not configured", 500);
  }
  if (!verifyBearerHeader(req, cronSecret)) {
    return apiError("Unauthorized", 401);
  }
  if (!supabaseAdmin) {
    return apiError("Database is not configured", 500);
  }

  try {
    const dryRunParam = new URL(req.url).searchParams.get("dryRun");
    const forceDryRun = dryRunParam === "1" || dryRunParam === "true";

    const summary = await runActivityRetention(supabaseAdmin, { forceDryRun });

    log.info("prune-hivra-activity run", {
      source: "prune-hivra-activity",
      dryRun: summary.dryRun,
      enabled: summary.enabled,
      retentionDays: summary.retentionDays,
      cutoff: summary.cutoff,
      eligible: summary.eligible,
      deleted: summary.deleted,
      batches: summary.batches,
      complete: summary.complete,
    });

    const deletedTotal =
      summary.deleted.expiredEvents +
      summary.deleted.deletedComputerEvents +
      summary.deleted.deletedComputerCollectors;
    if (deletedTotal > 0 || !summary.complete) {
      await reportOpsEvent({
        source: "cron.prune_hivra_activity",
        severity: summary.complete ? "info" : "warn",
        title: `prune-hivra-activity: deleted ${deletedTotal} activity row(s)`,
        message:
          `Deleted ${summary.deleted.expiredEvents} event(s) older than ${summary.retentionDays} days, ` +
          `${summary.deleted.deletedComputerEvents} event(s) and ${summary.deleted.deletedComputerCollectors} ` +
          `reporter row(s) of deleted computers in ${summary.batches} batch(es).` +
          (summary.complete ? "" : " Batch cap reached; the rest clears on the next run."),
        route: "/api/cron/prune-hivra-activity",
        metadata: { ...summary },
      });
    }

    return apiSuccess(summary);
  } catch (error) {
    log.error("prune-hivra-activity failed", error instanceof Error ? error : new Error(String(error)), {
      source: "prune-hivra-activity",
      route: "/api/cron/prune-hivra-activity",
      method: "GET",
      failureType: "activity_retention_failed",
    });
    return apiError("Activity retention failed", 500);
  }
}
