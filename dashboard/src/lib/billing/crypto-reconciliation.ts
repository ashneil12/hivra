import { supabaseAdmin } from "@/lib/supabase";
import { log } from "@/lib/logger";
import { metadataRecord, requireDb } from "@/lib/billing/db-utils";
import { normalizeEvmAddress } from "@/lib/billing/token-holdings";
import {
  CRYPTO_TOPUP_ASSETS,
  CRYPTO_TOPUP_REVIEW_REASONS,
  CRYPTO_TOPUP_SESSION_EXPIRED_FAILURE,
  USDC_BASE_TOKEN_ADDRESS,
  cryptoTopUpIntentWindow,
  cryptoTopUpTransferKey,
  isOpenCryptoTopUpIntent,
  listUnfinishedCryptoTopUpClaims,
  loadClaimedCryptoTopUpTransferKeys,
  loadCryptoTopUpPayment,
  resumeClaimedCryptoTopUp,
  retireCryptoTopUpIntent,
  settleCryptoTopUpIntent,
  surfaceCryptoTopUpTransfer,
  type CryptoTopUpPaymentRow,
  type CryptoTopUpSettlementResult,
  type CryptoTopUpTransfer,
} from "@/lib/billing/crypto-topups";
import { claimCronUtcDayOutcome } from "@/lib/cron-heartbeat";
import {
  createBaseChainReader,
  paymentDustFloor,
  scanErc20TransfersInWindow,
  type BaseChainReader,
  type JsonRpcFetch,
  type ScannedTransfer,
} from "@/lib/billing/base-transfer-scan";
import type { RpcCallOptions } from "@/lib/billing/base-rpc-retry";

// Kept exported from here: other Base scanners import them from this module.
export { ERC20_TRANSFER_TOPIC, encodeErc20TransferToTopic } from "@/lib/billing/base-transfer-scan";

type QueryError = { code?: string; message?: string } | null;

type DbQuery = {
  select: (...args: unknown[]) => DbQuery;
  eq: (...args: unknown[]) => DbQuery;
  in: (...args: unknown[]) => DbQuery;
  is: (...args: unknown[]) => DbQuery;
  gt: (...args: unknown[]) => DbQuery;
  lt: (...args: unknown[]) => DbQuery;
  lte: (...args: unknown[]) => DbQuery;
  order: (...args: unknown[]) => DbQuery;
  limit: (...args: unknown[]) => DbQuery;
  then: Promise<{ data?: unknown; error: QueryError }>["then"];
};

type DbTable = DbQuery & {
  update: (patch: Record<string, unknown>) => DbQuery;
};

type SupabaseLike = {
  from: (name: string) => unknown;
};

type SettleCryptoTopUp = typeof settleCryptoTopUpIntent;

const DEFAULT_LIMIT = 50;
// Batch slots always left for intents the old session helper failed without a
// chain check, so that finite backlog drains even while many intents are open.
const MIN_UNCHECKED_EXPIRED_SHARE = 5;
// An open intent older than this is no longer scanned every run: its session
// window + late-payment grace closed weeks ago, so each tick would only
// re-scan a dead range on the shared public RPC. On-demand settlement
// (reconcileCryptoTopUpByReference) still checks it if the user asks.
const STALE_INTENT_MAX_AGE_MS = 14 * 24 * 60 * 60_000;
// Bound on the stale-intent count query; the real backlog is single digits.
const STALE_INTENT_COUNT_LIMIT = 500;
// Open intents older than the cutoff are retried once per UTC day — on the
// first tick whose start lands in a new day — in one bounded batch, so a paid
// intent whose last in-window scan failed near the cutoff is not excluded
// forever. Derived from the cron heartbeat's last_run_at; no new table.
const STALE_DAILY_RETRY_LIMIT = 25;
const CRYPTO_TOPUPS_CRON_NAME = "reconcile-crypto-topups";
// The reconcile queue: `payment_transactions.reconcile_queued_at` is when an
// intent joined the back of the queue (its insert, then every check). See
// listOpenCryptoTopUps.
const QUEUE_COLUMN = "reconcile_queued_at";
// One account's intents may take at most this many of a run's slots while
// other accounts' intents are waiting in the rows read ahead.
const MAX_INTENTS_PER_USER_PER_RUN = 3;
// Rows read ahead of the batch to find other accounts' intents.
const QUEUE_LOOKAHEAD_FACTOR = 4;
const MAX_QUEUE_LOOKAHEAD = 200;
// limit / this many slots go to the newest intents (none below this limit).
const FRESH_LANE_DIVISOR = 5;
const DEFAULT_MIN_CONFIRMATIONS = 3;
// How many later intents to look through for the next one on the same
// deposit address (a user's wallet is normally the same across intents).
const NEXT_INTENT_LOOKAHEAD = 10;
const PAYMENT_COLUMNS =
  "id, user_id, provider, provider_reference_id, status, asset, amount_minor, package_credits, metadata, created_at, updated_at";

