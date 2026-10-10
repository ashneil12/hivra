/**
 * Token holding thresholds for Pro and Power tier eligibility.
 *
 * Three rules from BUILD_PLAN.md (locked spec, 2026-04-29):
 *
 *   1. Thresholds are denominated in TOKEN UNITS (base units, not USD).
 *      A user's qualifying quantity is locked in at the moment they
 *      first cross the threshold; price moves never trigger downgrade
 *      for existing holders.
 *
 *   2. New entrants pay the CURRENT threshold at the time they deposit.
 *      Existing holders are grandfathered at their original quantity.
 *
 *   3. There are TWO threshold tiers per Pro/Power: a launch promo
 *      rate (first 30 days from public launch) and a standard rate
 *      (after the launch window closes). New entrants in the launch
 *      window pay the launch rate; new entrants after the window
 *      pay the standard rate. Existing holders are grandfathered
 *      regardless of which window they qualified in.
 *
 * Calibration values below are computed from the locked USD targets
 * and a snapshot of the $HERMESOS market price at the moment of
 * calibration (see "Calibration notes" comment block below).
 *
 * Quarterly review:
 *   - Read current $HERMESOS price.
 *   - Recalculate token quantities for the same USD targets.
 *   - Update constants below.
 *   - Update calibration-notes comment block with the date + new price
 *     + reasoning.
 *   - 30 days notice via dashboard + email before threshold change
 *     (existing depositors grandfathered for at least 12 months).
 */

import { HERMESOS_TOKEN } from "./token-registry";

// The static calibration constants below are $HermesOS amounts. Live
// thresholds (live-thresholds.ts) price every platform token from the same
// USD targets, so the launch and founders discounts carry over to $HIVRA.
const HERMESOS_TOKEN_DECIMALS = HERMESOS_TOKEN.decimals;

// ────────────────────────────────────────────────────────────────────
// Calibration notes
// ────────────────────────────────────────────────────────────────────
//
//   Calibrated on:           2026-04-29
//   $HERMESOS market price:  $0.00002609 / token
//                            (source: GeckoTerminal, Hivra/USD pool
//                             on Uniswap V4 Base, 2026-04-29 evening UK)
//   Token decimals:          18
//
//   USD targets (locked spec, 2026-04-30 final pricing pass — Pro
//   launch trimmed from $100 → $99, Power launch unchanged at $199):
//     Pro launch:    $99   →  ~3,794,557 tokens  →  3794557 × 10^18
//     Pro standard:  $149  →  ~5,710,999 tokens  →  5710999 × 10^18
//     Power launch:  $199  →  ~7,627,443 tokens  →  7627443 × 10^18
//     Power standard:$299  → ~11,460,330 tokens  → 11460330 × 10^18
//
//   Launch promo window:  2026-04-30 → 2026-05-30 (30 days)
//
//   Quarterly review log:
//     [DATE] - [WHO] - [WHY THE NUMBERS CHANGED]
//
// ────────────────────────────────────────────────────────────────────
// Test/preview overrides
// ────────────────────────────────────────────────────────────────────
//
// In NON-PRODUCTION environments, the threshold values and the launch
// promo end date can be overridden via env vars so a small test deposit
// (e.g. $5 worth of $HERMESOS) qualifies a test user without needing
// $100+ of real tokens. Production ignores all overrides — the locked
// spec values always apply.
//
// Override env vars (whole tokens, not base units):
//   HERMES_TIER_THRESHOLD_OVERRIDE_PRO_LAUNCH       (e.g. "200000")
//   HERMES_TIER_THRESHOLD_OVERRIDE_PRO_STANDARD     (e.g. "300000")
//   HERMES_TIER_THRESHOLD_OVERRIDE_POWER_LAUNCH     (e.g. "500000")
//   HERMES_TIER_THRESHOLD_OVERRIDE_POWER_STANDARD   (e.g. "750000")
//   HERMES_LAUNCH_PROMO_END_DATE_OVERRIDE           (ISO 8601 string)
//
// Gate: overrides are only honored when VERCEL_ENV !== 'production'.
// Local dev (no VERCEL_ENV) and Vercel previews honor overrides;
// the production deployment ignores them.

