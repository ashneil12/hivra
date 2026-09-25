import { NextRequest } from "next/server";

const mockGetCredential = jest.fn();
const mockEnsureWallet = jest.fn();
const mockCreateQuote = jest.fn();
const mockCreateQuoteForUsdTarget = jest.fn();
const mockAssertNoActivePayment = jest.fn();

jest.mock("@/lib/billing/bankr-deposit-wallets", () => ({
  getBankrDepositWalletCredentialForUser: (...args: unknown[]) => mockGetCredential(...args),
  ensureBankrDepositWalletForUser: (...args: unknown[]) => mockEnsureWallet(...args),
}));

jest.mock("@/lib/billing/managed-venice-token-quotes", () => {
  class ManagedVeniceTokenQuotePriceError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "ManagedVeniceTokenQuotePriceError";
    }
  }

  return {
    ManagedVeniceTokenQuotePriceError,
    createManagedVeniceTokenQuote: (...args: unknown[]) => mockCreateQuote(...args),
    createManagedVeniceTokenQuoteForUsdTarget: (...args: unknown[]) =>
      mockCreateQuoteForUsdTarget(...args),
  };
});

jest.mock("@/lib/billing/crypto-payment-sessions", () => {
  class ActiveCryptoPaymentSessionError extends Error {
    session: unknown;
    constructor(session: unknown) {
      super("active payment");
      this.name = "ActiveCryptoPaymentSessionError";
      this.session = session;
    }
  }

  return {
    ActiveCryptoPaymentSessionError,
    assertNoActiveCryptoPaymentSession: (...args: unknown[]) => mockAssertNoActivePayment(...args),
    activeCryptoPaymentSessionResponse: (session: unknown) => ({ activePayment: session }),
  };
});

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
  currentUser: jest.fn().mockResolvedValue(null),
}));

const mockReportPriceGateRefusal = jest.fn<Promise<unknown>, unknown[]>(async () => ({
  refusal: { assetKey: "hermesos", asset: "$HermesOS", reason: "median_deviation", gate: "unknown", observed: {} },
  logged: true,
  alerted: false,
}));
jest.mock("@/lib/billing/price-gate-alerts", () => ({
  reportPriceGateRefusal: (...args: unknown[]) => mockReportPriceGateRefusal(...args),
}));

import { auth } from "@clerk/nextjs/server";
import { ManagedVeniceTokenQuotePriceError } from "@/lib/billing/managed-venice-token-quotes";
import { POST } from "../route";

function makeReq(body?: unknown): NextRequest {
  return new Request("http://localhost/api/billing/managed-venice/hermesos/quote", {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  }) as unknown as NextRequest;
}

const stubQuote = {
  id: "mvq_1",
  accountId: "acct_1",
  userId: "user_a",
  tokenAmountRaw: "1000000000000000000000",
  tokenSymbol: "Hivra",
  tokenDecimals: 18,
  snapshotPriceUsd: "0.05",
  lockedValueMicroUsd: 50_000_000,
  paidValueMicroUsd: 50_000_000,
  creditValueMicroUsd: 60_000_000,
  bonusValueMicroUsd: 10_000_000,
  launchBonusMicroUsd: 10_000_000,
  standardBonusMicroUsd: 0,
  depositAddress: "0xmanagedvenice",
  quotedAt: "2026-05-12T12:00:00.000Z",
  expiresAt: "2026-05-12T12:20:00.000Z",
  status: "active" as const,
  source: "dexscreener",
  crossCheckSource: "uniswap_v4_base_quoter",
  crossCheckPriceUsd: "0.051",
  priceLastUpdatedAt: "2026-05-12T12:00:00.000Z",
  crossCheckLastUpdatedAt: "2026-05-12T12:00:00.000Z",
  transactionHash: null,
  settledAt: null,
};

