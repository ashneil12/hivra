import { auth } from "@clerk/nextjs/server";
import { apiError, apiSuccess } from "@/lib/api-response";
import {
  BILLING_V2_UNAVAILABLE_MESSAGE,
  isBillingV2ServerEnabled,
} from "@/lib/billing/billing-v2-availability";
import {
  type BankrDepositWalletCredential,
  bankrDepositWalletPublicSummary,
  ensureBankrDepositWalletForUser,
  getBankrDepositWalletCredentialForUser,
} from "@/lib/billing/bankr-deposit-wallets";
import { getLatestHermesTokenHoldingSnapshotForWallet } from "@/lib/billing/token-holdings";
import {
  BankrPartnerResponseError,
  getBankrWalletForUser,
} from "@/lib/billing/bankr-wallets";
import { supabaseAdmin } from "@/lib/supabase";

const ROUTE_CONTEXT = {
  source: "billing/bankr-wallet",
  route: "/api/billing/bankr/wallet",
};

async function activeLegacyHermesLockCredential(
  userId: string,
  credential: BankrDepositWalletCredential | null
) {
  if (!credential) return null;

  const snapshot = await getLatestHermesTokenHoldingSnapshotForWallet({
    userId,
    walletAddress: credential.normalizedEvmAddress,
  });

  return snapshot && BigInt(snapshot.balanceRaw) > 0n ? credential : null;
}

async function loadBankrWalletStatus(userId: string) {
  const [wallet, creditCredential, tokenLockCredential] = await Promise.all([
    getBankrWalletForUser({ userId, purpose: "credit_deposit" }),
    getBankrDepositWalletCredentialForUser({ userId, purpose: "credit_deposit" }),
    getBankrDepositWalletCredentialForUser({ userId, purpose: "hermesos_lock" }),
  ]);
  const activeTokenLockCredential = await activeLegacyHermesLockCredential(userId, tokenLockCredential);
  const custodyMode = activeTokenLockCredential ? "legacy_custody" : "self_custody";

  return {
    status: activeTokenLockCredential ? "existing" : "self_custody_required",
    custodyMode,
    wallet,
    depositWallet: bankrDepositWalletPublicSummary(creditCredential),
    creditDepositWallet: bankrDepositWalletPublicSummary(creditCredential),
    tokenLockWallet: bankrDepositWalletPublicSummary(activeTokenLockCredential),
  };
}

async function provisionCreditDepositWalletStatus(userId: string) {
  const [creditResult, tokenLockCredential] = await Promise.all([
    ensureBankrDepositWalletForUser({
      userId,
      purpose: "credit_deposit",
      makePrimary: false,
    }),
    getBankrDepositWalletCredentialForUser({ userId, purpose: "hermesos_lock" }),
  ]);

  if (creditResult.status === "not_configured") {
    return { status: "not_configured" as const };
  }

  const activeTokenLockCredential = await activeLegacyHermesLockCredential(userId, tokenLockCredential);
  const custodyMode = activeTokenLockCredential ? "legacy_custody" : "self_custody";

  return {
    status: activeTokenLockCredential ? "existing" : "self_custody_required",
    custodyMode,
    wallet: creditResult.wallet,
    bankrWallet: creditResult.bankrWallet,
    depositWallet: bankrDepositWalletPublicSummary(creditResult.credential),
    creditDepositWallet: bankrDepositWalletPublicSummary(creditResult.credential),
    tokenLockWallet: bankrDepositWalletPublicSummary(activeTokenLockCredential),
  };
}

export async function GET() {
  let userIdForLog: string | null = null;
  try {
    if (!isBillingV2ServerEnabled()) {
      return apiError(BILLING_V2_UNAVAILABLE_MESSAGE, 404);
    }

    const { userId } = await auth();
    userIdForLog = userId ?? null;
    if (!userId) return apiError("Unauthorized", 401);
    if (!supabaseAdmin) return apiError("Database not configured", 500);

    return apiSuccess(await loadBankrWalletStatus(userId));
  } catch (error) {
    return apiError("Failed to load Bankr wallet", 500, {
      failureType: "bankr_wallet_status_failed",
      errorName: error instanceof Error ? error.name : typeof error,
    }, undefined, {
      ...ROUTE_CONTEXT,
      method: "GET",
      userId: userIdForLog,
      failureType: "bankr_wallet_status_failed",
      cause: error,
    });
  }
}

export async function POST() {
  let userIdForLog: string | null = null;
  try {
    if (!isBillingV2ServerEnabled()) {
      return apiError(BILLING_V2_UNAVAILABLE_MESSAGE, 404);
    }

    const { userId } = await auth();
    userIdForLog = userId ?? null;
    if (!userId) return apiError("Unauthorized", 401);
    if (!supabaseAdmin) return apiError("Database not configured", 500);

    const result = await provisionCreditDepositWalletStatus(userId);
    if (result.status === "not_configured") {
      return apiError("Bankr credit wallet provisioning is not configured", 503, {
        failureType: "bankr_credit_wallet_not_configured",
      });
    }

    return apiSuccess(result);
  } catch (error) {
    if (error instanceof BankrPartnerResponseError) {
      return apiError("Bankr credit wallet provisioning is temporarily unavailable", 503, {
        failureType: "bankr_credit_wallet_partner_error",
      }, undefined, {
        ...ROUTE_CONTEXT,
        method: "POST",
        userId: userIdForLog,
        failureType: "bankr_credit_wallet_partner_error",
        logLevel: "warn",
        metadata: {
          bankrOperation: error.operation,
          bankrStatus: error.status,
          bankrResponseBodySnippet: error.responseBody?.slice(0, 400) ?? null,
        },
      });
    }

    return apiError("Failed to load Bankr wallet status", 500, {
      failureType: "bankr_wallet_status_failed",
      errorName: error instanceof Error ? error.name : typeof error,
    }, undefined, {
      ...ROUTE_CONTEXT,
      method: "POST",
      userId: userIdForLog,
      failureType: "bankr_wallet_status_failed",
      cause: error,
    });
  }
}
