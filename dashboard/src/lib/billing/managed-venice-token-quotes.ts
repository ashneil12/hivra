import { requireDb } from "@/lib/billing/db-utils";
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

type ManagedVeniceTokenQuoteStatus =
  | "active"
  | "settled"
  | "expired"
  | "manual_review_required"
  | "cancelled";

type QueryError = { code?: string; message?: string } | null;

type DbChain = {
  select: (...args: unknown[]) => DbChain;
  eq: (...args: unknown[]) => DbChain;
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

type DbUpdateFilter = {
  eq: (...args: unknown[]) => DbUpdateFilter;
  select?: (...args: unknown[]) => {
    single: () => Promise<{ data: unknown; error: QueryError }>;
  };
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
}

const SELECT_COLUMNS =
  "id, account_id, user_id, token_amount_raw::text, snapshot_price_usd, " +
  "locked_value_micro_usd, deposit_address, quoted_at, expires_at, status, " +
  "source, cross_check_source, cross_check_price_usd, price_last_updated_at, " +
  "cross_check_last_updated_at, transaction_hash, settled_at, metadata";

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
  };
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

async function loadManagedVeniceTokenQuoteById(
  db: SupabaseLike,
  quoteId: string
): Promise<ManagedVeniceTokenQuote | null> {
  const { data, error } = await table(db, "managed_venice_token_quotes")
    .select(SELECT_COLUMNS)
    .eq("id", quoteId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message || "Failed to load managed Venice token quote");
  }
  return data ? asQuote(data as TokenQuoteRow) : null;
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

async function writeManualReview(params: {
  db: SupabaseLike;
  quote: ManagedVeniceTokenQuote;
  transactionHash: string;
  tokenAmountRaw: string;
  observedAt: string;
  reason: string;
}) {
  const now = new Date().toISOString();
  const { error: updateError } = await table(params.db, "managed_venice_token_quotes")
    .update({
      status: "manual_review_required" satisfies ManagedVeniceTokenQuoteStatus,
      transaction_hash: params.transactionHash,
      updated_at: now,
      metadata: {
        manualReviewReason: params.reason,
        observedTokenAmountRaw: params.tokenAmountRaw,
        observedAt: params.observedAt,
      },
    })
    .eq("id", params.quote.id);

  if (updateError) {
    throw new Error(updateError.message || "Failed to mark managed Venice token quote for review");
  }

  await writeReconciliationItem(params);
  return { status: "manual_review_required" as const };
}

