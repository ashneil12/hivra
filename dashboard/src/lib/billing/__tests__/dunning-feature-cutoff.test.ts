/**
 * Regression cover for the dunning FEATURE-cutoff lane.
 *
 * #617 made `resolveEffectiveSubscription` (instance-entitlement.ts) grace-aware,
 * but left the second entitlement lane — `hasPlanAccessStatus` →
 * `evaluateComputeEntitlement` → `isProTierUser` — accepting `past_due`
 * unconditionally. That lane gates the Pro+ features (browser sidecar, browser
 * stream, cron scheduling), so a failed payment kept them for Stripe's entire
 * retry window even after the 48h grace anchor elapsed.
 *
 * These tests pin: the cutoff itself, the fail-open cases that protect a paying
 * customer, and that the flag-OFF path is unchanged.
 */
import {
  hasPlanAccessStatus,
  hasPlanAccessWithGrace,
  isDunningFeatureCutoffLive,
  isDunningGraceExpired,
} from "@/lib/billing/subscription-status";
import { evaluateComputeEntitlement } from "@/lib/billing/entitlements";
import { isProTierUser } from "@/lib/billing/pro-tier";
import { supabaseAdmin } from "@/lib/supabase";
import { getCreditSummary, deriveReservedCreditBalance } from "@/lib/billing/credits";
import { getLatestHermesTokenHoldingSnapshot } from "@/lib/billing/token-holdings";

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;
jest.mock("@/lib/billing/credits", () => ({
  getCreditSummary: jest.fn(),
  deriveReservedCreditBalance: jest.fn(),
}));
jest.mock("@/lib/billing/token-holdings", () => ({
  getLatestHermesTokenHoldingSnapshot: jest.fn(),
}));

const FLAG = "DUNNING_FEATURE_CUTOFF_LIVE";
const HOUR = 60 * 60 * 1000;
const EXPIRED = new Date(Date.now() - 2 * HOUR).toISOString();
const FUTURE = new Date(Date.now() + 24 * HOUR).toISOString();

function setFlag(on: boolean) {
  if (on) process.env[FLAG] = "true";
  else delete process.env[FLAG];
}

afterEach(() => {
  delete process.env[FLAG];
  jest.clearAllMocks();
});

// ── The predicate itself ──────────────────────────────────────────────────────

describe("isDunningFeatureCutoffLive", () => {
  it("is OFF by default and only 'true' turns it on", () => {
    expect(isDunningFeatureCutoffLive({} as NodeJS.ProcessEnv)).toBe(false);
    expect(
      isDunningFeatureCutoffLive({ [FLAG]: "1" } as unknown as NodeJS.ProcessEnv)
    ).toBe(false);
    expect(
      isDunningFeatureCutoffLive({ [FLAG]: "true" } as unknown as NodeJS.ProcessEnv)
    ).toBe(true);
  });
});

describe("isDunningGraceExpired", () => {
  it("is true only for a past_due row whose explicit anchor has elapsed", () => {
    expect(
      isDunningGraceExpired({ status: "past_due", grace_period_ends_at: EXPIRED })
    ).toBe(true);
  });

  it("is false while the grace window is still open", () => {
    expect(
      isDunningGraceExpired({ status: "past_due", grace_period_ends_at: FUTURE })
    ).toBe(false);
  });

  it("FAILS OPEN on a missing or unparseable anchor — never lock out on a missing stamp", () => {
    expect(isDunningGraceExpired({ status: "past_due" })).toBe(false);
    expect(
      isDunningGraceExpired({ status: "past_due", grace_period_ends_at: null })
    ).toBe(false);
    expect(
      isDunningGraceExpired({ status: "past_due", grace_period_ends_at: "not-a-date" })
    ).toBe(false);
  });

  it("never fires for a non-past_due status, even with an elapsed anchor", () => {
    for (const status of ["active", "trialing", "canceled"]) {
      expect(isDunningGraceExpired({ status, grace_period_ends_at: EXPIRED })).toBe(false);
    }
  });
});

