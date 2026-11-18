import { hivraAgentHoldsCpuAndRam, placementSkipsDeepSleep } from "@/lib/services/instance-service";

describe("placement and deep-sleeping agents", () => {
  it("is off unless HIVRA_PLACEMENT_SKIP_DEEP_SLEEP is set", () => {
    expect(placementSkipsDeepSleep({})).toBe(false);
    expect(placementSkipsDeepSleep({ HIVRA_PLACEMENT_SKIP_DEEP_SLEEP: "0" })).toBe(false);
    expect(placementSkipsDeepSleep({ HIVRA_PLACEMENT_SKIP_DEEP_SLEEP: "1" })).toBe(true);
    expect(placementSkipsDeepSleep({ HIVRA_PLACEMENT_SKIP_DEEP_SLEEP: "on" })).toBe(true);
  });

  it("counts a deep-sleeping running agent only when the switch is off", () => {
    const row = { status: "running", sleep_state: "hibernated" };
    expect(hivraAgentHoldsCpuAndRam(row, false)).toBe(true);
    expect(hivraAgentHoldsCpuAndRam(row, true)).toBe(false);
  });

  it("always counts awake, napping and waking agents", () => {
    for (const sleep_state of ["awake", "napping", "waking", "hibernating", "wake_failed", null]) {
      expect(hivraAgentHoldsCpuAndRam({ status: "running", sleep_state }, true)).toBe(true);
    }
    expect(hivraAgentHoldsCpuAndRam({ status: "provisioning", sleep_state: null }, true)).toBe(true);
  });

  it("never counts stopped agents", () => {
    expect(hivraAgentHoldsCpuAndRam({ status: "stopped", sleep_state: "awake" }, false)).toBe(false);
  });
});

describe("per-host CPU overcommit", () => {
  const { resolveHostCpuOvercommitRatio } = jest.requireActual("@/lib/services/instance-service");
  it("uses the host value when sane, else the fallback", () => {
    expect(resolveHostCpuOvercommitRatio(8, 5)).toBe(8);
    expect(resolveHostCpuOvercommitRatio("8.0", 5)).toBe(8);
    expect(resolveHostCpuOvercommitRatio(null, 5)).toBe(5);
    expect(resolveHostCpuOvercommitRatio(undefined, 5)).toBe(5);
    expect(resolveHostCpuOvercommitRatio(0, 5)).toBe(5);
    expect(resolveHostCpuOvercommitRatio(50, 5)).toBe(5);
  });
});

describe("isServersFullPlacementError", () => {
  // Imported lazily: launch-agent pulls in server-only modules.
  const { isServersFullPlacementError } = jest.requireActual("@/lib/hivra/launch-agent") as typeof import("@/lib/hivra/launch-agent");
  it("is true only when a server was left out for lack of room", () => {
    expect(isServersFullPlacementError({ code: "PROXMOX_NO_PLACEMENT_TARGET", capacityFullHostIds: ["host-a"] })).toBe(true);
    expect(isServersFullPlacementError({ code: "PROXMOX_NO_PLACEMENT_TARGET", capacityFullHostIds: [] })).toBe(false);
    expect(isServersFullPlacementError({ code: "PROXMOX_HOST_NOT_READY" })).toBe(false);
    expect(isServersFullPlacementError(undefined)).toBe(false);
  });
});

describe("measuredFreeDiskGb", () => {
  const { measuredFreeDiskGb, MEASURED_DISK_RESERVE_GB } = jest.requireActual("@/lib/services/instance-service") as typeof import("@/lib/services/instance-service");
  const now = Date.parse("2026-11-18T13:00:00Z");
  const reading = (usedPercent: number, at = "2026-11-18T12:55:00Z") => ({
    v: 1, at, pool: { name: "pool-a", sizeMb: 830 * 1024, usedPercent },
  });

  it("uses the pool's real use up to 85%", () => {
    expect(measuredFreeDiskGb(reading(30), 0, now)).toBeCloseTo(830 * 0.85 - 830 * 0.3, 5);
  });

  it("keeps room for each launch still in progress", () => {
    expect(measuredFreeDiskGb(reading(30), 2, now)).toBeCloseTo(830 * 0.55 - 2 * MEASURED_DISK_RESERVE_GB, 5);
  });

  it("falls back (null) without a fresh reading with a pool", () => {
    expect(measuredFreeDiskGb(reading(30, "2026-11-18T12:30:00Z"), 0, now)).toBeNull();
    expect(measuredFreeDiskGb({ v: 1, at: "2026-11-18T12:55:00Z", pool: null }, 0, now)).toBeNull();
    expect(measuredFreeDiskGb(null, 0, now)).toBeNull();
    expect(measuredFreeDiskGb({ v: 2 }, 0, now)).toBeNull();
  });
});
