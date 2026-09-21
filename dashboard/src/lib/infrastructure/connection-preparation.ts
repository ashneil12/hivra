import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import {
  runProxmoxHostScript,
  type HostScriptResult,
} from "@/lib/services/proxmox-instance-service";

import { preflightInfrastructureConnection } from "./connection-preflight";
import {
  buildUserProxmoxEnvironment,
  InfrastructureNetworkError,
  resolveValidatedSshDestination,
} from "./connection-runtime";
import {
  InfrastructureConnectionStoreError,
  beginInfrastructureConnectionPreparation,
  completeInfrastructureConnectionPreflight,
  loadInfrastructureConnectionSecret,
  type LoadedInfrastructureConnection,
} from "./connection-store";
import type { ProxmoxPreflightResult } from "./contracts";
import {
  PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES,
  PORTABLE_HIVRA_PROVISIONER_DIRECTORY,
  PORTABLE_HIVRA_PROVISIONER_PREPARE_SCRIPT,
  PORTABLE_HIVRA_PROVISIONER_RESULT_MARKER,
  PORTABLE_HIVRA_PROVISIONER_VERSION,
  PORTABLE_HIVRA_SIMPLE_BRIDGE,
  PORTABLE_HIVRA_SIMPLE_VMID_RANGE,
} from "./portable-provisioner-contract";

const MAX_PROVISIONER_BUNDLE_BYTES = 2 * 1024 * 1024;
// Leave enough of the route's 300-second budget for the mandatory read-only
// preflight (up to 60 seconds) and response serialization.
const PREPARATION_TIMEOUT_MS = 225_000;
const REMOTE_PREPARATION_TIMEOUT_SECONDS = 210;
const MAX_PREPARATION_OUTPUT_BYTES = 64 * 1024;

export type InfrastructurePreparationErrorCode =
  | "CONNECTION_NOT_FOUND"
  | "INVALID_CONNECTION"
  | "SIMPLE_MODE_REQUIRED"
  | "HOST_RESOLUTION_FAILED"
  | "HOST_ADDRESS_BLOCKED"
  | "SSH_HOST_KEY_MISMATCH"
  | "SSH_AUTHENTICATION_FAILED"
  | "SSH_CONNECTION_FAILED"
  | "PREPARATION_FAILED"
  | "PREPARATION_SUPERSEDED"
  | "PREPARATION_INTERNAL_ERROR";

type PreparationFailure = {
  ok: false;
  connectionId: string;
  error: {
    code: InfrastructurePreparationErrorCode;
    message: string;
    remediation?: string;
  };
};

export type InfrastructurePreparationResult =
  | {
      ok: true;
      connectionId: string;
      provisionerVersion: typeof PORTABLE_HIVRA_PROVISIONER_VERSION;
      preflight: ProxmoxPreflightResult;
    }
  | PreparationFailure;

export type PortableProvisionerBundleAsset = {
  relativePath: string;
  content: Buffer;
};

type PreparationDependencies = {
  loadConnection: typeof loadInfrastructureConnectionSecret;
  resolveDestination: typeof resolveValidatedSshDestination;
  loadBundle: typeof loadPortableProvisionerBundle;
  executeHostScript: typeof runProxmoxHostScript;
  preflight: typeof preflightInfrastructureConnection;
  beginPreparation: typeof beginInfrastructureConnectionPreparation;
  completePreflight: typeof completeInfrastructureConnectionPreflight;
  now: () => Date;
  newRunId: () => string;
};

const ERROR_COPY: Record<
  InfrastructurePreparationErrorCode,
  { message: string; remediation?: string }
