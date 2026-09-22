import { metadataRecord, requireDb } from "@/lib/billing/db-utils";
import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";
import {
  HERMESOS_TOKEN_DECIMALS,
  HERMESOS_TOKEN_SYMBOL,
} from "./token-holdings";
import { ensureManagedVeniceWalletAccount } from "./managed-venice-wallets";
import {
  MANAGED_VENICE_HIDDEN_USER_BONUS_CAP_MICRO_USD,
  MANAGED_VENICE_LAUNCH_BONUS_BPS,
  MANAGED_VENICE_STANDARD_BONUS_BPS,
  getManagedVeniceSupportEmail,
  getManagedVeniceTopUpQuoteMicroUsd,
  type ManagedVeniceTopUpQuoteMicroUsd,
} from "@/lib/venice/managed-credit-topup";
import {
  fetchHermesPriceCrossCheck,
  fetchHermesPriceUsd,
  isHermesPriceFresh,
  type HermesPriceCrossCheck,
  type HermesPriceQuote,
} from "./price-feed";

export const MANAGED_VENICE_QUOTE_LIFETIME_MS = 20 * 60_000;
export const MANAGED_VENICE_PRICE_MAX_AGE_MS = 5 * 60_000;
export const MANAGED_VENICE_PRICE_MAX_DISAGREEMENT_BPS = 500;

// ── Over-send handling ────────────────────────────────────────────────────
// A deposit that sends MORE tokens than the quote asked for is still real
// money the user paid us. Rather than dead-ending an over-send at
// `manual_review_required` (no credit, requires a human), we credit the user
// for what they ACTUALLY sent — pro-rata against the quote's snapshot price —
// and settle the quote normally, as long as the over-send is within a sane
// ceiling. Above the ceiling (a fat-finger 10x, a wrong-token transfer that
// happened to decode, etc.) we still route to manual review so an absurd
// auto-credit can never be minted. Under-payments are NEVER auto-settled:
// the user didn't pay for what they quoted, so those still go to review.
//
// Ceiling: observed must be <= quoted * MAX_OVERSEND_NUMERATOR /
// MAX_OVERSEND_DENOMINATOR. 2/1 == accept up to 100% over the quote.
export const MANAGED_VENICE_MAX_OVERSEND_NUMERATOR = 2n;
export const MANAGED_VENICE_MAX_OVERSEND_DENOMINATOR = 1n;

export type ManagedVeniceTokenQuoteStatus =
  | "active"
  | "settled"
  | "expired"
  | "manual_review_required"
  | "cancelled";

// Statuses a quote can still be settled, reviewed, or retired from. Every
// status transition below is a compare-and-set on this set, so a quote that is
// already settled / in review / cancelled can never be moved again.
const OPEN_QUOTE_STATUSES = ["active", "expired"] as const;

// Terminal statuses whose flip sets transfer_surfacing_pending: the reconciler
// keeps rescanning such a quote's range, surface-only, until every transfer
// that did not settle or review it has been surfaced at full confirmations.
export const MANAGED_VENICE_TRANSFER_SURFACING_STATUSES = ["settled", "manual_review_required"] as const;

// Reconciliation item reasons for token deposits. Every item for an on-chain
// transfer carries one dedupe key per transfer (see
// managedVeniceTokenTransferDedupeKey), so the same transfer is surfaced once
// regardless of which reason or code path saw it first.
export const MANAGED_VENICE_TOKEN_DEPOSIT_REASONS = {
  underpaid: "managed_venice_token_deposit_underpaid",
  amountMismatch: "managed_venice_token_deposit_amount_mismatch",
  outsideQuoteWindow: "managed_venice_token_deposit_outside_quote_window",
  replayedAfterSettlement: "managed_venice_token_deposit_replayed_after_settlement",
  extraTransfer: "managed_venice_token_deposit_extra_transfer",
  unattributedLateTransfer: "managed_venice_token_deposit_unattributed_late_transfer",
  // A transfer delivered for a quote already in review or cancelled that would
  // otherwise have qualified (in window, in band).
  afterQuoteClosed: "managed_venice_token_deposit_after_quote_closed",
  // A credited lot whose tx is already bound to a different quote (legacy
  // cross-quote capture), so this quote can never be flipped to settled.
  claimConflict: "managed_venice_token_deposit_claim_conflict",
  // An open quote that claimed a tx but has neither a lot nor readable claim
  // values: nothing says what to credit, so it goes to review instead of
  // failing every reconcile.
  claimUnrecoverable: "managed_venice_token_deposit_claim_unrecoverable",
} as const;

export type ManagedVeniceTokenDepositReason =
  (typeof MANAGED_VENICE_TOKEN_DEPOSIT_REASONS)[keyof typeof MANAGED_VENICE_TOKEN_DEPOSIT_REASONS];

type QueryError = { code?: string; message?: string } | null;

type DbChain = {
  select: (...args: unknown[]) => DbChain;
  eq: (...args: unknown[]) => DbChain;
  neq: (...args: unknown[]) => DbChain;
  in: (...args: unknown[]) => DbChain;
  order: (...args: unknown[]) => DbChain;
  limit: (...args: unknown[]) => DbChain;
  single: () => Promise<{ data: unknown; error: QueryError }>;
  maybeSingle: () => Promise<{ data: unknown; error: QueryError }>;
  then: Promise<{ data?: unknown; error: QueryError }>["then"];
};

type DbInsertChain = {
  select: (...args: unknown[]) => {
    single: () => Promise<{ data: unknown; error: QueryError }>;
  };
  then: Promise<{ data?: unknown; error: QueryError }>["then"];
};

// update(...).<filters>.select() resolves to the AFFECTED rows, which is how
// the compare-and-set transitions below detect a lost race (0 rows).
type DbUpdateFilter = {
  eq: (...args: unknown[]) => DbUpdateFilter;
  in: (...args: unknown[]) => DbUpdateFilter;
  is: (...args: unknown[]) => DbUpdateFilter;
  select: (...args: unknown[]) => PromiseLike<{ data?: unknown; error: QueryError }>;
  then: Promise<{ error: QueryError }>["then"];
};

type DbTable = {
  insert: (...args: unknown[]) => DbInsertChain;
  select: (...args: unknown[]) => DbChain;
  update: (...args: unknown[]) => DbUpdateFilter;
};

type SupabaseLike = {
  from: (table: string) => unknown;
};

interface TokenQuoteRow {
  id: string;
  account_id: string;
  user_id: string;
  token_amount_raw: string | number | bigint;
  snapshot_price_usd: string;
  locked_value_micro_usd: number;
  deposit_address: string;
  quoted_at: string;
  expires_at: string;
  status: ManagedVeniceTokenQuoteStatus;
  source: string;
  cross_check_source?: string | null;
  cross_check_price_usd?: string | null;
  price_last_updated_at?: string | null;
  cross_check_last_updated_at?: string | null;
  transaction_hash?: string | null;
  settled_at?: string | null;
  transfer_surfacing_pending?: boolean | null;
  metadata?: Record<string, unknown> | null;
}

export interface ManagedVeniceTokenQuote {
  id: string;
  accountId: string;
  userId: string;
  tokenAmountRaw: string;
  tokenSymbol: string;
  tokenDecimals: number;
  snapshotPriceUsd: string;
  lockedValueMicroUsd: number;
  depositAddress: string;
  quotedAt: string;
  expiresAt: string;
  status: ManagedVeniceTokenQuoteStatus;
  source: string;
  crossCheckSource: string | null;
  crossCheckPriceUsd: string | null;
  priceLastUpdatedAt: string | null;
  crossCheckLastUpdatedAt: string | null;
  transactionHash: string | null;
  settledAt: string | null;
  paidValueMicroUsd: number;
  creditValueMicroUsd: number;
  bonusValueMicroUsd: number;
  launchBonusMicroUsd: number;
  standardBonusMicroUsd: number;
  // The tx this quote durably claimed (step 1 of settlement) and the values it
  // will be credited with. Present while a claimed quote is being completed and
  // kept on settled quotes as the audit record of what was credited.
  settlementClaim?: ManagedVeniceTokenSettlementClaim | null;
  // Set in the same compare-and-set that settles the quote or sends it to
  // review; cleared once the reconciler's surface-only pass has covered the
  // quote's whole attribution range at full confirmations.
  transferSurfacingPending?: boolean;
  // Why and by which transfer the quote was sent to review (review metadata).
  manualReviewReason?: string | null;
  reviewTransactionHash?: string | null;
}

export interface ManagedVeniceTokenSettlementClaim {
  transactionHash: string;
  logIndex: number | null;
  tokenAmountRaw: string;
  observedAt: string;
  blockTimestamp: string | null;
  paidValueMicroUsd: number;
  creditValueMicroUsd: number;
  bonusValueMicroUsd: number;
  claimedAt: string;
}

