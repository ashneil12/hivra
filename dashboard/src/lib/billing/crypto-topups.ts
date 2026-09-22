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
  cryptoTopUpSessionExpiresAt,
} from "@/lib/billing/crypto-payment-sessions";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";

type QueryError = { code?: string; message?: string } | null;

type DbQuery = {
  select: (...args: unknown[]) => DbQuery;
  eq: (...args: unknown[]) => DbQuery;
  in: (...args: unknown[]) => DbQuery;
  is: (...args: unknown[]) => DbQuery;
  gt: (...args: unknown[]) => DbQuery;
  order: (...args: unknown[]) => DbQuery;
  limit: (...args: unknown[]) => DbQuery;
  maybeSingle: () => Promise<{ data: unknown; error: QueryError }>;
  then: Promise<{ data?: unknown; error: QueryError }>["then"];
};

type DbTable = {
  upsert: (...args: unknown[]) => Promise<{ error: QueryError }>;
  insert: (...args: unknown[]) => DbQuery;
  select: (...args: unknown[]) => DbQuery;
  update: (...args: unknown[]) => DbQuery;
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

// A transfer mined after the 20-minute payment window but within this grace is
// still attributed to the intent: USDC is USD-pegged, so a late exact payment
// is credited like an on-time one. Once the window + grace has been scanned at
// full confirmations with nothing to credit, the reconciler closes the intent.
export const CRYPTO_TOPUP_LATE_PAYMENT_GRACE_MS = 2 * 60 * 60_000;

// `metadata.failureType` of an intent closed because its payment window passed
// with no payment. Intents the old session helper flipped to 'failed' carry it
// too, without `reconciliationClosedAt`: those were never checked on chain.
export const CRYPTO_TOPUP_SESSION_EXPIRED_FAILURE = "crypto_payment_session_expired";
export const CRYPTO_TOPUP_MANUAL_REVIEW_FAILURE = "crypto_topup_manual_review";

// Why a received transfer was surfaced to crypto_topup_reconciliation_items
// instead of being credited automatically.
export const CRYPTO_TOPUP_REVIEW_REASONS = {
  underpaid: "underpaid",
  overpaid: "overpaid",
  extraTransfer: "extra_transfer",
  replayedAfterSettlement: "replayed_after_settlement",
  intentClosedDuringSettlement: "intent_closed_during_settlement",
} as const;

export type CryptoTopUpReviewReason =
  (typeof CRYPTO_TOPUP_REVIEW_REASONS)[keyof typeof CRYPTO_TOPUP_REVIEW_REASONS];

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

export interface CryptoTopUpPaymentRow {
  id: string;
  user_id: string;
  provider: string;
  provider_reference_id: string;
  status: "pending" | "succeeded" | "failed" | "refunded";
  asset: string;
  amount_minor: number;
  package_credits: number | null;
  metadata: unknown;
  created_at?: string | null;
  updated_at?: string | null;
}

// One on-chain USDC transfer offered to settlement. Settlement only ever
// credits a transfer it has claimed in crypto_deposit_receipts.
export interface CryptoTopUpTransfer {
  transactionHash: string;
  logIndex: number;
  blockNumber: number;
  blockHash?: string | null;
  amountRaw: string;
  confirmations: number;
  // Block timestamp (ISO).
  observedAt: string;
}

interface ReceiptRow {
  id: string;
  reference_id: string;
  payment_transaction_id: string | null;
  tx_hash: string;
  log_index: number;
  block_number: number;
  block_hash: string | null;
  amount_minor: number | string;
  confirmations: number;
  status: string;
  metadata: unknown;
  detected_at: string | null;
}

export type CryptoTopUpSettlementResult =
  | {
      status: "settled";
      referenceId: string;
      transactionHash: string;
      // False when the credit already existed (an idempotent redelivery).
      inserted: boolean;
      balance: number | null;
    }
  | { status: "not_found"; referenceId: string }
  | { status: "not_settleable"; referenceId: string; paymentStatus: string }
  | { status: "amount_mismatch"; referenceId: string }
  | { status: "transaction_already_claimed"; referenceId: string; transactionHash: string }
  | { status: "intent_closed"; referenceId: string; paymentStatus: string };

const PAYMENT_COLUMNS =
  "id, user_id, provider, provider_reference_id, status, asset, amount_minor, package_credits, metadata, created_at, updated_at";
const RECEIPT_COLUMNS =
  "id, reference_id, payment_transaction_id, tx_hash, log_index, block_number, block_hash, amount_minor, confirmations, status, metadata, detected_at";

function table(db: SupabaseLike, name: string): DbTable {
  return db.from(name) as DbTable;
}

function affectedRowCount(data: unknown) {
  return Array.isArray(data) ? data.length : data ? 1 : 0;
}

function readDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
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

export function cryptoTopUpTransferKey(transactionHash: string, logIndex: number) {
  return `${transactionHash.trim().toLowerCase()}:${logIndex}`;
}

/**
 * The span of chain time a top-up intent owns: from its creation to the end of
 * its session plus the late-payment grace. The start is the earlier of the
 * app-side and database creation stamps, so no transfer the user could have
 * sent for this intent falls before it.
 */
export function cryptoTopUpIntentWindow(row: Pick<CryptoTopUpPaymentRow, "metadata" | "created_at" | "updated_at">) {
  const metadata = metadataRecord(row.metadata);
  const starts = [readDate(metadata.createdAt), readDate(row.created_at)].filter(
    (date): date is Date => date !== null
  );
  const start = starts.length ? new Date(Math.min(...starts.map((date) => date.getTime()))) : null;
  if (!start) {
    throw new Error("Crypto top-up intent has no creation time");
  }
  const expiresAt = cryptoTopUpSessionExpiresAt(row);
  return {
    // Block timestamps are whole seconds: floor so a transfer mined in the
    // same second the intent was created still belongs to it.
    startMs: Math.floor(start.getTime() / 1000) * 1000,
    expiresAtMs: expiresAt.getTime(),
    graceEndMs: expiresAt.getTime() + CRYPTO_TOPUP_LATE_PAYMENT_GRACE_MS,
  };
}

/**
 * An intent the reconciler still owns: pending, or expired by the old session
 * helper without ever being checked on chain.
 */
export function isOpenCryptoTopUpIntent(row: Pick<CryptoTopUpPaymentRow, "status" | "metadata">) {
  if (row.status === "pending") return true;
  const metadata = metadataRecord(row.metadata);
  return (
    row.status === "failed" &&
    metadata.failureType === CRYPTO_TOPUP_SESSION_EXPIRED_FAILURE &&
    !metadata.reconciliationClosedAt
  );
}

// Settlement may credit an open intent, or one closed as expired: the transfer
// itself is verified and claimed, so a late run can still pay the user.
function isSettleableIntent(row: CryptoTopUpPaymentRow) {
  if (row.status === "pending") return true;
  return (
    row.status === "failed" &&
    metadataRecord(row.metadata).failureType === CRYPTO_TOPUP_SESSION_EXPIRED_FAILURE
  );
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

// ── Loading ───────────────────────────────────────────────────────────────

export async function loadCryptoTopUpPayment(
  db: SupabaseLike,
  referenceId: string
): Promise<CryptoTopUpPaymentRow | null> {
  const { data, error } = await table(db, "payment_transactions")
    .select(PAYMENT_COLUMNS)
    .eq("provider", "bankr")
    .eq("provider_reference_id", referenceId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message || "Failed to load crypto top-up intent");
  }
  return (data as CryptoTopUpPaymentRow | null) ?? null;
}

async function loadReceiptForIntent(db: SupabaseLike, referenceId: string): Promise<ReceiptRow | null> {
  const { data, error } = await table(db, "crypto_deposit_receipts")
    .select(RECEIPT_COLUMNS)
    .eq("provider", "bankr")
    .eq("reference_id", referenceId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message || "Failed to load crypto deposit receipt");
  }
  return (data as ReceiptRow | null) ?? null;
}

