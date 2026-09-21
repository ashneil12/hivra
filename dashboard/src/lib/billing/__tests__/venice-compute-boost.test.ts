/**
 * Venice compute-boost evaluator tests.
 *
 * Covers the exact USD valuation (no float in the threshold gate) and the
 * grace state machine: qualify → breach → 48h grace → expire, plus recovery
 * and re-qualification.
 */

import {
  computeVvvHoldingUsd,
  evaluateAndRecordVeniceComputeBoost,
  VENICE_BOOST_GRACE_HOURS,
  type VeniceBoostDb,
} from "../venice-compute-boost";

const E18 = 10n ** 18n;
const PRICE_ONE = "1"; // 1 VVV = $1 → usd value == whole-token count.

interface MockRow {
  id: string;
  user_id: string;
  currently_eligible: boolean;
  last_breach_at: string | null;
  last_balance_seen: string | null;
  last_usd_value: number | null;
}

function makeDb(initial: MockRow | null) {
  let row: MockRow | null = initial;
  const inserts: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];

  const db = {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                maybeSingle: async () => ({ data: row, error: null }),
                in: async () => ({ data: [], error: null }),
              };
            },
          };
        },
        insert: async (payload: Record<string, unknown>) => {
          inserts.push(payload);
          row = {
            id: "row-1",
            user_id: String(payload.user_id),
            currently_eligible: Boolean(payload.currently_eligible),
            last_breach_at: (payload.last_breach_at as string | null) ?? null,
            last_balance_seen: (payload.last_balance_seen as string | null) ?? null,
            last_usd_value: (payload.last_usd_value as number | null) ?? null,
          };
          return { error: null };
        },
        update(payload: Record<string, unknown>) {
          return {
            eq: async () => {
              updates.push(payload);
              if (row) row = { ...row, ...payload } as MockRow;
              return { error: null };
            },
          };
        },
      };
    },
  };

  return {
    db: db as unknown as VeniceBoostDb,
    inserts,
    updates,
    getRow: () => row,
  };
}

function existingRow(over: Partial<MockRow> = {}): MockRow {
  return {
    id: "row-1",
    user_id: "user_1",
    currently_eligible: true,
    last_breach_at: null,
    last_balance_seen: (199n * E18).toString(),
    last_usd_value: 199,
    ...over,
  };
}

describe("computeVvvHoldingUsd", () => {
  it("values a holding precisely and gates on the threshold", () => {
    const r = computeVvvHoldingUsd(200n * E18, "1.5", 199);
    expect(r.usdValue).toBeCloseTo(300, 6);
    expect(r.meetsThreshold).toBe(true);
  });

  it("rejects a holding below the threshold", () => {
    const r = computeVvvHoldingUsd(100n * E18, "1", 199);
    expect(r.usdValue).toBeCloseTo(100, 6);
    expect(r.meetsThreshold).toBe(false);
  });

  it("handles fractional prices without float drift in the gate", () => {
    const r = computeVvvHoldingUsd(1000n * E18, "0.25", 199);
    expect(r.usdValue).toBeCloseTo(250, 6);
    expect(r.meetsThreshold).toBe(true);
    expect(computeVvvHoldingUsd(1000n * E18, "0.25", 300).meetsThreshold).toBe(false);
  });

  it("treats exactly the threshold as meeting it", () => {
    expect(computeVvvHoldingUsd(199n * E18, "1", 199).meetsThreshold).toBe(true);
  });

  it("throws on a malformed price string", () => {
    expect(() => computeVvvHoldingUsd(1n * E18, "not-a-price", 199)).toThrow();
  });
});

