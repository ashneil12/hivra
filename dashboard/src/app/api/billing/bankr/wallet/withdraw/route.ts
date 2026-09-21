/**
 * POST /api/billing/bankr/wallet/withdraw
 *
 * Sends the entire on-chain $HERMESOS balance from the authenticated
 * user's hermesos_lock wallet back to the EOA that originally deposited
 * into it. The destination is determined ON-CHAIN via the most recent
 * Transfer event into the lock wallet — there is no off-chain trust
 * assumption beyond Bankr's MPC.
 *
 * Body (all optional):
 *   {
 *     expectedRecipient?: string  // dashboard's confirmation; rejected
 *                                  // if it doesn't match the on-chain
 *                                  // originating wallet
 *   }
 *
 * Response 200:
 *   {
 *     status: "submitted",
 *     txHash: string | null,
 *     amountDisplay: string,
 *     recipientAddress: string
 *   }
 *
 * Response 4xx/5xx for: not authenticated, no balance, no on-chain
 * deposit history (so we have no recipient to send to), expectedRecipient
 * mismatch, Bankr transfer failure.
 */

import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import {
  BILLING_V2_UNAVAILABLE_MESSAGE,
  isBillingV2ServerEnabled,
} from "@/lib/billing/billing-v2-availability";
import { withdrawAllHermesTokensForUser } from "@/lib/billing/bankr-withdraw";
import { evaluateAndRecordTokenTierEligibility } from "@/lib/billing/token-tier-eligibility";
import {
  fetchHermesTokenBalance,
  getHermesLockWallet,
  refreshPrimaryHermesTokenHolding,
} from "@/lib/billing/token-holdings";
import { log } from "@/lib/logger";
import { enforceRateLimit } from "@/lib/rate-limit";

interface WithdrawRequestBody {
  expectedRecipient?: string;
}

// In-process per-user lock so two near-simultaneous POSTs from the same
// caller can't both observe the same non-zero balance, both mint Bankr
// API keys, and both submit a transfer. The second call is rejected with
// 409 instead of being queued — the user shouldn't be retrying that fast
// anyway, and queueing would just delay an inevitable double-submit.
//
// NOTE: this is process-local. Horizontal scaling (multiple Node
// instances behind the load balancer) is NOT covered. The proper fix is
// a DB-level `(user_id) UNIQUE WHERE status='in_flight'` claim row in a
// `withdrawals` table — see supabase migration referenced in the Pass 1
// security report. Keep this in-process guard as defense-in-depth even
// after the DB lock lands.
const inFlightByUser = new Map<string, Promise<unknown>>();
const LOG_CONTEXT = {
  source: "billing/withdraw",
  route: "/api/billing/bankr/wallet/withdraw",
  method: "POST",
};

