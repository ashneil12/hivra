import {
  BYTES_PER_GB,
  DEFAULT_INSTANCE_DISK_GB,
  computeStorageUsage,
  storageLevelRank,
} from "@/lib/storage-usage";

describe("computeStorageUsage", () => {
  const provisioned = 30 * BYTES_PER_GB;

  it("reports ok below the 80% warn threshold", () => {
    const usage = computeStorageUsage(0.79 * provisioned, provisioned);
    expect(usage.level).toBe("ok");
    expect(usage.percent).toBeCloseTo(79, 5);
  });

  it("flips to warn exactly at 80%", () => {
    const usage = computeStorageUsage(0.8 * provisioned, provisioned);
    expect(usage.level).toBe("warn");
    expect(usage.percent).toBeCloseTo(80, 5);
  });

  it("stays warn just below 95%", () => {
    const usage = computeStorageUsage(0.949 * provisioned, provisioned);
    expect(usage.level).toBe("warn");
  });

  it("escalates to critical at 95%", () => {
    const usage = computeStorageUsage(0.95 * provisioned, provisioned);
    expect(usage.level).toBe("critical");
    expect(usage.percent).toBeCloseTo(95, 5);
  });

  it("clamps the user-facing percent to 100 past 100% but keeps rawPercent + critical level", () => {
    const usage = computeStorageUsage(1.1 * provisioned, provisioned);
    // User sees a sane, capped percent...
    expect(usage.percent).toBe(100);
    // ...while the unclamped ratio is preserved for telemetry...
    expect(usage.rawPercent).toBeCloseTo(110, 5);
    // ...and the level still reads critical (computed from the clamped percent).
    expect(usage.level).toBe("critical");
  });

  it("clamps percent at exactly 100 when usage equals provisioned", () => {
    const usage = computeStorageUsage(provisioned, provisioned);
    expect(usage.percent).toBe(100);
    expect(usage.rawPercent).toBeCloseTo(100, 5);
    expect(usage.level).toBe("critical");
  });

  it("leaves rawPercent below 100 untouched (no clamping until over)", () => {
    const usage = computeStorageUsage(0.5 * provisioned, provisioned);
    expect(usage.percent).toBeCloseTo(50, 5);
    expect(usage.rawPercent).toBeCloseTo(50, 5);
  });

  it("treats unknown/zero provisioned size as 0% (no banner)", () => {
    const usage = computeStorageUsage(5 * BYTES_PER_GB, 0);
    expect(usage.percent).toBe(0);
    expect(usage.rawPercent).toBe(0);
    expect(usage.level).toBe("ok");
    expect(usage.provisionedBytes).toBe(0);
  });

  it("collapses non-finite or negative inputs to zero", () => {
    const usage = computeStorageUsage(Number.NaN, -5);
    expect(usage.usedBytes).toBe(0);
    expect(usage.provisionedBytes).toBe(0);
    expect(usage.level).toBe("ok");
  });

  it("uses the default disk size constant for a 30GB instance", () => {
    expect(DEFAULT_INSTANCE_DISK_GB).toBe(30);
    const usage = computeStorageUsage(
      29 * BYTES_PER_GB,
      DEFAULT_INSTANCE_DISK_GB * BYTES_PER_GB
    );
    expect(usage.level).toBe("critical");
  });
});

describe("storageLevelRank", () => {
  it("orders ok < warn < critical", () => {
    expect(storageLevelRank("ok")).toBe(0);
    expect(storageLevelRank("warn")).toBe(1);
    expect(storageLevelRank("critical")).toBe(2);
  });
});
