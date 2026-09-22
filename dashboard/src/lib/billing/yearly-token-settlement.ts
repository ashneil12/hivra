/**
 * Yearly $HermesOS payments: bind an on-chain transfer to a quote and grant
 * (or renew) the year it paid for.
 *
 * The quote shows the user their credit_deposit Bankr wallet, which is SHARED
 * with managed-Venice $HermesOS top-ups. So a quote is paid by a specific
 * Transfer log, never by the wallet's balance.
 *
 * Every quote owns an attribution RANGE on its deposit wallet:
 *
 *     quotedAt .. min(expiresAt + LATE_PAYMENT_GRACE, next $HermesOS session)
 *
 * (hermesos-transfer-attribution). Transfers another flow already owns are
 * skipped. The reconciler keeps watching the range until it has been scanned
 * at full confirmations (yearly_token_quotes.attribution_closed_at), whatever
 * happens to the quote in between:
 *
 *   'active' / 'expired' quotes
 *     1. The EARLIEST confirmed in-window transfer of 1x..2x the quote settles
 *        it through settle_yearly_token_payment, which claims the Transfer log,
 *        activates or renews the subscription and consumes the quote in one
 *        transaction.
 *     2. Nothing qualifying: over-ceiling transfers are surfaced for review as
 *        soon as they confirm, but the quote stays payable while its window
 *        is open. Once the window has closed, an over-ceiling, late in-band or
 *        under-paying transfer sends the quote to 'manual_review'. Every such
 *        transfer is one yearly_token_reconciliation_items row (+ ops event).
 *     3. Nothing at all once the range is fully scanned: 'cancelled'.
 *   'consumed' / 'manual_review' quotes
 *     Watched until the range is fully scanned: every further transfer in it
 *     (a duplicate payment, an extra that confirmed after settlement, a top-up
 *     after review) is surfaced once.
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
  scanErc20TransfersInWindow,
  type BaseChainReader,
  type JsonRpcFetch,
  type ScannedTransfer,
} from "@/lib/billing/base-transfer-scan";
import {
  loadHermesosTransferOwnership,
  loadNextHermesosPaymentSessionMs,
} from "@/lib/billing/hermesos-transfer-attribution";
import { HERMESOS_TOKEN_ADDRESS, normalizeEvmAddress } from "@/lib/billing/token-holdings";
import type { TierKey } from "@/lib/billing/tier-thresholds";
import {
  asYearlyTokenQuote,
  YEARLY_LATE_PAYMENT_GRACE_MS,
  YEARLY_QUOTE_SELECT_COLUMNS,
  type YearlyQuoteRow,
  type YearlyTokenQuote,
} from "@/lib/billing/yearly-token-quotes";

export { YEARLY_LATE_PAYMENT_GRACE_MS };
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
  | "payment_after_review"
  | "legacy_subscription_exists"
  | "contested_by_managed_venice_review"
  | "predates_legacy_settlement";

export type YearlyReconcileStatus =
  | "activated"
  | "renewed"
  | "already_settled"
  | "underconfirmed"
  | "no_match"
  | "manual_review"
  | "cancelled"
  | "transaction_already_claimed"
  /** A settled / in-review quote whose range is still being watched. */
  | "watching"
  /** The quote's range is closed (or the quote was final already). */
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
  watching: number;
  skipped: number;
  failed: number;
  /** Quotes left for the next run because the batch deadline passed. */
  deferred: number;
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
  gt: (...args: unknown[]) => DbQuery;
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

interface ReviewItem {
  userId: string;
  quoteId: string | null;
  subscriptionId: string | null;
  reason: YearlyReviewReason;
  transactionHash: string;
  logIndex: number;
  tokenAmountRaw: string;
  tokensRequiredRaw: string | null;
  depositAddress: string;
  observedAt: string | null;
  metadata: Record<string, unknown>;
}

/**
 * Record a transfer an operator has to look at. One row per transfer: a
 * repeat (every cron tick, the cron racing a user's check) hits the unique
 * dedupe key and is treated as already surfaced. Returns true when new.
 */
