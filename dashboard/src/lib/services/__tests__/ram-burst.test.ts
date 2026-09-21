import {
  RAM_BURST_ENABLED_ENV,
  RAM_BURST_MULTIPLIER_ENV,
  RAM_BURST_CAP_MB_ENV,
  RAM_BURST_MIN_BASELINE_MB,
  isRamBurstEnabled,
  resolveRamBurst,
} from "@/lib/services/ram-burst";

const ON = { [RAM_BURST_ENABLED_ENV]: "true" } as Record<string, string | undefined>;

describe("isRamBurstEnabled", () => {
  it("is off by default and on only for the literal 'true'", () => {
    expect(isRamBurstEnabled({})).toBe(false);
    expect(isRamBurstEnabled({ [RAM_BURST_ENABLED_ENV]: "1" })).toBe(false);
    expect(isRamBurstEnabled({ [RAM_BURST_ENABLED_ENV]: "false" })).toBe(false);
    expect(isRamBurstEnabled({ [RAM_BURST_ENABLED_ENV]: "TRUE" })).toBe(true);
    expect(isRamBurstEnabled({ [RAM_BURST_ENABLED_ENV]: " true " })).toBe(true);
  });
});

describe("resolveRamBurst", () => {
  it("disabled → ceiling == baseline, no burst (legacy pinned)", () => {
    const plan = resolveRamBurst(4096, {});
    expect(plan).toEqual({ baselineMb: 4096, ceilingMb: 4096, burstActive: false });
  });

  it("honors a bounded per-computer ceiling without the fleet feature flag", () => {
    expect(resolveRamBurst(3072, {}, 4096)).toEqual({
      baselineMb: 3072,
      ceilingMb: 4096,
      burstActive: true,
    });
    expect(resolveRamBurst(4096, {}, 2048)).toEqual({
      baselineMb: 4096,
      ceilingMb: 4096,
      burstActive: false,
    });
  });

  it("enabled but free/starter baseline stays pinned (no $0 overcommit)", () => {
    expect(resolveRamBurst(1024, ON)).toEqual({
      baselineMb: 1024,
      ceilingMb: 1024,
      burstActive: false,
    });
    expect(RAM_BURST_MIN_BASELINE_MB).toBe(1024);
  });

  it("enabled + paid baseline → 2x ceiling by default", () => {
    expect(resolveRamBurst(4096, ON)).toEqual({
      baselineMb: 4096,
      ceilingMb: 8192,
      burstActive: true,
    });
    expect(resolveRamBurst(8192, ON)).toEqual({
      baselineMb: 8192,
      ceilingMb: 16384,
      burstActive: true,
    });
  });

  it("honors a custom multiplier", () => {
    const plan = resolveRamBurst(4096, { ...ON, [RAM_BURST_MULTIPLIER_ENV]: "3" });
    expect(plan.ceilingMb).toBe(12288);
    expect(plan.burstActive).toBe(true);
  });

  it("clamps the ceiling to the cap", () => {
    const plan = resolveRamBurst(16384, { ...ON, [RAM_BURST_CAP_MB_ENV]: "24576" });
    // 16384 * 2 = 32768, capped to 24576
    expect(plan.ceilingMb).toBe(24576);
    expect(plan.burstActive).toBe(true);
  });

  it("never produces a ceiling below the baseline (cap < baseline is ignored)", () => {
    const plan = resolveRamBurst(8192, { ...ON, [RAM_BURST_CAP_MB_ENV]: "4096" });
    expect(plan.ceilingMb).toBe(8192);
    expect(plan.burstActive).toBe(false);
  });

  it("a multiplier <= 1 yields no burst", () => {
    const plan = resolveRamBurst(4096, { ...ON, [RAM_BURST_MULTIPLIER_ENV]: "1" });
    expect(plan.ceilingMb).toBe(4096);
    expect(plan.burstActive).toBe(false);
  });

  it("collapses junk baselines to the min baseline", () => {
    expect(resolveRamBurst(Number.NaN, ON).baselineMb).toBe(1024);
    expect(resolveRamBurst(-5, ON).baselineMb).toBe(1024);
  });
});
