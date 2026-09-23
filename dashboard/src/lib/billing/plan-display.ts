/**
 * Pure display models for the billing page: prices per cadence, computed
 * savings, the current plan's price line, plan-card labels and which call to
 * action each plan card offers.
 *
 * Every number here is derived from PLANS (card prices) or YEARLY_TOKEN_USD
 * ($HermesOS yearly prices) so the page can never advertise a price the
 * checkout does not charge. Nothing here reads flags or the network.
 */

import {
  ACTIVE_PLAN_KEYS,
  PLAN_ORDER,
  PLANS,
  isPlanUpgrade,
  type PlanKey,
} from "@/lib/subscription/plans";
import {
  YEARLY_TOKEN_TIER_PLAN,
  YEARLY_TOKEN_USD,
  yearlyTokenTierForPlan,
  type YearlyTokenTier,
} from "./token-plan-prices";

export type BillingCadence = "monthly" | "yearly";

export type PlanSource =
  | "stripe"
  | "free"
  | "token_holding"
  | "token_yearly"
  | "workspace_cloud"
  | "apple_iap";

/** How a plan is paid for on the Plans tab. */
export type PlanPaymentPath = "card" | "token";
/** The $HermesOS option: pay one year, or hold enough to qualify. */
export type TokenPlanMode = "yearly" | "hold";

export function isPlanKey(value: unknown): value is PlanKey {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(PLANS, value);
}

// ── Money ────────────────────────────────────────────────────────────────────

