/**
 * Regression tests for the yearly-token-quote API.
 *
 * Locked promises:
 *   - GET returns active quotes for the authed user, null per-tier when empty
 *   - POST validates tier strictly (only "pro" / "power")
 *   - POST resolves the user's shared credit_deposit wallet and uses its
 *     address as the deposit destination for every Bankr crypto payment
 *   - POST returns 409 when the user has no provisioned credit_deposit wallet
 *   - 401 / 404 gates fire before any DB or wallet work
 *   - Live-price-unavailable surfaces as a 503 the dashboard can act on
 */

import { NextRequest } from "next/server";

const mockGetActiveYearlyQuote = jest.fn();
const mockGetActiveYearlyQuotes = jest.fn();
const mockGetPendingYearlyQuotes = jest.fn();
const mockCreateYearlyQuote = jest.fn();
const mockGetCredential = jest.fn();
const mockEnsureWallet = jest.fn();
const mockBillingEnabled = jest.fn(() => true);

jest.mock("@/lib/billing/billing-v2-availability", () => ({
  BILLING_V2_UNAVAILABLE_MESSAGE: "Billing v2 is currently unavailable.",
  isBillingV2ServerEnabled: () => mockBillingEnabled(),
}));

jest.mock("@/lib/billing/yearly-token-quotes", () => ({
  ActiveYearlyQuoteTokenMismatchError: class ActiveYearlyQuoteTokenMismatchError extends Error {},
  createYearlyTokenQuote: (...args: unknown[]) => mockCreateYearlyQuote(...args),
  getActiveYearlyTokenQuote: (...args: unknown[]) => mockGetActiveYearlyQuote(...args),
  getActiveYearlyTokenQuotes: (...args: unknown[]) => mockGetActiveYearlyQuotes(...args),
  getPendingYearlyTokenQuotes: (...args: unknown[]) => mockGetPendingYearlyQuotes(...args),
}));

jest.mock("@/lib/billing/bankr-deposit-wallets", () => ({
  getBankrDepositWalletCredentialForUser: (...args: unknown[]) => mockGetCredential(...args),
  ensureBankrDepositWalletForUser: (...args: unknown[]) => mockEnsureWallet(...args),
}));

jest.mock("@/lib/billing/live-thresholds", () => {
  class LivePriceUnavailableError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "LivePriceUnavailableError";
    }
  }
  return { LivePriceUnavailableError };
});

const mockResolveEffectiveSubscription = jest.fn();
jest.mock("@/lib/billing/instance-entitlement", () => ({
  resolveEffectiveSubscription: (...args: unknown[]) => mockResolveEffectiveSubscription(...args),
}));

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));

const mockReportPriceGateRefusal = jest.fn<Promise<unknown>, unknown[]>(async () => ({
  refusal: { assetKey: "hivra", asset: "$HIVRA", reason: "median_deviation", gate: "deviation", observed: {} },
  logged: true,
  alerted: true,
}));
jest.mock("@/lib/billing/price-gate-alerts", () => ({
  reportPriceGateRefusal: (...args: unknown[]) => mockReportPriceGateRefusal(...args),
}));

import { auth } from "@clerk/nextjs/server";
import { PlatformTokenPriceGateError } from "@/lib/billing/price-feed";
import { GET, POST } from "../route";

function makeReq(url: string, body?: unknown): NextRequest {
  return new Request(url, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  }) as unknown as NextRequest;
}

const stubQuote = {
  id: "yq_1",
  userId: "user_a",
  tier: "pro" as const,
  usdTargetCents: 4900,
  priceUsdAtQuote: "0.00000215",
  tokensRequiredRaw: 22_790_697_674_418_604_651_162_791n,
  tokensRequiredDisplay: "22790698",
  tokenSymbol: "Hivra",
  tokenDecimals: 18,
  depositAddress: "0xCreditDepositWalletAddr",
  quotedAt: "2026-05-01T08:00:00.000Z",
  expiresAt: "2026-05-01T08:20:00.000Z",
  status: "active" as const,
  consumedBalanceRaw: null,
  consumedAt: null,
  consumedTxHash: null,
  source: "dexscreener",
};