function table(db: SupabaseLike, name: string): DbTable {
  return db.from(name) as DbTable;
}

function normalizeLimit(limit: number | undefined) {
  if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(100, Math.floor(limit ?? DEFAULT_LIMIT)));
}

function normalizeMinConfirmations(confirmations: number | undefined) {
  if (!Number.isFinite(confirmations)) return DEFAULT_MIN_CONFIRMATIONS;
  return Math.max(1, Math.min(100, Math.floor(confirmations ?? DEFAULT_MIN_CONFIRMATIONS)));
}

interface ParsedIntent {
  row: CryptoTopUpPaymentRow;
  referenceId: string;
  depositAddress: string;
  requiredAmount: bigint;
  window: ReturnType<typeof cryptoTopUpIntentWindow>;
}

function parseIntent(row: CryptoTopUpPaymentRow): ParsedIntent | null {
  if (row.provider !== "bankr" || row.asset !== CRYPTO_TOPUP_ASSETS.usdc_base.key) return null;
  if (!row.id || !row.user_id?.trim() || !row.provider_reference_id?.trim()) return null;
  if (!Number.isInteger(row.amount_minor) || row.amount_minor <= 0) return null;
  const depositAddress = metadataRecord(row.metadata).depositAddress;
  if (typeof depositAddress !== "string" || !depositAddress) return null;
  try {
    return {
      row,
      referenceId: row.provider_reference_id,
      depositAddress: normalizeEvmAddress(depositAddress),
      requiredAmount: BigInt(row.amount_minor),
      window: cryptoTopUpIntentWindow(row),
    };
  } catch {
    return null;
  }
}

function toTopUpTransfer(transfer: ScannedTransfer): CryptoTopUpTransfer {
  return {
    transactionHash: transfer.transactionHash,
    logIndex: transfer.logIndex,
    blockNumber: transfer.blockNumber,
    blockHash: transfer.blockHash,
    amountRaw: transfer.amount.toString(),
    confirmations: transfer.confirmations,
    observedAt: transfer.observedAt,
  };
}

// ── Candidates ────────────────────────────────────────────────────────────

/**
 * Take up to `budget` rows in order, at most MAX_INTENTS_PER_USER_PER_RUN per
 * account (counted across the whole run in `perUser`) while other accounts'
 * rows are waiting. Slots nobody else wants are filled from the deferred rows,
 * still in order, so the queue head always moves: a burst from one account
 * delays other intents by a bounded number of runs instead of blocking them.
 */
function takeFairly(
  rows: CryptoTopUpPaymentRow[],
  budget: number,
  perUser: Map<string, number>,
  alreadyTaken: ReadonlySet<string> = new Set()
) {
  const taken: CryptoTopUpPaymentRow[] = [];
  const deferred: CryptoTopUpPaymentRow[] = [];
  const take = (row: CryptoTopUpPaymentRow) => {
    perUser.set(row.user_id, (perUser.get(row.user_id) ?? 0) + 1);
    taken.push(row);
  };
  for (const row of rows) {
    if (taken.length >= budget) break;
    if (alreadyTaken.has(row.id)) continue;
    if ((perUser.get(row.user_id) ?? 0) >= MAX_INTENTS_PER_USER_PER_RUN) deferred.push(row);
    else take(row);
  }
  for (const row of deferred) {
    if (taken.length >= budget) break;
    take(row);
  }
  return taken;
}

