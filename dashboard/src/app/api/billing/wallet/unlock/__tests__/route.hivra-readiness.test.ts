/**
 * Unlock while $HIVRA is not usable: no new token tier of any kind, not even
 * the price-free 1-token base tier, for an account that pays in $HIVRA. An
 * account already on a token tier keeps it.
 */
import { POST } from "../route";
import { auth } from "@clerk/nextjs/server";
import { refreshPrimaryHermesTokenHolding, getLatestHermesTokenHoldingSnapshot } from "@/lib/billing/token-holdings";
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
  VVV_TOKEN_ADDRESS: "0xvvv",
}));
jest.mock("@/lib/billing/token-tier-eligibility", () => ({
  evaluateAndRecordTokenTierEligibility: jest.fn().mockResolvedValue({}),
}));
jest.mock("@/lib/billing/venice-compute-boost", () => ({ evaluateAndRecordVeniceComputeBoost: jest.fn() }));
jest.mock("@/lib/billing/price-feed", () => ({ fetchVvvPriceUsd: jest.fn() }));
jest.mock("@/lib/billing/instance-entitlement", () => ({ resolveEffectiveSubscription: jest.fn() }));
jest.mock("@/lib/services/tier-change-service", () => ({ applyTierChange: jest.fn() }));
jest.mock("@/lib/services/pending-resize", () => ({
  redeployPendingResizes: jest.fn().mockResolvedValue({ redeployed: 0, failed: 0, skipped: 0, results: [] }),
  PENDING_RESIZE_SELECT: "id",
}));
jest.mock("@/lib/services/tier-specs", () => ({
  tierFromPlanKey: (k: string) => k,
  isPaidTier: (t: string) => ["operator", "fleet", "command"].includes(t),
  resolveEffectiveTierSpec: (tier: string) => ({ cpuLimit: 0.5, ramLimitMb: 1024, label: tier }),
}));
// A new (non-grandfathered) account after activation that holds one whole $HIVRA.
jest.mock("@/lib/billing/token-access", () => {
  const actual = jest.requireActual("@/lib/billing/token-access");
  return {
    ...actual,
    resolveUserTokenAccess: jest.fn(async () =>
      actual.computeUserTokenAccess({ phase: "active", cohort: null, now: new Date() })
    ),
    qualifiesForTokenBaseTier: jest.fn(() => true),
  };
});
const mockNewTiersAllowed = jest.fn();
jest.mock("@/lib/billing/hivra-readiness", () => ({
  ...jest.requireActual("@/lib/billing/hivra-readiness"),
  newHivraTiersAllowed: () => mockNewTiersAllowed(),
}));
// The account's computers and their current compute tier.
let mockCurrentTier: string | null = null;
jest.mock("@/lib/supabase", () => {
  const chain = (rows: () => unknown[]) => {
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "not", "limit"]) builder[m] = () => builder;
    builder.then = (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
      Promise.resolve({ data: rows(), error: null }).then(resolve);
    return builder;
  };
  return {
    supabaseAdmin: {
      from: () => chain(() => (mockCurrentTier ? [{ resource_tier: mockCurrentTier }] : [])),
    },
  };
});

beforeEach(() => {
  jest.clearAllMocks();
  (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_new" });
  (getLatestHermesTokenHoldingSnapshot as jest.Mock).mockResolvedValue(null);
  (resolveEffectiveSubscription as jest.Mock).mockResolvedValue(null);
  (applyTierChange as jest.Mock).mockResolvedValue({ instancesUpdated: 1, resizesFailed: [] });
  (refreshPrimaryHermesTokenHolding as jest.Mock).mockResolvedValue({
    status: "refreshed",
    snapshot: { id: "snap", balanceRaw: "1000000000000000000", tokenAddress: "0xhivra" },
    snapshots: [],
    balances: { hivra: 10n ** 18n },
  });
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});

it("grants the 1-token base tier once $HIVRA is usable", async () => {
  mockNewTiersAllowed.mockResolvedValue(true);
  mockCurrentTier = "credit_base";
  const body = await (await POST()).json();
  expect(body.data.tier).toBe("token_base");
});

it("grants no new base tier while $HIVRA is not usable", async () => {
  mockNewTiersAllowed.mockResolvedValue(false);
  mockCurrentTier = "credit_base";
  const body = await (await POST()).json();
  expect(body.data.tier).toBe("credit_base");
  expect(applyTierChange).toHaveBeenCalledWith(expect.objectContaining({ newTier: "credit_base" }));
});

it("keeps a base tier the account already has while $HIVRA is not usable", async () => {
  mockNewTiersAllowed.mockResolvedValue(false);
  mockCurrentTier = "token_base";
  const body = await (await POST()).json();
  expect(body.data.tier).toBe("token_base");
});
