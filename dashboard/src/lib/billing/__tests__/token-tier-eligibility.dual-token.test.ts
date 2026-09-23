/**
 * Tier eligibility with $HIVRA ACTIVATED at a test address:
 *   - a new user can hold-for-tier only in $HIVRA ($HermesOS is refused);
 *   - a grandfathered user keeps a $HermesOS tier;
 *   - a grandfathered user who converts gets no access gap: either token
 *     counts during the grace, then the row moves to $HIVRA at the
 *     then-current threshold capped at the amount locked at conversion.
 * The launch block, live thresholds and deposit quotes are mocked.
 */
jest.mock("@/lib/billing/hivra-token-launch", () => ({
  HIVRA_TOKEN_LAUNCH: {
    contractAddress: "0x1111111111111111111111111111111111111111",
    decimals: 18,
    poolId: `0x${"ab".repeat(32)}`,
    activatesAt: "2026-10-01T16:00:00Z",
  },
}));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: {} }));

const ONE = 10n ** 18n;
// Same USD targets, different prices: $HIVRA is the pricier token here.
const HERMESOS_PRO = 5_000_000n * ONE;
const HERMESOS_POWER = 10_000_000n * ONE;
const HIVRA_PRO_AT_CONVERSION = 1_000n * ONE;
const HIVRA_PRO_NOW = 1_200n * ONE;
const HIVRA_POWER_NOW = 2_400n * ONE;

const liveMock = jest.fn();
jest.mock("@/lib/billing/live-thresholds", () => ({
  getLiveActiveThresholds: (...args: unknown[]) => liveMock(...args),
}));
const quotesMock = jest.fn(async () => [] as unknown[]);
const consumeMock = jest.fn(async () => undefined);
jest.mock("@/lib/billing/deposit-quotes", () => ({
  getActiveDepositQuotes: () => quotesMock(),
  consumeDepositQuote: () => consumeMock(),
}));

import { computeUserTokenAccess, TokenNotAllowedError } from "@/lib/billing/token-access";
import { evaluateAndRecordTokenTierEligibility } from "@/lib/billing/token-tier-eligibility";

type Row = Record<string, unknown> & { id: string; user_id: string; tier: string };

class FakeDb {
  rows: Row[] = [];
  /** Runs after each row read: lets a test change the row under the evaluator. */
  afterLoad: ((row: Row) => void) | null = null;
  from() {
    return {
      select: () => ({
        eq: (_c1: string, userId: string) => ({
          eq: (_c2: string, tier: string) => ({
            maybeSingle: async () => {
              const row = this.rows.find((r) => r.user_id === userId && r.tier === tier) ?? null;
              const copy = row ? { ...row } : null;
              if (row && this.afterLoad) {
                const hook = this.afterLoad;
                this.afterLoad = null;
                hook(row);
              }
              return { data: copy, error: null };
            },
          }),
        }),
      }),
      insert: async (payload: Record<string, unknown>) => {
        this.rows.push({
          id: `row-${this.rows.length + 1}`,
          last_breach_at: null,
          last_suspend_at: null,
          cooldown_ends_at: null,
          requalification_count: 0,
          requalification_window_start: null,
          metadata: {},
          ...payload,
        } as unknown as Row);
        return { error: null };
      },
      update: (payload: Record<string, unknown>) => ({
        eq: (_col: string, id: string) => {
          const row = () => this.rows.find((r) => r.id === id);
          return {
            then: (resolve: (value: { error: unknown }) => unknown) => {
              const target = row();
              if (target) Object.assign(target, payload);
              return Promise.resolve({ error: target ? null : { message: "missing" } }).then(resolve);
            },
            eq: (column: string, value: unknown) => ({
              select: async () => {
                const target = row();
                if (!target || target[column] !== value) return { data: [], error: null };
                Object.assign(target, payload);
                return { data: [{ id }], error: null };
              },
            }),
          };
        },
      }),
    };
  }
}
type DbCast = Parameters<typeof evaluateAndRecordTokenTierEligibility>[0]["db"];

