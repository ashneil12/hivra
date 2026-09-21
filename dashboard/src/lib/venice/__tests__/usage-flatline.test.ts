import {
  evaluateManagedVeniceUsage,
  MIN_BASELINE_DAILY_EVENTS,
} from "@/lib/venice/usage-flatline";

describe("evaluateManagedVeniceUsage", () => {
  it("pages on the actual Jun-2026 cliff: thousands/day collapsing to a handful", () => {
    // The real shape: ~3,000/day for the prior week, then 6 in the last 24h.
    const result = evaluateManagedVeniceUsage({
      recent24hEvents: 6,
      baselineWindowEvents: 3000 * 7,
      baselineWindowDays: 7,
    });
    expect(result.flatline).toBe(true);
    expect(result.baselineDailyAvg).toBe(3000);
  });

  it("stays SILENT on a legitimately idle-but-flat fleet (no false positive post-churn)", () => {
    // Today's post-cliff state: usage already floored, so there is no baseline to
    // collapse FROM. Must not page just because usage is low.
    const result = evaluateManagedVeniceUsage({
      recent24hEvents: 0,
      baselineWindowEvents: 40, // ~6/day over the week
      baselineWindowDays: 7,
    });
    expect(result.flatline).toBe(false);
  });

  it("stays silent while usage is healthy", () => {
    const result = evaluateManagedVeniceUsage({
      recent24hEvents: 2500,
      baselineWindowEvents: 3000 * 7,
      baselineWindowDays: 7,
    });
    expect(result.flatline).toBe(false);
  });

  it("does not page on an ordinary diurnal/weekend dip (well above the 10% floor)", () => {
    const result = evaluateManagedVeniceUsage({
      recent24hEvents: 1200, // 40% of a 3000/day baseline
      baselineWindowEvents: 3000 * 7,
      baselineWindowDays: 7,
    });
    expect(result.flatline).toBe(false);
  });

  it("requires a MEANINGFUL baseline before it will call anything a collapse", () => {
    // Right at the floor: a baseline below MIN_BASELINE_DAILY_EVENTS never pages,
    // even at zero recent usage.
    const justBelow = evaluateManagedVeniceUsage({
      recent24hEvents: 0,
      baselineWindowEvents: (MIN_BASELINE_DAILY_EVENTS - 1) * 7,
      baselineWindowDays: 7,
    });
    expect(justBelow.flatline).toBe(false);

    const atFloor = evaluateManagedVeniceUsage({
      recent24hEvents: 0,
      baselineWindowEvents: MIN_BASELINE_DAILY_EVENTS * 7,
      baselineWindowDays: 7,
    });
    expect(atFloor.flatline).toBe(true);
  });

  it("guards against a zero-day baseline window (no divide-by-zero)", () => {
    const result = evaluateManagedVeniceUsage({
      recent24hEvents: 0,
      baselineWindowEvents: 0,
      baselineWindowDays: 0,
    });
    expect(result.flatline).toBe(false);
    expect(Number.isFinite(result.baselineDailyAvg)).toBe(true);
  });
});
