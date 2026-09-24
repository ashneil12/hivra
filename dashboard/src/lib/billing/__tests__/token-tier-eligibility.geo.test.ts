/**
 * Token geo-policy in the tier evaluator: a blocked user gets no NEW tier
 * qualification row, while every row that already exists is evaluated exactly
 * as before (kept, breached, recovered). The dormant policy changes nothing.
 */
const mockFrom = jest.fn();
jest.mock("@/lib/supabase", () => ({
  get supabaseAdmin() {
    return { from: (table: string) => mockFrom(table) };
  },
}));
jest.mock("@/lib/logger", () => ({ log: { warn: jest.fn(), info: jest.fn(), error: jest.fn() } }));

const PRO = 200_000n;
const POWER = 500_000n;
jest.mock("../live-thresholds", () => ({
  getLiveActiveThresholds: async ({ now }: { now?: Date } = {}) => ({
    epoch: "launch",
    promoEndsAt: new Date("2026-12-31T00:00:00Z"),
    pro: { tier: "pro", epoch: "launch", code: "PRO_LAUNCH", amount: PRO },
    power: { tier: "power", epoch: "launch", code: "POWER_LAUNCH", amount: POWER },
    source: "live",
    priceUsd: "0.00002",
    priceFetchedAt: now ?? new Date(),
    warnings: [],
  }),
}));
jest.mock("../deposit-quotes", () => ({
  getActiveDepositQuotes: async () => [],
  consumeDepositQuote: async () => undefined,
}));

import { TOKEN_GEO_POLICY } from "@/lib/compliance/token-geo-policy";
import { resolveTokenGeoBlock } from "@/lib/compliance/token-geo-gate";
import { evaluateAndRecordTokenTierEligibility } from "../token-tier-eligibility";

type Row = Record<string, unknown> & { id: string; user_id: string; tier: string };
const NOW = new Date("2026-09-24T12:00:00.000Z");

class FakeDb {
  rows: Row[] = [];
  inserts = 0;
  from() {
    return {
      select: () => ({
        eq: (_c1: string, userId: string) => ({
          eq: (_c2: string, tier: string) => ({
            maybeSingle: async () => ({
              data: this.rows.find((r) => r.user_id === userId && r.tier === tier) ?? null,
              error: null,
            }),
          }),
        }),
      }),
      insert: async (payload: Record<string, unknown>) => {
        this.inserts += 1;
        this.rows.push({ id: `row-${this.rows.length + 1}`, metadata: {}, ...payload } as unknown as Row);
        return { error: null };
      },
      update: (payload: Record<string, unknown>) => ({
        eq: async (_col: string, id: string) => {
          Object.assign(this.rows.find((r) => r.id === id) ?? {}, payload);
          return { error: null };
        },
      }),
    };
  }
}

function existingProRow(overrides: Partial<Row> = {}): Row {
  return {
    id: "row-pro",
    user_id: "user_gb",
    tier: "pro",
    token_key: "hermesos",
    qualifying_quantity: PRO.toString(),
    threshold_at_qualification: PRO.toString(),
    qualifying_threshold_tier: "PRO_LAUNCH",
    qualified_at: "2026-06-01T00:00:00.000Z",
    currently_eligible: true,
    last_balance_seen: PRO.toString(),
    last_evaluated_at: "2026-09-23T00:00:00.000Z",
    last_breach_at: null,
    last_suspend_at: null,
    cooldown_ends_at: null,
    requalification_count: 0,
    requalification_window_start: null,
    metadata: {},
    ...overrides,
  };
}

function storedCountry(country: string | null) {
  mockFrom.mockImplementation(() => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({ data: country ? { country_code: country } : null, error: null }),
      }),
    }),
  }));
}

type Db = Parameters<typeof evaluateAndRecordTokenTierEligibility>[0]["db"];