const NOW = new Date("2026-10-02T12:00:00Z");
const HOUR_MS = 60 * 60 * 1000;

function thresholdsFor(token: { key: string }) {
  const hivra = token.key === "hivra";
  return {
    epoch: "standard",
    promoEndsAt: new Date("2026-05-30T23:59:59Z"),
    pro: { tier: "pro", epoch: "standard", code: "PRO_STANDARD", amount: hivra ? HIVRA_PRO_NOW : HERMESOS_PRO },
    power: { tier: "power", epoch: "standard", code: "POWER_STANDARD", amount: hivra ? HIVRA_POWER_NOW : HERMESOS_POWER },
    priceUsd: "1",
    priceFetchedAt: NOW,
  };
}

const newUser = computeUserTokenAccess({ phase: "active", cohort: null, now: NOW });
const grandfathered = computeUserTokenAccess({
  phase: "active",
  cohort: { user_id: "old", converted_at: null, conversion_grace_ends_at: null, metadata: {} },
  now: NOW,
});
function converted(at: Date, now: Date) {
  return computeUserTokenAccess({
    phase: "active",
    cohort: {
      user_id: "old",
      converted_at: at.toISOString(),
      conversion_grace_ends_at: new Date(at.getTime() + 72 * HOUR_MS).toISOString(),
      metadata: {
        conversion: {
          hivraThresholds: {
            pro: { amount: HIVRA_PRO_AT_CONVERSION.toString(), code: "PRO_STANDARD" },
            power: { amount: (2n * HIVRA_PRO_AT_CONVERSION).toString(), code: "POWER_STANDARD" },
          },
        },
      },
    },
    now,
  });
}

function hermesosProRow(overrides: Partial<Row> = {}): Row {
  return {
    id: "row-pro",
    user_id: "old",
    tier: "pro",
    token_key: "hermesos",
    qualifying_quantity: HERMESOS_PRO.toString(),
    threshold_at_qualification: HERMESOS_PRO.toString(),
    qualifying_threshold_tier: "PRO_LAUNCH",
    qualified_at: "2026-05-01T00:00:00Z",
    currently_eligible: true,
    last_balance_seen: HERMESOS_PRO.toString(),
    last_evaluated_at: null,
    last_breach_at: null,
    last_suspend_at: null,
    cooldown_ends_at: null,
    requalification_count: 0,
    requalification_window_start: null,
    metadata: {},
    ...overrides,
  };
}

beforeEach(() => {
  liveMock.mockReset();
  liveMock.mockImplementation(async ({ token }: { token: { key: string } }) => thresholdsFor(token));
  quotesMock.mockReset();
  quotesMock.mockResolvedValue([]);
});

