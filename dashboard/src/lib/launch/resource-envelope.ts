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

export const LAUNCH_RESOURCE_POLICY: Record<LaunchProfileId, {
  floor: Readonly<{ cpu: number; ram: number }>;
  recommended: Readonly<ResourceEnvelope>;
}> = {
  codex: {
    // The current Launch Journey enables Codex's accepted browser sidecar.
    floor: { cpu: 1.5, ram: 3 },
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

export type ResourceEnvelopeResult =
  | { ok: true; envelope: ResourceEnvelope }
  | { ok: false; reason: "below_floor" | "maximum_below_guarantee" | "maximum_above_cap" };

/** Pure launch policy shared by draft restoration, UI defaults, and API gates.
 * Missing maxima are deliberately treated as legacy pinned allocations. */
export function validateResourceEnvelope(
  profileId: LaunchProfileId,
  input: { cpu: number; ram: number; maximumCpu?: number | null; maximumRam?: number | null },
  limits: ResourceEnvelopeLimits = { maximumCpu: 8, maximumRam: 16 },
): ResourceEnvelopeResult {
  const floor = LAUNCH_RESOURCE_POLICY[profileId].floor;
  const maximumCpu = input.maximumCpu ?? input.cpu;
  const maximumRam = input.maximumRam ?? input.ram;
  if (input.cpu < floor.cpu || input.ram < floor.ram) return { ok: false, reason: "below_floor" };
  if (maximumCpu < input.cpu || maximumRam < input.ram) return { ok: false, reason: "maximum_below_guarantee" };
  if (maximumCpu > limits.maximumCpu || maximumRam > limits.maximumRam) return { ok: false, reason: "maximum_above_cap" };
  return { ok: true, envelope: { cpu: input.cpu, ram: input.ram, maximumCpu, maximumRam } };
}

export function recommendedResourceEnvelope(profileId: LaunchProfileId): ResourceEnvelope {
  return { ...LAUNCH_RESOURCE_POLICY[profileId].recommended };
}
