const mockAuth = jest.fn();
const mockGetWalletSummary = jest.fn();
const mockListProxyKeys = jest.fn();

jest.mock("@clerk/nextjs/server", () => ({
  auth: (...args: unknown[]) => mockAuth(...args),
  currentUser: jest.fn().mockResolvedValue(null),
}));

jest.mock("@/lib/billing/managed-venice-wallets", () => ({
  getManagedVeniceWalletSummary: (...args: unknown[]) =>
    mockGetWalletSummary(...args),
}));

jest.mock("@/lib/venice/proxy-keys", () => ({
  listManagedVeniceProxyKeys: (...args: unknown[]) => mockListProxyKeys(...args),
}));

jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: null,
}));

import { GET } from "../route";

describe("GET /api/billing/managed-venice/summary", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuth.mockResolvedValue({ userId: "user_a" });
    mockGetWalletSummary.mockResolvedValue({
      hermesos: {
        totalValueMicroUsd: 48_000_000,
        reservedMicroUsd: 8_000_000,
        availableMicroUsd: 40_000_000,
        remainingTokenAmountRaw: "2000000000000000000",
      },
      card: {
        totalValueMicroUsd: 25_000_000,
        reservedMicroUsd: 5_000_000,
        availableMicroUsd: 20_000_000,
      },
    });
    mockListProxyKeys.mockResolvedValue([]);
  });

  it("returns funded credit wallets for authenticated users", async () => {
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockGetWalletSummary).toHaveBeenCalledWith("user_a");
    expect(mockListProxyKeys).toHaveBeenCalledWith("user_a");
    expect(body.data.wallets.hermesos.availableMicroUsd).toBe(40_000_000);
    expect(body.data.wallets.card.availableMicroUsd).toBe(20_000_000);
  });

  it("still requires authentication before loading wallets", async () => {
    mockAuth.mockResolvedValueOnce({ userId: null });

    const response = await GET();

    expect(response.status).toBe(401);
    expect(mockGetWalletSummary).not.toHaveBeenCalled();
  });

  it("retries once on a transient network error, then succeeds", async () => {
    // A bare `TypeError: fetch failed` is how Node surfaces a transient upstream
    // blip; the handler should retry the whole load once rather than 500 the
    // billing page (the prod symptom behind incident #155).
    mockListProxyKeys.mockRejectedValueOnce(new TypeError("fetch failed"));

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockListProxyKeys).toHaveBeenCalledTimes(2); // initial attempt + one retry
    expect(body.data.wallets.hermesos.availableMicroUsd).toBe(40_000_000);
  });

  it("does not retry a non-transient error and fails fast", async () => {
    mockGetWalletSummary.mockRejectedValue(
      new Error('relation "x" does not exist')
    );

    const response = await GET();

    expect(response.status).toBe(500);
    expect(mockGetWalletSummary).toHaveBeenCalledTimes(1); // no wasted retry on logic errors
  });
});
