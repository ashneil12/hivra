import { NextRequest } from "next/server";

import { POST } from "../route";
import { supabaseAdmin } from "@/lib/supabase";
import { applyTierChange } from "@/lib/services/tier-change-service";
import {
  refreshVerifiedHermesTokenHoldings,
  qualifiesForHermesBaseTier,
} from "@/lib/billing/token-holdings";

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/services/tier-change-service", () => ({
  applyTierChange: jest.fn(),
}));

jest.mock("@/lib/billing/token-holdings", () => ({
  refreshVerifiedHermesTokenHoldings: jest.fn(),
  qualifiesForHermesBaseTier: jest.fn(),
  HERMESOS_TOKEN_ADDRESS: "0x95ccfd2b81a9667b0cc979992632f98fc853eba3",
  HERMESOS_TOKEN_DECIMALS: 18,
  HERMESOS_TOKEN_SYMBOL: "HERMESOS",
}));

// Base-tier caps (tier-specs is real). fleet = 4 vCPU / 8192 MB; token_base /
// credit_base = 0.5 / 1024; operator = 2 / 4096. Boost adds +1 vCPU / +2048 MB.
const FLEET_CPU = 4;
const FLEET_RAM = 8192;
const BASE_CPU = 0.5;
const BASE_RAM = 1024;

interface InstanceFixture {
  user_id: string;
  resource_tier: string | null;
  cpu_limit: number | null;
  ram_limit: number | null;
}

interface SnapshotFixture {
  user_id: string;
  balance_raw: string;
  qualifies_base_tier: boolean;
  checked_at: string;
}

interface SubscriptionFixture {
  user_id: string;
  status: string;
  plan: string;
}

interface QualificationFixture {
  user_id: string;
  tier: "pro" | "power";
  currently_eligible: boolean;
}

function mockSupabase(opts: {
  instances: InstanceFixture[];
  snapshots: SnapshotFixture[];
  subscriptions: SubscriptionFixture[];
  qualifications: QualificationFixture[];
  boosts?: string[];
}) {
  const instancesBuilder = {
    select: jest.fn().mockReturnThis(),
    not: jest.fn().mockResolvedValue({ data: opts.instances, error: null }),
  };
  const snapshotsBuilder = {
    select: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    gte: jest.fn().mockReturnThis(),
    order: jest.fn().mockResolvedValue({ data: opts.snapshots, error: null }),
  };
  const subscriptionsBuilder = {
    select: jest.fn().mockReturnThis(),
    in: jest.fn().mockResolvedValue({ data: opts.subscriptions, error: null }),
  };
  const qualificationsBuilder = {
    select: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(),
    eq: jest.fn().mockResolvedValue({ data: opts.qualifications, error: null }),
  };
  const boostsBuilder = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    in: jest.fn().mockResolvedValue({
      data: (opts.boosts ?? []).map((user_id) => ({ user_id })),
      error: null,
    }),
  };

  (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
    if (table === "hermes_instances") return instancesBuilder;
    if (table === "token_holding_snapshots") return snapshotsBuilder;
    if (table === "hermes_subscriptions") return subscriptionsBuilder;
    if (table === "token_tier_qualifications") return qualificationsBuilder;
    if (table === "venice_compute_boost_qualifications") return boostsBuilder;
    throw new Error(`Unexpected table ${table}`);
  });

  return {
    instancesBuilder,
    snapshotsBuilder,
    subscriptionsBuilder,
    qualificationsBuilder,
    boostsBuilder,
  };
}

const ORIGINAL_ENV = process.env;

function makeRequest(authorization = "Bearer cron-secret") {
  return new Request("http://localhost/api/cron/refresh-token-tiers", {
    method: "POST",
    headers: { authorization },
  }) as unknown as NextRequest;
}

