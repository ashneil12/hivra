import {
  doSessionActionFor,
  folderRecoveryEligible,
  isForcePowerAction,
  isGvisorAction,
  isPreparedAction,
  isProxmoxAction,
  isWindowsOnMyServer,
  privateNetworkReason,
  providerRefusalFor,
  restorePointSupport,
  runtimeUpdateRefusal,
  type LifecycleSupportRow,
} from "../lifecycle-support";

// The shared predicates behind the lifecycle routes and Manage. The route
// refactor moved these out of inline checks; these tests pin the same answers.

describe("action lists", () => {
  it("maps DigitalOcean Start, Stop and Delete to resume, pause and delete", () => {
    expect(["start", "stop", "delete", "restart", "resize", "toString"].map(doSessionActionFor)).toEqual(["resume", "pause", "delete", null, null, null]);
  });

  it("keeps each kind's accepted actions", () => {
    expect(["start", "stop", "resize", "delete", "restart", "snapshot"].filter(isGvisorAction)).toEqual(["start", "stop", "resize", "delete"]);
    expect(["start", "stop", "restart", "resize", "update_runtime"].filter(isPreparedAction)).toEqual(["start", "stop", "restart"]);
    expect(["stop", "start", "restart", "update_runtime", "resize", "snapshot", "restore", "rename", "delete"].filter(isProxmoxAction))
      .toEqual(["stop", "start", "restart", "update_runtime", "resize", "snapshot", "restore"]);
  });

  it("accepts Force off and Force restart on Proxmox and prepared computers only", () => {
    const force = ["force_stop", "force_restart"];
    expect(force.filter(isProxmoxAction)).toEqual(force);
    expect(force.filter(isPreparedAction)).toEqual(force);
    expect(force.filter(isGvisorAction)).toEqual([]);
    expect(force.map(doSessionActionFor)).toEqual([null, null]);
    expect(force.filter(isForcePowerAction)).toEqual(force);
    expect(["stop", "restart", "force"].filter(isForcePowerAction)).toEqual([]);
    expect(providerRefusalFor("force_stop")).toMatch(/use your provider's console to force it off/i);
    expect(providerRefusalFor("force_restart")).toMatch(/use your provider's console to force it off/i);
  });

  it("refuses My cloud actions with the route's exact messages", () => {
    expect(providerRefusalFor("resize")).toBe("Resizing an allocated Hetzner computer is not supported yet. Its original size and data are retained.");
    expect(providerRefusalFor("snapshot")).toBe(providerRefusalFor("restore"));
    expect(providerRefusalFor("update_runtime")).toMatch(/not supported yet/);
    expect(providerRefusalFor("stop")).toBeNull();
    expect(providerRefusalFor("constructor")).toBeNull();
  });
});

const ubuntu: LifecycleSupportRow = {
  type: "linux-desktop", computer_profile: "ubuntu-desktop", computer_substrate: "proxmox-kvm", deployment_mode: "hivra-managed",
  infrastructure_binding_token_enforced: true, status: "running", desired_state: "running", operation_id: null, operation_kind: null,
  vmid: 1113, ip: "10.250.20.63",
};

// The inline predicate private access used before the split, kept here to prove
// the shared one answers the same for every combination.
const IPV4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
function previousIsCompatible(agent: LifecycleSupportRow): boolean {
  return agent.type === "linux-desktop"
    && (agent.computer_profile == null || agent.computer_profile === "ubuntu-desktop")
    && agent.computer_substrate === "proxmox-kvm"
    && agent.infrastructure_binding_token_enforced === true
    && agent.status === "running" && agent.desired_state === "running"
    && agent.operation_id == null && agent.operation_kind == null
    && Number.isSafeInteger(agent.vmid) && Number(agent.vmid) >= 100
    && typeof agent.ip === "string" && IPV4.test(agent.ip);
}

describe("private network", () => {
  const variations: Array<Partial<LifecycleSupportRow>> = [
    {}, { type: "codex" }, { computer_profile: null }, { computer_profile: "windows" }, { computer_substrate: "provider-vm" },
    { infrastructure_binding_token_enforced: false }, { infrastructure_binding_token_enforced: "true" }, { status: "stopped" },
    { desired_state: "stopped" }, { operation_id: "op" }, { operation_kind: "private_access" }, { vmid: 99 }, { vmid: null },
    { ip: null }, { ip: "not-an-ip" }, { status: "provisioning", operation_id: "op", operation_kind: "provision" },
  ];
  it.each(variations)("agrees with the previous eligibility rule for %j", (change) => {
    const row = { ...ubuntu, ...change };
    expect(privateNetworkReason(row) === null).toBe(previousIsCompatible(row));
  });

  it("says why, telling what never changes apart from what clears", () => {
    expect(privateNetworkReason({ ...ubuntu, type: "codex" })).toBe("not_eligible");
    expect(privateNetworkReason({ ...ubuntu, infrastructure_binding_token_enforced: false })).toBe("not_bound");
    expect(privateNetworkReason({ ...ubuntu, status: "provisioning", operation_id: "op" })).toBe("operation_in_progress");
    expect(privateNetworkReason({ ...ubuntu, status: "stopped", desired_state: "stopped" })).toBe("not_running");
    expect(privateNetworkReason({ ...ubuntu, ip: null })).toBe("not_ready");
    expect(privateNetworkReason(ubuntu)).toBeNull();
  });
});

describe("restore points, folder recovery and the in-place update", () => {
  it("offers restore points only on owner-bound Proxmox computers that aren't prepared", () => {
    expect(restorePointSupport(ubuntu)).toEqual({ supported: true });
    expect(restorePointSupport({ ...ubuntu, infrastructure_binding_token_enforced: false })).toEqual({ supported: false, code: "not_bound" });
    expect(restorePointSupport({ ...ubuntu, computer_profile: "omarchy" })).toEqual({ supported: false, code: "prepared" });
    expect(restorePointSupport({ ...ubuntu, computer_substrate: "provider-vm" })).toEqual({ supported: false, code: "not_proxmox" });
    expect(restorePointSupport({ ...ubuntu, computer_substrate: null })).toEqual({ supported: false, code: "not_proxmox" });
  });

  it("keeps folder recovery to enrolled Ubuntu desktops with an address", () => {
    expect(folderRecoveryEligible(ubuntu)).toBe(true);
    expect(folderRecoveryEligible({ ...ubuntu, computer_profile: null })).toBe(false);
    expect(folderRecoveryEligible({ ...ubuntu, ip: null })).toBe(false);
    expect(folderRecoveryEligible({ ...ubuntu, infrastructure_binding_token_enforced: false })).toBe(false);
  });

  it("refuses the in-place update in the route's order", () => {
    expect(runtimeUpdateRefusal({ ...ubuntu, type: "codex" })).toBeNull();
    expect(runtimeUpdateRefusal({ ...ubuntu, type: "deepseek-harness" })).toBe("deepseek");
    // A DeepSeek computer in the owner's own cloud gets the DeepSeek refusal first, as the route answers.
    expect(runtimeUpdateRefusal({ ...ubuntu, type: "deepseek-harness", computer_substrate: "provider-vm" })).toBe("deepseek");
    expect(runtimeUpdateRefusal({ ...ubuntu, computer_profile: "windows" })).toBe("prepared");
    expect(runtimeUpdateRefusal({ ...ubuntu, computer_substrate: "provider-vm" })).toBe("my-cloud");
    expect(runtimeUpdateRefusal({ ...ubuntu, computer_substrate: "gvisor" })).toBe("linux-sandbox");
    expect(runtimeUpdateRefusal({ ...ubuntu, computer_substrate: "do-managed-session" })).toBe("digitalocean");
  });

  it("tells a Windows computer on the owner's server from a prepared one", () => {
    expect(isWindowsOnMyServer({ ...ubuntu, computer_profile: "windows", deployment_mode: "self-managed" })).toBe(true);
    expect(isWindowsOnMyServer({ ...ubuntu, computer_profile: "windows" })).toBe(false);
    expect(isWindowsOnMyServer({ ...ubuntu, computer_profile: "omarchy", deployment_mode: "self-managed" })).toBe(false);
  });
});