const SELECT_COLUMNS =
  "id, account_id, user_id, token_amount_raw::text, snapshot_price_usd, " +
  "locked_value_micro_usd, deposit_address, quoted_at, expires_at, status, " +
  "source, cross_check_source, cross_check_price_usd, price_last_updated_at, " +
  "cross_check_last_updated_at, transaction_hash, settled_at, " +
  "transfer_surfacing_pending, metadata";

export class ManagedVeniceTokenQuotePriceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagedVeniceTokenQuotePriceError";
  }
}

// Thrown by the quote-creation flow when a deposit's projected bonus
// would push the user past their hidden lifetime bonus cap. Caller
// (the hermesos/quote route) catches it and returns a 403 with the
// support-email message so the user can email to extend their cap.
export class ManagedVeniceTopUpExceedsHiddenCapError extends Error {
  public readonly supportEmail: string;
  public readonly currentBonusUsedMicroUsd: number;
  public readonly capLimitMicroUsd: number;
  public readonly attemptedTotalBonusMicroUsd: number;
  public readonly maxAdditionalPaidMicroUsd: number;
  constructor(params: {
    supportEmail: string;
    currentBonusUsedMicroUsd: number;
    capLimitMicroUsd: number;
    attemptedTotalBonusMicroUsd: number;
    maxAdditionalPaidMicroUsd: number;
  }) {
    super("Managed Venice top-up would exceed the per-user lifetime bonus cap");
    this.name = "ManagedVeniceTopUpExceedsHiddenCapError";
    this.supportEmail = params.supportEmail;
    this.currentBonusUsedMicroUsd = params.currentBonusUsedMicroUsd;
    this.capLimitMicroUsd = params.capLimitMicroUsd;
    this.attemptedTotalBonusMicroUsd = params.attemptedTotalBonusMicroUsd;
    this.maxAdditionalPaidMicroUsd = params.maxAdditionalPaidMicroUsd;
  }
}

function table(db: SupabaseLike, name: string): DbTable {
  return db.from(name) as DbTable;
}

function requireUserId(userId: string) {
  if (!userId.trim()) {
    throw new Error("Managed Venice token quote user ID is required");
  }
}

function requireDepositAddress(depositAddress: string) {
  if (!depositAddress.trim()) {
    throw new Error("Managed Venice token quote deposit address is required");
  }
}

function requireTokenAmountRaw(tokenAmountRaw: string | bigint): bigint {
  const value = typeof tokenAmountRaw === "bigint" ? tokenAmountRaw : BigInt(tokenAmountRaw);
  if (value <= 0n) {
    throw new Error("Managed Venice token quote amount must be positive");
  }
  return value;
}

function requirePositiveMicroUsd(value: number, label: string) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer microdollar amount`);
  }
}

function parseDecimal(value: string) {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid decimal value: ${value}`);
  }
  const [whole, fraction = ""] = trimmed.split(".");
  const integer = BigInt(`${whole}${fraction}`);
  if (integer <= 0n) {
    throw new Error("Decimal value must be positive");
  }
  return { integer, scale: fraction.length };
}

function decimalToScale(parsed: { integer: bigint; scale: number }, scale: number) {
  return parsed.integer * 10n ** BigInt(scale - parsed.scale);
}

function pricesDisagreeAboveBps(
  primaryPriceUsd: string,
  crossCheckPriceUsd: string,
  maxDisagreementBps: number
): boolean {
  const primary = parseDecimal(primaryPriceUsd);
  const crossCheck = parseDecimal(crossCheckPriceUsd);
  const scale = Math.max(primary.scale, crossCheck.scale);
  const primaryScaled = decimalToScale(primary, scale);
  const crossCheckScaled = decimalToScale(crossCheck, scale);
  const diff =
    primaryScaled > crossCheckScaled
      ? primaryScaled - crossCheckScaled
      : crossCheckScaled - primaryScaled;

  return diff * 10_000n > primaryScaled * BigInt(maxDisagreementBps);
}

function isoFromUnixSeconds(value: number | null | undefined) {
  return typeof value === "number"
    ? new Date(value * 1000).toISOString()
    : null;
}

