import {
  DEFAULT_AGENT_DEPLOYMENT_DESTINATION,
  parseAgentDeploymentDestination,
  targetSupportsCatalogRuntime,
  targetSupportsLaunchModelSettings,
} from "../agent-placement";
import type { ProxmoxDeploymentTargetDto } from "@/lib/infrastructure/contracts";
import {
  PORTABLE_HIVRA_PROVIDER_VM_PROVISIONER_VERSION,
  PORTABLE_HIVRA_PROVISIONER_VERSION,
  PORTABLE_HIVRA_RUNTIME_COMPATIBILITY,
} from "@/lib/infrastructure/portable-provisioner-contract";
import { providerVmTarget } from "@/lib/infrastructure/__tests__/provider-vm-target.fixtures";

function targetWithRuntimeEvidence(
  supportedCatalogRuntimeIds: Array<"claude-code" | "codex" | "aeon" | "openclaw" | "agent-zero" | "deepseek-harness" | "linux-desktop">,
): ProxmoxDeploymentTargetDto {
  const now = "2026-08-26T12:00:00.000Z";
  return {
    id: "22222222-2222-4222-8222-222222222222",
    connectionId: "11111111-1111-4111-8111-111111111111",
    evidenceConnectionRevision: 7,
    externalId: "pve-01",
    displayName: "Personal Proxmox / pve-01",
    status: "ready",
    capacity: {
      cpu: { totalCores: 8, utilizationRatio: 0.2 },
      memoryBytes: { total: 16_000, available: 12_000 },
      storageBytes: { total: 100_000, available: 80_000 },
    },
    capabilities: {
      proxmoxVersion: "pve-manager/8.4.1",
      launchReady: true,
      directRootAccess: true,
      kvmAvailable: true,
      bridges: ["hivra0"],
      selectedBridge: "hivra0",
      storages: ["local-lvm"],
      selectedStorage: "local-lvm",
      template: null,
      provisioner: {
        configured: true,
        ready: true,
        version: PORTABLE_HIVRA_PROVISIONER_VERSION,
      },
      runtimeCompatibility: {
        contractVersion: 1,
        provisionerVersion: PORTABLE_HIVRA_PROVISIONER_VERSION,
        supportedCatalogRuntimeIds,
      },
      vmidRange: { start: 200, end: 399, freeCount: 200, firstAvailable: 200 },
      issues: [],
    },
    supportedIsolationDrivers: ["proxmox-kvm"],
    isolationClass: "hardware-vm",
    lastPreflightAt: now,
    lastErrorCode: null,
    createdAt: now,
    updatedAt: now,
  };
}

describe("agent deployment destination", () => {
  it("does not use Proxmox compatibility to authorize a provider VM", () => {
    const provider = providerVmTarget();
    provider.capabilities.provisioner.ready = true;
    provider.capabilities.runtimeCompatibility = targetWithRuntimeEvidence(["codex"]).capabilities.runtimeCompatibility;
    expect(targetSupportsCatalogRuntime(provider, "codex")).toBe(false);
  });
  it("requires every launch client to choose its deployment authority", () => {
    expect(parseAgentDeploymentDestination(undefined)).toBeNull();
    expect(parseAgentDeploymentDestination(null)).toBeNull();
    expect(parseAgentDeploymentDestination(DEFAULT_AGENT_DEPLOYMENT_DESTINATION)).toEqual({
      mode: "hivra-managed",
    });
  });

  it("accepts an exact owner-selected target binding", () => {
    expect(
      parseAgentDeploymentDestination({
        mode: "self-managed",
        connectionId: "11111111-1111-4111-8111-111111111111",
        targetId: "22222222-2222-4222-8222-222222222222",
        expectedConnectionRevision: 7,
      }),
    ).toEqual({
      mode: "self-managed",
      connectionId: "11111111-1111-4111-8111-111111111111",
      targetId: "22222222-2222-4222-8222-222222222222",
      expectedConnectionRevision: 7,
    });
  });

  it.each([
    { mode: "self-managed" },
    {
      mode: "self-managed",
      connectionId: "not-a-uuid",
      targetId: "22222222-2222-4222-8222-222222222222",
      expectedConnectionRevision: 1,
    },
    {
      mode: "self-managed",
      connectionId: "11111111-1111-4111-8111-111111111111",
      targetId: "22222222-2222-4222-8222-222222222222",
      expectedConnectionRevision: 0,
    },
    { mode: "hivra-managed", targetId: "22222222-2222-4222-8222-222222222222" },
  ])("rejects an incomplete or ambiguous binding %#", (input) => {
    expect(parseAgentDeploymentDestination(input)).toBeNull();
  });
});