> = {
  CONNECTION_NOT_FOUND: { message: "The infrastructure connection was not found." },
  INVALID_CONNECTION: {
    message: "The infrastructure connection is incomplete or invalid.",
    remediation: "Review the SSH credentials and connection settings, then save them again.",
  },
  SIMPLE_MODE_REQUIRED: {
    message: "Automatic host preparation is currently available only for Simple setup.",
    remediation: "Switch this connection to Simple setup, or prepare an Advanced target yourself.",
  },
  HOST_RESOLUTION_FAILED: {
    message: "The SSH host could not be resolved.",
    remediation: "Check the hostname and its DNS records.",
  },
  HOST_ADDRESS_BLOCKED: {
    message: "The SSH host resolves to an address this control plane cannot reach.",
    remediation: "Use a permitted address or explicitly enable private networking on a self-hosted control plane.",
  },
  SSH_HOST_KEY_MISMATCH: {
    message: "The server identity did not match the pinned SSH fingerprint.",
    remediation: "Verify the host fingerprint out of band before updating this connection.",
  },
  SSH_AUTHENTICATION_FAILED: {
    message: "SSH authentication failed.",
    remediation: "Check the SSH user, private key, and root access on the Proxmox host.",
  },
  SSH_CONNECTION_FAILED: {
    message: "The Proxmox host could not be reached over SSH.",
    remediation: "Check the host, SSH port, firewall, and network access.",
  },
  PREPARATION_FAILED: {
    message: "The Proxmox host could not be prepared.",
    remediation: "Check the Proxmox version, root access, storage, KVM, and outbound network access, then try again.",
  },
  PREPARATION_SUPERSEDED: {
    message: "The connection changed while preparation was running.",
    remediation: "Review the latest connection settings before preparing the host again.",
  },
  PREPARATION_INTERNAL_ERROR: {
    message: "The host preparation operation could not be started safely.",
    remediation: "Try again after the current Hivra build finishes deploying.",
  },
};

function failure(
  connectionId: string,
  code: InfrastructurePreparationErrorCode,
): PreparationFailure {
  return { ok: false, connectionId, error: { code, ...ERROR_COPY[code] } };
}

function safeBundleRelativePath(relativePath: string): boolean {
  return (
    relativePath.length > 0 &&
    relativePath.length <= 160 &&
    !path.isAbsolute(relativePath) &&
    !relativePath.split("/").some((segment) => !segment || segment === "." || segment === "..") &&
    /^[A-Za-z0-9._+@/-]+$/.test(relativePath)
  );
}

/** Load only the reviewed bundle allowlist and reject symlinks or oversized
 * payloads before any SSH operation starts. */
export async function loadPortableProvisionerBundle(
  // Keep the runtime path statically scoped so Next's file tracer includes only
  // the reviewed bundle instead of conservatively tracing the whole project.
  bundleRoot = path.join(process.cwd(), "provisioner"),
): Promise<PortableProvisionerBundleAsset[]> {
  const canonicalRoot = await realpath(bundleRoot);
  const assets: PortableProvisionerBundleAsset[] = [];
  let totalBytes = 0;

  for (const relativePath of PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES) {
    if (!safeBundleRelativePath(relativePath)) {
      throw new Error("Portable provisioner bundle path is invalid.");
    }
    const candidate = path.join(canonicalRoot, relativePath);
    const canonicalCandidate = await realpath(candidate);
    if (!canonicalCandidate.startsWith(`${canonicalRoot}${path.sep}`)) {
      throw new Error("Portable provisioner bundle escaped its root.");
    }
    const stat = await lstat(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("Portable provisioner bundle contains an unsupported entry.");
    }
    const content = await readFile(candidate);
    totalBytes += content.byteLength;
    if (totalBytes > MAX_PROVISIONER_BUNDLE_BYTES) {
      throw new Error("Portable provisioner bundle is too large.");
    }
    assets.push({ relativePath, content });
  }

  const versionAsset = assets.find((asset) => asset.relativePath === "VERSION");
  if (versionAsset?.content.toString("utf8").trim() !== PORTABLE_HIVRA_PROVISIONER_VERSION) {
    throw new Error("Portable provisioner bundle version does not match its contract.");
  }
  return assets;
}

function wrapBase64(value: Buffer): string {
  return value.toString("base64").match(/.{1,76}/g)?.join("\n") ?? "";
}

/** Build the single stdin payload sent to the pinned SSH destination. Files
 * are base64 encoded, checksum-verified in a private temporary directory, and
 * removed on every exit path. Only the preparation entrypoint is executed. */