describe("new users after $HIVRA activation", () => {
  it("do not qualify on $HermesOS, however much they hold", async () => {
    const db = new FakeDb();
    const result = await evaluateAndRecordTokenTierEligibility({
      userId: "new",
      balances: { hermesos: 100n * HERMESOS_POWER },
      access: newUser,
      db: db as unknown as DbCast,
      now: NOW,
    });
    expect(result.pro?.transition).toBe("unchanged");
    expect(result.power?.transition).toBe("unchanged");
    expect(db.rows).toHaveLength(0);
    // $HermesOS is never even priced for them.
    expect(liveMock).not.toHaveBeenCalledWith(expect.objectContaining({ token: expect.objectContaining({ key: "hermesos" }) }));
  });

  it("qualify by holding $HIVRA, and the row is held in $HIVRA", async () => {
    const db = new FakeDb();
    const result = await evaluateAndRecordTokenTierEligibility({
      userId: "new",
      balances: { hivra: HIVRA_PRO_NOW },
      access: newUser,
      db: db as unknown as DbCast,
      now: NOW,
    });
    expect(result.pro).toMatchObject({ transition: "qualified", tokenKey: "hivra", qualifyingQuantity: HIVRA_PRO_NOW });
    expect(db.rows[0]).toMatchObject({ tier: "pro", token_key: "hivra", qualifying_quantity: HIVRA_PRO_NOW.toString() });
  });

  it("cannot lock a $HermesOS hold-for-tier quote (refused server-side)", async () => {
    const { createDepositQuote } = jest.requireActual<typeof import("@/lib/billing/deposit-quotes")>(
      "@/lib/billing/deposit-quotes"
    );
    await expect(createDepositQuote({ userId: "new", tier: "pro", token: "hermesos", access: newUser })).rejects.toBeInstanceOf(
      TokenNotAllowedError
    );
  });

  it("ignore a stray $HermesOS deposit quote", async () => {
    quotesMock.mockResolvedValue([
      {
        id: "q1",
        tier: "pro",
        tokenKey: "hermesos",
        tokensRequiredRaw: ONE,
        thresholdTierCode: "PRO_STANDARD",
        priceUsdAtQuote: "1",
        usdTargetCents: 14900,
      },
    ]);
    const db = new FakeDb();
    const result = await evaluateAndRecordTokenTierEligibility({
      userId: "new",
      balances: { hermesos: ONE, hivra: 0n },
      access: newUser,
      db: db as unknown as DbCast,
      now: NOW,
    });
    expect(result.pro?.transition).toBe("unchanged");
    expect(db.rows).toHaveLength(0);
    expect(result.warnings.join("\n")).toMatch(/Ignoring deposit quote q1/);
  });
});

describe("grandfathered $HermesOS users", () => {
  it("still qualify in $HermesOS", async () => {
    const db = new FakeDb();
    const result = await evaluateAndRecordTokenTierEligibility({
      userId: "old",
      balances: { hermesos: HERMESOS_PRO, hivra: 0n },
      access: grandfathered,
      db: db as unknown as DbCast,
      now: NOW,
    });
    expect(result.pro).toMatchObject({ transition: "qualified", tokenKey: "hermesos" });
    expect(db.rows[0].token_key).toBe("hermesos");
  });

  it("keep an existing $HermesOS tier with no deadline", async () => {
    const db = new FakeDb();
    db.rows.push(hermesosProRow());
    const years = new Date("2030-01-01T00:00:00Z");
    const result = await evaluateAndRecordTokenTierEligibility({
      userId: "old",
      balances: { hermesos: HERMESOS_PRO, hivra: 0n },
      access: computeUserTokenAccess({
        phase: "active",
        cohort: { user_id: "old", converted_at: null, conversion_grace_ends_at: null, metadata: {} },
        now: years,
      }),
      db: db as unknown as DbCast,
      now: years,
    });
    expect(result.pro).toMatchObject({ transition: "unchanged", currentlyEligible: true, tokenKey: "hermesos" });
    expect(db.rows[0]).toMatchObject({ token_key: "hermesos", currently_eligible: true, last_breach_at: null });
  });

  it("are never breached on a token balance that was not read", async () => {
    const db = new FakeDb();
    db.rows.push(hermesosProRow());
    const result = await evaluateAndRecordTokenTierEligibility({
      userId: "old",
      balances: { hivra: 0n },
      access: grandfathered,
      db: db as unknown as DbCast,
      now: NOW,
    });
    expect(result.pro?.transition).toBe("unchanged");
    expect(db.rows[0].currently_eligible).toBe(true);
  });
});

