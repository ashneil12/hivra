import { requireDb } from "@/lib/billing/db-utils";
import { supabaseAdmin } from "@/lib/supabase";
import {
  HERMESOS_TOKEN_ADDRESS,
  normalizeEvmAddress,
} from "@/lib/billing/token-holdings";
import {
  loadManagedVeniceTokenDepositLot,
  loadManagedVeniceTokenQuoteForUser,
  managedVeniceTokenQuoteWindow,
  retireManagedVeniceTokenQuote,
  settleManagedVeniceTokenQuote,
  surfaceManagedVeniceTokenTransfer,
  MANAGED_VENICE_MAX_OVERSEND_NUMERATOR,
  MANAGED_VENICE_MAX_OVERSEND_DENOMINATOR,
  MANAGED_VENICE_TOKEN_DEPOSIT_REASONS,
  type ManagedVeniceTokenDepositLot,
  type ManagedVeniceTokenDepositReason,
  type ManagedVeniceTokenQuote,
  type ManagedVeniceTokenSettlementResult,
} from "@/lib/billing/managed-venice-token-quotes";
import {
  ERC20_TRANSFER_TOPIC,
  encodeErc20TransferToTopic,
} from "@/lib/billing/crypto-reconciliation";
import {
  computeBackoffDelayMs,
  isRetryableRpcError,
  normalizeRpcRetryConfig,
  RpcHttpError,
  sleep,
  withRpcRetry,
  type RpcCallOptions,
  type RpcRetryConfig,
} from "@/lib/billing/base-rpc-retry";

// Re-exported so existing importers/tests of this module keep their entry
// points. The implementations now live in the shared base-rpc-retry module so
// every Base RPC path (managed-Venice deposits, token-tier/holdings refresh)
// shares one tested resilience layer.
export {
  computeBackoffDelayMs,
  isRetryableRpcError,
  RpcHttpError,
};
export type { RpcCallOptions, RpcRetryConfig };

type SupabaseLike = {
  from: (name: string) => unknown;
};

type QueryError = { code?: string; message?: string } | null;

type DbQuery = {
  select: (...args: unknown[]) => DbQuery;
  eq: (...args: unknown[]) => DbQuery;
  in: (...args: unknown[]) => DbQuery;
  gt: (...args: unknown[]) => DbQuery;
  order: (...args: unknown[]) => DbQuery;
  limit: (...args: unknown[]) => DbQuery;
  then: Promise<{ data?: unknown; error: QueryError }>["then"];
};

type JsonRpcFetch = (
  input: string,
  init: {
    method: "POST";
    headers: { "Content-Type": "application/json" };
    body: string;
  }
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
  };
}

interface EvmLog {
  address?: unknown;
  topics?: unknown[];
  data?: unknown;
  transactionHash?: unknown;
  logIndex?: unknown;
  blockNumber?: unknown;
  blockHash?: unknown;
  blockTimestamp?: unknown;
}

interface EvmBlock {
  number?: unknown;
  timestamp?: unknown;
}

type SettleManagedVeniceQuote = typeof settleManagedVeniceTokenQuote;

const DEFAULT_BASE_RPC_URL = "https://mainnet.base.org";
// Base's public RPC rejects eth_getLogs ranges above 2,000 blocks (HTTP 413,
// JSON-RPC -32614). Keep every chunk at the provider limit.
const MAX_BASE_RPC_LOG_RANGE_BLOCKS = 2_000;
const DEFAULT_MIN_CONFIRMATIONS = 3;
const DEFAULT_PENDING_QUOTE_RECONCILIATION_LIMIT = 25;
const MAX_PENDING_QUOTE_RECONCILIATION_LIMIT = 100;

// ── Quote-anchored scanning ───────────────────────────────────────────────
// Each quote is scanned over ITS OWN time range, not "the latest N blocks":
// from the block at quotedAt to the block at effectiveExpiresAt + grace. A
// payment is therefore visible however late the reconciler gets to the quote,
// and a quote stops seeing transfers that happen long after it.
//
// Late-payment grace: a transfer mined after the quote window but within this
// grace is still attributed to the quote (and goes to manual review when it is
// in the qualifying amount band). Once the whole window + grace is scanned at
// full confirmations with nothing to act on, the quote retires to 'cancelled'.
export const LATE_PAYMENT_GRACE_MS = 2 * 60 * 60_000;
// Base produces a block every 2 s; used to estimate a block from a timestamp.
// Every estimate is verified against eth_getBlockByNumber before it is used.
const BASE_BLOCK_TIME_SEC = 2;
// A timestamp->block answer may land this many seconds on the SAFE side of the
// target (earlier for a range start, later for a range end); the extra blocks
// are filtered out by their timestamps.
const BLOCK_SEARCH_TOLERANCE_SEC = 60;
const MAX_BLOCK_SEARCH_PROBES = 40;
// Estimate-and-correct probes before falling back to plain bisection.
const INTERPOLATION_PROBES = 4;
// Bound per-quote RPC work: a window + grace is ~4,200 blocks and has a
// handful of transfers; anything far above that is refused, not scanned.
const MAX_SCAN_SPAN_BLOCKS = 50_000;
const MAX_TRANSFER_TIMESTAMP_LOOKUPS = 200;

