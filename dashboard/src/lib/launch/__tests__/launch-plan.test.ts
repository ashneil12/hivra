import type { PlanInfo } from "@/lib/hivra/agent-api";
import type { DeploymentTargetDto } from "@/lib/infrastructure/contracts";
import {
  PORTABLE_HIVRA_PROVISIONER_VERSION,
  PORTABLE_HIVRA_RUNTIME_COMPATIBILITY,
} from "@/lib/infrastructure/portable-provisioner-contract";

import { PROFILE_DETAILS } from "../contracts";
import { createLaunchDraft } from "../draft-store";
import {
  capabilitySummary,
  cheapestPlanForSize,
  costSummary,
  defaultLaunchName,
  destinationSizeLimits,
  fitSizePresets,
  fitSizeToLimits,
  fittingPresetFor,
  launchChangesSummary,
  launchFit,
  launchNameProblem,
  launchProfileFitSubject,
  launchReturnPath,
  matchingSizePreset,
  parseLaunchArrival,
  parseLaunchDraftParam,
  planHoldAction,
  planHoldMessage,
  recommendedLaunchSize,
  sizeLabel,
  sizePresets,
  unfinishedLaunchNotes,
  upgradeObserved,
  upgradeRequestSize,
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
  return { plan, planChecked: true, targets, targetsLoading: false, targetsError: false, selfHosted: false, ...overrides };
}

/** What fetchPlanStrict reads for an account with no plan yet, running
 * nothing on Hivra Cloud. */
const NO_PLAN: PlanInfo = {
  subscribed: false, name: "Free", key: "free", maxAgents: 1,
  maxCpuPerAgent: 0.5, maxRamPerAgent: 1, poolCpu: 0.5, poolRam: 1, needsActivation: true,
  usage: { agentCount: 0, usedCpu: 0, usedRam: 0 },
};
/** A Pro subscription in dunning: billing reports no plan, and names it. */
const PRO_ON_HOLD: PlanInfo = {
  subscribed: false, name: "Free", key: "free", maxAgents: 1,
  maxCpuPerAgent: 0.5, maxRamPerAgent: 1, poolCpu: 0.5, poolRam: 1,
  usage: { agentCount: 0, usedCpu: 0, usedRam: 0 },
  onHold: { key: "operator", name: "Pro", reason: "payment_overdue", billingPortal: true },
};

