/**
 * Canonical tier → resource spec mapping.
 *
 * Single source of truth so Stripe webhook, token snapshot watcher, dashboard
 * display, warden cap policy, and Proxmox provisioning all agree on what a
 * legacy Free tier or "operator" tier means in CPU/RAM terms.
 *
 * Wallclock daily caps live in warden (Python side, in DEFAULT_TIER_CAPS_SECONDS)
 * — keeping caps near the enforcement code so their semantics are obvious.
 */

import "server-only";

import { PLANS } from "@/lib/subscription";
import { log } from "@/lib/logger";
import {
  type TierSpec,
  isPaidTier,
  applyComputeBoost,
} from "@/lib/services/tier-boost";

// Re-export the PLANS-free boost primitives so existing tier-specs importers
// keep working unchanged. The definitions live in tier-boost.ts to keep
// PLANS out of the import graph of provisioning / the boost evaluator.
export {
  VENICE_BOOST_CPU,
  VENICE_BOOST_RAM_MB,
  VENICE_BOOST_USD_THRESHOLD,
  isPaidTier,
  applyComputeBoost,
} from "@/lib/services/tier-boost";
export type { TierSpec } from "@/lib/services/tier-boost";

const LOG_SOURCE = "tier-specs";

/** All tier keys recognised by the system. Keep in sync with warden. */
export type TierKey =
  | "credit_base"     //  Legacy persisted Free tier alias
  | "token_base"      //  $HERMES holder
  | "operator"        //  Paid Pro plan ($9.99/mo)
  | "fleet"           //  Paid Power plan ($19.99/mo)
  | "command";        //  Paid Command plan ($49/mo)

export interface TierProvisioningLimits {
  maxInstances: number;
  totalCpu: number;
  totalRam: number;
  maxCpuPerInstance: number;
  maxRamPerInstance: number;
}

const TIER_SPECS: Record<TierKey, TierSpec> = {
  credit_base: {
    cpuLimit: 0.5,
    ramLimitMb: 1024,
    label: "Free",
  },
  token_base: {
    cpuLimit: 0.5,
    ramLimitMb: 1024,
    label: "Starter (Token Holder)",
  },
  // Pro/Power/Command pull from PLANS so a price/spec change in
  // subscription/plans.ts propagates everywhere.
  operator: {
    cpuLimit: PLANS.operator.maxCpuPerAgent,
    ramLimitMb: PLANS.operator.maxRamPerAgent,
    label: PLANS.operator.name,
  },
  fleet: {
    cpuLimit: PLANS.fleet.maxCpuPerAgent,
    ramLimitMb: PLANS.fleet.maxRamPerAgent,
    label: PLANS.fleet.name,
  },
  command: {
    cpuLimit: PLANS.command.maxCpuPerAgent,
    ramLimitMb: PLANS.command.maxRamPerAgent,
    label: PLANS.command.name,
  },
};

const TIER_LIMITS: Record<TierKey, TierProvisioningLimits> = {
  credit_base: {
    maxInstances: 1,
    totalCpu: 0.5,
    totalRam: 1024,
    maxCpuPerInstance: 0.5,
    maxRamPerInstance: 1024,
  },
  token_base: {
    maxInstances: 1,
    totalCpu: 0.5,
    totalRam: 1024,
    maxCpuPerInstance: 0.5,
    maxRamPerInstance: 1024,
  },
  operator: {
    maxInstances: PLANS.operator.maxAgents,
    totalCpu: PLANS.operator.totalCpu,
    totalRam: PLANS.operator.totalRam,
    maxCpuPerInstance: PLANS.operator.maxCpuPerAgent,
    maxRamPerInstance: PLANS.operator.maxRamPerAgent,
  },
  fleet: {
    maxInstances: PLANS.fleet.maxAgents,
    totalCpu: PLANS.fleet.totalCpu,
    totalRam: PLANS.fleet.totalRam,
    maxCpuPerInstance: PLANS.fleet.maxCpuPerAgent,
    maxRamPerInstance: PLANS.fleet.maxRamPerAgent,
  },
  command: {
    maxInstances: PLANS.command.maxAgents,
    totalCpu: PLANS.command.totalCpu,
    totalRam: PLANS.command.totalRam,
    maxCpuPerInstance: PLANS.command.maxCpuPerAgent,
    maxRamPerInstance: PLANS.command.maxRamPerAgent,
  },
};

export function resolveTierSpec(tier: TierKey | string): TierSpec {
  if (tier in TIER_SPECS) return TIER_SPECS[tier as TierKey];
  // Unknown tier → fall back to free. Loud-but-harmless: log so we notice
  // typos in callers.
  log.warn("unknown tier, falling back to free tier", {
    source: LOG_SOURCE,
    failureType: "unknown_tier_fallback",
    requestedTier: tier,
  });
  return TIER_SPECS.credit_base;
}

/**
 * Resolve the effective per-instance spec for a tier, including the Venice
 * boost only when the user is boost-eligible AND the tier is paid. Single
 * source of truth so the DB write, the live Proxmox resize, and any future
 * provisioning path all compute the identical number.
 */
export function resolveEffectiveTierSpec(
  tier: TierKey | string,
  veniceBoost: boolean
): TierSpec {
  return applyComputeBoost(resolveTierSpec(tier), veniceBoost && isPaidTier(tier));
}

export function resolveTierProvisioningLimits(tier: TierKey | string): TierProvisioningLimits {
  if (tier in TIER_LIMITS) return TIER_LIMITS[tier as TierKey];
  log.warn("unknown tier limits, falling back to free tier", {
    source: LOG_SOURCE,
    failureType: "unknown_tier_limits_fallback",
    requestedTier: tier,
  });
  return TIER_LIMITS.credit_base;
}

/** Reverse map: Stripe plan key → tier key. Mirrors the PLANS object. */
export function tierFromPlanKey(planKey: string): TierKey {
  if (
    planKey === "operator" ||
    planKey === "fleet" ||
    planKey === "command"
  ) {
    return planKey;
  }
  log.warn("unknown plan key, falling back to free tier", {
    source: LOG_SOURCE,
    failureType: "unknown_plan_key_fallback",
    requestedPlanKey: planKey,
  });
  return "credit_base";
}
