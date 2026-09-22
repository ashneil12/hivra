/**
 * Contract tests for the on-demand yearly-token check-now endpoint.
 *
 * Locked promises:
 *   - Auth + flag gates fire before any work
 *   - Reconciles only the signed-in user's quotes (and one tier when given)
 *   - Sweeps the user's pending subscriptions
 *   - Returns a summary { activated, manualReview, swept, ... } so the
 *     dashboard can show what happened
 *   - Internal errors don't leak to the response body
 *
 * The end-to-end behaviour against the real reconciler lives in
 * route.scenario.test.ts.
 */

import { NextRequest } from "next/server";

const mockBillingEnabled = jest.fn(() => true);
const mockReconcile = jest.fn();
const mockSweep = jest.fn();
const mockLimit = jest.fn();

interface MockQuery {
  select: () => MockQuery;
  eq: () => MockQuery;
  order: () => MockQuery;
  limit: (...args: unknown[]) => unknown;
}
const mockQuery: MockQuery = {
  select: () => mockQuery,
  eq: () => mockQuery,
  order: () => mockQuery,
  limit: (...args: unknown[]) => mockLimit(...args),
};

jest.mock("@/lib/billing/billing-v2-availability", () => ({
  BILLING_V2_UNAVAILABLE_MESSAGE: "Billing v2 is currently unavailable.",
  isBillingV2ServerEnabled: () => mockBillingEnabled(),
}));

jest.mock("@/lib/billing/yearly-token-settlement", () => ({
  reconcilePendingYearlyTokenQuotes: (...args: unknown[]) => mockReconcile(...args),
}));

jest.mock("@/lib/billing/yearly-sweep", () => ({
  sweepYearlyTokenSubscription: (...args: unknown[]) => mockSweep(...args),
}));

jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: { from: () => mockQuery },
}));

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));

import { auth } from "@clerk/nextjs/server";
import { POST } from "../route";

function makeReq(body?: unknown): NextRequest {
  return new Request("http://localhost/api/billing/yearly-token-quote/check-now", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  }) as unknown as NextRequest;
}

function batch(overrides: Record<string, unknown> = {}) {
  return {
    checked: 0,
    activated: 0,
    renewed: 0,
    underconfirmed: 0,
    noMatch: 0,
    manualReview: 0,
    cancelled: 0,
    skipped: 0,
    failed: 0,
    results: [],
    ...overrides,
  };
}

describe("POST /api/billing/yearly-token-quote/check-now", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBillingEnabled.mockReturnValue(true);
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_a" });
    mockLimit.mockResolvedValue({ data: [], error: null });
    mockReconcile.mockResolvedValue(batch());
  });

  it("returns 404 when billing v2 is disabled", async () => {
    mockBillingEnabled.mockReturnValueOnce(false);
    const res = await POST(makeReq({}));
    expect(res.status).toBe(404);
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  it("returns 401 when unauthenticated", async () => {
    (auth as unknown as jest.Mock).mockResolvedValueOnce({ userId: null });
    const res = await POST(makeReq({}));
    expect(res.status).toBe(401);
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  it("scopes reconciliation to the user and a single tier when supplied", async () => {
    const res = await POST(makeReq({ tier: "pro" }));
    expect(res.status).toBe(200);
    expect(mockReconcile).toHaveBeenCalledWith(expect.objectContaining({ userId: "user_a", tier: "pro" }));
  });

  it("reconciles every tier when none (or an invalid one) is supplied", async () => {
    await POST(makeReq({ tier: "enterprise" }));
    expect(mockReconcile).toHaveBeenCalledWith(expect.objectContaining({ userId: "user_a", tier: undefined }));
  });

  it("sweeps the user's pending subscriptions and reports the summary", async () => {
    mockReconcile.mockResolvedValueOnce(batch({ checked: 1, activated: 1, results: [{ quoteId: "yq_1", status: "activated" }] }));
    mockLimit.mockResolvedValueOnce({ data: [{ id: "sub_1", user_id: "user_a" }], error: null });
    mockSweep.mockResolvedValueOnce({ subscriptionId: "sub_1", userId: "user_a", outcome: "swept", txHash: "0xfeed" });

    const res = await POST(makeReq({}));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockSweep).toHaveBeenCalledWith({ id: "sub_1", user_id: "user_a" }, expect.anything());
    expect(body.data.summary).toMatchObject({ examined: 1, activated: 1, swept: 1 });
    expect(body.data.detection).toEqual([{ quoteId: "yq_1", status: "activated" }]);
  });

  it("counts a renewal as an activation and surfaces manual reviews", async () => {
    mockReconcile.mockResolvedValueOnce(batch({ checked: 2, renewed: 1, manualReview: 1 }));
    const body = await (await POST(makeReq({}))).json();
    expect(body.data.summary).toMatchObject({ activated: 1, renewed: 1, manualReview: 1, swept: 0 });
  });

  it("does not leak the underlying error message", async () => {
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    mockReconcile.mockRejectedValueOnce(new Error("internal_check_now_secret_should_not_leak"));
    const res = await POST(makeReq({}));
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(JSON.stringify(body)).not.toContain("internal_check_now_secret_should_not_leak");
    consoleErrorSpy.mockRestore();
  });
});
