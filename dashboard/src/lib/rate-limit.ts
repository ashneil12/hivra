import net from "node:net";
import { NextRequest } from "next/server";

type RateLimitRecord = {
  count: number;
  lastReset: number;
  /** Reserved slots whose work has not finished yet. */
  inFlight?: number;
  /** Failed reserved runs since failureWindowStart. */
  failures?: number;
  failureWindowStart?: number;
};

// In-memory store (works well enough for basic DoS protection per-container)
const store = new Map<string, RateLimitRecord>();

export interface RateLimitConfig {
  limit: number;
  windowMs: number;
}

export type RateLimitResult =
  | { success: true }
  | { success: false; retryAfterMs: number };

function retryAfterMs(record: RateLimitRecord, config: RateLimitConfig, now: number): number {
  return Math.max(0, record.lastReset + config.windowMs - now);
}

/**
 * Basic fixed-window rate limiter. A refusal says how long until the window
 * resets, so callers can send an honest Retry-After.
 */
export function enforceRateLimit(identifier: string, config: RateLimitConfig): RateLimitResult {
  const now = Date.now();
  const record = store.get(identifier);

  if (!record || now - record.lastReset > config.windowMs) {
    // Reset or initial
    store.set(identifier, { count: 1, lastReset: now });
    return { success: true };
  }

  if (record.count >= config.limit) {
    return { success: false, retryAfterMs: retryAfterMs(record, config, now) };
  }

  record.count += 1;
  store.set(identifier, record);
  return { success: true };
}

export interface ReservationRateLimitConfig extends RateLimitConfig {
  /**
   * Failed runs allowed per window before the next run must wait. A failure
   * gives its slot back so a fixed cause can be retried at once, but the work
   * still costs something (an SSH connection to someone's server), so repeated
   * failures are capped separately.
   */
  failureLimit?: number;
}

export type RateLimitRefusalReason = "in_flight" | "recent_success" | "repeated_failures";

export type RateLimitReservation =
  | {
      success: true;
      /** Ends the reserved run. A failed run gives its slot back (and counts
       * toward the failure cap); a successful one keeps it, and the window
       * restarts from the success. Idempotent. */
      settle: (outcome: "succeeded" | "failed") => void;
    }
  | { success: false; retryAfterMs: number; inFlight: boolean; reason: RateLimitRefusalReason };

/**
 * A fixed-window limit that counts only work that is still running or that
 * succeeded. The slot is taken when the work starts, so concurrent attempts
 * are refused, and returned if the work fails, so a person who fixes the cause
 * can try again straight away. A success holds the slot for a full window
 * from the moment it succeeded. With failureLimit, that many failures in a
 * window also make the next run wait.
 */
export function reserveRateLimit(identifier: string, config: ReservationRateLimitConfig): RateLimitReservation {
  const now = Date.now();
  let record = store.get(identifier);
  if (!record || now - record.lastReset > config.windowMs) {
    // A run still in flight from the previous window keeps counting, so a
    // window rollover never admits a concurrent second run. Failures have
    // their own window and carry over with it.
    record = {
      count: record?.inFlight ?? 0,
      lastReset: now,
      inFlight: record?.inFlight ?? 0,
      failures: record?.failures,
      failureWindowStart: record?.failureWindowStart,
    };
    store.set(identifier, record);
  }
  if (record.count >= config.limit) {
    const inFlight = (record.inFlight ?? 0) > 0;
    return {
      success: false,
      retryAfterMs: retryAfterMs(record, config, now),
      inFlight,
      reason: inFlight ? "in_flight" : "recent_success",
    };
  }
  if (config.failureLimit !== undefined && record.failureWindowStart !== undefined) {
    if (now - record.failureWindowStart > config.windowMs) {
      record.failures = 0;
      record.failureWindowStart = undefined;
    } else if ((record.failures ?? 0) >= config.failureLimit) {
      return {
        success: false,
        retryAfterMs: Math.max(0, record.failureWindowStart + config.windowMs - now),
        inFlight: false,
        reason: "repeated_failures",
      };
    }
  }

  record.count += 1;
  record.inFlight = (record.inFlight ?? 0) + 1;
  let settled = false;
  return {
    success: true,
    settle: (outcome) => {
      if (settled) return;
      settled = true;
      const current = store.get(identifier);
      if (!current) return;
      current.inFlight = Math.max(0, (current.inFlight ?? 0) - 1);
      const settledAt = Date.now();
      if (outcome === "succeeded") {
        // The limit is "one success per window", so the window runs from the
        // success, not from whichever earlier attempt opened it. A success
        // also clears the failure count.
        current.lastReset = settledAt;
        current.failures = 0;
        current.failureWindowStart = undefined;
        return;
      }
      // The run is counted in whichever window now holds it (a rollover
      // carries in-flight runs forward), so a failure always gives it back.
      current.count = Math.max(0, current.count - 1);
      if (current.failureWindowStart === undefined || settledAt - current.failureWindowStart > config.windowMs) {
        current.failures = 0;
        current.failureWindowStart = settledAt;
      }
      current.failures = (current.failures ?? 0) + 1;
    },
  };
}

/**
 * Gets the IP address from headers
 */
function parseCandidateIp(rawValue: string | null): string | null {
  if (!rawValue) {
    return null;
  }

  let candidate = rawValue.split(",")[0]?.trim() ?? "";
  if (!candidate) {
    return null;
  }

  if (candidate.toLowerCase().startsWith("for=")) {
    candidate = candidate.slice(4).trim();
  }

  if (candidate.startsWith('"') && candidate.endsWith('"')) {
    candidate = candidate.slice(1, -1).trim();
  }

  if (candidate.startsWith("[") && candidate.includes("]")) {
    candidate = candidate.slice(1, candidate.indexOf("]")).trim();
  } else if (candidate.includes(":") && net.isIP(candidate) === 0) {
    const withoutPort = candidate.replace(/:\d+$/, "");
    if (net.isIP(withoutPort) === 4) {
      candidate = withoutPort;
    }
  }

  return net.isIP(candidate) ? candidate : null;
}

export function getIP(req: NextRequest | Request): string {
  const directIp =
    parseCandidateIp(req.headers.get("cf-connecting-ip")) ??
    parseCandidateIp(req.headers.get("x-real-ip"));
  if (directIp) {
    return directIp;
  }

  return parseCandidateIp(req.headers.get("x-forwarded-for")) ?? "127.0.0.1";
}

// Periodic cleanup to prevent Memory Leaks in longer-living Node containers
if (typeof setInterval !== "undefined") {
  const interval = setInterval(() => {
    const now = Date.now();
    for (const [key, record] of Array.from(store.entries())) {
      // Arbitrary eviction after 1 hour of no updates. A reserved run still
      // going keeps its record, so eviction never admits a concurrent run.
      const lastUpdate = Math.max(record.lastReset, record.failureWindowStart ?? 0);
      if (!record.inFlight && now - lastUpdate > 60 * 60 * 1000) {
        store.delete(key);
      }
    }
  }, 10 * 60 * 1000);
  
  if (interval.unref) {
    interval.unref();
  }
}