/**
 * Transfer keys (`tx:logIndex`) already claimed by a receipt, optionally
 * ignoring one intent's own claim. A claimed transfer is accounted for and is
 * never attributed, credited or surfaced again.
 */
export async function loadClaimedCryptoTopUpTransferKeys(
  db: SupabaseLike,
  transfers: Array<{ transactionHash: string; logIndex: number }>,
  options: { ignoreReferenceId?: string } = {}
): Promise<Set<string>> {
  const claimed = new Set<string>();
  if (transfers.length === 0) return claimed;
  const hashes = Array.from(
    new Set(transfers.flatMap(({ transactionHash }) => [transactionHash, transactionHash.toLowerCase()]))
  );
  const { data, error } = await table(db, "crypto_deposit_receipts")
    .select("reference_id, tx_hash, log_index")
    .eq("chain_id", BASE_CHAIN_ID)
    .in("tx_hash", hashes);

  if (error) {
    throw new Error(error.message || "Failed to load claimed crypto deposit transfers");
  }
  for (const row of (Array.isArray(data) ? data : []) as Array<{
    reference_id?: string | null;
    tx_hash?: string | null;
    log_index?: number | null;
  }>) {
    if (options.ignoreReferenceId && row.reference_id === options.ignoreReferenceId) continue;
    if (typeof row.tx_hash === "string" && typeof row.log_index === "number") {
      claimed.add(cryptoTopUpTransferKey(row.tx_hash, row.log_index));
    }
  }
  return claimed;
}

