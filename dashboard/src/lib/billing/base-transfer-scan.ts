// Window-anchored ERC-20 transfer scans on Base.
//
// A payment session (a USDC top-up intent, a token quote) is scanned over ITS
// OWN time range, not "the latest N blocks": from the block at the session's
// start to the block at its end (window + late-payment grace). A payment is
// therefore visible however late the reconciler gets to it, and a session
// stops seeing transfers that happen long after it.
//
// Base's public RPC rejects eth_getLogs ranges above 2,000 blocks (HTTP 413,
// JSON-RPC -32614), so every scan is split into chunks at that limit.
// Read-only: no crediting logic lives here.

import { normalizeEvmAddress } from "@/lib/billing/token-holdings";
import {
  RpcHttpError,
  isRetryableRpcError,
  withRpcRetry,
  type RpcCallOptions,
} from "@/lib/billing/base-rpc-retry";
import { getLogsInBlockChunks } from "@/lib/billing/base-rpc-logs";

export const ERC20_TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const DEFAULT_BASE_RPC_URL = "https://mainnet.base.org";
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
// Bound per-session RPC work: a 20-minute window + 2 h grace is ~4,200 blocks
// with a handful of transfers; anything far above that is refused, not scanned.
const MAX_SCAN_SPAN_BLOCKS = 50_000;
const MAX_TRANSFER_TIMESTAMP_LOOKUPS = 200;
// A provider that accepts the connection and then stalls would otherwise hold
// the request until the platform kills the function (undici's default header
// timeout is 300 s). Time out, and let the retry layer try again.
const DEFAULT_RPC_REQUEST_TIMEOUT_MS = 10_000;

export type JsonRpcFetch = (
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

export function getBaseRpcUrl(env: Record<string, string | undefined> = process.env) {
  return (
    env.HERMES_BASE_RPC_URL?.trim() ||
    env.BASE_RPC_URL?.trim() ||
    DEFAULT_BASE_RPC_URL
  );
}

export function encodeErc20TransferToTopic(walletAddress: string) {
  const normalized = normalizeEvmAddress(walletAddress);
  return `0x${normalized.slice(2).padStart(64, "0")}`;
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
  fetchImpl: JsonRpcFetch,
  timeoutMs: number
): Promise<T> {
  let response: Awaited<ReturnType<JsonRpcFetch>>;
  try {
    response = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const name = (error as { name?: unknown } | null)?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      // A network-level failure, like fetch's own TypeError: retryable.
      throw new TypeError(`Base RPC ${method} timed out after ${timeoutMs} ms`);
    }
    throw error;
  }

  if (!response.ok) {
    const httpError = new RpcHttpError(response.status);
    // 429/5xx are retried by the shared layer; anything else is deterministic,
    // so name the provider's reason instead of only the status.
    if (isRetryableRpcError(httpError)) throw httpError;
    const detail = await readRpcErrorDetail(response);
    throw new Error(`Base RPC ${method} failed with status ${response.status}${detail ? `: ${detail}` : ""}`);
  }

  const payload = (await response.json()) as JsonRpcResponse;
  if (payload.error) {
    throw new Error(`Base RPC ${method} returned an error: ${payload.error.message || "unknown RPC error"}`);
  }

  return payload.result as T;
}

// ── Chain reader (cached per reconcile batch) ────────────────────────────

export interface BaseChainReader {
  call<T>(method: string, params: unknown[]): Promise<T>;
  latestBlock(): Promise<number>;
  // Block timestamp in unix seconds.
  blockTimestamp(block: number): Promise<number>;
}