async function writeReconciliationItem(params: {
  db: SupabaseLike;
  quote: ManagedVeniceTokenQuote;
  transactionHash: string;
  tokenAmountRaw: string;
  observedAt: string;
  reason: string;
}) {
  const { error: reconciliationError } = await table(
    params.db,
    "managed_venice_reconciliation_items"
  ).insert({
    user_id: params.quote.userId,
    account_id: params.quote.accountId,
    status: "open",
    reason: params.reason,
    metadata: {
      quoteId: params.quote.id,
      transactionHash: params.transactionHash,
      observedTokenAmountRaw: params.tokenAmountRaw,
      expectedTokenAmountRaw: params.quote.tokenAmountRaw,
      observedAt: params.observedAt,
    },
  });

  if (reconciliationError) {
    throw new Error(
      reconciliationError.message || "Failed to create managed Venice reconciliation item"
    );
  }
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

export async function settleManagedVeniceTokenQuote(
  params: {
    quoteId: string;
    transactionHash: string;
    tokenAmountRaw: string | bigint;
    observedAt: string;
    blockTimestamp?: string | null;
  },
  db: SupabaseLike | null | undefined = supabaseAdmin
) {
  if (!params.quoteId.trim()) {
    throw new Error("Managed Venice token quote ID is required");
  }
  if (!params.transactionHash.trim()) {
    throw new Error("Managed Venice token quote transaction hash is required");
  }
  const tokenAmountRaw = requireTokenAmountRaw(params.tokenAmountRaw).toString();
  const client = requireDb(db);
  const quote = await loadManagedVeniceTokenQuoteById(client, params.quoteId);
  if (!quote) {
    throw new Error("Managed Venice token quote not found");
  }

  const observedAt = new Date(params.blockTimestamp || params.observedAt);
  if (Number.isNaN(observedAt.getTime())) {
    throw new Error("Managed Venice token quote observedAt is invalid");
  }
  const quotedAt = new Date(quote.quotedAt);
  const storedExpiresAt = new Date(quote.expiresAt);
  const effectiveExpiresAt = new Date(
    Math.max(
      storedExpiresAt.getTime(),
      quotedAt.getTime() + MANAGED_VENICE_QUOTE_LIFETIME_MS
    )
  );
  const observedAtIso = observedAt.toISOString();

  if (quote.status === "settled") {
    // Idempotent redelivery of the SAME settled deposit. The amount can legally
    // differ from the quote when the original settlement was an accepted
    // over-send (quoted <= observed <= quoted*ceiling), so accept the same band
    // here rather than requiring a byte-exact amount — otherwise a benign retry
    // of an over-send would spuriously open a "replayed_after_settlement" item.
    const settledQuotedAmount = BigInt(quote.tokenAmountRaw);
    const settledObservedAmount = BigInt(tokenAmountRaw);
    const settledOverSendCeiling =
      (settledQuotedAmount * MANAGED_VENICE_MAX_OVERSEND_NUMERATOR) /
      MANAGED_VENICE_MAX_OVERSEND_DENOMINATOR;
    const amountWithinSettledBand =
      settledObservedAmount >= settledQuotedAmount &&
      settledObservedAmount <= settledOverSendCeiling;
    if (
      quote.transactionHash === params.transactionHash &&
      (tokenAmountRaw === quote.tokenAmountRaw || amountWithinSettledBand)
    ) {
      return { status: "settled" as const, quoteId: quote.id, idempotent: true };
    }

    await writeReconciliationItem({
      db: client,
      quote,
      transactionHash: params.transactionHash,
      tokenAmountRaw,
      observedAt: observedAtIso,
      reason: "managed_venice_token_deposit_replayed_after_settlement",
    });
    return { status: "manual_review_required" as const };
  }

  if (
    (quote.status !== "active" && quote.status !== "expired") ||
    observedAt < quotedAt ||
    observedAt > effectiveExpiresAt
  ) {
    return writeManualReview({
      db: client,
      quote,
      transactionHash: params.transactionHash,
      tokenAmountRaw,
      observedAt: observedAtIso,
      reason: "managed_venice_token_deposit_outside_quote_window",
    });
  }

  // ── Amount reconciliation (under-pay / exact / over-send) ─────────────
  // The user can send a different on-chain amount than the quote asked for.
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
  // only ever sees same-token amounts.
  const observedTokenAmount = BigInt(tokenAmountRaw);
  const quotedTokenAmount = BigInt(quote.tokenAmountRaw);
  const overSendCeiling =
    (quotedTokenAmount * MANAGED_VENICE_MAX_OVERSEND_NUMERATOR) /
    MANAGED_VENICE_MAX_OVERSEND_DENOMINATOR;

  if (observedTokenAmount < quotedTokenAmount) {
    return writeManualReview({
      db: client,
      quote,
      transactionHash: params.transactionHash,
      tokenAmountRaw,
      observedAt: observedAtIso,
      reason: "managed_venice_token_deposit_underpaid",
    });
  }

  if (observedTokenAmount > overSendCeiling) {
    return writeManualReview({
      db: client,
      quote,
      transactionHash: params.transactionHash,
      tokenAmountRaw,
      observedAt: observedAtIso,
      reason: "managed_venice_token_deposit_amount_mismatch",
    });
  }

  const now = new Date().toISOString();
  const isOverSend = observedTokenAmount > quotedTokenAmount;
  // The lot holds the ACTUAL received tokens so the spendable balance reflects
  // the real on-chain funds. For an exact match this is identical to the quote.
  const settledTokenAmountRaw = tokenAmountRaw;
  // Credit the actual paid value pro-rata: the excess tokens were bought at the
  // SAME snapshot price the quote locked, so paid value scales linearly with
  // the observed amount. The bonus/subsidy is NOT scaled up — it was sized and
  // cap-checked against the original quote, and over-sent excess shouldn't mint
  // extra subsidy past the hidden per-user bonus cap. Net effect: the user gets
  // full credit for every real token they sent; only the bonus stays as quoted.
  // For an exact match (observed === quoted) every value below is byte-identical
  // to the previous behavior.
  const paidValueMicroUsd = isOverSend
    ? Number(
        (BigInt(quote.paidValueMicroUsd) * observedTokenAmount) /
          quotedTokenAmount
      )
    : quote.paidValueMicroUsd;
  const bonusValueMicroUsd = quote.bonusValueMicroUsd;
  const creditValueMicroUsd = isOverSend
    ? paidValueMicroUsd + bonusValueMicroUsd
    : quote.creditValueMicroUsd;

  // ── Idempotency guard against double-credit on retry ──────────────────
  // The lot insert, financial-event inserts, and quote-status flip below
  // are NOT one transaction, and the lot insert has no unique key. A
  // settlement that creates the lot but dies before flipping the quote to
  // `settled` would, on the reconciler's next pass, hit this branch again
  // (status still `active`) and insert a SECOND spendable lot. The deposit
  // event's idempotency_key dedupes the *audit ledger* but NOT the lot, and
  // lots are the spendable balance — so a duplicate lot is a real double-
  // credit. A lot already existing for this quote means the credit was
  // granted; converge to settled instead of inserting another.
  const existingLot = await table(client, "managed_venice_token_lots")
    .select("id")
    .eq("quote_id", quote.id)
    .maybeSingle();
  if (existingLot.error) {
    throw new Error(
      existingLot.error.message || "Failed to check existing managed Venice token lot"
    );
  }
  const lotAlreadyExists = Boolean(existingLot.data);

  if (!lotAlreadyExists) {
    const { error: lotError } = await table(client, "managed_venice_token_lots").insert({
      account_id: quote.accountId,
      user_id: quote.userId,
      quote_id: quote.id,
      source: "hermesos_deposit",
      token_amount_raw: settledTokenAmountRaw,
      remaining_token_amount_raw: settledTokenAmountRaw,
      snapshot_price_usd: quote.snapshotPriceUsd,
      original_value_micro_usd: creditValueMicroUsd,
      remaining_value_micro_usd: creditValueMicroUsd,
      quote_source: quote.source,
      quoted_at: quote.quotedAt,
      quote_expires_at: quote.expiresAt,
      transaction_hash: params.transactionHash,
      status: "active",
      metadata: {
        quoteId: quote.id,
        observedAt: observedAtIso,
        blockTimestamp: params.blockTimestamp || null,
        paidValueMicroUsd,
        creditValueMicroUsd,
        bonusValueMicroUsd,
        ...(isOverSend
          ? {
              overSend: true,
              quotedTokenAmountRaw: quote.tokenAmountRaw,
              observedTokenAmountRaw: settledTokenAmountRaw,
            }
          : {}),
      },
    });
    // 23505 (unique_violation) = a concurrent settlement of the same quote
    // won the race and already inserted the lot. Belt-and-suspenders with
    // the existence check above; treat as already-credited, not an error.
    if (lotError && lotError.code !== "23505") {
      throw new Error(lotError.message || "Failed to create managed Venice token lot");
    }
  }

  const { error: eventError } = await table(
    client,
    "managed_venice_financial_events"
  ).insert({
    user_id: quote.userId,
    account_id: quote.accountId,
    wallet_type: "hermesos",
    event_type: "token_deposit",
    reference_id: quote.id,
    idempotency_key: `managed_venice_token_deposit:${quote.id}:${params.transactionHash}`,
    token_amount_raw: settledTokenAmountRaw,
    token_price_usd: quote.snapshotPriceUsd,
    amount_micro_usd: paidValueMicroUsd,
    metadata: {
      depositAddress: quote.depositAddress,
      transactionHash: params.transactionHash,
      observedAt: observedAtIso,
      creditValueMicroUsd,
      bonusValueMicroUsd,
      ...(isOverSend
        ? {
            overSend: true,
            quotedTokenAmountRaw: quote.tokenAmountRaw,
            observedTokenAmountRaw: settledTokenAmountRaw,
          }
        : {}),
    },
  });
  // 23505 = this deposit event was already recorded (idempotent redelivery
  // of the same quote+tx). The unique idempotency_key did its job; don't
  // throw, so a retry can still reach the quote-status flip below.
  if (eventError && eventError.code !== "23505") {
    throw new Error(
      eventError.message || "Failed to write managed Venice token deposit financial event"
    );
  }

  if (bonusValueMicroUsd > 0) {
    const rate =
      quote.launchBonusMicroUsd > 0 && quote.standardBonusMicroUsd > 0
        ? "mixed_launch_standard"
        : quote.launchBonusMicroUsd > 0
          ? "launch_20"
          : "standard_10";
    const { error: subsidyEventError } = await table(
      client,
      "managed_venice_financial_events"
    ).insert({
      user_id: quote.userId,
      account_id: quote.accountId,
      wallet_type: "hermesos",
      event_type: "subsidy_applied",
      reference_id: quote.id,
      idempotency_key: `managed_venice_token_bonus:${quote.id}:${params.transactionHash}`,
      token_amount_raw: settledTokenAmountRaw,
      token_price_usd: quote.snapshotPriceUsd,
      amount_micro_usd: 0,
      discount_micro_usd: bonusValueMicroUsd,
      metadata: {
        source: "managed_venice_deposit_bonus",
        rate,
        launchSubsidyMicroUsd: quote.launchBonusMicroUsd,
        standardSubsidyMicroUsd: quote.standardBonusMicroUsd,
        paidValueMicroUsd,
        creditValueMicroUsd,
        transactionHash: params.transactionHash,
      },
    });
    // 23505 = idempotent redelivery (bonus event already recorded). Mirror
    // the deposit-event handling above: don't throw on the duplicate.
    if (subsidyEventError && subsidyEventError.code !== "23505") {
      throw new Error(
        subsidyEventError.message ||
          "Failed to write managed Venice token bonus financial event"
      );
    }
  }

  const { error: quoteError } = await table(client, "managed_venice_token_quotes")
    .update({
      status: "settled" satisfies ManagedVeniceTokenQuoteStatus,
      transaction_hash: params.transactionHash,
      settled_at: now,
      updated_at: now,
      metadata: {
        observedAt: observedAtIso,
        blockTimestamp: params.blockTimestamp || null,
        managedVeniceTopUp: {
          policy: "deposit_bonus_v1",
          walletType: "hermesos",
          paidValueMicroUsd,
          creditValueMicroUsd,
          bonusValueMicroUsd,
          launchBonusMicroUsd: quote.launchBonusMicroUsd,
          standardBonusMicroUsd: quote.standardBonusMicroUsd,
        },
      },
    })
    .eq("id", quote.id);

  if (quoteError) {
    throw new Error(quoteError.message || "Failed to settle managed Venice token quote");
  }

  return { status: "settled" as const, quoteId: quote.id };
}
