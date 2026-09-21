import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { recordCronHeartbeat } from "@/lib/cron-heartbeat";
import { log } from "@/lib/logger";
import {
  PENDING_PROMPT_CRON_NAME,
  runPendingPromptSweep,
} from "@/lib/recovery/pending-prompt-sweep";

/**
 * Companion cron for the agent-approval-notify feature. Every couple of minutes:
 *   1. expire pending-prompt rows the agent abandoned (died while blocked), so a
 *      stale approval badge/nudge doesn't outlive the agent's park window; and
 *   2. email the owner ONCE if their agent has been blocked on an approval past
 *      the nudge delay and they haven't answered in the workspace iframe.
 *
 * Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. ?dryRun=1 reports what
 * it would do without expiring rows or sending mail.
 *
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *     "$SITE/api/cron/expire-pending-prompts?dryRun=1"
 */
export const maxDuration = 120;
export const dynamic = "force-dynamic";

const ROUTE = "/api/cron/expire-pending-prompts";

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error("CRON_SECRET is not configured; refusing to run", new Error("CRON_SECRET missing"), {
      source: PENDING_PROMPT_CRON_NAME,
      route: ROUTE,
      method: "GET",
      failureType: "cron_secret_missing",
    });
    return apiError("Cron secret is not configured", 500);
  }
  if (!verifyBearerHeader(req, cronSecret)) {
    return apiError("Unauthorized", 401);
  }

  const url = new URL(req.url);
  const limitParam = Number(url.searchParams.get("limit"));
  const dryRunRaw = url.searchParams.get("dryRun")?.trim().toLowerCase();
  const dryRun = dryRunRaw === "1" || dryRunRaw === "true" || dryRunRaw === "yes";

  try {
    const summary = await runPendingPromptSweep({
      limit: Number.isFinite(limitParam) && limitParam > 0 ? limitParam : undefined,
      dryRun,
    });
    if (!dryRun) {
      await recordCronHeartbeat(PENDING_PROMPT_CRON_NAME);
    }
    log.info("expire-pending-prompts sweep complete", {
      source: PENDING_PROMPT_CRON_NAME,
      route: ROUTE,
      ...summary,
    });
    return apiSuccess(summary);
  } catch (err) {
    log.error("expire-pending-prompts sweep failed", err, {
      source: PENDING_PROMPT_CRON_NAME,
      route: ROUTE,
      failureType: "pending_prompt_sweep_failed",
    });
    const message = err instanceof Error ? err.message : "Pending-prompt sweep failed";
    return apiError(message, 500);
  }
}
