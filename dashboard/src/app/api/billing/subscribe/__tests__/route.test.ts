import { NextRequest } from "next/server";
import Stripe from "stripe";
import { POST } from "../route";
import { auth, currentUser } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getStripe, validateOrRecreateStripeCustomer } from "@/lib/stripe";
import { PLANS } from "@/lib/subscription";
import { resolveEffectiveSubscription } from "@/lib/billing/instance-entitlement";

// Mock dependencies
jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
  currentUser: jest.fn(),
}));

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/stripe", () => ({
  getStripe: jest.fn(),
  validateOrRecreateStripeCustomer: jest.fn(),
}));

const posthogCaptureMock = jest.fn();
const posthogFlushMock = jest.fn().mockResolvedValue(undefined);
jest.mock("@/lib/posthog", () => ({
  posthogClient: {
    capture: (...args: unknown[]) => posthogCaptureMock(...args),
    flush: (...args: unknown[]) => posthogFlushMock(...args),
  },
}));

// The token/yearly entitlement short-circuit consults resolveEffectiveSubscription.
// Default it to null (no token entitlement) so the existing Stripe-path tests are
// unaffected; the token-holder cases override it per-test.
jest.mock("@/lib/billing/instance-entitlement", () => ({
  resolveEffectiveSubscription: jest.fn(),
}));

