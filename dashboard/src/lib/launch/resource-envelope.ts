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
  /** Codex's optional browser sidecar. Defaults on; other profiles ignore it. */
  browser?: boolean;
};

type LaunchResourcePolicy = {
  floor: Readonly<{ cpu: number; ram: number }>;
  recommended: Readonly<ResourceEnvelope>;
};

export const LAUNCH_RESOURCE_POLICY: Record<LaunchProfileId, LaunchResourcePolicy> = {
  codex: {
    // Codex with its browser sidecar (the catalog's browser-on floor).
    floor: resizeFloor("codex", true),
    recommended: { cpu: 1.5, ram: 3, maximumCpu: 2, maximumRam: 4 },
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

/** Codex without the browser sidecar keeps the catalog base floor and the same
 * pinned 0.5 CPU / 1 GB size the legacy welcome launch requests. */
const CODEX_WITHOUT_BROWSER_POLICY: LaunchResourcePolicy = {
  floor: resizeFloor("codex", false),
  recommended: { cpu: 0.5, ram: 1, maximumCpu: 0.5, maximumRam: 1 },
};

export function launchResourcePolicy(
  profileId: LaunchProfileId,
  { browser = true }: LaunchResourceOptions = {},
): LaunchResourcePolicy {
  return profileId === "codex" && !browser ? CODEX_WITHOUT_BROWSER_POLICY : LAUNCH_RESOURCE_POLICY[profileId];
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
