/**
 * PLANS-free tier/boost primitives.
 *
 * These live apart from tier-specs.ts on purpose: tier-specs builds its
 * TIER_SPECS/TIER_LIMITS tables from `@/lib/subscription` PLANS at module load,
 * so importing it pulls the whole subscription module in. Modules that only
 * need the boost constants or the paid-tier check (instance-service provisioning,
 * the Venice boost evaluator) import from here instead, keeping their import
 * graph free of PLANS. tier-specs re-exports everything below for convenience.
 */

export interface TierSpec {
  /** vCPU cap per VM. Decimal allowed (0.5 = half-core via Proxmox cpulimit). */
  cpuLimit: number;
  /** RAM cap per VM, MB. */
  ramLimitMb: number;
  /** Display label, e.g. for the upgrade UI. */
  label: string;
}

// ── Venice compute boost ───────────────────────────────────────────────
// A user on a PAID tier (operator/fleet/command — reached via Stripe card OR
// $HERMESOS token qualification) who also holds ≥ $199 of VVV (Venice's token,
// valued via DEX) earns extra per-instance compute on top of their tier.

/** Extra vCPU granted by an active Venice compute boost. */
export const VENICE_BOOST_CPU = 1;
/** Extra RAM (MB) granted by an active Venice compute boost. */
export const VENICE_BOOST_RAM_MB = 2048;
/** USD value of VVV a user must hold for the boost to be active. */
export const VENICE_BOOST_USD_THRESHOLD = 199;

/** Tiers the Venice boost is allowed to stack on. Free/base tiers get nothing. */
const PAID_TIERS: ReadonlySet<string> = new Set(["operator", "fleet", "command"]);

/** True when `tier` is a paid tier eligible for the Venice compute boost. */
export function isPaidTier(tier: string): boolean {
  return PAID_TIERS.has(tier);
}

/**
 * Pure: add the Venice boost to a base spec when `active`. Returns a new
 * spec; never mutates. Caller decides eligibility (see resolveEffectiveTierSpec).
 */
export function applyComputeBoost(spec: TierSpec, active: boolean): TierSpec {
  if (!active) return spec;
  return {
    ...spec,
    cpuLimit: spec.cpuLimit + VENICE_BOOST_CPU,
    ramLimitMb: spec.ramLimitMb + VENICE_BOOST_RAM_MB,
  };
}
