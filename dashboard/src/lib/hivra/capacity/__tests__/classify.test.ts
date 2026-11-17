import {
  DEFAULT_CAPACITY_THRESHOLDS,
  classifyHostCapacity,
  hostCapacityAlertsEnabled,
  resolveCapacityThresholds,
  type HostCapacityStats,
} from "../classify";

const stats = (over: Partial<HostCapacityStats> = {}): HostCapacityStats => ({
  memTotalMb: 128_000,
  memAvailableMb: 64_000,
  wakeHeadroomMb: 8192,
  pool: { name: "vg/pool", sizeMb: 1_000_000, usedPercent: 40 },
  committedRamMb: 96_000,
  hibernatedRamMb: 16_384,
  largestHibernatedRamMb: 8192,
  ...over,
});

describe("hostCapacityAlertsEnabled", () => {
  it.each([undefined, "", "off", "1", "true", "canary"])("is off for %p", (value) => {
    expect(hostCapacityAlertsEnabled({ HIVRA_HOST_CAPACITY_ALERTS: value })).toBe(false);
  });
  it("is on only for on", () => {
    expect(hostCapacityAlertsEnabled({ HIVRA_HOST_CAPACITY_ALERTS: " ON " })).toBe(true);
  });
});

describe("resolveCapacityThresholds", () => {
  it("uses the defaults", () => {
    expect(resolveCapacityThresholds({})).toEqual(DEFAULT_CAPACITY_THRESHOLDS);
    expect(DEFAULT_CAPACITY_THRESHOLDS).toMatchObject({ diskWarnPercent: 80, diskCriticalPercent: 90 });
  });
  it("takes overrides", () => {
    expect(resolveCapacityThresholds({
      HIVRA_HOST_CAPACITY_DISK_WARN_PERCENT: "70",
      HIVRA_HOST_CAPACITY_DISK_CRITICAL_PERCENT: "85",
      HIVRA_HOST_CAPACITY_RAM_MARGIN_MB: "4096",
      HIVRA_HOST_CAPACITY_STANDARD_AGENT_RAM_MB: "4096",
    })).toEqual({ diskWarnPercent: 70, diskCriticalPercent: 85, ramMarginMb: 4096, standardAgentRamMb: 4096 });
  });
  it("keeps the defaults for values that are not numbers, out of range, or inverted", () => {
    expect(resolveCapacityThresholds({
      HIVRA_HOST_CAPACITY_DISK_WARN_PERCENT: "95",
      HIVRA_HOST_CAPACITY_DISK_CRITICAL_PERCENT: "90",
      HIVRA_HOST_CAPACITY_RAM_MARGIN_MB: "-1",
      HIVRA_HOST_CAPACITY_STANDARD_AGENT_RAM_MB: "8g",
    })).toEqual(DEFAULT_CAPACITY_THRESHOLDS);
  });
});

describe("classifyHostCapacity", () => {
  it("is ok with room everywhere", () => {
    expect(classifyHostCapacity(stats())).toEqual({
      level: "ok", reasons: [], oversubscriptionRatio: 0.75, canAdmitStandard: true,
    });
  });

  it("warns when available memory is within the margin of the wake headroom", () => {
    const verdict = classifyHostCapacity(stats({ memAvailableMb: 8192 + 2047 }));
    expect(verdict.level).toBe("warn");
    expect(verdict.reasons).toEqual([{ code: "ram_available_low", level: "warn" }]);
    expect(verdict.canAdmitStandard).toBe(false);
  });

  it("is critical when available memory is below the wake headroom", () => {
    const verdict = classifyHostCapacity(stats({ memAvailableMb: 8191, largestHibernatedRamMb: 0 }));
    expect(verdict.level).toBe("critical");
    expect(verdict.reasons).toEqual([{ code: "ram_available_low", level: "critical" }]);
  });

  it("is not low exactly at headroom plus margin", () => {
    expect(classifyHostCapacity(stats({ memAvailableMb: 8192 + 2048 })).reasons).toEqual([]);
  });

  it.each([
    [79.9, "ok"], [80, "warn"], [89.9, "warn"], [90, "critical"], [100, "critical"],
  ])("grades a disk pool at %p%% as %p", (usedPercent, level) => {
    const verdict = classifyHostCapacity(stats({ pool: { name: "vg/pool", sizeMb: 1000, usedPercent } }));
    expect(verdict.level).toBe(level);
    expect(verdict.reasons).toEqual(level === "ok" ? [] : [{ code: "disk_pool_high", level }]);
  });

  it("uses overridden disk thresholds", () => {
    const thresholds = { ...DEFAULT_CAPACITY_THRESHOLDS, diskWarnPercent: 50, diskCriticalPercent: 60 };
    expect(classifyHostCapacity(stats({ pool: { name: "p", sizeMb: 1, usedPercent: 55 } }), thresholds).level).toBe("warn");
    expect(classifyHostCapacity(stats({ pool: { name: "p", sizeMb: 1, usedPercent: 60 } }), thresholds).level).toBe("critical");
  });

  it("ignores the disk when no pool was found", () => {
    expect(classifyHostCapacity(stats({ pool: null })).level).toBe("ok");
  });

  it("is critical when the largest hibernated agent no longer fits", () => {
    const verdict = classifyHostCapacity(stats({ memAvailableMb: 12_000, wakeHeadroomMb: 4096, largestHibernatedRamMb: 16_384 }));
    expect(verdict.level).toBe("critical");
    expect(verdict.reasons).toEqual([{ code: "wake_would_not_fit", level: "critical" }]);
    expect(verdict.canAdmitStandard).toBe(false);
  });

  it("lists every reason and takes the worst level", () => {
    const verdict = classifyHostCapacity(stats({
      memAvailableMb: 9000, pool: { name: "p", sizeMb: 1, usedPercent: 95 }, largestHibernatedRamMb: 16_384,
    }));
    expect(verdict.level).toBe("critical");
    expect(verdict.reasons.map((r) => r.code)).toEqual(["ram_available_low", "disk_pool_high", "wake_would_not_fit"]);
  });

  it("reports oversubscription as a ratio and survives a zero total", () => {
    expect(classifyHostCapacity(stats({ committedRamMb: 192_000 })).oversubscriptionRatio).toBe(1.5);
    expect(classifyHostCapacity(stats({ memTotalMb: 0 })).oversubscriptionRatio).toBe(0);
  });

  it("admits a standard agent only when it fits above the wake headroom", () => {
    expect(classifyHostCapacity(stats({ memAvailableMb: 16_384 })).canAdmitStandard).toBe(true);
    expect(classifyHostCapacity(stats({ memAvailableMb: 16_383 })).canAdmitStandard).toBe(false);
  });
});
