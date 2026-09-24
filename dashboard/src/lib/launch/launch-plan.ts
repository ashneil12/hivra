/**
 * Pure planning rules behind the Launch journey's Choose, Plan and Review
 * screens: plan-fit badges, size presets, and the plain-language rows that
 * describe where something runs, what it can use, what it costs and what a
 * launch changes. Everything is derived from the same plan, catalog and
 * target evidence the launch gates use; the server stays the authority.
 */

import { getAgent, resizeFloor, type AgentId, type PlanTier } from "@/lib/hivra/agent-catalog";
import type { PlanInfo } from "@/lib/hivra/agent-api";
import { targetSupportsCatalogRuntime } from "@/lib/hivra/agent-placement";
import { providerComputerResourceFloor } from "@/lib/hivra/provider-computer-resource-floor";
import { isProxmoxDeploymentTarget, type DeploymentTargetDto } from "@/lib/infrastructure/contracts";
import { measuredTargetCapacity } from "@/lib/infrastructure/measured-target-capacity";
import { ACTIVE_PLAN_KEYS, PLAN_ORDER, PLANS, type PlanKey } from "@/lib/subscription/plans";

import { LAUNCH_NAME_MAX_LENGTH, PROFILE_DETAILS, type LaunchProfileId, type LaunchResources } from "./contracts";
import { launchResourcePolicy, type ResourceEnvelope } from "./resource-envelope";

type Size = { cpu: number; ram: number };

// ── Plan fit ────────────────────────────────────────────────────────────────

/** What a Choose tile needs to judge where it can run. */
export type LaunchFitSubject = {
  /** Catalog runtime whose compatibility evidence a target must carry. */
  placementRuntimeId: string;
  /** "prepared" is a preview computer Hivra already set up; no plan applies. */
  hivraCloud: "plan" | "unavailable" | "prepared";
  minPlan: PlanTier;
  /** Smallest size without an optional browser. */
  floor: Size;
  /** Smallest size with the optional browser, when the runtime has one. */
  browserFloor: Size | null;
  /** Uses an agent slot but not the plan's CPU and memory pool. */
  poolExempt: boolean;
  /** Can run on capacity the owner connected. */
  ownServer: boolean;
  targetKind: "any" | "gvisor";
};

/** Browser automation is never part of a Free plan on Hivra Cloud. */
const PLAN_TIER_RANK: Record<PlanTier, number> = { free: 0, pro: 1, power: 2 };

function catalogSubject(id: AgentId, overrides: Partial<LaunchFitSubject> = {}): LaunchFitSubject {
  const def = getAgent(id);
  return {
    placementRuntimeId: id,
    hivraCloud: "plan",
    minPlan: def?.minPlan ?? "free",
    floor: resizeFloor(id, false),
    browserFloor: def?.browser ? resizeFloor(id, true) : null,
    poolExempt: Boolean(def?.poolExempt),
    ownServer: true,
    targetKind: "any",
    ...overrides,
  };
}

export function launchProfileFitSubject(profileId: LaunchProfileId): LaunchFitSubject {
  const profile = PROFILE_DETAILS[profileId];
  const floor = launchResourcePolicy(profileId, { browser: false }).floor;
  if (profileId === "codex") return catalogSubject("codex");
  if (profileId === "ubuntu-desktop") return catalogSubject("linux-desktop", { floor });
  if (profileId === "linux-terminal") {
    return catalogSubject("linux-terminal", { hivraCloud: "unavailable", floor, targetKind: "gvisor" });
  }
  if (profileId === "omarchy") {
    return { ...catalogSubject("linux-desktop", { floor }), hivraCloud: "prepared", ownServer: false };
  }
  return {
    placementRuntimeId: profile.placementRuntimeId,
    hivraCloud: "unavailable",
    minPlan: "free",
    floor,
    browserFloor: null,
    poolExempt: false,
    ownServer: true,
    targetKind: "any",
  };
}

/** Agents that still launch from their own setup page. Hermes runs only on
 * Hivra Cloud; the others can also use a server the owner connected. */
