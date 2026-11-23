// Shared, range-limited eth_getLogs for Base.
//
// Base's public RPC (https://mainnet.base.org, the default when neither
// HERMES_BASE_RPC_URL nor BASE_RPC_URL is set) rejects any eth_getLogs range
// wider than its live cap — HTTP 413 / JSON-RPC -32614 ("eth_getLogs is
// limited to a N range"). The cap moves: it was 2,000 blocks, then 1,000,
// then a few hundred. MAX_BASE_RPC_LOG_RANGE_BLOCKS stays the configured
// ceiling; when a provider refuses a range the stated cap is parsed from the
// error and the remaining range is re-tiled at that size, remembered per
// endpoint for a bounded window so later scans start there instead of paying
// one refused request per chunk.
//
// The managed-Venice reconciler was fixed for this with its own chunk loop,
// but the USDC top-up reconciler kept one 5,000-block call, so every pending
// top-up failed every cron tick while the cron still returned 200. Every
// Base log scan goes through getLogsInBlockChunks so the limit lives in one
// place; a guard test fails if any other module issues eth_getLogs directly.
//
// Transport-agnostic: callers pass their own single-request RPC function, which
// owns retry (withRpcRetry from @/lib/billing/base-rpc-retry). Retrying here as
// well would multiply attempts. Read-only — no crediting logic lives here.

export const MAX_BASE_RPC_LOG_RANGE_BLOCKS = 2_000;

// How long a discovered cap is trusted before it is re-probed. The cap a
// provider enforces is load-dependent (Base's public endpoint answered 2,000,
// then 1,000, then a few hundred over days), so a span confirmed during a
// degraded window must not pin every later scan at the degraded size for the
// life of the process — a serverless warm pool can live for hours.
const DISCOVERED_LOG_RANGE_CAP_TTL_MS = 60 * 60_000;

// The smallest span this process has had to fall back to after a provider
// range-cap refusal, keyed by endpoint: different providers enforce different
// caps, so a cap learned on one URL must not shrink another's scans. A cap is
// recorded only once a request at that span has actually SUCCEEDED — a
// provider that refuses every range down to a single block proves nothing
// about the span it will accept once it recovers, so a refusal alone must
// never shrink the remembered cap (otherwise one fully-degraded window would
// leave every later scan doing 2,000 one-block requests). Entries expire
// after the TTL and are re-learned on the next refusal.
const discoveredLogRangeCaps = new Map<string, { blocks: number; confirmedAtMs: number }>();

// Test hook: the discovered caps are process state and would otherwise leak
// between cases in the same worker.
export function resetDiscoveredBaseLogRangeCap() {
  discoveredLogRangeCaps.clear();
}

function logRangeCapKey(endpoint: string | undefined) {
  return endpoint ?? "";
}

// The confirmed cap for this endpoint, or null when none was learned (or the
// learned one aged out — expiry deletes so the next scan re-probes at the
// configured ceiling).
function rememberedLogRangeCap(endpoint: string | undefined) {
  const key = logRangeCapKey(endpoint);
  const cap = discoveredLogRangeCaps.get(key);
  if (!cap) return null;
  if (Date.now() - cap.confirmedAtMs >= DISCOVERED_LOG_RANGE_CAP_TTL_MS) {
    discoveredLogRangeCaps.delete(key);
    return null;
  }
  return cap.blocks;
}

function noteDiscoveredLogRangeCap(endpoint: string | undefined, blocks: number) {
  const key = logRangeCapKey(endpoint);
  const existing = discoveredLogRangeCaps.get(key);
  const stillFresh = existing && Date.now() - existing.confirmedAtMs < DISCOVERED_LOG_RANGE_CAP_TTL_MS;
  // Within the window the cap only shrinks (a provider that once refused
  // 500-block ranges is assumed to keep refusing them); past it, the new
  // confirmation replaces the stale value.
  discoveredLogRangeCaps.set(key, {
    blocks: stillFresh ? Math.min(existing.blocks, blocks) : blocks,
    confirmedAtMs: Date.now(),
  });
}

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

// A provider refusing a range because its RESULT is too big (a flood of
// matching logs), as opposed to any other failure. Such a range is split in
// half and fetched again, down to a single block, so a spray of transfers into
// a deposit address cannot stall its scan.
function isOversizedLogResult(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /more than \d+ results|too many results|query returned more than|response size|result window|log response size exceeded|-32005/i.test(
    error.message
  );
}

// A provider refusing a range because the SPAN itself is too wide. The public
// endpoint answers HTTP 413 whose body is a JSON-RPC -32614 error, surfaced
// through the callers' RPC wrappers as text like "Base RPC eth_getLogs failed
// with status 413: eth_getLogs is limited to a 200 range" or "Base RPC
// eth_getLogs returned an error: eth_getLogs is limited to a 1,000 range".
// The stated number is parsed when present (the cap moves, so trusting the
// configured ceiling alone fails); without one the range is halved, matching
// the reference probe in the money-path triage tooling.
function matchLogRangeCap(error: unknown): { statedBlocks: number | null } | null {
  if (!(error instanceof Error)) return null;
  const message = error.message;
  const stated = /limited to a ([\d,]+) range/i.exec(message);
  if (stated) {
    const blocks = Number(stated[1].replace(/,/g, ""));
    return { statedBlocks: Number.isSafeInteger(blocks) && blocks > 0 ? blocks : null };
  }
  // Unstated cap: the JSON-RPC range-limit code — carried as a structured
  // property by the RPC wrappers (and rendered into the message) — or
  // "limited to a ... range" phrased without a number. "limited to a" alone
  // is not enough — rate-limit messages use it too ("limited to a certain
  // number of requests").
  const rpcCode = (error as { code?: unknown }).code;
  if (rpcCode === -32614 || /-32614\b/.test(message) || /limited to a\b[^.;]*\brange\b/i.test(message)) {
    return { statedBlocks: null };
  }
  return null;
}