export function buildPortableProvisionerPreparationScript(
  assets: PortableProvisionerBundleAsset[],
): string {
  const expected = new Set<string>(PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES);
  if (
    assets.length !== expected.size ||
    assets.some((asset) => !expected.delete(asset.relativePath)) ||
    expected.size !== 0
  ) {
    throw new Error("Portable provisioner bundle does not match its allowlist.");
  }

  const directories = Array.from(
    new Set(
      assets
        .map((asset) => path.posix.dirname(asset.relativePath))
        .filter((directory) => directory !== "."),
    ),
  ).sort();
  const directorySetup = directories
    .map((directory) => `install -d -m 0700 "$UPLOAD_DIR/${directory}"`)
    .join("\n");
  const writes = assets.map((asset, index) => {
    const delimiter = `HIVRA_PROVISIONER_ASSET_${index}`;
    return `base64 -d > "$UPLOAD_DIR/${asset.relativePath}" <<'${delimiter}'\n${wrapBase64(asset.content)}\n${delimiter}`;
  }).join("\n");
  const checksumManifest = assets.map((asset) => {
    const digest = createHash("sha256").update(asset.content).digest("hex");
    return `${digest}  ${asset.relativePath}`;
  }).join("\n");

  return `#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C
umask 077
command -v base64 >/dev/null 2>&1
command -v sha256sum >/dev/null 2>&1
command -v mktemp >/dev/null 2>&1
command -v timeout >/dev/null 2>&1
UPLOAD_DIR="$(mktemp -d /tmp/hivra-provisioner.XXXXXXXX)"
cleanup_upload() { rm -rf -- "$UPLOAD_DIR"; }
trap cleanup_upload EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
${directorySetup}
${writes}
(
  cd "$UPLOAD_DIR"
  sha256sum -c - <<'HIVRA_PROVISIONER_CHECKSUMS'
${checksumManifest}
HIVRA_PROVISIONER_CHECKSUMS
)
chmod 0700 "$UPLOAD_DIR/${PORTABLE_HIVRA_PROVISIONER_PREPARE_SCRIPT}"
timeout --foreground --signal=TERM --kill-after=10s ${REMOTE_PREPARATION_TIMEOUT_SECONDS}s env \
  HIVRA_SOURCE_DIR="$UPLOAD_DIR" \
  HIVRA_INSTALL_DIR='${PORTABLE_HIVRA_PROVISIONER_DIRECTORY}' \
  HIVRA_STATE_DIR='/etc/hivra' \
  HIVRA_KEY_DIR='/etc/hivra/keys' \
  HIVRA_LOG_DIR='/var/log/hivra' \
  HIVRA_BRIDGE='${PORTABLE_HIVRA_SIMPLE_BRIDGE}' \
  HIVRA_SUBNET_PREFIX='10.251.20' \
  HIVRA_GW='10.251.20.1' \
  HIVRA_IP_LAST_OCTET_START='50' \
  HIVRA_VMID_START='${PORTABLE_HIVRA_SIMPLE_VMID_RANGE.start}' \
  HIVRA_VMID_END='${PORTABLE_HIVRA_SIMPLE_VMID_RANGE.end}' \
  HIVRA_UBUNTU_IMG='/var/lib/vz/template/iso/hivra-ubuntu-jammy.img' \
  HIVRA_VM_SSH_KEY_PATH='/etc/hivra/keys/vm-orchestrator' \
  bash "$UPLOAD_DIR/${PORTABLE_HIVRA_PROVISIONER_PREPARE_SCRIPT}"
`;
}

function classifyTransportFailure(result: HostScriptResult): InfrastructurePreparationErrorCode {
  const normalized = result.error?.toLowerCase() ?? "";
  if (/(host key|host denied|fingerprint|verification failed)/.test(normalized)) {
    return "SSH_HOST_KEY_MISMATCH";
  }
  if (/(authentication|no supported auth|all configured authentication)/.test(normalized)) {
    return "SSH_AUTHENTICATION_FAILED";
  }
  if (/(timed out|econn|socket|handshake|connection)/.test(normalized)) {
    return "SSH_CONNECTION_FAILED";
  }
  return "PREPARATION_FAILED";
}