export async function POST(req: NextRequest) {
  let userIdForLog: string | null = null;
  try {
    if (!isBillingV2ServerEnabled()) {
      return apiError(BILLING_V2_UNAVAILABLE_MESSAGE, 404);
    }

    const { userId } = await auth();
    userIdForLog = userId ?? null;
    if (!userId) return apiError("Unauthorized", 401);

    // Strict per-user rate limit. Money path — 3 attempts per minute is
    // plenty for legitimate retry-after-error, and tight enough that
    // even if the in-flight lock is bypassed (multi-process, lock map
    // cleared, etc.) the blast radius is bounded.
    const ip = req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || "unknown";
    const rate = enforceRateLimit(`withdraw:${userId}:${ip}`, {
      limit: 3,
      windowMs: 60_000,
    });
    if (!rate.success) {
      return apiError("Too many withdraw attempts. Please wait a minute.", 429, {
        failureType: "withdraw_rate_limited",
      });
    }

    // Claim the in-flight slot synchronously *before* any further await,
    // so two near-simultaneous POSTs can't both pass this check. Setting
    // a placeholder promise and replacing it later is a cheap way to
    // guarantee atomicity around the (check, set) pair.
    if (inFlightByUser.has(userId)) {
      return apiError(
        "A withdraw is already in progress. Wait for it to settle before retrying.",
        409,
        { failureType: "withdraw_already_in_flight" }
      );
    }
    let releaseLock: () => void = () => {};
    const lockHolder = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    inFlightByUser.set(userId, lockHolder);

    let result;
    try {
      let body: WithdrawRequestBody = {};
      try {
        body = (await req.json()) as WithdrawRequestBody;
      } catch {
        // Empty body is fine.
      }

      result = await withdrawAllHermesTokensForUser({
        userId,
        expectedRecipient: body.expectedRecipient,
      });
    } finally {
      inFlightByUser.delete(userId);
      releaseLock();
    }

    if (result.status === "already_in_flight") {
      // Cross-process lock fired — another Node instance is already
      // mid-withdrawal for this user. The route's in-process lock
      // catches the same-process case; this catches horizontal-scale
      // concurrency via the partial unique index on bankr_withdrawals.
      return apiError(
        result.errorMessage ??
          "A withdraw is already in progress. Wait for it to settle before retrying.",
        409,
        { failureType: "withdraw_already_in_flight" }
      );
    }
    if (result.status === "no_wallet") {
      return apiError("No Hivra lock wallet found for this user.", 404, {
        failureType: "withdraw_no_wallet",
      });
    }
    if (result.status === "no_balance") {
      return apiError("No $HERMESOS balance to withdraw.", 422, {
        failureType: "withdraw_no_balance",
      });
    }
    if (result.status === "no_withdraw_address") {
      return apiError(
        result.errorMessage ??
          "Set your withdraw destination address before withdrawing. Funds will be sent to the address you save — not auto-detected from chain history.",
        422,
        {
          failureType: "withdraw_no_address_set",
        }
      );
    }
    if (result.status === "not_configured") {
      return apiError("Bankr withdraw is not configured.", 503, {
        failureType: "withdraw_not_configured",
      });
    }
    if (result.status === "transfer_failed") {
      // NB: errorMessage is intentionally NOT included in the response —
      // it can carry status codes / partial response bodies from Bankr
      // that may include partner-side identifiers. Keep the structured
      // diagnostic to safe outcome tags only.
      log.error("withdraw transfer failed", new Error("bankr_transfer_failed"), {
        ...LOG_CONTEXT,
        userId,
        failureType: "withdraw_transfer_failed",
        gasTopupStatus: result.gasTopup?.status ?? null,
        reportOpsEvent: false,
      });
      return apiError("Withdraw transfer failed. Try again in a moment.", 502, {
        failureType: "withdraw_transfer_failed",
      }, undefined, {
        ...LOG_CONTEXT,
        userId,
        failureType: "withdraw_transfer_failed",
      });
    }

    if (result.gasTopup) {
      log.info("withdraw gas top-up observed", {
        ...LOG_CONTEXT,
        userId,
        gasTopupStatus: result.gasTopup.status,
        gasTopupTxHash: result.gasTopup.txHash ?? null,
      });
    }

    // Trigger an immediate eligibility re-evaluation so the user sees
    // their tier flip into breach/grace state on the very next page
    // refresh, rather than waiting for the 6-hour cron tick. We read
    // the live on-chain balance (not a DB cache) so the evaluator sees
    // the post-withdraw amount. Best-effort — failures here MUST NOT
    // bubble back as a 500, because the on-chain transfer already
    // submitted successfully.
    let postWithdrawEligibility:
      | { evaluated: boolean; balanceRaw: string }
      | null = null;
    try {
      // refreshPrimaryHermesTokenHolding does both: reads live on-chain
      // balance AND inserts a fresh row into token_holding_snapshots.
      // We need the snapshot insert specifically — the wallet
      // eligibility API reads balance from snapshots, so without a
      // fresh row the page keeps showing the pre-withdraw amount.
      const refresh = await refreshPrimaryHermesTokenHolding({ userId });
      if (refresh.status === "refreshed" && refresh.snapshot) {
        const balanceRaw = refresh.snapshot.balanceRaw;
        await evaluateAndRecordTokenTierEligibility({
          userId,
          currentBalance: BigInt(balanceRaw),
        });
        postWithdrawEligibility = {
          evaluated: true,
          balanceRaw,
        };
      } else {
        // Fallback path — refresh couldn't run (e.g. user has no
        // verified wallet row). Still try to evaluate eligibility off
        // a direct chain read so the row at least flips.
        const wallet = await getHermesLockWallet(userId);
        if (wallet) {
          const balance = await fetchHermesTokenBalance({
            walletAddress: wallet.address,
          });
          await evaluateAndRecordTokenTierEligibility({
            userId,
            currentBalance: BigInt(balance.balanceRaw),
          });
          postWithdrawEligibility = {
            evaluated: true,
            balanceRaw: balance.balanceRaw,
          };
        }
      }
    } catch (eligErr) {
      log.warn("post-withdraw eligibility re-check failed", {
        ...LOG_CONTEXT,
        userId,
        failureType: "withdraw_post_eligibility_failed",
      }, eligErr);
      // Swallow — the cron will catch up within 6 hours regardless.
    }

    return apiSuccess({
      status: result.status,
      txHash: result.txHash ?? null,
      amountRaw: result.amountRaw,
      amountDisplay: result.amountDisplay,
      recipientAddress: result.recipientAddress,
      postWithdrawEligibility,
    });
  } catch (error) {
    return apiError("Failed to process withdraw.", 500, {
      failureType: "withdraw_failed",
      errorName: error instanceof Error ? error.name : typeof error,
    }, undefined, {
      ...LOG_CONTEXT,
      userId: userIdForLog,
      failureType: "withdraw_failed",
      cause: error,
    });
  }
}