// ── Review items ─────────────────────────────────────────────────────────

/**
 * Surface a received transfer that automation will not credit, once per
 * transfer: the dedupe key makes a repeat insert (every cron tick, a bearer
 * redelivery) a 23505 that means "already surfaced". Each new item is also
 * reported to the ops feed.
 */
export async function surfaceCryptoTopUpTransfer(
  params: {
    payment: CryptoTopUpPaymentRow;
    transfer: CryptoTopUpTransfer;
    reason: CryptoTopUpReviewReason;
  },
  db: SupabaseLike | null | undefined = supabaseAdmin
): Promise<"surfaced" | "already_surfaced"> {
  const client = requireDb(db);
  const { payment, transfer, reason } = params;
  const transactionHash = transfer.transactionHash.trim().toLowerCase();
  const depositAddress = metadataRecord(payment.metadata).depositAddress;
  const { error } = await table(client, "crypto_topup_reconciliation_items").insert({
    user_id: payment.user_id,
    payment_transaction_id: payment.id,
    reference_id: payment.provider_reference_id,
    reason,
    status: "open",
    chain_id: BASE_CHAIN_ID,
    token_address: USDC_BASE_TOKEN_ADDRESS,
    deposit_address: typeof depositAddress === "string" ? normalizeEvmAddress(depositAddress) : null,
    tx_hash: transactionHash,
    log_index: transfer.logIndex,
    block_number: transfer.blockNumber,
    observed_amount_minor: transfer.amountRaw,
    expected_amount_minor: payment.amount_minor,
    observed_at: transfer.observedAt,
    dedupe_key: `crypto_topup_transfer:${BASE_CHAIN_ID}:${cryptoTopUpTransferKey(transactionHash, transfer.logIndex)}`,
    metadata: {
      confirmations: transfer.confirmations,
      paymentStatus: payment.status,
      packageCredits: payment.package_credits,
    },
  });

  if (error?.code === "23505") return "already_surfaced";
  if (error) {
    throw new Error(error.message || "Failed to create crypto top-up reconciliation item");
  }

  await reportOpsEvent({
    source: "billing.crypto-topups",
    severity: "warn",
    title: "USDC top-up needs manual review",
    message:
      "A USDC transfer to a top-up deposit wallet was received but not credited automatically. " +
      "Review crypto_topup_reconciliation_items and credit or refund it.",
    userId: payment.user_id,
    metadata: {
      reason,
      referenceId: payment.provider_reference_id,
      transactionHash,
      logIndex: transfer.logIndex,
      observedAmountMinor: transfer.amountRaw,
      expectedAmountMinor: payment.amount_minor,
    },
  });
  return "surfaced";
}

async function surfaceUnlessClaimed(
  db: SupabaseLike,
  payment: CryptoTopUpPaymentRow,
  transfer: CryptoTopUpTransfer,
  reason: CryptoTopUpReviewReason
) {
  const claimed = await loadClaimedCryptoTopUpTransferKeys(db, [transfer]);
  if (claimed.has(cryptoTopUpTransferKey(transfer.transactionHash, transfer.logIndex))) return;
  await surfaceCryptoTopUpTransfer({ payment, transfer, reason }, db);
}

