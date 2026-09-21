import { NextRequest } from "next/server";
import { POST } from "../route";
import { auth } from "@clerk/nextjs/server";
import { ensureBankrDepositWalletForUser } from "@/lib/billing/bankr-deposit-wallets";
import { createCryptoTopUpIntent } from "@/lib/billing/crypto-topups";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));

jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {},
}));

jest.mock("@/lib/billing/bankr-deposit-wallets", () => ({
  ensureBankrDepositWalletForUser: jest.fn(),
}));

jest.mock("@/lib/billing/crypto-topups", () => ({
  createCryptoTopUpIntent: jest.fn(),
  isCryptoTopUpAssetKey: jest.fn((value: unknown) => value === "usdc_base" || value === "hermesos_base"),
}));

describe("POST /api/billing/crypto/top-up", () => {
  const userId = "user_123";
  const depositAddress = "0x000000000000000000000000000000000000dead";
  const originalNodeEnv = process.env.NODE_ENV;

  function setNodeEnv(value: string | undefined) {
    (process.env as unknown as Record<string, string | undefined>).NODE_ENV = value;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.CRYPTO_BILLING_ENABLED;
    delete process.env.NEXT_PUBLIC_CRYPTO_BILLING_ENABLED;
    (auth as unknown as jest.Mock).mockResolvedValue({ userId });
    (ensureBankrDepositWalletForUser as jest.Mock).mockResolvedValue({
      status: "provisioned",
      credential: {
        clerkUserId: userId,
        bankrWalletId: "wlt_A1b2C3d4",
        evmAddress: depositAddress,
        normalizedEvmAddress: depositAddress,
        solAddress: null,
        createdAt: "2026-04-24T11:59:00.000Z",
        updatedAt: "2026-04-24T12:00:00.000Z",
        verifiedAt: "2026-04-24T12:00:00.000Z",
      },
    });
    (createCryptoTopUpIntent as jest.Mock).mockResolvedValue({
      referenceId: "bankr_crypto_topup:test",
      status: "pending",
      provider: "bankr",
      packageCredits: 1000,
      creditUnit: "100 credits = $1",
      asset: {
        key: "usdc_base",
        label: "USDC on Base",
        symbol: "USDC",
        chainId: 8453,
        network: "Base",
        tokenAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        tokenDecimals: 6,
        topUpEnabled: true,
        pricingMode: "usd_pegged",
      },
      amountMinor: 10_000_000,
      amountDisplay: "10",
      depositAddress,
      bankrWalletId: "wlt_A1b2C3d4",
    });
  });

  afterEach(() => {
    setNodeEnv(originalNodeEnv);
    delete process.env.CRYPTO_BILLING_ENABLED;
    delete process.env.NEXT_PUBLIC_CRYPTO_BILLING_ENABLED;
  });

  function createRequest(body: Record<string, unknown> = {
    asset: "usdc_base",
    packageCredits: 1000,
  }) {
    return new NextRequest("http://localhost/api/billing/crypto/top-up", {
      method: "POST",
      body: JSON.stringify(body),
      headers: new Headers({ "content-type": "application/json" }),
    });
  }

  function createRawRequest(body: string) {
    return new NextRequest("http://localhost/api/billing/crypto/top-up", {
      method: "POST",
      body,
      headers: new Headers({ "content-type": "application/json" }),
    });
  }

  it("returns 401 when unauthorized", async () => {
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: null });

    const response = await POST(createRequest());

    expect(response.status).toBe(401);
    expect(ensureBankrDepositWalletForUser).not.toHaveBeenCalled();
  });

  it("returns 404 in production until crypto billing is enabled", async () => {
    setNodeEnv("production");

    const response = await POST(createRequest());
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toBe("Crypto billing is currently unavailable.");
    expect(auth).not.toHaveBeenCalled();
    expect(ensureBankrDepositWalletForUser).not.toHaveBeenCalled();
    expect(createCryptoTopUpIntent).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON", async () => {
    const response = await POST(createRawRequest("{bad"));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Invalid JSON body");
  });

  it("rejects unsupported assets before provisioning a wallet", async () => {
    const response = await POST(createRequest({ asset: "ethereum", packageCredits: 1000 }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Invalid crypto top-up request");
    expect(ensureBankrDepositWalletForUser).not.toHaveBeenCalled();
  });

  it("returns a clean setup error when Bankr partner config is missing", async () => {
    (ensureBankrDepositWalletForUser as jest.Mock).mockResolvedValueOnce({
      status: "not_configured",
    });

    const response = await POST(createRequest());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error).toBe("Bankr wallet provisioning is not configured");
    expect(createCryptoTopUpIntent).not.toHaveBeenCalled();
  });

  it("creates a pending USDC/Base top-up intent", async () => {
    const response = await POST(createRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.instructions).toEqual({
      network: "Base",
      asset: "USDC",
      amount: "10",
      depositAddress,
    });
    expect(ensureBankrDepositWalletForUser).toHaveBeenCalledWith({
      userId,
      purpose: "credit_deposit",
      makePrimary: true,
    });
    expect(createCryptoTopUpIntent).toHaveBeenCalledWith({
      userId,
      asset: "usdc_base",
      packageCredits: 1000,
      depositWallet: {
        address: depositAddress,
        bankrWalletId: "wlt_A1b2C3d4",
      },
    });
  });

  it("does not leak backend errors", async () => {
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    (createCryptoTopUpIntent as jest.Mock).mockRejectedValueOnce(
      new Error("bk_ptr_secret should stay private")
    );

    const response = await POST(createRequest());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe("Failed to create crypto top-up");
    expect(JSON.stringify(body)).not.toContain("bk_ptr_secret");
    expect(JSON.stringify(consoleErrorSpy.mock.calls)).not.toContain("bk_ptr_secret");

    consoleErrorSpy.mockRestore();
  });

  it("maps disabled token top-ups to a safe client error", async () => {
    (createCryptoTopUpIntent as jest.Mock).mockRejectedValueOnce(
      new Error("Crypto top-up asset is not enabled for automatic credit top-ups yet")
    );

    const response = await POST(createRequest({ asset: "hermesos_base", packageCredits: 500 }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Invalid crypto top-up request");
  });
});
