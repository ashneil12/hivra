import { computeUsageSharePreview, type UsageShareUsageRow } from "../usage-share";

function usage(userId: string, agentType: string, activeHours: number, extra: Partial<UsageShareUsageRow> = {}): UsageShareUsageRow {
  return {
    userId, agentType, activeHours, agents: 1, inferenceRequests: 0,
    inferenceChargedMicroUsd: 0, inferenceCostMicroUsd: 0, runEvents: 0, ...extra,
  };
}

const noCosts = { feePercent: 0, feeFixedMinor: 0, serverCostMinor: 0 };

describe("computeUsageSharePreview", () => {
  it("splits each paying person's part between the agents they used, by hours", () => {
    const preview = computeUsageSharePreview(
      [{ userId: "a", priceMinor: 999 }, { userId: "b", priceMinor: 4900 }],
      [usage("a", "hermes", 30), usage("a", "openclaw", 10), usage("b", "hermes", 10)],
      { ...noCosts, sharePercent: 10 },
    );

    expect(preview.revenueMinor).toBe(5899);
    expect(preview.poolMinor).toBe(590);
    // a: 99.9 of the pool, three quarters to Hermes. b: 490, all to Hermes.
    expect(preview.byType.map((row) => [row.agentType, row.shareMinor])).toEqual([["hermes", 565], ["openclaw", 25]]);
    expect(preview.assignedMinor).toBe(590);
    expect(preview.unassignedMinor).toBe(0);
    expect(preview.totalActiveHours).toBe(50);
    expect(preview.byType[0]).toMatchObject({ people: 2, payingPeople: 2, activeHours: 40, hoursShare: 0.8 });
  });

  it("takes payment fees and servers off before sharing", () => {
    const preview = computeUsageSharePreview(
      [{ userId: "a", priceMinor: 999 }, { userId: "b", priceMinor: 4900 }],
      [usage("a", "hermes", 1), usage("b", "hermes", 1)],
      { sharePercent: 20, feePercent: 2.9, feeFixedMinor: 30, serverCostMinor: 1000 },
    );

    expect(preview.feesMinor).toBe(231); // 5899 x 2.9% + 2 x 30
    expect(preview.serverCostMinor).toBe(1000);
    expect(preview.netMinor).toBe(4668);
    expect(preview.poolMinor).toBe(934);
    expect(preview.byType[0].shareMinor).toBe(934);
  });

  it("takes the app store's cut, not the card fee, from people who pay there", () => {
    const preview = computeUsageSharePreview(
      [{ userId: "card", priceMinor: 1000 }, { userId: "store", priceMinor: 1000, viaAppStore: true }],
      [usage("card", "hermes", 1), usage("store", "hermes", 1)],
      { sharePercent: 100, feePercent: 3, feeFixedMinor: 30, appStoreFeePercent: 30, serverCostMinor: 0 },
    );

    expect(preview.appStorePeople).toBe(1);
    expect(preview.feesMinor).toBe(60 + 300);
    expect(preview.netMinor).toBe(1640);

    const sameFee = computeUsageSharePreview(
      [{ userId: "store", priceMinor: 1000, viaAppStore: true }],
      [],
      { sharePercent: 0, feePercent: 3, feeFixedMinor: 30, serverCostMinor: 0 },
    );
    expect(sameFee.feesMinor).toBe(60);
  });

  it("leaves a paying person's part unassigned when they have no measured use", () => {
    const preview = computeUsageSharePreview(
      [{ userId: "a", priceMinor: 1000 }, { userId: "quiet", priceMinor: 1000 }],
      [usage("a", "hermes", 5)],
      { ...noCosts, sharePercent: 50 },
    );

    expect(preview.payingPeople).toBe(2);
    expect(preview.payingPeopleWithUsage).toBe(1);
    expect(preview.poolMinor).toBe(1000);
    expect(preview.assignedMinor).toBe(500);
    expect(preview.unassignedMinor).toBe(500);
  });

  it("counts the hours of people who do not pay, but gives them no part", () => {
    const preview = computeUsageSharePreview(
      [{ userId: "a", priceMinor: 1000 }, { userId: "comped", priceMinor: 0 }],
      [usage("a", "hermes", 1), usage("comped", "codex", 99), usage("stranger", "codex", 1)],
      { ...noCosts, sharePercent: 100 },
    );

    const codex = preview.byType.find((row) => row.agentType === "codex");
    expect(preview.payingPeople).toBe(1);
    expect(codex).toMatchObject({ activeHours: 100, people: 2, payingPeople: 0, shareMinor: 0 });
    expect(preview.byType[0]).toMatchObject({ agentType: "hermes", shareMinor: 1000 });
  });

  it("shares nothing when the month loses money or no share is set", () => {
    const loss = computeUsageSharePreview(
      [{ userId: "a", priceMinor: 999 }],
      [usage("a", "hermes", 10)],
      { sharePercent: 50, feePercent: 0, feeFixedMinor: 0, serverCostMinor: 5000 },
    );
    expect(loss.netMinor).toBe(-4001);
    expect(loss.poolMinor).toBe(0);
    expect(loss.byType[0].shareMinor).toBe(0);

    const noShare = computeUsageSharePreview([{ userId: "a", priceMinor: 999 }], [usage("a", "hermes", 10)], { ...noCosts, sharePercent: 0 });
    expect(noShare.poolMinor).toBe(0);
    expect(noShare.unassignedMinor).toBe(0);
  });

  it("counts a person once at their highest price and ignores bad numbers", () => {
    const preview = computeUsageSharePreview(
      [{ userId: "a", priceMinor: 999 }, { userId: "a", priceMinor: 1999 }, { userId: "b", priceMinor: Number.NaN }],
      [usage("a", "hermes", Number.NaN), usage("a", "hermes", -3), usage("a", "openclaw", 2, { inferenceRequests: 7, inferenceChargedMicroUsd: 500, inferenceCostMicroUsd: 200 })],
      { sharePercent: 250, feePercent: -5, feeFixedMinor: Number.POSITIVE_INFINITY, serverCostMinor: -1 },
    );

    expect(preview.payingPeople).toBe(1);
    expect(preview.revenueMinor).toBe(1999);
    expect(preview.feesMinor).toBe(0);
    expect(preview.poolMinor).toBe(1999); // share is capped at 100%
    expect(preview.byType[0]).toMatchObject({ agentType: "openclaw", shareMinor: 1999, inferenceRequests: 7, inferenceChargedMicroUsd: 500, inferenceCostMicroUsd: 200 });
  });
});