// ── Retirement ───────────────────────────────────────────────────────────

/**
 * Close an intent whose window + grace was fully scanned with nothing to
 * credit: 'expired' when nothing arrived, 'manual_review' when non-exact
 * transfers arrived (each already surfaced as an item). Compare-and-set on the
 * status the reconciler read, so a concurrent settlement always wins.
 */
export async function retireCryptoTopUpIntent(
  params: {
    payment: CryptoTopUpPaymentRow;
    outcome: "expired" | "manual_review";
    observedTotalMinor?: string | null;
    now: Date;
  },
  db: SupabaseLike | null | undefined = supabaseAdmin
): Promise<{ retired: boolean }> {
  const client = requireDb(db);
  const { payment, outcome, now } = params;
  const nowIso = now.toISOString();
  const metadata = metadataRecord(payment.metadata);
  const expiresAt = cryptoTopUpSessionExpiresAt(payment).toISOString();
  const { data, error } = await table(client, "payment_transactions")
    .update({
      status: "failed",
      metadata: {
        ...metadata,
        creditGrantStatus: outcome,
        failureType:
          outcome === "expired" ? CRYPTO_TOPUP_SESSION_EXPIRED_FAILURE : CRYPTO_TOPUP_MANUAL_REVIEW_FAILURE,
        sessionExpiresAt: metadata.sessionExpiresAt ?? expiresAt,
        expiredAt: metadata.expiredAt ?? nowIso,
        reconciliationClosedAt: nowIso,
        ...(params.observedTotalMinor ? { observedTotalMinor: Number(params.observedTotalMinor) } : {}),
      },
      updated_at: nowIso,
    })
    .eq("provider", "bankr")
    .eq("provider_reference_id", payment.provider_reference_id)
    .eq("status", payment.status)
    .select("id");

  if (error) {
    throw new Error(error.message || "Failed to close crypto top-up intent");
  }
  return { retired: affectedRowCount(data) > 0 };
}

// ── Settlement ───────────────────────────────────────────────────────────

function receiptTransfer(receipt: ReceiptRow): CryptoTopUpTransfer {
  return {
    transactionHash: receipt.tx_hash,
    logIndex: receipt.log_index,
    blockNumber: Number(receipt.block_number),
    blockHash: receipt.block_hash,
    amountRaw: String(receipt.amount_minor),
    confirmations: receipt.confirmations,
    observedAt: String(metadataRecord(receipt.metadata).blockTimestamp ?? receipt.detected_at ?? ""),
  };
}

function sameTransfer(receipt: ReceiptRow, transfer: CryptoTopUpTransfer) {
  return (
    cryptoTopUpTransferKey(receipt.tx_hash, receipt.log_index) ===
    cryptoTopUpTransferKey(transfer.transactionHash, transfer.logIndex)
  );
}

type ClaimOutcome =
  | { status: "claimed"; receipt: ReceiptRow }
  | { status: "transaction_already_claimed" };

/**
 * Claim-first: bind the transfer to this intent in crypto_deposit_receipts
 * BEFORE any credit. unique (chain_id, tx_hash, log_index) makes one transfer
 * fund at most one intent; unique (provider, reference_id) makes one intent
 * hold at most one transfer. An intent that already holds a claim keeps it —
 * a receipt is never rewritten to another transfer.
 */