function isProductionEnv(): boolean {
  // Vercel sets VERCEL_ENV in every deployment ("production" | "preview" |
  // "development"). Local dev doesn't have it set at all. Anything other
  // than the literal "production" string honors overrides.
  if (typeof process === "undefined") return false;
  return process.env.VERCEL_ENV === "production";
}

function readWholeTokensOverride(envName: string): bigint | null {
  if (isProductionEnv()) return null;
  const raw = process.env[envName];
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    if (typeof console !== "undefined" && trimmed !== "") {
      // eslint-disable-next-line no-console
      console.warn(
        `[tier-thresholds] ignoring invalid ${envName}=${raw} (must be a positive integer of whole tokens)`
      );
    }
    return null;
  }
  const tokens = BigInt(trimmed);
  if (tokens <= 0n) return null;
  return tokens * 10n ** BigInt(HERMESOS_TOKEN_DECIMALS);
}

function readDateOverride(envName: string): Date | null {
  if (isProductionEnv()) return null;
  const raw = process.env[envName];
  if (!raw) return null;
  const parsed = new Date(raw.trim());
  if (Number.isNaN(parsed.getTime())) {
    if (typeof console !== "undefined") {
      // eslint-disable-next-line no-console
      console.warn(
        `[tier-thresholds] ignoring invalid ${envName}=${raw} (must be ISO 8601, e.g. 2026-05-30T23:59:59Z)`
      );
    }
    return null;
  }
  return parsed;
}

const PRO_LAUNCH_OVERRIDE = readWholeTokensOverride(
  "HERMES_TIER_THRESHOLD_OVERRIDE_PRO_LAUNCH"
);
const PRO_STANDARD_OVERRIDE = readWholeTokensOverride(
  "HERMES_TIER_THRESHOLD_OVERRIDE_PRO_STANDARD"
);
const POWER_LAUNCH_OVERRIDE = readWholeTokensOverride(
  "HERMES_TIER_THRESHOLD_OVERRIDE_POWER_LAUNCH"
);
const POWER_STANDARD_OVERRIDE = readWholeTokensOverride(
  "HERMES_TIER_THRESHOLD_OVERRIDE_POWER_STANDARD"
);
const LAUNCH_PROMO_END_OVERRIDE = readDateOverride(
  "HERMES_LAUNCH_PROMO_END_DATE_OVERRIDE"
);

if (
  typeof console !== "undefined" &&
  (PRO_LAUNCH_OVERRIDE ||
    PRO_STANDARD_OVERRIDE ||
    POWER_LAUNCH_OVERRIDE ||
    POWER_STANDARD_OVERRIDE ||
    LAUNCH_PROMO_END_OVERRIDE)
) {
  // eslint-disable-next-line no-console
  console.warn(
    "[tier-thresholds] non-production overrides active — DO NOT enable in production. " +
      `pro_launch=${PRO_LAUNCH_OVERRIDE ?? "default"} ` +
      `pro_standard=${PRO_STANDARD_OVERRIDE ?? "default"} ` +
      `power_launch=${POWER_LAUNCH_OVERRIDE ?? "default"} ` +
      `power_standard=${POWER_STANDARD_OVERRIDE ?? "default"} ` +
      `launch_promo_end=${LAUNCH_PROMO_END_OVERRIDE?.toISOString() ?? "default"}`
  );
}

// ────────────────────────────────────────────────────────────────────
// Founders-rate allowlist (per-user, production-honored)
// ────────────────────────────────────────────────────────────────────
//
// After the global launch promo window closes, specific users can still
// be granted the launch ("founders") rate by listing their Clerk user id
// in HERMES_FOUNDERS_RATE_USER_IDS (comma- or whitespace-separated).
//
// Unlike the test/preview overrides above, this IS honored in production —
// it's a deliberate per-user grant, not a test seam. Listing a user forces
// the launch epoch for them in every threshold resolver, so the eligibility
// cron snapshots them against the (cheaper) launch threshold and the
// deposit-quote flow prices them at the launch USD target. Once a listed
// user qualifies, their qualifying_quantity is snapshotted on
// token_tier_qualifications and they stay grandfathered even if later
// removed from the list.
//
// Example: HERMES_FOUNDERS_RATE_USER_IDS="user_2abc...,user_3def..."

