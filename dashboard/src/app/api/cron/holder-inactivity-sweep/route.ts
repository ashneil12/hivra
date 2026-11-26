import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { log } from "@/lib/logger";

import { classicHolderBridgeEnabled, readManagedLaunchBridgeEpoch } from "@/lib/hivra/managed-launch-bridge";
import { runClassicHolderSweep } from "@/lib/recovery/classic-holder-idle";
import { recordCronHeartbeat } from "@/lib/cron-heartbeat";

export const maxDuration = 400;
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error(
      "CRON_SECRET is not configured; refusing to run",
      new Error("CRON_SECRET missing"),
      {
        source: "holder-inactivity-sweep",
        route: "/api/cron/holder-inactivity-sweep",
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
    if (!classicHolderBridgeEnabled()) return apiSuccess({ outcomes: {} });
    const epoch = await readManagedLaunchBridgeEpoch();
    if (epoch !== "placement") return apiSuccess({ outcomes: {} });
    const outcomes = await runClassicHolderSweep();
    await recordCronHeartbeat("holder-inactivity-sweep");
    return apiSuccess({ outcomes });
  } catch (err) {
    log.error("Classic holder sweep failed", err, { source: "holder-inactivity-sweep" });
    return apiError("Classic holder sweep could not complete", 500);
  }
}
