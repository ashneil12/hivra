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

/** What people call the live Base token everywhere in the product. */
export const HERMESOS_DISPLAY_UNIT = "$HermesOS";

/**
 * Unit label to show next to a $HermesOS amount. The server's token symbol
 * (persisted in holding snapshots and quotes) reads "Hivra", but the live
 * contract is $HermesOS and $HIVRA is only a proposal, so the UI never prints
 * the stored symbol for it. Other assets (USDC, VVV, ETH) pass through.
 */
export function displayTokenUnit(symbol: string | null | undefined): string {
  const normalized = symbol?.trim().replace(/^\$/, "").toLowerCase() ?? "";
  if (!normalized || normalized === "hivra" || normalized === "hermesos") return HERMESOS_DISPLAY_UNIT;
  return symbol!.trim();
}

/** The yearly $HermesOS tier that buys a billing plan, or null when none does. */
export function yearlyTokenTierForPlan(planKey: string | null | undefined): YearlyTokenTier | null {
  if (planKey === YEARLY_TOKEN_TIER_PLAN.pro) return "pro";
  if (planKey === YEARLY_TOKEN_TIER_PLAN.power) return "power";
  return null;
}
