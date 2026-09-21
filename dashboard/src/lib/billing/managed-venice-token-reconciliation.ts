import { requireDb } from "@/lib/billing/db-utils";
import { supabaseAdmin } from "@/lib/supabase";
import {
  HERMESOS_TOKEN_ADDRESS,
  normalizeEvmAddress,
} from "@/lib/billing/token-holdings";
import {
  loadManagedVeniceTokenQuoteForUser,
  settleManagedVeniceTokenQuote,
  MANAGED_VENICE_MAX_OVERSEND_NUMERATOR,
  MANAGED_VENICE_MAX_OVERSEND_DENOMINATOR,
  type ManagedVeniceTokenQuote,
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

type PendingQuoteQuery = {
  select: (...args: unknown[]) => PendingQuoteQuery;
  in: (...args: unknown[]) => PendingQuoteQuery;
  order: (...args: unknown[]) => PendingQuoteQuery;
  limit: (...args: unknown[]) => Promise<{ data?: unknown; error: QueryError }>;
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
}

interface EvmBlock {
  number?: unknown;
  timestamp?: unknown;
}

type SettleManagedVeniceQuote = typeof settleManagedVeniceTokenQuote;

const DEFAULT_BASE_RPC_URL = "https://mainnet.base.org";
const DEFAULT_LOOKBACK_BLOCKS = 20_000;
const MAX_LOOKBACK_BLOCKS = 100_000;
// Base's public RPC currently rejects eth_getLogs ranges above 2,000 blocks.
// Keep the range at the provider limit so manual verification and the cron
// reconciler both receive logs instead of a deterministic JSON-RPC error.
const MAX_BASE_RPC_LOG_RANGE_BLOCKS = 2_000;
const DEFAULT_MIN_CONFIRMATIONS = 3;
const DEFAULT_PENDING_QUOTE_RECONCILIATION_LIMIT = 25;
const MAX_PENDING_QUOTE_RECONCILIATION_LIMIT = 100;

// Base RPC resilience (retry/backoff/jitter on 429/5xx/network) now lives in
// the shared @/lib/billing/base-rpc-retry module. This file keeps a short
// inter-quote throttle on top: the shared/public Base RPC endpoint rate-limits
// once a single reconciliation tick fans out eth_getLogs across every pending
// deposit quote, so we pause briefly between per-quote scans to keep the
// request rate under the public endpoint's threshold. Crediting/settlement
// logic is untouched — this only makes the on-chain READ resilient so
// legitimate deposits get seen.
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

function normalizeLookbackBlocks(lookbackBlocks: number | undefined) {
  if (!Number.isFinite(lookbackBlocks)) return DEFAULT_LOOKBACK_BLOCKS;
  return Math.max(1, Math.min(MAX_LOOKBACK_BLOCKS, Math.floor(lookbackBlocks ?? DEFAULT_LOOKBACK_BLOCKS)));
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
    // Throw a typed error so the retry layer can decide whether this status
    // (429 / 5xx) is worth retrying. The .message is unchanged from before so
    // existing ops_events / log assertions on the text keep matching.
    throw new RpcHttpError(response.status);
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

async function getLatestBaseBlockNumber(params: {
  rpcUrl: string;
  fetchImpl: JsonRpcFetch;
  rpcOptions?: RpcCallOptions;
}) {
  const latestBlockHex = await rpcCall<string>(
    params.rpcUrl,
    "eth_blockNumber",
    [],
    params.fetchImpl,
    params.rpcOptions
  );
  return parseRpcQuantity(latestBlockHex, "block number");
}

async function fetchHermesTransfersToAddress(params: {
  depositAddress: string;
  rpcUrl: string;
  fetchImpl: JsonRpcFetch;
  lookbackBlocks: number;
  rpcOptions?: RpcCallOptions;
}) {
  const latestBlock = await getLatestBaseBlockNumber(params);
  const fromBlock = Math.max(0, latestBlock - params.lookbackBlocks + 1);
  const logs: EvmLog[] = [];
  const toTopic = encodeErc20TransferToTopic(params.depositAddress);

  for (
    let chunkStart = fromBlock;
    chunkStart <= latestBlock;
    chunkStart += MAX_BASE_RPC_LOG_RANGE_BLOCKS
  ) {
    const chunkEnd = Math.min(
      latestBlock,
      chunkStart + MAX_BASE_RPC_LOG_RANGE_BLOCKS - 1
    );
    const chunkLogs = await rpcCall<EvmLog[]>(
      params.rpcUrl,
      "eth_getLogs",
      [
        {
          address: HERMESOS_TOKEN_ADDRESS,
          fromBlock: rpcQuantity(chunkStart),
          toBlock: rpcQuantity(chunkEnd),
          topics: [
            ERC20_TRANSFER_TOPIC,
            null,
            toTopic,
          ],
        },
      ],
      params.fetchImpl,
      params.rpcOptions
    );

    if (Array.isArray(chunkLogs)) logs.push(...chunkLogs);
  }

  return {
    latestBlock,
    logs,
  };
}

function findMatchingTransfer(params: {
  logs: EvmLog[];
  latestBlock: number;
  tokenAmountRaw: string;
}) {
  const requiredAmount = BigInt(params.tokenAmountRaw);
  // Accept the EXACT quoted amount OR an over-send within the same ceiling the
  // settlement layer credits (quoted <= observed <= quoted*N). An over-send is
  // real money the user paid us; matching it here lets the reconciler find the
  // transfer and hand the OBSERVED amount to settle, which credits pro-rata.
  // Under-payments and wildly-over transfers are NOT matched — they'd never be
  // auto-credited by settle anyway, so leaving them as `no_match` keeps the
  // reconciler re-scanning (a later top-up could still satisfy the quote).
  const overSendCeiling =
    (requiredAmount * MANAGED_VENICE_MAX_OVERSEND_NUMERATOR) /
    MANAGED_VENICE_MAX_OVERSEND_DENOMINATOR;
  const matches: Array<{
    amount: bigint;
    blockNumber: number;
    logIndex: number;
    confirmations: number;
    transactionHash: string;
    blockHash: string | null;
  }> = [];

  for (const log of params.logs) {
    try {
      const amount = decodeUint256LogData(log.data);
      const blockNumber = parseRpcQuantity(log.blockNumber, "log block number");
      const logIndex = parseRpcQuantity(log.logIndex, "log index");
      const confirmations = Math.max(0, params.latestBlock - blockNumber + 1);
      const transactionHash = typeof log.transactionHash === "string" ? log.transactionHash : "";
      const address = typeof log.address === "string" ? normalizeEvmAddress(log.address) : "";
      if (
        amount >= requiredAmount &&
        amount <= overSendCeiling &&
        transactionHash &&
        address === HERMESOS_TOKEN_ADDRESS
      ) {
        matches.push({
          amount,
          blockNumber,
          logIndex,
          confirmations,
          transactionHash,
          blockHash: typeof log.blockHash === "string" ? log.blockHash : null,
        });
      }
    } catch {
      continue;
    }
  }

  // Prefer the TIGHTEST qualifying transfer: an exact match over an over-send,
  // and among over-sends the smallest one. This avoids over-crediting when an
  // exact transfer is present alongside a larger one, and is deterministic.
  // Ties (same amount) fall back to chain order (earliest block/log first).
  return matches.sort((a, b) => {
    if (a.amount !== b.amount) return a.amount < b.amount ? -1 : 1;
    if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber;
    return a.logIndex - b.logIndex;
  });
}

async function fetchBlockTimestamp(params: {
  blockNumber: number;
  rpcUrl: string;
  fetchImpl: JsonRpcFetch;
  rpcOptions?: RpcCallOptions;
}) {
  const block = await rpcCall<EvmBlock>(
    params.rpcUrl,
    "eth_getBlockByNumber",
    [rpcQuantity(params.blockNumber), false],
    params.fetchImpl,
    params.rpcOptions
  );
  const timestamp = parseRpcQuantity(block?.timestamp, "block timestamp");
  return new Date(timestamp * 1000).toISOString();
}

function quotePayload(quote: ManagedVeniceTokenQuote) {
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
  const { data, error } = await ((params.db.from("managed_venice_token_quotes") as PendingQuoteQuery)
    .select("id, user_id, status")
    .in("status", ["active", "expired"])
    .order("created_at", { ascending: true })
    .limit(params.limit));

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

export async function reconcileManagedVeniceTokenQuote(params: {
  quoteId: string;
  userId: string;
  db?: SupabaseLike | null;
  rpcUrl?: string;
  fetchImpl?: JsonRpcFetch;
  lookbackBlocks?: number;
  minConfirmations?: number;
  settleQuote?: SettleManagedVeniceQuote;
  now?: Date;
  rpcOptions?: RpcCallOptions;
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

  const rpcUrl = params.rpcUrl || getBaseRpcUrl();
  const fetchImpl = params.fetchImpl || (fetch as unknown as JsonRpcFetch);
  const lookbackBlocks = normalizeLookbackBlocks(params.lookbackBlocks);
  const minConfirmations = normalizeMinConfirmations(params.minConfirmations);
  const rpcOptions = params.rpcOptions;
  const scan = await fetchHermesTransfersToAddress({
    depositAddress: quote.depositAddress,
    rpcUrl,
    fetchImpl,
    lookbackBlocks,
    rpcOptions,
  });
  const matches = findMatchingTransfer({
    logs: scan.logs,
    latestBlock: scan.latestBlock,
    tokenAmountRaw: quote.tokenAmountRaw,
  });
  const confirmed = matches.find((match) => match.confirmations >= minConfirmations);

  if (!confirmed) {
    if (matches.length > 0) {
      return {
        status: "underconfirmed" as const,
        quote: quotePayload(quote),
        confirmations: Math.max(...matches.map((match) => match.confirmations)),
      };
    }

    return {
      status: "no_match" as const,
      quote: quotePayload(quote),
    };
  }

  const blockTimestamp = await fetchBlockTimestamp({
    blockNumber: confirmed.blockNumber,
    rpcUrl,
    fetchImpl,
    rpcOptions,
  });
  const settle = params.settleQuote ?? settleManagedVeniceTokenQuote;
  const settlement = await settle(
    {
      quoteId: quote.id,
      transactionHash: confirmed.transactionHash,
      // Hand settle the ACTUAL on-chain amount, not the quoted amount. For an
      // exact match these are equal; for an accepted over-send this lets settle
      // credit the user for what they really sent (pro-rata) instead of
      // silently under-crediting them to the quoted amount.
      tokenAmountRaw: confirmed.amount.toString(),
      observedAt: (params.now ?? new Date()).toISOString(),
      blockTimestamp,
    },
    db
  );

  return {
    status: settlement.status,
    quote: quotePayload({
      ...quote,
      status: settlement.status,
      transactionHash: confirmed.transactionHash,
      settledAt: settlement.status === "settled" ? (params.now ?? new Date()).toISOString() : quote.settledAt,
    }),
    confirmations: confirmed.confirmations,
    transactionHash: confirmed.transactionHash,
  };
}

export async function reconcilePendingManagedVeniceTokenQuotes(params: {
  db?: SupabaseLike | null;
  rpcUrl?: string;
  fetchImpl?: JsonRpcFetch;
  lookbackBlocks?: number;
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
        rpcUrl: params.rpcUrl,
        fetchImpl: params.fetchImpl,
        lookbackBlocks: params.lookbackBlocks,
        minConfirmations: params.minConfirmations,
        settleQuote: params.settleQuote,
        now: params.now,
        rpcOptions,
      });

      if (result.status === "settled") summary.settled += 1;
      else if (result.status === "underconfirmed") summary.underconfirmed += 1;
      else if (result.status === "no_match") summary.noMatch += 1;
      else if (result.status === "manual_review_required") summary.manualReview += 1;
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
