import "server-only";

import {
  getInfrastructureDeploymentTarget,
  InfrastructureConnectionStoreError,
  loadInfrastructureConnectionSecret,
  type LoadedInfrastructureConnection,
} from "./connection-store";
import {
  buildUserProxmoxEnvironment,
  InfrastructureNetworkError,
  resolveValidatedSshDestination,
  type ValidatedSshDestination,
} from "./connection-runtime";
import { isProxmoxDeploymentTarget, type DeploymentTargetDto, type ProxmoxDeploymentTargetDto } from "./contracts";
import { resolveProxmoxHostCapacityPolicy } from "./host-capacity-policy";
import {
  PORTABLE_HIVRA_PROVISIONER_DIRECTORY,
  isCompatibleProxmoxProvisionerVersion,
} from "./portable-provisioner-contract";

export {
  PORTABLE_HIVRA_PROVISIONER_DIRECTORY,
  PORTABLE_HIVRA_PROVISIONER_VERSION,
} from "./portable-provisioner-contract";

export type SelfManagedTargetSelection = {
  connectionId: string;
  targetId: string;
  expectedConnectionRevision: number;
  purpose?: "lifecycle" | "teardown";
};

export type PortableProxmoxRuntime = {
  node: string;
  bridge: string;
  storage: string;
  vmidStart: number;
  vmidEnd: number;
  ipLastOctetStart: number;
  subnetPrefix: string;
  gateway: string;
  provisionerDirectory: string;
  provisionerVersion: string;
  ubuntuImage: string;
  vmSshKeyPath: string;
  logDirectory: string;
};

export type SelfManagedProxmoxExecutionContext = {
  kind: "self-managed";
  connectionId: string;
  targetId: string;
  connectionRevision: number;
  target: ProxmoxDeploymentTargetDto;
  env: Record<string, string | undefined>;
  runtime: PortableProxmoxRuntime;
  capacityPolicy?: ReturnType<typeof resolveProxmoxHostCapacityPolicy>;
};

export type ProxmoxExecutionContextErrorCode =
  | "binding_invalid"
  | "connection_not_found"
  | "connection_not_ready"
  | "connection_stale"
  | "credential_unavailable"
  | "target_not_found"
  | "target_not_ready"
  | "target_mismatch"
  | "network_unavailable";

export class ProxmoxExecutionContextError extends Error {
  constructor(public readonly code: ProxmoxExecutionContextErrorCode) {
    super(`Portable Proxmox execution context unavailable: ${code}`);
    this.name = "ProxmoxExecutionContextError";
  }
}

type Dependencies = {
  loadConnection: typeof loadInfrastructureConnectionSecret;
  getTarget: typeof getInfrastructureDeploymentTarget;
  resolveDestination: typeof resolveValidatedSshDestination;
};

const defaultDependencies: Dependencies = {
  loadConnection: loadInfrastructureConnectionSecret,
  getTarget: getInfrastructureDeploymentTarget,
  resolveDestination: resolveValidatedSshDestination,
};

function mapStoreError(
  error: unknown,
  missingCode: "connection_not_found" | "target_not_found",
): ProxmoxExecutionContextError {
  if (error instanceof InfrastructureConnectionStoreError) {
    if (error.code === "not_found") return new ProxmoxExecutionContextError(missingCode);
    if (error.code === "credential_error") {
      return new ProxmoxExecutionContextError("credential_unavailable");
    }
  }
  return new ProxmoxExecutionContextError("credential_unavailable");
}

function runtimeFrom(
  connection: LoadedInfrastructureConnection,
  target: ProxmoxDeploymentTargetDto,
  purpose: "lifecycle" | "teardown",
): PortableProxmoxRuntime {
  const vmidRange = target.capabilities.vmidRange;
  const bridge = target.capabilities.selectedBridge;
  const storage = target.capabilities.selectedStorage;
  const provisioner = target.capabilities.provisioner;
  if (!bridge || !storage || !provisioner?.ready || !provisioner.version) {
    throw new ProxmoxExecutionContextError("target_not_ready");
  }

  const expectedProvisioner = connection.configuration?.provisioner;
  const provisionerDirectory =
    expectedProvisioner?.directory ?? PORTABLE_HIVRA_PROVISIONER_DIRECTORY;
  const provisionerVersion =
    expectedProvisioner?.expectedVersion ?? provisioner.version;
  // Cleanup uses a separate ownership-checked script, not the installed
  // provisioner. Preserve existing Advanced cleanup with an explicit version
  // pin, but do not infer new authority from unknown Simple-mode observations.
  const explicitlyPinnedTeardown = purpose === "teardown"
    && connection.setupMode === "advanced"
    && expectedProvisioner?.expectedVersion !== undefined;
  if (!explicitlyPinnedTeardown && !isCompatibleProxmoxProvisionerVersion(provisionerVersion)) {
    throw new ProxmoxExecutionContextError("target_not_ready");
  }
  if (provisioner.version !== provisionerVersion) {
    throw new ProxmoxExecutionContextError("target_not_ready");
  }

  // Simple host preparation owns this isolated /24. Advanced portable targets
  // currently use the same network contract; arbitrary network overrides are
  // intentionally not accepted until the preflight can prove them.
  const subnetPrefix = "10.251.20";
  return {
    node: target.externalId,
    bridge,
    storage,
    vmidStart: vmidRange.start,
    vmidEnd: vmidRange.end,
    ipLastOctetStart: 50,
    subnetPrefix,
    gateway: `${subnetPrefix}.1`,
    provisionerDirectory,
    provisionerVersion,
    ubuntuImage: "/var/lib/vz/template/iso/hivra-ubuntu-jammy.img",
    vmSshKeyPath: "/etc/hivra/keys/vm-orchestrator",
    logDirectory: "/var/log/hivra",
  };
}

