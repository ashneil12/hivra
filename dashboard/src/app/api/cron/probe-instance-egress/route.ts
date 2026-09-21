import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { recordCronHeartbeat } from "@/lib/cron-heartbeat";
import { runInstanceEgressSweep } from "@/lib/recovery/instance-egress-sweep";
import { log } from "@/lib/logger";

/**
 * Cron-triggered synthetic egress probe across the running instance fleet.
 * Calls each agent's `/api/health/egress` which performs DNS + TCP probe
 * to known model API targets (api.openai.com, api.anthropic.com) inside
 * the agent's own network namespace, and reports per-target failures to
 * ops_events.
 *
 * Companion to /api/cron/probe-instance-health — that one verifies the
 * gateway answers (so users can connect TO the agent), this one verifies
 * the agent can connect OUT to model APIs (so chat sends actually work).
 * Different failure mode, different signal.
 *
 * Schedule: every 5 minutes via vercel.json. Each per-instance call is
 * bounded at ~8s; fleet runs in parallel.
 */
export const dynamic = "force-dynamic";
// Per-instance probes are bounded ~8s and run in parallel, but a large fleet
// could brush the default 60s function timeout. Lift to the cron ceiling.
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error(
      "CRON_SECRET is not configured; refusing to run",
      new Error("CRON_SECRET missing"),
      {
        source: "probe-instance-egress",
        route: "/api/cron/probe-instance-egress",
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
    const summary = await runInstanceEgressSweep();
    // Dead-man heartbeat: stamp success so a future CRON_REGISTRY entry can let
    // the watchdog page if this prober ever goes silent (companion to
    // probe-instance-health). Registering 'probe-instance-egress' in
    // CRON_REGISTRY lives in cron-heartbeat.ts — out of this route's scope —
    // so until that lands the watchdog won't alert, but the heartbeat row is
    // recorded now so the wiring is ready and never false-pages on first run.
    await recordCronHeartbeat("probe-instance-egress");
    return apiSuccess(summary);
  } catch (err) {
    log.error("instance egress sweep failed", err, {
      source: "probe-instance-egress",
      route: "/api/cron/probe-instance-egress",
      method: "GET",
      failureType: "instance_egress_sweep_failed",
    });
    const message = err instanceof Error ? err.message : "Egress sweep failed";
    return apiError(message, 500);
  }
}
