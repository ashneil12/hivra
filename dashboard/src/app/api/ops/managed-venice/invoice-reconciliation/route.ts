import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { log } from "@/lib/logger";
import {
  getManagedVeniceUsageSummary,
  parseSummaryRange,
} from "@/lib/venice/invoice-reconciliation";
import { settleManagedVeniceMultimodalUsage } from "@/lib/venice/proxy-settlement";

const ROUTE = "/api/ops/managed-venice/invoice-reconciliation";
const SOURCE = "ops/managed-venice/invoice-reconciliation";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error(
      "CRON_SECRET is not configured; refusing to run",
      new Error("CRON_SECRET missing"),
      {
        source: SOURCE,
        route: ROUTE,
        method: "GET",
        failureType: "cron_secret_missing",
      }
    );
    return apiError("Cron secret is not configured", 500);
  }
  if (!verifyBearerHeader(req, cronSecret)) {
    return apiError("Unauthorized", 401);
  }

  const url = new URL(req.url);
  let range: { from: Date; to: Date };
  try {
    range = parseSummaryRange({
      from: url.searchParams.get("from"),
      to: url.searchParams.get("to"),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid range";
    return apiError(message, 400);
  }

  try {
    const summary = await getManagedVeniceUsageSummary(range);
    // F176/F183: surface the multi-modal settlement leg. This is a DRY RUN by
    // default — settleManagedVeniceMultimodalUsage never charges unless
    // MANAGED_VENICE_MULTIMODAL_BILLING_ENABLED=true. With the flag on it
    // prices pending rows against lib/venice/multimodal-pricing.ts and debits
    // wallets; with it off (the default) it only reports what it WOULD settle,
    // so hitting this route cannot surprise-bill.
    let multimodalSettlement: Awaited<
      ReturnType<typeof settleManagedVeniceMultimodalUsage>
    > | { error: string };
    try {
      multimodalSettlement = await settleManagedVeniceMultimodalUsage({
        sinceIso: range.from.toISOString(),
        untilIso: range.to.toISOString(),
      });
    } catch (settleErr) {
      multimodalSettlement = {
        error: settleErr instanceof Error ? settleErr.message : String(settleErr),
      };
      log.warn("managed Venice multi-modal settlement scaffold failed", {
        source: SOURCE,
        route: ROUTE,
        failureType: "managed_venice_multimodal_settlement_failed",
        error: multimodalSettlement.error,
      });
    }
    return apiSuccess({ ...summary, multimodalSettlement });
  } catch (err) {
    log.error("managed Venice invoice reconciliation summary failed", err, {
      source: SOURCE,
      route: ROUTE,
      method: "GET",
      failureType: "managed_venice_invoice_reconciliation_failed",
    });
    const message = err instanceof Error ? err.message : "Summary failed";
    return apiError(message, 500);
  }
}