// Base RPC resilience (retry/backoff/jitter on 429/5xx/network) now lives in
// the shared @/lib/billing/base-rpc-retry module. This file keeps a short
// inter-quote throttle on top: the shared/public Base RPC endpoint rate-limits
// once a single reconciliation tick fans out eth_getLogs across every pending
// deposit quote, so we pause briefly between per-quote scans to keep the
// request rate under the public endpoint's threshold.
const DEFAULT_INTER_QUOTE_DELAY_MS = 150;

interface PendingQuoteCandidateRow {
  id?: unknown;
  user_id?: unknown;
}

type ReconcileManagedVeniceTokenQuoteResult = Awaited<
  ReturnType<typeof reconcileManagedVeniceTokenQuote>
>;

export interface ManagedVeniceTokenQuoteBatchReconciliationResult {
  checked: number;
  settled: number;
  underconfirmed: number;
  noMatch: number;
  manualReview: number;
  cancelled: number;
  skipped: number;
  failed: number;
  results: Array<{
    quoteId: string;
    userId: string;
    status: ReconcileManagedVeniceTokenQuoteResult["status"] | "failed";
    transactionHash?: string | null;
    confirmations?: number;
    errorName?: string;
    errorMessage?: string;
  }>;
}

function getBaseRpcUrl(env: Record<string, string | undefined> = process.env) {
  return (
    env.HERMES_BASE_RPC_URL?.trim() ||
    env.BASE_RPC_URL?.trim() ||
    DEFAULT_BASE_RPC_URL
  );
}

function normalizeMinConfirmations(confirmations: number | undefined) {
  if (!Number.isFinite(confirmations)) return DEFAULT_MIN_CONFIRMATIONS;
  return Math.max(1, Math.min(100, Math.floor(confirmations ?? DEFAULT_MIN_CONFIRMATIONS)));
}

function normalizePendingQuoteLimit(limit: number | undefined) {
  if (!Number.isFinite(limit)) return DEFAULT_PENDING_QUOTE_RECONCILIATION_LIMIT;
  return Math.max(
    1,
    Math.min(MAX_PENDING_QUOTE_RECONCILIATION_LIMIT, Math.floor(limit ?? DEFAULT_PENDING_QUOTE_RECONCILIATION_LIMIT))
  );
}

function rpcQuantity(value: number) {
  return `0x${value.toString(16)}`;
}

