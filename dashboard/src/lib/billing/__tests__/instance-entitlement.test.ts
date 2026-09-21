import { resolveEffectiveSubscription } from "@/lib/billing/instance-entitlement";
import { supabaseAdmin } from "@/lib/supabase";

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

interface MockSubData {
  plan: string;
  status: string;
  instance_limit: number;
  total_cpu_budget: number;
  total_ram_budget: number;
  current_period_end?: string | null;
  stripe_subscription_id?: string | null;
  grace_period_ends_at?: string | null;
}

interface MockQualRow {
  tier: "pro" | "power";
  currently_eligible: boolean;
}

interface MockYearlyRow {
  tier: "pro" | "power";
  status: string;
  expires_at: string;
}

interface MockAppleRow {
  plan: string;
  status: string;
  current_period_end?: string | null;
}

function mockTables(opts: {
  sub?: MockSubData | null;
  quals?: MockQualRow[];
  yearly?: MockYearlyRow | null;
  apple?: MockAppleRow | null;
}) {
  const subQuery = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue({ data: opts.sub ?? null, error: null }),
  };
  // The helper chains .eq("user_id", ...).eq("currently_eligible", true)
  // and resolves the chain itself (no .maybeSingle), so the second .eq
  // returns the resolved promise.
  const qualQuery: { select: jest.Mock; eq: jest.Mock } = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn(),
  };
  let eqCallCount = 0;
  qualQuery.eq.mockImplementation(() => {
    eqCallCount += 1;
    if (eqCallCount >= 2) {
      return Promise.resolve({ data: opts.quals ?? [], error: null });
    }
    return qualQuery;
  });

  // yearly_token_subscriptions: chain is .eq("user_id", ...).in("status",
  // [...]).order(...).limit(1).maybeSingle()
  const yearlyQuery = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue({ data: opts.yearly ?? null, error: null }),
  };

  // apple_iap_subscriptions: chain is .eq("user_id", ...).in("status",
  // [...]).maybeSingle(). The resolver only sees access-granting rows in
  // production because the DB applies the .in filter; the mock emulates that
  // filter so a terminal-status fixture correctly falls through.
  const APPLE_ACCESS = ["active", "trialing", "grace_period"];
  const appleRow =
    opts.apple && APPLE_ACCESS.includes(opts.apple.status) ? opts.apple : null;
  const appleQuery = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue({ data: appleRow, error: null }),
  };

  (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
    if (table === "hermes_subscriptions") return subQuery;
    if (table === "yearly_token_subscriptions") return yearlyQuery;
    if (table === "token_tier_qualifications") return qualQuery;
    if (table === "apple_iap_subscriptions") return appleQuery;
    throw new Error(`Unexpected table: ${table}`);
  });

  return { appleQuery };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("resolveEffectiveSubscription", () => {
  it("returns the Stripe subscription verbatim when status is active", async () => {
    mockTables({
      sub: {
        plan: "operator",
        status: "active",
        instance_limit: 5,
        total_cpu_budget: 4,
        total_ram_budget: 8192,
        current_period_end: "2026-12-31T00:00:00Z",
        stripe_subscription_id: "sub_live_123",
      },
    });

    const result = await resolveEffectiveSubscription("user_1");
    expect(result).toEqual({
      plan: "operator",
      status: "active",
      instance_limit: 5,
      total_cpu_budget: 4,
      total_ram_budget: 8192,
      source: "stripe",
      currentPeriodEnd: "2026-12-31T00:00:00Z",
      canChangePlanInPlace: true,
    });
  });

  it("marks manual paid subscription rows as checkout-only for plan changes", async () => {
    mockTables({
      sub: {
        plan: "operator",
        status: "active",
        instance_limit: 3,
        total_cpu_budget: 2,
        total_ram_budget: 4096,
        current_period_end: null,
        stripe_subscription_id: "manual_token_power",
      },
    });

    const result = await resolveEffectiveSubscription("user_manual_paid");
    expect(result?.source).toBe("stripe");
    expect(result?.canChangePlanInPlace).toBe(false);
  });

  it("returns the Stripe row for past_due and trialing too", async () => {
    for (const status of ["past_due", "trialing"] as const) {
      mockTables({
        sub: {
          plan: "fleet",
          status,
          instance_limit: 10,
          total_cpu_budget: 8,
          total_ram_budget: 16384,
        },
      });
      const result = await resolveEffectiveSubscription("user_1");
      expect(result?.status).toBe(status);
      expect(result?.source).toBe("stripe");
    }
  });

  it("falls back to token-holding qualification when no Stripe sub exists", async () => {
    mockTables({
      sub: null,
      quals: [{ tier: "pro", currently_eligible: true }],
    });

    const result = await resolveEffectiveSubscription("user_1");
    expect(result).toEqual({
      plan: "operator",
      status: "active",
      // Pro tier maps to operator plan limits.
      instance_limit: 3,
      total_cpu_budget: 2,
      total_ram_budget: 4096,
      source: "token_holding",
      tokenTier: "pro",
      canChangePlanInPlace: false,
    });
  });

  it("uses the higher (power) tier when the user qualifies for both", async () => {
    mockTables({
      sub: null,
      quals: [
        { tier: "pro", currently_eligible: true },
        { tier: "power", currently_eligible: true },
      ],
    });

    const result = await resolveEffectiveSubscription("user_1");
    expect(result?.tokenTier).toBe("power");
    expect(result?.plan).toBe("fleet");
    expect(result?.total_cpu_budget).toBe(4);
    expect(result?.total_ram_budget).toBe(8192);
  });

  it("falls back to token-holding when the Stripe row exists but is cancelled", async () => {
    mockTables({
      sub: {
        plan: "operator",
        status: "canceled",
        instance_limit: 5,
        total_cpu_budget: 4,
        total_ram_budget: 8192,
      },
      quals: [{ tier: "power", currently_eligible: true }],
    });

    const result = await resolveEffectiveSubscription("user_1");
    expect(result?.source).toBe("token_holding");
    expect(result?.tokenTier).toBe("power");
  });

  // Regression: a paid sub that degraded to past_due with instance_limit
  // zeroed (dunning, or a dropped customer.subscription.deleted webhook that
  // left the row stuck) must NOT short-circuit and mask a valid token tier.
  // This is the "Command Plan allows 0 agents" lockout — the user held Power
  // tokens the whole time but the zombie Stripe row hid the entitlement.
  it("falls through a zeroed past_due Stripe row to the token tier underneath", async () => {
    mockTables({
      sub: {
        plan: "command",
        status: "past_due",
        instance_limit: 0,
        total_cpu_budget: 8,
        total_ram_budget: 16384,
      },
      quals: [{ tier: "power", currently_eligible: true }],
    });

    const result = await resolveEffectiveSubscription("user_1");
    expect(result?.source).toBe("token_holding");
    expect(result?.tokenTier).toBe("power");
    expect(result?.plan).toBe("fleet");
    expect(result?.instance_limit).toBe(5);
  });

  // A zeroed past_due row with no token tier underneath should resolve to
  // null (caller shows "subscribe"), NOT to a useless 0-agent Stripe grant.
  it("returns null for a zeroed past_due row when no token tier exists", async () => {
    mockTables({
      sub: {
        plan: "fleet",
        status: "past_due",
        instance_limit: 0,
        total_cpu_budget: 4,
        total_ram_budget: 8192,
      },
      quals: [],
    });

    const result = await resolveEffectiveSubscription("user_1");
    expect(result).toBeNull();
  });

  // Guardrail: a HEALTHY past_due row (grace period, seats still granted)
  // must keep winning — we only fall through when the limit is actually zero.
  it("still honors a past_due Stripe row while it grants seats", async () => {
    mockTables({
      sub: {
        plan: "operator",
        status: "past_due",
        instance_limit: 3,
        total_cpu_budget: 2,
        total_ram_budget: 4096,
      },
      quals: [{ tier: "power", currently_eligible: true }],
    });

    const result = await resolveEffectiveSubscription("user_1");
    expect(result?.source).toBe("stripe");
    expect(result?.plan).toBe("operator");
    expect(result?.instance_limit).toBe(3);
  });

  it("returns null when neither source qualifies", async () => {
    mockTables({ sub: null, quals: [] });
    const result = await resolveEffectiveSubscription("user_1");
    expect(result).toBeNull();
  });

  it("does not consult token_tier_qualifications when an active Stripe sub is found", async () => {
    mockTables({
      sub: {
        plan: "operator",
        status: "active",
        instance_limit: 5,
        total_cpu_budget: 4,
        total_ram_budget: 8192,
      },
      // If the helper queried this table, the test mock would return [];
      // we confirm the early-return by checking call count instead.
      quals: [{ tier: "power", currently_eligible: true }],
    });

    const result = await resolveEffectiveSubscription("user_1");
    expect(result?.source).toBe("stripe");
    expect(result?.plan).toBe("operator");

    const fromMock = supabaseAdmin!.from as jest.Mock;
    const tablesQueried = fromMock.mock.calls.map((args) => args[0]);
    expect(tablesQueried).toContain("hermes_subscriptions");
    expect(tablesQueried).not.toContain("token_tier_qualifications");
  });

  it("returns the yearly-token sub when no Stripe row exists but yearly_token_subscriptions has an active row", async () => {
    mockTables({
      sub: null,
      yearly: {
        tier: "pro",
        status: "active",
        expires_at: "2027-05-01T12:35:18.000Z",
      },
      // If the helper reached the holding path the test mock would
      // accept these — we assert it short-circuits at yearly instead.
      quals: [],
    });

    const result = await resolveEffectiveSubscription("user_yearly");
    expect(result?.source).toBe("token_yearly");
    expect(result?.plan).toBe("operator");
    expect(result?.tokenTier).toBe("pro");
    expect(result?.currentPeriodEnd).toBe("2027-05-01T12:35:18.000Z");
  });

  it("treats grace-state yearly-token subs as active (sweep failed but tier still entitled)", async () => {
    mockTables({
      sub: null,
      yearly: {
        tier: "power",
        status: "grace",
        expires_at: "2027-05-01T12:35:18.000Z",
      },
    });

    const result = await resolveEffectiveSubscription("user_grace");
    expect(result?.source).toBe("token_yearly");
    expect(result?.plan).toBe("fleet");
    expect(result?.tokenTier).toBe("power");
  });

  it("Stripe outranks yearly-token when both are present", async () => {
    mockTables({
      sub: {
        plan: "operator",
        status: "active",
        instance_limit: 5,
        total_cpu_budget: 4,
        total_ram_budget: 8192,
      },
      yearly: {
        tier: "power",
        status: "active",
        expires_at: "2027-05-01T12:35:18.000Z",
      },
    });

    const result = await resolveEffectiveSubscription("user_both");
    expect(result?.source).toBe("stripe");
    // Did not fall through to yearly_token_subscriptions
    const fromMock = supabaseAdmin!.from as jest.Mock;
    const tablesQueried = fromMock.mock.calls.map((args) => args[0]);
    expect(tablesQueried).not.toContain("yearly_token_subscriptions");
  });

  describe("Free Stripe row interaction with token entitlements", () => {
    it("Pro token qualification beats an active Free Stripe row", async () => {
      mockTables({
        sub: {
          plan: "free",
          status: "active",
          instance_limit: 1,
          total_cpu_budget: 0.5,
          total_ram_budget: 1024,
        },
        quals: [{ tier: "pro", currently_eligible: true }],
      });

      const result = await resolveEffectiveSubscription("user_free_pro");
      expect(result?.source).toBe("token_holding");
      expect(result?.plan).toBe("operator");
      expect(result?.tokenTier).toBe("pro");
      expect(result?.instance_limit).toBe(3);
    });

    it("Power token qualification beats an active Free Stripe row", async () => {
      mockTables({
        sub: {
          plan: "free",
          status: "active",
          instance_limit: 1,
          total_cpu_budget: 0.5,
          total_ram_budget: 1024,
        },
        quals: [{ tier: "power", currently_eligible: true }],
      });

      const result = await resolveEffectiveSubscription("user_free_power");
      expect(result?.source).toBe("token_holding");
      expect(result?.plan).toBe("fleet");
      expect(result?.tokenTier).toBe("power");
    });

    it("Yearly token sub beats an active Free Stripe row", async () => {
      mockTables({
        sub: {
          plan: "free",
          status: "active",
          instance_limit: 1,
          total_cpu_budget: 0.5,
          total_ram_budget: 1024,
        },
        yearly: {
          tier: "pro",
          status: "active",
          expires_at: "2027-05-16T00:00:00.000Z",
        },
      });

      const result = await resolveEffectiveSubscription("user_free_yearly");
      expect(result?.source).toBe("token_yearly");
      expect(result?.plan).toBe("operator");
    });

    it("falls back to the Free row when no token entitlement qualifies", async () => {
      mockTables({
        sub: {
          plan: "free",
          status: "active",
          instance_limit: 1,
          total_cpu_budget: 0.5,
          total_ram_budget: 1024,
          current_period_end: null,
        },
        quals: [],
      });

      const result = await resolveEffectiveSubscription("user_only_free");
      expect(result).toEqual({
        plan: "free",
        status: "active",
        instance_limit: 1,
        total_cpu_budget: 0.5,
        total_ram_budget: 1024,
        source: "free",
        currentPeriodEnd: null,
        canChangePlanInPlace: false,
      });
    });
  });

  describe("Apple IAP source", () => {
    it("returns an apple_iap entitlement with plan-derived budgets when no Stripe sub exists", async () => {
      mockTables({
        sub: null,
        apple: {
          plan: "operator",
          status: "active",
          current_period_end: "2026-08-16T00:00:00.000Z",
        },
      });

      const result = await resolveEffectiveSubscription("user_apple");
      expect(result).toEqual({
        plan: "operator",
        status: "active",
        // operator plan budgets (PLANS.operator).
        instance_limit: 3,
        total_cpu_budget: 2,
        total_ram_budget: 4096,
        source: "apple_iap",
        currentPeriodEnd: "2026-08-16T00:00:00.000Z",
        canChangePlanInPlace: false,
      });
    });

    it("maps power products to fleet budgets", async () => {
      mockTables({
        sub: null,
        apple: { plan: "fleet", status: "active", current_period_end: null },
      });

      const result = await resolveEffectiveSubscription("user_apple_power");
      expect(result?.plan).toBe("fleet");
      expect(result?.total_cpu_budget).toBe(4);
      expect(result?.total_ram_budget).toBe(8192);
      expect(result?.source).toBe("apple_iap");
    });

    it("surfaces a trialing Apple sub as trialing", async () => {
      mockTables({
        sub: null,
        apple: { plan: "operator", status: "trialing" },
      });

      const result = await resolveEffectiveSubscription("user_apple_trial");
      expect(result?.status).toBe("trialing");
      expect(result?.source).toBe("apple_iap");
    });

    it("keeps access during Apple Billing Grace Period, rendered as past_due", async () => {
      mockTables({
        sub: null,
        apple: { plan: "operator", status: "grace_period" },
      });

      const result = await resolveEffectiveSubscription("user_apple_grace");
      expect(result?.status).toBe("past_due");
      expect(result?.source).toBe("apple_iap");
      expect(result?.instance_limit).toBe(3);
    });

    it("only asks the DB for access-granting Apple statuses", async () => {
      const { appleQuery } = mockTables({ sub: null, apple: null });

      await resolveEffectiveSubscription("user_no_apple");
      expect(appleQuery.in).toHaveBeenCalledWith("status", [
        "active",
        "trialing",
        "grace_period",
      ]);
    });

    it("does not entitle expired/revoked/past_due Apple rows (falls through to free-null)", async () => {
      for (const status of ["past_due", "expired", "revoked"]) {
        mockTables({
          sub: null,
          apple: { plan: "operator", status },
          quals: [],
        });
        const result = await resolveEffectiveSubscription("user_apple_lapsed");
        expect(result).toBeNull();
      }
    });

    it("paid Stripe outranks apple_iap and short-circuits before the apple table", async () => {
      mockTables({
        sub: {
          plan: "operator",
          status: "active",
          instance_limit: 5,
          total_cpu_budget: 4,
          total_ram_budget: 8192,
          stripe_subscription_id: "sub_live_123",
        },
        apple: { plan: "fleet", status: "active" },
      });

      const result = await resolveEffectiveSubscription("user_both_lanes");
      expect(result?.source).toBe("stripe");

      const fromMock = supabaseAdmin!.from as jest.Mock;
      const tablesQueried = fromMock.mock.calls.map((args) => args[0]);
      expect(tablesQueried).not.toContain("apple_iap_subscriptions");
    });

    it("apple_iap outranks yearly-token and token-holding entitlements", async () => {
      mockTables({
        sub: null,
        apple: { plan: "operator", status: "active" },
        yearly: {
          tier: "power",
          status: "active",
          expires_at: "2027-05-01T00:00:00.000Z",
        },
        quals: [{ tier: "power", currently_eligible: true }],
      });

      const result = await resolveEffectiveSubscription("user_apple_and_tokens");
      expect(result?.source).toBe("apple_iap");

      const fromMock = supabaseAdmin!.from as jest.Mock;
      const tablesQueried = fromMock.mock.calls.map((args) => args[0]);
      expect(tablesQueried).not.toContain("yearly_token_subscriptions");
      expect(tablesQueried).not.toContain("token_tier_qualifications");
    });

    it("apple_iap beats the Free Stripe fallback row", async () => {
      mockTables({
        sub: {
          plan: "free",
          status: "active",
          instance_limit: 1,
          total_cpu_budget: 0.5,
          total_ram_budget: 1024,
        },
        apple: { plan: "operator", status: "active" },
      });

      const result = await resolveEffectiveSubscription("user_free_plus_apple");
      expect(result?.source).toBe("apple_iap");
      expect(result?.plan).toBe("operator");
    });

    it("falls through an apple row whose plan key is unknown", async () => {
      mockTables({
        sub: null,
        apple: { plan: "bogus_plan", status: "active" },
        quals: [{ tier: "pro", currently_eligible: true }],
      });

      const result = await resolveEffectiveSubscription("user_apple_bogus");
      expect(result?.source).toBe("token_holding");
    });

    it("a zeroed past_due Stripe row falls through to apple_iap underneath", async () => {
      mockTables({
        sub: {
          plan: "operator",
          status: "past_due",
          instance_limit: 0,
          total_cpu_budget: 2,
          total_ram_budget: 4096,
        },
        apple: { plan: "fleet", status: "active" },
      });

      const result = await resolveEffectiveSubscription("user_zeroed_stripe_apple");
      expect(result?.source).toBe("apple_iap");
      expect(result?.plan).toBe("fleet");
    });
  });

  // Dunning cutoff: a past_due Stripe sub grants access only WHILE it is inside
  // its grace window. Past the anchor it stops entitling — closing the leak
  // where a failed card kept full Pro for the entire ~2-week Stripe retry.
  describe("dunning grace cutoff (past_due)", () => {
    it("still grants access while the grace window is open (future anchor)", async () => {
      mockTables({
        sub: {
          plan: "operator",
          status: "past_due",
          instance_limit: 3,
          total_cpu_budget: 2,
          total_ram_budget: 4096,
          grace_period_ends_at: "2999-01-01T00:00:00.000Z",
        },
      });

      const result = await resolveEffectiveSubscription("user_in_grace");
      expect(result?.source).toBe("stripe");
      expect(result?.status).toBe("past_due");
      expect(result?.instance_limit).toBe(3);
    });

    it("stops granting access once the grace window has elapsed (past anchor) → null", async () => {
      mockTables({
        sub: {
          plan: "operator",
          status: "past_due",
          instance_limit: 3,
          total_cpu_budget: 2,
          total_ram_budget: 4096,
          grace_period_ends_at: "2020-01-01T00:00:00.000Z",
        },
        quals: [],
      });

      const result = await resolveEffectiveSubscription("user_grace_expired");
      expect(result).toBeNull();
    });

    it("a grace-expired past_due row still exposes the token tier underneath", async () => {
      mockTables({
        sub: {
          plan: "operator",
          status: "past_due",
          instance_limit: 3,
          total_cpu_budget: 2,
          total_ram_budget: 4096,
          grace_period_ends_at: "2020-01-01T00:00:00.000Z",
        },
        quals: [{ tier: "power", currently_eligible: true }],
      });

      const result = await resolveEffectiveSubscription("user_grace_expired_token");
      expect(result?.source).toBe("token_holding");
      expect(result?.tokenTier).toBe("power");
    });

    it("fails OPEN on a null anchor — a past_due row without a grace stamp keeps access", async () => {
      mockTables({
        sub: {
          plan: "operator",
          status: "past_due",
          instance_limit: 3,
          total_cpu_budget: 2,
          total_ram_budget: 4096,
          grace_period_ends_at: null,
        },
      });

      const result = await resolveEffectiveSubscription("user_no_anchor");
      expect(result?.source).toBe("stripe");
      expect(result?.status).toBe("past_due");
    });

    it("never cuts off an active row even if a stale past anchor lingers", async () => {
      mockTables({
        sub: {
          plan: "operator",
          status: "active",
          instance_limit: 3,
          total_cpu_budget: 2,
          total_ram_budget: 4096,
          grace_period_ends_at: "2020-01-01T00:00:00.000Z",
        },
      });

      const result = await resolveEffectiveSubscription("user_active_stale_anchor");
      expect(result?.source).toBe("stripe");
      expect(result?.status).toBe("active");
    });
  });
});
