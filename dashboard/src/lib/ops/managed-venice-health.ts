import type { OpsEventInput } from "@/lib/ops-events";
import { parseManagedVeniceInferenceKeys } from "@/lib/venice/upstream-keys";

// Managed-Venice upstream-health detectors.
//
// Why this exists: in Jul-2026 the upstream Venice account hit $0 and every
// managed completion 402'd for FIVE DAYS before anyone noticed. The existing
// usage-flatline monitor (cron/monitor-managed-venice-usage) watches the
// usage_events stream, but usage events only exist for requests that SETTLE —
// a dead upstream produces reservations that are created and immediately
// released, never captured, so the settled stream just looks "quiet" until the
// baseline decays. These detectors watch the failure directly:
//
//  1. Capture drought (primary, provider-agnostic): reservations are being
//     CREATED (users are trying) but nothing is being CAPTURED (nothing
//     succeeds). Reads managed_venice_reservations only. This fires on ANY
//     total upstream failure — dead key, $0 balance, DNS, a Venice-side
//     rejection class — because they all share the same signature: the chat
//     routes release every reservation instead of capturing it.
//
//  2. Direct upstream probe (secondary): one GET against Venice's key
//     rate-limits/balance introspection endpoint per cron run (free — no
//     inference cost). A 402 or a revoked key is a definitive upstream-billing
//     failure even before any user traffic arrives, and the response exposes
//     the remaining USD balance so we can warn BEFORE it hits zero.

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Sliding window the drought detector looks back over. */
export const DEFAULT_WINDOW_HOURS = 6;
/** Minimum attempts (reservations created) before 0 captures is CRITICAL. */
export const DEFAULT_MIN_ATTEMPTS = 3;
/** Minimum attempts before a degraded capture ratio is worth a WARN. */
export const DEFAULT_WARN_MIN_ATTEMPTS = 5;
/** Capture ratio below which (with enough attempts) we WARN. */
export const DEFAULT_WARN_CAPTURE_RATIO = 0.25;
/**
 * Reservations younger than this are ignored entirely: a chat request settles
 * within seconds, but a burst of brand-new still-active holds would otherwise
 * read as "attempts with zero captures" and false-page mid-stream.
 */
export const DEFAULT_SETTLE_GRACE_MINUTES = 10;
/** Don't re-emit an identical (same-fingerprint) event more often than this. */
export const DEFAULT_DEDUPE_HOURS = 6;
/** Upstream USD balance below which the probe raises an early WARN. */
export const DEFAULT_MIN_UPSTREAM_BALANCE_USD = 5;

export interface ManagedVeniceHealthConfig {
  windowHours: number;
  minAttempts: number;
  warnMinAttempts: number;
  warnCaptureRatio: number;
  settleGraceMinutes: number;
  dedupeHours: number;
  minUpstreamBalanceUsd: number;
}