/**
 * The next batch of open intents, in two lanes:
 *   - fresh: a fifth of the batch goes to the newest pending intents, so a
 *     payment made minutes ago is credited on the next run when there is a
 *     backlog of older intents;
 *   - queue: the rest goes to the intents that have waited longest since they
 *     were created or last checked. Every intent a run picks, in either lane,
 *     goes to the back of the queue (markCheckedThisRun) whatever the outcome,
 *     and settling or retiring takes it out. So no set of intents, old or new,
 *     can hold the batch: every open intent is checked within
 *     ceil(open intents / queue slots) runs, however many arrive meanwhile.
 * Intents the old session helper failed without a chain check keep a share of
 * every batch, in queue order, until they are closed.
 */
async function listOpenCryptoTopUps(db: SupabaseLike, limit: number, createdAfterIso: string) {
  const lookahead = Math.min(MAX_QUEUE_LOOKAHEAD, limit * QUEUE_LOOKAHEAD_FACTOR);
  const freshShare = Math.floor(limit / FRESH_LANE_DIVISOR);
  const intents = () =>
    table(db, "payment_transactions")
      .select(PAYMENT_COLUMNS)
      .eq("provider", "bankr")
      .eq("asset", CRYPTO_TOPUP_ASSETS.usdc_base.key)
      .gt("created_at", createdAfterIso);
  const inQueueOrder = (query: DbQuery) =>
    query
      .order(QUEUE_COLUMN, { ascending: true, nullsFirst: true })
      .order("created_at", { ascending: true })
      .limit(lookahead);
  const [fresh, queued, uncheckedExpired] = await Promise.all([
    freshShare > 0
      ? intents().eq("status", "pending").order("created_at", { ascending: false }).limit(lookahead)
      : Promise.resolve({ data: [], error: null }),
    inQueueOrder(intents().eq("status", "pending")),
    inQueueOrder(
      intents()
        .eq("status", "failed")
        .eq("metadata->>failureType", CRYPTO_TOPUP_SESSION_EXPIRED_FAILURE)
        .is("metadata->>reconciliationClosedAt", null)
    ),
  ]);
  for (const result of [fresh, queued, uncheckedExpired]) {
    if (result.error) {
      throw new Error(result.error.message || "Failed to load open crypto top-ups");
    }
  }
  const rowsOf = (result: { data?: unknown }) =>
    (Array.isArray(result.data) ? result.data : []) as CryptoTopUpPaymentRow[];

  const perUser = new Map<string, number>();
  const freshRows = takeFairly(rowsOf(fresh), freshShare, perUser);
  const queuedRows = takeFairly(
    rowsOf(queued),
    limit - freshRows.length,
    perUser,
    new Set(freshRows.map((row) => row.id))
  );
  const pendingRows = [...freshRows, ...queuedRows];
  const uncheckedShare = Math.max(MIN_UNCHECKED_EXPIRED_SHARE, limit - pendingRows.length);
  const uncheckedRows = takeFairly(rowsOf(uncheckedExpired), uncheckedShare, perUser);
  return [...pendingRows, ...uncheckedRows];
}

/**
 * The once-a-day lane: open intents the age cutoff excludes get one bounded
 * retry batch on the first tick of each UTC day, in the same queue order, so
 * a payment whose last scan failed near the cutoff still gets another look.
 * Same two lanes as listOpenCryptoTopUps, bounded by created_at instead of
 * the other way around — the sets are exact complements, never overlapping.
 */
