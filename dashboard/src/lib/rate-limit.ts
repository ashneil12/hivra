import net from "node:net";
import { NextRequest } from "next/server";

type RateLimitRecord = {
  count: number;
  lastReset: number;
  /** Reserved slots whose work has not finished yet. */
  inFlight?: number;
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

export type RateLimitReservation =
  | {
      success: true;
      /** Ends the reserved run. A failed run gives its slot back; a
       * successful one keeps it for the rest of the window. Idempotent. */
      settle: (outcome: "succeeded" | "failed") => void;
    }
  | { success: false; retryAfterMs: number; inFlight: boolean };

/**
 * A fixed-window limit that counts only work that is still running or that
 * succeeded. The slot is taken when the work starts, so concurrent attempts
 * are refused, and returned if the work fails, so a person who fixes the cause
 * can try again straight away.
 */
export function reserveRateLimit(identifier: string, config: RateLimitConfig): RateLimitReservation {
  const now = Date.now();
  let record = store.get(identifier);
  if (!record || now - record.lastReset > config.windowMs) {
    // A run still in flight from the previous window keeps counting, so a
    // window rollover never admits a concurrent second run.
    record = { count: record?.inFlight ?? 0, lastReset: now, inFlight: record?.inFlight ?? 0 };
    store.set(identifier, record);
  }
  if (record.count >= config.limit) {
    return {
      success: false,
      retryAfterMs: retryAfterMs(record, config, now),
      inFlight: (record.inFlight ?? 0) > 0,
    };
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
      // The run is counted in whichever window now holds it (a rollover
      // carries in-flight runs forward), so a failure always gives it back.
      if (outcome === "failed") current.count = Math.max(0, current.count - 1);
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
      if (!record.inFlight && now - record.lastReset > 60 * 60 * 1000) {
        store.delete(key);
      }
    }
  }, 10 * 60 * 1000);
  
  if (interval.unref) {
    interval.unref();
  }
}
