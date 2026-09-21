import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { log } from "@/lib/logger";
import { runResumeMispausedPaidSweep } from "@/lib/recovery/resume-mispaused-paid-instances";

/**
 * Resume paid-tier agents that the inactivity sweep wrongly paused (before paid
 * tiers became exempt). Manual / bearer-triggered remediation — NOT on a
 * vercel.json schedule, so it never resumes paid agents on a timer behind the
 * operator's back. Stage it with ?limit=N (default 10, cap 50) to spread the
 * wake across hosts; ?dryRun=1 reports the eligible count without touching VMs.
 *
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *     "$SITE/api/cron/resume-mispaused-paid-instances?limit=10"
 */
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    // Mirror the breadcrumb every other cron route emits — a misconfigured env
    // must not fail silently with no log line.
    log.error(
      "CRON_SECRET is not configured; refusing to run",
      new Error("CRON_SECRET missing"),
      {
        source: "resume-mispaused-paid-instances",
        route: "/api/cron/resume-mispaused-paid-instances",
        method: "GET",
        failureType: "cron_secret_missing",
      },
    );
    return apiError("Cron secret is not configured", 500);
  }
  if (!verifyBearerHeader(req, cronSecret)) {
    return apiError("Unauthorized", 401);
  }

  const url = new URL(req.url);
  const limitParam = Number(url.searchParams.get("limit"));
  // Accept the common truthy spellings, not just "1". Previously ?dryRun=true
  // silently fell through to a REAL resume (wakes paid VMs) because only "1"
  // matched — a dangerous footgun for a destructive-adjacent endpoint.
  const dryRunRaw = url.searchParams.get("dryRun")?.trim().toLowerCase();
  const dryRun = dryRunRaw === "1" || dryRunRaw === "true" || dryRunRaw === "yes";

  try {
    const summary = await runResumeMispausedPaidSweep({
      limit: Number.isFinite(limitParam) ? limitParam : undefined,
      dryRun,
    });
    log.info("resume-mispaused-paid sweep complete", {
      source: "resume-mispaused-paid-instances",
      route: "/api/cron/resume-mispaused-paid-instances",
      ...summary,
    });
    return apiSuccess(summary);
  } catch (err) {
    log.error("resume-mispaused-paid sweep failed", err, {
      source: "resume-mispaused-paid-instances",
      route: "/api/cron/resume-mispaused-paid-instances",
      failureType: "resume_mispaused_sweep_failed",
    });
    // Surface the error message in the response (it's a bearer-gated operator
    // endpoint, not public) so a manual remediation run is debuggable without
    // grepping logs — matches the sibling crons.
    const message = err instanceof Error ? err.message : "Resume sweep failed";
    return apiError(message, 500);
  }
}