function parseRpcQuantity(value: unknown, label: string) {
  if (typeof value !== "string" || !/^0x[a-fA-F0-9]+$/.test(value)) {
    throw new Error(`Invalid ${label} RPC quantity`);
  }

  const parsed = Number.parseInt(value, 16);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ${label} RPC quantity`);
  }

  return parsed;
}

function decodeUint256LogData(data: unknown) {
  if (typeof data !== "string" || !/^0x[a-fA-F0-9]+$/.test(data)) {
    throw new Error("Invalid ERC-20 transfer amount data");
  }

  return BigInt(data);
}

// Best-effort read of the provider's reason from a non-OK response (e.g. the
// public endpoint's 413 "eth_getLogs is limited to a 2,000 range"), so the
// failure names its cause instead of only an HTTP status.
async function readRpcErrorDetail(response: { json: () => Promise<unknown> }) {
  try {
    const payload = (await response.json()) as { error?: { message?: unknown }; message?: unknown } | null;
    const message = payload?.error?.message ?? payload?.message;
    return typeof message === "string" ? message : undefined;
  } catch {
    return undefined;
  }
}

async function rpcCallOnce<T>(
  rpcUrl: string,
  method: string,
  params: unknown[],
  fetchImpl: JsonRpcFetch
): Promise<T> {
  const response = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    }),
  });

  if (!response.ok) {
    // Typed error so the retry layer can decide whether this status (429 /
    // 5xx) is worth retrying. The provider's JSON-RPC message rides along.
    throw new RpcHttpError(response.status, await readRpcErrorDetail(response));
  }

  const payload = (await response.json()) as JsonRpcResponse;
  if (payload.error) {
    // A JSON-RPC error body is a deterministic application-level failure, not a
    // transport hiccup — surface it as a plain Error so it is NOT retried.
    throw new Error(
      `Base RPC ${method} returned an error: ${
        payload.error.message || "unknown RPC error"
      }`
    );
  }

  return payload.result as T;
}

async function rpcCall<T>(
  rpcUrl: string,
  method: string,
  params: unknown[],
  fetchImpl: JsonRpcFetch,
  options: RpcCallOptions = {}
): Promise<T> {
  // Delegate the retry/backoff/jitter loop to the shared resilience layer so
  // managed-Venice deposits and the token-tier/holdings refresh share one
  // tested implementation.
  return withRpcRetry<T>(
    () => rpcCallOnce<T>(rpcUrl, method, params, fetchImpl),
    options
  );
}

// ── Chain reader (cached per reconcile batch) ────────────────────────────

interface BaseChainReader {
  call<T>(method: string, params: unknown[]): Promise<T>;
  latestBlock(): Promise<number>;
  // Block timestamp in unix seconds.
  blockTimestamp(block: number): Promise<number>;
}

function createBaseChainReader(params: {
  rpcUrl: string;
  fetchImpl: JsonRpcFetch;
  rpcOptions?: RpcCallOptions;
}): BaseChainReader {
  let latest: Promise<number> | null = null;
  const timestamps = new Map<number, Promise<number>>();
  const call = <T>(method: string, args: unknown[]) =>
    rpcCall<T>(params.rpcUrl, method, args, params.fetchImpl, params.rpcOptions);

  return {
    call,
    latestBlock() {
      if (!latest) {
        latest = call<string>("eth_blockNumber", [])
          .then((value) => parseRpcQuantity(value, "block number"))
          .catch((error: unknown) => {
            latest = null;
            throw error;
          });
      }
      return latest;
    },
    blockTimestamp(block: number) {
      let cached = timestamps.get(block);
      if (!cached) {
        cached = call<EvmBlock | null>("eth_getBlockByNumber", [rpcQuantity(block), false])
          .then((result) => {
            if (!result) throw new Error(`Base RPC returned no block ${block}`);
            return parseRpcQuantity(result.timestamp, "block timestamp");
          })
          .catch((error: unknown) => {
            timestamps.delete(block);
            throw error;
          });
        timestamps.set(block, cached);
      }
      return cached;
    },
  };
}

// Map a unix timestamp to a block. 'floor' returns a block at or before the
// target (a safe range start); 'ceil' returns a block at or after it (a safe
// range end), or null when the chain has not reached the target yet. The
// first probe is estimated from the head at 2 s/block; each probe is checked
// against the real block timestamp and corrected, falling back to bisection
// between the tightest known bounds, so a wrong estimate costs probes, never
// correctness.
async function findBlockForTimestamp(
  chain: BaseChainReader,
  params: { targetSec: number; side: "floor" | "ceil"; latest: number; latestSec: number }
): Promise<number | null> {
  const { targetSec, side, latest, latestSec } = params;
  if (side === "floor" && targetSec >= latestSec) return latest;
  if (side === "ceil" && targetSec > latestSec) return null;

  // "Past" is monotone in block number; the head is past the target here.
  const isPast = (timestampSec: number) =>
    side === "floor" ? timestampSec > targetSec : timestampSec >= targetSec;
  let lo = -1; // greatest block known NOT past the target
  let hi = latest; // least block known past the target
  const blocksBack = (latestSec - targetSec) / BASE_BLOCK_TIME_SEC;
  let guess = side === "floor" ? latest - Math.ceil(blocksBack) : latest - Math.floor(blocksBack);

  for (let probe = 0; probe < MAX_BLOCK_SEARCH_PROBES && hi - lo > 1; probe += 1) {
    guess = Math.min(hi - 1, Math.max(lo + 1, guess));
    const timestampSec = await chain.blockTimestamp(guess);
    const interpolate = probe < INTERPOLATION_PROBES;
    if (isPast(timestampSec)) {
      hi = guess;
      if (side === "ceil" && timestampSec - targetSec <= BLOCK_SEARCH_TOLERANCE_SEC) return guess;
      guess = interpolate
        ? guess - Math.max(1, Math.ceil((timestampSec - targetSec) / BASE_BLOCK_TIME_SEC))
        : Math.floor((lo + hi) / 2);
    } else {
      lo = guess;
      if (side === "floor" && targetSec - timestampSec <= BLOCK_SEARCH_TOLERANCE_SEC) return guess;
      guess = interpolate
        ? guess + Math.max(1, Math.floor((targetSec - timestampSec) / BASE_BLOCK_TIME_SEC))
        : Math.floor((lo + hi) / 2);
    }
  }

  return side === "floor" ? Math.max(0, lo) : hi;
}

// ── Transfer scan ─────────────────────────────────────────────────────────

interface ScannedTransfer {
  transactionHash: string;
  logIndex: number;
  blockNumber: number;
  amount: bigint;
  confirmations: number;
  timestampMs: number;
  observedAt: string;
}

async function scanQuoteTransfers(params: {
  chain: BaseChainReader;
  quote: ManagedVeniceTokenQuote;
  quotedAtMs: number;
  graceEndMs: number;
  minConfirmations: number;
}) {
  const { chain } = params;
  const latest = await chain.latestBlock();
  const latestSec = await chain.blockTimestamp(latest);
  const fromBlock =
    (await findBlockForTimestamp(chain, {
      targetSec: Math.floor(params.quotedAtMs / 1000),
      side: "floor",
      latest,
      latestSec,
    })) ?? 0;
  const graceEndBlock = await findBlockForTimestamp(chain, {
    targetSec: Math.ceil(params.graceEndMs / 1000),
    side: "ceil",
    latest,
    latestSec,
  });
  const toBlock = Math.max(fromBlock, graceEndBlock ?? latest);
  if (toBlock - fromBlock + 1 > MAX_SCAN_SPAN_BLOCKS) {
    throw new Error(
      `Managed Venice quote scan span of ${toBlock - fromBlock + 1} blocks exceeds ${MAX_SCAN_SPAN_BLOCKS}`
    );
  }

  const toTopic = encodeErc20TransferToTopic(params.quote.depositAddress);
  const logs: EvmLog[] = [];
  for (let chunkStart = fromBlock; chunkStart <= toBlock; chunkStart += MAX_BASE_RPC_LOG_RANGE_BLOCKS) {
    const chunkEnd = Math.min(toBlock, chunkStart + MAX_BASE_RPC_LOG_RANGE_BLOCKS - 1);
    const chunkLogs = await chain.call<EvmLog[]>("eth_getLogs", [
      {
        address: HERMESOS_TOKEN_ADDRESS,
        fromBlock: rpcQuantity(chunkStart),
        toBlock: rpcQuantity(chunkEnd),
        topics: [ERC20_TRANSFER_TOPIC, null, toTopic],
      },
    ]);
    if (Array.isArray(chunkLogs)) logs.push(...chunkLogs);
  }

  const parsed = new Map<
    string,
    Omit<ScannedTransfer, "timestampMs" | "observedAt"> & { logTimestampSec: number | null }
  >();
  for (const log of logs) {
    try {
      const address = typeof log.address === "string" ? normalizeEvmAddress(log.address) : "";
      const transactionHash =
        typeof log.transactionHash === "string" ? log.transactionHash.trim().toLowerCase() : "";
      if (address !== HERMESOS_TOKEN_ADDRESS || !transactionHash) continue;
      const amount = decodeUint256LogData(log.data);
      // Zero-value Transfer events are address-poisoning spam, not payments.
      if (amount <= 0n) continue;
      if (log.topics?.[1] === toTopic) continue; // the wallet paying itself
      const blockNumber = parseRpcQuantity(log.blockNumber, "log block number");
      const logIndex = parseRpcQuantity(log.logIndex, "log index");
      parsed.set(`${transactionHash}:${logIndex}`, {
        transactionHash,
        logIndex,
        blockNumber,
        amount,
        confirmations: Math.max(0, latest - blockNumber + 1),
        logTimestampSec:
          typeof log.blockTimestamp === "string" && /^0x[a-fA-F0-9]+$/.test(log.blockTimestamp)
            ? Number.parseInt(log.blockTimestamp, 16)
            : null,
      });
    } catch {
      continue;
    }
  }

  const blocksToFetch = new Set(
    [...parsed.values()]
      .filter((entry) => entry.logTimestampSec === null)
      .map((entry) => entry.blockNumber)
  );
  if (blocksToFetch.size > MAX_TRANSFER_TIMESTAMP_LOOKUPS) {
    throw new Error(
      `Managed Venice quote scan found transfers in ${blocksToFetch.size} blocks; ` +
        `refusing to look up more than ${MAX_TRANSFER_TIMESTAMP_LOOKUPS}`
    );
  }
  const transfers: ScannedTransfer[] = [];
  for (const { logTimestampSec, ...transfer } of parsed.values()) {
    const timestampSec = logTimestampSec ?? (await chain.blockTimestamp(transfer.blockNumber));
    transfers.push({
      ...transfer,
      timestampMs: timestampSec * 1000,
      observedAt: new Date(timestampSec * 1000).toISOString(),
    });
  }
  transfers.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);

  // Every block at or below the confirmed head has >= minConfirmations.
  const confirmedHead = latest - params.minConfirmations + 1;
  const confirmedHeadMs =
    confirmedHead >= 0 ? (await chain.blockTimestamp(confirmedHead)) * 1000 : Number.NEGATIVE_INFINITY;

  return { transfers, confirmedHeadMs };
}

// ── Attribution ───────────────────────────────────────────────────────────
// The user's credit_deposit wallet is shared by every managed-Venice quote the
// user ever makes AND by yearly $HermesOS payments. A transfer at block time t
// belongs to this quote only if quotedAt <= t < (the user's next $HermesOS
// payment session on this wallet): the next managed-Venice quote on the same
// address (any status) or the user's next yearly token quote. Deposit quotes
// (hold tier) are balance checks on the separate hermesos_lock wallet and USDC
// top-ups are a different token, so neither can produce a $HermesOS transfer
// here.

async function loadAttributionBoundaryMs(db: SupabaseLike, quote: ManagedVeniceTokenQuote) {
  const [nextManaged, nextYearly] = await Promise.all([
    (db.from("managed_venice_token_quotes") as DbQuery)
      .select("id, quoted_at")
      .eq("deposit_address", quote.depositAddress)
      .gt("quoted_at", quote.quotedAt)
      .order("quoted_at", { ascending: true })
      .limit(1),
    (db.from("yearly_token_quotes") as DbQuery)
      .select("id, quoted_at")
      .eq("user_id", quote.userId)
      .gt("quoted_at", quote.quotedAt)
      .order("quoted_at", { ascending: true })
      .limit(1),
  ]);
  for (const result of [nextManaged, nextYearly]) {
    if (result.error) {
      throw new Error(result.error.message || "Failed to load the next $HermesOS payment session");
    }
  }
  const boundaries = [nextManaged.data, nextYearly.data]
    .flatMap((rows) => (Array.isArray(rows) ? (rows as Array<{ quoted_at?: unknown }>) : []))
    .map((row) => Date.parse(String(row.quoted_at)))
    .filter((value) => Number.isFinite(value));
  return boundaries.length ? Math.min(...boundaries) : null;
}

// Tx hashes already accounted for by any flow that records $HermesOS
// transfers: managed-Venice quote claims and lots, consumed yearly quotes and
// yearly subscriptions. Such a transfer is never attributed to this quote.
const BOUND_TRANSACTION_COLUMNS: Array<[string, string]> = [
  ["managed_venice_token_quotes", "transaction_hash"],
  ["managed_venice_token_lots", "transaction_hash"],
  ["yearly_token_quotes", "consumed_tx_hash"],
  ["yearly_token_subscriptions", "deposit_tx_hash"],
];

async function loadBoundTransactionHashes(db: SupabaseLike, transactionHashes: string[]) {
  const bound = new Set<string>();
  if (transactionHashes.length === 0) return bound;
  const variants = Array.from(new Set(transactionHashes.flatMap((hash) => [hash, hash.toLowerCase()])));
  const results = await Promise.all(
    BOUND_TRANSACTION_COLUMNS.map(([tableName, column]) =>
      (db.from(tableName) as DbQuery).select(column).in(column, variants)
    )
  );
  results.forEach((result, index) => {
    const [tableName, column] = BOUND_TRANSACTION_COLUMNS[index];
    if (result.error) {
      throw new Error(result.error.message || `Failed to check ${tableName} transaction hashes`);
    }
    for (const row of Array.isArray(result.data) ? (result.data as Array<Record<string, unknown>>) : []) {
      const value = row[column];
      if (typeof value === "string") bound.add(value.toLowerCase());
    }
  });
  return bound;
}

type TransferClass =
  | "qualifying" // in window, quoted <= amount <= ceiling
  | "over" // in window, above the ceiling
  | "under" // in window, below the quote
  | "late_qualifying" // after the window, in band
  | "late_other"; // after the window, out of band

const CLASS_REASON: Record<TransferClass, ManagedVeniceTokenDepositReason> = {
  qualifying: MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.extraTransfer,
  over: MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.amountMismatch,
  under: MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.underpaid,
  late_qualifying: MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.outsideQuoteWindow,
  late_other: MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.unattributedLateTransfer,
};

function classifyTransfer(
  transfer: ScannedTransfer,
  quote: { quoted: bigint; ceiling: bigint; expiresAtMs: number }
): TransferClass {
  const inBand = transfer.amount >= quote.quoted && transfer.amount <= quote.ceiling;
  if (transfer.timestampMs > quote.expiresAtMs) return inBand ? "late_qualifying" : "late_other";
  if (inBand) return "qualifying";
  return transfer.amount > quote.ceiling ? "over" : "under";
}

function quotePayload(
  quote: Omit<ManagedVeniceTokenQuote, "status"> & { status: string }
) {
  return {
    id: quote.id,
    tokenAmountRaw: quote.tokenAmountRaw,
    tokenSymbol: quote.tokenSymbol,
    tokenDecimals: quote.tokenDecimals,
    snapshotPriceUsd: quote.snapshotPriceUsd,
    paidValueMicroUsd: quote.paidValueMicroUsd,
    creditValueMicroUsd: quote.creditValueMicroUsd,
    bonusValueMicroUsd: quote.bonusValueMicroUsd,
    depositAddress: quote.depositAddress,
    expiresAt: quote.expiresAt,
    status: quote.status,
    transactionHash: quote.transactionHash,
    settledAt: quote.settledAt,
  };
}

async function loadPendingManagedVeniceTokenQuoteCandidates(params: {
  db: SupabaseLike;
  limit: number;
}) {
  // Newest first: a fresh payment is always inside the batch, whatever older
  // quotes are still open. Older quotes leave the set by settling, going to
  // review, or retiring once their window + grace has been fully scanned.
  const { data, error } = await (params.db.from("managed_venice_token_quotes") as DbQuery)
    .select("id, user_id, status")
    .in("status", ["active", "expired"])
    .order("created_at", { ascending: false })
    .limit(params.limit);

  if (error) {
    throw new Error(error.message || "Failed to load pending managed Venice token quotes");
  }

  return (Array.isArray(data) ? data : [])
    .map((row): { id: string; userId: string } | null => {
      const candidate = row as PendingQuoteCandidateRow;
      if (typeof candidate.id !== "string" || typeof candidate.user_id !== "string") {
        return null;
      }
      return { id: candidate.id, userId: candidate.user_id };
    })
    .filter((candidate): candidate is { id: string; userId: string } => Boolean(candidate));
}

function settlementOutcome(
  quote: ManagedVeniceTokenQuote,
  settlement: ManagedVeniceTokenSettlementResult,
  transfer: { transactionHash: string; confirmations?: number },
  now: Date
) {
  const settled = settlement.status === "settled";
  return {
    status: settlement.status,
    quote: quotePayload({
      ...quote,
      status: settlement.status === "transaction_already_claimed" ? quote.status : settlement.status,
      transactionHash: settled ? transfer.transactionHash : quote.transactionHash,
      settledAt: settled ? now.toISOString() : quote.settledAt,
    }),
    confirmations: transfer.confirmations,
    transactionHash: transfer.transactionHash,
  };
}

// A quote that already claimed a tx, or already has a lot, crashed part-way
// through settlement: finish it on that tx without scanning.
function recoveryTransfer(
  quote: ManagedVeniceTokenQuote,
  lot: ManagedVeniceTokenDepositLot | null,
  now: Date
) {
  const claim = quote.settlementClaim ?? null;
  const transactionHash = lot?.transactionHash ?? claim?.transactionHash ?? quote.transactionHash;
  if (!transactionHash) {
    throw new Error(
      "Managed Venice token quote has a deposit lot without a transaction hash; it needs manual review"
    );
  }
  return {
    quoteId: quote.id,
    transactionHash,
    tokenAmountRaw: lot?.tokenAmountRaw ?? claim?.tokenAmountRaw ?? quote.tokenAmountRaw,
    observedAt: lot?.observedAt ?? claim?.observedAt ?? now.toISOString(),
    blockTimestamp: lot?.blockTimestamp ?? claim?.blockTimestamp ?? null,
    logIndex: lot?.logIndex ?? claim?.logIndex ?? null,
  };
}

async function surfaceTransfers(
  db: SupabaseLike,
  quote: ManagedVeniceTokenQuote,
  transfers: ScannedTransfer[],
  reasonFor: (transfer: ScannedTransfer) => ManagedVeniceTokenDepositReason
) {
  for (const transfer of transfers) {
    await surfaceManagedVeniceTokenTransfer(
      {
        quote,
        transactionHash: transfer.transactionHash,
        logIndex: transfer.logIndex,
        tokenAmountRaw: transfer.amount.toString(),
        observedAt: transfer.observedAt,
        reason: reasonFor(transfer),
      },
      db
    );
  }
}

export async function reconcileManagedVeniceTokenQuote(params: {
  quoteId: string;
  userId: string;
  db?: SupabaseLike | null;
  rpcUrl?: string;
  fetchImpl?: JsonRpcFetch;
  minConfirmations?: number;
  settleQuote?: SettleManagedVeniceQuote;
  now?: Date;
  rpcOptions?: RpcCallOptions;
  // Shared by a batch so the head and block timestamps are fetched once.
  chain?: BaseChainReader;
}) {
  const db = requireDb(params.db ?? supabaseAdmin);
  const quote = await loadManagedVeniceTokenQuoteForUser(
    { quoteId: params.quoteId, userId: params.userId },
    db
  );

  if (!quote) {
    return { status: "not_found" as const };
  }

  if (quote.status !== "active" && quote.status !== "expired") {
    return {
      status: quote.status,
      quote: quotePayload(quote),
    };
  }

  const settle = params.settleQuote ?? settleManagedVeniceTokenQuote;
  const now = params.now ?? new Date();

  const lot = await loadManagedVeniceTokenDepositLot(quote.id, db);
  if (quote.transactionHash || lot) {
    const recovery = recoveryTransfer(quote, lot, now);
    const settlement = await settle(recovery, db);
    return settlementOutcome(quote, settlement, recovery, now);
  }

  const chain =
    params.chain ??
    createBaseChainReader({
      rpcUrl: params.rpcUrl || getBaseRpcUrl(),
      fetchImpl: params.fetchImpl || (fetch as unknown as JsonRpcFetch),
      rpcOptions: params.rpcOptions,
    });
  const minConfirmations = normalizeMinConfirmations(params.minConfirmations);
  const window = managedVeniceTokenQuoteWindow(quote);
  const quotedAtMs = window.quotedAt.getTime();
  const expiresAtMs = window.effectiveExpiresAt.getTime();
  const graceEndMs = expiresAtMs + LATE_PAYMENT_GRACE_MS;

  const scan = await scanQuoteTransfers({ chain, quote, quotedAtMs, graceEndMs, minConfirmations });
  const boundaryMs = await loadAttributionBoundaryMs(db, quote);
  const inRange = scan.transfers.filter(
    (transfer) =>
      transfer.timestampMs >= quotedAtMs &&
      transfer.timestampMs <= graceEndMs &&
      (boundaryMs === null || transfer.timestampMs < boundaryMs)
  );
  const bound = await loadBoundTransactionHashes(
    db,
    inRange.map((transfer) => transfer.transactionHash)
  );
  const attributable = inRange.filter((transfer) => !bound.has(transfer.transactionHash));

  const quoted = BigInt(quote.tokenAmountRaw);
  const band = {
    quoted,
    ceiling: (quoted * MANAGED_VENICE_MAX_OVERSEND_NUMERATOR) / MANAGED_VENICE_MAX_OVERSEND_DENOMINATOR,
    expiresAtMs,
  };
  const classOf = (transfer: ScannedTransfer) => classifyTransfer(transfer, band);
  const isConfirmed = (transfer: ScannedTransfer) => transfer.confirmations >= minConfirmations;
  const settleWith = (transfer: ScannedTransfer) =>
    settle(
      {
        quoteId: quote.id,
        transactionHash: transfer.transactionHash,
        // Hand settle the ACTUAL on-chain amount: an accepted over-send is
        // credited pro-rata for what the user really sent.
        tokenAmountRaw: transfer.amount.toString(),
        observedAt: now.toISOString(),
        blockTimestamp: transfer.observedAt,
        logIndex: transfer.logIndex,
      },
      db
    );

  // 1. The settlement candidate is the EARLIEST qualifying in-window transfer
  //    in chain order. New arrivals can never displace it, and an
  //    under-confirmed candidate is waited for, never skipped.
  const candidate = attributable.find((transfer) => classOf(transfer) === "qualifying");
  if (candidate) {
    if (!isConfirmed(candidate)) {
      return {
        status: "underconfirmed" as const,
        quote: quotePayload(quote),
        confirmations: candidate.confirmations,
      };
    }
    const settlement = await settleWith(candidate);
    if (settlement.status === "settled") {
      await surfaceTransfers(
        db,
        quote,
        attributable.filter((transfer) => transfer !== candidate && isConfirmed(transfer)),
        () => MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.extraTransfer
      );
    }
    return settlementOutcome(quote, settlement, candidate, now);
  }

  // 2. No qualifying transfer: confirmed non-qualifying ones go to review.
  //    Above-ceiling and late in-band transfers review now; an under-payment
  //    only once the window has closed on a confirmed chain, so the user can
  //    still send the full amount until then.
  const confirmed = attributable.filter(isConfirmed);
  const windowClosed = now.getTime() > expiresAtMs && scan.confirmedHeadMs >= expiresAtMs;
  const reviewTrigger =
    confirmed.find((transfer) => classOf(transfer) === "over") ??
    confirmed.find((transfer) => classOf(transfer) === "late_qualifying") ??
    (windowClosed ? confirmed.find((transfer) => classOf(transfer) === "under") : undefined);
  if (reviewTrigger) {
    const settlement = await settleWith(reviewTrigger);
    await surfaceTransfers(
      db,
      quote,
      confirmed.filter((transfer) => transfer !== reviewTrigger),
      (transfer) => CLASS_REASON[classOf(transfer)]
    );
    return settlementOutcome(quote, settlement, reviewTrigger, now);
  }

  // Late out-of-band transfers never settle or review the quote: item only.
  const lateOther = confirmed.filter((transfer) => classOf(transfer) === "late_other");
  await surfaceTransfers(
    db,
    quote,
    lateOther,
    () => MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.unattributedLateTransfer
  );

  const awaitingConfirmations = attributable.filter(
    (transfer) => !isConfirmed(transfer) && classOf(transfer) !== "late_other"
  );
  if (awaitingConfirmations.length > 0) {
    return {
      status: "underconfirmed" as const,
      quote: quotePayload(quote),
      confirmations: Math.max(...awaitingConfirmations.map((transfer) => transfer.confirmations)),
    };
  }

  // 3. Retire: the whole window + grace is scanned at full confirmations and
  //    nothing left can settle or review this quote.
  const fullyScanned = scan.confirmedHeadMs >= graceEndMs;
  if (fullyScanned && confirmed.length === lateOther.length) {
    const retired = await retireManagedVeniceTokenQuote({ quoteId: quote.id, closedAt: now }, db);
    return {
      status: retired.status,
      quote: quotePayload({ ...quote, status: retired.status }),
    };
  }

  return {
    status: "no_match" as const,
    quote: quotePayload(quote),
  };
}

export async function reconcilePendingManagedVeniceTokenQuotes(params: {
  db?: SupabaseLike | null;
  rpcUrl?: string;
  fetchImpl?: JsonRpcFetch;
  minConfirmations?: number;
  settleQuote?: SettleManagedVeniceQuote;
  now?: Date;
  limit?: number;
  // Resilience knobs (all optional; sensible defaults). Exposed mainly so tests
  // can inject a fake sleep/random and tighten the retry budget.
  rpcRetryConfig?: Partial<RpcRetryConfig>;
  rpcSleepImpl?: (ms: number) => Promise<void>;
  rpcRandom?: () => number;
  interQuoteDelayMs?: number;
} = {}): Promise<ManagedVeniceTokenQuoteBatchReconciliationResult> {
  const db = requireDb(params.db ?? supabaseAdmin);
  const candidates = await loadPendingManagedVeniceTokenQuoteCandidates({
    db,
    limit: normalizePendingQuoteLimit(params.limit),
  });

  // Build the per-call RPC options once: retry config + injectable sleep/random
  // ride along with every eth_* call this batch makes.
  const rpcOptions: RpcCallOptions = {
    retryConfig: normalizeRpcRetryConfig(params.rpcRetryConfig),
    sleepImpl: params.rpcSleepImpl,
    random: params.rpcRandom,
  };
  // One chain view per batch: the head and each block timestamp are fetched
  // once and shared by every quote in the tick.
  const chain = createBaseChainReader({
    rpcUrl: params.rpcUrl || getBaseRpcUrl(),
    fetchImpl: params.fetchImpl || (fetch as unknown as JsonRpcFetch),
    rpcOptions,
  });
  const sleepImpl = params.rpcSleepImpl ?? sleep;
  const interQuoteDelayMs = Number.isFinite(params.interQuoteDelayMs)
    ? Math.max(0, Math.floor(params.interQuoteDelayMs as number))
    : DEFAULT_INTER_QUOTE_DELAY_MS;

  const summary: ManagedVeniceTokenQuoteBatchReconciliationResult = {
    checked: 0,
    settled: 0,
    underconfirmed: 0,
    noMatch: 0,
    manualReview: 0,
    cancelled: 0,
    skipped: 0,
    failed: 0,
    results: [],
  };

  let index = 0;
  for (const candidate of candidates) {
    // Throttle between quotes (not before the first) to keep the per-tick
    // request rate under the public Base RPC endpoint's rate-limit threshold.
    if (index > 0 && interQuoteDelayMs > 0) {
      await sleepImpl(interQuoteDelayMs);
    }
    index += 1;
    summary.checked += 1;
    try {
      const result = await reconcileManagedVeniceTokenQuote({
        quoteId: candidate.id,
        userId: candidate.userId,
        db,
        minConfirmations: params.minConfirmations,
        settleQuote: params.settleQuote,
        now: params.now,
        rpcOptions,
        chain,
      });

      if (result.status === "settled") summary.settled += 1;
      else if (result.status === "underconfirmed") summary.underconfirmed += 1;
      else if (result.status === "no_match") summary.noMatch += 1;
      else if (result.status === "manual_review_required") summary.manualReview += 1;
      else if (result.status === "cancelled") summary.cancelled += 1;
      else summary.skipped += 1;

      summary.results.push({
        quoteId: candidate.id,
        userId: candidate.userId,
        status: result.status,
        transactionHash: "transactionHash" in result ? result.transactionHash ?? null : null,
        confirmations: "confirmations" in result ? result.confirmations : undefined,
      });
    } catch (error) {
      summary.failed += 1;
      summary.results.push({
        quoteId: candidate.id,
        userId: candidate.userId,
        status: "failed",
        errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return summary;
}
