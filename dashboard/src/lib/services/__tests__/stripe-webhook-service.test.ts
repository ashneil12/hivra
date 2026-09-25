import { StripeWebhookService } from "@/lib/services/stripe-webhook-service";
import Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { log } from "@/lib/logger";
import { PLANS } from "@/lib/subscription";

process.env.STRIPE_SECRET_KEY = 'sk_test_123';

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

jest.mock("stripe", () => {
  const MockStripe = jest.fn().mockImplementation(() => ({
    invoices: {
      retrieve: jest.fn().mockResolvedValue({}),
    },
    refunds: {
      create: jest.fn().mockResolvedValue({}),
    },
    subscriptions: {
      cancel: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      retrieve: jest.fn().mockResolvedValue({}),
      list: jest.fn().mockResolvedValue({ data: [] }),
    },
    customers: {
      retrieve: jest.fn().mockResolvedValue({}),
    }
  }));

  return Object.assign(MockStripe, {
    errors: {
      StripeError: class StripeError extends Error {},
    },
  });
});

jest.mock("@/lib/hetzner/client", () => ({
  changeServerType: jest.fn(),
  getServer: jest.fn(),
  shutdownServer: jest.fn(),
  powerOnServer: jest.fn(),
  waitForAction: jest.fn(),
}));

