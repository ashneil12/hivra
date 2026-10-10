/**
 * USD price of one year of plan access paid with $HermesOS.
 *
 * Client-safe (no server imports): the billing page shows these numbers and
 * `yearly-token-quotes.ts` mints quotes from them, so the price a user sees is
 * the price the server charges. Tier keys follow the token lane's naming:
 * "pro" is the operator plan and "power" is the fleet plan.
 *
 * Hold-to-qualify amounts are deliberately NOT here. They depend on the
 * user's pricing epoch and founders status and are resolved on the server
 * (see tier-thresholds.ts), so the billing UI links to the wallet page for
 * them instead of printing a number.
 */
import {
  HERMESOS_TOKEN,
  HIVRA_DISPLAY_UNIT,
  HIVRA_SYMBOL,
  platformTokenByAddress,
} from "./token-registry";

export const YEARLY_TOKEN_USD = {
  pro: 49,
  power: 99,
} as const;

export type YearlyTokenTier = keyof typeof YEARLY_TOKEN_USD;

/** Billing plan key each yearly $HermesOS tier entitles. */
export const YEARLY_TOKEN_TIER_PLAN = {
  pro: "operator",
  power: "fleet",
} as const satisfies Record<YearlyTokenTier, string>;

/** What people call the legacy Base token everywhere in the product. */
export const HERMESOS_DISPLAY_UNIT = HERMESOS_TOKEN.displayUnit;

/**
 * Unit label to show next to a platform-token amount.
 *
 * Pass the token's contract address when it is known: the registry then names
 * the unit exactly. Without it, the stored symbol decides. $HIVRA is stored as
 * "HIVRA". $HermesOS is stored as "HermesOS", and rows written before the token
 * registry carry "Hivra", so every other spelling of hivra/hermesos reads as
 * $HermesOS. Other assets (USDC, VVV, ETH) pass through.
 */
export function displayTokenUnit(
  symbol: string | null | undefined,
  tokenAddress?: string | null
): string {
  const token = platformTokenByAddress(tokenAddress);
  if (token) return token.displayUnit;
  const trimmed = symbol?.trim().replace(/^\$/, "") ?? "";
  if (trimmed === HIVRA_SYMBOL) return HIVRA_DISPLAY_UNIT;
  const normalized = trimmed.toLowerCase();
  if (!normalized || normalized === "hivra" || normalized === "hermesos") return HERMESOS_DISPLAY_UNIT;
  return symbol!.trim();
}

/** The yearly $HermesOS tier that buys a billing plan, or null when none does. */
export function yearlyTokenTierForPlan(planKey: string | null | undefined): YearlyTokenTier | null {
  if (planKey === YEARLY_TOKEN_TIER_PLAN.pro) return "pro";
  if (planKey === YEARLY_TOKEN_TIER_PLAN.power) return "power";
  return null;
}
