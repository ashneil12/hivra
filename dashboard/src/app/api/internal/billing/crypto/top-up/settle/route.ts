import { NextRequest } from "next/server";
import { z } from "zod";
import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { reconcileCryptoTopUpByReference } from "@/lib/billing/crypto-reconciliation";
import { log } from "@/lib/logger";

const CryptoSettlementRequestSchema = z.object({
  referenceId: z.string().trim().min(1),
  // Optional expectation only. The credited transfer is always found and
  // verified on chain and claimed in crypto_deposit_receipts, never taken
  // from the caller; a mismatch is refused.
  transactionHash: z.string().trim().min(1).optional(),
  // Accepted for compatibility; the block timestamp is used instead.
  detectedAt: z.string().trim().min(1).optional(),
});

function getSettlementSecret() {
  // CRON_SECRET is intentionally NOT a fallback here. This route credits user
  // balances and advances the crypto top-up state machine — its bearer must
  // be scoped to the bankr reconciler, not every Vercel cron and operator
  // debug script that happens to know CRON_SECRET.
  return process.env.BILLING_SETTLEMENT_SECRET?.trim() || null;
}

export async function POST(req: NextRequest) {
  const settlementSecret = getSettlementSecret();
  if (!settlementSecret) {
    log.error("settlement secret is not configured; refusing to run", new Error("missing settlement secret"), {
      source: "crypto-topup-settle",
      route: "/api/internal/billing/crypto/top-up/settle",
      method: "POST",
      failureType: "crypto_topup_settlement_secret_missing",
    });
    return apiError("Settlement secret is not configured", 500);
  }

  if (!verifyBearerHeader(req, settlementSecret)) {
    return apiError("Unauthorized", 401);
  }

  try {
    let body: unknown;
    try {
      body = await req.json();
    } catch (error) {
      return apiError("Invalid JSON body", 400, {
        failureType: "crypto_topup_settlement_invalid_json",
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }

    const parsed = CryptoSettlementRequestSchema.safeParse(body);
    if (!parsed.success) {
      return apiError("Invalid crypto settlement request", 400);
    }

    const result = await reconcileCryptoTopUpByReference({ referenceId: parsed.data.referenceId });

    if (result.status === "not_found") {
      return apiError("Crypto top-up intent not found", 404);
    }

    if (result.status === "settled") {
      const expected = parsed.data.transactionHash?.toLowerCase();
      if (expected && expected !== result.transactionHash.toLowerCase()) {
        return apiError("Crypto top-up intent was settled by a different transaction", 409, undefined, {
          status: "transaction_mismatch",
          transactionHash: result.transactionHash,
        });
      }
      return apiSuccess(result);
    }

    if (result.status === "closed") {
      return apiError("Crypto top-up intent is not settleable", 409, undefined, {
        paymentStatus: result.paymentStatus,
      });
    }

    // No verified, attributable, confirmed payment yet, or it went to review.
    return apiError("Crypto top-up intent has no settleable on-chain payment", 409, undefined, {
      status: result.status === "settlement_skipped" ? result.settlementStatus : result.status,
    });
  } catch (error) {
    return apiError("Failed to settle crypto top-up", 500, {
      failureType: "crypto_topup_settlement_failed",
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}