describe("evaluateAndRecordVeniceComputeBoost", () => {
  it("qualifies a first-time holder at/above the threshold", async () => {
    const { db, inserts } = makeDb(null);
    const res = await evaluateAndRecordVeniceComputeBoost({
      userId: "user_1",
      vvvBalanceRaw: 200n * E18,
      vvvPriceUsd: PRICE_ONE,
      db,
    });
    expect(res).toMatchObject({ eligible: true, transition: "qualified" });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ currently_eligible: true, last_breach_at: null });
  });

  it("records nothing for a first-time non-holder below the threshold", async () => {
    const { db, inserts, updates } = makeDb(null);
    const res = await evaluateAndRecordVeniceComputeBoost({
      userId: "user_1",
      vvvBalanceRaw: 100n * E18,
      vvvPriceUsd: PRICE_ONE,
      db,
    });
    expect(res).toMatchObject({ eligible: false, transition: "unchanged" });
    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it("opens a grace window on a fresh breach but stays eligible", async () => {
    const now = new Date("2026-05-01T00:00:00.000Z");
    const { db, updates } = makeDb(existingRow({ currently_eligible: true, last_breach_at: null }));
    const res = await evaluateAndRecordVeniceComputeBoost({
      userId: "user_1",
      vvvBalanceRaw: 100n * E18,
      vvvPriceUsd: PRICE_ONE,
      now,
      db,
    });
    expect(res).toMatchObject({ eligible: true, transition: "breached", inGrace: true });
    expect(updates[0]).toMatchObject({ last_breach_at: now.toISOString() });
  });

  it("stays eligible while still in grace", async () => {
    const breachAt = new Date("2026-05-01T00:00:00.000Z");
    const now = new Date(breachAt.getTime() + (VENICE_BOOST_GRACE_HOURS - 1) * 3600 * 1000);
    const { db } = makeDb(existingRow({ currently_eligible: true, last_breach_at: breachAt.toISOString() }));
    const res = await evaluateAndRecordVeniceComputeBoost({
      userId: "user_1",
      vvvBalanceRaw: 100n * E18,
      vvvPriceUsd: PRICE_ONE,
      now,
      db,
    });
    expect(res).toMatchObject({ eligible: true, transition: "unchanged", inGrace: true });
  });

  it("expires the boost once grace lapses while still below", async () => {
    const breachAt = new Date("2026-05-01T00:00:00.000Z");
    const now = new Date(breachAt.getTime() + (VENICE_BOOST_GRACE_HOURS + 1) * 3600 * 1000);
    const { db, updates } = makeDb(existingRow({ currently_eligible: true, last_breach_at: breachAt.toISOString() }));
    const res = await evaluateAndRecordVeniceComputeBoost({
      userId: "user_1",
      vvvBalanceRaw: 100n * E18,
      vvvPriceUsd: PRICE_ONE,
      now,
      db,
    });
    expect(res).toMatchObject({ eligible: false, transition: "expired" });
    expect(updates[0]).toMatchObject({ currently_eligible: false, last_breach_at: null });
  });

  it("recovers within grace when the holding returns above threshold", async () => {
    const breachAt = new Date("2026-05-01T00:00:00.000Z");
    const now = new Date(breachAt.getTime() + 3600 * 1000);
    const { db, updates } = makeDb(existingRow({ currently_eligible: true, last_breach_at: breachAt.toISOString() }));
    const res = await evaluateAndRecordVeniceComputeBoost({
      userId: "user_1",
      vvvBalanceRaw: 250n * E18,
      vvvPriceUsd: PRICE_ONE,
      now,
      db,
    });
    expect(res).toMatchObject({ eligible: true, transition: "grace_recovered" });
    expect(updates[0]).toMatchObject({ currently_eligible: true, last_breach_at: null });
  });

  it("re-qualifies a previously-expired holder who tops back up", async () => {
    const { db, updates } = makeDb(existingRow({ currently_eligible: false, last_breach_at: null }));
    const res = await evaluateAndRecordVeniceComputeBoost({
      userId: "user_1",
      vvvBalanceRaw: 250n * E18,
      vvvPriceUsd: PRICE_ONE,
      db,
    });
    expect(res).toMatchObject({ eligible: true, transition: "re_qualified" });
    expect(updates[0]).toMatchObject({ currently_eligible: true });
  });
});
