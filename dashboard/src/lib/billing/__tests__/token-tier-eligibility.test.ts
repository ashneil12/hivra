/**
 * Tests for the eight critical paths the deposit flow must handle. From
 * BUILD_PLAN.md (locked spec, 2026-04-29):
 *
 *   1. First-time deposit during launch promo records the LAUNCH-rate
 *      qualifying quantity AND the PRO_LAUNCH code.
 *   2. Existing launch holder is grandfathered when the threshold rises to
 *      the standard rate — they stay eligible at their original quantity.
 *   3. New entrant after the launch promo window pays the STANDARD-rate
 *      qualifying quantity (PRO_STANDARD code).
 *   4. Breach within 48h grace + recovery flips eligibility back ON
 *      without changing qualifying_quantity (no penalty for a brief dip).
 *   5. Breach beyond 48h grace transitions to SUSPENDED, sets cooldown_ends_at
 *      to last_suspend_at + 7 days.
 *   6. Re-qualification while in 7-day cooldown is BLOCKED even if balance
 *      is back above threshold (transition = requalification_blocked_cooldown).
 *   7. Re-qualification after cooldown elapses succeeds at the CURRENT
 *      epoch's threshold — a launch holder who suspends and re-qualifies
 *      after the launch window LOSES the launch grandfather (now PRO_STANDARD).
 *   8. Re-qualification cap of 2 per rolling 365-day window is enforced
 *      (transition = requalification_blocked_cap on the third attempt).
 *
 * Plus a "fails closed when thresholds are not configured" case.
 */

jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {},
}));

interface FakeRow {
  id: string;
  user_id: string;
  tier: "pro" | "power";
  qualifying_quantity: string;
  threshold_at_qualification: string;
  qualifying_threshold_tier:
    | "PRO_LAUNCH"
    | "PRO_STANDARD"
    | "POWER_LAUNCH"
    | "POWER_STANDARD";
  qualified_at: string;
  currently_eligible: boolean;
  last_balance_seen: string | null;
  last_evaluated_at: string | null;
  last_breach_at: string | null;
  last_suspend_at: string | null;
  cooldown_ends_at: string | null;
  requalification_count: number;
  requalification_window_start: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

class FakeDb {
  rows: FakeRow[] = [];

