import {
  YEARLY_LIVE_STATUSES,
  pickEntitledYearlySubscription,
  yearlyTierPlanKey,
  type YearlyEntitlementRow,
} from "@/lib/billing/yearly-entitlement";

function row(
  id: string,
  tier: YearlyEntitlementRow["tier"],
  paid_at: string,
  expires_at: string
): YearlyEntitlementRow & { id: string } {
  return { id, tier, paid_at, expires_at };
}

describe("pickEntitledYearlySubscription", () => {
  it("returns null when there is no live row", () => {
    expect(pickEntitledYearlySubscription([])).toBeNull();
  });

  it("ranks Power above a newer Pro payment", () => {
    const power = row("power", "power", "2026-03-01T00:00:00Z", "2027-03-01T00:00:00Z");
    const pro = row("pro", "pro", "2026-09-01T00:00:00Z", "2027-09-01T00:00:00Z");

    expect(pickEntitledYearlySubscription([pro, power])?.id).toBe("power");
    expect(pickEntitledYearlySubscription([power, pro])?.id).toBe("power");
  });

  it("prefers the later expiry within a tier", () => {
    const later = row("later", "pro", "2026-01-01T00:00:00Z", "2027-06-01T00:00:00Z");
    const earlier = row("earlier", "pro", "2026-02-01T00:00:00Z", "2027-02-01T00:00:00Z");

    expect(pickEntitledYearlySubscription([earlier, later])?.id).toBe("later");
  });

  it("breaks an expiry tie on the later payment", () => {
    const first = row("first", "power", "2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z");
    const second = row("second", "power", "2026-01-02T00:00:00Z", "2027-01-01T00:00:00Z");

    expect(pickEntitledYearlySubscription([second, first])?.id).toBe("second");
  });

  it("ignores a row with an unknown tier", () => {
    const unknown = { ...row("unknown", "pro", "2026-01-01T00:00:00Z", "2028-01-01T00:00:00Z"), tier: "ultra" };

    expect(
      pickEntitledYearlySubscription([unknown as unknown as YearlyEntitlementRow])
    ).toBeNull();
  });
});

describe("yearly entitlement constants", () => {
  it("treats only active and grace rows as live", () => {
    expect([...YEARLY_LIVE_STATUSES]).toEqual(["active", "grace"]);
  });

  it("maps Power to fleet and Pro to operator compute", () => {
    expect(yearlyTierPlanKey("power")).toBe("fleet");
    expect(yearlyTierPlanKey("pro")).toBe("operator");
  });
});
