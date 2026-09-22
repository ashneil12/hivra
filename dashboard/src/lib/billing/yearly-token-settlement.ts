/**
 * Yearly $HermesOS payments: bind an on-chain transfer to a quote and grant
 * (or renew) the year it paid for.
 *
 * The quote shows the user their credit_deposit Bankr wallet, which is SHARED
 * with managed-Venice $HermesOS top-ups. So a quote is paid by a specific
 * Transfer log, never by the wallet's balance:
 *
 *   1. Scan Transfer logs into the deposit address over the quote's own time
 *      range: quotedAt .. expiresAt + LATE_PAYMENT_GRACE, cut off at the start
 *      of the user's next $HermesOS payment session on that wallet
 *      (hermesos-transfer-attribution). Transfers any flow already bound are
 *      skipped.
 *   2. The EARLIEST confirmed in-window transfer of at least the quoted amount
 *      (and at most MAX_OVERSEND x) settles the quote through
 *      settle_yearly_token_payment, which claims the tx, activates or renews
 *      the subscription and consumes the quote in one transaction.
 *   3. Nothing qualifying: under-payments (once the window has closed),
 *      over-ceiling payments and in-band payments after the window go to an
 *      operator as yearly_token_reconciliation_items (one per transfer) and
 *      the quote moves to 'manual_review'. Other late transfers are surfaced
 *      without closing the quote.
 *   4. Once the whole range is scanned at full confirmations with nothing to
 *      act on, the quote retires to 'cancelled'.
 *
 * Mirrors the managed-Venice reconciler on claude/venice-settlement-fixes.
 */

import { requireDb } from "@/lib/billing/db-utils";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import { supabaseAdmin } from "@/lib/supabase";
import { normalizeRpcRetryConfig, sleep, type RpcCallOptions, type RpcRetryConfig } from "@/lib/billing/base-rpc-retry";
import {
  createBaseChainReader,
  scanTokenTransfersTo,
  type BaseChainReader,
  type JsonRpcFetch,
  type ScannedTransfer,
} from "@/lib/billing/base-token-transfers";
import {
  floorToSecondMs,
  loadBoundHermesosTransactionHashes,
  loadNextHermesosPaymentSessionMs,
} from "@/lib/billing/hermesos-transfer-attribution";
import { HERMESOS_TOKEN_ADDRESS, normalizeEvmAddress } from "@/lib/billing/token-holdings";
import type { TierKey } from "@/lib/billing/tier-thresholds";
import {
  asYearlyTokenQuote,
  YEARLY_QUOTE_SELECT_COLUMNS,
  type YearlyQuoteRow,
  type YearlyTokenQuote,
} from "@/lib/billing/yearly-token-quotes";

/** A payment mined after the quote window but within this grace is still attributed to the quote (for review). */
export const YEARLY_LATE_PAYMENT_GRACE_MS = 2 * 60 * 60_000;
/** Payments above quoted * 2 are not auto-accepted (fat-finger over-sends go to review for a refund decision). */
export const YEARLY_MAX_OVERSEND_NUMERATOR = 2n;
export const YEARLY_MAX_OVERSEND_DENOMINATOR = 1n;

const DEFAULT_MIN_CONFIRMATIONS = 3;
const DEFAULT_BATCH_LIMIT = 25;
const MAX_BATCH_LIMIT = 100;
// Short pause between quotes so one tick's eth_getLogs fan-out stays under the
// public Base endpoint's rate limit.
const DEFAULT_INTER_QUOTE_DELAY_MS = 150;

export type YearlyReviewReason =
  | "underpaid"
  | "overpaid"
  | "late_payment"
  | "unattributed_late_transfer"
  | "extra_transfer"
  | "legacy_subscription_exists";

export type YearlyReconcileStatus =
  | "activated"
  | "renewed"
  | "already_settled"
  | "underconfirmed"
  | "no_match"
  | "manual_review"
  | "cancelled"
  | "transaction_already_claimed"
  | "closed";

