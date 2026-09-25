import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import { apiError, apiSuccess } from "@/lib/api-response";
import {
  enforceAuthenticatedRouteRateLimit,
  RATE_LIMIT_PRESETS,
} from "@/lib/authenticated-rate-limit";
import { getSelfCustodyPrimaryWallet } from "@/lib/billing/bankr-withdraw";
import { getHermesLockWallet } from "@/lib/billing/token-holdings";
import { getPendingWalletChallengeAddress, verifyWalletChallenge } from "@/lib/billing/wallet-verification";
import {
  noticeWithdrawDestinationChange,
  withdrawDestinationStepUpResponse,
} from "@/lib/billing/withdraw-destination-notice";
import { withdrawDestinationAvailableAt } from "@/lib/billing/withdraw-destination-policy";
import { log } from "@/lib/logger";
import { hasExistingTokenHolderAccess, resolveTokenGeoBlock } from "@/lib/compliance/token-geo-gate";
import { tokenGeoBlockedResponse } from "@/lib/compliance/token-geo-response";
import { supabaseAdmin } from "@/lib/supabase";

const ROUTE = "/api/billing/wallet/verify";

const WalletVerifyRequestSchema = z.object({
  challengeId: z.string().trim().min(1),
  signature: z.string().trim().min(1),
});

/**
 * For a lock-wallet holder, the verified primary wallet is where
 * "move to my own wallet" sends the lock wallet's tokens, so verifying a
 * different wallet changes a withdrawal destination: it needs a fresh sign-in
 * check, the move is held for the cooldown from the new verification
 * (bankr-withdraw.ts) and the owner is emailed here. Read before verifying;
 * null when it could not be read.
 */
async function loadMoveDestination(userId: string): Promise<{ hasLockWallet: boolean; address: string | null } | null> {
  try {
    const [lockWallet, primary] = await Promise.all([
      getHermesLockWallet(userId),
      getSelfCustodyPrimaryWallet(userId),
    ]);
    return { hasLockWallet: Boolean(lockWallet), address: primary?.normalizedAddress ?? null };
  } catch (error) {
    log.warn("could not read the lock-wallet move destination before verifying a wallet", {
      source: "billing/wallet-verify",
      route: ROUTE,
      userId,
      failureType: "wallet_verify_move_destination_read_failed",
    }, error);
    return null;
  }
}

/**
 * Whether verifying this challenge would change where a lock-wallet move
 * sends funds, so it needs the same fresh sign-in check as every other
 * withdrawal destination change. Fails closed: when the current destination
 * or the challenge's wallet can't be read, it counts as a change. An account
 * without a lock wallet has no move destination to change, and can't gain
 * one later (no path creates new lock wallets), so it is never asked.
 */
async function verificationChangesMoveDestination(
  userId: string,
  challengeId: string,
  before: { hasLockWallet: boolean; address: string | null } | null
): Promise<boolean> {
  if (before && !before.hasLockWallet) return false;
  let challengeAddress: string | null;
  try {
    challengeAddress = await getPendingWalletChallengeAddress({ userId, challengeId });
  } catch (error) {
    log.warn("could not read the wallet a challenge would verify", {
      source: "billing/wallet-verify",
      route: ROUTE,
      userId,
      failureType: "wallet_verify_challenge_read_failed",
    }, error);
    return true;
  }
  // No pending challenge: nothing will be verified, and the verifier says why.
  if (challengeAddress === null) return false;
  return before === null || before.address !== challengeAddress;
}

export async function POST(req: NextRequest) {
  try {
    const authObject = await auth();
    const { userId } = authObject;
    if (!userId) return apiError("Unauthorized", 401);
    if (!supabaseAdmin) return apiError("Database not configured", 500);

    // Wallet signature verification is comparatively expensive (signature
    // recovery + RPC on the chain). Rate-limit so a single authed user
    // can't flood with bogus signatures.
    const rateLimitError = enforceAuthenticatedRouteRateLimit(req, {
      routeKey: "wallet_verify_post",
      userId,
      ...RATE_LIMIT_PRESETS.secretWrite,
    });
    if (rateLimitError) return rateLimitError;

    // Same rule as /api/billing/wallet/challenge: no new wallet verification
    // for a blocked user without existing token access.
    const geo = await resolveTokenGeoBlock(req, { userId });
    if (geo.blocked && !(await hasExistingTokenHolderAccess(userId))) {
      return tokenGeoBlockedResponse(geo, {
        source: "billing/wallet-verify",
        route: ROUTE,
        method: "POST",
        userId,
      });
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch (error) {
      return apiError("Invalid JSON body", 400, {
        failureType: "wallet_verify_invalid_json",
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }

    const parsed = WalletVerifyRequestSchema.safeParse(body);
    if (!parsed.success) {
      return apiError("Invalid wallet verification request", 400);
    }

    const moveDestinationBefore = await loadMoveDestination(userId);
    // Checked before the challenge is used, so the dashboard can retry the
    // same signed request once the user has confirmed it's them.
    if (await verificationChangesMoveDestination(userId, parsed.data.challengeId, moveDestinationBefore)) {
      const stepUp = withdrawDestinationStepUpResponse(authObject, { route: ROUTE, userId });
      if (stepUp) return stepUp;
    }

    const result = await verifyWalletChallenge({
      userId,
      challengeId: parsed.data.challengeId,
      signature: parsed.data.signature,
    });

    switch (result.status) {
      case "verified": {
        const newAddress = result.wallet?.normalizedAddress ?? null;
        // Notify when a lock-wallet holder's move destination changed. If it
        // could not be read beforehand, notify anyway: a spare email is better
        // than a missed one.
        if (
          newAddress &&
          (moveDestinationBefore === null ||
            (moveDestinationBefore.hasLockWallet && moveDestinationBefore.address !== newAddress))
        ) {
          const changedAt = result.wallet?.verifiedAt ? new Date(result.wallet.verifiedAt) : new Date();
          await noticeWithdrawDestinationChange({
            userId,
            kind: "verified_wallet",
            previousAddress: moveDestinationBefore?.address ?? null,
            newAddress,
            changedAt,
            availableAt: withdrawDestinationAvailableAt(changedAt),
          });
        }
        return apiSuccess({
          status: result.status,
          wallet: result.wallet,
          challenge: result.challenge,
          // The signature proved control of the wallet, so it was taken over
          // from account(s) that had verified it before (sybil guard). Only a
          // boolean crosses the API — never the displaced account ids.
          movedFromAnotherAccount: Boolean(result.takeover),
        });
      }
      case "invalid_signature":
        return apiError("Invalid wallet signature", 400, undefined, {
          status: result.status,
        });
      case "expired":
        return apiError("Wallet verification challenge expired", 400, undefined, {
          status: result.status,
        });
      case "not_found":
        return apiError("Wallet verification challenge not found", 404, undefined, {
          status: result.status,
        });
      case "already_used":
        return apiError("Wallet verification challenge already used", 409, undefined, {
          status: result.status,
        });
      default:
        return apiError("Failed to verify wallet", 500, {
          failureType: "wallet_verify_unknown_status",
        });
    }
  } catch (error) {
    return apiError("Failed to verify wallet", 500, {
      failureType: "wallet_verify_failed",
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}
