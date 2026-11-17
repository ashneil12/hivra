import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { log } from "@/lib/logger";
import { runMemoryFloorSweep } from "@/lib/hivra/capacity/memory-floor-apply";

/**
 * Cron-triggered memory floors. Once a day, sets each awake agent's memory
 * floor (the VM's balloon minimum) from its measured use, so a host that runs
 * short may take back memory nobody is using. See
 * src/lib/hivra/capacity/memory-floor-apply.ts.
 *
 * Does nothing unless HIVRA_AGENT_MEMORY_FLOORS is `dry`, `on` or `restore`.
 *
 * Schedule: daily via vercel.json.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error("CRON_SECRET is not configured; refusing to run", new Error("CRON_SECRET missing"), {
      source: "hivra-memory-floors",
      route: "/api/cron/hivra-memory-floors",
      method: "GET",
      failureType: "cron_secret_missing",
    });
    return apiError("Cron secret is not configured", 500);
  }
  if (!verifyBearerHeader(req, cronSecret)) {
    return apiError("Unauthorized", 401);
  }

  try {
    const summary = await runMemoryFloorSweep();
    if (summary.failed) return apiError("Memory floors could not run", 500);
    return apiSuccess(summary);
  } catch (error) {
    log.error("hivra-memory-floors sweep failed", error instanceof Error ? error : new Error(String(error)), {
      source: "hivra-memory-floors",
      route: "/api/cron/hivra-memory-floors",
      method: "GET",
      failureType: "hivra_memory_floors_failed",
    });
    return apiError("Memory floors failed", 500);
  }
}