describe("hasPlanAccessStatus (protective contract — must NOT tighten)", () => {
  it("still accepts past_due unconditionally", () => {
    // force-delete / purge-expired / subscribe / change-plan / refresh-token-tiers
    // all depend on this staying loose; tightening it would let a grace-expired
    // user's VM be destroyed and would push past_due users into a second Checkout.
    expect(hasPlanAccessStatus("past_due")).toBe(true);
    expect(hasPlanAccessStatus("active")).toBe(true);
    expect(hasPlanAccessStatus("trialing")).toBe(true);
    expect(hasPlanAccessStatus("canceled")).toBe(false);
  });
});

describe("hasPlanAccessWithGrace", () => {
  it("flag OFF: byte-identical to hasPlanAccessStatus for every case", () => {
    setFlag(false);
    const cases = [
      { status: "past_due", grace_period_ends_at: EXPIRED },
      { status: "past_due", grace_period_ends_at: FUTURE },
      { status: "past_due", grace_period_ends_at: null },
      { status: "active", grace_period_ends_at: EXPIRED },
      { status: "trialing" },
      { status: "canceled" },
      { status: null },
    ];
    for (const c of cases) {
      expect(hasPlanAccessWithGrace(c)).toBe(hasPlanAccessStatus(c.status));
    }
  });

  it("flag ON: revokes access once the grace window has elapsed", () => {
    setFlag(true);
    expect(
      hasPlanAccessWithGrace({ status: "past_due", grace_period_ends_at: EXPIRED })
    ).toBe(false);
  });

  it("flag ON: keeps access inside the grace window and on a missing anchor", () => {
    setFlag(true);
    expect(
      hasPlanAccessWithGrace({ status: "past_due", grace_period_ends_at: FUTURE })
    ).toBe(true);
    expect(hasPlanAccessWithGrace({ status: "past_due" })).toBe(true);
  });

  it("flag ON: never disturbs an active/trialing subscriber", () => {
    setFlag(true);
    expect(
      hasPlanAccessWithGrace({ status: "active", grace_period_ends_at: EXPIRED })
    ).toBe(true);
    expect(
      hasPlanAccessWithGrace({ status: "trialing", grace_period_ends_at: EXPIRED })
    ).toBe(true);
  });
});

// ── The compute-entitlement resolver ─────────────────────────────────────────

function entitlementFor(sub: {
  plan: string;
  status: string;
  grace_period_ends_at?: string | null;
}, tokenBalance = 0) {
  return evaluateComputeEntitlement({
    userId: "user_123",
    subscription: sub,
    creditBalanceCredits: null,
    reservedCredits: 0,
    tokenHolding: { verified: tokenBalance > 0, balance: tokenBalance },
    activeInstances: [],
    requestedInstance: { cpu: 0.5, ram: 1024 },
  });
}

