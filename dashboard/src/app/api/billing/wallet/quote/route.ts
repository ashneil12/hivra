/**
 * GET  /api/billing/wallet/quote                     → all active quotes
 * GET  /api/billing/wallet/quote?tier=pro            → just that tier
 * POST /api/billing/wallet/quote   body: { tier }    → mint a fresh quote
 *
 * Quotes lock in a USD-denominated tier price (e.g. $100 Pro launch)
 * to a precise token quantity using the live $HERMESOS/USD price.
 * Each quote lives for 20 minutes; if tokens haven't arrived by then
 * the user gets a fresh quote at the new price.
 */

import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import {
  BILLING_V2_UNAVAILABLE_MESSAGE,
  isBillingV2ServerEnabled,
} from "@/lib/billing/billing-v2-availability";
import {
  createDepositQuote,
  getActiveDepositQuotes,
  type DepositQuote,
} from "@/lib/billing/deposit-quotes";
import {
  ActiveCryptoPaymentSessionError,
  activeCryptoPaymentSessionResponse,
} from "@/lib/billing/crypto-payment-sessions";
import { getTokenVerificationWallet } from "@/lib/billing/token-holdings";
import { TokenNotAllowedError } from "@/lib/billing/token-access";
import { isPlatformTokenKey } from "@/lib/billing/token-registry";
import type { TierKey } from "@/lib/billing/tier-thresholds";

function isValidTier(value: unknown): value is TierKey {
  return value === "pro" || value === "power";
}

function serializeQuote(quote: DepositQuote) {
  return {
    id: quote.id,
    tier: quote.tier,
    thresholdTierCode: quote.thresholdTierCode,
    epoch: quote.epoch,
    usdTargetCents: quote.usdTargetCents,
    priceUsdAtQuote: quote.priceUsdAtQuote,
    tokensRequiredRaw: quote.tokensRequiredRaw.toString(),
    tokensRequiredDisplay: quote.tokensRequiredDisplay,
    tokenKey: quote.tokenKey,
    tokenAddress: quote.tokenAddress,
    tokenSymbol: quote.tokenSymbol,
    tokenDecimals: quote.tokenDecimals,
    quotedAt: quote.quotedAt,
    expiresAt: quote.expiresAt,
    status: quote.status,
    source: quote.source,
  };
}

async function hasVerifiedTokenWallet(userId: string) {
  return Boolean(await getTokenVerificationWallet(userId));
}

function verifiedTokenWalletRequiredError() {
  return apiError(
    "Connect and verify a wallet before locking a Hivra price.",
    403,
    { failureType: "deposit_quote_verified_wallet_required" }
  );
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
    const tier = tierParam && isValidTier(tierParam) ? tierParam : undefined;

    if (!(await hasVerifiedTokenWallet(userId))) {
      return verifiedTokenWalletRequiredError();
    }

    const quotes = await getActiveDepositQuotes({ userId, tier });

    return apiSuccess({
      quotes: quotes.map(serializeQuote),
      pro: quotes.find((q) => q.tier === "pro") ? serializeQuote(quotes.find((q) => q.tier === "pro")!) : null,
      power: quotes.find((q) => q.tier === "power") ? serializeQuote(quotes.find((q) => q.tier === "power")!) : null,
    });
  } catch (error) {
    return apiError("Failed to load deposit quotes.", 500, {
      failureType: "deposit_quote_load_failed",
      errorName: error instanceof Error ? error.name : typeof error,
    }, undefined, {
      source: "billing/wallet-quote",
      route: "/api/billing/wallet/quote",
      method: "GET",
      userId: userIdForLog,
      failureType: "deposit_quote_load_failed",
      cause: error,
    });
  }
}

interface PostBody {
  tier?: unknown;
  /** Optional platform token ("hermesos" | "hivra"); defaults per account. */
  token?: unknown;
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
        failureType: "deposit_quote_bad_tier",
      });
    }

    if (body.token !== undefined && !isPlatformTokenKey(body.token)) {
      return apiError("Invalid token — must be 'hermesos' or 'hivra'.", 400, {
        failureType: "deposit_quote_bad_token",
      });
    }

    if (!(await hasVerifiedTokenWallet(userId))) {
      return verifiedTokenWalletRequiredError();
    }

    const quote = await createDepositQuote({
      userId,
      tier: body.tier,
      ...(body.token !== undefined ? { token: body.token } : {}),
    });

    return apiSuccess(serializeQuote(quote));
  } catch (error) {
    if (error instanceof TokenNotAllowedError) {
      return apiError(error.message, 403, {
        failureType: "token_not_allowed",
        token: error.tokenKey,
        allowedTokens: error.allowedTokens,
      });
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
          source: "billing/wallet-quote",
          route: "/api/billing/wallet/quote",
          method: "POST",
          userId: userIdForLog,
          failureType: "crypto_payment_session_active",
          logLevel: "warn",
        }
      );
    }

    return apiError("Failed to mint deposit quote.", 500, {
      failureType: "deposit_quote_mint_failed",
      errorName: error instanceof Error ? error.name : typeof error,
    }, undefined, {
      source: "billing/wallet-quote",
      route: "/api/billing/wallet/quote",
      method: "POST",
      userId: userIdForLog,
      failureType: "deposit_quote_mint_failed",
      cause: error,
    });
  }
}
