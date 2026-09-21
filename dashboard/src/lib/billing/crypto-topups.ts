import { randomUUID } from "crypto";
import { supabaseAdmin } from "@/lib/supabase";
import { metadataRecord, requireDb } from "@/lib/billing/db-utils";
import {
  BASE_CHAIN_ID,
  formatRawTokenBalance,
  HERMESOS_TOKEN_ADDRESS,
  HERMESOS_TOKEN_DECIMALS,
  HERMESOS_TOKEN_SYMBOL,
  normalizeEvmAddress,
} from "@/lib/billing/token-holdings";
import {
  CREDIT_UNIT_LABEL,
  appendCreditLedgerEntry,
  type TopUpPackageCredits,
  isTopUpPackageCredits,
} from "@/lib/billing/credits";
import {
  assertNoActiveCryptoPaymentSession,
  CRYPTO_PAYMENT_SESSION_TIMEOUT_MS,
} from "@/lib/billing/crypto-payment-sessions";

type QueryError = { message?: string } | null;

type DbSelectFilter = {
  select: (...args: unknown[]) => DbSelectFilter;
  eq: (...args: unknown[]) => DbSelectFilter;
  maybeSingle: () => Promise<{ data: unknown; error: QueryError }>;
};

type DbUpdateFilter = {
  eq: (...args: unknown[]) => DbUpdateFilter;
  then: Promise<{ error: QueryError }>["then"];
};

type DbTable = {
  upsert: (...args: unknown[]) => Promise<{ error: QueryError }>;
  select: (...args: unknown[]) => DbSelectFilter;
  update: (...args: unknown[]) => DbUpdateFilter;
};

type SupabaseLike = {
  from: (name: string) => unknown;
};

export const USDC_BASE_TOKEN_ADDRESS = normalizeEvmAddress(
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
);

export const CRYPTO_TOPUP_ASSETS = {
  usdc_base: {
    key: "usdc_base",
    label: "USDC on Base",
    symbol: "USDC",
    chainId: BASE_CHAIN_ID,
    network: "Base",
    tokenAddress: USDC_BASE_TOKEN_ADDRESS,
    tokenDecimals: 6,
    topUpEnabled: true,
    pricingMode: "usd_pegged",
  },
  hermesos_base: {
    key: "hermesos_base",
    label: "$HermesOS on Base",
    symbol: HERMESOS_TOKEN_SYMBOL,
    chainId: BASE_CHAIN_ID,
    network: "Base",
    tokenAddress: HERMESOS_TOKEN_ADDRESS,
    tokenDecimals: HERMESOS_TOKEN_DECIMALS,
    topUpEnabled: false,
    pricingMode: "manual_quote_required",
  },
} as const;

export type CryptoTopUpAssetKey = keyof typeof CRYPTO_TOPUP_ASSETS;

interface DepositWallet {
  address: string;
  bankrWalletId?: string | null;
}

export interface CryptoTopUpIntent {
  referenceId: string;
  status: "pending";
  provider: "bankr";
  packageCredits: TopUpPackageCredits;
  creditUnit: string;
  asset: typeof CRYPTO_TOPUP_ASSETS[CryptoTopUpAssetKey];
  amountMinor: number;
  amountDisplay: string;
  depositAddress: string;
  bankrWalletId: string | null;
}

interface PaymentTransactionRow {
  id: string;
  user_id: string;
  provider: "bankr";
  provider_reference_id: string;
  status: "pending" | "succeeded" | "failed" | "refunded";
  asset: string;
  amount_minor: number;
  package_credits: number | null;
  metadata: unknown;
}

function table(db: SupabaseLike, name: string): DbTable {
  return db.from(name) as DbTable;
}

export function isCryptoTopUpAssetKey(value: unknown): value is CryptoTopUpAssetKey {
  return typeof value === "string" && value in CRYPTO_TOPUP_ASSETS;
}

export function getCryptoTopUpAssets() {
  return Object.values(CRYPTO_TOPUP_ASSETS);
}

export function cryptoCreditsToUsdcMinorUnits(credits: TopUpPackageCredits): number {
  return credits * 10_000;
}

