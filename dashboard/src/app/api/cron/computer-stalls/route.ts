import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { recordCronHeartbeat } from "@/lib/cron-heartbeat";
import { log } from "@/lib/logger";
import { COMPUTER_STALL_CRON, COMPUTER_STALL_ROUTE, runComputerStallScan } from "@/lib/recovery/computer-stalls";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return apiError("Cron secret is not configured", 500);
  if (!verifyBearerHeader(req, secret)) return apiError("Unauthorized", 401);

  try {
    const summary = await runComputerStallScan();
    await recordCronHeartbeat(COMPUTER_STALL_CRON, summary.failed
      ? { ok: false, detail: `failed=${summary.failed}` }
      : undefined);
    return summary.failed ? apiError("Computer stall reconciliation incomplete", 500) : apiSuccess(summary);
  } catch (error) {
    log.error("Computer stall scan failed", error, {
      source: COMPUTER_STALL_CRON,
      route: COMPUTER_STALL_ROUTE,
      method: "GET",
      failureType: "computer_stall_scan_failed",
    });
    await recordCronHeartbeat(COMPUTER_STALL_CRON, { ok: false, detail: "scan threw" });
    return apiError("Computer stall scan failed", 500);
  }
}
