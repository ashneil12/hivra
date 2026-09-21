import type Stripe from "stripe";

import { reconcileSubscriptionState } from "@/lib/billing/subscription-state-reconciler";
import { supabaseAdmin } from "@/lib/supabase";
import { getStripe } from "@/lib/stripe";
import { StripeWebhookService } from "@/lib/services/stripe-webhook-service";

jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: jest.fn(),
    rpc: jest.fn(),
  },
}));

jest.mock("@/lib/stripe", () => ({
  getStripe: jest.fn(),
}));

jest.mock("@/lib/services/stripe-webhook-service", () => ({
  StripeWebhookService: {
    handleSubscriptionChange: jest.fn(),
    handleSubscriptionDeleted: jest.fn(),
  },
}));

interface SubscriptionRow {
  user_id: string;
  plan: string;
  status: string;
  instance_limit: number;
  total_cpu_budget: number;
  total_ram_budget: number;
  stripe_subscription_id: string | null;
  stripe_customer_id: string | null;
  current_period_end: string | null;
  grace_period_ends_at: string | null;
  updated_at: string | null;
}

function row(overrides: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return {
    user_id: "user_pending",
    plan: "fleet",
    status: "pending",
    instance_limit: 999,
    total_cpu_budget: 4,
    total_ram_budget: 8192,
    stripe_subscription_id: null,
    stripe_customer_id: "cus_pending",
    current_period_end: null,
    grace_period_ends_at: null,
    updated_at: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function mockSubscriptionQuery(rows: SubscriptionRow[]) {
  const query = {
    select: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(),
    order: jest.fn().mockResolvedValue({ data: rows, error: null }),
  };
  return query;
}

function mockSupabase(rows: SubscriptionRow[]) {
  const query = mockSubscriptionQuery(rows);
  (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
    if (table !== "hermes_subscriptions") {
      throw new Error(`unexpected table ${table}`);
    }
    return query;
  });
  return { query };
}

function mockRpcResult(result: {
  subscription_updated: boolean;
  reason: string;
  instances_updated: number;
  instances_changed: number;
  target_tier: string | null;
} = {
  subscription_updated: true,
  reason: "reconciled",
  instances_updated: 1,
  instances_changed: 1,
  target_tier: "credit_base",
}) {
  (supabaseAdmin!.rpc as jest.Mock).mockResolvedValue({ data: result, error: null });
}

function mockStripe({
  retrieve,
  listSubscriptions = async () => ({ data: [] }),
  listCheckoutSessions = async () => ({ data: [] }),
}: {
  retrieve?: (id: string) => Promise<Partial<Stripe.Subscription>>;
  listSubscriptions?: (params: Record<string, unknown>) => Promise<{ data: Partial<Stripe.Subscription>[] }>;
  listCheckoutSessions?: (params: Record<string, unknown>) => Promise<{ data: Array<{ id: string; status: string }> }>;
}) {
  const retrieveMock = jest.fn(async (id: string) => {
    if (!retrieve) throw new Error(`unexpected retrieve ${id}`);
    return retrieve(id);
  });
  const listSubscriptionsMock = jest.fn(listSubscriptions);
  const listCheckoutSessionsMock = jest.fn(listCheckoutSessions);

  (getStripe as jest.Mock).mockReturnValue({
    subscriptions: {
      retrieve: retrieveMock,
      list: listSubscriptionsMock,
    },
    checkout: {
      sessions: {
        list: listCheckoutSessionsMock,
      },
    },
  });

  return { retrieveMock, listSubscriptionsMock, listCheckoutSessionsMock };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "info").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  mockRpcResult();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("reconcileSubscriptionState", () => {
  it("resets abandoned pending paid checkout rows through the transactional DB RPC", async () => {
    const stalePending = row();
    mockSupabase([stalePending]);
    const stripe = mockStripe({});

    const result = await reconcileSubscriptionState("2026-06-03T00:00:00.000Z");

    expect(result.scanned).toBe(1);
    expect(result.pendingReset).toBe(1);
    expect(result.manualReview).toBe(0);
    expect(result.runtimeRowsUpdated).toBe(1);
    expect(result.runtimeRowsChanged).toBe(1);
    expect(stripe.listCheckoutSessionsMock).toHaveBeenCalledWith({
      customer: "cus_pending",
      limit: 20,
    });
    expect(stripe.listSubscriptionsMock).toHaveBeenCalledWith({
      customer: "cus_pending",
      status: "all",
      limit: 100,
    });
    expect(supabaseAdmin!.rpc).toHaveBeenCalledWith(
      "reconcile_stale_subscription_state_to_free",
      {
        p_user_id: "user_pending",
        p_observed_plan: "fleet",
        p_observed_status: "pending",
        p_observed_stripe_subscription_id: null,
        p_observed_updated_at: "2026-06-01T00:00:00.000Z",
        p_now: "2026-06-03T00:00:00.000Z",
      }
    );
    expect(result.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: "user_pending",
          action: "reset_pending_abandoned",
          detail: expect.stringContaining("target_tier=credit_base"),
        }),
      ])
    );
  });

  it("activates stale pending rows when Stripe already has a live matching subscription", async () => {
    const stalePending = row({
      user_id: "user_paid_pending",
      stripe_subscription_id: "sub_live_pending",
      stripe_customer_id: "cus_paid_pending",
    });
    const liveSubscription: Partial<Stripe.Subscription> = {
      id: "sub_live_pending",
      status: "active",
      customer: "cus_paid_pending",
      metadata: { user_id: "user_paid_pending", plan: "fleet" },
    };
    mockSupabase([stalePending]);
    const stripe = mockStripe({
      retrieve: async () => liveSubscription,
      listCheckoutSessions: async () => ({ data: [{ id: "cs_unrelated_open", status: "open" }] }),
    });

    const result = await reconcileSubscriptionState("2026-06-03T00:00:00.000Z");

    expect(result.pendingActivatedFromStripe).toBe(1);
    expect(result.pendingReset).toBe(0);
    expect(result.manualReview).toBe(0);
    expect(StripeWebhookService.handleSubscriptionChange).toHaveBeenCalledWith(liveSubscription);
    expect(stripe.listCheckoutSessionsMock).not.toHaveBeenCalled();
    expect(supabaseAdmin!.rpc).not.toHaveBeenCalled();
    expect(result.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: "user_paid_pending",
          action: "activated_stripe_grant",
          detail: expect.stringContaining("sub_live_pending"),
        }),
      ])
    );
  });

  it("flags live Stripe pending grants with missing metadata for manual review instead of reset", async () => {
    const stalePending = row({
      user_id: "user_paid_pending",
      stripe_subscription_id: "sub_live_pending",
      stripe_customer_id: "cus_paid_pending",
    });
    mockSupabase([stalePending]);
    mockStripe({ retrieve: async () => ({ id: "sub_live_pending", status: "active", customer: "cus_paid_pending", metadata: {} }) });

    const result = await reconcileSubscriptionState("2026-06-03T00:00:00.000Z");

    expect(result.pendingActivatedFromStripe).toBe(0);
    expect(result.pendingReset).toBe(0);
    expect(result.manualReview).toBe(1);
    expect(StripeWebhookService.handleSubscriptionChange).not.toHaveBeenCalled();
    expect(supabaseAdmin!.rpc).not.toHaveBeenCalled();
  });

  it("keeps pending rows when an open Checkout session still exists", async () => {
    mockSupabase([row()]);
    mockStripe({
      listCheckoutSessions: async () => ({ data: [{ id: "cs_open", status: "open" }] }),
    });

    const result = await reconcileSubscriptionState("2026-06-03T00:00:00.000Z");

    expect(result.pendingReset).toBe(0);
    expect(result.skippedOpenCheckout).toBe(1);
    expect(supabaseAdmin!.rpc).not.toHaveBeenCalled();
  });

  it("resets terminal Stripe paid-access rows while preserving live Stripe grants", async () => {
    const terminal = row({
      user_id: "user_terminal",
      plan: "operator",
      status: "active",
      stripe_subscription_id: "sub_canceled",
      stripe_customer_id: "cus_terminal",
    });
    const live = row({
      user_id: "user_live",
      plan: "fleet",
      status: "active",
      stripe_subscription_id: "sub_live",
      stripe_customer_id: "cus_live",
    });
    mockSupabase([terminal, live]);
    const stripe = mockStripe({
      retrieve: async (id) => ({
        id,
        customer: id === "sub_live" ? "cus_live" : "cus_terminal",
        status: id === "sub_live" ? "active" : "canceled",
      }),
    });

    const result = await reconcileSubscriptionState("2026-06-03T00:00:00.000Z");

    expect(result.paidAccessReset).toBe(1);
    expect(result.skippedStripeGrant).toBe(1);
    expect(stripe.retrieveMock).toHaveBeenCalledWith("sub_canceled");
    expect(stripe.retrieveMock).toHaveBeenCalledWith("sub_live");
    expect(supabaseAdmin!.rpc).toHaveBeenCalledTimes(1);
    expect(supabaseAdmin!.rpc).toHaveBeenCalledWith(
      "reconcile_stale_subscription_state_to_free",
      expect.objectContaining({
        p_user_id: "user_terminal",
        p_observed_stripe_subscription_id: "sub_canceled",
      })
    );
  });

  it("routes a terminal own-subscription through the canonical cancel path instead of a free-reset", async () => {
    // Regression (2026-06→07 ghost-payer cohort): resetting a canceled payer
    // to a free/active row with a nulled sub id erased the Stripe linkage and
    // dropped them onto the free-tier idle-purge ladder. A terminal
    // subscription with intact metadata must go through
    // handleSubscriptionDeleted (status='canceled', plan + sub id retained).
    const ghost = row({
      user_id: "user_ghost",
      plan: "operator",
      status: "past_due",
      stripe_subscription_id: "sub_ghost",
      stripe_customer_id: "cus_ghost",
    });
    const terminalSubscription: Partial<Stripe.Subscription> = {
      id: "sub_ghost",
      status: "canceled",
      customer: "cus_ghost",
      metadata: { user_id: "user_ghost", plan: "operator" },
    };
    mockSupabase([ghost]);
    mockStripe({ retrieve: async () => terminalSubscription });

    const result = await reconcileSubscriptionState("2026-06-03T00:00:00.000Z");

    expect(result.canceledTerminalStripe).toBe(1);
    expect(result.paidAccessReset).toBe(0);
    expect(StripeWebhookService.handleSubscriptionDeleted).toHaveBeenCalledWith(
      terminalSubscription
    );
    expect(supabaseAdmin!.rpc).not.toHaveBeenCalled();
    expect(result.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: "user_ghost",
          action: "canceled_terminal_stripe",
          detail: expect.stringContaining("sub_ghost"),
        }),
      ])
    );
  });

  it("keeps a paying user whose row points at a stale subscription id", async () => {
    // The row's sub id is dead, but the customer's list has a live matching
    // subscription. Previously the list fallback only ran when the row had NO
    // sub id, so this user was wrongly reset to Free while still paying.
    const stale = row({
      user_id: "user_stale_id",
      plan: "fleet",
      status: "active",
      stripe_subscription_id: "sub_stale",
      stripe_customer_id: "cus_stale",
    });
    mockSupabase([stale]);
    mockStripe({
      retrieve: async () => ({
        id: "sub_stale",
        status: "canceled",
        customer: "cus_stale",
        metadata: { user_id: "user_stale_id", plan: "fleet" },
      }),
      listSubscriptions: async () => ({
        data: [
          {
            id: "sub_replacement",
            status: "active",
            customer: "cus_stale",
            metadata: { user_id: "user_stale_id", plan: "fleet" },
          },
        ],
      }),
    });

    const result = await reconcileSubscriptionState("2026-06-03T00:00:00.000Z");

    expect(result.skippedStripeGrant).toBe(1);
    expect(result.paidAccessReset).toBe(0);
    expect(result.canceledTerminalStripe).toBe(0);
    expect(StripeWebhookService.handleSubscriptionDeleted).not.toHaveBeenCalled();
    expect(supabaseAdmin!.rpc).not.toHaveBeenCalled();
  });

  it("resets paid-access rows whose retrieved Stripe subscription belongs to another customer", async () => {
    const mismatched = row({
      user_id: "user_mismatch",
      plan: "operator",
      status: "active",
      stripe_subscription_id: "sub_live_wrong_customer",
      stripe_customer_id: "cus_expected",
    });
    mockSupabase([mismatched]);
    mockStripe({
      retrieve: async (id) => ({
        id,
        customer: "cus_attacker",
        status: "active",
        metadata: { user_id: "user_mismatch" },
      }),
    });

    const result = await reconcileSubscriptionState("2026-06-03T00:00:00.000Z");

    expect(result.skippedStripeGrant).toBe(0);
    expect(result.paidAccessReset).toBe(1);
    expect(supabaseAdmin!.rpc).toHaveBeenCalledWith(
      "reconcile_stale_subscription_state_to_free",
      expect.objectContaining({
        p_user_id: "user_mismatch",
        p_observed_stripe_subscription_id: "sub_live_wrong_customer",
      })
    );
  });

  it("preserves token entitlement when the transactional DB RPC returns a token-backed target tier", async () => {
    const terminalTokenHolder = row({
      user_id: "user_power",
      plan: "fleet",
      status: "active",
      stripe_subscription_id: "sub_canceled",
      stripe_customer_id: "cus_power",
    });
    mockSupabase([terminalTokenHolder]);
    mockStripe({ retrieve: async (id) => ({ id, status: "canceled" }) });
    mockRpcResult({
      subscription_updated: true,
      reason: "reconciled",
      instances_updated: 2,
      instances_changed: 1,
      target_tier: "fleet",
    });

    const result = await reconcileSubscriptionState("2026-06-03T00:00:00.000Z");

    expect(result.paidAccessReset).toBe(1);
    expect(result.runtimeRowsUpdated).toBe(2);
    expect(result.runtimeRowsChanged).toBe(1);
    expect(result.entries[0].detail).toContain("target_tier=fleet");
  });

  it("does not overwrite rows that changed after the scan", async () => {
    const stalePending = row();
    mockSupabase([stalePending]);
    mockStripe({});
    mockRpcResult({
      subscription_updated: false,
      reason: "stale_observed_subscription",
      instances_updated: 0,
      instances_changed: 0,
      target_tier: null,
    });

    const result = await reconcileSubscriptionState("2026-06-03T00:00:00.000Z");

    expect(result.pendingReset).toBe(0);
    expect(result.skippedStaleRow).toBe(1);
    expect(result.runtimeRowsUpdated).toBe(0);
    expect(result.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: "user_pending",
          action: "skipped_stale_row",
          detail: "stale_observed_subscription",
        }),
      ])
    );
  });

  it("flags manual or missing-Stripe paid-access rows for review instead of auto-revoking them", async () => {
    const manual = row({
      user_id: "user_manual",
      plan: "operator",
      status: "active",
      stripe_subscription_id: "manual_123",
      stripe_customer_id: "cus_manual",
    });
    const missing = row({
      user_id: "user_missing",
      plan: "operator",
      status: "active",
      stripe_subscription_id: null,
      stripe_customer_id: "cus_missing",
    });
    mockSupabase([manual, missing]);
    mockStripe({});

    const result = await reconcileSubscriptionState("2026-06-03T00:00:00.000Z");

    expect(result.manualReview).toBe(2);
    expect(result.paidAccessReset).toBe(0);
    expect(supabaseAdmin!.rpc).not.toHaveBeenCalled();
    expect(result.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: "user_manual", action: "manual_review" }),
        expect.objectContaining({ userId: "user_missing", action: "manual_review" }),
      ])
    );
  });
});
