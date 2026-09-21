// Shared Base-RPC resilience layer.
//
// The shared/public Base RPC endpoint (https://mainnet.base.org) rate-limits
// (HTTP 429) once a cron tick fans many eth_* calls across the fleet's users in
// a tight loop. Without protection a single 429 throws straight out of the
// per-call helper and surfaces as a "failed" — e.g. a managed-Venice deposit
// silently went uncredited, or a holder's token-tier/holdings refresh was
// skipped this tick (and could even drop their tier on a transient blip).
//
// This module is the SINGLE source of that resilience so every Base RPC path
// shares one tested implementation:
//   (1) retry with exponential backoff + full jitter on transient errors
//       (429 / 5xx / raw network failure), and
//   (2) fail fast on deterministic errors (bad params, decode errors, a
//       JSON-RPC error body, a 4xx that isn't 429) — retrying those just burns
//       the rate-limit budget without changing the outcome.
// Callers add a small inter-call throttle of their own to keep the per-tick
// request rate under the public endpoint's threshold. Read-only — no
// crediting/tier/balance logic lives here.

const DEFAULT_RPC_MAX_ATTEMPTS = 4;
const DEFAULT_RPC_BASE_DELAY_MS = 250;
const DEFAULT_RPC_MAX_DELAY_MS = 4_000;

export interface RpcRetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

const DEFAULT_RPC_RETRY_CONFIG: RpcRetryConfig = {
  maxAttempts: DEFAULT_RPC_MAX_ATTEMPTS,
  baseDelayMs: DEFAULT_RPC_BASE_DELAY_MS,
  maxDelayMs: DEFAULT_RPC_MAX_DELAY_MS,
};

export function normalizeRpcRetryConfig(
  config?: Partial<RpcRetryConfig>
): RpcRetryConfig {
  const rawMaxAttempts = config?.maxAttempts;
  const rawBaseDelayMs = config?.baseDelayMs;
  const rawMaxDelayMs = config?.maxDelayMs;

  const maxAttempts =
    typeof rawMaxAttempts === "number" && Number.isFinite(rawMaxAttempts)
      ? Math.max(1, Math.min(10, Math.floor(rawMaxAttempts)))
      : DEFAULT_RPC_RETRY_CONFIG.maxAttempts;
  const baseDelayMs =
    typeof rawBaseDelayMs === "number" && Number.isFinite(rawBaseDelayMs)
      ? Math.max(0, Math.floor(rawBaseDelayMs))
      : DEFAULT_RPC_RETRY_CONFIG.baseDelayMs;
  const maxDelayMs =
    typeof rawMaxDelayMs === "number" && Number.isFinite(rawMaxDelayMs)
      ? Math.max(baseDelayMs, Math.floor(rawMaxDelayMs))
      : Math.max(baseDelayMs, DEFAULT_RPC_RETRY_CONFIG.maxDelayMs);
  return { maxAttempts, baseDelayMs, maxDelayMs };
}

// Distinguishable HTTP-level RPC failure so the retry layer can tell a 429/5xx
// (retry) apart from a JSON-RPC error body or a 4xx (don't retry). The message
// is intentionally stable ("Base RPC request failed with status N") so existing
// ops_events / log assertions on the text keep matching.
export class RpcHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Base RPC request failed with status ${status}`);
    this.name = "RpcHttpError";
    this.status = status;
  }
}

// A transient error is one worth retrying: rate-limits (429), server-side
// faults (5xx), and raw network failures (fetch rejects with a TypeError, no
// HTTP status at all). Deterministic failures (bad params, decode errors, a
// JSON-RPC error body, 4xx that isn't 429) are NOT retried — retrying them
// just burns the rate-limit budget without changing the outcome.
export function isRetryableRpcError(error: unknown): boolean {
  if (error instanceof RpcHttpError) {
    return error.status === 429 || error.status >= 500;
  }
  // Network-level failures (DNS, connection reset, fetch abort) reject with a
  // TypeError or AbortError rather than producing a response. Treat those as
  // transient too.
  if (error instanceof TypeError) return true;
  if (
    error instanceof Error &&
    /network|fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(
      error.message
    )
  ) {
    return true;
  }
  return false;
}

// Exponential backoff with full jitter (capped). Full jitter avoids a
// thundering-herd retry alignment when several calls back off at once.
export function computeBackoffDelayMs(
  attempt: number,
  config: RpcRetryConfig,
  random: () => number = Math.random
): number {
  const exponential = Math.min(
    config.maxDelayMs,
    config.baseDelayMs * 2 ** Math.max(0, attempt - 1)
  );
  // Full jitter: a random point in [0, exponential]. Floor at baseDelayMs so a
  // tiny random draw doesn't collapse the wait to ~0 and immediately re-hammer.
  return Math.max(config.baseDelayMs, Math.floor(random() * exponential));
}

export function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RpcCallOptions {
  retryConfig?: RpcRetryConfig;
  sleepImpl?: (ms: number) => Promise<void>;
  random?: () => number;
}

// Run a single RPC operation with retry + exponential backoff + jitter. The
// `operation` should perform exactly one attempt and throw an RpcHttpError on a
// non-OK HTTP status (so 429/5xx can be classified) or a plain Error for a
// deterministic failure (so it is NOT retried). On exhaustion or a
// non-transient error the ORIGINAL error is re-thrown so callers still see the
// real cause (e.g. "Base RPC request failed with status 429").
export async function withRpcRetry<T>(
  operation: () => Promise<T>,
  options: RpcCallOptions = {}
): Promise<T> {
  const config = options.retryConfig ?? DEFAULT_RPC_RETRY_CONFIG;
  const sleepImpl = options.sleepImpl ?? sleep;
  const random = options.random ?? Math.random;

  let lastError: unknown;
  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= config.maxAttempts || !isRetryableRpcError(error)) {
        throw error;
      }
      await sleepImpl(computeBackoffDelayMs(attempt, config, random));
    }
  }

  // Unreachable in practice (the loop either returns or throws), but keeps the
  // type checker happy and preserves the original error if it ever is hit.
  throw lastError instanceof Error
    ? lastError
    : new Error("Base RPC request failed");
}
