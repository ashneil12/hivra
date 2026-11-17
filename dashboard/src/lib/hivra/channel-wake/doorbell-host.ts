import "server-only";

import { createHash } from "node:crypto";

import {
  anyWakeDoorbellEnabled,
  buildDoorbellInstallScript,
  buildDoorbellRemoveScript,
  buildDoorbellStatusScript,
  DOORBELL_BUNDLE_FILES,
  parseDoorbellResult,
  parseDoorbellStatus,
  type DoorbellBundlePath,
  type DoorbellResult,
  type DoorbellStatus,
} from "./doorbell-scripts";
import { isSafeManagedProvisionerTargetId, targetIsConfigured } from "@/lib/hivra/managed-provisioner-bundle-sync";
import type { ManagedHivraProvisionerChannel } from "@/lib/hivra/managed-provisioner-channel";
import { loadPortableProvisionerBundle } from "@/lib/infrastructure/connection-preparation";
import {
  PORTABLE_HIVRA_PROVISIONER_VERSION,
  provisionerSupportsWakeDoorbell,
} from "@/lib/infrastructure/portable-provisioner-contract";
import { resolveProxmoxTargetConfiguration, runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";

/**
 * The doorbell's install step, run from the ops provisioner-bundle route like
 * the wake proxy's (and, like it, separate from bundle sync). install-doorbell
 * needs HIVRA_WAKE_DOORBELLS to list a channel and a release that carries the
 * doorbell; status is read-only and remove is the way back, so neither needs
 * the switch. Removal still refuses on the host while the doorbell holds arms.
 */

export const DOORBELL_ACTIONS = ["install-doorbell", "doorbell-status", "remove-doorbell"] as const;
export type DoorbellAction = (typeof DOORBELL_ACTIONS)[number];

export function isDoorbellAction(value: unknown): value is DoorbellAction {
  return (DOORBELL_ACTIONS as readonly unknown[]).includes(value);
}

export interface DoorbellActionResult {
  ok: boolean;
  action: DoorbellAction;
  targetId: string;
  channel: ManagedHivraProvisionerChannel;
  httpStatus?: number;
  result?: DoorbellResult;
  status?: DoorbellStatus;
  error?: string;
}

type Dependencies = {
  loadBundle: typeof loadPortableProvisionerBundle;
  runHostScript: typeof runProxmoxHostScript;
  env: NodeJS.ProcessEnv;
};

const DEFAULTS: Dependencies = { loadBundle: loadPortableProvisionerBundle, runHostScript: runProxmoxHostScript, env: process.env };
const INSTALL_TIMEOUT_MS = 120_000;
const SHORT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

export async function reviewedDoorbellDigests(
  loadBundle: typeof loadPortableProvisionerBundle = loadPortableProvisionerBundle,
): Promise<Record<DoorbellBundlePath, string>> {
  const assets = await loadBundle();
  const digests = {} as Record<DoorbellBundlePath, string>;
  for (const name of DOORBELL_BUNDLE_FILES) {
    const asset = assets.find((entry) => entry.relativePath === name);
    if (!asset) throw new Error(`The provisioner bundle has no ${name}.`);
    digests[name] = createHash("sha256").update(asset.content).digest("hex");
  }
  return digests;
}

export async function runDoorbellAction(
  input: { action: DoorbellAction; channel: ManagedHivraProvisionerChannel; targetId: string },
  dependencies: Partial<Dependencies> = {},
): Promise<DoorbellActionResult> {
  const deps = { ...DEFAULTS, ...dependencies };
  const { action, channel, targetId } = input;
  const base = { action, targetId, channel };
  if (!isSafeManagedProvisionerTargetId(targetId) || !targetIsConfigured(targetId, deps.env)) {
    return { ...base, ok: false, httpStatus: 400, error: "Target is not in the configured managed host rotation." };
  }
  let script: string;
  if (action === "install-doorbell") {
    if (!anyWakeDoorbellEnabled(deps.env)) return { ...base, ok: false, httpStatus: 409, error: "HIVRA_WAKE_DOORBELLS lists no channel." };
    if (!provisionerSupportsWakeDoorbell(PORTABLE_HIVRA_PROVISIONER_VERSION)) {
      return { ...base, ok: false, httpStatus: 409, error: "This provisioner release does not carry the wake doorbell." };
    }
    script = buildDoorbellInstallScript({
      targetId,
      channel,
      bundleVersion: PORTABLE_HIVRA_PROVISIONER_VERSION,
      fileDigests: await reviewedDoorbellDigests(deps.loadBundle),
    });
  } else if (action === "remove-doorbell") {
    script = buildDoorbellRemoveScript(targetId);
  } else {
    script = buildDoorbellStatusScript(targetId);
  }
  const candidate = resolveProxmoxTargetConfiguration(deps.env, targetId);
  const run = await deps.runHostScript(script, candidate.env, {
    timeoutMs: action === "install-doorbell" ? INSTALL_TIMEOUT_MS : SHORT_TIMEOUT_MS,
    maxOutputBytes: MAX_OUTPUT_BYTES,
  });
  const detail = run.error ?? (run.stderr.slice(-300) || undefined);
  if (action === "doorbell-status") {
    const status = parseDoorbellStatus(run.stdout);
    if (!run.ok || !status) return { ...base, ok: false, httpStatus: 503, error: detail ?? "Doorbell status marker was missing." };
    return { ...base, ok: true, status };
  }
  const result = parseDoorbellResult(run.stdout) ?? undefined;
  const success = action === "install-doorbell"
    ? result?.status === "installed" || result?.status === "unchanged"
    : result?.status === "removed" || result?.status === "absent";
  if (!run.ok || !success) {
    return { ...base, ok: false, httpStatus: result?.status === "refused" ? 409 : 503, ...(result ? { result } : {}),
      error: detail ?? "Doorbell result marker was missing." };
  }
  return { ...base, ok: true, result };
}
