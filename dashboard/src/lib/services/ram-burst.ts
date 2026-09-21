/**
 * RAM burst / memory-overcommit resolver (PLANS-free, pure, testable).
 *
 * Today every VM is fully pinned: qemu `--memory` == the tier's RAM and the
 * balloon floor == memory, so the guest can never use more than it reserves.
 * RAM burst splits a tier's RAM into two numbers:
 *
 *   - baseline (MB): the GUARANTEED RAM. What placement reserves, what the user
 *     pays for, and the `--balloon` floor — the host can never reclaim a guest
 *     below this. Stays equal to the existing `ram_limit`, so placement math is
 *     unchanged (we still reserve baseline per VM).
 *   - ceiling  (MB): the BURST cap. Booted as qemu `--memory` and used as the
 *     agent container's cgroup limit, so the guest can freely use burst headroom
 *     while the host has room. Under host memory pressure Proxmox auto-balloons
 *     the guest back down toward `baseline` (never below). If a tenant's own
 *     workload exceeds `ceiling`, the container cgroup OOM-kills it (clean,
 *     blast-radius = that one tenant) and `restart: unless-stopped` brings it
 *     back — the upsell banner fires off the metering signal.
 *
 * Overcommit is the host's bet: Σ(baseline) stays within the host RAM budget
 * (placement enforces this, unchanged), while Σ(ceiling) may exceed it — exactly
 * the same shape as the existing 1.5× thin-pool disk overcommit.
 *
 * Lives apart from tier-specs.ts on purpose (no PLANS import) so the provisioning
 * graph can pull it without dragging the subscription module in — same reason
 * tier-boost.ts is separate.
 *
 * Gated by HERMES_RAM_BURST_ENABLED (default OFF): when disabled, `resolveRamBurst`
 * returns ceiling == baseline so provisioning/resize behave EXACTLY as before.
 */

type EnvLike = Record<string, string | undefined>;

/** Master gate. When not "true", burst is inert everywhere (ceiling = baseline). */
export const RAM_BURST_ENABLED_ENV = "HERMES_RAM_BURST_ENABLED";
/** Ceiling = baseline × this multiplier (default 2). Tunable without a deploy. */
export const RAM_BURST_MULTIPLIER_ENV = "HERMES_RAM_BURST_MULTIPLIER";
/** Hard cap on the burst ceiling, MB (default 32768 = 32 GB). */
export const RAM_BURST_CAP_MB_ENV = "HERMES_RAM_BURST_CAP_MB";

/**
 * Baselines at/below this (MB) are treated as non-burstable: free/starter tiers
 * (1024 MB) stay fully pinned so a $0 agent never gets host-overcommitted RAM.
 * Mirrors the free-tier RAM in tier-specs.ts; kept local to stay PLANS-free.
 */
export const RAM_BURST_MIN_BASELINE_MB = 1024;

const DEFAULT_MULTIPLIER = 2;
const DEFAULT_CAP_MB = 32768;

export interface RamBurstPlan {
  /** Guaranteed RAM (MB) — placement reservation + balloon floor. */
  baselineMb: number;
  /** Burst cap (MB) — qemu `--memory` + container cgroup limit. */
  ceilingMb: number;
  /** True when ceiling > baseline (this VM is actually overcommitted). */
  burstActive: boolean;
}

function envFlag(env: EnvLike, key: string): boolean {
  const v = env[key];
  return typeof v === "string" && v.trim().toLowerCase() === "true";
}

function envNumber(env: EnvLike, key: string, fallback: number): number {
  const v = env[key];
  if (typeof v !== "string" || !v.trim()) return fallback;
  const parsed = Number(v);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** True when the RAM-burst feature is enabled for this environment/host. */
export function isRamBurstEnabled(env: EnvLike = process.env): boolean {
  return envFlag(env, RAM_BURST_ENABLED_ENV);
}

/**
 * Resolve the burst plan for a VM whose guaranteed/paid baseline RAM is
 * `baselineMb`. Pure: depends only on the baseline + env config. When burst is
 * disabled, or the baseline is a non-burstable (free/starter) tier, the ceiling
 * equals the baseline and `burstActive` is false — i.e. the legacy pinned
 * allocation, byte-for-byte.
 */
export function resolveRamBurst(
  baselineMb: number,
  env: EnvLike = process.env,
  /** Explicit per-computer ceiling. Unlike the legacy environment default,
   * this is owner-selected launch intent and therefore remains active without
   * the fleet-wide feature flag. */
  ceilingOverrideMb?: number,
): RamBurstPlan {
  const baseline =
    Number.isFinite(baselineMb) && baselineMb > 0 ? Math.floor(baselineMb) : RAM_BURST_MIN_BASELINE_MB;

  if (ceilingOverrideMb !== undefined) {
    const ceiling = Number.isFinite(ceilingOverrideMb)
      ? Math.max(baseline, Math.floor(ceilingOverrideMb))
      : baseline;
    return { baselineMb: baseline, ceilingMb: ceiling, burstActive: ceiling > baseline };
  }

  if (!isRamBurstEnabled(env) || baseline <= RAM_BURST_MIN_BASELINE_MB) {
    return { baselineMb: baseline, ceilingMb: baseline, burstActive: false };
  }

  const multiplier = Math.max(1, envNumber(env, RAM_BURST_MULTIPLIER_ENV, DEFAULT_MULTIPLIER));
  const cap = Math.max(baseline, Math.floor(envNumber(env, RAM_BURST_CAP_MB_ENV, DEFAULT_CAP_MB)));
  const ceiling = Math.min(Math.max(baseline, Math.floor(baseline * multiplier)), cap);

  return { baselineMb: baseline, ceilingMb: ceiling, burstActive: ceiling > baseline };
}
