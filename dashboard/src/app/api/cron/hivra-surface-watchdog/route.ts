import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { recordCronHeartbeat } from "@/lib/cron-heartbeat";
import { log } from "@/lib/logger";
import { runSurfaceWatchdogSweep } from "@/lib/recovery/hivra-surface-watchdog-sweep";

/**
 * Cron-triggered relay of box-side surface watchdog receipts to ops_events.
 * The watchdog on each agent computer probes the real user path through the
 * box gateway (for Agent Zero: login -> entry -> /api/csrf_token), restarts a
 * wedged surface under bounds, and records receipts; this sweep turns them
 * into ops rows so a wedged surface — or a crash-looping unit — is never
 * silent again. See src/lib/recovery/hivra-surface-watchdog-sweep.ts.
 *
 * Schedule: every 5 minutes via vercel.json.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error(
      "CRON_SECRET is not configured; refusing to run",
      new Error("CRON_SECRET missing"),
      {
        source: "hivra-surface-watchdog",
        route: "/api/cron/hivra-surface-watchdog",
        method: "GET",
        failureType: "cron_secret_missing",
      },
    );
    return apiError("Cron secret is not configured", 500);
  }
  if (!verifyBearerHeader(req, cronSecret)) {
    return apiError("Unauthorized", 401);
  }

  try {
    const summary = await runSurfaceWatchdogSweep();
    // Honest heartbeat: read/relay failures, budget-skipped boxes AND a
    // fleet larger than the per-tick window all mean boxes went unswept
    // this tick — capped>0 is an incomplete sweep, not a clean one.
    await recordCronHeartbeat(
      "hivra-surface-watchdog",
      summary.failed > 0 || summary.notReached > 0 || summary.capped > 0
        ? {
            ok: false,
            detail:
              `failed=${summary.failed} notReached=${summary.notReached} ` +
              `capped=${summary.capped} ` +
              `unreachable=${summary.unreachable} notInstalled=${summary.notInstalled}`,
          }
        : undefined,
    );
    return apiSuccess(summary);
  } catch (err) {
    log.error("surface watchdog sweep failed", err, {
      source: "hivra-surface-watchdog",
      route: "/api/cron/hivra-surface-watchdog",
      method: "GET",
      failureType: "surface_watchdog_sweep_failed",
    });
    const message = err instanceof Error ? err.message : "Surface watchdog sweep failed";
    return apiError(message, 500);
  }
}
