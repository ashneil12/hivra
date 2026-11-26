import {
  DEFAULT_PROXMOX_CPU_OVERCOMMIT_RATIO,
  placementSkipsDeepSleep,
  proxmoxPlacementRpcPolicy,
  resolveHostCpuOvercommitRatio,
  resolveProxmoxCpuOvercommitRatio,
} from "../placement-policy";

describe("Proxmox placement policy", () => {
  it("uses the shared CPU-overcommit default and rejects invalid fleet values", () => {
    expect(resolveProxmoxCpuOvercommitRatio({})).toBe(DEFAULT_PROXMOX_CPU_OVERCOMMIT_RATIO);
    expect(resolveProxmoxCpuOvercommitRatio({ HERMES_PROXMOX_CPU_OVERCOMMIT_RATIO: "2.5" })).toBe(2.5);
    expect(resolveProxmoxCpuOvercommitRatio({ HERMES_PROXMOX_CPU_OVERCOMMIT_RATIO: "0.5" })).toBe(
      DEFAULT_PROXMOX_CPU_OVERCOMMIT_RATIO,
    );
    expect(resolveProxmoxCpuOvercommitRatio({ HERMES_PROXMOX_CPU_OVERCOMMIT_RATIO: "junk" })).toBe(
      DEFAULT_PROXMOX_CPU_OVERCOMMIT_RATIO,
    );
  });

  it("keeps valid host CPU-overcommit overrides authoritative", () => {
    expect(resolveHostCpuOvercommitRatio(1.5, 5)).toBe(1.5);
    expect(resolveHostCpuOvercommitRatio("2", 5)).toBe(2);
    expect(resolveHostCpuOvercommitRatio(0, 5)).toBe(5);
    expect(resolveHostCpuOvercommitRatio(21, 5)).toBe(5);
    expect(resolveHostCpuOvercommitRatio(null, 5)).toBe(5);
  });

  it("parses the deep-sleep switch and emits the exact RPC policy arguments", () => {
    expect(placementSkipsDeepSleep({})).toBe(false);
    expect(placementSkipsDeepSleep({ HIVRA_PLACEMENT_SKIP_DEEP_SLEEP: "true" })).toBe(true);
    expect(placementSkipsDeepSleep({ HIVRA_PLACEMENT_SKIP_DEEP_SLEEP: " ON " })).toBe(true);
    expect(proxmoxPlacementRpcPolicy({
      HERMES_PROXMOX_CPU_OVERCOMMIT_RATIO: "2.5",
      HIVRA_PLACEMENT_SKIP_DEEP_SLEEP: "1",
    })).toEqual({ p_cpu_overcommit_ratio: 2.5, p_skip_sleep: true });
  });
});
