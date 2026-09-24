import type { PlanInfo } from "@/lib/hivra/agent-api";
import type { DeploymentTargetDto } from "@/lib/infrastructure/contracts";
import {
  PORTABLE_HIVRA_PROVISIONER_VERSION,
  PORTABLE_HIVRA_RUNTIME_COMPATIBILITY,
} from "@/lib/infrastructure/portable-provisioner-contract";

import { PROFILE_DETAILS } from "../contracts";
import {
  capabilitySummary,
  catalogAgentFitSubject,
  cheapestPlanForSize,
  costSummary,
  defaultLaunchName,
  launchChangesSummary,
  launchFit,
  launchNameProblem,
  launchProfileFitSubject,
  launchReturnPath,
  matchingSizePreset,
  parseLaunchDraftParam,
  sizeLabel,
  sizePresets,
  type LaunchFitEvidence,
} from "../launch-plan";
import { validateResourceEnvelope } from "../resource-envelope";

const FREE: PlanInfo = {
  subscribed: false, name: "Free", key: "free", maxAgents: 1,
  maxCpuPerAgent: 0.5, maxRamPerAgent: 1, poolCpu: 0.5, poolRam: 1,
  usage: { agentCount: 0, usedCpu: 0, usedRam: 0 },
};
const PRO: PlanInfo = {
  subscribed: true, name: "Pro", key: "operator", maxAgents: 3,
  maxCpuPerAgent: 2, maxRamPerAgent: 4, poolCpu: 2, poolRam: 4,
  usage: { agentCount: 0, usedCpu: 0, usedRam: 0 },
};

const PROXMOX: DeploymentTargetDto = {
  id: "22222222-2222-4222-8222-222222222222",
  connectionId: "11111111-1111-4111-8111-111111111111",
  evidenceConnectionRevision: 7,
  externalId: "pve-01",
  displayName: "Studio Proxmox / pve-01",
  status: "ready",
  capacity: {
    cpu: { totalCores: 6, utilizationRatio: 0.2 },
    memoryBytes: { total: 16 * 1024 ** 3, available: 8 * 1024 ** 3 },
    storageBytes: { total: 500 * 1024 ** 3, available: 350 * 1024 ** 3 },
  },
  capabilities: {
    proxmoxVersion: "pve-manager/8.4.1",
    launchReady: true,
    directRootAccess: true,
    kvmAvailable: true,
    bridges: ["vmbr1"],
    selectedBridge: "vmbr1",
    storages: ["local-lvm"],
    selectedStorage: "local-lvm",
    template: { vmid: 9000, exists: true, isTemplate: true, nameMatches: true, ready: true },
    provisioner: { configured: true, ready: true, version: PORTABLE_HIVRA_PROVISIONER_VERSION },
    runtimeCompatibility: { ...PORTABLE_HIVRA_RUNTIME_COMPATIBILITY, supportedCatalogRuntimeIds: ["codex", "linux-desktop"] },
    vmidRange: { start: 200, end: 399, freeCount: 180, firstAvailable: 200 },
    issues: [],
  },
  supportedIsolationDrivers: ["proxmox-kvm"],
  isolationClass: "hardware-vm",
  lastPreflightAt: "2026-09-04T12:00:00.000Z",
  lastErrorCode: null,
  createdAt: "2026-09-04T12:00:00.000Z",
  updatedAt: "2026-09-04T12:00:00.000Z",
};

function evidence(plan: PlanInfo | null, targets: DeploymentTargetDto[] = [], overrides: Partial<LaunchFitEvidence> = {}): LaunchFitEvidence {
  return { plan, planChecked: true, targets, targetsLoading: false, selfHosted: false, ...overrides };
}

