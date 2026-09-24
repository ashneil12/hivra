// DigitalOcean Managed Agents as a place a Launch agent runs. The owner's own
// DigitalOcean team runs the sandbox and bills it; Hivra relays chat and files.
// These rules decide which launches can use it, what they need, and the exact
// request Launch sends. Keys are never stored: they come from the page.

import {
  DIGITALOCEAN_HARNESS_LABELS,
  ManagedSessionLaunchSchema,
  type ManagedSessionLaunchInput,
} from "@/lib/hivra/managed-session-contracts";
import type {
  DigitalOceanDeploymentTargetDto,
  DigitalOceanHarness,
  DigitalOceanSandboxSize,
} from "@/lib/infrastructure/contracts";

import type { LaunchDigitalOceanChoice, LaunchDraft, LaunchProfileId } from "./contracts";

const HARNESS_FOR_PROFILE: Partial<Record<LaunchProfileId, DigitalOceanHarness>> = {
  "claude-code": "claude-code",
  codex: "codex",
  hermes: "hermes",
};

/** The DigitalOcean harness a Launch profile runs as, or null when DigitalOcean can't run it. */
export function digitalOceanHarnessFor(profileId: LaunchProfileId | null): DigitalOceanHarness | null {
  return profileId ? HARNESS_FOR_PROFILE[profileId] ?? null : null;
}

/** A DigitalOcean team this profile can launch on now. */
export function digitalOceanTargetRuns(target: DigitalOceanDeploymentTargetDto, harness: DigitalOceanHarness): boolean {
  return target.status === "ready" && target.capabilities.launchReady && target.capabilities.harnesses.includes(harness)
    && target.capacity.sizes.length > 0;
}

/** The provider key the harness itself signs in with, or null (Hermes takes DigitalOcean Inference only). */
export function digitalOceanVendorKey(harness: DigitalOceanHarness): string | null {
  return DIGITALOCEAN_HARNESS_LABELS[harness].vendorKey;
}

/** The model mode this harness actually uses: Hermes has no vendor key. */
export function effectiveDigitalOceanModelMode(
  harness: DigitalOceanHarness,
  choice: LaunchDigitalOceanChoice,
): LaunchDigitalOceanChoice["modelMode"] {
  return digitalOceanVendorKey(harness) ? choice.modelMode : "digitalocean-inference";
}

/** "2 vCPU / 4 GB" for a DigitalOcean sandbox size. */
export function digitalOceanSizeLabel(size: { vcpus: number; memoryMb: number }): string {
  const gb = size.memoryMb / 1024;
  return `${size.vcpus} vCPU / ${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
}

/** The size this launch uses on the target: the owner's choice while the team offers it. */
export function digitalOceanSizeFor(
  target: DigitalOceanDeploymentTargetDto,
  choice: LaunchDigitalOceanChoice,
): DigitalOceanDeploymentTargetDto["capacity"]["sizes"][number] | null {
  const sizes = target.capacity.sizes;
  return sizes.find((size) => size.slug === choice.size)
    ?? sizes.find((size) => size.slug === ("mars-2vcpu-4gb" as DigitalOceanSandboxSize))
    ?? sizes[0] ?? null;
}

/** What the model choice still needs before Review, or null. */
export function digitalOceanModelProblem(
  harness: DigitalOceanHarness,
  choice: LaunchDigitalOceanChoice,
  key: string,
): string | null {
  const mode = effectiveDigitalOceanModelMode(harness, choice);
  const vendorKey = digitalOceanVendorKey(harness);
  if (key.trim().length < 20) {
    return mode === "vendor"
      ? `Paste your ${vendorKey} for ${DIGITALOCEAN_HARNESS_LABELS[harness].name}.`
      : "Paste a DigitalOcean model access key.";
  }
  if (/\s/.test(key.trim())) return "The key can't contain spaces.";
  if (mode === "digitalocean-inference" && !choice.model) return "Choose the DigitalOcean model it uses.";
  return null;
}

/** The exact launch request for a DigitalOcean sandbox. Replays use the same
 * launchRequestId, which the server treats as the same launch. */
export function digitalOceanLaunchRequest(
  draft: LaunchDraft,
  deployment: { connectionId: string; targetId: string },
  target: DigitalOceanDeploymentTargetDto,
  key: string,
): ManagedSessionLaunchInput {
  const harness = digitalOceanHarnessFor(draft.profileId);
  if (!harness) throw new Error("DigitalOcean can't run this launch.");
  const size = digitalOceanSizeFor(target, draft.digitalOcean);
  if (!size) throw new Error("This DigitalOcean team offers no sandbox size.");
  const mode = effectiveDigitalOceanModelMode(harness, draft.digitalOcean);
  return ManagedSessionLaunchSchema.parse({
    launchRequestId: draft.launchRequestId,
    connectionId: deployment.connectionId,
    targetId: deployment.targetId,
    harness,
    size: size.slug,
    name: draft.name.trim(),
    model: mode === "vendor"
      ? { mode: "vendor", apiKey: key.trim() }
      : { mode: "digitalocean-inference", apiKey: key.trim(), model: draft.digitalOcean.model },
  });
}