/** "$9.99", "$79", "$6.58". Whole dollars drop the cents. */
export function formatUsdCents(cents: number): string {
  const rounded = Math.round(cents);
  const dollars = rounded / 100;
  if (rounded % 100 === 0) return `$${dollars.toLocaleString("en-US")}`;
  return `$${dollars.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** The plan's yearly card price in cents, or null when it has none. */
export function planYearlyPriceCents(key: PlanKey): number | null {
  const plan = PLANS[key];
  if (!("yearlyPrice" in plan) || typeof plan.yearlyPrice !== "number") return null;
  return plan.yearlyPrice;
}

/** Card price for a cadence, in cents; null when the plan has no such price. */
export function planPriceCents(key: PlanKey, cadence: BillingCadence): number | null {
  if (cadence === "monthly") return PLANS[key].price;
  return planYearlyPriceCents(key);
}

/**
 * Percent saved paying yearly by card instead of twelve monthly payments,
 * rounded DOWN so the page never overstates it. Null when there is nothing
 * to save (free) or no yearly price (command).
 */
export function yearlySavingsPercent(key: PlanKey): number | null {
  const monthly = PLANS[key].price;
  const yearly = planYearlyPriceCents(key);
  if (!monthly || yearly === null || yearly <= 0) return null;
  const twelveMonths = monthly * 12;
  if (yearly >= twelveMonths) return null;
  return Math.floor(((twelveMonths - yearly) / twelveMonths) * 100);
}

/** The largest yearly saving across the plans on sale, for the cadence chip. */
export function bestYearlySavingsPercent(keys: readonly PlanKey[] = ACTIVE_PLAN_KEYS): number | null {
  const savings = keys
    .map((key) => yearlySavingsPercent(key))
    .filter((value): value is number => value !== null);
  return savings.length > 0 ? Math.max(...savings) : null;
}

/**
 * The yearly card price spread over twelve months, in whole cents, rounded
 * UP so twelve of them never add up to less than the yearly price ($79 a
 * year reads $6.59/mo, not $6.58).
 */
export function monthlyEquivalentCents(key: PlanKey): number | null {
  const yearly = planYearlyPriceCents(key);
  if (yearly === null || yearly <= 0) return null;
  return Math.ceil(yearly / 12);
}

/**
 * Percent saved paying a year with $HermesOS instead of a year by card,
 * rounded down. Null when the plan has no $HermesOS price.
 */
export function tokenYearlySavingsPercent(tier: YearlyTokenTier): number | null {
  const planKey: PlanKey = tier === "pro" ? "operator" : "fleet";
  const cardYearly = planYearlyPriceCents(planKey);
  const tokenCents = YEARLY_TOKEN_USD[tier] * 100;
  if (cardYearly === null || cardYearly <= tokenCents) return null;
  return Math.floor(((cardYearly - tokenCents) / cardYearly) * 100);
}

export interface PlanPriceDisplay {
  /** "$9.99" */
  amount: string;
  /** "/mo", "/yr", "a year" or "" */
  unit: string;
  /** Secondary line under the price, e.g. "$6.58/mo billed yearly". */
  subline: string | null;
}

/** What a plan card prints as its price for the chosen payment method. */
export function planPriceDisplay(
  key: PlanKey,
  options: { path: PlanPaymentPath; cadence: BillingCadence; tokenMode?: TokenPlanMode }
): PlanPriceDisplay {
  if (key === "free") {
    return { amount: "$0", unit: "", subline: "Free · no charge" };
  }

  if (options.path === "token") {
    const tier = yearlyTokenTierForPlan(key);
    if (!tier) return cardMonthly(key);
    if (options.tokenMode === "hold") {
      return {
        amount: "Hold",
        unit: "$HermesOS",
        subline: "Keep enough $HermesOS in a verified wallet · withdraw any time",
      };
    }
    return {
      amount: `$${YEARLY_TOKEN_USD[tier]}`,
      unit: "a year",
      subline: "Paid once in $HermesOS · 365 days · final, doesn't renew automatically",
    };
  }

  if (options.cadence === "yearly") {
    const yearly = planYearlyPriceCents(key);
    const perMonth = monthlyEquivalentCents(key);
    if (yearly !== null && yearly > 0) {
      return {
        amount: formatUsdCents(yearly),
        unit: "/yr",
        subline: perMonth !== null ? `${formatUsdCents(perMonth)}/mo billed yearly` : null,
      };
    }
  }

  return cardMonthly(key);
}

function cardMonthly(key: PlanKey): PlanPriceDisplay {
  return { amount: formatUsdCents(PLANS[key].price), unit: "/mo", subline: null };
}

// ── The current plan ────────────────────────────────────────────────────────

function defaultFormatDate(iso: string): string | null {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return null;
  return new Date(time).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/**
 * One line saying how the current plan is paid for, by entitlement source.
 *
 * The usage API does not say whether a card subscription is monthly or
 * yearly, so the card line never claims a per-month price. It also carries
 * no auto-renew signal (a subscription cancelled in the Stripe portal or
 * the App Store stays "active" until its period ends), so card and App
 * Store lines say when the current billing period ends, never that the plan
 * "renews". A failing payment is shown by the status badge next to it.
 * $HermesOS years do not renew; holding access lasts while the user holds.
 */
export function activePlanPriceLine(params: {
  planKey: string | null | undefined;
  source: PlanSource | null | undefined;
  currentPeriodEnd: string | null | undefined;
  formatDate?: (iso: string) => string | null;
}): string {
  const formatDate = params.formatDate ?? defaultFormatDate;
  const date = params.currentPeriodEnd ? formatDate(params.currentPeriodEnd) : null;

  switch (params.source) {
    case "token_yearly":
      return date
        ? `Paid with $HermesOS · active until ${date} · doesn't renew automatically`
        : "Paid with $HermesOS · doesn't renew automatically";
    case "token_holding":
      return "Unlocked by holding $HermesOS · active while you hold";
    case "apple_iap":
      return date
        ? `Billed through the App Store · current billing period ends ${date}`
        : "Billed through the App Store";
    case "workspace_cloud":
      return date
        ? `Included with Workspace Cloud · current billing period ends ${date}`
        : "Included with Workspace Cloud";
    case "free":
      return "Free · no charge";
    default:
      if (params.planKey === "free") return "Free · no charge";
      return date ? `Billed by card · current billing period ends ${date}` : "Billed by card";
  }
}

/** Days without activity after which a Free machine sleeps. */
export const FREE_IDLE_SLEEP_DAYS = 4;

/** Idle policy the servers enforce for a plan. */
export function planIdlePolicy(key: string | null | undefined): string {
  return key === "free" ? `Sleeps after ${FREE_IDLE_SLEEP_DAYS} idle days` : "Always on";
}

