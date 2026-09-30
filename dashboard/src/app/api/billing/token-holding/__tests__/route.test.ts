import { NextRequest } from "next/server";
import { GET, POST } from "../route";
import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";
import {
  getLatestHermesTokenHoldingSnapshot,
  getTokenVerificationWallet,
  refreshPrimaryHermesTokenHolding,
} from "@/lib/billing/token-holdings";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));

jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {},
}));

jest.mock("@/lib/billing/token-holdings", () => ({
  BASE_CHAIN_ID: 8453,
  HERMESOS_BASE_TIER_MIN_RAW: "1000000000000000000",
  HERMESOS_TOKEN_ADDRESS: "0x95ccfd2b81a9667b0cc979992632f98fc853eba3",
  HERMESOS_TOKEN_DECIMALS: 18,
  HERMESOS_TOKEN_SYMBOL: "Hivra",
  formatRawTokenBalance: jest.fn(() => "1"),
  getLatestHermesTokenHoldingSnapshot: jest.fn(),
  getTokenVerificationWallet: jest.fn(),
  refreshPrimaryHermesTokenHolding: jest.fn(),
  platformTokenBalanceConfig: (token: { chainId: number; address: string; symbol: string; decimals: number }) => ({
    chainId: token.chainId,
    tokenAddress: token.address,
    tokenSymbol: token.symbol,
    tokenDecimals: token.decimals,
    baseTierMinimumRaw: (10n ** BigInt(token.decimals)).toString(),
  }),
}));

// $HIVRA is dormant in these tests: the access-aware snapshot reader is the
// $HermesOS one, as in production before activation.
jest.mock("@/lib/billing/token-access", () => {
  const actual = jest.requireActual("@/lib/billing/token-access");
  const holdings = jest.requireMock("@/lib/billing/token-holdings");
  return {
    ...actual,
    resolveUserTokenAccess: jest.fn(async () =>
      actual.computeUserTokenAccess({ phase: "dormant", cohort: null, now: new Date() })
    ),
    getLatestAccessTokenHoldingSnapshot: jest.fn((userId: string) =>
      holdings.getLatestHermesTokenHoldingSnapshot(userId)
    ),
  };
});

describe("/api/billing/token-holding", () => {
  const userId = "user_123";
  const originalNodeEnv = process.env.NODE_ENV;
  let consoleErrorSpy: jest.SpyInstance;

  function setNodeEnv(value: string | undefined) {
    (process.env as unknown as Record<string, string | undefined>).NODE_ENV = value;
  }

  function createPostRequest() {
    return new NextRequest("http://localhost/api/billing/token-holding", {
      method: "POST",
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.CRYPTO_BILLING_ENABLED;
    delete process.env.NEXT_PUBLIC_CRYPTO_BILLING_ENABLED;
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    (auth as unknown as jest.Mock).mockResolvedValue({ userId });
    (getTokenVerificationWallet as jest.Mock).mockResolvedValue({
      id: "wallet_1",
      address: "0x000000000000000000000000000000000000dEaD",
      normalizedAddress: "0x000000000000000000000000000000000000dead",
      chainId: 8453,
      verifiedAt: "2026-04-24T12:00:00.000Z",
    });
    (getLatestHermesTokenHoldingSnapshot as jest.Mock).mockResolvedValue({
      id: "snapshot_1",
      balance: 1,
      balanceDisplay: "1",
      qualifiesBaseTier: true,
      checkedAt: "2026-04-24T12:01:00.000Z",
    });
  });

  afterEach(() => {
    setNodeEnv(originalNodeEnv);
    delete process.env.CRYPTO_BILLING_ENABLED;
    delete process.env.NEXT_PUBLIC_CRYPTO_BILLING_ENABLED;
    consoleErrorSpy.mockRestore();
  });

  it("returns 404 in production until crypto billing is enabled", async () => {
    setNodeEnv("production");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toBe("Crypto billing is currently unavailable.");
    expect(auth).not.toHaveBeenCalled();
    expect(getTokenVerificationWallet).not.toHaveBeenCalled();
    expect(getLatestHermesTokenHoldingSnapshot).not.toHaveBeenCalled();
  });

  it("returns the current verified wallet and latest token snapshot", async () => {
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({
      token: {
        chainId: 8453,
        tokenSymbol: "HermesOS",
        minimumBalanceDisplay: "1",
      },
      wallet: {
        id: "wallet_1",
      },
      snapshot: {
        id: "snapshot_1",
        qualifiesBaseTier: true,
      },
      entitlement: {
        verified: true,
        qualifiesBaseTier: true,
      },
    });
    expect(getTokenVerificationWallet).toHaveBeenCalledWith(userId);
    expect(getLatestHermesTokenHoldingSnapshot).toHaveBeenCalledWith(userId);
  });

  it("refreshes the primary verified wallet snapshot", async () => {
    (refreshPrimaryHermesTokenHolding as jest.Mock).mockResolvedValue({
      status: "refreshed",
      snapshot: {
        id: "snapshot_2",
        qualifiesBaseTier: true,
      },
    });

    const response = await POST(createPostRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.refresh).toMatchObject({
      status: "refreshed",
      snapshot: {
        id: "snapshot_2",
      },
    });
    expect(body.data.entitlement).toEqual({
      verified: true,
      qualifiesBaseTier: true,
    });
    expect(refreshPrimaryHermesTokenHolding).toHaveBeenCalledWith({ userId });
  });

  it("returns a clean refresh response when no verified wallet exists", async () => {
    (refreshPrimaryHermesTokenHolding as jest.Mock).mockResolvedValue({
      status: "no_verified_wallet",
      snapshot: null,
    });

    const response = await POST(createPostRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.refresh).toEqual({
      status: "no_verified_wallet",
      snapshot: null,
    });
    expect(body.data.entitlement).toEqual({
      verified: false,
      qualifiesBaseTier: false,
    });
  });

  it("does not leak backend errors", async () => {
    (getTokenVerificationWallet as jest.Mock).mockRejectedValueOnce(
      new Error("token-secret-leak")
    );

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe("Failed to load token holding");
    expect(JSON.stringify(body)).not.toContain("token-secret-leak");
    expect(JSON.stringify(consoleErrorSpy.mock.calls)).not.toContain("token-secret-leak");
    expect(supabaseAdmin).toBeDefined();
  });
});