async function listStaleCryptoTopUpsForDailyRetry(
  db: SupabaseLike,
  createdBeforeIso: string,
  limit: number
) {
  const lookahead = Math.min(MAX_QUEUE_LOOKAHEAD, limit * QUEUE_LOOKAHEAD_FACTOR);
  const intents = () =>
    table(db, "payment_transactions")
      .select(PAYMENT_COLUMNS)
      .eq("provider", "bankr")
      .eq("asset", CRYPTO_TOPUP_ASSETS.usdc_base.key)
      .lte("created_at", createdBeforeIso);
  const inQueueOrder = (query: DbQuery) =>
    query
      .order(QUEUE_COLUMN, { ascending: true, nullsFirst: true })
      .order("created_at", { ascending: true })
      .limit(lookahead);
  const [pending, uncheckedExpired] = await Promise.all([
    inQueueOrder(intents().eq("status", "pending")),
    inQueueOrder(
      intents()
        .eq("status", "failed")
        .eq("metadata->>failureType", CRYPTO_TOPUP_SESSION_EXPIRED_FAILURE)
        .is("metadata->>reconciliationClosedAt", null)
    ),
  ]);
  for (const result of [pending, uncheckedExpired]) {
    if (result.error) {
      throw new Error(result.error.message || "Failed to load stale crypto top-ups");
    }
  }
  const rowsOf = (result: { data?: unknown }) =>
    (Array.isArray(result.data) ? result.data : []) as CryptoTopUpPaymentRow[];

  const perUser = new Map<string, number>();
  const pendingRows = takeFairly(rowsOf(pending), limit, perUser);
  const uncheckedShare = Math.max(MIN_UNCHECKED_EXPIRED_SHARE, limit - pendingRows.length);
  const uncheckedRows = takeFairly(rowsOf(uncheckedExpired), uncheckedShare, perUser);
  return [...pendingRows, ...uncheckedRows];
}

// How many open intents the age cutoff just excluded this run, so the summary
// shows the backlog is being skipped on purpose rather than silently absent.
async function countStaleOpenCryptoTopUps(db: SupabaseLike, createdBeforeIso: string) {
  const base = () =>
    table(db, "payment_transactions")
      .select("id")
      .eq("provider", "bankr")
      .eq("asset", CRYPTO_TOPUP_ASSETS.usdc_base.key)
      .lt("created_at", createdBeforeIso);
  const [pending, uncheckedExpired] = await Promise.all([
    base().eq("status", "pending").limit(STALE_INTENT_COUNT_LIMIT),
    base()
      .eq("status", "failed")
      .eq("metadata->>failureType", CRYPTO_TOPUP_SESSION_EXPIRED_FAILURE)
      .is("metadata->>reconciliationClosedAt", null)
      .limit(STALE_INTENT_COUNT_LIMIT),
  ]);
  for (const result of [pending, uncheckedExpired]) {
    if (result.error) {
      throw new Error(result.error.message || "Failed to count stale crypto top-ups");
    }
  }
  const ids = new Set(
    [pending.data, uncheckedExpired.data]
      .flatMap((data) => (Array.isArray(data) ? data : []))
      .map((row) => (row as { id?: unknown }).id)
      .filter((id): id is string => typeof id === "string")
  );
  return ids.size;
}

/**
 * Move this run's intents to the back of the queue before they are checked,
 * so a run that dies part-way still advances the queue and an overlapping run
 * takes the next intents instead of the same ones. A failure here throws: a
 * queue that stops moving is the starvation this ordering exists to prevent.
 */
async function markCheckedThisRun(db: SupabaseLike, rows: CryptoTopUpPaymentRow[], now: Date) {
  if (rows.length === 0) return;
  const { error } = await table(db, "payment_transactions")
    .update({ [QUEUE_COLUMN]: now.toISOString() })
    .in(
      "id",
      rows.map((row) => row.id)
    )
    .eq("provider", "bankr");
  if (error) {
    throw new Error(`Failed to advance the crypto top-up reconcile queue: ${error.message || "unknown error"}`);
  }
}

// ── Attribution ───────────────────────────────────────────────────────────
// The user's deposit wallet is reused by every top-up intent they make. A
// transfer at block time t belongs to intent I only if
//   start(I) <= t <= end of I's session + grace, and t < start(next intent on
//   the same address).
// So each transfer has at most one owner, an older stranded transfer is never
// matched to a newer intent, and a payment sent after the user opened a new
// intent pays the new one.