export function createBaseChainReader(params: {
  rpcUrl?: string;
  fetchImpl?: JsonRpcFetch;
  rpcOptions?: RpcCallOptions;
  requestTimeoutMs?: number;
}): BaseChainReader {
  const rpcUrl = params.rpcUrl || getBaseRpcUrl();
  const fetchImpl = params.fetchImpl || (fetch as unknown as JsonRpcFetch);
  const timeoutMs = params.requestTimeoutMs ?? DEFAULT_RPC_REQUEST_TIMEOUT_MS;
  let latest: Promise<number> | null = null;
  const timestamps = new Map<number, Promise<number>>();
  const call = <T>(method: string, args: unknown[]) =>
    withRpcRetry<T>(() => rpcCallOnce<T>(rpcUrl, method, args, fetchImpl, timeoutMs), params.rpcOptions);

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
export async function findBlockForTimestamp(
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

export interface ScannedTransfer {
  transactionHash: string;
  logIndex: number;
  blockNumber: number;
  blockHash: string | null;
  amount: bigint;
  confirmations: number;
  timestampMs: number;
  observedAt: string;
}

export interface TransferWindowScan {
  // Transfers in chain order (block, then log index), timestamps attached.
  transfers: ScannedTransfer[];
  // Every block at or before this time has >= minConfirmations.
  confirmedHeadMs: number;
}

/**
 * Every non-zero `tokenAddress` Transfer to `toAddress` mined between
 * `fromMs` and `toMs` (inclusive, by block timestamp; the range end is capped
 * at the chain head). Callers filter by exact timestamps; the block range is
 * padded on the safe side.
 */
export async function scanErc20TransfersInWindow(params: {
  chain: BaseChainReader;
  tokenAddress: string;
  toAddress: string;
  fromMs: number;
  toMs: number;
  minConfirmations: number;
}): Promise<TransferWindowScan> {
  const { chain } = params;
  const tokenAddress = normalizeEvmAddress(params.tokenAddress);
  const latest = await chain.latestBlock();
  const latestSec = await chain.blockTimestamp(latest);
  const fromBlock =
    (await findBlockForTimestamp(chain, {
      targetSec: Math.floor(params.fromMs / 1000),
      side: "floor",
      latest,
      latestSec,
    })) ?? 0;
  const endBlock = await findBlockForTimestamp(chain, {
    targetSec: Math.ceil(params.toMs / 1000),
    side: "ceil",
    latest,
    latestSec,
  });
  const toBlock = Math.max(fromBlock, endBlock ?? latest);
  if (toBlock - fromBlock + 1 > MAX_SCAN_SPAN_BLOCKS) {
    throw new Error(`Transfer scan span of ${toBlock - fromBlock + 1} blocks exceeds ${MAX_SCAN_SPAN_BLOCKS}`);
  }

  const toTopic = encodeErc20TransferToTopic(params.toAddress);
  const logs = await getLogsInBlockChunks<EvmLog>({
    call: chain.call,
    filter: { address: tokenAddress, topics: [ERC20_TRANSFER_TOPIC, null, toTopic] },
    fromBlock,
    toBlock,
  });

  const parsed = new Map<
    string,
    Omit<ScannedTransfer, "timestampMs" | "observedAt"> & { logTimestampSec: number | null }
  >();
  for (const log of logs) {
    // Per-log try/catch: one malformed entry (a null blockNumber on a reorged
    // log from a flaky proxy) must not throw away the rest of the scan.
    try {
      const address = typeof log.address === "string" ? normalizeEvmAddress(log.address) : "";
      const transactionHash =
        typeof log.transactionHash === "string" ? log.transactionHash.trim().toLowerCase() : "";
      if (address !== tokenAddress || !transactionHash) continue;
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
        blockHash: typeof log.blockHash === "string" ? log.blockHash : null,
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
    [...parsed.values()].filter((entry) => entry.logTimestampSec === null).map((entry) => entry.blockNumber)
  );
  if (blocksToFetch.size > MAX_TRANSFER_TIMESTAMP_LOOKUPS) {
    throw new Error(
      `Transfer scan found transfers in ${blocksToFetch.size} blocks; refusing to look up more than ${MAX_TRANSFER_TIMESTAMP_LOOKUPS}`
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

  const confirmedHead = latest - params.minConfirmations + 1;
  const confirmedHeadMs =
    confirmedHead >= 0 ? (await chain.blockTimestamp(confirmedHead)) * 1000 : Number.NEGATIVE_INFINITY;

  return { transfers, confirmedHeadMs };
}