export function catalogAgentFitSubject(id: "claude-code" | "hermes" | "openclaw" | "agent-zero" | "aeon"): LaunchFitSubject {
  return catalogSubject(id, id === "hermes" ? { ownServer: false } : {});
}

export type LaunchFit = {
  label: string;
  tone: "fits" | "needs" | "neutral";
};

export type LaunchFitEvidence = {
  plan: PlanInfo | null;
  /** The plan check has finished (successfully or not). */
  planChecked: boolean;
  /** Launch-ready targets of any kind, before runtime filtering. */
  targets: readonly DeploymentTargetDto[];
  targetsLoading: boolean;
  /** This installation has no Hivra Cloud; only connected servers count. */
  selfHosted: boolean;
};

export function isPaidPlan(plan: PlanInfo | null): boolean {
  return Boolean(plan?.subscribed && plan.key !== "free");
}

function planKeyRank(plan: PlanInfo): number {
  const rank = PLAN_ORDER.indexOf(plan.key as PlanKey);
  if (rank >= 0) return rank;
  return isPaidPlan(plan) ? 1 : 0;
}

function tierAllows(rank: number, minPlan: PlanTier): boolean {
  return Math.min(rank, PLAN_TIER_RANK.power) >= PLAN_TIER_RANK[minPlan];
}

/** Whether the plan's per-agent caps, remaining pool and open slots hold a
 * size pinned at `size` (reserved equals maximum). */
function planHolds(plan: PlanInfo & { usage: NonNullable<PlanInfo["usage"]> }, size: Size, poolExempt: boolean): boolean {
  if (plan.usage.agentCount >= plan.maxAgents) return false;
  if (plan.maxCpuPerAgent < size.cpu || plan.maxRamPerAgent < size.ram) return false;
  if (poolExempt) return true;
  return plan.poolCpu - plan.usage.usedCpu >= size.cpu && plan.poolRam - plan.usage.usedRam >= size.ram;
}

type CloudFit = "full" | "without-browser" | "no" | "unknown";

function hivraCloudFit(subject: LaunchFitSubject, plan: PlanInfo | null): CloudFit {
  if (!plan?.usage) return "unknown";
  const observed = { ...plan, usage: plan.usage };
  if (!tierAllows(planKeyRank(plan), subject.minPlan)) return "no";
  if (subject.browserFloor) {
    if (isPaidPlan(plan) && planHolds(observed, subject.browserFloor, subject.poolExempt)) return "full";
    return planHolds(observed, subject.floor, subject.poolExempt) ? "without-browser" : "no";
  }
  return planHolds(observed, subject.floor, subject.poolExempt) ? "full" : "no";
}

export type PlanUpgrade = { key: PlanKey; name: string };

/** The cheapest plan on sale, above the current one, whose per-agent caps
 * hold `maximum`, whose pool (after what the owner already runs) holds
 * `reserved`, and which has a free agent slot. */
export function cheapestPlanForSize(
  request: { reserved: Size; maximum: Size; minPlan: PlanTier; poolExempt: boolean },
  plan: PlanInfo | null,
): PlanUpgrade | null {
  const currentRank = plan ? planKeyRank(plan) : 0;
  const usage = plan?.usage ?? { agentCount: 0, usedCpu: 0, usedRam: 0 };
  for (const key of ACTIVE_PLAN_KEYS) {
    const rank = PLAN_ORDER.indexOf(key);
    if (rank <= currentRank || !tierAllows(rank, request.minPlan)) continue;
    const candidate = PLANS[key];
    const perAgentRam = candidate.maxRamPerAgent / 1024;
    const totalRam = candidate.totalRam / 1024;
    if (candidate.maxAgents <= usage.agentCount) continue;
    if (candidate.maxCpuPerAgent < request.maximum.cpu || perAgentRam < request.maximum.ram) continue;
    if (!request.poolExempt
      && (candidate.totalCpu - usage.usedCpu < request.reserved.cpu || totalRam - usage.usedRam < request.reserved.ram)) continue;
    return { key, name: candidate.name };
  }
  return null;
}

