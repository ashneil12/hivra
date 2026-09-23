import {
  BILLING_TAB_IDS,
  billingTabUrl,
  deepLinkBillingTab,
  isBillingTabId,
  resolveBillingTab,
  visibleBillingTabs,
} from "../_components/billing-tabs";
import { selectYearlyBannerCandidate } from "../_components/YearlyPaymentBanner";
import type { YearlyTokenQuotePayload, YearlyTokenSubscriptionPayload } from "@/lib/billing/format";

function params(values: Record<string, string>) {
  return { get: (key: string) => values[key] ?? null };
}

describe("visibleBillingTabs", () => {
  it("shows Credits for billing v2 or crypto, and History for billing v2 only", () => {
    expect(visibleBillingTabs({ billingV2Enabled: true, cryptoBillingEnabled: true })).toEqual([...BILLING_TAB_IDS]);
    expect(visibleBillingTabs({ billingV2Enabled: false, cryptoBillingEnabled: true })).toEqual([
      "overview",
      "plans",
      "payments",
      "credits",
    ]);
    expect(visibleBillingTabs({ billingV2Enabled: false, cryptoBillingEnabled: false })).toEqual([
      "overview",
      "plans",
      "payments",
    ]);
  });
});

describe("deepLinkBillingTab", () => {
  it("honours a valid ?tab= first", () => {
    expect(deepLinkBillingTab(params({ tab: "history", credits: "success" }), "")).toBe("history");
    expect(isBillingTabId("nope")).toBe(false);
    expect(deepLinkBillingTab(params({ tab: "nope" }), "")).toBeNull();
  });

  it("maps plan-state links to Overview", () => {
    expect(deepLinkBillingTab(params({ intent: "backups", instanceId: "i" }), "")).toBe("overview");
    expect(deepLinkBillingTab(params({ subscription: "success", session_id: "cs" }), "")).toBe("overview");
    expect(deepLinkBillingTab(params({ storage_expanded: "1" }), "")).toBe("overview");
  });

  it("maps plan-picking links to Plans", () => {
    expect(deepLinkBillingTab(params({ plan: "fleet", cadence: "yearly" }), "")).toBe("plans");
    expect(deepLinkBillingTab(params({ plan: "pro", yearly_token: "1", from: "welcome" }), "")).toBe("plans");
    expect(deepLinkBillingTab(params({ cadence: "yearly", from: "cancel_save" }), "")).toBe("plans");
    expect(deepLinkBillingTab(params({ from: "paywall", feature: "browser" }), "")).toBe("plans");
    expect(deepLinkBillingTab(params({ from: "launch" }), "")).toBe("plans");
  });

  it("maps credit links and the #managed-venice anchor to Credits", () => {
    expect(deepLinkBillingTab(params({ managedVenice: "deposit", wallet: "hermesos" }), "")).toBe("credits");
    expect(deepLinkBillingTab(params({ managedVenice: "card_success" }), "")).toBe("credits");
    expect(deepLinkBillingTab(params({ credits: "canceled" }), "")).toBe("credits");
    expect(deepLinkBillingTab(params({}), "#managed-venice")).toBe("credits");
  });

  it("asks for nothing without a recognised link", () => {
    expect(deepLinkBillingTab(params({}), "")).toBeNull();
    expect(deepLinkBillingTab(null, "#elsewhere")).toBeNull();
    expect(deepLinkBillingTab(params({ from: "somewhere" }), "")).toBeNull();
  });
});

describe("resolveBillingTab", () => {
  const all = [...BILLING_TAB_IDS];

  it("uses the requested tab when it is visible", () => {
    expect(resolveBillingTab({ requested: "credits", visible: all, subscribed: true })).toBe("credits");
  });

  it("falls back when the requested tab is hidden in this build", () => {
    const noHistory = all.filter((id) => id !== "history");
    expect(resolveBillingTab({ requested: "history", visible: noHistory, subscribed: true })).toBe("overview");
  });

  it("defaults to Overview with a plan and Plans without one", () => {
    expect(resolveBillingTab({ requested: null, visible: all, subscribed: true })).toBe("overview");
    expect(resolveBillingTab({ requested: null, visible: all, subscribed: false })).toBe("plans");
  });
});

describe("billingTabUrl", () => {
  it("sets ?tab= and keeps every other param and the hash", () => {
    expect(billingTabUrl("http://x.test/dashboard/billing?from=welcome&plan=fleet#top", "plans")).toBe(
      "/dashboard/billing?from=welcome&plan=fleet&tab=plans#top"
    );
    expect(billingTabUrl("http://x.test/dashboard/billing?tab=plans", "history")).toBe(
      "/dashboard/billing?tab=history"
    );
  });
});

describe("selectYearlyBannerCandidate", () => {
  const quote = (overrides: Partial<YearlyTokenQuotePayload> = {}) =>
    ({
      id: "yq",
      tier: "pro",
      usdTargetCents: 4900,
      priceUsdAtQuote: "0.1",
      tokensRequiredDisplay: "490",
      tokenSymbol: "Hivra",
      depositAddress: "0x1",
      expiresAt: "2099-01-01T00:00:00.000Z",
      status: "active",
      ...overrides,
    }) as YearlyTokenQuotePayload;
  const sub = (overrides: Partial<YearlyTokenSubscriptionPayload> = {}) =>
    ({
      id: "ys",
      tier: "pro",
      yearlyQuoteId: "yq",
      paidAt: "2026-09-23T10:00:00.000Z",
      expiresAt: "2027-09-23T10:00:00.000Z",
      status: "active",
      sweepStatus: "swept",
      sweepTxHash: null,
      amountReceivedRaw: "1",
      ...overrides,
    }) as YearlyTokenSubscriptionPayload;
  const empty = { pro: null, power: null };

  it("prefers a payable quote over one under review", () => {
    const chosen = selectYearlyBannerCandidate({
      activeQuotes: { pro: null, power: quote({ tier: "power" }) },
      pendingQuotes: { pro: quote({ status: "manual_review" }), power: null },
      recentSubs: empty,
    });
    expect(chosen?.tier).toBe("power");
  });

  it("shows a subscription only while it is recent or still sweeping", () => {
    const now = Date.parse("2026-09-23T10:03:00.000Z");
    expect(
      selectYearlyBannerCandidate({ activeQuotes: empty, pendingQuotes: empty, recentSubs: { pro: sub(), power: null } }, now)
        ?.tier
    ).toBe("pro");
    const later = Date.parse("2026-09-23T11:00:00.000Z");
    expect(
      selectYearlyBannerCandidate({ activeQuotes: empty, pendingQuotes: empty, recentSubs: { pro: sub(), power: null } }, later)
    ).toBeNull();
    expect(
      selectYearlyBannerCandidate(
        { activeQuotes: empty, pendingQuotes: empty, recentSubs: { pro: null, power: sub({ tier: "power", sweepStatus: "pending" }) } },
        later
      )?.tier
    ).toBe("power");
  });
});