export interface YearlyReconcileResult {
  quoteId: string;
  userId: string;
  tier: TierKey;
  status: YearlyReconcileStatus;
  subscriptionId?: string | null;
  expiresAt?: string | null;
  transactionHash?: string | null;
  amountReceivedRaw?: string;
  confirmations?: number;
  reason?: YearlyReviewReason;
  quoteStatus?: string;
}

export interface YearlyReconcileBatchResult {
  checked: number;
  activated: number;
  renewed: number;
  underconfirmed: number;
  noMatch: number;
  manualReview: number;
  cancelled: number;
  skipped: number;
  failed: number;
  results: Array<YearlyReconcileResult | (Pick<YearlyReconcileResult, "quoteId" | "userId" | "tier"> & {
    status: "failed";
    errorName: string;
    errorMessage: string;
  })>;
}

type QueryError = { code?: string; message?: string } | null;

type DbQuery = {
  select: (...args: unknown[]) => DbQuery;
  eq: (...args: unknown[]) => DbQuery;
  in: (...args: unknown[]) => DbQuery;
  is: (...args: unknown[]) => DbQuery;
  order: (...args: unknown[]) => DbQuery;
  limit: (...args: unknown[]) => DbQuery;
  maybeSingle: () => Promise<{ data: unknown; error: QueryError }>;
  then: Promise<{ data?: unknown; error: QueryError }>["then"];
};

type DbTable = {
  select: (...args: unknown[]) => DbQuery;
  insert: (row: unknown) => DbQuery;
  update: (patch: unknown) => DbQuery;
};

export type YearlySettlementDb = {
  from: (name: string) => unknown;
  rpc: (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: QueryError }>;
};

function table(db: YearlySettlementDb, name: string) {
  return db.from(name) as DbTable;
}

function asSettlementDb(db: unknown) {
  return requireDb(db as YearlySettlementDb | null) as YearlySettlementDb;
}

interface SettlementRpcResult {
  status:
    | "activated"
    | "renewed"
    | "already_settled"
    | "quote_settled_with_other_transaction"
    | "not_settleable"
    | "legacy_subscription_exists"
    | "transaction_already_claimed"
    | "not_found"
    | "invalid_transaction"
    | "invalid_amount";
  subscription_id?: string | null;
  expires_at?: string | null;
  renewed_subscription_id?: string | null;
  transaction_hash?: string | null;
  quote_status?: string;
}

async function settleYearlyTokenPayment(
  db: YearlySettlementDb,
  params: { quoteId: string; transfer: ScannedTransfer; now: Date }
): Promise<SettlementRpcResult> {
  const { data, error } = await db.rpc("settle_yearly_token_payment", {
    p_quote_id: params.quoteId,
    p_transaction_hash: params.transfer.transactionHash,
    p_log_index: params.transfer.logIndex,
    // numeric: a string keeps the full 78-digit precision through PostgREST.
    p_amount_raw: params.transfer.amount.toString(),
    p_block_timestamp: params.transfer.observedAt,
    p_now: params.now.toISOString(),
  });
  if (error) {
    throw new Error(`settle_yearly_token_payment failed: ${error.message || error.code || "unknown error"}`);
  }
  const result = data as SettlementRpcResult | null;
  if (!result || typeof result.status !== "string") {
    throw new Error("settle_yearly_token_payment returned no status");
  }
  return result;
}

type TransferClass = "qualifying" | "over" | "under" | "late_qualifying" | "late_other";

const CLASS_REASON: Record<TransferClass, YearlyReviewReason> = {
  qualifying: "extra_transfer",
  over: "overpaid",
  under: "underpaid",
  late_qualifying: "late_payment",
  late_other: "unattributed_late_transfer",
};