/** The cheapest plan that would hold the subject at its smallest size. */
export function cheapestPlanFor(subject: LaunchFitSubject, plan: PlanInfo | null): PlanUpgrade | null {
  return cheapestPlanForSize({
    reserved: subject.floor,
    maximum: subject.floor,
    minPlan: subject.minPlan,
    poolExempt: subject.poolExempt,
  }, plan);
}

function targetKind(target: DeploymentTargetDto): string | undefined {
  return (target.capabilities as unknown as { kind?: string }).kind;
}

/** A ready target the owner connected that is compatible with the subject
 * and measured large enough for its smallest size. */
export function ownServerHolds(subject: LaunchFitSubject, targets: readonly DeploymentTargetDto[]): boolean {
  if (!subject.ownServer) return false;
  return targets.some(target => {
    if (subject.targetKind === "gvisor" && targetKind(target) !== "gvisor") return false;
    if (!targetSupportsCatalogRuntime(target, subject.placementRuntimeId)) return false;
    const capacity = measuredTargetCapacity(target);
    // A provider computer is used whole; it needs runtime headroom, not a slice.
    const needed = targetKind(target) === "provider-vm"
      ? providerComputerResourceFloor(subject.placementRuntimeId, false)
      : subject.floor;
    return capacity.cpu >= needed.cpu && capacity.ramGb >= needed.ram;
  });
}

/** The badge for a Choose tile, or null while its evidence is still loading
 * or the plan could not be checked. Only observed plan and target evidence
 * is used, and the badge never promises more than the launch gates allow. */
export function launchFit(subject: LaunchFitSubject, evidence: LaunchFitEvidence): LaunchFit | null {
  if (subject.hivraCloud === "prepared") return { label: "Preview", tone: "neutral" };
  if (evidence.selfHosted) {
    if (evidence.targetsLoading) return null;
    return ownServerHolds(subject, evidence.targets)
      ? { label: "Ready on your server", tone: "fits" }
      : { label: "Needs a connected server", tone: "needs" };
  }
  if (subject.hivraCloud === "plan") {
    if (!evidence.planChecked) return null;
    const cloud = hivraCloudFit(subject, evidence.plan);
    const planName = evidence.plan?.name ?? "";
    if (cloud === "full") return { label: `Fits your ${planName} plan`, tone: "fits" };
    if (cloud === "without-browser") return { label: `Fits ${planName} without a browser`, tone: "fits" };
    if (subject.ownServer && evidence.targetsLoading) return null;
    if (ownServerHolds(subject, evidence.targets)) return { label: "Ready on your server", tone: "fits" };
    if (cloud === "unknown") return null;
    const upgrade = cheapestPlanFor(subject, evidence.plan);
    if (upgrade) {
      return { label: subject.ownServer ? `Needs ${upgrade.name} or your own server` : `Needs ${upgrade.name}`, tone: "needs" };
    }
    return subject.ownServer
      ? { label: "Needs your own server", tone: "needs" }
      : { label: `No room on your ${planName} plan`, tone: "needs" };
  }
  if (evidence.targetsLoading) return null;
  return ownServerHolds(subject, evidence.targets)
    ? { label: "Ready on your server", tone: "fits" }
    : { label: "Needs your own server", tone: "needs" };
}

// ── Size presets ────────────────────────────────────────────────────────────

export type SizePresetId = "small" | "medium" | "large";

export type SizePreset = {
  id: SizePresetId;
  label: "Small" | "Medium" | "Large";
  resources: ResourceEnvelope;
};

function presets(small: ResourceEnvelope, medium: ResourceEnvelope, large: ResourceEnvelope): SizePreset[] {
  return [
    { id: "small", label: "Small", resources: small },
    { id: "medium", label: "Medium", resources: medium },
    { id: "large", label: "Large", resources: large },
  ];
}

/** Small / Medium / Large for a profile. Small is the recommended size, and
 * every preset holds the profile's floor. Fixed-size profiles have none. */
