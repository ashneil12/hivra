import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { log } from "@/lib/logger";
import { expireDuePromoGrants } from "@/lib/venice/promo/service";

export const dynamic = "force-dynamic";

const ROUTE = "/api/cron/venice-promo-expiry";

/**
 * Closes Venice promo grants past their expiry, removing only the unspent promo
 * part from the card wallet. Runs even while the promo flag is off, so money
 * already granted is always cleaned up. Idempotent per grant.
 */
export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error("CRON_SECRET is not configured; refusing venice promo expiry", new Error("CRON_SECRET missing"), {
      source: "venice-promo-expiry",
      route: ROUTE,
    });
    return apiError("Cron secret is not configured", 500);
  }
  if (!verifyBearerHeader(req, cronSecret)) return apiError("Unauthorized", 401);

  try {
    const summary = await expireDuePromoGrants();
    if (summary.due > 0) log.info("venice promo expiry run", { source: "venice-promo-expiry", ...summary });
    return apiSuccess(summary);
  } catch (error) {
    log.error("venice promo expiry failed", error, { source: "venice-promo-expiry", route: ROUTE });
    return apiError("Venice promo expiry failed", 500);
  }
}
