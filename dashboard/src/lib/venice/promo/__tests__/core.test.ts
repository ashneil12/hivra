import {
  codeMatches,
  evaluateLaunchEligibility,
  isCampaignGrantable,
  isVenicePromoEnabled,
  normalizePromoCode,
  promoExpiryRemovalMicroUsd,
  promoLineLabel,
  topupBonusMicroUsd,
  type LaunchEligibilityFacts,
  type PromoCampaign,
} from "../core";

const NOW = new Date("2026-12-01T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const M = 1_000_000;

const facts = (over: Partial<LaunchEligibilityFacts>): LaunchEligibilityFacts => ({
  hasActivePaidPlan: true,
  currentRunStartedAt: new Date(NOW.getTime() - DAY),
  hasPriorPaid: false,
  priorPaidEndedAt: null,
  ...over,
});

describe("launch eligibility", () => {
  it("accepts a new subscriber with no prior paid subscription", () => {
    expect(evaluateLaunchEligibility(facts({}), NOW)).toEqual({ eligible: true, reason: "new_subscriber" });
  });

  it("needs an active paid plan", () => {
    expect(evaluateLaunchEligibility(facts({ hasActivePaidPlan: false }), NOW)).toEqual({
      eligible: false,
      reason: "no_paid_plan",
    });
  });

  it("accepts a returning subscriber whose earlier plan ended 30+ days before they came back", () => {
    const started = new Date("2026-11-30T00:00:00Z");
    const ended = new Date(started.getTime() - 30 * DAY);
    expect(
      evaluateLaunchEligibility(facts({ hasPriorPaid: true, currentRunStartedAt: started, priorPaidEndedAt: ended }), NOW)
    ).toEqual({ eligible: true, reason: "returning_subscriber" });
  });

  it("rejects a return after 29 days, and an earlier plan that never ended", () => {
    const started = new Date("2026-11-30T00:00:00Z");
    const ended = new Date(started.getTime() - 29 * DAY);
    expect(
      evaluateLaunchEligibility(facts({ hasPriorPaid: true, currentRunStartedAt: started, priorPaidEndedAt: ended }), NOW).reason
    ).toBe("returned_too_soon");
    expect(evaluateLaunchEligibility(facts({ hasPriorPaid: true, priorPaidEndedAt: null }), NOW)).toEqual({
      eligible: false,
      reason: "existing_subscriber",
    });
  });

  it("rejects overlapping subscriptions (negative gap)", () => {
    const started = new Date("2026-11-30T00:00:00Z");
    const ended = new Date("2026-12-15T00:00:00Z");
    expect(
      evaluateLaunchEligibility(facts({ hasPriorPaid: true, currentRunStartedAt: started, priorPaidEndedAt: ended }), NOW).eligible
    ).toBe(false);
  });
});

describe("top-up bonus math", () => {
  it("is 50% rounded down and capped at $10", () => {
    expect(topupBonusMicroUsd(10 * M, 5000, 10 * M)).toBe(5 * M);
    expect(topupBonusMicroUsd(10 * M + 3, 5000, 10 * M)).toBe(5 * M + 1);
    expect(topupBonusMicroUsd(50 * M, 5000, 10 * M)).toBe(10 * M);
    expect(topupBonusMicroUsd(0, 5000, 10 * M)).toBe(0);
    expect(topupBonusMicroUsd(10 * M, 0, 10 * M)).toBe(0);
  });
});

describe("expiry math", () => {
  const amount = 10 * M;
  it("removes only the unspent part, spend consuming promo money first", () => {
    expect(promoExpiryRemovalMicroUsd({ amountMicroUsd: amount, cardSpendSinceGrantMicroUsd: 0, walletAvailableMicroUsd: 99 * M })).toBe(amount);
    expect(promoExpiryRemovalMicroUsd({ amountMicroUsd: amount, cardSpendSinceGrantMicroUsd: 4 * M, walletAvailableMicroUsd: 99 * M })).toBe(6 * M);
    expect(promoExpiryRemovalMicroUsd({ amountMicroUsd: amount, cardSpendSinceGrantMicroUsd: 25 * M, walletAvailableMicroUsd: 99 * M })).toBe(0);
  });
  it("never removes more than the wallet has available, and never goes negative", () => {
    expect(promoExpiryRemovalMicroUsd({ amountMicroUsd: amount, cardSpendSinceGrantMicroUsd: 0, walletAvailableMicroUsd: 3 * M })).toBe(3 * M);
    expect(promoExpiryRemovalMicroUsd({ amountMicroUsd: amount, cardSpendSinceGrantMicroUsd: 0, walletAvailableMicroUsd: -5 })).toBe(0);
  });
});

describe("flag, codes, campaign window, labels", () => {
  const campaign: PromoCampaign = {
    id: "c", slug: "s", kind: "launch_credit", code: "VENICE", enabled: true,
    startsAt: "2026-11-01T00:00:00Z", endsAt: "2027-01-01T00:00:00Z", grantCutoffAt: "2026-12-31T00:00:00Z",
    budgetMicroUsd: 1, perUserCapMicroUsd: 1, bonusBps: null, maxGrants: 1, grantExpiryDays: 30,
  };

  it("is off unless exactly 'true'", () => {
    expect(isVenicePromoEnabled({})).toBe(false);
    expect(isVenicePromoEnabled({ HIVRA_VENICE_PROMO_ENABLED: "1" })).toBe(false);
    expect(isVenicePromoEnabled({ HIVRA_VENICE_PROMO_ENABLED: "true" })).toBe(true);
  });

  it("matches codes case-insensitively and rejects junk", () => {
    expect(normalizePromoCode("  venice ")).toBe("VENICE");
    expect(codeMatches("VENICE", normalizePromoCode("Venice"))).toBe(true);
    expect(normalizePromoCode("a b")).toBeNull();
    expect(normalizePromoCode(42)).toBeNull();
  });

  it("fails closed on disabled or undated campaigns", () => {
    expect(isCampaignGrantable(campaign, NOW)).toBe(true);
    expect(isCampaignGrantable({ ...campaign, enabled: false }, NOW)).toBe(false);
    expect(isCampaignGrantable({ ...campaign, startsAt: null }, NOW)).toBe(false);
    expect(isCampaignGrantable({ ...campaign, grantCutoffAt: null, endsAt: null }, NOW)).toBe(false);
    expect(isCampaignGrantable(campaign, new Date("2027-02-01T00:00:00Z"))).toBe(false);
  });

  it("labels the line", () => {
    expect(promoLineLabel("launch_credit", 10 * M, "2026-12-12T10:00:00Z")).toBe("$10 Venice launch credit, expires 12 Dec");
    expect(promoLineLabel("topup_bonus", 6_250_000, "2026-12-02T00:00:00Z")).toBe("$6.25 Venice top-up bonus, expires 2 Dec");
  });
});