function classify(transfer: ScannedTransfer, band: { required: bigint; ceiling: bigint; expiresAtMs: number }) {
  const inBand = transfer.amount >= band.required && transfer.amount <= band.ceiling;
  if (transfer.timestampMs > band.expiresAtMs) return inBand ? "late_qualifying" : "late_other";
  if (inBand) return "qualifying";
  return transfer.amount > band.ceiling ? "over" : "under";
}

export function yearlyTransferDedupeKey(transfer: Pick<ScannedTransfer, "transactionHash" | "logIndex">) {
  return `yearly_token_transfer:${transfer.transactionHash.toLowerCase()}:${transfer.logIndex}`;
}

/**
 * Record a transfer an operator has to look at. One row per transfer: a
 * repeat (every cron tick, the cron racing a user's check) hits the unique
 * dedupe key and is treated as already surfaced. Returns true when new.
 */
async function surfaceTransfer(
  db: YearlySettlementDb,
  quote: YearlyTokenQuote,
  transfer: ScannedTransfer,
  reason: YearlyReviewReason,
  subscriptionId: string | null = null
) {
  const { error } = await table(db, "yearly_token_reconciliation_items").insert({
    user_id: quote.userId,
    quote_id: quote.id,
    subscription_id: subscriptionId,
    status: "open",
    reason,
    transaction_hash: transfer.transactionHash,
    log_index: transfer.logIndex,
    token_amount_raw: transfer.amount.toString(),
    tokens_required_raw: quote.tokensRequiredRaw.toString(),
    deposit_address: normalizeEvmAddress(quote.depositAddress),
    observed_at: transfer.observedAt,
    dedupe_key: yearlyTransferDedupeKey(transfer),
    metadata: {
      tier: quote.tier,
      blockNumber: transfer.blockNumber,
      confirmations: transfer.confirmations,
      quoteExpiresAt: quote.expiresAt,
    },
  });
  if (error) {
    if (error.code === "23505") return false;
    throw new Error(`Failed to record yearly token reconciliation item: ${error.message || "unknown error"}`);
  }
  await reportOpsEvent({
    source: "billing.yearly-token-payments",
    severity: "warn",
    title: "Yearly $HermesOS payment needs review",
    message:
      `A $HermesOS transfer to a yearly quote's deposit wallet could not be credited automatically ` +
      `(${reason}). It is recorded in yearly_token_reconciliation_items.`,
    userId: quote.userId,
    metadata: {
      failureType: "yearly_token_payment_review",
      reason,
      quoteId: quote.id,
      subscriptionId,
      transactionHash: transfer.transactionHash,
      logIndex: transfer.logIndex,
      tokenAmountRaw: transfer.amount.toString(),
      tokensRequiredRaw: quote.tokensRequiredRaw.toString(),
    },
  });
  return true;
}

/** active|expired -> status, only while no transfer is bound to the quote. */
async function closeQuote(db: YearlySettlementDb, quoteId: string, status: "manual_review" | "cancelled", now: Date) {
  const { data, error } = await table(db, "yearly_token_quotes")
    .update({ status, updated_at: now.toISOString() })
    .eq("id", quoteId)
    .in("status", ["active", "expired"])
    .is("consumed_tx_hash", null)
    .select("id, status");
  if (error) throw new Error(`Failed to move yearly quote to ${status}: ${error.message || "unknown error"}`);
  return Array.isArray(data) && data.length > 0;
}

// Conversion stamp (write-once): a yearly token payment flips the user's
// entitlement without touching hermes_subscriptions.plan, so the funnel's
// upgraded_at is stamped here. Best-effort: never blocks the activation.
async function stampTokenConversion(db: YearlySettlementDb, userId: string, now: Date) {
  try {
    await table(db, "hermes_subscriptions")
      .update({ upgraded_at: now.toISOString(), upgrade_source: "token_payment" })
      .eq("user_id", userId)
      .is("upgraded_at", null);
  } catch {
    // Analytics stamp only — activation already succeeded.
  }
}

