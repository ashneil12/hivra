import Stripe from "stripe";
import { POST } from "../route";
import { auth, currentUser } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getStripe, validateOrRecreateStripeCustomer } from "@/lib/stripe";
import { applyTierChange } from "@/lib/services/tier-change-service";
import { reportOpsEvent } from "@/lib/ops-events";
import { PLANS } from "@/lib/subscription";
import { makeJsonRequest } from "@/test-utils/request";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
  currentUser: jest.fn(),
}));

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/stripe", () => ({
  getStripe: jest.fn(),
  validateOrRecreateStripeCustomer: jest.fn(),
}));

jest.mock("@/lib/services/tier-change-service", () => ({
  applyTierChange: jest.fn(),
}));

jest.mock("@/lib/ops-events", () => ({
  // Preserve the real module (apiError() depends on sanitizeOpsMetadata) and
  // only stub the feed write.
  ...jest.requireActual("@/lib/ops-events"),
  reportOpsEvent: jest.fn(),
}));

describe("POST /api/billing/change-plan", () => {
  const mockUserId = "user_123";
  let consoleErrorSpy: jest.SpyInstance;
  const ORIGINAL_DOWNGRADE_FLAG = process.env.HERMES_SELF_SERVE_DOWNGRADE_ENABLED;

  function createRequest(body: Record<string, unknown> = { newPlan: "fleet" }) {
    return makeJsonRequest("http://localhost/api/billing/change-plan", body, { method: "POST" });
  }

  beforeEach(() => {
    jest.resetAllMocks();
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    // Default OFF — each downgrade test that needs it sets the flag explicitly.
    delete process.env.HERMES_SELF_SERVE_DOWNGRADE_ENABLED;

    (auth as unknown as jest.Mock).mockResolvedValue({ userId: mockUserId });
    (currentUser as jest.Mock).mockResolvedValue({
      emailAddresses: [{ emailAddress: "test@example.com" }],
      firstName: "Test",
      lastName: "User",
    });

    // Idempotent tier-apply + ops-feed are best-effort side effects — default
    // them to a clean success so the happy paths don't throw.
    (applyTierChange as jest.Mock).mockResolvedValue({
      userId: mockUserId,
      newTier: "operator",
      instancesUpdated: 1,
      resizesAttempted: 1,
      resizesSucceeded: 1,
      resizesFailed: [],
    });
    (reportOpsEvent as jest.Mock).mockResolvedValue(null);

    // @ts-expect-error test override
    PLANS.operator.stripePriceId = "price_operator_test";
    // @ts-expect-error test override
    PLANS.fleet.stripePriceId = "price_fleet_test";
    // @ts-expect-error test override
    PLANS.command.stripePriceId = "price_command_test";
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    if (ORIGINAL_DOWNGRADE_FLAG === undefined) {
      delete process.env.HERMES_SELF_SERVE_DOWNGRADE_ENABLED;
    } else {
      process.env.HERMES_SELF_SERVE_DOWNGRADE_ENABLED = ORIGINAL_DOWNGRADE_FLAG;
    }
  });

  it("refuses to upgrade manual or missing-Stripe paid rows without secure checkout", async () => {
    const selectBuilder = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          plan: "operator",
          status: "active",
          stripe_subscription_id: "manual_123",
          stripe_customer_id: "cus_manual",
          total_cpu_budget: 2,
          total_ram_budget: 4096,
          instance_limit: 999,
        },
        error: null,
      }),
    };

    (supabaseAdmin!.from as jest.Mock).mockImplementationOnce(() => selectBuilder);

    const res = await POST(createRequest({ newPlan: "fleet" }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toMatch(/secure checkout|re-subscribe/i);
    expect(validateOrRecreateStripeCustomer).not.toHaveBeenCalled();
    expect(getStripe).not.toHaveBeenCalled();
    expect(currentUser).not.toHaveBeenCalled();
  });

  it("does not treat the free plan as a manual paid subscription upgrade", async () => {
    const selectBuilder = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          plan: "free",
          status: "active",
          stripe_subscription_id: null,
          stripe_customer_id: null,
          total_cpu_budget: 0.5,
          total_ram_budget: 1024,
          instance_limit: 1,
        },
        error: null,
      }),
    };

    (supabaseAdmin!.from as jest.Mock).mockImplementationOnce(() => selectBuilder);

    const res = await POST(createRequest({ newPlan: "fleet" }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toMatch(/secure checkout/i);
    expect(validateOrRecreateStripeCustomer).not.toHaveBeenCalled();
    expect(getStripe).not.toHaveBeenCalled();
  });

  it("keeps the Stripe upgrade flow for paid subscriptions", async () => {
    const selectBuilder = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          plan: "operator",
          status: "active",
          stripe_subscription_id: "sub_123",
          stripe_customer_id: "cus_live",
          total_cpu_budget: 2,
          total_ram_budget: 4096,
          instance_limit: 999,
        },
        error: null,
      }),
    };
    const updateBuilder = {
      update: jest.fn().mockReturnThis(),
      eq: jest.fn().mockResolvedValue({ error: null }),
    };
    const mockRetrieve = jest.fn().mockResolvedValue({
      customer: "cus_live",
      items: {
        data: [{ id: "si_123" }],
      },
    });
    const mockUpdateSubscription = jest.fn().mockResolvedValue({ id: "sub_123" });

    (supabaseAdmin!.from as jest.Mock)
      .mockImplementationOnce(() => selectBuilder)
      .mockImplementationOnce(() => updateBuilder);
    (validateOrRecreateStripeCustomer as jest.Mock).mockResolvedValue({
      customerId: "cus_live",
      wasRecreated: false,
    });
    (getStripe as jest.Mock).mockReturnValue({
      subscriptions: {
        retrieve: mockRetrieve,
        update: mockUpdateSubscription,
      },
    });

    const res = await POST(createRequest({ newPlan: "fleet" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.message).toBe(
      "Successfully upgraded to Power. Prorated charge applied."
    );
    expect(validateOrRecreateStripeCustomer).toHaveBeenCalledWith({
      customerId: "cus_live",
      clerkUserId: mockUserId,
      email: "test@example.com",
      name: "Test User",
    });
    expect(mockRetrieve).toHaveBeenCalledWith("sub_123");
    expect(mockUpdateSubscription).toHaveBeenCalledWith(
      "sub_123",
      expect.objectContaining({
        items: [
          {
            id: "si_123",
            price: "price_fleet_test",
          },
        ],
        proration_behavior: "create_prorations",
        metadata: expect.objectContaining({
          user_id: mockUserId,
          plan: "fleet",
          previous_plan: "operator",
        }),
      })
    );
  });

  it("does NOT stamp upgraded_at on a paid→paid plan change (write-once conversion stamp)", async () => {
    // upgraded_at marks the FIRST free→paid transition only. A paid→paid
    // upgrade must omit the stamp keys entirely so the original conversion
    // timestamp can never move.
    const selectBuilder = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          plan: "operator",
          status: "active",
          stripe_subscription_id: "sub_123",
          stripe_customer_id: "cus_live",
          total_cpu_budget: 2,
          total_ram_budget: 4096,
          instance_limit: 999,
        },
        error: null,
      }),
    };
    const updateBuilder = {
      update: jest.fn().mockReturnThis(),
      eq: jest.fn().mockResolvedValue({ error: null }),
    };

    (supabaseAdmin!.from as jest.Mock)
      .mockImplementationOnce(() => selectBuilder)
      .mockImplementationOnce(() => updateBuilder);
    (validateOrRecreateStripeCustomer as jest.Mock).mockResolvedValue({
      customerId: "cus_live",
      wasRecreated: false,
    });
    (getStripe as jest.Mock).mockReturnValue({
      subscriptions: {
        retrieve: jest.fn().mockResolvedValue({
          customer: "cus_live",
          items: { data: [{ id: "si_123" }] },
        }),
        update: jest.fn().mockResolvedValue({ id: "sub_123" }),
      },
    });

    const res = await POST(createRequest({ newPlan: "fleet" }));
    expect(res.status).toBe(200);

    expect(updateBuilder.update).toHaveBeenCalledTimes(1);
    const updatePayload = updateBuilder.update.mock.calls[0][0];
    expect(updatePayload).toMatchObject({ plan: "fleet" });
    expect(updatePayload).not.toHaveProperty("upgraded_at");
    expect(updatePayload).not.toHaveProperty("upgrade_source");
  });

  it("hides unexpected plan-change errors from the client and logs", async () => {
    (auth as unknown as jest.Mock).mockRejectedValueOnce(new Error("change-plan-secret"));

    const res = await POST(createRequest({ newPlan: "fleet" }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Failed to change plan. Please try again.");
    expect(body.error).not.toContain("change-plan-secret");
    expect(consoleErrorSpy.mock.calls.flat().join(" ")).not.toContain("change-plan-secret");
  });

  it("does not leak raw Stripe plan-change errors", async () => {
    const selectBuilder = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          plan: "operator",
          status: "active",
          stripe_subscription_id: "sub_123",
          stripe_customer_id: "cus_live",
          total_cpu_budget: 2,
          total_ram_budget: 4096,
          instance_limit: 999,
        },
        error: null,
      }),
    };

    (supabaseAdmin!.from as jest.Mock).mockImplementationOnce(() => selectBuilder);
    (validateOrRecreateStripeCustomer as jest.Mock).mockResolvedValue({
      customerId: "cus_live",
      wasRecreated: false,
    });

    const stripeError = Object.assign(Object.create(Stripe.errors.StripeError.prototype), {
      message: "stripe-secret-leak",
      type: "StripeInvalidRequestError",
    });
    const mockRetrieve = jest.fn().mockRejectedValue(stripeError);

    (getStripe as jest.Mock).mockReturnValue({
      subscriptions: {
        retrieve: mockRetrieve,
        update: jest.fn(),
      },
    });

    const res = await POST(createRequest({ newPlan: "fleet" }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Unable to update Stripe billing for the plan change. Please try again.");
    expect(body.error).not.toContain("stripe-secret-leak");
    expect(consoleErrorSpy.mock.calls.flat().join(" ")).not.toContain("stripe-secret-leak");
  });

  it("refuses to bump the local plan when the Stripe customer was recreated", async () => {
    // If validateOrRecreateStripeCustomer returns wasRecreated=true OR a
    // different customerId, the stored stripe_subscription_id no longer
    // belongs to the validated customer — calling subscriptions.update
    // would either fail or silently mutate someone else's subscription
    // while our local DB optimistically grants the new plan's resources.
    // Lock that off with a 409.
    const selectBuilder = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          plan: "operator",
          status: "active",
          stripe_subscription_id: "sub_old",
          stripe_customer_id: "cus_old",
          total_cpu_budget: 2,
          total_ram_budget: 4096,
          instance_limit: 999,
        },
        error: null,
      }),
    };
    const updateBuilder = {
      update: jest.fn().mockReturnThis(),
      eq: jest.fn().mockResolvedValue({ error: null }),
    };
    const mockUpdateSubscription = jest.fn();

    (supabaseAdmin!.from as jest.Mock)
      .mockImplementationOnce(() => selectBuilder)
      .mockImplementationOnce(() => updateBuilder);
    (validateOrRecreateStripeCustomer as jest.Mock).mockResolvedValue({
      customerId: "cus_new",
      wasRecreated: true,
    });
    (getStripe as jest.Mock).mockReturnValue({
      subscriptions: {
        retrieve: jest.fn(),
        update: mockUpdateSubscription,
      },
    });

    const res = await POST(createRequest({ newPlan: "fleet" }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toMatch(/re-link|cancel and re-subscribe/i);
    // Critical: must NOT have called Stripe.subscriptions.update or the
    // optimistic local DB update.
    expect(mockUpdateSubscription).not.toHaveBeenCalled();
    expect(updateBuilder.update).not.toHaveBeenCalled();
  });

  it("refuses to update a Stripe subscription that belongs to a different customer", async () => {
    const selectBuilder = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          plan: "operator",
          status: "active",
          stripe_subscription_id: "sub_other_customer",
          stripe_customer_id: "cus_live",
          total_cpu_budget: 2,
          total_ram_budget: 4096,
          instance_limit: 999,
        },
        error: null,
      }),
    };
    const updateBuilder = {
      update: jest.fn().mockReturnThis(),
      eq: jest.fn().mockResolvedValue({ error: null }),
    };
    const mockUpdateSubscription = jest.fn();

    (supabaseAdmin!.from as jest.Mock)
      .mockImplementationOnce(() => selectBuilder)
      .mockImplementationOnce(() => updateBuilder);
    (validateOrRecreateStripeCustomer as jest.Mock).mockResolvedValue({
      customerId: "cus_live",
      wasRecreated: false,
    });
    (getStripe as jest.Mock).mockReturnValue({
      subscriptions: {
        retrieve: jest.fn().mockResolvedValue({
          customer: "cus_attacker",
          items: { data: [{ id: "si_123" }] },
        }),
        update: mockUpdateSubscription,
      },
    });

    const res = await POST(createRequest({ newPlan: "fleet" }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toMatch(/not linked|re-subscribe/i);
    expect(mockUpdateSubscription).not.toHaveBeenCalled();
    expect(updateBuilder.update).not.toHaveBeenCalled();
  });

  // ── Self-serve downgrade (Batch 6) ────────────────────────────────────────

  /**
   * Build the standard select+update supabase builders + a Stripe stub for a
   * downgrade from `fromPlan` → target. Returns the spies so each test can
   * assert on the exact Stripe `subscriptions.update` call.
   */
  function setupDowngradeMocks(fromPlan: string) {
    const selectBuilder = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          plan: fromPlan,
          status: "active",
          stripe_subscription_id: "sub_123",
          stripe_customer_id: "cus_live",
          total_cpu_budget: 4,
          total_ram_budget: 8192,
          instance_limit: 999,
        },
        error: null,
      }),
    };
    const updateBuilder = {
      update: jest.fn().mockReturnThis(),
      eq: jest.fn().mockResolvedValue({ error: null }),
    };
    const mockRetrieve = jest.fn().mockResolvedValue({
      customer: "cus_live",
      items: { data: [{ id: "si_123" }] },
    });
    const mockUpdateSubscription = jest.fn().mockResolvedValue({ id: "sub_123" });

    (supabaseAdmin!.from as jest.Mock)
      .mockImplementationOnce(() => selectBuilder)
      .mockImplementationOnce(() => updateBuilder);
    (validateOrRecreateStripeCustomer as jest.Mock).mockResolvedValue({
      customerId: "cus_live",
      wasRecreated: false,
    });
    (getStripe as jest.Mock).mockReturnValue({
      subscriptions: {
        retrieve: mockRetrieve,
        update: mockUpdateSubscription,
      },
    });

    return { selectBuilder, updateBuilder, mockRetrieve, mockUpdateSubscription };
  }

  it("returns the verbatim downgrade-unavailable rejection when the flag is OFF", async () => {
    // Flag defaults OFF in beforeEach.
    const selectBuilder = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          plan: "fleet",
          status: "active",
          stripe_subscription_id: "sub_123",
          stripe_customer_id: "cus_live",
          total_cpu_budget: 4,
          total_ram_budget: 8192,
          instance_limit: 999,
        },
        error: null,
      }),
    };
    (supabaseAdmin!.from as jest.Mock).mockImplementationOnce(() => selectBuilder);

    const res = await POST(createRequest({ newPlan: "operator" }));
    const body = await res.json();

    expect(res.status).toBe(403);
    // Must be byte-for-byte the historical message.
    expect(body.error).toBe(
      "Plan downgrades are not available due to dedicated server infrastructure. " +
        "You can upgrade your plan anytime. To switch to a lower tier, cancel your " +
        "subscription and re-subscribe — note this will remove your current server."
    );
    // Flag off short-circuits before touching Stripe or the tier apply.
    expect(validateOrRecreateStripeCustomer).not.toHaveBeenCalled();
    expect(getStripe).not.toHaveBeenCalled();
    expect(applyTierChange).not.toHaveBeenCalled();
  });

  it("allows a paid→lower-paid downgrade with create_prorations when the flag is ON", async () => {
    process.env.HERMES_SELF_SERVE_DOWNGRADE_ENABLED = "true";
    const { mockUpdateSubscription, updateBuilder } = setupDowngradeMocks("fleet");

    const res = await POST(createRequest({ newPlan: "operator" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.direction).toBe("downgraded");
    expect(body.data.previousPlan).toBe("fleet");
    expect(body.data.newPlan).toBe("operator");
    // Customer-facing proration credit language.
    expect(body.data.message).toMatch(/account credit for the unused time/i);

    // The Stripe subscription is moved to the target price with PRORATION CREDIT.
    expect(mockUpdateSubscription).toHaveBeenCalledWith(
      "sub_123",
      expect.objectContaining({
        items: [{ id: "si_123", price: "price_operator_test" }],
        proration_behavior: "create_prorations",
        metadata: expect.objectContaining({
          plan: "operator",
          previous_plan: "fleet",
        }),
      })
    );

    // Optimistic DB update lands the lower plan + caps.
    expect(updateBuilder.update).toHaveBeenCalledWith(
      expect.objectContaining({ plan: "operator" })
    );
  });

  it("calls applyTierChange inline (idempotent) so the VM resizes down immediately", async () => {
    process.env.HERMES_SELF_SERVE_DOWNGRADE_ENABLED = "true";
    setupDowngradeMocks("fleet");

    const res = await POST(createRequest({ newPlan: "operator" }));
    expect(res.status).toBe(200);

    expect(applyTierChange).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: mockUserId,
        newTier: "operator",
      })
    );
  });

  it("reports a downgrade ops event for canary review", async () => {
    process.env.HERMES_SELF_SERVE_DOWNGRADE_ENABLED = "true";
    setupDowngradeMocks("command");

    const res = await POST(createRequest({ newPlan: "fleet" }));
    expect(res.status).toBe(200);

    expect(reportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "billing-change-plan",
        title: "Self-serve plan downgrade",
        metadata: expect.objectContaining({
          previousPlan: "command",
          newPlan: "fleet",
          prorationBehavior: "create_prorations",
        }),
      })
    );
  });

  it("succeeds even if the inline applyTierChange throws (non-fatal resize)", async () => {
    process.env.HERMES_SELF_SERVE_DOWNGRADE_ENABLED = "true";
    const { mockUpdateSubscription } = setupDowngradeMocks("fleet");
    (applyTierChange as jest.Mock).mockRejectedValueOnce(new Error("ssh timeout"));

    const res = await POST(createRequest({ newPlan: "operator" }));
    const body = await res.json();

    // Stripe + DB are the source of truth; a resize hiccup must not 500.
    expect(res.status).toBe(200);
    expect(body.data.direction).toBe("downgraded");
    expect(mockUpdateSubscription).toHaveBeenCalled();
  });

  it("does NOT downgrade an upgrade request even when the flag is ON", async () => {
    // operator → fleet is an upgrade; the downgrade gate must not intercept it.
    process.env.HERMES_SELF_SERVE_DOWNGRADE_ENABLED = "true";
    const { mockUpdateSubscription } = setupDowngradeMocks("operator");

    const res = await POST(createRequest({ newPlan: "fleet" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.direction).toBe("upgraded");
    expect(body.data.message).toMatch(/upgraded to/i);
    expect(mockUpdateSubscription).toHaveBeenCalledWith(
      "sub_123",
      expect.objectContaining({ proration_behavior: "create_prorations" })
    );
    // No downgrade ops event on an upgrade.
    expect(reportOpsEvent).not.toHaveBeenCalled();
  });
});
