/**
 * Regression tests for the deposit quote API.
 *
 * Locked promises:
 *   - GET returns null per-tier when nothing's active
 *   - POST validates the tier param strictly
 *   - POST forwards the tier to createDepositQuote and returns the
 *     serialised quote payload (BigInt → string)
 *   - 401 / 404 gates fire before any work
 *   - Internal errors don't leak to the response body
 */

import { NextRequest } from "next/server";

const mockGetActiveDepositQuotes = jest.fn();
const mockCreateDepositQuote = jest.fn();
const mockBillingEnabled = jest.fn(() => true);
const mockGetTokenVerificationWallet = jest.fn();

jest.mock("@/lib/billing/billing-v2-availability", () => ({
  BILLING_V2_UNAVAILABLE_MESSAGE: "Billing v2 is currently unavailable.",
  isBillingV2ServerEnabled: () => mockBillingEnabled(),
}));

jest.mock("@/lib/billing/deposit-quotes", () => ({
  getActiveDepositQuotes: (...args: unknown[]) => mockGetActiveDepositQuotes(...args),
  createDepositQuote: (...args: unknown[]) => mockCreateDepositQuote(...args),
}));

jest.mock("@/lib/billing/token-holdings", () => ({
  getTokenVerificationWallet: (...args: unknown[]) => mockGetTokenVerificationWallet(...args),
}));

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));

import { auth } from "@clerk/nextjs/server";
import { GET, POST } from "../route";

function makeReq(url: string, body?: unknown): NextRequest {
  return new Request(url, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  }) as unknown as NextRequest;
}

const stubQuote = {
  id: "q_1",
  userId: "user_a",
  tier: "pro" as const,
  thresholdTierCode: "PRO_LAUNCH" as const,
  epoch: "launch" as const,
  usdTargetCents: 9900,
  priceUsdAtQuote: "0.00000255",
  tokensRequiredRaw: 39_215_686_274_509_803_921_568_627n,
  tokensRequiredDisplay: "39215686.274509803921568627",
  tokenSymbol: "Hivra",
  tokenDecimals: 18,
  quotedAt: "2026-04-30T08:00:00.000Z",
  expiresAt: "2026-04-30T08:20:00.000Z",
  status: "active" as const,
  consumedBalanceRaw: null,
  consumedAt: null,
  source: "dexscreener",
};

describe("/api/billing/wallet/quote", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBillingEnabled.mockReturnValue(true);
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_a" });
    mockGetTokenVerificationWallet.mockResolvedValue({
      id: "wallet_sig",
      userId: "user_a",
      address: "0x000000000000000000000000000000000000abcd",
      normalizedAddress: "0x000000000000000000000000000000000000abcd",
      chainId: 8453,
      verifiedAt: "2026-05-12T12:00:00.000Z",
      verificationMethod: "signature",
    });
  });

  describe("GET", () => {
    it("returns 404 when billing v2 is disabled", async () => {
      mockBillingEnabled.mockReturnValueOnce(false);
      const response = await GET(makeReq("http://localhost/api/billing/wallet/quote"));
      expect(response.status).toBe(404);
    });

    it("returns 401 when unauthenticated", async () => {
      (auth as unknown as jest.Mock).mockResolvedValueOnce({ userId: null });
      const response = await GET(makeReq("http://localhost/api/billing/wallet/quote"));
      expect(response.status).toBe(401);
    });

    it("returns null per-tier when no active quotes exist", async () => {
      mockGetActiveDepositQuotes.mockResolvedValueOnce([]);
      const response = await GET(makeReq("http://localhost/api/billing/wallet/quote"));
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.pro).toBeNull();
      expect(body.data.power).toBeNull();
      expect(body.data.quotes).toEqual([]);
    });

    it("blocks price locks when no verified token wallet exists", async () => {
      mockGetTokenVerificationWallet.mockResolvedValueOnce(null);

      const response = await GET(makeReq("http://localhost/api/billing/wallet/quote"));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toMatch(/connect and verify/i);
      expect(mockGetActiveDepositQuotes).not.toHaveBeenCalled();
    });

    it("serialises tokensRequiredRaw as a string (BigInt is not JSON-safe)", async () => {
      mockGetActiveDepositQuotes.mockResolvedValueOnce([stubQuote]);
      const response = await GET(makeReq("http://localhost/api/billing/wallet/quote"));
      const body = await response.json();
      expect(body.data.pro.tokensRequiredRaw).toBe("39215686274509803921568627");
      expect(typeof body.data.pro.tokensRequiredRaw).toBe("string");
    });
  });

  describe("POST", () => {
    it("rejects missing tier", async () => {
      const response = await POST(
        makeReq("http://localhost/api/billing/wallet/quote", {})
      );
      expect(response.status).toBe(400);
    });

    it("rejects invalid tier values", async () => {
      const response = await POST(
        makeReq("http://localhost/api/billing/wallet/quote", { tier: "platinum" })
      );
      expect(response.status).toBe(400);
    });

    it("forwards the tier into createDepositQuote and returns the quote", async () => {
      mockCreateDepositQuote.mockResolvedValueOnce(stubQuote);
      const response = await POST(
        makeReq("http://localhost/api/billing/wallet/quote", { tier: "pro" })
      );
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(mockCreateDepositQuote).toHaveBeenCalledWith({
        userId: "user_a",
        tier: "pro",
      });
      expect(body.data.id).toBe("q_1");
      expect(body.data.tier).toBe("pro");
      expect(body.data.tokensRequiredRaw).toBe("39215686274509803921568627");
    });

    it("mints price locks for verified self-custody wallets", async () => {
      mockCreateDepositQuote.mockResolvedValueOnce({ ...stubQuote, tier: "power" });
      const response = await POST(
        makeReq("http://localhost/api/billing/wallet/quote", { tier: "power" })
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(mockCreateDepositQuote).toHaveBeenCalledWith({
        userId: "user_a",
        tier: "power",
      });
      expect(body.data.tier).toBe("power");
    });

    it("does not mint price locks without a verified token wallet", async () => {
      mockGetTokenVerificationWallet.mockResolvedValueOnce(null);

      const response = await POST(
        makeReq("http://localhost/api/billing/wallet/quote", { tier: "pro" })
      );
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toMatch(/connect and verify/i);
      expect(mockCreateDepositQuote).not.toHaveBeenCalled();
    });

    it("does not leak the underlying error message", async () => {
      const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      mockCreateDepositQuote.mockRejectedValueOnce(
        new Error("internal_pricefeed_secret_should_not_leak")
      );
      const response = await POST(
        makeReq("http://localhost/api/billing/wallet/quote", { tier: "pro" })
      );
      const body = await response.json();
      expect(response.status).toBe(500);
      expect(JSON.stringify(body)).not.toContain(
        "internal_pricefeed_secret_should_not_leak"
      );
      // NODE_ENV-gated diagnostic logging stays out of test runs.
      expect(JSON.stringify(consoleErrorSpy.mock.calls)).not.toContain(
        "internal_pricefeed_secret_should_not_leak"
      );
      consoleErrorSpy.mockRestore();
    });
  });
});
