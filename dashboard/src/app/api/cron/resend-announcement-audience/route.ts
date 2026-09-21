import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { syncClerkUsersToAnnouncementAudience } from "@/lib/email/resend-announcement-sync";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";

// The sync sleeps ~800ms per Clerk user (Resend rate-limit headroom) and again
// per orphan-prune contact, so total runtime scales linearly with audience
// size. Vercel's default function timeout (60s) starts truncating runs once
// we're past ~50 users; bump to the cron ceiling so we don't silently 504
// while the audience grows.
export const maxDuration = 300;

// Wall-clock budget passed to the sync so it stops cleanly a safe margin under
// maxDuration (300s) instead of being SIGKILLed mid-loop with
// "Task timed out after 300 seconds". The sync is idempotent and runs daily, so
// any unprocessed tail converges on subsequent runs. ~50s of headroom covers
// the in-flight Resend round-trip + rate-limit backoff after the last check.
const SYNC_TIME_BUDGET_MS = 250_000;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    log.error("CRON_SECRET is not configured; refusing to run", new Error("missing CRON_SECRET"), {
      source: "resend-announcement-audience",
      route: "/api/cron/resend-announcement-audience",
      method: "GET",
      failureType: "cron_secret_missing",
    });
    return apiError("Cron secret is not configured", 500);
  }

  if (!verifyBearerHeader(req, cronSecret)) {
    return apiError("Unauthorized", 401);
  }

  try {
    const result = await syncClerkUsersToAnnouncementAudience({
      timeBudgetMs: SYNC_TIME_BUDGET_MS,
    });
    if (result.timedOut) {
      log.warn("resend announcement audience sync hit time budget; tail deferred to next run", {
        source: "resend-announcement-audience",
        route: "/api/cron/resend-announcement-audience",
        method: "GET",
        failureType: "resend_announcement_audience_budget_exhausted",
        recipientsProcessed: result.recipientsProcessed,
        recipients: result.recipients,
        pruned: result.pruned,
      });
    }
    return apiSuccess(result);
  } catch (error) {
    // The error was previously only echoed as errorName in the 500 body — no
    // structured log from this route and no feed signal. Add both so a Resend/
    // Clerk outage that breaks the daily audience sync is greppable + visible.
    log.error("resend announcement audience sync failed", error, {
      source: "resend-announcement-audience",
      route: "/api/cron/resend-announcement-audience",
      method: "GET",
      failureType: "resend_announcement_audience_sync_failed",
    });
    await reportOpsEvent({
      source: "cron.resend-announcement-audience",
      severity: "warn",
      title: "Resend announcement audience sync failed",
      message:
        "syncClerkUsersToAnnouncementAudience threw. The announcement audience may be out of " +
        "sync with Clerk (new users not added / orphans not pruned) until the next run.",
      route: "/api/cron/resend-announcement-audience",
      metadata: {
        failureType: "resend_announcement_audience_sync_failed",
        errorName: error instanceof Error ? error.name : typeof error,
      },
    });
    return apiError("Failed to sync Resend announcement audience", 500, {
      failureType: "resend_announcement_audience_sync_failed",
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}
