/**
 * refresh-token-tiers with $HIVRA ACTIVATED at a test address: which tokens'
 * holdings and tier rows count for grandfathered and new users.
 */
import { NextRequest } from "next/server";

jest.mock("@/lib/billing/hivra-token-launch", () => ({
  HIVRA_TOKEN_LAUNCH: {
    contractAddress: "0x1111111111111111111111111111111111111111",
    decimals: 18,
    poolId: `0x${"ab".repeat(32)}`,
    activatesAt: "2026-01-01T00:00:00Z",
  },
}));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock("@/lib/services/tier-change-service", () => ({ applyTierChange: jest.fn(async () => ({})) }));
jest.mock("@/lib/billing/token-holdings", () => ({
  refreshVerifiedHermesTokenHoldings: jest.fn(async () => ({ refreshed: 0, failed: 0 })),
}));
jest.mock("@/lib/billing/venice-compute-boost", () => ({
  fetchVeniceBoostEligibleUsers: jest.fn(async () => new Set<string>()),
}));
// Access comes from the cohort; the cron's own token filtering is under test.
jest.mock("@/lib/billing/token-access", () => {
  const actual = jest.requireActual("@/lib/billing/token-access");
  return {
    ...actual,
    resolveTokenAccessForUsers: jest.fn(async (userIds: string[]) => {
      const now = new Date();
      return new Map(
        userIds.map((userId) => [
          userId,
          actual.computeUserTokenAccess({
            phase: "active",
            cohort: userId.startsWith("old")
              ? { user_id: userId, converted_at: null, conversion_grace_ends_at: null, metadata: {} }
              : null,
            now,
          }),
        ])
      );
    }),
  };
});

import { POST } from "../route";
import { supabaseAdmin } from "@/lib/supabase";
import { applyTierChange } from "@/lib/services/tier-change-service";

const HERMESOS = "0x95ccfd2b81a9667b0cc979992632f98fc853eba3";
const HIVRA = "0x1111111111111111111111111111111111111111";
const ONE = "1000000000000000000";

function thenable<T>(data: T) {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "in", "eq", "gte", "not", "order"]) builder[method] = jest.fn(() => builder);
  builder.then = (resolve: (value: { data: T; error: null }) => unknown) =>
    Promise.resolve({ data, error: null }).then(resolve);
  return builder;
}

function mockTables(tables: {
  instances: Array<{ user_id: string; resource_tier: string }>;
  snapshots: Array<{ user_id: string; token_address: string; balance_raw: string }>;
  qualifications?: Array<{ user_id: string; tier: "pro" | "power"; token_key: string }>;
}) {
  const snapshotBuilder = thenable(
    tables.snapshots.map((s) => ({ ...s, qualifies_base_tier: BigInt(s.balance_raw) >= BigInt(ONE), checked_at: new Date().toISOString() }))
  );
  (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
    if (table === "hermes_instances") {
      return thenable(tables.instances.map((i) => ({ ...i, cpu_limit: 0.5, ram_limit: 1024 })));
    }
    if (table === "token_holding_snapshots") return snapshotBuilder;
    if (table === "token_tier_qualifications") {
      return thenable((tables.qualifications ?? []).map((q) => ({ ...q, currently_eligible: true })));
    }
    return thenable([]);
  });
  return { snapshotBuilder };
}

function request() {
  return new Request("http://localhost/api/cron/refresh-token-tiers", {
    method: "POST",
    headers: { authorization: "Bearer cron-secret" },
  }) as unknown as NextRequest;
}

const ORIGINAL_ENV = process.env;
beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...ORIGINAL_ENV, CRON_SECRET: "cron-secret" };
});
afterAll(() => {
  process.env = ORIGINAL_ENV;
});

it("reads snapshots for both live platform tokens", async () => {
  const { snapshotBuilder } = mockTables({ instances: [], snapshots: [] });
  await POST(request());
  // No users: the snapshot scan is skipped entirely; with users it filters by both.
  mockTables({ instances: [{ user_id: "new_1", resource_tier: "credit_base" }], snapshots: [] });
  await POST(request());
  const builder = (supabaseAdmin!.from as jest.Mock).mock.results
    .map((r) => r.value)
    .find((b) => (b.in as jest.Mock)?.mock.calls.some((c: unknown[]) => c[0] === "token_address"));
  expect(builder.in).toHaveBeenCalledWith("token_address", [HERMESOS, HIVRA]);
  expect(snapshotBuilder).toBeDefined();
});

it("a new user's $HermesOS balance does not grant the token base tier; $HIVRA does", async () => {
  mockTables({
    instances: [
      { user_id: "new_hermesos", resource_tier: "credit_base" },
      { user_id: "new_hivra", resource_tier: "credit_base" },
    ],
    snapshots: [
      { user_id: "new_hermesos", token_address: HERMESOS, balance_raw: "5000000000000000000000" },
      { user_id: "new_hivra", token_address: HIVRA, balance_raw: ONE },
    ],
  });
  await POST(request());
  expect(applyTierChange).toHaveBeenCalledWith(expect.objectContaining({ userId: "new_hivra", newTier: "token_base" }));
  // The $HermesOS-only new user stays on credit_base (no change applied).
  expect(applyTierChange).not.toHaveBeenCalledWith(expect.objectContaining({ userId: "new_hermesos" }));
});

it("a grandfathered user keeps the base tier on $HermesOS alone", async () => {
  mockTables({
    instances: [{ user_id: "old_holder", resource_tier: "credit_base" }],
    snapshots: [
      { user_id: "old_holder", token_address: HERMESOS, balance_raw: ONE },
      { user_id: "old_holder", token_address: HIVRA, balance_raw: "0" },
    ],
  });
  await POST(request());
  expect(applyTierChange).toHaveBeenCalledWith(expect.objectContaining({ userId: "old_holder", newTier: "token_base" }));
});

it("counts a grandfathered user's $HermesOS Pro row and ignores a non-member's", async () => {
  mockTables({
    instances: [
      { user_id: "old_pro", resource_tier: "credit_base" },
      { user_id: "new_pro", resource_tier: "credit_base" },
    ],
    snapshots: [],
    qualifications: [
      { user_id: "old_pro", tier: "pro", token_key: "hermesos" },
      { user_id: "new_pro", tier: "pro", token_key: "hermesos" },
    ],
  });
  await POST(request());
  expect(applyTierChange).toHaveBeenCalledWith(expect.objectContaining({ userId: "old_pro", newTier: "operator" }));
  expect(applyTierChange).not.toHaveBeenCalledWith(expect.objectContaining({ userId: "new_pro", newTier: "operator" }));
});