describe("self-managed runtime placement", () => {
  it("requires a model-capable bundle and actual Codex adapter without narrowing native runtime support", () => {
    const target = targetWithRuntimeEvidence(["codex", "claude-code"]);
    expect(targetSupportsLaunchModelSettings(target, "codex")).toBe(true);
    expect(targetSupportsLaunchModelSettings(target, "claude-code")).toBe(false);
    expect(targetSupportsCatalogRuntime(target, "claude-code")).toBe(true);
    target.capabilities.provisioner!.version = "2026.08.28.1";
    target.capabilities.runtimeCompatibility!.provisionerVersion = "2026.08.28.1";
    expect(targetSupportsCatalogRuntime(target, "codex")).toBe(true);
    expect(targetSupportsLaunchModelSettings(target, "codex")).toBe(false);
    expect(targetSupportsLaunchModelSettings(null, "codex")).toBe(false);
  });
  it("keeps exact compatible predecessor evidence, but never mixes installed and advertised releases",()=>{
    const target=targetWithRuntimeEvidence(["codex"]);
    target.capabilities.provisioner!.version="2026.08.26.10";
    expect(targetSupportsCatalogRuntime(target,"codex")).toBe(false);
    target.capabilities.runtimeCompatibility!.provisionerVersion="2026.08.26.10";
    expect(targetSupportsCatalogRuntime(target,"codex")).toBe(true);
    target.capabilities.provisioner!.ready=false;
    expect(targetSupportsCatalogRuntime(target,"codex")).toBe(false);
  });
  it("accepts a selected runtime named by matching versioned target evidence", () => {
    expect(targetSupportsCatalogRuntime(targetWithRuntimeEvidence(["codex"]), "codex"))
      .toBe(true);
    expect(targetSupportsCatalogRuntime(targetWithRuntimeEvidence(["linux-desktop"]), "linux-desktop"))
      .toBe(true);
  });

  it("does not let old Proxmox or provider-VM bundles inherit Linux desktop support", () => {
    const oldProxmox = targetWithRuntimeEvidence(["linux-desktop"]);
    oldProxmox.capabilities.provisioner!.version = "2026.09.01.9";
    oldProxmox.capabilities.runtimeCompatibility!.provisionerVersion = "2026.09.01.9";
    expect(targetSupportsCatalogRuntime(oldProxmox, "linux-desktop")).toBe(false);

    const provider = providerVmTarget();
    provider.status = "ready";
    provider.lastErrorCode = null;
    provider.capabilities.launchReady = true;
    provider.capabilities.provisioner.ready = true;
    provider.capabilities.provisioner.version = "2026.09.05.6";
    expect(targetSupportsCatalogRuntime(provider, "linux-desktop")).toBe(false);
  });
  it("admits only the current provider Ubuntu bundle for a fresh launch",()=>{
    const provider=providerVmTarget();provider.status="ready";provider.lastErrorCode=null;
    provider.capabilities.launchReady=true;provider.capabilities.provisioner.ready=true;
    provider.capabilities.provisioner.version="2026.09.05.7";
    expect(targetSupportsCatalogRuntime(provider,"linux-desktop")).toBe(false);
    provider.capabilities.provisioner.version="2026.09.05.8";
    expect(targetSupportsCatalogRuntime(provider,"linux-desktop")).toBe(false);
    provider.capabilities.provisioner.version=PORTABLE_HIVRA_PROVIDER_VM_PROVISIONER_VERSION;
    expect(targetSupportsCatalogRuntime(provider,"linux-desktop")).toBe(true);
    expect(targetSupportsCatalogRuntime(provider,"omarchy")).toBe(false);
    expect(targetSupportsCatalogRuntime(provider,"windows")).toBe(false);
    provider.capabilities.launchReady=false;
    expect(targetSupportsCatalogRuntime(provider,"linux-desktop")).toBe(false);
  });

  it("rejects a selected runtime omitted by otherwise valid target evidence", () => {
    expect(
      targetSupportsCatalogRuntime(
        targetWithRuntimeEvidence(["claude-code"]),
        "codex",
      ),
    ).toBe(false);
  });

  it("requires the distinct signed current Windows installer capability", () => {
    const current = targetWithRuntimeEvidence(["linux-desktop"]);
    current.capabilities.runtimeCompatibility = { ...PORTABLE_HIVRA_RUNTIME_COMPATIBILITY };
    expect(targetSupportsCatalogRuntime(current, "windows-installer")).toBe(true);
    expect(targetSupportsCatalogRuntime(current, "linux-desktop")).toBe(true);

    const unsigned = targetWithRuntimeEvidence(["linux-desktop"]);
    expect(targetSupportsCatalogRuntime(unsigned, "windows-installer")).toBe(false);

    const predecessor = targetWithRuntimeEvidence(["linux-desktop"]);
    predecessor.capabilities.provisioner!.version = "2026.09.08.3";
    predecessor.capabilities.runtimeCompatibility = {
      ...PORTABLE_HIVRA_RUNTIME_COMPATIBILITY,
      provisionerVersion: "2026.09.08.3",
    };
    expect(targetSupportsCatalogRuntime(predecessor, "windows-installer")).toBe(false);
  });

  it("rejects matching target evidence from an older provisioner contract", () => {
    const current = targetWithRuntimeEvidence(["codex"]);
    const older: ProxmoxDeploymentTargetDto = {
      ...current,
      capabilities: {
        ...current.capabilities,
        provisioner: {
          ...current.capabilities.provisioner!,
          version: "2026.08.26.4",
        },
        runtimeCompatibility: {
          ...current.capabilities.runtimeCompatibility!,
          provisionerVersion: "2026.08.26.4",
        },
      },
    };

    expect(targetSupportsCatalogRuntime(older, "codex")).toBe(false);
  });

  it("rejects legacy target evidence with no compatibility record", () => {
    const legacy = targetWithRuntimeEvidence(["codex"]);
    delete (legacy.capabilities as Partial<typeof legacy.capabilities>)
      .runtimeCompatibility;

    expect(targetSupportsCatalogRuntime(legacy, "codex")).toBe(false);
  });
});
