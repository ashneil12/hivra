import {
  activePlanPriceLine,
  bestYearlySavingsPercent,
  formatUsdCents,
  hasPaidCardOrAppleSubscription,
  isTokenYearRenewal,
  monthlyEquivalentCents,
  planCardBadge,
  planCardCta,
  planCardEyebrow,
  planCardFeatures,
  planIdlePolicy,
  planPriceCents,
  planPriceDisplay,
  plansForLadder,
  plansSoldAtCheckout,
  tokenYearTierOffered,
  tokenYearlySavingsPercent,
  yearlySavingsPercent,
  SMALLER_PLAN_NOT_SELF_SERVE,
  APPLE_PLAN_CHANGE_NOTE,
} from "../plan-display";
import { YEARLY_TOKEN_USD, yearlyTokenTierForPlan } from "../token-plan-prices";
import { PLANS } from "@/lib/subscription/plans";

const date = (iso: string) => `D(${iso.slice(0, 10)})`;

describe("formatUsdCents", () => {
  it("drops cents for whole dollars and keeps two decimals otherwise", () => {
    expect(formatUsdCents(7900)).toBe("$79");
    expect(formatUsdCents(999)).toBe("$9.99");
    expect(formatUsdCents(658)).toBe("$6.58");
    expect(formatUsdCents(1990)).toBe("$19.90");
    expect(formatUsdCents(0)).toBe("$0");
  });
});

describe("prices per cadence", () => {
  it("reads monthly and yearly card prices from PLANS", () => {
    expect(planPriceCents("operator", "monthly")).toBe(PLANS.operator.price);
    expect(planPriceCents("operator", "yearly")).toBe(PLANS.operator.yearlyPrice);
    expect(planPriceCents("fleet", "yearly")).toBe(PLANS.fleet.yearlyPrice);
    // Command has no yearly price.
    expect(planPriceCents("command", "yearly")).toBeNull();
  });

  it("computes the monthly equivalent of a yearly price in whole cents, rounded up", () => {
    expect(monthlyEquivalentCents("operator")).toBe(Math.ceil(PLANS.operator.yearlyPrice / 12));
    // $79 / 12 = $6.5833: $6.58 x 12 = $78.96 would understate the price.
    expect(monthlyEquivalentCents("operator")).toBe(659);
    expect((monthlyEquivalentCents("operator") as number) * 12).toBeGreaterThanOrEqual(PLANS.operator.yearlyPrice);
    expect((monthlyEquivalentCents("fleet") as number) * 12).toBeGreaterThanOrEqual(PLANS.fleet.yearlyPrice);
    expect(monthlyEquivalentCents("free")).toBeNull();
    expect(monthlyEquivalentCents("command")).toBeNull();
  });
});

describe("computed savings", () => {
  it("rounds yearly card savings down from PLANS, never overstating them", () => {
    // $9.99 x 12 = $119.88 vs $79 → 34.1%; $19.99 x 12 = $239.88 vs $149 → 37.9%.
    expect(yearlySavingsPercent("operator")).toBe(34);
    expect(yearlySavingsPercent("fleet")).toBe(37);
    expect(yearlySavingsPercent("free")).toBeNull();
    expect(yearlySavingsPercent("command")).toBeNull();
    expect(bestYearlySavingsPercent()).toBe(37);
  });

  it("compares a $HermesOS year with a card year using the shared token prices", () => {
    // $49 vs $79 → 37.9%; $99 vs $149 → 33.5%.
    expect(tokenYearlySavingsPercent("pro")).toBe(37);
    expect(tokenYearlySavingsPercent("power")).toBe(33);
  });
});