describe("launchFit", () => {
  it("labels each tile on Free from the same floors the launch gates use", () => {
    const free = evidence(FREE);
    expect(launchFit(launchProfileFitSubject("codex"), free)).toEqual({ label: "Fits Free without a browser", tone: "fits" });
    expect(launchFit(catalogAgentFitSubject("claude-code"), free)).toEqual({ label: "Fits Free without a browser", tone: "fits" });
    expect(launchFit(catalogAgentFitSubject("hermes"), free)).toEqual({ label: "Fits your Free plan", tone: "fits" });
    expect(launchFit(catalogAgentFitSubject("aeon"), free)).toEqual({ label: "Fits your Free plan", tone: "fits" });
    expect(launchFit(catalogAgentFitSubject("openclaw"), free)).toEqual({ label: "Needs Pro or your own server", tone: "needs" });
    expect(launchFit(catalogAgentFitSubject("agent-zero"), free)).toEqual({ label: "Needs Pro or your own server", tone: "needs" });
    expect(launchFit(launchProfileFitSubject("ubuntu-desktop"), free)).toEqual({ label: "Needs Pro or your own server", tone: "needs" });
    expect(launchFit(launchProfileFitSubject("linux-terminal"), free)).toEqual({ label: "Needs your own server", tone: "needs" });
    expect(launchFit(launchProfileFitSubject("windows"), free)).toEqual({ label: "Needs your own server", tone: "needs" });
    expect(launchFit(launchProfileFitSubject("omarchy"), free)).toEqual({ label: "Preview", tone: "neutral" });
  });

  it("includes the browser on a paid plan that holds it", () => {
    expect(launchFit(launchProfileFitSubject("codex"), evidence(PRO))).toEqual({ label: "Fits your Pro plan", tone: "fits" });
    expect(launchFit(launchProfileFitSubject("ubuntu-desktop"), evidence(PRO))).toEqual({ label: "Fits your Pro plan", tone: "fits" });
  });

  it("counts open slots and the pool the owner already uses", () => {
    const fullFree = { ...FREE, usage: { agentCount: 1, usedCpu: 0.5, usedRam: 1 } };
    expect(launchFit(catalogAgentFitSubject("hermes"), evidence(fullFree))).toEqual({ label: "Needs Pro", tone: "needs" });
    expect(launchFit(launchProfileFitSubject("codex"), evidence(fullFree))).toEqual({ label: "Needs Pro or your own server", tone: "needs" });
  });

  it("says a ready server of the owner's holds it when the plan does not", () => {
    expect(launchFit(launchProfileFitSubject("ubuntu-desktop"), evidence(FREE, [PROXMOX]))).toEqual({ label: "Ready on your server", tone: "fits" });
    // Compatibility evidence matters, not just a ready host.
    expect(launchFit(catalogAgentFitSubject("openclaw"), evidence(FREE, [PROXMOX]))).toEqual({ label: "Needs Pro or your own server", tone: "needs" });
    // Too small a host is not ready for it.
    const small = { ...PROXMOX, capacity: { ...PROXMOX.capacity, cpu: { totalCores: 1, utilizationRatio: 0 }, memoryBytes: { total: 4 * 1024 ** 3, available: 2 * 1024 ** 3 } } };
    expect(launchFit(launchProfileFitSubject("ubuntu-desktop"), evidence(FREE, [small]))).toEqual({ label: "Needs Pro or your own server", tone: "needs" });
    // Linux Sandbox needs a gVisor host, not a Proxmox one.
    expect(launchFit(launchProfileFitSubject("linux-terminal"), evidence(FREE, [PROXMOX]))).toEqual({ label: "Needs your own server", tone: "needs" });
  });

  it("shows no badge until the evidence it depends on is known", () => {
    expect(launchFit(launchProfileFitSubject("codex"), evidence(null, [], { planChecked: false }))).toBeNull();
    // A failed plan check is unknown, not Free.
    expect(launchFit(launchProfileFitSubject("codex"), evidence(null))).toBeNull();
    expect(launchFit(launchProfileFitSubject("codex"), evidence({ ...FREE, usage: undefined }))).toBeNull();
    expect(launchFit(launchProfileFitSubject("linux-terminal"), evidence(FREE, [], { targetsLoading: true }))).toBeNull();
    expect(launchFit(launchProfileFitSubject("ubuntu-desktop"), evidence(FREE, [], { targetsLoading: true }))).toBeNull();
  });

  it("judges only connected servers on a self-hosted installation", () => {
    expect(launchFit(launchProfileFitSubject("codex"), evidence(null, [PROXMOX], { selfHosted: true }))).toEqual({ label: "Ready on your server", tone: "fits" });
    expect(launchFit(launchProfileFitSubject("codex"), evidence(null, [], { selfHosted: true }))).toEqual({ label: "Needs a connected server", tone: "needs" });
  });
});