export async function createCryptoTopUpIntent(params: {
  userId: string;
  asset: CryptoTopUpAssetKey;
  packageCredits: number;
  depositWallet: DepositWallet;
  db?: SupabaseLike | null;
  referenceId?: string;
  now?: Date;
}): Promise<CryptoTopUpIntent> {
  if (!params.userId.trim()) {
    throw new Error("Crypto top-up user ID is required");
  }

  if (!isTopUpPackageCredits(params.packageCredits)) {
    throw new Error("Invalid credit top-up package");
  }

  if (!isCryptoTopUpAssetKey(params.asset)) {
    throw new Error("Unsupported crypto top-up asset");
  }

  const asset = CRYPTO_TOPUP_ASSETS[params.asset];
  if (!asset.topUpEnabled) {
    throw new Error("Crypto top-up asset is not enabled for automatic credit top-ups yet");
  }

  const admin = requireDb(params.db ?? supabaseAdmin);
  const depositAddress = normalizeEvmAddress(params.depositWallet.address);
  const now = params.now ?? new Date();
  await assertNoActiveCryptoPaymentSession({
    userId: params.userId,
    db: admin,
    now,
  });

  const referenceId = params.referenceId ?? `bankr_crypto_topup:${randomUUID()}`;
  const amountMinor = cryptoCreditsToUsdcMinorUnits(params.packageCredits);
  const amountDisplay = formatRawTokenBalance(String(amountMinor), asset.tokenDecimals);
  const bankrWalletId = params.depositWallet.bankrWalletId?.trim() || null;
  const sessionExpiresAt = new Date(now.getTime() + CRYPTO_PAYMENT_SESSION_TIMEOUT_MS);

  const result = await table(admin, "payment_transactions").upsert(
    {
      user_id: params.userId,
      provider: "bankr",
      provider_reference_id: referenceId,
      idempotency_reference: referenceId,
      status: "pending",
      asset: asset.key,
      amount_minor: amountMinor,
      package_credits: params.packageCredits,
      metadata: {
        type: "crypto_topup_intent",
        chainId: asset.chainId,
        network: asset.network,
        tokenAddress: asset.tokenAddress,
        tokenSymbol: asset.symbol,
        tokenDecimals: asset.tokenDecimals,
        amountDisplay,
        depositAddress,
        bankrWalletId,
        creditUnit: CREDIT_UNIT_LABEL,
        createdAt: now.toISOString(),
        sessionExpiresAt: sessionExpiresAt.toISOString(),
        creditGrantStatus: "pending_detection",
      },
      updated_at: now.toISOString(),
    },
    { onConflict: "provider,provider_reference_id" }
  );

  if (result.error) {
    throw new Error(result.error.message || "Failed to create crypto top-up intent");
  }

  return {
    referenceId,
    status: "pending",
    provider: "bankr",
    packageCredits: params.packageCredits,
    creditUnit: CREDIT_UNIT_LABEL,
    asset,
    amountMinor,
    amountDisplay,
    depositAddress,
    bankrWalletId,
  };
}

export async function settleCryptoTopUpIntent(params: {
  referenceId: string;
  actor?: string;
  transactionHash?: string | null;
  detectedAt?: string | null;
  db?: SupabaseLike | null;
  now?: Date;
}) {
  const referenceId = params.referenceId.trim();
  if (!referenceId) {
    throw new Error("Crypto top-up reference ID is required");
  }

  const admin = requireDb(params.db ?? supabaseAdmin);
  const actor = params.actor?.trim() || "bankr_reconciler";
  const now = params.now ?? new Date();
  const { data, error } = await table(admin, "payment_transactions")
    .select("id, user_id, provider, provider_reference_id, status, asset, amount_minor, package_credits, metadata")
    .eq("provider", "bankr")
    .eq("provider_reference_id", referenceId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message || "Failed to load crypto top-up intent");
  }

  if (!data) {
    return { status: "not_found" as const };
  }

  const payment = data as PaymentTransactionRow;
  if (payment.status !== "pending" && payment.status !== "succeeded") {
    return {
      status: "not_settleable" as const,
      paymentStatus: payment.status,
    };
  }

  if (
    typeof payment.package_credits !== "number" ||
    !isTopUpPackageCredits(payment.package_credits)
  ) {
    throw new Error("Crypto top-up intent has an invalid credit package");
  }
  const packageCredits = payment.package_credits;

  if (!payment.user_id.trim()) {
    throw new Error("Crypto top-up intent has no user");
  }

  const transactionHash = params.transactionHash?.trim() || null;
  const metadata = {
    ...metadataRecord(payment.metadata),
    creditGrantStatus: "granted",
    settlement: {
      actor,
      transactionHash,
      detectedAt: params.detectedAt || null,
      settledAt: now.toISOString(),
    },
  };
  // Credit the user FIRST, then mark the payment succeeded. The reverse order
  // (mark succeeded → credit) is unsafe: if the ledger insert dies after the
  // payment row flips to `succeeded`, the reconciler (crypto-reconciliation.ts)
  // only re-picks `pending` rows, so the user stays paid-but-uncredited
  // forever. `appendCreditLedgerEntry` is idempotent on
  // (user_id, reason, reference_id) so a redelivered settlement is a no-op.
  const grant = await appendCreditLedgerEntry(
    {
      userId: payment.user_id,
      amountCredits: packageCredits,
      source: "bankr",
      actor,
      reason: "crypto_topup",
      referenceId,
      metadata: {
        paymentTransactionId: payment.id,
        asset: payment.asset,
        amountMinor: payment.amount_minor,
        transactionHash,
        detectedAt: params.detectedAt || null,
      },
    },
    admin
  );

  const updateResult = await table(admin, "payment_transactions")
    .update({
      status: "succeeded",
      metadata,
      updated_at: now.toISOString(),
    })
    .eq("provider", "bankr")
    .eq("provider_reference_id", referenceId);

  if (updateResult.error) {
    throw new Error(updateResult.error.message || "Failed to update crypto top-up intent");
  }

  return {
    status: "settled" as const,
    inserted: grant.inserted,
    balance: grant.balance,
  };
}
