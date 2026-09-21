import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { recordCronHeartbeat } from "@/lib/cron-heartbeat";
import { runInstanceHealthSweep } from "@/lib/recovery/instance-health-sweep";
import { log } from "@/lib/logger";

/**
 * Cron-triggered synthetic health probe across the running instance
 * fleet. Calls runInstanceHealthSweep() which pings every running
 * instance's gateway and logs failures to ops_events.
 *
 * Schedule: every 5 minutes via vercel.json. Each probe is bounded at
 * ~6s; a fleet of N runs in parallel so total wall time is roughly
 * one probe-timeout regardless of fleet size.
 *
 * Auth: bearer token verified against CRON_SECRET, identical to the
 * other /api/cron/* endpoints. The endpoint is unauthenticated for
 * Clerk specifically because Vercel Cron sends bearer-only requests,
 * but a missing/bad secret returns 401 before any work happens.
 */
export const dynamic = "force-dynamic";
// Each probe is bounded ~6s and the fleet runs in parallel, but a large/slow
// fleet could brush the default 60s function timeout (a truncated sweep would
// still stamp a green heartbeat below). Lift to the cron ceiling for headroom.
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error(
      "CRON_SECRET is not configured; refusing to run",
      new Error("CRON_SECRET missing"),
      {
        source: "probe-instance-health",
        route: "/api/cron/probe-instance-health",
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
    const summary = await runInstanceHealthSweep();
    // Dead-man heartbeat: stamp success so the watchdog (in migration-drift-check)
    // can page if this prober ever goes silent. Best-effort — recordCronHeartbeat
    // swallows its own errors and never throws.
    await recordCronHeartbeat("probe-instance-health");
    return apiSuccess(summary);
  } catch (err) {
    log.error("instance health sweep failed", err, {
      source: "probe-instance-health",
      route: "/api/cron/probe-instance-health",
      method: "GET",
      failureType: "instance_health_sweep_failed",
    });
    const message = err instanceof Error ? err.message : "Health sweep failed";
    return apiError(message, 500);
  }
}
