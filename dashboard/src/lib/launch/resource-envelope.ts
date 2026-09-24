import { resizeFloor } from "@/lib/hivra/agent-catalog";
import type { LaunchProfileId } from "./contracts";

export type ResourceEnvelope = {
  /** Capacity reserved for this computer and never ballooned below. */
  cpu: number;
  ram: number;
  /** Hard VM/cgroup ceilings; never lower than the guaranteed allocation. */
  maximumCpu: number;
  maximumRam: number;
};

export type ResourceEnvelopeLimits = {
  maximumCpu: number;
  maximumRam: number;
};

export type LaunchResourceOptions = {
  /** The optional browser (Codex, Claude Code, OpenClaw). Defaults on;
   * profiles without one ignore it. */
  browser?: boolean;
};

type LaunchResourcePolicy = {
  floor: Readonly<{ cpu: number; ram: number }>;
  recommended: Readonly<ResourceEnvelope>;
  /** Sizes Hivra tries in order, taking the first that runs where the launch
   * goes. Without them, the recommendation is fitted to the destination. */
  candidates?: readonly Readonly<ResourceEnvelope>[];
};

function pinned(cpu: number, ram: number): ResourceEnvelope {
  return { cpu, ram, maximumCpu: cpu, maximumRam: ram };
}

export const LAUNCH_RESOURCE_POLICY: Record<LaunchProfileId, LaunchResourcePolicy> = {
  codex: {
    // Codex with its browser sidecar (the catalog's browser-on floor).
    floor: resizeFloor("codex", true),
    recommended: { cpu: 1.5, ram: 3, maximumCpu: 2, maximumRam: 4 },
  },
  // Claude Code, OpenClaw, Agent Zero, Aeon and Hermes keep the size they
  // launch with as their hard limit; their setup forms never sent maxima.
  "claude-code": {
    // With the browser: the welcome form's 2 CPU / 4 GB recommendation.
    floor: resizeFloor("claude-code", true),
    recommended: pinned(2, 4),
  },
  openclaw: {
    floor: resizeFloor("openclaw", true),
    recommended: pinned(2, 4),
  },
  "agent-zero": {
    // Recommended gives its tools and own browser room; the catalog floor
    // stays one click away, as on its setup form.
    floor: resizeFloor("agent-zero", false),
    recommended: pinned(2, 4),
    candidates: [pinned(2, 4), pinned(1, 2)],
  },
  aeon: {
    // Only its dashboard runs here; Hivra Cloud pins it to the catalog floor.
    floor: resizeFloor("aeon", false),
    recommended: pinned(0.5, 1),
  },
  hermes: {
    floor: resizeFloor("hermes", false),
    // The Hermes setup form gave a new agent the whole plan, leaving nothing
    // for a second agent. Hivra proposes Medium, or the largest smaller size
    // that fits what is left; Large stays one click away.
    recommended: pinned(2, 4),
    candidates: [pinned(2, 4), pinned(1, 2), pinned(0.5, 1)],
  },
  "ubuntu-desktop": {
    floor: { cpu: 2, ram: 4 },
    recommended: { cpu: 2, ram: 4, maximumCpu: 4, maximumRam: 8 },
  },
  "linux-terminal": {
    floor: { cpu: 0.5, ram: 1 },
    recommended: { cpu: 1, ram: 1, maximumCpu: 1, maximumRam: 1 },
  },
  omarchy: {
    floor: { cpu: 4, ram: 8 },
    recommended: { cpu: 4, ram: 8, maximumCpu: 4, maximumRam: 8 },
  },
  windows: {
    floor: { cpu: 4, ram: 8 },
    recommended: { cpu: 4, ram: 8, maximumCpu: 4, maximumRam: 8 },
  },
};

/** Without their browser, Codex and Claude Code keep the catalog base floor
 * and the pinned 0.5 CPU / 1 GB size their welcome launches request, and
 * OpenClaw its catalog floor. */
const WITHOUT_BROWSER_POLICY: Partial<Record<LaunchProfileId, LaunchResourcePolicy>> = {
  codex: {
    floor: resizeFloor("codex", false),
    recommended: pinned(0.5, 1),
  },
  "claude-code": {
    floor: resizeFloor("claude-code", false),
    recommended: pinned(0.5, 1),
  },
  openclaw: {
    floor: resizeFloor("openclaw", false),
    recommended: pinned(1, 2),
  },
};

export function launchResourcePolicy(
  profileId: LaunchProfileId,
  { browser = true }: LaunchResourceOptions = {},
): LaunchResourcePolicy {
  return (!browser ? WITHOUT_BROWSER_POLICY[profileId] : undefined) ?? LAUNCH_RESOURCE_POLICY[profileId];
}

export type ResourceEnvelopeResult =
  | { ok: true; envelope: ResourceEnvelope }
  | { ok: false; reason: "below_floor" | "maximum_below_guarantee" | "maximum_above_cap" };

/** Pure launch policy shared by draft restoration, UI defaults, and API gates.
 * Missing maxima are deliberately treated as legacy pinned allocations. */
export function validateResourceEnvelope(
  profileId: LaunchProfileId,
  input: { cpu: number; ram: number; maximumCpu?: number | null; maximumRam?: number | null },
  limits: ResourceEnvelopeLimits = { maximumCpu: 8, maximumRam: 16 },
  options: LaunchResourceOptions = {},
): ResourceEnvelopeResult {
  const floor = launchResourcePolicy(profileId, options).floor;
  const maximumCpu = input.maximumCpu ?? input.cpu;
  const maximumRam = input.maximumRam ?? input.ram;
  if (input.cpu < floor.cpu || input.ram < floor.ram) return { ok: false, reason: "below_floor" };
  if (maximumCpu < input.cpu || maximumRam < input.ram) return { ok: false, reason: "maximum_below_guarantee" };
  if (maximumCpu > limits.maximumCpu || maximumRam > limits.maximumRam) return { ok: false, reason: "maximum_above_cap" };
  return { ok: true, envelope: { cpu: input.cpu, ram: input.ram, maximumCpu, maximumRam } };
}

export function recommendedResourceEnvelope(
  profileId: LaunchProfileId,
  options: LaunchResourceOptions = {},
): ResourceEnvelope {
  return { ...launchResourcePolicy(profileId, options).recommended };
}