/**
 * The small line above a plan card's name — the plan's own tagline, so a
 * card can never borrow another plan's label (the old Free card read "Power").
 */
export function planCardEyebrow(key: PlanKey): string {
  return PLANS[key].tagline.replace(/\.\s*$/, "");
}

/**
 * Up to `limit` features for a plan card, skipping the ones the spec rows
 * already say (idle policy).
 */
export function planCardFeatures(key: PlanKey, limit = 4): string[] {
  return (PLANS[key].features as readonly string[])
    .filter((feature) => !/idle days|always-on/i.test(feature))
    .slice(0, limit);
}

export type PlanCardBadge = { kind: "current" | "popular"; label: string } | null;

export function planCardBadge(key: PlanKey, currentPlanKey: string | null | undefined): PlanCardBadge {
  if (key === currentPlanKey) return { kind: "current", label: "Current plan" };
  const plan = PLANS[key];
  if ("popular" in plan && plan.popular) return { kind: "popular", label: "Most popular" };
  return null;
}

/**
 * The plans the Plans tab shows, lowest first: everything on sale plus the
 * user's current plan when it is no longer sold (e.g. Command). In the
 * $HermesOS view only plans that can be paid with $HermesOS are listed,
 * plus the current plan.
 */
export function plansForLadder(params: {
  currentPlanKey: string | null | undefined;
  path: PlanPaymentPath;
}): PlanKey[] {
  const keys = new Set<PlanKey>(ACTIVE_PLAN_KEYS);
  if (isPlanKey(params.currentPlanKey)) keys.add(params.currentPlanKey);
  return PLAN_ORDER.filter((key) => {
    if (!keys.has(key)) return false;
    if (params.path === "token") {
      return key === params.currentPlanKey || yearlyTokenTierForPlan(key) !== null;
    }
    return true;
  });
}

// ── $HermesOS years ─────────────────────────────────────────────────────────

/**
 * Whether a year of `tier` paid with $HermesOS is worth offering to someone
 * on `currentPlanKey`: always with no paid plan, for the same tier (it adds
 * a year) and for a bigger tier. Never for a smaller tier: entitlement goes
 * to the highest tier, so a smaller year bought on top mostly buys nothing,
 * and it can replace a bigger holding-based plan. Token payments are final.
 *
 * The Plans tab and the Payment methods tab both use this one rule.
 */
export function tokenYearTierOffered(currentPlanKey: string | null | undefined, tier: YearlyTokenTier): boolean {
  const current = isPlanKey(currentPlanKey) && currentPlanKey !== "free" ? currentPlanKey : null;
  const tierPlan = YEARLY_TOKEN_TIER_PLAN[tier];
  return !current || current === tierPlan || isPlanUpgrade(current, tierPlan);
}

/**
 * True when paying for `tier` extends a $HermesOS year the user already has
 * (settlement adds the year to the live row of the same tier).
 */
export function isTokenYearRenewal(params: {
  currentPlanKey: string | null | undefined;
  source: PlanSource | null | undefined;
  tier: YearlyTokenTier;
}): boolean {
  return params.source === "token_yearly" && params.currentPlanKey === YEARLY_TOKEN_TIER_PLAN[params.tier];
}

// ── Plan card calls to action ───────────────────────────────────────────────

export type PlanCardCta =
  | { kind: "current"; label: string }
  | { kind: "start_free"; label: string }
  | { kind: "subscribe"; label: string }
  | { kind: "pay_yearly_token"; label: string; tier: YearlyTokenTier }
  | { kind: "hold_token"; label: string; href: string; tier: YearlyTokenTier }
  | { kind: "upgrade"; label: string }
  | { kind: "downgrade"; label: string }
  | { kind: "note"; note: string };

export const SMALLER_PLAN_NOT_SELF_SERVE = "Moving to a smaller plan isn't self-serve yet";
export const APPLE_PLAN_CHANGE_NOTE = "Change plans in the App Store";