async function claimTransfer(
  db: SupabaseLike,
  payment: CryptoTopUpPaymentRow,
  transfer: CryptoTopUpTransfer,
  now: Date
): Promise<ClaimOutcome> {
  const nowIso = now.toISOString();
  const depositAddress = normalizeEvmAddress(String(metadataRecord(payment.metadata).depositAddress ?? ""));
  const { error } = await table(db, "crypto_deposit_receipts").insert({
    user_id: payment.user_id,
    payment_transaction_id: payment.id,
    provider: "bankr",
    reference_id: payment.provider_reference_id,
    chain_id: BASE_CHAIN_ID,
    token_address: USDC_BASE_TOKEN_ADDRESS,
    token_symbol: CRYPTO_TOPUP_ASSETS.usdc_base.symbol,
    token_decimals: CRYPTO_TOPUP_ASSETS.usdc_base.tokenDecimals,
    deposit_address: depositAddress,
    normalized_deposit_address: depositAddress,
    amount_minor: payment.amount_minor,
    tx_hash: transfer.transactionHash.trim().toLowerCase(),
    log_index: transfer.logIndex,
    block_number: transfer.blockNumber,
    block_hash: transfer.blockHash ?? null,
    confirmations: transfer.confirmations,
    status: "confirmed",
    metadata: {
      source: "base_rpc",
      creditGrantReference: payment.provider_reference_id,
      blockTimestamp: transfer.observedAt,
    },
    detected_at: nowIso,
    confirmed_at: nowIso,
    updated_at: nowIso,
  });

  if (error && error.code !== "23505") {
    throw new Error(error.message || "Failed to claim crypto deposit transfer");
  }
  // Inserted, or 23505: either this intent already holds a claim (resume on
  // it), or the transfer belongs to another intent.
  const receipt = await loadReceiptForIntent(db, payment.provider_reference_id);
  if (receipt) return { status: "claimed", receipt };
  return { status: "transaction_already_claimed" };
}

async function markReceipt(
  db: SupabaseLike,
  receipt: ReceiptRow,
  status: "settled" | "failed",
  now: Date,
  metadata: Record<string, unknown> = {}
) {
  const nowIso = now.toISOString();
  const { error } = await table(db, "crypto_deposit_receipts")
    .update({
      status,
      ...(status === "settled" ? { settled_at: nowIso } : {}),
      metadata: { ...metadataRecord(receipt.metadata), ...metadata },
      updated_at: nowIso,
    })
    .eq("id", receipt.id)
    .eq("status", receipt.status);

  if (error) {
    throw new Error(error.message || "Failed to update crypto deposit receipt");
  }
}

async function creditClaimedTransfer(
  db: SupabaseLike,
  payment: CryptoTopUpPaymentRow,
  receipt: ReceiptRow,
  actor: string,
  now: Date
) {
  if (typeof payment.package_credits !== "number" || !isTopUpPackageCredits(payment.package_credits)) {
    throw new Error("Crypto top-up intent has an invalid credit package");
  }
  // Idempotent on (source, reference_id, reason): a resumed settlement whose
  // credit already landed is a no-op here.
  const grant = await appendCreditLedgerEntry(
    {
      userId: payment.user_id,
      amountCredits: payment.package_credits,
      source: "bankr",
      actor,
      reason: "crypto_topup",
      referenceId: payment.provider_reference_id,
      metadata: {
        paymentTransactionId: payment.id,
        asset: payment.asset,
        amountMinor: payment.amount_minor,
        transactionHash: receipt.tx_hash,
        logIndex: receipt.log_index,
        detectedAt: now.toISOString(),
      },
    },
    db
  );
  if (receipt.status !== "settled") {
    await markReceipt(db, receipt, "settled", now);
  }
  return grant;
}

// The intent is already succeeded: finish a credit that died part-way, and
// never touch the settled transaction or metadata.
async function convergeSucceededIntent(
  db: SupabaseLike,
  payment: CryptoTopUpPaymentRow,
  transfer: CryptoTopUpTransfer,
  actor: string,
  now: Date
): Promise<CryptoTopUpSettlementResult> {
  const receipt = await loadReceiptForIntent(db, payment.provider_reference_id);
  const settlement = metadataRecord(metadataRecord(payment.metadata).settlement);
  if (!receipt) {
    // Settled before receipts were written for every credit (the old bearer
    // route). Nothing to credit; a different transfer is real money that was
    // not credited here.
    const settledHash = typeof settlement.transactionHash === "string" ? settlement.transactionHash : null;
    if (!settledHash || settledHash.toLowerCase() !== transfer.transactionHash.toLowerCase()) {
      await surfaceUnlessClaimed(db, payment, transfer, CRYPTO_TOPUP_REVIEW_REASONS.replayedAfterSettlement);
    }
    return {
      status: "settled",
      referenceId: payment.provider_reference_id,
      transactionHash: settledHash ?? transfer.transactionHash,
      inserted: false,
      balance: null,
    };
  }

  let inserted = false;
  let balance: number | null = null;
  if (receipt.status !== "settled") {
    const grant = await creditClaimedTransfer(db, payment, receipt, actor, now);
    inserted = grant.inserted;
    balance = grant.balance;
  }
  if (!sameTransfer(receipt, transfer)) {
    await surfaceUnlessClaimed(db, payment, transfer, CRYPTO_TOPUP_REVIEW_REASONS.replayedAfterSettlement);
  }
  return {
    status: "settled",
    referenceId: payment.provider_reference_id,
    transactionHash: receipt.tx_hash,
    inserted,
    balance,
  };
}