export async function resolveSelfManagedProxmoxExecutionContext(
  userId: string,
  selection: SelfManagedTargetSelection,
  dependencies: Partial<Dependencies> = {},
): Promise<SelfManagedProxmoxExecutionContext> {
  if (
    !userId ||
    !selection.connectionId ||
    !selection.targetId ||
    !Number.isSafeInteger(selection.expectedConnectionRevision) ||
    selection.expectedConnectionRevision < 1
  ) {
    throw new ProxmoxExecutionContextError("binding_invalid");
  }
  const deps = { ...defaultDependencies, ...dependencies };
  const purpose = selection.purpose ?? "lifecycle";

  let connection: LoadedInfrastructureConnection;
  try {
    connection = await deps.loadConnection(userId, selection.connectionId);
  } catch (error) {
    throw mapStoreError(error, "connection_not_found");
  }

  let target: DeploymentTargetDto;
  try {
    target = await deps.getTarget(userId, selection.targetId);
  } catch (error) {
    throw mapStoreError(error, "target_not_found");
  }

  if (target.connectionId !== connection.id) {
    throw new ProxmoxExecutionContextError("target_mismatch");
  }
  // Teardown must reject provider VMs too: it cannot interpret a provider ID
  // as a Proxmox node/VMID or borrow the managed environment as a fallback.
  if (!isProxmoxDeploymentTarget(target)) {
    throw new ProxmoxExecutionContextError("target_mismatch");
  }
  if (purpose === "lifecycle" && connection.status !== "ready") {
    throw new ProxmoxExecutionContextError("connection_not_ready");
  }
  const exactRevisionAuthority =
    connection.revision === selection.expectedConnectionRevision &&
    target.evidenceConnectionRevision === connection.revision;
  // A credential-only recovery keeps the endpoint, fingerprint, connection,
  // target, and provider binding immutable while moving the encrypted key to
  // N+1. Until preflight succeeds and atomically rebinds idle agents, teardown
  // may use that new key against the exact N target evidence. Launch/lifecycle
  // never receive this bridge and remain fail-closed on unavailable readiness.
  const credentialRecoveryTeardownAuthority =
    purpose === "teardown" &&
    connection.pendingBindingRebindFromRevision === selection.expectedConnectionRevision &&
    connection.revision > selection.expectedConnectionRevision &&
    target.evidenceConnectionRevision === selection.expectedConnectionRevision;
  if (!exactRevisionAuthority && !credentialRecoveryTeardownAuthority) {
    throw new ProxmoxExecutionContextError("connection_stale");
  }
  if (purpose === "lifecycle" && (
    target.status !== "ready" ||
    !target.capabilities.launchReady ||
    !target.capabilities.directRootAccess ||
    !target.capabilities.kvmAvailable ||
    target.isolationClass !== "hardware-vm" ||
    !target.supportedIsolationDrivers.includes("proxmox-kvm")
  )) {
    throw new ProxmoxExecutionContextError("target_not_ready");
  }

  let destination: ValidatedSshDestination;
  try {
    destination = await deps.resolveDestination(connection.endpoint.sshHost);
  } catch (error) {
    if (error instanceof InfrastructureNetworkError) {
      throw new ProxmoxExecutionContextError("network_unavailable");
    }
    throw new ProxmoxExecutionContextError("network_unavailable");
  }

  const runtime = runtimeFrom(connection, target, purpose);
  const env = buildUserProxmoxEnvironment(
    {
      id: connection.id,
      sshHost: connection.endpoint.sshHost,
      sshPort: connection.endpoint.sshPort,
      sshUser: connection.endpoint.sshUser,
      sshHostFingerprintSha256: connection.endpoint.sshHostFingerprintSha256,
      sshPrivateKey: connection.credentials.sshPrivateKey,
      node: runtime.node,
      vmidStart: runtime.vmidStart,
      vmidEnd: runtime.vmidEnd,
      bridge: runtime.bridge,
      storage: runtime.storage,
    },
    destination,
  );
  env.PROXMOX_PRIVATE_SUBNET_PREFIX = runtime.subnetPrefix;
  env.PROXMOX_PRIVATE_GATEWAY = runtime.gateway;
  env.PROXMOX_IP_LAST_OCTET_START = String(runtime.ipLastOctetStart);

  return {
    kind: "self-managed",
    connectionId: connection.id,
    targetId: target.id,
    connectionRevision: connection.revision,
    target,
    env,
    runtime,
    capacityPolicy: resolveProxmoxHostCapacityPolicy(connection.configuration?.capacityPolicy),
  };
}
