/**
 * GET  /api/billing/yearly-token-quote                   → all active yearly quotes for user
 * GET  /api/billing/yearly-token-quote?tier=pro          → that tier only
 * POST /api/billing/yearly-token-quote   body: { tier }  → mint a fresh yearly quote
 *
 * Yearly token-payment flow: user clicks "Pay yearly with $HermesOS" on
 * /dashboard/billing, this endpoint mints a 20-min lock at live USD ÷
 * live $HERMESOS price ($49 Pro, $99 Power), and the deposit address
 * (the user's credit_deposit Bankr wallet) is shown. The cron binds the
 * on-chain transfer that paid the quote, activates a 365-day yearly
 * subscription (or extends a live one by a year), and sweeps that
 * transfer's tokens to HERMES_TREASURY_ADDRESS.
 */

import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import {
  BILLING_V2_UNAVAILABLE_MESSAGE,
  isBillingV2ServerEnabled,
} from "@/lib/billing/billing-v2-availability";
import {
  createYearlyTokenQuote,
  getActiveYearlyTokenQuote,
  getActiveYearlyTokenQuotes,
  type YearlyTokenQuote,
} from "@/lib/billing/yearly-token-quotes";
import {
  ActiveCryptoPaymentSessionError,
  activeCryptoPaymentSessionResponse,
} from "@/lib/billing/crypto-payment-sessions";
import {
  ensureBankrDepositWalletForUser,
  getBankrDepositWalletCredentialForUser,
} from "@/lib/billing/bankr-deposit-wallets";
import type { TierKey } from "@/lib/billing/tier-thresholds";
import { LivePriceUnavailableError } from "@/lib/billing/live-thresholds";
import { supabaseAdmin } from "@/lib/supabase";

function isValidTier(value: unknown): value is TierKey {
  return value === "pro" || value === "power";
}

function serializeQuote(quote: YearlyTokenQuote) {
  return {
    id: quote.id,
    tier: quote.tier,
    usdTargetCents: quote.usdTargetCents,
    priceUsdAtQuote: quote.priceUsdAtQuote,
    tokensRequiredRaw: quote.tokensRequiredRaw.toString(),
    tokensRequiredDisplay: quote.tokensRequiredDisplay,
    tokenSymbol: quote.tokenSymbol,
    tokenDecimals: quote.tokenDecimals,
    depositAddress: quote.depositAddress,
    quotedAt: quote.quotedAt,
    expiresAt: quote.expiresAt,
    status: quote.status,
    source: quote.source,
  };
}

interface RecentSubRow {
  id: string;
  tier: TierKey;
  yearly_quote_id: string | null;
  paid_at: string;
  expires_at: string;
  status: "active" | "grace" | "expired" | "cancelled" | "renewed";
  sweep_status: "pending" | "sweeping" | "swept" | "failed" | "skipped" | "needs_operator";
  sweep_tx_hash: string | null;
  amount_received_raw: string;
}

/**
 * Returns the user's most-recent yearly_token_subscriptions row per
 * tier, or null. Used by the dashboard banner to render the post-pay
 * progress stepper (activated → swept) without needing to wait for
 * the next page reload.
 */
async function loadRecentSubscriptions(
  userId: string,
): Promise<{ pro: RecentSubRow | null; power: RecentSubRow | null }> {
  if (!supabaseAdmin) return { pro: null, power: null };
  const { data, error } = await supabaseAdmin
    .from("yearly_token_subscriptions")
    .select(
      "id, tier, yearly_quote_id, paid_at, expires_at, status, sweep_status, sweep_tx_hash, amount_received_raw::text",
    )
    .eq("user_id", userId)
    .order("paid_at", { ascending: false })
    .limit(10);
  if (error || !Array.isArray(data)) return { pro: null, power: null };
  const rows = data as RecentSubRow[];
  return {
    pro: rows.find((r) => r.tier === "pro") ?? null,
    power: rows.find((r) => r.tier === "power") ?? null,
  };
}

function serializeSub(row: RecentSubRow | null) {
  if (!row) return null;
  return {
    id: row.id,
    tier: row.tier,
    yearlyQuoteId: row.yearly_quote_id ?? null,
    paidAt: row.paid_at,
    expiresAt: row.expires_at,
    status: row.status,
    sweepStatus: row.sweep_status,
    sweepTxHash: row.sweep_tx_hash,
    amountReceivedRaw: row.amount_received_raw,
  };
}

