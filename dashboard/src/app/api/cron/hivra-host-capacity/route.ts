import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { log } from "@/lib/logger";
import { runHostCapacitySweep } from "@/lib/hivra/capacity/sweep";

/**
 * Cron-triggered host capacity check. Reads every active host's memory, disk
 * pool and VM counts with one read-only script, stores the reading on the
 * host's row and raises an ops event when a host, or every host, is close to
 * full. See src/lib/hivra/capacity/.
 *
 * Does nothing unless HIVRA_HOST_CAPACITY_ALERTS is `on`.
 *
 * Schedule: every 5 minutes via vercel.json.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error("CRON_SECRET is not configured; refusing to run", new Error("CRON_SECRET missing"), {
      source: "hivra-host-capacity",
      route: "/api/cron/hivra-host-capacity",
      method: "GET",
      failureType: "cron_secret_missing",
    });
    return apiError("Cron secret is not configured", 500);
  }
  if (!verifyBearerHeader(req, cronSecret)) {
    return apiError("Unauthorized", 401);
  }

  try {
    const summary = await runHostCapacitySweep();
    // The sweep could not load its hosts or agents (it has logged why): nothing is being watched.
    if (summary.failed) return apiError("Host capacity check could not run", 500);
    return apiSuccess(summary);
  } catch (error) {
    log.error("hivra-host-capacity sweep failed", error instanceof Error ? error : new Error(String(error)), {
      source: "hivra-host-capacity",
      route: "/api/cron/hivra-host-capacity",
      method: "GET",
      failureType: "hivra_host_capacity_failed",
    });
    return apiError("Host capacity check failed", 500);
  }
}
