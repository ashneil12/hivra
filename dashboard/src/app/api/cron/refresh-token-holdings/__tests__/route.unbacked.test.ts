/**
 * An account whose Pro/Power (or Venice boost) standing has no verification
 * wallet behind it must be judged at a zero balance, not skipped.
 *
 * Before the fix the cron evaluated only accounts whose balance refresh
 * succeeded. An account whose signed wallet had been displaced as primary
 * (a crypto payment used to promote the Bankr deposit wallet) came back
 * `no_verified_wallet` on every run, so its `currently_eligible` qualification
 * was never breached and the tier became permanent.
 */
import { NextRequest } from "next/server";

import { GET } from "../route";
import { refreshVerifiedHermesTokenHoldings } from "@/lib/billing/token-holdings";
import {
  fetchLatestPlatformTokenBalancesByUser,
  fetchLatestVvvSnapshotsByUser,
} from "@/lib/billing/token-holding-snapshots";
import { resolveTokenAccessForUsers } from "@/lib/billing/token-access";
import { evaluateAndRecordTokenTierEligibility } from "@/lib/billing/token-tier-eligibility";
import { evaluateAndRecordVeniceComputeBoost } from "@/lib/billing/venice-compute-boost";
import { sendTierEligibilityNotification } from "@/lib/email/tier-eligibility-notifications";

jest.mock("@/lib/billing/token-holdings", () => ({
  refreshVerifiedHermesTokenHoldings: jest.fn(),
}));
jest.mock("@/lib/billing/token-holding-snapshots", () => ({
  fetchLatestPlatformTokenBalancesByUser: jest.fn(),
  fetchLatestVvvSnapshotsByUser: jest.fn(),
}));
jest.mock("@/lib/billing/token-access", () => ({
  resolveTokenAccessForUsers: jest.fn(),
}));
jest.mock("@/lib/billing/token-tier-eligibility", () => ({
  evaluateAndRecordTokenTierEligibility: jest.fn(),
}));
jest.mock("@/lib/billing/venice-compute-boost", () => ({
  evaluateAndRecordVeniceComputeBoost: jest.fn(),
}));
jest.mock("@/lib/billing/price-feed", () => ({
  fetchVvvPriceUsd: jest.fn(async () => ({ priceUsd: "2.5", lastUpdatedAt: 0, source: "dexscreener", raw: {} })),
}));
jest.mock("@/lib/email/tier-eligibility-notifications", () => ({
  sendTierEligibilityNotification: jest.fn(async () => undefined),
}));
jest.mock("@/lib/ops-events", () => ({ reportOpsEvent: jest.fn(async () => undefined) }));

const accessHeld = { phase: "dormant" };
const accessUnbacked = { phase: "dormant", unbacked: true };

function makeRequest() {
  return new Request("http://localhost/api/cron/refresh-token-holdings", {
    headers: { authorization: "Bearer cron-secret" },
  }) as unknown as NextRequest;
}

describe("GET /api/cron/refresh-token-holdings: standing without a verification wallet", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, CRON_SECRET: "cron-secret" };
    (refreshVerifiedHermesTokenHoldings as jest.Mock).mockResolvedValue({
      checked: 3,
      refreshed: 1,
      noVerifiedWallet: 1,
      failed: 1,
      results: [
        { userId: "user_held", status: "refreshed", snapshotId: "snapshot_1", qualifiesBaseTier: true },
        { userId: "user_unbacked", status: "no_verified_wallet" },
        // A failed read (RPC outage) is never judged: it is not a zero balance.
        { userId: "user_rpc_failed", status: "failed" },
      ],
    });
    (fetchLatestPlatformTokenBalancesByUser as jest.Mock).mockResolvedValue(
      new Map([["user_held", { hermesos: 7n }]])
    );
    (fetchLatestVvvSnapshotsByUser as jest.Mock).mockResolvedValue(new Map([["user_held", 3n]]));
    (resolveTokenAccessForUsers as jest.Mock).mockImplementation(async (userIds: string[]) =>
      new Map(userIds.map((id) => [id, id === "user_unbacked" ? accessUnbacked : accessHeld]))
    );
    (evaluateAndRecordTokenTierEligibility as jest.Mock).mockImplementation(async ({ userId }) => ({
      configured: true,
      warnings: [],
      pro: null,
      power:
        userId === "user_unbacked"
          ? { transition: "breached", balance: 0n }
          : { transition: "unchanged", balance: 7n },
    }));
    (evaluateAndRecordVeniceComputeBoost as jest.Mock).mockImplementation(async ({ userId }) => ({
      eligible: userId !== "user_unbacked",
      transition: userId === "user_unbacked" ? "breached" : "unchanged",
      usdValue: 0,
      inGrace: userId === "user_unbacked",
    }));
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("judges the unbacked account's tier rows at a zero balance in every platform token", async () => {
    const response = await GET(makeRequest());
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(evaluateAndRecordTokenTierEligibility).toHaveBeenCalledWith({
      userId: "user_unbacked",
      balances: { hermesos: 0n, hivra: 0n },
      access: accessUnbacked,
    });
    expect(evaluateAndRecordTokenTierEligibility).toHaveBeenCalledWith({
      userId: "user_held",
      balances: { hermesos: 7n },
      access: accessHeld,
    });
    expect(evaluateAndRecordTokenTierEligibility).not.toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user_rpc_failed" })
    );
    expect(json.data.eligibility.evaluated).toBe(2);
    expect(json.data.eligibility.transitions).toEqual([
      { userId: "user_unbacked", tier: "power", transition: "breached" },
    ]);
    expect(sendTierEligibilityNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user_unbacked", tier: "power", transition: "breached", currentBalance: 0n })
    );
    // The holdings cron pages through accounts on its own cursor lane.
    expect(refreshVerifiedHermesTokenHoldings).toHaveBeenCalledWith({ lane: "token_holdings", limit: 100 });
  });

  it("judges the unbacked account's Venice boost at a zero VVV balance", async () => {
    const response = await GET(makeRequest());
    const json = await response.json();

    expect(evaluateAndRecordVeniceComputeBoost).toHaveBeenCalledWith({
      userId: "user_unbacked",
      vvvBalanceRaw: 0n,
      vvvPriceUsd: "2.5",
    });
    expect(evaluateAndRecordVeniceComputeBoost).toHaveBeenCalledWith({
      userId: "user_held",
      vvvBalanceRaw: 3n,
      vvvPriceUsd: "2.5",
    });
    expect(evaluateAndRecordVeniceComputeBoost).not.toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user_rpc_failed" })
    );
    expect(json.data.veniceBoost.transitions).toEqual([{ userId: "user_unbacked", transition: "breached" }]);
  });
});
