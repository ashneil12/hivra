// Shared, range-limited eth_getLogs for Base.
//
// Base's public RPC (https://mainnet.base.org, the default when neither
// HERMES_BASE_RPC_URL nor BASE_RPC_URL is set) rejects any eth_getLogs range
// wider than 2,000 blocks with HTTP 413 / JSON-RPC -32614 ("eth_getLogs is
// limited to a 2,000 range"). The managed-Venice reconciler was fixed for this
// with its own chunk loop, but the USDC top-up reconciler kept one 5,000-block
// call, so every pending top-up failed every cron tick while the cron still
// returned 200. Every Base log scan goes through getLogsInBlockChunks so the
// limit lives in one place; a guard test fails if any other module issues
// eth_getLogs directly.
//
// Transport-agnostic: callers pass their own single-request RPC function, which
// owns retry (withRpcRetry from @/lib/billing/base-rpc-retry). Retrying here as
// well would multiply attempts. Read-only — no crediting logic lives here.

export const MAX_BASE_RPC_LOG_RANGE_BLOCKS = 2_000;

export type BaseRpcCall = <T>(method: string, params: unknown[]) => Promise<T>;

export interface BaseLogFilter {
  address: string;
  topics: Array<string | null>;
}

function rpcQuantity(value: number) {
  return `0x${value.toString(16)}`;
}

function assertBlockNumber(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid Base log scan ${label}: ${value}`);
  }
}

/**
 * Every log matching `filter` in blocks `fromBlock`..`toBlock` (inclusive),
 * fetched in sequential eth_getLogs requests of at most
 * MAX_BASE_RPC_LOG_RANGE_BLOCKS blocks each. Both bounds are concrete block
 * numbers — never "latest" — so a request can never span more than the limit
 * and every chunk sees the same chain head the caller measured confirmations
 * against.
 */
export async function getLogsInBlockChunks<TLog>(params: {
  call: BaseRpcCall;
  filter: BaseLogFilter;
  fromBlock: number;
  toBlock: number;
}): Promise<TLog[]> {
  assertBlockNumber(params.fromBlock, "fromBlock");
  assertBlockNumber(params.toBlock, "toBlock");
  if (params.toBlock < params.fromBlock) {
    throw new Error(
      `Invalid Base log scan range: fromBlock ${params.fromBlock} is after toBlock ${params.toBlock}`
    );
  }

  const logs: TLog[] = [];
  for (
    let chunkStart = params.fromBlock;
    chunkStart <= params.toBlock;
    chunkStart += MAX_BASE_RPC_LOG_RANGE_BLOCKS
  ) {
    const chunkEnd = Math.min(
      params.toBlock,
      chunkStart + MAX_BASE_RPC_LOG_RANGE_BLOCKS - 1
    );
    const chunkLogs = await params.call<TLog[]>("eth_getLogs", [
      {
        address: params.filter.address,
        fromBlock: rpcQuantity(chunkStart),
        toBlock: rpcQuantity(chunkEnd),
        topics: params.filter.topics,
      },
    ]);

    if (Array.isArray(chunkLogs)) logs.push(...chunkLogs);
  }

  return logs;
}
