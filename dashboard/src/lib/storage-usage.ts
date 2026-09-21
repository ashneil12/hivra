// Storage-usage thresholds + computation for the Layer A disk-usage banners
// (monitoring/visibility only — NO enforcement). Pure and client-safe so the
// read-only API route and the chat banner share one definition of "how full".

export type StorageLevel = "ok" | "warn" | "critical";

/** Show an amber "running low" banner at or above this percent. */
const STORAGE_WARN_PERCENT = 80;
/** Escalate to a red "almost full" banner at or above this percent. */
const STORAGE_CRITICAL_PERCENT = 95;

/**
 * Fallback provisioned disk when an instance row has no `disk_size_gb` set.
 * Mirrors DEFAULT_PROXMOX_VM_DISK_GB in proxmox-instance-service.ts (kept as a
 * local constant so this client-safe module doesn't pull in the server-only
 * provisioning graph).
 */
export const DEFAULT_INSTANCE_DISK_GB = 30;

export const BYTES_PER_GB = 1024 ** 3;

export interface StorageUsage {
  /** Latest observed disk usage, in bytes (never negative). */
  usedBytes: number;
  /** Provisioned disk for the instance, in bytes (never negative). */
  provisionedBytes: number;
  /**
   * usedBytes / provisionedBytes as a percent, CLAMPED to a maximum of 100
   * (0 when provisioned is unknown). This is the user-facing value — a stale
   * denominator can no longer produce an impossible ">100%" banner.
   */
  percent: number;
  /**
   * The UNclamped usedBytes / provisionedBytes percent (0 when provisioned is
   * unknown). Preserved for telemetry/logs so a denominator bug (e.g. dividing
   * by a stale disk_size_gb) is still detectable even though the user sees ≤100.
   */
  rawPercent: number;
  level: StorageLevel;
}

/**
 * Classify an instance's disk usage. Defensive about junk inputs: non-finite or
 * negative values collapse to 0, and an unknown/zero provisioned size yields 0%
 * (an "ok" level with no banner) rather than a divide-by-zero.
 *
 * `percent` is clamped to ≤100 so a stale denominator can't render an
 * impossible ">100% full" banner; `rawPercent` keeps the unclamped ratio for
 * telemetry. `level` is computed from the CLAMPED percent, so a truly-full
 * (>100% raw) disk still reads "critical".
 */
export function computeStorageUsage(usedBytes: number, provisionedBytes: number): StorageUsage {
  const used = Number.isFinite(usedBytes) && usedBytes > 0 ? usedBytes : 0;
  const provisioned = Number.isFinite(provisionedBytes) && provisionedBytes > 0 ? provisionedBytes : 0;
  const rawPercent = provisioned > 0 ? (used / provisioned) * 100 : 0;
  const percent = provisioned > 0 ? Math.min(100, rawPercent) : 0;
  const level: StorageLevel =
    percent >= STORAGE_CRITICAL_PERCENT
      ? "critical"
      : percent >= STORAGE_WARN_PERCENT
        ? "warn"
        : "ok";
  return { usedBytes: used, provisionedBytes: provisioned, percent, rawPercent, level };
}

/** Ordered severity so the banner can re-appear when usage escalates. */
export function storageLevelRank(level: StorageLevel): number {
  return level === "critical" ? 2 : level === "warn" ? 1 : 0;
}