describe("/api/billing/yearly-token-quote", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBillingEnabled.mockReturnValue(true);
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_a" });
    mockGetPendingYearlyQuotes.mockResolvedValue([]);
    mockResolveEffectiveSubscription.mockResolvedValue(null);
    mockGetCredential.mockResolvedValue({
      id: "cred_1",
      userId: "user_a",
      purpose: "credit_deposit",
      walletId: "w_1",
      bankrWalletId: "bw_1",
      evmAddress: "0xCreditDepositWalletAddr",
      normalizedEvmAddress: "0xcreditdepositwalletaddr",
    });
  });

  describe("GET", () => {
    it("returns 404 when billing v2 is disabled", async () => {
      mockBillingEnabled.mockReturnValueOnce(false);
      const response = await GET(makeReq("http://localhost/api/billing/yearly-token-quote"));
      expect(response.status).toBe(404);
    });

    it("returns 401 when unauthenticated", async () => {
      (auth as unknown as jest.Mock).mockResolvedValueOnce({ userId: null });
      const response = await GET(makeReq("http://localhost/api/billing/yearly-token-quote"));
      expect(response.status).toBe(401);
    });

    it("returns a quote under review so the banner can tell the user not to pay again", async () => {
      mockGetActiveYearlyQuotes.mockResolvedValueOnce([]);
      mockGetPendingYearlyQuotes.mockResolvedValueOnce([{ ...stubQuote, status: "manual_review" }]);
      const response = await GET(makeReq("http://localhost/api/billing/yearly-token-quote"));
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.data.pro).toBeNull();
      expect(body.data.proPending).toMatchObject({ id: "yq_1", status: "manual_review" });
      expect(body.data.powerPending).toBeNull();

      mockGetActiveYearlyQuote.mockResolvedValueOnce(null);
      mockGetPendingYearlyQuotes.mockResolvedValueOnce([{ ...stubQuote, status: "expired" }]);
      const tierBody = await (await GET(makeReq("http://localhost/api/billing/yearly-token-quote?tier=pro"))).json();
      expect(tierBody.data.pendingQuote).toMatchObject({ id: "yq_1", status: "expired" });
    });

    it("returns null per-tier when no active yearly quotes exist", async () => {
      mockGetActiveYearlyQuotes.mockResolvedValueOnce([]);
      const response = await GET(makeReq("http://localhost/api/billing/yearly-token-quote"));
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.pro).toBeNull();
      expect(body.data.power).toBeNull();
      expect(body.data.quotes).toEqual([]);
    });

    it("scopes to a single tier when ?tier= is supplied", async () => {
      mockGetActiveYearlyQuote.mockResolvedValueOnce(stubQuote);
      const response = await GET(makeReq("http://localhost/api/billing/yearly-token-quote?tier=pro"));
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.data.tier).toBe("pro");
      expect(body.data.quote.id).toBe("yq_1");
      expect(mockGetActiveYearlyQuote).toHaveBeenCalledWith({ userId: "user_a", tier: "pro" });
      expect(mockGetActiveYearlyQuotes).not.toHaveBeenCalled();
    });

    it("serialises tokensRequiredRaw as a string (BigInt is not JSON-safe)", async () => {
      mockGetActiveYearlyQuotes.mockResolvedValueOnce([stubQuote]);
      const response = await GET(makeReq("http://localhost/api/billing/yearly-token-quote"));
      const body = await response.json();
      expect(body.data.pro.tokensRequiredRaw).toBe("22790697674418604651162791");
      expect(typeof body.data.pro.tokensRequiredRaw).toBe("string");
    });
  });

  describe("POST", () => {
    it("rejects missing tier", async () => {
      const response = await POST(makeReq("http://localhost/api/billing/yearly-token-quote", {}));
      expect(response.status).toBe(400);
    });

    it("rejects invalid tier values", async () => {
      const response = await POST(
        makeReq("http://localhost/api/billing/yearly-token-quote", { tier: "platinum" })
      );
      expect(response.status).toBe(400);
    });

    it.each(["token_yearly", "token_holding"])(
      "refuses a Pro year when %s already gives Power, before touching the wallet",
      async (source) => {
        mockResolveEffectiveSubscription.mockResolvedValueOnce({ plan: "fleet", source, tokenTier: "power" });
        const response = await POST(makeReq("http://localhost/api/billing/yearly-token-quote", { tier: "pro" }));
        expect(response.status).toBe(409);
        expect(mockResolveEffectiveSubscription).toHaveBeenCalledWith("user_a", { excludeStripe: true });
        expect(mockGetCredential).not.toHaveBeenCalled();
        expect(mockCreateYearlyQuote).not.toHaveBeenCalled();
      }
    );

    it("mints the quote when the entitlement lookup fails", async () => {
      mockResolveEffectiveSubscription.mockRejectedValueOnce(new Error("db down"));
      mockCreateYearlyQuote.mockResolvedValueOnce(stubQuote);
      const response = await POST(makeReq("http://localhost/api/billing/yearly-token-quote", { tier: "pro" }));
      expect(response.status).toBe(200);
      expect(mockCreateYearlyQuote).toHaveBeenCalledTimes(1);
    });

    it("still sells a same-tier or higher year to a token user", async () => {
      mockResolveEffectiveSubscription.mockResolvedValue({ plan: "operator", source: "token_yearly", tokenTier: "pro" });
      mockCreateYearlyQuote.mockResolvedValue(stubQuote);
      for (const tier of ["pro", "power"]) {
        const response = await POST(makeReq("http://localhost/api/billing/yearly-token-quote", { tier }));
        expect(response.status).not.toBe(409);
      }
      expect(mockCreateYearlyQuote).toHaveBeenCalledTimes(2);
    });

    it("looks up the user's shared credit_deposit wallet (NOT yearly_subscription, NOT hermesos_lock)", async () => {
      mockCreateYearlyQuote.mockResolvedValueOnce(stubQuote);
      await POST(makeReq("http://localhost/api/billing/yearly-token-quote", { tier: "pro" }));
      expect(mockGetCredential).toHaveBeenCalledWith({
        userId: "user_a",
        purpose: "credit_deposit",
      });
    });

    it("lazy-provisions the shared credit_deposit wallet when one does not exist yet", async () => {
      // First call: no wallet yet. Second call (after provisioning): the new credential.
      mockGetCredential.mockResolvedValueOnce(null);
      mockEnsureWallet.mockResolvedValueOnce({
        status: "provisioned",
        credential: {
          id: "cred_new",
          userId: "user_a",
          purpose: "credit_deposit",
          walletId: "w_new",
          bankrWalletId: "bw_new",
          evmAddress: "0xFreshlyProvisioned",
          normalizedEvmAddress: "0xfreshlyprovisioned",
        },
        wallet: null,
        bankrWallet: null,
      });
      mockCreateYearlyQuote.mockResolvedValueOnce({
        ...stubQuote,
        depositAddress: "0xFreshlyProvisioned",
      });

      const response = await POST(
        makeReq("http://localhost/api/billing/yearly-token-quote", { tier: "pro" })
      );

      expect(response.status).toBe(200);
      expect(mockEnsureWallet).toHaveBeenCalledWith({
        userId: "user_a",
        purpose: "credit_deposit",
        makePrimary: false,
      });
      expect(mockCreateYearlyQuote).toHaveBeenCalledWith({
        userId: "user_a",
        tier: "pro",
        depositAddress: "0xfreshlyprovisioned",
      });
    });

    it("returns 503 when Bankr provisioning is not configured", async () => {
      mockGetCredential.mockResolvedValueOnce(null);
      mockEnsureWallet.mockResolvedValueOnce({ status: "not_configured" });

      const response = await POST(
        makeReq("http://localhost/api/billing/yearly-token-quote", { tier: "pro" })
      );

      expect(response.status).toBe(503);
      expect(mockCreateYearlyQuote).not.toHaveBeenCalled();
    });

    it("forwards tier + deposit address into createYearlyTokenQuote and returns the serialised quote", async () => {
      mockCreateYearlyQuote.mockResolvedValueOnce(stubQuote);
      const response = await POST(
        makeReq("http://localhost/api/billing/yearly-token-quote", { tier: "pro" })
      );
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(mockCreateYearlyQuote).toHaveBeenCalledWith({
        userId: "user_a",
        tier: "pro",
        depositAddress: "0xcreditdepositwalletaddr",
      });
      expect(body.data.id).toBe("yq_1");
      expect(body.data.tier).toBe("pro");
      expect(body.data.depositAddress).toBe("0xCreditDepositWalletAddr");
      expect(body.data.tokensRequiredRaw).toBe("22790697674418604651162791");
    });

    it("returns 503 when the live $HERMESOS price feed is unavailable", async () => {
      const { LivePriceUnavailableError } = jest.requireMock(
        "@/lib/billing/live-thresholds"
      ) as { LivePriceUnavailableError: typeof Error };
      mockCreateYearlyQuote.mockRejectedValueOnce(
        new LivePriceUnavailableError("DEXScreener 503")
      );
      const response = await POST(
        makeReq("http://localhost/api/billing/yearly-token-quote", { tier: "pro" })
      );
      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body.error).toMatch(/try again later/i);
    });

    it("reports a refused price gate once and answers 503 without an error-level log", async () => {
      const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      const refusal = new PlatformTokenPriceGateError("deviation", "$HIVRA spot is 1500 bps above its 240-minute median");
      mockCreateYearlyQuote.mockRejectedValueOnce(refusal);

      const response = await POST(
        makeReq("http://localhost/api/billing/yearly-token-quote", { tier: "pro" })
      );

      expect(response.status).toBe(503);
      expect(mockReportPriceGateRefusal).toHaveBeenCalledTimes(1);
      expect(mockReportPriceGateRefusal).toHaveBeenCalledWith(refusal, {
        source: "billing/yearly-token-quote",
        route: "/api/billing/yearly-token-quote",
        method: "POST",
      });
      expect(consoleErrorSpy).not.toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });

    it("does not leak the underlying error message", async () => {
      const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      mockCreateYearlyQuote.mockRejectedValueOnce(
        new Error("internal_yearly_quote_secret_should_not_leak")
      );
      const response = await POST(
        makeReq("http://localhost/api/billing/yearly-token-quote", { tier: "pro" })
      );
      const body = await response.json();
      expect(response.status).toBe(500);
      expect(JSON.stringify(body)).not.toContain(
        "internal_yearly_quote_secret_should_not_leak"
      );
      consoleErrorSpy.mockRestore();
    });
  });
});
