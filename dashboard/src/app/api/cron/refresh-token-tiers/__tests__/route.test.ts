import { NextRequest } from "next/server";

import { POST, maxDuration } from "../route";
import { supabaseAdmin } from "@/lib/supabase";
import { applyTierChange } from "@/lib/services/tier-change-service";
import { refreshVerifiedHermesTokenHoldings } from "@/lib/billing/token-holdings";

// Written for the $HermesOS-only registry: pin an empty $HIVRA launch block so the suite does not
// change behaviour when the committed block's activatesAt passes. The launched paths have their own suites.
jest.mock("@/lib/billing/hivra-token-launch", () => ({
  HIVRA_TOKEN_LAUNCH: { contractAddress: "", decimals: 18, poolId: "", activatesAt: "" },
}));

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/services/tier-change-service", () => ({
  applyTierChange: jest.fn(),
}));

const HERMESOS_CONTRACT = "0x95ccfd2b81a9667b0cc979992632f98fc853eba3";

jest.mock("@/lib/billing/token-holdings", () => ({
  refreshVerifiedHermesTokenHoldings: jest.fn(),
}));

// Base-tier caps (tier-specs is real). fleet = 4 vCPU / 8192 MB;
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
  /** Defaults to the $HermesOS contract. */
  token_address?: string;
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

interface YearlyFixture {
  user_id: string;
  tier: "pro" | "power";
  status: "active" | "grace" | "expired" | "cancelled" | "renewed";
  paid_at: string;
  expires_at: string;
}

interface AppleFixture {
  user_id: string;
  plan: string;
  status: "active" | "trialing" | "grace_period" | "past_due" | "expired" | "revoked";
}

type QueryResult<Row> = { data: Row[] | null; error: { message: string } | null };

interface FilteringBuilder<Row> extends PromiseLike<QueryResult<Row>> {
  select: jest.Mock<FilteringBuilder<Row>, unknown[]>;
  in: jest.Mock<FilteringBuilder<Row>, [string, readonly unknown[]]>;
  eq: jest.Mock<FilteringBuilder<Row>, [string, unknown]>;
}

// Applies the `.in` / `.eq` filters the route sends, so a fixture row outside
// the requested users or statuses is dropped the way Postgres would drop it.
function filteringBuilder<Row extends object>(
  rows: Row[],
  error: { message: string } | null = null
): FilteringBuilder<Row> {
  const filters: Array<(row: Row) => boolean> = [];
  const field = (row: Row, column: string) => (row as Record<string, unknown>)[column];
  const builder: FilteringBuilder<Row> = {
    select: jest.fn(() => builder),
    in: jest.fn((column: string, values: readonly unknown[]) => {
      filters.push((row) => values.includes(field(row, column)));
      return builder;
    }),
    eq: jest.fn((column: string, value: unknown) => {
      filters.push((row) => field(row, column) === value);
      return builder;
    }),
    then: (onFulfilled, onRejected) =>
      Promise.resolve<QueryResult<Row>>(
        error
          ? { data: null, error }
          : { data: rows.filter((row) => filters.every((keep) => keep(row))), error: null }
      ).then(onFulfilled, onRejected),
  };
  return builder;
}

