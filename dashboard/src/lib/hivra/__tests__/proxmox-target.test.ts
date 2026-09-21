import {
  resolveHivraClaudeCodeProxmoxHost,
  resolveHivraNetworkConfig,
  resolveHivraProxmoxHost,
  resolveHivraVmidEnd,
} from "../proxmox-target";

describe("Hivra Proxmox target resolution", () => {
  it("does not pin Claude Code to a dedicated host unless ops configures one", () => {
    expect(resolveHivraClaudeCodeProxmoxHost({})).toBeNull();
  });

  it("honors the explicit Claude Code host override", () => {
    expect(resolveHivraClaudeCodeProxmoxHost({
      HIVRA_CLAUDE_CODE_PROXMOX_HOST: " fixturenode10 ",
    })).toBe("fixturenode10");
  });

  it.each(["auto", "any", "rotation", "none", "disabled", "off", "0", "false"])(
    "treats %s as allocator placement for Claude Code",
    (value) => {
      expect(resolveHivraClaudeCodeProxmoxHost({
        HIVRA_CLAUDE_CODE_PROXMOX_HOST: value,
      })).toBeNull();
    },
  );

  it("keeps the general Hivra host fallback separate from Claude Code's dedicated override", () => {
    expect(resolveHivraProxmoxHost(null, {})).toBe("local");
  });

  it("requires portable network configuration instead of a managed-fleet default", () => {
    expect(() => resolveHivraNetworkConfig("local", {})).toThrow(
      "missing PROXMOX_PRIVATE_SUBNET_PREFIX or PROXMOX_PRIVATE_GATEWAY"
    );
    expect(resolveHivraNetworkConfig("local", {
      PROXMOX_PRIVATE_SUBNET_PREFIX: "10.254.0",
      PROXMOX_PRIVATE_GATEWAY: "10.254.0.1",
    })).toEqual({ subnetPrefix: "10.254.0", gateway: "10.254.0.1" });
  });

  it("derives the default Hivra VMID range from the tenant capacity cap", () => {
    expect(resolveHivraVmidEnd({}, 200)).toBe(239);
    expect(resolveHivraVmidEnd({}, 1090)).toBe(1129);
  });

  it("lets explicit Hivra VMID range configuration override the default cap", () => {
    expect(resolveHivraVmidEnd({ PROXMOX_VMID_END: "1095" }, 1090)).toBe(1095);
    expect(resolveHivraVmidEnd({ HERMES_PROXMOX_MAX_TENANT_INSTANCES: "6" }, 1090)).toBe(1095);
  });
});
