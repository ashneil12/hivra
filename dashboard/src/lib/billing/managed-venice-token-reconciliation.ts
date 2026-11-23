import { claimCronUtcDayOutcome } from "@/lib/cron-heartbeat";
import { livePlatformTokens } from "@/lib/billing/token-registry";
import { requireDb } from "@/lib/billing/db-utils";
import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";
import {
  HERMESOS_TOKEN_ADDRESS,
  normalizeEvmAddress,
} from "@/lib/billing/token-holdings";
import {
  completeManagedVeniceTokenTransferSurfacing,
  isManagedVeniceTransferBindingCounted,
  loadManagedVeniceTokenDepositLot,
  loadManagedVeniceTokenQuoteForUser,
  loadManagedVeniceTransferBindings,
  managedVeniceTokenQuoteWindow,
  retireManagedVeniceTokenQuote,
  settleManagedVeniceTokenQuote,
  surfaceManagedVeniceTokenReviewTrigger,
  surfaceManagedVeniceTokenTransfer,
  TOKEN_DEPOSIT_LOT_SOURCES,
  MANAGED_VENICE_MAX_OVERSEND_NUMERATOR,
  MANAGED_VENICE_MAX_OVERSEND_DENOMINATOR,
  MANAGED_VENICE_TOKEN_DEPOSIT_REASONS,
  MANAGED_VENICE_TRANSFER_SURFACING_STATUSES,
  type ManagedVeniceTokenDepositLot,
  type ManagedVeniceTokenDepositReason,
  type ManagedVeniceTokenQuote,
  type ManagedVeniceTokenSettlementResult,
  type ManagedVeniceTransferBinding,
} from "@/lib/billing/managed-venice-token-quotes";
import {
  ERC20_TRANSFER_TOPIC,
  encodeErc20TransferToTopic,
  blockTimestampsFor,
  findBlockForTimestamp,
  paymentDustFloor,
  tokenDustFloor,
} from "@/lib/billing/base-transfer-scan";
import {
  computeBackoffDelayMs,
  isRetryableRpcError,
  normalizeRpcRetryConfig,
  RpcCallAbortedError,
  RpcHttpError,
  baseRpcPayloadError,
  sleep,
  withRpcRetry,
  type RpcCallOptions,
  type RpcRetryConfig,
} from "@/lib/billing/base-rpc-retry";
import { getLogsInBlockChunks } from "@/lib/billing/base-rpc-logs";

// Re-exported so existing importers/tests of this module keep their entry
// points. The implementations now live in the shared base-rpc-retry module so
// every Base RPC path (managed-Venice deposits, token-tier/holdings refresh)
// shares one tested resilience layer.
export {
  computeBackoffDelayMs,
  isRetryableRpcError,
  RpcCallAbortedError,
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
  neq: (...args: unknown[]) => DbQuery;
  in: (...args: unknown[]) => DbQuery;
  not: (...args: unknown[]) => DbQuery;
  gt: (...args: unknown[]) => DbQuery;
  lt: (...args: unknown[]) => DbQuery;
  lte: (...args: unknown[]) => DbQuery;
  is: (...args: unknown[]) => DbQuery;
  or: (...args: unknown[]) => DbQuery;
  order: (...args: unknown[]) => DbQuery;
  limit: (...args: unknown[]) => DbQuery;
  range: (...args: unknown[]) => DbQuery;
  then: Promise<{ data?: unknown; error: QueryError }>["then"];
};

type DbTable = {
  update: (patch: Record<string, unknown>) => DbQuery;
};