export function sizePresets(profileId: LaunchProfileId, { browser = false }: { browser?: boolean } = {}): SizePreset[] {
  if (profileId === "codex") {
    return browser
      ? presets(
        { cpu: 1.5, ram: 3, maximumCpu: 2, maximumRam: 4 },
        { cpu: 2, ram: 4, maximumCpu: 4, maximumRam: 8 },
        { cpu: 4, ram: 8, maximumCpu: 8, maximumRam: 16 },
      )
      : presets(
        { cpu: 0.5, ram: 1, maximumCpu: 0.5, maximumRam: 1 },
        { cpu: 1, ram: 2, maximumCpu: 2, maximumRam: 4 },
        { cpu: 2, ram: 4, maximumCpu: 4, maximumRam: 8 },
      );
  }
  if (profileId === "ubuntu-desktop") {
    return presets(
      { cpu: 2, ram: 4, maximumCpu: 4, maximumRam: 8 },
      { cpu: 4, ram: 8, maximumCpu: 8, maximumRam: 16 },
      { cpu: 8, ram: 16, maximumCpu: 8, maximumRam: 16 },
    );
  }
  if (profileId === "linux-terminal") {
    // gVisor enforces its reservation as the hard limit.
    return presets(
      { cpu: 1, ram: 1, maximumCpu: 1, maximumRam: 1 },
      { cpu: 2, ram: 2, maximumCpu: 2, maximumRam: 2 },
      { cpu: 4, ram: 4, maximumCpu: 4, maximumRam: 4 },
    );
  }
  return [];
}

export function matchingSizePreset(resources: LaunchResources, options: readonly SizePreset[]): SizePreset | null {
  return options.find(({ resources: preset }) =>
    preset.cpu === resources.cpu
    && preset.ram === resources.ram
    && preset.maximumCpu === (resources.maximumCpu ?? resources.cpu)
    && preset.maximumRam === (resources.maximumRam ?? resources.ram),
  ) ?? null;
}

/** "Small", "Medium" or "Large" when the size is a preset; otherwise
 * "Recommended" for a size Hivra picked and "Custom" for the owner's own. */
export function sizeLabel(resources: LaunchResources, options: readonly SizePreset[]): string {
  return matchingSizePreset(resources, options)?.label
    ?? (resources.source === "recommended" ? "Recommended" : "Custom");
}

/** "1.5 CPU / 3 GB", rounded down so a fraction is never overstated. */
export function formatLaunchSize(cpu: number, ram: number): string {
  const tenth = (value: number) => Math.floor(value * 10 + 1e-9) / 10;
  return `${tenth(cpu)} CPU / ${tenth(ram)} GB`;
}

// ── Plan and review rows ────────────────────────────────────────────────────

/** Where a launch lands, as the rows describe it. */
export type LaunchSubstrate = "hivra-cloud" | "proxmox" | "provider-vm" | "gvisor" | "unknown";

export function launchSubstrate(mode: "hivra-managed" | "self-managed", target: DeploymentTargetDto | null): LaunchSubstrate {
  if (mode === "hivra-managed") return "hivra-cloud";
  if (!target) return "unknown";
  if (isProxmoxDeploymentTarget(target)) return "proxmox";
  const kind = targetKind(target);
  if (kind === "gvisor") return "gvisor";
  if (kind === "provider-vm" || target.isolationClass === "provider-vm") return "provider-vm";
  return "unknown";
}

/** "My cloud" is a server Hivra created in the owner's cloud account; "My
 * server" is one they already had. */
export function ownCapacityLabel(substrate: LaunchSubstrate): "My cloud" | "My server" {
  return substrate === "provider-vm" ? "My cloud" : "My server";
}

/** What the agent (or the owner, for a computer) can use once it runs. */
export function capabilitySummary(profileId: LaunchProfileId, { browser }: { browser: boolean }): string {
  if (profileId === "codex") {
    return `Terminal, files and administrator access on its own computer. Browser: ${browser ? "on" : "off"}.`;
  }
  if (profileId === "ubuntu-desktop") return "A desktop, terminal and files on this computer.";
  if (profileId === "linux-terminal") return "A terminal and files, without administrator access. No desktop, public ports or host folders.";
  if (profileId === "omarchy") return "The prepared Omarchy desktop, with a setup console in your browser.";
  return "The Windows installer in your server's console. A desktop connection comes after setup finishes.";
}

