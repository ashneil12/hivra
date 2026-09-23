import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import { TokenNotAllowedError } from "@/lib/billing/token-access";

import { apiError, apiSuccess } from "@/lib/api-response";
import {
  ensureBankrDepositWalletForUser,
  getBankrDepositWalletCredentialForUser,
} from "@/lib/billing/bankr-deposit-wallets";
import {
  ManagedVeniceTokenQuotePriceError,
  ManagedVeniceTopUpExceedsHiddenCapError,
  type ManagedVeniceTokenQuote,
  createManagedVeniceTokenQuote,
  createManagedVeniceTokenQuoteForUsdTarget,
} from "@/lib/billing/managed-venice-token-quotes";
import {
  ActiveCryptoPaymentSessionError,
  activeCryptoPaymentSessionResponse,
  assertNoActiveCryptoPaymentSession,
} from "@/lib/billing/crypto-payment-sessions";

const MANAGED_VENICE_DEPOSIT_WALLET_PURPOSE = "credit_deposit";

// Server-side ceiling on the paid principal a single $HermesOS quote can
// target, mirroring the card top-up cap (MAX_MANAGED_VENICE_TOP_UP_MICRO_USD
// in api/billing/managed-venice/card/top-up/route.ts) so the crypto path can't
// be used to mint an arbitrarily large credit/bonus from one quote. $5,000.
const MAX_MANAGED_VENICE_TARGET_PAID_MICRO_USD = 5_000_000_000;

const HERMES_TOP_UP_UNAVAILABLE_MESSAGE =
  "We couldn't start the $HermesOS top-up yet. Please try again in a moment, or use card credits for now.";
const HERMES_PRICE_UNAVAILABLE_MESSAGE =
  "$HermesOS pricing is temporarily unavailable. Please try again in a moment, or use card credits for now.";
const HERMES_WALLET_PENDING_MESSAGE =
  "$HermesOS top-ups are still being connected. Card credits are available now.";

// Optional platform token; the account's payment token when absent.
const TokenSchema = z.enum(["hermesos", "hivra"]).optional();

const QuoteRequestSchema = z.union([
  z.object({
    tokenAmountRaw: z.string().regex(/^[1-9]\d*$/),
    targetPaidMicroUsd: z.never().optional(),
    token: TokenSchema,
  }),
  z.object({
    targetPaidMicroUsd: z
      .number()
      .int()
      .positive()
      .max(MAX_MANAGED_VENICE_TARGET_PAID_MICRO_USD),
    tokenAmountRaw: z.never().optional(),
    token: TokenSchema,
  }),
]);

function serializeQuote(quote: ManagedVeniceTokenQuote) {
  return {
    id: quote.id,
    accountId: quote.accountId,
    userId: quote.userId,
    tokenAmountRaw: quote.tokenAmountRaw,
    tokenKey: quote.tokenKey,
    tokenAddress: quote.tokenAddress,
    tokenSymbol: quote.tokenSymbol,
    tokenDecimals: quote.tokenDecimals,
    snapshotPriceUsd: quote.snapshotPriceUsd,
    lockedValueMicroUsd: quote.lockedValueMicroUsd,
    depositAddress: quote.depositAddress,
    quotedAt: quote.quotedAt,
    expiresAt: quote.expiresAt,
    status: quote.status,
    source: quote.source,
    crossCheckSource: quote.crossCheckSource,
    crossCheckPriceUsd: quote.crossCheckPriceUsd,
    priceLastUpdatedAt: quote.priceLastUpdatedAt,
    crossCheckLastUpdatedAt: quote.crossCheckLastUpdatedAt,
    transactionHash: quote.transactionHash,
    settledAt: quote.settledAt,
    paidValueMicroUsd: quote.paidValueMicroUsd,
    creditValueMicroUsd: quote.creditValueMicroUsd,
    bonusValueMicroUsd: quote.bonusValueMicroUsd,
    launchBonusMicroUsd: quote.launchBonusMicroUsd,
    standardBonusMicroUsd: quote.standardBonusMicroUsd,
  };
}