async function loadNextIntentStartMs(db: SupabaseLike, intent: ParsedIntent) {
  const { data, error } = await table(db, "payment_transactions")
    .select("id, provider_reference_id, metadata, created_at, updated_at")
    .eq("provider", "bankr")
    .eq("asset", CRYPTO_TOPUP_ASSETS.usdc_base.key)
    .eq("user_id", intent.row.user_id)
    .gt("created_at", intent.row.created_at)
    .order("created_at", { ascending: true })
    .limit(NEXT_INTENT_LOOKAHEAD);

  if (error) {
    throw new Error(error.message || "Failed to load the next crypto top-up intent");
  }
  for (const row of (Array.isArray(data) ? data : []) as CryptoTopUpPaymentRow[]) {
    if (row.provider_reference_id === intent.referenceId) continue;
    const address = metadataRecord(row.metadata).depositAddress;
    if (typeof address !== "string" || normalizeEvmAddress(address) !== intent.depositAddress) continue;
    try {
      return cryptoTopUpIntentWindow(row).startMs;
    } catch {
      continue;
    }
  }
  return null;
}

// ── Per-intent reconciliation ─────────────────────────────────────────────

export type CryptoTopUpReconciliationResult =
  | { status: "invalid_intent"; referenceId: string }
  | { status: "no_match"; referenceId: string }
  | { status: "underconfirmed"; referenceId: string; confirmations: number }
  | { status: "expired"; referenceId: string }
  | { status: "manual_review"; referenceId: string; surfaced: number }
  | { status: "closed"; referenceId: string; paymentStatus: string }
  | { status: "settled"; referenceId: string; transactionHash: string; inserted: boolean; balance: number | null }
  | {
      status: "settlement_skipped";
      referenceId: string;
      settlementStatus: Exclude<CryptoTopUpSettlementResult["status"], "settled">;
    };

function settlementOutcome(result: CryptoTopUpSettlementResult): CryptoTopUpReconciliationResult {
  if (result.status === "settled") return result;
  return { status: "settlement_skipped", referenceId: result.referenceId, settlementStatus: result.status };
}

