/**
 * Regression tests for the on-demand yearly-token check-now endpoint.
 *
 * Locked promises:
 *   - Auth + flag gates fire before any work
 *   - For each active quote, runs detectAndActivateYearlyDeposit
 *   - For any pending sub, runs sweepActivatedSubscription
 *   - tier filter scopes detection to a single tier when supplied
 *   - Returns a summary { activated, alreadyActive, noBalance, swept }
 *     so the dashboard can show what happened
 *   - Internal errors don't leak to the response body
 */

import { NextRequest } from "next/server";

const mockBillingEnabled = jest.fn(() => true);
const mockGetActiveQuote = jest.fn();
const mockGetActiveQuotes = jest.fn();
const mockDetect = jest.fn();
const mockSweep = jest.fn();

const mockSelect = jest.fn().mockReturnThis();
const mockEq = jest.fn().mockReturnThis();
const mockOrder = jest.fn().mockReturnThis();
const mockLimit = jest.fn();
const mockFrom = jest.fn((name: string) => {
  void name;
  return {
  select: mockSelect,
  eq: mockEq,
  order: mockOrder,
  limit: mockLimit,
  };
});

jest.mock("@/lib/billing/billing-v2-availability", () => ({
  BILLING_V2_UNAVAILABLE_MESSAGE: "Billing v2 is currently unavailable.",
  isBillingV2ServerEnabled: () => mockBillingEnabled(),
}));

jest.mock("@/lib/billing/yearly-sweep", () => ({
  detectAndActivateYearlyDeposit: (...args: unknown[]) => mockDetect(...args),
  sweepActivatedSubscription: (...args: unknown[]) => mockSweep(...args),
}));

jest.mock("@/lib/billing/yearly-token-quotes", () => ({
  getActiveYearlyTokenQuote: (...args: unknown[]) => mockGetActiveQuote(...args),
  getActiveYearlyTokenQuotes: (...args: unknown[]) => mockGetActiveQuotes(...args),
}));

jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: { from: (name: string) => mockFrom(name) },
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

const stubQuote = {
  id: "yq_1",
  userId: "user_a",
  tier: "pro" as const,
  usdTargetCents: 4900,
  priceUsdAtQuote: "0.00000258",
  tokensRequiredRaw: 18_977_537n,
  tokensRequiredDisplay: "18977537",
  tokenSymbol: "Hivra",
  tokenDecimals: 18,
  depositAddress: "0xdeadbeef",
  quotedAt: "2026-05-01T12:00:00.000Z",
  expiresAt: "2026-05-01T12:20:00.000Z",
  status: "active" as const,
  consumedBalanceRaw: null,
  consumedAt: null,
  consumedTxHash: null,
  source: "dexscreener",
};

describe("POST /api/billing/yearly-token-quote/check-now", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBillingEnabled.mockReturnValue(true);
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_a" });
    mockLimit.mockResolvedValue({ data: [], error: null });
  });

  it("returns 404 when billing v2 is disabled", async () => {
    mockBillingEnabled.mockReturnValueOnce(false);
    const res = await POST(makeReq({}));
    expect(res.status).toBe(404);
  });

  it("returns 401 when unauthenticated", async () => {
    (auth as unknown as jest.Mock).mockResolvedValueOnce({ userId: null });
    const res = await POST(makeReq({}));
    expect(res.status).toBe(401);
  });

  it("scopes detection to a single tier when supplied", async () => {
    mockGetActiveQuote.mockResolvedValueOnce(stubQuote);
    mockDetect.mockResolvedValueOnce({
      quoteId: "yq_1",
      userId: "user_a",
      tier: "pro",
      outcome: "no_balance",
    });
    const res = await POST(makeReq({ tier: "pro" }));
    expect(res.status).toBe(200);
    expect(mockGetActiveQuote).toHaveBeenCalledWith({
      userId: "user_a",
      tier: "pro",
    });
    expect(mockGetActiveQuotes).not.toHaveBeenCalled();
    expect(mockDetect).toHaveBeenCalledTimes(1);
  });

  it("examines all tiers when no tier is supplied", async () => {
    mockGetActiveQuotes.mockResolvedValueOnce([stubQuote, { ...stubQuote, tier: "power", id: "yq_2" }]);
    mockDetect.mockResolvedValue({ outcome: "no_balance" });
    const res = await POST(makeReq({}));
    expect(res.status).toBe(200);
    expect(mockGetActiveQuotes).toHaveBeenCalledWith("user_a");
    expect(mockDetect).toHaveBeenCalledTimes(2);
  });

  it("runs sweepActivatedSubscription for any pending sub rows", async () => {
    mockGetActiveQuotes.mockResolvedValueOnce([stubQuote]);
    mockDetect.mockResolvedValueOnce({
      quoteId: "yq_1",
      userId: "user_a",
      tier: "pro",
      outcome: "activated",
      subscriptionId: "sub_1",
      amountReceivedRaw: "18977537",
    });
    mockLimit.mockResolvedValueOnce({
      data: [{ id: "sub_1", user_id: "user_a", amount_received_raw: "18977537" }],
      error: null,
    });
    mockSweep.mockResolvedValueOnce({
      subscriptionId: "sub_1",
      userId: "user_a",
      outcome: "swept",
      txHash: "0xfeedface",
    });

    const res = await POST(makeReq({}));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockSweep).toHaveBeenCalledTimes(1);
    expect(body.data.summary.activated).toBe(1);
    expect(body.data.summary.swept).toBe(1);
  });

  it("returns the per-step results so the dashboard can render progress", async () => {
    mockGetActiveQuotes.mockResolvedValueOnce([stubQuote]);
    mockDetect.mockResolvedValueOnce({
      quoteId: "yq_1",
      userId: "user_a",
      tier: "pro",
      outcome: "insufficient_balance",
    });
    const res = await POST(makeReq({}));
    const body = await res.json();
    expect(body.data.summary.insufficient).toBe(1);
    expect(body.data.summary.swept).toBe(0);
    expect(Array.isArray(body.data.detection)).toBe(true);
  });

  it("does not leak the underlying error message", async () => {
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    mockGetActiveQuotes.mockRejectedValueOnce(
      new Error("internal_check_now_secret_should_not_leak"),
    );
    const res = await POST(makeReq({}));
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(JSON.stringify(body)).not.toContain(
      "internal_check_now_secret_should_not_leak",
    );
    consoleErrorSpy.mockRestore();
  });
});
