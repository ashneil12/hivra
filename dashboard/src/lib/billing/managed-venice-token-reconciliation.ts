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
} from "@/lib/billing/base-transfer-scan";
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
import { getLogsInBlockChunks } from "@/lib/billing/base-rpc-logs";

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
//   - 2 timestamp->block searches, each <= MAX_BLOCK_SEARCH_PROBES (40)
//     eth_getBlockByNumber probes; the 2 s/block estimate is verified, so
//     typically 1-3 probes each, and every block timestamp is cached per batch;
//   - ceil(span / 2,000) eth_getLogs: a window + grace is ~4,200 blocks, so 3;
//     hard cap MAX_SCAN_SPAN_BLOCKS (50,000) / 2,000 = 25;
//   - <= MAX_TRANSFER_TIMESTAMP_LOOKUPS (200) block timestamps for logs that
//     carry no blockTimestamp (usually a handful of transfers, often 0);
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
// its summary instead of being killed mid-batch.
const OPEN_SCAN_BUDGET_MS = 150_000;
const SURFACING_SCAN_BUDGET_MS = 240_000;

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
export const LATE_PAYMENT_GRACE_MS = 2 * 60 * 60_000;
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
  // The lowest log index of this tx's Transfer logs to the deposit address:
  // the log a binding without a log index accounts for, and the one whose
  // item carries the bare tx/address key.
  firstLogIndex: number;
  // The log index for the item's dedupe key: null for the tx's first log to
  // the address, this log's index for any later one.
  dedupeLogIndex: number | null;
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
  // Chunked at the public endpoint's 2,000-block eth_getLogs limit (Base's
  // public RPC answers a wider range with HTTP 413 / JSON-RPC -32614).
  const logs = await getLogsInBlockChunks<EvmLog>({
    call: chain.call,
    filter: { address: HERMESOS_TOKEN_ADDRESS, topics: [ERC20_TRANSFER_TOPIC, null, toTopic] },
    fromBlock,
    toBlock,
  });

  const parsed = new Map<
    string,
    Omit<ScannedTransfer, "timestampMs" | "observedAt" | "firstLogIndex" | "dedupeLogIndex"> & {
      logTimestampSec: number | null;
    }
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
  // A tx's logs share one block, so they are always scanned (and in range,
  // and confirmed) together.
  const firstLogIndexByTx = new Map<string, number>();
  for (const entry of parsed.values()) {
    const first = firstLogIndexByTx.get(entry.transactionHash);
    if (first === undefined || entry.logIndex < first) firstLogIndexByTx.set(entry.transactionHash, entry.logIndex);
  }
  const transfers: ScannedTransfer[] = [];
  for (const { logTimestampSec, ...transfer } of parsed.values()) {
    const timestampSec = logTimestampSec ?? (await chain.blockTimestamp(transfer.blockNumber));
    const firstLogIndex = firstLogIndexByTx.get(transfer.transactionHash) ?? transfer.logIndex;
    transfers.push({
      ...transfer,
      firstLogIndex,
      dedupeLogIndex: transfer.logIndex === firstLogIndex ? null : transfer.logIndex,
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
//   - bound: a counted binding accounts for this log (its log index, or the
//     tx's first log to the address when the binding has none). Excluded.
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

function bindingStateOf(
  transfer: ScannedTransfer,
  bindings: Map<string, ManagedVeniceTransferBinding[]>,
  quoteId: string
): BindingState {
  const counted = (bindings.get(transfer.transactionHash) ?? []).filter((binding) =>
    isManagedVeniceTransferBindingCounted(binding, quoteId)
  );
  if (counted.length === 0) return "unbound";
  return counted.some((binding) => (binding.logIndex ?? transfer.firstLogIndex) === transfer.logIndex)
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
}) {
  const { db, quote } = params;
  const window = managedVeniceTokenQuoteWindow(quote);
  const quotedAtMs = window.quotedAt.getTime();
  const expiresAtMs = window.effectiveExpiresAt.getTime();
  const graceEndMs = expiresAtMs + LATE_PAYMENT_GRACE_MS;

  const scan = await scanQuoteTransfers({
    chain: params.chain,
    quote,
    quotedAtMs,
    graceEndMs,
    minConfirmations: params.minConfirmations,
  });
  const boundaryMs = await loadAttributionBoundaryMs(db, quote);
  const inRange = scan.transfers.filter(
    (transfer) =>
      transfer.timestampMs >= quotedAtMs &&
      transfer.timestampMs <= graceEndMs &&
      (boundaryMs === null || transfer.timestampMs < boundaryMs)
  );
  const { unbound, extraLogs } = await partitionByBindings(db, quote, inRange);

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
  return quoteCandidates(data);
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
        dedupeLogIndex: transfer.dedupeLogIndex,
        tokenAmountRaw: transfer.amount.toString(),
        observedAt: transfer.observedAt,
        reason: reasonFor(transfer),
      },
      db
    );
  }
}