type JsonRpcFetch = (
  input: string,
  init: {
    method: "POST";
    headers: { "Content-Type": "application/json" };
    body: string;
    signal?: AbortSignal;
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
const DEFAULT_MIN_CONFIRMATIONS = 3;
// Open (active|expired) quotes per batch. The cron route passes 50 (its own
// default); this default only serves callers that pass no limit.
const DEFAULT_PENDING_QUOTE_RECONCILIATION_LIMIT = 25;
const MAX_PENDING_QUOTE_RECONCILIATION_LIMIT = 100;
// Settled / in-review quotes given a surface-only pass per batch, after the
// open quotes. A quote only carries transfer_surfacing_pending until its
// window + grace (or the start of the user's next payment session) is
// confirmed, a few hours, so this set stays small; newest first keeps a stuck
// old one from pinning it.
const TRANSFER_SURFACING_LIMIT = 25;
// RPC budget per cron tick (50 open + 25 surface-only quotes = 75 scans; a
// claimed open quote is recovered without a scan). One head (eth_blockNumber)
// and its timestamp per batch, then per scanned quote:
//   - 2 timestamp->block searches, each <= 40 probes (findBlockForTimestamp);
//     eth_getBlockByNumber probes; the 2 s/block estimate is verified, so
//     typically 1-3 probes each, and every block timestamp is cached per batch;
//   - ceil(span / 2,000) eth_getLogs: a window + grace is ~4,200 blocks, so 3;
//     hard cap MAX_SCAN_SPAN_BLOCKS (50,000) / 2,000 = 25;
//   - <= 200 block timestamps for logs that carry no blockTimestamp (usually
//     a handful of transfers, often 0; above 200 blocks, one read and Base's
//     fixed block time, see blockTimestampsFor);
//   - 1 confirmed-head block timestamp (the same block for every quote).
// Worst case, every bound hit and nothing cached:
//   2 + 75 x (80 + 25 + 200 + 1) = 22,952 calls,
// each retried up to the retry config's attempts (default 4) on 429/5xx/network.
// Typical: 2 + 75 x (~4 + 3 + ~1 + 1) ~ 700 calls, plus a 150 ms pause between
// quotes (~11 s per tick). A slow or rate-limited RPC stretches that, so the
// batch has a wall-clock budget below the cron's maxDuration (300 s): it
// starts open-quote scans only for the first OPEN_SCAN_BUDGET_MS and
// surface-only scans only for the first SURFACING_SCAN_BUDGET_MS, and reports
// what it deferred, so a slow tick still reaches the surface-only pass and
// its summary instead of being killed mid-batch. On the once-a-day stale
// tick the stale pass runs FIRST, inside its own STALE_SCAN_BUDGET_MS slice
// of the same clock: the regular open loop can never starve it, and a stale
// backlog can only borrow what the open loop would have used.
const OPEN_SCAN_BUDGET_MS = 150_000;
const SURFACING_SCAN_BUDGET_MS = 240_000;
const STALE_SCAN_BUDGET_MS = 60_000;
// Recovery candidates (claimed / lot-held) always run ahead of fresh scans —
// a crashed settlement finishes without RPC — but they share the open
// budget's clock. A sustained failure storm of them (each attempt blocking
// on a slow write) could otherwise spend the whole slice ahead of fresh
// discovery, so the recovery lanes are bounded to this share of the open
// budget and fresh quotes keep the rest guaranteed. A never-attempted claim
// is still admitted first every tick — the updated_at cursor keeps it at
// the head of the claimed lane — and retries once the storm drains.
const RECOVERY_OPEN_BUDGET_SHARE = 0.5;

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
//
// Accepted limitations (each needs an address-level unsolicited-deposit
// detector that scans every credit_deposit wallet independently of quotes;
// follow-up):
//   - A payment mined AFTER window + grace is never scanned by any quote. For
//     a quote that retired (or whose surface-only pass already cleared its
//     flag) such a transfer is not detected or surfaced at all.
//   - A transfer mined at or after the start of the user's NEXT $HermesOS
//     payment session on the shared wallet (a later managed-Venice quote, or a
//     yearly_token_quotes row, consumed or not) is never attributed to this
//     quote, even inside this quote's window or grace. It belongs to that later
//     session. If the later session does not account for it (the yearly flow
//     detects payment by wallet balance and records no tx), it is neither
//     credited nor surfaced here. The yearly follow-up owns that attribution.
const LATE_PAYMENT_GRACE_MS = 2 * 60 * 60_000;
// How long past its expiry an open quote keeps being log-scanned by the
// cron. A quote whose whole window + grace is scanned with nothing to act on
// retires to 'cancelled' long before this; the grace only bounds quotes whose
// scans keep failing or never complete, so one stuck quote cannot hold RPC
// budget forever. Past it the quote moves to 'expired' (still settleable on
// demand) instead of being scanned again.
const NO_DEPOSIT_AFTER_EXPIRY_GRACE_MS = 7 * 24 * 60 * 60_000;
// Stale unclaimed quotes scanned (and possibly expired) once per UTC day, on
// the first tick of a new day, least-recently-scanned first (the updated_at
// cursor in loadStaleUnpaidQuoteRows). Each costs a real log scan, so the
// batch stays small and runs inside its own budget slice ahead of the regular
// open work; the rest of the backlog waits for the next day.
const STALE_QUOTE_DAILY_SCAN_LIMIT = 25;
const MANAGED_VENICE_TOKEN_RECONCILIATION_CRON = "managed-venice-token-reconciliation";
// Base produces a block every 2 s; used to estimate a block from a timestamp.
// Every estimate is verified against eth_getBlockByNumber before it is used.
const BASE_BLOCK_TIME_SEC = 2;
// Finality margin for decisions that can never be revisited: retiring a quote
// to 'cancelled', clearing transfer_surfacing_pending, and the under-payment
// review gate. The head comes from eth_blockNumber and the logs from separate
// eth_getLogs calls, which a load-balanced RPC can answer from a backend a few
// blocks behind (silently clamping toBlock to its own head). Requiring the
// confirmed head to be this many blocks past the range end means the logs
// must cover the whole range unless that backend lags by more than the
// margin. Measured on real block timestamps: confirmedHeadMs >= rangeEndMs +
// FINALITY_MARGIN_MS. Settling a transfer that was actually seen is unchanged.
const FINALITY_MARGIN_BLOCKS = 30;
const FINALITY_MARGIN_MS = FINALITY_MARGIN_BLOCKS * BASE_BLOCK_TIME_SEC * 1000;
// Each Base RPC request gives up after this long and is retried by the shared
// retry layer, so one stalled read cannot hold the reconcile tick.
const DEFAULT_RPC_REQUEST_TIMEOUT_MS = 10_000;
// Bound per-quote RPC work: a window + grace is ~4,200 blocks and has a
// handful of transfers; anything far above that is refused, not scanned.
const MAX_SCAN_SPAN_BLOCKS = 50_000;

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
  // Surface-only passes over settled / in-review quotes that still owe one.
  // Counted apart from the open-quote fields above so a quote already in
  // review is not re-reported as a new manual review every tick; a failed
  // pass is also counted in `failed` and listed in `results`.
  transferSurfacing: {
    checked: number;
    complete: number;
    pending: number;
    failed: number;
  };
  // Candidates not scanned this tick because the batch's time budget ran out
  // (open quotes / surface-only quotes). They are picked up by a later tick.
  deferred: {
    open: number;
    surfacing: number;
  };
  // The once-a-day stale pass was due but its candidate SELECT failed. No
  // per-quote failure exists to count in `failed`, so this is reported apart
  // — the caller's incident report and heartbeat must read the tick as
  // degraded, not as a clean pass that scanned nothing (the crypto
  // reconciler's staleRetryLoadFailed pattern). The pass retries on the next
  // day's first tick.
  staleScanLoadFailed: boolean;
  // The stale pass's once-a-day slot could not even be claimed: the claim
  // WRITE failed (as opposed to another run already holding the day, which
  // is a clean skip). Without this flag a tick whose claim keeps failing
  // records a clean heartbeat while the stale pass runs on NO tick. The
  // pass stays deferred — not lost — and retries on the next tick.
  staleScanClaimFailed: boolean;
  // The open lane's lot probe — the bounded page over open quotes matched
  // against their deposit lots (loadOpenLotHoldingQuoteCandidates) —
  // failed. Like the stale flags this is an auxiliary failure with no
  // per-quote result to count: the claimed and fresh lanes still ran and
  // every reconcile's own per-quote lot check is unaffected, but the tick
  // found no lot-held recovery candidates at all, so it must read as
  // degraded rather than a clean pass that simply had none. The probe
  // retries on the next tick.
  lotProbeLoadFailed: boolean;
  results: Array<{
    quoteId: string;
    userId: string;
    status: ReconcileManagedVeniceTokenQuoteResult["status"] | "failed" | "expired";
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
  let response: Awaited<ReturnType<JsonRpcFetch>>;
  try {
    response = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params,
      }),
      // A provider that accepts the connection and then stalls must not hold
      // the cron tick (or the holdings run budget): time out, and retry below.
      signal: AbortSignal.timeout(DEFAULT_RPC_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const name = (error as { name?: unknown } | null)?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      // A network-level failure, like fetch's own TypeError: retryable.
      throw new TypeError(`Base RPC ${method} timed out after ${DEFAULT_RPC_REQUEST_TIMEOUT_MS} ms`);
    }
    throw error;
  }

  if (!response.ok) {
    // Typed error so the retry layer can decide whether this status (429 /
    // 5xx) is worth retrying. The provider's JSON-RPC message rides along.
    throw new RpcHttpError(response.status, await readRpcErrorDetail(response));
  }

  const payload = (await response.json()) as JsonRpcResponse;
  if (payload.error) {
    // A JSON-RPC error body is a deterministic application-level failure, not a
    // transport hiccup — surface it as a plain Error so it is NOT retried.
    throw baseRpcPayloadError(method, payload.error);
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
  // The endpoint `call` talks to: getLogsInBlockChunks scopes its discovered
  // eth_getLogs range cap by this.
  endpoint?: string;
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
    endpoint: params.rpcUrl,
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

// ── Deposit Transfer logs ─────────────────────────────────────────────────

// One incoming $HermesOS payment to a deposit address, as a Transfer log.
interface DepositTransferLog {
  transactionHash: string;
  logIndex: number;
  blockNumber: number;
  amount: bigint;
  logTimestampSec: number | null;
}

// The Transfer logs that count as payments to a deposit address: emitted by
// the $HermesOS token contract, the ERC-20 Transfer event (topics[0]) to the
// address (topics[2]), not sent by the address itself (topics[1]), with a
// positive amount. The quote scan and the bearer delivery resolver both accept
// exactly these logs, so a tx's first log to the address, which carries the
// bare tx/address item key, is the same log on both paths. Null for any other
// log, including one that does not parse.
function parseDepositTransferLog(log: EvmLog, toTopic: string, tokenAddress: string): DepositTransferLog | null {
  try {
    const address = typeof log.address === "string" ? normalizeEvmAddress(log.address) : "";
    const transactionHash =
      typeof log.transactionHash === "string" ? log.transactionHash.trim().toLowerCase() : "";
    if (address !== tokenAddress.toLowerCase() || !transactionHash) return null;
    const topics = (Array.isArray(log.topics) ? log.topics : []).map((topic) =>
      typeof topic === "string" ? topic.toLowerCase() : null
    );
    if (topics[0] !== ERC20_TRANSFER_TOPIC || topics[2] !== toTopic) return null;
    if (topics[1] === toTopic) return null; // the wallet paying itself
    const amount = decodeUint256LogData(log.data);
    // Zero-value Transfer events are address-poisoning spam, not payments.
    if (amount <= 0n) return null;
    return {
      transactionHash,
      logIndex: parseRpcQuantity(log.logIndex, "log index"),
      blockNumber: parseRpcQuantity(log.blockNumber, "log block number"),
      amount,
      logTimestampSec:
        typeof log.blockTimestamp === "string" && /^0x[a-fA-F0-9]+$/.test(log.blockTimestamp)
          ? Number.parseInt(log.blockTimestamp, 16)
          : null,
    };
  } catch {
    return null;
  }
}

// The item dedupe log index of one of a tx's logs to a deposit address: null
// (the bare tx/address key) for the tx's first log to the address, the log's
// own index for a later one (see managedVeniceTokenTransferDedupeKey).
function dedupeLogIndexOf(logIndex: number, firstLogIndex: number) {
  return logIndex === firstLogIndex ? null : logIndex;
}

// ── Bearer delivery resolution ────────────────────────────────────────────
// The bearer settle route receives (quote, tx, amount) without a log index. A
// tx can pay one deposit address several times (a batched double-send), so a
// tx alone does not name a transfer. Before anything is keyed, bound or
// claimed, the delivery is resolved against the tx receipt to the one Transfer
// log to the quote's address that carries the delivered amount, and gets the
// same (log index, dedupe log index) identity the reconciler's scan gives that
// log. Anything that cannot be resolved to exactly one log is refused as
// retryable, with nothing written: the reconciler attributes the tx from its
// own scan.

export type ManagedVeniceTokenTransferLogRetryReason =
  // No receipt: the tx is unknown to the RPC or not mined yet.
  | "receipt_unavailable"
  // The receipt's status is not success (the tx reverted).
  | "transaction_failed"
  // No accepted Transfer log to the address carries the delivered amount.
  | "no_matching_log"
  // Several accepted Transfer logs to the address carry the delivered amount.
  | "ambiguous_log";

export type ManagedVeniceTokenTransferLogResolution =
  | { status: "resolved"; logIndex: number; dedupeLogIndex: number | null }
  | { status: "retryable"; reason: ManagedVeniceTokenTransferLogRetryReason; matchingLogIndexes?: number[] };

interface EvmTransactionReceipt {
  status?: unknown;
  logs?: unknown;
}

function isSuccessfulReceiptStatus(status: unknown) {
  return typeof status === "string" && /^0x0*1$/i.test(status);
}

export async function resolveManagedVeniceTokenTransferLog(params: {
  transactionHash: string;
  depositAddress: string;
  tokenAmountRaw: string | bigint;
  /** The quote's token: only its Transfer logs can pay the quote. Default $HermesOS. */
  tokenAddress?: string;
  rpcUrl?: string;
  fetchImpl?: JsonRpcFetch;
  rpcOptions?: RpcCallOptions;
}): Promise<ManagedVeniceTokenTransferLogResolution> {
  const chain = createBaseChainReader({
    rpcUrl: params.rpcUrl || getBaseRpcUrl(),
    fetchImpl: params.fetchImpl || (fetch as unknown as JsonRpcFetch),
    rpcOptions: params.rpcOptions,
  });
  const transactionHash = params.transactionHash.trim().toLowerCase();
  const receipt = await chain.call<EvmTransactionReceipt | null>("eth_getTransactionReceipt", [transactionHash]);
  if (!receipt) return { status: "retryable", reason: "receipt_unavailable" };
  if (!isSuccessfulReceiptStatus(receipt.status)) return { status: "retryable", reason: "transaction_failed" };
  if (!Array.isArray(receipt.logs)) {
    throw new Error("Invalid eth_getTransactionReceipt result from Base RPC");
  }

  const toTopic = encodeErc20TransferToTopic(params.depositAddress);
  const accepted = new Map<number, DepositTransferLog>();
  for (const log of receipt.logs as EvmLog[]) {
    const transfer = parseDepositTransferLog(log, toTopic, params.tokenAddress ?? HERMESOS_TOKEN_ADDRESS);
    if (transfer && transfer.transactionHash === transactionHash) accepted.set(transfer.logIndex, transfer);
  }
  const amount = BigInt(params.tokenAmountRaw);
  const matching = [...accepted.values()].filter((log) => log.amount === amount);
  if (matching.length !== 1) {
    return {
      status: "retryable",
      reason: matching.length === 0 ? "no_matching_log" : "ambiguous_log",
      ...(matching.length > 1 ? { matchingLogIndexes: matching.map((log) => log.logIndex).sort((a, b) => a - b) } : {}),
    };
  }
  const firstLogIndex = Math.min(...accepted.keys());
  const { logIndex } = matching[0];
  return { status: "resolved", logIndex, dedupeLogIndex: dedupeLogIndexOf(logIndex, firstLogIndex) };
}

// ── Transfer scan ─────────────────────────────────────────────────────────

interface ScannedTransfer {
  transactionHash: string;
  logIndex: number;
  // The lowest log index of this tx's Transfer logs to the deposit address:
  // the one whose item carries the bare tx/address key, and the log a binding
  // without a log index accounts for unless its amount names another (see
  // boundLogIndex).
  firstLogIndex: number;
  // Every Transfer log of this tx to the deposit address in the scan (this
  // one included), so a binding without a log index can be matched by amount
  // whichever subset of the scan is being partitioned.
  txLogs: ReadonlyArray<{ logIndex: number; amount: bigint }>;
  // The log index for the item's dedupe key: null for the tx's first log to
  // the address, this log's index for any later one.
  dedupeLogIndex: number | null;
  blockNumber: number;
  amount: bigint;
  confirmations: number;
  timestampMs: number;
  observedAt: string;
}

// getLogsInBlockChunks skips a chunk whose result is not an array, and a
// JSON-RPC answer without an error is otherwise taken as-is. For a log scan
// that would read "no transfers" into a range the provider never answered, and
// a fully covered range with no transfers retires the quote to 'cancelled'
// irreversibly, losing a payment in it. Fail the reconcile instead (the batch
// counts it and a later tick rescans), like the USDC sweep's reader does.
// Only handed to getLogsInBlockChunks, whose every call is a log request.
function callRequiringArrayResults(call: BaseChainReader["call"]): BaseChainReader["call"] {
  return async <T>(method: string, args: unknown[]) => {
    const result = await call<T>(method, args);
    if (!Array.isArray(result)) {
      throw new Error(`Invalid ${method} result from Base RPC`);
    }
    return result;
  };
}

// Resumable log-scan coverage, persisted on the quote row under this
// metadata key (no new column): a per-token map of checkpoints, each proof
// that blocks fromBlock..scannedThroughBlock of that token's anchored window
// were fully answered plus the qualifying transfers found in them.
//
// A stale quote's scan bounds are fixed PAST blocks (quotedAt and the grace
// end are both behind the chain), so coverage is cumulative across attempts:
// the once-a-day stale pass has a bounded slice of the tick clock, and a
// quote whose window needs more than one slice used to abort mid-scan every
// day and restart from the first block the next — it could never finish, so
// a payment in its window was never found. With each answered chunk
// checkpointed, the next day's pass resumes at scannedThroughBlock + 1, and
// a fully-covered record makes later passes free. Progress is only proof of
// coverage, never of an outcome: a quote is still decided only on a scan the
// confirmed head covers end to end — the unchanged rule.
const STALE_SCAN_PROGRESS_KEY = "depositScanProgress";
const STALE_SCAN_PROGRESS_VERSION = 1;
// A normal quote carries a handful of qualifying transfers; a cap keeps a
// flood of real transfers to one address from bloating the row. Over the cap
// the checkpoint is skipped — the scan still completes correctly, it just
// does not leave resumable coverage for the next attempt.
const MAX_PERSISTED_SCAN_TRANSFERS = 5_000;

interface PersistedScannedTransfer {
  transactionHash: string;
  logIndex: number;
  blockNumber: number;
  amount: string;
  logTimestampSec: number | null;
}

interface PersistedTokenScan {
  v: number;
  tokenAddress: string;
  fromBlock: number;
  toBlock: number;
  /** Inclusive: every block fromBlock..scannedThroughBlock was answered. */
  scannedThroughBlock: number;
  /** The scan's qualifying (post-dust-filter) transfers in the covered range. */
  transfers: PersistedScannedTransfer[];
}

// A checkpoint handed to a log scan: `saved` is a validated record for this
// exact token (its fromBlock/toBlock match is checked inside the scan, where
// the bounds are computed); `checkpoint` is awaited after each fully
// answered chunk so a mid-scan abort leaves provable coverage behind.
interface ResumableScanProgress {
  saved: PersistedTokenScan | null;
  checkpoint: (scan: PersistedTokenScan) => Promise<void>;
}

// Validate one token's checkpoint out of the persisted per-token map. Anything
// malformed or for another version/token is ignored — a bad record must never
// skip live coverage, so the safe answer to doubt is a full rescan.
function readPersistedTokenScanProgress(
  savedByToken: unknown,
  tokenAddress: string
): PersistedTokenScan | null {
  if (!savedByToken || typeof savedByToken !== "object") return null;
  const raw = (savedByToken as Record<string, unknown>)[tokenAddress.toLowerCase()];
  if (!raw || typeof raw !== "object") return null;
  const scan = raw as Record<string, unknown>;
  const isBlock = (value: unknown): value is number =>
    Number.isSafeInteger(value) && (value as number) >= 0;
  if (
    scan.v !== STALE_SCAN_PROGRESS_VERSION ||
    scan.tokenAddress !== tokenAddress.toLowerCase() ||
    !isBlock(scan.fromBlock) ||
    !isBlock(scan.toBlock) ||
    !isBlock(scan.scannedThroughBlock) ||
    // scannedThroughBlock < fromBlock means nothing was covered yet; treating
    // the record as absent keeps one code path.
    scan.scannedThroughBlock < scan.fromBlock - 1 ||
    scan.scannedThroughBlock > scan.toBlock ||
    !Array.isArray(scan.transfers) ||
    scan.transfers.length > MAX_PERSISTED_SCAN_TRANSFERS
  ) {
    return null;
  }
  const transfers: PersistedScannedTransfer[] = [];
  for (const entry of scan.transfers) {
    const t = entry as Record<string, unknown> | null;
    if (
      !t ||
      typeof t !== "object" ||
      typeof t.transactionHash !== "string" ||
      !isBlock(t.logIndex) ||
      !isBlock(t.blockNumber) ||
      // The covered range is fromBlock..scannedThroughBlock; a persisted
      // transfer outside it was never part of the proven scan. Seeding one
      // would make it a settle / review candidate with confirmations
      // computed off the current head, so a record carrying one is corrupt
      // the same way a malformed entry is — fail closed into a full rescan.
      t.blockNumber < scan.fromBlock ||
      t.blockNumber > scan.scannedThroughBlock ||
      typeof t.amount !== "string" ||
      !/^\d+$/.test(t.amount) ||
      // Records written before inline stamps simply lack the field: absent
      // means "unresolved" (null), never malformed — the coverage is still
      // valid and only the stamp is re-fetched.
      !(t.logTimestampSec === undefined || t.logTimestampSec === null || isBlock(t.logTimestampSec))
    ) {
      return null;
    }
    transfers.push({
      transactionHash: t.transactionHash,
      logIndex: t.logIndex,
      blockNumber: t.blockNumber,
      amount: t.amount,
      logTimestampSec:
        t.logTimestampSec === undefined || t.logTimestampSec === null
          ? null
          : (t.logTimestampSec as number),
    });
  }
  return {
    v: STALE_SCAN_PROGRESS_VERSION,
    tokenAddress: tokenAddress.toLowerCase(),
    fromBlock: scan.fromBlock,
    toBlock: scan.toBlock,
    scannedThroughBlock: scan.scannedThroughBlock,
    transfers,
  };
}

// The persisted transfer set for a coverage record that claims blocks up to
// `throughBlock`: only transfers inside the covered range may be persisted.
// Anything beyond it (a scan that saw a non-final block it could not yet
// checkpoint — see persistProgress in scanQuoteTransfers) stays only in the
// in-memory result, never in a record a later attempt would treat as
// already-covered.
function serializeScannedTransfers(
  parsed: Map<string, DepositTransferLog & { confirmations: number }>,
  throughBlock: number
): PersistedScannedTransfer[] | null {
  const covered = [...parsed.values()].filter((entry) => entry.blockNumber <= throughBlock);
  if (covered.length > MAX_PERSISTED_SCAN_TRANSFERS) return null;
  return covered.map((entry) => ({
    transactionHash: entry.transactionHash,
    logIndex: entry.logIndex,
    blockNumber: entry.blockNumber,
    amount: entry.amount.toString(),
    logTimestampSec: entry.logTimestampSec,
  }));
}

async function scanQuoteTransfers(params: {
  chain: BaseChainReader;
  quote: ManagedVeniceTokenQuote;
  quotedAtMs: number;
  graceEndMs: number;
  minConfirmations: number;
  /** Token whose Transfer logs to read. Default: the quote's own token. */
  tokenAddress?: string;
  /**
   * Dust floor in base units. A tx whose every log is below it is skipped
   * before any timestamp lookup, so a spray of tiny transfers cannot stall
   * the quote. A tx with one real log keeps all its logs.
   */
  minAmount?: bigint;
  /**
   * Resumable coverage for this scan, armed only by the daily stale pass.
   * A checkpoint is usable only for the identical scan (same token and
   * anchored range): its transfers seed the result and the RPC walk resumes
   * at scannedThroughBlock + 1. Every fully answered chunk is checkpointed
   * before the next request, so a cooperative abort mid-scan leaves provable
   * coverage instead of losing the whole attempt. Persisted coverage never
   * decides anything by itself — the settle / review / retire rules below
   * run on the merged result exactly as after a one-shot scan.
   */
  resume?: ResumableScanProgress;
}) {
  const tokenAddress = (params.tokenAddress ?? params.quote.tokenAddress).toLowerCase();
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

  // A checkpoint is trusted only when it covers THIS scan: same token and the
  // same anchored range. The range is anchored to fixed past blocks (quotedAt
  // and the grace end), so a stale quote's bounds agree attempt to attempt;
  // any drift in them — or a malformed/forged-looking record — means a full
  // rescan, never a hole.
  const savedScan =
    params.resume?.saved &&
    params.resume.saved.fromBlock === fromBlock &&
    params.resume.saved.toBlock === toBlock
      ? params.resume.saved
      : null;
  const scanFromBlock = savedScan ? savedScan.scannedThroughBlock + 1 : fromBlock;

  const toTopic = encodeErc20TransferToTopic(params.quote.depositAddress);
  const minAmount = params.minAmount ?? 0n;
  const parsed = new Map<string, DepositTransferLog & { confirmations: number }>();
  const addTransfer = (transfer: DepositTransferLog) => {
    parsed.set(`${transfer.transactionHash}:${transfer.logIndex}`, {
      ...transfer,
      confirmations: Math.max(0, latest - transfer.blockNumber + 1),
    });
  };
  // Seed the checkpointed prefix's transfers — confirmations are recomputed
  // against today's head, so a transfer parked underconfirmed yesterday can
  // still settle on resume.
  for (const entry of savedScan?.transfers ?? []) {
    addTransfer({ ...entry, amount: BigInt(entry.amount) });
  }

  // The last block this attempt has provably covered, seeded from the
  // checkpoint's mark when resuming.
  let coveredThroughBlock = savedScan ? savedScan.scannedThroughBlock : fromBlock - 1;
  // Coverage is only persisted for blocks the finality margin already puts
  // beyond a reorg: a checkpoint that claimed a non-final block could never
  // be refetched, so a transfer mined into the replaced block would stay
  // missed forever — and the quote could retire over it. The covered tail
  // within the margin is re-scanned on the next attempt instead. For a
  // stale quote the whole anchored range is far behind the head, so this
  // only ever binds when a resumable scan runs close behind the head.
  const finalCoveredBlock = latest - FINALITY_MARGIN_BLOCKS;
  const persistableThroughBlock = () => Math.min(coveredThroughBlock, finalCoveredBlock);
  // The coverage mark this attempt resumed from: a write may never go below
  // it (a clamped or regressed head must not erase proven coverage) but MAY
  // equal it — the same record rewritten with resolved timestamps.
  const resumedThroughBlock = scanFromBlock - 1;
  let checkpointCapWarned = false;
  const persistProgress = async () => {
    if (!params.resume) return;
    const throughBlock = persistableThroughBlock();
    if (throughBlock < resumedThroughBlock) return;
    const transfers = serializeScannedTransfers(parsed, throughBlock);
    if (transfers === null) {
      // Over the persisted cap: the scan keeps running correctly but stops
      // checkpointing, so a later attempt never resumes into a partial set.
      if (!checkpointCapWarned) {
        checkpointCapWarned = true;
        log.warn("managed venice quote scan has too many transfers to persist; resumable coverage disabled for this scan", {
          source: "managed-venice-token-reconciliation",
          failureType: "managed_venice_scan_progress_cap",
          quoteId: params.quote.id,
        });
      }
      return;
    }
    try {
      await params.resume.checkpoint({
        v: STALE_SCAN_PROGRESS_VERSION,
        tokenAddress,
        fromBlock,
        toBlock,
        scannedThroughBlock: throughBlock,
        transfers,
      });
    } catch (error) {
      // Best-effort like every queue writer: a failed checkpoint only means
      // the next attempt rescans the uncovered prefix — never a wrong answer.
      log.warn("stale quote scan progress checkpoint failed; the next attempt rescans the uncovered prefix", {
        source: "managed-venice-token-reconciliation",
        failureType: "managed_venice_scan_progress_failed",
        quoteId: params.quote.id,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  };
  // Resolve block times for every still-unstamped qualifying transfer,
  // including ones a previous attempt's checkpoint seeded without their
  // stamps. Called inside the scan so the resolution rides the pass's own
  // deadline instead of a serial post-scan pass that re-ran from an empty
  // cache every attempt — and each resolved stamp is flushed into the
  // coverage record as it lands (in bounded batches plus a final flush in
  // `finally`), so a deadline abort mid-lookup leaves the lookups already
  // paid inside the checkpoint instead of restarting them all tomorrow.
  const stampResolvedBlock = (block: number, stamp: number) => {
    for (const entry of parsed.values()) {
      if (entry.blockNumber === block && entry.logTimestampSec === null) {
        entry.logTimestampSec = stamp;
      }
    }
  };
  // Checkpoint at most once per this many resolved blocks: a 200-block
  // lookup writes the record ~8 times instead of ~200, and the finally
  // flush below captures the last partial batch.
  const TIMESTAMP_FLUSH_EVERY = 25;
  const resolveMissingTransferTimestamps = async () => {
    const missing = new Set<number>(
      [...parsed.values()]
        .filter((entry) => entry.logTimestampSec === null)
        .map((entry) => entry.blockNumber)
    );
    if (missing.size === 0) return false;
    let sinceFlush = 0;
    // The reader blockTimestampsFor resolves through: each returned stamp is
    // applied to `parsed` IMMEDIATELY (an abort between calls can never take
    // resolved stamps with it) and periodically persisted.
    const stampingChain = {
      blockTimestamp: async (block: number) => {
        const stamp = await chain.blockTimestamp(block);
        stampResolvedBlock(block, stamp);
        sinceFlush += 1;
        if (sinceFlush >= TIMESTAMP_FLUSH_EVERY) {
          sinceFlush = 0;
          await persistProgress();
        }
        return stamp;
      },
    };
    try {
      const times = await blockTimestampsFor(
        stampingChain,
        missing,
        { block: latest, timestampSec: latestSec },
        "Managed Venice quote scan"
      );
      // Blocks the fixed-spacing shortcut computed without a read (the
      // >200-lookup path) were never stamped through the wrapped reader.
      for (const [block, stamp] of times) stampResolvedBlock(block, stamp);
      return true;
    } finally {
      // Success or deadline abort alike: whatever resolved is stamped on
      // `parsed` already — flush it so the next attempt reuses it.
      // persistProgress is a no-op for a scan without resumable coverage.
      await persistProgress();
    }
  };

  let dustSkipped = 0;
  // Parse + dust-filter per chunk. A tx's logs all sit in one block and a
  // chunk never splits a block, so the tx-level rule ("a tx with one real
  // log keeps all its logs") applied per chunk is identical to applying it
  // to the whole result — and it keeps dust out of the persisted checkpoint.
  const handleChunk = async (chunkEndBlock: number, chunkLogs: EvmLog[]) => {
    const chunkParsed = new Map<string, DepositTransferLog>();
    for (const logEntry of chunkLogs) {
      const transfer = parseDepositTransferLog(logEntry, toTopic, tokenAddress);
      if (transfer) chunkParsed.set(`${transfer.transactionHash}:${transfer.logIndex}`, transfer);
    }
    if (minAmount > 0n) {
      const realTxs = new Set(
        [...chunkParsed.values()].filter((entry) => entry.amount >= minAmount).map((entry) => entry.transactionHash)
      );
      for (const [key, entry] of chunkParsed) {
        if (realTxs.has(entry.transactionHash)) continue;
        chunkParsed.delete(key);
        dustSkipped += 1;
      }
    }
    for (const transfer of chunkParsed.values()) addTransfer(transfer);
    if (!params.resume) return;
    coveredThroughBlock = chunkEndBlock;
    // Coverage first: the tile's blocks are checkpointed even if the
    // timestamp resolution below dies on the scan's deadline.
    await persistProgress();
    // Stamp the resolved timestamps into the same coverage record, so a
    // resumed attempt finds them inline and never re-pays a serial
    // timestamp pass on an empty cache. The resolver flushes internally
    // (batches plus a finally), so an abort mid-lookup keeps paid stamps.
    await resolveMissingTransferTimestamps();
  };

  // Chunked at the public endpoint's 2,000-block eth_getLogs limit (Base's
  // public RPC answers a wider range with HTTP 413 / JSON-RPC -32614). A
  // fully-covered checkpoint leaves scanFromBlock past toBlock: nothing to
  // fetch, the seeded transfers below are the whole result.
  if (scanFromBlock <= toBlock) {
    await getLogsInBlockChunks<EvmLog>({
      call: callRequiringArrayResults(chain.call),
      filter: { address: tokenAddress, topics: [ERC20_TRANSFER_TOPIC, null, toTopic] },
      fromBlock: scanFromBlock,
      toBlock,
      endpoint: chain.endpoint,
      onChunk: handleChunk,
    });
  }

  if (dustSkipped > 0) {
    log.info("managed venice quote scan skipped dust transfers", {
      source: "managed-venice-token-reconciliation",
      quoteId: params.quote.id,
      dustSkipped,
    });
  }

  // Resolve every still-unstamped qualifying transfer — including ones a
  // fully-covered checkpoint seeded without stamps, where no chunk callback
  // ran at all. A checkpointed transfer with no inline timestamp made every
  // later attempt re-run this serial pass from an empty cache and lose all
  // of it to a deadline abort; the resolver flushes stamps into the
  // coverage record as they land (and once more in finally), so the next
  // pass resumes instead of restarting.
  await resolveMissingTransferTimestamps();
  // A tx's logs share one block, so they are always scanned (and in range,
  // and confirmed) together.
  const logsByTx = new Map<string, Array<{ logIndex: number; amount: bigint }>>();
  for (const entry of parsed.values()) {
    logsByTx.set(entry.transactionHash, [
      ...(logsByTx.get(entry.transactionHash) ?? []),
      { logIndex: entry.logIndex, amount: entry.amount },
    ]);
  }
  const transfers: ScannedTransfer[] = [];
  for (const { logTimestampSec, ...transfer } of parsed.values()) {
    // Every entry is stamped by now — resolveMissingTransferTimestamps
    // either resolved it or threw (abort) before this line ran.
    const timestampSec = logTimestampSec!;
    const txLogs = logsByTx.get(transfer.transactionHash) ?? [{ logIndex: transfer.logIndex, amount: transfer.amount }];
    const firstLogIndex = Math.min(...txLogs.map((log) => log.logIndex));
    transfers.push({
      ...transfer,
      firstLogIndex,
      txLogs,
      dedupeLogIndex: dedupeLogIndexOf(transfer.logIndex, firstLogIndex),
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
//
// Consequence (documented limitation, see LATE_PAYMENT_GRACE_MS): a transfer
// mined at or after that next session starts (a later managed-Venice quote or
// a yearly_token_quotes row, consumed or not) is never attributed to the
// earlier quote, even inside its window or grace. If the later session does
// not account for it either (the yearly flow detects payment by wallet
// balance and records no tx), it is neither credited nor surfaced here. The
// yearly follow-up owns that attribution.

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

// What already accounts for a scanned transfer on this quote's deposit
// address (loadManagedVeniceTransferBindings: quote claims and review
// triggers on the address, this user's lots and yearly payments). A binding on
// ANOTHER address never excludes a transfer here: that is a different Transfer
// log of the same tx (a bundle paying several wallets), which this quote must
// still credit or surface (settle sends it to review as a claim conflict when
// the tx is claimed elsewhere). Per log, within the address:
//   - bound: a counted binding accounts for this log (see boundLogIndex).
//     Excluded.
//   - extra_log: the tx is bound here, but on another of its logs (a batched
//     double-send). Real money no quote can credit (the claim is unique per
//     tx), so it is only ever surfaced.
//   - unbound: attributable.
// The quote's own claim and lot count (its credited transfer is never
// re-surfaced); its own review trigger does not (see
// isManagedVeniceTransferBindingCounted). Another quote's review trigger
// counts, so a transfer that reviewed one quote is never credited by another:
// whichever binds it first wins, and a transfer is credited XOR surfaced.
type BindingState = "unbound" | "bound" | "extra_log";

// The log of `transfer`'s tx (to this deposit address) that a binding
// accounts for:
//   - its own log index, when it recorded one. Every settlement and review
//     records one: the reconciler's from its scan, the bearer route's from the
//     tx receipt (resolveManagedVeniceTokenTransferLog);
//   - otherwise (a record written without one: a legacy lot or settlement, or
//     a claim-unrecoverable review, which records no amount) the one scanned
//     log of the tx whose amount equals the amount the binding recorded. A
//     claim with no readable amount (a legacy settled quote) takes its own
//     quote's lot for the same tx, which is the credit that exists. Without a
//     unique amount match (no amount, or zero or several logs with it) it
//     falls back to the tx's first log.
function boundLogIndex(
  binding: ManagedVeniceTransferBinding,
  siblings: ManagedVeniceTransferBinding[],
  transfer: ScannedTransfer
) {
  const source =
    binding.kind === "quote_claim" && binding.logIndex === null && binding.tokenAmountRaw === null
      ? siblings.find((other) => other.kind === "lot" && other.quoteId === binding.quoteId) ?? binding
      : binding;
  if (source.logIndex !== null) return source.logIndex;
  if (source.tokenAmountRaw !== null) {
    const amount = BigInt(source.tokenAmountRaw);
    const matching = transfer.txLogs.filter((log) => log.amount === amount);
    if (matching.length === 1) return matching[0].logIndex;
  }
  return transfer.firstLogIndex;
}

function bindingStateOf(
  transfer: ScannedTransfer,
  bindings: Map<string, ManagedVeniceTransferBinding[]>,
  quoteId: string
): BindingState {
  const all = bindings.get(transfer.transactionHash) ?? [];
  const counted = all.filter((binding) => isManagedVeniceTransferBindingCounted(binding, quoteId));
  if (counted.length === 0) return "unbound";
  return counted.some((binding) => boundLogIndex(binding, all, transfer) === transfer.logIndex)
    ? "bound"
    : "extra_log";
}

async function partitionByBindings(db: SupabaseLike, quote: ManagedVeniceTokenQuote, transfers: ScannedTransfer[]) {
  const bindings = await loadManagedVeniceTransferBindings(
    { quote, transactionHashes: Array.from(new Set(transfers.map((transfer) => transfer.transactionHash))) },
    db
  );
  const states = transfers.map((transfer) => ({ transfer, state: bindingStateOf(transfer, bindings, quote.id) }));
  const pick = (state: BindingState) => states.filter((entry) => entry.state === state).map((entry) => entry.transfer);
  return {
    unbound: pick("unbound"),
    extraLogs: pick("extra_log"),
    // Everything not accounted for elsewhere, in chain order.
    surfaceable: states.filter((entry) => entry.state !== "bound").map((entry) => entry.transfer),
  };
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

// The transfers attributable to a quote: its own anchored range, cut at the
// user's next $HermesOS payment session, minus every transfer already bound on
// the quote's deposit address. Shared by the open-quote reconcile and the
// surface-only pass so both see exactly the same set.
async function scanAttributableTransfers(params: {
  db: SupabaseLike;
  chain: BaseChainReader;
  quote: ManagedVeniceTokenQuote;
  minConfirmations: number;
  now?: Date;
  /**
   * The daily stale pass's resumable-coverage store: the persisted per-token
   * checkpoint map plus a writer that stamps one token's coverage. See
   * STALE_SCAN_PROGRESS_KEY — every other caller scans an unbounded,
   * non-abortable range and passes nothing.
   */
  scanProgress?: {
    saved: unknown;
    checkpoint: (scan: PersistedTokenScan) => Promise<void>;
  };
  /**
   * The stale pass's phase deadline, checked between the non-RPC units the
   * RPC abort cannot reach (each extra token's surface items). Everything
   * the decision needs is computed before the guarded units, so stopping
   * them only owes dedupe-keyed items to a later attempt.
   */
  shouldStop?: () => boolean;
}) {
  const { db, quote } = params;
  const window = managedVeniceTokenQuoteWindow(quote);
  const quotedAtMs = window.quotedAt.getTime();
  const expiresAtMs = window.effectiveExpiresAt.getTime();
  const graceEndMs = expiresAtMs + LATE_PAYMENT_GRACE_MS;

  const resumeFor = (tokenAddress: string): ResumableScanProgress | undefined =>
    params.scanProgress
      ? {
          saved: readPersistedTokenScanProgress(params.scanProgress.saved, tokenAddress),
          checkpoint: params.scanProgress.checkpoint,
        }
      : undefined;

  const scan = await scanQuoteTransfers({
    chain: params.chain,
    quote,
    quotedAtMs,
    graceEndMs,
    minConfirmations: params.minConfirmations,
    minAmount: paymentDustFloor(BigInt(quote.tokenAmountRaw)),
    resume: resumeFor(quote.tokenAddress),
  });
  const boundaryMs = await loadAttributionBoundaryMs(db, quote);
  const inRange = scan.transfers.filter(
    (transfer) =>
      transfer.timestampMs >= quotedAtMs &&
      transfer.timestampMs <= graceEndMs &&
      (boundaryMs === null || transfer.timestampMs < boundaryMs)
  );
  const { unbound, extraLogs } = await partitionByBindings(db, quote, inRange);

  // Any OTHER live platform token sent into this range is the wrong token:
  // surfaced for operator recovery, never credited. With $HIVRA dormant there
  // is no other token and nothing extra is scanned.
  const inAttributionRange = (transfer: ScannedTransfer) =>
    transfer.timestampMs >= quotedAtMs &&
    transfer.timestampMs <= graceEndMs &&
    (boundaryMs === null || transfer.timestampMs < boundaryMs);
  for (const other of livePlatformTokens(params.now ?? new Date()).filter((token) => token.address !== quote.tokenAddress)) {
    // Past the phase deadline, another token's scan and its surface items
    // are owed to the next attempt — the decision data above is already
    // computed, so stopping here still returns it.
    if (params.shouldStop?.()) break;
    const otherScan = await scanQuoteTransfers({
      chain: params.chain,
      quote,
      quotedAtMs,
      graceEndMs,
      minConfirmations: params.minConfirmations,
      tokenAddress: other.address,
      minAmount: tokenDustFloor(other.decimals),
      resume: resumeFor(other.address),
    });
    const confirmedOther = otherScan.transfers.filter(
      (transfer) => inAttributionRange(transfer) && transfer.confirmations >= params.minConfirmations
    );
    if (confirmedOther.length === 0) continue;
    const { surfaceable } = await partitionByBindings(db, quote, confirmedOther);
    for (const transfer of surfaceable) {
      if (params.shouldStop?.()) break;
      await surfaceManagedVeniceTokenTransfer(
        {
          quote,
          transactionHash: transfer.transactionHash,
          logIndex: transfer.logIndex,
          // Keyed by its own log index, never the bare tx/address key the
          // quote token's first log of the same tx would use.
          dedupeLogIndex: transfer.logIndex,
          tokenAmountRaw: transfer.amount.toString(),
          observedAt: transfer.observedAt,
          reason: MANAGED_VENICE_TOKEN_DEPOSIT_REASONS.wrongToken,
          tokenAddress: other.address,
        },
        db
      );
    }
  }

  const quoted = BigInt(quote.tokenAmountRaw);
  const band = {
    quoted,
    ceiling: (quoted * MANAGED_VENICE_MAX_OVERSEND_NUMERATOR) / MANAGED_VENICE_MAX_OVERSEND_DENOMINATOR,
    expiresAtMs,
  };
  return {
    attributable: unbound,
    // Later logs of a tx already bound on this address: surfaced, never
    // credited, never a settle / review candidate.
    extraLogs,
    confirmedHeadMs: scan.confirmedHeadMs,
    expiresAtMs,
    graceEndMs,
    // Where attribution to this quote stops: the grace end, or the user's next
    // payment session if that starts first.
    attributionEndMs: boundaryMs === null ? graceEndMs : Math.min(graceEndMs, boundaryMs),
    classOf: (transfer: ScannedTransfer) => classifyTransfer(transfer, band),
    isConfirmed: (transfer: ScannedTransfer) => transfer.confirmations >= params.minConfirmations,
  };
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

function quoteCandidates(data: unknown) {
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

// Open quotes paged per lot-recovery sweep; PostgREST .in() lists stay small
// enough to keep the URL and plan sane.
const OPEN_QUOTE_ID_PAGE_SIZE = 1000;
const LOT_HELD_ID_CHUNK = 200;
// How many open quotes the lot probe may inspect per tick. The probe reads a
// bounded slice — see loadOpenLotHoldingQuoteCandidates — so a large open
// table can no longer spend the whole open-scan budget paging itself before
// any fresh work runs.
const LOT_DISCOVERY_QUOTE_BUDGET = 2 * OPEN_QUOTE_ID_PAGE_SIZE;

/**
 * Open quotes that hold a token deposit lot (a settlement that crashed after
 * its lot insert but before the quote flip). managed_venice_token_lots has no
 * FK to quotes, so PostgREST cannot join — instead of fetching every lot's
 * quote_id (unbounded history: every settled deposit keeps a lot forever) and
 * probing each for an open quote, this probes the OPEN side, which is exactly
 * the set recovery cares about, and matches lots to it with bounded .in()
 * lookups. The page source being open quotes means the limit applies AFTER
 * filtering to open: an old open quote behind thousands of settled lots is
 * still reached, and a growing lots table never raises the cost of the check.
 *
 * The probe is bounded to `probeBudget` rows per tick, longest-expired first:
 * that end is where the long-stuck quotes this lane exists for sit, while
 * the fresher end (expires_at inside the last week) is already covered by the
 * fresh lane every tick. Rows deeper than the slice are no longer paged in
 * the same tick the way the old walk did — the daily stale pass guarantees
 * their coverage instead: it scans every unclaimed open quote (bounded per
 * day, rotating by updated_at) and runs this same lot recovery inside its
 * reconcile, so an old lot-holding quote is always recovered, just never at
 * the cost of walking the whole open table ahead of fresh work. expires_at is
 * used for the order because it never changes after quote creation — unlike
 * updated_at, which every write (and the daily pass's own cursor touches)
 * reshuffles.
 */
async function loadOpenLotHoldingQuoteCandidates(params: {
  db: SupabaseLike;
  openQuotes: () => DbQuery;
  limit: number;
  probeBudget?: number;
}) {
  const probeBudget = Number.isFinite(params.probeBudget)
    ? Math.max(1, Math.floor(params.probeBudget as number))
    : LOT_DISCOVERY_QUOTE_BUDGET;
  const candidates: Array<{ id: string; userId: string }> = [];
  let probed = 0;
  for (
    let from = 0;
    probed < probeBudget && candidates.length < params.limit;
    from += OPEN_QUOTE_ID_PAGE_SIZE
  ) {
    const pageSize = Math.min(OPEN_QUOTE_ID_PAGE_SIZE, probeBudget - probed);
    const { data, error } = await params
      .openQuotes()
      .order("expires_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) {
      throw new Error(error.message || "Failed to load open managed Venice token quotes for lot recovery");
    }
    const page = quoteCandidates(data);
    probed += page.length;
    for (
      let offset = 0;
      offset < page.length && candidates.length < params.limit;
      offset += LOT_HELD_ID_CHUNK
    ) {
      const chunk = page.slice(offset, offset + LOT_HELD_ID_CHUNK);
      const { data: lots, error: lotError } = await (params.db.from("managed_venice_token_lots") as DbQuery)
        .select("quote_id")
        .in("source", [...TOKEN_DEPOSIT_LOT_SOURCES])
        .in(
          "quote_id",
          chunk.map((candidate) => candidate.id)
        );
      if (lotError) {
        throw new Error(lotError.message || "Failed to check managed Venice token deposit lots");
      }
      const holding = new Set(
        (Array.isArray(lots) ? lots : [])
          .map((row) => (row as { quote_id?: unknown }).quote_id)
          .filter((id): id is string => typeof id === "string")
      );
      for (const candidate of chunk) {
        if (candidates.length >= params.limit) break;
        if (holding.has(candidate.id)) candidates.push(candidate);
      }
    }
    if (page.length < pageSize) break;
  }
  return candidates;
}

async function loadPendingManagedVeniceTokenQuoteCandidates(params: {
  db: SupabaseLike;
  limit: number;
  // Quotes whose stored expiry is at or before this are left to the daily
  // stale pass instead of a scan every tick (see runDailyStaleUnpaidQuoteScan)
  // — but only while they are unclaimed and lot-free (see below).
  expiresAfterIso: string;
  // Bound on how many open quotes the lot probe inspects this tick
  // (see loadOpenLotHoldingQuoteCandidates).
  lotProbeBudget?: number;
}) {
  const openQuotes = () =>
    (params.db.from("managed_venice_token_quotes") as DbQuery)
      .select("id, user_id, status")
      .in("status", ["active", "expired"]);

  // The expiry bound must not drop a quote that already claimed a transfer or
  // holds a deposit lot: both mean settlement started and crashed part-way,
  // and the per-quote recovery branch is the only automatic path that finishes
  // it — at any age. Claimed quotes are matched on transaction_hash; lot
  // holders on their lot rows (no FK, so open quote ids are matched to lots
  // below instead).
  //
  // Claimed rows rotate on the same updated_at cursor the daily stale pass
  // uses: every recovery attempt bumps the row to the back of the claimed
  // queue (see the batch loop), so a set of permanently-failing claims cannot
  // pin every batch the way created_at order let it — an un-attempted claim
  // is always a least-recently-touched row and gets in, while attempted ones
  // stay eligible behind it rather than being dropped.
  const claimed = await openQuotes()
    .not("transaction_hash", "is", null)
    .order("updated_at", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(params.limit);

  if (claimed.error) {
    throw new Error(claimed.error.message || "Failed to load claimed managed Venice token quotes");
  }

  // The lot check pages the OPEN quotes and matches lots to them (no FK to
  // join on): the open set is bounded by what the stale pass drains, while
  // historical lots grow forever — a backlog of settled lots must not starve
  // a still-open lot-holding quote out of recovery.
  //
  // The probe is auxiliary like the stale pass's candidate SELECT: a failure
  // here must not reject the batch — the claimed lane above and the fresh
  // lane below (and the surface-only pass after discovery) still run, and
  // the reconcile's own per-quote lot check keeps recovering any holder
  // those lanes reach. But the miss must not be silent either: the tick
  // finds no lot-held candidates at all, so the outcome flags the probe for
  // the route's incident report and heartbeat (the staleScanLoadFailed
  // pattern), and the probe retries on the next tick.
  let lotHeldCandidates: Array<{ id: string; userId: string }> = [];
  let lotProbeLoadFailed = false;
  try {
    lotHeldCandidates = await loadOpenLotHoldingQuoteCandidates({
      db: params.db,
      openQuotes,
      limit: params.limit,
      probeBudget: params.lotProbeBudget,
    });
  } catch (error) {
    lotProbeLoadFailed = true;
    log.warn("open-lane lot probe failed; claimed and fresh lanes still ran", {
      source: "managed-venice-token-reconciliation",
      failureType: "managed_venice_lot_probe_failed",
      errorName: error instanceof Error ? error.name : typeof error,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
  const lotHeldIds = new Set(lotHeldCandidates.map((candidate) => candidate.id));

  // Newest first: a fresh payment is always inside the batch, whatever older
  // quotes are still open. Older quotes leave the set by settling, going to
  // review, retiring once their window + grace has been fully scanned, or
  // expiring once they are NO_DEPOSIT_AFTER_EXPIRY_GRACE_MS past it. The
  // expires_at bound approximates the effective expiry (quoted_at + lifetime
  // for legacy short-lived rows) within the quote lifetime — close enough
  // that a quote can only be skipped for scan a few minutes early at worst,
  // and the stale pass re-checks the exact window before expiring.
  //
  // The lane fills only with rows that will actually be LOG-SCANNED, so its
  // guaranteed share of the open budget is never spent idle:
  //   - transaction_hash IS NULL drops claimed quotes in SQL. They are the
  //     claimed lane's recovery work already, and a failing-claim storm can
  //     occupy the newest in-grace rows indefinitely — without the filter the
  //     "fresh" page yields zero fresh work while unclaimed quotes just
  //     behind it are never read.
  //   - Rows the lot probe proved lot-held are filtered in memory (lots have
  //     no FK to filter in SQL): they ride the recovery lane, so the read
  //     pages on to backfill the slots they took. At most `lotHeldIds.size`
  //     window rows can drop out this way, so `limit + lotHeldIds.size` rows
  //     read always yields a full lane when the window holds that many
  //     unclaimed rows — a bounded re-read, not a table walk. A holder BEYOND
  //     the probe's bounded slice is not known to the filter and keeps its
  //     fresh slot; the reconcile recovers its lot without a scan, as before.
  const freshCandidates: Array<{ id: string; userId: string }> = [];
  const freshRowBudget = params.limit + lotHeldIds.size;
  let freshRowsRead = 0;
  let freshFrom = 0;
  while (freshRowsRead < freshRowBudget && freshCandidates.length < params.limit) {
    const pageSize = Math.min(params.limit, freshRowBudget - freshRowsRead);
    const { data, error } = await openQuotes()
      .gt("expires_at", params.expiresAfterIso)
      .is("transaction_hash", null)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(freshFrom, freshFrom + pageSize - 1);
    if (error) {
      throw new Error(error.message || "Failed to load pending managed Venice token quotes");
    }
    const rows = Array.isArray(data) ? data : [];
    freshRowsRead += rows.length;
    freshFrom += rows.length;
    for (const candidate of quoteCandidates(rows)) {
      if (freshCandidates.length >= params.limit) break;
      if (!lotHeldIds.has(candidate.id)) freshCandidates.push(candidate);
    }
    if (rows.length < pageSize) break;
  }

  const claimedCandidates = quoteCandidates(claimed.data);
  const byId = new Map<string, { id: string; userId: string }>();
  // Recovery lanes first: a claimed quote (a settlement that claimed a tx and
  // crashed before finishing) and a lot-holding one (the lot insert landed,
  // the quote flip did not) are each finished WITHOUT a log scan, while a
  // fresh quote's scan is the expensive work the open-scan budget exists to
  // bound. Fresh-first ordering let a sustained fresh backlog spend the whole
  // budget before either recovery lane was reached, leaving half-finished
  // settlements open indefinitely while the provider kept answering. Recovery
  // candidates are cheap and bounded by `limit`, so they always run ahead of
  // fresh scans; the fresh lane keeps its newest-first order within itself,
  // and the claimed lane's updated_at cursor still rotates it behind any
  // claims never attempted (see the batch loop).
  for (const candidate of [
    ...claimedCandidates,
    ...lotHeldCandidates,
    ...freshCandidates,
  ]) {
    byId.set(candidate.id, candidate);
  }
  // The batch loop needs the recovery lanes back out: claimed quotes ordered
  // by updated_at only rotate if their attempts touch that cursor, and both
  // recovery lanes share a bounded slice of the open-scan budget, so the loop
  // must know which candidates came through them.
  return {
    candidates: [...byId.values()],
    claimedIds: new Set(claimedCandidates.map((candidate) => candidate.id)),
    lotHeldIds,
    lotProbeLoadFailed,
  };
}

// Settled / in-review quotes whose flip set transfer_surfacing_pending and
// whose range is not yet fully confirmed. Legacy terminal quotes (flag false)
// are never selected, so they are never rescanned.
async function loadTransferSurfacingCandidates(params: { db: SupabaseLike; limit: number }) {
  const { data, error } = await (params.db.from("managed_venice_token_quotes") as DbQuery)
    .select("id, user_id, status")
    .in("status", [...MANAGED_VENICE_TRANSFER_SURFACING_STATUSES])
    .eq("transfer_surfacing_pending", true)
    .order("created_at", { ascending: false })
    .limit(params.limit);

  if (error) {
    throw new Error(error.message || "Failed to load managed Venice token quotes awaiting transfer surfacing");
  }
  return quoteCandidates(data);
}

function isOpenQuoteStatus(status: ManagedVeniceTokenQuote["status"]) {
  return status === "active" || status === "expired";
}

interface StaleQuoteCandidateRow {
  id?: unknown;
  user_id?: unknown;
  quoted_at?: unknown;
  expires_at?: unknown;
  metadata?: unknown;
}

// Metadata key stamped on a no_deposit_after_grace row after the daily pass
// gave it its one catch-up window scan. The historical expire-without-scan
// pass marked rows closedReason=no_deposit_after_grace without ever reading
// their deposit window, so each such row owes exactly one real scan: while
// the key is absent the row stays eligible below; once it is present the row
// is out for good (it remains 'expired' and settleable on demand — the
// user's check still scans live).
const GRACE_WINDOW_SCANNED_KEY = "graceWindowScannedAt";

// Open unclaimed quotes whose stored expiry is at or before `expiresBeforeIso`,
// least-recently-touched first so a backlog drains across days: every row the
// daily pass scans has its updated_at cursor advanced (see
// runDailyStaleUnpaidQuoteScan), so a quote whose scan keeps failing moves to
// the back of the queue instead of occupying every day's batch — it stays
// eligible, never lost. Selection only — the daily pass decides scan vs
// expire per row.
async function loadStaleUnpaidQuoteRows(params: {
  db: SupabaseLike;
  expiresBeforeIso: string;
  limit: number;
}) {
  const { data, error } = await (params.db.from("managed_venice_token_quotes") as DbQuery)
    .select("id, user_id, quoted_at, expires_at, metadata")
    .in("status", ["active", "expired"])
    .is("transaction_hash", null)
    .lte("expires_at", params.expiresBeforeIso)
    // Rows this pass already expired (metadata.closedReason =
    // no_deposit_after_grace) that ALSO had their one catch-up scan
    // (metadata.graceWindowScannedAt) must not consume the batch limit again —
    // with a backlog above `limit` they would be re-selected every day and
    // starve the rest. A no_deposit_after_grace row WITHOUT the scan marker
    // is still eligible: it was expired sight-unseen and gets exactly one
    // real window scan before becoming unrecoverable here. `is.null` keeps
    // quotes with missing metadata eligible: a plain `not.eq` would compare
    // NULL and drop them in Postgres.
    .or(
      "metadata->>closedReason.is.null," +
        "metadata->>closedReason.neq.no_deposit_after_grace," +
        `metadata->>${GRACE_WINDOW_SCANNED_KEY}.is.null`
    )
    .order("updated_at", { ascending: true })
    .order("expires_at", { ascending: true })
    .limit(params.limit);

  if (error) {
    throw new Error(error.message || "Failed to load stale managed Venice token quotes");
  }
  return (Array.isArray(data) ? data : []) as StaleQuoteCandidateRow[];
}

// Advance open quotes' queue cursors after they were tried (whatever the
// outcome), so the next selection — the daily stale pass over updated_at, or
// the claimed lane that orders the same way — takes the rows that have
// waited longest. It is the fairness mechanism that keeps repeatedly-failing
// rows from pinning a batch's head. updated_at is the state surface: the
// row's own update trigger would bump it on any write anyway, and the
// open-status guard no-ops once the quote has left the open set. Only the
// cursor moves — no completion marker and no status change — so a row that
// was never decided stays fully eligible. Best-effort: a failed touch only
// means the rows keep their places at the front for the next pass.
//
// The batch form covers the id set in one UPDATE per chunk: the stale pass's
// marked-probe advance can carry ~200 ids, and one awaited round-trip per id
// there costs more wall-clock than the pass's whole scan slice. The .in()
// list shares the bounded size the lots probe already puts on the wire.
async function touchQuoteQueueCursors(db: SupabaseLike, quoteIds: string[], nowIso: string) {
  for (let offset = 0; offset < quoteIds.length; offset += LOT_HELD_ID_CHUNK) {
    const chunk = quoteIds.slice(offset, offset + LOT_HELD_ID_CHUNK);
    const { error } = await (db.from("managed_venice_token_quotes") as DbTable)
      .update({ updated_at: nowIso })
      .in("id", chunk)
      .in("status", ["active", "expired"]);
    if (error) {
      log.warn("quote queue cursor update failed; the rows keep their places for the next pass", {
        source: "managed-venice-token-reconciliation",
        failureType: "managed_venice_scan_cursor_failed",
        quoteIds: chunk,
        errorMessage: error.message ?? "unknown",
      });
    }
  }
}

async function touchQuoteQueueCursor(db: SupabaseLike, quoteId: string, nowIso: string) {
  await touchQuoteQueueCursors(db, [quoteId], nowIso);
}

// How many marked rows the stale pass lot-checks per day. Rows carrying both
// closedReason=no_deposit_after_grace and GRACE_WINDOW_SCANNED_KEY are
// excluded from the scan selection for good — but the marker only proves the
// deposit WINDOW scanned clean, never that nothing is owed: a deposit lot can
// still sit on the row (one landed while its catch-up scan ran, before the
// marker learned the lot check; or a legacy lot-only row was expired
// sight-unseen and marked under an older guard). Such a row is out of the
// scan selection AND can sit beyond the open lane's bounded lot probe, so
// without this probe it would owe settlement recovery forever. The probe is
// bounded and scan-free — recovering a lot needs no RPC — and rotates on the
// same updated_at cursor so a marked backlog larger than the slice is still
// covered across days.
const STALE_MARKED_LOT_PROBE_LIMIT = 200;
// The marked lot-holder lane runs ahead of the day's scans on the same
// clock, but it is settlement recovery, not scanning — a persistently slow
// or failing marked set (each attempt is only checked against the budget
// between quotes, so two ~30 s attempts land before the first check fails)
// could otherwise spend the whole slice before one stale quote scanned,
// and the UTC-day claim blocks a same-day retry. The lane is bounded to
// this share of the slice — the same shape RECOVERY_OPEN_BUDGET_SHARE
// gives the open lane's recovery work — so the scans keep the rest
// guaranteed.
const MARKED_LOT_STALE_BUDGET_SHARE = 0.5;

async function loadMarkedLotHoldingQuoteRows(params: {
  db: SupabaseLike;
  limit: number;
}) {
  const { data, error } = await (params.db.from("managed_venice_token_quotes") as DbQuery)
    .select("id, user_id, metadata")
    .in("status", ["active", "expired"])
    .is("transaction_hash", null)
    .eq("metadata->>closedReason", "no_deposit_after_grace")
    .not(`metadata->>${GRACE_WINDOW_SCANNED_KEY}`, "is", null)
    // Same rotation cursor the scan selection uses, so probed rows move to
    // the back (see runDailyStaleUnpaidQuoteScan) and the whole marked set
    // is covered across days.
    .order("updated_at", { ascending: true })
    .order("expires_at", { ascending: true })
    .limit(params.limit);
  if (error) {
    throw new Error(error.message || "Failed to load marked managed Venice token quotes");
  }
  const rows = (Array.isArray(data) ? data : []) as StaleQuoteCandidateRow[];
  const probedIds = rows
    .map((row) => row.id)
    .filter((id): id is string => typeof id === "string");
  const holders: Array<{ id: string; userId: string; metadata: unknown }> = [];
  for (let offset = 0; offset < rows.length; offset += LOT_HELD_ID_CHUNK) {
    const chunk = rows
      .slice(offset, offset + LOT_HELD_ID_CHUNK)
      .filter(
        (row): row is StaleQuoteCandidateRow & { id: string; user_id: string } =>
          typeof row.id === "string" && typeof row.user_id === "string"
      );
    if (chunk.length === 0) continue;
    const { data: lots, error: lotError } = await (params.db.from("managed_venice_token_lots") as DbQuery)
      .select("quote_id")
      .in("source", [...TOKEN_DEPOSIT_LOT_SOURCES])
      .in(
        "quote_id",
        chunk.map((row) => row.id)
      );
    if (lotError) {
      throw new Error(lotError.message || "Failed to check managed Venice token deposit lots");
    }
    const holding = new Set(
      (Array.isArray(lots) ? lots : [])
        .map((row) => (row as { quote_id?: unknown }).quote_id)
        .filter((id): id is string => typeof id === "string")
    );
    for (const row of chunk) {
      if (holding.has(row.id)) holders.push({ id: row.id, userId: row.user_id, metadata: row.metadata });
    }
  }
  return { holders, probedIds };
}

// A quote row's resumable scan-coverage store for the stale pass: `saved` is
// the persisted per-token checkpoint map (from the selection's own read) and
// `checkpoint` stamps one token's coverage back into it, bumping the
// updated_at rotation cursor with each write.
//
// The merge target is the metadata the selection just read, exactly like
// markStaleQuoteGraceScanned. The guards make that safe for THIS write's own
// race too: the only open-quote metadata writer that does not flip status is
// a settlement claim, and it sets transaction_hash — which this write
// refuses to touch (.is null), so the claim CAS can never be clobbered by a
// checkpoint, and a checkpoint landing after a claim simply no-ops (progress
// is lost, which costs a rescan — never a wrong answer). The claim CAS's own
// merge can likewise drop a just-written checkpoint; again a rescan, not a
// wrong answer.
function staleQuoteScanProgress(
  db: SupabaseLike,
  candidate: { id: string; metadata: unknown },
  nowIso: string
): { saved: unknown; checkpoint: (scan: PersistedTokenScan) => Promise<void> } {
  const base =
    candidate.metadata && typeof candidate.metadata === "object"
      ? (candidate.metadata as Record<string, unknown>)
      : {};
  const existing =
    base[STALE_SCAN_PROGRESS_KEY] && typeof base[STALE_SCAN_PROGRESS_KEY] === "object"
      ? (base[STALE_SCAN_PROGRESS_KEY] as Record<string, unknown>)
      : {};
  // Live copy of the per-token map: the quote token and each wrong-token scan
  // checkpoint into the same record within one attempt.
  const progressByToken: Record<string, unknown> = { ...existing };
  return {
    saved: progressByToken,
    checkpoint: async (scan) => {
      progressByToken[scan.tokenAddress] = scan;
      const { error } = await (db.from("managed_venice_token_quotes") as DbTable)
        .update({
          updated_at: nowIso,
          metadata: { ...base, [STALE_SCAN_PROGRESS_KEY]: progressByToken },
        })
        .eq("id", candidate.id)
        .is("transaction_hash", null)
        .in("status", ["active", "expired"]);
      if (error) {
        throw new Error(error.message || "Failed to persist stale scan progress");
      }
    },
  };
}

// Record that a no_deposit_after_grace row got its one catch-up window scan:
// stamp GRACE_WINDOW_SCANNED_KEY into metadata (and bump the rotation
// cursor). Guarded on the row still being open, still carrying the
// no_deposit_after_grace reason, AND still unclaimed — a scan that settled,
// reviewed or retired the quote changed its status, so the write is a no-op
// there by design. The transaction_hash guard is the same one the scan
// checkpoint writes carry: a settlement claim landing between selection and
// this write sets transaction_hash plus the claim in metadata, and a marker
// that rewrote the selection-read metadata would erase the claim while
// leaving the hash — recovery would send a paid quote to manual review
// instead of crediting it. With the guard the write simply no-ops and the
// claim's own recovery path runs. `metadata` is the row the selection just
// read; a rare concurrent metadata writer between selection and mark could
// drop a key it added, but every writer that matters also changes the
// fields the guards check. Best-effort: a failed mark leaves the row
// eligible for one more scan tomorrow, which is the safe side.
async function markStaleQuoteGraceScanned(
  db: SupabaseLike,
  quoteId: string,
  metadata: unknown,
  nowIso: string
) {
  // A deposit lot means a settlement is mid-flight — retireManagedVeniceTokenQuote
  // refuses to cancel over one, and the marker must not discharge the row
  // either: marked rows leave the stale selection for good, so stamping it
  // over a lot would park a crash-stopped settlement where only the bounded
  // lot probes — the open lane's, and this pass's marked lane — might still
  // find it. Skip the mark instead — the row
  // keeps its place and a later pass's recovery branch finishes the lot.
  // (The marker guards on transaction_hash alone because a claim occupies
  // that column; a lot does not — it is a crash window between lot insert
  // and quote flip, or a legacy lot-only row.)
  let lotHeld: boolean;
  try {
    lotHeld = Boolean(await loadManagedVeniceTokenDepositLot(quoteId, db));
  } catch (error) {
    // Cannot prove the row is lot-free: same safe side as a failed mark —
    // stay eligible for a later pass rather than risk a permanent exclusion.
    log.warn("grace-scan marker could not check the row's deposit lot; leaving it eligible", {
      source: "managed-venice-token-reconciliation",
      failureType: "managed_venice_grace_scan_marker_lot_check_failed",
      quoteId,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  if (lotHeld) {
    log.warn("grace-scan marker skipped: the quote holds a deposit lot; settlement recovery owns it now", {
      source: "managed-venice-token-reconciliation",
      failureType: "managed_venice_grace_scan_marker_lot_held",
      quoteId,
    });
    return;
  }
  const merged =
    metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>) : {};
  const { error } = await (db.from("managed_venice_token_quotes") as DbTable)
    .update({
      updated_at: nowIso,
      metadata: { ...merged, [GRACE_WINDOW_SCANNED_KEY]: nowIso },
    })
    .eq("id", quoteId)
    .eq("metadata->>closedReason", "no_deposit_after_grace")
    .is("transaction_hash", null)
    .in("status", ["active", "expired"]);
  if (error) {
    log.warn("stale grace-scan marker write failed; the row is re-selected once more tomorrow", {
      source: "managed-venice-token-reconciliation",
      failureType: "managed_venice_grace_scan_marker_failed",
      quoteId,
      errorMessage: error.message ?? "unknown",
    });
  }
}

/**
 * The once-a-day stale pass (first tick of a new UTC day only): every stale
 * unclaimed quote gets a real log scan of its deposit window through the
 * normal per-quote reconcile — a clean fully-scanned window retires the
 * quote itself, a found deposit settles or reviews it, and anything
 * inconclusive stays open for the next day. Expiring sight-unseen is
 * exactly what this pass exists to prevent, so there is no separate
 * expiry step: the scan IS the decision.
 *
 * `loadFailed` reports the one auxiliary failure — the candidate SELECT —
 * which is caught here so it cannot abort the regular lanes below; per-quote
 * failures ride `failed` instead. Any other throw is a genuine crash and
 * still propagates as a batch failure.
 */
async function runDailyStaleUnpaidQuoteScan(params: {
  db: SupabaseLike;
  now: Date;
  quoteNow?: Date;
  limit: number;
  chain: BaseChainReader;
  rpcOptions: RpcCallOptions;
  minConfirmations?: number;
  settleQuote?: SettleManagedVeniceQuote;
  throttle: () => Promise<void>;
  elapsedMs: () => number;
  // The pass's own slice of the tick clock (it runs before the regular open
  // loop on the daily tick), so a slow regular batch can never starve it.
  staleScanBudgetMs: number;
  // Arms the shared deadline for the phase the pass is in: the marked-lot
  // lane at its share boundary, the scans at the slice end. It binds RPC
  // calls through rpcOptions.shouldStop AND the reconcile's non-RPC
  // segments through the same check, so an attempt's total elapsed — DB
  // work included — stays inside its phase. The caller owns the
  // underlying shouldStop and disarms it when the pass returns; the
  // regular lanes are never bound by it.
  setRpcAbortAtMs: (deadlineMs: number) => void;
}) {
  const expiresBeforeIso = new Date(
    params.now.getTime() - NO_DEPOSIT_AFTER_EXPIRY_GRACE_MS
  ).toISOString();
  let rows: StaleQuoteCandidateRow[];
  try {
    rows = await loadStaleUnpaidQuoteRows({
      db: params.db,
      expiresBeforeIso,
      limit: params.limit,
    });
  } catch (error) {
    // The candidate SELECT is this pass's one auxiliary failure (per-quote
    // failures are counted below and never reach here). It must not reject
    // the batch — the regular lanes and the transfer-surfacing pass still
    // progress, and the pass retries on the next day's first tick — but it
    // must not be INVISIBLE either: the tick produced no stale work at all,
    // so the outcome carries the failure for the route's incident report and
    // heartbeat (the crypto reconciler's staleRetryLoadFailed pattern).
    // Anything else the pass throws still propagates as a batch failure.
    log.warn("daily stale quote pass could not load its candidates; regular lanes still ran", {
      source: "managed-venice-token-reconciliation",
      failureType: "managed_venice_stale_scan_load_failed",
      errorName: error instanceof Error ? error.name : typeof error,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return { loadFailed: true, failed: [], outcomes: [], deferred: 0, handledIds: new Set<string>() };
  }

  const failed: Array<{
    quoteId: string;
    userId: string;
    errorName: string;
    errorMessage: string;
  }> = [];
  const outcomes: Array<{
    quoteId: string;
    userId: string;
    result: ReconcileManagedVeniceTokenQuoteResult;
  }> = [];
  let deferred = 0;

  // ── Marked lot-holder repair ──
  // Rows carrying the grace marker are excluded from the scan selection
  // above for good — but a marked row can still hold a deposit lot (the lot
  // landed while its catch-up scan ran and was marked before the marker
  // learned the lot check, or a legacy lot-only row was expired sight-unseen
  // and marked under an older guard), and such a row can sit beyond the open
  // lane's bounded lot probe. Lot recovery needs no scan, so the pass gives
  // a bounded, rotating slice of marked rows a lot check ahead of the day's
  // scans (see STALE_MARKED_LOT_PROBE_LIMIT) — but never the scans' whole
  // window: the lane admits attempts only inside MARKED_LOT_STALE_BUDGET_SHARE
  // of the slice. The bound holds mid-attempt too — the abort deadline is
  // the share while the lane runs, and the reconcile checks it between the
  // segments of an attempt that never touch RPC (a lot-holder's normal
  // recovery is pure DB: quote read, lot read, settle chain), so a marked
  // attempt can no more spend the scans' reservation on DB work than a
  // degenerate scan can on RPC calls.
  const markedLotBudgetMs = params.staleScanBudgetMs * MARKED_LOT_STALE_BUDGET_SHARE;
  params.setRpcAbortAtMs(markedLotBudgetMs);
  const markedLotProbe = await (async () => {
    try {
      return await loadMarkedLotHoldingQuoteRows({ db: params.db, limit: STALE_MARKED_LOT_PROBE_LIMIT });
    } catch (error) {
      // Auxiliary like the candidate SELECT: warn and run the pass without
      // the probe rather than kill the whole day's stale work.
      log.warn("daily stale pass could not probe marked quotes for lots; they retry tomorrow", {
        source: "managed-venice-token-reconciliation",
        failureType: "managed_venice_marked_lot_probe_failed",
        errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return { holders: [] as Array<{ id: string; userId: string; metadata: unknown }>, probedIds: [] as string[] };
    }
  })();
  const markedHolderIds = new Set(markedLotProbe.holders.map((holder) => holder.id));
  const attemptedMarkedHolders = new Set<string>();
  for (const [position, holder] of markedLotProbe.holders.entries()) {
    if (params.elapsedMs() >= markedLotBudgetMs) {
      deferred += markedLotProbe.holders.length - position;
      break;
    }
    await params.throttle();
    attemptedMarkedHolders.add(holder.id);
    try {
      const result = await reconcileManagedVeniceTokenQuote({
        quoteId: holder.id,
        userId: holder.userId,
        db: params.db,
        minConfirmations: params.minConfirmations,
        settleQuote: params.settleQuote,
        now: params.quoteNow,
        rpcOptions: params.rpcOptions,
        chain: params.chain,
        failOnTransferSurfacingError: true,
        scanProgress: staleQuoteScanProgress(
          params.db,
          { id: holder.id, metadata: holder.metadata },
          params.now.toISOString()
        ),
      });
      outcomes.push({ quoteId: holder.id, userId: holder.userId, result });
    } catch (error) {
      if (error instanceof RpcCallAbortedError) {
        // Same as an aborted scan row: never decided — deferred, not failed.
        deferred += markedLotProbe.holders.length - position;
        break;
      }
      failed.push({
        quoteId: holder.id,
        userId: holder.userId,
        errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }
  // Rotate every probed marked row to the back of the probe — except holders
  // the budget never reached, which keep the front of tomorrow's probe. One
  // bounded bulk UPDATE covers the whole probed-id set: up to ~200 awaited
  // per-row writes here would cost more of the shared tick clock than the
  // pass's scan slice itself, so every day's stale scan deferred before it
  // started.
  await touchQuoteQueueCursors(
    params.db,
    markedLotProbe.probedIds.filter(
      (probedId) => !(markedHolderIds.has(probedId) && !attemptedMarkedHolders.has(probedId))
    ),
    params.now.toISOString()
  );

  // The scans own the rest of the slice: the abort boundary moves from the
  // marked lane's share to the full stale budget.
  params.setRpcAbortAtMs(params.staleScanBudgetMs);
  for (const [position, row] of rows.entries()) {
    const candidate = row as StaleQuoteCandidateRow;
    if (typeof candidate.id !== "string" || typeof candidate.user_id !== "string") continue;
    // A row the expire-without-scan era marked no_deposit_after_grace is due
    // exactly ONE catch-up scan: skip it only once the scan marker is also
    // present (the selection above filters the same pair; this mirrors it so
    // the limit is spent on rows the pass will actually scan).
    const metadata =
      candidate.metadata && typeof candidate.metadata === "object"
        ? (candidate.metadata as Record<string, unknown>)
        : null;
    const graceExpired = metadata?.closedReason === "no_deposit_after_grace";
    if (graceExpired && metadata?.[GRACE_WINDOW_SCANNED_KEY] != null) {
      continue;
    }
    // Past the pass's own budget slice the rest wait for the next day's pass.
    if (params.elapsedMs() >= params.staleScanBudgetMs) {
      deferred += rows.length - position;
      break;
    }
    await params.throttle();
    // Resumable coverage for this row's log scans: a scan that aborts at the
    // pass's budget boundary leaves its answered chunks checkpointed on the
    // row, so tomorrow's pass resumes at scannedThroughBlock + 1 instead of
    // restarting at the window's first block — the difference between a wide
    // window finishing across days and the same window dying at the same
    // chunk every day.
    const scanProgress = staleQuoteScanProgress(
      params.db,
      { id: candidate.id, metadata: candidate.metadata },
      params.now.toISOString()
    );
    let scannedOutcome: ReconcileManagedVeniceTokenQuoteResult | null = null;
    try {
      const result = await reconcileManagedVeniceTokenQuote({
        quoteId: candidate.id,
        userId: candidate.user_id,
        db: params.db,
        minConfirmations: params.minConfirmations,
        settleQuote: params.settleQuote,
        now: params.quoteNow,
        rpcOptions: params.rpcOptions,
        chain: params.chain,
        failOnTransferSurfacingError: true,
        scanProgress,
      });
      scannedOutcome = result;
      outcomes.push({ quoteId: candidate.id, userId: candidate.user_id, result });
    } catch (error) {
      // The scan budget ran out mid-quote: the row was never decided — count
      // it and everything behind it deferred (not failed) and stop the pass.
      // A partial scan is never authoritative, so nothing settle/expire
      // -shaped happened for this row inside the aborted call.
      if (error instanceof RpcCallAbortedError) {
        // Still advance the row's queue cursor — only the cursor, no marker
        // or status change — so tomorrow's pass does not restart the SAME
        // scan at the head of the selection while rows behind it (including
        // ones recoverable without RPC) never get a turn. The row stays
        // fully eligible; it just retries from the back.
        await touchQuoteQueueCursor(params.db, candidate.id, params.now.toISOString());
        deferred += rows.length - position;
        break;
      }
      // A quote that fails to scan is retried on a later day; it does not
      // block the rest of the pass or the scan batch.
      failed.push({
        quoteId: candidate.id,
        userId: candidate.user_id,
        errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
    // The marker is only honest on an EXPLICIT full-window outcome: the
    // 'expired' status only comes back from the retire path, which itself
    // requires the confirmed head past the whole grace end, and a no_match
    // counts only when it reports that same coverage — a bare no_match just
    // means "nothing in what we scanned", and a chain head behind the grace
    // end leaves a payment in the unscanned tail invisible forever if the
    // row is excluded here.
    const catchUpScanProved =
      scannedOutcome?.status === "expired" ||
      (scannedOutcome?.status === "no_match" && scannedOutcome.windowFullyScanned === true);
    if (graceExpired && catchUpScanProved) {
      // The row's one catch-up scan completed over the whole window and
      // decided nothing — the quote stays open but is done here: stamp the
      // marker so tomorrow's selection skips it. A terminal outcome
      // (settled / review / retired) took the row out of the open set and
      // needs no marker; anything else that left the row open —
      // underconfirmed (a pending deposit owes it another look), a partial
      // no_match, or an indecisive status — is NOT marked, so it stays
      // eligible rather than being excluded with money still in flight.
      await markStaleQuoteGraceScanned(
        params.db,
        candidate.id,
        candidate.metadata,
        params.now.toISOString()
      );
      // The marker write already advanced the row's updated_at cursor.
      continue;
    }
    // Rotate the cursor for every scanned row — clean retire, still-open
    // outcome or failure alike — so repeatedly-failing quotes go to the back
    // of the daily selection instead of pinning its head (the open-status
    // guard makes this a no-op once the row has left the set).
    await touchQuoteQueueCursor(params.db, candidate.id, params.now.toISOString());
  }
  // Rows the pass already reconciled: the caller drops them from the open
  // lanes, which can also reach a marked lot-holder through their own lot
  // probe — one decision per tick, never a double settle.
  const handledIds = new Set<string>(
    [...outcomes.map((outcome) => outcome.quoteId), ...failed.map((failure) => failure.quoteId)]
  );
  return { loadFailed: false, failed, outcomes, deferred, handledIds };
}

// The reconcile result after a settle call, from the quote as it is NOW (it is
// re-read after the call): if a competing settle or review won, the status,
// tx and payload say what actually happened, not what this call attempted.
function settlementOutcome(
  current: ManagedVeniceTokenQuote,
  settlement: ManagedVeniceTokenSettlementResult,
  transfer: { transactionHash: string; confirmations?: number }
) {
  // Still open: the settle refused the transfer (it belongs to another quote).
  const status = isOpenQuoteStatus(current.status)
    ? settlement.status
    : (current.status as Exclude<ManagedVeniceTokenQuote["status"], "active" | "expired">);
  const transactionHash =
    status === "settled"
      ? current.transactionHash
      : status === "manual_review_required"
        ? current.reviewTransactionHash ?? current.transactionHash ?? transfer.transactionHash
        : status === "cancelled"
          ? null
          : transfer.transactionHash;
  return {
    status,
    quote: quotePayload(current),
    confirmations: sameTransactionHash(transactionHash, transfer.transactionHash) ? transfer.confirmations : undefined,
    transactionHash,
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

// Writes one reconciliation item per transfer — the one unbounded non-RPC
// loop in a reconcile (a dust spray can owe hundreds of awaited inserts).
// It honors the same cooperative deadline the RPC layer does, between
// items: past the deadline the loop stops short instead of holding the
// phase. Every item is dedupe-keyed, so the unwritten tail is owed to the
// surface-only pass (a terminal quote's transfer_surfacing_pending) or the
// next attempt's scan — never lost, and never a wrong answer: surfacing is
// bookkeeping, not the quote's decision. Returns false when the deadline
// ended the pass early so a caller whose own gate needs a COMPLETE surface
// (the surfacing flag's clear below) stays honest.
async function surfaceTransfers(
  db: SupabaseLike,
  quote: ManagedVeniceTokenQuote,
  transfers: ScannedTransfer[],
  reasonFor: (transfer: ScannedTransfer) => ManagedVeniceTokenDepositReason,
  shouldStop?: () => boolean
): Promise<boolean> {
  for (const transfer of transfers) {
    if (shouldStop?.()) return false;
    await surfaceManagedVeniceTokenTransfer(
      {
        quote,
        transactionHash: transfer.transactionHash,
        logIndex: transfer.logIndex,
        dedupeLogIndex: transfer.dedupeLogIndex,
        tokenAmountRaw: transfer.amount.toString(),
        observedAt: transfer.observedAt,
        reason: reasonFor(transfer),
      },
      db
    );
  }
  return true;
}

function sameTransactionHash(left: string | null | undefined, right: string | null | undefined) {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

function byChainOrder(left: ScannedTransfer, right: ScannedTransfer) {
  return left.blockNumber - right.blockNumber || left.logIndex - right.logIndex;
}

const DEPOSIT_REASONS = new Set<string>(Object.values(MANAGED_VENICE_TOKEN_DEPOSIT_REASONS));

// The Transfer log that sent this quote to review (its review trigger). A
// review records its trigger's log index; one without (a claim-unrecoverable
// review) keyed its item with the bare tx/address key, i.e. the tx's first log.
function isOwnReviewTrigger(quote: ManagedVeniceTokenQuote, transfer: ScannedTransfer) {
  return (
    quote.status === "manual_review_required" &&
    sameTransactionHash(quote.reviewTransactionHash, transfer.transactionHash) &&
    (quote.reviewLogIndex ?? transfer.firstLogIndex) === transfer.logIndex
  );
}

// The item reason for a transfer surfaced against a quote (by the surface-only
// pass, right after the settle / review flip, or item-only on an open quote):
// the review trigger keeps its review reason (a claim conflict stays a claim
// conflict); an in-window in-band transfer is an extra transfer; anything else
// keeps its class reason. The same rule on every path, so an item's reason
// does not depend on which pass saw the transfer first.
function surfacedTransferReason(
  quote: ManagedVeniceTokenQuote,
  transfer: ScannedTransfer,
  transferClass: TransferClass
): ManagedVeniceTokenDepositReason {
  if (isOwnReviewTrigger(quote, transfer) && quote.manualReviewReason && DEPOSIT_REASONS.has(quote.manualReviewReason)) {
    return quote.manualReviewReason as ManagedVeniceTokenDepositReason;
  }
  return CLASS_REASON[transferClass];
}

// Surface-only pass for a settled / in-review quote that still owes one
// (transfer_surfacing_pending). Rescans the quote's own attribution range with
// the same scan / boundary logic as the open-quote reconcile and surfaces every
// confirmed attributable transfer not bound on the quote's address (the
// quote's own credited log is excluded; the review trigger is included, and
// dedupe makes it a no-op once its item exists), plus every later log of a
// bound tx. It never settles, reviews, or changes the quote's status. The flag
// is cleared (CAS on the flag) only once the confirmed head is past the whole
// range end by the finality margin and nothing in range is still waiting for
// confirmations: every item it owes exists by then.
async function surfaceTerminalQuoteTransfers(params: {
  db: SupabaseLike;
  chain: BaseChainReader;
  quote: ManagedVeniceTokenQuote;
  minConfirmations: number;
  now: Date;
  shouldStop?: () => boolean;
}): Promise<"complete" | "pending"> {
  const { db, quote } = params;

  // A review's trigger can lie outside the range scanned below (a bearer
  // delivery mined before quotedAt, after the grace, or after the user's next
  // payment session started), and a claim-unrecoverable review keeps its
  // claimed tx bound to the quote, so the scan may never surface it. If the
  // item insert after the review flip failed, (re)write it from the review's
  // metadata under the review's own key first: a no-op once it exists, and a
  // failure here fails the pass, so the flag is never cleared without it.
  await surfaceManagedVeniceTokenReviewTrigger({ quote, observedAt: params.now.toISOString() }, db);

  const scan = await scanAttributableTransfers(params);
  const surfaceable = [...scan.attributable, ...scan.extraLogs].sort(byChainOrder);
  const surfacedAll = await surfaceTransfers(db, quote, surfaceable.filter(scan.isConfirmed), (transfer) =>
    surfacedTransferReason(quote, transfer, scan.classOf(transfer)), params.shouldStop
  );

  const fullyConfirmed =
    surfacedAll &&
    scan.confirmedHeadMs >= scan.attributionEndMs + FINALITY_MARGIN_MS &&
    surfaceable.every(scan.isConfirmed);
  if (!fullyConfirmed) return "pending";
  await completeManagedVeniceTokenTransferSurfacing({ quoteId: quote.id }, db);
  return "complete";
}

// After a settle / review call from the reconciler: re-read the quote and, if
// it is now terminal and owes surfacing, surface the other confirmed transfers
// this reconcile scanned. Bindings are re-read AFTER the call, so the log the
// quote actually settled with (this call's, or a competing settle's) is never
// surfaced as an extra, while another log of the same tx is. If the quote is
// still open (the transfer belongs to another quote) nothing is written: those
// transfers may be a later tick's candidates. The flip set the surfacing flag,
// so a failed item insert here is finished by the surface-only pass: the cron
// fails the call (it is counted), the user's check logs it and still returns
// the terminal status (the credit or review already happened).
async function finishSettlement(params: {
  db: SupabaseLike;
  quote: ManagedVeniceTokenQuote;
  settlement: ManagedVeniceTokenSettlementResult;
  transfer: { transactionHash: string; confirmations?: number };
  surface?: { transfers: ScannedTransfer[]; classOf: (transfer: ScannedTransfer) => TransferClass };
  failOnSurfacingError: boolean;
  shouldStop?: () => boolean;
}) {
  const { db, quote, surface } = params;
  const current =
    (await loadManagedVeniceTokenQuoteForUser({ quoteId: quote.id, userId: quote.userId }, db)) ?? quote;

  if (
    surface &&
    surface.transfers.length > 0 &&
    current.transferSurfacingPending &&
    (current.status === "settled" || current.status === "manual_review_required")
  ) {
    try {
      const { surfaceable } = await partitionByBindings(db, current, surface.transfers);
      // The flip already set transfer_surfacing_pending, so items a
      // deadline-stopped surface leaves unwritten are owed to the
      // surface-only pass — the settle / review outcome below stands.
      await surfaceTransfers(db, current, surfaceable, (transfer) =>
        surfacedTransferReason(current, transfer, surface.classOf(transfer)), params.shouldStop
      );
    } catch (error) {
      if (params.failOnSurfacingError) throw error;
      log.warn("managed Venice token quote is terminal but surfacing its other transfers failed; the cron finishes it", {
        source: "managed-venice-token-reconciliation",
        failureType: "managed_venice_token_transfer_surfacing_failed",
        quoteId: current.id,
        quoteStatus: current.status,
        errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return settlementOutcome(current, params.settlement, params.transfer);
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
  // Cron only (its surface-only loop): run the surface-only pass for a settled
  // / in-review quote that still owes one. Every other caller (the user's
  // check) gets a terminal quote straight from the DB with no RPC call, so a
  // credited quote reads as settled whatever the Base RPC is doing.
  runTransferSurfacing?: boolean;
  // Cron only: fail the call when surfacing the other transfers after a
  // settle / review flip fails, so the batch counts it. Otherwise (the user's
  // check) the failure is logged and the terminal status returned.
  failOnTransferSurfacingError?: boolean;
  // The daily stale pass only: resumable coverage for the quote's log scans
  // (see STALE_SCAN_PROGRESS_KEY). The stale pass scans a bounded slice of
  // the tick clock and can be aborted mid-window; checkpointing coverage on
  // the quote row lets the next day's pass resume where it stopped instead
  // of restarting at the window's first block. No other caller scans a
  // bounded, abortable range, so no other caller passes it.
  scanProgress?: {
    saved: unknown;
    checkpoint: (scan: PersistedTokenScan) => Promise<void>;
  };
}) {
  const db = requireDb(params.db ?? supabaseAdmin);
  const quote = await loadManagedVeniceTokenQuoteForUser(
    { quoteId: params.quoteId, userId: params.userId },
    db
  );

  if (!quote) {
    return { status: "not_found" as const };
  }

  const chain =
    params.chain ??
    createBaseChainReader({
      rpcUrl: params.rpcUrl || getBaseRpcUrl(),
      fetchImpl: params.fetchImpl || (fetch as unknown as JsonRpcFetch),
      rpcOptions: params.rpcOptions,
    });
  const minConfirmations = normalizeMinConfirmations(params.minConfirmations);
  const failOnSurfacingError = params.failOnTransferSurfacingError === true;

  // The stale pass arms rpcOptions.shouldStop at its current phase's
  // deadline — the marked-lot lane's share of the slice, then the slice
  // end — and the retry layer checks it before every RPC request, so a
  // scan's serial eth_* calls stay bound by the phase. The same deadline
  // must also bind the segments with no RPC in them: a recovery attempt
  // (claim or deposit lot) runs its whole settle chain on the DB without
  // one eth_* call, and a scan's DB-side settle / surface tails are
  // likewise off the RPC path, so a marked attempt could otherwise spend
  // far past its share on pure-DB work and hand the day's scans a
  // reservation that is already spent. RpcCallAbortedError is the pass's
  // existing cooperative-cancel contract (deferred, never failed), and
  // every throwIfStaleDeadline call site below sits where the quote is
  // still undecided, so a firing deadline only ever defers the attempt —
  // the row simply retries on the next pass. Outside the stale pass the
  // check is disarmed, so this is a no-op for every other caller.
  const shouldStop = params.rpcOptions?.shouldStop;
  const throwIfStaleDeadline = () => {
    if (shouldStop?.()) {
      throw new RpcCallAbortedError("stale pass deadline reached during non-RPC quote work");
    }
  };

  if (!isOpenQuoteStatus(quote.status)) {
    // Settled / in review since the flag was introduced: the cron's
    // surface-only loop finishes surfacing whatever else reached the quote.
    // Legacy terminal quotes (flag false), cancelled quotes and every
    // non-cron caller get the quote as-is, without a scan.
    if (params.runTransferSurfacing && quote.transferSurfacingPending) {
      const transferSurfacing = await surfaceTerminalQuoteTransfers({
        db,
        chain,
        quote,
        minConfirmations,
        now: params.now ?? new Date(),
        shouldStop,
      });
      return {
        status: quote.status,
        quote: quotePayload(quote),
        transferSurfacing,
      };
    }
    return {
      status: quote.status,
      quote: quotePayload(quote),
    };
  }

  const settle = params.settleQuote ?? settleManagedVeniceTokenQuote;
  const now = params.now ?? new Date();

  const lot = await loadManagedVeniceTokenDepositLot(quote.id, db);
  // Entry and reads are this attempt's first non-RPC segment; everything
  // below either commits (the settle chain) or scans (RPC-bound, plus the
  // same check inside it). If the reads already spent the phase's share,
  // defer the attempt while it is still undecided.
  throwIfStaleDeadline();
  if (quote.transactionHash || lot) {
    // The flip sets transfer_surfacing_pending, so any extra transfer this
    // recovery does not scan for is surfaced by the surface-only pass. A claim
    // with no lot and no readable claim values goes to review in settle.
    const recovery = recoveryTransfer(quote, lot, now);
    const settlement = await settle(recovery, db);
    return finishSettlement({ db, quote, settlement, transfer: recovery, failOnSurfacingError, shouldStop });
  }

  const scan = await scanAttributableTransfers({
    db,
    chain,
    quote,
    minConfirmations,
    now,
    scanProgress: params.scanProgress,
    shouldStop,
  });
  const { attributable, extraLogs, classOf, isConfirmed, expiresAtMs, graceEndMs } = scan;
  const confirmed = attributable.filter(isConfirmed);
  const confirmedExtraLogs = extraLogs.filter(isConfirmed);
  const settleWith = async (transfer: ScannedTransfer) => {
    // The scan is decided on data, not yet on the row — the settle call
    // below commits. This is the last clean point for the phase deadline
    // to defer the row when the scan's DB tail already spent it.
    throwIfStaleDeadline();
    const settlement = await settle(
      {
        quoteId: quote.id,
        transactionHash: transfer.transactionHash,
        // Hand settle the ACTUAL on-chain amount: an accepted over-send is
        // credited pro-rata for what the user really sent.
        tokenAmountRaw: transfer.amount.toString(),
        observedAt: now.toISOString(),
        blockTimestamp: transfer.observedAt,
        logIndex: transfer.logIndex,
        dedupeLogIndex: transfer.dedupeLogIndex,
      },
      db
    );
    // The other transfers are surfaced only AFTER the settle / review flip,
    // relative to what the quote actually settled with; see finishSettlement.
    return finishSettlement({
      db,
      quote,
      settlement,
      transfer,
      surface: { transfers: [...confirmed, ...confirmedExtraLogs].sort(byChainOrder), classOf },
      failOnSurfacingError,
      shouldStop,
    });
  };

  // 1. The settlement candidate is the EARLIEST qualifying in-window transfer
  //    in chain order. New arrivals can never displace it, and an
  //    under-confirmed candidate is waited for, never skipped. Extras are
  //    surfaced only AFTER the settle: if the claim loses a race, an extra may
  //    become the next tick's candidate and must not be credited AND surfaced.
  //    The settle flip sets transfer_surfacing_pending, so an extra whose item
  //    insert fails here (or that confirms later) is surfaced by the
  //    surface-only pass.
  const candidate = attributable.find((transfer) => classOf(transfer) === "qualifying");
  if (candidate) {
    if (!isConfirmed(candidate)) {
      return {
        status: "underconfirmed" as const,
        quote: quotePayload(quote),
        confirmations: candidate.confirmations,
      };
    }
    return settleWith(candidate);
  }

  // 2. No qualifying transfer: confirmed non-qualifying ones go to review.
  //    Above-ceiling and late in-band transfers review now; an under-payment
  //    only once the window has closed on a chain confirmed past it by the
  //    finality margin, so the user can still send the full amount until then
  //    and a qualifying transfer in the window's last blocks is seen first.
  //    The review CAS flip comes first (settle writes the trigger's item after
  //    it), then the other transfers' items. A lost flip writes nothing; a
  //    failed insert after the flip is finished by the surface-only pass (the
  //    flip set the flag).
  const windowClosed =
    now.getTime() > expiresAtMs && scan.confirmedHeadMs >= expiresAtMs + FINALITY_MARGIN_MS;
  const reviewTrigger =
    confirmed.find((transfer) => classOf(transfer) === "over") ??
    confirmed.find((transfer) => classOf(transfer) === "late_qualifying") ??
    (windowClosed ? confirmed.find((transfer) => classOf(transfer) === "under") : undefined);
  if (reviewTrigger) {
    return settleWith(reviewTrigger);
  }

  // Late out-of-band transfers and later logs of a tx bound on this address
  // never settle or review the quote: item only. A deadline-stopped surface
  // just owes the dedupe-keyed remainder; the decision below is unaffected.
  const lateOther = confirmed.filter((transfer) => classOf(transfer) === "late_other");
  await surfaceTransfers(db, quote, [...lateOther, ...confirmedExtraLogs].sort(byChainOrder), (transfer) =>
    surfacedTransferReason(quote, transfer, classOf(transfer)), shouldStop
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

  // 3. Retire: the whole window + grace is scanned on a chain confirmed past
  //    it by the finality margin, and nothing left can settle or review this
  //    quote (every item-only transfer was surfaced above).
  const fullyScanned = scan.confirmedHeadMs >= graceEndMs + FINALITY_MARGIN_MS;
  if (fullyScanned && confirmed.length === lateOther.length && extraLogs.every(isConfirmed)) {
    const retired = await retireManagedVeniceTokenQuote({ quoteId: quote.id, closedAt: now }, db);
    return {
      status: retired.status,
      quote: quotePayload({ ...quote, status: retired.status }),
    };
  }

  return {
    status: "no_match" as const,
    quote: quotePayload(quote),
    // Whether the confirmed head provably covered the whole window + grace —
    // the same bar the retire path above uses. A no_match WITHOUT it only
    // says "nothing in the scanned prefix": the unscanned tail can still
    // hold the payment, so callers that exclude a quote on one silent scan
    // (the daily stale pass's graceWindowScannedAt marker) must read this.
    windowFullyScanned: fullyScanned,
  };
}

function normalizeBudgetMs(value: number | undefined, fallback: number) {
  return Number.isFinite(value) ? Math.max(0, value as number) : fallback;
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
  // Wall-clock budget (see OPEN_SCAN_BUDGET_MS); tests inject a fake clock.
  clock?: () => number;
  openScanBudgetMs?: number;
  surfacingScanBudgetMs?: number;
  staleScanBudgetMs?: number;
  // Bound on the lot-recovery probe's open-quote reads per tick (see
  // LOT_DISCOVERY_QUOTE_BUDGET); tests inject a small value.
  lotProbeBudget?: number;
} = {}): Promise<ManagedVeniceTokenQuoteBatchReconciliationResult> {
  const clock = params.clock ?? Date.now;
  const startedAtMs = clock();
  const elapsedMs = () => clock() - startedAtMs;
  const openScanBudgetMs = normalizeBudgetMs(params.openScanBudgetMs, OPEN_SCAN_BUDGET_MS);
  const surfacingScanBudgetMs = normalizeBudgetMs(params.surfacingScanBudgetMs, SURFACING_SCAN_BUDGET_MS);
  const staleScanBudgetMs = normalizeBudgetMs(params.staleScanBudgetMs, STALE_SCAN_BUDGET_MS);

  const db = requireDb(params.db ?? supabaseAdmin);
  const batchNow = params.now ?? new Date();

  // Build the per-call RPC options once: retry config + injectable sleep/random
  // ride along with every eth_* call this batch makes. shouldStop is armed
  // only while the daily stale pass runs, at the boundary the pass's current
  // phase owns — the marked-lot lane's share, then the slice end — so a
  // single quote's scan, dozens of serial RPC calls, is interrupted at its
  // phase's boundary instead of overrunning it for minutes; the regular
  // lanes let an in-flight scan finish (their budgets are honored between
  // quotes).
  let staleRpcAbortAtMs: number | null = null;
  const rpcOptions: RpcCallOptions = {
    retryConfig: normalizeRpcRetryConfig(params.rpcRetryConfig),
    sleepImpl: params.rpcSleepImpl,
    random: params.rpcRandom,
    shouldStop: () => staleRpcAbortAtMs !== null && elapsedMs() >= staleRpcAbortAtMs,
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
    transferSurfacing: { checked: 0, complete: 0, pending: 0, failed: 0 },
    deferred: { open: 0, surfacing: 0 },
    staleScanLoadFailed: false,
    staleScanClaimFailed: false,
    lotProbeLoadFailed: false,
    results: [],
  };

  let index = 0;
  // Throttle between quotes (not before the first) to keep the per-tick
  // request rate under the public Base RPC endpoint's rate-limit threshold.
  const throttle = async () => {
    if (index > 0 && interQuoteDelayMs > 0) {
      await sleepImpl(interQuoteDelayMs);
    }
    index += 1;
  };
  const failure = (candidate: { id: string; userId: string }, error: unknown) => ({
    quoteId: candidate.id,
    userId: candidate.userId,
    status: "failed" as const,
    errorName: error instanceof Error ? error.name : typeof error,
    errorMessage: error instanceof Error ? error.message : String(error),
  });

  // Once per UTC day the stale unclaimed quote pass runs BEFORE the regular
  // open loop AND before regular candidate discovery below, inside its own
  // slice of the tick clock. Stale quotes are the oldest unclaimed money, so
  // the day's one pass gets a guaranteed window: a slow fresh/claimed/
  // lot-held lookup can never eat the stale budget because discovery has not
  // run yet, and the shared clock still bounds the slice so the batch keeps
  // its wall-clock cap. Other ticks do no stale work at all: expiring
  // without a real log scan of the deposit window is exactly what this pass
  // exists to prevent.
  //
  // The day is claimed atomically on a dedicated heartbeat row
  // ("<cron>:stale-scan"), not inferred from the run heartbeat's last_run_at:
  // a tick that starts before UTC midnight and finishes after it stamps the
  // heartbeat on the NEW day — under the read gate that heartbeat would mask
  // the new day's pass entirely. The claim row keys the pass to the day it
  // RAN, and the guarded update also decides between overlapping invocations
  // (the read-only day check let two of them both run it).
  // The claim outcome distinguishes "another run holds today" (a clean
  // skip) from "the claim write itself failed" — the latter leaves the day
  // unclaimed AND the pass unrun, so the tick is reported degraded instead
  // of recording a clean heartbeat while the stale pass runs on no tick.
  const staleScanClaim = await claimCronUtcDayOutcome(
    db,
    MANAGED_VENICE_TOKEN_RECONCILIATION_CRON,
    batchNow,
    { claimKey: "stale-scan" }
  );
  if (staleScanClaim === "failed") {
    summary.staleScanClaimFailed = true;
    log.warn("daily stale quote pass could not claim its utc-day slot; regular lanes still ran", {
      source: "managed-venice-token-reconciliation",
      failureType: "managed_venice_stale_scan_claim_failed",
    });
  }
  const staleHandledIds = new Set<string>();
  if (staleScanClaim === "claimed") {
    try {
      // Only the pass's candidate SELECT is caught inside (loadFailed); a
      // genuine mid-pass crash still propagates as a batch failure, and
      // per-quote failures are counted, not thrown.
      const stale = await runDailyStaleUnpaidQuoteScan({
        db,
        now: batchNow,
        quoteNow: params.now,
        limit: STALE_QUOTE_DAILY_SCAN_LIMIT,
        chain,
        rpcOptions,
        minConfirmations: params.minConfirmations,
        settleQuote: params.settleQuote,
        throttle,
        elapsedMs,
        staleScanBudgetMs,
        setRpcAbortAtMs: (deadlineMs) => {
          staleRpcAbortAtMs = deadlineMs;
        },
      });
      if (stale.loadFailed) summary.staleScanLoadFailed = true;
      summary.failed += stale.failed.length;
      summary.deferred.open += stale.deferred;
      for (const outcome of stale.outcomes) {
        summary.checked += 1;
        const result = outcome.result;
        if (result.status === "settled") summary.settled += 1;
        else if (result.status === "underconfirmed") summary.underconfirmed += 1;
        else if (result.status === "no_match") summary.noMatch += 1;
        else if (result.status === "manual_review_required") summary.manualReview += 1;
        else if (result.status === "cancelled") summary.cancelled += 1;
        else summary.skipped += 1;

        summary.results.push({
          quoteId: outcome.quoteId,
          userId: outcome.userId,
          status: result.status,
          transactionHash: "transactionHash" in result ? result.transactionHash ?? null : null,
          confirmations: "confirmations" in result ? result.confirmations : undefined,
        });
      }
      for (const failure of stale.failed) {
        summary.results.push({ ...failure, status: "failed" });
      }
      for (const handledId of stale.handledIds) staleHandledIds.add(handledId);
    } finally {
      // The regular lanes must never see the stale deadline — their budgets
      // are honored between quotes and an in-flight scan completes.
      staleRpcAbortAtMs = null;
    }
  }

  // Scan candidates are bounded below by expires_at: anything at or before
  // the stale cutoff is handled by the once-a-day stale pass instead of a
  // scan every tick (the stored expiry approximates the effective expiry
  // within the quote lifetime, and the stale pass re-checks the exact
  // window). This runs AFTER the stale pass so a slow discovery can never
  // starve the day's one stale pass of its budget slice.
  const { candidates, claimedIds, lotHeldIds, lotProbeLoadFailed } = await loadPendingManagedVeniceTokenQuoteCandidates({
    db,
    limit: normalizePendingQuoteLimit(params.limit),
    expiresAfterIso: new Date(batchNow.getTime() - NO_DEPOSIT_AFTER_EXPIRY_GRACE_MS).toISOString(),
    lotProbeBudget: params.lotProbeBudget,
  });
  summary.lotProbeLoadFailed = lotProbeLoadFailed;
  // Rows the stale pass already decided this tick are dropped from the open
  // lanes: a marked lot-holder is reachable by both the pass's repair probe
  // and the open lot probe, and one tick must never settle a row twice.
  const openCandidates = candidates.filter((candidate) => !staleHandledIds.has(candidate.id));
  // Claimed and lot-held candidates lead the candidate list — a crashed
  // settlement finishes without a scan — but they are not entitled to the
  // whole open budget: a storm of failing claims could otherwise defer
  // every fresh payment to the once-a-day stale pass. Their lane is
  // bounded to a share of the slice; fresh quotes keep the rest.
  const recoveryIds = new Set<string>([...claimedIds, ...lotHeldIds]);
  const recoveryScanBudgetMs = openScanBudgetMs * RECOVERY_OPEN_BUDGET_SHARE;

  for (const [position, candidate] of openCandidates.entries()) {
    // Past the open-scan budget, leave the rest for a later tick so the
    // surface-only pass and the summary still run inside maxDuration.
    if (elapsedMs() >= openScanBudgetMs) {
      // Add to whatever the stale pass already deferred on this tick.
      summary.deferred.open += openCandidates.length - position;
      break;
    }
    // Past the recovery lanes' share, defer them (not drop: they were never
    // attempted, so the cursor keeps them at the front of the next tick)
    // and spend the rest of the clock on fresh discovery.
    if (recoveryIds.has(candidate.id) && elapsedMs() >= recoveryScanBudgetMs) {
      summary.deferred.open += 1;
      continue;
    }
    await throttle();
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
        failOnTransferSurfacingError: true,
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
      summary.results.push(failure(candidate, error));
    }
    // A claimed quote is selected least-recently-attempted first (updated_at
    // order in discovery): advancing its cursor after the attempt rotates a
    // claim that keeps failing to the back of the lane instead of letting a
    // batch-sized set of them starve every newer claim forever. The cursor
    // moves only — terminal outcomes already left the open set, where the
    // status guard makes the write a no-op.
    if (claimedIds.has(candidate.id)) {
      await touchQuoteQueueCursor(db, candidate.id, batchNow.toISOString());
    }
  }

  // Surface-only pass over settled / in-review quotes that still owe one,
  // including any the loop above just made terminal: a transfer that was still
  // confirming at the flip, arrived after it, or whose item insert failed
  // after it is surfaced here, once, until the quote's range is confirmed. It
  // has its own, later budget, so an open loop that used up its budget never
  // starves it.
  const surfacingCandidates = await loadTransferSurfacingCandidates({ db, limit: TRANSFER_SURFACING_LIMIT });
  for (const [position, candidate] of surfacingCandidates.entries()) {
    if (elapsedMs() >= surfacingScanBudgetMs) {
      summary.deferred.surfacing = surfacingCandidates.length - position;
      break;
    }
    await throttle();
    summary.transferSurfacing.checked += 1;
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
        runTransferSurfacing: true,
        failOnTransferSurfacingError: true,
      });
      // No surfacing result = the flag was cleared since the candidate query.
      const outcome = ("transferSurfacing" in result && result.transferSurfacing) || "complete";
      summary.transferSurfacing[outcome] += 1;
    } catch (error) {
      summary.failed += 1;
      summary.transferSurfacing.failed += 1;
      summary.results.push(failure(candidate, error));
    }
  }

  return summary;
}