function parseFoundersRateUserIds(raw: string | undefined): ReadonlySet<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(/[\s,]+/)
      .map((id) => id.trim())
      .filter((id) => id.length > 0)
  );
}

const FOUNDERS_RATE_USER_IDS = parseFoundersRateUserIds(
  typeof process !== "undefined"
    ? process.env.HERMES_FOUNDERS_RATE_USER_IDS
    : undefined
);

/**
 * True when the given user has been granted the launch ("founders") rate
 * past the global promo window via HERMES_FOUNDERS_RATE_USER_IDS. Returns
 * false for null/undefined ids and when the allowlist is empty (the
 * default — so this is a no-op until an id is explicitly listed).
 */
export function isFoundersRateUser(userId: string | null | undefined): boolean {
  if (!userId) return false;
  return FOUNDERS_RATE_USER_IDS.has(userId);
}

// ────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────

/**
 * Canonical USD targets per tier × epoch. Live-priced threshold
 * resolution divides these by the live $HERMESOS price to get the
 * token-quantity threshold at evaluation time. The static
 * PRO_THRESHOLD_LAUNCH_TOKEN_UNITS / etc. constants below remain as
 * a last-resort fallback when the price feed is unreachable.
 */
export type ThresholdTierCode =
  | "PRO_LAUNCH"
  | "PRO_STANDARD"
  | "POWER_LAUNCH"
  | "POWER_STANDARD";

export const USD_TARGET_CENTS: Record<ThresholdTierCode, number> = {
  PRO_LAUNCH: 9900,
  PRO_STANDARD: 14900,
  POWER_LAUNCH: 19900,
  POWER_STANDARD: 29900,
};

/** Pro launch threshold (first 30 days of public launch). */
export const PRO_THRESHOLD_LAUNCH_TOKEN_UNITS: bigint =
  PRO_LAUNCH_OVERRIDE ?? 3_794_557n * 10n ** BigInt(HERMESOS_TOKEN_DECIMALS);

/** Pro standard threshold (after the launch promo window closes). */
export const PRO_THRESHOLD_STANDARD_TOKEN_UNITS: bigint =
  PRO_STANDARD_OVERRIDE ?? 5_710_999n * 10n ** BigInt(HERMESOS_TOKEN_DECIMALS);

/** Power launch threshold (first 30 days of public launch). */
export const POWER_THRESHOLD_LAUNCH_TOKEN_UNITS: bigint =
  POWER_LAUNCH_OVERRIDE ?? 7_627_443n * 10n ** BigInt(HERMESOS_TOKEN_DECIMALS);

/** Power standard threshold (after the launch promo window closes). */
export const POWER_THRESHOLD_STANDARD_TOKEN_UNITS: bigint =
  POWER_STANDARD_OVERRIDE ?? 11_460_330n * 10n ** BigInt(HERMESOS_TOKEN_DECIMALS);

/**
 * End of the launch promo window. After this timestamp new entrants
 * pay the standard threshold. Existing holders are unaffected.
 *
 * Stored as ISO string so it survives env / build boundaries cleanly.
 */
export const LAUNCH_PROMO_END_DATE: Date =
  LAUNCH_PROMO_END_OVERRIDE ?? new Date("2026-05-30T23:59:59Z");

/**
 * Re-qualification limits per BUILD_PLAN.md.
 *
 * Updated 2026-04-30: grace shortened from 48h → 24h to align with the
 * withdraw flow. Rationale: a holder who explicitly clicks Withdraw is
 * declaring intent to exit; 24h is plenty of time for them to re-deposit
 * if they change their mind. Longer grace was a holdover from the
 * pre-withdraw spec where the only way out was to send tokens elsewhere.
 */
export const REQUALIFICATION_GRACE_HOURS = 24;
export const REQUALIFICATION_COOLDOWN_DAYS = 7;
export const REQUALIFICATION_CAP_PER_YEAR = 2;
export const REQUALIFICATION_WINDOW_DAYS = 365;

// ────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────

export type TierKey = "pro" | "power";
export type ThresholdEpoch = "launch" | "standard";

