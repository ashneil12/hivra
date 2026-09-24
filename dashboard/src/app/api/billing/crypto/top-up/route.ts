import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import { apiError, apiSuccess } from "@/lib/api-response";
import {
  createCryptoTopUpIntent,
  isCryptoTopUpAssetKey,
} from "@/lib/billing/crypto-topups";
import {
  ActiveCryptoPaymentSessionError,
  activeCryptoPaymentSessionResponse,
} from "@/lib/billing/crypto-payment-sessions";
import {
  CRYPTO_BILLING_UNAVAILABLE_MESSAGE,
  isCryptoBillingEnabled,
} from "@/lib/billing/crypto-availability";
import { ensureBankrDepositWalletForUser } from "@/lib/billing/bankr-deposit-wallets";
import { resolveTokenGeoBlock } from "@/lib/compliance/token-geo-gate";
import { tokenGeoBlockedResponse } from "@/lib/compliance/token-geo-response";
import { supabaseAdmin } from "@/lib/supabase";

const CryptoTopUpRequestSchema = z.object({
  asset: z.string().trim().min(1),
  packageCredits: z.number().int(),
});

function isClientInputError(error: unknown) {
  return error instanceof Error && (
    error.message.includes("Invalid credit top-up package") ||
    error.message.includes("Unsupported crypto top-up asset") ||
    error.message.includes("not enabled")
  );
}

export async function POST(req: NextRequest) {
  let userIdForLog: string | null = null;
  try {
    if (!isCryptoBillingEnabled()) {
      return apiError(CRYPTO_BILLING_UNAVAILABLE_MESSAGE, 404);
    }

    const { userId } = await auth();
    userIdForLog = userId ?? null;
    if (!userId) return apiError("Unauthorized", 401);
    if (!supabaseAdmin) return apiError("Database not configured", 500);

    // Token geo-policy: a crypto top-up starts a new crypto payment. Card
    // top-ups (/api/billing/top-up) never consult the policy.
    const geo = await resolveTokenGeoBlock(req, { userId });
    if (geo.blocked) {
      return tokenGeoBlockedResponse(geo, {
        source: "billing/crypto/top-up",
        route: "/api/billing/crypto/top-up",
        method: "POST",
        userId,
      });
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch (error) {
      return apiError("Invalid JSON body", 400, {
        failureType: "crypto_topup_invalid_json",
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }

    const parsed = CryptoTopUpRequestSchema.safeParse(body);
    if (!parsed.success || !isCryptoTopUpAssetKey(parsed.data.asset)) {
      return apiError("Invalid crypto top-up request", 400);
    }

    const walletResult = await ensureBankrDepositWalletForUser({
      userId,
      purpose: "credit_deposit",
      makePrimary: true,
    });
    if (walletResult.status === "not_configured") {
      return apiError("Bankr wallet provisioning is not configured", 503, {
        failureType: "bankr_wallet_not_configured",
      });
    }
    if (!walletResult.credential) {
      return apiError("Wallet provisioning returned no credential", 500, {
        failureType: "bankr_wallet_credential_missing",
      });
    }

    const intent = await createCryptoTopUpIntent({
      userId,
      asset: parsed.data.asset,
      packageCredits: parsed.data.packageCredits,
      depositWallet: {
        address: walletResult.credential.normalizedEvmAddress || walletResult.credential.evmAddress,
        bankrWalletId: walletResult.credential.bankrWalletId,
      },
    });

    return apiSuccess({
      intent,
      instructions: {
        network: intent.asset.network,
        asset: intent.asset.symbol,
        amount: intent.amountDisplay,
        depositAddress: intent.depositAddress,
      },
    });
  } catch (error) {
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
          source: "billing/crypto/top-up",
          route: "/api/billing/crypto/top-up",
          method: "POST",
          userId: userIdForLog,
          failureType: "crypto_payment_session_active",
          logLevel: "warn",
        }
      );
    }

    if (isClientInputError(error)) {
      return apiError("Invalid crypto top-up request", 400);
    }

    return apiError("Failed to create crypto top-up", 500, {
      failureType: "crypto_topup_create_failed",
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}