function numberOrDefault(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asQuote(row: TokenQuoteRow): ManagedVeniceTokenQuote {
  const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  const topUp =
    metadata.managedVeniceTopUp && typeof metadata.managedVeniceTopUp === "object"
      ? (metadata.managedVeniceTopUp as Record<string, unknown>)
      : {};
  const paidValueMicroUsd = numberOrDefault(
    topUp.paidValueMicroUsd,
    row.locked_value_micro_usd
  );
  const creditValueMicroUsd = numberOrDefault(
    topUp.creditValueMicroUsd,
    row.locked_value_micro_usd
  );
  const bonusValueMicroUsd = numberOrDefault(topUp.bonusValueMicroUsd, 0);
  const launchBonusMicroUsd = numberOrDefault(topUp.launchBonusMicroUsd, 0);
  const standardBonusMicroUsd = numberOrDefault(topUp.standardBonusMicroUsd, 0);

  return {
    id: row.id,
    accountId: row.account_id,
    userId: row.user_id,
    tokenAmountRaw: String(row.token_amount_raw),
    tokenSymbol: HERMESOS_TOKEN_SYMBOL,
    tokenDecimals: HERMESOS_TOKEN_DECIMALS,
    snapshotPriceUsd: row.snapshot_price_usd,
    lockedValueMicroUsd: row.locked_value_micro_usd,
    depositAddress: row.deposit_address,
    quotedAt: row.quoted_at,
    expiresAt: row.expires_at,
    status: row.status,
    source: row.source,
    crossCheckSource: row.cross_check_source || null,
    crossCheckPriceUsd: row.cross_check_price_usd || null,
    priceLastUpdatedAt: row.price_last_updated_at || null,
    crossCheckLastUpdatedAt: row.cross_check_last_updated_at || null,
    transactionHash: row.transaction_hash || null,
    settledAt: row.settled_at || null,
    paidValueMicroUsd,
    creditValueMicroUsd,
    bonusValueMicroUsd,
    launchBonusMicroUsd,
    standardBonusMicroUsd,
    settlementClaim: readSettlementClaim(metadata.settlementClaim),
    transferSurfacingPending: row.transfer_surfacing_pending === true,
    manualReviewReason: nonEmptyString(metadata.manualReviewReason),
    reviewTransactionHash: nonEmptyString(metadata.reviewTransactionHash),
  };
}

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

function readSettlementClaim(value: unknown): ManagedVeniceTokenSettlementClaim | null {
  const claim = metadataRecord(value);
  const numberField = (field: unknown) =>
    typeof field === "number" && Number.isFinite(field) ? field : null;
  const paidValueMicroUsd = numberField(claim.paidValueMicroUsd);
  const creditValueMicroUsd = numberField(claim.creditValueMicroUsd);
  const bonusValueMicroUsd = numberField(claim.bonusValueMicroUsd);
  if (
    typeof claim.transactionHash !== "string" ||
    !claim.transactionHash ||
    typeof claim.tokenAmountRaw !== "string" ||
    !/^\d+$/.test(claim.tokenAmountRaw) ||
    typeof claim.observedAt !== "string" ||
    paidValueMicroUsd === null ||
    creditValueMicroUsd === null ||
    bonusValueMicroUsd === null
  ) {
    return null;
  }
  return {
    transactionHash: claim.transactionHash,
    logIndex: normalizeLogIndex(claim.logIndex),
    tokenAmountRaw: claim.tokenAmountRaw,
    observedAt: claim.observedAt,
    blockTimestamp: typeof claim.blockTimestamp === "string" ? claim.blockTimestamp : null,
    paidValueMicroUsd,
    creditValueMicroUsd,
    bonusValueMicroUsd,
    claimedAt: typeof claim.claimedAt === "string" ? claim.claimedAt : claim.observedAt,
  };
}

function normalizeLogIndex(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function calculateManagedVeniceLockedValueMicroUsd(params: {
  tokenAmountRaw: string | bigint;
  priceUsdPerToken: string;
  tokenDecimals?: number;
}): number {
  const tokenAmountRaw = requireTokenAmountRaw(params.tokenAmountRaw);
  const tokenDecimals = params.tokenDecimals ?? HERMESOS_TOKEN_DECIMALS;
  if (!Number.isInteger(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 36) {
    throw new Error("tokenDecimals out of range");
  }

  const price = parseDecimal(params.priceUsdPerToken);
  const numerator = tokenAmountRaw * price.integer * 1_000_000n;
  const denominator =
    10n ** BigInt(tokenDecimals) * 10n ** BigInt(price.scale);
  const value = numerator / denominator;
  if (value <= 0n) {
    throw new Error("Managed Venice token quote value is below one microdollar");
  }
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Managed Venice token quote value exceeds safe integer range");
  }

  return Number(value);
}

export function calculateManagedVeniceTokenAmountRawForUsd(params: {
  targetMicroUsd: number;
  priceUsdPerToken: string;
  tokenDecimals?: number;
}): string {
  requirePositiveMicroUsd(params.targetMicroUsd, "managed Venice token quote USD target");
  const tokenDecimals = params.tokenDecimals ?? HERMESOS_TOKEN_DECIMALS;
  if (!Number.isInteger(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 36) {
    throw new Error("tokenDecimals out of range");
  }

  const price = parseDecimal(params.priceUsdPerToken);
  const numerator =
    BigInt(params.targetMicroUsd) *
    10n ** BigInt(tokenDecimals) *
    10n ** BigInt(price.scale);
  const denominator = price.integer * 1_000_000n;
  const exactRaw = (numerator + denominator - 1n) / denominator;
  if (exactRaw <= 0n) {
    throw new Error("Managed Venice token quote amount is below one raw token unit");
  }
  const wholeTokenScale = 10n ** BigInt(tokenDecimals);
  const wholeTokenRaw =
    ((exactRaw + wholeTokenScale - 1n) / wholeTokenScale) * wholeTokenScale;
  return wholeTokenRaw.toString();
}

async function loadManagedVeniceTopUpSubsidyState(
  db: SupabaseLike,
  userId: string,
  now: Date
) {
  const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: events, error: eventsError } = await table(
    db,
    "managed_venice_financial_events"
  )
    .select("discount_micro_usd, metadata, created_at")
    .eq("user_id", userId)
    .eq("event_type", "subsidy_applied");

  if (eventsError) {
    throw new Error(eventsError.message || "Failed to load managed Venice subsidy events");
  }

  let userLaunchBonusUsedMicroUsd = 0;
  let weeklyLaunchBonusUsedMicroUsd = 0;
  // Lifetime total of every subsidy event for this user (launch + standard
  // tier combined). Used for the hidden per-user bonus cap — the launch-only
  // counter isn't enough because a user who's spent 10 years on the 10%
  // standard tier could still rack up more total subsidy than the cap.
  let lifetimeUserBonusUsedMicroUsd = 0;
  for (const event of Array.isArray(events) ? (events as Record<string, unknown>[]) : []) {
    const metadata =
      event.metadata && typeof event.metadata === "object"
        ? (event.metadata as Record<string, unknown>)
        : {};
    const discountMicroUsd = numberOrDefault(event.discount_micro_usd, 0);
    const launchBonusMicroUsd = numberOrDefault(
      metadata.launchSubsidyMicroUsd,
      metadata.rate === "launch_20" ? discountMicroUsd : 0
    );
    userLaunchBonusUsedMicroUsd += launchBonusMicroUsd;
    lifetimeUserBonusUsedMicroUsd += discountMicroUsd;
    if (typeof event.created_at === "string" && event.created_at >= since) {
      weeklyLaunchBonusUsedMicroUsd += discountMicroUsd;
    }
  }

  const { data: platformState, error: platformError } = await table(
    db,
    "managed_venice_platform_state"
  )
    .select("weekly_kill_switch_active, weekly_subsidy_used_micro_usd")
    .eq("id", "global")
    .maybeSingle();

  if (platformError) {
    throw new Error(platformError.message || "Failed to load managed Venice platform state");
  }

  const state =
    platformState && typeof platformState === "object"
      ? (platformState as Record<string, unknown>)
      : {};

  return {
    userLaunchBonusUsedMicroUsd,
    weeklyLaunchBonusUsedMicroUsd: numberOrDefault(
      state.weekly_subsidy_used_micro_usd,
      weeklyLaunchBonusUsedMicroUsd
    ),
    lifetimeUserBonusUsedMicroUsd,
    killSwitchActive: Boolean(state.weekly_kill_switch_active),
  };
}

function topUpMetadata(quote: ManagedVeniceTopUpQuoteMicroUsd) {
  return {
    managedVeniceTopUp: {
      policy: "deposit_bonus_v1",
      walletType: "hermesos",
      paidValueMicroUsd: quote.paidMicroUsd,
      creditValueMicroUsd: quote.totalCreditsMicroUsd,
      bonusValueMicroUsd: quote.bonusMicroUsd,
      launchPaidMicroUsd: quote.launchPaidMicroUsd,
      standardPaidMicroUsd: quote.standardPaidMicroUsd,
      launchBonusMicroUsd: quote.launchBonusMicroUsd,
      standardBonusMicroUsd: quote.standardBonusMicroUsd,
      reason: quote.reason,
    },
  };
}

interface ManagedVeniceTokenQuoteRecord {
  quote: ManagedVeniceTokenQuote;
  // Raw metadata so every write can MERGE into it instead of replacing it
  // (primaryRaw / crossCheckRaw / managedVeniceTopUp must survive).
  metadata: Record<string, unknown>;
}

async function loadManagedVeniceTokenQuoteRecord(
  db: SupabaseLike,
  quoteId: string
): Promise<ManagedVeniceTokenQuoteRecord | null> {
  const { data, error } = await table(db, "managed_venice_token_quotes")
    .select(SELECT_COLUMNS)
    .eq("id", quoteId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message || "Failed to load managed Venice token quote");
  }
  if (!data) return null;
  const row = data as TokenQuoteRow;
  return { quote: asQuote(row), metadata: metadataRecord(row.metadata) };
}

export async function loadManagedVeniceTokenQuoteForUser(
  params: {
    quoteId: string;
    userId: string;
  },
  db: SupabaseLike | null | undefined = supabaseAdmin
): Promise<ManagedVeniceTokenQuote | null> {
  requireUserId(params.userId);
  const client = requireDb(db);
  const { data, error } = await table(client, "managed_venice_token_quotes")
    .select(SELECT_COLUMNS)
    .eq("id", params.quoteId)
    .eq("user_id", params.userId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message || "Failed to load managed Venice token quote");
  }
  return data ? asQuote(data as TokenQuoteRow) : null;
}

// ── Deposit lots ──────────────────────────────────────────────────────────

interface DepositLotRow {
  id: string;
  transaction_hash?: string | null;
  token_amount_raw: string | number;
  original_value_micro_usd: number | string;
  metadata?: unknown;
}

export interface ManagedVeniceTokenDepositLot {
  id: string;
  transactionHash: string | null;
  tokenAmountRaw: string;
  originalValueMicroUsd: number;
  observedAt: string | null;
  blockTimestamp: string | null;
  logIndex: number | null;
  paidValueMicroUsd: number | null;
  bonusValueMicroUsd: number | null;
}

function optionalNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asDepositLot(row: DepositLotRow): ManagedVeniceTokenDepositLot {
  const metadata = metadataRecord(row.metadata);
  return {
    id: row.id,
    transactionHash: row.transaction_hash || null,
    tokenAmountRaw: String(row.token_amount_raw),
    originalValueMicroUsd: Number(row.original_value_micro_usd),
    observedAt: typeof metadata.observedAt === "string" ? metadata.observedAt : null,
    blockTimestamp: typeof metadata.blockTimestamp === "string" ? metadata.blockTimestamp : null,
    logIndex: normalizeLogIndex(metadata.logIndex),
    paidValueMicroUsd: optionalNumber(metadata.paidValueMicroUsd),
    bonusValueMicroUsd: optionalNumber(metadata.bonusValueMicroUsd),
  };
}

async function loadDepositLot(
  db: SupabaseLike,
  quoteId: string
): Promise<ManagedVeniceTokenDepositLot | null> {
  const { data, error } = await table(db, "managed_venice_token_lots")
    .select("id, transaction_hash, token_amount_raw::text, original_value_micro_usd, metadata")
    .eq("quote_id", quoteId)
    .eq("source", "hermesos_deposit")
    .maybeSingle();

  if (error) {
    throw new Error(error.message || "Failed to check existing managed Venice token lot");
  }
  return data ? asDepositLot(data as DepositLotRow) : null;
}

// The quote's spendable deposit lot, if settlement created one. Exposed so the
// reconciler can recover a crashed settlement and the sweep can move the
// RECEIVED amount instead of the quoted one.
export async function loadManagedVeniceTokenDepositLot(
  quoteId: string,
  db: SupabaseLike | null | undefined = supabaseAdmin
) {
  return loadDepositLot(requireDb(db), quoteId);
}

// ── Transfer identity and reconciliation items ───────────────────────────

