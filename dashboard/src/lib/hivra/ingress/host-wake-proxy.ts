import "server-only";

import { createHash } from "node:crypto";

import {
  buildHostCredentialRemoveScript,
  buildHostWakeProxyInstallScript,
  buildHostWakeProxyRemoveScript,
  buildHostWakeProxyStatusScript,
  HOST_WAKE_PROXY_BUNDLE_FILES,
  parseHostWakeProxyResult,
  parseHostWakeProxyStatus,
  type HostWakeProxyBundlePath,
  type HostWakeProxyResult,
  type HostWakeProxyStatus,
} from "@/lib/hivra/ingress/host-scripts";
import {
  hostWakeProxyEnabled,
  ingressHostAllowed,
  ingressHostCredentialEnabled,
  type IngressHostRow,
} from "@/lib/hivra/ingress/config";
import { issueHostCredential, revokeHostCredential } from "@/lib/hivra/ingress/host-credential-store";
import {
  isSafeManagedProvisionerTargetId,
  targetIsConfigured,
} from "@/lib/hivra/managed-provisioner-bundle-sync";
import type { ManagedHivraProvisionerChannel } from "@/lib/hivra/managed-provisioner-channel";
import { loadPortableProvisionerBundle } from "@/lib/infrastructure/connection-preparation";
import {
  PORTABLE_HIVRA_PROVISIONER_VERSION,
  provisionerSupportsHostCredential,
  provisionerSupportsWakeProxy,
} from "@/lib/infrastructure/portable-provisioner-contract";
import {
  resolveProxmoxTargetConfiguration,
  runProxmoxHostScript,
  runProxmoxHostScriptWithStdin,
} from "@/lib/services/proxmox-instance-service";
import { supabaseAdmin } from "@/lib/supabase";

export const HOST_WAKE_PROXY_ACTIONS = [
  "install-wake-proxy",
  "wake-proxy-status",
  "remove-wake-proxy",
  "revoke-host-credential",
] as const;
export type HostWakeProxyAction = (typeof HOST_WAKE_PROXY_ACTIONS)[number];

export function isHostWakeProxyAction(value: unknown): value is HostWakeProxyAction {
  return (HOST_WAKE_PROXY_ACTIONS as readonly unknown[]).includes(value);
}

export type HostWakeProxyActionResult = {
  ok: boolean;
  action: HostWakeProxyAction;
  targetId: string;
  channel: ManagedHivraProvisionerChannel;
  /** HTTP status the route should answer with when ok is false. */
  httpStatus?: number;
  result?: HostWakeProxyResult;
  status?: HostWakeProxyStatus;
  /** revoke-host-credential: the generation now honoured, and whether the host's file is gone. */
  credentialGeneration?: number;
  hostFileRemoved?: boolean;
  error?: string;
};

type Dependencies = {
  loadBundle: typeof loadPortableProvisionerBundle;
  runHostScript: typeof runProxmoxHostScript;
  runHostScriptWithStdin: typeof runProxmoxHostScriptWithStdin;
  loadHostRow: (targetId: string) => Promise<IngressHostRow | null>;
  issueCredential: typeof issueHostCredential;
  revokeCredential: typeof revokeHostCredential;
  env: NodeJS.ProcessEnv;
};

async function loadHostRowFromDb(targetId: string): Promise<IngressHostRow | null> {
  if (!supabaseAdmin) throw new Error("Supabase is not configured.");
  const { data, error } = await supabaseAdmin
    .from("proxmox_hosts")
    .select("id, ingress_mode")
    .eq("id", targetId)
    .maybeSingle();
  if (error) throw new Error(`proxmox_hosts read failed: ${error.message}`);
  return (data as IngressHostRow | null) ?? null;
}

const DEFAULT_DEPENDENCIES: Dependencies = {
  loadBundle: loadPortableProvisionerBundle,
  runHostScript: runProxmoxHostScript,
  runHostScriptWithStdin: runProxmoxHostScriptWithStdin,
  loadHostRow: loadHostRowFromDb,
  issueCredential: issueHostCredential,
  revokeCredential: revokeHostCredential,
  env: process.env,
};

const INSTALL_TIMEOUT_MS = 280_000;
const SHORT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

/** sha256 of each wake-proxy file in this deployment's reviewed bundle. */
export async function reviewedWakeProxyDigests(
  loadBundle: typeof loadPortableProvisionerBundle = loadPortableProvisionerBundle,
): Promise<Record<HostWakeProxyBundlePath, string>> {
  const assets = await loadBundle();
  const digests = {} as Record<HostWakeProxyBundlePath, string>;
  for (const name of HOST_WAKE_PROXY_BUNDLE_FILES) {
    const asset = assets.find((entry) => entry.relativePath === name);
    if (!asset) throw new Error(`The provisioner bundle has no ${name}.`);
    digests[name] = createHash("sha256").update(asset.content).digest("hex");
  }
  return digests;
}

/**
 * install-wake-proxy needs HIVRA_HOST_WAKE_PROXY_ENABLED plus both ingress
 * switches (HIVRA_HOST_INGRESS and the host's ingress_mode) not off, and a
 * bundle version that carries the wake proxy. wake-proxy-status is read-only
 * and remove-wake-proxy is the way back, so neither needs the flags; removal
 * still refuses on the host while any computer uses host ingress there.
 */
