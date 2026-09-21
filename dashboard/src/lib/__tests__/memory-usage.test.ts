import {
  BYTES_PER_MB,
  MEMORY_WARN_PERCENT,
  MEMORY_CRITICAL_PERCENT,
  computeMemoryUsage,
  memoryLevelRank,
} from "@/lib/memory-usage";

describe("computeMemoryUsage", () => {
  const baseline = 4096 * BYTES_PER_MB; // operator baseline (4 GB)

  it("reports ok below the 80% warn threshold", () => {
    const usage = computeMemoryUsage(0.79 * baseline, baseline);
    expect(usage.level).toBe("ok");
    expect(usage.percent).toBeCloseTo(79, 5);
  });

  it("flips to warn exactly at 80%", () => {
    const usage = computeMemoryUsage(0.8 * baseline, baseline);
    expect(usage.level).toBe("warn");
    expect(usage.percent).toBeCloseTo(80, 5);
  });

  it("stays warn just below 100%", () => {
    const usage = computeMemoryUsage(0.999 * baseline, baseline);
    expect(usage.level).toBe("warn");
  });

  it("escalates to critical at the guaranteed baseline (100%)", () => {
    const usage = computeMemoryUsage(baseline, baseline);
    expect(usage.level).toBe("critical");
    expect(usage.percent).toBeCloseTo(100, 5);
  });

  it("reports critical past 100% without clamping the percent (burst headroom)", () => {
    const usage = computeMemoryUsage(1.5 * baseline, baseline);
    expect(usage.level).toBe("critical");
    expect(usage.percent).toBeGreaterThan(100);
  });

  it("treats unknown/zero baseline as 0% (no banner)", () => {
    const usage = computeMemoryUsage(2048 * BYTES_PER_MB, 0);
    expect(usage.percent).toBe(0);
    expect(usage.level).toBe("ok");
    expect(usage.baselineBytes).toBe(0);
  });

  it("collapses non-finite or negative inputs to zero", () => {
    const usage = computeMemoryUsage(Number.NaN, -5);
    expect(usage.peakBytes).toBe(0);
    expect(usage.baselineBytes).toBe(0);
    expect(usage.level).toBe("ok");
  });

  it("flags a free agent maxing its pinned 1 GB", () => {
    const free = 1024 * BYTES_PER_MB;
    const usage = computeMemoryUsage(1.02 * free, free);
    expect(usage.level).toBe("critical");
  });

  it("exposes the documented thresholds", () => {
    expect(MEMORY_WARN_PERCENT).toBe(80);
    expect(MEMORY_CRITICAL_PERCENT).toBe(100);
  });
});

describe("memoryLevelRank", () => {
  it("orders ok < warn < critical", () => {
    expect(memoryLevelRank("ok")).toBe(0);
    expect(memoryLevelRank("warn")).toBe(1);
    expect(memoryLevelRank("critical")).toBe(2);
  });
});