/**
 * Credit a top-up intent from a verified on-chain transfer.
 *
 * Order: claim the transfer (receipt, status 'confirmed') -> compare-and-set
 * the intent to 'succeeded' -> credit the ledger -> mark the receipt
 * 'settled'. Every step is idempotent, and a run that dies after the claim is
 * finished by the reconciler's recovery pass over 'confirmed' receipts, so a
 * paid intent can neither stay uncredited nor be credited twice. The intent
 * flip is a compare-and-set on the status read here: an intent an operator
 * refunded or closed meanwhile is left alone, credited nothing, and its
 * transfer surfaced for review.
 */
export async function settleCryptoTopUpIntent(params: {
  referenceId: string;
  transfer: CryptoTopUpTransfer;
  actor?: string;
  db?: SupabaseLike | null;
  now?: Date;
}): Promise<CryptoTopUpSettlementResult> {
  const referenceId = params.referenceId.trim();
  if (!referenceId) {
    throw new Error("Crypto top-up reference ID is required");
  }
  if (!params.transfer.transactionHash.trim()) {
    throw new Error("Crypto top-up transaction hash is required");
  }

  const db = requireDb(params.db ?? supabaseAdmin);
  const actor = params.actor?.trim() || "bankr_reconciler";
  const now = params.now ?? new Date();
  const transfer = {
    ...params.transfer,
    transactionHash: params.transfer.transactionHash.trim().toLowerCase(),
  };

  const payment = await loadCryptoTopUpPayment(db, referenceId);
  if (!payment) {
    return { status: "not_found", referenceId };
  }
  if (payment.status === "succeeded") {
    return convergeSucceededIntent(db, payment, transfer, actor, now);
  }
  if (!isSettleableIntent(payment)) {
    return { status: "not_settleable", referenceId, paymentStatus: payment.status };
  }
  if (!payment.user_id?.trim()) {
    throw new Error("Crypto top-up intent has no user");
  }
  if (typeof payment.package_credits !== "number" || !isTopUpPackageCredits(payment.package_credits)) {
    throw new Error("Crypto top-up intent has an invalid credit package");
  }
  if (BigInt(transfer.amountRaw) !== BigInt(payment.amount_minor)) {
    return { status: "amount_mismatch", referenceId };
  }

  const claim = await claimTransfer(db, payment, transfer, now);
  if (claim.status === "transaction_already_claimed") {
    log.warn("USDC top-up transfer already claimed by another intent", {
      source: "crypto-topups",
      failureType: "crypto_topup_transaction_already_claimed",
      referenceId,
      transactionHash: transfer.transactionHash,
    });
    return { status: "transaction_already_claimed", referenceId, transactionHash: transfer.transactionHash };
  }
  const { receipt } = claim;
  const claimed = receiptTransfer(receipt);

  const nowIso = now.toISOString();
  const previous = metadataRecord(payment.metadata);
  const rest = Object.fromEntries(Object.entries(previous).filter(([key]) => key !== "failureType"));
  const { data, error } = await table(db, "payment_transactions")
    .update({
      status: "succeeded",
      metadata: {
        ...rest,
        creditGrantStatus: "granted",
        ...(payment.status === "failed" ? { recoveredFromStatus: "failed", recoveredFailureType: previous.failureType } : {}),
        settlement: {
          actor,
          transactionHash: receipt.tx_hash,
          logIndex: receipt.log_index,
          blockNumber: Number(receipt.block_number),
          blockTimestamp: claimed.observedAt || null,
          detectedAt: nowIso,
          settledAt: nowIso,
        },
      },
      updated_at: nowIso,
    })
    .eq("provider", "bankr")
    .eq("provider_reference_id", referenceId)
    .eq("status", payment.status)
    .select("id");

  if (error) {
    throw new Error(error.message || "Failed to update crypto top-up intent");
  }

  if (affectedRowCount(data) === 0) {
    const current = await loadCryptoTopUpPayment(db, referenceId);
    if (current?.status === "succeeded") {
      // A concurrent settlement flipped it first: converge on its claim.
      return convergeSucceededIntent(db, current, transfer, actor, now);
    }
    // Refunded, reviewed or otherwise closed between our read and write:
    // release nothing, credit nothing, keep the claim so the transfer cannot
    // fund another intent, and hand it to an operator.
    const paymentStatus = current?.status ?? "missing";
    await markReceipt(db, receipt, "failed", now, { closedReason: "intent_closed_during_settlement", paymentStatus });
    await surfaceCryptoTopUpTransfer(
      { payment: current ?? payment, transfer: claimed, reason: CRYPTO_TOPUP_REVIEW_REASONS.intentClosedDuringSettlement },
      db
    );
    log.warn("USDC top-up intent changed during settlement; not credited", {
      source: "crypto-topups",
      failureType: "crypto_topup_intent_closed_during_settlement",
      referenceId,
      paymentStatus,
      transactionHash: receipt.tx_hash,
    });
    return { status: "intent_closed", referenceId, paymentStatus };
  }

  const grant = await creditClaimedTransfer(db, payment, receipt, actor, now);

  if (!sameTransfer(receipt, transfer)) {
    // This intent already held another transfer; the offered one was not
    // credited here.
    await surfaceUnlessClaimed(db, payment, transfer, CRYPTO_TOPUP_REVIEW_REASONS.extraTransfer);
  }

  return {
    status: "settled",
    referenceId,
    transactionHash: receipt.tx_hash,
    inserted: grant.inserted,
    balance: grant.balance,
  };
}

