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
import {
  fetchTokenBalance,
  getLatestHermesTokenHoldingSnapshotForWallet,
  platformTokenBalanceConfig,
} from "@/lib/billing/token-holdings";
import { getActiveHivraToken } from "@/lib/billing/token-registry";
import { log } from "@/lib/logger";
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

interface TokenLockHivraBalance {
  tokenSymbol: string;
  tokenAddress: string;
  tokenDecimals: number;
  balanceRaw: string;
  balanceDisplay: string;
}

/**
 * The lock wallet's live $HIVRA balance, once $HIVRA is live. Some lock
 * wallets receive the holder airdrop at the same address; this is what lets
 * their owners see it and withdraw it. Null while $HIVRA is dormant (nothing
 * is read), with no lock wallet, or when the read fails (logged; the page
 * still loads).
 */
async function lockWalletHivraBalance(
  userId: string,
  credential: BankrDepositWalletCredential | null
): Promise<TokenLockHivraBalance | null> {
  const hivra = getActiveHivraToken();
  if (!hivra || !credential) return null;
  try {
    const balance = await fetchTokenBalance({
      token: platformTokenBalanceConfig(hivra),
      walletAddress: credential.normalizedEvmAddress,
    });
    return {
      tokenSymbol: hivra.symbol,
      tokenAddress: hivra.address,
      tokenDecimals: hivra.decimals,
      balanceRaw: balance.balanceRaw,
      balanceDisplay: balance.balanceDisplay,
    };
  } catch (error) {
    log.warn("lock wallet $HIVRA balance read failed", {
      ...ROUTE_CONTEXT,
      userId,
      failureType: "bankr_lock_wallet_hivra_balance_failed",
    }, error);
    return null;
  }
}

/**
 * The lock wallet the page shows, plus its $HIVRA balance once $HIVRA is live.
 * A lock wallet that holds only $HIVRA still shows, so its owner can withdraw
 * it, but it is not legacy custody: custody (and every $HermesOS panel) follows
 * the lock wallet's $HermesOS alone, and `tokenLockHoldsHermes` tells the page
 * whether to offer the $HermesOS withdraw. While $HIVRA is dormant this is
 * exactly the $HermesOS-only check and the response gains no field.
 */
async function lockWalletState(userId: string, credential: BankrDepositWalletCredential | null) {
  const [hermesCredential, hivraBalance] = await Promise.all([
    activeLegacyHermesLockCredential(userId, credential),
    lockWalletHivraBalance(userId, credential),
  ]);
  const holdsHivra = Boolean(hivraBalance && BigInt(hivraBalance.balanceRaw) > 0n);
  const holdsHermes = Boolean(hermesCredential);
  return {
    activeCredential: hermesCredential ?? (holdsHivra ? credential : null),
    custodyMode: holdsHermes ? ("legacy_custody" as const) : ("self_custody" as const),
    status: holdsHermes ? ("existing" as const) : ("self_custody_required" as const),
    hivraFields: getActiveHivraToken()
      ? { tokenLockHivra: holdsHivra ? hivraBalance : null, tokenLockHoldsHermes: holdsHermes }
      : {},
  };
}

async function loadBankrWalletStatus(userId: string) {
  const [wallet, creditCredential, tokenLockCredential] = await Promise.all([
    getBankrWalletForUser({ userId, purpose: "credit_deposit" }),
    getBankrDepositWalletCredentialForUser({ userId, purpose: "credit_deposit" }),
    getBankrDepositWalletCredentialForUser({ userId, purpose: "hermesos_lock" }),
  ]);
  const lock = await lockWalletState(userId, tokenLockCredential);
  const activeTokenLockCredential = lock.activeCredential;

  return {
    status: lock.status,
    custodyMode: lock.custodyMode,
    wallet,
    depositWallet: bankrDepositWalletPublicSummary(creditCredential),
    creditDepositWallet: bankrDepositWalletPublicSummary(creditCredential),
    tokenLockWallet: bankrDepositWalletPublicSummary(activeTokenLockCredential),
    ...lock.hivraFields,
  };
}

async function provisionCreditDepositWalletStatus(userId: string) {
  const [creditResult, tokenLockCredential] = await Promise.all([
    ensureBankrDepositWalletForUser({
      userId,
      purpose: "credit_deposit",
    }),
    getBankrDepositWalletCredentialForUser({ userId, purpose: "hermesos_lock" }),
  ]);

  if (creditResult.status === "not_configured") {
    return { status: "not_configured" as const };
  }

  const lock = await lockWalletState(userId, tokenLockCredential);
  const activeTokenLockCredential = lock.activeCredential;

  return {
    status: lock.status,
    custodyMode: lock.custodyMode,
    wallet: creditResult.wallet,
    bankrWallet: creditResult.bankrWallet,
    depositWallet: bankrDepositWalletPublicSummary(creditResult.credential),
    creditDepositWallet: bankrDepositWalletPublicSummary(creditResult.credential),
    tokenLockWallet: bankrDepositWalletPublicSummary(activeTokenLockCredential),
    ...lock.hivraFields,
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
