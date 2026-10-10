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
  formatRawTokenBalance,
  getTokenVerificationWallet,
  platformTokenBalanceConfig,
  refreshPrimaryHermesTokenHolding,
} from "@/lib/billing/token-holdings";
import {
  getLatestAccessTokenHoldingSnapshot,
  resolveUserTokenAccess,
} from "@/lib/billing/token-access";
import { platformTokenByAddress, requirePlatformToken, type PlatformToken } from "@/lib/billing/token-registry";

function tokenConfigPayload(token: PlatformToken) {
  const config = platformTokenBalanceConfig(token);
  return {
    chainId: config.chainId,
    tokenKey: token.key,
    tokenAddress: config.tokenAddress,
    tokenSymbol: config.tokenSymbol,
    tokenDecimals: config.tokenDecimals,
    minimumBalanceRaw: config.baseTierMinimumRaw!,
    minimumBalanceDisplay: formatRawTokenBalance(config.baseTierMinimumRaw!, config.tokenDecimals),
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

    const [wallet, snapshot, access] = await Promise.all([
      getTokenVerificationWallet(userId),
      getLatestAccessTokenHoldingSnapshot(userId),
      resolveUserTokenAccess(userId, { recordMembership: false }),
    ]);
    const token =
      platformTokenByAddress(snapshot?.tokenAddress) ?? requirePlatformToken(access.paymentToken);

    return apiSuccess({
      token: tokenConfigPayload(token),
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
    const access = await resolveUserTokenAccess(userId, { recordMembership: false });
    const isAllowedPlatformSnapshot = (tokenAddress: string | undefined) => {
      // A snapshot without an address predates the token dimension: $HermesOS.
      const key = tokenAddress ? platformTokenByAddress(tokenAddress)?.key : "hermesos";
      return !!key && access.allowedTokens.includes(key);
    };
    // The token base tier counts any platform token this user may hold.
    const qualifyingSnapshot =
      result.status === "refreshed"
        ? [...(result.snapshots ?? []), ...(result.snapshot ? [result.snapshot] : [])].find(
            (snapshot) =>
              snapshot.qualifiesBaseTier &&
              // The refresh result's snapshots also include VVV: only platform tokens count.
              isAllowedPlatformSnapshot(snapshot.tokenAddress)
          ) ?? null
        : null;
    const token =
      platformTokenByAddress(qualifyingSnapshot?.tokenAddress) ?? requirePlatformToken(access.paymentToken);

    return apiSuccess({
      token: tokenConfigPayload(token),
      // Balances are bigints (not JSON); the snapshots carry the same numbers.
      refresh:
        result.status === "refreshed"
          ? { status: result.status, snapshot: result.snapshot, snapshots: result.snapshots ?? [] }
          : { status: result.status, snapshot: result.snapshot },
      entitlement: {
        verified: Boolean(result.snapshot),
        qualifiesBaseTier: qualifyingSnapshot !== null,
      },
    });
  } catch (error) {
    return apiError("Failed to refresh token holding", 500, {
      failureType: "token_holding_refresh_failed",
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}