export async function runHostWakeProxyAction(
  input: {
    action: HostWakeProxyAction;
    channel: ManagedHivraProvisionerChannel;
    targetId: string;
    forceHealthFailure?: boolean;
  },
  dependencies: Partial<Dependencies> = {},
): Promise<HostWakeProxyActionResult> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const { action, channel, targetId } = input;
  const base = { action, targetId, channel };
  if (!isSafeManagedProvisionerTargetId(targetId) || !targetIsConfigured(targetId, deps.env)) {
    return { ...base, ok: false, httpStatus: 400, error: "Target is not in the configured managed host rotation." };
  }

  if (action === "revoke-host-credential") return revokeAction(base, deps);

  let script: string;
  // Only with HIVRA_INGRESS_HOST_CREDENTIAL: the credential document, sent on stdin.
  let stdin: string | null = null;
  if (action === "install-wake-proxy") {
    if (!hostWakeProxyEnabled(deps.env)) {
      return { ...base, ok: false, httpStatus: 409, error: "HIVRA_HOST_WAKE_PROXY_ENABLED is off." };
    }
    if (!provisionerSupportsWakeProxy(PORTABLE_HIVRA_PROVISIONER_VERSION)) {
      return { ...base, ok: false, httpStatus: 409, error: "This provisioner release does not carry the wake proxy." };
    }
    const hostRow = await deps.loadHostRow(targetId);
    if (!ingressHostAllowed(hostRow, deps.env)) {
      return { ...base, ok: false, httpStatus: 409, error: "Host ingress is off for this host." };
    }
    if (ingressHostCredentialEnabled(deps.env)) {
      if (!provisionerSupportsHostCredential(PORTABLE_HIVRA_PROVISIONER_VERSION)) {
        return { ...base, ok: false, httpStatus: 409, error: "This provisioner release's wake proxy cannot use a host credential." };
      }
      const issued = await deps.issueCredential(targetId, deps.env);
      if (!issued.ok) {
        return { ...base, ok: false, httpStatus: 409, error: `Host credential could not be issued (${issued.reason}).` };
      }
      stdin = `${JSON.stringify(issued.document)}\n`;
    }
    script = buildHostWakeProxyInstallScript({
      targetId,
      channel,
      bundleVersion: PORTABLE_HIVRA_PROVISIONER_VERSION,
      fileDigests: await reviewedWakeProxyDigests(deps.loadBundle),
      forceHealthFailure: input.forceHealthFailure === true,
      ...(stdin !== null ? { hostCredential: true } : {}),
    });
  } else if (action === "remove-wake-proxy") {
    script = buildHostWakeProxyRemoveScript(targetId);
  } else {
    script = buildHostWakeProxyStatusScript(targetId);
  }

  const candidate = resolveProxmoxTargetConfiguration(deps.env, targetId);
  const runOptions = {
    timeoutMs: action === "install-wake-proxy" ? INSTALL_TIMEOUT_MS : SHORT_TIMEOUT_MS,
    maxOutputBytes: MAX_OUTPUT_BYTES,
  };
  const run = stdin !== null
    ? await deps.runHostScriptWithStdin(script, stdin, candidate.env, runOptions)
    : await deps.runHostScript(script, candidate.env, runOptions);
  const detail = run.error ?? (run.stderr.slice(-300) || undefined);

  if (action === "wake-proxy-status") {
    const status = parseHostWakeProxyStatus(run.stdout);
    if (!run.ok || !status) {
      return { ...base, ok: false, httpStatus: 503, error: detail ?? "Wake proxy status marker was missing." };
    }
    return { ...base, ok: true, status };
  }

  const result = parseHostWakeProxyResult(run.stdout) ?? undefined;
  const success = action === "install-wake-proxy"
    ? result?.status === "installed" || result?.status === "unchanged"
    : result?.status === "removed" || result?.status === "absent";
  if (!run.ok || !success) {
    return {
      ...base,
      ok: false,
      httpStatus: result?.status === "refused" ? 409 : 503,
      ...(result ? { result } : {}),
      error: detail ?? "Wake proxy result marker was missing.",
    };
  }
  return { ...base, ok: true, result };
}

/**
 * revoke-host-credential: moves the host's credential generation on, so the
 * credential it holds stops working at once, then removes the file from the
 * host. Needs no flag: revoking is always safe, and the sweep still catches up
 * proxy wakes without it. The next install with the flag on issues a new one.
 */
async function revokeAction(
  base: { action: HostWakeProxyAction; targetId: string; channel: ManagedHivraProvisionerChannel },
  deps: Dependencies,
): Promise<HostWakeProxyActionResult> {
  const revoked = await deps.revokeCredential(base.targetId);
  if (!revoked.ok) return { ...base, ok: false, httpStatus: 409, error: `Host credential could not be revoked (${revoked.reason}).` };
  const candidate = resolveProxmoxTargetConfiguration(deps.env, base.targetId);
  const run = await deps.runHostScript(buildHostCredentialRemoveScript(base.targetId), candidate.env, {
    timeoutMs: SHORT_TIMEOUT_MS,
    maxOutputBytes: MAX_OUTPUT_BYTES,
  });
  const result = parseHostWakeProxyResult(run.stdout) ?? undefined;
  const hostFileRemoved = run.ok && (result?.status === "removed" || result?.status === "absent");
  // The revocation already holds: the file left behind is only a credential that no longer works.
  return {
    ...base,
    ok: true,
    credentialGeneration: revoked.generation,
    hostFileRemoved,
    ...(result ? { result } : {}),
  };
}