async function reconcileOpenIntent(params: {
  row: CryptoTopUpPaymentRow;
  db: SupabaseLike;
  chain: BaseChainReader;
  minConfirmations: number;
  settle: SettleCryptoTopUp;
  now: Date;
}): Promise<CryptoTopUpReconciliationResult> {
  const { db, now } = params;
  const intent = parseIntent(params.row);
  if (!intent) {
    return { status: "invalid_intent", referenceId: params.row.provider_reference_id };
  }
  const { window, referenceId } = intent;

  const scan = await scanErc20TransfersInWindow({
    chain: params.chain,
    tokenAddress: USDC_BASE_TOKEN_ADDRESS,
    toAddress: intent.depositAddress,
    fromMs: window.startMs,
    toMs: window.graceEndMs,
    minConfirmations: params.minConfirmations,
    minAmount: paymentDustFloor(intent.requiredAmount),
  });
  const nextStartMs = await loadNextIntentStartMs(db, intent);
  const inRange = scan.transfers.filter(
    (transfer) =>
      transfer.timestampMs >= window.startMs &&
      transfer.timestampMs <= window.graceEndMs &&
      (nextStartMs === null || transfer.timestampMs < nextStartMs)
  );
  // A transfer another intent has claimed is accounted for there.
  const claimedElsewhere = await loadClaimedCryptoTopUpTransferKeys(db, inRange, {
    ignoreReferenceId: referenceId,
  });
  const attributable = inRange.filter(
    (transfer) => !claimedElsewhere.has(cryptoTopUpTransferKey(transfer.transactionHash, transfer.logIndex))
  );
  const isConfirmed = (transfer: ScannedTransfer) => transfer.confirmations >= params.minConfirmations;

  // 1. Credit the EARLIEST exact-amount transfer in chain order. Later
  //    arrivals never displace it; an under-confirmed one is waited for.
  const candidate = attributable.find((transfer) => transfer.amount === intent.requiredAmount);
  if (candidate) {
    if (!isConfirmed(candidate)) {
      return { status: "underconfirmed", referenceId, confirmations: candidate.confirmations };
    }
    const settlement = await params.settle({
      referenceId,
      transfer: toTopUpTransfer(candidate),
      actor: "bankr_reconciler",
      db,
      now,
    });
    if (settlement.status === "settled") {
      // Anything else the user sent for this intent is real money that was
      // not credited: hand it to an operator. (Settlement itself surfaces the
      // candidate when the intent turned out to hold an earlier claim.)
      const claimed = await loadClaimedCryptoTopUpTransferKeys(db, attributable);
      for (const transfer of attributable) {
        if (transfer === candidate || !isConfirmed(transfer)) continue;
        if (claimed.has(cryptoTopUpTransferKey(transfer.transactionHash, transfer.logIndex))) continue;
        await surfaceCryptoTopUpTransfer(
          { payment: intent.row, transfer: toTopUpTransfer(transfer), reason: CRYPTO_TOPUP_REVIEW_REASONS.extraTransfer },
          db
        );
      }
    }
    return settlementOutcome(settlement);
  }

  // 2. No exact payment. Keep watching until the whole window + grace is on a
  //    confirmed chain: the user can still send the right amount until then.
  const fullyScanned = now.getTime() >= window.graceEndMs && scan.confirmedHeadMs >= window.graceEndMs;
  if (!fullyScanned) {
    const waiting = attributable.filter((transfer) => !isConfirmed(transfer));
    if (waiting.length > 0) {
      return {
        status: "underconfirmed",
        referenceId,
        confirmations: Math.max(...waiting.map((transfer) => transfer.confirmations)),
      };
    }
    return { status: "no_match", referenceId };
  }

  // 3. Close the intent. Non-exact transfers (under, over, split payments) are
  //    surfaced one item each BEFORE the close, so a review is never lost.
  const received = attributable.filter(isConfirmed);
  for (const transfer of received) {
    await surfaceCryptoTopUpTransfer(
      {
        payment: intent.row,
        transfer: toTopUpTransfer(transfer),
        reason:
          transfer.amount < intent.requiredAmount
            ? CRYPTO_TOPUP_REVIEW_REASONS.underpaid
            : CRYPTO_TOPUP_REVIEW_REASONS.overpaid,
      },
      db
    );
  }
  const outcome = received.length > 0 ? "manual_review" : "expired";
  const retired = await retireCryptoTopUpIntent(
    {
      payment: intent.row,
      outcome,
      observedTotalMinor: received.length
        ? received.reduce((sum, transfer) => sum + transfer.amount, 0n).toString()
        : null,
      now,
    },
    db
  );
  if (!retired.retired) {
    // Settled or closed by someone else since the candidates were read.
    const current = await loadCryptoTopUpPayment(db, referenceId);
    return { status: "closed", referenceId, paymentStatus: current?.status ?? "missing" };
  }
  return outcome === "manual_review"
    ? { status: "manual_review", referenceId, surfaced: received.length }
    : { status: "expired", referenceId };
}

/**
 * Reconcile one intent on demand (the bearer settle route). The transfer is
 * found and verified on chain and claimed like any cron settlement; a
 * caller-supplied hash is never trusted.
 */
export async function reconcileCryptoTopUpByReference(params: {
  referenceId: string;
  db?: SupabaseLike | null;
  rpcUrl?: string;
  fetchImpl?: JsonRpcFetch;
  minConfirmations?: number;
  now?: Date;
  rpcOptions?: RpcCallOptions;
}): Promise<CryptoTopUpReconciliationResult | { status: "not_found"; referenceId: string }> {
  const db = requireDb(params.db ?? supabaseAdmin);
  const referenceId = params.referenceId.trim();
  const now = params.now ?? new Date();
  const row = await loadCryptoTopUpPayment(db, referenceId);
  if (!row) return { status: "not_found", referenceId };

  if (row.status === "succeeded") {
    // Settled already: report the claimed transfer; never re-settle.
    const settlement = metadataRecord(metadataRecord(row.metadata).settlement);
    const claim = await loadClaimForIntent(db, referenceId);
    const transactionHash =
      claim?.tx_hash ?? (typeof settlement.transactionHash === "string" ? settlement.transactionHash : "");
    return { status: "settled", referenceId, transactionHash, inserted: false, balance: null };
  }
  if (!isOpenCryptoTopUpIntent(row)) {
    return { status: "closed", referenceId, paymentStatus: row.status };
  }

  return reconcileOpenIntent({
    row,
    db,
    chain: createBaseChainReader({ rpcUrl: params.rpcUrl, fetchImpl: params.fetchImpl, rpcOptions: params.rpcOptions }),
    minConfirmations: normalizeMinConfirmations(params.minConfirmations),
    settle: settleCryptoTopUpIntent,
    now,
  });
}