function mockSupabase(opts: {
  instances: InstanceFixture[];
  snapshots: SnapshotFixture[];
  subscriptions: SubscriptionFixture[];
  qualifications: QualificationFixture[];
  yearly?: YearlyFixture[];
  yearlyError?: string;
  apple?: AppleFixture[];
  appleError?: string;
  boosts?: string[];
}) {
  // hermes_instances is read keyset-paged (order by id, gt cursor, limit), the way
  // PostgREST would cap it at 1000 rows per response. Rows get stable ids here.
  const instanceRows = opts.instances.map((row, index) => ({
    id: `inst-${String(index).padStart(6, "0")}`,
    ...row,
  }));
  const instancesBuilder = (() => {
    let cursor: string | null = null;
    let limit = Infinity;
    const builder: Record<string, unknown> = {
      select: jest.fn(() => {
        cursor = null;
        limit = Infinity;
        return builder;
      }),
      not: jest.fn(() => builder),
      gt: jest.fn((_column: string, value: string) => {
        cursor = value;
        return builder;
      }),
      order: jest.fn(() => builder),
      limit: jest.fn((count: number) => {
        limit = count;
        return builder;
      }),
      then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve({
          data: instanceRows
            .filter((row) => cursor === null || row.id > cursor)
            .slice(0, Math.min(limit, 1000)),
          error: null,
        }).then(onFulfilled, onRejected),
    };
    return builder;
  })();
  const snapshotsBuilder = {
    select: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    gte: jest.fn().mockReturnThis(),
    order: jest.fn().mockResolvedValue({
      data: opts.snapshots.map((snapshot) => ({ token_address: HERMESOS_CONTRACT, ...snapshot })),
      error: null,
    }),
  };
  const subscriptionsBuilder = {
    select: jest.fn().mockReturnThis(),
    in: jest.fn().mockResolvedValue({ data: opts.subscriptions, error: null }),
  };
  // The route filters eligible-or-in-grace rows in the database (.or), so the
  // fixture lists only the rows that filter would return.
  const qualificationsBuilder = {
    select: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(),
    or: jest.fn().mockResolvedValue({ data: opts.qualifications, error: null }),
  };
  const boostsBuilder = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    in: jest.fn().mockResolvedValue({
      data: (opts.boosts ?? []).map((user_id) => ({ user_id })),
      error: null,
    }),
  };
  const yearlyBuilder = filteringBuilder(
    opts.yearly ?? [],
    opts.yearlyError ? { message: opts.yearlyError } : null
  );
  const appleBuilder = filteringBuilder(
    opts.apple ?? [],
    opts.appleError ? { message: opts.appleError } : null
  );

  (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
    if (table === "hermes_instances") return instancesBuilder;
    if (table === "token_holding_snapshots") return snapshotsBuilder;
    if (table === "hermes_subscriptions") return subscriptionsBuilder;
    if (table === "token_tier_qualifications") return qualificationsBuilder;
    if (table === "yearly_token_subscriptions") return yearlyBuilder;
    if (table === "apple_iap_subscriptions") return appleBuilder;
    if (table === "venice_compute_boost_qualifications") return boostsBuilder;
    throw new Error(`Unexpected table ${table}`);
  });

  return {
    instancesBuilder,
    snapshotsBuilder,
    subscriptionsBuilder,
    qualificationsBuilder,
    yearlyBuilder,
    appleBuilder,
    boostsBuilder,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

function yearlyRow(
  user_id: string,
  tier: "pro" | "power",
  overrides: Partial<YearlyFixture> = {}
): YearlyFixture {
  const paidAt = Date.now() - 30 * DAY_MS;
  return {
    user_id,
    tier,
    status: "active",
    paid_at: new Date(paidAt).toISOString(),
    expires_at: new Date(paidAt + 365 * DAY_MS).toISOString(),
    ...overrides,
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
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it("refreshes holdings on its own lane within a budget that leaves room for the tier scan", async () => {
    mockSupabase({ instances: [], snapshots: [], subscriptions: [], qualifications: [] });

    const res = await POST(makeRequest());

    expect(res.status).toBe(200);
    expect(refreshVerifiedHermesTokenHoldings).toHaveBeenCalledWith(
      expect.objectContaining({ lane: "token_tiers", timeBudgetMs: 150_000 })
    );
    // A snapshot-only lane: every definitive read counts as judged.
    expect(refreshVerifiedHermesTokenHoldings).toHaveBeenCalledWith(
      expect.not.objectContaining({ judgePage: expect.anything() })
    );
    expect(maxDuration).toBe(300);
  });

  it("upgrades a Power-qualified token holder from credit_base to fleet", async () => {
    mockSupabase({
      instances: [
        { user_id: "user_power", resource_tier: "credit_base", cpu_limit: BASE_CPU, ram_limit: BASE_RAM },
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
      from: "credit_base",
      to: "fleet",
    });
  });

  it("re-tiers a holder past the 1000-row PostgREST cap instead of silently dropping them", async () => {
    // Before the fix the instance scan stopped at the first 1000 rows, so user_1004
    // was never scanned and kept a stale tier, however strong their qualification.
    const instances = Array.from({ length: 1005 }, (_, i) => ({
      user_id: `user_${i}`,
      resource_tier: "credit_base",
      cpu_limit: BASE_CPU,
      ram_limit: BASE_RAM,
    }));
    mockSupabase({
      instances,
      snapshots: [],
      subscriptions: [],
      qualifications: [{ user_id: "user_1004", tier: "power", currently_eligible: true }],
    });
    (applyTierChange as jest.Mock).mockResolvedValue({});

    const res = await POST(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.users_scanned).toBe(1005);
    expect(applyTierChange).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user_1004", newTier: "fleet" })
    );
  });

  it("fails the run before any tier change when a user-id scan reaches the row cap", async () => {
    // A truncated qualification read would read paid holders as "no entitlement"
    // and downgrade them, so the run must stop instead.
    mockSupabase({
      instances: [{ user_id: "user_0", resource_tier: "fleet", cpu_limit: FLEET_CPU, ram_limit: FLEET_RAM }],
      snapshots: [],
      subscriptions: [],
      qualifications: Array.from({ length: 1000 }, () => ({
        user_id: "user_0",
        tier: "pro" as const,
        currently_eligible: true,
      })),
    });
    (applyTierChange as jest.Mock).mockResolvedValue({});

    const res = await POST(makeRequest());

    expect(res.status).toBe(500);
    expect(applyTierChange).not.toHaveBeenCalled();
  });

  it("upgrades a Pro-qualified token holder from credit_base to operator", async () => {
    mockSupabase({
      instances: [
        { user_id: "user_pro", resource_tier: "credit_base", cpu_limit: BASE_CPU, ram_limit: BASE_RAM },
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
        { user_id: "user_both", resource_tier: "credit_base", cpu_limit: BASE_CPU, ram_limit: BASE_RAM },
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

  it("gives a 1-token holder no compute tier: the Starter tier is gone", async () => {
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

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(applyTierChange).not.toHaveBeenCalled();
    // Holdings no longer decide a tier, so the scan reads no snapshots.
    expect(snapshotsBuilder.select).not.toHaveBeenCalled();
  });

  it("moves a computer left on token_base to credit_base however much the owner holds", async () => {
    mockSupabase({
      instances: [
        { user_id: "user_starter", resource_tier: "token_base", cpu_limit: BASE_CPU, ram_limit: BASE_RAM },
      ],
      snapshots: [
        {
          user_id: "user_starter",
          balance_raw: "500000000000000000000",
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
      expect.objectContaining({ userId: "user_starter", newTier: "credit_base", veniceBoost: false })
    );
  });

  // The evaluator sets currently_eligible = false at a breach, but the breach
  // email promises the tier until REQUALIFICATION_GRACE_HOURS have passed, and
  // the lapse check keeps the computer running that long. The scan keeps the
  // tier for exactly that window, in the database filter.
  describe("Pro/Power breach grace", () => {
    it("reads eligible rows and rows inside their breach grace", async () => {
      const { qualificationsBuilder } = mockSupabase({
        instances: [
          { user_id: "user_dipped", resource_tier: "fleet", cpu_limit: FLEET_CPU, ram_limit: FLEET_RAM },
        ],
        snapshots: [],
        subscriptions: [],
        qualifications: [{ user_id: "user_dipped", tier: "power", currently_eligible: false }],
      });

      const before = Date.now();
      const res = await POST(makeRequest());
      expect(res.status).toBe(200);
      expect(applyTierChange).not.toHaveBeenCalled();

      const filter = (qualificationsBuilder.or as jest.Mock).mock.calls[0][0] as string;
      const match = /^currently_eligible\.eq\.true,and\(last_suspend_at\.is\.null,last_breach_at\.gt\.(.+)\)$/.exec(filter);
      expect(match).not.toBeNull();
      const graceMs = before - Date.parse(match![1]);
      expect(graceMs).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000 - 1000);
      expect(graceMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 1000);
    });

    it("drops a holder whose qualification is gone to credit_base, however fresh their holding", async () => {
      mockSupabase({
        instances: [
          { user_id: "user_sold", resource_tier: "fleet", cpu_limit: FLEET_CPU, ram_limit: FLEET_RAM },
        ],
        snapshots: [
          {
            user_id: "user_sold",
            balance_raw: "5000000000000000000",
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
        expect.objectContaining({ userId: "user_sold", newTier: "credit_base" })
      );
    });
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

  it("ignores qualification rows the database filter drops (not eligible, grace over)", async () => {
    // The query keeps only eligible or in-grace rows, so the mock returns
    // none. The user falls through to credit_base, which matches the stored
    // caps, so nothing is re-applied.
    mockSupabase({
      instances: [
        { user_id: "user_ineligible", resource_tier: "credit_base", cpu_limit: BASE_CPU, ram_limit: BASE_RAM },
      ],
      snapshots: [],
      subscriptions: [],
      qualifications: [],
    });

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(applyTierChange).not.toHaveBeenCalled();
  });

  describe("yearly $HermesOS subscriptions", () => {
    it("keeps a yearly Power subscriber on fleet when the wallet no longer holds the tokens", async () => {
      // The yearly payment sweeps the $HermesOS out of the wallet, so there is
      // no qualification and no snapshot. resolveEffectiveSubscription still
      // entitles the user to fleet, which is what createInstance provisioned.
      mockSupabase({
        instances: [
          { user_id: "user_yearly_power", resource_tier: "fleet", cpu_limit: FLEET_CPU, ram_limit: FLEET_RAM },
        ],
        snapshots: [],
        subscriptions: [{ user_id: "user_yearly_power", status: "active", plan: "free" }],
        qualifications: [],
        yearly: [yearlyRow("user_yearly_power", "power")],
      });
      (applyTierChange as jest.Mock).mockResolvedValue({});

      const res = await POST(makeRequest());
      expect(res.status).toBe(200);
      // Before the fix the cron never read yearly_token_subscriptions, fell
      // through to credit_base and live-resized the paid VM down every tick.
      expect(applyTierChange).not.toHaveBeenCalled();
    });

    it("upgrades a yearly Pro subscriber's credit_base instances to operator", async () => {
      const { yearlyBuilder } = mockSupabase({
        instances: [
          { user_id: "user_yearly_pro", resource_tier: "credit_base", cpu_limit: BASE_CPU, ram_limit: BASE_RAM },
        ],
        snapshots: [],
        subscriptions: [],
        qualifications: [],
        yearly: [yearlyRow("user_yearly_pro", "pro")],
      });
      (applyTierChange as jest.Mock).mockResolvedValue({});

      const res = await POST(makeRequest());
      expect(res.status).toBe(200);
      expect(applyTierChange).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "user_yearly_pro",
          newTier: "operator",
          source: "token_snapshot",
          reason: "cron: yearly $HermesOS pro subscription",
        })
      );
      expect(yearlyBuilder.in).toHaveBeenCalledWith("user_id", ["user_yearly_pro"]);
    });

    it("counts a row in its post-expiry grace window as live", async () => {
      mockSupabase({
        instances: [
          { user_id: "user_yearly_grace", resource_tier: "fleet", cpu_limit: FLEET_CPU, ram_limit: FLEET_RAM },
        ],
        snapshots: [],
        subscriptions: [],
        qualifications: [],
        yearly: [
          yearlyRow("user_yearly_grace", "power", {
            status: "grace",
            paid_at: new Date(Date.now() - 366 * DAY_MS).toISOString(),
            expires_at: new Date(Date.now() - DAY_MS).toISOString(),
          }),
        ],
      });

      const res = await POST(makeRequest());
      expect(res.status).toBe(200);
      expect(applyTierChange).not.toHaveBeenCalled();
    });

    it("drops a user whose only yearly row has expired to credit_base", async () => {
      mockSupabase({
        instances: [
          { user_id: "user_yearly_expired", resource_tier: "fleet", cpu_limit: FLEET_CPU, ram_limit: FLEET_RAM },
        ],
        snapshots: [],
        subscriptions: [],
        qualifications: [],
        yearly: [
          yearlyRow("user_yearly_expired", "power", { status: "expired" }),
          yearlyRow("user_yearly_expired", "pro", { status: "renewed" }),
        ],
      });
      (applyTierChange as jest.Mock).mockResolvedValue({});

      const res = await POST(makeRequest());
      expect(res.status).toBe(200);
      expect(applyTierChange).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "user_yearly_expired", newTier: "credit_base" })
      );
    });

    it("keeps fleet when a newer Pro year is paid while a Power year is still live", async () => {
      // One live row per tier: renewing or buying Pro inserts the NEWEST row.
      // Tier rank must win over payment order, as in resolveEffectiveSubscription.
      mockSupabase({
        instances: [
          { user_id: "user_yearly_both", resource_tier: "fleet", cpu_limit: FLEET_CPU, ram_limit: FLEET_RAM },
        ],
        snapshots: [],
        subscriptions: [],
        qualifications: [],
        yearly: [
          yearlyRow("user_yearly_both", "power", {
            paid_at: new Date(Date.now() - 200 * DAY_MS).toISOString(),
            expires_at: new Date(Date.now() + 165 * DAY_MS).toISOString(),
          }),
          yearlyRow("user_yearly_both", "pro", {
            paid_at: new Date(Date.now() - DAY_MS).toISOString(),
            expires_at: new Date(Date.now() + 364 * DAY_MS).toISOString(),
          }),
        ],
      });

      const res = await POST(makeRequest());
      expect(res.status).toBe(200);
      expect(applyTierChange).not.toHaveBeenCalled();
    });

    it("lets a paid Stripe plan outrank a yearly subscription", async () => {
      mockSupabase({
        instances: [
          { user_id: "user_stripe_yearly", resource_tier: "operator", cpu_limit: 2, ram_limit: 4096 },
        ],
        snapshots: [],
        subscriptions: [{ user_id: "user_stripe_yearly", status: "active", plan: "operator" }],
        qualifications: [],
        yearly: [yearlyRow("user_stripe_yearly", "power")],
      });

      const res = await POST(makeRequest());
      expect(res.status).toBe(200);
      expect(applyTierChange).not.toHaveBeenCalled();
    });

    it("lets a yearly subscription outrank a token-holding qualification", async () => {
      // Same order as resolveEffectiveSubscription, so the cron and
      // createInstance never disagree about which tier the user is on.
      mockSupabase({
        instances: [
          { user_id: "user_yearly_qual", resource_tier: "fleet", cpu_limit: FLEET_CPU, ram_limit: FLEET_RAM },
        ],
        snapshots: [],
        subscriptions: [],
        qualifications: [{ user_id: "user_yearly_qual", tier: "power", currently_eligible: true }],
        yearly: [yearlyRow("user_yearly_qual", "pro")],
      });
      (applyTierChange as jest.Mock).mockResolvedValue({});

      const res = await POST(makeRequest());
      expect(res.status).toBe(200);
      expect(applyTierChange).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "user_yearly_qual", newTier: "operator" })
      );
    });

    it("applies the VVV boost on top of a yearly tier", async () => {
      mockSupabase({
        instances: [
          { user_id: "user_yearly_vvv", resource_tier: "fleet", cpu_limit: FLEET_CPU, ram_limit: FLEET_RAM },
        ],
        snapshots: [],
        subscriptions: [],
        qualifications: [],
        yearly: [yearlyRow("user_yearly_vvv", "power")],
        boosts: ["user_yearly_vvv"],
      });
      (applyTierChange as jest.Mock).mockResolvedValue({});

      const res = await POST(makeRequest());
      expect(res.status).toBe(200);
      expect(applyTierChange).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "user_yearly_vvv", newTier: "fleet", veniceBoost: true })
      );
    });

    it("fails the run instead of downgrading anyone when the yearly scan errors", async () => {
      mockSupabase({
        instances: [
          { user_id: "user_yearly_power", resource_tier: "fleet", cpu_limit: FLEET_CPU, ram_limit: FLEET_RAM },
        ],
        snapshots: [],
        subscriptions: [],
        qualifications: [],
        yearlyError: "connection reset",
      });

      const res = await POST(makeRequest());
      expect(res.status).toBe(500);
      expect(applyTierChange).not.toHaveBeenCalled();
    });
  });

  describe("Apple IAP subscriptions", () => {
    it("keeps an Apple Pro subscriber on operator when they hold no tokens", async () => {
      // apple_iap_subscriptions is its own lane: nothing lands in
      // hermes_subscriptions, so before the fix this user fell through to
      // credit_base every tick and was live-resized off the plan Apple bills.
      mockSupabase({
        instances: [
          { user_id: "user_apple_pro", resource_tier: "operator", cpu_limit: 2, ram_limit: 4096 },
        ],
        snapshots: [],
        subscriptions: [{ user_id: "user_apple_pro", status: "active", plan: "free" }],
        qualifications: [],
        apple: [{ user_id: "user_apple_pro", plan: "operator", status: "active" }],
      });

      const res = await POST(makeRequest());
      expect(res.status).toBe(200);
      expect(applyTierChange).not.toHaveBeenCalled();
    });

    it("upgrades an Apple Power subscriber in billing grace to fleet", async () => {
      const { appleBuilder } = mockSupabase({
        instances: [
          { user_id: "user_apple_power", resource_tier: "credit_base", cpu_limit: BASE_CPU, ram_limit: BASE_RAM },
        ],
        snapshots: [],
        subscriptions: [],
        qualifications: [],
        apple: [{ user_id: "user_apple_power", plan: "fleet", status: "grace_period" }],
      });
      (applyTierChange as jest.Mock).mockResolvedValue({});

      const res = await POST(makeRequest());
      expect(res.status).toBe(200);
      expect(applyTierChange).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "user_apple_power",
          newTier: "fleet",
          reason: "cron: apple iap plan fleet",
        })
      );
      expect(appleBuilder.in).toHaveBeenCalledWith("user_id", ["user_apple_power"]);
    });

    it("drops an Apple subscriber whose billing retry has no grace to credit_base", async () => {
      mockSupabase({
        instances: [
          { user_id: "user_apple_lapsed", resource_tier: "operator", cpu_limit: 2, ram_limit: 4096 },
        ],
        snapshots: [],
        subscriptions: [],
        qualifications: [],
        apple: [{ user_id: "user_apple_lapsed", plan: "operator", status: "past_due" }],
      });
      (applyTierChange as jest.Mock).mockResolvedValue({});

      const res = await POST(makeRequest());
      expect(res.status).toBe(200);
      expect(applyTierChange).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "user_apple_lapsed", newTier: "credit_base" })
      );
    });

    it("ranks Apple above a yearly subscription and below paid Stripe", async () => {
      mockSupabase({
        instances: [
          { user_id: "user_apple_yearly", resource_tier: "fleet", cpu_limit: FLEET_CPU, ram_limit: FLEET_RAM },
          { user_id: "user_stripe_apple", resource_tier: "operator", cpu_limit: 2, ram_limit: 4096 },
        ],
        snapshots: [],
        subscriptions: [{ user_id: "user_stripe_apple", status: "active", plan: "operator" }],
        qualifications: [],
        yearly: [yearlyRow("user_apple_yearly", "power")],
        apple: [
          { user_id: "user_apple_yearly", plan: "operator", status: "active" },
          { user_id: "user_stripe_apple", plan: "fleet", status: "active" },
        ],
      });
      (applyTierChange as jest.Mock).mockResolvedValue({});

      const res = await POST(makeRequest());
      expect(res.status).toBe(200);
      // Same order as resolveEffectiveSubscription: paid Stripe → Apple → yearly.
      expect(applyTierChange).toHaveBeenCalledTimes(1);
      expect(applyTierChange).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "user_apple_yearly", newTier: "operator" })
      );
    });

    it("fails the run instead of downgrading anyone when the Apple scan errors", async () => {
      mockSupabase({
        instances: [
          { user_id: "user_apple_pro", resource_tier: "operator", cpu_limit: 2, ram_limit: 4096 },
        ],
        snapshots: [],
        subscriptions: [],
        qualifications: [],
        appleError: "connection reset",
      });

      const res = await POST(makeRequest());
      expect(res.status).toBe(500);
      expect(applyTierChange).not.toHaveBeenCalled();
    });
  });
});
