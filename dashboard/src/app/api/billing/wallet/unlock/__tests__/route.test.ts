import { POST } from "../route";
import { auth } from "@clerk/nextjs/server";
import {
  refreshPrimaryHermesTokenHolding,
  getLatestHermesTokenHoldingSnapshot,
} from "@/lib/billing/token-holdings";
import { evaluateAndRecordVeniceComputeBoost } from "@/lib/billing/venice-compute-boost";
import { fetchVvvPriceUsd } from "@/lib/billing/price-feed";
import { resolveEffectiveSubscription } from "@/lib/billing/instance-entitlement";
import { applyTierChange } from "@/lib/services/tier-change-service";

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/billing/billing-v2-availability", () => ({
  isBillingV2ServerEnabled: () => true,
  BILLING_V2_UNAVAILABLE_MESSAGE: "Billing v2 unavailable.",
}));
jest.mock("@/lib/billing/token-holdings", () => ({
  refreshPrimaryHermesTokenHolding: jest.fn(),
  getLatestHermesTokenHoldingSnapshot: jest.fn(),
  qualifiesForHermesBaseTier: jest.fn(() => true),
  VVV_TOKEN_ADDRESS: "0xvvv",
}));
jest.mock("@/lib/billing/token-tier-eligibility", () => ({
  evaluateAndRecordTokenTierEligibility: jest.fn().mockResolvedValue({}),
}));
jest.mock("@/lib/billing/venice-compute-boost", () => ({
  evaluateAndRecordVeniceComputeBoost: jest.fn(),
}));
jest.mock("@/lib/billing/price-feed", () => ({
  fetchVvvPriceUsd: jest.fn(),
}));
jest.mock("@/lib/billing/instance-entitlement", () => ({
  resolveEffectiveSubscription: jest.fn(),
}));
jest.mock("@/lib/services/tier-change-service", () => ({
  applyTierChange: jest.fn(),
}));
jest.mock("@/lib/services/pending-resize", () => ({
  redeployPendingResizes: jest.fn().mockResolvedValue({ redeployed: 0, failed: 0, skipped: 0, results: [] }),
  PENDING_RESIZE_SELECT: "id",
}));
jest.mock("@/lib/services/tier-specs", () => ({
  tierFromPlanKey: (k: string) => (["operator", "fleet", "command"].includes(k) ? k : "credit_base"),
  isPaidTier: (t: string) => ["operator", "fleet", "command"].includes(t),
  resolveEffectiveTierSpec: (tier: string, boost: boolean) =>
    tier === "operator"
      ? { cpuLimit: boost ? 3 : 2, ramLimitMb: boost ? 6144 : 4096, label: "Operator" }
      : { cpuLimit: 0.5, ramLimitMb: 1024, label: tier },
}));

const mockAuth = auth as unknown as jest.Mock;
const mockRefresh = refreshPrimaryHermesTokenHolding as jest.Mock;
const mockLatest = getLatestHermesTokenHoldingSnapshot as jest.Mock;
const mockBoostEval = evaluateAndRecordVeniceComputeBoost as jest.Mock;
const mockPrice = fetchVvvPriceUsd as jest.Mock;
const mockSub = resolveEffectiveSubscription as jest.Mock;
const mockApply = applyTierChange as jest.Mock;

let consoleErr: jest.SpyInstance;
let consoleWarn: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth.mockResolvedValue({ userId: "user_a" });
  mockLatest.mockResolvedValue(null); // not throttled by default
  mockPrice.mockResolvedValue({ priceUsd: "1", lastUpdatedAt: 0, source: "dexscreener", raw: {} });
  mockBoostEval.mockResolvedValue({ eligible: true, transition: "qualified", usdValue: 250, inGrace: false });
  mockSub.mockResolvedValue({ plan: "operator", status: "active", source: "stripe" });
  mockApply.mockResolvedValue({ instancesUpdated: 1, resizesAttempted: 1, resizesSucceeded: 1, resizesFailed: [], userId: "user_a", newTier: "operator" });
  mockRefresh.mockResolvedValue({
    status: "refreshed",
    snapshot: { id: "snap1", balanceRaw: "1000000000000000000", tokenAddress: "0xhermes" },
    snapshots: [
      { tokenAddress: "0xhermes", balanceRaw: "1000000000000000000" },
      { tokenAddress: "0xvvv", balanceRaw: "250000000000000000000" },
    ],
  });
  consoleErr = jest.spyOn(console, "error").mockImplementation(() => {});
  consoleWarn = jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  consoleErr?.mockRestore();
  consoleWarn?.mockRestore();
});

describe("POST /api/billing/wallet/unlock", () => {
  it("rejects unauthenticated requests", async () => {
    mockAuth.mockResolvedValueOnce({ userId: null });
    const res = await POST();
    expect(res.status).toBe(401);
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("throttles when holdings were just refreshed", async () => {
    mockLatest.mockResolvedValueOnce({ checkedAt: new Date().toISOString(), balanceRaw: "0" });
    const res = await POST();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.throttled).toBe(true);
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(mockApply).not.toHaveBeenCalled();
  });

  it("404s when there is no verified lock wallet", async () => {
    mockRefresh.mockResolvedValueOnce({ status: "no_verified_wallet", snapshot: null });
    const res = await POST();
    expect(res.status).toBe(404);
    expect(mockApply).not.toHaveBeenCalled();
  });

  it("runs the full unlock: evaluates boost and live-applies the boosted tier", async () => {
    const res = await POST();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.throttled).toBe(false);
    expect(body.data.tier).toBe("operator");
    expect(body.data.veniceBoostActive).toBe(true);
    expect(body.data.applied).toMatchObject({ cpuLimit: 3, ramLimit: 6144, instancesUpdated: 1, resizeFailures: 0 });

    // Boost evaluated against the VVV snapshot + DEX price.
    expect(mockBoostEval).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user_a", vvvBalanceRaw: 250000000000000000000n, vvvPriceUsd: "1" })
    );
    // Compute live-applied with the boost.
    expect(mockApply).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user_a", newTier: "operator", veniceBoost: true, source: "manual" })
    );
  });

  it("still unlocks the base tier when the VVV price feed is down (boost skipped)", async () => {
    mockPrice.mockRejectedValueOnce(new Error("dex down"));
    const res = await POST();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.veniceBoostActive).toBe(false);
    // Boost not eligible (skipped) → applyTierChange called with veniceBoost false.
    expect(mockApply).toHaveBeenCalledWith(
      expect.objectContaining({ newTier: "operator", veniceBoost: false })
    );
  });
});
