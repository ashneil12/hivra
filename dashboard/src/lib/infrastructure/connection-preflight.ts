import "server-only";

import { randomUUID } from "node:crypto";

import { runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";
import { PROXMOX_NEEDS_ROOT_COPY, PROXMOX_SUDO_TRANSPORT_READY } from "./sudo-transport-gate";

import {
  buildUserProxmoxEnvironment,
  InfrastructureNetworkError,
  resolveValidatedSshDestination,
} from "./connection-runtime";
import {
  beginInfrastructureConnectionPreflight,
  completeInfrastructureConnectionPreflight,
  invalidateInfrastructureConnectionPreflight,
  loadInfrastructureConnectionSecret,
  InfrastructureConnectionStoreError,
  type InfrastructurePreflightCompletion,
  type InfrastructurePreflightTargetEvidence,
  type LoadedInfrastructureConnection,
} from "./connection-store";
import {
  InfrastructurePreflightTargetEvidenceSchema,
  ProxmoxPreflightResultSchema,
  type ProxmoxPreflightErrorCode,
  type ProxmoxPreflightResult,
} from "./contracts";
import {
  MAX_PROXMOX_PREFLIGHT_OUTPUT_BYTES,
  runPortableProxmoxPreflight,
  type PortableProxmoxPreflightInput,
  type ProxmoxPreflightIssue,
  type ProxmoxPreflightReport,
  type PortableProxmoxPreflightOutcome,
} from "./proxmox-preflight";
import {
  PORTABLE_HIVRA_PROVISIONER_DIRECTORY,
  PORTABLE_HIVRA_PROVISIONER_VERSION,
  PORTABLE_HIVRA_COMPATIBLE_PROXMOX_VERSIONS,
  isCompatibleProxmoxProvisionerVersion,
  PORTABLE_HIVRA_SIMPLE_BRIDGE,
  PORTABLE_HIVRA_SIMPLE_REQUIRED_ASSETS,
  PORTABLE_HIVRA_SIMPLE_VMID_RANGE,
  portableHivraRequiredAssetsForProvisionerDirectory,
  portableRuntimeCompatibilityForProvisioner,
} from "./portable-provisioner-contract";
import { resolveProxmoxHostCapacityPolicy } from "./host-capacity-policy";
import { blockedAddressRemediation, internalFailureRemediation } from "./remediation-copy";

type PreflightDependencies = {
  loadConnection: typeof loadInfrastructureConnectionSecret;
  beginPreflight: typeof beginInfrastructureConnectionPreflight;
  completePreflight: typeof completeInfrastructureConnectionPreflight;
  invalidatePreflight: typeof invalidateInfrastructureConnectionPreflight;
  resolveDestination: typeof resolveValidatedSshDestination;
  runPreflight: typeof runPortableProxmoxPreflight;
  executeHostScript: typeof runProxmoxHostScript;
  now: () => Date;
  newRunId: () => string;
};

const PUBLIC_ERROR_COPY: Record<
  ProxmoxPreflightErrorCode,
  { message: string; remediation?: string }
> = {
  INVALID_CONNECTION: {
    message: "The infrastructure connection is incomplete or invalid.",
    remediation: "Review the connection settings and save them again.",
  },
  CONNECTION_NOT_FOUND: { message: "The infrastructure connection was not found." },
  HOST_RESOLUTION_FAILED: {
    message: "The SSH host could not be resolved.",
    remediation: "Check the hostname and its DNS records.",
  },
  HOST_ADDRESS_BLOCKED: {
    message: "The SSH host resolves to an address this control plane cannot reach.",
    // Mode-dependent; see preflightErrorCopy.
  },
  SSH_HOST_KEY_MISMATCH: {
    message: "The server identity did not match the pinned SSH fingerprint.",
    remediation: "Verify the host fingerprint out of band before updating this connection.",
  },
  SSH_AUTHENTICATION_FAILED: {
    message: "SSH authentication failed.",
    remediation: "Check the SSH user and private key installed on the Proxmox host.",
  },
  SSH_CONNECTION_FAILED: {
    message: "The Proxmox host could not be reached over SSH.",
    remediation: "Check the host, SSH port, firewall, and network access.",
  },
  SSH_COMMAND_FAILED: {
    message: "The read-only SSH preflight command did not complete.",
    remediation: "Check the SSH account permissions and Proxmox host logs.",
  },
  PROXMOX_UNAVAILABLE: {
    message: "The connected host did not expose the required Proxmox tools.",
    remediation: "Connect a prepared Proxmox VE host.",
  },
  PROXMOX_VERSION_UNSUPPORTED: {
    message: "The detected Proxmox version is not supported.",
    remediation: "Upgrade the target to a supported Proxmox VE release.",
  },
  PROXMOX_PERMISSION_UNAVAILABLE: {
    message: "The SSH account cannot run the required Proxmox lifecycle commands.",
    // Gate-dependent; see preflightErrorCopy.
  },
  NODE_UNAVAILABLE: {
    message: "The Proxmox node could not be inspected.",
    remediation: "Check the configured node name and SSH account permissions.",
  },
  KVM_UNAVAILABLE: {
    message: "Hardware-backed KVM isolation is unavailable on this target.",
    remediation: "Turn on virtualization (VT-x or AMD-V) in the server's firmware, or nested virtualization with your provider, so /dev/kvm exists. Then check again.",
  },
  BRIDGE_UNAVAILABLE: {
    message: "No usable Proxmox network bridge was found.",
    remediation: "Choose Review setup to create Hivra's private network on this server. Using your own bridge? Create it in the Proxmox web UI under your node → System → Network → Create → Linux Bridge, apply it, then check again.",
  },
  STORAGE_UNAVAILABLE: {
    message: "No usable Proxmox VM storage was found.",
    remediation: "In the Proxmox web UI, open Datacenter → Storage and make sure one storage is enabled, active and allows Disk image content (for example local-lvm). Then check again.",
  },
  TEMPLATE_UNAVAILABLE: {
    message: "The configured VM template is not ready.",
    remediation: "In the Proxmox web UI, convert the VM this connection names into a template (right-click → Convert to template), or edit the connection to name another one. Then check again.",
  },
  PROVISIONER_UNAVAILABLE: {
    message: "The portable provisioner is not ready on this target.",
    remediation: "Choose Review setup to install Hivra's host tools on this server, then check again.",
  },
  VMID_RANGE_UNAVAILABLE: {
    message: "The configured VMID range has no free IDs.",
    remediation: "Every VM ID this connection may use is taken. Remove VMs you no longer need from that range in the Proxmox web UI, then check again.",
  },
  CAPACITY_UNAVAILABLE: {
    message: "The target capacity could not be measured safely.",
    remediation: "Check the node and storage status in the Proxmox web UI, then check again.",
  },
  PREFLIGHT_SUPERSEDED: {
    message: "A newer connection change or preflight replaced this check.",
    remediation: "Use the newest result, or check again.",
  },
  PREFLIGHT_INTERNAL_ERROR: {
    message: "The infrastructure preflight could not be completed.",
    // Mode-dependent; see preflightErrorCopy.
  },
};

// A legacy Advanced connection names its own bridge and host-tools directory,
// and Review setup (Simple only) cannot fix those; its owner fixes them.
const ADVANCED_REMEDIATION: Partial<Record<ProxmoxPreflightErrorCode, string>> = {
  BRIDGE_UNAVAILABLE: "Create the bridge this connection names in the Proxmox web UI under your node → System → Network → Create → Linux Bridge, apply it, then check again.",
  PROVISIONER_UNAVAILABLE: "Install Hivra's host tools in the directory this connection names, or switch the connection to Simple so Review setup can install them. Then check again.",
};

/** The public copy for a code, with fix text that fits how Hivra is run:
 * hosted owners are never told to read server logs or change network policy,
 * and nobody is sent to a setup mode their connection doesn't have. */
function preflightErrorCopy(
  code: ProxmoxPreflightErrorCode,
  setupMode: "simple" | "advanced" = "simple",
): { message: string; remediation?: string } {
  const copy = PUBLIC_ERROR_COPY[code];
  if (code === "HOST_ADDRESS_BLOCKED") return { ...copy, remediation: blockedAddressRemediation() };
  if (code === "PREFLIGHT_INTERNAL_ERROR") return { ...copy, remediation: internalFailureRemediation() };
  if (code === "PROXMOX_PERMISSION_UNAVAILABLE") {
    return {
      ...copy,
      remediation: PROXMOX_SUDO_TRANSPORT_READY
        ? "Connect as root, or as a user with passwordless sudo, then check again."
        : `${PROXMOX_NEEDS_ROOT_COPY} Edit the connection, set the SSH user to root, then check again.`,
    };
  }
  const advanced = setupMode === "advanced" ? ADVANCED_REMEDIATION[code] : undefined;
  return advanced ? { ...copy, remediation: advanced } : copy;
}

const PREFLIGHT_ISSUE_CODES: Record<string, ProxmoxPreflightErrorCode> = {
  PROXMOX_TOOL_PVEVERSION_MISSING: "PROXMOX_UNAVAILABLE",
  PROXMOX_TOOL_PVESH_MISSING: "PROXMOX_UNAVAILABLE",
  PROXMOX_TOOL_QM_MISSING: "PROXMOX_UNAVAILABLE",
  PROXMOX_TOOL_PVESM_MISSING: "PROXMOX_UNAVAILABLE",
  PROXMOX_TOOL_IP_MISSING: "BRIDGE_UNAVAILABLE",
  PROXMOX_TOOL_BASE64_MISSING: "PROXMOX_UNAVAILABLE",
  PROXMOX_TOOL_ID_MISSING: "PROXMOX_PERMISSION_UNAVAILABLE",
  PROXMOX_ROOT_PERMISSION_REQUIRED: "PROXMOX_PERMISSION_UNAVAILABLE",
  PROXMOX_VERSION_UNAVAILABLE: "PROXMOX_UNAVAILABLE",
  PROXMOX_VERSION_UNSUPPORTED: "PROXMOX_VERSION_UNSUPPORTED",
  PROXMOX_NODE_UNAVAILABLE: "NODE_UNAVAILABLE",
  PROXMOX_NODE_MISMATCH: "NODE_UNAVAILABLE",
  PROXMOX_NODE_STATUS_UNAVAILABLE: "NODE_UNAVAILABLE",
  PROXMOX_KVM_UNAVAILABLE: "KVM_UNAVAILABLE",
  PROXMOX_CPU_VIRTUALIZATION_UNAVAILABLE: "KVM_UNAVAILABLE",
  PROXMOX_CPU_CAPACITY_UNAVAILABLE: "CAPACITY_UNAVAILABLE",
  PROXMOX_MEMORY_CAPACITY_UNAVAILABLE: "CAPACITY_UNAVAILABLE",
  PROXMOX_MEMORY_CAPACITY_EXHAUSTED: "CAPACITY_UNAVAILABLE",
  PROXMOX_STORAGE_UNAVAILABLE: "STORAGE_UNAVAILABLE",
  PROXMOX_STORAGE_NOT_FOUND: "STORAGE_UNAVAILABLE",
  PROXMOX_STORAGE_INACTIVE: "STORAGE_UNAVAILABLE",
  PROXMOX_STORAGE_DISABLED: "STORAGE_UNAVAILABLE",
  PROXMOX_STORAGE_NOT_VM_CAPABLE: "STORAGE_UNAVAILABLE",
  PROXMOX_STORAGE_CAPACITY_UNAVAILABLE: "CAPACITY_UNAVAILABLE",
  PROXMOX_STORAGE_CAPACITY_EXHAUSTED: "CAPACITY_UNAVAILABLE",
  PROXMOX_BRIDGE_UNAVAILABLE: "BRIDGE_UNAVAILABLE",
  PROXMOX_BRIDGE_NOT_FOUND: "BRIDGE_UNAVAILABLE",
  PROXMOX_VMID_INVENTORY_UNAVAILABLE: "VMID_RANGE_UNAVAILABLE",
  PROXMOX_VMID_RANGE_EXHAUSTED: "VMID_RANGE_UNAVAILABLE",
  PROXMOX_PREPARED_TARGET_UNSPECIFIED: "PROVISIONER_UNAVAILABLE",
  PROXMOX_TEMPLATE_MISSING: "TEMPLATE_UNAVAILABLE",
  PROXMOX_TEMPLATE_NOT_TEMPLATE: "TEMPLATE_UNAVAILABLE",
  PROXMOX_TEMPLATE_NAME_MISMATCH: "TEMPLATE_UNAVAILABLE",
  PROXMOX_PROVISIONER_VERSION_REQUIRED: "PROVISIONER_UNAVAILABLE",
  PROXMOX_PROVISIONER_VERSION_MISSING: "PROVISIONER_UNAVAILABLE",
  PROXMOX_PROVISIONER_VERSION_MISMATCH: "PROVISIONER_UNAVAILABLE",
  PROXMOX_PROVISIONER_MANIFEST_INVALID: "PROVISIONER_UNAVAILABLE",
  PROXMOX_REQUIRED_ASSET_MISSING: "PROVISIONER_UNAVAILABLE",
};

function publicFailure(
  connectionId: string,
  checkedAt: string,
  code: ProxmoxPreflightErrorCode,
  unmetRequirements?: Array<{ code: ProxmoxPreflightErrorCode; message: string }>,
  setupMode?: "simple" | "advanced",
): ProxmoxPreflightResult {
  const copy = preflightErrorCopy(code, setupMode);
  return ProxmoxPreflightResultSchema.parse({
    ok: false,
    connectionId,
    checkedAt,
    error: { code, ...copy },
    unmetRequirements: unmetRequirements ?? [{ code, message: copy.message }],
  });
}

function mappedRequirements(
  issues: ProxmoxPreflightIssue[],
): Array<{ code: ProxmoxPreflightErrorCode; message: string }> {
  const seen = new Set<string>();
  const result: Array<{ code: ProxmoxPreflightErrorCode; message: string }> = [];
  for (const issue of issues) {
    const code = PREFLIGHT_ISSUE_CODES[issue.code] ?? "PREFLIGHT_INTERNAL_ERROR";
    const key = `${code}:${issue.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ code, message: issue.message.slice(0, 500) });
    if (result.length === 20) break;
  }
  return result;
}

function topReportError(report: ProxmoxPreflightReport): ProxmoxPreflightErrorCode {
  const first = report.unmetRequirements[0];
  return first ? PREFLIGHT_ISSUE_CODES[first.code] ?? "PREFLIGHT_INTERNAL_ERROR" : "PREFLIGHT_INTERNAL_ERROR";
}

function classifyTransportFailure(error: string | undefined): ProxmoxPreflightErrorCode {
  const normalized = error?.toLowerCase() ?? "";
  if (/(host key|host denied|fingerprint|verification failed)/.test(normalized)) {
    return "SSH_HOST_KEY_MISMATCH";
  }
  if (/(authentication|no supported auth|all configured authentication)/.test(normalized)) {
    return "SSH_AUTHENTICATION_FAILED";
  }
  if (/(output exceeded|capture budget)/.test(normalized)) return "SSH_COMMAND_FAILED";
  if (/(ssh exec|remote bash)/.test(normalized)) return "SSH_COMMAND_FAILED";
  return "SSH_CONNECTION_FAILED";
}

function preflightInput(connection: LoadedInfrastructureConnection): PortableProxmoxPreflightInput {
  const configuration = connection.configuration;
  if (connection.setupMode === "simple") {
    return {
      node: null,
      bridge: PORTABLE_HIVRA_SIMPLE_BRIDGE,
      storage: null,
      vmidRange: { ...PORTABLE_HIVRA_SIMPLE_VMID_RANGE },
      ...(configuration?.capacityPolicy
        ? { capacityPolicy: resolveProxmoxHostCapacityPolicy(configuration.capacityPolicy) }
        : {}),
      preparedTarget: {
        templateVmid: null,
        templateExpectedName: null,
        provisioner: {
          directory: PORTABLE_HIVRA_PROVISIONER_DIRECTORY,
          expectedVersion: PORTABLE_HIVRA_PROVISIONER_VERSION,
          compatibleVersions: [...PORTABLE_HIVRA_COMPATIBLE_PROXMOX_VERSIONS],
          manifestFile: "BUNDLE.sha256",
        },
        requiredAssets: PORTABLE_HIVRA_SIMPLE_REQUIRED_ASSETS.map((asset) => ({ ...asset })),
      },
    };
  }
  const configuredProvisioner = configuration?.provisioner;
  const usesVendoredProvisionerContract =
    isCompatibleProxmoxProvisionerVersion(configuredProvisioner?.expectedVersion);
  return {
    node: configuration?.node ?? null,
    bridge: configuration?.bridge ?? null,
    storage: configuration?.storage ?? null,
    vmidRange: configuration?.vmidRange ?? { start: 200, end: 399 },
    ...(configuration?.capacityPolicy
      ? { capacityPolicy: resolveProxmoxHostCapacityPolicy(configuration.capacityPolicy) }
      : {}),
    preparedTarget: configuration?.template || configuration?.provisioner
      ? {
          templateVmid: configuration.template?.vmid ?? null,
          templateExpectedName: configuration.template?.expectedName ?? null,
          provisioner: configuredProvisioner
            ? {
                directory: configuredProvisioner.directory,
                expectedVersion: configuredProvisioner.expectedVersion,
                ...(usesVendoredProvisionerContract
                  ? { manifestFile: "BUNDLE.sha256" }
                  : {}),
              }
            : null,
          requiredAssets: usesVendoredProvisionerContract && configuredProvisioner
            ? portableHivraRequiredAssetsForProvisionerDirectory(
                configuredProvisioner.directory,
              )
            : [],
        }
      : null,
  };
}

function capacityPolicyEvidence(
  report: ProxmoxPreflightReport,
): NonNullable<ProxmoxPreflightReport["capacity"]["policy"]> {
  if (report.capacity.policy) return report.capacity.policy;
  const activeFloorMemoryBytes = report.capacity.memory.reservedGuestBytes;
  const floorMemoryHeadroomBytes = report.capacity.memory.availableBytes;
  return {
    mode: "observe",
    cpuCeilingDensity: 1,
    memoryCeilingDensity: 1,
    activeFloorMemoryBytes,
    activeCeilingMemoryBytes: activeFloorMemoryBytes,
    activeCeilingCpu: report.capacity.cpu.totalCores === null ? null : 0,
    floorMemoryHeadroomBytes,
    ceilingMemoryHeadroomBytes: floorMemoryHeadroomBytes,
    ceilingCpuHeadroom: report.capacity.cpu.totalCores,
  };
}

function publicSuccess(
  connection: LoadedInfrastructureConnection,
  report: ProxmoxPreflightReport,
  checkedAt: string,
): ProxmoxPreflightResult | null {
  const node = report.node.id;
  const version = report.node.proxmoxVersion;
  const cpu = report.capacity.cpu;
  const memory = report.capacity.memory;
  const storage = report.capacity.storage;
  const policy = capacityPolicyEvidence(report);
  const kvmAvailable = report.capabilities.kvmDevice && report.capabilities.cpuVirtualization;
  if (
    !node ||
    !version ||
    !kvmAvailable ||
    cpu.totalCores === null ||
    cpu.utilizationRatio === null ||
    memory.totalBytes === null ||
    memory.availableBytes === null ||
    memory.availableBytes > memory.totalBytes ||
    policy.activeFloorMemoryBytes === null ||
    policy.activeCeilingMemoryBytes === null ||
    policy.activeCeilingCpu === null ||
    policy.floorMemoryHeadroomBytes === null ||
    policy.ceilingMemoryHeadroomBytes === null ||
    policy.ceilingCpuHeadroom === null ||
    !storage ||
    storage.totalBytes === null ||
    storage.availableBytes === null ||
    storage.availableBytes > storage.totalBytes ||
    !report.capabilities.selectedBridge ||
    !report.capabilities.selectedStorage
  ) {
    return null;
  }

  const configuredProvisioner = connection.setupMode === "simple"
    ? {
        directory: PORTABLE_HIVRA_PROVISIONER_DIRECTORY,
        expectedVersion: PORTABLE_HIVRA_PROVISIONER_VERSION,
      }
    : connection.configuration?.provisioner;
  const provisionerEvidence = report.capabilities.preparedTarget.provisioner;
  const provisioner = configuredProvisioner
    ? {
        ready: Boolean(provisionerEvidence?.ready),
        version: provisionerEvidence?.version ?? null,
      }
    : null;
  const launchReady = report.launchReady && provisioner?.ready !== false;

  const unmetRequirements = mappedRequirements(report.unmetRequirements);
  const warnings = unmetRequirements.map((issue) => issue.message);

  return ProxmoxPreflightResultSchema.parse({
    ok: true,
    connectionId: connection.id,
    checkedAt,
    target: {
      externalId: node,
      displayName: `${connection.name} / ${node}`.slice(0, 128),
      proxmoxVersion: version.slice(0, 64),
      launchReady,
      capacity: {
        cpu: { totalCores: cpu.totalCores, utilizationRatio: cpu.utilizationRatio },
        memoryBytes: { total: memory.totalBytes, available: memory.availableBytes },
        storageBytes: { total: storage.totalBytes, available: storage.availableBytes },
        ...(report.capacity.policy ? { policy: {
            ...policy,
            hostMemoryReserveBytes: report.capacity.memory.hostReserveBytes,
            activeFloorMemoryBytes: policy.activeFloorMemoryBytes!,
            activeCeilingMemoryBytes: policy.activeCeilingMemoryBytes!,
            activeCeilingCpu: policy.activeCeilingCpu!,
            floorMemoryHeadroomBytes: policy.floorMemoryHeadroomBytes!,
            ceilingMemoryHeadroomBytes: policy.ceilingMemoryHeadroomBytes!,
            ceilingCpuHeadroom: policy.ceilingCpuHeadroom!,
          } } : {}),
      },
      capabilities: {
        isolationDrivers: ["proxmox-kvm"],
        isolationClass: "hardware-vm",
        kvmAvailable: true,
        bridges: report.capabilities.bridges,
        storages: report.capabilities.storage.map((entry) => entry.id),
        template: report.capabilities.preparedTarget.template
          ? {
              vmid: report.capabilities.preparedTarget.template.vmid,
              ready:
                report.capabilities.preparedTarget.template.exists &&
                report.capabilities.preparedTarget.template.isTemplate &&
                report.capabilities.preparedTarget.template.nameMatches,
            }
          : null,
        provisioner,
        runtimeCompatibility: report.capabilities.preparedTarget.ready
          ? portableRuntimeCompatibilityForProvisioner(provisioner)
          : null,
        vmidRange: {
          start: report.capacity.vmids.start,
          end: report.capacity.vmids.end,
          freeCount: report.capacity.vmids.availableCount,
        },
      },
    },
    warnings: warnings.slice(0, 20),
    unmetRequirements,
  });
}

const DEFAULT_DEPENDENCIES: PreflightDependencies = {
  loadConnection: loadInfrastructureConnectionSecret,
  beginPreflight: beginInfrastructureConnectionPreflight,
  completePreflight: completeInfrastructureConnectionPreflight,
  invalidatePreflight: invalidateInfrastructureConnectionPreflight,
  resolveDestination: resolveValidatedSshDestination,
  runPreflight: runPortableProxmoxPreflight,
  executeHostScript: runProxmoxHostScript,
  now: () => new Date(),
  newRunId: randomUUID,
};

function targetEvidenceFromReport(
  connection: LoadedInfrastructureConnection,
  report: ProxmoxPreflightReport,
  result: ProxmoxPreflightResult,
): InfrastructurePreflightTargetEvidence | null {
  if (!report.node.id) return null;
  const launchReady = result.ok && result.target.launchReady;
  const kvmAvailable = report.capabilities.kvmDevice && report.capabilities.cpuVirtualization;
  const errorCode = launchReady
    ? null
    : !result.ok
      ? result.error.code
      : report.unmetRequirements.length > 0
        ? topReportError(report)
        : result.target.capabilities.provisioner?.ready === false
          ? "PROVISIONER_UNAVAILABLE"
          : result.target.capabilities.template?.ready === false
            ? "TEMPLATE_UNAVAILABLE"
            : "PREFLIGHT_INTERNAL_ERROR";
  const supportedIsolationDrivers = report.connectionReady && kvmAvailable
    ? report.capabilities.supportedIsolationDrivers
    : [];
  const template = report.capabilities.preparedTarget.template;
  const policy = capacityPolicyEvidence(report);

  return InfrastructurePreflightTargetEvidenceSchema.parse({
    externalId: report.node.id,
    displayName: `${connection.name} / ${report.node.id}`.slice(0, 128),
    status: launchReady ? "ready" : "unavailable",
    capacity: {
      cpu: {
        totalCores: report.capacity.cpu.totalCores,
        utilizationRatio: report.capacity.cpu.utilizationRatio,
      },
      memoryBytes: {
        total: report.capacity.memory.totalBytes,
        available: report.capacity.memory.availableBytes,
      },
      storageBytes: report.capacity.storage
        ? {
            total: report.capacity.storage.totalBytes,
            available: report.capacity.storage.availableBytes,
          }
        : null,
      ...(report.capacity.policy ? { policy: policy.activeFloorMemoryBytes === null
        || policy.activeCeilingMemoryBytes === null
        || policy.activeCeilingCpu === null
        || policy.floorMemoryHeadroomBytes === null
        || policy.ceilingMemoryHeadroomBytes === null
        || policy.ceilingCpuHeadroom === null
        ? null
        : {
            ...policy,
            hostMemoryReserveBytes: report.capacity.memory.hostReserveBytes,
            activeFloorMemoryBytes: policy.activeFloorMemoryBytes,
            activeCeilingMemoryBytes: policy.activeCeilingMemoryBytes,
            activeCeilingCpu: policy.activeCeilingCpu,
            floorMemoryHeadroomBytes: policy.floorMemoryHeadroomBytes,
            ceilingMemoryHeadroomBytes: policy.ceilingMemoryHeadroomBytes,
            ceilingCpuHeadroom: policy.ceilingCpuHeadroom,
          } } : {}),
    },
    capabilities: {
      proxmoxVersion: report.node.proxmoxVersion?.slice(0, 64) ?? null,
      launchReady,
      directRootAccess: report.capabilities.directRootAccess,
      kvmAvailable,
      bridges: report.capabilities.bridges,
      selectedBridge: report.capabilities.selectedBridge,
      storages: report.capabilities.storage.map((entry) => entry.id),
      selectedStorage: report.capabilities.selectedStorage,
      template: template
        ? {
            ...template,
            ready: template.exists && template.isTemplate && template.nameMatches,
          }
        : null,
      provisioner: report.capabilities.preparedTarget.provisioner,
      runtimeCompatibility: report.capabilities.preparedTarget.ready
        ? portableRuntimeCompatibilityForProvisioner(
            report.capabilities.preparedTarget.provisioner,
          )
        : null,
      vmidRange: {
        start: report.capacity.vmids.start,
        end: report.capacity.vmids.end,
        freeCount: report.capacity.vmids.availableCount,
        firstAvailable: report.capacity.vmids.firstAvailable,
      },
      issues: mappedRequirements(report.unmetRequirements),
    },
    supportedIsolationDrivers,
    isolationClass: supportedIsolationDrivers.length > 0 ? "hardware-vm" : null,
    lastErrorCode: errorCode,
  });
}

function supersededFailure(connectionId: string, checkedAt: string): ProxmoxPreflightResult {
  return publicFailure(connectionId, checkedAt, "PREFLIGHT_SUPERSEDED");
}

export async function preflightInfrastructureConnection(
  userId: string,
  connectionId: string,
  dependencies: Partial<PreflightDependencies> = {},
  expectedConnectionRevision?: number,
): Promise<ProxmoxPreflightResult> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const checkedAt = deps.now().toISOString();
  let connection: LoadedInfrastructureConnection;

  try {
    connection = await deps.loadConnection(userId, connectionId);
  } catch (error) {
    const storeError = error instanceof InfrastructureConnectionStoreError ? error : null;
    const code =
      storeError?.code === "not_found"
        ? "CONNECTION_NOT_FOUND"
        : storeError?.code === "credential_error"
          ? "INVALID_CONNECTION"
          : "PREFLIGHT_INTERNAL_ERROR";
    if (code === "INVALID_CONNECTION" && storeError?.connectionRevision != null) {
      try {
        const invalidated = await deps.invalidatePreflight(
          userId,
          connectionId,
          storeError.connectionRevision,
          checkedAt,
          code,
        );
        if (!invalidated) return supersededFailure(connectionId, checkedAt);
      } catch {
        return publicFailure(connectionId, checkedAt, "PREFLIGHT_INTERNAL_ERROR");
      }
    }
    return publicFailure(connectionId, checkedAt, code);
  }
  if (
    expectedConnectionRevision !== undefined &&
    connection.revision !== expectedConnectionRevision
  ) {
    return supersededFailure(connectionId, checkedAt);
  }
  // Release gate T43: Proxmox preflight refuses sudo connections before any
  // SSH until early finish is proven under sudo.
  if (connection.endpoint.sshPrivilege === "sudo" && !PROXMOX_SUDO_TRANSPORT_READY) {
    return publicFailure(connectionId, checkedAt, "PROXMOX_PERMISSION_UNAVAILABLE");
  }

  const runId = deps.newRunId();
  let leaseClaimed = false;
  try {
    leaseClaimed = await deps.beginPreflight(
      userId,
      connectionId,
      connection.revision,
      runId,
      checkedAt,
    );
    if (!leaseClaimed) return supersededFailure(connectionId, checkedAt);

    const destination = await deps.resolveDestination(connection.endpoint.sshHost);
    const input = preflightInput(connection);
    const env = buildUserProxmoxEnvironment(
      {
        id: connection.id,
        sshHost: connection.endpoint.sshHost,
        sshPort: connection.endpoint.sshPort,
        sshUser: connection.endpoint.sshUser,
        sshHostFingerprintSha256: connection.endpoint.sshHostFingerprintSha256,
        sshPrivateKey: connection.credentials.sshPrivateKey,
        sshPrivilege: connection.endpoint.sshPrivilege,
        sshHostKeyType: connection.endpoint.sshHostKeyType,
        node: connection.configuration?.node,
        templateId: connection.configuration?.template?.vmid,
        vmidStart: input.vmidRange.start,
        vmidEnd: input.vmidRange.end,
      },
      destination,
    );

    let transportError: string | undefined;
    const outcome: PortableProxmoxPreflightOutcome = await deps.runPreflight(
      input,
      async (script) => {
        const execution = await deps.executeHostScript(script, env, {
          timeoutMs: 60_000,
          maxOutputBytes: MAX_PROXMOX_PREFLIGHT_OUTPUT_BYTES,
        });
        transportError = execution.error;
        return { ok: execution.ok, stdout: execution.ok ? execution.stdout : "" };
      },
    );

    if (!outcome.ok) {
      const code = outcome.code === "PROXMOX_PREFLIGHT_EXECUTION_FAILED"
        ? classifyTransportFailure(transportError)
        : outcome.code === "PROXMOX_PREFLIGHT_INPUT_INVALID"
          ? "INVALID_CONNECTION"
          : "SSH_COMMAND_FAILED";
      const result = publicFailure(connectionId, checkedAt, code);
      const persisted = await deps.completePreflight(
        userId,
        connectionId,
        connection.revision,
        runId,
        {
          connectionStatus: "error",
          checkedAt,
          lastErrorCode: code,
          target: null,
        },
      );
      if (!persisted) return supersededFailure(connectionId, checkedAt);
      return result;
    }

    const requirements = mappedRequirements(outcome.report.unmetRequirements);
    const result = outcome.report.connectionReady
      ? publicSuccess(connection, outcome.report, checkedAt)
        ?? publicFailure(connectionId, checkedAt, topReportError(outcome.report), requirements, connection.setupMode)
      : publicFailure(connectionId, checkedAt, topReportError(outcome.report), requirements, connection.setupMode);

    const completion: InfrastructurePreflightCompletion = {
      connectionStatus: result.ok ? "ready" : "error",
      checkedAt,
      lastErrorCode: result.ok ? null : result.error.code,
      target: targetEvidenceFromReport(connection, outcome.report, result),
    };
    const persisted = await deps.completePreflight(
      userId,
      connectionId,
      connection.revision,
      runId,
      completion,
    );
    if (!persisted) return supersededFailure(connectionId, checkedAt);
    return result;
  } catch (error) {
    const code = error instanceof InfrastructureNetworkError
      ? error.code === "ssh_host_unresolvable"
        ? "HOST_RESOLUTION_FAILED"
        : error.code === "ssh_host_forbidden"
          ? "HOST_ADDRESS_BLOCKED"
          : "INVALID_CONNECTION"
      : "PREFLIGHT_INTERNAL_ERROR";
    if (!leaseClaimed) return publicFailure(connectionId, checkedAt, code);
    try {
      const persisted = await deps.completePreflight(
        userId,
        connectionId,
        connection.revision,
        runId,
        {
          connectionStatus: "error",
          checkedAt,
          lastErrorCode: code,
          target: null,
        },
      );
      if (!persisted) return supersededFailure(connectionId, checkedAt);
      return publicFailure(connectionId, checkedAt, code);
    } catch {
      return publicFailure(connectionId, checkedAt, "PREFLIGHT_INTERNAL_ERROR");
    }
  }
}