function errorName(error: unknown) {
  return error instanceof Error ? error.name : typeof error;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function POST(req: NextRequest) {
  let userIdForLog: string | null = null;

  const topUpFailure = (
    failureType: string,
    step: string,
    error: unknown,
    status = 500,
    reason = "topup_temporarily_unavailable"
  ) =>
    apiError(
      HERMES_TOP_UP_UNAVAILABLE_MESSAGE,
      status,
      {
        failureType,
        step,
        errorName: errorName(error),
        errorMessage: errorMessage(error),
      },
      { reason },
      {
        source: "billing/managed-venice/hermesos/quote",
        route: "/api/billing/managed-venice/hermesos/quote",
        method: "POST",
        userId: userIdForLog,
        failureType,
        cause: error,
      }
    );

  try {
    const { userId } = await auth();
    userIdForLog = userId ?? null;
    if (!userId) return apiError("Unauthorized", 401);

    let body: unknown;
    try {
      body = await req.json();
    } catch (error) {
      return apiError("Invalid JSON body.", 400, {
        failureType: "managed_venice_quote_invalid_json",
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }

    const parsed = QuoteRequestSchema.safeParse(body);
    if (!parsed.success) {
      return apiError("Invalid $HermesOS top-up request.", 400, {
        failureType: "managed_venice_quote_invalid_amount",
      });
    }

    let credential;
    try {
      credential = await getBankrDepositWalletCredentialForUser({
        userId,
        purpose: MANAGED_VENICE_DEPOSIT_WALLET_PURPOSE,
      });
    } catch (error) {
      return topUpFailure(
        "managed_venice_quote_wallet_lookup_failed",
        "wallet_lookup",
        error
      );
    }

    if (!credential) {
      let provisioned;
      try {
        provisioned = await ensureBankrDepositWalletForUser({
          userId,
          purpose: MANAGED_VENICE_DEPOSIT_WALLET_PURPOSE,
        });
      } catch (error) {
        return topUpFailure(
          "managed_venice_quote_wallet_provision_failed",
          "wallet_provision",
          error,
          503,
          "wallet_provisioning_unavailable"
        );
      }

      if (provisioned.status === "not_configured") {
        return apiError(
          HERMES_WALLET_PENDING_MESSAGE,
          503,
          {
            failureType: "managed_venice_quote_bankr_not_configured",
          },
          { reason: "bankr_wallet_provisioning_pending" }
        );
      }
      credential = provisioned.credential;
    }
    if (!credential) {
      return topUpFailure(
        "managed_venice_quote_credential_missing",
        "wallet_provision",
        new Error("Wallet provisioning returned no credential")
      );
    }

    const depositAddress = credential.normalizedEvmAddress || credential.evmAddress;
    if (!depositAddress) {
      return topUpFailure(
        "managed_venice_quote_wallet_missing_address",
        "wallet_provision",
        new Error("Wallet credential missing deposit address")
      );
    }

    try {
      await assertNoActiveCryptoPaymentSession({ userId });
    } catch (error) {
      if (error instanceof ActiveCryptoPaymentSessionError) {
        return apiError(
          "A crypto payment is already active. Finish it or let it expire before starting another.",
          409,
          { failureType: "managed_venice_quote_active_payment" },
          activeCryptoPaymentSessionResponse(error.session)
        );
      }
      return topUpFailure(
        "managed_venice_quote_active_payment_check_failed",
        "active_payment_check",
        error
      );
    }

    let quote: ManagedVeniceTokenQuote;
    try {
      quote =
        typeof parsed.data.targetPaidMicroUsd === "number"
          ? await createManagedVeniceTokenQuoteForUsdTarget({
              userId,
              targetMicroUsd: parsed.data.targetPaidMicroUsd,
              depositAddress,
              ...(parsed.data.token ? { token: parsed.data.token } : {}),
            })
          : await createManagedVeniceTokenQuote({
              userId,
              tokenAmountRaw: parsed.data.tokenAmountRaw,
              depositAddress,
              ...(parsed.data.token ? { token: parsed.data.token } : {}),
            });
    } catch (error) {
      if (error instanceof TokenNotAllowedError) {
        return apiError(error.message, 403, {
          failureType: "token_not_allowed",
          token: error.tokenKey,
          allowedTokens: error.allowedTokens,
        });
      }
      if (error instanceof ManagedVeniceTokenQuotePriceError) {
        return apiError(
          HERMES_PRICE_UNAVAILABLE_MESSAGE,
          503,
          {
            failureType: "managed_venice_quote_price_unavailable",
            step: "price_oracle",
            errorName: error.name,
            errorMessage: error.message,
          },
          { reason: "pricing_unavailable" },
          {
            source: "billing/managed-venice/hermesos/quote",
            route: "/api/billing/managed-venice/hermesos/quote",
            method: "POST",
            userId: userIdForLog,
            failureType: "managed_venice_quote_price_unavailable",
            cause: error,
          }
        );
      }
      if (error instanceof ManagedVeniceTopUpExceedsHiddenCapError) {
        const maxAdditionalUsd = (error.maxAdditionalPaidMicroUsd / 1_000_000).toFixed(2);
        return apiError(
          `This top-up would exceed your account's bonus allocation. ` +
            `Email ${error.supportEmail} to extend your allocation. ` +
            `Without contacting support you can still top up up to $${maxAdditionalUsd} more at the current bonus rate.`,
          403,
          {
            failureType: "managed_venice_quote_user_bonus_cap_reached",
            errorName: error.name,
            currentBonusUsedMicroUsd: error.currentBonusUsedMicroUsd,
            capLimitMicroUsd: error.capLimitMicroUsd,
            attemptedTotalBonusMicroUsd: error.attemptedTotalBonusMicroUsd,
            maxAdditionalPaidMicroUsd: error.maxAdditionalPaidMicroUsd,
          },
          {
            reason: "user_bonus_cap_reached",
            supportEmail: error.supportEmail,
            maxAdditionalPaidMicroUsd: error.maxAdditionalPaidMicroUsd,
          },
          {
            source: "billing/managed-venice/hermesos/quote",
            route: "/api/billing/managed-venice/hermesos/quote",
            method: "POST",
            userId: userIdForLog,
            failureType: "managed_venice_quote_user_bonus_cap_reached",
            cause: error,
          }
        );
      }
      return topUpFailure(
        "managed_venice_quote_persist_failed",
        "quote_create",
        error
      );
    }

    return apiSuccess(serializeQuote(quote));
  } catch (error) {
    return topUpFailure("managed_venice_quote_create_failed", "unexpected", error);
  }
}
