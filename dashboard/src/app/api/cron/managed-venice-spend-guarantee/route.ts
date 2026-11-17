import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { log } from "@/lib/logger";
import { runSpendGuarantee } from "@/lib/billing/managed-venice-spend-guarantee";

/**
 * Daily: credits back any Hivra AI spend above an agent's daily limit for the
 * UTC day just ended. See src/lib/billing/managed-venice-spend-guarantee.ts.
 * Does nothing unless MANAGED_VENICE_SPEND_GUARANTEE is `dry` or `on`.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return apiError("Cron secret is not configured", 500);
  if (!verifyBearerHeader(req, cronSecret)) return apiError("Unauthorized", 401);
  try {
    const summary = await runSpendGuarantee();
    if (summary.errors && summary.reason) return apiError("Spend guarantee could not run", 500);
    return apiSuccess(summary);
  } catch (error) {
    log.error("spend guarantee failed", error instanceof Error ? error : new Error(String(error)), {
      source: "managed-venice-spend-guarantee", route: "/api/cron/managed-venice-spend-guarantee", method: "GET",
      failureType: "spend_guarantee_failed",
    });
    return apiError("Spend guarantee failed", 500);
  }
}
