import { NextRequest } from "next/server";

describe("POST /api/webhooks/stripe", () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetModules();
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    delete process.env.STRIPE_WEBHOOK_SECRET;
  });

  function getConsoleOutput() {
    return JSON.stringify(consoleErrorSpy.mock.calls);
  }

  function createRequest(body = "{}") {
    return new NextRequest("http://localhost/api/webhooks/stripe", {
      method: "POST",
      body,
      headers: new Headers({ "stripe-signature": "sig_test" }),
    });
  }

  it("dispatches checkout.session.completed events and marks them processed", async () => {
    const constructEvent = jest.fn().mockReturnValue({
      id: "evt_123",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_123",
          mode: "subscription",
          payment_status: "no_payment_required",
        },
      },
    });
    const handleCheckoutCompleted = jest.fn().mockResolvedValue(undefined);
    const beginStripeWebhookEvent = jest.fn().mockResolvedValue("reserved");
    const markProcessed = jest.fn().mockResolvedValue(undefined);
    const markFailed = jest.fn().mockResolvedValue(undefined);

    jest.doMock("@/lib/stripe", () => ({
      getStripe: jest.fn(() => ({
        webhooks: {
          constructEvent,
        },
      })),
    }));
    jest.doMock("@/lib/rate-limit", () => ({
      enforceRateLimit: jest.fn(() => ({ success: true })),
      getIP: jest.fn(() => "127.0.0.1"),
    }));
    jest.doMock("@/lib/services/stripe-webhook-service", () => ({
      StripeWebhookService: {
        handleCheckoutCompleted,
        handleSubscriptionChange: jest.fn(),
        handleSubscriptionDeleted: jest.fn(),
        handleInvoicePaid: jest.fn(),
        handlePaymentFailed: jest.fn(),
      },
    }));
    jest.doMock("@/lib/stripe-webhook-events", () => ({
      beginStripeWebhookEvent,
      markStripeWebhookEventProcessed: markProcessed,
      markStripeWebhookEventFailed: markFailed,
    }));

    const { POST } = await import("../route");

    const res = await POST(createRequest());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(handleCheckoutCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ id: "cs_123" })
    );
    expect(markProcessed).toHaveBeenCalledWith("evt_123");
    expect(markFailed).not.toHaveBeenCalled();
  });

  it("dispatches async checkout payment succeeded events for delayed payment methods", async () => {
    const constructEvent = jest.fn().mockReturnValue({
      id: "evt_async_123",
      type: "checkout.session.async_payment_succeeded",
      data: {
        object: {
          id: "cs_async_123",
          mode: "payment",
          payment_status: "paid",
        },
      },
    });
    const handleCheckoutCompleted = jest.fn().mockResolvedValue(undefined);
    const markProcessed = jest.fn().mockResolvedValue(undefined);

    jest.doMock("@/lib/stripe", () => ({
      getStripe: jest.fn(() => ({
        webhooks: {
          constructEvent,
        },
      })),
    }));
    jest.doMock("@/lib/rate-limit", () => ({
      enforceRateLimit: jest.fn(() => ({ success: true })),
      getIP: jest.fn(() => "127.0.0.1"),
    }));
    jest.doMock("@/lib/services/stripe-webhook-service", () => ({
      StripeWebhookService: {
        handleCheckoutCompleted,
        handleSubscriptionChange: jest.fn(),
        handleSubscriptionDeleted: jest.fn(),
        handleInvoicePaid: jest.fn(),
        handlePaymentFailed: jest.fn(),
      },
    }));
    jest.doMock("@/lib/stripe-webhook-events", () => ({
      beginStripeWebhookEvent: jest.fn().mockResolvedValue("reserved"),
      markStripeWebhookEventProcessed: markProcessed,
      markStripeWebhookEventFailed: jest.fn(),
    }));

    const { POST } = await import("../route");

    const res = await POST(createRequest());

    expect(res.status).toBe(200);
    expect(handleCheckoutCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ id: "cs_async_123" })
    );
    expect(markProcessed).toHaveBeenCalledWith("evt_async_123");
  });

  it("returns duplicate success for already-reserved webhook events", async () => {
    const constructEvent = jest.fn().mockReturnValue({
      id: "evt_123",
      type: "checkout.session.completed",
      data: { object: { id: "cs_123" } },
    });
    const handleCheckoutCompleted = jest.fn().mockResolvedValue(undefined);

    jest.doMock("@/lib/stripe", () => ({
      getStripe: jest.fn(() => ({
        webhooks: {
          constructEvent,
        },
      })),
    }));
    jest.doMock("@/lib/rate-limit", () => ({
      enforceRateLimit: jest.fn(() => ({ success: true })),
      getIP: jest.fn(() => "127.0.0.1"),
    }));
    jest.doMock("@/lib/services/stripe-webhook-service", () => ({
      StripeWebhookService: {
        handleCheckoutCompleted,
        handleSubscriptionChange: jest.fn(),
        handleSubscriptionDeleted: jest.fn(),
        handleInvoicePaid: jest.fn(),
        handlePaymentFailed: jest.fn(),
      },
    }));
    jest.doMock("@/lib/stripe-webhook-events", () => ({
      beginStripeWebhookEvent: jest.fn().mockResolvedValue("duplicate"),
      markStripeWebhookEventProcessed: jest.fn(),
      markStripeWebhookEventFailed: jest.fn(),
    }));

    const { POST } = await import("../route");

    const res = await POST(createRequest());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toEqual({ received: true, duplicate: true });
    expect(handleCheckoutCompleted).not.toHaveBeenCalled();
  });

  it("refuses to process when idempotency is untracked in production", async () => {
    // Regression guard: previously the route processed events even when
    // beginStripeWebhookEvent returned "untracked" (missing supabase env
    // or missing table). Stripe redelivers any non-2xx response, so
    // every retry would double-grant credits, double-fire posthog, etc.
    // In production we must fail closed.
    const previousNodeEnv = process.env.NODE_ENV;
    Object.defineProperty(process.env, "NODE_ENV", { value: "production", configurable: true });
    try {
      const constructEvent = jest.fn().mockReturnValue({
        id: "evt_untracked_456",
        type: "checkout.session.completed",
        data: { object: { id: "cs_456", mode: "subscription", payment_status: "paid" } },
      });
      const handleCheckoutCompleted = jest.fn().mockResolvedValue(undefined);

      jest.doMock("@/lib/stripe", () => ({
        getStripe: jest.fn(() => ({ webhooks: { constructEvent } })),
      }));
      jest.doMock("@/lib/rate-limit", () => ({
        enforceRateLimit: jest.fn(() => ({ success: true })),
        getIP: jest.fn(() => "127.0.0.1"),
      }));
      jest.doMock("@/lib/services/stripe-webhook-service", () => ({
        StripeWebhookService: {
          handleCheckoutCompleted,
          handleSubscriptionChange: jest.fn(),
          handleSubscriptionDeleted: jest.fn(),
          handleInvoicePaid: jest.fn(),
          handlePaymentFailed: jest.fn(),
        },
      }));
      jest.doMock("@/lib/stripe-webhook-events", () => ({
        beginStripeWebhookEvent: jest.fn().mockResolvedValue("untracked"),
        markStripeWebhookEventProcessed: jest.fn(),
        markStripeWebhookEventFailed: jest.fn(),
      }));

      const { POST } = await import("../route");
      const res = await POST(createRequest());
      expect(res.status).toBe(503);
      expect(handleCheckoutCompleted).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process.env, "NODE_ENV", { value: previousNodeEnv, configurable: true });
    }
  });

  it("does not leak signature verification errors to the client or logs", async () => {
    const constructEvent = jest.fn(() => {
      throw new Error("webhook-signature-secret-leak");
    });

    jest.doMock("@/lib/stripe", () => ({
      getStripe: jest.fn(() => ({
        webhooks: {
          constructEvent,
        },
      })),
    }));
    jest.doMock("@/lib/rate-limit", () => ({
      enforceRateLimit: jest.fn(() => ({ success: true })),
      getIP: jest.fn(() => "127.0.0.1"),
    }));
    jest.doMock("@/lib/services/stripe-webhook-service", () => ({
      StripeWebhookService: {
        handleCheckoutCompleted: jest.fn(),
        handleSubscriptionChange: jest.fn(),
        handleSubscriptionDeleted: jest.fn(),
        handleInvoicePaid: jest.fn(),
        handlePaymentFailed: jest.fn(),
      },
    }));
    jest.doMock("@/lib/stripe-webhook-events", () => ({
      beginStripeWebhookEvent: jest.fn(),
      markStripeWebhookEventProcessed: jest.fn(),
      markStripeWebhookEventFailed: jest.fn(),
    }));

    const { POST } = await import("../route");

    const res = await POST(createRequest());
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Invalid signature");
    expect(body.error).not.toContain("webhook-signature-secret-leak");
    expect(getConsoleOutput()).not.toContain("webhook-signature-secret-leak");
  });

  it("does not leak unexpected webhook handler errors to the client or logs", async () => {
    const constructEvent = jest.fn().mockReturnValue({
      id: "evt_123",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_123",
          mode: "subscription",
          payment_status: "no_payment_required",
        },
      },
    });
    const handleCheckoutCompleted = jest.fn().mockRejectedValue(new Error("webhook-handler-secret-leak"));
    const markFailed = jest.fn().mockResolvedValue(undefined);

    jest.doMock("@/lib/stripe", () => ({
      getStripe: jest.fn(() => ({
        webhooks: {
          constructEvent,
        },
      })),
    }));
    jest.doMock("@/lib/rate-limit", () => ({
      enforceRateLimit: jest.fn(() => ({ success: true })),
      getIP: jest.fn(() => "127.0.0.1"),
    }));
    jest.doMock("@/lib/services/stripe-webhook-service", () => ({
      StripeWebhookService: {
        handleCheckoutCompleted,
        handleSubscriptionChange: jest.fn(),
        handleSubscriptionDeleted: jest.fn(),
        handleInvoicePaid: jest.fn(),
        handlePaymentFailed: jest.fn(),
      },
    }));
    jest.doMock("@/lib/stripe-webhook-events", () => ({
      beginStripeWebhookEvent: jest.fn().mockResolvedValue("reserved"),
      markStripeWebhookEventProcessed: jest.fn(),
      markStripeWebhookEventFailed: markFailed,
    }));

    const { POST } = await import("../route");

    const res = await POST(createRequest());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Webhook handler failed");
    expect(body.error).not.toContain("webhook-handler-secret-leak");
    expect(markFailed).toHaveBeenCalled();
    expect(getConsoleOutput()).not.toContain("webhook-handler-secret-leak");
  });

  describe("setup_intent.succeeded — card-on-file gate", () => {
    type CardFunding = "credit" | "debit" | "prepaid" | "unknown";

    function mountSetupIntentMocks(opts: {
      paymentMethod: {
        id: string;
        card: { fingerprint: string | null; funding: CardFunding } | null;
      };
      collidingUserId?: string | null;
    }) {
      const constructEvent = jest.fn().mockReturnValue({
        id: "evt_si_123",
        type: "setup_intent.succeeded",
        data: {
          object: {
            id: "seti_123",
            payment_method: opts.paymentMethod.id,
            metadata: { clerk_user_id: "user_abc" },
          },
        },
      });
      const paymentMethodsRetrieve = jest
        .fn()
        .mockResolvedValue(opts.paymentMethod);
      const markCardOnFile = jest.fn().mockResolvedValue(undefined);
      const markCardRejected = jest.fn().mockResolvedValue(undefined);
      const findOtherUserWithSatisfiedFingerprint = jest
        .fn()
        .mockResolvedValue(opts.collidingUserId ?? null);
      const markProcessed = jest.fn().mockResolvedValue(undefined);

      jest.doMock("@/lib/stripe", () => ({
        getStripe: jest.fn(() => ({
          webhooks: { constructEvent },
          paymentMethods: { retrieve: paymentMethodsRetrieve },
        })),
      }));
      jest.doMock("@/lib/rate-limit", () => ({
        enforceRateLimit: jest.fn(() => ({ success: true })),
        getIP: jest.fn(() => "127.0.0.1"),
      }));
      jest.doMock("@/lib/services/stripe-webhook-service", () => ({
        StripeWebhookService: {
          handleCheckoutCompleted: jest.fn(),
          handleSubscriptionChange: jest.fn(),
          handleSubscriptionDeleted: jest.fn(),
          handleInvoicePaid: jest.fn(),
          handlePaymentFailed: jest.fn(),
        },
      }));
      jest.doMock("@/lib/stripe-webhook-events", () => ({
        beginStripeWebhookEvent: jest.fn().mockResolvedValue("reserved"),
        markStripeWebhookEventProcessed: markProcessed,
        markStripeWebhookEventFailed: jest.fn(),
      }));
      jest.doMock("@/lib/abuse/repository", () => ({
        markCardOnFile,
        markCardRejected,
        findOtherUserWithSatisfiedFingerprint,
      }));

      return {
        markCardOnFile,
        markCardRejected,
        findOtherUserWithSatisfiedFingerprint,
        paymentMethodsRetrieve,
        markProcessed,
      };
    }

    it("marks card-on-file with fingerprint + funding for a normal credit card", async () => {
      const mocks = mountSetupIntentMocks({
        paymentMethod: {
          id: "pm_credit",
          card: { fingerprint: "fp_credit_abc", funding: "credit" },
        },
      });

      const { POST } = await import("../route");
      const res = await POST(createRequest());

      expect(res.status).toBe(200);
      expect(mocks.paymentMethodsRetrieve).toHaveBeenCalledWith("pm_credit");
      expect(mocks.markCardOnFile).toHaveBeenCalledWith({
        userId: "user_abc",
        setupIntentId: "seti_123",
        paymentMethodId: "pm_credit",
        cardFingerprint: "fp_credit_abc",
        cardFunding: "credit",
      });
      expect(mocks.markCardRejected).not.toHaveBeenCalled();
      expect(mocks.markProcessed).toHaveBeenCalledWith("evt_si_123");
    });

    it("rejects prepaid cards (Privacy.com / virtual cards) without satisfying", async () => {
      const mocks = mountSetupIntentMocks({
        paymentMethod: {
          id: "pm_prepaid",
          card: { fingerprint: "fp_prepaid_xyz", funding: "prepaid" },
        },
      });

      const { POST } = await import("../route");
      const res = await POST(createRequest());

      expect(res.status).toBe(200);
      expect(mocks.markCardRejected).toHaveBeenCalledWith({
        userId: "user_abc",
        setupIntentId: "seti_123",
        paymentMethodId: "pm_prepaid",
        cardFingerprint: "fp_prepaid_xyz",
        cardFunding: "prepaid",
        reason: "prepaid_card",
      });
      expect(mocks.markCardOnFile).not.toHaveBeenCalled();
      // Collision lookup is short-circuited by the prepaid check.
      expect(mocks.findOtherUserWithSatisfiedFingerprint).not.toHaveBeenCalled();
    });

    it("rejects fingerprint collisions when another user already cleared the gate", async () => {
      const mocks = mountSetupIntentMocks({
        paymentMethod: {
          id: "pm_dupe",
          card: { fingerprint: "fp_shared_999", funding: "credit" },
        },
        collidingUserId: "user_other",
      });

      const { POST } = await import("../route");
      const res = await POST(createRequest());

      expect(res.status).toBe(200);
      expect(mocks.findOtherUserWithSatisfiedFingerprint).toHaveBeenCalledWith(
        "fp_shared_999",
        "user_abc"
      );
      expect(mocks.markCardRejected).toHaveBeenCalledWith({
        userId: "user_abc",
        setupIntentId: "seti_123",
        paymentMethodId: "pm_dupe",
        cardFingerprint: "fp_shared_999",
        cardFunding: "credit",
        reason: "card_collision",
      });
      expect(mocks.markCardOnFile).not.toHaveBeenCalled();
    });

    it("fails CLOSED when paymentMethods.retrieve throws (Stripe will redeliver)", async () => {
      // Abuse-gate guarantee: if we can't read fingerprint/funding, we must
      // NOT mark card-on-file. Earlier "fail-open" admitted the user with
      // null dedup signals, which let an attacker who could force a
      // transient retrieve failure clear the gate without ever exposing a
      // fingerprint and repeat from each fresh account.
      const constructEvent = jest.fn().mockReturnValue({
        id: "evt_si_retrieve_fail",
        type: "setup_intent.succeeded",
        data: {
          object: {
            id: "seti_999",
            payment_method: "pm_unknown",
            metadata: { clerk_user_id: "user_xyz" },
          },
        },
      });
      const paymentMethodsRetrieve = jest
        .fn()
        .mockRejectedValue(new Error("network blip"));
      const markCardOnFile = jest.fn().mockResolvedValue(undefined);
      const markCardRejected = jest.fn().mockResolvedValue(undefined);
      const findOtherUserWithSatisfiedFingerprint = jest
        .fn()
        .mockResolvedValue(null);
      const markFailed = jest.fn().mockResolvedValue(undefined);

      jest.doMock("@/lib/stripe", () => ({
        getStripe: jest.fn(() => ({
          webhooks: { constructEvent },
          paymentMethods: { retrieve: paymentMethodsRetrieve },
        })),
      }));
      jest.doMock("@/lib/rate-limit", () => ({
        enforceRateLimit: jest.fn(() => ({ success: true })),
        getIP: jest.fn(() => "127.0.0.1"),
      }));
      jest.doMock("@/lib/services/stripe-webhook-service", () => ({
        StripeWebhookService: {
          handleCheckoutCompleted: jest.fn(),
          handleSubscriptionChange: jest.fn(),
          handleSubscriptionDeleted: jest.fn(),
          handleInvoicePaid: jest.fn(),
          handlePaymentFailed: jest.fn(),
        },
      }));
      jest.doMock("@/lib/stripe-webhook-events", () => ({
        beginStripeWebhookEvent: jest.fn().mockResolvedValue("reserved"),
        markStripeWebhookEventProcessed: jest.fn(),
        markStripeWebhookEventFailed: markFailed,
      }));
      jest.doMock("@/lib/abuse/repository", () => ({
        markCardOnFile,
        markCardRejected,
        findOtherUserWithSatisfiedFingerprint,
      }));

      const { POST } = await import("../route");
      const res = await POST(createRequest());

      // 500 → Stripe will redeliver the webhook on its retry schedule.
      expect(res.status).toBe(500);
      expect(markCardOnFile).not.toHaveBeenCalled();
      expect(markCardRejected).not.toHaveBeenCalled();
      expect(markFailed).toHaveBeenCalled();
    });

    it("does not mark card-on-file when retrieve returns a card lacking fingerprint or funding", async () => {
      // Structurally incomplete response → no abuse-gate signal → don't
      // mark on file. Don't throw either (re-delivery won't change a
      // malformed response).
      const constructEvent = jest.fn().mockReturnValue({
        id: "evt_si_no_fingerprint",
        type: "setup_intent.succeeded",
        data: {
          object: {
            id: "seti_888",
            payment_method: "pm_partial",
            metadata: { clerk_user_id: "user_partial" },
          },
        },
      });
      const paymentMethodsRetrieve = jest.fn().mockResolvedValue({
        id: "pm_partial",
        card: { fingerprint: null, funding: null },
      });
      const markCardOnFile = jest.fn().mockResolvedValue(undefined);
      const markCardRejected = jest.fn().mockResolvedValue(undefined);
      const markProcessed = jest.fn().mockResolvedValue(undefined);

      jest.doMock("@/lib/stripe", () => ({
        getStripe: jest.fn(() => ({
          webhooks: { constructEvent },
          paymentMethods: { retrieve: paymentMethodsRetrieve },
        })),
      }));
      jest.doMock("@/lib/rate-limit", () => ({
        enforceRateLimit: jest.fn(() => ({ success: true })),
        getIP: jest.fn(() => "127.0.0.1"),
      }));
      jest.doMock("@/lib/services/stripe-webhook-service", () => ({
        StripeWebhookService: {
          handleCheckoutCompleted: jest.fn(),
          handleSubscriptionChange: jest.fn(),
          handleSubscriptionDeleted: jest.fn(),
          handleInvoicePaid: jest.fn(),
          handlePaymentFailed: jest.fn(),
        },
      }));
      jest.doMock("@/lib/stripe-webhook-events", () => ({
        beginStripeWebhookEvent: jest.fn().mockResolvedValue("reserved"),
        markStripeWebhookEventProcessed: markProcessed,
        markStripeWebhookEventFailed: jest.fn(),
      }));
      jest.doMock("@/lib/abuse/repository", () => ({
        markCardOnFile,
        markCardRejected,
        findOtherUserWithSatisfiedFingerprint: jest.fn(),
      }));

      const { POST } = await import("../route");
      const res = await POST(createRequest());

      // Returns 200 (event consumed) but the gate stays closed.
      expect(res.status).toBe(200);
      expect(markCardOnFile).not.toHaveBeenCalled();
      expect(markCardRejected).not.toHaveBeenCalled();
    });
  });
});
