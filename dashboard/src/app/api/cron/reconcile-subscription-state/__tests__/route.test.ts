import { NextRequest } from "next/server";

import { GET } from "../route";
import { reconcileSubscriptionState } from "@/lib/billing/subscription-state-reconciler";
import { reportOpsEvent } from "@/lib/ops-events";

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/billing/subscription-state-reconciler", () => ({
  SUBSCRIPTION_STATE_RECONCILER_LOG_SOURCE: "subscription-state-reconciler",
  reconcileSubscriptionState: jest.fn(),
}));

jest.mock("@/lib/ops-events", () => ({
  reportOpsEvent: jest.fn().mockResolvedValue(undefined),
  sanitizeOpsMetadata: jest.fn((metadata) => metadata),
}));

function request(secret = "secret") {
  return new NextRequest("http://localhost/api/cron/reconcile-subscription-state", {
    headers: { authorization: `Bearer ${secret}` },
  });
}

describe("GET /api/cron/reconcile-subscription-state", () => {
  const oldEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...oldEnv, CRON_SECRET: "secret" };
    jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = oldEnv;
    jest.restoreAllMocks();
  });

  it("runs the reconciler and emits an ops breadcrumb when state was changed", async () => {
    (reconcileSubscriptionState as jest.Mock).mockResolvedValue({
      scanned: 4,
      pendingReset: 2,
      paidAccessReset: 1,
      pendingActivatedFromStripe: 1,
      skippedOpenCheckout: 1,
      skippedRecentPending: 0,
      skippedStripeGrant: 0,
      skippedStaleRow: 0,
      manualReview: 1,
      runtimeRowsUpdated: 3,
      runtimeRowsChanged: 3,
      errors: 0,
      entries: [
        {
          userId: "user_manual",
          plan: "operator",
          status: "active",
          stripeSubscriptionId: "manual_123",
          stripeCustomerId: "cus_manual",
          action: "manual_review",
        },
      ],
    });

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      scanned: 4,
      pendingReset: 2,
      paidAccessReset: 1,
      pendingActivatedFromStripe: 1,
      skippedOpenCheckout: 1,
      errors: 0,
    });
    expect(reportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "subscription-state-reconciler",
        severity: "warn",
        title: "Reconciled stale billing subscription state",
        metadata: expect.objectContaining({
          pendingReset: 2,
          paidAccessReset: 1,
          pendingActivatedFromStripe: 1,
          runtimeRowsUpdated: 3,
          runtimeRowsChanged: 3,
          manualReviewEntries: [
            expect.objectContaining({
              userId: "user_manual",
              plan: "operator",
              stripeSubscriptionId: "manual_123",
            }),
          ],
        }),
      })
    );
  });

  it("stays quiet when only standing observations exist and nothing changed", async () => {
    // Prod 2026-11: the same 5 operator-grant manualReview rows re-fired a
    // warn every 15 minutes forever (one ops row, 11k+ occurrences). Standing
    // backlog is not a change — only mutations and errors should emit.
    (reconcileSubscriptionState as jest.Mock).mockResolvedValue({
      scanned: 55,
      pendingReset: 0,
      paidAccessReset: 0,
      pendingActivatedFromStripe: 0,
      canceledTerminalStripe: 0,
      skippedOpenCheckout: 0,
      skippedRecentPending: 0,
      skippedStripeGrant: 50,
      skippedStaleRow: 0,
      manualReview: 5,
      runtimeRowsUpdated: 0,
      runtimeRowsChanged: 0,
      errors: 0,
      entries: [
        {
          userId: "user_manual",
          plan: "operator",
          status: "active",
          stripeSubscriptionId: "manual_123",
          stripeCustomerId: "cus_manual",
          action: "manual_review",
        },
      ],
    });

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(reportOpsEvent).not.toHaveBeenCalled();
  });

  it("still warns when the reconcile changed state even with a standing backlog", async () => {
    (reconcileSubscriptionState as jest.Mock).mockResolvedValue({
      scanned: 4,
      pendingReset: 0,
      paidAccessReset: 0,
      pendingActivatedFromStripe: 0,
      canceledTerminalStripe: 0,
      skippedOpenCheckout: 0,
      skippedRecentPending: 0,
      skippedStripeGrant: 0,
      skippedStaleRow: 0,
      manualReview: 5,
      runtimeRowsUpdated: 0,
      runtimeRowsChanged: 2,
      errors: 0,
      entries: [],
    });

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(reportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "subscription-state-reconciler",
        severity: "warn",
        metadata: expect.objectContaining({ manualReview: 5, runtimeRowsChanged: 2 }),
      })
    );
  });

  it("rejects unauthorized cron calls", async () => {
    const response = await GET(request("wrong"));

    expect(response.status).toBe(401);
    expect(reconcileSubscriptionState).not.toHaveBeenCalled();
  });
});