function hasExpectedPreparationReceipt(stdout: string): boolean {
  if (Buffer.byteLength(stdout, "utf8") > MAX_PREPARATION_OUTPUT_BYTES) return false;
  const prefix = `${PORTABLE_HIVRA_PROVISIONER_RESULT_MARKER} `;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith(prefix)) continue;
    try {
      const receipt = JSON.parse(line.slice(prefix.length)) as unknown;
      if (
        receipt &&
        typeof receipt === "object" &&
        !Array.isArray(receipt) &&
        (receipt as { version?: unknown }).version === PORTABLE_HIVRA_PROVISIONER_VERSION
      ) {
        return true;
      }
    } catch {
      return false;
    }
  }
  return false;
}

function loadedConnectionFailure(
  connectionId: string,
  error: unknown,
): PreparationFailure {
  if (error instanceof InfrastructureConnectionStoreError) {
    if (error.code === "not_found") return failure(connectionId, "CONNECTION_NOT_FOUND");
    if (error.code === "credential_error") return failure(connectionId, "INVALID_CONNECTION");
  }
  return failure(connectionId, "PREPARATION_INTERNAL_ERROR");
}

function sameOperationalRevision(
  first: LoadedInfrastructureConnection,
  current: LoadedInfrastructureConnection,
): boolean {
  return first.id === current.id && first.revision === current.revision;
}

const DEFAULT_DEPENDENCIES: PreparationDependencies = {
  loadConnection: loadInfrastructureConnectionSecret,
  resolveDestination: resolveValidatedSshDestination,
  loadBundle: loadPortableProvisionerBundle,
  executeHostScript: runProxmoxHostScript,
  preflight: preflightInfrastructureConnection,
  beginPreparation: beginInfrastructureConnectionPreparation,
  completePreflight: completeInfrastructureConnectionPreflight,
  now: () => new Date(),
  newRunId: randomUUID,
};