  from() {
    return {
      select: () => ({
        eq: (_col1: string, val1: string) => ({
          eq: (_col2: string, val2: string) => ({
            maybeSingle: async () => {
              const row = this.rows.find(
                (r) => r.user_id === val1 && r.tier === (val2 as "pro" | "power")
              );
              return { data: row ?? null, error: null };
            },
          }),
        }),
      }),
      insert: async (payload: Record<string, unknown>) => {
        this.rows.push({
          id: `id-${this.rows.length + 1}`,
          metadata: {},
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          last_breach_at: null,
          last_suspend_at: null,
          cooldown_ends_at: null,
          requalification_count: 0,
          requalification_window_start: null,
          ...(payload as Partial<FakeRow>),
        } as FakeRow);
        return { error: null };
      },
      update: (payload: Record<string, unknown>) => ({
        eq: async (_col: string, val: string) => {
          const row = this.rows.find((r) => r.id === val);
          if (!row) return { error: { message: "row not found" } };
          Object.assign(row, payload, { updated_at: new Date().toISOString() });
          return { error: null };
        },
      }),
    };
  }
}

// ────────────────────────────────────────────────────────────────────
// Threshold module mocks
//
// We mount fresh mocks of `tier-thresholds` per test by re-requiring the
// eligibility module after `jest.doMock`. This lets us drive the active
// threshold (launch vs standard) and the threshold values without touching
// the production constants.
// ────────────────────────────────────────────────────────────────────

const PRO_LAUNCH = 200_000n;
const PRO_STANDARD = 300_000n;
const POWER_LAUNCH = 500_000n;
const POWER_STANDARD = 750_000n;

const LAUNCH_PROMO_END = new Date("2026-05-30T23:59:59.000Z");
const NOW_DURING_LAUNCH = new Date("2026-04-29T12:00:00.000Z");
const NOW_AFTER_LAUNCH = new Date("2026-06-15T12:00:00.000Z");

function thresholdsModule() {
  jest.doMock("../tier-thresholds", () => {
    const actual = jest.requireActual<typeof import("../tier-thresholds")>(
      "../tier-thresholds"
    );

    const PRO_THRESHOLD_LAUNCH_TOKEN_UNITS = PRO_LAUNCH;
    const PRO_THRESHOLD_STANDARD_TOKEN_UNITS = PRO_STANDARD;
    const POWER_THRESHOLD_LAUNCH_TOKEN_UNITS = POWER_LAUNCH;
    const POWER_THRESHOLD_STANDARD_TOKEN_UNITS = POWER_STANDARD;

    function resolveActiveThresholds(now: Date = new Date()) {
      const inLaunch = now < LAUNCH_PROMO_END;
      const epoch = inLaunch ? "launch" : "standard";
      return {
        epoch,
        promoEndsAt: LAUNCH_PROMO_END,
        pro: {
          tier: "pro" as const,
          epoch,
          code: inLaunch ? "PRO_LAUNCH" : "PRO_STANDARD",
          amount: inLaunch
            ? PRO_THRESHOLD_LAUNCH_TOKEN_UNITS
            : PRO_THRESHOLD_STANDARD_TOKEN_UNITS,
        },
        power: {
          tier: "power" as const,
          epoch,
          code: inLaunch ? "POWER_LAUNCH" : "POWER_STANDARD",
          amount: inLaunch
            ? POWER_THRESHOLD_LAUNCH_TOKEN_UNITS
            : POWER_THRESHOLD_STANDARD_TOKEN_UNITS,
        },
      };
    }

    function getTierThresholds(now: Date = new Date()) {
      const active = resolveActiveThresholds(now);
      return {
        source: "configured" as const,
        thresholds: { pro: active.pro.amount, power: active.power.amount },
      };
    }

    return {
      ...actual,
      PRO_THRESHOLD_LAUNCH_TOKEN_UNITS,
      PRO_THRESHOLD_STANDARD_TOKEN_UNITS,
      POWER_THRESHOLD_LAUNCH_TOKEN_UNITS,
      POWER_THRESHOLD_STANDARD_TOKEN_UNITS,
      LAUNCH_PROMO_END_DATE: LAUNCH_PROMO_END,
      REQUALIFICATION_GRACE_HOURS: 48,
      REQUALIFICATION_COOLDOWN_DAYS: 7,
      REQUALIFICATION_CAP_PER_YEAR: 2,
      REQUALIFICATION_WINDOW_DAYS: 365,
      resolveActiveThresholds,
      getTierThresholds,
    };
  });

  // The eligibility evaluator now resolves thresholds via live-thresholds
  // (USD-target ÷ live CoinGecko price). Tests don't want to hit the network
  // and don't care about the price math — they want the deterministic token
  // amounts above. Mock the live module to pass through resolveActiveThresholds.
  jest.doMock("../live-thresholds", () => ({
    getLiveActiveThresholds: async ({ now }: { now?: Date } = {}) => {
      const inLaunch = (now ?? new Date()) < LAUNCH_PROMO_END;
      const epoch = inLaunch ? "launch" : "standard";
      return {
        epoch,
        promoEndsAt: LAUNCH_PROMO_END,
        pro: {
          tier: "pro",
          epoch,
          code: inLaunch ? "PRO_LAUNCH" : "PRO_STANDARD",
          amount: inLaunch ? PRO_LAUNCH : PRO_STANDARD,
        },
        power: {
          tier: "power",
          epoch,
          code: inLaunch ? "POWER_LAUNCH" : "POWER_STANDARD",
          amount: inLaunch ? POWER_LAUNCH : POWER_STANDARD,
        },
        source: "live",
        priceUsd: "0.00002609",
        priceFetchedAt: now ?? new Date(),
        warnings: [],
      };
    },
  }));

  return jest.requireActual<typeof import("../token-tier-eligibility")>("../token-tier-eligibility");
}

function loadModule() {
  jest.resetModules();
  return thresholdsModule();
}

function loadModuleWithLiveThresholdAmounts(params: {
  pro: bigint;
  power: bigint;
}) {
  jest.resetModules();
  jest.doMock("../live-thresholds", () => ({
    getLiveActiveThresholds: async ({ now }: { now?: Date } = {}) => ({
      epoch: "launch",
      promoEndsAt: LAUNCH_PROMO_END,
      pro: {
        tier: "pro",
        epoch: "launch",
        code: "PRO_LAUNCH",
        amount: params.pro,
      },
      power: {
        tier: "power",
        epoch: "launch",
        code: "POWER_LAUNCH",
        amount: params.power,
      },
      source: "live",
      priceUsd: "0.00000293",
      priceFetchedAt: now ?? new Date(),
      warnings: [],
    }),
  }));
  jest.doMock("../deposit-quotes", () => ({
    getActiveDepositQuotes: async () => [],
    consumeDepositQuote: async () => undefined,
  }));

  return jest.requireActual<typeof import("../token-tier-eligibility")>("../token-tier-eligibility");
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function isoFromOffset(base: Date, offsetMs: number): string {
  return new Date(base.getTime() + offsetMs).toISOString();
}

function makeRow(overrides: Partial<FakeRow>): FakeRow {
  return {
    id: "id-1",
    user_id: "user_x",
    tier: "pro",
    qualifying_quantity: PRO_LAUNCH.toString(),
    threshold_at_qualification: PRO_LAUNCH.toString(),
    qualifying_threshold_tier: "PRO_LAUNCH",
    qualified_at: "2026-04-29T12:00:00.000Z",
    currently_eligible: true,
    last_balance_seen: PRO_LAUNCH.toString(),
    last_evaluated_at: "2026-04-29T12:00:00.000Z",
    last_breach_at: null,
    last_suspend_at: null,
    cooldown_ends_at: null,
    requalification_count: 0,
    requalification_window_start: null,
    metadata: {},
    created_at: "2026-04-29T12:00:00.000Z",
    updated_at: "2026-04-29T12:00:00.000Z",
    ...overrides,
  };
}

type DbCast = Parameters<
  typeof import("../token-tier-eligibility").evaluateAndRecordTokenTierEligibility
>[0]["db"];

describe("evaluateAndRecordTokenTierEligibility", () => {
  it("Case 1 — first-time deposit during launch promo records PRO_LAUNCH code at launch threshold", async () => {
    const mod = loadModule();
    const db = new FakeDb();

    const result = await mod.evaluateAndRecordTokenTierEligibility({
      userId: "user_a",
      currentBalance: 250_000n, // above Pro launch (200k), below Power launch (500k)
      db: db as unknown as DbCast,
      now: NOW_DURING_LAUNCH,
    });

    expect(result.configured).toBe(true);
    expect(result.pro?.transition).toBe("qualified");
    expect(result.pro?.currentlyEligible).toBe(true);
    expect(result.pro?.qualifyingQuantity).toBe(PRO_LAUNCH);
    expect(result.pro?.qualifyingThresholdTier).toBe("PRO_LAUNCH");
    expect(result.pro?.thresholdCode).toBe("PRO_LAUNCH");
    expect(result.power?.transition).toBe("unchanged");
    expect(result.power?.currentlyEligible).toBe(false);
    expect(result.power?.qualifyingQuantity).toBeNull();

    const proRow = db.rows.find((r) => r.tier === "pro");
    expect(proRow).toBeDefined();
    expect(proRow?.qualifying_quantity).toBe(PRO_LAUNCH.toString());
    expect(proRow?.qualifying_threshold_tier).toBe("PRO_LAUNCH");
    expect(proRow?.currently_eligible).toBe(true);
  });

  it("qualifies Power when the on-chain balance is only raw-unit dust below the quoted threshold", async () => {
    const tokenUnit = 10n ** 18n;
    const proThreshold = 34_185_083n * tokenUnit;
    const powerThreshold = 67_941_277n * tokenUnit;
    const mod = loadModuleWithLiveThresholdAmounts({
      pro: proThreshold,
      power: powerThreshold,
    });
    const db = new FakeDb();
    const dustShortfall = 2_488_532_992n;

    const result = await mod.evaluateAndRecordTokenTierEligibility({
      userId: "user_power_dust",
      currentBalance: powerThreshold - dustShortfall,
      db: db as unknown as DbCast,
      now: NOW_DURING_LAUNCH,
    });

    expect(result.power?.transition).toBe("qualified");
    expect(result.power?.currentlyEligible).toBe(true);
    expect(result.power?.qualifyingQuantity).toBe(powerThreshold);
    expect(result.power?.qualifyingThresholdTier).toBe("POWER_LAUNCH");

    const powerRow = db.rows.find((r) => r.tier === "power");
    expect(powerRow).toBeDefined();
    expect(powerRow?.qualifying_quantity).toBe(powerThreshold.toString());
    expect(powerRow?.currently_eligible).toBe(true);
    expect(powerRow?.last_balance_seen).toBe((powerThreshold - dustShortfall).toString());
  });

  it("Case 2 — existing PRO_LAUNCH holder is grandfathered when threshold rises post-launch", async () => {
    // User qualified at PRO_LAUNCH (200k). Time has moved past the launch
    // promo window so the active threshold is PRO_STANDARD (300k). Their
    // balance is 220k — above their qualifying_quantity (200k) but below
    // the new active threshold (300k). They MUST stay eligible.
    const mod = loadModule();
    const db = new FakeDb();

    db.rows.push(
      makeRow({
        user_id: "user_b",
        last_balance_seen: "220000",
        last_evaluated_at: "2026-06-01T00:00:00.000Z",
        updated_at: "2026-06-01T00:00:00.000Z",
      })
    );

    const result = await mod.evaluateAndRecordTokenTierEligibility({
      userId: "user_b",
      currentBalance: 220_000n,
      db: db as unknown as DbCast,
      now: NOW_AFTER_LAUNCH,
    });

    expect(result.pro?.transition).toBe("unchanged");
    expect(result.pro?.currentlyEligible).toBe(true);
    expect(result.pro?.qualifyingQuantity).toBe(PRO_LAUNCH);
    expect(result.pro?.qualifyingThresholdTier).toBe("PRO_LAUNCH");
    // Active threshold reflects the standard epoch, not the user's deal.
    expect(result.pro?.threshold).toBe(PRO_STANDARD);
    expect(result.pro?.thresholdCode).toBe("PRO_STANDARD");

    const proRow = db.rows[0];
    expect(proRow.qualifying_quantity).toBe(PRO_LAUNCH.toString());
    expect(proRow.qualifying_threshold_tier).toBe("PRO_LAUNCH");
    expect(proRow.currently_eligible).toBe(true);
  });

  it("Case 3 — new entrant after the launch promo window pays the STANDARD threshold", async () => {
    const mod = loadModule();
    const db = new FakeDb();

    const result = await mod.evaluateAndRecordTokenTierEligibility({
      userId: "user_c",
      currentBalance: 320_000n, // above PRO_STANDARD (300k)
      db: db as unknown as DbCast,
      now: NOW_AFTER_LAUNCH,
    });

    expect(result.pro?.transition).toBe("qualified");
    expect(result.pro?.qualifyingQuantity).toBe(PRO_STANDARD);
    expect(result.pro?.qualifyingThresholdTier).toBe("PRO_STANDARD");
    expect(result.pro?.thresholdCode).toBe("PRO_STANDARD");

    const proRow = db.rows.find((r) => r.tier === "pro");
    expect(proRow?.qualifying_quantity).toBe(PRO_STANDARD.toString());
    expect(proRow?.qualifying_threshold_tier).toBe("PRO_STANDARD");
  });

  it("Case 4 — breach within 48h grace + recovery flips eligibility back ON without penalty", async () => {
    // User breached 12h ago (still inside grace). Balance has now returned
    // to above qualifying_quantity. Should return to currently_eligible=true
    // with no change to qualifying_quantity and no requalification count bump.
    const mod = loadModule();
    const db = new FakeDb();

    const breachAt = isoFromOffset(NOW_DURING_LAUNCH, -12 * HOUR_MS);

    db.rows.push(
      makeRow({
        user_id: "user_d",
        currently_eligible: false, // strict check
        last_balance_seen: "150000",
        last_evaluated_at: breachAt,
        last_breach_at: breachAt,
      })
    );

    const result = await mod.evaluateAndRecordTokenTierEligibility({
      userId: "user_d",
      currentBalance: 220_000n, // back above PRO_LAUNCH qualifying (200k)
      db: db as unknown as DbCast,
      now: NOW_DURING_LAUNCH,
    });

    expect(result.pro?.transition).toBe("grace_recovered");
    expect(result.pro?.currentlyEligible).toBe(true);
    expect(result.pro?.qualifyingQuantity).toBe(PRO_LAUNCH);
    // qualifying_threshold_tier is preserved.
    expect(result.pro?.qualifyingThresholdTier).toBe("PRO_LAUNCH");

    const proRow = db.rows[0];
    expect(proRow.currently_eligible).toBe(true);
    expect(proRow.last_breach_at).toBeNull();
    expect(proRow.qualifying_quantity).toBe(PRO_LAUNCH.toString()); // unchanged
    expect(proRow.requalification_count).toBe(0); // grace recovery doesn't count
    expect(proRow.last_suspend_at).toBeNull();
    expect(proRow.cooldown_ends_at).toBeNull();
  });

  it("Case 5 — breach past 48h grace transitions to SUSPENDED with cooldown_ends_at = now + 7d", async () => {
    const mod = loadModule();
    const db = new FakeDb();

    // Breach happened 50h ago — past the 48h grace window.
    const breachAt = isoFromOffset(NOW_DURING_LAUNCH, -50 * HOUR_MS);

    db.rows.push(
      makeRow({
        user_id: "user_e",
        currently_eligible: false,
        last_balance_seen: "150000",
        last_evaluated_at: breachAt,
        last_breach_at: breachAt,
      })
    );

    const result = await mod.evaluateAndRecordTokenTierEligibility({
      userId: "user_e",
      currentBalance: 150_000n, // still below qualifying
      db: db as unknown as DbCast,
      now: NOW_DURING_LAUNCH,
    });

    expect(result.pro?.transition).toBe("suspended");
    expect(result.pro?.currentlyEligible).toBe(false);
    expect(result.pro?.cooldownEndsAt).not.toBeNull();

    const proRow = db.rows[0];
    expect(proRow.last_suspend_at).toBe(NOW_DURING_LAUNCH.toISOString());
    expect(proRow.cooldown_ends_at).not.toBeNull();
    // Cooldown end must be exactly 7 days after suspend.
    const cooldownEnd = new Date(proRow.cooldown_ends_at!);
    expect(cooldownEnd.getTime() - NOW_DURING_LAUNCH.getTime()).toBe(7 * DAY_MS);
    // Qualifying quantity unchanged — they keep their grandfathered deal
    // until they re-qualify (which would replace it).
    expect(proRow.qualifying_quantity).toBe(PRO_LAUNCH.toString());
    expect(proRow.qualifying_threshold_tier).toBe("PRO_LAUNCH");
  });

  it("Case 6 — re-qualification while in 7-day cooldown is BLOCKED even if balance is above threshold", async () => {
    const mod = loadModule();
    const db = new FakeDb();

    // Suspended 3 days ago, cooldown ends 4 days from now.
    const suspendAt = isoFromOffset(NOW_DURING_LAUNCH, -3 * DAY_MS);
    const cooldownEnd = isoFromOffset(NOW_DURING_LAUNCH, 4 * DAY_MS);

    db.rows.push(
      makeRow({
        user_id: "user_f",
        currently_eligible: false,
        last_balance_seen: "150000",
        last_evaluated_at: suspendAt,
        last_breach_at: isoFromOffset(NOW_DURING_LAUNCH, -5 * DAY_MS),
        last_suspend_at: suspendAt,
        cooldown_ends_at: cooldownEnd,
      })
    );

    const result = await mod.evaluateAndRecordTokenTierEligibility({
      userId: "user_f",
      currentBalance: 250_000n, // above active PRO_LAUNCH threshold (200k)
      db: db as unknown as DbCast,
      now: NOW_DURING_LAUNCH,
    });

    expect(result.pro?.transition).toBe("requalification_blocked_cooldown");
    expect(result.pro?.currentlyEligible).toBe(false);
    expect(result.pro?.cooldownEndsAt).toEqual(new Date(cooldownEnd));

    const proRow = db.rows[0];
    expect(proRow.currently_eligible).toBe(false);
    expect(proRow.last_suspend_at).toBe(suspendAt);
    expect(proRow.cooldown_ends_at).toBe(cooldownEnd);
    // qualifying_quantity is still the original (no re-qual happened).
    expect(proRow.qualifying_quantity).toBe(PRO_LAUNCH.toString());
    expect(proRow.qualifying_threshold_tier).toBe("PRO_LAUNCH");
    // last_balance_seen was refreshed.
    expect(proRow.last_balance_seen).toBe("250000");
  });

  it("Case 7 — re-qualifying after the launch window LOSES the launch grandfather (now PRO_STANDARD)", async () => {
    // User originally qualified at PRO_LAUNCH. They were then suspended.
    // Cooldown has elapsed. We're now AFTER the launch promo window.
    // They re-deposit to 320k (above PRO_STANDARD = 300k). They re-qualify
    // at PRO_STANDARD — losing their launch deal.
    const mod = loadModule();
    const db = new FakeDb();

    const suspendAt = isoFromOffset(NOW_AFTER_LAUNCH, -10 * DAY_MS);
    const cooldownEnded = isoFromOffset(NOW_AFTER_LAUNCH, -3 * DAY_MS);

    db.rows.push(
      makeRow({
        user_id: "user_g",
        currently_eligible: false,
        last_balance_seen: "150000",
        last_evaluated_at: suspendAt,
        last_breach_at: isoFromOffset(NOW_AFTER_LAUNCH, -12 * DAY_MS),
        last_suspend_at: suspendAt,
        cooldown_ends_at: cooldownEnded, // already past
        requalification_count: 0,
        requalification_window_start: null,
      })
    );

    const result = await mod.evaluateAndRecordTokenTierEligibility({
      userId: "user_g",
      currentBalance: 320_000n,
      db: db as unknown as DbCast,
      now: NOW_AFTER_LAUNCH,
    });

    expect(result.pro?.transition).toBe("re_qualified");
    expect(result.pro?.currentlyEligible).toBe(true);
    // Re-qualified at the STANDARD threshold — the launch grandfather is gone.
    expect(result.pro?.qualifyingQuantity).toBe(PRO_STANDARD);
    expect(result.pro?.qualifyingThresholdTier).toBe("PRO_STANDARD");
    expect(result.pro?.thresholdCode).toBe("PRO_STANDARD");

    const proRow = db.rows[0];
    expect(proRow.qualifying_quantity).toBe(PRO_STANDARD.toString());
    expect(proRow.threshold_at_qualification).toBe(PRO_STANDARD.toString());
    expect(proRow.qualifying_threshold_tier).toBe("PRO_STANDARD");
    expect(proRow.qualified_at).toBe(NOW_AFTER_LAUNCH.toISOString());
    expect(proRow.currently_eligible).toBe(true);
    expect(proRow.last_breach_at).toBeNull();
    expect(proRow.last_suspend_at).toBeNull();
    expect(proRow.cooldown_ends_at).toBeNull();
    expect(proRow.requalification_count).toBe(1);
    expect(proRow.requalification_window_start).toBe(NOW_AFTER_LAUNCH.toISOString());
  });

  it("Case 8 — third re-qualification within 365 days is BLOCKED by the cap", async () => {
    const mod = loadModule();
    const db = new FakeDb();

    // Window opened 100 days ago. User has already re-qualified twice in
    // that window. They're now suspended again, cooldown has elapsed,
    // balance is above active threshold — but the cap blocks them.
    const windowStart = isoFromOffset(NOW_DURING_LAUNCH, -100 * DAY_MS);
    const suspendAt = isoFromOffset(NOW_DURING_LAUNCH, -10 * DAY_MS);
    const cooldownEnded = isoFromOffset(NOW_DURING_LAUNCH, -3 * DAY_MS);

    db.rows.push(
      makeRow({
        user_id: "user_h",
        currently_eligible: false,
        last_balance_seen: "150000",
        last_evaluated_at: suspendAt,
        last_breach_at: isoFromOffset(NOW_DURING_LAUNCH, -12 * DAY_MS),
        last_suspend_at: suspendAt,
        cooldown_ends_at: cooldownEnded,
        requalification_count: 2, // cap already hit
        requalification_window_start: windowStart,
      })
    );

    const result = await mod.evaluateAndRecordTokenTierEligibility({
      userId: "user_h",
      currentBalance: 250_000n, // above PRO_LAUNCH threshold
      db: db as unknown as DbCast,
      now: NOW_DURING_LAUNCH,
    });

    expect(result.pro?.transition).toBe("requalification_blocked_cap");
    expect(result.pro?.currentlyEligible).toBe(false);
    expect(result.warnings.join("\n")).toMatch(/cap of 2 per 365d reached/);

    const proRow = db.rows[0];
    // No re-qualification recorded.
    expect(proRow.qualifying_quantity).toBe(PRO_LAUNCH.toString());
    expect(proRow.qualifying_threshold_tier).toBe("PRO_LAUNCH");
    expect(proRow.requalification_count).toBe(2); // unchanged
    expect(proRow.requalification_window_start).toBe(windowStart);
    expect(proRow.last_balance_seen).toBe("250000"); // refreshed
  });

  it("skips evaluation and writes nothing when the live price feed is unreachable", async () => {
    jest.resetModules();
    jest.doMock("../live-thresholds", () => {
      class LivePriceUnavailableError extends Error {
        constructor(message: string) {
          super(message);
          this.name = "LivePriceUnavailableError";
        }
      }
      return {
        LivePriceUnavailableError,
        getLiveActiveThresholds: async () => {
          throw new LivePriceUnavailableError("CoinGecko 503");
        },
      };
    });
    const mod = jest.requireActual<typeof import("../token-tier-eligibility")>("../token-tier-eligibility");

    const db = new FakeDb();
    const result = await mod.evaluateAndRecordTokenTierEligibility({
      userId: "user_z",
      currentBalance: 999_999_999n,
      db: db as unknown as DbCast,
      now: NOW_DURING_LAUNCH,
    });

    // Evaluator deliberately skips on price-feed failure rather than
    // serving a wrong threshold. Existing holders are unaffected because
    // qualifying_quantity is already snapshotted on their rows.
    expect(result.configured).toBe(false);
    expect(result.pro).toBeNull();
    expect(result.power).toBeNull();
    expect(db.rows).toHaveLength(0);
    expect(result.warnings.join("\n")).toMatch(/Live \$HERMESOS price unavailable/);
  });

  it("self-heals an orphaned active deposit quote for a still-eligible holder (Case h)", async () => {
    // Models the orphaned-quote race: a prior first-time qualification recorded
    // the row but failed to consume its quote. On a later stable tick (Case h)
    // the still-active quote must be reconciled (idempotently consumed).
    jest.resetModules();
    const consumeSpy = jest.fn(async (..._args: unknown[]) => undefined);
    jest.doMock("../live-thresholds", () => ({
      getLiveActiveThresholds: async ({ now }: { now?: Date } = {}) => ({
        epoch: "launch",
        promoEndsAt: LAUNCH_PROMO_END,
        pro: { tier: "pro", epoch: "launch", code: "PRO_LAUNCH", amount: PRO_LAUNCH },
        power: { tier: "power", epoch: "launch", code: "POWER_LAUNCH", amount: POWER_LAUNCH },
        source: "live",
        priceUsd: "0.00000293",
        priceFetchedAt: now ?? new Date(),
        warnings: [],
      }),
    }));
    jest.doMock("../deposit-quotes", () => ({
      // Only the pro tier has the orphaned quote, so this test exercises the
      // pro Case-h self-heal — not the power tier's first-time Case-a consume.
      getActiveDepositQuotes: async ({ tier }: { tier: string }) =>
        tier === "pro"
          ? [
              {
                id: "quote_orphan",
                tokensRequiredRaw: PRO_LAUNCH,
                priceUsdAtQuote: "0.01",
                usdTargetCents: 100,
              },
            ]
          : [],
      consumeDepositQuote: (...args: unknown[]) => consumeSpy(...args),
    }));
    const mod = jest.requireActual<
      typeof import("../token-tier-eligibility")
    >("../token-tier-eligibility");

    const db = new FakeDb();
    db.rows.push(
      makeRow({
        user_id: "user_h",
        tier: "pro",
        currently_eligible: true,
        qualifying_quantity: PRO_LAUNCH.toString(),
      })
    );

    const result = await mod.evaluateAndRecordTokenTierEligibility({
      userId: "user_h",
      currentBalance: 250_000n, // ≥ Pro launch (200k), still eligible → Case h
      db: db as unknown as DbCast,
      now: NOW_DURING_LAUNCH,
    });

    expect(result.pro?.transition).toBe("unchanged");
    expect(result.pro?.currentlyEligible).toBe(true);
    // The orphaned active quote was reconciled (idempotent consume).
    expect(consumeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ quoteId: "quote_orphan" })
    );
  });

  it("does NOT touch the deposit quote for a holder who is NOT currently eligible (Case h)", async () => {
    // A suspended/re-qualifying holder's active quote is still needed — Case h
    // must only reconcile when the user is currently eligible.
    jest.resetModules();
    const consumeSpy = jest.fn(async (..._args: unknown[]) => undefined);
    jest.doMock("../live-thresholds", () => ({
      getLiveActiveThresholds: async ({ now }: { now?: Date } = {}) => ({
        epoch: "launch",
        promoEndsAt: LAUNCH_PROMO_END,
        pro: { tier: "pro", epoch: "launch", code: "PRO_LAUNCH", amount: PRO_LAUNCH },
        power: { tier: "power", epoch: "launch", code: "POWER_LAUNCH", amount: POWER_LAUNCH },
        source: "live",
        priceUsd: "0.00000293",
        priceFetchedAt: now ?? new Date(),
        warnings: [],
      }),
    }));
    jest.doMock("../deposit-quotes", () => ({
      getActiveDepositQuotes: async ({ tier }: { tier: string }) =>
        tier === "pro"
          ? [{ id: "quote_pending", tokensRequiredRaw: PRO_LAUNCH, priceUsdAtQuote: "0.01", usdTargetCents: 100 }]
          : [],
      consumeDepositQuote: (...args: unknown[]) => consumeSpy(...args),
    }));
    const mod = jest.requireActual<
      typeof import("../token-tier-eligibility")
    >("../token-tier-eligibility");

    const db = new FakeDb();
    // Row exists but the holder is NOT currently eligible and not in any
    // suspend/grace branch → Case h with wasStrictlyEligible=false.
    db.rows.push(
      makeRow({
        user_id: "user_h2",
        tier: "pro",
        currently_eligible: false,
        qualifying_quantity: PRO_LAUNCH.toString(),
      })
    );

    await mod.evaluateAndRecordTokenTierEligibility({
      userId: "user_h2",
      currentBalance: 250_000n,
      db: db as unknown as DbCast,
      now: NOW_DURING_LAUNCH,
    });

    expect(consumeSpy).not.toHaveBeenCalled();
  });
});