describe("cheapestPlanForSize", () => {
  it("names the first plan on sale whose caps and pool hold the size", () => {
    const size = (cpu: number, ram: number) => ({ reserved: { cpu, ram }, maximum: { cpu, ram }, minPlan: "free" as const, poolExempt: false });
    expect(cheapestPlanForSize(size(1.5, 3), FREE)?.name).toBe("Pro");
    expect(cheapestPlanForSize(size(4, 8), FREE)?.name).toBe("Power");
    expect(cheapestPlanForSize(size(4, 8), PRO)?.name).toBe("Power");
    // Nothing on sale holds 8 CPU per agent.
    expect(cheapestPlanForSize(size(8, 16), FREE)).toBeNull();
    expect(cheapestPlanForSize({ ...size(0.5, 1), minPlan: "pro" }, FREE)?.name).toBe("Pro");
  });
});

describe("size presets", () => {
  it.each([
    ["codex", false],
    ["codex", true],
    ["ubuntu-desktop", false],
    ["linux-terminal", false],
  ] as const)("keeps every %s preset (browser %s) at or above its floor", (profileId, browser) => {
    const options = sizePresets(profileId, { browser });
    expect(options.map(option => option.label)).toEqual(["Small", "Medium", "Large"]);
    for (const option of options) {
      expect(validateResourceEnvelope(profileId, option.resources, { maximumCpu: 8, maximumRam: 16 }, { browser })).toEqual({ ok: true, envelope: option.resources });
      expect(PROFILE_DETAILS[profileId].cpuOptions).toContain(option.resources.cpu);
      expect(PROFILE_DETAILS[profileId].ramOptions).toContain(option.resources.ram);
    }
  });

  it("makes Small the recommended size so a default launch is a preset", () => {
    for (const [profileId, browser] of [["codex", false], ["codex", true], ["ubuntu-desktop", false], ["linux-terminal", false]] as const) {
      const recommended = { ...PROFILE_DETAILS[profileId].recommended };
      const small = sizePresets(profileId, { browser })[0].resources;
      if (profileId === "codex" && !browser) expect(small).toEqual({ cpu: 0.5, ram: 1, maximumCpu: 0.5, maximumRam: 1 });
      else expect(small).toEqual({ cpu: recommended.cpu, ram: recommended.ram, maximumCpu: recommended.maximumCpu, maximumRam: recommended.maximumRam });
    }
  });

  it("has no presets for fixed-size computers", () => {
    expect(sizePresets("omarchy")).toEqual([]);
    expect(sizePresets("windows")).toEqual([]);
  });

  it("labels a size by its preset, otherwise as recommended or custom", () => {
    const options = sizePresets("codex", { browser: true });
    expect(sizeLabel({ cpu: 2, ram: 4, maximumCpu: 4, maximumRam: 8, source: "custom" }, options)).toBe("Medium");
    expect(matchingSizePreset({ cpu: 2, ram: 4, maximumCpu: 2, maximumRam: 4, source: "custom" }, options)).toBeNull();
    expect(sizeLabel({ cpu: 2, ram: 4, maximumCpu: 2, maximumRam: 4, source: "custom" }, options)).toBe("Custom");
    expect(sizeLabel({ cpu: 1.5, ram: 3, maximumCpu: 2, maximumRam: 4, source: "recommended" }, sizePresets("codex"))).toBe("Recommended");
  });
});