export async function reconcileYearlyTokenQuote(params: {
  quote: YearlyTokenQuote;
  db?: unknown;
  chain?: BaseChainReader;
  rpcUrl?: string;
  fetchImpl?: JsonRpcFetch;
  rpcOptions?: RpcCallOptions;
  minConfirmations?: number;
  now?: Date;
}): Promise<YearlyReconcileResult> {
  const db = asSettlementDb(params.db ?? supabaseAdmin);
  const { quote } = params;
  const base = { quoteId: quote.id, userId: quote.userId, tier: quote.tier };
  if (quote.status !== "active" && quote.status !== "expired") {
    return { ...base, status: "closed", quoteStatus: quote.status };
  }

  const now = params.now ?? new Date();
  const minConfirmations = normalizeMinConfirmations(params.minConfirmations);
  const chain =
    params.chain ?? createBaseChainReader({ rpcUrl: params.rpcUrl, fetchImpl: params.fetchImpl, rpcOptions: params.rpcOptions });

  const quotedAtMs = floorToSecondMs(Date.parse(quote.quotedAt));
  const expiresAtMs = Date.parse(quote.expiresAt);
  if (!Number.isFinite(quotedAtMs) || !Number.isFinite(expiresAtMs)) {
    throw new Error(`Yearly quote ${quote.id} has an invalid window`);
  }
  const graceEndMs = expiresAtMs + YEARLY_LATE_PAYMENT_GRACE_MS;
  const boundaryMs = await loadNextHermesosPaymentSessionMs(db, {
    userId: quote.userId,
    depositAddress: quote.depositAddress,
    quotedAt: quote.quotedAt,
  });
  // A transfer at or after the next session's start belongs to that session.
  const rangeEndMs = boundaryMs === null ? graceEndMs : Math.min(graceEndMs, boundaryMs - 1);

  const scan = await scanTokenTransfersTo({
    chain,
    tokenAddress: HERMESOS_TOKEN_ADDRESS,
    recipient: quote.depositAddress,
    fromMs: quotedAtMs,
    toMs: rangeEndMs,
    minConfirmations,
  });
  const bound = await loadBoundHermesosTransactionHashes(
    db,
    scan.transfers.map((transfer) => transfer.transactionHash)
  );
  const attributable = scan.transfers.filter((transfer) => !bound.has(transfer.transactionHash));

  const required = quote.tokensRequiredRaw;
  const band = {
    required,
    ceiling: (required * YEARLY_MAX_OVERSEND_NUMERATOR) / YEARLY_MAX_OVERSEND_DENOMINATOR,
    expiresAtMs,
  };
  const classOf = (transfer: ScannedTransfer) => classify(transfer, band);
  const isConfirmed = (transfer: ScannedTransfer) => transfer.confirmations >= minConfirmations;

  // 1. The EARLIEST qualifying in-window transfer in chain order settles the
  //    quote. Later arrivals never displace it; an under-confirmed candidate is
  //    waited for, never skipped.
  const candidate = attributable.find((transfer) => classOf(transfer) === "qualifying");
  if (candidate) {
    if (!isConfirmed(candidate)) {
      return { ...base, status: "underconfirmed", confirmations: candidate.confirmations };
    }
    const settlement = await settleYearlyTokenPayment(db, { quoteId: quote.id, transfer: candidate, now });
    const settledResult = {
      ...base,
      transactionHash: candidate.transactionHash,
      amountReceivedRaw: candidate.amount.toString(),
      subscriptionId: settlement.subscription_id ?? null,
      expiresAt: settlement.expires_at ?? null,
      confirmations: candidate.confirmations,
    };
    switch (settlement.status) {
      case "activated":
      case "renewed":
      case "already_settled": {
        if (settlement.status !== "already_settled") await stampTokenConversion(db, quote.userId, now);
        for (const extra of attributable) {
          if (extra !== candidate && isConfirmed(extra)) {
            await surfaceTransfer(db, quote, extra, "extra_transfer", settlement.subscription_id ?? null);
          }
        }
        return { ...settledResult, status: settlement.status };
      }
      case "transaction_already_claimed":
        // Another flow bound this transfer between our read and the claim; the
        // next pass no longer sees it as attributable.
        return { ...settledResult, status: "transaction_already_claimed", subscriptionId: null, expiresAt: null };
      case "legacy_subscription_exists":
        await surfaceTransfer(db, quote, candidate, "legacy_subscription_exists");
        await closeQuote(db, quote.id, "manual_review", now);
        return { ...settledResult, status: "manual_review", reason: "legacy_subscription_exists", subscriptionId: null };
      case "quote_settled_with_other_transaction":
      case "not_settleable":
      case "not_found":
        return { ...base, status: "closed", quoteStatus: settlement.quote_status ?? settlement.status };
      default:
        throw new Error(`settle_yearly_token_payment rejected the transfer: ${settlement.status}`);
    }
  }

  // 2. No qualifying transfer. Over-ceiling and late in-band payments go to
  //    review now; an under-payment only once the window has closed on a
  //    confirmed chain, so the user can still send the full amount until then.
  //    Items are written BEFORE the quote closes, so a review is never
  //    invisible.
  const confirmed = attributable.filter(isConfirmed);
  const windowClosed = now.getTime() > expiresAtMs && scan.confirmedHeadMs >= expiresAtMs;
  const reviewTrigger =
    confirmed.find((transfer) => classOf(transfer) === "over") ??
    confirmed.find((transfer) => classOf(transfer) === "late_qualifying") ??
    (windowClosed ? confirmed.find((transfer) => classOf(transfer) === "under") : undefined);
  if (reviewTrigger) {
    for (const transfer of confirmed) {
      await surfaceTransfer(db, quote, transfer, CLASS_REASON[classOf(transfer)]);
    }
    await closeQuote(db, quote.id, "manual_review", now);
    return {
      ...base,
      status: "manual_review",
      reason: CLASS_REASON[classOf(reviewTrigger)],
      transactionHash: reviewTrigger.transactionHash,
      amountReceivedRaw: reviewTrigger.amount.toString(),
    };
  }

  // Late out-of-band transfers never settle or review the quote: item only.
  const lateOther = confirmed.filter((transfer) => classOf(transfer) === "late_other");
  for (const transfer of lateOther) {
    await surfaceTransfer(db, quote, transfer, "unattributed_late_transfer");
  }

  const awaiting = attributable.filter((transfer) => !isConfirmed(transfer) && classOf(transfer) !== "late_other");
  if (awaiting.length > 0) {
    return {
      ...base,
      status: "underconfirmed",
      confirmations: Math.max(...awaiting.map((transfer) => transfer.confirmations)),
    };
  }

  // 3. Retire: the whole range is scanned at full confirmations and nothing
  //    left can settle or review this quote.
  const fullyScanned = now.getTime() > rangeEndMs && scan.confirmedHeadMs >= rangeEndMs;
  if (fullyScanned && confirmed.length === lateOther.length) {
    await closeQuote(db, quote.id, "cancelled", now);
    return { ...base, status: "cancelled" };
  }

  return { ...base, status: "no_match" };
}

