import { spawnSync } from "node:child_process";

import {
  buildPortableProxmoxPreflightScript,
  isSupportedProxmoxVersion,
  MAX_PROXMOX_PREFLIGHT_OUTPUT_BYTES,
  parsePortableProxmoxPreflightOutput,
  PROXMOX_PREFLIGHT_PROTOCOL,
  ProxmoxPreflightInputError,
  runPortableProxmoxPreflight,
  type PortableProxmoxPreflightInput,
} from "../proxmox-preflight";
import {
  PORTABLE_HIVRA_PROVISIONER_VERSION,
  portableHivraRequiredAssetsForProvisionerDirectory,
} from "../portable-provisioner-contract";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

const preparedInput: PortableProxmoxPreflightInput = {
  node: "pve-user-1",
  bridge: "vmbr0",
  storage: "local-lvm",
  vmidRange: { start: 200, end: 203 },
  preparedTarget: {
    templateVmid: 9000,
    templateExpectedName: "portable-template",
    provisioner: {
      directory: "/opt/hivra/provisioner",
      expectedVersion: "2026.08.25+1",
    },
    requiredAssets: [
      { id: "portable-provisioner", kind: "executable", path: "/opt/hivra/bin/provision" },
    ],
  },
};

const advancedVendoredInput: PortableProxmoxPreflightInput = {
  ...preparedInput,
  preparedTarget: {
    ...preparedInput.preparedTarget,
    provisioner: {
      directory: "/srv/hivra/provisioner",
      expectedVersion: PORTABLE_HIVRA_PROVISIONER_VERSION,
      manifestFile: "BUNDLE.sha256",
    },
    requiredAssets: portableHivraRequiredAssetsForProvisionerDirectory(
      "/srv/hivra/provisioner",
    ),
  },
};

function b64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function healthyMarkers(overrides: Record<string, string> = {}): string {
  const values: Record<string, string> = {
    PROTOCOL: "1",
    TOOL_PVEVERSION: "1",
    TOOL_PVESH: "1",
    TOOL_QM: "1",
    TOOL_PVESM: "1",
    TOOL_IP: "1",
    TOOL_BASE64: "1",
    TOOL_ID: "1",
    EFFECTIVE_UID: "0",
    LOCAL_NODE_B64: b64("pve-user-1"),
    NODE_B64: b64("pve-user-1"),
    NODE_MATCH: "1",
    PVE_VERSION_B64: b64("pve-manager/8.4.1/2a5fa54a8503f96d"),
    NODE_STATUS_B64: b64(JSON.stringify({
      cpu: 0.25,
      maxcpu: 8,
      memory: { total: 32 * GIB, used: 8 * GIB, free: 24 * GIB },
    })),
    NODE_NETWORK_B64: b64(JSON.stringify([{ iface: "vmbr0", type: "bridge" }, { iface: "vmbr1", type: "bridge" }])),
    STORAGE_CONFIG_B64: b64(JSON.stringify([
      { storage: "local", type: "dir", content: "iso,vztmpl,backup" },
      { storage: "local-lvm", type: "lvmthin", content: "images,rootdir" },
    ])),
    STORAGE_STATUS_B64: b64(JSON.stringify([
      { storage: "local", type: "dir", active: 1, enabled: 1, total: 1_000, avail: 400 },
      { storage: "local-lvm", type: "lvmthin", active: 1, enabled: 1, total: 20_000, avail: 15_000 },
    ])),
    VM_RESOURCES_B64: b64(JSON.stringify([
      { vmid: 200, node: "pve-user-1", type: "qemu", template: 0, maxmem: 4 * GIB },
      { vmid: "202", node: "pve-user-1", type: "qemu", template: 0, maxmem: 2 * GIB },
    ])),
    BRIDGES_B64: b64(JSON.stringify([
      { ifname: "vmbr0", flags: ["BROADCAST", "UP", "LOWER_UP"] },
      { ifname: "vmbr1", flags: ["BROADCAST", "UP"] },
    ])),
    KVM_DEVICE: "1",
    CPU_VIRTUALIZATION: "1",
    TEMPLATE_EXISTS: "1",
    TEMPLATE_CONFIG_B64: b64("name: portable-template\ntemplate: 1\n"),
    PROVISIONER_DIRECTORY: "1",
    PROVISIONER_VERSION_B64: b64("2026.08.25+1\n"),
    ASSET_0: "1",
    END: "1",
    ...overrides,
  };
  return [
    "An unrelated login banner is ignored",
    ...Object.entries(values).map(([key, value]) => `${PROXMOX_PREFLIGHT_PROTOCOL}|${key}|${value}`),
  ].join("\n");
}