beforeEach(() => {
  mockFrom.mockReset();
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe("dormant policy", () => {
  beforeEach(() => jest.replaceProperty(TOKEN_GEO_POLICY, "blockedCountries", []));

  it("records a first qualification for a GB user without reading any country", async () => {
    storedCountry("GB");
    const db = new FakeDb();
    const result = await evaluateAndRecordTokenTierEligibility({
      userId: "user_gb",
      balances: { hermesos: 250_000n },
      db: db as unknown as Db,
      now: NOW,
    });
    expect(result.pro?.transition).toBe("qualified");
    expect(db.inserts).toBe(1);
    expect(mockFrom).not.toHaveBeenCalled();
  });
});

describe("policy of ['GB']", () => {
  beforeEach(() => jest.replaceProperty(TOKEN_GEO_POLICY, "blockedCountries", ["GB"]));

  it("refuses a NEW qualification for a blocked request (IP signal from the route)", async () => {
    storedCountry(null);
    const db = new FakeDb();
    const tokenGeo = await resolveTokenGeoBlock({ get: () => "GB" }, { userId: "user_gb" });
    const result = await evaluateAndRecordTokenTierEligibility({
      userId: "user_gb",
      balances: { hermesos: 600_000n },
      tokenGeo,
      db: db as unknown as Db,
      now: NOW,
    });
    expect(db.inserts).toBe(0);
    expect(result.pro?.currentlyEligible).toBe(false);
    expect(result.power?.currentlyEligible).toBe(false);
    expect(result.warnings.join(" ")).toMatch(/refused by the token geo-policy/);
  });

  it("refuses a NEW qualification from a cron for a stored GB country, reading it once", async () => {
    storedCountry("GB");
    const db = new FakeDb();
    await evaluateAndRecordTokenTierEligibility({
      userId: "user_gb",
      balances: { hermesos: 600_000n },
      db: db as unknown as Db,
      now: NOW,
    });
    expect(db.inserts).toBe(0);
    expect(mockFrom).toHaveBeenCalledTimes(1);
    expect(mockFrom).toHaveBeenCalledWith("signup_risk_assessments");
  });

  it("refuses a NEW qualification from a cron when Clerk's latest session was in the UK", async () => {
    storedCountry(null);
    const originalKey = process.env.CLERK_SECRET_KEY;
    const originalFetch = global.fetch;
    process.env.CLERK_SECRET_KEY = "sk_test_geo";
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => [{ latest_activity: { country: "United Kingdom" } }],
    })) as unknown as typeof fetch;
    try {
      const db = new FakeDb();
      await evaluateAndRecordTokenTierEligibility({
        userId: "user_vpn",
        balances: { hermesos: 250_000n },
        db: db as unknown as Db,
        now: NOW,
      });
      expect(db.inserts).toBe(0);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    } finally {
      global.fetch = originalFetch;
      if (originalKey === undefined) delete process.env.CLERK_SECRET_KEY;
      else process.env.CLERK_SECRET_KEY = originalKey;
    }
  });

  it("still records a first qualification for a user who is not blocked", async () => {
    storedCountry("FR");
    const db = new FakeDb();
    const result = await evaluateAndRecordTokenTierEligibility({
      userId: "user_fr",
      balances: { hermesos: 250_000n },
      db: db as unknown as Db,
      now: NOW,
    });
    expect(result.pro?.transition).toBe("qualified");
    expect(db.inserts).toBe(1);
  });

  it("keeps an EXISTING tier for a blocked user: unchanged while they hold, and no country is even read", async () => {
    storedCountry("GB");
    const db = new FakeDb();
    db.rows.push(existingProRow());
    const tokenGeo = await resolveTokenGeoBlock({ get: () => "GB" }, { userId: "user_gb" });
    const result = await evaluateAndRecordTokenTierEligibility({
      userId: "user_gb",
      // Holds Pro, not enough for a NEW Power qualification.
      balances: { hermesos: 250_000n },
      tokenGeo,
      db: db as unknown as Db,
      now: NOW,
    });
    expect(result.pro?.currentlyEligible).toBe(true);
    expect(result.pro?.transition).toBe("unchanged");
    expect(db.rows.find((r) => r.id === "row-pro")?.currently_eligible).toBe(true);
    expect(db.inserts).toBe(0);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("lets an EXISTING tier recover from a breach for a blocked user, like anyone else", async () => {
    storedCountry("GB");
    const db = new FakeDb();
    db.rows.push(
      existingProRow({
        currently_eligible: false,
        last_breach_at: "2026-09-24T06:00:00.000Z",
        last_balance_seen: "1000",
      })
    );
    const result = await evaluateAndRecordTokenTierEligibility({
      userId: "user_gb",
      balances: { hermesos: 250_000n },
      db: db as unknown as Db,
      now: NOW,
    });
    expect(result.pro?.currentlyEligible).toBe(true);
    expect(db.rows.find((r) => r.id === "row-pro")?.currently_eligible).toBe(true);
    expect(db.inserts).toBe(0);
  });
});
