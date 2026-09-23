/**
 * POST /api/billing/wallet/refresh
 *
 * On-demand snapshot refresh for the authenticated user. Reads the
 * lock wallet's $HERMESOS balance from Base RPC, writes a fresh row
 * into token_holding_snapshots, and re-evaluates tier eligibility.
 *
 * Enables the dashboard's "Refresh" button next to current balance
 * to actually pull a NEW chain read, instead of just re-displaying
 * the stale snapshot the cron last wrote.
 *
 * Rate-limit consideration: this is a chain RPC call + DB write per
 * invocation. The dashboard's button is a manual click so abuse is
 * naturally bounded, but if we ever expose this to automation we
 * should add a per-user 1-call-per-30s limiter.
 */

import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import {
  enforceAuthenticatedRouteRateLimit,
  RATE_LIMIT_PRESETS,
} from "@/lib/authenticated-rate-limit";
import {
  BILLING_V2_UNAVAILABLE_MESSAGE,
  isBillingV2ServerEnabled,
} from "@/lib/billing/billing-v2-availability";
import { isCryptoBillingEnabled } from "@/lib/billing/crypto-availability";
import { refreshPrimaryHermesTokenHolding } from "@/lib/billing/token-holdings";
import { evaluateAndRecordTokenTierEligibility } from "@/lib/billing/token-tier-eligibility";
import { log } from "@/lib/logger";

const LOG_CONTEXT = {
  source: "billing/wallet-refresh",
  route: "/api/billing/wallet/refresh",
  method: "POST",
};

export async function POST(req: NextRequest) {
  let userIdForLog: string | null = null;
  try {
    // Token/wallet surfaces share one consistent gate (see token-holding route):
    // require BOTH billing-v2 and crypto billing so the wallet and billing pages
    // never disagree about whether token holdings are available.
    if (!isBillingV2ServerEnabled() || !isCryptoBillingEnabled()) {
      return apiError(BILLING_V2_UNAVAILABLE_MESSAGE, 404);
    }
    const { userId } = await auth();
    userIdForLog = userId ?? null;
    if (!userId) return apiError("Unauthorized", 401);

    // Each call is a Base RPC read + DB write; enforce a per-user limit so an
    // authed client cannot hammer the chain RPC (was only a code comment before).
    const rateLimited = enforceAuthenticatedRouteRateLimit(req, {
      routeKey: "billing-wallet-refresh",
      userId,
      ...RATE_LIMIT_PRESETS.secretWrite,
    });
    if (rateLimited) return rateLimited;

    const result = await refreshPrimaryHermesTokenHolding({ userId });
    if (result.status !== "refreshed" || !result.snapshot) {
      return apiError(
        "No verified $HERMESOS lock wallet to refresh.",
        404,
        { failureType: "wallet_refresh_no_wallet" }
      );
    }

    // Re-evaluate eligibility against the fresh balance — this is
    // what flips the tier row to breached / qualified / etc. on the
    // user's next page reload.
    try {
      await evaluateAndRecordTokenTierEligibility({
        userId,
        balances: result.balances,
      });
    } catch (eligErr) {
      log.warn("wallet refresh eligibility re-evaluation failed", {
        ...LOG_CONTEXT,
        userId,
        failureType: "wallet_refresh_eligibility_failed",
      }, eligErr);
      // Don't fail the response — the snapshot itself succeeded.
    }

    return apiSuccess({
      snapshotId: result.snapshot.id,
      balanceRaw: result.snapshot.balanceRaw,
      qualifiesBaseTier: result.snapshot.qualifiesBaseTier,
    });
  } catch (error) {
    return apiError("Failed to refresh wallet balance.", 500, {
      failureType: "wallet_refresh_failed",
      errorName: error instanceof Error ? error.name : typeof error,
    }, undefined, {
      ...LOG_CONTEXT,
      userId: userIdForLog,
      failureType: "wallet_refresh_failed",
      cause: error,
    });
  }
}