async function insertReviewItem(db: YearlySettlementDb, item: ReviewItem) {
  const { error } = await table(db, "yearly_token_reconciliation_items").insert({
    user_id: item.userId,
    quote_id: item.quoteId,
    subscription_id: item.subscriptionId,
    status: "open",
    reason: item.reason,
    transaction_hash: item.transactionHash,
    log_index: item.logIndex,
    token_amount_raw: item.tokenAmountRaw,
    tokens_required_raw: item.tokensRequiredRaw,
    deposit_address: normalizeEvmAddress(item.depositAddress),
    observed_at: item.observedAt,
    dedupe_key: yearlyTransferDedupeKey(item),
    metadata: item.metadata,
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
      `A $HermesOS transfer to a yearly quote's deposit wallet needs an operator ` +
      `(${item.reason}). It is recorded in yearly_token_reconciliation_items.`,
    userId: item.userId,
    metadata: {
      failureType: "yearly_token_payment_review",
      reason: item.reason,
      quoteId: item.quoteId,
      subscriptionId: item.subscriptionId,
      transactionHash: item.transactionHash,
      logIndex: item.logIndex,
      tokenAmountRaw: item.tokenAmountRaw,
      tokensRequiredRaw: item.tokensRequiredRaw,
    },
  });
  return true;
}

function surfaceTransfer(
  db: YearlySettlementDb,
  quote: YearlyTokenQuote,
  transfer: ScannedTransfer,
  reason: YearlyReviewReason,
  subscriptionId: string | null = null
) {
  return insertReviewItem(db, {
    userId: quote.userId,
    quoteId: quote.id,
    subscriptionId,
    reason,
    transactionHash: transfer.transactionHash,
    logIndex: transfer.logIndex,
    tokenAmountRaw: transfer.amount.toString(),
    tokensRequiredRaw: quote.tokensRequiredRaw.toString(),
    depositAddress: quote.depositAddress,
    observedAt: transfer.observedAt,
    metadata: {
      tier: quote.tier,
      quoteStatus: quote.status,
      blockNumber: transfer.blockNumber,
      confirmations: transfer.confirmations,
      quoteExpiresAt: quote.expiresAt,
    },
  });
}

/**
 * canary's pre-attribution managed-Venice reconciler rescans ~11 h of
 * transfers with no time window and, when it sends a stale quote to review,
 * writes the transfer it REJECTED into that quote's transaction_hash. If that
 * transfer paid a yearly subscription, an operator working the Venice review
 * could credit it a second time. This pass flags every such yearly payment
 * (one item per transfer), whenever the Venice review appears — also long
 * after the yearly quote's range has closed.
 */