describe("planPriceDisplay", () => {
  it("shows monthly card prices", () => {
    expect(planPriceDisplay("operator", { path: "card", cadence: "monthly" })).toEqual({
      amount: "$9.99",
      unit: "/mo",
      subline: null,
    });
  });

  it("shows yearly card prices with a per-month equivalent", () => {
    expect(planPriceDisplay("fleet", { path: "card", cadence: "yearly" })).toEqual({
      amount: "$149",
      unit: "/yr",
      subline: "$12.42/mo billed yearly",
    });
  });

  it("falls back to the monthly price when a plan has no yearly price", () => {
    expect(planPriceDisplay("command", { path: "card", cadence: "yearly" }).unit).toBe("/mo");
  });

  it("shows the $HermesOS year price from YEARLY_TOKEN_USD", () => {
    const display = planPriceDisplay("operator", { path: "token", cadence: "monthly", tokenMode: "yearly" });
    expect(display.amount).toBe(`$${YEARLY_TOKEN_USD.pro}`);
    expect(display.subline).toMatch(/doesn't renew automatically/);
  });

  it("never prints a hold amount", () => {
    const display = planPriceDisplay("fleet", { path: "token", cadence: "monthly", tokenMode: "hold" });
    expect(`${display.amount} ${display.unit} ${display.subline}`).not.toMatch(/\$\d/);
  });

  it("shows Free as free", () => {
    expect(planPriceDisplay("free", { path: "card", cadence: "yearly" })).toEqual({
      amount: "$0",
      unit: "",
      subline: "Free · no charge",
    });
  });
});

describe("activePlanPriceLine", () => {
  it("never claims a monthly price for a card plan (cadence is unknown)", () => {
    const line = activePlanPriceLine({
      planKey: "fleet",
      source: "stripe",
      currentPeriodEnd: "2026-10-12T00:00:00.000Z",
      formatDate: date,
    });
    expect(line).toBe("Billed by card · current billing period ends D(2026-10-12)");
    expect(line).not.toMatch(/month|\/mo/);
  });

  it("never says a card or App Store plan renews: the data has no auto-renew signal", () => {
    // A plan cancelled in the Stripe portal or the App Store stays active
    // until its period ends, so "renews" would promise a charge that may not
    // come. Payment trouble is shown by the status badge, not this line.
    for (const source of ["stripe", "apple_iap", "workspace_cloud", undefined] as const) {
      const line = activePlanPriceLine({
        planKey: "operator",
        source,
        currentPeriodEnd: "2026-11-01T00:00:00.000Z",
        formatDate: date,
      });
      expect(line).not.toMatch(/renew/i);
      expect(line).toMatch(/current billing period ends D\(2026-11-01\)$/);
    }
  });

  it("treats a legacy row without a source as a card plan", () => {
    expect(activePlanPriceLine({ planKey: "fleet", source: undefined, currentPeriodEnd: null })).toBe(
      "Billed by card"
    );
  });

  it("says a $HermesOS year runs until a date and does not renew", () => {
    expect(
      activePlanPriceLine({
        planKey: "operator",
        source: "token_yearly",
        currentPeriodEnd: "2027-05-01T00:00:00.000Z",
        formatDate: date,
      })
    ).toBe("Paid with $HermesOS · active until D(2027-05-01) · doesn't renew automatically");
  });

  it("describes holding, Apple, Workspace Cloud and Free", () => {
    expect(activePlanPriceLine({ planKey: "fleet", source: "token_holding", currentPeriodEnd: null })).toBe(
      "Unlocked by holding $HermesOS · active while you hold"
    );
    expect(
      activePlanPriceLine({
        planKey: "operator",
        source: "apple_iap",
        currentPeriodEnd: "2026-11-01T00:00:00.000Z",
        formatDate: date,
      })
    ).toBe("Billed through the App Store · current billing period ends D(2026-11-01)");
    expect(activePlanPriceLine({ planKey: "fleet", source: "workspace_cloud", currentPeriodEnd: null })).toBe(
      "Included with Workspace Cloud"
    );
    expect(activePlanPriceLine({ planKey: "free", source: "free", currentPeriodEnd: null })).toBe("Free · no charge");
    expect(activePlanPriceLine({ planKey: "free", source: undefined, currentPeriodEnd: null })).toBe("Free · no charge");
  });

  it("omits an unparseable date instead of printing Invalid Date", () => {
    expect(activePlanPriceLine({ planKey: "fleet", source: "stripe", currentPeriodEnd: "not-a-date" })).toBe(
      "Billed by card"
    );
  });
});

describe("plan card labels", () => {
  it("uses each plan's own tagline as its eyebrow (the Free card never reads 'Power')", () => {
    expect(planCardEyebrow("free")).toBe("start without a bill");
    expect(planCardEyebrow("free")).not.toMatch(/power/i);
    const eyebrows = (["free", "operator", "fleet", "command"] as const).map(planCardEyebrow);
    expect(new Set(eyebrows).size).toBe(eyebrows.length);
  });

  it("badges the current plan over the popular one", () => {
    expect(planCardBadge("fleet", null)).toEqual({ kind: "popular", label: "Most popular" });
    expect(planCardBadge("fleet", "fleet")).toEqual({ kind: "current", label: "Current plan" });
    expect(planCardBadge("operator", "fleet")).toBeNull();
  });

  it("lists up to four features and skips the idle-policy ones already in the spec rows", () => {
    const features = planCardFeatures("operator");
    expect(features.length).toBeLessThanOrEqual(4);
    expect(features.join(" ")).not.toMatch(/always-on|idle days/i);
    expect(planCardFeatures("free").join(" ")).not.toMatch(/idle days/i);
  });

  it("states the enforced idle policy", () => {
    expect(planIdlePolicy("free")).toBe("Sleeps after 4 idle days");
    expect(planIdlePolicy("operator")).toBe("Always on");
  });
});

describe("plansForLadder", () => {
  it("lists the plans on sale, lowest first", () => {
    expect(plansForLadder({ currentPlanKey: null, path: "card" })).toEqual(["free", "operator", "fleet"]);
  });

  it("adds a current plan that is no longer sold, such as Command", () => {
    expect(plansForLadder({ currentPlanKey: "command", path: "card" })).toEqual([
      "free",
      "operator",
      "fleet",
      "command",
    ]);
  });

  it("lists only $HermesOS-payable plans (plus the current one) on the token path", () => {
    expect(plansForLadder({ currentPlanKey: null, path: "token" })).toEqual(["operator", "fleet"]);
    expect(plansForLadder({ currentPlanKey: "free", path: "token" })).toEqual(["free", "operator", "fleet"]);
  });
});

describe("planCardCta", () => {
  const base = {
    source: null,
    path: "card" as const,
    tokenMode: "yearly" as const,
    cadence: "monthly" as const,
    selfServeDowngradeEnabled: false,
    changePlanRequiresCheckout: false,
  };

  it("offers checkout at the chosen cadence when there is no plan", () => {
    expect(planCardCta({ ...base, planKey: "operator", currentPlanKey: null })).toEqual({
      kind: "subscribe",
      label: "Subscribe · $9.99/mo",
    });
    expect(planCardCta({ ...base, planKey: "fleet", currentPlanKey: null, cadence: "yearly" })).toEqual({
      kind: "subscribe",
      label: "Subscribe · $149/yr",
    });
    expect(planCardCta({ ...base, planKey: "free", currentPlanKey: null })).toEqual({
      kind: "start_free",
      label: "Start free",
    });
  });

  it("offers the $HermesOS year or the hold path, never for Free", () => {
    expect(planCardCta({ ...base, path: "token", planKey: "operator", currentPlanKey: null })).toEqual({
      kind: "pay_yearly_token",
      label: "Pay a year · $49 in $HermesOS",
      tier: "pro",
    });
    expect(
      planCardCta({ ...base, path: "token", tokenMode: "hold", planKey: "fleet", currentPlanKey: null })
    ).toEqual({
      kind: "hold_token",
      label: "See how much to hold",
      href: "/dashboard/wallet?from=billing&plan=power",
      tier: "power",
    });
    expect(planCardCta({ ...base, path: "token", planKey: "free", currentPlanKey: null }).kind).toBe("note");
    // A token plan already at Power is not offered a lower $HermesOS year.
    expect(
      planCardCta({ ...base, path: "token", planKey: "operator", currentPlanKey: "fleet", source: "token_yearly" })
    ).toEqual({ kind: "note", note: "Your current plan already covers this" });
    expect(
      planCardCta({ ...base, path: "token", planKey: "operator", currentPlanKey: "fleet", source: "token_holding" })
    ).toEqual({ kind: "note", note: "Your current plan already covers this" });
    // A bigger tier is offered.
    expect(
      planCardCta({ ...base, path: "token", planKey: "fleet", currentPlanKey: "operator", source: "token_yearly" })
    ).toEqual({ kind: "pay_yearly_token", label: "Pay a year · $99 in $HermesOS", tier: "power" });
  });

  it("offers a yearly $HermesOS plan another year on its own card, labelled as adding a year", () => {
    expect(
      planCardCta({ ...base, path: "token", planKey: "operator", currentPlanKey: "operator", source: "token_yearly" })
    ).toEqual({ kind: "pay_yearly_token", label: "Add a year · $49 in $HermesOS", tier: "pro" });
    // Holding-based and card plans keep the plain current marker.
    expect(
      planCardCta({ ...base, path: "token", planKey: "fleet", currentPlanKey: "fleet", source: "token_holding" }).kind
    ).toBe("current");
    expect(
      planCardCta({ ...base, path: "token", tokenMode: "hold", planKey: "operator", currentPlanKey: "operator", source: "token_yearly" }).kind
    ).toBe("current");
    expect(planCardCta({ ...base, planKey: "operator", currentPlanKey: "operator", source: "token_yearly" }).kind).toBe(
      "current"
    );
  });

  it("marks the current plan", () => {
    expect(planCardCta({ ...base, planKey: "fleet", currentPlanKey: "fleet" }).kind).toBe("current");
    // Command is never offered for purchase; it only ever shows as current.
    expect(planCardCta({ ...base, planKey: "command", currentPlanKey: "command" }).kind).toBe("current");
  });

  it("routes upgrades through the change-plan confirmation", () => {
    expect(planCardCta({ ...base, planKey: "fleet", currentPlanKey: "operator", source: "stripe" })).toEqual({
      kind: "upgrade",
      label: "Upgrade to Power",
    });
    expect(planCardCta({ ...base, planKey: "operator", currentPlanKey: "free", source: "free", changePlanRequiresCheckout: true })).toEqual({
      kind: "upgrade",
      label: "Upgrade to Pro",
    });
  });

  it("offers a paid→paid downgrade only when the flag is on and the plan changes in place", () => {
    const downgrade = { ...base, planKey: "operator" as const, currentPlanKey: "fleet", source: "stripe" as const };
    expect(planCardCta({ ...downgrade, selfServeDowngradeEnabled: true })).toEqual({
      kind: "downgrade",
      label: "Switch to Pro",
    });
    expect(planCardCta(downgrade)).toEqual({ kind: "note", note: SMALLER_PLAN_NOT_SELF_SERVE });
    expect(planCardCta({ ...downgrade, selfServeDowngradeEnabled: true, changePlanRequiresCheckout: true })).toEqual({
      kind: "note",
      note: SMALLER_PLAN_NOT_SELF_SERVE,
    });
    // Moving to Free is a cancellation, never a self-serve downgrade.
    expect(
      planCardCta({ ...downgrade, planKey: "free", selfServeDowngradeEnabled: true })
    ).toEqual({ kind: "note", note: "To move to Free, cancel your subscription" });
    expect(planCardCta({ ...downgrade, planKey: "free", source: "token_yearly" })).toEqual({
      kind: "note",
      note: SMALLER_PLAN_NOT_SELF_SERVE,
    });
  });

  it("never offers Stripe changes to Apple subscribers", () => {
    for (const planKey of ["free", "fleet"] as const) {
      expect(
        planCardCta({ ...base, planKey, currentPlanKey: "operator", source: "apple_iap", selfServeDowngradeEnabled: true })
      ).toEqual({ kind: "note", note: APPLE_PLAN_CHANGE_NOTE });
    }
  });
});

describe("tokenYearTierOffered", () => {
  it("offers every tier with no paid plan", () => {
    for (const current of [null, undefined, "free"]) {
      expect(tokenYearTierOffered(current, "pro")).toBe(true);
      expect(tokenYearTierOffered(current, "power")).toBe(true);
    }
  });

  it("offers the same tier and bigger tiers, never a smaller one", () => {
    expect(tokenYearTierOffered("operator", "pro")).toBe(true);
    expect(tokenYearTierOffered("operator", "power")).toBe(true);
    expect(tokenYearTierOffered("fleet", "pro")).toBe(false);
    expect(tokenYearTierOffered("fleet", "power")).toBe(true);
    expect(tokenYearTierOffered("command", "pro")).toBe(false);
    expect(tokenYearTierOffered("command", "power")).toBe(false);
  });

  it("calls a same-tier payment on a yearly $HermesOS plan a renewal, and nothing else", () => {
    expect(isTokenYearRenewal({ currentPlanKey: "fleet", source: "token_yearly", tier: "power" })).toBe(true);
    expect(isTokenYearRenewal({ currentPlanKey: "fleet", source: "token_holding", tier: "power" })).toBe(false);
    expect(isTokenYearRenewal({ currentPlanKey: "operator", source: "token_yearly", tier: "power" })).toBe(false);
    expect(isTokenYearRenewal({ currentPlanKey: null, source: null, tier: "pro" })).toBe(false);
  });
});

describe("plansSoldAtCheckout", () => {
  it("lists only the cards that start a checkout", () => {
    expect(
      plansSoldAtCheckout([
        { planKey: "free", cta: { kind: "start_free", label: "Start free" } },
        { planKey: "operator", cta: { kind: "subscribe", label: "Subscribe · $9.99/mo" } },
        { planKey: "fleet", cta: { kind: "upgrade", label: "Upgrade to Power" } },
        { planKey: "command", cta: { kind: "current", label: "Current plan" } },
      ])
    ).toEqual(["operator", "fleet"]);
    expect(
      plansSoldAtCheckout([
        { planKey: "operator", cta: { kind: "note", note: SMALLER_PLAN_NOT_SELF_SERVE } },
        { planKey: "command", cta: { kind: "current", label: "Current plan" } },
      ])
    ).toEqual([]);
  });
});

describe("hasPaidCardOrAppleSubscription", () => {
  it("is true only for paid card, Apple or Workspace Cloud plans", () => {
    expect(hasPaidCardOrAppleSubscription({ planKey: "fleet", source: "stripe" })).toBe(true);
    expect(hasPaidCardOrAppleSubscription({ planKey: "fleet", source: undefined })).toBe(true);
    expect(hasPaidCardOrAppleSubscription({ planKey: "operator", source: "apple_iap" })).toBe(true);
    expect(hasPaidCardOrAppleSubscription({ planKey: "free", source: "free" })).toBe(false);
    expect(hasPaidCardOrAppleSubscription({ planKey: null, source: null })).toBe(false);
    expect(hasPaidCardOrAppleSubscription({ planKey: "operator", source: "token_yearly" })).toBe(false);
    expect(hasPaidCardOrAppleSubscription({ planKey: "fleet", source: "token_holding" })).toBe(false);
  });
});

describe("token plan prices", () => {
  it("maps billing plans to $HermesOS tiers", () => {
    expect(yearlyTokenTierForPlan("operator")).toBe("pro");
    expect(yearlyTokenTierForPlan("fleet")).toBe("power");
    expect(yearlyTokenTierForPlan("free")).toBeNull();
    expect(yearlyTokenTierForPlan("command")).toBeNull();
    expect(YEARLY_TOKEN_USD).toEqual({ pro: 49, power: 99 });
  });
});
