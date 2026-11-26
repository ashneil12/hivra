/**
 * Holder-tier pricing and threshold types.
 *
 * Current new-entrant holder pricing is locked to USD value and converted to
 * token units with a live market price at quote/evaluation time:
 *
 *   - Pro   (2 vCPU / 4 GB):  $299
 *   - Power (4 vCPU / 8 GB):  $599
 *
 * There is one active price for new qualifications. The April/May launch
 * window, per-user founders rate, test overrides and static token-quantity
 * fallbacks are retired for new entrants: a static token amount is necessarily
 * stale as soon as the market price moves, so production quote and threshold
 * paths must use live-thresholds.ts instead.
 *
 * Existing qualification rows are not repriced. `qualifying_quantity`,
 * `threshold_at_qualification`, the historical `PRO_LAUNCH` / `PRO_STANDARD` /
 * `POWER_LAUNCH` / `POWER_STANDARD` codes, the token the row was earned in,
 * and the entitlement it grants remain valid. If a holder later loses and
 * re-qualifies for a tier, that new qualification uses the current price.
 */

import { HOLDER_TIER_TERMS } from "./holder-tier-terms";
import { HERMESOS_TOKEN } from "./token-registry";

export type TierKey = "pro" | "power";
export type ThresholdEpoch = "launch" | "standard";

/**
 * Every code the database may already carry. New rows use only the STANDARD
 * codes; LAUNCH codes remain in the type so historical rows decode and keep
 * their original locked quantities.
 */
export type ThresholdTierCode =
  | "PRO_LAUNCH"
  | "PRO_STANDARD"
  | "POWER_LAUNCH"
  | "POWER_STANDARD";

/** USD value target for each tier code. The LAUNCH values are historical. */
export const USD_TARGET_CENTS: Record<ThresholdTierCode, number> = {
  PRO_LAUNCH: 9900,
  PRO_STANDARD: HOLDER_TIER_TERMS.pro.usdCents,
  POWER_LAUNCH: 19900,
  POWER_STANDARD: HOLDER_TIER_TERMS.power.usdCents,
};

/** The current new-entrant USD target by tier. */
export const ACTIVE_HOLDER_USD_TARGET_CENTS: Record<TierKey, number> = {
  pro: HOLDER_TIER_TERMS.pro.usdCents,
  power: HOLDER_TIER_TERMS.power.usdCents,
};

/** The threshold code written for a new qualification in a tier. */
export function activeThresholdTierCode(tier: TierKey): Extract<ThresholdTierCode, "PRO_STANDARD" | "POWER_STANDARD"> {
  return tier === "pro" ? "PRO_STANDARD" : "POWER_STANDARD";
}

/** The current USD target a quote or live threshold must use for a tier. */
export function activeHolderUsdTargetCents(tier: TierKey): number {
  return ACTIVE_HOLDER_USD_TARGET_CENTS[tier];
}

/**
 * Re-qualification limits. A breach starts a short grace; once suspended, a
 * holder can re-qualify only after cooldown and within the rolling cap.
 */
export const REQUALIFICATION_GRACE_HOURS = 24;
export const REQUALIFICATION_COOLDOWN_DAYS = 7;
export const REQUALIFICATION_CAP_PER_YEAR = 2;
export const REQUALIFICATION_WINDOW_DAYS = 365;

/**
 * A fully-qualified live threshold: which tier, which pricing epoch the row
 * is compatible with, the persisted code, and the token-unit amount computed
 * from a live price. Historical rows may carry launch codes and amounts;
 * current resolution always uses the standard epoch.
 */
export interface ResolvedThreshold {
  tier: TierKey;
  epoch: ThresholdEpoch;
  code: ThresholdTierCode;
  amount: bigint;
}

export interface TierThresholdsForEpoch {
  pro: ResolvedThreshold;
  power: ResolvedThreshold;
  epoch: ThresholdEpoch;
}

export const HERMESOS_TOKEN_DECIMALS = HERMESOS_TOKEN.decimals;