function normalizeMinConfirmations(confirmations: number | undefined) {
  if (!Number.isFinite(confirmations)) return DEFAULT_MIN_CONFIRMATIONS;
  return Math.max(1, Math.min(100, Math.floor(confirmations ?? DEFAULT_MIN_CONFIRMATIONS)));
}

function normalizeBatchLimit(limit: number | undefined) {
  if (!Number.isFinite(limit)) return DEFAULT_BATCH_LIMIT;
  return Math.max(1, Math.min(MAX_BATCH_LIMIT, Math.floor(limit ?? DEFAULT_BATCH_LIMIT)));
}

/**
 * Quotes whose window or late-payment grace may still hold a payment, newest
 * first: a fresh payment is always inside the batch however many older quotes
 * are open, and older ones leave the set by settling, going to review or
 * retiring.
 */
export async function loadReconcilableYearlyTokenQuotes(params: {
  db?: unknown;
  userId?: string;
  tier?: TierKey;
  limit?: number;
}) {
  const db = asSettlementDb(params.db ?? supabaseAdmin);
  let query = table(db, "yearly_token_quotes")
    .select(YEARLY_QUOTE_SELECT_COLUMNS)
    .in("status", ["active", "expired"]);
  if (params.userId) query = query.eq("user_id", params.userId);
  if (params.tier) query = query.eq("tier", params.tier);
  const { data, error } = await query.order("quoted_at", { ascending: false }).limit(normalizeBatchLimit(params.limit));
  if (error) throw new Error(`Failed to load reconcilable yearly quotes: ${error.message || "unknown error"}`);
  return ((Array.isArray(data) ? data : []) as YearlyQuoteRow[]).map(asYearlyTokenQuote);
}

