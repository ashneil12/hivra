import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { apiSuccess, apiError } from "@/lib/api-response";
import { supabaseAdmin } from "@/lib/supabase";
import { log } from "@/lib/logger";
import { enforceRateLimit, getIP } from "@/lib/rate-limit";
import { planFromAppleProductId } from "@/lib/billing/apple-products";
import { AppleWebhookService } from "@/lib/services/apple-webhook-service";

const LOG_SOURCE = "mobile-iap-attach";

/**
 * POST /api/mobile/iap/attach
 *
 * Client-driven fallback binding: after a purchase or Restore Purchases the
 * app POSTs its signed transaction (StoreKit 2 JWS) and the server verifies
 * it and binds originalTransactionId → the authenticated Clerk user. Covers
 * purchases where the appAccountToken was missing (pre-login purchase,
 * family sharing) — the webhook's appAccountToken path is primary.
 *
 * The binding runs through the SAME activation primitive the webhook uses,
 * so credits/tier/resume side effects are identical and idempotent — the app
 * may safely call this belt-and-braces after every purchase.
 *
 * Security posture:
 *  - the JWS is verified against Apple's roots before ANYTHING is read from
 *    it (a forged transaction never reaches the DB);
 *  - a transaction already bound to a DIFFERENT user is refused with 409 —
 *    attach can never steal another account's subscription;
 *  - an expired transaction is refused — attach can only grant access Apple
 *    currently vouches for (the reconciler owns lapsed state).
 */
export async function POST(req: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    if (!supabaseAdmin) return apiError("Database not configured", 500);

    const ip = getIP(req);
    const { success } = enforceRateLimit(`mobile_iap_attach_${ip}`, {
      limit: 10,
      windowMs: 60 * 1000,
    });
    if (!success) {
      return apiError("Too Many Requests", 429);
    }

    let signedTransaction: string | null = null;
    try {
      const body = (await req.json()) as { signedTransaction?: unknown };
      signedTransaction =
        typeof body?.signedTransaction === "string" && body.signedTransaction.trim()
          ? body.signedTransaction
          : null;
    } catch {
      signedTransaction = null;
    }
    if (!signedTransaction) {
      return apiError("Missing signedTransaction", 400);
    }

    let verified;
    try {
      verified = await AppleWebhookService.verifyTransaction(signedTransaction);
    } catch (err) {
      return apiError("Invalid transaction signature", 401, {
        failureType: "mobile_iap_attach_invalid_signature",
        errorName: err instanceof Error ? err.name : typeof err,
        userId,
      });
    }

    const { transaction, environment } = verified;
    const originalTransactionId = transaction.originalTransactionId;
    if (!originalTransactionId) {
      return apiError("Transaction is missing originalTransactionId", 400);
    }

    if (!planFromAppleProductId(transaction.productId)) {
      return apiError("Unknown product", 422, {
        failureType: "mobile_iap_attach_unknown_product",
        userId,
      });
    }

    const expiresMs = transaction.expiresDate;
    if (typeof expiresMs !== "number" || expiresMs <= Date.now()) {
      return apiError("Subscription is not active", 400, {
        failureType: "mobile_iap_attach_expired_transaction",
        userId,
      });
    }

    // Never rebind a subscription that belongs to another account.
    const { data: existing } = await supabaseAdmin
      .from("apple_iap_subscriptions")
      .select("user_id")
      .eq("apple_original_transaction_id", originalTransactionId)
      .maybeSingle<{ user_id: string }>();
    if (existing && existing.user_id !== userId) {
      log.warn("attach refused: transaction already bound to another user", {
        source: LOG_SOURCE,
        failureType: "mobile_iap_attach_conflict",
        userId,
        boundUserId: existing.user_id,
      });
      return apiError("This subscription is linked to a different account", 409);
    }

    const outcome = await AppleWebhookService.activateFromTransaction({
      userId,
      transaction,
      renewalInfo: null,
      environment,
      notificationType: "ATTACH",
    });

    return apiSuccess({
      attached: true,
      action: outcome.action,
    });
  } catch (error) {
    return apiError("Failed to attach transaction", 500, {
      failureType: "mobile_iap_attach_failed",
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}
