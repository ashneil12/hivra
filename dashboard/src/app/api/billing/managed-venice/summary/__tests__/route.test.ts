const mockAuth = jest.fn();
const mockGetWalletSummary = jest.fn();
const mockListProxyKeys = jest.fn();
const mockSupabaseFrom = jest.fn();

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
  supabaseAdmin: {
    from: (...args: unknown[]) => mockSupabaseFrom(...args),
  },
}));

import { GET } from "../route";

// Chainable read that resolves to `result` when awaited or ended with maybeSingle().
function readBuilder(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {};
  builder.select = jest.fn(() => builder);
  builder.eq = jest.fn(() => builder);
  builder.maybeSingle = jest.fn(async () => result);
  builder.then = (
    resolve: (value: unknown) => unknown,
    reject?: (reason: unknown) => unknown
  ) => Promise.resolve(result).then(resolve, reject);
  return builder;
}

function mockSubsidyReads(events: {
  data: unknown;
  error: unknown;
}, platformState: { data: unknown; error: unknown }) {
  mockSupabaseFrom.mockImplementation((table: string) =>
    table === "managed_venice_financial_events"
      ? readBuilder(events)
      : readBuilder(platformState)
  );
}

describe("GET /api/billing/managed-venice/summary", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSubsidyReads(
      { data: [], error: null },
      { data: null, error: null }
    );
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

  it("reports the real subsidy totals and kill switch state when both reads succeed", async () => {
    mockSubsidyReads(
      {
        data: [
          {
            discount_micro_usd: 1_000,
            metadata: { rate: "launch_20" },
            created_at: new Date().toISOString(),
          },
        ],
        error: null,
      },
      { data: { weekly_kill_switch_active: false, weekly_subsidy_used_micro_usd: 5_000 }, error: null }
    );

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.discount.launchSubsidyUsedMicroUsd).toBe(1_000);
    expect(body.data.killSwitch.active).toBe(false);
    expect(body.data.killSwitch.weeklySubsidyUsedMicroUsd).toBe(5_000);
  });

  it("fails closed with 503 when the subsidy usage read errors, instead of showing the full allowance", async () => {
    mockSubsidyReads(
      { data: null, error: { message: "permission-denied-secret" } },
      { data: null, error: null }
    );

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error).toMatch(/temporarily unavailable/i);
    expect(body).not.toHaveProperty("data");
    expect(JSON.stringify(body)).not.toContain("permission-denied-secret");
  });

  it("fails closed with 503 when the kill switch read errors instead of reporting it off", async () => {
    mockSubsidyReads(
      { data: [], error: null },
      { data: null, error: { message: "platform-state-secret" } }
    );

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).not.toHaveProperty("data");
    expect(JSON.stringify(body)).not.toContain("platform-state-secret");
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