export async function prepareSimpleProxmoxConnection(
  userId: string,
  connectionId: string,
  dependencies: Partial<PreparationDependencies> = {},
): Promise<InfrastructurePreparationResult> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  let connection: LoadedInfrastructureConnection;
  try {
    connection = await deps.loadConnection(userId, connectionId);
  } catch (error) {
    return loadedConnectionFailure(connectionId, error);
  }

  if (connection.setupMode !== "simple") {
    return failure(connectionId, "SIMPLE_MODE_REQUIRED");
  }

  let destination;
  try {
    destination = await deps.resolveDestination(connection.endpoint.sshHost);
  } catch (error) {
    if (error instanceof InfrastructureNetworkError) {
      return failure(
        connectionId,
        error.code === "ssh_host_unresolvable"
          ? "HOST_RESOLUTION_FAILED"
          : error.code === "ssh_host_forbidden"
            ? "HOST_ADDRESS_BLOCKED"
            : "INVALID_CONNECTION",
      );
    }
    return failure(connectionId, "PREPARATION_INTERNAL_ERROR");
  }

  let bundle: PortableProvisionerBundleAsset[];
  try {
    bundle = await deps.loadBundle();
  } catch {
    return failure(connectionId, "PREPARATION_INTERNAL_ERROR");
  }

  let current: LoadedInfrastructureConnection;
  try {
    current = await deps.loadConnection(userId, connectionId);
  } catch (error) {
    return loadedConnectionFailure(connectionId, error);
  }
  if (!sameOperationalRevision(connection, current) || current.setupMode !== "simple") {
    return failure(connectionId, "PREPARATION_SUPERSEDED");
  }

  let script: string;
  try {
    script = buildPortableProvisionerPreparationScript(bundle);
  } catch {
    return failure(connectionId, "PREPARATION_INTERNAL_ERROR");
  }
  const env = buildUserProxmoxEnvironment(
    {
      id: current.id,
      sshHost: current.endpoint.sshHost,
      sshPort: current.endpoint.sshPort,
      sshUser: current.endpoint.sshUser,
      sshHostFingerprintSha256: current.endpoint.sshHostFingerprintSha256,
      sshPrivateKey: current.credentials.sshPrivateKey,
      vmidStart: PORTABLE_HIVRA_SIMPLE_VMID_RANGE.start,
      vmidEnd: PORTABLE_HIVRA_SIMPLE_VMID_RANGE.end,
      bridge: PORTABLE_HIVRA_SIMPLE_BRIDGE,
    },
    destination,
  );

  // Acquire durable authority before the first host mutation. The database
  // transition atomically marks the connection checking and invalidates every
  // published target, so launches cannot consume readiness evidence while the
  // bundle/network is being swapped.
  const preparationRunId = deps.newRunId();
  const preparationStartedAt = deps.now().toISOString();
  let leaseAcquired: boolean;
  try {
    leaseAcquired = await deps.beginPreparation(
      userId,
      connectionId,
      current.revision,
      preparationRunId,
      preparationStartedAt,
    );
  } catch {
    return failure(connectionId, "PREPARATION_INTERNAL_ERROR");
  }
  if (!leaseAcquired) return failure(connectionId, "PREPARATION_SUPERSEDED");

  const failWhileLeased = async (
    code: InfrastructurePreparationErrorCode,
  ): Promise<PreparationFailure> => {
    try {
      const completed = await deps.completePreflight(
        userId,
        connectionId,
        current.revision,
        preparationRunId,
        {
          connectionStatus: "error",
          checkedAt: deps.now().toISOString(),
          lastErrorCode: "PROVISIONER_UNAVAILABLE",
          target: null,
        },
      );
      if (!completed) return failure(connectionId, "PREPARATION_SUPERSEDED");
    } catch {
      return failure(connectionId, "PREPARATION_INTERNAL_ERROR");
    }
    return failure(connectionId, code);
  };

  let execution: HostScriptResult;
  try {
    execution = await deps.executeHostScript(script, env, {
      timeoutMs: PREPARATION_TIMEOUT_MS,
      maxOutputBytes: MAX_PREPARATION_OUTPUT_BYTES,
    });
  } catch {
    return failWhileLeased("SSH_CONNECTION_FAILED");
  }
  if (!execution.ok) {
    return failWhileLeased(classifyTransportFailure(execution));
  }
  if (!hasExpectedPreparationReceipt(execution.stdout)) {
    return failWhileLeased("PREPARATION_FAILED");
  }

  let afterPreparation: LoadedInfrastructureConnection;
  try {
    afterPreparation = await deps.loadConnection(userId, connectionId);
  } catch {
    return failWhileLeased("PREPARATION_SUPERSEDED");
  }
  if (!sameOperationalRevision(current, afterPreparation) || afterPreparation.setupMode !== "simple") {
    return failWhileLeased("PREPARATION_SUPERSEDED");
  }

  let preflight: ProxmoxPreflightResult;
  try {
    preflight = await deps.preflight(
      userId,
      connectionId,
      { newRunId: () => preparationRunId },
      current.revision,
    );
  } catch {
    return failWhileLeased("PREPARATION_INTERNAL_ERROR");
  }
  if (!preflight.ok && preflight.error.code === "CONNECTION_NOT_FOUND") {
    return failure(connectionId, "CONNECTION_NOT_FOUND");
  }
  if (!preflight.ok && preflight.error.code === "PREFLIGHT_SUPERSEDED") {
    return failure(connectionId, "PREPARATION_SUPERSEDED");
  }

  let finalConnection: LoadedInfrastructureConnection;
  try {
    finalConnection = await deps.loadConnection(userId, connectionId);
  } catch (error) {
    return loadedConnectionFailure(connectionId, error);
  }
  if (!sameOperationalRevision(current, finalConnection) || finalConnection.setupMode !== "simple") {
    return failure(connectionId, "PREPARATION_SUPERSEDED");
  }

  return {
    ok: true,
    connectionId,
    provisionerVersion: PORTABLE_HIVRA_PROVISIONER_VERSION,
    preflight,
  };
}