/**
 * A fully-qualified threshold: which tier, which epoch (launch vs
 * standard), and the token-unit amount required at that epoch.
 *
 * The `code` field ("PRO_LAUNCH" / "PRO_STANDARD" / etc.) is what
 * gets persisted into `token_tier_qualifications.qualifying_threshold_tier`
 * so the system knows what each user qualified against.
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
  promoEndsAt: Date;
}

// ────────────────────────────────────────────────────────────────────
// Resolvers
// ────────────────────────────────────────────────────────────────────

/** Options shared by the active-threshold resolvers. */
export interface ThresholdResolveOptions {
  /**
   * Force the launch epoch regardless of the date. Used to grant the
   * founders rate to allowlisted users (see {@link isFoundersRateUser})
   * after the global launch promo window closes.
   */
  forceLaunchEpoch?: boolean;
}

/**
 * Returns the active threshold pair for a given moment.
 *
 *   now < LAUNCH_PROMO_END_DATE → epoch="launch"
 *   now ≥ LAUNCH_PROMO_END_DATE → epoch="standard"
 *
 * Pass `forceLaunchEpoch` to pin a specific user to the launch epoch past
 * the window (the founders-rate grant).
 *
 * The deposit flow uses this when a NEW user qualifies, to record
 * which threshold they qualified against. Existing holders are
 * unaffected — they keep their snapshotted qualifying quantity.
 */
export function resolveActiveThresholds(
  now: Date = new Date(),
  options: ThresholdResolveOptions = {}
): TierThresholdsForEpoch {
  const inLaunchWindow = options.forceLaunchEpoch === true || now < LAUNCH_PROMO_END_DATE;
  const epoch: ThresholdEpoch = inLaunchWindow ? "launch" : "standard";

  return {
    epoch,
    promoEndsAt: LAUNCH_PROMO_END_DATE,
    pro: {
      tier: "pro",
      epoch,
      code: inLaunchWindow ? "PRO_LAUNCH" : "PRO_STANDARD",
      amount: inLaunchWindow
        ? PRO_THRESHOLD_LAUNCH_TOKEN_UNITS
        : PRO_THRESHOLD_STANDARD_TOKEN_UNITS,
    },
    power: {
      tier: "power",
      epoch,
      code: inLaunchWindow ? "POWER_LAUNCH" : "POWER_STANDARD",
      amount: inLaunchWindow
        ? POWER_THRESHOLD_LAUNCH_TOKEN_UNITS
        : POWER_THRESHOLD_STANDARD_TOKEN_UNITS,
    },
  };
}

/** Best tier the supplied balance qualifies for AT THE CURRENT EPOCH, or null. */
export function bestQualifyingTier(
  balance: bigint,
  active: TierThresholdsForEpoch = resolveActiveThresholds()
): TierKey | null {
  if (balance >= active.power.amount) return "power";
  if (balance >= active.pro.amount) return "pro";
  return null;
}

/** Resolve a single tier's active threshold (helper for the evaluator). */
export function resolveActiveThresholdForTier(
  tier: TierKey,
  now: Date = new Date(),
  options: ThresholdResolveOptions = {}
): ResolvedThreshold {
  const active = resolveActiveThresholds(now, options);
  return tier === "pro" ? active.pro : active.power;
}

/** Re-export for convenience so consumers don't import token-holdings separately. */
export { HERMESOS_TOKEN_DECIMALS };

// ────────────────────────────────────────────────────────────────────
// Backwards-compatibility shim
// ────────────────────────────────────────────────────────────────────
// The earlier evaluator API exported a simpler `getTierThresholds()`
// returning a plain {pro, power} pair. Existing call sites and tests
// rely on this shape; keep it as a thin wrapper that returns the
// current epoch's amounts so refactor scope stays bounded.

export interface TierThresholds {
  pro: bigint;
  power: bigint;
}

type TierThresholdSource = "configured" | "missing";

export interface TierThresholdResult {
  source: TierThresholdSource;
  thresholds: TierThresholds | null;
}

export function getTierThresholds(now: Date = new Date()): TierThresholdResult {
  const active = resolveActiveThresholds(now);
  return {
    source: "configured",
    thresholds: {
      pro: active.pro.amount,
      power: active.power.amount,
    },
  };
}