/**
 * What a plan card lets the user do. Mirrors the page's existing semantics:
 * no plan → checkout (card) or the $HermesOS year/hold paths; a plan → the
 * change-plan confirmation for upgrades and flagged self-serve downgrades
 * between paid plans. Apple subscribers change plans in the App Store only.
 */
export function planCardCta(params: {
  planKey: PlanKey;
  currentPlanKey: string | null | undefined;
  source: PlanSource | null | undefined;
  path: PlanPaymentPath;
  tokenMode: TokenPlanMode;
  cadence: BillingCadence;
  selfServeDowngradeEnabled: boolean;
  changePlanRequiresCheckout: boolean;
}): PlanCardCta {
  const { planKey } = params;
  const plan = PLANS[planKey];
  const current = isPlanKey(params.currentPlanKey) ? params.currentPlanKey : null;

  if (current === planKey) {
    // A $HermesOS year doesn't renew by itself; paying again adds a year.
    const tier = yearlyTokenTierForPlan(planKey);
    if (
      params.path === "token" &&
      params.tokenMode === "yearly" &&
      tier &&
      isTokenYearRenewal({ currentPlanKey: current, source: params.source, tier })
    ) {
      return {
        kind: "pay_yearly_token",
        label: `Add a year · $${YEARLY_TOKEN_USD[tier]} in $HermesOS`,
        tier,
      };
    }
    return { kind: "current", label: "Current plan" };
  }

  if (params.path === "token") {
    const tier = yearlyTokenTierForPlan(planKey);
    if (!tier) return { kind: "note", note: "Not available with $HermesOS" };
    if (!tokenYearTierOffered(current, tier)) {
      return { kind: "note", note: "Your current plan already covers this" };
    }
    if (params.tokenMode === "hold") {
      return {
        kind: "hold_token",
        label: "See how much to hold",
        href: `/dashboard/wallet?from=billing&plan=${tier}`,
        tier,
      };
    }
    return {
      kind: "pay_yearly_token",
      label: `Pay a year · $${YEARLY_TOKEN_USD[tier]} in $HermesOS`,
      tier,
    };
  }

  if (!current) {
    if (planKey === "free") return { kind: "start_free", label: "Start free" };
    const price = planPriceDisplay(planKey, { path: "card", cadence: params.cadence });
    return { kind: "subscribe", label: `Subscribe · ${price.amount}${price.unit}` };
  }

  if (params.source === "apple_iap") return { kind: "note", note: APPLE_PLAN_CHANGE_NOTE };

  if (isPlanUpgrade(current, planKey)) {
    return { kind: "upgrade", label: `Upgrade to ${plan.name}` };
  }

  if (
    planKey !== "free" &&
    params.selfServeDowngradeEnabled &&
    !params.changePlanRequiresCheckout
  ) {
    return { kind: "downgrade", label: `Switch to ${plan.name}` };
  }

  if (planKey === "free" && (params.source === "stripe" || !params.source)) {
    return { kind: "note", note: "To move to Free, cancel your subscription" };
  }

  return { kind: "note", note: SMALLER_PLAN_NOT_SELF_SERVE };
}

/**
 * The plans on a ladder whose card starts a card checkout (subscribe, or an
 * upgrade that goes through checkout). A Monthly/Yearly choice only means
 * something when this list has a plan with a yearly price, and the savings
 * chip is computed from these plans only.
 */
export function plansSoldAtCheckout(entries: ReadonlyArray<{ planKey: PlanKey; cta: PlanCardCta }>): PlanKey[] {
  return entries
    .filter((entry) => entry.cta.kind === "subscribe" || entry.cta.kind === "upgrade")
    .map((entry) => entry.planKey);
}

/**
 * True when the user already pays by card or through Apple for a paid plan.
 * Those users never see the $HermesOS plan payment choice.
 */
export function hasPaidCardOrAppleSubscription(params: {
  planKey: string | null | undefined;
  source: PlanSource | null | undefined;
}): boolean {
  if (!params.planKey || params.planKey === "free") return false;
  return (
    params.source === "stripe" ||
    params.source === "apple_iap" ||
    params.source === "workspace_cloud" ||
    !params.source
  );
}
