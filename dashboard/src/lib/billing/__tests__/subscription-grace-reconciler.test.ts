import type Stripe from "stripe";

import { reconcileSubscriptionGrace } from "@/lib/billing/subscription-grace-reconciler";
import { supabaseAdmin } from "@/lib/supabase";
import { getStripe } from "@/lib/stripe";
import { StripeWebhookService } from "@/lib/services/stripe-webhook-service";
import { enforceGraceExpiredComputeStop } from "@/lib/recovery/dunning-grace-enforce";

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/stripe", () => ({
  getStripe: jest.fn(),
}));

jest.mock("@/lib/services/stripe-webhook-service", () => ({
  StripeWebhookService: {
    handleSubscriptionDeleted: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock("@/lib/recovery/dunning-grace-enforce", () => ({
  enforceGraceExpiredComputeStop: jest.fn().mockResolvedValue({
    userId: "user_1",
    outcome: "stopped",
    affected: 1,
  }),
}));

interface StrandedRow {
  user_id: string;
  status: string;
  plan: string;
  instance_limit: number;
  stripe_subscription_id: string | null;
  grace_period_ends_at: string | null;
}

/**
 * Mock the hermes_subscriptions select chain:
 *   .select(...).in(...).not(...).lt(...) -> resolves { data, error }
 */
function mockStrandedQuery(rows: StrandedRow[], error: unknown = null) {
  const query = {
    select: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(),
    not: jest.fn().mockReturnThis(),
    lt: jest.fn().mockResolvedValue({ data: rows, error }),
  };
  (supabaseAdmin!.from as jest.Mock).mockReturnValue(query);
  return query;
}

function mockStripeRetrieve(
  impl: (id: string) => Promise<Stripe.Subscription>
) {
  (getStripe as jest.Mock).mockReturnValue({
    subscriptions: { retrieve: jest.fn((id: string) => impl(id)) },
  });
}

const handleDeleted = StripeWebhookService.handleSubscriptionDeleted as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "info").mockImplementation(() => {});
});

function strandedRow(overrides: Partial<StrandedRow> = {}): StrandedRow {
  return {
    user_id: "user_1",
    status: "past_due",
    plan: "command",
    instance_limit: 0,
    stripe_subscription_id: "sub_1",
    grace_period_ends_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("reconcileSubscriptionGrace", () => {
  it("syncs a terminal (canceled) Stripe sub via the canonical handler", async () => {
    mockStrandedQuery([strandedRow()]);
    mockStripeRetrieve(async (id) =>
      ({ id, status: "canceled", metadata: { user_id: "user_1" } } as unknown as Stripe.Subscription)
    );

    const result = await reconcileSubscriptionGrace("2026-06-01T00:00:00Z");

    expect(result.scanned).toBe(1);
    expect(result.syncedCanceled).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);
    expect(handleDeleted).toHaveBeenCalledTimes(1);
    const arg = handleDeleted.mock.calls[0][0];
    expect(arg.id).toBe("sub_1");
    expect(arg.metadata.user_id).toBe("user_1");
  });

  it("treats a resource_missing Stripe sub as terminal and syncs it", async () => {
    mockStrandedQuery([strandedRow({ stripe_subscription_id: "sub_gone" })]);
    // Mirror the StripeError shape the reconciler checks (err.code).
    const err = Object.assign(new Error("No such subscription"), {
      code: "resource_missing",
    });
    // Make it pass the `instanceof Stripe.errors.StripeError` guard.
    const StripeNS = jest.requireActual("stripe") as typeof Stripe;
    Object.setPrototypeOf(err, StripeNS.errors.StripeError.prototype);
    mockStripeRetrieve(async () => {
      throw err;
    });

    const result = await reconcileSubscriptionGrace("2026-06-01T00:00:00Z");

    expect(result.syncedCanceled).toBe(1);
    expect(result.errors).toBe(0);
    expect(handleDeleted).toHaveBeenCalledTimes(1);
    expect(handleDeleted.mock.calls[0][0].id).toBe("sub_gone");
  });

  it("skips a sub Stripe still considers active (does not override Stripe)", async () => {
    mockStrandedQuery([strandedRow()]);
    mockStripeRetrieve(async (id) =>
      ({ id, status: "active", metadata: { user_id: "user_1" } } as unknown as Stripe.Subscription)
    );

    const result = await reconcileSubscriptionGrace("2026-06-01T00:00:00Z");

    expect(result.syncedCanceled).toBe(0);
    expect(result.skipped).toBe(1);
    expect(handleDeleted).not.toHaveBeenCalled();
  });

  it("enforces compute-stop for a grace-expired sub Stripe is still retrying (past_due)", async () => {
    mockStrandedQuery([strandedRow()]);
    mockStripeRetrieve(async (id) =>
      ({ id, status: "past_due", metadata: { user_id: "user_1" } } as unknown as Stripe.Subscription)
    );

    const result = await reconcileSubscriptionGrace("2026-06-01T00:00:00Z");

    // Still-retrying at Stripe → we must NOT cancel the sub…
    expect(handleDeleted).not.toHaveBeenCalled();
    // …but our grace has expired, so compute is enforced-stopped.
    expect(enforceGraceExpiredComputeStop).toHaveBeenCalledWith("user_1");
    expect(result.enforcedStopped).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.entries[0].action).toBe("enforced_stopped");
  });

  it("skips rows with no stripe_subscription_id", async () => {
    mockStrandedQuery([strandedRow({ stripe_subscription_id: null })]);

    const result = await reconcileSubscriptionGrace("2026-06-01T00:00:00Z");

    expect(result.skipped).toBe(1);
    expect(result.syncedCanceled).toBe(0);
    expect(handleDeleted).not.toHaveBeenCalled();
  });

  it("returns an all-zero result when nothing is stranded", async () => {
    mockStrandedQuery([]);
    const result = await reconcileSubscriptionGrace("2026-06-01T00:00:00Z");
    expect(result).toEqual({
      scanned: 0,
      syncedCanceled: 0,
      skipped: 0,
      errors: 0,
      enforcedStopped: 0,
      entries: [],
    });
  });

  it("counts a row as errored when Stripe throws a non-missing error", async () => {
    mockStrandedQuery([strandedRow()]);
    mockStripeRetrieve(async () => {
      throw new Error("stripe network blip");
    });

    const result = await reconcileSubscriptionGrace("2026-06-01T00:00:00Z");

    expect(result.errors).toBe(1);
    expect(result.syncedCanceled).toBe(0);
    expect(handleDeleted).not.toHaveBeenCalled();
  });
});
