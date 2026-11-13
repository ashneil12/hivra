import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { isLocalBridgeEnabled } from "@/lib/local-bridge/flag";
import { closeStuckRequests, expireStalePending, purgeAllOldResults } from "@/lib/local-bridge/store";
import { log } from "@/lib/logger";

/**
 * Daily cleanup for the local bridge: clears stored command output older than
 * 7 days, expires approval requests nobody answered, and closes requests
 * that were approved but never ran or started running and never finished. Does nothing while the
 * bridge flag is off. Vercel Cron sends `Authorization: Bearer $CRON_SECRET`.
 */
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const SOURCE = "purge-bridge-results";

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error("CRON_SECRET is not configured; refusing to run", new Error("CRON_SECRET missing"), { source: SOURCE, failureType: "cron_secret_missing" });
    return apiError("Cron secret is not configured", 500);
  }
  if (!verifyBearerHeader(req, cronSecret)) return apiError("Unauthorized", 401);
  if (!isLocalBridgeEnabled()) return apiSuccess({ skipped: "local bridge is off" });
  try {
    await expireStalePending();
    await closeStuckRequests();
    await purgeAllOldResults();
    return apiSuccess({ cleaned: true });
  } catch (err) {
    log.error("local bridge cleanup failed", err, { source: SOURCE, failureType: "bridge_cleanup_failed" });
    return apiError("Local bridge cleanup failed", 500);
  }
}
