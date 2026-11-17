import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { log } from "@/lib/logger";
import { grantDuePlanAllowances } from "@/lib/billing/plan-ai-allowance";

export const dynamic = "force-dynamic";

const ROUTE = "/api/cron/plan-ai-allowance";

/**
 * Pays each active ladder plan's monthly AI allowance into the owner's
 * managed AI balance, and expires unspent allowance older than one month.
 * Idempotent per owner per month. Only rows bought on the plan ladder earn
 * anything, so this does nothing until the ladder has sold a plan.
 */
export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error("CRON_SECRET is not configured; refusing plan allowance run", new Error("CRON_SECRET missing"), {
      source: "plan-ai-allowance",
      route: ROUTE,
    });
    return apiError("Cron secret is not configured", 500);
  }
  if (!verifyBearerHeader(req, cronSecret)) return apiError("Unauthorized", 401);

  try {
    const summary = await grantDuePlanAllowances();
    if (summary.scanned > 0) log.info("plan allowance run", { source: "plan-ai-allowance", ...summary });
    return apiSuccess(summary);
  } catch (error) {
    log.error("plan allowance run failed", error, { source: "plan-ai-allowance", route: ROUTE });
    return apiError("Plan allowance run failed", 500);
  }
}
