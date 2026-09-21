import net from "node:net";
import { NextRequest } from "next/server";

type RateLimitRecord = {
  count: number;
  lastReset: number;
};

// In-memory store (works well enough for basic DoS protection per-container)
const store = new Map<string, RateLimitRecord>();

export interface RateLimitConfig {
  limit: number;
  windowMs: number;
}

/**
 * Basic fixed-window rate limiter
 */
export function enforceRateLimit(identifier: string, config: RateLimitConfig) {
  const now = Date.now();
  const record = store.get(identifier);

  if (!record || now - record.lastReset > config.windowMs) {
    // Reset or initial
    store.set(identifier, { count: 1, lastReset: now });
    return { success: true };
  }

  if (record.count >= config.limit) {
    return { success: false };
  }

  record.count += 1;
  store.set(identifier, record);
  return { success: true };
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
      // Arbitrary eviction after 1 hour of no updates
      if (now - record.lastReset > 60 * 60 * 1000) {
        store.delete(key);
      }
    }
  }, 10 * 60 * 1000);
  
  if (interval.unref) {
    interval.unref();
  }
}
