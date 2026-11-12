import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { recordCronHeartbeat } from "@/lib/cron-heartbeat";
import { log } from "@/lib/logger";
import { runSleepIdleSweep } from "@/lib/hivra/sleep-idle-sweep";

/**
 * Cron-triggered agent sleep sweep. Wakes agents ahead of their scheduled jobs,
 * settles stale sleep and wake leases from the host, then hibernates agents that
 * have napped long enough and naps agents that are idle.
 *
 * Never puts an agent to sleep unless HIVRA_SLEEP_MODE is canary or on, and
 * even then only on hosts whose own sleep_mode is canary or on. With it unset,
 * `off` or `observe` the run reports `skipped`, skips the heartbeat, and only
 * does the two recovery steps (wake agents due a scheduled wake, settle stale
 * leases), which find nothing when no agent is asleep. Switching the mode off
 * therefore never strands an agent that is already asleep.
 *
 * Schedule: every minute via vercel.json. New work is started inside a budget of
 * about 50 seconds. A hibernate that is already running may take up to about
 * 285 seconds (its host script is allowed 240), so the limit is 300.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error("CRON_SECRET is not configured; refusing to run", new Error("CRON_SECRET missing"), {
      source: "sleep-idle-agents",
      route: "/api/cron/sleep-idle-agents",
      method: "GET",
      failureType: "cron_secret_missing",
    });
    return apiError("Cron secret is not configured", 500);
  }
  if (!verifyBearerHeader(req, cronSecret)) {
    return apiError("Unauthorized", 401);
  }

  try {
    const summary = await runSleepIdleSweep();
    // Stamp only a real run without errors; a skipped run touches nothing.
    if (!summary.skipped && summary.errors === 0) await recordCronHeartbeat("sleep-idle-agents");
    return apiSuccess(summary);
  } catch (error) {
    log.error("sleep-idle-agents sweep failed", error instanceof Error ? error : new Error(String(error)), {
      source: "sleep-idle-agents",
      route: "/api/cron/sleep-idle-agents",
      method: "GET",
      failureType: "sleep_idle_agents_failed",
    });
    return apiError("Sleep idle agents failed", 500);
  }
}