describe("a grandfathered user who converts", () => {
  const convertedAt = NOW;

  it("keeps the tier during the grace holding only $HIVRA (at the amount locked at conversion)", async () => {
    const db = new FakeDb();
    db.rows.push(hermesosProRow());
    const during = new Date(convertedAt.getTime() + 24 * HOUR_MS);
    const result = await evaluateAndRecordTokenTierEligibility({
      userId: "old",
      balances: { hermesos: 0n, hivra: HIVRA_PRO_AT_CONVERSION },
      access: converted(convertedAt, during),
      db: db as unknown as DbCast,
      now: during,
    });
    expect(result.pro).toMatchObject({ transition: "unchanged", currentlyEligible: true, tokenKey: "hermesos" });
    expect(db.rows[0]).toMatchObject({ currently_eligible: true, last_breach_at: null });
  });

  it("keeps the tier during the grace still holding only $HermesOS", async () => {
    const db = new FakeDb();
    db.rows.push(hermesosProRow());
    const during = new Date(convertedAt.getTime() + 24 * HOUR_MS);
    const result = await evaluateAndRecordTokenTierEligibility({
      userId: "old",
      balances: { hermesos: HERMESOS_PRO, hivra: 0n },
      access: converted(convertedAt, during),
      db: db as unknown as DbCast,
      now: during,
    });
    expect(result.pro?.currentlyEligible).toBe(true);
    expect(db.rows[0].last_breach_at).toBeNull();
  });

  it("moves to $HIVRA after the grace, with no gap when holding enough", async () => {
    const db = new FakeDb();
    db.rows.push(hermesosProRow());
    const after = new Date(convertedAt.getTime() + 73 * HOUR_MS);
    const result = await evaluateAndRecordTokenTierEligibility({
      userId: "old",
      balances: { hermesos: 0n, hivra: HIVRA_PRO_NOW },
      access: converted(convertedAt, after),
      db: db as unknown as DbCast,
      now: after,
    });
    expect(result.pro).toMatchObject({ tokenKey: "hivra", transition: "unchanged", currentlyEligible: true, movedToHivra: true });
    expect(db.rows[0]).toMatchObject({
      token_key: "hivra",
      // min(locked 1,000, current 1,200)
      qualifying_quantity: HIVRA_PRO_AT_CONVERSION.toString(),
      currently_eligible: true,
      last_breach_at: null,
    });
    expect((db.rows[0].metadata as Record<string, unknown>).moved_from_hermesos).toMatchObject({
      qualifying_quantity: HERMESOS_PRO.toString(),
    });
  });

  it("keeps the tier after the grace holding the amount locked at conversion, even if $HIVRA got pricier to hold", async () => {
    // $HIVRA's price fell during the grace, so today's threshold (1,200) is
    // above the locked one (1,000). The move caps at the locked amount.
    const db = new FakeDb();
    db.rows.push(hermesosProRow());
    const after = new Date(convertedAt.getTime() + 73 * HOUR_MS);
    const result = await evaluateAndRecordTokenTierEligibility({
      userId: "old",
      balances: { hermesos: 0n, hivra: HIVRA_PRO_AT_CONVERSION },
      access: converted(convertedAt, after),
      db: db as unknown as DbCast,
      now: after,
    });
    expect(result.pro).toMatchObject({
      tokenKey: "hivra",
      transition: "unchanged",
      currentlyEligible: true,
      movedToHivra: true,
      qualifyingQuantity: HIVRA_PRO_AT_CONVERSION,
    });
    expect(db.rows[0]).toMatchObject({
      token_key: "hivra",
      currently_eligible: true,
      qualifying_quantity: HIVRA_PRO_AT_CONVERSION.toString(),
    });
  });

  it("takes today's lower threshold when $HIVRA got cheaper to hold during the grace", async () => {
    liveMock.mockImplementation(async ({ token }: { token: { key: string } }) => {
      const t = thresholdsFor(token);
      return token.key === "hivra" ? { ...t, pro: { ...t.pro, amount: 800n * ONE } } : t;
    });
    const db = new FakeDb();
    db.rows.push(hermesosProRow());
    const after = new Date(convertedAt.getTime() + 73 * HOUR_MS);
    const result = await evaluateAndRecordTokenTierEligibility({
      userId: "old",
      balances: { hermesos: 0n, hivra: 800n * ONE },
      access: converted(convertedAt, after),
      db: db as unknown as DbCast,
      now: after,
    });
    expect(result.pro).toMatchObject({ tokenKey: "hivra", currentlyEligible: true, qualifyingQuantity: 800n * ONE });
  });

  it("is breached (normal grace) only when holding less than both the locked and current amounts", async () => {
    const db = new FakeDb();
    db.rows.push(hermesosProRow());
    const after = new Date(convertedAt.getTime() + 73 * HOUR_MS);
    const result = await evaluateAndRecordTokenTierEligibility({
      userId: "old",
      balances: { hermesos: 0n, hivra: HIVRA_PRO_AT_CONVERSION - ONE },
      access: converted(convertedAt, after),
      db: db as unknown as DbCast,
      now: after,
    });
    expect(result.pro).toMatchObject({ tokenKey: "hivra", transition: "breached", inGrace: true });
    expect(db.rows[0]).toMatchObject({ token_key: "hivra", last_suspend_at: null });
  });

  it("does not overwrite a row a concurrent evaluation already moved", async () => {
    const db = new FakeDb();
    db.rows.push(hermesosProRow());
    const after = new Date(convertedAt.getTime() + 73 * HOUR_MS);
    const breachedAt = new Date(after.getTime() - 60_000).toISOString();
    // Another evaluation moves the row and records a breach right after we read it.
    db.afterLoad = (row) =>
      Object.assign(row, {
        token_key: "hivra",
        qualifying_quantity: HIVRA_PRO_NOW.toString(),
        currently_eligible: false,
        last_breach_at: breachedAt,
      });
    await evaluateAndRecordTokenTierEligibility({
      userId: "old",
      balances: { hermesos: 0n, hivra: 0n },
      access: converted(convertedAt, after),
      db: db as unknown as DbCast,
      now: after,
    });
    expect(db.rows[0]).toMatchObject({ token_key: "hivra", last_breach_at: breachedAt, currently_eligible: false });
  });

  it("stays on either-token rules past the grace while no $HIVRA price is available", async () => {
    liveMock.mockImplementation(async ({ token }: { token: { key: string } }) => {
      if (token.key === "hivra") throw new Error("feed down");
      return thresholdsFor(token);
    });
    const db = new FakeDb();
    db.rows.push(hermesosProRow());
    const after = new Date(convertedAt.getTime() + 80 * HOUR_MS);
    const result = await evaluateAndRecordTokenTierEligibility({
      userId: "old",
      balances: { hermesos: 0n, hivra: HIVRA_PRO_AT_CONVERSION },
      access: converted(convertedAt, after),
      db: db as unknown as DbCast,
      now: after,
    });
    expect(result.pro).toMatchObject({ tokenKey: "hermesos", currentlyEligible: true });
    expect(db.rows[0]).toMatchObject({ token_key: "hermesos", last_breach_at: null });
    expect(result.warnings.join("\n")).toMatch(/due to move to \$HIVRA/);
  });
});

describe("a lock-wallet move in flight", () => {
  it("holds a new breach until the hold ends, then breaches normally", async () => {
    const db = new FakeDb();
    const holdUntil = new Date(NOW.getTime() + 30 * 60 * 1000);
    db.rows.push(hermesosProRow({ metadata: { breach_hold_until: holdUntil.toISOString() } }));
    const during = await evaluateAndRecordTokenTierEligibility({
      userId: "old",
      balances: { hermesos: 0n, hivra: 0n },
      access: grandfathered,
      db: db as unknown as DbCast,
      now: NOW,
    });
    expect(during.pro).toMatchObject({ transition: "unchanged", currentlyEligible: true });
    expect(db.rows[0]).toMatchObject({ currently_eligible: true, last_breach_at: null });

    const after = new Date(holdUntil.getTime() + 1);
    const breached = await evaluateAndRecordTokenTierEligibility({
      userId: "old",
      balances: { hermesos: 0n, hivra: 0n },
      access: grandfathered,
      db: db as unknown as DbCast,
      now: after,
    });
    expect(breached.pro?.transition).toBe("breached");
  });
});