export async function flagYearlyPaymentsInManagedVeniceReviews(params: { db?: unknown; limit?: number } = {}) {
  const db = asSettlementDb(params.db ?? supabaseAdmin);
  const { data: reviews, error: reviewsError } = await table(db, "managed_venice_token_quotes")
    .select("id, transaction_hash, deposit_address, status")
    .eq("status", "manual_review_required")
    .order("updated_at", { ascending: false })
    .limit(Math.max(1, Math.min(500, Math.floor(params.limit ?? 200))));
  if (reviewsError) {
    throw new Error(`Failed to load managed Venice reviews: ${reviewsError.message || "unknown error"}`);
  }
  const reviewed = new Map<string, Set<string>>(); // tx -> wallets under review
  for (const row of (Array.isArray(reviews) ? reviews : []) as Array<Record<string, unknown>>) {
    if (typeof row.transaction_hash !== "string" || typeof row.deposit_address !== "string") continue;
    const tx = row.transaction_hash.toLowerCase();
    const wallets = reviewed.get(tx) ?? new Set<string>();
    wallets.add(row.deposit_address.toLowerCase());
    reviewed.set(tx, wallets);
  }
  if (reviewed.size === 0) return { flagged: 0 };

  const hashes = Array.from(reviewed.keys());
  const { data: subs, error: subsError } = await table(db, "yearly_token_subscriptions")
    .select("id, user_id, yearly_quote_id, deposit_tx_hash, deposit_log_index, deposit_address, amount_received_raw::text, paid_at, metadata")
    .in("deposit_tx_hash", hashes);
  if (subsError) throw new Error(`Failed to load yearly subscriptions: ${subsError.message || "unknown error"}`);

  let flagged = 0;
  for (const sub of (Array.isArray(subs) ? subs : []) as Array<Record<string, unknown>>) {
    const tx = typeof sub.deposit_tx_hash === "string" ? sub.deposit_tx_hash.toLowerCase() : "";
    const wallet = typeof sub.deposit_address === "string" ? sub.deposit_address.toLowerCase() : "";
    if (typeof sub.deposit_log_index !== "number" || !reviewed.get(tx)?.has(wallet)) continue;
    const metadata = (sub.metadata ?? {}) as Record<string, unknown>;
    const inserted = await insertReviewItem(db, {
      userId: String(sub.user_id),
      quoteId: typeof sub.yearly_quote_id === "string" ? sub.yearly_quote_id : null,
      subscriptionId: String(sub.id),
      reason: "contested_by_managed_venice_review",
      transactionHash: tx,
      logIndex: sub.deposit_log_index,
      tokenAmountRaw: String(sub.amount_received_raw),
      tokensRequiredRaw: typeof metadata.tokensRequiredRaw === "string" ? metadata.tokensRequiredRaw : null,
      depositAddress: wallet,
      observedAt:
        typeof metadata.blockTimestamp === "string" ? metadata.blockTimestamp : typeof sub.paid_at === "string" ? sub.paid_at : null,
      metadata: { source: "managed_venice_review_cross_check" },
    });
    if (inserted) flagged += 1;
  }
  return { flagged };
}

/**
 * active|expired -> status, only while no transfer is bound to the quote.
 * Retiring to 'cancelled' happens only after a full scan, so it also closes
 * attribution; 'manual_review' leaves the range watched.
 */
async function closeQuote(db: YearlySettlementDb, quoteId: string, status: "manual_review" | "cancelled", now: Date) {
  const { data, error } = await table(db, "yearly_token_quotes")
    .update({
      status,
      updated_at: now.toISOString(),
      ...(status === "cancelled" ? { attribution_closed_at: now.toISOString() } : {}),
    })
    .eq("id", quoteId)
    .in("status", ["active", "expired"])
    .is("consumed_tx_hash", null)
    .select("id, status");
  if (error) throw new Error(`Failed to move yearly quote to ${status}: ${error.message || "unknown error"}`);
  return Array.isArray(data) && data.length > 0;
}

async function closeAttribution(db: YearlySettlementDb, quoteId: string, now: Date) {
  const { error } = await table(db, "yearly_token_quotes")
    .update({ attribution_closed_at: now.toISOString(), updated_at: now.toISOString() })
    .eq("id", quoteId)
    .is("attribution_closed_at", null)
    .select("id");
  if (error) throw new Error(`Failed to close yearly quote attribution: ${error.message || "unknown error"}`);
}

/**
 * Did the pre-attribution (balance-based) flow settle a LATER quote of this
 * user? That flow consumed quotes from the wallet balance, so it may have
 * spent a transfer that lies in this earlier quote's range (a payment it
 * missed here and then counted there). Such a range must never auto-credit.
 */
async function hasLegacySettlementAfter(db: YearlySettlementDb, quote: YearlyTokenQuote) {
  const { data, error } = await table(db, "yearly_token_quotes")
    .select("id")
    .eq("user_id", quote.userId)
    .eq("status", "consumed")
    .is("consumed_tx_hash", null)
    .gt("quoted_at", quote.quotedAt)
    .limit(1);
  if (error) throw new Error(`Failed to check for legacy yearly settlements: ${error.message || "unknown error"}`);
  return Array.isArray(data) && data.length > 0;
}