describe("POST /api/cron/refresh-token-tiers", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV, CRON_SECRET: "cron-secret" };
    (refreshVerifiedHermesTokenHoldings as jest.Mock).mockResolvedValue({
      refreshed: 0,
      failed: 0,
    });
    (qualifiesForHermesBaseTier as jest.Mock).mockReturnValue(true);
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it("upgrades a Power-qualified token holder from token_base to fleet", async () => {
    mockSupabase({
      instances: [
        { user_id: "user_power", resource_tier: "token_base", cpu_limit: BASE_CPU, ram_limit: BASE_RAM },
      ],
      snapshots: [
        {
          user_id: "user_power",
          balance_raw: "68715470000000000000000000",
          qualifies_base_tier: true,
          checked_at: new Date().toISOString(),
        },
      ],
      subscriptions: [],
      qualifications: [
        { user_id: "user_power", tier: "power", currently_eligible: true },
      ],
    });
    (applyTierChange as jest.Mock).mockResolvedValue({});

    const res = await POST(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(applyTierChange).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_power",
        newTier: "fleet",
        source: "token_snapshot",
        veniceBoost: false,
      })
    );
    expect(body.data.tier_changes).toBe(1);
    expect(body.data.tier_change_details[0]).toEqual({
      userId: "user_power",
      from: "token_base",
      to: "fleet",
    });
  });

  it("upgrades a Pro-qualified token holder from token_base to operator", async () => {
    mockSupabase({
      instances: [
        { user_id: "user_pro", resource_tier: "token_base", cpu_limit: BASE_CPU, ram_limit: BASE_RAM },
      ],
      snapshots: [
        {
          user_id: "user_pro",
          balance_raw: "34185083000000000000000000",
          qualifies_base_tier: true,
          checked_at: new Date().toISOString(),
        },
      ],
      subscriptions: [],
      qualifications: [
        { user_id: "user_pro", tier: "pro", currently_eligible: true },
      ],
    });
    (applyTierChange as jest.Mock).mockResolvedValue({});

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(applyTierChange).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user_pro", newTier: "operator" })
    );
  });

  it("prefers Power over Pro when a user qualifies for both", async () => {
    mockSupabase({
      instances: [
        { user_id: "user_both", resource_tier: "token_base", cpu_limit: BASE_CPU, ram_limit: BASE_RAM },
      ],
      snapshots: [
        {
          user_id: "user_both",
          balance_raw: "68715470000000000000000000",
          qualifies_base_tier: true,
          checked_at: new Date().toISOString(),
        },
      ],
      subscriptions: [],
      qualifications: [
        { user_id: "user_both", tier: "pro", currently_eligible: true },
        { user_id: "user_both", tier: "power", currently_eligible: true },
      ],
    });
    (applyTierChange as jest.Mock).mockResolvedValue({});

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(applyTierChange).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user_both", newTier: "fleet" })
    );
  });

  it("does not downgrade a Power-qualified user already on fleet with correct caps", async () => {
    mockSupabase({
      instances: [
        { user_id: "user_steady", resource_tier: "fleet", cpu_limit: FLEET_CPU, ram_limit: FLEET_RAM },
      ],
      snapshots: [
        {
          user_id: "user_steady",
          balance_raw: "68715470000000000000000000",
          qualifies_base_tier: true,
          checked_at: new Date().toISOString(),
        },
      ],
      subscriptions: [],
      qualifications: [
        { user_id: "user_steady", tier: "power", currently_eligible: true },
      ],
    });

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(applyTierChange).not.toHaveBeenCalled();
  });

  it("falls back to token_base for users without Pro/Power qualifications but holding base threshold", async () => {
    const { snapshotsBuilder } = mockSupabase({
      instances: [
        { user_id: "user_base", resource_tier: "credit_base", cpu_limit: BASE_CPU, ram_limit: BASE_RAM },
      ],
      snapshots: [
        {
          user_id: "user_base",
          balance_raw: "1000000000000000000",
          qualifies_base_tier: true,
          checked_at: new Date().toISOString(),
        },
      ],
      subscriptions: [],
      qualifications: [],
    });
    (applyTierChange as jest.Mock).mockResolvedValue({});

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(applyTierChange).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user_base", newTier: "token_base" })
    );
    expect(snapshotsBuilder.eq).toHaveBeenCalledWith(
      "token_address",
      "0x95ccfd2b81a9667b0cc979992632f98fc853eba3"
    );
  });

  it("does not re-apply for a steady paid Stripe user when tier and caps are unchanged", async () => {
    mockSupabase({
      instances: [
        { user_id: "user_stripe", resource_tier: "fleet", cpu_limit: FLEET_CPU, ram_limit: FLEET_RAM },
      ],
      snapshots: [],
      subscriptions: [
        { user_id: "user_stripe", status: "active", plan: "fleet" },
      ],
      qualifications: [
        { user_id: "user_stripe", tier: "power", currently_eligible: true },
      ],
    });

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    // Stripe owns the base tier; with no boost change there's nothing to do.
    expect(applyTierChange).not.toHaveBeenCalled();
  });

  it("applies the VVV boost to a paid Stripe user holding ≥ $199 of VVV", async () => {
    // Stripe webhooks don't fire when the VVV price drifts, so the cron is
    // the path that gets the boost onto a card-paid user's instances. Base
    // tier (fleet) is unchanged, but the effective caps grow by +1 / +2048,
    // so the cron must re-apply rather than skip.
    mockSupabase({
      instances: [
        { user_id: "user_stripe_vvv", resource_tier: "fleet", cpu_limit: FLEET_CPU, ram_limit: FLEET_RAM },
      ],
      snapshots: [],
      subscriptions: [
        { user_id: "user_stripe_vvv", status: "active", plan: "fleet" },
      ],
      qualifications: [],
      boosts: ["user_stripe_vvv"],
    });
    (applyTierChange as jest.Mock).mockResolvedValue({});

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(applyTierChange).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_stripe_vvv",
        newTier: "fleet",
        veniceBoost: true,
      })
    );
  });

  it("re-applies on a boost-only change for a token-tier user (base tier unchanged)", async () => {
    // Regression for the old `desiredTier === currentTier` skip: a user who
    // newly earns the boost while staying on fleet would have been skipped,
    // so the +1/+2 would never reach the VM. The effective-spec compare must
    // catch it.
    mockSupabase({
      instances: [
        { user_id: "user_boost_only", resource_tier: "fleet", cpu_limit: FLEET_CPU, ram_limit: FLEET_RAM },
      ],
      snapshots: [
        {
          user_id: "user_boost_only",
          balance_raw: "68715470000000000000000000",
          qualifies_base_tier: true,
          checked_at: new Date().toISOString(),
        },
      ],
      subscriptions: [],
      qualifications: [
        { user_id: "user_boost_only", tier: "power", currently_eligible: true },
      ],
      boosts: ["user_boost_only"],
    });
    (applyTierChange as jest.Mock).mockResolvedValue({});

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(applyTierChange).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_boost_only",
        newTier: "fleet",
        veniceBoost: true,
      })
    );
  });

  it("does not re-apply when the boost is already reflected in the stored caps", async () => {
    mockSupabase({
      instances: [
        {
          user_id: "user_boosted_steady",
          resource_tier: "fleet",
          cpu_limit: FLEET_CPU + 1,
          ram_limit: FLEET_RAM + 2048,
        },
      ],
      snapshots: [
        {
          user_id: "user_boosted_steady",
          balance_raw: "68715470000000000000000000",
          qualifies_base_tier: true,
          checked_at: new Date().toISOString(),
        },
      ],
      subscriptions: [],
      qualifications: [
        { user_id: "user_boosted_steady", tier: "power", currently_eligible: true },
      ],
      boosts: ["user_boosted_steady"],
    });

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(applyTierChange).not.toHaveBeenCalled();
  });

  it("processes Free-row users with Pro token qualification (cron upgrades resource_tier)", async () => {
    // Sign-up auto-creates an active 'free' hermes_subscriptions row.
    // That row is a placeholder, NOT a paid sub, so the cron must still
    // upgrade the user's resource_tier when they qualify via $HermesOS.
    mockSupabase({
      instances: [
        { user_id: "user_free_pro", resource_tier: "credit_base", cpu_limit: BASE_CPU, ram_limit: BASE_RAM },
      ],
      snapshots: [
        {
          user_id: "user_free_pro",
          balance_raw: "34185083000000000000000000",
          qualifies_base_tier: true,
          checked_at: new Date().toISOString(),
        },
      ],
      subscriptions: [
        { user_id: "user_free_pro", status: "active", plan: "free" },
      ],
      qualifications: [
        { user_id: "user_free_pro", tier: "pro", currently_eligible: true },
      ],
    });
    (applyTierChange as jest.Mock).mockResolvedValue({});

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(applyTierChange).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_free_pro",
        newTier: "operator",
        source: "token_snapshot",
      })
    );
  });

  it("ignores qualification rows where currently_eligible is false (filtered by query)", async () => {
    // The query filters for currently_eligible=true at the DB level, so the
    // mock returns only eligible rows. Ineligible users fall through to the
    // base/credit decision — token_base here, which matches the stored caps,
    // so nothing is re-applied.
    mockSupabase({
      instances: [
        { user_id: "user_ineligible", resource_tier: "token_base", cpu_limit: BASE_CPU, ram_limit: BASE_RAM },
      ],
      snapshots: [
        {
          user_id: "user_ineligible",
          balance_raw: "1000000000000000000",
          qualifies_base_tier: true,
          checked_at: new Date().toISOString(),
        },
      ],
      subscriptions: [],
      qualifications: [],
    });

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(applyTierChange).not.toHaveBeenCalled();
  });
});