function advancedVendoredMarkers(overrides: Record<string, string> = {}): string {
  const assetMarkers = Object.fromEntries(
    (advancedVendoredInput.preparedTarget?.requiredAssets ?? []).map((_, index) => [
      `ASSET_${index}`,
      "1",
    ]),
  );
  return healthyMarkers({
    PROVISIONER_VERSION_B64: b64(`${PORTABLE_HIVRA_PROVISIONER_VERSION}\n`),
    PROVISIONER_MANIFEST: "1",
    ...assetMarkers,
    ...overrides,
  });
}

describe("portable Proxmox preflight", () => {
  describe("explicit compatible release admission",()=>{
    const rolling:PortableProxmoxPreflightInput={...advancedVendoredInput,preparedTarget:{...advancedVendoredInput.preparedTarget,
      provisioner:{...advancedVendoredInput.preparedTarget!.provisioner!,compatibleVersions:[PORTABLE_HIVRA_PROVISIONER_VERSION,"2026.08.26.10"]}}};
    it("admits the observed predecessor only with its actual manifest and assets",()=>{
      const old=advancedVendoredMarkers({PROVISIONER_VERSION_B64:b64("2026.08.26.10\n")});
      expect(parsePortableProxmoxPreflightOutput(old,rolling).capabilities.preparedTarget.provisioner)
        .toEqual({configured:true,ready:true,version:"2026.08.26.10"});
      expect(parsePortableProxmoxPreflightOutput(old,advancedVendoredInput).launchReady).toBe(false);
      expect(parsePortableProxmoxPreflightOutput(advancedVendoredMarkers({PROVISIONER_VERSION_B64:b64("2026.08.26.10"),PROVISIONER_MANIFEST:"0"}),rolling).launchReady).toBe(false);
      expect(parsePortableProxmoxPreflightOutput(advancedVendoredMarkers({PROVISIONER_VERSION_B64:b64("2026.08.26.4")}),rolling).launchReady).toBe(false);
      expect(parsePortableProxmoxPreflightOutput(advancedVendoredMarkers({PROVISIONER_VERSION_B64:b64("2026.08.26.10"),ASSET_0:"0"}),rolling).launchReady).toBe(false);
    });
    it.each([[],["2026.08.26.10"],[PORTABLE_HIVRA_PROVISIONER_VERSION,PORTABLE_HIVRA_PROVISIONER_VERSION],
      [PORTABLE_HIVRA_PROVISIONER_VERSION,"*"],[PORTABLE_HIVRA_PROVISIONER_VERSION,"a","b","c","d"]].map(versions=>({versions})))("rejects invalid version policy $versions",({versions})=>{
      expect(()=>buildPortableProxmoxPreflightScript({...rolling,preparedTarget:{...rolling.preparedTarget,
        provisioner:{...rolling.preparedTarget!.provisioner!,compatibleVersions:versions}}})).toThrow(ProxmoxPreflightInputError);
    });
    it("never permits compatible versions without checksum evidence",()=>{
      expect(()=>buildPortableProxmoxPreflightScript({...rolling,preparedTarget:{...rolling.preparedTarget,
        provisioner:{...rolling.preparedTarget!.provisioner!,manifestFile:null}}})).toThrow(ProxmoxPreflightInputError);
    });
  });
  describe("shell construction", () => {
    it("builds a generic, bounded read-only probe", () => {
      const script = buildPortableProxmoxPreflightScript(preparedInput);

      expect(script).toContain('pvesh get "/nodes/$NODE/status" --output-format json');
      expect(script).toContain('pvesh get "/nodes/$NODE/storage" --output-format json');
      expect(script).not.toContain("pvesm status --output-format json");
      expect(script).toContain("ip -json link show type bridge");
      expect(script).toContain("id -u");
      expect(script).toContain("qm config 9000");
      expect(script).toContain("cat '/opt/hivra/provisioner/VERSION'");
      expect(script).toContain("[ -f '/opt/hivra/bin/provision' ] && [ -x '/opt/hivra/bin/provision' ]");
      expect(script).toContain("/dev/kvm");
      expect(script).toContain('QEMU_INVENTORY="$(qm list 2>/dev/null)" || CAPACITY_EVIDENCE=0');
      expect(script).toContain("awk 'NF && !header {header=1; if ($1!=\"VMID\") exit 2; next}");
      expect(script).toContain('status_output="$(qm status "$candidate" 2>/dev/null)" || { CAPACITY_EVIDENCE=0; continue; }');
      expect(script).toContain("cpu=$((cores * sockets))");
      expect(script).toContain('PCT_INVENTORY="$(pct list 2>/dev/null)" || CAPACITY_EVIDENCE=0');

      expect(script).not.toMatch(/\bqm\s+(?:create|set|start|stop|destroy|clone)\b/);
      expect(script).not.toMatch(/\bpvesm\s+(?:alloc|free)\b/);
      expect(script).not.toMatch(/\b(?:apt|apt-get|dnf|yum)\s+(?:install|remove|upgrade)\b/);
      expect(script).not.toContain("caddy");
      expect(script).not.toContain("hermesos.cloud");
      expect(script).not.toContain("/root/hivra-provisioner");
      expect(script.indexOf('if [ "$NODE" != "$LOCAL_NODE" ]')).toBeLessThan(
        script.indexOf('pvesh get "/nodes/$NODE/status"'),
      );

      const syntax = spawnSync("sh", ["-n"], { input: script, encoding: "utf8" });
      expect(syntax.status).toBe(0);
      expect(syntax.stderr).toBe("");
    });

    it("checks the Advanced vendored manifest and every rebased critical asset", () => {
      const script = buildPortableProxmoxPreflightScript(advancedVendoredInput);

      expect(script).toContain(
        "(cd '/srv/hivra/provisioner' && sha256sum -c --status 'BUNDLE.sha256')",
      );
      for (const asset of advancedVendoredInput.preparedTarget?.requiredAssets ?? []) {
        expect(script).toContain(`'${asset.path}'`);
      }
    });

    it.each([
      { ...preparedInput, node: "pve; touch /tmp/pwned" },
      { ...preparedInput, bridge: "vmbr0$(id)" },
      { ...preparedInput, storage: "local lvm" },
      {
        ...preparedInput,
        preparedTarget: {
          requiredAssets: [{ id: "bad", kind: "file" as const, path: "/opt/good;reboot" }],
        },
      },
    ])("rejects unsafe input before constructing a shell", (input) => {
      expect(() => buildPortableProxmoxPreflightScript(input as PortableProxmoxPreflightInput))
        .toThrow(ProxmoxPreflightInputError);
    });

    it("rejects an unbounded VMID range", () => {
      expect(() => buildPortableProxmoxPreflightScript({
        vmidRange: { start: 100, end: 50_000 },
      })).toThrow("vmidRange cannot contain more than 10000 VMIDs");
    });

    it("normalizes saved contract-compatible identifiers and a trailing directory slash", () => {
      const normalized = buildPortableProxmoxPreflightScript({
        node: "n".repeat(64),
        storage: "9storage",
        vmidRange: { start: 200, end: 220 },
        preparedTarget: {
          provisioner: {
            directory: "/opt/hivra/provisioner/",
            expectedVersion: "2026.08.25+1",
          },
        },
      });

      expect(normalized).toContain(`NODE='${"n".repeat(64)}'`);
      expect(normalized).toContain("cat '/opt/hivra/provisioner/VERSION'");
    });
  });

  describe("sanitized report parsing", () => {
    it("reports detected capabilities, capacity, and VMID availability", () => {
      const report = parsePortableProxmoxPreflightOutput(healthyMarkers(), preparedInput);

      expect(report).toEqual(expect.objectContaining({
        provider: "proxmox",
        protocolVersion: 1,
        connectionReady: true,
        launchReady: true,
      }));
      expect(report.node).toEqual({
        id: "pve-user-1",
        proxmoxVersion: "pve-manager/8.4.1/2a5fa54a8503f96d",
      });
      expect(report.capabilities).toEqual(expect.objectContaining({
        directRootAccess: true,
        kvmDevice: true,
        cpuVirtualization: true,
        supportedIsolationDrivers: ["proxmox-kvm"],
        bridges: ["vmbr0", "vmbr1"],
        selectedBridge: "vmbr0",
        selectedStorage: "local-lvm",
      }));
      expect(report.capabilities.preparedTarget).toEqual({
        configured: true,
        ready: true,
        template: { vmid: 9000, exists: true, isTemplate: true, nameMatches: true },
        provisioner: { configured: true, ready: true, version: "2026.08.25+1" },
        assets: [{ id: "portable-provisioner", kind: "executable", available: true }],
      });
      expect(report.capacity).toEqual({
        cpu: { totalCores: 8, utilizationRatio: 0.25 },
        memory: {
          totalBytes: 32 * GIB,
          reportedFreeBytes: 24 * GIB,
          reservedGuestBytes: 6 * GIB,
          hostReserveBytes: 2 * GIB,
          availableBytes: 24 * GIB,
        },
        storage: { id: "local-lvm", totalBytes: 20_000, availableBytes: 15_000 },
        vmids: { start: 200, end: 203, availableCount: 2, firstAvailable: 201 },
      });
      expect(report.unmetRequirements).toEqual([]);

      const serialized = JSON.stringify(report);
      expect(serialized).not.toContain("portable-template");
      expect(serialized).not.toContain("/opt/hivra/bin/provision");
      expect(serialized).not.toContain("login banner");
    });

    it.each([
      {
        evidenceFailure: "an invalid manifest",
        markerOverrides: { PROVISIONER_MANIFEST: "0" } as Record<string, string>,
        expectedCode: "PROXMOX_PROVISIONER_MANIFEST_INVALID",
        provisionerReady: false,
      },
      {
        evidenceFailure: "a missing critical asset",
        markerOverrides: { ASSET_2: "0" } as Record<string, string>,
        expectedCode: "PROXMOX_REQUIRED_ASSET_MISSING",
        provisionerReady: true,
      },
    ])(
      "keeps the exact-version Advanced target unready for $evidenceFailure",
      ({ markerOverrides, expectedCode, provisionerReady }) => {
        const report = parsePortableProxmoxPreflightOutput(
          advancedVendoredMarkers(markerOverrides),
          advancedVendoredInput,
        );

        expect(report.launchReady).toBe(false);
        expect(report.capabilities.preparedTarget.ready).toBe(false);
        expect(report.capabilities.preparedTarget.provisioner).toEqual(
          expect.objectContaining({ ready: provisionerReady }),
        );
        expect(report.unmetRequirements.map((entry) => entry.code)).toContain(expectedCode);
      },
    );

    it("accepts complete exact-version Advanced manifest and asset evidence", () => {
      const report = parsePortableProxmoxPreflightOutput(
        advancedVendoredMarkers(),
        advancedVendoredInput,
      );

      expect(report.launchReady).toBe(true);
      expect(report.capabilities.preparedTarget.ready).toBe(true);
      expect(report.capabilities.preparedTarget.provisioner).toEqual({
        configured: true,
        ready: true,
        version: PORTABLE_HIVRA_PROVISIONER_VERSION,
      });
      expect(report.capabilities.preparedTarget.assets.every((asset) => asset.available))
        .toBe(true);
      expect(report.unmetRequirements).toEqual([]);
    });

    it("auto-selects VM-capable storage and a bridge in simple mode", () => {
      const output = healthyMarkers()
        .split("\n")
        .filter((line) => !/\|(TEMPLATE_EXISTS|TEMPLATE_CONFIG_B64|PROVISIONER_DIRECTORY|PROVISIONER_VERSION_B64|ASSET_0)\|/.test(line))
        .join("\n");
      const report = parsePortableProxmoxPreflightOutput(output, {
        vmidRange: { start: 200, end: 203 },
      });

      expect(report.connectionReady).toBe(true);
      expect(report.launchReady).toBe(false);
      expect(report.capabilities.selectedStorage).toBe("local-lvm");
      expect(report.capabilities.selectedBridge).toBe("vmbr0");
      expect(report.capabilities.preparedTarget.configured).toBe(false);
      expect(report.unmetRequirements.map((entry) => entry.code)).toContain(
        "PROXMOX_PREPARED_TARGET_UNSPECIFIED",
      );
    });

    it("blocks unsupported Proxmox releases with a reachable stable code", () => {
      expect(isSupportedProxmoxVersion("pve-manager/8.4.1/build")).toBe(true);
      expect(isSupportedProxmoxVersion("pve-manager/9.0.2/build")).toBe(true);
      expect(isSupportedProxmoxVersion("pve-manager/1.0/build")).toBe(false);

      const report = parsePortableProxmoxPreflightOutput(healthyMarkers({
        PVE_VERSION_B64: b64("pve-manager/1.0/build"),
      }), preparedInput);

      expect(report.connectionReady).toBe(false);
      expect(report.launchReady).toBe(false);
      expect(report.unmetRequirements.map((entry) => entry.code)).toContain(
        "PROXMOX_VERSION_UNSUPPORTED",
      );
    });

    it("requires effective UID 0 for connection and launch readiness", () => {
      const report = parsePortableProxmoxPreflightOutput(healthyMarkers({
        EFFECTIVE_UID: "1000",
      }), preparedInput);

      expect(report.connectionReady).toBe(false);
      expect(report.launchReady).toBe(false);
      expect(report.capabilities.directRootAccess).toBe(false);
      expect(report.unmetRequirements.map((entry) => entry.code)).toContain(
        "PROXMOX_ROOT_PERMISSION_REQUIRED",
      );
    });

    it("requires the selected Advanced node to be the local SSH node", () => {
      const report = parsePortableProxmoxPreflightOutput(healthyMarkers({
        LOCAL_NODE_B64: b64("pve-user-1"),
        NODE_B64: b64("pve-user-2"),
        NODE_MATCH: "0",
      }), { ...preparedInput, node: "pve-user-2" });

      expect(report.connectionReady).toBe(false);
      expect(report.launchReady).toBe(false);
      expect(report.capabilities.supportedIsolationDrivers).toEqual([]);
      expect(report.unmetRequirements.map((entry) => entry.code)).toContain(
        "PROXMOX_NODE_MISMATCH",
      );
    });

    it("validates the configured template name", () => {
      const report = parsePortableProxmoxPreflightOutput(healthyMarkers({
        TEMPLATE_CONFIG_B64: b64("name: another-template\ntemplate: 1\n"),
      }), preparedInput);

      expect(report.launchReady).toBe(false);
      expect(report.capabilities.preparedTarget.template).toEqual({
        vmid: 9000,
        exists: true,
        isTemplate: true,
        nameMatches: false,
      });
      expect(report.unmetRequirements.map((entry) => entry.code)).toContain(
        "PROXMOX_TEMPLATE_NAME_MISMATCH",
      );
    });

    it("never treats provisioner directory presence alone as version evidence", () => {
      const input: PortableProxmoxPreflightInput = {
        vmidRange: { start: 200, end: 203 },
        preparedTarget: {
          provisioner: { directory: "/opt/hivra/provisioner" },
        },
      };
      const output = healthyMarkers()
        .split("\n")
        .filter((line) => !/\|(TEMPLATE_EXISTS|TEMPLATE_CONFIG_B64|ASSET_0)\|/.test(line))
        .join("\n");
      const report = parsePortableProxmoxPreflightOutput(output, input);

      expect(report.launchReady).toBe(false);
      expect(report.capabilities.preparedTarget.provisioner).toEqual({
        configured: true,
        ready: false,
        version: "2026.08.25+1",
      });
      expect(report.unmetRequirements.map((entry) => entry.code)).toContain(
        "PROXMOX_PROVISIONER_VERSION_REQUIRED",
      );
    });

    it("fails closed when storage configuration cannot prove VM image support", () => {
      const report = parsePortableProxmoxPreflightOutput(healthyMarkers({
        STORAGE_CONFIG_B64: b64("permission denied"),
      }), { ...preparedInput, storage: null });

      expect(report.capabilities.storage).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "local-lvm", content: [] }),
      ]));
      expect(report.capabilities.selectedStorage).toBeNull();
      expect(report.launchReady).toBe(false);
      expect(report.unmetRequirements.map((entry) => entry.code)).toContain(
        "PROXMOX_STORAGE_UNAVAILABLE",
      );
    });

    it("ignores transient firewall bridges when selecting Simple placement", () => {
      const report = parsePortableProxmoxPreflightOutput(healthyMarkers({
        NODE_NETWORK_B64: b64(JSON.stringify([{ iface: "vmbr0", type: "bridge" }])),
        BRIDGES_B64: b64(JSON.stringify([
          { ifname: "fwbr200i0", flags: ["UP"] },
          { ifname: "vmbr0", flags: ["UP"] },
        ])),
      }), { ...preparedInput, bridge: null });

      expect(report.capabilities.bridges).toEqual(["vmbr0"]);
      expect(report.capabilities.selectedBridge).toBe("vmbr0");
      expect(report.launchReady).toBe(true);
    });

    it("does not accept a configured but administratively down bridge", () => {
      const report = parsePortableProxmoxPreflightOutput(healthyMarkers({
        NODE_NETWORK_B64: b64(JSON.stringify([{ iface: "vmbr0", type: "bridge" }])),
        BRIDGES_B64: b64(JSON.stringify([{ ifname: "vmbr0", flags: ["BROADCAST"] }])),
      }), { ...preparedInput, bridge: null });

      expect(report.capabilities.bridges).toEqual([]);
      expect(report.capabilities.selectedBridge).toBeNull();
      expect(report.launchReady).toBe(false);
      expect(report.unmetRequirements.map((entry) => entry.code)).toContain(
        "PROXMOX_BRIDGE_UNAVAILABLE",
      );
    });

    it("emits a real capacity issue when CPU utilization cannot be measured", () => {
      const report = parsePortableProxmoxPreflightOutput(healthyMarkers({
        NODE_STATUS_B64: b64(JSON.stringify({
          cpu: 2,
          maxcpu: 8,
          memory: { total: 32 * GIB, used: 8 * GIB, free: 24 * GIB },
        })),
      }), preparedInput);

      expect(report.capacity.cpu).toEqual({ totalCores: 8, utilizationRatio: null });
      expect(report.launchReady).toBe(false);
      expect(report.unmetRequirements.map((entry) => entry.code)).toContain(
        "PROXMOX_CPU_CAPACITY_UNAVAILABLE",
      );
    });

    it("normalizes a nonpositive reported CPU capacity to unavailable evidence", () => {
      const report = parsePortableProxmoxPreflightOutput(healthyMarkers({
        NODE_STATUS_B64: b64(JSON.stringify({
          cpu: 0,
          maxcpu: 0,
          memory: { total: 32 * GIB, used: 8 * GIB, free: 24 * GIB },
        })),
      }), preparedInput);

      expect(report.capacity.cpu).toEqual({ totalCores: null, utilizationRatio: 0 });
      expect(report.launchReady).toBe(false);
      expect(report.unmetRequirements.map((entry) => entry.code)).toContain(
        "PROXMOX_CPU_CAPACITY_UNAVAILABLE",
      );
    });

    it("returns stable requirement codes without exposing raw host data", () => {
      const report = parsePortableProxmoxPreflightOutput(healthyMarkers({
        KVM_DEVICE: "0",
        CPU_VIRTUALIZATION: "0",
        TEMPLATE_EXISTS: "0",
        TEMPLATE_CONFIG_B64: "",
        ASSET_0: "0",
      }), preparedInput);

      expect(report.connectionReady).toBe(true);
      expect(report.launchReady).toBe(false);
      expect(report.capabilities.supportedIsolationDrivers).toEqual([]);
      expect(report.unmetRequirements.map((entry) => entry.code)).toEqual(expect.arrayContaining([
        "PROXMOX_KVM_UNAVAILABLE",
        "PROXMOX_CPU_VIRTUALIZATION_UNAVAILABLE",
        "PROXMOX_TEMPLATE_MISSING",
        "PROXMOX_REQUIRED_ASSET_MISSING",
      ]));
      expect(report.unmetRequirements.find((entry) => entry.code === "PROXMOX_REQUIRED_ASSET_MISSING"))
        .toEqual(expect.objectContaining({ subject: "portable-provisioner" }));
      expect(JSON.stringify(report)).not.toContain("/opt/hivra/bin/provision");
    });

    it("reports an exhausted VMID range", () => {
      const report = parsePortableProxmoxPreflightOutput(healthyMarkers({
        VM_RESOURCES_B64: b64(JSON.stringify([
          { vmid: 200, node: "pve-user-1", type: "qemu", template: 0, maxmem: GIB },
          { vmid: 201, node: "pve-user-1", type: "qemu", template: 0, maxmem: GIB },
          { vmid: 202, node: "pve-user-1", type: "qemu", template: 0, maxmem: GIB },
          { vmid: 203, node: "pve-user-1", type: "qemu", template: 0, maxmem: GIB },
        ])),
      }), preparedInput);

      expect(report.capacity.vmids).toEqual({
        start: 200,
        end: 203,
        availableCount: 0,
        firstAvailable: null,
      });
      expect(report.launchReady).toBe(false);
      expect(report.unmetRequirements.map((entry) => entry.code)).toContain(
        "PROXMOX_VMID_RANGE_EXHAUSTED",
      );
    });

    it("reports zero launch headroom when configured guests overcommit host memory", () => {
      const report = parsePortableProxmoxPreflightOutput(healthyMarkers({
        NODE_STATUS_B64: b64(JSON.stringify({
          cpu: 0.2,
          maxcpu: 24,
          memory: {
            total: 128_738 * MIB,
            used: 4_000 * MIB,
            free: 124_738 * MIB,
          },
        })),
        VM_RESOURCES_B64: b64(JSON.stringify([
          { vmid: 1100, node: "pve-user-1", type: "qemu", template: 0, maxmem: 164_864 * MIB },
        ])),
      }), preparedInput);

      expect(report.capacity.memory).toEqual({
        totalBytes: 128_738 * MIB,
        reportedFreeBytes: 124_738 * MIB,
        reservedGuestBytes: 164_864 * MIB,
        hostReserveBytes: 2 * GIB,
        availableBytes: 0,
      });
      expect(report.launchReady).toBe(false);
      expect(report.unmetRequirements.map((entry) => entry.code)).toContain(
        "PROXMOX_MEMORY_CAPACITY_EXHAUSTED",
      );
    });

    it("counts only this node's QEMU and LXC reservations while keeping cluster VMIDs", () => {
      const report = parsePortableProxmoxPreflightOutput(healthyMarkers({
        VM_RESOURCES_B64: b64(JSON.stringify([
          { vmid: 200, node: "pve-user-1", type: "qemu", template: 0, maxmem: 2 * GIB },
          { vmid: 201, node: "pve-user-1", type: "lxc", template: 0, maxmem: 2 * GIB },
          { vmid: 202, node: "pve-user-1", type: "qemu", template: 1, maxmem: 128 * GIB },
          { vmid: 203, node: "pve-remote", type: "qemu", template: 0, maxmem: 64 * GIB },
          { vmid: 204, node: "pve-remote", type: "lxc", template: 0, maxmem: 64 * GIB },
        ])),
      }), preparedInput);

      expect(report.capacity.memory).toMatchObject({
        reservedGuestBytes: 4 * GIB,
        availableBytes: 24 * GIB,
      });
      expect(report.capacity.vmids).toEqual({
        start: 200,
        end: 203,
        availableCount: 0,
        firstAvailable: null,
      });
    });

    it.each([
      { label: "node identity is missing", row: { vmid: 200, type: "qemu", template: 0, maxmem: GIB } },
      { label: "node identity is invalid", row: { vmid: 200, node: "pve;invalid", type: "qemu", template: 0, maxmem: GIB } },
      { label: "guest type is missing", row: { vmid: 200, node: "pve-user-1", template: 0, maxmem: GIB } },
      { label: "guest type is invalid", row: { vmid: 200, node: "pve-user-1", type: "node", template: 0, maxmem: GIB } },
      { label: "template flag is missing", row: { vmid: 200, node: "pve-user-1", type: "qemu", maxmem: GIB } },
      { label: "template flag is invalid", row: { vmid: 200, node: "pve-user-1", type: "qemu", template: 2, maxmem: GIB } },
    ])("fails memory admission closed when $label", ({ row }) => {
      const report = parsePortableProxmoxPreflightOutput(healthyMarkers({
        VM_RESOURCES_B64: b64(JSON.stringify([row])),
      }), preparedInput);

      expect(report.capacity.memory.reservedGuestBytes).toBeNull();
      expect(report.capacity.memory.availableBytes).toBeNull();
      expect(report.launchReady).toBe(false);
      expect(report.capacity.vmids).toEqual({
        start: 200,
        end: 203,
        availableCount: 3,
        firstAvailable: 201,
      });
      expect(report.unmetRequirements.map((entry) => entry.code)).toContain(
        "PROXMOX_MEMORY_CAPACITY_UNAVAILABLE",
      );
    });

    it.each([
      { label: "is absent", type: "qemu", maxmem: undefined },
      { label: "is numeric zero", type: "qemu", maxmem: 0 },
      { label: "is string zero", type: "lxc", maxmem: "0" },
    ])("fails memory admission closed when a local guest reservation $label", ({ type, maxmem }) => {
      const report = parsePortableProxmoxPreflightOutput(healthyMarkers({
        VM_RESOURCES_B64: b64(JSON.stringify([
          { vmid: 200, node: "pve-user-1", type, template: 0, maxmem },
        ])),
      }), preparedInput);

      expect(report.capacity.memory.reservedGuestBytes).toBeNull();
      expect(report.capacity.memory.availableBytes).toBeNull();
      expect(report.launchReady).toBe(false);
      expect(report.unmetRequirements.map((entry) => entry.code)).toContain(
        "PROXMOX_MEMORY_CAPACITY_UNAVAILABLE",
      );
    });

    it("fails closed when VMID inventory output is unavailable", () => {
      const report = parsePortableProxmoxPreflightOutput(healthyMarkers({
        VM_RESOURCES_B64: b64("truncated-json"),
      }), preparedInput);

      expect(report.capacity.vmids).toEqual({
        start: 200,
        end: 203,
        availableCount: 0,
        firstAvailable: null,
      });
      expect(report.launchReady).toBe(false);
      expect(report.unmetRequirements.map((entry) => entry.code)).toContain(
        "PROXMOX_VMID_INVENTORY_UNAVAILABLE",
      );
    });

    it("rejects duplicate, unknown, and non-canonical encoded markers", () => {
      expect(() => parsePortableProxmoxPreflightOutput(
        `${healthyMarkers()}\n${PROXMOX_PREFLIGHT_PROTOCOL}|END|1`,
        preparedInput,
      )).toThrow("duplicate marker");

      expect(() => parsePortableProxmoxPreflightOutput(
        `${healthyMarkers()}\n${PROXMOX_PREFLIGHT_PROTOCOL}|UNEXPECTED|1`,
        preparedInput,
      )).toThrow("unknown marker");

      expect(() => parsePortableProxmoxPreflightOutput(
        healthyMarkers({ NODE_B64: "not-base64" }),
        preparedInput,
      )).toThrow("canonical base64");
    });

    it("accepts the combined legal field maxima but rejects bytes beyond the aggregate budget", () => {
      const maximal = healthyMarkers({
        LOCAL_NODE_B64: b64("n".repeat(64)),
        NODE_B64: b64("n".repeat(64)),
        PVE_VERSION_B64: b64("pve-manager/8.4.1/".padEnd(512, "x")),
        NODE_STATUS_B64: b64(" ".repeat(65_536)),
        NODE_NETWORK_B64: b64(" ".repeat(65_536)),
        STORAGE_CONFIG_B64: b64(" ".repeat(131_072)),
        STORAGE_STATUS_B64: b64(" ".repeat(131_072)),
        VM_RESOURCES_B64: b64(" ".repeat(256 * 1024)),
        BRIDGES_B64: b64(" ".repeat(65_536)),
        TEMPLATE_CONFIG_B64: b64(" ".repeat(65_536)),
        PROVISIONER_VERSION_B64: b64("v".padEnd(256, " ")),
      });
      expect(Buffer.byteLength(maximal)).toBeLessThanOrEqual(
        MAX_PROXMOX_PREFLIGHT_OUTPUT_BYTES,
      );
      expect(() => parsePortableProxmoxPreflightOutput(maximal, {
        ...preparedInput,
        node: "n".repeat(64),
      })).not.toThrow();

      const overflow = `${maximal}\n${"x".repeat(
        MAX_PROXMOX_PREFLIGHT_OUTPUT_BYTES - Buffer.byteLength(maximal) + 1,
      )}`;
      expect(() => parsePortableProxmoxPreflightOutput(overflow, preparedInput)).toThrow(
        "preflight output exceeded the limit",
      );
    });
  });

  describe("injected execution", () => {
    it("executes through the supplied adapter and returns the parsed report", async () => {
      const executor = jest.fn<Promise<{ ok: boolean; stdout: string }>, [string]>(
        async () => ({ ok: true, stdout: healthyMarkers() }),
      );

      const outcome = await runPortableProxmoxPreflight(preparedInput, executor);

      expect(outcome.ok).toBe(true);
      expect(executor).toHaveBeenCalledTimes(1);
      expect(executor.mock.calls[0][0]).toContain(PROXMOX_PREFLIGHT_PROTOCOL);
      if (outcome.ok) expect(outcome.report.launchReady).toBe(true);
    });

    it("does not invoke the adapter when input validation fails", async () => {
      const executor = jest.fn(async () => ({ ok: true, stdout: "" }));

      const outcome = await runPortableProxmoxPreflight({
        node: "bad;node",
        vmidRange: { start: 200, end: 220 },
      }, executor);

      expect(outcome).toEqual(expect.objectContaining({
        ok: false,
        code: "PROXMOX_PREFLIGHT_INPUT_INVALID",
      }));
      expect(executor).not.toHaveBeenCalled();
    });

    it("returns sanitized execution and protocol failures", async () => {
      const secret = "PRIVATE_KEY_SHOULD_NOT_ESCAPE";
      const thrown = await runPortableProxmoxPreflight(preparedInput, async () => {
        throw new Error(secret);
      });
      const failed = await runPortableProxmoxPreflight(preparedInput, async () => ({
        ok: false,
        stdout: secret,
      }));
      const invalid = await runPortableProxmoxPreflight(preparedInput, async () => ({
        ok: true,
        stdout: secret,
      }));

      expect(thrown).toEqual({
        ok: false,
        code: "PROXMOX_PREFLIGHT_EXECUTION_FAILED",
        message: "The Proxmox preflight could not be executed",
      });
      expect(failed).toEqual({
        ok: false,
        code: "PROXMOX_PREFLIGHT_EXECUTION_FAILED",
        message: "The Proxmox preflight did not complete successfully",
      });
      expect(invalid).toEqual({
        ok: false,
        code: "PROXMOX_PREFLIGHT_OUTPUT_INVALID",
        message: "The Proxmox preflight returned invalid output",
      });
      expect(JSON.stringify([thrown, failed, invalid])).not.toContain(secret);
    });
  });
});