jest.mock("@/lib/posthog", () => ({
  posthogClient: {
    capture: jest.fn(),
    flush: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock("@/lib/billing/credits", () => ({
  grantStripeTopUpCredits: jest.fn().mockResolvedValue({ inserted: true, balance: 1000 }),
  grantSubscriptionCycleCredits: jest.fn().mockResolvedValue({ inserted: true, balance: 2090 }),
  isTopUpPackageCredits: jest.fn((credits: number) =>
    [500, 1000, 2500, 5000].includes(credits)
  ),
}));

jest.mock("@/lib/billing/managed-venice-wallets", () => ({
  grantManagedVeniceCardTopUpCredit: jest.fn().mockResolvedValue({
    card: { totalValueMicroUsd: 50_000_000, availableMicroUsd: 50_000_000 },
  }),
}));

jest.mock("@/lib/billing/dunning", () => ({
  maybeSendPaymentFailedRecoveryEmail: jest
    .fn()
    .mockResolvedValue({ sent: false, reason: "disabled" }),
}));

// The Stripe lapse paths ask whether another lane (Apple IAP, yearly
// $HermesOS, token holdings) still entitles the user. Default: none.
jest.mock("@/lib/billing/instance-entitlement", () => ({
  resolveEffectiveSubscription: jest.fn().mockResolvedValue(null),
}));

interface MockBuilder {
  select: jest.Mock;
  update: jest.Mock;
  upsert: jest.Mock;
  not: jest.Mock;
  eq: jest.Mock;
  neq: jest.Mock;
  in: jest.Mock;
  is: jest.Mock;
  single: jest.Mock;
  maybeSingle: jest.Mock;
  then: (resolve: (value: unknown) => void) => void;
}

const createMockBuilder = (): MockBuilder => {
  const builder: MockBuilder = {
    select: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    upsert: jest.fn().mockReturnThis(),
    not: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    neq: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(),
    is: jest.fn().mockReturnThis(),
    single: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockReturnThis(),
    then: (resolve: (value: unknown) => void) => resolve({ data: null, error: null }),
  };
  return builder;
};

// We will track the latest builder returned by from()
let latestBuilder: MockBuilder;

jest.mock("@/lib/supabase", () => {
  return {
    supabaseAdmin: {
      from: jest.fn(() => {
        latestBuilder = createMockBuilder();
        return latestBuilder;
      }),
    },
  };
});

// We have to require it AFTER mocking
import { supabaseAdmin } from "@/lib/supabase";
import {
  changeServerType,
  getServer,
  powerOnServer,
  shutdownServer,
  waitForAction,
} from "@/lib/hetzner/client";
import { posthogClient } from "@/lib/posthog";
import {
  grantStripeTopUpCredits,
  grantSubscriptionCycleCredits,
} from "@/lib/billing/credits";
import { grantManagedVeniceCardTopUpCredit } from "@/lib/billing/managed-venice-wallets";
import { maybeSendPaymentFailedRecoveryEmail } from "@/lib/billing/dunning";
import {
  resolveEffectiveSubscription,
  type EffectiveSubscription,
} from "@/lib/billing/instance-entitlement";

function createDeferredPromise<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function flushAsyncStart() {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function stringifyLoggerCalls(mock: jest.Mock): string {
  return JSON.stringify(mock.mock.calls);
}

describe("StripeWebhookService", () => {
  beforeEach(() => {
    jest.clearAllMocks();

    const stripe = getStripe();
    (stripe.subscriptions.retrieve as jest.Mock).mockResolvedValue({});
    (stripe.subscriptions.list as jest.Mock).mockResolvedValue({ data: [] });
    (stripe.subscriptions.cancel as jest.Mock).mockResolvedValue({});
    (stripe.invoices.retrieve as jest.Mock).mockResolvedValue({});
    (stripe.refunds.create as jest.Mock).mockResolvedValue({});
  });

  describe("handleCheckoutCompleted", () => {
    it("grants credits for paid Stripe top-up checkout sessions", async () => {
      await StripeWebhookService.handleCheckoutCompleted({
        id: "cs_topup_123",
        mode: "payment",
        payment_status: "paid",
        amount_total: 1000,
        payment_intent: "pi_123",
        metadata: {
          type: "credit_topup",
          user_id: "user_123",
          package_credits: "1000",
          package_usd: "10",
        },
      } as unknown as Stripe.Checkout.Session);

      expect(grantStripeTopUpCredits).toHaveBeenCalledWith({
        userId: "user_123",
        sessionId: "cs_topup_123",
        packageCredits: 1000,
        amountTotalCents: 1000,
        metadata: {
          paymentIntentId: "pi_123",
        },
      });
      expect(posthogClient.capture).toHaveBeenCalledWith(
        expect.objectContaining({
          distinctId: "user_123",
          event: "credit_topup_completed",
          properties: expect.objectContaining({
            session_id: "cs_topup_123",
            package_credits: 1000,
          }),
        })
      );
    });

    it("does not credit top-up sessions before payment settles", async () => {
      (log.warn as jest.Mock).mockClear();

      await StripeWebhookService.handleCheckoutCompleted({
        id: "cs_topup_123",
        mode: "payment",
        payment_status: "unpaid",
        amount_total: 1000,
        metadata: {
          type: "credit_topup",
          user_id: "user_123",
          package_credits: "1000",
        },
      } as unknown as Stripe.Checkout.Session);

      expect(grantStripeTopUpCredits).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith(
        "credit_topup checkout completed before payment settled",
        expect.objectContaining({
          source: "stripe-webhook-service",
          failureType: "credit_topup_unpaid_session",
          sessionId: "cs_topup_123",
          paymentStatus: "unpaid",
        })
      );
    });

    it("credits managed Venice card wallet for paid managed Venice checkout sessions", async () => {
      await StripeWebhookService.handleCheckoutCompleted({
        id: "cs_managed_venice_123",
        mode: "payment",
        payment_status: "paid",
        amount_total: 5000,
        payment_intent: "pi_managed_venice",
        metadata: {
          type: "managed_venice_card_topup",
          user_id: "user_123",
          paid_micro_usd: "50000000",
          credit_micro_usd: "50000000",
        },
      } as unknown as Stripe.Checkout.Session);

      expect(grantManagedVeniceCardTopUpCredit).toHaveBeenCalledWith({
        userId: "user_123",
        sessionId: "cs_managed_venice_123",
        amountMicroUsd: 50_000_000,
        amountTotalCents: 5000,
        metadata: {
          paidMicroUsd: 50_000_000,
          paymentIntentId: "pi_managed_venice",
        },
      });
      expect(posthogClient.capture).toHaveBeenCalledWith(
        expect.objectContaining({
          distinctId: "user_123",
          event: "managed_venice_card_topup_completed",
          properties: expect.objectContaining({
            session_id: "cs_managed_venice_123",
            paid_micro_usd: 50_000_000,
            credit_micro_usd: 50_000_000,
          }),
        })
      );
    });

    it("delegates to storage addon naturally", async () => {
      const mockSession = {
        id: "sess_123",
        metadata: {
          type: "storage_addon",
          instance_id: "inst_123",
          user_id: "user_123",
          disk_gb_added: "20"
        }
      } as unknown as Stripe.Checkout.Session;

      // When from('hermes_instances').select().single() is called
      (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
        const builder = createMockBuilder();
        if (table === "hermes_instances") {
            builder.single.mockImplementation(() => Promise.resolve({
                data: { id: "inst_123", disk_size_gb: 40, disk_upgraded: false, hetzner_server_id: null }
            }));
            builder.eq.mockImplementation(() => builder);
            builder.update.mockImplementation(() => builder);
            // the await on eq() will hit builder.then
        }
        return builder;
      });

      // The background Hetzner disk expansion will be skipped since hetzner_server_id is null in test data
      await StripeWebhookService.handleCheckoutCompleted(mockSession);

      expect(supabaseAdmin!.from).toHaveBeenCalledWith("hermes_instances");
    });

    it("falls back to subscription metadata for trial tracking and conversion capture", async () => {
      const stripe = getStripe();
      const retrieveSubscription = stripe.subscriptions.retrieve as jest.Mock;
      retrieveSubscription.mockResolvedValue({
        id: "sub_123",
        metadata: { user_id: "user_123", plan: "fleet" },
      });

      const insertMock = jest.fn().mockResolvedValue({ error: null });
      (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
        if (table === "hermes_trial_usage") {
          return {
            insert: insertMock,
          };
        }

        return createMockBuilder();
      });

      const handleSubscriptionChangeSpy = jest
        .spyOn(StripeWebhookService, "handleSubscriptionChange")
        .mockResolvedValue(undefined);

      await StripeWebhookService.handleCheckoutCompleted({
        id: "sess_123",
        mode: "subscription",
        subscription: "sub_123",
        payment_status: "paid",
        metadata: {},
        amount_total: 2900,
      } as unknown as Stripe.Checkout.Session);

      expect(handleSubscriptionChangeSpy).toHaveBeenCalledWith(
        expect.objectContaining({ id: "sub_123" })
      );
      expect(insertMock).toHaveBeenCalledWith({
        user_id: "user_123",
        ip_address: null,
      });
      expect(posthogClient.capture).toHaveBeenCalledWith(
        expect.objectContaining({
          distinctId: "user_123",
          properties: expect.objectContaining({
            plan: "fleet",
            session_id: "sess_123",
          }),
        })
      );

      handleSubscriptionChangeSpy.mockRestore();
    });

    it("redacts trial usage insert errors before logging them", async () => {
      (log.error as jest.Mock).mockClear();

      const stripe = getStripe();
      const retrieveSubscription = stripe.subscriptions.retrieve as jest.Mock;
      retrieveSubscription.mockResolvedValue({
        id: "sub_123",
        metadata: { user_id: "user_123", plan: "fleet" },
      });

      const handleSubscriptionChangeSpy = jest
        .spyOn(StripeWebhookService, "handleSubscriptionChange")
        .mockResolvedValue(undefined);

      const insertMock = jest.fn().mockResolvedValue({
        error: {
          code: "XX000",
          message: "trial-usage-secret-leak",
          details: "trial-usage-details-leak",
          hint: "trial-usage-hint-leak",
        },
      });

      (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
        if (table === "hermes_trial_usage") {
          return {
            insert: insertMock,
          };
        }

        return createMockBuilder();
      });

      await StripeWebhookService.handleCheckoutCompleted({
        id: "sess_123",
        mode: "subscription",
        subscription: "sub_123",
        payment_status: "paid",
        metadata: {},
      } as unknown as Stripe.Checkout.Session);

      await flushAsyncStart();

      expect(log.error).toHaveBeenCalledWith(
        "failed to record trial usage",
        expect.anything(),
        expect.objectContaining({
          source: "stripe-webhook-service",
          failureType: "trial_usage_insert_failed",
          errorCode: "XX000",
        })
      );
      // The context (3rd arg) must not contain the leaked DB error fields.
      // The 2nd-arg err object is intentionally redacted by the logger itself
      // (covered in logger.test.ts), so we only audit the context here.
      const contextCalls = (log.error as jest.Mock).mock.calls.map((call) => call[2]);
      const stringifiedContext = JSON.stringify(contextCalls);
      expect(stringifiedContext).not.toContain("trial-usage-secret-leak");
      expect(stringifiedContext).not.toContain("trial-usage-details-leak");
      expect(stringifiedContext).not.toContain("trial-usage-hint-leak");

      handleSubscriptionChangeSpy.mockRestore();
    });

    it("redacts checkout activation errors before logging them AND re-throws so Stripe retries", async () => {
      (log.error as jest.Mock).mockClear();

      const stripe = getStripe();
      const retrieveSubscription = stripe.subscriptions.retrieve as jest.Mock;
      retrieveSubscription.mockRejectedValue({
        name: "StripeActivationFailure",
        message: "checkout-secret-leak",
        stack: "stack-secret-leak",
      });

      // Regression guard: the catch used to swallow the error, log.error,
      // and return. That ack'd the webhook to Stripe as successful even
      // though the paying user's subscription was never activated. The
      // catch must now re-throw so the route returns non-2xx and Stripe
      // redelivers via its built-in retry schedule.
      await expect(
        StripeWebhookService.handleCheckoutCompleted({
          id: "sess_123",
          mode: "subscription",
          subscription: "sub_123",
          payment_status: "paid",
          metadata: {},
        } as unknown as Stripe.Checkout.Session)
      ).rejects.toMatchObject({ name: "StripeActivationFailure" });

      expect(log.error).toHaveBeenCalledWith(
        "failed to activate subscription from checkout",
        expect.anything(),
        expect.objectContaining({
          source: "stripe-webhook-service",
          failureType: "checkout_activation_failed",
          subscriptionId: "sub_123",
        })
      );
      // Audit the context (3rd arg) for accidental leaks. The err (2nd arg)
      // is intentionally redacted at the logger boundary (see logger.test.ts).
      const contextCalls = (log.error as jest.Mock).mock.calls.map((call) => call[2]);
      const stringifiedContext = JSON.stringify(contextCalls);
      expect(stringifiedContext).not.toContain("checkout-secret-leak");
      expect(stringifiedContext).not.toContain("stack-secret-leak");
    });
  });

  describe("handleStorageAddonPurchased", () => {
    it("redacts unexpected storage addon metadata before logging it", async () => {
      (log.error as jest.Mock).mockClear();

      await StripeWebhookService.handleStorageAddonPurchased({
        id: "sess_123",
        metadata: {
          user_id: "user_123",
          token: "storage-addon-secret-leak",
        },
      } as unknown as Stripe.Checkout.Session);

      expect(log.error).toHaveBeenCalledWith(
        "storage_addon missing instance_id or user_id in metadata",
        expect.anything(),
        expect.objectContaining({
          source: "stripe-webhook-service",
          failureType: "storage_addon_missing_metadata",
          hasInstanceId: false,
          hasUserId: true,
          hasDiskGbAdded: false,
        })
      );
      expect(stringifyLoggerCalls(log.error as jest.Mock)).not.toContain("storage-addon-secret-leak");
    });

    it("redacts storage addon instance update errors before logging them", async () => {
      (log.error as jest.Mock).mockClear();

      (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
        const builder = createMockBuilder();

        if (table === "hermes_instances") {
          builder.select.mockImplementation(() => {
            const selectBuilder = createMockBuilder();
            selectBuilder.eq.mockImplementation(() => selectBuilder);
            selectBuilder.single.mockResolvedValue({
              data: {
                id: "inst_123",
                name: "Atlas",
                disk_size_gb: 40,
                disk_upgraded: false,
                hetzner_server_id: null,
                status: "running",
              },
            });
            return selectBuilder;
          });

          builder.update.mockImplementation(() => ({
            eq: jest.fn().mockResolvedValue({
              error: {
                code: "XX000",
                message: "storage-addon-update-secret",
                details: "storage-addon-update-details",
                hint: "storage-addon-update-hint",
              },
            }),
          }));
        }

        return builder;
      });

      await StripeWebhookService.handleStorageAddonPurchased({
        id: "sess_123",
        metadata: {
          instance_id: "inst_123",
          user_id: "user_123",
          disk_gb_added: "20",
        },
      } as unknown as Stripe.Checkout.Session);

      expect(log.error).toHaveBeenCalledWith(
        "failed to update instance disk after storage addon",
        expect.anything(),
        expect.objectContaining({
          source: "stripe-webhook-service",
          failureType: "storage_addon_instance_update_failed",
          instanceId: "inst_123",
          errorCode: "XX000",
        })
      );
      // Context (3rd arg) must not leak the raw DB error fields. The err
      // (2nd arg) message/stack are redacted by the logger itself.
      const contextCalls = (log.error as jest.Mock).mock.calls.map((call) => call[2]);
      const stringifiedContext = JSON.stringify(contextCalls);
      expect(stringifiedContext).not.toContain("storage-addon-update-secret");
      expect(stringifiedContext).not.toContain("storage-addon-update-details");
      expect(stringifiedContext).not.toContain("storage-addon-update-hint");
    });

    it("aborts the webhook (throws) and does NOT mark disk_upgraded when Hetzner resize fails", async () => {
      // Regression guard for the BLOCKER fix: the previous behaviour
      // wrote `disk_upgraded=true` to the DB BEFORE firing a
      // fire-and-forget Hetzner resize. If Hetzner failed, the user
      // had paid for storage they didn't get and the early-return
      // guard prevented retries. Now: we resize first, only flip the
      // DB if the resize succeeds, and throw on failure so Stripe
      // redelivers.
      (log.error as jest.Mock).mockClear();

      jest
        .spyOn(StripeWebhookService, "triggerHetznerDiskExpansion")
        .mockRejectedValue({
          name: "DiskExpansionFailure",
          message: "disk-expansion-secret-leak",
          stack: "disk-expansion-stack-leak",
        });

      const updateEq = jest.fn().mockResolvedValue({ error: null });
      (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
        const builder = createMockBuilder();

        if (table === "hermes_instances") {
          builder.select.mockImplementation(() => {
            const selectBuilder = createMockBuilder();
            selectBuilder.eq.mockImplementation(() => selectBuilder);
            selectBuilder.single.mockResolvedValue({
              data: {
                id: "inst_123",
                name: "Atlas",
                disk_size_gb: 40,
                disk_upgraded: false,
                hetzner_server_id: 123,
                status: "running",
              },
            });
            return selectBuilder;
          });

          builder.update.mockImplementation(() => ({ eq: updateEq }));
        }

        return builder;
      });

      let thrown: unknown = null;
      try {
        await StripeWebhookService.handleStorageAddonPurchased({
          id: "sess_123",
          metadata: {
            instance_id: "inst_123",
            user_id: "user_123",
            disk_gb_added: "20",
          },
        } as unknown as Stripe.Checkout.Session);
      } catch (err) {
        thrown = err;
      }

      // Critical: the handler must throw so Stripe redelivers.
      expect(thrown).not.toBeNull();
      // Critical: the DB write must NOT have happened — we only flip
      // disk_upgraded after a successful Hetzner resize.
      expect(updateEq).not.toHaveBeenCalled();

      // The logger should record the failure with redacted context.
      expect(log.error).toHaveBeenCalledWith(
        expect.stringContaining("hetzner disk expansion failed"),
        expect.anything(),
        expect.objectContaining({
          source: "stripe-webhook-service",
          failureType: "storage_addon_disk_expansion_failed",
          instanceId: "inst_123",
        })
      );
      const contextCalls = (log.error as jest.Mock).mock.calls.map((call) => call[2]);
      const stringifiedContext = JSON.stringify(contextCalls);
      expect(stringifiedContext).not.toContain("disk-expansion-secret-leak");
      expect(stringifiedContext).not.toContain("disk-expansion-stack-leak");

      (
        StripeWebhookService.triggerHetznerDiskExpansion as jest.MockedFunction<
          typeof StripeWebhookService.triggerHetznerDiskExpansion
        >
      ).mockRestore();
    });

    it("marks disk_upgraded=true ONLY after a successful Hetzner resize", async () => {
      // Positive case: resize succeeds → DB flag updates → no throw.
      (log.error as jest.Mock).mockClear();

      jest
        .spyOn(StripeWebhookService, "triggerHetznerDiskExpansion")
        .mockResolvedValue(undefined);

      const updateRow = jest.fn();
      const updateEq = jest.fn().mockResolvedValue({ error: null });
      (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
        const builder = createMockBuilder();

        if (table === "hermes_instances") {
          builder.select.mockImplementation(() => {
            const selectBuilder = createMockBuilder();
            selectBuilder.eq.mockImplementation(() => selectBuilder);
            selectBuilder.single.mockResolvedValue({
              data: {
                id: "inst_123",
                name: "Atlas",
                disk_size_gb: 40,
                disk_upgraded: false,
                hetzner_server_id: 123,
                status: "running",
              },
            });
            return selectBuilder;
          });

          builder.update.mockImplementation((row: Record<string, unknown>) => {
            updateRow(row);
            return { eq: updateEq };
          });
        }

        return builder;
      });

      await StripeWebhookService.handleStorageAddonPurchased({
        id: "sess_123",
        metadata: {
          instance_id: "inst_123",
          user_id: "user_123",
          disk_gb_added: "20",
        },
      } as unknown as Stripe.Checkout.Session);

      expect(updateEq).toHaveBeenCalled();
      expect(updateRow).toHaveBeenCalledWith(
        expect.objectContaining({
          disk_upgraded: true,
          disk_size_gb: 60,
          storage_addon_session_id: "sess_123",
        })
      );

      (
        StripeWebhookService.triggerHetznerDiskExpansion as jest.MockedFunction<
          typeof StripeWebhookService.triggerHetznerDiskExpansion
        >
      ).mockRestore();
    });
  });

  describe("handleSubscriptionChange", () => {
    it("upserts subscription properly", async () => {
      const sub = {
        id: "sub_1",
        customer: "cus_1",
        status: "active",
        start_date: 1000,
        metadata: { user_id: "user_1", plan: "operator" },
        items: { data: [{ current_period_start: 1000, current_period_end: 2000 }] }
      } as unknown as Stripe.Subscription;

      let upsertArgs: unknown;
      (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
        const builder = createMockBuilder();
        if (table === "hermes_subscriptions") {
            builder.upsert.mockImplementation((args: unknown) => {
                upsertArgs = args;
                return Promise.resolve({ error: null });
            });
        }
        if (table === "hermes_instances") {
            builder.eq.mockImplementation(() => builder);
            builder.then = (r: (value: unknown) => void) => r({ data: [] }); // No pending
        }
        return builder;
      });

      await StripeWebhookService.handleSubscriptionChange(sub);

      expect(supabaseAdmin!.from).toHaveBeenCalledWith("hermes_subscriptions");
      expect(upsertArgs).toMatchObject({
          user_id: "user_1",
          plan: "operator",
          status: "active"
      });
      expect(grantSubscriptionCycleCredits).toHaveBeenCalledWith({
        userId: "user_1",
        planKey: "operator",
        subscriptionId: "sub_1",
        periodStart: 1000,
        periodEnd: 2000,
      });
    });

    it("accepts a configured yearly Stripe price for the matching plan", async () => {
      const operatorPlan = PLANS.operator as unknown as {
        stripePriceId: string;
        stripeYearlyPriceId: string;
      };
      const originalMonthlyPriceId = operatorPlan.stripePriceId;
      const originalYearlyPriceId = operatorPlan.stripeYearlyPriceId;
      operatorPlan.stripePriceId = "price_operator_monthly_test";
      operatorPlan.stripeYearlyPriceId = "price_operator_yearly_test";

      try {
        const sub = {
          id: "sub_yearly",
          customer: "cus_1",
          status: "trialing",
          start_date: 1000,
          metadata: { user_id: "user_1", plan: "operator" },
          items: {
            data: [
              {
                price: { id: "price_operator_yearly_test" },
                current_period_start: 1000,
                current_period_end: 2000,
              },
            ],
          },
        } as unknown as Stripe.Subscription;

        let upsertArgs: unknown;
        (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
          const builder = createMockBuilder();
          if (table === "hermes_subscriptions") {
            builder.upsert.mockImplementation((args: unknown) => {
              upsertArgs = args;
              return Promise.resolve({ error: null });
            });
          }
          return builder;
        });

        await StripeWebhookService.handleSubscriptionChange(sub);

        expect(upsertArgs).toMatchObject({
          user_id: "user_1",
          stripe_subscription_id: "sub_yearly",
          plan: "operator",
          status: "active",
        });
        expect(log.error).not.toHaveBeenCalledWith(
          "subscription plan/price mismatch — refusing to apply",
          expect.anything(),
          expect.anything()
        );
        expect(grantSubscriptionCycleCredits).toHaveBeenCalledWith({
          userId: "user_1",
          planKey: "operator",
          subscriptionId: "sub_yearly",
          periodStart: 1000,
          periodEnd: 2000,
        });
      } finally {
        operatorPlan.stripePriceId = originalMonthlyPriceId;
        operatorPlan.stripeYearlyPriceId = originalYearlyPriceId;
      }
    });

    it("accepts the pre-2026-04-30 legacy Stripe price for the matching plan", async () => {
      // Regression: legacy subscribers keep billing on the rotated-away price
      // forever. Before the LEGACY_STRIPE_PRICE_IDS allowlist, every one of
      // their subscription webhooks was dropped by the plan/price mismatch
      // guard (38 users / 105 dropped events by 2026-07-15).
      const operatorPlan = PLANS.operator as unknown as {
        stripePriceId: string;
        stripeYearlyPriceId: string;
      };
      const originalMonthlyPriceId = operatorPlan.stripePriceId;
      const originalYearlyPriceId = operatorPlan.stripeYearlyPriceId;
      operatorPlan.stripePriceId = "price_operator_monthly_test";
      operatorPlan.stripeYearlyPriceId = "price_operator_yearly_test";

      try {
        const sub = {
          id: "sub_legacy_price",
          customer: "cus_legacy",
          status: "trialing",
          start_date: 1000,
          metadata: { user_id: "user_legacy", plan: "operator" },
          items: {
            data: [
              {
                price: { id: "price_1THZgbRmaqy4HoEnvyd6bpG1" },
                current_period_start: 1000,
                current_period_end: 2000,
              },
            ],
          },
        } as unknown as Stripe.Subscription;

        let upsertArgs: unknown;
        (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
          const builder = createMockBuilder();
          if (table === "hermes_subscriptions") {
            builder.upsert.mockImplementation((args: unknown) => {
              upsertArgs = args;
              return Promise.resolve({ error: null });
            });
          }
          return builder;
        });

        await StripeWebhookService.handleSubscriptionChange(sub);

        expect(upsertArgs).toMatchObject({
          user_id: "user_legacy",
          stripe_subscription_id: "sub_legacy_price",
          plan: "operator",
          status: "active",
        });
        expect(log.error).not.toHaveBeenCalledWith(
          "subscription plan/price mismatch — refusing to apply",
          expect.anything(),
          expect.anything()
        );
      } finally {
        operatorPlan.stripePriceId = originalMonthlyPriceId;
        operatorPlan.stripeYearlyPriceId = originalYearlyPriceId;
      }
    });

    it("refuses to apply a subscription whose price does not belong to metadata.plan", async () => {
      const operatorPlan = PLANS.operator as unknown as {
        stripePriceId: string;
        stripeYearlyPriceId: string;
      };
      const originalMonthlyPriceId = operatorPlan.stripePriceId;
      const originalYearlyPriceId = operatorPlan.stripeYearlyPriceId;
      operatorPlan.stripePriceId = "price_operator_monthly_test";
      operatorPlan.stripeYearlyPriceId = "price_operator_yearly_test";

      try {
        await StripeWebhookService.handleSubscriptionChange({
          id: "sub_wrong_price",
          customer: "cus_1",
          status: "active",
          start_date: 1000,
          metadata: { user_id: "user_1", plan: "operator" },
          items: {
            data: [
              {
                price: { id: "price_fleet_monthly_test" },
                current_period_start: 1000,
                current_period_end: 2000,
              },
            ],
          },
        } as unknown as Stripe.Subscription);

        expect(supabaseAdmin!.from).not.toHaveBeenCalled();
        expect(grantSubscriptionCycleCredits).not.toHaveBeenCalled();
        expect(log.error).toHaveBeenCalledWith(
          "subscription plan/price mismatch — refusing to apply",
          expect.anything(),
          expect.objectContaining({
            source: "stripe-webhook-service",
            failureType: "subscription_plan_price_mismatch",
            subscriptionId: "sub_wrong_price",
            metadataPlan: "operator",
            metadataPlanPriceIds: [
              "price_operator_monthly_test",
              "price_operator_yearly_test",
              "price_1THZgbRmaqy4HoEnvyd6bpG1",
            ],
            actualPriceId: "price_fleet_monthly_test",
          })
        );
      } finally {
        operatorPlan.stripePriceId = originalMonthlyPriceId;
        operatorPlan.stripeYearlyPriceId = originalYearlyPriceId;
      }
    });

    it("redacts invalid subscription metadata before logging it", async () => {
      (log.error as jest.Mock).mockClear();

      await StripeWebhookService.handleSubscriptionChange({
        id: "sub_1",
        customer: "cus_1",
        status: "active",
        start_date: 1000,
        metadata: {
          plan: "operator",
          vaultToken: "subscription-metadata-secret-leak",
        },
        items: { data: [{ current_period_start: 1000, current_period_end: 2000 }] },
      } as unknown as Stripe.Subscription);

      expect(log.error).toHaveBeenCalledWith(
        "subscription has missing or invalid metadata",
        expect.anything(),
        expect.objectContaining({
          source: "stripe-webhook-service",
          failureType: "subscription_invalid_metadata",
          hasUserId: false,
          hasPlanKey: true,
          hasValidPlan: true,
        })
      );
      expect(stringifyLoggerCalls(log.error as jest.Mock)).not.toContain("subscription-metadata-secret-leak");
    });

    it("redacts duplicate subscription recovery errors before logging them", async () => {
      (log.error as jest.Mock).mockClear();
      const stripe = getStripe();
      const listSubscriptions = stripe.subscriptions.list as jest.Mock;
      const cancelSubscription = stripe.subscriptions.cancel as jest.Mock;

      listSubscriptions.mockResolvedValue({
        data: [
          {
            id: "sub_old",
            created: 1,
            metadata: { user_id: "user_1", plan: "operator" },
          },
          {
            id: "sub_new",
            created: 2,
            metadata: { user_id: "user_1", plan: "operator" },
          },
        ],
      });
      cancelSubscription.mockRejectedValue({
        name: "DuplicateCancelFailure",
        message: "duplicate-subscription-secret-leak",
        stack: "duplicate-subscription-stack-leak",
      });

      // Survivor row exists in DB → my "deferred until survivor row
      // present" check passes and the cancel/refund attempt runs (and
      // fails per the mocked rejection above).
      (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
        const builder = createMockBuilder();
        if (table === "hermes_subscriptions") {
          builder.maybeSingle.mockResolvedValue({
            data: { id: "row_old", stripe_subscription_id: "sub_old" },
            error: null,
          });
          builder.upsert.mockResolvedValue({ error: null });
        }
        if (table === "hermes_instances") {
          builder.eq.mockImplementation(() => builder);
          builder.then = (r: (value: unknown) => void) => r({ data: [] });
        }
        return builder;
      });

      await StripeWebhookService.handleSubscriptionChange({
        id: "sub_new",
        customer: "cus_1",
        status: "active",
        start_date: 1000,
        metadata: { user_id: "user_1", plan: "operator" },
        latest_invoice: "in_123",
        items: { data: [{ current_period_start: 1000, current_period_end: 2000 }] },
      } as unknown as Stripe.Subscription);

      expect(log.error).toHaveBeenCalledWith(
        "error handling duplicate subscription",
        expect.anything(),
        expect.objectContaining({
          source: "stripe-webhook-service",
          failureType: "duplicate_subscription_recovery_failed",
          subscriptionId: "sub_new",
        })
      );
      const contextCalls = (log.error as jest.Mock).mock.calls.map((call) => call[2]);
      const stringifiedContext = JSON.stringify(contextCalls);
      expect(stringifiedContext).not.toContain("duplicate-subscription-secret-leak");
      expect(stringifiedContext).not.toContain("duplicate-subscription-stack-leak");
    });

    it("on redelivery of a duplicate already canceled at Stripe: re-issues the refund (idempotent) and does NOT upsert it as active", async () => {
      // Models the crash window: a prior run canceled the duplicate (sub_new)
      // but died before the refund and before marking the event processed. On
      // redelivery the frozen payload still says 'active', but Stripe's live
      // active list now contains only the survivor (sub_old). Without the fix
      // the duplicate branch is skipped and sub_new (canceled) gets upserted as
      // the active row with no refund.
      const stripe = getStripe();
      (stripe.subscriptions.list as jest.Mock).mockResolvedValue({
        data: [{ id: "sub_old", created: 1, metadata: { user_id: "user_1", plan: "operator" } }],
      });
      const retrieveSub = stripe.subscriptions.retrieve as jest.Mock;
      retrieveSub.mockResolvedValue({ id: "sub_new", status: "canceled" });
      (stripe.invoices.retrieve as jest.Mock).mockResolvedValue({ payment_intent: "pi_dup" });
      const refundsCreate = stripe.refunds.create as jest.Mock;
      refundsCreate.mockClear();
      const cancelSubscription = stripe.subscriptions.cancel as jest.Mock;
      cancelSubscription.mockClear();

      let upsertCalled = false;
      (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
        const builder = createMockBuilder();
        if (table === "hermes_subscriptions") {
          builder.upsert.mockImplementation(() => {
            upsertCalled = true;
            return Promise.resolve({ error: null });
          });
        }
        if (table === "hermes_instances") {
          builder.eq.mockImplementation(() => builder);
          builder.then = (r: (value: unknown) => void) => r({ data: [] });
        }
        return builder;
      });

      await StripeWebhookService.handleSubscriptionChange({
        id: "sub_new",
        customer: "cus_1",
        status: "active", // frozen webhook payload
        start_date: 1000,
        metadata: { user_id: "user_1", plan: "operator" },
        latest_invoice: "in_dup",
        items: { data: [{ current_period_start: 1000, current_period_end: 2000 }] },
      } as unknown as Stripe.Subscription);

      // Refund re-issued with the stable idempotency key (a prior success no-ops).
      expect(refundsCreate).toHaveBeenCalledWith(
        { payment_intent: "pi_dup", reason: "duplicate" },
        { idempotencyKey: "duplicate_refund_sub_new" }
      );
      // The canceled duplicate is NOT written as the active subscription.
      expect(upsertCalled).toBe(false);
      // And we don't re-cancel an already-canceled subscription.
      expect(cancelSubscription).not.toHaveBeenCalled();
    });

    it("defers duplicate-cancel via webhook redelivery when the survivor row hasn't been written yet", async () => {
      // Stripe can deliver the NEWER subscription's webhook before the
      // OLDER one. If we cancel the duplicate (newer) right away while
      // no hermes_subscriptions row exists for either, the user briefly
      // has paid for nothing — UI polls show "no active sub" and they
      // may buy a third time. Throwing here makes Stripe redeliver this
      // webhook later, by which point the older sub's webhook has
      // upserted the row and we can safely cancel + refund the
      // duplicate.
      const stripe = getStripe();
      const listSubscriptions = stripe.subscriptions.list as jest.Mock;
      const cancelSubscription = stripe.subscriptions.cancel as jest.Mock;
      const refunds = stripe.refunds.create as jest.Mock;

      listSubscriptions.mockResolvedValue({
        data: [
          { id: "sub_old", created: 1, metadata: { user_id: "user_1", plan: "operator" } },
          { id: "sub_new", created: 2, metadata: { user_id: "user_1", plan: "operator" } },
        ],
      });

      // No survivor row in DB → deferred path should fire.
      (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
        const builder = createMockBuilder();
        if (table === "hermes_subscriptions") {
          builder.maybeSingle.mockResolvedValue({ data: null, error: null });
        }
        return builder;
      });

      await expect(
        StripeWebhookService.handleSubscriptionChange({
          id: "sub_new",
          customer: "cus_1",
          status: "active",
          start_date: 1000,
          metadata: { user_id: "user_1", plan: "operator" },
          latest_invoice: "in_123",
          items: { data: [{ current_period_start: 1000, current_period_end: 2000 }] },
        } as unknown as Stripe.Subscription)
      ).rejects.toThrow(/survivor.*not yet present|deferring/i);

      // Critical: the cancel and refund must NOT have run.
      expect(cancelSubscription).not.toHaveBeenCalled();
      expect(refunds).not.toHaveBeenCalled();
    });

    it("does not count an older Workspace Cloud subscription as a duplicate of a Hivra one", async () => {
      // Workspace Cloud checkout reuses the user's Stripe customer and stamps
      // the same metadata.user_id. Counting its subscription as a Hivra
      // duplicate made every event for a newer Hivra subscription wait for a
      // "survivor" Hivra row that can never exist, so the paid Hivra plan was
      // never applied (and Stripe redelivered the event until it gave up).
      const stripe = getStripe();
      const cancelSubscription = stripe.subscriptions.cancel as jest.Mock;
      const refunds = stripe.refunds.create as jest.Mock;
      (stripe.subscriptions.list as jest.Mock).mockResolvedValue({
        data: [
          {
            id: "sub_wc_older",
            created: 1,
            metadata: { user_id: "user_1", plan: "ws_cloud_pro", surface: "workspace_cloud" },
          },
          { id: "sub_hivra_newer", created: 2, metadata: { user_id: "user_1", plan: "operator" } },
        ],
      });

      const upserts: Array<Record<string, unknown>> = [];
      (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
        const builder = createMockBuilder();
        if (table === "hermes_subscriptions") {
          builder.maybeSingle.mockResolvedValue({ data: null, error: null });
          builder.upsert.mockImplementation((payload: Record<string, unknown>) => {
            upserts.push(payload);
            return builder;
          });
        }
        return builder;
      });

      await StripeWebhookService.handleSubscriptionChange({
        id: "sub_hivra_newer",
        customer: "cus_1",
        status: "active",
        start_date: 1000,
        metadata: { user_id: "user_1", plan: "operator" },
        items: { data: [{ current_period_start: 1000, current_period_end: 2000 }] },
      } as unknown as Stripe.Subscription);

      expect(cancelSubscription).not.toHaveBeenCalled();
      expect(refunds).not.toHaveBeenCalled();
      expect(upserts).toEqual([
        expect.objectContaining({
          user_id: "user_1",
          stripe_subscription_id: "sub_hivra_newer",
          plan: "operator",
          status: "active",
        }),
      ]);
    });

    it("redacts subscription upsert errors before logging them", async () => {
      (log.error as jest.Mock).mockClear();

      (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
        const builder = createMockBuilder();
        if (table === "hermes_subscriptions") {
          builder.upsert.mockResolvedValue({
            error: {
              code: "23505",
              message: "subscription-upsert-secret-leak",
              details: "subscription-upsert-details-leak",
              hint: "subscription-upsert-hint-leak",
            },
          });
        }
        if (table === "hermes_instances") {
          builder.eq.mockImplementation(() => builder);
          builder.then = (resolve: (value: unknown) => void) => resolve({ data: [] });
        }
        return builder;
      });

      await StripeWebhookService.handleSubscriptionChange({
        id: "sub_1",
        customer: "cus_1",
        status: "active",
        start_date: 1000,
        metadata: { user_id: "user_1", plan: "operator" },
        items: { data: [{ current_period_start: 1000, current_period_end: 2000 }] },
      } as unknown as Stripe.Subscription);

      expect(log.error).toHaveBeenCalledWith(
        "failed to upsert subscription",
        expect.anything(),
        expect.objectContaining({
          source: "stripe-webhook-service",
          failureType: "subscription_upsert_failed",
          errorCode: "23505",
          subscriptionId: "sub_1",
        })
      );
      const contextCalls = (log.error as jest.Mock).mock.calls.map((call) => call[2]);
      const stringifiedContext = JSON.stringify(contextCalls);
      expect(stringifiedContext).not.toContain("subscription-upsert-secret-leak");
      expect(stringifiedContext).not.toContain("subscription-upsert-details-leak");
      expect(stringifiedContext).not.toContain("subscription-upsert-hint-leak");
      expect(grantSubscriptionCycleCredits).not.toHaveBeenCalled();
    });
  });

  describe("handleSubscriptionChange — conversion stamp (upgraded_at write-once)", () => {
    const activeSub = (overrides: Record<string, unknown> = {}) =>
      ({
        id: "sub_stamp",
        customer: "cus_1",
        status: "active",
        start_date: 1000,
        metadata: { user_id: "user_1", plan: "operator" },
        items: { data: [{ current_period_start: 1000, current_period_end: 2000 }] },
        ...overrides,
      }) as unknown as Stripe.Subscription;

    function mockSubscriptionTables(priorRow: Record<string, unknown> | null) {
      let upsertArgs: Record<string, unknown> | undefined;
      (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
        const builder = createMockBuilder();
        if (table === "hermes_subscriptions") {
          builder.maybeSingle.mockImplementation(() =>
            Promise.resolve({ data: priorRow, error: null })
          );
          builder.upsert.mockImplementation((args: Record<string, unknown>) => {
            upsertArgs = args;
            return Promise.resolve({ error: null });
          });
        }
        if (table === "hermes_instances") {
          builder.eq.mockImplementation(() => builder);
          builder.then = (r: (v: unknown) => void) => r({ data: [] });
        }
        return builder;
      });
      return () => upsertArgs;
    }

    it("stamps upgraded_at + upgrade_source on a free→paid activation (webhook default source)", async () => {
      const getUpsertArgs = mockSubscriptionTables({
        plan: "free",
        status: "active",
        upgraded_at: null,
      });

      await StripeWebhookService.handleSubscriptionChange(activeSub());

      const upsertArgs = getUpsertArgs();
      expect(upsertArgs).toMatchObject({
        user_id: "user_1",
        plan: "operator",
        status: "active",
        upgrade_source: "stripe_webhook",
      });
      expect(typeof upsertArgs!.upgraded_at).toBe("string");
    });

    it("stamps with source confirm_checkout when threaded from the confirm route", async () => {
      const getUpsertArgs = mockSubscriptionTables(null);

      await StripeWebhookService.handleSubscriptionChange(activeSub(), {
        source: "confirm_checkout",
      });

      expect(getUpsertArgs()).toMatchObject({
        upgrade_source: "confirm_checkout",
      });
    });

    it("stamps when the prior row was a pending checkout", async () => {
      const getUpsertArgs = mockSubscriptionTables({
        plan: "operator",
        status: "pending",
        upgraded_at: null,
      });

      await StripeWebhookService.handleSubscriptionChange(activeSub());

      expect(getUpsertArgs()).toMatchObject({
        upgrade_source: "stripe_webhook",
      });
    });

    it("does NOT re-stamp on a webhook redelivery (prior row already paid+active+stamped)", async () => {
      const getUpsertArgs = mockSubscriptionTables({
        plan: "operator",
        status: "active",
        upgraded_at: "2026-06-01T00:00:00.000Z",
      });

      await StripeWebhookService.handleSubscriptionChange(activeSub());

      const upsertArgs = getUpsertArgs();
      expect(upsertArgs).toBeDefined();
      expect(upsertArgs).not.toHaveProperty("upgraded_at");
      expect(upsertArgs).not.toHaveProperty("upgrade_source");
    });

    it("does NOT stamp a paid→paid plan change", async () => {
      const getUpsertArgs = mockSubscriptionTables({
        plan: "fleet",
        status: "active",
        upgraded_at: "2026-05-01T00:00:00.000Z",
      });

      await StripeWebhookService.handleSubscriptionChange(activeSub());

      const upsertArgs = getUpsertArgs();
      expect(upsertArgs).not.toHaveProperty("upgraded_at");
      expect(upsertArgs).not.toHaveProperty("upgrade_source");
    });

    it("does NOT stamp when the new state is not paid+active (incomplete checkout)", async () => {
      const getUpsertArgs = mockSubscriptionTables({
        plan: "free",
        status: "active",
        upgraded_at: null,
      });

      await StripeWebhookService.handleSubscriptionChange(
        activeSub({ status: "incomplete" })
      );

      const upsertArgs = getUpsertArgs();
      expect(upsertArgs).toMatchObject({ status: "pending" });
      expect(upsertArgs).not.toHaveProperty("upgraded_at");
      expect(upsertArgs).not.toHaveProperty("upgrade_source");
    });

    it("fails closed (no stamp) when the prior-row read errors", async () => {
      let upsertArgs: Record<string, unknown> | undefined;
      (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
        const builder = createMockBuilder();
        if (table === "hermes_subscriptions") {
          builder.maybeSingle.mockImplementation(() =>
            Promise.resolve({ data: null, error: { message: "read blip" } })
          );
          builder.upsert.mockImplementation((args: Record<string, unknown>) => {
            upsertArgs = args;
            return Promise.resolve({ error: null });
          });
        }
        if (table === "hermes_instances") {
          builder.eq.mockImplementation(() => builder);
          builder.then = (r: (v: unknown) => void) => r({ data: [] });
        }
        return builder;
      });

      await StripeWebhookService.handleSubscriptionChange(activeSub());

      expect(upsertArgs).toBeDefined();
      expect(upsertArgs).not.toHaveProperty("upgraded_at");
      expect(upsertArgs).not.toHaveProperty("upgrade_source");
    });
  });

  describe("handleSubscriptionChange — tier-change wiring", () => {
    it("calls applyTierChange when subscription transitions to active", async () => {
      // Regression: an active/trialing subscription event MUST update
      // resource_tier on the user's instances and (for Proxmox VMs) hot-resize.
      // If applyTierChange isn't called, paid users keep free-tier caps until
      // next provision. Mock the dynamically-imported tier-change-service to
      // verify the call without exercising the real Proxmox SSH path.
      const applyTierChangeMock = jest.fn().mockResolvedValue({
        userId: "user_1",
        newTier: "operator",
        instancesUpdated: 1,
        resizesAttempted: 1,
        resizesSucceeded: 1,
        resizesFailed: [],
      });
      jest.doMock("@/lib/services/tier-change-service", () => ({
        applyTierChange: applyTierChangeMock,
      }));

      const sub = {
        id: "sub_tier_active",
        customer: "cus_1",
        status: "active",
        start_date: 1000,
        metadata: { user_id: "user_1", plan: "operator" },
        items: { data: [{ current_period_start: 1000, current_period_end: 2000 }] },
      } as unknown as Stripe.Subscription;

      (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
        const builder = createMockBuilder();
        if (table === "hermes_subscriptions") {
          builder.upsert.mockResolvedValue({ error: null });
        }
        if (table === "hermes_instances") {
          builder.eq.mockImplementation(() => builder);
          builder.then = (r: (v: unknown) => void) => r({ data: [] });
        }
        return builder;
      });

      await StripeWebhookService.handleSubscriptionChange(sub);

      expect(applyTierChangeMock).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "user_1",
          newTier: "operator",
          source: "stripe",
        })
      );

      jest.dontMock("@/lib/services/tier-change-service");
    });

    it("refuses to apply when subscription.metadata.user_id != customer.metadata.clerk_user_id", async () => {
      // Defense-in-depth: if a Stripe-side attacker creates a subscription
      // with a tampered metadata.user_id, the customer's stored
      // clerk_user_id is the authoritative anchor. Applying a mismatch
      // would credit the wrong account.
      const sub = {
        id: "sub_tampered",
        customer: "cus_42",
        status: "active",
        start_date: 1000,
        metadata: { user_id: "user_attacker", plan: "operator" },
        items: { data: [{ current_period_start: 1000, current_period_end: 2000 }] },
      } as unknown as Stripe.Subscription;

      const stripe = getStripe() as unknown as {
        customers: { retrieve: jest.Mock };
      };
      stripe.customers.retrieve.mockResolvedValueOnce({
        id: "cus_42",
        deleted: false,
        metadata: { clerk_user_id: "user_legitimate" },
      });

      const upsertMock = jest.fn();
      (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
        const builder = createMockBuilder();
        if (table === "hermes_subscriptions") {
          builder.upsert = upsertMock;
        }
        return builder;
      });

      (log.error as jest.Mock).mockClear();
      await StripeWebhookService.handleSubscriptionChange(sub);

      // Subscription must NOT be persisted on a mismatch.
      expect(upsertMock).not.toHaveBeenCalled();
      expect(log.error).toHaveBeenCalledWith(
        "subscription/customer user mismatch — refusing to apply",
        expect.anything(),
        expect.objectContaining({
          source: "stripe-webhook-service",
          failureType: "subscription_user_mismatch",
          metadataUserId: "user_attacker",
          customerClerkUserId: "user_legitimate",
        })
      );
    });

  });

  // Helper: capture every hermes_instances UPDATE payload while letting the
  // chain resolve. Mirrors the suspend/resume query shape
  // (.update().eq().neq()/.in().not().is().select()).
  function mockInstanceUpdateCapture(
    rows: Array<{ id: string }> = [{ id: "inst_1" }],
    subscriptionRow: Record<string, unknown> = { stripe_subscription_id: "sub_1" }
  ) {
    const payloads: Array<Record<string, unknown>> = [];
    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      const builder = createMockBuilder();
      if (table === "hermes_subscriptions") {
        builder.maybeSingle.mockImplementation(() =>
          Promise.resolve({ data: subscriptionRow })
        );
      }
      if (table === "hermes_instances") {
        builder.update.mockImplementation((payload: Record<string, unknown>) => {
          payloads.push(payload);
          const sel = createMockBuilder();
          sel.then = (r: (value: unknown) => void) => r({ data: rows, error: null });
          return sel;
        });
      }
      return builder;
    });
    return payloads;
  }

  // Invoice events only act on the hermes_subscriptions row bound to that
  // exact Stripe subscription, so their fixtures carry one.
  function boundSubscriptionRow(subscriptionId: string): Record<string, unknown> {
    return {
      plan: "operator",
      status: "active",
      grace_period_ends_at: null,
      stripe_subscription_id: subscriptionId,
    };
  }

  describe("handleSubscriptionDeleted", () => {
    it("suspends instances (no deletion fuse) so a cancellation preserves data", async () => {
      const sub = {
        id: "sub_1",
        metadata: { user_id: "user_1" },
      } as unknown as Stripe.Subscription;

      const payloads = mockInstanceUpdateCapture();
      await StripeWebhookService.handleSubscriptionDeleted(sub);

      const suspend = payloads.find((p) => p.entitlement_state === "suspended");
      expect(suspend).toMatchObject({
        // "suspended" is a lifecycle_state, not a status — the DB's
        // hermes_instances_status_check constraint rejects it (the
        // billing_suspend_failed regression: the whole UPDATE rolled back and
        // past-due/canceled users kept running). Mirror the credit-billing
        // suspend shape: status "stopped" + lifecycle_state "suspended".
        status: "stopped",
        lifecycle_state: "suspended",
        entitlement_state: "suspended",
        entitlement_reason: "subscription_canceled",
      });
      // Critically: cancellation must NOT arm a hard-delete fuse.
      expect(suspend).not.toHaveProperty("scheduled_deletion_at");
      for (const p of payloads) {
        expect(p.status).not.toBe("scheduled_for_deletion");
      }
    });

    it("does NOT write the suspend shape when the legacy hard-delete revert flag is set", async () => {
      process.env.HERMES_BILLING_LEGACY_HARD_DELETE = "true";
      try {
        const sub = {
          id: "sub_1",
          metadata: { user_id: "user_1" },
        } as unknown as Stripe.Subscription;
        const payloads = mockInstanceUpdateCapture();
        await StripeWebhookService.handleSubscriptionDeleted(sub);
        // Flag routes to the legacy scheduleInstancesForDeletion path, so the
        // new suspend shape must never be written.
        expect(
          payloads.find((p) => p.entitlement_state === "suspended")
        ).toBeUndefined();
      } finally {
        delete process.env.HERMES_BILLING_LEGACY_HARD_DELETE;
      }
    });
  });

  describe("handlePaymentFailed", () => {
    it("suspends instances instead of arming a deletion fuse on a failed invoice", async () => {
      const stripe = getStripe();
      (stripe.subscriptions.retrieve as jest.Mock).mockResolvedValue({
        id: "sub_pf",
        metadata: { user_id: "user_pf" },
      });
      const payloads = mockInstanceUpdateCapture(undefined, boundSubscriptionRow("sub_pf"));

      await StripeWebhookService.handlePaymentFailed({
        subscription: "sub_pf",
      } as unknown as Stripe.Invoice);

      const suspend = payloads.find((p) => p.entitlement_state === "suspended");
      expect(suspend).toMatchObject({
        status: "stopped",
        lifecycle_state: "suspended",
        entitlement_reason: "subscription_past_due",
      });
      for (const p of payloads) {
        expect(p.status).not.toBe("scheduled_for_deletion");
        expect(p).not.toHaveProperty("scheduled_deletion_at");
      }
    });

    it("only ever writes status values the DB check constraint allows", async () => {
      // Regression guard for the 2026-07 billing_suspend_failed incident:
      // status "suspended" is NOT in hermes_instances_status_check, so
      // Postgres rejected the suspend UPDATE outright and past-due users'
      // instances silently stayed running. Unit mocks can't run the
      // constraint, so pin the allowed set here. If this list needs to grow,
      // a migration must change the constraint on BOTH prod and canary DBs
      // first (see migration history for hermes_instances_status_check).
      const DB_ALLOWED_STATUSES = [
        "provisioning",
        "running",
        "stopped",
        "failed",
        "error",
        "deleted",
        "redeploying",
        "scheduled_for_deletion",
      ];
      const stripe = getStripe();
      (stripe.subscriptions.retrieve as jest.Mock).mockResolvedValue({
        id: "sub_pf2",
        metadata: { user_id: "user_pf2" },
      });
      const payloads = mockInstanceUpdateCapture(undefined, boundSubscriptionRow("sub_pf2"));

      await StripeWebhookService.handlePaymentFailed({
        subscription: "sub_pf2",
      } as unknown as Stripe.Invoice);
      await StripeWebhookService.suspendInstancesForBilling(
        "user_pf2",
        "subscription_canceled"
      );
      await StripeWebhookService.resumeBillingSuspendedInstances("user_pf2");

      expect(payloads.length).toBeGreaterThan(0);
      for (const p of payloads) {
        if ("status" in p) {
          expect(DB_ALLOWED_STATUSES).toContain(p.status);
        }
      }
    });

    it("hands the failed invoice to the dunning-email module with the resolved user", async () => {
      const stripe = getStripe();
      (stripe.subscriptions.retrieve as jest.Mock).mockResolvedValue({
        id: "sub_pf3",
        metadata: { user_id: "user_pf3" },
      });
      mockInstanceUpdateCapture(undefined, boundSubscriptionRow("sub_pf3"));
      const invoice = {
        id: "in_pf3",
        subscription: "sub_pf3",
        attempt_count: 2,
      } as unknown as Stripe.Invoice;

      await StripeWebhookService.handlePaymentFailed(invoice);

      expect(maybeSendPaymentFailedRecoveryEmail).toHaveBeenCalledTimes(1);
      expect(maybeSendPaymentFailedRecoveryEmail).toHaveBeenCalledWith({
        invoice,
        userId: "user_pf3",
      });
    });

    it("never lets a dunning-email throw fail the webhook (Stripe would redeliver)", async () => {
      const stripe = getStripe();
      (stripe.subscriptions.retrieve as jest.Mock).mockResolvedValue({
        id: "sub_pf4",
        metadata: { user_id: "user_pf4" },
      });
      (maybeSendPaymentFailedRecoveryEmail as jest.Mock).mockRejectedValueOnce(
        new Error("resend exploded")
      );
      const payloads = mockInstanceUpdateCapture(undefined, boundSubscriptionRow("sub_pf4"));

      await expect(
        StripeWebhookService.handlePaymentFailed({
          subscription: "sub_pf4",
        } as unknown as Stripe.Invoice)
      ).resolves.toBeUndefined();

      // The suspend path still ran before the email hiccup.
      const suspend = payloads.find((p) => p.entitlement_state === "suspended");
      expect(suspend).toBeTruthy();
      expect(stringifyLoggerCalls(log.warn as jest.Mock)).toContain(
        "payment-failed recovery email errored"
      );
    });

    it("routes an already-canceled subscription through the cancel path instead of writing past_due", async () => {
      // Regression: final-retry cancellations emit invoice.payment_failed and
      // customer.subscription.deleted in the same second. The unconditional
      // past_due write used to land after the deleted handler and resurrect
      // the canceled row into the subscription-state reconciler's scan set,
      // which then reset the payer to a free/active row (2026-06→07
      // ghost-payer cohort).
      const stripe = getStripe();
      (stripe.subscriptions.retrieve as jest.Mock).mockResolvedValue({
        id: "sub_final_retry",
        status: "canceled",
        metadata: { user_id: "user_final_retry" },
      });
      const deletedSpy = jest
        .spyOn(StripeWebhookService, "handleSubscriptionDeleted")
        .mockResolvedValue(undefined);

      const subscriptionUpdates: Array<Record<string, unknown>> = [];
      (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
        const builder = createMockBuilder();
        if (table === "hermes_subscriptions") {
          builder.update.mockImplementation((payload: Record<string, unknown>) => {
            subscriptionUpdates.push(payload);
            return builder;
          });
        }
        return builder;
      });

      try {
        await StripeWebhookService.handlePaymentFailed({
          subscription: "sub_final_retry",
        } as unknown as Stripe.Invoice);

        expect(deletedSpy).toHaveBeenCalledWith(
          expect.objectContaining({ id: "sub_final_retry", status: "canceled" })
        );
        expect(
          subscriptionUpdates.find((payload) => payload.status === "past_due")
        ).toBeUndefined();
        // A canceled subscriber must not receive payment-failed dunning nudges.
        expect(maybeSendPaymentFailedRecoveryEmail).not.toHaveBeenCalled();
      } finally {
        deletedSpy.mockRestore();
      }
    });

    it("stamps a fresh 48h grace anchor on the first failure", async () => {
      const stripe = getStripe();
      (stripe.subscriptions.retrieve as jest.Mock).mockResolvedValue({
        id: "sub_first",
        status: "past_due",
        metadata: { user_id: "user_first" },
      });

      const subUpdates: Array<Record<string, unknown>> = [];
      (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
        const builder = createMockBuilder();
        if (table === "hermes_subscriptions") {
          // No prior anchor: an active row transitioning to past_due.
          builder.maybeSingle.mockResolvedValue({
            data: {
              ...boundSubscriptionRow("sub_first"),
              status: "active",
              grace_period_ends_at: null,
            },
            error: null,
          });
          builder.update.mockImplementation((payload: Record<string, unknown>) => {
            subUpdates.push(payload);
            return builder;
          });
        }
        return builder;
      });

      const before = Date.now();
      await StripeWebhookService.handlePaymentFailed({
        subscription: "sub_first",
      } as unknown as Stripe.Invoice);
      const after = Date.now();

      const pastDueWrite = subUpdates.find((p) => p.status === "past_due");
      expect(pastDueWrite).toBeTruthy();
      const stamped = Date.parse(pastDueWrite!.grace_period_ends_at as string);
      const H48 = 48 * 60 * 60 * 1000;
      expect(stamped).toBeGreaterThanOrEqual(before + H48 - 5000);
      expect(stamped).toBeLessThanOrEqual(after + H48 + 5000);
    });

    it("preserves the original grace anchor across Stripe retries (stamp-once, not reset)", async () => {
      // Stripe emits invoice.payment_failed on every smart-retry attempt.
      // Re-stamping now+48h each time would slide the keep-alive window to the
      // end of the ~2-week retry and defeat the dunning cutoff. The anchor must
      // stay pinned to the first decline.
      const stripe = getStripe();
      (stripe.subscriptions.retrieve as jest.Mock).mockResolvedValue({
        id: "sub_retry",
        status: "past_due",
        metadata: { user_id: "user_retry" },
      });

      const EXISTING_ANCHOR = "2026-07-17T00:00:00.000Z";
      const subUpdates: Array<Record<string, unknown>> = [];
      (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
        const builder = createMockBuilder();
        if (table === "hermes_subscriptions") {
          builder.maybeSingle.mockResolvedValue({
            data: {
              ...boundSubscriptionRow("sub_retry"),
              status: "past_due",
              grace_period_ends_at: EXISTING_ANCHOR,
            },
            error: null,
          });
          builder.update.mockImplementation((payload: Record<string, unknown>) => {
            subUpdates.push(payload);
            return builder;
          });
        }
        return builder;
      });

      await StripeWebhookService.handlePaymentFailed({
        subscription: "sub_retry",
      } as unknown as Stripe.Invoice);

      const pastDueWrite = subUpdates.find((p) => p.status === "past_due");
      expect(pastDueWrite).toBeTruthy();
      expect(pastDueWrite!.grace_period_ends_at).toBe(EXISTING_ANCHOR);
    });
  });

  describe("Stripe lapse while another lane still pays", () => {
    const YEARLY_POWER: EffectiveSubscription = {
      plan: "fleet",
      status: "active",
      instance_limit: PLANS.fleet.maxAgents,
      total_cpu_budget: PLANS.fleet.totalCpu,
      total_ram_budget: PLANS.fleet.totalRam,
      source: "token_yearly",
      tokenTier: "power",
      currentPeriodEnd: "2027-03-07T00:00:00.000Z",
      canChangePlanInPlace: false,
    };
    const APPLE_PRO: EffectiveSubscription = {
      plan: "operator",
      status: "active",
      instance_limit: PLANS.operator.maxAgents,
      total_cpu_budget: PLANS.operator.totalCpu,
      total_ram_budget: PLANS.operator.totalRam,
      source: "apple_iap",
      currentPeriodEnd: "2026-10-23T00:00:00.000Z",
      canChangePlanInPlace: false,
    };

    // The service loads tier-change-service lazily. doMock + import returns
    // the same mocked module the service will get, even if an earlier test
    // already registered a mock for it.
    async function mockApplyTierChange(): Promise<jest.Mock> {
      jest.doMock("@/lib/services/tier-change-service", () => ({
        applyTierChange: jest.fn(),
      }));
      const mod = await import("@/lib/services/tier-change-service");
      const applyTierChange = mod.applyTierChange as unknown as jest.Mock;
      applyTierChange.mockReset();
      applyTierChange.mockResolvedValue({
        userId: "user_1",
        newTier: "fleet",
        instancesUpdated: 1,
        resizesAttempted: 0,
        resizesSucceeded: 0,
        resizesFailed: [],
      });
      return applyTierChange;
    }

    afterEach(() => {
      jest.dontMock("@/lib/services/tier-change-service");
    });

    it("subscription.deleted keeps a yearly subscriber running on their yearly tier", async () => {
      const applyTierChange = await mockApplyTierChange();
      (resolveEffectiveSubscription as jest.Mock).mockResolvedValueOnce(YEARLY_POWER);
      const payloads = mockInstanceUpdateCapture();

      await StripeWebhookService.handleSubscriptionDeleted({
        id: "sub_1",
        metadata: { user_id: "user_1" },
      } as unknown as Stripe.Subscription);

      expect(resolveEffectiveSubscription).toHaveBeenCalledWith("user_1", {
        excludeStripe: true,
      });
      expect(payloads.find((p) => p.entitlement_state === "suspended")).toBeUndefined();
      expect(payloads.find((p) => p.status === "scheduled_for_deletion")).toBeUndefined();
      expect(applyTierChange).toHaveBeenCalledTimes(1);
      expect(applyTierChange).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "user_1", newTier: "fleet", source: "stripe" })
      );
    });

    it("subscription.deleted arms no deletion fuse under the legacy hard-delete flag", async () => {
      process.env.HERMES_BILLING_LEGACY_HARD_DELETE = "true";
      const scheduleSpy = jest
        .spyOn(StripeWebhookService, "scheduleInstancesForDeletion")
        .mockResolvedValue(undefined);
      try {
        await mockApplyTierChange();
        (resolveEffectiveSubscription as jest.Mock).mockResolvedValueOnce(YEARLY_POWER);
        mockInstanceUpdateCapture();

        await StripeWebhookService.handleSubscriptionDeleted({
          id: "sub_1",
          metadata: { user_id: "user_1" },
        } as unknown as Stripe.Subscription);

        expect(scheduleSpy).not.toHaveBeenCalled();
      } finally {
        scheduleSpy.mockRestore();
        delete process.env.HERMES_BILLING_LEGACY_HARD_DELETE;
      }
    });

    it("subscription.deleted downgrades and suspends when no other lane pays", async () => {
      const applyTierChange = await mockApplyTierChange();
      const payloads = mockInstanceUpdateCapture();

      await StripeWebhookService.handleSubscriptionDeleted({
        id: "sub_1",
        metadata: { user_id: "user_1" },
      } as unknown as Stripe.Subscription);

      expect(applyTierChange).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "user_1", newTier: "credit_base" })
      );
      expect(payloads.find((p) => p.entitlement_state === "suspended")).toMatchObject({
        entitlement_reason: "subscription_canceled",
      });
    });

    it("invoice.payment_failed does not suspend an Apple subscriber", async () => {
      const stripe = getStripe();
      (stripe.subscriptions.retrieve as jest.Mock).mockResolvedValue({
        id: "sub_pf_apple",
        status: "past_due",
        metadata: { user_id: "user_pf_apple" },
      });
      (resolveEffectiveSubscription as jest.Mock).mockResolvedValueOnce(APPLE_PRO);
      const payloads = mockInstanceUpdateCapture(undefined, boundSubscriptionRow("sub_pf_apple"));

      await StripeWebhookService.handlePaymentFailed({
        subscription: "sub_pf_apple",
      } as unknown as Stripe.Invoice);

      expect(resolveEffectiveSubscription).toHaveBeenCalledWith("user_pf_apple", {
        excludeStripe: true,
      });
      expect(payloads.find((p) => p.entitlement_state === "suspended")).toBeUndefined();
      // The card still failed, so the dunning nudge still goes out.
      expect(maybeSendPaymentFailedRecoveryEmail).toHaveBeenCalled();
    });

    it.each(["past_due", "canceled", "unpaid"] as const)(
      "subscription.updated → %s does not suspend a yearly subscriber",
      async (status) => {
        (resolveEffectiveSubscription as jest.Mock).mockResolvedValueOnce(YEARLY_POWER);
        const payloads = mockInstanceUpdateCapture();

        await StripeWebhookService.handleSubscriptionChange({
          id: "sub_lapse",
          customer: "cus_1",
          status,
          start_date: 1000,
          metadata: { user_id: "user_1", plan: "operator" },
          items: { data: [{ current_period_start: 1000, current_period_end: 2000 }] },
        } as unknown as Stripe.Subscription);

        expect(resolveEffectiveSubscription).toHaveBeenCalledWith("user_1", {
          excludeStripe: true,
        });
        expect(payloads.find((p) => p.entitlement_state === "suspended")).toBeUndefined();
      }
    );

    it("subscription.updated → past_due still suspends a Stripe-only user", async () => {
      const payloads = mockInstanceUpdateCapture();

      await StripeWebhookService.handleSubscriptionChange({
        id: "sub_lapse",
        customer: "cus_1",
        status: "past_due",
        start_date: 1000,
        metadata: { user_id: "user_1", plan: "operator" },
        items: { data: [{ current_period_start: 1000, current_period_end: 2000 }] },
      } as unknown as Stripe.Subscription);

      expect(payloads.find((p) => p.entitlement_state === "suspended")).toMatchObject({
        entitlement_reason: "subscription_past_due",
      });
    });

    it("throws for redelivery, suspending nothing, when the cross-check itself fails", async () => {
      const applyTierChange = await mockApplyTierChange();
      (resolveEffectiveSubscription as jest.Mock).mockRejectedValueOnce(
        new Error("connection reset")
      );
      const payloads = mockInstanceUpdateCapture();

      await expect(
        StripeWebhookService.handleSubscriptionDeleted({
          id: "sub_1",
          metadata: { user_id: "user_1" },
        } as unknown as Stripe.Subscription)
      ).rejects.toThrow("connection reset");

      expect(payloads.find((p) => p.entitlement_state === "suspended")).toBeUndefined();
      expect(applyTierChange).not.toHaveBeenCalled();
    });
  });

  describe("handleInvoicePaid — resume", () => {
    it("does not blanket-activate the row when the subscription is already canceled", async () => {
      // A dunning email can collect an open invoice after Stripe canceled the
      // subscription; writing status='active' here would resurrect a canceled
      // (or reconciler-reset free) row with no plan/sub id attached.
      const stripe = getStripe();
      (stripe.subscriptions.retrieve as jest.Mock).mockResolvedValue({
        id: "sub_dead",
        status: "canceled",
        metadata: { user_id: "user_dead", plan: "operator" },
        items: { data: [{ current_period_start: 1000, current_period_end: 2000 }] },
      });

      const subscriptionUpdates: Array<Record<string, unknown>> = [];
      (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
        const builder = createMockBuilder();
        if (table === "hermes_subscriptions") {
          builder.update.mockImplementation((payload: Record<string, unknown>) => {
            subscriptionUpdates.push(payload);
            return builder;
          });
        }
        return builder;
      });

      await StripeWebhookService.handleInvoicePaid({
        subscription: "sub_dead",
      } as unknown as Stripe.Invoice);

      expect(subscriptionUpdates).toHaveLength(0);
      expect(grantSubscriptionCycleCredits).not.toHaveBeenCalled();
      expect(log.error).toHaveBeenCalledWith(
        expect.stringContaining("invoice.paid for a canceled subscription"),
        expect.anything(),
        expect.objectContaining({
          failureType: "invoice_paid_after_cancellation",
          subscriptionId: "sub_dead",
          userId: "user_dead",
        })
      );
    });

    it("resumes billing-suspended instances when payment recovers", async () => {
      const stripe = getStripe();
      (stripe.subscriptions.retrieve as jest.Mock).mockResolvedValue({
        id: "sub_ok",
        metadata: { user_id: "user_ok" },
      });
      const payloads = mockInstanceUpdateCapture(undefined, boundSubscriptionRow("sub_ok"));

      await StripeWebhookService.handleInvoicePaid({
        subscription: "sub_ok",
      } as unknown as Stripe.Invoice);

      const resume = payloads.find((p) => p.entitlement_state === "ok");
      expect(resume).toMatchObject({
        status: "running",
        lifecycle_state: "active",
        entitlement_state: "ok",
        entitlement_suspended_at: null,
        scheduled_deletion_at: null,
      });
    });

    it("advances current_period_start/end on the renewal so the dashboard isn't stuck on a past renewal date", async () => {
      const stripe = getStripe();
      (stripe.subscriptions.retrieve as jest.Mock).mockResolvedValue({
        id: "sub_renew",
        // no plan key → skip cycle-credit grant; this test isolates the period write
        metadata: { user_id: "user_renew" },
        items: { data: [{ current_period_start: 1000, current_period_end: 2000 }] },
      });

      let subscriptionUpdate: Record<string, unknown> | undefined;
      (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
        const builder = createMockBuilder();
        if (table === "hermes_subscriptions") {
          builder.maybeSingle.mockResolvedValue({
            data: boundSubscriptionRow("sub_renew"),
            error: null,
          });
          builder.update.mockImplementation((payload: Record<string, unknown>) => {
            subscriptionUpdate = payload;
            return builder;
          });
        }
        return builder;
      });

      await StripeWebhookService.handleInvoicePaid({
        subscription: "sub_renew",
      } as unknown as Stripe.Invoice);

      expect(subscriptionUpdate).toMatchObject({
        status: "active",
        grace_period_ends_at: null,
        current_period_start: new Date(1000 * 1000).toISOString(),
        current_period_end: new Date(2000 * 1000).toISOString(),
      });
    });
  });

  // invoice.paid / invoice.payment_failed carry no lane marker of their own:
  // the lane lives on the subscription's metadata, which the handlers only see
  // after retrieving it. These events used to write hermes_subscriptions by
  // user id alone, so a Workspace Cloud invoice could activate (or suspend) a
  // Hivra plan row it had nothing to do with. Fixtures cover both lanes and an
  // abandoned Hivra checkout row that already carries a paid plan's limits.
  describe("invoice events stay in their billing lane", () => {
    type RecordedWrite = {
      table: string;
      op: "update" | "upsert";
      payload: Record<string, unknown>;
      filters: Array<[string, unknown]>;
    };

    const USER = "user_lane";

    // Pending row written by /api/billing/subscribe for a Fleet checkout that
    // was never paid: it already carries Fleet's limits, only status gates it.
    const ABANDONED_FLEET_ROW = {
      plan: "fleet",
      status: "pending",
      stripe_subscription_id: null,
      grace_period_ends_at: null,
      instance_limit: PLANS.fleet.maxAgents,
    };
    // Same abandoned checkout, on a row that kept an earlier Hivra
    // subscription id (cancellation keeps plan + sub id on the row).
    const ABANDONED_FLEET_ROW_WITH_OLD_SUB = {
      ...ABANDONED_FLEET_ROW,
      stripe_subscription_id: "sub_hivra_old",
    };
    const ACTIVE_OPERATOR_ROW = {
      plan: "operator",
      status: "active",
      stripe_subscription_id: "sub_hivra",
      grace_period_ends_at: null,
      instance_limit: PLANS.operator.maxAgents,
    };

    function workspaceCloudSubscription(
      status: Stripe.Subscription.Status
    ): Stripe.Subscription {
      return {
        id: "sub_wc",
        status,
        customer: "cus_shared",
        // Exactly what /api/workspace-cloud/billing/subscribe stamps.
        metadata: {
          user_id: USER,
          plan: "ws_cloud_pro",
          cadence: "monthly",
          surface: "workspace_cloud",
        },
        items: {
          data: [
            {
              price: { id: "price_shared_operator" },
              current_period_start: 1000,
              current_period_end: 2000,
            },
          ],
        },
      } as unknown as Stripe.Subscription;
    }

    function hivraSubscription(
      id: string,
      plan: string,
      status: Stripe.Subscription.Status = "active"
    ): Stripe.Subscription {
      return {
        id,
        status,
        customer: "cus_shared",
        metadata: { user_id: USER, plan, cadence: "monthly" },
        items: {
          data: [
            {
              price: { id: "price_shared_operator" },
              current_period_start: 1000,
              current_period_end: 2000,
            },
          ],
        },
      } as unknown as Stripe.Subscription;
    }

    function mockBillingTables(
      hermesRow: Record<string, unknown> | null,
      readError: { message: string } | null = null
    ) {
      const writes: RecordedWrite[] = [];
      (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
        const builder = createMockBuilder();
        let current: RecordedWrite | null = null;
        const record =
          (op: RecordedWrite["op"]) => (payload: Record<string, unknown>) => {
            current = { table, op, payload, filters: [] };
            writes.push(current);
            return builder;
          };
        builder.update.mockImplementation(record("update"));
        builder.upsert.mockImplementation(record("upsert"));
        builder.eq.mockImplementation((column: string, value: unknown) => {
          current?.filters.push([column, value]);
          return builder;
        });
        if (table === "hermes_subscriptions") {
          builder.maybeSingle.mockImplementation(() =>
            Promise.resolve({ data: readError ? null : hermesRow, error: readError })
          );
        }
        return builder;
      });
      return {
        writes,
        to: (table: string) => writes.filter((w) => w.table === table),
      };
    }

    function retrieveReturns(subscription: Stripe.Subscription) {
      const stripe = getStripe();
      (stripe.subscriptions.retrieve as jest.Mock).mockResolvedValue(subscription);
    }

    function invoiceFor(subscriptionId: string): Stripe.Invoice {
      return { id: `in_${subscriptionId}`, subscription: subscriptionId } as unknown as Stripe.Invoice;
    }

    describe("Workspace Cloud subscription", () => {
      it.each([
        ["with no Stripe subscription", ABANDONED_FLEET_ROW],
        ["that kept an old Hivra subscription id", ABANDONED_FLEET_ROW_WITH_OLD_SUB],
      ])(
        "invoice.paid never activates an abandoned Hivra Fleet row %s",
        async (_label, hermesRow) => {
          retrieveReturns(workspaceCloudSubscription("active"));
          const db = mockBillingTables(hermesRow);

          await StripeWebhookService.handleInvoicePaid(invoiceFor("sub_wc"));

          expect(db.to("hermes_subscriptions")).toEqual([]);
          expect(db.to("hermes_instances")).toEqual([]);
          expect(grantSubscriptionCycleCredits).not.toHaveBeenCalled();
          // The payment still lands on the lane's own row.
          expect(db.to("workspace_cloud_subscriptions")).toEqual([
            expect.objectContaining({
              op: "upsert",
              payload: expect.objectContaining({
                user_id: USER,
                plan: "ws_cloud_pro",
                status: "active",
                stripe_subscription_id: "sub_wc",
              }),
            }),
          ]);
        }
      );

      it("invoice.payment_failed never marks the Hivra row past_due or suspends Hivra computers", async () => {
        retrieveReturns(workspaceCloudSubscription("past_due"));
        const db = mockBillingTables(ACTIVE_OPERATOR_ROW);

        await StripeWebhookService.handlePaymentFailed(invoiceFor("sub_wc"));

        expect(db.to("hermes_subscriptions")).toEqual([]);
        expect(db.to("hermes_instances")).toEqual([]);
        expect(maybeSendPaymentFailedRecoveryEmail).not.toHaveBeenCalled();
        expect(db.to("workspace_cloud_subscriptions")).toEqual([
          expect.objectContaining({
            op: "upsert",
            payload: expect.objectContaining({
              user_id: USER,
              status: "past_due",
              stripe_subscription_id: "sub_wc",
            }),
          }),
        ]);
      });

      it("invoice.payment_failed on a canceled lane subscription cancels only the lane row", async () => {
        retrieveReturns(workspaceCloudSubscription("canceled"));
        const deletedSpy = jest.spyOn(StripeWebhookService, "handleSubscriptionDeleted");
        const db = mockBillingTables(ACTIVE_OPERATOR_ROW);

        try {
          await StripeWebhookService.handlePaymentFailed(invoiceFor("sub_wc"));

          expect(deletedSpy).not.toHaveBeenCalled();
          expect(db.to("hermes_subscriptions")).toEqual([]);
          expect(db.to("hermes_instances")).toEqual([]);
          expect(db.to("workspace_cloud_subscriptions")).toEqual([
            expect.objectContaining({
              op: "update",
              payload: expect.objectContaining({ status: "canceled" }),
              filters: [["stripe_subscription_id", "sub_wc"]],
            }),
          ]);
        } finally {
          deletedSpy.mockRestore();
        }
      });
    });

    describe("Hivra subscription", () => {
      it.each([
        ["an abandoned row with no subscription", ABANDONED_FLEET_ROW],
        ["a row bound to another subscription", ACTIVE_OPERATOR_ROW],
      ])(
        "invoice.paid leaves %s untouched",
        async (_label, hermesRow) => {
          retrieveReturns(hivraSubscription("sub_hivra_unbound", "fleet"));
          const db = mockBillingTables(hermesRow);

          await StripeWebhookService.handleInvoicePaid(invoiceFor("sub_hivra_unbound"));

          expect(db.to("hermes_subscriptions")).toEqual([]);
          expect(db.to("hermes_instances")).toEqual([]);
          expect(log.warn).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({
              failureType: "invoice_subscription_not_bound",
              subscriptionId: "sub_hivra_unbound",
              userId: USER,
            })
          );
        }
      );

      it("invoice.paid does not activate a bound row that carries another plan's limits", async () => {
        // The abandoned Fleet checkout kept the old Operator subscription id.
        // Paying that Operator subscription must not switch the Fleet limits
        // on; customer.subscription.updated rewrites the plan from Stripe.
        retrieveReturns(hivraSubscription("sub_hivra_old", "operator"));
        const db = mockBillingTables(ABANDONED_FLEET_ROW_WITH_OLD_SUB);

        await StripeWebhookService.handleInvoicePaid(invoiceFor("sub_hivra_old"));

        expect(db.to("hermes_subscriptions")).toEqual([]);
        expect(db.to("hermes_instances")).toEqual([]);
        expect(log.warn).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            failureType: "invoice_paid_plan_mismatch",
            subscriptionId: "sub_hivra_old",
            rowPlan: "fleet",
            subscriptionPlan: "operator",
          })
        );
      });

      it("invoice.paid activates only the row bound to that exact subscription", async () => {
        retrieveReturns(hivraSubscription("sub_hivra", "operator"));
        const db = mockBillingTables({ ...ACTIVE_OPERATOR_ROW, status: "past_due" });

        await StripeWebhookService.handleInvoicePaid(invoiceFor("sub_hivra"));

        expect(db.to("hermes_subscriptions")).toEqual([
          expect.objectContaining({
            op: "update",
            payload: expect.objectContaining({ status: "active", grace_period_ends_at: null }),
            filters: expect.arrayContaining([
              ["user_id", USER],
              ["stripe_subscription_id", "sub_hivra"],
            ]),
          }),
        ]);
        // Payment recovered: the bound row's billing-suspended computers resume.
        expect(
          db.to("hermes_instances").find((w) => w.payload.entitlement_state === "ok")
        ).toBeTruthy();
        expect(grantSubscriptionCycleCredits).toHaveBeenCalledWith(
          expect.objectContaining({ userId: USER, planKey: "operator", subscriptionId: "sub_hivra" })
        );
        expect(db.to("workspace_cloud_subscriptions")).toEqual([]);
      });

      it("invoice.payment_failed for a subscription not bound to the row leaves the row and computers alone", async () => {
        retrieveReturns(hivraSubscription("sub_hivra_stale", "operator", "past_due"));
        const db = mockBillingTables(ACTIVE_OPERATOR_ROW);

        await StripeWebhookService.handlePaymentFailed(invoiceFor("sub_hivra_stale"));

        expect(db.to("hermes_subscriptions")).toEqual([]);
        expect(db.to("hermes_instances")).toEqual([]);
        expect(maybeSendPaymentFailedRecoveryEmail).not.toHaveBeenCalled();
        expect(log.warn).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            failureType: "invoice_subscription_not_bound",
            subscriptionId: "sub_hivra_stale",
            userId: USER,
          })
        );
      });

      it("a failed row read throws for Stripe redelivery instead of dropping a real renewal", async () => {
        retrieveReturns(hivraSubscription("sub_hivra", "operator"));
        const db = mockBillingTables(null, { message: "connection reset" });

        await expect(
          StripeWebhookService.handleInvoicePaid(invoiceFor("sub_hivra"))
        ).rejects.toThrow("connection reset");

        expect(db.to("hermes_subscriptions")).toEqual([]);
        expect(db.to("hermes_instances")).toEqual([]);
      });

      it("invoice.payment_failed marks only the row bound to that exact subscription past_due", async () => {
        retrieveReturns(hivraSubscription("sub_hivra", "operator", "past_due"));
        const db = mockBillingTables(ACTIVE_OPERATOR_ROW);

        await StripeWebhookService.handlePaymentFailed(invoiceFor("sub_hivra"));

        expect(db.to("hermes_subscriptions")).toEqual([
          expect.objectContaining({
            op: "update",
            payload: expect.objectContaining({ status: "past_due" }),
            filters: expect.arrayContaining([
              ["user_id", USER],
              ["stripe_subscription_id", "sub_hivra"],
            ]),
          }),
        ]);
        expect(
          db.to("hermes_instances").find((w) => w.payload.entitlement_state === "suspended")
        ).toBeTruthy();
        expect(maybeSendPaymentFailedRecoveryEmail).toHaveBeenCalledTimes(1);
        expect(db.to("workspace_cloud_subscriptions")).toEqual([]);
      });
    });
  });

  describe("instance deletion scheduling", () => {
    it("starts shutdowns concurrently before awaiting the first one", async () => {
      const shutdownServerMock = shutdownServer as jest.MockedFunction<typeof shutdownServer>;
      const firstShutdown = createDeferredPromise<{ action: { id: number } }>();
      const secondShutdown = createDeferredPromise<{ action: { id: number } }>();
      shutdownServerMock
        .mockImplementationOnce(() => firstShutdown.promise)
        .mockImplementationOnce(() => secondShutdown.promise);

      const updatedInstanceIds: string[] = [];
      const updatedHostIds: string[] = [];

      (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
        const builder = createMockBuilder();
        if (table === "hermes_instances") {
          builder.select.mockImplementation(() => {
            const selectBuilder = createMockBuilder();
            selectBuilder.eq.mockImplementation(() => selectBuilder);
            selectBuilder.not.mockImplementation(() => selectBuilder);
            selectBuilder.then = (resolve: (value: unknown) => void) =>
              resolve({
                data: [
                  { id: "inst_1", host_id: "host_1", hetzner_server_id: "srv_1", status: "running" },
                  { id: "inst_2", host_id: "host_2", hetzner_server_id: "srv_2", status: "running" },
                ],
                error: null,
              });
            return selectBuilder;
          });

          builder.update.mockImplementation(() => {
            const updateBuilder = createMockBuilder();
            updateBuilder.eq.mockImplementation((_: string, value: string) => {
              updatedInstanceIds.push(value);
              return Promise.resolve({ error: null });
            });
            return updateBuilder;
          });
        }

        if (table === "hermes_hosts") {
          builder.update.mockImplementation(() => {
            const updateBuilder = createMockBuilder();
            updateBuilder.eq.mockImplementation((_: string, value: string) => {
              updatedHostIds.push(value);
              return Promise.resolve({ error: null });
            });
            return updateBuilder;
          });
        }
        return builder;
      });

      const pending = StripeWebhookService.scheduleInstancesForDeletion("user_1");
      await flushAsyncStart();

      expect(shutdownServerMock).toHaveBeenCalledTimes(2);

      firstShutdown.resolve({ action: { id: 1 } });
      secondShutdown.resolve({ action: { id: 2 } });
      await pending;

      expect(updatedInstanceIds).toEqual(expect.arrayContaining(["inst_1", "inst_2"]));
      expect(updatedHostIds).toEqual(expect.arrayContaining(["host_1", "host_2"]));
    });

    it("deduplicates shared-host shutdowns and host sync writes", async () => {
      const shutdownServerMock = shutdownServer as jest.MockedFunction<typeof shutdownServer>;
      shutdownServerMock.mockResolvedValue({ action: { id: 1 } });

      const updatedInstanceIds: string[] = [];
      const updatedHostIds: string[] = [];

      (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
        const builder = createMockBuilder();
        if (table === "hermes_instances") {
          builder.select.mockImplementation(() => {
            const selectBuilder = createMockBuilder();
            selectBuilder.eq.mockImplementation(() => selectBuilder);
            selectBuilder.not.mockImplementation(() => selectBuilder);
            selectBuilder.then = (resolve: (value: unknown) => void) =>
              resolve({
                data: [
                  {
                    id: "inst_1",
                    host_id: "host_1",
                    hetzner_server_id: "srv_1",
                    status: "running",
                    scheduled_deletion_at: null,
                  },
                  {
                    id: "inst_2",
                    host_id: "host_1",
                    hetzner_server_id: "srv_1",
                    status: "running",
                    scheduled_deletion_at: null,
                  },
                ],
                error: null,
              });
            return selectBuilder;
          });

          builder.update.mockImplementation(() => {
            const updateBuilder = createMockBuilder();
            updateBuilder.eq.mockImplementation((_: string, value: string) => {
              updatedInstanceIds.push(value);
              return Promise.resolve({ error: null });
            });
            return updateBuilder;
          });
        }

        if (table === "hermes_hosts") {
          builder.update.mockImplementation(() => {
            const updateBuilder = createMockBuilder();
            updateBuilder.eq.mockImplementation((_: string, value: string) => {
              updatedHostIds.push(value);
              return Promise.resolve({ error: null });
            });
            return updateBuilder;
          });
        }
        return builder;
      });

      await StripeWebhookService.scheduleInstancesForDeletion("user_1");

      expect(shutdownServerMock).toHaveBeenCalledTimes(1);
      expect(updatedHostIds).toEqual(["host_1"]);
      expect(updatedInstanceIds).toEqual(expect.arrayContaining(["inst_1", "inst_2"]));
    });

    it("redacts shutdown errors before logging them", async () => {
      (log.error as jest.Mock).mockClear();
      const shutdownServerMock = shutdownServer as jest.MockedFunction<typeof shutdownServer>;
      shutdownServerMock.mockRejectedValue({
        name: "ShutdownFailure",
        message: "shutdown-secret-leak",
        stack: "shutdown-stack-leak",
      });

      (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
        const builder = createMockBuilder();
        if (table === "hermes_instances") {
          builder.select.mockImplementation(() => {
            const selectBuilder = createMockBuilder();
            selectBuilder.eq.mockImplementation(() => selectBuilder);
            selectBuilder.not.mockImplementation(() => selectBuilder);
            selectBuilder.then = (resolve: (value: unknown) => void) =>
              resolve({
                data: [{ id: "inst_1", hetzner_server_id: "srv_1", status: "running" }],
                error: null,
              });
            return selectBuilder;
          });

          builder.update.mockImplementation(() => ({
            eq: jest.fn().mockResolvedValue({ error: null }),
          }));
        }
        return builder;
      });

      await StripeWebhookService.scheduleInstancesForDeletion("user_1");

      expect(log.error).toHaveBeenCalledWith(
        "failed to shutdown hetzner server",
        expect.anything(),
        expect.objectContaining({
          source: "stripe-webhook-service",
          failureType: "instance_server_transition_failed",
          action: "shutdown",
          hetznerServerId: "srv_1",
        })
      );
      const contextCalls = (log.error as jest.Mock).mock.calls.map((call) => call[2]);
      const stringifiedContext = JSON.stringify(contextCalls);
      expect(stringifiedContext).not.toContain("shutdown-secret-leak");
      expect(stringifiedContext).not.toContain("shutdown-stack-leak");
    });

    it("still marks the row scheduled_for_deletion when Hetzner shutdown fails — purge cron converges later", async () => {
      // Regression: 2026-04-29 trial cohort. Hetzner shutdown threw on
      // some subscriptions (e.g. already-off VMs from a prior delivery
      // of the same webhook); old behavior returned early so the DB
      // row stayed 'running' forever and purge-expired (which filters
      // status='scheduled_for_deletion') never picked them up. Result:
      // canceled trials with phantom VMs accumulating Hetzner billing.
      (log.error as jest.Mock).mockClear();
      const shutdownServerMock = shutdownServer as jest.MockedFunction<typeof shutdownServer>;
      shutdownServerMock.mockRejectedValue({
        name: "ShutdownFailure",
        message: "shutdown-secret-leak",
        stack: "shutdown-stack-leak",
      });

      const updatedInstanceIds: string[] = [];
      const updatedHostIds: string[] = [];

      (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
        const builder = createMockBuilder();
        if (table === "hermes_instances") {
          builder.select.mockImplementation(() => {
            const selectBuilder = createMockBuilder();
            selectBuilder.eq.mockImplementation(() => selectBuilder);
            selectBuilder.not.mockImplementation(() => selectBuilder);
            selectBuilder.then = (resolve: (value: unknown) => void) =>
              resolve({
                data: [
                  {
                    id: "inst_1",
                    host_id: "host_1",
                    hetzner_server_id: "srv_1",
                    status: "running",
                    scheduled_deletion_at: null,
                  },
                ],
                error: null,
              });
            return selectBuilder;
          });

          builder.update.mockImplementation(() => {
            const updateBuilder = createMockBuilder();
            updateBuilder.eq.mockImplementation((_: string, value: string) => {
              updatedInstanceIds.push(value);
              return Promise.resolve({ error: null });
            });
            return updateBuilder;
          });
        }

        if (table === "hermes_hosts") {
          builder.update.mockImplementation(() => {
            const updateBuilder = createMockBuilder();
            updateBuilder.eq.mockImplementation((_: string, value: string) => {
              updatedHostIds.push(value);
              return Promise.resolve({ error: null });
            });
            return updateBuilder;
          });
        }
        return builder;
      });

      await StripeWebhookService.scheduleInstancesForDeletion("user_1");

      expect(updatedInstanceIds).toEqual(["inst_1"]);
      expect(updatedHostIds).toEqual(["host_1"]);
      expect(log.error).toHaveBeenCalledWith(
        "failed to shutdown hetzner server",
        expect.anything(),
        expect.objectContaining({
          source: "stripe-webhook-service",
          failureType: "instance_server_transition_failed",
          action: "shutdown",
          hetznerServerId: "srv_1",
        })
      );
      const contextCalls = (log.error as jest.Mock).mock.calls.map((call) => call[2]);
      expect(JSON.stringify(contextCalls)).not.toContain("shutdown-secret-leak");
    });

    it("redacts unexpected instance update errors before logging them", async () => {
      (log.error as jest.Mock).mockClear();
      const shutdownServerMock = shutdownServer as jest.MockedFunction<typeof shutdownServer>;
      shutdownServerMock.mockResolvedValue({ action: { id: 1 } });

      (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
        const builder = createMockBuilder();
        if (table === "hermes_instances") {
          builder.select.mockImplementation(() => {
            const selectBuilder = createMockBuilder();
            selectBuilder.eq.mockImplementation(() => selectBuilder);
            selectBuilder.not.mockImplementation(() => selectBuilder);
            selectBuilder.then = (resolve: (value: unknown) => void) =>
              resolve({
                data: [{ id: "inst_1", hetzner_server_id: "srv_1", status: "running" }],
                error: null,
              });
            return selectBuilder;
          });

          builder.update.mockImplementation(() => ({
            eq: jest.fn().mockRejectedValue({
              name: "InstanceUpdateFailure",
              message: "instance-update-secret-leak",
              stack: "instance-update-stack-leak",
            }),
          }));
        }
        return builder;
      });

      await StripeWebhookService.scheduleInstancesForDeletion("user_1");

      expect(log.error).toHaveBeenCalledWith(
        "failed to soft-delete instance instance lifecycle row",
        expect.anything(),
        expect.objectContaining({
          source: "stripe-webhook-service",
          failureType: "instance_state_update_failed",
          action: "soft-delete instance",
          instanceId: "inst_1",
        })
      );
      const contextCalls = (log.error as jest.Mock).mock.calls.map((call) => call[2]);
      const stringifiedContext = JSON.stringify(contextCalls);
      expect(stringifiedContext).not.toContain("instance-update-secret-leak");
      expect(stringifiedContext).not.toContain("instance-update-stack-leak");
    });

    it("still updates instance rows when the shared host sync fails after shutdown succeeds", async () => {
      (log.error as jest.Mock).mockClear();
      const shutdownServerMock = shutdownServer as jest.MockedFunction<typeof shutdownServer>;
      shutdownServerMock.mockResolvedValue({ action: { id: 1 } });
      const updatedInstanceIds: string[] = [];

      (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
        const builder = createMockBuilder();
        if (table === "hermes_instances") {
          builder.select.mockImplementation(() => {
            const selectBuilder = createMockBuilder();
            selectBuilder.eq.mockImplementation(() => selectBuilder);
            selectBuilder.not.mockImplementation(() => selectBuilder);
            selectBuilder.then = (resolve: (value: unknown) => void) =>
              resolve({
                data: [
                  {
                    id: "inst_1",
                    host_id: "host_1",
                    hetzner_server_id: "srv_1",
                    status: "running",
                    scheduled_deletion_at: null,
                  },
                ],
                error: null,
              });
            return selectBuilder;
          });

          builder.update.mockImplementation(() => {
            const updateBuilder = createMockBuilder();
            updateBuilder.eq.mockImplementation((_: string, value: string) => {
              updatedInstanceIds.push(value);
              return Promise.resolve({ error: null });
            });
            return updateBuilder;
          });
        }

        if (table === "hermes_hosts") {
          builder.update.mockImplementation(() => {
            const updateBuilder = createMockBuilder();
            updateBuilder.eq.mockResolvedValue({
              error: {
                message: "host-update-secret-leak",
              },
            });
            return updateBuilder;
          });
        }

        return builder;
      });

      await StripeWebhookService.scheduleInstancesForDeletion("user_1");

      expect(updatedInstanceIds).toEqual(["inst_1"]);
      expect(log.error).toHaveBeenCalledWith(
        "failed to sync host lifecycle state",
        expect.anything(),
        expect.objectContaining({
          source: "stripe-webhook-service",
          failureType: "host_state_update_failed",
          action: "soft-delete instance",
          hostId: "host_1",
        })
      );
      const contextCalls = (log.error as jest.Mock).mock.calls.map((call) => call[2]);
      const stringifiedContext = JSON.stringify(contextCalls);
      expect(stringifiedContext).not.toContain("host-update-secret-leak");
      expect(stringifiedContext).not.toContain("host-update-stack-leak");
    });
  });

  describe("scheduled deletion restoration", () => {
    it("starts power-ons concurrently before awaiting the first one", async () => {
      const powerOnServerMock = powerOnServer as jest.MockedFunction<typeof powerOnServer>;
      const firstPowerOn = createDeferredPromise<{ action: { id: number } }>();
      const secondPowerOn = createDeferredPromise<{ action: { id: number } }>();
      powerOnServerMock
        .mockImplementationOnce(() => firstPowerOn.promise)
        .mockImplementationOnce(() => secondPowerOn.promise);

      const updatedInstanceIds: string[] = [];
      const updatedHostIds: string[] = [];

      (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
        const builder = createMockBuilder();
        if (table === "hermes_instances") {
          builder.select.mockImplementation(() => {
            const selectBuilder = createMockBuilder();
            selectBuilder.eq.mockImplementation(() => selectBuilder);
            selectBuilder.then = (resolve: (value: unknown) => void) =>
              resolve({
                data: [
                  { id: "inst_1", name: "Atlas", host_id: "host_1", hetzner_server_id: "srv_1" },
                  { id: "inst_2", name: "Boreal", host_id: "host_2", hetzner_server_id: "srv_2" },
                ],
                error: null,
              });
            return selectBuilder;
          });

          builder.update.mockImplementation(() => {
            const updateBuilder = createMockBuilder();
            updateBuilder.eq.mockImplementation((_: string, value: string) => {
              updatedInstanceIds.push(value);
              return Promise.resolve({ error: null });
            });
            return updateBuilder;
          });
        }

        if (table === "hermes_hosts") {
          builder.update.mockImplementation(() => {
            const updateBuilder = createMockBuilder();
            updateBuilder.eq.mockImplementation((_: string, value: string) => {
              updatedHostIds.push(value);
              return Promise.resolve({ error: null });
            });
            return updateBuilder;
          });
        }
        return builder;
      });

      const pending = StripeWebhookService.restoreScheduledDeletions("user_1");
      await flushAsyncStart();

      expect(powerOnServerMock).toHaveBeenCalledTimes(2);

      firstPowerOn.resolve({ action: { id: 1 } });
      secondPowerOn.resolve({ action: { id: 2 } });
      await pending;

      expect(updatedInstanceIds).toEqual(expect.arrayContaining(["inst_1", "inst_2"]));
      expect(updatedHostIds).toEqual(expect.arrayContaining(["host_1", "host_2"]));
    });

    it("still restores instance rows when the shared host sync fails after power-on succeeds", async () => {
      (log.error as jest.Mock).mockClear();
      const powerOnServerMock = powerOnServer as jest.MockedFunction<typeof powerOnServer>;
      powerOnServerMock.mockResolvedValue({ action: { id: 1 } });
      const updatedInstanceIds: string[] = [];

      (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
        const builder = createMockBuilder();
        if (table === "hermes_instances") {
          builder.select.mockImplementation(() => {
            const selectBuilder = createMockBuilder();
            selectBuilder.eq.mockImplementation(() => selectBuilder);
            selectBuilder.then = (resolve: (value: unknown) => void) =>
              resolve({
                data: [
                  {
                    id: "inst_1",
                    name: "Atlas",
                    host_id: "host_1",
                    hetzner_server_id: "srv_1",
                    status: "scheduled_for_deletion",
                    scheduled_deletion_at: "2026-04-23T06:00:00.000Z",
                  },
                ],
                error: null,
              });
            return selectBuilder;
          });

          builder.update.mockImplementation(() => {
            const updateBuilder = createMockBuilder();
            updateBuilder.eq.mockImplementation((_: string, value: string) => {
              updatedInstanceIds.push(value);
              return Promise.resolve({ error: null });
            });
            return updateBuilder;
          });
        }

        if (table === "hermes_hosts") {
          builder.update.mockImplementation(() => {
            const updateBuilder = createMockBuilder();
            updateBuilder.eq.mockResolvedValue({
              error: {
                message: "host-update-secret-leak",
              },
            });
            return updateBuilder;
          });
        }

        return builder;
      });

      await StripeWebhookService.restoreScheduledDeletions("user_1");

      expect(updatedInstanceIds).toEqual(["inst_1"]);
      expect(log.error).toHaveBeenCalledWith(
        "failed to sync host lifecycle state",
        expect.anything(),
        expect.objectContaining({
          source: "stripe-webhook-service",
          failureType: "host_state_update_failed",
          action: "restore",
          hostId: "host_1",
        })
      );
      const contextCalls = (log.error as jest.Mock).mock.calls.map((call) => call[2]);
      expect(JSON.stringify(contextCalls)).not.toContain("host-update-secret-leak");
    });

    it("still flips status back to running when Hetzner powerOn fails — without this, purge cron would delete a reactivated subscription's instance", async () => {
      (log.error as jest.Mock).mockClear();
      const powerOnServerMock = powerOnServer as jest.MockedFunction<typeof powerOnServer>;
      powerOnServerMock.mockRejectedValue({
        name: "PowerOnFailure",
        message: "poweron-secret-leak",
        stack: "poweron-stack-leak",
      });
      const updatedInstanceIds: string[] = [];

      (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
        const builder = createMockBuilder();
        if (table === "hermes_instances") {
          builder.select.mockImplementation(() => {
            const selectBuilder = createMockBuilder();
            selectBuilder.eq.mockImplementation(() => selectBuilder);
            selectBuilder.then = (resolve: (value: unknown) => void) =>
              resolve({
                data: [
                  {
                    id: "inst_1",
                    name: "Atlas",
                    host_id: "host_1",
                    hetzner_server_id: "srv_1",
                    status: "scheduled_for_deletion",
                    scheduled_deletion_at: "2026-04-23T06:00:00.000Z",
                  },
                ],
                error: null,
              });
            return selectBuilder;
          });

          builder.update.mockImplementation(() => {
            const updateBuilder = createMockBuilder();
            updateBuilder.eq.mockImplementation((_: string, value: string) => {
              updatedInstanceIds.push(value);
              return Promise.resolve({ error: null });
            });
            return updateBuilder;
          });
        }
        if (table === "hermes_hosts") {
          builder.update.mockImplementation(() => {
            const updateBuilder = createMockBuilder();
            updateBuilder.eq.mockResolvedValue({ error: null });
            return updateBuilder;
          });
        }
        return builder;
      });

      await StripeWebhookService.restoreScheduledDeletions("user_1");

      expect(updatedInstanceIds).toEqual(["inst_1"]);
      const contextCalls = (log.error as jest.Mock).mock.calls.map((call) => call[2]);
      expect(JSON.stringify(contextCalls)).not.toContain("poweron-secret-leak");
    });
  });

  describe("triggerHetznerDiskExpansion", () => {
    it("redacts unexpected Hetzner failures before logging them", async () => {
      (log.error as jest.Mock).mockClear();
      const getServerMock = getServer as jest.MockedFunction<typeof getServer>;
      const changeServerTypeMock = changeServerType as jest.MockedFunction<typeof changeServerType>;
      const waitForActionMock = waitForAction as jest.MockedFunction<typeof waitForAction>;

      getServerMock.mockRejectedValue({
        name: "HetznerLookupFailure",
        message: "hetzner-secret-leak",
        stack: "hetzner-stack-leak",
      });
      changeServerTypeMock.mockResolvedValue({ action: { id: 2 } } as never);
      waitForActionMock.mockResolvedValue(undefined as never);

      await expect(
        StripeWebhookService.triggerHetznerDiskExpansion("inst_123", 123)
      ).rejects.toBeDefined();

      expect(log.error).toHaveBeenCalledWith(
        "hetzner disk expansion failed",
        expect.anything(),
        expect.objectContaining({
          source: "stripe-webhook-service",
          failureType: "hetzner_disk_expansion_failed",
          instanceId: "inst_123",
        })
      );
      const contextCalls = (log.error as jest.Mock).mock.calls.map((call) => call[2]);
      const stringifiedContext = JSON.stringify(contextCalls);
      expect(stringifiedContext).not.toContain("hetzner-secret-leak");
      expect(stringifiedContext).not.toContain("hetzner-stack-leak");
    });
  });
});
