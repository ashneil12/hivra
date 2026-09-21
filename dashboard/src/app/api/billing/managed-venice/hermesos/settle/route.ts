import { NextRequest } from "next/server";
import { z } from "zod";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { settleManagedVeniceTokenQuote } from "@/lib/billing/managed-venice-token-quotes";
import { log } from "@/lib/logger";

const SettlementRequestSchema = z.object({
  quoteId: z.string().trim().min(1),
  transactionHash: z.string().trim().min(1),
  tokenAmountRaw: z.string().regex(/^[1-9]\d*$/),
  observedAt: z.string().trim().min(1),
  blockTimestamp: z.string().trim().min(1).optional(),
});

function getSettlementSecret() {
  // CRON_SECRET is intentionally NOT a fallback here. This route mints wallet
  // credit by settling managed Venice token quotes — its bearer must be scoped
  // to the bankr reconciler, not every Vercel cron and operator debug script
  // that happens to know CRON_SECRET. Mirrors the crypto top-up settle route.
  return (
    process.env.MANAGED_VENICE_SETTLEMENT_SECRET?.trim() ||
    process.env.BILLING_SETTLEMENT_SECRET?.trim() ||
    null
  );
}

export async function POST(req: NextRequest) {
  const settlementSecret = getSettlementSecret();
  if (!settlementSecret) {
    log.error(
      "managed Venice settlement secret is not configured; refusing to run",
      new Error("missing settlement secret"),
      {
        source: "managed-venice-token-settle",
        route: "/api/billing/managed-venice/hermesos/settle",
        method: "POST",
        failureType: "managed_venice_settlement_secret_missing",
      }
    );
    return apiError("Settlement secret is not configured.", 500);
  }

  if (!verifyBearerHeader(req, settlementSecret)) {
    return apiError("Unauthorized", 401);
  }

  try {
    let body: unknown;
    try {
      body = await req.json();
    } catch (error) {
      return apiError("Invalid JSON body.", 400, {
        failureType: "managed_venice_settlement_invalid_json",
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }

    const parsed = SettlementRequestSchema.safeParse(body);
    if (!parsed.success) {
      return apiError("Invalid managed Venice settlement request.", 400, {
        failureType: "managed_venice_settlement_invalid_request",
      });
    }

    const result = await settleManagedVeniceTokenQuote({
      quoteId: parsed.data.quoteId,
      transactionHash: parsed.data.transactionHash,
      tokenAmountRaw: parsed.data.tokenAmountRaw,
      observedAt: parsed.data.observedAt,
      blockTimestamp: parsed.data.blockTimestamp || null,
    });

    return apiSuccess(result);
  } catch (error) {
    return apiError(
      "Failed to settle managed Venice token quote.",
      500,
      {
        failureType: "managed_venice_settlement_failed",
        errorName: error instanceof Error ? error.name : typeof error,
      },
      undefined,
      {
        source: "managed-venice-token-settle",
        route: "/api/billing/managed-venice/hermesos/settle",
        method: "POST",
        failureType: "managed_venice_settlement_failed",
        cause: error,
      }
    );
  }
}
