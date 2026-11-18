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