export function modelAccessSummary(profileId: LaunchProfileId): string | null {
  return profileId === "codex" ? "Sign in to ChatGPT inside Codex after it opens." : null;
}

export function costSummary({
  profileId,
  substrate,
  planName,
}: {
  profileId: LaunchProfileId;
  substrate: LaunchSubstrate;
  planName: string | null;
}): string {
  if (profileId === "omarchy") return "Nothing is bought. It uses a prepared preview computer.";
  if (substrate === "hivra-cloud") return `No extra charge. Uses your ${planName ?? "Hivra Cloud"} plan allowance.`;
  if (substrate === "provider-vm") return "Nothing new is bought. Your cloud provider keeps billing this server as usual.";
  return "No charge from Hivra. It uses your server's own capacity.";
}

/** Exactly what the launch changes. */
export function launchChangesSummary({
  profileId,
  substrate,
  targetName,
}: {
  profileId: LaunchProfileId;
  substrate: LaunchSubstrate;
  targetName: string | null;
}): string {
  const profile = PROFILE_DETAILS[profileId];
  const host = targetName ?? "your server";
  if (profileId === "omarchy") return "Claims the prepared Omarchy preview computer. Nothing is bought.";
  if (profileId === "windows") {
    return `Creates one Windows setup computer on ${host}, attaches the ISO you chose and starts the installer. Nothing is bought or uploaded, and Hivra Cloud isn't used.`;
  }
  if (profileId === "linux-terminal") {
    return `Creates one Linux Sandbox on ${host} with fixed CPU and memory limits. It doesn't create a desktop, public ports or host folders. Nothing is bought.`;
  }
  if (substrate === "provider-vm") {
    return `Installs ${profile.name} on ${host} and uses the whole server. It doesn't buy or create another server.`;
  }
  const where = substrate === "hivra-cloud" ? "" : ` on ${host}`;
  return profile.resourceKind === "computer"
    ? `Creates one computer${where} with ${profile.name}. Nothing is bought.`
    : `Creates one computer${where} and installs ${profile.name}. Nothing is bought.`;
}

export function isolationDetail(substrate: LaunchSubstrate): string {
  if (substrate === "hivra-cloud") return "Private virtual machine on Hivra Cloud (Proxmox KVM)";
  if (substrate === "proxmox") return "Private virtual machine on your Proxmox host (KVM)";
  if (substrate === "gvisor") return "gVisor application-kernel sandbox on your Linux host";
  if (substrate === "provider-vm") return "The whole cloud server, used by this launch only";
  return "Isolation evidence unavailable";
}

// ── Names ───────────────────────────────────────────────────────────────────

/** Windows setup names become host-side identifiers. */
const WINDOWS_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** "Codex 1", or the next number no existing agent or computer uses. */
export function defaultLaunchName(profileId: LaunchProfileId, existingNames: readonly string[]): string {
  const base = PROFILE_DETAILS[profileId].name;
  const separator = profileId === "windows" ? "-" : " ";
  const taken = new Set(existingNames.map(name => name.trim().toLowerCase()));
  let number = 1;
  while (taken.has(`${base}${separator}${number}`.toLowerCase())) number += 1;
  return `${base}${separator}${number}`;
}

/** Why a name can't be used, or null when it can. */
export function launchNameProblem(profileId: LaunchProfileId, name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Enter a name.";
  if (trimmed.length > LAUNCH_NAME_MAX_LENGTH) return `Use ${LAUNCH_NAME_MAX_LENGTH} characters or fewer.`;
  if (profileId === "windows" && !WINDOWS_NAME.test(trimmed)) {
    return "Windows names use letters, numbers, dots, dashes and underscores, and start with a letter or number.";
  }
  return null;
}

// ── Returning to a launch ───────────────────────────────────────────────────

const LAUNCH_DRAFT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Where an upgrade or activation started from this draft returns to. */
export function launchReturnPath(launchRequestId: string): string {
  return `/dashboard/launch?draft=${encodeURIComponent(launchRequestId)}`;
}

export function parseLaunchDraftParam(value: string | null | undefined): string | null {
  return value && LAUNCH_DRAFT_ID.test(value) ? value.toLowerCase() : null;
}
