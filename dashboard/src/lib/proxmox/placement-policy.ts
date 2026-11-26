/**
 * The application-side placement policy inputs shared by ranking, holder
 * admission advancement, and every durable SQL placement write. Host-level
 * proxmox_hosts.cpu_overcommit_ratio and placement_skip_deep_sleep still win
 * inside the database authority; these values are the configured fleet
 * fallback for hosts whose columns are NULL/false.
 */

export const DEFAULT_PROXMOX_CPU_OVERCOMMIT_RATIO = 5;

type PlacementEnv = Record<string, string | undefined>;

export function resolveProxmoxCpuOvercommitRatio(
  env: PlacementEnv = process.env,
): number {
  const raw = env.HERMES_PROXMOX_CPU_OVERCOMMIT_RATIO?.trim();
  if (!raw) return DEFAULT_PROXMOX_CPU_OVERCOMMIT_RATIO;

  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= 1
    ? parsed
    : DEFAULT_PROXMOX_CPU_OVERCOMMIT_RATIO;
}

export function resolveHostCpuOvercommitRatio(
  hostValue: number | string | null | undefined,
  fallback: number,
): number {
  const parsed = typeof hostValue === "string" ? Number(hostValue) : hostValue;
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0 && parsed <= 20
    ? parsed
    : fallback;
}

export function placementSkipsDeepSleep(env: PlacementEnv = process.env): boolean {
  const raw = env.HIVRA_PLACEMENT_SKIP_DEEP_SLEEP?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on";
}

export function proxmoxPlacementPolicy(env: PlacementEnv = process.env): {
  cpuOvercommitRatio: number;
  skipDeepSleep: boolean;
} {
  return {
    cpuOvercommitRatio: resolveProxmoxCpuOvercommitRatio(env),
    skipDeepSleep: placementSkipsDeepSleep(env),
  };
}

/** Exact RPC argument fragment for the durable placement write authority. */
export function proxmoxPlacementRpcPolicy(env: PlacementEnv = process.env): {
  p_cpu_overcommit_ratio: number;
  p_skip_sleep: boolean;
} {
  const policy = proxmoxPlacementPolicy(env);
  return {
    p_cpu_overcommit_ratio: policy.cpuOvercommitRatio,
    p_skip_sleep: policy.skipDeepSleep,
  };
}
