/**
 * Observability for the platform-token price gates (price-feed.ts).
 *
 * A gate refusing a quote is expected, fail-closed behaviour, and the user
 * gets a 503 "try again later". On a launch day it is also the signal that a
 * pool is thin, pumped or not indexed yet, so each refusal the quote routes
 * return becomes:
 *
 *   1. A structured warn log, "Price gate refused a token quote", with the
 *      route, the token, the gate reason and the observed values. At most one
 *      line per token and reason per PRICE_GATE_LOG_INTERVAL_MS (a minute) in this
 *      server process;
 *      the next line says how many refusals it folded in
 *      (`refusalsSinceLastLog`), so a burst stays countable without a flood.
 *   2. An ops alert: a severity-warn ops_events row, shown on /dashboard/ops
 *      and in the /api/ops/events/feed alert feed. At most one per token per
 *      PRICE_GATE_ALERT_INTERVAL_MS (30 minutes) from this process, and the row's fingerprint names the
 *      30-minute clock window, so other server processes in the same window
 *      count into that row instead of opening another. It does not page:
 *      email and Telegram paging is reserved for fatal ops events.
 *
 * Log and metadata keys avoid the word "token": the logger's sanitizer
 * redacts any key that contains it, so the token is logged as `asset`.
 */
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";

import { priceGateRefusalFromError, type PriceGateRefusal } from "./price-feed";

export const PRICE_GATE_LOG_INTERVAL_MS = 60_000;
export const PRICE_GATE_ALERT_INTERVAL_MS = 30 * 60_000;
export const PRICE_GATE_ALERT_SOURCE = "billing/price-gate";

export interface PriceGateRefusalContext {
  /** The quote route's log source, e.g. "billing/wallet-quote". */
  source: string;
  route: string;
  method?: string;
}

interface LogState {
  lastLoggedAtMs: number;
  refusalsSinceLastLog: number;
}

const logStateByKey = new Map<string, LogState>();
const lastAlertAtMsByAsset = new Map<string, number>();

/** Test seam. */
export function _resetPriceGateAlertStateForTests() {
  logStateByKey.clear();
  lastAlertAtMsByAsset.clear();
}

const UNKNOWN_REFUSAL: PriceGateRefusal = {
  assetKey: "unknown",
  asset: "unknown",
  reason: "feed_error",
  gate: "unknown",
  observed: {},
};

/**
 * Log and alert on a quote a price gate refused. Call it where the route
 * returns its 503; it never throws. Returns what it emitted, for tests.
 */
export async function reportPriceGateRefusal(
  error: unknown,
  context: PriceGateRefusalContext,
  nowMs: number = Date.now()
): Promise<{ refusal: PriceGateRefusal; logged: boolean; alerted: boolean }> {
  const refusal = priceGateRefusalFromError(error) ?? UNKNOWN_REFUSAL;
  let logged = false;
  let alerted = false;
  try {
    logged = logRefusal(refusal, context, nowMs);
    alerted = await alertRefusal(refusal, context, nowMs);
  } catch {
    // Observability must never turn a clean 503 into a 500.
  }
  return { refusal, logged, alerted };
}

function logRefusal(refusal: PriceGateRefusal, context: PriceGateRefusalContext, nowMs: number): boolean {
  const key = `${refusal.assetKey}:${refusal.reason}`;
  const state = logStateByKey.get(key);
  if (state && nowMs - state.lastLoggedAtMs < PRICE_GATE_LOG_INTERVAL_MS) {
    state.refusalsSinceLastLog += 1;
    return false;
  }
  log.warn("Price gate refused a token quote", {
    source: context.source,
    route: context.route,
    method: context.method,
    failureType: "price_gate_refused",
    asset: refusal.asset,
    assetKey: refusal.assetKey,
    gateReason: refusal.reason,
    gate: refusal.gate,
    observed: refusal.observed,
    // Refusals of this token for this reason that this process folded into
    // this line since the previous one (0 for the first).
    refusalsSinceLastLog: state?.refusalsSinceLastLog ?? 0,
  });
  logStateByKey.set(key, { lastLoggedAtMs: nowMs, refusalsSinceLastLog: 0 });
  return true;
}

async function alertRefusal(refusal: PriceGateRefusal, context: PriceGateRefusalContext, nowMs: number): Promise<boolean> {
  const lastAlertAtMs = lastAlertAtMsByAsset.get(refusal.assetKey);
  if (lastAlertAtMs !== undefined && nowMs - lastAlertAtMs < PRICE_GATE_ALERT_INTERVAL_MS) return false;
  lastAlertAtMsByAsset.set(refusal.assetKey, nowMs);
  const windowStart = new Date(nowMs - (nowMs % PRICE_GATE_ALERT_INTERVAL_MS)).toISOString();
  // Title and message are stable within the window (no reason, route or user),
  // so every process's alert for this token in the window is the same row.
  const reported = await reportOpsEvent({
    source: PRICE_GATE_ALERT_SOURCE,
    severity: "warn",
    title: `${refusal.asset} quotes refused by a price gate`,
    message: `A price gate refused ${refusal.asset} quotes in the 30-minute window from ${windowStart}. Quotes stay closed until the gate passes; card payment is unaffected. The metadata has the first refusal's gate, reason and observed values.`,
    metadata: {
      asset: refusal.asset,
      assetKey: refusal.assetKey,
      gateReason: refusal.reason,
      gate: refusal.gate,
      observed: refusal.observed,
      quoteSource: context.source,
      quoteRoute: context.route,
      windowStart,
    },
  });
  // Null when ops_events is unavailable (no Supabase admin client) or the write failed.
  return reported !== null;
}
