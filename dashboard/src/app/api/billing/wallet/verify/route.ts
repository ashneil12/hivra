import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import { apiError, apiSuccess } from "@/lib/api-response";
import {
  enforceAuthenticatedRouteRateLimit,
  RATE_LIMIT_PRESETS,
} from "@/lib/authenticated-rate-limit";
import { verifyWalletChallenge } from "@/lib/billing/wallet-verification";
import { supabaseAdmin } from "@/lib/supabase";

const WalletVerifyRequestSchema = z.object({
  challengeId: z.string().trim().min(1),
  signature: z.string().trim().min(1),
});

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

    const result = await verifyWalletChallenge({
      userId,
      challengeId: parsed.data.challengeId,
      signature: parsed.data.signature,
    });

    switch (result.status) {
      case "verified":
        return apiSuccess({
          status: result.status,
          wallet: result.wallet,
          challenge: result.challenge,
          // The signature proved control of the wallet, so it was taken over
          // from account(s) that had verified it before (sybil guard). Only a
          // boolean crosses the API — never the displaced account ids.
          movedFromAnotherAccount: Boolean(result.takeover),
        });
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
