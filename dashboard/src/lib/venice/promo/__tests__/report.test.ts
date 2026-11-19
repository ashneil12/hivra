import { shapePromoReport, type GrantStat, type WindowStats } from "../report";
import { summarizePromoReport } from "../report-summary";
import type { PromoCampaign } from "../core";
import * as service from "../service";

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));
jest.mock("@/lib/logger", () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

const M = 1_000_000;
const campaign = (id: string, slug: string, budget: number, max: number): PromoCampaign => ({
  id, slug, kind: "launch_credit", code: null, enabled: true, startsAt: null, endsAt: null, grantCutoffAt: null,
  budgetMicroUsd: budget, perUserCapMicroUsd: 10 * M, bonusBps: null, maxGrants: max, grantExpiryDays: 30,
});
const grant = (over: Partial<GrantStat>): GrantStat => ({
  grantId: "g", campaignId: "c1", userId: "u", amountMicroUsd: 10 * M, status: "active",
  grantedAt: "2026-11-25T00:00:00Z", expiresAt: "2026-12-25T00:00:00Z", expiredMicroUsd: 0, spentMicroUsd: 0,
  active7: null, active30: null, toppedUpAfter: false, ...over,
});
const windowStats: WindowStats = {
  modelSpend: [{ model: "m", requests: 3, chargedMicroUsd: 5 * M, veniceCostMicroUsd: 4 * M, promoUserRequests: 1, promoUserChargedMicroUsd: M }],
  creditsModeLaunchUsers: 4,
  creditsModeLaunches: 5,
};

describe("shapePromoReport", () => {
  const report = shapePromoReport({
    now: new Date("2026-12-04T00:00:00Z"),
    from: new Date("2026-11-27T00:00:00Z"),
    to: new Date("2026-12-04T00:00:00Z"),
    campaigns: [campaign("c1", "launch", 700 * M, 70), campaign("c2", "topup", 200 * M, 20)],
    grants: [
      grant({ grantId: "a", userId: "u1", spentMicroUsd: 4 * M, active7: true, active30: null, toppedUpAfter: true, grantedAt: "2026-11-28T00:00:00Z" }),
      grant({ grantId: "b", userId: "u2", status: "expired", spentMicroUsd: 1 * M, expiredMicroUsd: 9 * M, active7: false, active30: false }),
      grant({ grantId: "c", userId: "u1", campaignId: "c2", amountMicroUsd: 5 * M }),
    ],
    windowStats,
  });

  it("totals per campaign and computes budget left", () => {
    expect(report.campaigns[0]).toMatchObject({
      slug: "launch", grants: 2, grantsInWindow: 1, grantedMicroUsd: 20 * M, spentMicroUsd: 5 * M,
      expiredMicroUsd: 9 * M, budgetLeftMicroUsd: 680 * M, grantsLeft: 68,
    });
    expect(report.campaigns[1]).toMatchObject({ grants: 1, grantedMicroUsd: 5 * M, budgetLeftMicroUsd: 195 * M });
  });

  it("counts distinct promo users and retention against grants old enough to check", () => {
    expect(report.promoUsers).toEqual({
      total: 2,
      active7: { eligible: 2, active: 1 },
      active30: { eligible: 1, active: 0 },
      paidTopupAfterGrant: 1,
    });
    expect(report.creditsModeLaunchUsers).toBe(4);
    expect(report.spendByModel).toHaveLength(1);
    expect(Object.keys(report.definitions)).toContain("active");
  });

  it("summarizes for ops_events", () => {
    const text = summarizePromoReport(report);
    expect(text).toContain("launch: 2 grants (1 this week), granted $20.00");
    expect(text).toContain("Active after 7d: 1/2");
  });
});

describe("flag off", () => {
  it("never touches the database", async () => {
    delete process.env.HIVRA_VENICE_PROMO_ENABLED;
    const db = { from: jest.fn(), rpc: jest.fn() };
    await service.tryGrantLaunchCredit({ userId: "u" }, db);
    await service.tryGrantTopupBonus({ userId: "u", sessionId: "s", amountMicroUsd: 1 }, db);
    expect(db.from).not.toHaveBeenCalled();
    expect(db.rpc).not.toHaveBeenCalled();
  });
});
