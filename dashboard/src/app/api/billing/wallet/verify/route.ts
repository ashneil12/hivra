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
import { verifyWalletChallenge } from "@/lib/billing/wallet-verification";
import { noticeWithdrawDestinationChange } from "@/lib/billing/withdraw-destination-notice";
import { withdrawDestinationAvailableAt } from "@/lib/billing/withdraw-destination-policy";
import { log } from "@/lib/logger";
import { hasExistingTokenHolderAccess, resolveTokenGeoBlock } from "@/lib/compliance/token-geo-gate";
import { tokenGeoBlockedResponse } from "@/lib/compliance/token-geo-response";
import { supabaseAdmin } from "@/lib/supabase";

const WalletVerifyRequestSchema = z.object({
  challengeId: z.string().trim().min(1),
  signature: z.string().trim().min(1),
});

/**
 * For a lock-wallet holder, the verified primary wallet is where
 * "move to my own wallet" sends the lock wallet's tokens, so verifying a
 * different wallet changes a withdrawal destination: the move is held for the
 * cooldown from the new verification (bankr-withdraw.ts) and the owner is
 * emailed here. Read before verifying; null when it could not be read.
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
      route: "/api/billing/wallet/verify",
      userId,
      failureType: "wallet_verify_move_destination_read_failed",
    }, error);
    return null;
  }
}

export async function POST(req: NextRequest) {
  try {
    const { userId } = await auth();
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
        route: "/api/billing/wallet/verify",
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