export async function reconcilePendingYearlyTokenQuotes(
  params: {
    db?: unknown;
    userId?: string;
    tier?: TierKey;
    limit?: number;
    now?: Date;
    minConfirmations?: number;
    rpcUrl?: string;
    fetchImpl?: JsonRpcFetch;
    rpcRetryConfig?: Partial<RpcRetryConfig>;
    rpcSleepImpl?: (ms: number) => Promise<void>;
    interQuoteDelayMs?: number;
  } = {}
): Promise<YearlyReconcileBatchResult> {
  const db = asSettlementDb(params.db ?? supabaseAdmin);
  const quotes = await loadReconcilableYearlyTokenQuotes({
    db,
    userId: params.userId,
    tier: params.tier,
    limit: params.limit,
  });
  const rpcOptions: RpcCallOptions = {
    retryConfig: normalizeRpcRetryConfig(params.rpcRetryConfig),
    sleepImpl: params.rpcSleepImpl,
  };
  // One chain view per batch: the head and block timestamps are fetched once.
  const chain = createBaseChainReader({ rpcUrl: params.rpcUrl, fetchImpl: params.fetchImpl, rpcOptions });
  const sleepImpl = params.rpcSleepImpl ?? sleep;
  const interQuoteDelayMs = Number.isFinite(params.interQuoteDelayMs)
    ? Math.max(0, Math.floor(params.interQuoteDelayMs as number))
    : DEFAULT_INTER_QUOTE_DELAY_MS;

  const summary: YearlyReconcileBatchResult = {
    checked: 0,
    activated: 0,
    renewed: 0,
    underconfirmed: 0,
    noMatch: 0,
    manualReview: 0,
    cancelled: 0,
    skipped: 0,
    failed: 0,
    results: [],
  };

  for (const [index, quote] of quotes.entries()) {
    if (index > 0 && interQuoteDelayMs > 0) await sleepImpl(interQuoteDelayMs);
    summary.checked += 1;
    try {
      const result = await reconcileYearlyTokenQuote({
        quote,
        db,
        chain,
        minConfirmations: params.minConfirmations,
        now: params.now,
      });
      if (result.status === "activated") summary.activated += 1;
      else if (result.status === "renewed") summary.renewed += 1;
      else if (result.status === "underconfirmed") summary.underconfirmed += 1;
      else if (result.status === "no_match") summary.noMatch += 1;
      else if (result.status === "manual_review") summary.manualReview += 1;
      else if (result.status === "cancelled") summary.cancelled += 1;
      else summary.skipped += 1;
      summary.results.push(result);
    } catch (error) {
      summary.failed += 1;
      log.error("yearly token quote reconciliation failed; continuing", error, {
        source: "yearly-token-settlement",
        userId: quote.userId,
        quoteId: quote.id,
        failureType: "yearly_token_reconcile_failed",
      });
      summary.results.push({
        quoteId: quote.id,
        userId: quote.userId,
        tier: quote.tier,
        status: "failed",
        errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return summary;
}