function readPositiveNumber(raw: string | undefined, fallback: number): number {
  if (!raw?.trim()) return fallback;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function readRatio(raw: string | undefined, fallback: number): number {
  const parsed = readPositiveNumber(raw, fallback);
  return parsed > 1 ? fallback : parsed;
}

export function resolveManagedVeniceHealthConfig(
  env: Record<string, string | undefined> = process.env
): ManagedVeniceHealthConfig {
  return {
    windowHours: readPositiveNumber(
      env.MANAGED_VENICE_HEALTH_WINDOW_HOURS,
      DEFAULT_WINDOW_HOURS
    ),
    minAttempts: readPositiveNumber(
      env.MANAGED_VENICE_HEALTH_MIN_ATTEMPTS,
      DEFAULT_MIN_ATTEMPTS
    ),
    warnMinAttempts: readPositiveNumber(
      env.MANAGED_VENICE_HEALTH_WARN_MIN_ATTEMPTS,
      DEFAULT_WARN_MIN_ATTEMPTS
    ),
    warnCaptureRatio: readRatio(
      env.MANAGED_VENICE_HEALTH_WARN_CAPTURE_RATIO,
      DEFAULT_WARN_CAPTURE_RATIO
    ),
    settleGraceMinutes: readPositiveNumber(
      env.MANAGED_VENICE_HEALTH_SETTLE_GRACE_MINUTES,
      DEFAULT_SETTLE_GRACE_MINUTES
    ),
    dedupeHours: readPositiveNumber(
      env.MANAGED_VENICE_HEALTH_DEDUPE_HOURS,
      DEFAULT_DEDUPE_HOURS
    ),
    minUpstreamBalanceUsd: readPositiveNumber(
      env.MANAGED_VENICE_HEALTH_MIN_UPSTREAM_BALANCE_USD,
      DEFAULT_MIN_UPSTREAM_BALANCE_USD
    ),
  };
}

// ---------------------------------------------------------------------------
// Detector 1: capture drought (pure decision + reservation counts)
// ---------------------------------------------------------------------------

type CaptureDroughtLevel = "healthy" | "warn" | "critical";

export interface CaptureDroughtInput {
  /** Reservations created inside the window (any terminal status). */
  attempts: number;
  /** Of those, reservations that reached status='captured'. */
  captured: number;
  windowStartIso: string;
  config: ManagedVeniceHealthConfig;
}

export interface CaptureDroughtResult {
  level: CaptureDroughtLevel;
  attempts: number;
  captured: number;
  captureRatio: number | null;
  windowStartIso: string;
  reason: string;
}

// Pure decision so the threshold logic is unit-testable without a database.
export function evaluateCaptureDrought(
  input: CaptureDroughtInput
): CaptureDroughtResult {
  const { attempts, captured, windowStartIso, config } = input;
  const captureRatio = attempts > 0 ? captured / attempts : null;
  const base = { attempts, captured, captureRatio, windowStartIso };

  if (attempts >= config.minAttempts && captured === 0) {
    return {
      ...base,
      level: "critical",
      reason:
        `managed-Venice upstream failing: ${attempts} attempts, 0 captures ` +
        `since ${windowStartIso}`,
    };
  }

  if (
    attempts >= config.warnMinAttempts &&
    captureRatio !== null &&
    captureRatio < config.warnCaptureRatio
  ) {
    return {
      ...base,
      level: "warn",
      reason:
        `managed-Venice capture ratio degraded: ${captured}/${attempts} ` +
        `(${(captureRatio * 100).toFixed(0)}%) captured since ${windowStartIso}, ` +
        `below the ${(config.warnCaptureRatio * 100).toFixed(0)}% floor`,
    };
  }

  if (attempts < config.minAttempts) {
    return {
      ...base,
      level: "healthy",
      reason:
        `only ${attempts} attempt(s) since ${windowStartIso} — too quiet to judge`,
    };
  }

  return {
    ...base,
    level: "healthy",
    reason:
      `${captured}/${attempts} captured since ${windowStartIso} — capture ` +
      `pipeline healthy`,
  };
}

type QueryError = { message?: string } | null;
type CountResult = { count: number | null; error: QueryError };

interface CountFilterChain extends PromiseLike<CountResult> {
  eq(column: string, value: string): CountFilterChain;
  gte(column: string, value: string): CountFilterChain;
  lt(column: string, value: string): CountFilterChain;
}

type ReservationCountTable = {
  select(columns: string, options: { count: "exact"; head: boolean }): CountFilterChain;
};

export type SupabaseLike = { from: (table: string) => unknown };

/**
 * Head-only exact counts against managed_venice_reservations. READ-ONLY.
 * Equivalent SQL:
 *
 *   SELECT count(*) FROM managed_venice_reservations
 *    WHERE created_at >= $windowStart AND created_at < $windowEnd;            -- attempts
 *   SELECT count(*) FROM managed_venice_reservations
 *    WHERE status = 'captured'
 *      AND created_at >= $windowStart AND created_at < $windowEnd;            -- captured
 *
 * Both counts key on created_at (not captured_at) so the ratio is "of the
 * attempts made in this window, how many succeeded". windowEnd trails now by
 * the settle grace so in-flight holds don't read as failures.
 */
export async function readCaptureDroughtCounts(
  db: SupabaseLike,
  window: { windowStartIso: string; windowEndIso: string }
): Promise<{ attempts: number; captured: number }> {
  const countReservations = async (capturedOnly: boolean): Promise<number> => {
    let chain = (db.from("managed_venice_reservations") as ReservationCountTable)
      .select("id", { count: "exact", head: true });
    if (capturedOnly) chain = chain.eq("status", "captured");
    const { count, error } = await chain
      .gte("created_at", window.windowStartIso)
      .lt("created_at", window.windowEndIso);
    if (error) {
      throw new Error(error.message || "managed-Venice reservation count query failed");
    }
    return count ?? 0;
  };

  const [attempts, captured] = await Promise.all([
    countReservations(false),
    countReservations(true),
  ]);
  return { attempts, captured };
}

/** Reads the reservation window and applies the pure drought decision. */
export async function runCaptureDroughtDetector(
  db: SupabaseLike,
  config: ManagedVeniceHealthConfig,
  nowMs: number = Date.now()
): Promise<CaptureDroughtResult> {
  const windowEndMs = nowMs - config.settleGraceMinutes * 60_000;
  const windowStartMs = windowEndMs - config.windowHours * 3_600_000;
  const windowStartIso = new Date(windowStartMs).toISOString();
  const windowEndIso = new Date(windowEndMs).toISOString();

  const { attempts, captured } = await readCaptureDroughtCounts(db, {
    windowStartIso,
    windowEndIso,
  });

  return evaluateCaptureDrought({ attempts, captured, windowStartIso, config });
}

// ---------------------------------------------------------------------------
// Detector 2: direct upstream probe
// ---------------------------------------------------------------------------

// Venice's cheapest introspection endpoint: returns the key's rate limits AND
// the account's remaining balances (data.balances.USD / data.balances.DIEM)
// plus data.accessPermitted, with NO inference cost. Shape per
// https://docs.venice.ai/api-reference/endpoint/api_keys/rate_limits.
export const VENICE_RATE_LIMITS_URL =
  "https://api.venice.ai/api/v1/api_keys/rate_limits";

export const PROBE_TIMEOUT_MS = 8_000;

type UpstreamProbeStatus =
  | "healthy"
  | "warn"
  | "critical"
  | "inconclusive"
  | "skipped";

export interface UpstreamProbeResult {
  status: UpstreamProbeStatus;
  reason: string;
  httpStatus: number | null;
  balanceUsd: number | null;
  balanceDiem: number | null;
  accessPermitted: boolean | null;
  keySource: "pool" | "legacy" | null;
  poolSize: number;
}

/**
 * Probe the SAME upstream credential the proxy uses: the first key of
 * MANAGED_VENICE_INFERENCE_KEYS, or the legacy VENICE_API_KEY. Returns
 * "skipped" when neither is configured server-side. Never throws.
 */
export function resolveProbeKey(
  env: Record<string, string | undefined> = process.env
): { key: string; source: "pool" | "legacy"; poolSize: number } | null {
  const pool = parseManagedVeniceInferenceKeys(env);
  if (pool.length > 0) return { key: pool[0], source: "pool", poolSize: pool.length };
  const legacy = env.VENICE_API_KEY?.trim();
  if (legacy) return { key: legacy, source: "legacy", poolSize: 1 };
  return null;
}

function readBalance(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export async function probeManagedVeniceUpstream(
  options: {
    env?: Record<string, string | undefined>;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    minBalanceUsd?: number;
  } = {}
): Promise<UpstreamProbeResult> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const minBalanceUsd = options.minBalanceUsd ?? DEFAULT_MIN_UPSTREAM_BALANCE_USD;

  const resolved = resolveProbeKey(env);
  const base: UpstreamProbeResult = {
    status: "skipped",
    reason: "no managed-Venice upstream key configured server-side",
    httpStatus: null,
    balanceUsd: null,
    balanceDiem: null,
    accessPermitted: null,
    keySource: resolved?.source ?? null,
    poolSize: resolved?.poolSize ?? 0,
  };
  if (!resolved) return base;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(VENICE_RATE_LIMITS_URL, {
      headers: { Authorization: `Bearer ${resolved.key}` },
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (error) {
    return {
      ...base,
      status: "inconclusive",
      reason:
        `probe fetch failed (${error instanceof Error ? error.name : "unknown"}) — ` +
        `network/timeout, not a confirmed billing failure`,
    };
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 402) {
    return {
      ...base,
      status: "critical",
      httpStatus: 402,
      reason:
        "Venice returned 402 to the upstream key probe — the upstream account " +
        "is out of funds; every managed completion is failing",
    };
  }

  if (response.status === 401 || response.status === 403) {
    return {
      ...base,
      status: "critical",
      httpStatus: response.status,
      reason:
        `Venice rejected the upstream key (HTTP ${response.status}) — the key is ` +
        `revoked/blocked; every managed completion is failing`,
    };
  }

  if (!response.ok) {
    // 404/429/5xx: Venice-side wobble or an endpoint move — not a confirmed
    // billing failure. The drought detector catches any sustained real outage.
    return {
      ...base,
      status: "inconclusive",
      httpStatus: response.status,
      reason: `probe returned HTTP ${response.status} — inconclusive`,
    };
  }

  let data: Record<string, unknown> = {};
  try {
    const json = (await response.json()) as { data?: unknown };
    if (json?.data && typeof json.data === "object") {
      data = json.data as Record<string, unknown>;
    }
  } catch {
    return {
      ...base,
      status: "inconclusive",
      httpStatus: response.status,
      reason: "probe returned 2xx but an unparseable body — inconclusive",
    };
  }

  const balances = (data.balances ?? {}) as Record<string, unknown>;
  const balanceUsd = readBalance(balances.USD);
  const balanceDiem = readBalance(balances.DIEM);
  const accessPermitted =
    typeof data.accessPermitted === "boolean" ? data.accessPermitted : null;

  if (accessPermitted === false) {
    return {
      ...base,
      status: "critical",
      httpStatus: response.status,
      balanceUsd,
      balanceDiem,
      accessPermitted,
      reason:
        "Venice reports accessPermitted=false for the upstream key — inference " +
        "is blocked; every managed completion is failing",
    };
  }

  if (balanceUsd !== null && balanceUsd < minBalanceUsd) {
    return {
      ...base,
      status: "warn",
      httpStatus: response.status,
      balanceUsd,
      balanceDiem,
      accessPermitted,
      reason:
        `upstream Venice USD balance is low ($${balanceUsd.toFixed(2)} < ` +
        `$${minBalanceUsd}) — top up before it hits $0 and managed inference dies`,
    };
  }

  return {
    ...base,
    status: "healthy",
    httpStatus: response.status,
    balanceUsd,
    balanceDiem,
    accessPermitted,
    reason:
      balanceUsd !== null
        ? `upstream key healthy; $${balanceUsd.toFixed(2)} USD remaining`
        : "upstream key healthy",
  };
}

// ---------------------------------------------------------------------------
// Ops-event construction + re-emit dedupe
// ---------------------------------------------------------------------------

// IMPORTANT: title + message must be STABLE for an ongoing incident — the
// ops-events pipeline fingerprints on (source,title,message,route) and pages
// admins only on the FIRST sighting of a fatal fingerprint (see
// cron/monitor-managed-venice-usage for the prior art). All volatile numbers
// (counts, balances, timestamps) belong in metadata, which is NOT
// fingerprinted.

export function buildDroughtOpsEvent(
  result: CaptureDroughtResult,
  config: ManagedVeniceHealthConfig,
  context: { source: string; route: string }
): OpsEventInput | null {
  if (result.level === "critical") {
    return {
      source: context.source,
      route: context.route,
      severity: "fatal",
      title: "Managed-Venice upstream failing: attempts with zero captures",
      message:
        `Managed-Venice reservations are being created but NONE have been ` +
        `captured across the sliding window — every completion is failing ` +
        `upstream (the signature of the Jul-2026 $0-balance outage: each ` +
        `request reserves, 402s, and releases). Check the upstream Venice ` +
        `account balance/key first. Exact attempt/capture counts and the ` +
        `window bounds are in this event's metadata.`,
      metadata: {
        failureType: "managed_venice_capture_drought",
        attempts: result.attempts,
        captured: result.captured,
        captureRatio: result.captureRatio,
        windowStartIso: result.windowStartIso,
        windowHours: config.windowHours,
        minAttempts: config.minAttempts,
        reason: result.reason,
      },
    };
  }

  if (result.level === "warn") {
    return {
      source: context.source,
      route: context.route,
      severity: "warn",
      title: "Managed-Venice capture ratio degraded",
      message:
        `A meaningful share of managed-Venice completions are failing to ` +
        `capture across the sliding window. Not (yet) a total outage, but ` +
        `well below the healthy capture ratio — check upstream Venice health ` +
        `and the settlement pipeline. Counts are in this event's metadata.`,
      metadata: {
        failureType: "managed_venice_capture_ratio_degraded",
        attempts: result.attempts,
        captured: result.captured,
        captureRatio: result.captureRatio,
        windowStartIso: result.windowStartIso,
        windowHours: config.windowHours,
        warnCaptureRatio: config.warnCaptureRatio,
        reason: result.reason,
      },
    };
  }

  return null;
}

export function buildProbeOpsEvent(
  result: UpstreamProbeResult,
  context: { source: string; route: string }
): OpsEventInput | null {
  if (result.status === "critical") {
    return {
      source: context.source,
      route: context.route,
      severity: "fatal",
      title: "Managed-Venice upstream key probe failed",
      message:
        `A direct probe of the managed-Venice upstream key against Venice's ` +
        `rate-limits/balance endpoint came back in a definitive failure state ` +
        `(402 out-of-funds, 401/403 key rejected, or accessPermitted=false). ` +
        `Managed inference is down until the upstream account is funded or the ` +
        `key replaced. HTTP status and remaining balance are in metadata.`,
      metadata: {
        failureType: "managed_venice_upstream_probe_failed",
        httpStatus: result.httpStatus,
        balanceUsd: result.balanceUsd,
        balanceDiem: result.balanceDiem,
        accessPermitted: result.accessPermitted,
        keySource: result.keySource,
        poolSize: result.poolSize,
        reason: result.reason,
      },
    };
  }

  if (result.status === "warn") {
    return {
      source: context.source,
      route: context.route,
      severity: "warn",
      title: "Managed-Venice upstream balance low",
      message:
        `The upstream Venice account balance is below the configured floor. ` +
        `Top up before it reaches $0 — at $0 every managed completion 402s ` +
        `and managed inference dies silently. Balance is in metadata.`,
      metadata: {
        failureType: "managed_venice_upstream_balance_low",
        httpStatus: result.httpStatus,
        balanceUsd: result.balanceUsd,
        balanceDiem: result.balanceDiem,
        keySource: result.keySource,
        poolSize: result.poolSize,
        reason: result.reason,
      },
    };
  }

  return null;
}

type OpsEventLookupTable = {
  select(columns: string): {
    eq(column: string, value: string): {
      maybeSingle(): Promise<{ data: { last_seen_at?: string | null } | null; error: QueryError }>;
    };
  };
};

/**
 * Re-emit guard: true when an ops event with this fingerprint was already
 * reported inside the dedupe window. reportOpsEvent itself only PAGES on the
 * first sighting of a fatal fingerprint, but every re-report still rewrites
 * the row (bumping occurrence_count and clearing archived_at) — so without
 * this guard a 30-min cron would churn the /dashboard/ops row 48×/day and
 * instantly un-archive an event an operator just triaged. Fails OPEN (emit)
 * on lookup errors: double-reporting beats dropping the page.
 */
export async function wasOpsEventRecentlyReported(
  db: SupabaseLike,
  fingerprint: string,
  dedupeMs: number,
  nowMs: number = Date.now()
): Promise<boolean> {
  try {
    const { data, error } = await (db.from("ops_events") as OpsEventLookupTable)
      .select("last_seen_at")
      .eq("fingerprint", fingerprint)
      .maybeSingle();
    if (error || !data?.last_seen_at) return false;
    const lastSeenMs = Date.parse(data.last_seen_at);
    if (!Number.isFinite(lastSeenMs)) return false;
    return nowMs - lastSeenMs < dedupeMs;
  } catch {
    return false;
  }
}
