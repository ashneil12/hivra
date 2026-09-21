import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { apiError, apiSuccess } from "@/lib/api-response";
import {
  enforceAuthenticatedRouteRateLimit,
  RATE_LIMIT_PRESETS,
} from "@/lib/authenticated-rate-limit";
import {
  CRYPTO_BILLING_UNAVAILABLE_MESSAGE,
  isCryptoBillingEnabled,
} from "@/lib/billing/crypto-availability";
import { isBillingV2ServerEnabled } from "@/lib/billing/billing-v2-availability";
import { supabaseAdmin } from "@/lib/supabase";
import {
  BASE_CHAIN_ID,
  HERMESOS_BASE_TIER_MIN_RAW,
  HERMESOS_TOKEN_ADDRESS,
  HERMESOS_TOKEN_DECIMALS,
  HERMESOS_TOKEN_SYMBOL,
  formatRawTokenBalance,
  getLatestHermesTokenHoldingSnapshot,
  getTokenVerificationWallet,
  refreshPrimaryHermesTokenHolding,
} from "@/lib/billing/token-holdings";

function tokenConfigPayload() {
  return {
    chainId: BASE_CHAIN_ID,
    tokenAddress: HERMESOS_TOKEN_ADDRESS,
    tokenSymbol: HERMESOS_TOKEN_SYMBOL,
    tokenDecimals: HERMESOS_TOKEN_DECIMALS,
    minimumBalanceRaw: HERMESOS_BASE_TIER_MIN_RAW,
    minimumBalanceDisplay: formatRawTokenBalance(
      HERMESOS_BASE_TIER_MIN_RAW,
      HERMESOS_TOKEN_DECIMALS
    ),
  };
}

// Token/wallet surfaces (this route + /api/billing/wallet/eligibility and
// /api/billing/wallet/refresh) must share one consistent gate. Previously this
// route gated only on crypto billing while the wallet routes gated only on
// billing-v2, so a mis-set flag could make the billing page show holdings the
// wallet page reported as unavailable (and vice versa). Require BOTH flags
// everywhere — strictly no looser than either was before.
function isTokenHoldingSurfaceEnabled(): boolean {
  return isCryptoBillingEnabled() && isBillingV2ServerEnabled();
}

export async function GET() {
  try {
    if (!isTokenHoldingSurfaceEnabled()) {
      return apiError(CRYPTO_BILLING_UNAVAILABLE_MESSAGE, 404);
    }

    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    if (!supabaseAdmin) return apiError("Database not configured", 500);

    const [wallet, snapshot] = await Promise.all([
      getTokenVerificationWallet(userId),
      getLatestHermesTokenHoldingSnapshot(userId),
    ]);

    return apiSuccess({
      token: tokenConfigPayload(),
      wallet,
      snapshot,
      entitlement: {
        verified: Boolean(snapshot),
        qualifiesBaseTier: snapshot?.qualifiesBaseTier ?? false,
      },
    });
  } catch (error) {
    return apiError("Failed to load token holding", 500, {
      failureType: "token_holding_status_failed",
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}

export async function POST(req: NextRequest) {
  try {
    if (!isTokenHoldingSurfaceEnabled()) {
      return apiError(CRYPTO_BILLING_UNAVAILABLE_MESSAGE, 404);
    }

    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    if (!supabaseAdmin) return apiError("Database not configured", 500);

    // Same Base RPC read as /api/billing/wallet/refresh; enforce a per-user
    // limit so an authed client cannot hammer the chain RPC.
    const rateLimited = enforceAuthenticatedRouteRateLimit(req, {
      routeKey: "billing-token-holding-refresh",
      userId,
      ...RATE_LIMIT_PRESETS.secretWrite,
    });
    if (rateLimited) return rateLimited;

    const result = await refreshPrimaryHermesTokenHolding({ userId });

    return apiSuccess({
      token: tokenConfigPayload(),
      refresh: result,
      entitlement: {
        verified: Boolean(result.snapshot),
        qualifiesBaseTier: result.snapshot?.qualifiesBaseTier ?? false,
      },
    });
  } catch (error) {
    return apiError("Failed to refresh token holding", 500, {
      failureType: "token_holding_refresh_failed",
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}