/**
 * Finish a claim whose settlement died part-way (receipt still 'confirmed').
 * The transfer was verified and attributed when it was claimed.
 */
export async function resumeClaimedCryptoTopUp(
  params: { receipt: ReceiptRow; db?: SupabaseLike | null; now?: Date; actor?: string }
): Promise<CryptoTopUpSettlementResult> {
  const db = requireDb(params.db ?? supabaseAdmin);
  const now = params.now ?? new Date();
  const result = await settleCryptoTopUpIntent({
    referenceId: params.receipt.reference_id,
    transfer: receiptTransfer(params.receipt),
    actor: params.actor,
    db,
    now,
  });
  if (result.status === "not_settleable") {
    // The intent was closed after the claim and before the flip.
    const payment = await loadCryptoTopUpPayment(db, params.receipt.reference_id);
    await markReceipt(db, params.receipt, "failed", now, {
      closedReason: "intent_closed_during_settlement",
      paymentStatus: result.paymentStatus,
    });
    if (payment) {
      await surfaceCryptoTopUpTransfer(
        {
          payment,
          transfer: receiptTransfer(params.receipt),
          reason: CRYPTO_TOPUP_REVIEW_REASONS.intentClosedDuringSettlement,
        },
        db
      );
    }
  }
  return result;
}

export async function listUnfinishedCryptoTopUpClaims(db: SupabaseLike, limit: number): Promise<ReceiptRow[]> {
  const { data, error } = await table(db, "crypto_deposit_receipts")
    .select(RECEIPT_COLUMNS)
    .eq("provider", "bankr")
    .eq("chain_id", BASE_CHAIN_ID)
    .eq("token_address", USDC_BASE_TOKEN_ADDRESS)
    .eq("status", "confirmed")
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) {
    throw new Error(error.message || "Failed to load unfinished crypto deposit claims");
  }
  return Array.isArray(data) ? (data as ReceiptRow[]) : [];
}

export type { ReceiptRow as CryptoTopUpReceiptRow };
