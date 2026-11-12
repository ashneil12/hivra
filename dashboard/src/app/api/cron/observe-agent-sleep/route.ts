import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { recordCronHeartbeat } from "@/lib/cron-heartbeat";
import { log } from "@/lib/logger";
import { runObserveAgentSleepSweep } from "@/lib/hivra/observe-agent-sleep";

/**
 * Cron-triggered, observe-only agent sleep log. Records what the sleep policy
 * WOULD decide for each running Hivra agent, using only data already in the
 * database. It never contacts a host and never changes a VM or an agent.
 *
 * Inert unless HIVRA_SLEEP_MODE is observe, canary or on: with it unset or `off`
 * the run reports `skipped` and touches nothing, including the heartbeat.
 *
 * Schedule: every 15 minutes via vercel.json.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error("CRON_SECRET is not configured; refusing to run", new Error("CRON_SECRET missing"), {
      source: "observe-agent-sleep",
      route: "/api/cron/observe-agent-sleep",
      method: "GET",
      failureType: "cron_secret_missing",
    });
    return apiError("Cron secret is not configured", 500);
  }
  if (!verifyBearerHeader(req, cronSecret)) {
    return apiError("Unauthorized", 401);
  }

  try {
    const summary = await runObserveAgentSleepSweep();
    // Stamp only a real run that wrote what it read; a skipped run touches nothing.
    if (!summary.skipped && summary.errors === 0) await recordCronHeartbeat("observe-agent-sleep");
    return apiSuccess(summary);
  } catch (error) {
    log.error("observe-agent-sleep sweep failed", error instanceof Error ? error : new Error(String(error)), {
      source: "observe-agent-sleep",
      route: "/api/cron/observe-agent-sleep",
      method: "GET",
      failureType: "observe_agent_sleep_failed",
    });
    return apiError("Observe agent sleep failed", 500);
  }
}
