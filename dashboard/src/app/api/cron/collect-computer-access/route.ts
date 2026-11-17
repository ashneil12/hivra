import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { log } from "@/lib/logger";
import { runAccessLogCollection } from "@/lib/hivra/computer-access-log";

/**
 * Cron-triggered access-log collection. Drains each Proxmox host's record of
 * connections into guest computers and stores hourly counts per computer,
 * so owners can see who connected to theirs. See
 * src/lib/hivra/computer-access-log.ts.
 *
 * Does nothing unless HIVRA_ACCESS_LOG_COLLECTION is `on`.
 *
 * Schedule: every 10 minutes via vercel.json.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error("CRON_SECRET is not configured; refusing to run", new Error("CRON_SECRET missing"), {
      source: "hivra-access-log",
      route: "/api/cron/collect-computer-access",
      method: "GET",
      failureType: "cron_secret_missing",
    });
    return apiError("Cron secret is not configured", 500);
  }
  if (!verifyBearerHeader(req, cronSecret)) {
    return apiError("Unauthorized", 401);
  }

  try {
    const summary = await runAccessLogCollection();
    if (summary.failed) return apiError("Access log collection could not run", 500);
    return apiSuccess(summary);
  } catch (error) {
    log.error("access log collection failed", error instanceof Error ? error : new Error(String(error)), {
      source: "hivra-access-log",
      route: "/api/cron/collect-computer-access",
      method: "GET",
      failureType: "hivra_access_log_failed",
    });
    return apiError("Access log collection failed", 500);
  }
}