async function subscriptionIdForQuote(db: YearlySettlementDb, quoteId: string) {
  const { data, error } = await table(db, "yearly_token_subscriptions")
    .select("id")
    .eq("yearly_quote_id", quoteId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load the yearly subscription for quote ${quoteId}: ${error.message || "unknown"}`);
  return (data as { id?: string } | null)?.id ?? null;
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
  const now = params.now ?? new Date();

  const settling = quote.status === "active" || quote.status === "expired";
  // settle_yearly_token_payment always records the tx it consumes with; a
  // consumed quote without one was settled by the pre-attribution
  // (balance-based) flow, whose payment was never bound: rescanning its range
  // would report that payment as an extra transfer.
  const legacyConsumed = quote.status === "consumed" && !quote.consumedTxHash;
  const watching = (quote.status === "consumed" && !legacyConsumed) || quote.status === "manual_review";
  if (!settling && !watching) {
    await closeAttribution(db, quote.id, now);
    return { ...base, status: "closed", quoteStatus: quote.status };
  }

  const minConfirmations = normalizeMinConfirmations(params.minConfirmations);
  const chain =
    params.chain ?? createBaseChainReader({ rpcUrl: params.rpcUrl, fetchImpl: params.fetchImpl, rpcOptions: params.rpcOptions });

  const quotedAtMs = Date.parse(quote.quotedAt);
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

  const scan = await scanErc20TransfersInWindow({
    chain,
    tokenAddress: HERMESOS_TOKEN_ADDRESS,
    toAddress: quote.depositAddress,
    fromMs: quotedAtMs,
    toMs: rangeEndMs,
    minConfirmations,
  });
  // The scan pads its block range on the safe side; the range is exact here.
  const inRange = scan.transfers.filter(
    (transfer) => transfer.timestampMs >= quotedAtMs && transfer.timestampMs <= rangeEndMs
  );
  const ownership = await loadHermesosTransferOwnership(db, {
    transfers: inRange,
    depositAddress: quote.depositAddress,
    userId: quote.userId,
  });
  const attributable = inRange.filter((transfer) => !ownership.isBound(transfer));

  const required = quote.tokensRequiredRaw;
  const band = {
    required,
    ceiling: (required * YEARLY_MAX_OVERSEND_NUMERATOR) / YEARLY_MAX_OVERSEND_DENOMINATOR,
    expiresAtMs,
  };
  const classOf = (transfer: ScannedTransfer) => classify(transfer, band);
  const isConfirmed = (transfer: ScannedTransfer) => transfer.confirmations >= minConfirmations;
  const confirmed = attributable.filter(isConfirmed);
  const rangeScanned = now.getTime() > rangeEndMs && scan.confirmedHeadMs >= rangeEndMs;

  // ── Settled or in-review quote: keep surfacing until the range closes ──
  if (watching) {
    const subscriptionId = quote.status === "consumed" ? await subscriptionIdForQuote(db, quote.id) : null;
    // The quote's own payment can become contested after it settled (the
    // pre-attribution Venice flow reviews it later): flag it, once.
    const ownPayment = inRange.find(
      (transfer) =>
        transfer.transactionHash === quote.consumedTxHash?.toLowerCase() &&
        (quote.consumedLogIndex === null || transfer.logIndex === quote.consumedLogIndex)
    );
    if (ownPayment && ownership.isContested(ownPayment)) {
      await surfaceTransfer(db, quote, ownPayment, "contested_by_managed_venice_review", subscriptionId);
    }
    for (const transfer of confirmed) {
      const reason: YearlyReviewReason =
        quote.status === "consumed"
          ? "extra_transfer"
          : classOf(transfer) === "qualifying"
            ? "payment_after_review"
            : CLASS_REASON[classOf(transfer)];
      await surfaceTransfer(db, quote, transfer, reason, subscriptionId);
    }
    const awaiting = attributable.filter((transfer) => !isConfirmed(transfer));
    if (rangeScanned && awaiting.length === 0) {
      await closeAttribution(db, quote.id, now);
      return { ...base, status: "closed", quoteStatus: quote.status };
    }
    return { ...base, status: "watching", quoteStatus: quote.status };
  }

  // A later quote was settled from the wallet balance by the pre-attribution
  // flow, which may already have spent a transfer in this range. Crediting it
  // here could grant a second year for one payment, and dropping it could lose
  // a real one: hand every transfer in the range to an operator.
  if (await hasLegacySettlementAfter(db, quote)) {
    for (const transfer of confirmed) {
      await surfaceTransfer(db, quote, transfer, "predates_legacy_settlement");
    }
    if (confirmed.length > 0) {
      await closeQuote(db, quote.id, "manual_review", now);
      return { ...base, status: "manual_review", reason: "predates_legacy_settlement" };
    }
    if (attributable.length > 0) {
      return { ...base, status: "underconfirmed", confirmations: Math.max(...attributable.map((t) => t.confirmations)) };
    }
    if (rangeScanned) {
      await closeQuote(db, quote.id, "cancelled", now);
      return { ...base, status: "cancelled" };
    }
    return { ...base, status: "no_match" };
  }

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
        const subscriptionId = settlement.subscription_id ?? null;
        if (settlement.status !== "already_settled") await stampTokenConversion(db, quote.userId, now);
        if (ownership.isContested(candidate)) {
          // The pre-attribution managed-Venice flow put this transfer in one of
          // its reviews; make sure nobody credits it a second time there.
          await surfaceTransfer(db, quote, candidate, "contested_by_managed_venice_review", subscriptionId);
        }
        // Extras confirmed now are surfaced here; later ones by the watch pass.
        for (const extra of confirmed) {
          if (extra !== candidate) await surfaceTransfer(db, quote, extra, "extra_transfer", subscriptionId);
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
      case "not_settleable": {
        // A concurrent pass settled or closed the quote after we loaded it.
        // This transfer is still in the quote's range: never drop it.
        const reason: YearlyReviewReason =
          settlement.quote_status === "manual_review" ? "payment_after_review" : "extra_transfer";
        await surfaceTransfer(db, quote, candidate, reason);
        return { ...base, status: "closed", quoteStatus: settlement.quote_status ?? settlement.status };
      }
      case "not_found":
        return { ...base, status: "closed", quoteStatus: "not_found" };
      default:
        throw new Error(`settle_yearly_token_payment rejected the transfer: ${settlement.status}`);
    }
  }

  // 2. No qualifying transfer. Over-ceiling payments are surfaced as soon as
  //    they confirm, but the quote stays payable while its window is open, so
  //    the user can still send the right amount. Once the window has closed on
  //    a confirmed chain, any over-ceiling, late in-band or under-paying
  //    transfer sends the quote to review. Items are written BEFORE the quote
  //    closes, so a review is never invisible.
  for (const transfer of confirmed) {
    if (classOf(transfer) === "over") await surfaceTransfer(db, quote, transfer, "overpaid");
  }
  const windowClosed = now.getTime() > expiresAtMs && scan.confirmedHeadMs >= expiresAtMs;
  const reviewTrigger = windowClosed
    ? confirmed.find((transfer) => classOf(transfer) === "over") ??
      confirmed.find((transfer) => classOf(transfer) === "late_qualifying") ??
      confirmed.find((transfer) => classOf(transfer) === "under")
    : undefined;
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
  if (rangeScanned && confirmed.length === lateOther.length) {
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
 * Quotes whose attribution range is still open, newest first: a fresh
 * payment is always inside the batch however many older ranges are open,
 * and older ones leave the set once their range has been fully scanned.
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
    .is("attribution_closed_at", null);
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
    requestTimeoutMs?: number;
    /** Wall-clock ms after which no further quote is started (left for the next run). */
    deadlineMs?: number;
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
  const chain = createBaseChainReader({
    rpcUrl: params.rpcUrl,
    fetchImpl: params.fetchImpl,
    rpcOptions,
    requestTimeoutMs: params.requestTimeoutMs,
  });
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
    watching: 0,
    skipped: 0,
    failed: 0,
    deferred: 0,
    results: [],
  };

  for (const [index, quote] of quotes.entries()) {
    if (params.deadlineMs !== undefined && Date.now() >= params.deadlineMs) {
      summary.deferred = quotes.length - index;
      log.warn("yearly token reconciliation hit its deadline; deferring the rest", {
        source: "yearly-token-settlement",
        failureType: "yearly_token_reconcile_deadline",
        deferred: summary.deferred,
      });
      break;
    }
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
      else if (result.status === "watching") summary.watching += 1;
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
