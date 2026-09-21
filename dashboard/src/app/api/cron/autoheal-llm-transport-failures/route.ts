import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { recordCronHeartbeat } from "@/lib/cron-heartbeat";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import { runAutohealLlmTransportFailuresSweep } from "@/lib/recovery/autoheal-llm-transport-failures";

/**
 * Cron-triggered sweeper that restarts agent gateways which are HEALTHY at the
 * HTTP layer but whose LLM calls are hard-failing with transport-class errors
 * (broken pipe / ReadError / provider overloaded). The /health-probe recovery
 * crons can't see this class — the gateway returns 200 while every inference
 * call fails. See src/lib/recovery/autoheal-llm-transport-failures.ts for the
 * detection heuristic and the cooldown / attempt-cap semantics.
 *
 * Schedule: every 15 minutes via vercel.json.
 */
export const dynamic = "force-dynamic";

// Probes + restarts are sequential SSH sessions; the lib enforces a 10-min
// soft budget and per-run caps, so keep the hard ceiling above that so a real
// run finishes instead of being SIGTERM'd mid-restart.
export const maxDuration = 800;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error(
      "CRON_SECRET is not configured; refusing to run",
      new Error("CRON_SECRET missing"),
      {
        source: "autoheal-llm-transport-failures",
        route: "/api/cron/autoheal-llm-transport-failures",
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
    const summary = await runAutohealLlmTransportFailuresSweep();

    // Surface systemic failure: if we detected bursts but every restart failed
    // (SSH/key churn, host down), a 200 would look healthy. Emit a warn.
    if (summary.restartFailed > 0 || summary.probeErrors > 0) {
      await reportOpsEvent({
        source: "cron.autoheal_llm_transport_failures_degraded",
        severity: "warn",
        title: `autoheal-llm: ${summary.restartFailed} restart failure(s), ${summary.probeErrors} probe error(s)`,
        message:
          `autoheal-llm-transport-failures scanned ${summary.scanned} active box(es); ` +
          `burstsDetected=${summary.burstsDetected} restartAttempted=${summary.restartAttempted} ` +
          `restartFailed=${summary.restartFailed} cooldownSkipped=${summary.cooldownSkipped} ` +
          `exhausted=${summary.exhausted} probeErrors=${summary.probeErrors}. Restarts may not be ` +
          `landing — check SSH host health.`,
        route: "/api/cron/autoheal-llm-transport-failures",
        metadata: { ...summary },
      });
    }

    await recordCronHeartbeat("autoheal-llm-transport-failures");

    return apiSuccess(summary);
  } catch (err) {
    log.error("autoheal-llm sweep failed", err, {
      source: "autoheal-llm-transport-failures",
      route: "/api/cron/autoheal-llm-transport-failures",
      method: "GET",
      failureType: "autoheal_llm_sweep_failed",
    });
    const message = err instanceof Error ? err.message : "Autoheal sweep failed";
    return apiError(message, 500);
  }
}
