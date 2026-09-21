/**
 * Guard sweep: the Stripe reconcilers must be provably unable to touch Apple
 * lane rows. The lanes are separated at the TABLE level, so the proof is that
 * a full reconcile pass over stranded Stripe rows never issues a single query
 * against apple_iap_subscriptions / apple_iap_account_tokens /
 * apple_webhook_events — even while it reconciles rows to canceled.
 *
 * If someone ever adds a join or a cross-lane cleanup to either reconciler,
 * these tests fail loudly before the change can reach an Apple subscriber.
 */

import type Stripe from "stripe";

import { reconcileSubscriptionGrace } from "@/lib/billing/subscription-grace-reconciler";
import { reconcileSubscriptionState } from "@/lib/billing/subscription-state-reconciler";
import { supabaseAdmin } from "@/lib/supabase";
import { getStripe } from "@/lib/stripe";

jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: { from: jest.fn(), rpc: jest.fn() },
}));

jest.mock("@/lib/stripe", () => ({
  getStripe: jest.fn(),
}));

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

jest.mock("@/lib/services/stripe-webhook-service", () => ({
  StripeWebhookService: {
    handleSubscriptionDeleted: jest.fn().mockResolvedValue(undefined),
    handleSubscriptionChange: jest.fn().mockResolvedValue(undefined),
  },
}));

const APPLE_TABLES = [
  "apple_iap_subscriptions",
  "apple_iap_account_tokens",
  "apple_webhook_events",
];

const fromMock = supabaseAdmin!.from as jest.Mock;
const rpcMock = (supabaseAdmin as unknown as { rpc: jest.Mock }).rpc;

function tablesQueried(): string[] {
  return fromMock.mock.calls.map((args) => args[0]);
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("Stripe reconcilers never touch Apple lane tables", () => {
  it("subscription-grace-reconciler reconciles stranded rows without querying any apple table", async () => {
    // A stranded past_due row that WILL be synced to canceled — the fullest
    // code path the reconciler has.
    const scanQuery = {
      select: jest.fn().mockReturnThis(),
      in: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnThis(),
      lt: jest.fn().mockResolvedValue({
        data: [
          {
            user_id: "user_1",
            status: "past_due",
            plan: "operator",
            instance_limit: 0,
            stripe_subscription_id: "sub_1",
            grace_period_ends_at: "2026-01-01T00:00:00Z",
          },
        ],
        error: null,
      }),
    };
    fromMock.mockImplementation((table: string) => {
      if (table === "hermes_subscriptions") return scanQuery;
      throw new Error(`Unexpected table in grace reconciler: ${table}`);
    });
    (getStripe as jest.Mock).mockReturnValue({
      subscriptions: {
        retrieve: jest.fn().mockResolvedValue({
          id: "sub_1",
          status: "canceled",
          metadata: { user_id: "user_1" },
        }),
      },
    });

    const result = await reconcileSubscriptionGrace("2026-06-01T00:00:00Z");

    expect(result.syncedCanceled).toBe(1);
    for (const appleTable of APPLE_TABLES) {
      expect(tablesQueried()).not.toContain(appleTable);
    }
  });

  it("subscription-state-reconciler resets a terminal Stripe row without querying any apple table", async () => {
    const scanQuery = {
      select: jest.fn().mockReturnThis(),
      in: jest.fn().mockReturnThis(),
      order: jest.fn().mockResolvedValue({
        data: [
          {
            user_id: "user_1",
            plan: "operator",
            status: "active",
            instance_limit: 3,
            total_cpu_budget: 2,
            total_ram_budget: 4096,
            stripe_subscription_id: "sub_gone",
            stripe_customer_id: "cus_1",
            current_period_end: "2026-01-01T00:00:00Z",
            grace_period_ends_at: null,
            updated_at: "2026-01-01T00:00:00Z",
          },
        ],
        error: null,
      }),
    };
    fromMock.mockImplementation((table: string) => {
      if (table === "hermes_subscriptions") return scanQuery;
      throw new Error(`Unexpected table in state reconciler: ${table}`);
    });
    rpcMock.mockResolvedValue({
      data: {
        subscription_updated: true,
        instances_updated: 1,
        instances_changed: 1,
        target_tier: "credit_base",
      },
      error: null,
    });
    // Stripe reports the paid-access row's sub as gone → reset path runs.
    // The reconciler guards on `instanceof Stripe.errors.StripeError`, so the
    // synthetic error needs the real prototype.
    const missingErr = Object.assign(new Error("No such subscription"), {
      code: "resource_missing",
    });
    const StripeNS = jest.requireActual("stripe") as typeof Stripe;
    Object.setPrototypeOf(missingErr, StripeNS.errors.StripeError.prototype);
    (getStripe as jest.Mock).mockReturnValue({
      subscriptions: {
        retrieve: jest.fn().mockRejectedValue(missingErr),
        list: jest.fn().mockResolvedValue({ data: [] }),
      },
      checkout: {
        sessions: { list: jest.fn().mockResolvedValue({ data: [] }) },
      },
    });

    const result = await reconcileSubscriptionState("2026-06-01T00:00:00Z");

    expect(result.scanned).toBe(1);
    // Prove the FULL reset path executed (not an early error) while never
    // touching an apple table.
    expect(result.paidAccessReset).toBe(1);
    expect(result.errors).toBe(0);
    for (const appleTable of APPLE_TABLES) {
      expect(tablesQueried()).not.toContain(appleTable);
    }
  });
});
