// DigitalOcean Managed Agents as a place a Launch agent runs. The owner's own
// DigitalOcean team runs the sandbox and bills it; Hivra relays chat and files.
// These rules decide which launches can use it, what they need, and the exact
// request Launch sends. A pasted key comes from the page and is never stored;
// a key the owner saved in their Vault is named by id, sent only once they
// confirm it for this launch, and read by the server for them alone.

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
import { savedKeyHint, type SavedModelKey } from "./model-access";

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

/** The owner's saved Vault key for this harness's provider key (Anthropic for
 * Claude Code, OpenAI for Codex), or null. The Vault holds no DigitalOcean
 * model access key, so DigitalOcean Inference always takes a pasted one. */
export function digitalOceanSavedKey(
  harness: DigitalOceanHarness,
  choice: LaunchDigitalOceanChoice,
  savedKeys: readonly SavedModelKey[],
): SavedModelKey | null {
  const provider = DIGITALOCEAN_HARNESS_LABELS[harness].vaultProvider;
  if (!provider || effectiveDigitalOceanModelMode(harness, choice) !== "vendor") return null;
  return savedKeys.find(key => key.provider.trim().toLowerCase() === provider) ?? null;
}

/** Where this launch's provider key comes from: the saved one unless the
 * owner chose to paste, or there is none. */
export function digitalOceanKeySource(
  harness: DigitalOceanHarness,
  choice: LaunchDigitalOceanChoice,
  savedKeys: readonly SavedModelKey[],
): "saved" | "paste" {
  return digitalOceanSavedKey(harness, choice, savedKeys) && choice.keySource !== "paste" ? "saved" : "paste";
}

/** The saved key this launch sends: only the one the owner confirmed. */
function confirmedSavedKey(
  harness: DigitalOceanHarness,
  choice: LaunchDigitalOceanChoice,
  savedKeys: readonly SavedModelKey[],
): SavedModelKey | null {
  const saved = digitalOceanSavedKey(harness, choice, savedKeys);
  return saved && digitalOceanKeySource(harness, choice, savedKeys) === "saved"
    && choice.sendSavedKey && choice.vaultKeyId === saved.id ? saved : null;
}

/** What the model choice still needs before Review, or null. */
export function digitalOceanModelProblem(
  harness: DigitalOceanHarness,
  choice: LaunchDigitalOceanChoice,
  key: string,
  savedKeys: readonly SavedModelKey[] = [],
): string | null {
  const mode = effectiveDigitalOceanModelMode(harness, choice);
  const vendorKey = digitalOceanVendorKey(harness);
  if (digitalOceanKeySource(harness, choice, savedKeys) === "saved") {
    return confirmedSavedKey(harness, choice, savedKeys)
      ? null
      : `Confirm that your saved ${vendorKey} can be sent to DigitalOcean for this sandbox.`;
  }
  if (key.trim().length < 20) {
    return mode === "vendor"
      ? `Paste your ${vendorKey} for ${DIGITALOCEAN_HARNESS_LABELS[harness].name}.`
      : "Paste a DigitalOcean model access key.";
  }
  if (/\s/.test(key.trim())) return "The key can't contain spaces.";
  if (mode === "digitalocean-inference" && !choice.model) return "Choose the DigitalOcean model it uses.";
  return null;
}

/** The Review row for how the sandbox reaches a model. */
export function digitalOceanModelSummary(
  harness: DigitalOceanHarness,
  choice: LaunchDigitalOceanChoice,
  savedKeys: readonly SavedModelKey[],
): string {
  if (effectiveDigitalOceanModelMode(harness, choice) !== "vendor") {
    return `DigitalOcean Inference · ${choice.model || "no model chosen"}, billed to your team`;
  }
  const vendorKey = digitalOceanVendorKey(harness);
  const saved = confirmedSavedKey(harness, choice, savedKeys);
  if (saved) return `Your saved ${vendorKey} ${savedKeyHint(saved)}, sent to DigitalOcean for this sandbox`;
  if (!choice.saveKey) return `Your ${vendorKey}, sent to DigitalOcean for this sandbox`;
  const replaced = digitalOceanSavedKey(harness, choice, savedKeys);
  return `Your ${vendorKey}, sent to DigitalOcean for this sandbox and saved in your Vault${replaced ? `, replacing ${savedKeyHint(replaced)}` : ""}`;
}

/** The saved Vault key a DigitalOcean launch names: the one the owner
 * confirmed for it, or null when it sends a pasted key. Review is gated on
 * that key still being the saved one; a resend repeats it as confirmed, and
 * the server reads it for the owner alone. */
export function digitalOceanLaunchVaultKeyId(draft: LaunchDraft): string | null {
  const harness = digitalOceanHarnessFor(draft.profileId);
  const choice = draft.digitalOcean;
  return harness && DIGITALOCEAN_HARNESS_LABELS[harness].vaultProvider
    && effectiveDigitalOceanModelMode(harness, choice) === "vendor"
    && choice.keySource !== "paste" && choice.sendSavedKey && choice.vaultKeyId
    ? choice.vaultKeyId
    : null;
}

/** The exact launch request for a DigitalOcean sandbox. Replays use the same
 * launchRequestId, which the server treats as the same launch. `key` is the
 * pasted key, or the id of a saved Vault key the owner confirmed. */
export function digitalOceanLaunchRequest(
  draft: LaunchDraft,
  deployment: { connectionId: string; targetId: string },
  target: DigitalOceanDeploymentTargetDto,
  key: string | { vaultKeyId: string },
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
      ? typeof key === "string" ? { mode: "vendor", apiKey: key.trim() } : { mode: "vendor", vaultKeyId: key.vaultKeyId }
      : { mode: "digitalocean-inference", apiKey: typeof key === "string" ? key.trim() : "", model: draft.digitalOcean.model },
    ...(draft.digitalOcean.firstTask.trim() ? { firstTask: draft.digitalOcean.firstTask.trim() } : {}),
  });
}
