import { NextRequest } from "next/server";
import Stripe from "stripe";
import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getStripe } from "@/lib/stripe";
import { StripeWebhookService } from "@/lib/services/stripe-webhook-service";
import { POST } from "../route";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/stripe", () => ({
  getStripe: jest.fn(),
}));

jest.mock("@/lib/services/stripe-webhook-service", () => ({
  StripeWebhookService: {
    handleSubscriptionChange: jest.fn(),
    captureCheckoutPaymentCompleted: jest.fn(),
  },
}));

describe("POST /api/billing/confirm-checkout", () => {
  const mockUserId = "user_123";

  let mockSupabaseQuery: Record<string, jest.Mock>;
  let mockSessionsRetrieve: jest.Mock;
  let mockSubscriptionsRetrieve: jest.Mock;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    (auth as unknown as jest.Mock).mockResolvedValue({ userId: mockUserId });

    mockSupabaseQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn(),
      // Replay-protection insert into stripe_checkout_session_activations.
      // Defaults to "first activation succeeds"; tests for the duplicate
      // path override this to return a 23505.
      insert: jest.fn().mockResolvedValue({ error: null }),
      // Guard release on activation failure: .delete().eq(...) resolves.
      delete: jest.fn().mockReturnThis(),
    };
    mockSupabaseQuery.eq = jest.fn().mockReturnValue(mockSupabaseQuery);

    (supabaseAdmin!.from as jest.Mock).mockReturnValue(mockSupabaseQuery);

    mockSessionsRetrieve = jest.fn();
    mockSubscriptionsRetrieve = jest.fn();

    (getStripe as jest.Mock).mockReturnValue({
      checkout: {
        sessions: {
          retrieve: mockSessionsRetrieve,
        },
      },
      subscriptions: {
        retrieve: mockSubscriptionsRetrieve,
      },
    });
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  function createRequest(body: Record<string, unknown>) {
    return new NextRequest("http://localhost/api/billing/confirm-checkout", {
      method: "POST",
      body: JSON.stringify(body),
      headers: new Headers({ "Content-Type": "application/json" }),
    });
  }

  function getConsoleOutput() {
    return JSON.stringify(consoleErrorSpy.mock.calls);
  }

  it("returns 401 when unauthorized", async () => {
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: null });

    const res = await POST(createRequest({ sessionId: "cs_test_123" }));
    expect(res.status).toBe(401);
  });

  it("activates a checkout session with no_payment_required", async () => {
    const mockSubscription = {
      id: "sub_123",
      metadata: { plan: "operator", user_id: mockUserId },
    };

    mockSessionsRetrieve.mockResolvedValue({
      id: "cs_test_123",
      mode: "subscription",
      payment_status: "no_payment_required",
      customer: "cus_123",
      subscription: mockSubscription,
    });

    mockSupabaseQuery.maybeSingle.mockResolvedValue({
      data: { stripe_customer_id: "cus_123" },
      error: null,
    });

    (StripeWebhookService.handleSubscriptionChange as jest.Mock).mockResolvedValue(undefined);

    const res = await POST(createRequest({ sessionId: "cs_test_123" }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toEqual({ activated: true, plan: "operator" });
    // Conversion stamp threading: the confirm-checkout path must identify
    // itself so upgrade_source lands as "confirm_checkout".
    expect(StripeWebhookService.handleSubscriptionChange).toHaveBeenCalledWith(
      mockSubscription,
      { source: "confirm_checkout" }
    );
    expect(StripeWebhookService.captureCheckoutPaymentCompleted).toHaveBeenCalledWith({
      session: expect.objectContaining({
        id: "cs_test_123",
        payment_status: "no_payment_required",
      }),
      subscription: mockSubscription,
      source: "confirm_checkout",
    });
  });

  it("rejects a session that belongs to a different Stripe customer", async () => {
    mockSessionsRetrieve.mockResolvedValue({
      id: "cs_test_123",
      mode: "subscription",
      payment_status: "paid",
      customer: "cus_other",
      subscription: {
        id: "sub_123",
        metadata: { plan: "operator", user_id: mockUserId },
      },
    });

    mockSupabaseQuery.maybeSingle.mockResolvedValue({
      data: { stripe_customer_id: "cus_123" },
      error: null,
    });

    const res = await POST(createRequest({ sessionId: "cs_test_123" }));
    expect(res.status).toBe(403);
    expect(StripeWebhookService.handleSubscriptionChange).not.toHaveBeenCalled();
  });

  it("does not leak raw Stripe retrieval failures", async () => {
    mockSessionsRetrieve.mockRejectedValueOnce(new Error("checkout-secret-leak"));

    const res = await POST(createRequest({ sessionId: "cs_test_123" }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("Could not retrieve checkout session");
    expect(body.error).not.toContain("checkout-secret-leak");
    expect(getConsoleOutput()).not.toContain("checkout-secret-leak");
  });

  it("short-circuits on a replayed checkout session WITHOUT re-running handleSubscriptionChange", async () => {
    // Bookmarked / replayed `?session_id=cs_…` URL: same session, same
    // user, second time. The unique PK on
    // stripe_checkout_session_activations.stripe_session_id makes the
    // second insert fail with 23505 — the route must short-circuit and
    // NOT re-fire the webhook handler (which credits, fires posthog,
    // etc.).
    const mockSubscription = {
      id: "sub_123",
      metadata: { plan: "operator", user_id: mockUserId },
    };

    mockSessionsRetrieve.mockResolvedValue({
      id: "cs_replay",
      mode: "subscription",
      payment_status: "paid",
      customer: "cus_123",
      subscription: mockSubscription,
    });

    mockSupabaseQuery.maybeSingle.mockResolvedValue({
      data: { stripe_customer_id: "cus_123" },
      error: null,
    });

    // Second insert hits the unique-PK violation.
    mockSupabaseQuery.insert.mockResolvedValueOnce({
      error: { code: "23505", message: "duplicate key value violates unique constraint" },
    });

    const res = await POST(createRequest({ sessionId: "cs_replay" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({
      activated: true,
      alreadyActivated: true,
      plan: "operator",
    });
    // Critical: handleSubscriptionChange must NOT have been re-invoked.
    expect(StripeWebhookService.handleSubscriptionChange).not.toHaveBeenCalled();
    expect(StripeWebhookService.captureCheckoutPaymentCompleted).not.toHaveBeenCalled();
  });

  it("does not leak raw Stripe subscription confirmation failures", async () => {
    mockSessionsRetrieve.mockResolvedValue({
      id: "cs_test_123",
      mode: "subscription",
      payment_status: "paid",
      customer: "cus_123",
      subscription: "sub_123",
    });

    mockSupabaseQuery.maybeSingle.mockResolvedValue({
      data: { stripe_customer_id: "cus_123" },
      error: null,
    });

    const stripeError = Object.assign(Object.create(Stripe.errors.StripeError.prototype), {
      message: "confirm-checkout-secret",
      type: "StripeInvalidRequestError",
      code: "resource_missing",
    });
    mockSubscriptionsRetrieve.mockRejectedValueOnce(stripeError);

    const res = await POST(createRequest({ sessionId: "cs_test_123" }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Failed to confirm checkout");
    expect(JSON.stringify(body)).not.toContain("confirm-checkout-secret");
    expect(getConsoleOutput()).not.toContain("confirm-checkout-secret");
  });

  it("releases the replay guard when activation fails, so a retry can re-run", async () => {
    const mockSubscription = {
      id: "sub_123",
      metadata: { plan: "operator", user_id: mockUserId },
    };
    mockSessionsRetrieve.mockResolvedValue({
      id: "cs_test_123",
      mode: "subscription",
      payment_status: "paid",
      customer: "cus_123",
      subscription: mockSubscription,
    });
    mockSupabaseQuery.maybeSingle.mockResolvedValue({
      data: { stripe_customer_id: "cus_123" },
      error: null,
    });
    // First activation claims the guard (insert succeeds) then the side-effect
    // handler throws — the guard MUST be released so a retry isn't permanently
    // short-circuited as "alreadyActivated".
    (StripeWebhookService.handleSubscriptionChange as jest.Mock).mockRejectedValueOnce(
      new Error("activation blew up")
    );

    const res = await POST(createRequest({ sessionId: "cs_test_123" }));

    expect(res.status).toBe(500);
    // The activation guard row was deleted (released) for this session.
    expect(mockSupabaseQuery.delete).toHaveBeenCalledTimes(1);
    expect(mockSupabaseQuery.eq).toHaveBeenCalledWith("stripe_session_id", "cs_test_123");
  });
});
