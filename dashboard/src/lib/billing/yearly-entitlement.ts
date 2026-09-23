/**
 * Which yearly $HermesOS subscription entitles a user, and to what compute.
 *
 * A user can hold one live ('active' or 'grace') `yearly_token_subscriptions`
 * row per tier: settle_yearly_token_payment renews by marking the live
 * same-tier row 'renewed' and inserting a fresh one, and buying Pro while a
 * Power year is running inserts a Pro row beside it. The entitling row is
 * therefore chosen by tier rank (Power > Pro), then the later expires_at, then
 * the later paid_at — never simply the newest payment, which would let a Pro
 * renewal shrink a paid Power year to Pro compute.
 *
 * Every reader that turns yearly rows into a tier must use this order: the
 * refresh-token-tiers cron (live Proxmox resizes), resolveEffectiveSubscription
 * (what createInstance provisions), and the ORDER BY in
 * public.reconcile_stale_subscription_state_to_free. If they disagree, the
 * cron and the provisioning path fight over the same instances.
 */

import type { TierKey as YearlyTokenTier } from "@/lib/billing/tier-thresholds";

/** Statuses in which a yearly row still entitles the user to its tier. */
export const YEARLY_LIVE_STATUSES = ["active", "grace"] as const;

export interface YearlyEntitlementRow {
  tier: YearlyTokenTier;
  expires_at: string;
  paid_at: string;
}

const YEARLY_TIER_RANK: Record<YearlyTokenTier, number> = { pro: 1, power: 2 };

function compareYearlyEntitlement(a: YearlyEntitlementRow, b: YearlyEntitlementRow): number {
  return (
    YEARLY_TIER_RANK[a.tier] - YEARLY_TIER_RANK[b.tier] ||
    Date.parse(a.expires_at) - Date.parse(b.expires_at) ||
    Date.parse(a.paid_at) - Date.parse(b.paid_at)
  );
}

/**
 * The live row that entitles the user, or null. Callers pass rows already
 * filtered to YEARLY_LIVE_STATUSES; rows with an unknown tier are ignored.
 */
export function pickEntitledYearlySubscription<Row extends YearlyEntitlementRow>(
  rows: readonly Row[]
): Row | null {
  return rows
    .filter((row) => row.tier in YEARLY_TIER_RANK)
    .reduce<Row | null>(
      (best, row) => (!best || compareYearlyEntitlement(row, best) > 0 ? row : best),
      null
    );
}

/** The plan whose compute a yearly tier buys: Power → fleet, Pro → operator. */
export function yearlyTierPlanKey(tier: YearlyTokenTier): "fleet" | "operator" {
  return tier === "power" ? "fleet" : "operator";
}
