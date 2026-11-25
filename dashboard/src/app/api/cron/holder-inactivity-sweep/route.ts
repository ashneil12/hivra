import { NextRequest } from "next/server";

import { apiError } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { log } from "@/lib/logger";

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

  // Classic Hermes has no nap or memory-preserving save/resume lifecycle.
  // A shutdown would discard the running guest's memory.
  return apiError("Automatic holder sleep is unavailable for Classic Hermes.", 501);
}