export async function GET(req: NextRequest) {
  let userIdForLog: string | null = null;
  try {
    if (!isBillingV2ServerEnabled()) {
      return apiError(BILLING_V2_UNAVAILABLE_MESSAGE, 404);
    }
    const { userId } = await auth();
    userIdForLog = userId ?? null;
    if (!userId) return apiError("Unauthorized", 401);

    const url = new URL(req.url);
    const tierParam = url.searchParams.get("tier");
    const tier = tierParam && isValidTier(tierParam) ? tierParam : null;

    if (tier) {
      const [quote, subs] = await Promise.all([
        getActiveYearlyTokenQuote({ userId, tier }),
        loadRecentSubscriptions(userId),
      ]);
      return apiSuccess({
        quote: quote ? serializeQuote(quote) : null,
        subscription: serializeSub(tier === "pro" ? subs.pro : subs.power),
        tier,
      });
    }

    const [quotes, subs] = await Promise.all([
      getActiveYearlyTokenQuotes(userId),
      loadRecentSubscriptions(userId),
    ]);
    const proQuote = quotes.find((q) => q.tier === "pro") ?? null;
    const powerQuote = quotes.find((q) => q.tier === "power") ?? null;
    return apiSuccess({
      quotes: quotes.map(serializeQuote),
      pro: proQuote ? serializeQuote(proQuote) : null,
      power: powerQuote ? serializeQuote(powerQuote) : null,
      // Recent subscription state per tier — drives the multi-stage
      // progress stepper on the dashboard banner (paid → activated →
      // swept) without a reload.
      proSubscription: serializeSub(subs.pro),
      powerSubscription: serializeSub(subs.power),
    });
  } catch (error) {
    return apiError("Failed to load yearly token quotes.", 500, {
      failureType: "yearly_token_quote_load_failed",
      errorName: error instanceof Error ? error.name : typeof error,
    }, undefined, {
      source: "billing/yearly-token-quote",
      route: "/api/billing/yearly-token-quote",
      method: "GET",
      userId: userIdForLog,
      failureType: "yearly_token_quote_load_failed",
      cause: error,
    });
  }
}

interface PostBody {
  tier?: unknown;
}

export async function POST(req: NextRequest) {
  let userIdForLog: string | null = null;
  try {
    if (!isBillingV2ServerEnabled()) {
      return apiError(BILLING_V2_UNAVAILABLE_MESSAGE, 404);
    }
    const { userId } = await auth();
    userIdForLog = userId ?? null;
    if (!userId) return apiError("Unauthorized", 401);

    let body: PostBody = {};
    try {
      body = (await req.json()) as PostBody;
    } catch {
      return apiError("Invalid JSON body.", 400);
    }

    if (!isValidTier(body.tier)) {
      return apiError("Missing or invalid tier — must be 'pro' or 'power'.", 400, {
        failureType: "yearly_token_quote_bad_tier",
      });
    }

    // Resolve (or lazy-provision) the shared credit_deposit wallet. Every
    // Bankr crypto payment uses this same address, while the session lock in
    // createYearlyTokenQuote prevents overlapping purposes from reading the
    // same inbound transfer ambiguously.
    let credential = await getBankrDepositWalletCredentialForUser({
      userId,
      purpose: "credit_deposit",
    });
    if (!credential) {
      const provisioned = await ensureBankrDepositWalletForUser({
        userId,
        purpose: "credit_deposit",
        makePrimary: true,
      });
      if (provisioned.status === "not_configured") {
        return apiError("Bankr wallet provisioning is not configured.", 503, {
          failureType: "yearly_token_quote_bankr_not_configured",
        });
      }
      credential = provisioned.credential;
    }
    if (!credential) {
      return apiError("Wallet provisioning returned no credential.", 500, {
        failureType: "yearly_token_quote_credential_missing",
      });
    }
    const depositAddress = credential.normalizedEvmAddress || credential.evmAddress;
    if (!depositAddress) {
      return apiError("Wallet credential missing deposit address.", 500, {
        failureType: "yearly_token_quote_wallet_missing_address",
      });
    }

    let quote: YearlyTokenQuote;
    try {
      quote = await createYearlyTokenQuote({
        userId,
        tier: body.tier,
        depositAddress,
      });
    } catch (error) {
      if (error instanceof LivePriceUnavailableError) {
        return apiError(
          "Token price unavailable — please try again later.",
          503,
          { failureType: "yearly_token_quote_price_unavailable" }
        );
      }
      if (error instanceof ActiveCryptoPaymentSessionError) {
        return apiError(
          "Another crypto payment is already active. Finish it or wait for it to expire before starting a new one.",
          409,
          {
            failureType: "crypto_payment_session_active",
            activePaymentKind: error.session.kind,
            activePaymentReferenceId: error.session.referenceId,
          },
          activeCryptoPaymentSessionResponse(error.session),
          {
            source: "billing/yearly-token-quote",
            route: "/api/billing/yearly-token-quote",
            method: "POST",
            userId: userIdForLog,
            failureType: "crypto_payment_session_active",
            logLevel: "warn",
          }
        );
      }
      throw error;
    }

    return apiSuccess(serializeQuote(quote));
  } catch (error) {
    return apiError("Failed to mint yearly token quote.", 500, {
      failureType: "yearly_token_quote_mint_failed",
      errorName: error instanceof Error ? error.name : typeof error,
    }, undefined, {
      source: "billing/yearly-token-quote",
      route: "/api/billing/yearly-token-quote",
      method: "POST",
      userId: userIdForLog,
      failureType: "yearly_token_quote_mint_failed",
      cause: error,
    });
  }
}