describe("POST /api/billing/subscribe", () => {
  const mockUserId = "user_123";
  const mockCustomer = { emailAddresses: [{ emailAddress: "test@example.com" }] };
  const mockCustomerStripeId = "cus_123";

  let mockSupabaseQuery: Record<string, jest.Mock>;
  let mockStripeSessionsList: jest.Mock;
  let mockStripeSessionsCreate: jest.Mock;
  let mockStripeSessionsExpire: jest.Mock;
  let mockStripeCustomersCreate: jest.Mock;
  let consoleErrorSpy: jest.SpyInstance;
  let consoleWarnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    (auth as unknown as jest.Mock).mockResolvedValue({ userId: mockUserId });
    (currentUser as jest.Mock).mockResolvedValue(mockCustomer);
    (resolveEffectiveSubscription as jest.Mock).mockResolvedValue(null);

    // Mock price IDs
    // @ts-expect-error Mocking for test
    if (PLANS.operator) PLANS.operator.stripePriceId = "price_operator_test";
    // @ts-expect-error Mocking for test
    if (PLANS.fleet) PLANS.fleet.stripePriceId = "price_fleet_test";
    // @ts-expect-error Mocking for test
    if (PLANS.command) PLANS.command.stripePriceId = "price_command_test";
    // @ts-expect-error Mocking for test
    if (PLANS.operator) PLANS.operator.stripeYearlyPriceId = "price_operator_yearly_test";
    // @ts-expect-error Mocking for test
    if (PLANS.fleet) PLANS.fleet.stripeYearlyPriceId = "price_fleet_yearly_test";

    // Setup Supabase mocks
    mockSupabaseQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      or: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue({ data: [], error: null }),
      maybeSingle: jest.fn(),
      upsert: jest.fn().mockReturnThis(),
    };
    (supabaseAdmin!.from as jest.Mock).mockReturnValue(mockSupabaseQuery);

    // Setup Stripe mocks
    mockStripeSessionsList = jest.fn().mockResolvedValue({ data: [] });
    mockStripeSessionsCreate = jest.fn().mockResolvedValue({ url: "https://stripe.test/checkout/123" });
    mockStripeSessionsExpire = jest.fn().mockResolvedValue({});
    mockStripeCustomersCreate = jest.fn().mockResolvedValue({ id: "cus_new" });
    
    (getStripe as jest.Mock).mockReturnValue({
      checkout: {
        sessions: {
          list: mockStripeSessionsList,
          create: mockStripeSessionsCreate,
          expire: mockStripeSessionsExpire,
        },
      },
      customers: {
        create: mockStripeCustomersCreate,
      }
    });

    (validateOrRecreateStripeCustomer as jest.Mock).mockResolvedValue({
      customerId: mockCustomerStripeId,
      wasRecreated: false,
    });
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  function createRequest(body: Record<string, unknown> = { plan: "fleet" }, rawHeaders: Record<string, string> = {}) {
    return new NextRequest("http://localhost/api/billing/subscribe", {
      method: "POST",
      body: JSON.stringify(body),
      headers: new Headers(rawHeaders),
    });
  }

  function createRawRequest(body: string, rawHeaders: Record<string, string> = {}) {
    return new NextRequest("http://localhost/api/billing/subscribe", {
      method: "POST",
      body,
      headers: new Headers({
        "content-type": "application/json",
        ...rawHeaders,
      }),
    });
  }

  function getSpyOutput(spy: jest.SpyInstance) {
    return JSON.stringify(spy.mock.calls);
  }

  it("should return 401 if unauthorized", async () => {
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: null });
    const res = await POST(createRequest());
    expect(res.status).toBe(401);
  });

  it("should return 400 for invalid plan", async () => {
    const res = await POST(createRequest({ plan: "unreal_plan" }));
    expect(res.status).toBe(400);
  });

  it("activates the free plan without creating a Stripe customer or checkout session", async () => {
    mockSupabaseQuery.maybeSingle.mockResolvedValueOnce({
      data: null,
      error: null,
    });

    const res = await POST(createRequest({ plan: "free" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      success: true,
      data: { activated: true, plan: "free" },
    });
    expect(mockStripeCustomersCreate).not.toHaveBeenCalled();
    expect(mockStripeSessionsCreate).not.toHaveBeenCalled();
    expect(mockSupabaseQuery.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: mockUserId,
        plan: "free",
        status: "active",
        stripe_customer_id: null,
        stripe_subscription_id: null,
        instance_limit: 1,
        total_cpu_budget: 0.5,
        total_ram_budget: 1024,
      }),
      { onConflict: "user_id" }
    );
  });

  it("does not downgrade a manually-granted paid subscription when plan=free is posted", async () => {
    // Manually-granted paid row: plan access but no live Stripe subscription id.
    // The activate page auto-POSTs plan=free on visit, so this must be a no-op.
    mockSupabaseQuery.maybeSingle.mockResolvedValueOnce({
      data: {
        plan: "operator",
        status: "active",
        updated_at: new Date().toISOString(),
        stripe_customer_id: mockCustomerStripeId,
        stripe_subscription_id: "manual_token_power",
      },
      error: null,
    });

    const res = await POST(createRequest({ plan: "free" }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("You already have an active subscription");
    expect(body.reason).toBe("ACTIVE_SUBSCRIPTION");
    expect(mockSupabaseQuery.upsert).not.toHaveBeenCalled();
    expect(mockStripeCustomersCreate).not.toHaveBeenCalled();
    expect(mockStripeSessionsCreate).not.toHaveBeenCalled();
  });

  it("short-circuits a token-power holder to the dashboard instead of paid checkout", async () => {
    // Returning $HERMESOS power holder: canceled Stripe row (payment lapsed),
    // but the token qualification still entitles them to fleet. The get-started
    // funnel auto-selects `operator` — they must NOT be shown a Stripe bill for
    // compute they already own.
    mockSupabaseQuery.maybeSingle.mockResolvedValueOnce({
      data: {
        plan: "command",
        status: "canceled",
        updated_at: new Date().toISOString(),
        stripe_customer_id: mockCustomerStripeId,
        stripe_subscription_id: "sub_lapsed",
      },
      error: null,
    });
    (resolveEffectiveSubscription as jest.Mock).mockResolvedValue({
      plan: "fleet",
      status: "active",
      instance_limit: 3,
      total_cpu_budget: 4,
      total_ram_budget: 8192,
      source: "token_holding",
      tokenTier: "power",
      canChangePlanInPlace: false,
    });

    const res = await POST(createRequest({ plan: "operator" }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.reason).toBe("ACTIVE_SUBSCRIPTION");
    expect(mockStripeSessionsCreate).not.toHaveBeenCalled();
    expect(mockStripeCustomersCreate).not.toHaveBeenCalled();
  });

  it("lets a token-pro holder still buy a strictly higher (fleet) plan", async () => {
    // Pro-tier token holder (operator-equivalent) genuinely upgrading to fleet:
    // the request exceeds their token tier, so real Checkout must proceed.
    mockSupabaseQuery.maybeSingle.mockResolvedValueOnce({
      data: null,
      error: null,
    });
    (resolveEffectiveSubscription as jest.Mock).mockResolvedValue({
      plan: "operator",
      status: "active",
      instance_limit: 1,
      total_cpu_budget: 2,
      total_ram_budget: 4096,
      source: "token_holding",
      tokenTier: "pro",
      canChangePlanInPlace: false,
    });

    const res = await POST(createRequest({ plan: "fleet" }));

    expect(res.status).toBe(200);
    expect(mockStripeSessionsCreate).toHaveBeenCalled();
  });

  it("re-activates the free plan for an existing free row", async () => {
    mockSupabaseQuery.maybeSingle.mockResolvedValueOnce({
      data: {
        plan: "free",
        status: "active",
        updated_at: new Date().toISOString(),
        stripe_customer_id: mockCustomerStripeId,
        stripe_subscription_id: null,
      },
      error: null,
    });

    const res = await POST(createRequest({ plan: "free" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      success: true,
      data: { activated: true, plan: "free" },
    });
    expect(mockSupabaseQuery.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: mockUserId,
        plan: "free",
        status: "active",
        stripe_customer_id: mockCustomerStripeId,
      }),
      { onConflict: "user_id" }
    );
  });

  it("activates the free plan over a canceled paid row", async () => {
    mockSupabaseQuery.maybeSingle.mockResolvedValueOnce({
      data: {
        plan: "operator",
        status: "canceled",
        updated_at: new Date().toISOString(),
        stripe_customer_id: mockCustomerStripeId,
        stripe_subscription_id: "sub_old",
      },
      error: null,
    });

    const res = await POST(createRequest({ plan: "free" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      success: true,
      data: { activated: true, plan: "free" },
    });
    expect(mockSupabaseQuery.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: mockUserId,
        plan: "free",
        status: "active",
      }),
      { onConflict: "user_id" }
    );
  });

  it("lets an active free user start direct paid checkout without a trial", async () => {
    mockSupabaseQuery.maybeSingle.mockResolvedValueOnce({
      data: {
        plan: "free",
        status: "active",
        updated_at: new Date().toISOString(),
        stripe_customer_id: null,
      },
      error: null,
    });

    const res = await POST(createRequest({ plan: "operator" }));

    expect(res.status).toBe(200);
    expect(validateOrRecreateStripeCustomer).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: null,
        clerkUserId: mockUserId,
      })
    );
    expect(mockStripeSessionsCreate).toHaveBeenCalled();
    const callArgs = mockStripeSessionsCreate.mock.calls[0][0];
    expect(callArgs.subscription_data?.trial_period_days).toBeUndefined();
  });

  it("should gracefully recover an existing open Stripe checkout session on 409", async () => {
    // Database returns a pending subscription updated within the hour
    mockSupabaseQuery.maybeSingle.mockResolvedValueOnce({
      data: { 
        status: "pending", 
        updated_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // 5 mins ago
        stripe_customer_id: mockCustomerStripeId
      },
      error: null,
    });

    // Stripe has an open session
    mockStripeSessionsList.mockResolvedValueOnce({
      data: [
        {
          id: "cs_resume",
          status: "open",
          mode: "subscription",
          url: "https://stripe.resumed/checkout/999",
          metadata: {
            user_id: mockUserId,
            plan: "fleet",
          },
        }
      ]
    });

    const res = await POST(createRequest());
    expect(res.status).toBe(200);
    
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.url).toBe("https://stripe.resumed/checkout/999");
    expect(body.data.resumed).toBe(true);

    // Should NOT have created a new session
    expect(mockStripeSessionsCreate).not.toHaveBeenCalled();
    expect(mockStripeSessionsExpire).not.toHaveBeenCalled();
  });

  it("should prevent duplication and return 409 if Stripe recovery fails", async () => {
    // Database returns pending within hour
    mockSupabaseQuery.maybeSingle.mockResolvedValueOnce({
      data: { 
        status: "pending", 
        updated_at: new Date().toISOString(),
        stripe_customer_id: mockCustomerStripeId
      },
      error: null,
    });

    // Stripe throws error during lookup
    mockStripeSessionsList.mockRejectedValueOnce(new Error("stripe-recovery-secret"));

    const res = await POST(createRequest());
    expect(res.status).toBe(409);
    
    const body = await res.json();
    expect(body.error).toContain("A checkout session is already in progress");
    expect(body.reason).toBe("CHECKOUT_IN_PROGRESS");
    expect(JSON.stringify(body)).not.toContain("stripe-recovery-secret");
    expect(getSpyOutput(consoleErrorSpy)).not.toContain("stripe-recovery-secret");
    expect(mockStripeSessionsCreate).not.toHaveBeenCalled();
  });

  it("recreates checkout instead of blocking when the pending record has no Stripe customer id", async () => {
    mockSupabaseQuery.maybeSingle.mockResolvedValueOnce({
      data: {
        status: "pending",
        updated_at: new Date().toISOString(),
        stripe_customer_id: null,
      },
      error: null,
    });

    const res = await POST(createRequest());
    expect(res.status).toBe(200);

    expect(validateOrRecreateStripeCustomer).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: null,
        clerkUserId: mockUserId,
      })
    );
    expect(mockStripeSessionsList).toHaveBeenCalledWith({
      customer: mockCustomerStripeId,
      limit: 10,
    });
    expect(mockStripeSessionsCreate).toHaveBeenCalled();
  });

  it("expires mismatched open sessions before creating a fresh checkout", async () => {
    mockSupabaseQuery.maybeSingle.mockResolvedValueOnce({
      data: {
        status: "pending",
        updated_at: new Date().toISOString(),
        stripe_customer_id: mockCustomerStripeId,
      },
      error: null,
    });

    mockStripeSessionsList.mockResolvedValueOnce({
      data: [
        {
          id: "cs_operator",
          status: "open",
          mode: "subscription",
          url: "https://stripe.test/operator",
          metadata: { user_id: mockUserId, plan: "operator" },
        },
      ],
    });

    const res = await POST(createRequest({ plan: "fleet" }));
    expect(res.status).toBe(200);

    expect(mockStripeSessionsExpire).toHaveBeenCalledWith("cs_operator");
    expect(mockStripeSessionsCreate).toHaveBeenCalled();
  });

  describe("returning to where checkout started", () => {
    const LAUNCH_RETURN = "/dashboard/launch?draft=33333333-3333-4333-8333-333333333333";

    function pendingCheckout() {
      mockSupabaseQuery.maybeSingle.mockResolvedValueOnce({
        data: { status: "pending", updated_at: new Date().toISOString(), stripe_customer_id: mockCustomerStripeId },
        error: null,
      });
    }

    it("sends Stripe's success and cancel pages back to a same-origin launch path", async () => {
      mockSupabaseQuery.maybeSingle.mockResolvedValueOnce({ data: null, error: null });

      const res = await POST(createRequest({ plan: "operator", returnTo: LAUNCH_RETURN }));
      expect(res.status).toBe(200);

      const [params, options] = mockStripeSessionsCreate.mock.calls[0];
      const encoded = encodeURIComponent(LAUNCH_RETURN);
      expect(new URL(params.success_url).pathname + new URL(params.success_url).search)
        .toBe(`/dashboard/billing?subscription=success&session_id={CHECKOUT_SESSION_ID}&returnTo=${encoded}`);
      expect(new URL(params.cancel_url).searchParams.get("returnTo")).toBe(LAUNCH_RETURN);
      expect(new URL(params.cancel_url).pathname).toBe("/checkout/canceled");
      expect(params.metadata).toEqual(expect.objectContaining({ plan: "operator", return_to: LAUNCH_RETURN }));
      // Subscription metadata stays about the subscription.
      expect(params.subscription_data.metadata).not.toHaveProperty("return_to");
      expect(options.idempotencyKey).toMatch(/^checkout_user_123_operator_monthly_r[0-9a-f]{16}_\d+$/);
    });

    it.each([
      ["an absolute URL", "https://evil.example/dashboard/launch"],
      ["a protocol-relative URL", "//evil.example/dashboard"],
      ["a path outside the dashboard", "/api/billing/subscribe"],
      ["a non-string", { path: "/dashboard" }],
    ])("drops %s and checks out without a return path", async (_label, returnTo) => {
      mockSupabaseQuery.maybeSingle.mockResolvedValueOnce({ data: null, error: null });

      const res = await POST(createRequest({ plan: "operator", returnTo }));
      expect(res.status).toBe(200);

      const [params, options] = mockStripeSessionsCreate.mock.calls[0];
      expect(params.success_url).toMatch(/session_id=\{CHECKOUT_SESSION_ID\}$/);
      expect(params.cancel_url).toMatch(/\/checkout\/canceled\?plan=operator$/);
      expect(params.metadata).not.toHaveProperty("return_to");
      expect(options.idempotencyKey).toMatch(/^checkout_user_123_operator_monthly_\d+$/);
    });

    it("resumes an open session only when it returns to the same place", async () => {
      pendingCheckout();
      mockStripeSessionsList.mockResolvedValueOnce({
        data: [
          { id: "cs_plain", status: "open", url: "https://stripe.test/plain", metadata: { user_id: mockUserId, plan: "operator" } },
          { id: "cs_launch", status: "open", url: "https://stripe.test/launch", metadata: { user_id: mockUserId, plan: "operator", return_to: LAUNCH_RETURN } },
        ],
      });

      const res = await POST(createRequest({ plan: "operator", returnTo: LAUNCH_RETURN }));
      const body = await res.json();

      expect(body.data).toEqual({ url: "https://stripe.test/launch", resumed: true });
      expect(mockStripeSessionsCreate).not.toHaveBeenCalled();
    });

    it("never reuses the idempotency key of a session it just expired", async () => {
      // Plain checkout, then one from Launch (which expires the plain one),
      // then plain again: the third must not replay the first, expired
      // session's saved response.
      pendingCheckout();
      mockStripeSessionsList.mockResolvedValueOnce({
        data: [{ id: "cs_launch", status: "open", url: "https://stripe.test/launch", metadata: { user_id: mockUserId, plan: "operator", return_to: LAUNCH_RETURN } }],
      });

      const res = await POST(createRequest({ plan: "operator" }));
      expect(res.status).toBe(200);

      expect(mockStripeSessionsExpire).toHaveBeenCalledWith("cs_launch");
      const [params, options] = mockStripeSessionsCreate.mock.calls[0];
      expect(params.metadata).not.toHaveProperty("return_to");
      expect(options.idempotencyKey).toMatch(/^checkout_user_123_operator_monthly_x[0-9a-f]{16}_\d+$/);
    });
  });

  it("keeps recreated checkout sessions as direct payment with no trial", async () => {
    mockSupabaseQuery.maybeSingle.mockResolvedValueOnce({
      data: {
        status: "pending",
        updated_at: new Date().toISOString(),
        stripe_customer_id: mockCustomerStripeId,
      },
      error: null,
    });

    mockStripeSessionsList.mockResolvedValueOnce({
      data: [
        {
          id: "cs_operator",
          status: "open",
          mode: "subscription",
          url: "https://stripe.test/operator",
          metadata: { user_id: mockUserId, plan: "operator" },
        },
      ],
    });

    const res = await POST(createRequest({ plan: "fleet" }));
    expect(res.status).toBe(200);

    const callArgs = mockStripeSessionsCreate.mock.calls[0][0];
    expect(callArgs.subscription_data?.trial_period_days).toBeUndefined();
    expect(mockStripeSessionsExpire).toHaveBeenCalledWith("cs_operator");
  });

  it("does not leak stale session expiration errors to logs", async () => {
    mockSupabaseQuery.maybeSingle.mockResolvedValueOnce({
      data: {
        status: "pending",
        updated_at: new Date().toISOString(),
        stripe_customer_id: mockCustomerStripeId,
      },
      error: null,
    });

    mockStripeSessionsList.mockResolvedValueOnce({
      data: [
        {
          id: "cs_operator",
          status: "open",
          mode: "subscription",
          url: "https://stripe.test/operator",
          metadata: { user_id: mockUserId, plan: "operator" },
        },
      ],
    });
    mockStripeSessionsExpire.mockRejectedValueOnce(new Error("stale-session-secret"));

    const res = await POST(createRequest({ plan: "fleet" }));
    expect(res.status).toBe(200);

    expect(mockStripeSessionsCreate).toHaveBeenCalled();
    expect(getSpyOutput(consoleWarnSpy)).not.toContain("stale-session-secret");
  });

  it("should block subscribe if plan is already active", async () => {
    mockSupabaseQuery.maybeSingle.mockResolvedValueOnce({
      data: {
        plan: "operator",
        status: "active",
        stripe_subscription_id: "sub_existing",
      },
      error: null,
    });

    const res = await POST(createRequest());
    expect(res.status).toBe(400);
    
    const body = await res.json();
    expect(body.error).toContain("You already have an active subscription");
    expect(body.reason).toBe("ACTIVE_SUBSCRIPTION");
  });

  it("lets active manual paid users start checkout without overwriting their current entitlement", async () => {
    mockSupabaseQuery.maybeSingle.mockResolvedValueOnce({
      data: {
        plan: "operator",
        status: "active",
        updated_at: new Date().toISOString(),
        stripe_customer_id: mockCustomerStripeId,
        stripe_subscription_id: "manual_token_power",
      },
      error: null,
    });

    const res = await POST(createRequest({ plan: "fleet" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.url).toBe("https://stripe.test/checkout/123");
    expect(validateOrRecreateStripeCustomer).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: mockCustomerStripeId,
        clerkUserId: mockUserId,
      })
    );
    expect(mockStripeSessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: mockCustomerStripeId,
        line_items: [{ price: "price_fleet_test", quantity: 1 }],
        metadata: expect.objectContaining({
          plan: "fleet",
          cadence: "monthly",
        }),
      }),
      expect.anything()
    );
    expect(mockSupabaseQuery.upsert).not.toHaveBeenCalled();
  });

  it("should block subscribe if the user is in a Stripe trial period", async () => {
    mockSupabaseQuery.maybeSingle.mockResolvedValueOnce({
      data: { status: "trialing" },
      error: null,
    });

    const res = await POST(createRequest({ plan: "operator" }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("You already have an active subscription");
    expect(body.reason).toBe("ACTIVE_SUBSCRIPTION");
    expect(mockStripeSessionsCreate).not.toHaveBeenCalled();
  });

  it("should create new checkout session and upsert pending status", async () => {
    // No existing sub
    mockSupabaseQuery.maybeSingle.mockResolvedValueOnce({ data: null, error: null });

    const res = await POST(createRequest());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.url).toBe("https://stripe.test/checkout/123");

    // Verify Stripe called with correct idempotency and dedicated cancel route
    expect(mockStripeSessionsCreate).toHaveBeenCalledWith(expect.objectContaining({
      success_url: expect.stringContaining("/dashboard/billing?subscription=success&session_id={CHECKOUT_SESSION_ID}"),
      cancel_url: expect.stringContaining("/checkout/canceled?plan=fleet"),
      customer: "cus_new",
      client_reference_id: mockUserId,
      metadata: expect.objectContaining({
        user_id: mockUserId,
        plan: "fleet",
        checkout_ip: "127.0.0.1",
      }),
    }), expect.objectContaining({
      idempotencyKey: expect.any(String)
    }));

    // Verify upsert called
    expect(mockSupabaseQuery.upsert).toHaveBeenCalledWith(expect.objectContaining({
      user_id: mockUserId,
      plan: "fleet",
      status: "pending",
    }), expect.objectContaining({ onConflict: "user_id" }));
  });

  it("builds Stripe redirect URLs from the runtime apex, not a build-frozen NEXT_PUBLIC_APP_URL", async () => {
    // Regression guard for the hermesos.cloud→hivra.cloud apex cutover: the
    // success/cancel URLs resolve NEXT_PUBLIC_APP_URL at RUNTIME (via
    // getDashboardOrigin), so a bundle built before an apex change still points
    // post-checkout redirects at the live host instead of the stale value Next
    // would otherwise build-inline. Mutating process.env here and seeing it
    // reflected in the Stripe session proves the read is not build-time frozen.
    const original = process.env.NEXT_PUBLIC_APP_URL;
    process.env.NEXT_PUBLIC_APP_URL = "https://runtime-apex.test";
    try {
      mockSupabaseQuery.maybeSingle.mockResolvedValueOnce({ data: null, error: null });

      const res = await POST(createRequest());
      expect(res.status).toBe(200);

      expect(mockStripeSessionsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          success_url:
            "https://runtime-apex.test/dashboard/billing?subscription=success&session_id={CHECKOUT_SESSION_ID}",
          cancel_url: "https://runtime-apex.test/checkout/canceled?plan=fleet",
        }),
        expect.anything()
      );
    } finally {
      if (original === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
      else process.env.NEXT_PUBLIC_APP_URL = original;
    }
  });

  it("should refresh pending checkout state for an existing Stripe customer before returning the new checkout URL", async () => {
    mockSupabaseQuery.maybeSingle.mockResolvedValueOnce({
      data: {
        stripe_customer_id: mockCustomerStripeId,
        status: "canceled",
        updated_at: null,
      },
      error: null,
    });

    const res = await POST(createRequest());
    expect(res.status).toBe(200);

    expect(mockStripeSessionsCreate).toHaveBeenCalled();
    expect(mockSupabaseQuery.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: mockUserId,
        stripe_customer_id: mockCustomerStripeId,
        status: "pending",
        plan: "fleet",
      }),
      expect.objectContaining({ onConflict: "user_id" })
    );
  });

  it("should reject invalid JSON with a stable invalid-body reason", async () => {
    const res = await POST(createRawRequest("{ plan:"));

    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain("Invalid JSON");
    expect(body.reason).toBe("INVALID_BODY");
  });

  it("does not leak raw JSON parser failures", async () => {
    const req = {
      headers: new Headers(),
      json: jest.fn().mockRejectedValue(new Error("json-secret-leak")),
    } as unknown as NextRequest;

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Invalid JSON body");
    expect(body.reason).toBe("INVALID_BODY");
    expect(JSON.stringify(body)).not.toContain("json-secret-leak");
    expect(getSpyOutput(consoleErrorSpy)).not.toContain("json-secret-leak");
  });

  it("sanitizes proxy IP headers before storing checkout metadata and skips trial lookups", async () => {
    mockSupabaseQuery.maybeSingle.mockResolvedValueOnce({ data: null, error: null });

    const res = await POST(
      createRequest(
        { plan: "fleet" },
        { "cf-connecting-ip": "198.51.100.7,or(status.eq.active)" }
      )
    );

    expect(res.status).toBe(200);
    const callArgs = mockStripeSessionsCreate.mock.calls[0][0];
    expect(callArgs.metadata.checkout_ip).toBe("198.51.100.7");
    expect((supabaseAdmin!.from as jest.Mock).mock.calls).not.toContainEqual([
      "hermes_trial_usage",
    ]);
  });

  it("keeps IPv6 checkout metadata without running trial filters", async () => {
    mockSupabaseQuery.maybeSingle.mockResolvedValueOnce({ data: null, error: null });

    const res = await POST(
      createRequest(
        { plan: "fleet" },
        { "cf-connecting-ip": "2001:db8::1" }
      )
    );

    expect(res.status).toBe(200);
    const callArgs = mockStripeSessionsCreate.mock.calls[0][0];
    expect(callArgs.metadata.checkout_ip).toBe("2001:db8::1");
    expect((supabaseAdmin!.from as jest.Mock).mock.calls).not.toContainEqual([
      "hermes_trial_usage",
    ]);
    expect(mockSupabaseQuery.or).not.toHaveBeenCalled();
  });

  it("ignores old trial-usage rows because new paid checkout is direct payment", async () => {
    mockSupabaseQuery.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    mockSupabaseQuery.limit
      .mockResolvedValueOnce({ data: [], error: null })
      .mockResolvedValueOnce({ data: [{ id: "trial_1" }], error: null });

    const res = await POST(
      createRequest(
        { plan: "fleet" },
        { "cf-connecting-ip": "198.51.100.7" }
      )
    );

    expect(res.status).toBe(200);
    const callArgs = mockStripeSessionsCreate.mock.calls[0][0];
    expect(callArgs.subscription_data?.trial_period_days).toBeUndefined();
    expect((supabaseAdmin!.from as jest.Mock).mock.calls).not.toContainEqual([
      "hermes_trial_usage",
    ]);
  });

  it("does not grant hackathon trials; paid checkout is direct payment", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-04-18T12:00:00.000Z"));
    mockSupabaseQuery.maybeSingle.mockResolvedValueOnce({ data: null, error: null });

    const res = await POST(createRequest({ plan: "operator" }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);

    const callArgs = mockStripeSessionsCreate.mock.calls[0][0];
    expect(callArgs.subscription_data?.trial_period_days).toBeUndefined();
    expect(callArgs.subscription_data).not.toHaveProperty("trial_end");
    expect(callArgs.payment_method_collection).toBe("always");
    expect(callArgs.metadata).toEqual(
      expect.objectContaining({
        user_id: mockUserId,
        plan: "operator",
        checkout_ip: "127.0.0.1",
      })
    );
  });

  it("should extract client IP securely from X-Real-IP", async () => {
    mockSupabaseQuery.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    
    // Simulate Vercel passing X-Real-IP
    const req = createRequest({ plan: "fleet" }, { "x-real-ip": "203.0.113.1", "x-forwarded-for": "203.0.113.4, 203.0.113.1" });
    const res = await POST(req);
    
    expect(res.status).toBe(200);
    // Verify that the checkout session metadata includes the securely extracted IP
    expect(mockStripeSessionsCreate).toHaveBeenCalledWith(expect.anything(), expect.anything());
    const callArgs = mockStripeSessionsCreate.mock.calls[0][0];
    expect(callArgs.metadata.checkout_ip).toBe("203.0.113.1");
    expect(callArgs.subscription_data.metadata.checkout_ip).toBe("203.0.113.1");
  });

  it("should use the first X-Forwarded-For entry when X-Real-IP is absent", async () => {
    mockSupabaseQuery.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    
    const req = createRequest({ plan: "fleet" }, { "x-forwarded-for": "1.1.1.1, 198.51.100.1" });
    const res = await POST(req);
    
    expect(res.status).toBe(200);
    const callArgs = mockStripeSessionsCreate.mock.calls[0][0];
    expect(callArgs.metadata.checkout_ip).toBe("1.1.1.1");
    expect(callArgs.subscription_data.metadata.checkout_ip).toBe("1.1.1.1");
  });

  it("does not leak raw database errors when the new customer record cannot be persisted", async () => {
    const existingSubscriptionBuilder = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
    };
    const persistBuilder = {
      upsert: jest.fn().mockResolvedValue({
        error: {
          message: "db-secret-leak",
          code: "23505",
          details: "db-secret-details",
          hint: "db-secret-hint",
        },
      }),
    };

    (supabaseAdmin!.from as jest.Mock)
      .mockImplementationOnce(() => existingSubscriptionBuilder)
      .mockImplementationOnce(() => persistBuilder);

    const res = await POST(createRequest());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Failed to prepare checkout");
    expect(JSON.stringify(body)).not.toContain("db-secret-leak");
    expect(getSpyOutput(consoleErrorSpy)).not.toContain("db-secret-leak");
    expect(getSpyOutput(consoleErrorSpy)).not.toContain("db-secret-details");
    expect(getSpyOutput(consoleErrorSpy)).not.toContain("db-secret-hint");
  });

  it("does not leak raw Stripe checkout errors from the final catch path", async () => {
    mockSupabaseQuery.maybeSingle.mockResolvedValueOnce({ data: null, error: null });

    const stripeError = Object.assign(Object.create(Stripe.errors.StripeError.prototype), {
      message: "stripe-secret-leak",
      type: "StripeInvalidRequestError",
      code: "resource_missing",
    });
    mockStripeSessionsCreate.mockRejectedValueOnce(stripeError);

    const res = await POST(createRequest());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Unable to process subscription. Please try again or contact support.");
    expect(JSON.stringify(body)).not.toContain("stripe-secret-leak");
    expect(getSpyOutput(consoleErrorSpy)).not.toContain("stripe-secret-leak");
  });

  it("does not leak raw pending checkout refresh errors to logs", async () => {
    const existingSubscriptionBuilder = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          stripe_customer_id: mockCustomerStripeId,
          status: "canceled",
          updated_at: null,
        },
        error: null,
      }),
    };
    const refreshBuilder = {
      upsert: jest.fn().mockResolvedValue({
        error: {
          message: "pending-refresh-secret",
          code: "PGRST001",
          details: "pending-refresh-details",
          hint: "pending-refresh-hint",
        },
      }),
    };

    (supabaseAdmin!.from as jest.Mock)
      .mockImplementationOnce(() => existingSubscriptionBuilder)
      .mockImplementationOnce(() => refreshBuilder);

    const res = await POST(createRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(getSpyOutput(consoleErrorSpy)).not.toContain("pending-refresh-secret");
    expect(getSpyOutput(consoleErrorSpy)).not.toContain("pending-refresh-details");
    expect(getSpyOutput(consoleErrorSpy)).not.toContain("pending-refresh-hint");
  });

  // ── Yearly cadence — added 2026-05-01 ────────────────────────────────────
  // Two regression tests guarding the cadence parameter so a future refactor
  // can't silently fall back to the monthly price when "yearly" is requested.

  it("forwards the YEARLY Stripe price to checkout when cadence is 'yearly'", async () => {
    mockSupabaseQuery.maybeSingle.mockResolvedValueOnce({ data: null, error: null });

    const res = await POST(createRequest({ plan: "fleet", cadence: "yearly" }));
    expect(res.status).toBe(200);

    expect(mockStripeSessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: [{ price: "price_fleet_yearly_test", quantity: 1 }],
        metadata: expect.objectContaining({
          plan: "fleet",
          cadence: "yearly",
        }),
      }),
      expect.objectContaining({ idempotencyKey: expect.stringContaining("yearly") })
    );
  });

  it("defaults to the monthly Stripe price when cadence is omitted", async () => {
    mockSupabaseQuery.maybeSingle.mockResolvedValueOnce({ data: null, error: null });

    const res = await POST(createRequest({ plan: "fleet" }));
    expect(res.status).toBe(200);

    expect(mockStripeSessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: [{ price: "price_fleet_test", quantity: 1 }],
        metadata: expect.objectContaining({
          plan: "fleet",
          cadence: "monthly",
        }),
      }),
      expect.anything()
    );
  });

  it("returns 500 with the missing env-var name when the yearly price isn't configured", async () => {
    // @ts-expect-error Mocking for test
    PLANS.fleet.stripeYearlyPriceId = "";
    mockSupabaseQuery.maybeSingle.mockResolvedValueOnce({ data: null, error: null });

    const res = await POST(createRequest({ plan: "fleet", cadence: "yearly" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("STRIPE_FLEET_YEARLY_PRICE_ID");
  });

  it("rejects an invalid cadence value", async () => {
    const res = await POST(createRequest({ plan: "fleet", cadence: "weekly" }));
    expect(res.status).toBe(400);
  });

  // ── Signup attribution (first-touch, write-once) — added 2026-06-10 ──────
  // The client forwards the localStorage UTM stash; the route must persist it
  // on the subscription row exactly once and never clobber an earlier capture.

  const sampleAttribution = {
    utm_source: "twitter",
    utm_medium: "social",
    utm_campaign: "launch",
    referrer: "https://x.com/hermesos",
    landing_page: "/",
    captured_at: 1765370000000,
  };

  it("persists signup attribution on the pending checkout upsert for a new customer", async () => {
    mockSupabaseQuery.maybeSingle.mockResolvedValueOnce({ data: null, error: null });

    const res = await POST(
      createRequest({ plan: "fleet", attribution: sampleAttribution })
    );
    expect(res.status).toBe(200);

    expect(mockSupabaseQuery.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: mockUserId,
        plan: "fleet",
        status: "pending",
        signup_attribution: expect.objectContaining({
          utm_source: "twitter",
          utm_medium: "social",
          utm_campaign: "launch",
          referrer: "https://x.com/hermesos",
          landing_page: "/",
          captured_at: 1765370000000,
        }),
      }),
      expect.objectContaining({ onConflict: "user_id" })
    );
  });

  it("persists signup attribution on free-plan activation", async () => {
    mockSupabaseQuery.maybeSingle.mockResolvedValueOnce({ data: null, error: null });

    const res = await POST(
      createRequest({ plan: "free", attribution: sampleAttribution })
    );
    expect(res.status).toBe(200);

    expect(mockSupabaseQuery.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: mockUserId,
        plan: "free",
        status: "active",
        signup_attribution: expect.objectContaining({ utm_source: "twitter" }),
      }),
      { onConflict: "user_id" }
    );
  });

  it("drops attribution when the existing row already carries one (write-once)", async () => {
    mockSupabaseQuery.maybeSingle.mockResolvedValueOnce({
      data: {
        stripe_customer_id: mockCustomerStripeId,
        status: "canceled",
        updated_at: null,
        signup_attribution: { utm_source: "original-touch" },
      },
      error: null,
    });

    const res = await POST(
      createRequest({ plan: "fleet", attribution: sampleAttribution })
    );
    expect(res.status).toBe(200);

    // The pending-refresh upsert must OMIT the key entirely so the
    // first-touch capture can never be overwritten.
    expect(mockSupabaseQuery.upsert).toHaveBeenCalled();
    for (const call of mockSupabaseQuery.upsert.mock.calls) {
      expect(call[0]).not.toHaveProperty("signup_attribution");
    }
  });

  it("omits attribution from the upsert when the client sends none", async () => {
    mockSupabaseQuery.maybeSingle.mockResolvedValueOnce({ data: null, error: null });

    const res = await POST(createRequest({ plan: "fleet" }));
    expect(res.status).toBe(200);

    expect(mockSupabaseQuery.upsert).toHaveBeenCalled();
    for (const call of mockSupabaseQuery.upsert.mock.calls) {
      expect(call[0]).not.toHaveProperty("signup_attribution");
    }
  });

  it("rejects attribution fields exceeding the 256-char cap", async () => {
    const res = await POST(
      createRequest({
        plan: "fleet",
        attribution: { utm_source: "x".repeat(300) },
      })
    );
    expect(res.status).toBe(400);
  });

  it("strips unknown attribution keys before persisting", async () => {
    mockSupabaseQuery.maybeSingle.mockResolvedValueOnce({ data: null, error: null });

    const res = await POST(
      createRequest({
        plan: "fleet",
        attribution: { utm_source: "twitter", injected_key: "nope" },
      })
    );
    expect(res.status).toBe(200);

    const upsertCall = mockSupabaseQuery.upsert.mock.calls.find(
      (call) => call[0]?.signup_attribution
    );
    expect(upsertCall).toBeDefined();
    expect(upsertCall![0].signup_attribution).toEqual({ utm_source: "twitter" });
  });

  // ── 7-day Pro trial experiment (default-off A/B) ─────────────────────────
  describe("trial experiment wiring", () => {
    const ORIGINAL_ENV = process.env;

    beforeEach(() => {
      process.env = { ...ORIGINAL_ENV };
      delete process.env.TRIAL_EXPERIMENT_ENABLED;
      delete process.env.TRIAL_EXPERIMENT_PERCENT;
      posthogFlushMock.mockResolvedValue(undefined);
    });

    afterAll(() => {
      process.env = ORIGINAL_ENV;
    });

    function sessionCreateParams() {
      expect(mockStripeSessionsCreate).toHaveBeenCalledTimes(1);
      return mockStripeSessionsCreate.mock.calls[0][0];
    }

    it("default-off: paid checkout has NO trial_period_days and no assignment event", async () => {
      mockSupabaseQuery.maybeSingle.mockResolvedValueOnce({ data: null, error: null });

      const res = await POST(createRequest({ plan: "fleet" }));
      expect(res.status).toBe(200);

      const params = sessionCreateParams();
      expect(params.subscription_data.trial_period_days).toBeUndefined();
      expect(params.metadata.trial_days).toBeUndefined();
      expect(posthogCaptureMock).not.toHaveBeenCalled();
    });

    it("enabled + 100% (trial bucket): checkout carries trial_period_days=7 and captures the assignment", async () => {
      process.env.TRIAL_EXPERIMENT_ENABLED = "true";
      process.env.TRIAL_EXPERIMENT_PERCENT = "100";
      mockSupabaseQuery.maybeSingle.mockResolvedValueOnce({ data: null, error: null });

      const res = await POST(createRequest({ plan: "fleet" }));
      expect(res.status).toBe(200);

      const params = sessionCreateParams();
      expect(params.subscription_data.trial_period_days).toBe(7);
      expect(params.subscription_data.metadata.trial_days).toBe("7");
      expect(params.metadata.trial_days).toBe("7");

      expect(posthogCaptureMock).toHaveBeenCalledWith({
        distinctId: mockUserId,
        event: "trial_experiment_assigned",
        properties: expect.objectContaining({
          bucket: "trial",
          plan: "fleet",
          trial_days: 7,
          $insert_id: `trial_experiment_assigned_${mockUserId}`,
        }),
      });
      expect(posthogFlushMock).toHaveBeenCalled();
    });

    it("enabled + 0% (control bucket): no trial days, but the assignment event still fires with bucket=control", async () => {
      process.env.TRIAL_EXPERIMENT_ENABLED = "true";
      process.env.TRIAL_EXPERIMENT_PERCENT = "0";
      mockSupabaseQuery.maybeSingle.mockResolvedValueOnce({ data: null, error: null });

      const res = await POST(createRequest({ plan: "fleet" }));
      expect(res.status).toBe(200);

      const params = sessionCreateParams();
      expect(params.subscription_data.trial_period_days).toBeUndefined();

      expect(posthogCaptureMock).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "trial_experiment_assigned",
          properties: expect.objectContaining({ bucket: "control", trial_days: 0 }),
        })
      );
    });

    it("enabled: free-plan activation never assigns or trials (no checkout reached)", async () => {
      process.env.TRIAL_EXPERIMENT_ENABLED = "true";
      process.env.TRIAL_EXPERIMENT_PERCENT = "100";
      mockSupabaseQuery.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
      mockSupabaseQuery.upsert.mockResolvedValueOnce({ error: null });

      const res = await POST(createRequest({ plan: "free" }));
      expect(res.status).toBe(200);

      expect(mockStripeSessionsCreate).not.toHaveBeenCalled();
      expect(posthogCaptureMock).not.toHaveBeenCalled();
    });

    it("a PostHog flush failure never breaks checkout", async () => {
      process.env.TRIAL_EXPERIMENT_ENABLED = "true";
      process.env.TRIAL_EXPERIMENT_PERCENT = "100";
      posthogFlushMock.mockRejectedValueOnce(new Error("posthog down"));
      mockSupabaseQuery.maybeSingle.mockResolvedValueOnce({ data: null, error: null });

      const res = await POST(createRequest({ plan: "fleet" }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.url).toBe("https://stripe.test/checkout/123");
    });
  });
});