async function loadClaimForIntent(db: SupabaseLike, referenceId: string) {
  const { data, error } = await table(db, "crypto_deposit_receipts")
    .select("tx_hash")
    .eq("provider", "bankr")
    .eq("reference_id", referenceId)
    .limit(1);
  if (error) {
    throw new Error(error.message || "Failed to load crypto deposit receipt");
  }
  return (Array.isArray(data) ? (data[0] as { tx_hash?: string } | undefined) : undefined) ?? null;
}

// ── Batch ─────────────────────────────────────────────────────────────────

type BatchResult =
  | CryptoTopUpReconciliationResult
  | { status: "recovered"; referenceId: string; settlementStatus: CryptoTopUpSettlementResult["status"] }
  | { status: "failed"; referenceId: string; errorName: string; errorMessage: string };

export async function reconcilePendingCryptoTopUps(params: {
  db?: SupabaseLike | null;
  limit?: number;
  rpcUrl?: string;
  fetchImpl?: JsonRpcFetch;
  minConfirmations?: number;
  settleIntent?: SettleCryptoTopUp;
  now?: Date;
  rpcOptions?: RpcCallOptions;
} = {}) {
  const db = requireDb(params.db ?? supabaseAdmin);
  const limit = normalizeLimit(params.limit);
  const minConfirmations = normalizeMinConfirmations(params.minConfirmations);
  const settle = params.settleIntent ?? settleCryptoTopUpIntent;
  const now = params.now ?? new Date();
  const staleCutoffIso = new Date(now.getTime() - STALE_INTENT_MAX_AGE_MS).toISOString();
  // One reader per batch: the head and block timestamps are fetched once.
  const chain = createBaseChainReader({
    rpcUrl: params.rpcUrl,
    fetchImpl: params.fetchImpl,
    rpcOptions: params.rpcOptions,
  });

  const results: BatchResult[] = [];
  const counts = {
    settled: 0,
    noMatch: 0,
    underconfirmed: 0,
    invalidIntent: 0,
    expired: 0,
    manualReview: 0,
    recovered: 0,
    failed: 0,
  };
  const fail = (referenceId: string, error: unknown) => {
    counts.failed += 1;
    results.push({
      status: "failed",
      referenceId,
      errorName: error instanceof Error ? error.name : typeof error,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  };

  // The first tick of a new UTC day also retries a bounded batch of the
  // intents the age cutoff excludes — a paid intent whose last scan failed
  // just before crossing it must not lose its only automatic retry. The day
  // boundary IS the claim below: its guarded update only matches a
  // last_run_at from before today, so "claimed" is exactly "first tick of a
  // new UTC day with a recorded previous run" — no separate read can add to
  // that, and no row at all means no baseline and a held claim.
  //
  // The claim is also the atomic decider between overlapping invocations:
  // the route heartbeats AFTER reconciliation resolves, so two runs that
  // both believe the day is free would otherwise both scan every stale
  // intent on the shared public RPC. The first writer to move last_run_at
  // into today owns the pass; a loser skips it. A winner that then crashes
  // holds the day, deferring the pass to tomorrow — deferral, not loss,
  // which is the right trade for a retry lane that already runs daily.
  // A failed claim is distinct from an already-claimed day: the day stays
  // unclaimed while the retry lane never ran, so the run's incident report
  // and heartbeat must read degraded, not a clean skip.
  const staleDayClaim = await claimCronUtcDayOutcome(db, CRYPTO_TOPUPS_CRON_NAME, now);
  const retryStale = staleDayClaim === "claimed";
  const staleRetryClaimFailed = staleDayClaim === "failed";
  let staleRetryLoadFailed = false;
  const [intents, staleExcluded, staleRetry] = await Promise.all([
    listOpenCryptoTopUps(db, limit, staleCutoffIso),
    // The stale count only feeds the run summary — a failure here must not
    // reject the batch and skip settlement, claim recovery, or the caller's
    // treasury sweeps. Report it as unavailable instead.
    countStaleOpenCryptoTopUps(db, staleCutoffIso).catch((error: unknown) => {
      log.warn("stale crypto top-up count failed; continuing without it", {
        source: "crypto-reconciliation",
        failureType: "stale_topup_count_failed",
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return null;
    }),
    // The daily retry lane is auxiliary like the count: a failed read must
    // not reject the batch — the intents stay open and are retried tomorrow.
    // But it must not be INVISIBLE either: the day's one stale pass silently
    // missing would leave the run summary, the cron's incident report and its
    // heartbeat all reading as success, so the outcome carries the failure.
    retryStale
      ? listStaleCryptoTopUpsForDailyRetry(db, staleCutoffIso, STALE_DAILY_RETRY_LIMIT).catch(
          (error: unknown) => {
            staleRetryLoadFailed = true;
            log.warn("stale crypto top-up daily retry load failed; continuing without it", {
              source: "crypto-reconciliation",
              failureType: "stale_topup_retry_load_failed",
              errorMessage: error instanceof Error ? error.message : String(error),
            });
            return [] as CryptoTopUpPaymentRow[];
          }
        )
      : Promise.resolve([] as CryptoTopUpPaymentRow[]),
  ]);
  // The lanes are exact complements on created_at, so no id can appear twice.
  const batch = [...intents, ...staleRetry];
  await markCheckedThisRun(db, batch, now);
  for (const row of batch) {
    try {
      const result = await reconcileOpenIntent({ row, db, chain, minConfirmations, settle, now });
      results.push(result);
      if (result.status === "settled") counts.settled += 1;
      if (result.status === "no_match") counts.noMatch += 1;
      if (result.status === "underconfirmed") counts.underconfirmed += 1;
      if (result.status === "invalid_intent") counts.invalidIntent += 1;
      if (result.status === "expired") counts.expired += 1;
      if (result.status === "manual_review") counts.manualReview += 1;
      if (result.status === "settlement_skipped") {
        // A closed-during-settlement intent is already surfaced for review;
        // anything else settlement refused is unexpected here.
        if (result.settlementStatus === "intent_closed") counts.manualReview += 1;
        else counts.failed += 1;
      }
    } catch (error) {
      fail(row.provider_reference_id, error);
    }
  }

  // Recovery: a claim whose settlement died part-way (the intent already
  // flipped, the credit not yet written) is finished here without a scan.
  const claims = await listUnfinishedCryptoTopUpClaims(db, limit);
  for (const receipt of claims) {
    try {
      const result = await resumeClaimedCryptoTopUp({ receipt, db, now });
      results.push({ status: "recovered", referenceId: receipt.reference_id, settlementStatus: result.status });
      if (result.status === "settled") counts.recovered += 1;
    } catch (error) {
      fail(receipt.reference_id, error);
    }
  }

  return {
    checked: batch.length,
    // Open intents older than STALE_INTENT_MAX_AGE_MS — the standing stale
    // backlog. On the first tick of a UTC day up to STALE_DAILY_RETRY_LIMIT
    // of them are also retried (see staleRetried); the rest remain settleable
    // on demand.
    staleExcluded,
    staleRetried: staleRetry.length,
    // The day was claimed for the stale pass but its intent SELECT failed —
    // the pass produced zero rows without running. Surfaced so the caller's
    // incident report and heartbeat read the run as degraded instead of clean.
    staleRetryLoadFailed,
    // The stale pass's utc-day claim write itself failed — the lane never
    // ran today, distinct from "another run holds the day" (a clean skip).
    staleRetryClaimFailed,
    ...counts,
    results,
  };
}