/**
 * Every log matching `filter` in blocks `fromBlock`..`toBlock` (inclusive),
 * fetched in sequential eth_getLogs requests of at most
 * MAX_BASE_RPC_LOG_RANGE_BLOCKS blocks each. Both bounds are concrete block
 * numbers — never "latest" — so a request can never span more than the limit
 * and every chunk sees the same chain head the caller measured confirmations
 * against.
 *
 * `endpoint` identifies the RPC endpoint the discovered range cap is scoped
 * to (the provider URL is the natural key); callers that pass none share a
 * single cap, matching the original global behaviour.
 *
 * `onChunk`, when given, is awaited after each top-level chunk is fully
 * answered, in order, with the chunk's inclusive end block and its logs. It
 * exists so a bounded caller can checkpoint resumable coverage: once the
 * callback returns, every block in `fromBlock..chunkEndBlock` has been
 * answered. A chunk that throws — including a cooperative abort raised inside
 * the caller's `call` — never fires the callback, so an interrupted scan's
 * last checkpointed block is always one it actually covered.
 */
export async function getLogsInBlockChunks<TLog>(params: {
  call: BaseRpcCall;
  filter: BaseLogFilter;
  fromBlock: number;
  toBlock: number;
  endpoint?: string;
  onChunk?: (chunkEndBlock: number, chunkLogs: TLog[]) => void | Promise<void>;
}): Promise<TLog[]> {
  assertBlockNumber(params.fromBlock, "fromBlock");
  assertBlockNumber(params.toBlock, "toBlock");
  if (params.toBlock < params.fromBlock) {
    throw new Error(
      `Invalid Base log scan range: fromBlock ${params.fromBlock} is after toBlock ${params.toBlock}`
    );
  }

  const fetchRange = async (from: number, to: number, confirmSpanAsCap = false): Promise<TLog[]> => {
    let rangeLogs: TLog[];
    try {
      rangeLogs = await params.call<TLog[]>("eth_getLogs", [
        {
          address: params.filter.address,
          fromBlock: rpcQuantity(from),
          toBlock: rpcQuantity(to),
          topics: params.filter.topics,
        },
      ]);
    } catch (error) {
      if (to > from && isOversizedLogResult(error)) {
        const mid = from + Math.floor((to - from) / 2);
        return [...(await fetchRange(from, mid)), ...(await fetchRange(mid + 1, to))];
      }
      // A range-cap refusal re-tiles the SAME range at the discovered (or
      // halved) span: contiguous tile-sized subranges cover it exactly once,
      // so no block is skipped or fetched twice, and a served tile's span is
      // remembered for every later chunk and scan on this endpoint.
      const cap = to > from ? matchLogRangeCap(error) : null;
      if (cap) {
        const span = to - from + 1;
        const tile =
          cap.statedBlocks !== null && cap.statedBlocks < span
            ? cap.statedBlocks
            : Math.floor(span / 2);
        if (tile < 1) throw error;
        const retiled: TLog[] = [];
        let subStart = from;
        while (subStart <= to) {
          const subEnd = Math.min(to, subStart + tile - 1);
          // A full tile that the provider then SERVES is the only proof a
          // smaller cap exists — a partial tail tile says nothing about the
          // tile size, and a provider that keeps refusing down to one block
          // leaves the remembered cap alone.
          retiled.push(...(await fetchRange(subStart, subEnd, subEnd - subStart + 1 === tile)));
          subStart = subEnd + 1;
        }
        return retiled;
      }
      throw error;
    }
    // A successful eth_getLogs always returns an array. Anything else is a
    // broken provider response; treating it as "no logs" could hide a payment.
    if (!Array.isArray(rangeLogs)) {
      throw new Error("Invalid eth_getLogs result from Base RPC");
    }
    if (confirmSpanAsCap) {
      noteDiscoveredLogRangeCap(params.endpoint, to - from + 1);
    }
    return rangeLogs;
  };

  const logs: TLog[] = [];
  let chunkStart = params.fromBlock;
  while (chunkStart <= params.toBlock) {
    // The configured ceiling, shrunk to the cap this endpoint confirmed on an
    // earlier refusal (within the TTL), so later chunks never pay for a
    // request we know the provider will reject.
    const chunkBlocks = Math.min(
      MAX_BASE_RPC_LOG_RANGE_BLOCKS,
      rememberedLogRangeCap(params.endpoint) ?? MAX_BASE_RPC_LOG_RANGE_BLOCKS
    );
    const chunkEnd = Math.min(params.toBlock, chunkStart + chunkBlocks - 1);
    const chunkLogs = await fetchRange(chunkStart, chunkEnd);
    await params.onChunk?.(chunkEnd, chunkLogs);
    logs.push(...chunkLogs);
    chunkStart = chunkEnd + 1;
  }

  return logs;
}
