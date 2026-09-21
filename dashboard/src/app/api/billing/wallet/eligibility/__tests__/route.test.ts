/**
 * Regression test for the schema/code mismatch on token_holding_snapshots.
 *
 * The DB column is `checked_at` (per the foundation migration) and the
 * writer in lib/billing/token-holdings.ts inserts into `checked_at`.
 * Earlier work in this PR routed the wallet eligibility reader through a
 * non-existent `captured_at` column, which threw "column ... does not
 * exist" on every load. This test pins the read query to the correct
 * column and verifies the wire shape still exposes capturedAt to the
 * client (dashboard UI compatibility).
 */

import { GET } from "../route";

// ── Module mocks ─────────────────────────────────────────────────────────────

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));

// jest.mock factories are hoisted; refer to module-scope state via
// `mock`-prefixed identifiers that jest allows in the factory.
const mockCaptureColumnUsage = {
  selectArgs: [] as string[],
  eqArgs: [] as Array<[string, unknown]>,
  orderArgs: [] as string[],
};

const mockSnapshotResponse = {
  data: [
    {
      wallet_address: "0x000000000000000000000000000000000000abcd",
      normalized_wallet_address: "0x000000000000000000000000000000000000abcd",
      balance_raw: "50000000000000000000000",
      balance_display: "50000",
      checked_at: "2026-04-30T00:00:00.000Z",
    },
  ],
  error: null,
};

const mockQualResponse = { data: [], error: null };

// Mutable so a test can opt into an active Venice boost row. Reset per test.
const mockBoostState = { row: null as Record<string, unknown> | null };

jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from(table: string) {
      if (table === "venice_compute_boost_qualifications") {
        return {
          select() {
            return {
              eq() {
                return {
                  maybeSingle() {
                    return Promise.resolve({ data: mockBoostState.row, error: null });
                  },
                };
              },
            };
          },
        };
      }
      if (table === "token_holding_snapshots") {
        return {
          select(cols: string) {
            mockCaptureColumnUsage.selectArgs.push(cols);
            return {
              eq(col: string, val: unknown) {
                mockCaptureColumnUsage.eqArgs.push([col, val]);
                return this;
              },
              order(col: string) {
                mockCaptureColumnUsage.orderArgs.push(col);
                return this;
              },
              limit() {
                return Promise.resolve(mockSnapshotResponse);
              },
            };
          },
        };
      }
      if (table === "token_tier_qualifications") {
        return {
          select() {
            return {
              eq() {
                return Promise.resolve(mockQualResponse);
              },
            };
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  },
}));

jest.mock("@/lib/billing/billing-v2-availability", () => ({
  isBillingV2ServerEnabled: () => true,
  BILLING_V2_UNAVAILABLE_MESSAGE: "Billing v2 is currently unavailable.",
}));

jest.mock("@/lib/billing/tier-thresholds", () => ({
  getTierThresholds: () => ({
    source: "configured" as const,
    thresholds: { pro: 200000n, power: 500000n },
  }),
  HERMESOS_TOKEN_DECIMALS: 18,
  isFoundersRateUser: () => false,
}));

const mockGetLive = jest.fn();
jest.mock("@/lib/billing/live-thresholds", () => {
  class LivePriceUnavailableError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "LivePriceUnavailableError";
    }
  }
  return {
    LivePriceUnavailableError,
    getLiveActiveThresholds: (...args: unknown[]) => mockGetLive(...args),
  };
});

jest.mock("@/lib/billing/token-holdings", () => ({
  BASE_CHAIN_ID: 8453,
  HERMESOS_TOKEN_ADDRESS: "0x95ccfd2b81a9667b0cc979992632f98fc853eba3",
  HERMESOS_TOKEN_SYMBOL: "HERMESOS",
  VVV_TOKEN_ADDRESS: "0xacfe6019ed1a7dc6f7b508c02d1b04ec88cc21bf",
  VVV_TOKEN_DECIMALS: 18,
  getVvvStakingContractAddress: jest.fn(() => null),
}));

// The route now prices VVV to show "Hold at least N VVV". Stub the DEX call
// (keep the pure token-math real) so the test never hits the network.
jest.mock("@/lib/billing/price-feed", () => ({
  ...jest.requireActual("@/lib/billing/price-feed"),
  fetchVvvPriceUsd: jest
    .fn()
    .mockResolvedValue({ priceUsd: "0.5", lastUpdatedAt: 0, source: "dexscreener", raw: {} }),
}));

import { auth } from "@clerk/nextjs/server";