describe("launchFit", () => {
  it("says what fits Free before the Free plan is turned on, without calling it the owner's plan", () => {
    const noPlan = evidence(NO_PLAN);
    expect(launchFit(launchProfileFitSubject("hermes"), noPlan)).toEqual({ label: "Fits Free", tone: "fits" });
    expect(launchFit(launchProfileFitSubject("codex"), noPlan)).toEqual({ label: "Fits Free without a browser", tone: "fits" });
    expect(launchFit(launchProfileFitSubject("ubuntu-desktop"), noPlan)).toEqual({ label: "Needs Pro or your own server", tone: "needs" });
  });

  it("counts what an account without a plan already runs, and never assumes nothing", () => {
    // A lapsed account still running an agent: Free would have no room.
    const running = evidence({ ...NO_PLAN, usage: { agentCount: 1, usedCpu: 0.5, usedRam: 1 } });
    expect(launchFit(launchProfileFitSubject("hermes"), running)).toEqual({ label: "Needs Pro", tone: "needs" });
    // Unread is unknown, not empty.
    const unread = evidence({ ...NO_PLAN, usage: undefined });
    expect(launchFit(launchProfileFitSubject("hermes"), unread)).toEqual({ label: "Couldn't check your plan", tone: "neutral" });
  });

  it("closes Hivra Cloud while a paid plan is on hold, and still offers a ready server", () => {
    const onHold = evidence(PRO_ON_HOLD);
    expect(launchFit(launchProfileFitSubject("hermes"), onHold)).toEqual({ label: "Pro plan on hold", tone: "needs" });
    expect(launchFit(launchProfileFitSubject("claude-code"), onHold)).toEqual({ label: "Pro plan on hold", tone: "needs" });
    expect(launchFit(launchProfileFitSubject("codex"), evidence(PRO_ON_HOLD, [PROXMOX]))).toEqual({ label: "Ready on your server", tone: "fits" });
    // Never "Fits Free": Free can't be turned on over a paid plan.
    expect(launchFit(launchProfileFitSubject("hermes"), onHold)?.label).not.toMatch(/Free/);
  });

  it("labels each tile on Free from the same floors the launch gates use", () => {
    const free = evidence(FREE);
    expect(launchFit(launchProfileFitSubject("codex"), free)).toEqual({ label: "Fits Free without a browser", tone: "fits" });
    expect(launchFit(launchProfileFitSubject("claude-code"), free)).toEqual({ label: "Fits Free without a browser", tone: "fits" });
    expect(launchFit(launchProfileFitSubject("hermes"), free)).toEqual({ label: "Fits your Free plan", tone: "fits" });
    expect(launchFit(launchProfileFitSubject("aeon"), free)).toEqual({ label: "Fits your Free plan", tone: "fits" });
    expect(launchFit(launchProfileFitSubject("openclaw"), free)).toEqual({ label: "Needs Pro or your own server", tone: "needs" });
    expect(launchFit(launchProfileFitSubject("agent-zero"), free)).toEqual({ label: "Needs Pro or your own server", tone: "needs" });
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
    expect(launchFit(launchProfileFitSubject("hermes"), evidence(fullFree))).toEqual({ label: "Needs Pro", tone: "needs" });
    expect(launchFit(launchProfileFitSubject("codex"), evidence(fullFree))).toEqual({ label: "Needs Pro or your own server", tone: "needs" });
  });

  it("says a ready server of the owner's holds it when the plan does not", () => {
    expect(launchFit(launchProfileFitSubject("ubuntu-desktop"), evidence(FREE, [PROXMOX]))).toEqual({ label: "Ready on your server", tone: "fits" });
    // Compatibility evidence matters, not just a ready host.
    expect(launchFit(launchProfileFitSubject("openclaw"), evidence(FREE, [PROXMOX]))).toEqual({ label: "Needs Pro or your own server", tone: "needs" });
    // Too small a host is not ready for it.
    const small = { ...PROXMOX, capacity: { ...PROXMOX.capacity, cpu: { totalCores: 1, utilizationRatio: 0 }, memoryBytes: { total: 4 * 1024 ** 3, available: 2 * 1024 ** 3 } } };
    expect(launchFit(launchProfileFitSubject("ubuntu-desktop"), evidence(FREE, [small]))).toEqual({ label: "Needs Pro or your own server", tone: "needs" });
    // Linux Sandbox needs a gVisor host, not a Proxmox one.
    expect(launchFit(launchProfileFitSubject("linux-terminal"), evidence(FREE, [PROXMOX]))).toEqual({ label: "Needs your own server", tone: "needs" });
  });

  it("shows no badge until the evidence it depends on is known", () => {
    expect(launchFit(launchProfileFitSubject("codex"), evidence(null, [], { planChecked: false }))).toBeNull();
    expect(launchFit(launchProfileFitSubject("linux-terminal"), evidence(FREE, [], { targetsLoading: true }))).toBeNull();
    expect(launchFit(launchProfileFitSubject("ubuntu-desktop"), evidence(FREE, [], { targetsLoading: true }))).toBeNull();
  });

  it("says a check failed instead of waiting forever or reading it as an answer", () => {
    const planUnchecked = { label: "Couldn't check your plan", tone: "neutral" };
    const serversUnchecked = { label: "Couldn't check your servers", tone: "neutral" };
    // A failed plan check is unknown, not Free, and it is finished.
    expect(launchFit(launchProfileFitSubject("codex"), evidence(null))).toEqual(planUnchecked);
    expect(launchFit(launchProfileFitSubject("hermes"), evidence(null))).toEqual(planUnchecked);
    expect(launchFit(launchProfileFitSubject("codex"), evidence({ ...FREE, usage: undefined }))).toEqual(planUnchecked);
    // A server the owner connected still counts when only the plan is unknown.
    expect(launchFit(launchProfileFitSubject("ubuntu-desktop"), evidence(null, [PROXMOX]))).toEqual({ label: "Ready on your server", tone: "fits" });
    // A server list that failed to load is not an empty one.
    const failed = { targetsError: true };
    expect(launchFit(launchProfileFitSubject("linux-terminal"), evidence(FREE, [], failed))).toEqual(serversUnchecked);
    expect(launchFit(launchProfileFitSubject("windows"), evidence(FREE, [], failed))).toEqual(serversUnchecked);
    expect(launchFit(launchProfileFitSubject("codex"), evidence(null, [], { ...failed, selfHosted: true }))).toEqual(serversUnchecked);
    // What the plan itself says is still observed.
    expect(launchFit(launchProfileFitSubject("codex"), evidence(FREE, [], failed))).toEqual({ label: "Fits Free without a browser", tone: "fits" });
    expect(launchFit(launchProfileFitSubject("ubuntu-desktop"), evidence(FREE, [], failed))).toEqual({ label: "Needs Pro or your own server", tone: "needs" });
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

describe("fitting a size to where it runs", () => {
  const ubuntu = PROFILE_DETAILS["ubuntu-desktop"];

  it("keeps the reservation and brings a maximum over the plan's cap down to it", () => {
    const pro = destinationSizeLimits("hivra-managed", null, PRO);
    expect(pro).toEqual({ reservedCpu: 2, reservedRam: 4, maximumCpu: 2, maximumRam: 4 });
    expect(fitSizeToLimits({ cpu: 2, ram: 4, maximumCpu: 4, maximumRam: 8 }, pro, ubuntu))
      .toEqual({ cpu: 2, ram: 4, maximumCpu: 2, maximumRam: 4 });
    // A reservation over what is left never shrinks to fit.
    expect(fitSizeToLimits({ cpu: 4, ram: 8, maximumCpu: 8, maximumRam: 16 }, pro, ubuntu)).toBeNull();
    const used = destinationSizeLimits("hivra-managed", null, { ...PRO, usage: { agentCount: 1, usedCpu: 1, usedRam: 2 } });
    expect(fitSizeToLimits({ cpu: 2, ram: 4, maximumCpu: 4, maximumRam: 8 }, used, ubuntu)).toBeNull();
  });

  it("offers Ubuntu's Small on Pro instead of marking every preset over the plan", () => {
    const presets = fitSizePresets(sizePresets("ubuntu-desktop"), destinationSizeLimits("hivra-managed", null, PRO), ubuntu);
    expect(presets.map(preset => [preset.label, preset.fits, preset.capped])).toEqual([
      ["Small", true, true], ["Medium", false, false], ["Large", false, false],
    ]);
    expect(presets[0].resources).toEqual({ cpu: 2, ram: 4, maximumCpu: 2, maximumRam: 4 });
    expect(sizeLabel({ ...presets[0].resources, source: "recommended" }, presets)).toBe("Small");
    // The offer for a size that doesn't fit is the preset that does.
    expect(fittingPresetFor(presets, { cpu: 2, ram: 4, maximumCpu: 4, maximumRam: 8, source: "custom" })?.label).toBe("Small");
    expect(fittingPresetFor(fitSizePresets(sizePresets("ubuntu-desktop"), destinationSizeLimits("hivra-managed", null, FREE), ubuntu),
      { cpu: 2, ram: 4, maximumCpu: 4, maximumRam: 8, source: "custom" })).toBeNull();
  });

  it("fits a maximum to the selected server's total capacity", () => {
    const host = destinationSizeLimits("self-managed", PROXMOX, null);
    expect(host).toEqual({ reservedCpu: 6, reservedRam: 8, maximumCpu: 6, maximumRam: 16 });
    const [small, medium, large] = fitSizePresets(sizePresets("ubuntu-desktop"), host, ubuntu);
    expect([small.fits, small.capped]).toEqual([true, false]);
    expect(medium.resources).toEqual({ cpu: 4, ram: 8, maximumCpu: 4, maximumRam: 16 });
    expect(large.fits).toBe(false);
  });

  it("recommends Hivra's size fitted to the plan, or as it is while nothing fits", () => {
    expect(recommendedLaunchSize("ubuntu-desktop", destinationSizeLimits("hivra-managed", null, PRO), { browser: false }))
      .toEqual({ cpu: 2, ram: 4, maximumCpu: 2, maximumRam: 4, source: "recommended" });
    expect(recommendedLaunchSize("ubuntu-desktop", destinationSizeLimits("hivra-managed", null, FREE), { browser: false }))
      .toEqual({ ...PROFILE_DETAILS["ubuntu-desktop"].recommended });
    expect(recommendedLaunchSize("ubuntu-desktop", null, { browser: false })).toEqual({ ...PROFILE_DETAILS["ubuntu-desktop"].recommended });
    expect(recommendedLaunchSize("codex", destinationSizeLimits("hivra-managed", null, PRO), { browser: true }))
      .toEqual({ cpu: 1.5, ram: 3, maximumCpu: 2, maximumRam: 4, source: "recommended" });
  });

  it("proposes Medium for Hermes, never the whole plan, stepping down to what is left", () => {
    const power = { ...PRO, name: "Power", key: "power", maxCpuPerAgent: 8, maxRamPerAgent: 16, poolCpu: 8, poolRam: 16 };
    const pinned = (cpu: number, ram: number) => ({ cpu, ram, maximumCpu: cpu, maximumRam: ram, source: "recommended" });
    expect(recommendedLaunchSize("hermes", destinationSizeLimits("hivra-managed", null, power), { browser: false })).toEqual(pinned(2, 4));
    expect(recommendedLaunchSize("hermes", destinationSizeLimits("hivra-managed", null, { ...PRO, usage: { agentCount: 1, usedCpu: 1, usedRam: 2 } }), { browser: false }))
      .toEqual(pinned(1, 2));
    expect(recommendedLaunchSize("hermes", destinationSizeLimits("hivra-managed", null, FREE), { browser: false })).toEqual(pinned(0.5, 1));
  });

  it("recommends each agent's own size from its form and the catalog floors", () => {
    const pinned = (cpu: number, ram: number) => ({ cpu, ram, maximumCpu: cpu, maximumRam: ram, source: "recommended" });
    const pro = destinationSizeLimits("hivra-managed", null, PRO);
    expect(recommendedLaunchSize("claude-code", pro, { browser: true })).toEqual(pinned(2, 4));
    expect(recommendedLaunchSize("claude-code", destinationSizeLimits("hivra-managed", null, FREE), { browser: false })).toEqual(pinned(0.5, 1));
    expect(recommendedLaunchSize("openclaw", pro, { browser: false })).toEqual(pinned(1, 2));
    expect(recommendedLaunchSize("openclaw", pro, { browser: true })).toEqual(pinned(2, 4));
    expect(recommendedLaunchSize("agent-zero", pro, { browser: false })).toEqual(pinned(2, 4));
    expect(recommendedLaunchSize("agent-zero", destinationSizeLimits("hivra-managed", null, { ...PRO, usage: { agentCount: 1, usedCpu: 1, usedRam: 2 } }), { browser: false }))
      .toEqual(pinned(1, 2));
    expect(recommendedLaunchSize("aeon", pro, { browser: false })).toEqual(pinned(0.5, 1));
  });

  it("offers the upgrade the Choose badge named for Hivra's own size, and an exact fit for the owner's", () => {
    const request = (resources: Parameters<typeof upgradeRequestSize>[0]) => cheapestPlanForSize({
      ...upgradeRequestSize(resources), minPlan: launchProfileFitSubject("ubuntu-desktop").minPlan, poolExempt: false,
    }, FREE);
    // Free -> the badge says Pro, and Pro holds Ubuntu once its maximum is fitted.
    expect(launchFit(launchProfileFitSubject("ubuntu-desktop"), evidence(FREE))?.label).toBe("Needs Pro or your own server");
    expect(request({ ...PROFILE_DETAILS["ubuntu-desktop"].recommended })?.name).toBe("Pro");
    // A size the owner chose is kept, so it needs a plan that holds it exactly.
    expect(request({ cpu: 2, ram: 4, maximumCpu: 4, maximumRam: 8, source: "custom" })?.name).toBe("Power");
  });
});

describe("plan holds", () => {
  it("says why Hivra Cloud is closed and what settles it, from what billing observed", () => {
    expect(planHoldMessage({ reason: "payment_overdue", planName: "Pro" }, "Claude Code"))
      .toBe("Your Pro plan is on hold because a payment didn't go through. Update your payment in Billing to run Claude Code on Hivra Cloud.");
    expect(planHoldMessage({ reason: "no_slots", planName: "Power" }))
      .toBe("Your Power plan has no agent slots right now. Check it in Billing to launch on Hivra Cloud.");
    expect(planHoldMessage({ reason: "unconfirmed" }, "Codex"))
      .toBe("Your account has a paid plan that isn't active right now, so Free can't be turned on. Check your plan in Billing to run Codex on Hivra Cloud.");
    expect(planHoldAction({ reason: "payment_overdue", planName: "Pro" })).toBe("Update payment");
    expect(planHoldAction({ reason: "no_slots", planName: "Pro" })).toBe("Open Billing");
    expect(planHoldAction({ reason: "unconfirmed" })).toBe("Open Billing");
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
    // Before the Free plan is turned on it isn't "your" plan yet.
    expect(costSummary({ profileId: "codex", substrate: "hivra-cloud", planName: "Free", planPending: true }))
      .toBe("No charge. It runs on the Free plan, which you turn on before launching.");
    expect(costSummary({ profileId: "codex", substrate: "proxmox", planName: "Free", planPending: true })).toMatch(/your server's own capacity/);
    // A plan on hold is never presented as Free or as costing nothing.
    expect(costSummary({ profileId: "codex", substrate: "hivra-cloud", planName: "Free", planOnHold: "Pro" }))
      .toBe("Uses your Pro plan allowance once the plan is active again.");
    expect(costSummary({ profileId: "codex", substrate: "proxmox", planName: "Free", planOnHold: "Pro" })).toMatch(/your server's own capacity/);
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

  it("reads which paid plan an upgrade moved to, and nothing else", () => {
    const id = "33333333-3333-4333-8333-333333333333";
    expect(parseLaunchArrival(id, "fleet")).toEqual({ draftId: id, upgrade: { target: "fleet" } });
    expect(parseLaunchArrival(id, "1")).toEqual({ draftId: id, upgrade: { target: null } });
    expect(parseLaunchArrival(id, null)).toEqual({ draftId: id, upgrade: null });
    expect(parseLaunchArrival(null, "free")).toBeNull();
    expect(parseLaunchArrival("../evil", "<script>")).toBeNull();
  });

  it("counts an upgrade as showing only once the fetched plan reaches it", () => {
    const power = { ...PRO, name: "Power", key: "fleet" };
    expect(upgradeObserved(PRO, "operator")).toBe(true);
    expect(upgradeObserved(power, "operator")).toBe(true);
    // Pro to Power that hasn't synced yet is not "Pro is active".
    expect(upgradeObserved(PRO, "fleet")).toBe(false);
    expect(upgradeObserved(FREE, "operator")).toBe(false);
    expect(upgradeObserved(PRO, null)).toBe(true);
    expect(upgradeObserved(null, null)).toBe(false);
  });
});

describe("unfinished launch notes", () => {
  const unfinished = { ...createLaunchDraft(), stage: "review" as const, resourceKind: "agent" as const, profileId: "codex" as const, name: "Codex 1" };

  it("says only that an unlaunched draft hasn't launched", () => {
    expect(unfinishedLaunchNotes(unfinished)).toEqual({
      summary: "You set up Codex 1 but haven't launched it yet.", partialId: null, download: null,
    });
  });

  it("points at what a partial launch created instead of claiming nothing started", () => {
    const id = "77777777-7777-4777-8777-777777777777";
    const notes = unfinishedLaunchNotes({ ...unfinished, error: "The browser sidecar failed to start", result: { id, name: "Codex 1", status: "error" } });
    expect(notes.summary).toBe("Your last try created part of Codex 1 before it stopped.");
    expect(notes.partialId).toBe(id);
  });

  it("reports a turned-down launch and a refused one from what the draft recorded", () => {
    expect(unfinishedLaunchNotes({ ...unfinished, stage: "launch", launchState: "failed", error: "Your plan has no open agent slots." }).summary)
      .toBe("Your last try at launching Codex 1 was turned down: Your plan has no open agent slots.");
    expect(unfinishedLaunchNotes({ ...unfinished, error: "Name already in use" }).summary)
      .toBe("Your last try at launching Codex 1 didn't go through: Name already in use.");
  });

  it("mentions a Windows ISO download that was still running", () => {
    const windows = {
      ...unfinished, resourceKind: "computer" as const, profileId: "windows" as const, name: "Windows-1",
      windowsIsoDownload: {
        taskId: "99999999-9999-4999-8999-999999999999", connectionId: "11111111-1111-4111-8111-111111111111",
        targetId: "22222222-2222-4222-8222-222222222222", expectedConnectionRevision: 7, source: "windows-11" as const,
        storage: "local", filename: "Win11.iso", state: "running" as const,
      },
    };
    expect(unfinishedLaunchNotes(windows).download)
      .toBe("When you left, your server was still downloading Win11.iso. Starting a new launch doesn't stop that download.");
  });
});
