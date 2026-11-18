jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));
jest.mock("@/lib/logger", () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import { addMonthsClamped, allowancePeriodKey, earnsAllowance, grantAllowanceForRow } from "../plan-ai-allowance";

const row = {
  user_id: "user_1",
  stripe_subscription_id: "sub_1",
  status: "active",
  plan_ladder: "2026-11",
  ai_allowance_micro_usd: 5_000_000,
  current_period_start: "2026-01-31T10:00:00Z",
};

describe("plan AI allowance months", () => {
  it("adds months the way Stripe bills, clamping to the month's end", () => {
    expect(addMonthsClamped(new Date("2026-01-31T10:00:00Z"), 1).toISOString()).toBe("2026-02-28T10:00:00.000Z");
    expect(addMonthsClamped(new Date("2026-01-31T10:00:00Z"), 2).toISOString()).toBe("2026-03-31T10:00:00.000Z");
    expect(addMonthsClamped(new Date("2026-11-15T00:00:00Z"), 2).toISOString()).toBe("2027-01-15T00:00:00.000Z");
  });

  it("gives a yearly period twelve monthly keys", () => {
    const yearly = { ...row, current_period_start: "2026-11-17T12:00:00Z" };
    const keys = new Set<string>();
    for (let day = 0; day < 365; day += 1) {
      const now = new Date(Date.parse("2026-11-17T12:00:00Z") + day * 86_400_000);
      keys.add(allowancePeriodKey(yearly, now)!);
    }
    expect(keys.size).toBe(12);
    expect(allowancePeriodKey(yearly, new Date("2026-12-17T11:59:59Z"))).toBe("sub_1:2026-11-17");
    expect(allowancePeriodKey(yearly, new Date("2026-12-17T12:00:00Z"))).toBe("sub_1:2026-12-17");
  });

  it("has no period before the start or without one", () => {
    expect(allowancePeriodKey(row, new Date("2026-01-01T00:00:00Z"))).toBeNull();
    expect(allowancePeriodKey({ ...row, current_period_start: null }, new Date())).toBeNull();
  });

  it("pays only active ladder plans with an allowance", () => {
    expect(earnsAllowance(row)).toBe(true);
    expect(earnsAllowance({ ...row, plan_ladder: null })).toBe(false);
    expect(earnsAllowance({ ...row, status: "past_due" })).toBe(false);
    expect(earnsAllowance({ ...row, ai_allowance_micro_usd: 0 })).toBe(false);
  });

  it("calls the grant function with the month's key", async () => {
    const rpc = jest.fn().mockResolvedValue({ data: { granted: true, amountMicroUsd: 5_000_000, expiredMicroUsd: 0 }, error: null });
    const outcome = await grantAllowanceForRow(row, new Date("2026-03-01T00:00:00Z"), rpc);
    expect(rpc).toHaveBeenCalledWith("grant_plan_ai_allowance", {
      p_user_id: "user_1",
      p_period_key: "sub_1:2026-02-28",
      p_amount_micro_usd: 5_000_000,
      p_now: "2026-03-01T00:00:00.000Z",
    });
    expect(outcome).toMatchObject({ status: "granted", amountMicroUsd: 5_000_000 });
  });
});