function sameTransactionHash(left: string | null | undefined, right: string | null | undefined) {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

function byChainOrder(left: ScannedTransfer, right: ScannedTransfer) {
  return left.blockNumber - right.blockNumber || left.logIndex - right.logIndex;
}

const DEPOSIT_REASONS = new Set<string>(Object.values(MANAGED_VENICE_TOKEN_DEPOSIT_REASONS));

// The Transfer log that sent this quote to review (its review trigger).
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
  await surfaceTransfers(db, quote, surfaceable.filter(scan.isConfirmed), (transfer) =>
    surfacedTransferReason(quote, transfer, scan.classOf(transfer))
  );

  const fullyConfirmed =
    scan.confirmedHeadMs >= scan.attributionEndMs + FINALITY_MARGIN_MS && surfaceable.every(scan.isConfirmed);
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
      await surfaceTransfers(db, current, surfaceable, (transfer) =>
        surfacedTransferReason(current, transfer, surface.classOf(transfer))
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
  if (quote.transactionHash || lot) {
    // The flip sets transfer_surfacing_pending, so any extra transfer this
    // recovery does not scan for is surfaced by the surface-only pass. A claim
    // with no lot and no readable claim values goes to review in settle.
    const recovery = recoveryTransfer(quote, lot, now);
    const settlement = await settle(recovery, db);
    return finishSettlement({ db, quote, settlement, transfer: recovery, failOnSurfacingError });
  }

  const scan = await scanAttributableTransfers({ db, chain, quote, minConfirmations });
  const { attributable, extraLogs, classOf, isConfirmed, expiresAtMs, graceEndMs } = scan;
  const confirmed = attributable.filter(isConfirmed);
  const confirmedExtraLogs = extraLogs.filter(isConfirmed);
  const settleWith = async (transfer: ScannedTransfer) => {
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
  // never settle or review the quote: item only.
  const lateOther = confirmed.filter((transfer) => classOf(transfer) === "late_other");
  await surfaceTransfers(db, quote, [...lateOther, ...confirmedExtraLogs].sort(byChainOrder), (transfer) =>
    surfacedTransferReason(quote, transfer, classOf(transfer))
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
} = {}): Promise<ManagedVeniceTokenQuoteBatchReconciliationResult> {
  const clock = params.clock ?? Date.now;
  const startedAtMs = clock();
  const elapsedMs = () => clock() - startedAtMs;
  const openScanBudgetMs = normalizeBudgetMs(params.openScanBudgetMs, OPEN_SCAN_BUDGET_MS);
  const surfacingScanBudgetMs = normalizeBudgetMs(params.surfacingScanBudgetMs, SURFACING_SCAN_BUDGET_MS);

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
    transferSurfacing: { checked: 0, complete: 0, pending: 0, failed: 0 },
    deferred: { open: 0, surfacing: 0 },
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

  for (const [position, candidate] of candidates.entries()) {
    // Past the open-scan budget, leave the rest for a later tick so the
    // surface-only pass and the summary still run inside maxDuration.
    if (elapsedMs() >= openScanBudgetMs) {
      summary.deferred.open = candidates.length - position;
      break;
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
