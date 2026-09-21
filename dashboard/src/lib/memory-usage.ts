// Memory-pressure thresholds + computation for the agent-chat "you're maxing
// your RAM → upgrade" banner. Pure and client-safe so the read-only API route
// and the chat banner share one definition of "how close to the limit".
//
// The signal is the latest metering `ram_peak_bytes` (already sampled every
// 5/30 min by the metrics cron) measured against the instance's GUARANTEED
// baseline RAM (`ram_limit`). Crossing the baseline means the tenant is either
// running on burst headroom that isn't guaranteed (paid tiers) or about to be
// OOM-killed at their pinned cap (free tier) — both are the moment to upsell.
// Monitoring/visibility only: this never blocks anything.

export type MemoryLevel = "ok" | "warn" | "critical";

/** Amber "approaching your plan's RAM" banner at or above this percent of baseline. */
export const MEMORY_WARN_PERCENT = 80;
/**
 * Red "over your plan's guaranteed RAM" banner at or above this percent. 100%
 * means peak usage has reached the guaranteed baseline — past here a free VM
 * risks OOM and a paid VM is leaning on non-guaranteed burst headroom.
 */
export const MEMORY_CRITICAL_PERCENT = 100;

export const BYTES_PER_MB = 1024 ** 2;

export interface MemoryUsage {
  /** Latest observed peak RAM usage, in bytes (never negative). */
  peakBytes: number;
  /** Guaranteed baseline RAM for the instance, in bytes (never negative). */
  baselineBytes: number;
  /** peakBytes / baselineBytes as a percent (0 when baseline is unknown). */
  percent: number;
  level: MemoryLevel;
}

/**
 * Classify an instance's memory pressure. Defensive about junk inputs: non-finite
 * or negative values collapse to 0, and an unknown/zero baseline yields 0% (an
 * "ok" level with no banner) rather than a divide-by-zero.
 */
export function computeMemoryUsage(peakBytes: number, baselineBytes: number): MemoryUsage {
  const peak = Number.isFinite(peakBytes) && peakBytes > 0 ? peakBytes : 0;
  const baseline = Number.isFinite(baselineBytes) && baselineBytes > 0 ? baselineBytes : 0;
  const percent = baseline > 0 ? (peak / baseline) * 100 : 0;
  const level: MemoryLevel =
    percent >= MEMORY_CRITICAL_PERCENT
      ? "critical"
      : percent >= MEMORY_WARN_PERCENT
        ? "warn"
        : "ok";
  return { peakBytes: peak, baselineBytes: baseline, percent, level };
}

/** Ordered severity so the banner can re-appear when pressure escalates. */
export function memoryLevelRank(level: MemoryLevel): number {
  return level === "critical" ? 2 : level === "warn" ? 1 : 0;
}