describe("plan rows", () => {
  it("describes what Codex can use, including whether it has a browser", () => {
    expect(capabilitySummary("codex", { browser: false })).toBe("Terminal, files and administrator access on its own computer. Browser: off.");
    expect(capabilitySummary("codex", { browser: true })).toMatch(/Browser: on\.$/);
    expect(capabilitySummary("linux-terminal", { browser: false })).toMatch(/without administrator access/);
  });

  it("states cost and changes without claiming a purchase", () => {
    expect(costSummary({ profileId: "codex", substrate: "hivra-cloud", planName: "Free" })).toBe("No extra charge. Uses your Free plan allowance.");
    expect(costSummary({ profileId: "codex", substrate: "provider-vm", planName: "Free" })).toMatch(/cloud provider keeps billing/);
    expect(launchChangesSummary({ profileId: "codex", substrate: "hivra-cloud", targetName: null }))
      .toBe("Creates one computer and installs Codex. Nothing is bought.");
    expect(launchChangesSummary({ profileId: "codex", substrate: "proxmox", targetName: "pve-01" }))
      .toBe("Creates one computer on pve-01 and installs Codex. Nothing is bought.");
    expect(launchChangesSummary({ profileId: "ubuntu-desktop", substrate: "hivra-cloud", targetName: null }))
      .toBe("Creates one computer with Ubuntu Desktop. Nothing is bought.");
    expect(launchChangesSummary({ profileId: "codex", substrate: "provider-vm", targetName: "hetzner-1" }))
      .toBe("Installs Codex on hetzner-1 and uses the whole server. It doesn't buy or create another server.");
  });

  it("describes a Windows setup without claiming an Ubuntu install or a purchase", () => {
    const changes = launchChangesSummary({ profileId: "windows", substrate: "proxmox", targetName: "pve-01" });
    expect(changes).toBe("Creates one Windows setup computer on pve-01, attaches the ISO you chose and starts the installer. Nothing is bought or uploaded, and Hivra Cloud isn't used.");
    expect(changes).not.toContain("Ubuntu");
  });
});

describe("launch names", () => {
  it("numbers the default name past names already in use", () => {
    expect(defaultLaunchName("codex", [])).toBe("Codex 1");
    expect(defaultLaunchName("codex", ["codex 1", "Codex 2 ", "Ubuntu Desktop 3"])).toBe("Codex 3");
    expect(defaultLaunchName("ubuntu-desktop", ["Codex 1"])).toBe("Ubuntu Desktop 1");
    // Windows setup names become host-side identifiers.
    expect(defaultLaunchName("windows", ["Windows-1"])).toBe("Windows-2");
  });

  it("flags names the launch routes would refuse", () => {
    expect(launchNameProblem("codex", "Codex 1")).toBeNull();
    expect(launchNameProblem("codex", "  ")).toBe("Enter a name.");
    expect(launchNameProblem("codex", "x".repeat(61))).toBe("Use 60 characters or fewer.");
    expect(launchNameProblem("windows", "Windows-1")).toBeNull();
    expect(launchNameProblem("windows", "My Windows")).toMatch(/letters, numbers, dots, dashes and underscores/);
    expect(launchNameProblem("windows", defaultLaunchName("windows", []))).toBeNull();
  });
});

describe("launch return paths", () => {
  it("round-trips only a launch draft id", () => {
    const id = "33333333-3333-4333-8333-333333333333";
    expect(launchReturnPath(id)).toBe(`/dashboard/launch?draft=${id}`);
    expect(parseLaunchDraftParam(id.toUpperCase())).toBe(id);
    expect(parseLaunchDraftParam("../../evil")).toBeNull();
    expect(parseLaunchDraftParam(null)).toBeNull();
  });
});
