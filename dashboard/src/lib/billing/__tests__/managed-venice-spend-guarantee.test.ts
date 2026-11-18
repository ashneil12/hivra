jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));
jest.mock("@/lib/ops-events", () => ({ reportOpsEvent: jest.fn(() => Promise.resolve(null)) }));
jest.mock("@/lib/billing/managed-venice-wallets", () => ({ refundManagedVeniceOvercharge: jest.fn() }));

import { guaranteeCredits, previousUtcDay, runSpendGuarantee, spendGuaranteeMode } from "../managed-venice-spend-guarantee";

function fakeDb(usage: Array<Record<string, unknown>>, keys: Array<Record<string, unknown>>) {
  const make = (rows: Array<Record<string, unknown>>) => {
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "gte", "lt", "not", "order", "in"]) chain[m] = () => chain;
    chain.range = async (from: number, to: number) => ({ data: rows.slice(from, to + 1), error: null });
    chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: rows, error: null });
    return chain;
  };
  return { from: (name: string) => make(name === "managed_venice_usage_events" ? usage : keys) };
}

const NOW = () => new Date("2026-11-18T00:40:00Z");
const ON = { MANAGED_VENICE_SPEND_GUARANTEE: "on", MANAGED_VENICE_AGENT_SPEND_CAPS_ENABLED: "true" };

describe("spend guarantee", () => {
  it("is off by default and needs per-agent limits on", async () => {
    expect(spendGuaranteeMode({})).toBe("off");
    expect(await runSpendGuarantee({ env: {} })).toMatchObject({ skipped: true, reason: "flag_off" });
    expect(await runSpendGuarantee({ env: { MANAGED_VENICE_SPEND_GUARANTEE: "on" }, db: fakeDb([], []) })).toMatchObject({ skipped: true, reason: "limits_off" });
  });

  it("looks at the UTC day just ended", () => {
    expect(previousUtcDay(NOW())).toEqual({ start: "2026-11-17T00:00:00.000Z", end: "2026-11-18T00:00:00.000Z", day: "2026-11-17" });
  });

  it("credits only what went over the limit", () => {
    const spend = new Map([["k1", { userId: "u", charged: 5_400_000 }], ["k2", { userId: "u", charged: 900_000 }], ["k3", { userId: "u", charged: 9_000_000 }]]);
    expect(guaranteeCredits(spend, new Map([["k1", 5_000_000], ["k2", 1_000_000]]))).toEqual([
      { keyId: "k1", userId: "u", capMicroUsd: 5_000_000, chargedMicroUsd: 5_400_000, creditMicroUsd: 400_000 },
    ]);
  });

  it("pays the difference once per key and day, and holds large ones for review", async () => {
    const refund = jest.fn(async () => ({ event: {}, alreadyRefunded: false }));
    const db = fakeDb(
      [
        { user_id: "u1", proxy_key_id: "k1", charged_micro_usd: 3_000_000 },
        { user_id: "u1", proxy_key_id: "k1", charged_micro_usd: 2_500_000 },
        { user_id: "u2", proxy_key_id: "k2", charged_micro_usd: 90_000_000 },
      ],
      [
        { id: "k1", metadata: { spendCap: { dailyMicroUsd: 5_000_000 } } },
        { id: "k2", metadata: { spendCap: { dailyMicroUsd: 1_000_000 } } },
      ],
    );
    const summary = await runSpendGuarantee({ env: ON, db, now: NOW, refund: refund as never });
    expect(summary).toMatchObject({ keysOver: 2, credited: 1, creditedMicroUsd: 500_000, heldForReview: 1, errors: 0, day: "2026-11-17" });
    expect(refund).toHaveBeenCalledWith(expect.objectContaining({
      userId: "u1", amountMicroUsd: 500_000, referenceId: "spend_guarantee:k1:2026-11-17",
    }), db);
  });

  it("only reports in dry mode", async () => {
    const refund = jest.fn();
    const db = fakeDb([{ user_id: "u1", proxy_key_id: "k1", charged_micro_usd: 6_000_000 }], [{ id: "k1", metadata: { spendCap: { dailyMicroUsd: 5_000_000 } } }]);
    const summary = await runSpendGuarantee({ env: { ...ON, MANAGED_VENICE_SPEND_GUARANTEE: "dry" }, db, now: NOW, refund: refund as never });
    expect(summary.plan).toEqual([{ keyId: "k1", creditMicroUsd: 1_000_000 }]);
    expect(refund).not.toHaveBeenCalled();
  });
});
