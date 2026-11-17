/**
 * Host capacity: thresholds and the pure classification of one host's reading.
 *
 * With sleeping agents a host holds more agents than fit in its memory at once.
 * This says when that is getting close: memory left for wakes, the disk pool
 * the VM disks and the saved memory of hibernated agents live on, and whether
 * the largest hibernated agent could still come back.
 */

type EnvLike = Record<string, string | undefined>;

export type CapacityLevel = "ok" | "warn" | "critical";
export type CapacityReasonCode = "ram_available_low" | "disk_pool_high" | "wake_would_not_fit";
export type CapacityReason = { code: CapacityReasonCode; level: Exclude<CapacityLevel, "ok"> };

export type CapacityThresholds = {
  /** Warn while available memory is within this much of the host's wake headroom. */
  ramMarginMb: number;
  diskWarnPercent: number;
  diskCriticalPercent: number;
  /** Memory of the agent a new launch is assumed to need. */
  standardAgentRamMb: number;
};

export const DEFAULT_CAPACITY_THRESHOLDS: CapacityThresholds = {
  ramMarginMb: 2048,
  diskWarnPercent: 80,
  diskCriticalPercent: 90,
  standardAgentRamMb: 8192,
};

export type HostCapacityStats = {
  memTotalMb: number;
  memAvailableMb: number;
  /** proxmox_hosts.wake_headroom_ram_mb: memory kept free for wakes. */
  wakeHeadroomMb: number;
  /** The disk pool, or null when the host script could not find one. */
  pool: { name: string; sizeMb: number; usedPercent: number } | null;
  /** Memory of every agent on the host, asleep or not: what is needed if all woke. */
  committedRamMb: number;
  /** Memory of the hibernated agents: what has to come back from disk. */
  hibernatedRamMb: number;
  largestHibernatedRamMb: number;
};

export type CapacityVerdict = {
  level: CapacityLevel;
  reasons: CapacityReason[];
  /** Committed agent memory over the host's total memory. Above 1 the host relies on sleep. */
  oversubscriptionRatio: number;
  /** Whether a standard new agent fits without eating into the wake headroom. */
  canAdmitStandard: boolean;
};

/** The cron runs every 5 minutes; a reading that missed two runs is no longer trusted. */
export const CAPACITY_READING_MAX_AGE_MS = 15 * 60 * 1000;

/** `on` only when the switch says exactly that. Anything else is off. */
export function hostCapacityAlertsEnabled(env: EnvLike = process.env): boolean {
  return env.HIVRA_HOST_CAPACITY_ALERTS?.trim().toLowerCase() === "on";
}

function envNumber(env: EnvLike, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  const value = Number.parseInt(raw, 10);
  return value >= min && value <= max ? value : fallback;
}

/** Thresholds from the environment. A value that is missing or out of range keeps its default. */
export function resolveCapacityThresholds(env: EnvLike = process.env): CapacityThresholds {
  const d = DEFAULT_CAPACITY_THRESHOLDS;
  const diskWarnPercent = envNumber(env, "HIVRA_HOST_CAPACITY_DISK_WARN_PERCENT", d.diskWarnPercent, 1, 99);
  const diskCriticalPercent = envNumber(env, "HIVRA_HOST_CAPACITY_DISK_CRITICAL_PERCENT", d.diskCriticalPercent, 1, 100);
  // A warn level at or above the critical one would never warn: keep the defaults for both.
  const diskValid = diskWarnPercent < diskCriticalPercent;
  return {
    ramMarginMb: envNumber(env, "HIVRA_HOST_CAPACITY_RAM_MARGIN_MB", d.ramMarginMb, 0, 1_000_000),
    diskWarnPercent: diskValid ? diskWarnPercent : d.diskWarnPercent,
    diskCriticalPercent: diskValid ? diskCriticalPercent : d.diskCriticalPercent,
    standardAgentRamMb: envNumber(env, "HIVRA_HOST_CAPACITY_STANDARD_AGENT_RAM_MB", d.standardAgentRamMb, 512, 1_000_000),
  };
}

export function classifyHostCapacity(
  stats: HostCapacityStats,
  thresholds: CapacityThresholds = DEFAULT_CAPACITY_THRESHOLDS,
): CapacityVerdict {
  const reasons: CapacityReason[] = [];

  if (stats.memAvailableMb < stats.wakeHeadroomMb) {
    reasons.push({ code: "ram_available_low", level: "critical" });
  } else if (stats.memAvailableMb < stats.wakeHeadroomMb + thresholds.ramMarginMb) {
    reasons.push({ code: "ram_available_low", level: "warn" });
  }

  if (stats.pool) {
    if (stats.pool.usedPercent >= thresholds.diskCriticalPercent) {
      reasons.push({ code: "disk_pool_high", level: "critical" });
    } else if (stats.pool.usedPercent >= thresholds.diskWarnPercent) {
      reasons.push({ code: "disk_pool_high", level: "warn" });
    }
  }

  if (stats.largestHibernatedRamMb > stats.memAvailableMb) {
    reasons.push({ code: "wake_would_not_fit", level: "critical" });
  }

  const level: CapacityLevel = reasons.some((reason) => reason.level === "critical")
    ? "critical"
    : reasons.length > 0 ? "warn" : "ok";
  return {
    level,
    reasons,
    oversubscriptionRatio: stats.memTotalMb > 0
      ? Math.round((stats.committedRamMb / stats.memTotalMb) * 100) / 100
      : 0,
    canAdmitStandard: level !== "critical"
      && stats.memAvailableMb - thresholds.standardAgentRamMb >= stats.wakeHeadroomMb,
  };
}