describe("/api/billing/managed-venice/hermesos/quote", () => {
  let consoleWarnSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_a" });
    mockGetCredential.mockResolvedValue({
      id: "cred_1",
      userId: "user_a",
      purpose: "credit_deposit",
      walletId: "w_1",
      bankrWalletId: "bw_1",
      evmAddress: "0xManagedVenice",
      normalizedEvmAddress: "0xmanagedvenice",
    });
    mockCreateQuote.mockResolvedValue(stubQuote);
    mockCreateQuoteForUsdTarget.mockResolvedValue(stubQuote);
    mockAssertNoActivePayment.mockResolvedValue(null);
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it("allows authenticated credit top-up quotes", async () => {
    const response = await POST(makeReq({ targetPaidMicroUsd: 50_000_000 }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual(stubQuote);
    expect(mockGetCredential).toHaveBeenCalledWith({
      userId: "user_a",
      purpose: "credit_deposit",
    });
    expect(mockCreateQuoteForUsdTarget).toHaveBeenCalledWith({
      userId: "user_a",
      targetMicroUsd: 50_000_000,
      depositAddress: "0xmanagedvenice",
    });
  });

  it("returns 401 before wallet work when unauthenticated", async () => {
    (auth as unknown as jest.Mock).mockResolvedValueOnce({ userId: null });

    const response = await POST(makeReq({ tokenAmountRaw: stubQuote.tokenAmountRaw }));

    expect(response.status).toBe(401);
    expect(mockGetCredential).not.toHaveBeenCalled();
  });

  it("rejects invalid token amounts", async () => {
    const response = await POST(makeReq({ tokenAmountRaw: "0" }));

    expect(response.status).toBe(400);
    expect(mockCreateQuote).not.toHaveBeenCalled();
  });

  it("lazy-provisions the shared credit_deposit wallet for managed Venice token top-ups", async () => {
    mockGetCredential.mockResolvedValueOnce(null);
    mockEnsureWallet.mockResolvedValueOnce({
      status: "provisioned",
      credential: {
        id: "cred_new",
        userId: "user_a",
        purpose: "credit_deposit",
        walletId: "w_new",
        bankrWalletId: "bw_new",
        evmAddress: "0xFreshManagedVenice",
        normalizedEvmAddress: "0xfreshmanagedvenice",
      },
    });

    const response = await POST(makeReq({ tokenAmountRaw: stubQuote.tokenAmountRaw }));

    expect(response.status).toBe(200);
    expect(mockEnsureWallet).toHaveBeenCalledWith({
      userId: "user_a",
      purpose: "credit_deposit",
      makePrimary: false,
    });
    expect(mockCreateQuote).toHaveBeenCalledWith({
      userId: "user_a",
      tokenAmountRaw: stubQuote.tokenAmountRaw,
      depositAddress: "0xfreshmanagedvenice",
    });
  });

  it("returns 503 when Bankr provisioning is not configured", async () => {
    mockGetCredential.mockResolvedValueOnce(null);
    mockEnsureWallet.mockResolvedValueOnce({ status: "not_configured" });

    const response = await POST(makeReq({ tokenAmountRaw: stubQuote.tokenAmountRaw }));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.reason).toBe("bankr_wallet_provisioning_pending");
    expect(body.error).toBe("$HermesOS top-ups are still being connected. Card credits are available now.");
    expect(mockCreateQuote).not.toHaveBeenCalled();
  });

  it("returns a plain top-up error when wallet provisioning fails internally", async () => {
    mockGetCredential.mockResolvedValueOnce(null);
    mockEnsureWallet.mockRejectedValueOnce(new Error("Invalid EVM address"));

    const response = await POST(makeReq({ tokenAmountRaw: stubQuote.tokenAmountRaw }));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.reason).toBe("wallet_provisioning_unavailable");
    expect(body.error).toBe(
      "We couldn't start the $HermesOS top-up yet. Please try again in a moment, or use card credits for now."
    );
    expect(JSON.stringify(body)).not.toContain("Invalid EVM address");
    expect(mockCreateQuote).not.toHaveBeenCalled();
  });

  it("returns a JSON-safe quote payload", async () => {
    const response = await POST(makeReq({ tokenAmountRaw: stubQuote.tokenAmountRaw }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual(stubQuote);
    expect(typeof body.data.tokenAmountRaw).toBe("string");
  });

  it("accepts a USD target and lets the server calculate the exact token amount", async () => {
    const response = await POST(makeReq({ targetPaidMicroUsd: 50_000_000 }));

    expect(response.status).toBe(200);
    expect(mockCreateQuote).not.toHaveBeenCalled();
    expect(mockCreateQuoteForUsdTarget).toHaveBeenCalledWith({
      userId: "user_a",
      targetMicroUsd: 50_000_000,
      depositAddress: "0xmanagedvenice",
    });
  });

  it("blocks new managed Venice quotes while another crypto payment is active", async () => {
    const { ActiveCryptoPaymentSessionError } = await import(
      "@/lib/billing/crypto-payment-sessions"
    );
    mockAssertNoActivePayment.mockRejectedValueOnce(
      new ActiveCryptoPaymentSessionError({
        kind: "crypto_topup",
        table: "payment_transactions",
        id: "payment_1",
        userId: "user_a",
        label: "crypto top-up",
        referenceId: "bankr_active",
        tier: null,
        asset: "usdc_base",
        amountDisplay: "10",
        tokenSymbol: "USDC",
        createdAt: "2026-05-12T12:00:00.000Z",
        expiresAt: "2026-05-12T12:20:00.000Z",
      })
    );

    const response = await POST(makeReq({ targetPaidMicroUsd: 50_000_000 }));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.activePayment.referenceId).toBe("bankr_active");
    expect(mockCreateQuote).not.toHaveBeenCalled();
    expect(mockCreateQuoteForUsdTarget).not.toHaveBeenCalled();
  });

  it("surfaces stale or disagreeing prices as a retryable 503 without leaking internals", async () => {
    mockCreateQuote.mockRejectedValueOnce(
      new ManagedVeniceTokenQuotePriceError("dexscreener_uniswap_internal_detail")
    );

    const response = await POST(makeReq({ tokenAmountRaw: stubQuote.tokenAmountRaw }));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error).toMatch(/pricing is temporarily unavailable/i);
    expect(body.reason).toBe("pricing_unavailable");
    expect(JSON.stringify(body)).not.toContain("dexscreener_uniswap_internal_detail");
  });

  it("reports each price gate refusal to the rate-limited gate log and ops alert", async () => {
    const refusal = new ManagedVeniceTokenQuotePriceError("Managed Venice token deposits are temporarily disabled");
    mockCreateQuote.mockRejectedValueOnce(refusal);

    const response = await POST(makeReq({ tokenAmountRaw: stubQuote.tokenAmountRaw }));

    expect(response.status).toBe(503);
    expect(mockReportPriceGateRefusal).toHaveBeenCalledWith(refusal, {
      source: "billing/managed-venice/hermesos/quote",
      route: "/api/billing/managed-venice/hermesos/quote",
      method: "POST",
    });
  });

  it("does not expose quote internals when persistence fails", async () => {
    mockCreateQuote.mockRejectedValueOnce(
      new Error('relation "managed_venice_token_quotes" does not exist')
    );

    const response = await POST(makeReq({ tokenAmountRaw: stubQuote.tokenAmountRaw }));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.reason).toBe("topup_temporarily_unavailable");
    expect(body.error).toBe(
      "We couldn't start the $HermesOS top-up yet. Please try again in a moment, or use card credits for now."
    );
    expect(JSON.stringify(body)).not.toContain("managed_venice_token_quotes");
  });
});