describe("GET /api/billing/wallet/eligibility", () => {
  let consoleWarnSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    mockCaptureColumnUsage.selectArgs = [];
    mockCaptureColumnUsage.eqArgs = [];
    mockCaptureColumnUsage.orderArgs = [];
    mockBoostState.row = null;
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_a" });
    mockGetLive.mockReset();
    mockGetLive.mockResolvedValue({
      epoch: "launch" as const,
      promoEndsAt: new Date("2026-05-30T23:59:59.000Z"),
      pro: { tier: "pro", epoch: "launch", code: "PRO_LAUNCH", amount: 200000n },
      power: { tier: "power", epoch: "launch", code: "POWER_LAUNCH", amount: 500000n },
      priceUsd: "0.00002609",
      priceFetchedAt: new Date("2026-04-30T12:00:00.000Z"),
    });
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it("queries token_holding_snapshots by checked_at (NOT captured_at — that column does not exist)", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(mockCaptureColumnUsage.selectArgs[0]).toContain("checked_at");
    expect(mockCaptureColumnUsage.selectArgs[0]).not.toContain("captured_at");
    expect(mockCaptureColumnUsage.orderArgs).toContain("checked_at");
    expect(mockCaptureColumnUsage.orderArgs).not.toContain("captured_at");
  });

  it("casts balance_raw to ::text to avoid PostgREST numeric → JSON-Number precision loss", async () => {
    // Postgres numeric(78,0) values > 2^53 round to floats when emitted
    // as JSON numbers. The wallet eligibility API must request the
    // column as text so a 500,000-token holder's balance survives the
    // wire round-trip without being mis-rendered as 499,999.999...
    await GET();

    expect(mockCaptureColumnUsage.selectArgs[0]).toContain("balance_raw::text");
  });

  it("filters the balance snapshot to Hivra on Base so VVV snapshots cannot masquerade as Hivra balance", async () => {
    await GET();

    expect(mockCaptureColumnUsage.eqArgs).toContainEqual(["user_id", "user_a"]);
    expect(mockCaptureColumnUsage.eqArgs).toContainEqual(["chain_id", 8453]);
    expect(mockCaptureColumnUsage.eqArgs).toContainEqual([
      "token_address",
      "0x95ccfd2b81a9667b0cc979992632f98fc853eba3",
    ]);
  });

  it("maps DB checked_at to wire-level capturedAt for dashboard UI compatibility", async () => {
    const response = await GET();
    const body = await response.json();

    expect(body.success).toBe(true);
    // The wire shape uses capturedAt — the dashboard wallet page reads it.
    expect(body.data.balance).toMatchObject({
      balanceRaw: "50000000000000000000000",
      balanceDisplay: "50000",
      capturedAt: "2026-04-30T00:00:00.000Z",
    });
  });

  it("returns the verified wallet address with the latest balance snapshot", async () => {
    const response = await GET();
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(mockCaptureColumnUsage.selectArgs[0]).toContain("wallet_address");
    expect(mockCaptureColumnUsage.selectArgs[0]).toContain("normalized_wallet_address");
    expect(body.data.balance).toMatchObject({
      walletAddress: "0x000000000000000000000000000000000000abcd",
      normalizedWalletAddress: "0x000000000000000000000000000000000000abcd",
    });
  });

  it("rejects unauthenticated requests", async () => {
    (auth as unknown as jest.Mock).mockResolvedValueOnce({ userId: null });
    const response = await GET();
    expect(response.status).toBe(401);
  });

  it("exposes the live-priced $HERMESOS price + fetch timestamp so the dashboard can render the price line", async () => {
    const response = await GET();
    const body = await response.json();

    expect(body.data.thresholds).toMatchObject({
      configured: true,
      priceUsd: "0.00002609",
      priceFetchedAt: "2026-04-30T12:00:00.000Z",
      epoch: "launch",
    });
    expect(body.data.thresholds).not.toHaveProperty("source");
  });

  it("exposes the Venice compute-boost block (threshold + bonus + eligibility) for the wallet UI", async () => {
    // Default: no boost row → not eligible, but the block + constants are present.
    const idle = await GET();
    const idleBody = await idle.json();
    expect(idleBody.data.veniceBoost).toMatchObject({
      thresholdUsd: 199,
      cpuBonus: 1,
      ramBonusMb: 2048,
      currentlyEligible: false,
      // $199 ÷ $0.50 = 398 VVV (whole-token, rounded up).
      requiredVvvDisplay: "398",
    });

    // Active boost row → currentlyEligible true.
    mockBoostState.row = {
      currently_eligible: true,
      last_usd_value: "250.5",
      last_evaluated_at: "2026-05-22T00:00:00.000Z",
      last_breach_at: null,
    };
    const active = await GET();
    const activeBody = await active.json();
    expect(activeBody.data.veniceBoost).toMatchObject({
      currentlyEligible: true,
      lastUsdValue: "250.5",
    });
  });

  it("returns 503 when the live price feed is unavailable so the dashboard can show 'try again later'", async () => {
    const { LivePriceUnavailableError } = jest.requireMock(
      "@/lib/billing/live-thresholds"
    ) as { LivePriceUnavailableError: typeof Error };
    mockGetLive.mockRejectedValueOnce(new LivePriceUnavailableError("CoinGecko 503"));

    const response = await GET();
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toMatch(/try again later/i);
  });
});
