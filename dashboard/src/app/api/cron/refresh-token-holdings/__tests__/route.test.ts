import { NextRequest } from "next/server";

import { GET } from "../route";
import { fetchLatestHermesSnapshotsByUser } from "@/lib/billing/token-holding-snapshots";
import {
  HERMESOS_TOKEN_ADDRESS,
  refreshVerifiedHermesTokenHoldings,
} from "@/lib/billing/token-holdings";

jest.mock("@/lib/billing/token-holdings", () => ({
  refreshVerifiedHermesTokenHoldings: jest.fn(),
  HERMESOS_TOKEN_ADDRESS: "0x95ccfd2b81a9667b0cc979992632f98fc853eba3",
  VVV_TOKEN_ADDRESS: "0xacfe6019ed1a7dc6f7b508c02d1b04ec88cc21bf",
  normalizeNumericToBigIntString: (value: unknown) => String(value),
  // tier-thresholds.ts re-imports this from token-holdings; without it
  // BigInt(undefined) throws when the threshold module is loaded.
  HERMESOS_TOKEN_DECIMALS: 18,
  VVV_TOKEN_DECIMALS: 18,
  HERMESOS_TOKEN_SYMBOL: "HERMESOS",
}));

// The boost step fetches a live VVV/USD price from DEX. Stub it so the test
// never touches the network. With supabaseAdmin unconfigured the VVV snapshot
// lookup returns an empty map, so no user is actually evaluated.
jest.mock("@/lib/billing/price-feed", () => ({
  ...jest.requireActual("@/lib/billing/price-feed"),
  fetchVvvPriceUsd: jest
    .fn()
    .mockResolvedValue({ priceUsd: "1", lastUpdatedAt: 0, source: "dexscreener", raw: {} }),
}));

describe("GET /api/cron/refresh-token-holdings", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, CRON_SECRET: "cron-secret" };
    (refreshVerifiedHermesTokenHoldings as jest.Mock).mockResolvedValue({
      checked: 2,
      refreshed: 1,
      noVerifiedWallet: 0,
      failed: 1,
      results: [
        {
          userId: "user_1",
          walletId: "wallet_1",
          status: "refreshed",
          snapshotId: "snapshot_1",
          qualifiesBaseTier: true,
        },
        {
          userId: "user_2",
          walletId: "wallet_2",
          status: "failed",
        },
      ],
    });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  const makeRequest = (authorization?: string, url = "http://localhost/api/cron/refresh-token-holdings") =>
    new Request(url, {
      headers: authorization ? { authorization } : {},
    }) as unknown as NextRequest;

  it("rejects requests without the cron secret", async () => {
    const response = await GET(makeRequest());

    expect(response.status).toBe(401);
    expect(refreshVerifiedHermesTokenHoldings).not.toHaveBeenCalled();
  });

  it("rejects requests when the cron secret is not configured", async () => {
    process.env = { ...originalEnv, CRON_SECRET: "" };

    const response = await GET(makeRequest("Bearer cron-secret"));
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error).toBe("Cron secret is not configured");
    expect(refreshVerifiedHermesTokenHoldings).not.toHaveBeenCalled();
  });

  it("refreshes verified token holdings and returns a compact summary", async () => {
    const response = await GET(makeRequest(
      "Bearer cron-secret",
      "http://localhost/api/cron/refresh-token-holdings?limit=25"
    ));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(refreshVerifiedHermesTokenHoldings).toHaveBeenCalledWith({ lane: "token_holdings", limit: 25 });
    expect(json.data).toEqual({
      checked: 2,
      refreshed: 1,
      noVerifiedWallet: 0,
      failed: 1,
      results: [
        {
          userId: "user_1",
          walletId: "wallet_1",
          status: "refreshed",
          snapshotId: "snapshot_1",
          qualifiesBaseTier: true,
        },
        {
          userId: "user_2",
          walletId: "wallet_2",
          status: "failed",
        },
      ],
      // After refresh, the cron also evaluates tier eligibility against
      // each refreshed user's latest snapshot. With supabaseAdmin not
      // configured in the test environment, the snapshot lookup returns
      // an empty map and no users get evaluated.
      eligibility: {
        evaluated: 0,
        evaluationFailures: 0,
        transitions: [],
        warnings: [],
      },
      // VVV compute-boost step: price is stubbed, but the VVV snapshot
      // lookup returns an empty map (no supabaseAdmin), so no user is
      // evaluated.
      veniceBoost: {
        evaluated: 0,
        eligible: 0,
        failures: 0,
        transitions: [],
      },
    });
  });

  it("does not leak backend errors", async () => {
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    (refreshVerifiedHermesTokenHoldings as jest.Mock).mockRejectedValueOnce(
      new Error("cron-token-secret-leak")
    );

    const response = await GET(makeRequest("Bearer cron-secret"));
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error).toBe("Failed to refresh token holdings");
    expect(JSON.stringify(json)).not.toContain("cron-token-secret-leak");
    expect(JSON.stringify(consoleErrorSpy.mock.calls)).not.toContain("cron-token-secret-leak");

    consoleErrorSpy.mockRestore();
  });

  it("loads eligibility balances only from Hivra snapshots", async () => {
    const snapshotsBuilder = {
      select: jest.fn().mockReturnThis(),
      in: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      order: jest.fn().mockResolvedValue({
        data: [
          {
            user_id: "user_1",
            balance_raw: "1000000000000000000",
            checked_at: "2026-04-24T12:00:00.000Z",
          },
        ],
        error: null,
      }),
    };
    const db = {
      from: jest.fn(() => snapshotsBuilder),
    };

    const result = await fetchLatestHermesSnapshotsByUser(["user_1"], db);

    expect(db.from).toHaveBeenCalledWith("token_holding_snapshots");
    expect(snapshotsBuilder.eq).toHaveBeenCalledWith("token_address", HERMESOS_TOKEN_ADDRESS);
    expect(result.get("user_1")).toBe(1000000000000000000n);
  });
});