function sameTransactionHash(left: string | null | undefined, right: string | null | undefined) {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

function transactionHashVariants(transactionHash: string) {
  return Array.from(new Set([transactionHash, transactionHash.toLowerCase()]));
}

// One open item per on-chain transfer, whatever the reason: the unique index on
// managed_venice_reconciliation_items.dedupe_key turns a repeat insert (every
// cron tick, cron racing the user's check, a bearer redelivery) into a no-op.
// Keyed by the tx hash alone: the bearer settle route has no log index, and the
// reconciler and the bearer route must key the same transfer identically. (The
// claim is per tx too: the unique quotes.transaction_hash index.)
export function managedVeniceTokenTransferDedupeKey(transactionHash: string) {
  return `managed_venice_token_transfer:${transactionHash.trim().toLowerCase()}`;
}

function affectedRowCount(data: unknown) {
  if (Array.isArray(data)) return data.length;
  return data ? 1 : 0;
}

// True when the tx is already the settlement tx of a quote or a lot. Such a
// transfer is accounted for; it is never re-surfaced against another quote.
async function isTransactionBound(
  db: SupabaseLike,
  transactionHash: string,
  options: { ignoreQuoteId?: string } = {}
) {
  const variants = transactionHashVariants(transactionHash);
  const [quotes, lots] = await Promise.all([
    table(db, "managed_venice_token_quotes")
      .select("id")
      .in("transaction_hash", variants),
    table(db, "managed_venice_token_lots")
      .select("id, quote_id")
      .in("transaction_hash", variants),
  ]);
  if (quotes.error) {
    throw new Error(quotes.error.message || "Failed to check managed Venice quote transaction binding");
  }
  if (lots.error) {
    throw new Error(lots.error.message || "Failed to check managed Venice lot transaction binding");
  }
  const boundQuotes = (Array.isArray(quotes.data) ? quotes.data : []) as Array<{ id?: unknown }>;
  const boundLots = (Array.isArray(lots.data) ? lots.data : []) as Array<{ quote_id?: unknown }>;
  return (
    boundQuotes.some((row) => row.id !== options.ignoreQuoteId) ||
    boundLots.some((row) => !options.ignoreQuoteId || row.quote_id !== options.ignoreQuoteId)
  );
}

interface ObservedTransfer {
  transactionHash: string;
  logIndex: number | null;
  tokenAmountRaw: string | null;
  observedAt: string;
}

async function insertTransferItem(
  db: SupabaseLike,
  quote: ManagedVeniceTokenQuote,
  transfer: ObservedTransfer,
  reason: ManagedVeniceTokenDepositReason
): Promise<"surfaced" | "already_surfaced"> {
  const dedupeKey = managedVeniceTokenTransferDedupeKey(transfer.transactionHash);
  const { error } = await table(db, "managed_venice_reconciliation_items").insert({
    user_id: quote.userId,
    account_id: quote.accountId,
    status: "open",
    reason,
    dedupe_key: dedupeKey,
    metadata: {
      quoteId: quote.id,
      transactionHash: transfer.transactionHash,
      logIndex: transfer.logIndex,
      observedTokenAmountRaw: transfer.tokenAmountRaw,
      expectedTokenAmountRaw: quote.tokenAmountRaw,
      observedAt: transfer.observedAt,
    },
  });

  // 23505 on the dedupe key = this transfer is already surfaced. Success.
  if (error?.code === "23505") return "already_surfaced";
  if (error) {
    throw new Error(error.message || "Failed to create managed Venice reconciliation item");
  }
  return "surfaced";
}

// Surface one on-chain transfer for operator review without touching the
// quote (extra transfers, late out-of-band transfers). Idempotent per transfer.
export async function surfaceManagedVeniceTokenTransfer(
  params: {
    quote: ManagedVeniceTokenQuote;
    transactionHash: string;
    logIndex?: number | null;
    tokenAmountRaw: string | null;
    observedAt: string;
    reason: ManagedVeniceTokenDepositReason;
  },
  db: SupabaseLike | null | undefined = supabaseAdmin
) {
  const status = await insertTransferItem(
    requireDb(db),
    params.quote,
    {
      transactionHash: params.transactionHash.trim().toLowerCase(),
      logIndex: normalizeLogIndex(params.logIndex),
      tokenAmountRaw: params.tokenAmountRaw,
      observedAt: params.observedAt,
    },
    params.reason
  );
  return { status };
}

export async function createManagedVeniceTokenQuote(
  params: {
    userId: string;
    tokenAmountRaw: string | bigint;
    depositAddress: string;
    now?: Date;
    priceQuote?: HermesPriceQuote;
    crossCheckQuote?: HermesPriceCrossCheck | null;
    metadata?: Record<string, unknown>;
  },
  db: SupabaseLike | null | undefined = supabaseAdmin
): Promise<ManagedVeniceTokenQuote> {
  requireUserId(params.userId);
  requireDepositAddress(params.depositAddress);
  const tokenAmountRaw = requireTokenAmountRaw(params.tokenAmountRaw);
  const client = requireDb(db);
  const now = params.now ?? new Date();

  const priceQuote = params.priceQuote ?? (await fetchHermesPriceUsd());
  if (!isHermesPriceFresh(priceQuote, now, MANAGED_VENICE_PRICE_MAX_AGE_MS)) {
    throw new ManagedVeniceTokenQuotePriceError(
      "Managed Venice token deposits are temporarily disabled because the Hivra price is stale"
    );
  }

  const crossCheckQuote =
    params.crossCheckQuote === undefined
      ? await fetchHermesPriceCrossCheck()
      : params.crossCheckQuote;
  if (
    crossCheckQuote &&
    !isHermesPriceFresh(crossCheckQuote, now, MANAGED_VENICE_PRICE_MAX_AGE_MS)
  ) {
    throw new ManagedVeniceTokenQuotePriceError(
      "Managed Venice token deposits are temporarily disabled because the Hivra cross-check price is stale"
    );
  }
  if (
    crossCheckQuote &&
    pricesDisagreeAboveBps(
      priceQuote.priceUsd,
      crossCheckQuote.priceUsd,
      MANAGED_VENICE_PRICE_MAX_DISAGREEMENT_BPS
    )
  ) {
    throw new ManagedVeniceTokenQuotePriceError(
      "Managed Venice token deposits are temporarily disabled because Hivra price sources disagree"
    );
  }

  const account = await ensureManagedVeniceWalletAccount(params.userId, client);
  const lockedValueMicroUsd = calculateManagedVeniceLockedValueMicroUsd({
    tokenAmountRaw,
    priceUsdPerToken: priceQuote.priceUsd,
    tokenDecimals: HERMESOS_TOKEN_DECIMALS,
  });
  const expiresAt = new Date(now.getTime() + MANAGED_VENICE_QUOTE_LIFETIME_MS);

  const { data, error } = await table(client, "managed_venice_token_quotes")
    .insert({
      account_id: account.id,
      user_id: params.userId,
      token_amount_raw: tokenAmountRaw.toString(),
      snapshot_price_usd: priceQuote.priceUsd,
      locked_value_micro_usd: lockedValueMicroUsd,
      deposit_address: params.depositAddress,
      quoted_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
      status: "active" satisfies ManagedVeniceTokenQuoteStatus,
      source: priceQuote.source,
      cross_check_source: crossCheckQuote?.source ?? null,
      cross_check_price_usd: crossCheckQuote?.priceUsd ?? null,
      price_last_updated_at: isoFromUnixSeconds(priceQuote.lastUpdatedAt),
      cross_check_last_updated_at: isoFromUnixSeconds(crossCheckQuote?.lastUpdatedAt),
      metadata: {
        primaryRaw: priceQuote.raw ?? null,
        crossCheckRaw: crossCheckQuote?.raw ?? null,
        ...(params.metadata || {}),
      },
    })
    .select(SELECT_COLUMNS)
    .single();

  if (error || !data) {
    throw new Error(error?.message || "Failed to create managed Venice token quote");
  }
  return asQuote(data as TokenQuoteRow);
}

export async function createManagedVeniceTokenQuoteForUsdTarget(
  params: {
    userId: string;
    targetMicroUsd: number;
    depositAddress: string;
    now?: Date;
    priceQuote?: HermesPriceQuote;
    crossCheckQuote?: HermesPriceCrossCheck | null;
  },
  db: SupabaseLike | null | undefined = supabaseAdmin
): Promise<ManagedVeniceTokenQuote> {
  requirePositiveMicroUsd(params.targetMicroUsd, "managed Venice token quote USD target");
  const now = params.now ?? new Date();
  const priceQuote = params.priceQuote ?? (await fetchHermesPriceUsd());
  const client = requireDb(db);
  const subsidyState = await loadManagedVeniceTopUpSubsidyState(
    client,
    params.userId,
    now
  );
  const topUpQuote = getManagedVeniceTopUpQuoteMicroUsd({
    paidMicroUsd: params.targetMicroUsd,
    walletType: "hermesos",
    ...subsidyState,
  });

  // Hidden per-user lifetime bonus cap. Reject the quote BEFORE we write a
  // token-quote row so the user can't lock in a price and then race-create
  // more quotes to slip past the limit. Cap covers BOTH launch + standard
  // tier bonuses combined; once exceeded the user emails support to extend.
  const projectedTotalBonusMicroUsd =
    subsidyState.lifetimeUserBonusUsedMicroUsd + topUpQuote.bonusMicroUsd;
  if (projectedTotalBonusMicroUsd > MANAGED_VENICE_HIDDEN_USER_BONUS_CAP_MICRO_USD) {
    // Figure out how much more they CAN safely deposit before tripping
    // the cap, so the operator can quote it back in the support reply.
    const remainingBonusMicroUsd = Math.max(
      0,
      MANAGED_VENICE_HIDDEN_USER_BONUS_CAP_MICRO_USD - subsidyState.lifetimeUserBonusUsedMicroUsd,
    );
    // Bonus-rate this top-up would have earned (effective rate accounting
    // for launch vs standard split). Fall back to the standard rate for
    // the back-calc when nothing in this top-up qualifies for launch.
    const effectiveBonusBps =
      topUpQuote.paidMicroUsd > 0
        ? Math.round((topUpQuote.bonusMicroUsd * 10_000) / topUpQuote.paidMicroUsd)
        : MANAGED_VENICE_STANDARD_BONUS_BPS;
    const maxAdditionalPaidMicroUsd =
      effectiveBonusBps > 0
        ? Math.floor((remainingBonusMicroUsd * 10_000) / effectiveBonusBps)
        : params.targetMicroUsd;
    throw new ManagedVeniceTopUpExceedsHiddenCapError({
      supportEmail: getManagedVeniceSupportEmail(),
      currentBonusUsedMicroUsd: subsidyState.lifetimeUserBonusUsedMicroUsd,
      capLimitMicroUsd: MANAGED_VENICE_HIDDEN_USER_BONUS_CAP_MICRO_USD,
      attemptedTotalBonusMicroUsd: projectedTotalBonusMicroUsd,
      maxAdditionalPaidMicroUsd,
    });
  }
  // Reference launch bps to keep the import live for the bonus-back-calc
  // path above (when the entire deposit lands in the launch tier).
  void MANAGED_VENICE_LAUNCH_BONUS_BPS;
  const tokenAmountRaw = calculateManagedVeniceTokenAmountRawForUsd({
    targetMicroUsd: params.targetMicroUsd,
    priceUsdPerToken: priceQuote.priceUsd,
    tokenDecimals: HERMESOS_TOKEN_DECIMALS,
  });

  return createManagedVeniceTokenQuote(
    {
      userId: params.userId,
      tokenAmountRaw,
      depositAddress: params.depositAddress,
      now,
      priceQuote,
      crossCheckQuote: params.crossCheckQuote,
      metadata: topUpMetadata(topUpQuote),
    },
    client
  );
}

// ── Settlement ────────────────────────────────────────────────────────────
//
// There is no multi-statement transaction here, so settlement is a claim-first
// saga whose every step is idempotent and whose every quote transition is a
// compare-and-set:
//   1. CLAIM  — quote.transaction_hash := tx (CAS: open status, tx still null).
//               The unique tx index makes this the single point where a
//               transfer is bound to exactly one quote; a tx that is already
//               another quote's lot (legacy) is refused before the claim.
//               Nothing is credited before the claim is durable.
//   2. LOT    — one spendable lot (unique per quote), from the claim values.
//   3. EVENTS — token_deposit + subsidy_applied, keyed by quote + claimed tx.
//   4. FLIP   — status := settled (CAS: open status, tx = claimed tx), and
//               transfer_surfacing_pending := true in the same write.
// A crash anywhere leaves either an unclaimed quote (nothing credited) or a
// claimed/credited one that any later call converges on the SAME tx and
// values. A different transfer seen by a retry is surfaced, never credited.
//
// Review is the same shape: the CAS flip to manual_review_required (with
// transfer_surfacing_pending := true) comes FIRST and its item after it. A
// lost CAS writes nothing and re-evaluates, so a transfer that a concurrent
// claim credits is never also left with an open item. A settled or reviewed
// quote is terminal here, so every transfer it attracts that is not credited
// (one still confirming at the flip, one sent later, or one whose item insert
// failed after the flip) is surfaced by the reconciler's surface-only pass
// until the flag is cleared.

export type ManagedVeniceTokenSettlementResult =
  | { status: "settled"; quoteId: string; idempotent?: true }
  | { status: "manual_review_required" }
  | { status: "cancelled" }
  | { status: "transaction_already_claimed"; quoteId: string };

const RETRY_SETTLEMENT = Symbol("retry_managed_venice_settlement");
type SettlementPass = ManagedVeniceTokenSettlementResult | typeof RETRY_SETTLEMENT;

// A lost compare-and-set re-loads the quote and re-evaluates once.
const MAX_SETTLEMENT_PASSES = 2;

interface SettlementTransfer extends ObservedTransfer {
  tokenAmountRaw: string;
  observedAtDate: Date;
  blockTimestamp: string | null;
}

export function managedVeniceTokenQuoteWindow(
  quote: Pick<ManagedVeniceTokenQuote, "quotedAt" | "expiresAt">
) {
  const quotedAt = new Date(quote.quotedAt);
  const storedExpiresAt = new Date(quote.expiresAt);
  return {
    quotedAt,
    // Legacy quotes were stored with a shorter lifetime; every quote gets at
    // least the current 20-minute window.
    effectiveExpiresAt: new Date(
      Math.max(storedExpiresAt.getTime(), quotedAt.getTime() + MANAGED_VENICE_QUOTE_LIFETIME_MS)
    ),
  };
}

function overSendCeiling(quotedTokenAmount: bigint) {
  return (
    (quotedTokenAmount * MANAGED_VENICE_MAX_OVERSEND_NUMERATOR) /
    MANAGED_VENICE_MAX_OVERSEND_DENOMINATOR
  );
}

// ── Amount reconciliation (under-pay / exact / over-send) ─────────────
// The user can send a different on-chain amount than the quote asked for.
//   • outside [quotedAt, effectiveExpiresAt] → manual review.
//   • observed  <  quoted              → UNDER-PAYMENT. Never auto-credit;
//     they didn't pay for what they quoted. Route to manual review.
//   • quoted <= observed <= quoted*N   → OVER-SEND within bounds. Real
//     money — credit them for what they ACTUALLY sent (pro-rata against
//     the quote's snapshot price) and settle normally.
//   • observed  >  quoted*N            → WILDLY over (fat-finger 10x, a
//     wrong-token transfer that happened to decode, etc). Route to manual
//     review so an absurd auto-credit can never be minted.
// Wrong-token transfers are already filtered upstream by the reconciler
// (it only matches logs from the $HermesOS token contract), so this code
// only ever sees same-token amounts. Returns null for a qualifying transfer.
function classifyTransfer(
  quote: ManagedVeniceTokenQuote,
  transfer: Pick<SettlementTransfer, "tokenAmountRaw" | "observedAtDate">
): ManagedVeniceTokenDepositReason | null {
  const window = managedVeniceTokenQuoteWindow(quote);
  if (transfer.observedAtDate < window.quotedAt || transfer.observedAtDate > window.effectiveExpiresAt) {
    return MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.outsideQuoteWindow;
  }
  const observed = BigInt(transfer.tokenAmountRaw);
  const quoted = BigInt(quote.tokenAmountRaw);
  if (observed < quoted) return MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.underpaid;
  if (observed > overSendCeiling(quoted)) return MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.amountMismatch;
  return null;
}

function buildSettlementClaim(
  quote: ManagedVeniceTokenQuote,
  transfer: SettlementTransfer,
  claimedAt: string
): ManagedVeniceTokenSettlementClaim {
  const observed = BigInt(transfer.tokenAmountRaw);
  const quoted = BigInt(quote.tokenAmountRaw);
  const isOverSend = observed > quoted;
  // Credit the actual paid value pro-rata: the excess tokens were bought at the
  // SAME snapshot price the quote locked, so paid value scales linearly with
  // the observed amount. The bonus/subsidy is NOT scaled up — it was sized and
  // cap-checked against the original quote, and over-sent excess shouldn't mint
  // extra subsidy past the hidden per-user bonus cap. For an exact match every
  // value is the quote's own.
  const paidValueMicroUsd = isOverSend
    ? Number((BigInt(quote.paidValueMicroUsd) * observed) / quoted)
    : quote.paidValueMicroUsd;
  const bonusValueMicroUsd = quote.bonusValueMicroUsd;
  return {
    transactionHash: transfer.transactionHash,
    logIndex: transfer.logIndex,
    tokenAmountRaw: transfer.tokenAmountRaw,
    observedAt: transfer.observedAt,
    blockTimestamp: transfer.blockTimestamp,
    paidValueMicroUsd,
    creditValueMicroUsd: isOverSend ? paidValueMicroUsd + bonusValueMicroUsd : quote.creditValueMicroUsd,
    bonusValueMicroUsd,
    claimedAt,
  };
}

// The lot is the credit that already exists, so it is authoritative for the
// tx and every amount; the recorded claim only fills gaps in legacy lots.
function settlementClaimFromLot(
  quote: ManagedVeniceTokenQuote,
  lot: ManagedVeniceTokenDepositLot,
  recordedClaim: ManagedVeniceTokenSettlementClaim | null,
  transfer: SettlementTransfer
): ManagedVeniceTokenSettlementClaim {
  const transactionHash =
    lot.transactionHash ?? recordedClaim?.transactionHash ?? quote.transactionHash ?? transfer.transactionHash;
  const claim =
    recordedClaim && sameTransactionHash(recordedClaim.transactionHash, transactionHash) ? recordedClaim : null;
  const bonusValueMicroUsd = lot.bonusValueMicroUsd ?? claim?.bonusValueMicroUsd ?? quote.bonusValueMicroUsd;
  const creditValueMicroUsd = lot.originalValueMicroUsd;
  return {
    transactionHash,
    logIndex: lot.logIndex ?? claim?.logIndex ?? null,
    tokenAmountRaw: lot.tokenAmountRaw,
    observedAt: lot.observedAt ?? claim?.observedAt ?? transfer.observedAt,
    blockTimestamp: lot.blockTimestamp ?? claim?.blockTimestamp ?? null,
    paidValueMicroUsd:
      lot.paidValueMicroUsd ?? claim?.paidValueMicroUsd ?? Math.max(0, creditValueMicroUsd - bonusValueMicroUsd),
    creditValueMicroUsd,
    bonusValueMicroUsd,
    claimedAt: claim?.claimedAt ?? new Date().toISOString(),
  };
}

export async function settleManagedVeniceTokenQuote(
  params: {
    quoteId: string;
    transactionHash: string;
    tokenAmountRaw: string | bigint;
    observedAt: string;
    blockTimestamp?: string | null;
    logIndex?: number | null;
  },
  db: SupabaseLike | null | undefined = supabaseAdmin
): Promise<ManagedVeniceTokenSettlementResult> {
  if (!params.quoteId.trim()) {
    throw new Error("Managed Venice token quote ID is required");
  }
  if (!params.transactionHash.trim()) {
    throw new Error("Managed Venice token quote transaction hash is required");
  }
  const tokenAmountRaw = requireTokenAmountRaw(params.tokenAmountRaw).toString();
  const client = requireDb(db);

  const observedAt = new Date(params.blockTimestamp || params.observedAt);
  if (Number.isNaN(observedAt.getTime())) {
    throw new Error("Managed Venice token quote observedAt is invalid");
  }
  const transfer: SettlementTransfer = {
    // Tx hashes are hex; normalize so the unique claim index cannot be
    // side-stepped by a differently-cased copy of the same hash.
    transactionHash: params.transactionHash.trim().toLowerCase(),
    logIndex: normalizeLogIndex(params.logIndex),
    tokenAmountRaw,
    observedAt: observedAt.toISOString(),
    observedAtDate: observedAt,
    blockTimestamp: params.blockTimestamp || null,
  };

  for (let pass = 0; pass < MAX_SETTLEMENT_PASSES; pass += 1) {
    const outcome = await settleOnce(client, params.quoteId, transfer);
    if (outcome !== RETRY_SETTLEMENT) return outcome;
  }
  throw new Error(
    "Managed Venice token quote changed concurrently during settlement; retry the settlement"
  );
}

async function settleOnce(
  db: SupabaseLike,
  quoteId: string,
  transfer: SettlementTransfer
): Promise<SettlementPass> {
  const record = await loadManagedVeniceTokenQuoteRecord(db, quoteId);
  if (!record) {
    throw new Error("Managed Venice token quote not found");
  }
  const { quote } = record;

  if (quote.status === "settled") {
    return handleSettledQuote(db, quote, transfer);
  }
  if (quote.status !== "active" && quote.status !== "expired") {
    return handleClosedQuote(db, record, transfer);
  }

  // A claim or a lot means an earlier settlement got part-way: converge on it.
  const lot = await loadDepositLot(db, quote.id);
  if (quote.transactionHash || lot) {
    return convergeClaimedSettlement(db, record, lot, transfer);
  }

  const reviewReason = classifyTransfer(quote, transfer);
  if (reviewReason) {
    return reviewUnclaimedQuote(db, record, transfer, reviewReason);
  }
  return claimAndSettle(db, record, transfer);
}

async function handleSettledQuote(
  db: SupabaseLike,
  quote: ManagedVeniceTokenQuote,
  transfer: SettlementTransfer
): Promise<ManagedVeniceTokenSettlementResult> {
  // Idempotent redelivery of the SAME settled deposit. The amount can legally
  // differ from the quote when the original settlement was an accepted
  // over-send (quoted <= observed <= quoted*ceiling), so accept the same band
  // here rather than requiring a byte-exact amount — otherwise a benign retry
  // of an over-send would spuriously open a "replayed_after_settlement" item.
  const quoted = BigInt(quote.tokenAmountRaw);
  const observed = BigInt(transfer.tokenAmountRaw);
  const amountWithinSettledBand = observed >= quoted && observed <= overSendCeiling(quoted);
  if (
    sameTransactionHash(quote.transactionHash, transfer.transactionHash) &&
    (transfer.tokenAmountRaw === quote.tokenAmountRaw || amountWithinSettledBand)
  ) {
    return { status: "settled", quoteId: quote.id, idempotent: true };
  }

  // A different transfer after settlement: surface it once, never touch the
  // settled quote (its credit, tx and sweep state are final).
  if (!(await isTransactionBound(db, transfer.transactionHash, { ignoreQuoteId: quote.id }))) {
    await insertTransferItem(db, quote, transfer, MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.replayedAfterSettlement);
  }
  return { status: "manual_review_required" };
}

async function handleClosedQuote(
  db: SupabaseLike,
  record: ManagedVeniceTokenQuoteRecord,
  transfer: SettlementTransfer
): Promise<ManagedVeniceTokenSettlementResult> {
  const { quote } = record;
  const status = quote.status === "cancelled" ? "cancelled" : "manual_review_required";
  // Review and cancelled are terminal for automation: never settle, never
  // re-review.
  if (sameTransactionHash(quote.reviewTransactionHash, transfer.transactionHash)) {
    // The transfer that caused the review. Its item is written right after the
    // review flip; while the quote still owes surfacing that insert may have
    // failed, so a redelivery (re)writes it (a no-op once it exists). Legacy
    // reviews (flag false) wrote theirs before this flag existed.
    if (quote.transferSurfacingPending) {
      await insertTransferItem(
        db,
        quote,
        transfer,
        (quote.manualReviewReason as ManagedVeniceTokenDepositReason | null) ??
          classifyTransfer(quote, transfer) ??
          MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.afterQuoteClosed
      );
    }
    return { status };
  }
  if (!(await isTransactionBound(db, transfer.transactionHash))) {
    await insertTransferItem(
      db,
      quote,
      transfer,
      classifyTransfer(quote, transfer) ?? MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.afterQuoteClosed
    );
  }
  return { status };
}

async function reviewUnclaimedQuote(
  db: SupabaseLike,
  record: ManagedVeniceTokenQuoteRecord,
  transfer: SettlementTransfer,
  reason: ManagedVeniceTokenDepositReason
): Promise<SettlementPass> {
  const { quote } = record;
  const now = new Date().toISOString();
  // Flip FIRST, item after. A lost CAS (the quote was claimed, settled or
  // reviewed concurrently) writes nothing and re-evaluates: the transfer may
  // be the very one a concurrent claim is crediting, and must not also get an
  // open item. If the item insert fails after the flip, the flag set here
  // makes the reconciler's surface-only pass (or a redelivery of this
  // transfer) write it, so a review is never invisible for long.
  // The rejected tx is NOT written to transaction_hash: that column is the
  // unique settlement claim, and a foreign transfer must never occupy it.
  const { data, error } = await table(db, "managed_venice_token_quotes")
    .update({
      status: "manual_review_required" satisfies ManagedVeniceTokenQuoteStatus,
      transfer_surfacing_pending: true,
      updated_at: now,
      metadata: {
        ...record.metadata,
        manualReviewReason: reason,
        observedTokenAmountRaw: transfer.tokenAmountRaw,
        observedAt: transfer.observedAt,
        reviewTransactionHash: transfer.transactionHash,
        reviewLogIndex: transfer.logIndex,
      },
    })
    .eq("id", quote.id)
    .in("status", OPEN_QUOTE_STATUSES)
    .is("transaction_hash", null)
    .select("id");

  if (error) {
    throw new Error(error.message || "Failed to mark managed Venice token quote for review");
  }
  if (affectedRowCount(data) === 0) return RETRY_SETTLEMENT;

  await insertTransferItem(db, quote, transfer, reason);
  return { status: "manual_review_required" };
}

// Lots whose tx is `transactionHash` and that belong to a quote other than
// `quoteId`. Claim-first settlement only inserts a lot after its quote claims
// the tx, but legacy lots exist whose quote never recorded the tx, so the
// unique quotes.transaction_hash index alone cannot refuse them.
async function findOtherQuoteLot(db: SupabaseLike, transactionHash: string, quoteId: string) {
  const { data, error } = await table(db, "managed_venice_token_lots")
    .select("id, quote_id")
    .in("transaction_hash", transactionHashVariants(transactionHash));
  if (error) {
    throw new Error(error.message || "Failed to check managed Venice lot transaction binding");
  }
  const lots = (Array.isArray(data) ? data : []) as Array<{ id?: unknown; quote_id?: unknown }>;
  return lots.find((lot) => lot.quote_id !== quoteId) ?? null;
}

async function claimAndSettle(
  db: SupabaseLike,
  record: ManagedVeniceTokenQuoteRecord,
  transfer: SettlementTransfer
): Promise<SettlementPass> {
  const { quote } = record;
  const alreadyClaimed = (boundTo: "quote" | "lot") => {
    // Another quote already owns this transfer. It is accounted for there;
    // this quote stays open for its own transfer and nothing is written.
    log.warn("managed Venice token transfer already claimed by another quote", {
      source: "managed-venice-token-quotes",
      failureType: "managed_venice_token_transaction_already_claimed",
      quoteId: quote.id,
      transactionHash: transfer.transactionHash,
      boundTo,
    });
    return { status: "transaction_already_claimed" as const, quoteId: quote.id };
  };

  if (await findOtherQuoteLot(db, transfer.transactionHash, quote.id)) {
    return alreadyClaimed("lot");
  }

  const now = new Date().toISOString();
  const claim = buildSettlementClaim(quote, transfer, now);
  const metadata = { ...record.metadata, settlementClaim: claim };
  const { data, error } = await table(db, "managed_venice_token_quotes")
    .update({ transaction_hash: claim.transactionHash, updated_at: now, metadata })
    .eq("id", quote.id)
    .in("status", OPEN_QUOTE_STATUSES)
    .is("transaction_hash", null)
    .select("id");

  // The unique tx index: another quote claimed this transfer.
  if (error?.code === "23505") return alreadyClaimed("quote");
  if (error) {
    throw new Error(error.message || "Failed to claim managed Venice token deposit");
  }
  if (affectedRowCount(data) === 0) return RETRY_SETTLEMENT;

  await completeClaimedSettlement(db, { ...quote, transactionHash: claim.transactionHash }, metadata, claim, null);
  return { status: "settled", quoteId: quote.id };
}

// An open quote that claimed `claimedTransactionHash` but has no lot and no
// readable claim values. The CAS (open status, tx = the claimed tx) flips it to
// manual_review_required with the surfacing flag and KEEPS the claim, so the
// tx stays bound to this quote and no other quote can credit it; THEN one item
// for the claimed tx. A lost CAS writes nothing and re-evaluates. A different
// transfer the caller delivered is surfaced once, like any transfer that
// reaches a closed quote.
async function reviewUnrecoverableClaim(
  db: SupabaseLike,
  record: ManagedVeniceTokenQuoteRecord,
  claimedTransactionHash: string,
  transfer: SettlementTransfer
): Promise<SettlementPass> {
  const { quote } = record;
  const reason = MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.claimUnrecoverable;
  const now = new Date().toISOString();
  const { data, error } = await table(db, "managed_venice_token_quotes")
    .update({
      status: "manual_review_required" satisfies ManagedVeniceTokenQuoteStatus,
      transfer_surfacing_pending: true,
      updated_at: now,
      metadata: {
        ...record.metadata,
        manualReviewReason: reason,
        reviewTransactionHash: claimedTransactionHash,
        reviewedAt: now,
      },
    })
    .eq("id", quote.id)
    .in("status", OPEN_QUOTE_STATUSES)
    .eq("transaction_hash", claimedTransactionHash)
    .select("id");

  if (error) {
    throw new Error(error.message || "Failed to mark managed Venice token quote for review");
  }
  if (affectedRowCount(data) === 0) return RETRY_SETTLEMENT;

  log.warn("managed Venice token quote claim has no lot and no claim values; sent to manual review", {
    source: "managed-venice-token-quotes",
    failureType: "managed_venice_token_claim_unrecoverable",
    quoteId: quote.id,
    transactionHash: claimedTransactionHash,
  });
  await insertTransferItem(
    db,
    quote,
    { transactionHash: claimedTransactionHash, logIndex: null, tokenAmountRaw: null, observedAt: now },
    reason
  );
  if (
    !sameTransactionHash(transfer.transactionHash, claimedTransactionHash) &&
    !(await isTransactionBound(db, transfer.transactionHash))
  ) {
    await insertTransferItem(
      db,
      quote,
      transfer,
      classifyTransfer(quote, transfer) ?? MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.afterQuoteClosed
    );
  }
  return { status: "manual_review_required" };
}

async function convergeClaimedSettlement(
  db: SupabaseLike,
  record: ManagedVeniceTokenQuoteRecord,
  lot: ManagedVeniceTokenDepositLot | null,
  transfer: SettlementTransfer
): Promise<SettlementPass> {
  const { quote } = record;
  const recordedClaim = readSettlementClaim(record.metadata.settlementClaim);
  let claim: ManagedVeniceTokenSettlementClaim;
  if (lot) {
    claim = settlementClaimFromLot(quote, lot, recordedClaim, transfer);
  } else if (
    quote.transactionHash &&
    recordedClaim &&
    sameTransactionHash(recordedClaim.transactionHash, quote.transactionHash)
  ) {
    claim = recordedClaim;
  } else if (quote.transactionHash) {
    // Claimed, but no lot and no readable claim values: nothing says what the
    // claimed transfer was worth (the reconciler's recovery call only has the
    // quote's own numbers), so never credit it and never fail every tick.
    return reviewUnrecoverableClaim(db, record, quote.transactionHash, transfer);
  } else {
    throw new Error("Managed Venice token quote has no claimed transaction and no deposit lot to converge on");
  }

  let metadata = record.metadata;
  if (!sameTransactionHash(quote.transactionHash, claim.transactionHash)) {
    // The lot (the credit that exists) wins: bind the quote to the lot's tx.
    metadata = { ...record.metadata, settlementClaim: claim };
    const update = table(db, "managed_venice_token_quotes")
      .update({ transaction_hash: claim.transactionHash, updated_at: new Date().toISOString(), metadata })
      .eq("id", quote.id)
      .in("status", OPEN_QUOTE_STATUSES);
    const { data, error } = await (quote.transactionHash
      ? update.eq("transaction_hash", quote.transactionHash)
      : update.is("transaction_hash", null)
    ).select("id");

    if (error?.code === "23505") {
      // Legacy cross-quote capture: this quote holds a credited lot whose tx
      // is claimed by another quote, so it can never flip to settled. Surface
      // it once for an operator instead of failing every tick.
      log.warn("managed Venice token lot transaction is claimed by another quote", {
        source: "managed-venice-token-quotes",
        failureType: "managed_venice_token_lot_claim_conflict",
        quoteId: quote.id,
        transactionHash: claim.transactionHash,
      });
      await insertTransferItem(db, quote, claim, MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.claimConflict);
      return { status: "transaction_already_claimed", quoteId: quote.id };
    }
    if (error) {
      throw new Error(error.message || "Failed to claim managed Venice token deposit");
    }
    if (affectedRowCount(data) === 0) return RETRY_SETTLEMENT;

    const displacedClaim = quote.transactionHash;
    if (displacedClaim && !(await isTransactionBound(db, displacedClaim))) {
      await insertTransferItem(
        db,
        quote,
        {
          transactionHash: displacedClaim,
          logIndex: recordedClaim && sameTransactionHash(recordedClaim.transactionHash, displacedClaim)
            ? recordedClaim.logIndex
            : null,
          tokenAmountRaw:
            recordedClaim && sameTransactionHash(recordedClaim.transactionHash, displacedClaim)
              ? recordedClaim.tokenAmountRaw
              : null,
          observedAt: transfer.observedAt,
        },
        MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.extraTransfer
      );
    }
  }

  await completeClaimedSettlement(db, { ...quote, transactionHash: claim.transactionHash }, metadata, claim, lot);

  // The caller saw a different transfer than the one this quote settled with:
  // it is real money that was not credited here, so surface it once.
  if (
    !sameTransactionHash(transfer.transactionHash, claim.transactionHash) &&
    !(await isTransactionBound(db, transfer.transactionHash))
  ) {
    await insertTransferItem(db, quote, transfer, MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.extraTransfer);
  }
  return { status: "settled", quoteId: quote.id };
}

async function completeClaimedSettlement(
  db: SupabaseLike,
  quote: ManagedVeniceTokenQuote,
  metadata: Record<string, unknown>,
  claim: ManagedVeniceTokenSettlementClaim,
  existingLot: ManagedVeniceTokenDepositLot | null
) {
  const now = new Date().toISOString();
  const isOverSend = BigInt(claim.tokenAmountRaw) > BigInt(quote.tokenAmountRaw);
  const overSendMetadata = isOverSend
    ? {
        overSend: true,
        quotedTokenAmountRaw: quote.tokenAmountRaw,
        observedTokenAmountRaw: claim.tokenAmountRaw,
      }
    : {};

  if (!existingLot) {
    // The lot holds the ACTUAL received tokens so the spendable balance
    // reflects the real on-chain funds.
    const { error: lotError } = await table(db, "managed_venice_token_lots").insert({
      account_id: quote.accountId,
      user_id: quote.userId,
      quote_id: quote.id,
      source: "hermesos_deposit",
      token_amount_raw: claim.tokenAmountRaw,
      remaining_token_amount_raw: claim.tokenAmountRaw,
      snapshot_price_usd: quote.snapshotPriceUsd,
      original_value_micro_usd: claim.creditValueMicroUsd,
      remaining_value_micro_usd: claim.creditValueMicroUsd,
      quote_source: quote.source,
      quoted_at: quote.quotedAt,
      quote_expires_at: quote.expiresAt,
      transaction_hash: claim.transactionHash,
      status: "active",
      metadata: {
        quoteId: quote.id,
        observedAt: claim.observedAt,
        blockTimestamp: claim.blockTimestamp,
        logIndex: claim.logIndex,
        paidValueMicroUsd: claim.paidValueMicroUsd,
        creditValueMicroUsd: claim.creditValueMicroUsd,
        bonusValueMicroUsd: claim.bonusValueMicroUsd,
        ...overSendMetadata,
      },
    });
    if (lotError?.code === "23505") {
      // A concurrent completion of the same claim won the insert. It can only
      // have used the same claimed tx; anything else must not be papered over.
      const winner = await loadDepositLot(db, quote.id);
      if (!winner || !sameTransactionHash(winner.transactionHash, claim.transactionHash)) {
        throw new Error("Managed Venice token lot was created for a different transaction; retry to converge");
      }
    } else if (lotError) {
      throw new Error(lotError.message || "Failed to create managed Venice token lot");
    }
  }

  const { error: eventError } = await table(db, "managed_venice_financial_events").insert({
    user_id: quote.userId,
    account_id: quote.accountId,
    wallet_type: "hermesos",
    event_type: "token_deposit",
    reference_id: quote.id,
    idempotency_key: `managed_venice_token_deposit:${quote.id}:${claim.transactionHash}`,
    token_amount_raw: claim.tokenAmountRaw,
    token_price_usd: quote.snapshotPriceUsd,
    amount_micro_usd: claim.paidValueMicroUsd,
    metadata: {
      depositAddress: quote.depositAddress,
      transactionHash: claim.transactionHash,
      observedAt: claim.observedAt,
      creditValueMicroUsd: claim.creditValueMicroUsd,
      bonusValueMicroUsd: claim.bonusValueMicroUsd,
      ...overSendMetadata,
    },
  });
  // 23505 = this deposit event was already recorded for the claimed tx.
  if (eventError && eventError.code !== "23505") {
    throw new Error(
      eventError.message || "Failed to write managed Venice token deposit financial event"
    );
  }

  if (claim.bonusValueMicroUsd > 0) {
    const rate =
      quote.launchBonusMicroUsd > 0 && quote.standardBonusMicroUsd > 0
        ? "mixed_launch_standard"
        : quote.launchBonusMicroUsd > 0
          ? "launch_20"
          : "standard_10";
    const { error: subsidyEventError } = await table(db, "managed_venice_financial_events").insert({
      user_id: quote.userId,
      account_id: quote.accountId,
      wallet_type: "hermesos",
      event_type: "subsidy_applied",
      reference_id: quote.id,
      idempotency_key: `managed_venice_token_bonus:${quote.id}:${claim.transactionHash}`,
      token_amount_raw: claim.tokenAmountRaw,
      token_price_usd: quote.snapshotPriceUsd,
      amount_micro_usd: 0,
      discount_micro_usd: claim.bonusValueMicroUsd,
      metadata: {
        source: "managed_venice_deposit_bonus",
        rate,
        launchSubsidyMicroUsd: quote.launchBonusMicroUsd,
        standardSubsidyMicroUsd: quote.standardBonusMicroUsd,
        paidValueMicroUsd: claim.paidValueMicroUsd,
        creditValueMicroUsd: claim.creditValueMicroUsd,
        transactionHash: claim.transactionHash,
      },
    });
    // 23505 = bonus event already recorded for the claimed tx.
    if (subsidyEventError && subsidyEventError.code !== "23505") {
      throw new Error(
        subsidyEventError.message ||
          "Failed to write managed Venice token bonus financial event"
      );
    }
  }

  const existingTopUp = metadataRecord(metadata.managedVeniceTopUp);
  const { data, error: quoteError } = await table(db, "managed_venice_token_quotes")
    .update({
      status: "settled" satisfies ManagedVeniceTokenQuoteStatus,
      transfer_surfacing_pending: true,
      settled_at: now,
      updated_at: now,
      metadata: {
        ...metadata,
        observedAt: claim.observedAt,
        blockTimestamp: claim.blockTimestamp,
        managedVeniceTopUp: {
          ...existingTopUp,
          policy: "deposit_bonus_v1",
          walletType: "hermesos",
          paidValueMicroUsd: claim.paidValueMicroUsd,
          creditValueMicroUsd: claim.creditValueMicroUsd,
          bonusValueMicroUsd: claim.bonusValueMicroUsd,
          launchBonusMicroUsd: quote.launchBonusMicroUsd,
          standardBonusMicroUsd: quote.standardBonusMicroUsd,
        },
      },
    })
    .eq("id", quote.id)
    .eq("transaction_hash", claim.transactionHash)
    .in("status", OPEN_QUOTE_STATUSES)
    .select("id");

  if (quoteError) {
    throw new Error(quoteError.message || "Failed to settle managed Venice token quote");
  }
  if (affectedRowCount(data) === 0) {
    const current = await loadManagedVeniceTokenQuoteRecord(db, quote.id);
    if (
      current?.quote.status === "settled" &&
      sameTransactionHash(current.quote.transactionHash, claim.transactionHash)
    ) {
      return; // A concurrent completion of the same claim flipped it first.
    }
    throw new Error(
      `Managed Venice token quote could not be marked settled (status ${current?.quote.status ?? "missing"})`
    );
  }
}

// Retire an unpaid quote whose window + late-payment grace has been fully
// scanned: active|expired -> cancelled, only while nothing is claimed and no
// lot exists. Returns the quote's resulting status.
export async function retireManagedVeniceTokenQuote(
  params: { quoteId: string; closedAt?: Date },
  db: SupabaseLike | null | undefined = supabaseAdmin
): Promise<{ status: ManagedVeniceTokenQuoteStatus }> {
  const client = requireDb(db);
  const record = await loadManagedVeniceTokenQuoteRecord(client, params.quoteId);
  if (!record) {
    throw new Error("Managed Venice token quote not found");
  }
  const { quote } = record;
  if ((quote.status !== "active" && quote.status !== "expired") || quote.transactionHash) {
    return { status: quote.status };
  }
  if (await loadDepositLot(client, quote.id)) {
    return { status: quote.status };
  }

  const closedAt = (params.closedAt ?? new Date()).toISOString();
  const { data, error } = await table(client, "managed_venice_token_quotes")
    .update({
      status: "cancelled" satisfies ManagedVeniceTokenQuoteStatus,
      updated_at: new Date().toISOString(),
      metadata: { ...record.metadata, closedReason: "expired_unpaid", closedAt },
    })
    .eq("id", quote.id)
    .in("status", OPEN_QUOTE_STATUSES)
    .is("transaction_hash", null)
    .select("id");

  if (error) {
    throw new Error(error.message || "Failed to retire managed Venice token quote");
  }
  if (affectedRowCount(data) === 1) return { status: "cancelled" };
  const current = await loadManagedVeniceTokenQuoteRecord(client, quote.id);
  return { status: current?.quote.status ?? quote.status };
}

// Clear a terminal quote's transfer-surfacing obligation once the reconciler
// has surfaced every transfer in its fully confirmed attribution range. A
// compare-and-set on the flag, so a concurrent pass clearing it is harmless.
export async function completeManagedVeniceTokenTransferSurfacing(
  params: { quoteId: string },
  db: SupabaseLike | null | undefined = supabaseAdmin
): Promise<{ cleared: boolean }> {
  const { data, error } = await table(requireDb(db), "managed_venice_token_quotes")
    .update({ transfer_surfacing_pending: false, updated_at: new Date().toISOString() })
    .eq("id", params.quoteId)
    .eq("transfer_surfacing_pending", true)
    .select("id");

  if (error) {
    throw new Error(error.message || "Failed to complete managed Venice token transfer surfacing");
  }
  return { cleared: affectedRowCount(data) === 1 };
}
