/**
 * Window-anchored ERC-20 transfer scanning on Base.
 *
 * A payment quote is paid by a specific Transfer log into the deposit wallet,
 * not by the wallet's balance: the user's credit_deposit wallet is shared by
 * every $HermesOS payment flow. This module reads the Transfer logs into an
 * address over a TIME range (the quote's own window), however late the
 * reconciler gets to it, instead of "the latest N blocks".
 *
 * Mirrors the managed-Venice reconciler's scan (claude/venice-settlement-fixes):
 *   - timestamps map to blocks by a 2 s/block estimate verified with
 *     eth_getBlockByNumber (iterative correction, bisection fallback);
 *   - eth_getLogs runs in chunks of <= 2,000 blocks (the public endpoint's
 *     limit);
 *   - the head and block timestamps are cached per chain reader, so a batch
 *     shares them;
 *   - zero-value transfers (address-poisoning spam) and self-transfers are
 *     ignored.
 */

import {
  withRpcRetry,
  RpcHttpError,
  type RpcCallOptions,
} from "@/lib/billing/base-rpc-retry";
import {
  ERC20_TRANSFER_TOPIC,
  encodeErc20TransferToTopic,
} from "@/lib/billing/crypto-reconciliation";
import { normalizeEvmAddress } from "@/lib/billing/token-holdings";

export type JsonRpcFetch = (
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
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface EvmLog {
  address?: unknown;
  topics?: unknown[];
  data?: unknown;
  transactionHash?: unknown;
  logIndex?: unknown;
  blockNumber?: unknown;
  blockTimestamp?: unknown;
}

interface EvmBlock {
  timestamp?: unknown;
}

const DEFAULT_BASE_RPC_URL = "https://mainnet.base.org";
// Base's public RPC rejects eth_getLogs ranges above 2,000 blocks (HTTP 413,
// JSON-RPC -32614). Keep every chunk at the provider limit.
const MAX_BASE_RPC_LOG_RANGE_BLOCKS = 2_000;
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
// Bound per-scan RPC work: a quote window + late-payment grace is ~4,200
// blocks with a handful of transfers; anything far above that is refused.
const MAX_SCAN_SPAN_BLOCKS = 50_000;
const MAX_TRANSFER_TIMESTAMP_LOOKUPS = 200;

export function getBaseRpcUrl(env: Record<string, string | undefined> = process.env) {
  return env.HERMES_BASE_RPC_URL?.trim() || env.BASE_RPC_URL?.trim() || DEFAULT_BASE_RPC_URL;
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

async function rpcCallOnce<T>(rpcUrl: string, method: string, params: unknown[], fetchImpl: JsonRpcFetch) {
  const response = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) {
    // Typed so the retry layer retries 429 / 5xx and nothing else.
    throw new RpcHttpError(response.status);
  }
  const payload = (await response.json()) as JsonRpcResponse;
  if (payload.error) {
    // A JSON-RPC error body is deterministic: surfaced, not retried.
    throw new Error(`Base RPC ${method} returned an error: ${payload.error.message || "unknown RPC error"}`);
  }
  return payload.result as T;
}

export interface BaseChainReader {
  call<T>(method: string, params: unknown[]): Promise<T>;
  latestBlock(): Promise<number>;
  /** Block timestamp in unix seconds. */
  blockTimestamp(block: number): Promise<number>;
}

export function createBaseChainReader(params: {
  rpcUrl?: string;
  fetchImpl?: JsonRpcFetch;
  rpcOptions?: RpcCallOptions;
} = {}): BaseChainReader {
  const rpcUrl = params.rpcUrl || getBaseRpcUrl();
  const fetchImpl = params.fetchImpl || (fetch as unknown as JsonRpcFetch);
  let latest: Promise<number> | null = null;
  const timestamps = new Map<number, Promise<number>>();
  const call = <T>(method: string, args: unknown[]) =>
    withRpcRetry<T>(() => rpcCallOnce<T>(rpcUrl, method, args, fetchImpl), params.rpcOptions);

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
  const isPast = (timestampSec: number) => (side === "floor" ? timestampSec > targetSec : timestampSec >= targetSec);
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

export interface ScannedTransfer {
  transactionHash: string;
  logIndex: number;
  blockNumber: number;
  amount: bigint;
  confirmations: number;
  timestampMs: number;
  observedAt: string;
}

export interface TransferScan {
  /** Transfers mined in [fromMs, toMs], in chain order. */
  transfers: ScannedTransfer[];
  /** Timestamp of the newest block with >= minConfirmations. */
  confirmedHeadMs: number;
}

/**
 * Every Transfer of `tokenAddress` into `recipient` mined in [fromMs, toMs]
 * (block time), in chain order, with its confirmation count.
 */
export async function scanTokenTransfersTo(params: {
  chain: BaseChainReader;
  tokenAddress: string;
  recipient: string;
  fromMs: number;
  toMs: number;
  minConfirmations: number;
}): Promise<TransferScan> {
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

  const toTopic = encodeErc20TransferToTopic(params.recipient);
  const logs: EvmLog[] = [];
  for (let chunkStart = fromBlock; chunkStart <= toBlock; chunkStart += MAX_BASE_RPC_LOG_RANGE_BLOCKS) {
    const chunkEnd = Math.min(toBlock, chunkStart + MAX_BASE_RPC_LOG_RANGE_BLOCKS - 1);
    const chunkLogs = await chain.call<EvmLog[]>("eth_getLogs", [
      {
        address: tokenAddress,
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
      if (address !== tokenAddress || !transactionHash) continue;
      if (typeof log.topics?.[2] !== "string" || log.topics[2].toLowerCase() !== toTopic) continue;
      const amount = decodeUint256LogData(log.data);
      // Zero-value Transfer events are address-poisoning spam, not payments.
      if (amount <= 0n) continue;
      if (typeof log.topics?.[1] === "string" && log.topics[1].toLowerCase() === toTopic) continue; // self-transfer
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
    const timestampMs = timestampSec * 1000;
    // The block range is padded on the safe side; keep only the time range.
    if (timestampMs < params.fromMs || timestampMs > params.toMs) continue;
    transfers.push({ ...transfer, timestampMs, observedAt: new Date(timestampMs).toISOString() });
  }
  transfers.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);

  // Every block at or below the confirmed head has >= minConfirmations.
  const confirmedHead = latest - params.minConfirmations + 1;
  const confirmedHeadMs =
    confirmedHead >= 0 ? (await chain.blockTimestamp(confirmedHead)) * 1000 : Number.NEGATIVE_INFINITY;

  return { transfers, confirmedHeadMs };
}