describe("evaluateComputeEntitlement — dunning cutoff", () => {
  it("flag ON: a grace-expired past_due sub no longer grants its plan tier", () => {
    setFlag(true);
    const decision = entitlementFor({
      plan: "operator",
      status: "past_due",
      grace_period_ends_at: EXPIRED,
    });
    expect(decision).toMatchObject({
      verified: false,
      failClosed: true,
      allowedTier: null,
      canProvision: false,
    });
  });

  it("flag ON: falls THROUGH to a token entitlement rather than hard-denying", () => {
    // A user who also holds $HERMES keeps token_base — the cutoff drops the
    // Stripe grant, it does not blanket-revoke the account.
    setFlag(true);
    const decision = entitlementFor(
      { plan: "operator", status: "past_due", grace_period_ends_at: EXPIRED },
      1
    );
    expect(decision).toMatchObject({ verified: true, allowedTier: "token_base" });
  });

  it("flag ON: keeps the plan tier while still inside the 48h grace window", () => {
    setFlag(true);
    expect(
      entitlementFor({
        plan: "operator",
        status: "past_due",
        grace_period_ends_at: FUTURE,
      })
    ).toMatchObject({ verified: true, allowedTier: "operator" });
  });

  it("flag ON: FAILS OPEN when the past_due row carries no grace anchor", () => {
    setFlag(true);
    expect(
      entitlementFor({ plan: "operator", status: "past_due" })
    ).toMatchObject({ verified: true, allowedTier: "operator" });
    expect(
      entitlementFor({
        plan: "operator",
        status: "past_due",
        grace_period_ends_at: null,
      })
    ).toMatchObject({ verified: true, allowedTier: "operator" });
  });

  it("flag OFF: a grace-expired past_due sub keeps its tier (unchanged behavior)", () => {
    setFlag(false);
    expect(
      entitlementFor({
        plan: "operator",
        status: "past_due",
        grace_period_ends_at: EXPIRED,
      })
    ).toMatchObject({ verified: true, allowedTier: "operator" });
  });

  it("flag ON: active subscribers are untouched", () => {
    setFlag(true);
    expect(
      entitlementFor({
        plan: "operator",
        status: "active",
        grace_period_ends_at: EXPIRED,
      })
    ).toMatchObject({ verified: true, allowedTier: "operator" });
  });
});

// ── The live Pro+ feature gate ───────────────────────────────────────────────

function mockProTierTables(sub: {
  plan: string;
  status: string;
  grace_period_ends_at?: string | null;
} | null) {
  const selected: string[] = [];
  (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
    if (table === "hermes_subscriptions") {
      return {
        select: jest.fn((cols: string) => {
          selected.push(cols);
          return {
            eq: jest.fn().mockReturnValue({
              maybeSingle: jest.fn().mockResolvedValue({ data: sub, error: null }),
            }),
          };
        }),
      };
    }
    return {
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          not: jest.fn().mockResolvedValue({ data: [], error: null }),
        }),
      }),
    };
  });
  (getCreditSummary as jest.Mock).mockResolvedValue({ balance: 0 });
  (deriveReservedCreditBalance as jest.Mock).mockResolvedValue(0);
  (getLatestHermesTokenHoldingSnapshot as jest.Mock).mockResolvedValue(null);
  return { selected };
}

describe("isProTierUser — the live Pro+ feature gate", () => {
  it("selects grace_period_ends_at so the cutoff has an anchor to read", () => {
    const { selected } = mockProTierTables({ plan: "operator", status: "active" });
    return isProTierUser("user_123").then(() => {
      expect(selected.some((c) => c.includes("grace_period_ends_at"))).toBe(true);
    });
  });

  it("flag ON: revokes Pro+ features once grace has expired", async () => {
    setFlag(true);
    mockProTierTables({
      plan: "operator",
      status: "past_due",
      grace_period_ends_at: EXPIRED,
    });
    await expect(isProTierUser("user_123")).resolves.toMatchObject({
      ok: false,
      tier: null,
      reason: "no_entitlement",
    });
  });

  it("flag ON: keeps Pro+ features inside the grace window", async () => {
    setFlag(true);
    mockProTierTables({
      plan: "operator",
      status: "past_due",
      grace_period_ends_at: FUTURE,
    });
    await expect(isProTierUser("user_123")).resolves.toMatchObject({
      ok: true,
      tier: "operator",
    });
  });

  it("flag OFF: grace-expired past_due keeps Pro+ features (unchanged behavior)", async () => {
    setFlag(false);
    mockProTierTables({
      plan: "operator",
      status: "past_due",
      grace_period_ends_at: EXPIRED,
    });
    await expect(isProTierUser("user_123")).resolves.toMatchObject({
      ok: true,
      tier: "operator",
    });
  });

  it("flag ON: an active subscriber is unaffected", async () => {
    setFlag(true);
    mockProTierTables({ plan: "operator", status: "active" });
    await expect(isProTierUser("user_123")).resolves.toMatchObject({
      ok: true,
      tier: "operator",
    });
  });
});
