import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import { apiError, apiSuccess } from "@/lib/api-response";
import {
  enforceAuthenticatedRouteRateLimit,
  RATE_LIMIT_PRESETS,
} from "@/lib/authenticated-rate-limit";
import { BASE_CHAIN_ID, isEvmAddress } from "@/lib/billing/token-holdings";
import {
  createWalletVerificationChallenge,
  isWalletClaimedByAnotherAccount,
} from "@/lib/billing/wallet-verification";
import { supabaseAdmin } from "@/lib/supabase";

const WalletChallengeRequestSchema = z.object({
  address: z.string().trim().min(1),
  chainId: z.number().int().optional().default(BASE_CHAIN_ID),
});

export async function POST(req: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    if (!supabaseAdmin) return apiError("Database not configured", 500);

    // Cap challenge creation so an authed user can't fill the table with
    // pending rows. settingsWrite (10/60s) is plenty for normal use.
    const rateLimitError = enforceAuthenticatedRouteRateLimit(req, {
      routeKey: "wallet_challenge_post",
      userId,
      ...RATE_LIMIT_PRESETS.settingsWrite,
    });
    if (rateLimitError) return rateLimitError;

    let body: unknown;
    try {
      body = await req.json();
    } catch (error) {
      return apiError("Invalid JSON body", 400, {
        failureType: "wallet_challenge_invalid_json",
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }

    const parsed = WalletChallengeRequestSchema.safeParse(body);
    if (!parsed.success) {
      return apiError("Invalid wallet challenge request", 400);
    }

    if (!isEvmAddress(parsed.data.address)) {
      return apiError("Invalid wallet address", 400);
    }

    if (parsed.data.chainId !== BASE_CHAIN_ID) {
      return apiError("Unsupported wallet network", 400);
    }

    const challenge = await createWalletVerificationChallenge({
      userId,
      address: parsed.data.address,
      chainId: parsed.data.chainId,
    });

    // Heads-up for the UI: this address is currently verified on another
    // account, so completing the signature will MOVE it here (the takeover in
    // verifyWalletChallenge demotes the other account's claim). Best-effort —
    // a failed scan must not block challenge creation.
    const movesFromAnotherAccount = await isWalletClaimedByAnotherAccount({
      userId,
      address: parsed.data.address,
    }).catch(() => false);

    return apiSuccess({
      challengeId: challenge.id,
      address: challenge.normalizedAddress,
      chainId: challenge.chainId,
      message: challenge.message,
      expiresAt: challenge.expiresAt,
      movesFromAnotherAccount,
    });
  } catch (error) {
    return apiError("Failed to create wallet verification challenge", 500, {
      failureType: "wallet_challenge_create_failed",
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}
