import "server-only";

import { createHash, randomUUID } from "node:crypto";

import {
  normalizeProxmoxSshHostFingerprint,
  runProxmoxHostScript,
} from "@/lib/services/proxmox-instance-service";

import {
  buildUserProxmoxEnvironment,
  InfrastructureNetworkError,
  resolveValidatedSshDestination,
} from "./connection-runtime";
import {
  InfrastructureConnectionStoreError,
  loadInfrastructureConnectionSecret,
  type LoadedInfrastructureConnection,
} from "./connection-store";
import {
  HOST_DISCOVERY_CONTRACT_VERSION,
  HOST_DISCOVERY_PROTOCOL,
  HOST_DISCOVERY_SNAPSHOT_TTL_MS,
  HOST_ISOLATION_ENGINE_IDS,
  HostDiscoveryResultSchema,
  HostDiscoverySnapshotSchema,
  ProviderGuestDiscoverySnapshotSchema,
  MAX_HOST_DISCOVERY_OUTPUT_BYTES,
  type HostDiscoveryEngine,
  type HostDiscoveryErrorCode,
  type HostDiscoveryResult,
  type HostDiscoverySnapshot,
  type ProviderGuestDiscoverySnapshot,
  type HostEngineRequirement,
  type HostIsolationEngineId,
} from "./host-discovery-contracts";
import {
  beginInfrastructureHostDiscovery,
  completeInfrastructureHostDiscovery,
  HostDiscoveryStoreError,
  releaseInfrastructureHostDiscovery,
} from "./host-discovery-store";

const DISCOVERY_TIMEOUT_MS = 30_000;
const MAX_DISCOVERY_TEXT_BYTES = 160;

const ENGINE_OUTPUT_KEYS: Record<
  HostIsolationEngineId,
  { installed: string; version: string }
> = {
  "proxmox-kvm": {
    installed: "PROXMOX_KVM_INSTALLED",
    version: "PROXMOX_KVM_VERSION_B64",
  },
  "qemu-kvm": {
    installed: "QEMU_KVM_INSTALLED",
    version: "QEMU_KVM_VERSION_B64",
  },
  gvisor: { installed: "GVISOR_INSTALLED", version: "GVISOR_VERSION_B64" },
  docker: { installed: "DOCKER_INSTALLED", version: "DOCKER_VERSION_B64" },
  containerd: {
    installed: "CONTAINERD_INSTALLED",
    version: "CONTAINERD_VERSION_B64",
  },
  podman: { installed: "PODMAN_INSTALLED", version: "PODMAN_VERSION_B64" },
  "oci-runc": { installed: "OCI_RUNC_INSTALLED", version: "OCI_RUNC_VERSION_B64" },
  "oci-crun": { installed: "OCI_CRUN_INSTALLED", version: "OCI_CRUN_VERSION_B64" },
  lxc: { installed: "LXC_INSTALLED", version: "LXC_VERSION_B64" },
};

const BASE_OUTPUT_KEYS = [
  "PROTOCOL",
  "OS_FAMILY",
  "OS_ID_B64",
  "OS_VERSION_ID_B64",
  "KERNEL_RELEASE_B64",
  "ARCH_B64",
  "EUID",
  "VIRTUALIZATION",
  "CGROUP_VERSION",
  "CPU_LOGICAL_CORES",
  "MEMORY_TOTAL_BYTES",
  "MEMORY_AVAILABLE_BYTES",
  "ROOT_STORAGE_TOTAL_BYTES",
  "ROOT_STORAGE_AVAILABLE_BYTES",
  "KVM_DEVICE",
  "CPU_VIRTUALIZATION",
  "PACKAGE_MANAGERS",
  "MACHINE_ID_DIGEST",
] as const;

const EXPECTED_OUTPUT_KEYS = new Set([
  ...BASE_OUTPUT_KEYS,
  ...Object.values(ENGINE_OUTPUT_KEYS).flatMap(({ installed, version }) => [
    installed,
    version,
  ]),
  "END",
]);

const PUBLIC_ERROR_COPY: Record<
  HostDiscoveryErrorCode,
  { message: string; remediation?: string }
> = {
  CONNECTION_NOT_FOUND: { message: "The infrastructure connection was not found." },
  INVALID_CONNECTION: {
    message: "The host connection is incomplete or invalid.",
    remediation: "Save a verified SSH SHA-256 host fingerprint and valid credentials, then try again.",
  },
  HOST_RESOLUTION_FAILED: {
    message: "The SSH host could not be resolved.",
    remediation: "Check the hostname and its DNS records.",
  },
  HOST_ADDRESS_BLOCKED: {
    message: "The SSH host resolves to an address this control plane cannot reach.",
    remediation: "Use an allowed address or explicitly enable private networking on a self-hosted control plane.",
  },
  SSH_HOST_KEY_MISMATCH: {
    message: "The server identity did not match the pinned SSH fingerprint.",
    remediation: "Verify the host fingerprint out of band before changing the connection.",
  },
  SSH_AUTHENTICATION_FAILED: {
    message: "SSH authentication failed.",
    remediation: "Check the SSH user and private key authorized on this host.",
  },
  SSH_CONNECTION_FAILED: {
    message: "The host could not be reached over SSH.",
    remediation: "Check the address, SSH port, firewall, and network access.",
  },
  SSH_COMMAND_FAILED: {
    message: "The bounded read-only host inspection did not complete.",
    remediation: "Check the SSH account permissions and try again.",
  },
  DISCOVERY_OUTPUT_INVALID: {
    message: "The host returned invalid discovery evidence.",
    remediation: "Confirm the SSH account runs a standard Linux shell without modifying command output.",
  },
  DISCOVERY_SUPERSEDED: {
    message: "A newer connection change or host operation replaced this discovery.",
    remediation: "Use the newest result or inspect the host again.",
  },
  DISCOVERY_INTERNAL_ERROR: {
    message: "Host discovery could not be completed.",
    remediation: "Try again. If the problem continues, inspect the self-hosted server logs.",
  },
};

type DiscoveryDependencies = {
  loadConnection: typeof loadInfrastructureConnectionSecret;
  beginDiscovery: typeof beginInfrastructureHostDiscovery;
  completeDiscovery: typeof completeInfrastructureHostDiscovery;
  releaseDiscovery: typeof releaseInfrastructureHostDiscovery;
  resolveDestination: typeof resolveValidatedSshDestination;
  executeHostScript: typeof runProxmoxHostScript;
  now: () => Date;
  newRunId: () => string;
};

const DEFAULT_DEPENDENCIES: DiscoveryDependencies = {
  loadConnection: loadInfrastructureConnectionSecret,
  beginDiscovery: beginInfrastructureHostDiscovery,
  completeDiscovery: completeInfrastructureHostDiscovery,
  releaseDiscovery: releaseInfrastructureHostDiscovery,
  resolveDestination: resolveValidatedSshDestination,
  executeHostScript: runProxmoxHostScript,
  now: () => new Date(),
  newRunId: randomUUID,
};

function failure(
  connectionId: string,
  attemptedAt: string,
  code: HostDiscoveryErrorCode,
): HostDiscoveryResult {
  return HostDiscoveryResultSchema.parse({
    ok: false,
    connectionId,
    attemptedAt,
    error: { code, ...PUBLIC_ERROR_COPY[code] },
  });
}

function classifyTransportFailure(raw: string | undefined): HostDiscoveryErrorCode {
  const normalized = raw?.toLowerCase() ?? "";
  if (/(host key|fingerprint|verification failed)/.test(normalized)) {
    return "SSH_HOST_KEY_MISMATCH";
  }
  if (/(authentication|permission denied|no supported auth|configured authentication)/.test(normalized)) {
    return "SSH_AUTHENTICATION_FAILED";
  }
  if (/(output exceeded|remote bash|ssh exec|exited with code)/.test(normalized)) {
    return "SSH_COMMAND_FAILED";
  }
  return "SSH_CONNECTION_FAILED";
}

/**
 * Static, bounded and read-only Linux capability probe. Dynamic host values are
 * base64 encoded and length-limited before crossing the protocol boundary.
 * Machine identity is salted on-host and never emitted verbatim.
 */
export function buildReadOnlyHostDiscoveryScript(connectionId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(connectionId)) {
    throw new Error("Invalid discovery connection id");
  }

  return `#!/usr/bin/env bash
set -u
export LC_ALL=C

emit() {
  printf '%s\\t%s\\t%s\\n' '${HOST_DISCOVERY_PROTOCOL}' "$1" "$2"
}
emit_b64() {
  value=$(printf '%s' "$2" | head -c ${MAX_DISCOVERY_TEXT_BYTES})
  if command -v base64 >/dev/null 2>&1; then
    encoded=$(printf '%s' "$value" | base64 | tr -d '\\r\\n')
  else
    encoded=''
  fi
  emit "$1" "$encoded"
}
command_version() {
  "$@" 2>/dev/null | head -n 1 | head -c ${MAX_DISCOVERY_TEXT_BYTES} || true
}

emit PROTOCOL '${HOST_DISCOVERY_CONTRACT_VERSION}'

os_family=unknown
if [ "$(uname -s 2>/dev/null || true)" = Linux ]; then os_family=linux; fi
os_id=''
os_version_id=''
if [ -r /etc/os-release ]; then
  os_id=$(awk -F= '$1 == "ID" { value=$0; sub(/^[^=]*=/, "", value); gsub(/^"|"$/, "", value); print value; exit }' /etc/os-release 2>/dev/null || true)
  os_version_id=$(awk -F= '$1 == "VERSION_ID" { value=$0; sub(/^[^=]*=/, "", value); gsub(/^"|"$/, "", value); print value; exit }' /etc/os-release 2>/dev/null || true)
fi
emit OS_FAMILY "$os_family"
emit_b64 OS_ID_B64 "$os_id"
emit_b64 OS_VERSION_ID_B64 "$os_version_id"
emit_b64 KERNEL_RELEASE_B64 "$(uname -r 2>/dev/null || true)"
emit_b64 ARCH_B64 "$(uname -m 2>/dev/null || true)"

euid=''
if command -v id >/dev/null 2>&1; then euid=$(id -u 2>/dev/null || true); fi
emit EUID "$euid"

virtualization=unknown
if [ -e /.dockerenv ] || [ -e /run/.containerenv ]; then
  virtualization=container
elif command -v systemd-detect-virt >/dev/null 2>&1; then
  detected_virt=$(systemd-detect-virt 2>/dev/null || true)
  case "$detected_virt" in
    none) virtualization=bare-metal ;;
    docker|lxc|lxc-libvirt|podman|openvz|systemd-nspawn|wsl) virtualization=container ;;
    kvm|qemu|vmware|microsoft|xen|oracle|parallels|bhyve) virtualization=virtual-machine ;;
  esac
fi
emit VIRTUALIZATION "$virtualization"

cgroup_version=''
if [ -r /sys/fs/cgroup/cgroup.controllers ]; then
  cgroup_version=2
elif [ -r /proc/1/cgroup ]; then
  cgroup_version=1
fi
emit CGROUP_VERSION "$cgroup_version"

cpu_cores=''
if command -v getconf >/dev/null 2>&1; then
  cpu_cores=$(getconf _NPROCESSORS_ONLN 2>/dev/null || true)
elif command -v nproc >/dev/null 2>&1; then
  cpu_cores=$(nproc 2>/dev/null || true)
fi
emit CPU_LOGICAL_CORES "$cpu_cores"

memory_total=''
memory_available=''
if [ -r /proc/meminfo ]; then
  memory_total=$(awk '$1 == "MemTotal:" { printf "%.0f", $2 * 1024; exit }' /proc/meminfo 2>/dev/null || true)
  memory_available=$(awk '$1 == "MemAvailable:" { printf "%.0f", $2 * 1024; exit }' /proc/meminfo 2>/dev/null || true)
fi
emit MEMORY_TOTAL_BYTES "$memory_total"
emit MEMORY_AVAILABLE_BYTES "$memory_available"

root_storage=''
if command -v df >/dev/null 2>&1; then
  root_storage=$(df -B1 -P / 2>/dev/null | awk 'NR == 2 { print $2 "|" $4 }' || true)
fi
emit ROOT_STORAGE_TOTAL_BYTES "\${root_storage%%|*}"
if [ "$root_storage" != "\${root_storage#*|}" ]; then
  emit ROOT_STORAGE_AVAILABLE_BYTES "\${root_storage#*|}"
else
  emit ROOT_STORAGE_AVAILABLE_BYTES ''
fi

kvm_device=0
if [ -e /dev/kvm ]; then kvm_device=1; fi
cpu_virtualization=0
if [ -r /proc/cpuinfo ] && grep -Eq '(^|[[:space:]])(vmx|svm)([[:space:]]|$)' /proc/cpuinfo 2>/dev/null; then
  cpu_virtualization=1
fi
emit KVM_DEVICE "$kvm_device"
emit CPU_VIRTUALIZATION "$cpu_virtualization"

package_managers=''
append_package_manager() {
  if [ -n "$package_managers" ]; then package_managers="$package_managers,$1"; else package_managers="$1"; fi
}
if command -v apt-get >/dev/null 2>&1; then append_package_manager apt; fi
if command -v dnf >/dev/null 2>&1; then append_package_manager dnf; fi
if command -v yum >/dev/null 2>&1; then append_package_manager yum; fi
if command -v zypper >/dev/null 2>&1; then append_package_manager zypper; fi
if command -v apk >/dev/null 2>&1; then append_package_manager apk; fi
emit PACKAGE_MANAGERS "$package_managers"

machine_id=''
if [ -r /etc/machine-id ]; then
  IFS= read -r machine_id < /etc/machine-id || true
elif [ -r /var/lib/dbus/machine-id ]; then
  IFS= read -r machine_id < /var/lib/dbus/machine-id || true
fi
machine_id_digest=''
case "$machine_id" in
  ''|*[!A-Za-z0-9]*) ;;
  *)
    if command -v sha256sum >/dev/null 2>&1; then
      machine_id_digest=$(printf 'hivra-host-discovery-v1:%s:%s' '${connectionId}' "$machine_id" | sha256sum | awk '{ print $1 }' || true)
    fi
    ;;
esac
emit MACHINE_ID_DIGEST "$machine_id_digest"

proxmox_installed=0
proxmox_version=''
if command -v pveversion >/dev/null 2>&1 && command -v qm >/dev/null 2>&1 && command -v pvesm >/dev/null 2>&1; then
  proxmox_installed=1
  proxmox_version=$(command_version pveversion)
fi
emit PROXMOX_KVM_INSTALLED "$proxmox_installed"
emit_b64 PROXMOX_KVM_VERSION_B64 "$proxmox_version"

qemu_installed=0
qemu_version=''
qemu_command=''
if command -v qemu-system-x86_64 >/dev/null 2>&1; then qemu_command=qemu-system-x86_64; fi
if [ -z "$qemu_command" ] && command -v qemu-system-aarch64 >/dev/null 2>&1; then qemu_command=qemu-system-aarch64; fi
if [ -n "$qemu_command" ]; then
  qemu_installed=1
  qemu_version=$(command_version "$qemu_command" --version)
fi
emit QEMU_KVM_INSTALLED "$qemu_installed"
emit_b64 QEMU_KVM_VERSION_B64 "$qemu_version"

if command -v runsc >/dev/null 2>&1; then gvisor_installed=1; gvisor_version=$(command_version runsc --version); else gvisor_installed=0; gvisor_version=''; fi
emit GVISOR_INSTALLED "$gvisor_installed"
emit_b64 GVISOR_VERSION_B64 "$gvisor_version"

if command -v docker >/dev/null 2>&1; then docker_installed=1; docker_version=$(command_version docker --version); else docker_installed=0; docker_version=''; fi
emit DOCKER_INSTALLED "$docker_installed"
emit_b64 DOCKER_VERSION_B64 "$docker_version"

if command -v containerd >/dev/null 2>&1; then containerd_installed=1; containerd_version=$(command_version containerd --version); else containerd_installed=0; containerd_version=''; fi
emit CONTAINERD_INSTALLED "$containerd_installed"
emit_b64 CONTAINERD_VERSION_B64 "$containerd_version"

if command -v podman >/dev/null 2>&1; then podman_installed=1; podman_version=$(command_version podman --version); else podman_installed=0; podman_version=''; fi
emit PODMAN_INSTALLED "$podman_installed"
emit_b64 PODMAN_VERSION_B64 "$podman_version"

if command -v runc >/dev/null 2>&1; then runc_installed=1; runc_version=$(command_version runc --version); else runc_installed=0; runc_version=''; fi
emit OCI_RUNC_INSTALLED "$runc_installed"
emit_b64 OCI_RUNC_VERSION_B64 "$runc_version"

if command -v crun >/dev/null 2>&1; then crun_installed=1; crun_version=$(command_version crun --version); else crun_installed=0; crun_version=''; fi
emit OCI_CRUN_INSTALLED "$crun_installed"
emit_b64 OCI_CRUN_VERSION_B64 "$crun_version"

if command -v lxc-start >/dev/null 2>&1; then lxc_installed=1; lxc_version=$(command_version lxc-start --version); else lxc_installed=0; lxc_version=''; fi
emit LXC_INSTALLED "$lxc_installed"
emit_b64 LXC_VERSION_B64 "$lxc_version"

emit END 1
`;
}

function parseProtocolValues(output: string): Map<string, string> {
  if (Buffer.byteLength(output, "utf8") > MAX_HOST_DISCOVERY_OUTPUT_BYTES) {
    throw new Error("Discovery output exceeded its protocol budget");
  }

  const values = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith(`${HOST_DISCOVERY_PROTOCOL}\t`)) continue;
    const parts = line.split("\t");
    if (parts.length !== 3 || parts[0] !== HOST_DISCOVERY_PROTOCOL) {
      throw new Error("Malformed discovery marker");
    }
    const [, key, value] = parts;
    if (!EXPECTED_OUTPUT_KEYS.has(key) || values.has(key)) {
      throw new Error("Unknown or duplicate discovery marker");
    }
    values.set(key, value);
  }

  if (values.size !== EXPECTED_OUTPUT_KEYS.size) {
    throw new Error("Discovery output was incomplete");
  }
  if (values.get("PROTOCOL") !== String(HOST_DISCOVERY_CONTRACT_VERSION) || values.get("END") !== "1") {
    throw new Error("Discovery protocol version was invalid");
  }
  return values;
}

function decodeText(values: Map<string, string>, key: string, maxBytes: number): string | null {
  const encoded = values.get(key);
  if (encoded === undefined) throw new Error("Discovery field was absent");
  if (encoded === "") return null;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error("Discovery base64 was malformed");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded || bytes.length === 0 || bytes.length > maxBytes) {
    throw new Error("Discovery base64 was noncanonical or oversized");
  }
  const decoded = bytes.toString("utf8");
  if (!Buffer.from(decoded, "utf8").equals(bytes) || !/^[\x20-\x7e]+$/.test(decoded)) {
    throw new Error("Discovery text was unsafe");
  }
  return decoded;
}

function nullableInteger(values: Map<string, string>, key: string): number | null {
  const raw = values.get(key);
  if (raw === undefined) throw new Error("Discovery numeric field was absent");
  if (raw === "") return null;
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) throw new Error("Discovery numeric field was invalid");
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("Discovery numeric field exceeded its safe range");
  }
  return parsed;
}

function booleanValue(values: Map<string, string>, key: string): boolean {
  const raw = values.get(key);
  if (raw === "1") return true;
  if (raw === "0") return false;
  throw new Error("Discovery boolean field was invalid");
}

function requirementsForEngine(input: {
  id: HostIsolationEngineId;
  installed: boolean;
  linux: boolean;
  root: boolean;
  supportedArchitecture: boolean;
  packageManager: boolean;
  kvmReady: boolean;
  proxmoxVersionSupported: boolean;
  cgroupV2: boolean;
  dockerInstalled: boolean;
  supportedGvisorOs: boolean;
}): HostEngineRequirement[] {
  const requirements: HostEngineRequirement[] = [];
  if (!input.linux) requirements.push("LINUX_REQUIRED");
  if (!input.root) requirements.push("ROOT_REQUIRED");
  if (!input.supportedArchitecture) requirements.push("SUPPORTED_ARCH_REQUIRED");
  if (!input.installed && !input.packageManager) requirements.push("PACKAGE_MANAGER_REQUIRED");
  if ((input.id === "proxmox-kvm" || input.id === "qemu-kvm") && !input.kvmReady) {
    requirements.push("KVM_REQUIRED");
  }
  if (!input.installed) requirements.push("ENGINE_NOT_INSTALLED");
  if (input.id === "proxmox-kvm" && input.installed && !input.proxmoxVersionSupported) {
    requirements.push("ENGINE_VERSION_UNSUPPORTED");
  }
  if (input.id === "gvisor") {
    if (!input.cgroupV2) requirements.push("CGROUP_V2_REQUIRED");
    if (!input.dockerInstalled) requirements.push("DOCKER_REQUIRED");
    if (!input.supportedGvisorOs) requirements.push("SUPPORTED_OS_REQUIRED");
  } else if (input.id !== "proxmox-kvm") requirements.push("RUNTIME_ADAPTER_UNAVAILABLE");
  return requirements;
}

function engineEvidence(input: {
  values: Map<string, string>;
  id: HostIsolationEngineId;
  osId: string | null;
  osVersionId: string | null;
  linux: boolean;
  root: boolean;
  architecture: "amd64" | "arm64" | "other";
  packageManagers: string[];
  kvmReady: boolean;
  cgroupVersion: 1 | 2 | null;
}): HostDiscoveryEngine {
  const keys = ENGINE_OUTPUT_KEYS[input.id];
  const installed = booleanValue(input.values, keys.installed);
  const detectedVersion = installed
    ? decodeText(input.values, keys.version, MAX_DISCOVERY_TEXT_BYTES)
    : null;
  const supportedArchitecture = input.architecture !== "other";
  const packageManager = input.packageManagers.length > 0;
  const proxmoxVersionSupported = Boolean(
    detectedVersion && /^pve-manager\/(8|9)\./.test(detectedVersion),
  );
  const dockerInstalled = booleanValue(input.values, ENGINE_OUTPUT_KEYS.docker.installed);
  const supportedGvisorOs = input.osId === "ubuntu"
    && (input.osVersionId === "22.04" || input.osVersionId === "24.04");
  const requirements = requirementsForEngine({
    id: input.id,
    installed,
    linux: input.linux,
    root: input.root,
    supportedArchitecture,
    packageManager,
    kvmReady: input.kvmReady,
    proxmoxVersionSupported,
    cgroupV2: input.cgroupVersion === 2,
    dockerInstalled,
    supportedGvisorOs,
  });
  const proxmoxInstallable =
    input.id === "proxmox-kvm" &&
    input.osId === "debian" &&
    input.architecture === "amd64" &&
    input.packageManagers.includes("apt") &&
    input.root &&
    input.kvmReady;
  const generallyInstallable =
    input.id !== "proxmox-kvm" &&
    input.linux &&
    input.root &&
    supportedArchitecture &&
    packageManager &&
    (!(input.id === "qemu-kvm") || input.kvmReady);
  const availability = installed
    ? "installed"
    : proxmoxInstallable || generallyInstallable
      ? "installable"
      : "unavailable";
  const supported = input.linux && input.root && input.architecture === "amd64" && (
    (installed && input.id === "proxmox-kvm" && input.kvmReady && proxmoxVersionSupported)
    || (
      input.id === "gvisor"
      && input.cgroupVersion === 2
      && input.packageManagers.includes("apt")
      && supportedGvisorOs
    )
  );

  return {
    id: input.id,
    availability,
    supported,
    detectedVersion,
    unmetRequirements: requirements,
  };
}

type DiscoveryOutputInput = {
  output: string;
  discoveryId: string;
  connectionId: string;
  connectionRevision: number;
  normalizedHostFingerprint: string;
  observedAt: Date;
};

export function parseHostDiscoveryOutput(input:DiscoveryOutputInput & {connectionProvider:"proxmox"|"host"}):HostDiscoverySnapshot {
  return HostDiscoverySnapshotSchema.parse({...parseDiscoveryOutput(input),connectionProvider:input.connectionProvider});
}

export function parseProviderGuestDiscoveryOutput(input:DiscoveryOutputInput & {
  providerServerId:string;capacityOrderId:string;enrollmentAttemptId:string;
}):ProviderGuestDiscoverySnapshot {
  const evidence=parseDiscoveryOutput(input);
  return ProviderGuestDiscoverySnapshotSchema.parse({...evidence,connectionProvider:"hetzner-cloud",
    providerServerId:input.providerServerId,capacityOrderId:input.capacityOrderId,enrollmentAttemptId:input.enrollmentAttemptId,
    // Provider publication and lifecycle guards bind to the enrolled SSH key,
    // not the generic host/machine composite identity used for custom hosts.
    hostIdentityDigest:normalizeProxmoxSshHostFingerprint(input.normalizedHostFingerprint),
    // Installed engines are useful facts, but cannot turn a Cloud VM into a
    // supported nested-hypervisor target through this discovery path.
    engines:evidence.engines.map(engine=>({...engine,supported:false,
      unmetRequirements:[...new Set([...engine.unmetRequirements,"RUNTIME_ADAPTER_UNAVAILABLE" as const])]})),
  });
}

function parseDiscoveryOutput(input:DiscoveryOutputInput) {
  const values = parseProtocolValues(input.output);
  const osFamily = values.get("OS_FAMILY");
  if (osFamily !== "linux" && osFamily !== "unknown") {
    throw new Error("Discovery OS family was invalid");
  }
  const osId = decodeText(values, "OS_ID_B64", 64);
  if (osId !== null && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(osId)) {
    throw new Error("Discovery OS identifier was invalid");
  }
  const osVersionId = decodeText(values, "OS_VERSION_ID_B64", 64);
  const kernelRelease = decodeText(values, "KERNEL_RELEASE_B64", 128);
  const rawArchitecture = decodeText(values, "ARCH_B64", 32)?.toLowerCase();
  const architecture = rawArchitecture === "x86_64" || rawArchitecture === "amd64"
    ? "amd64"
    : rawArchitecture === "aarch64" || rawArchitecture === "arm64"
      ? "arm64"
      : "other";
  const euid = nullableInteger(values, "EUID");
  const effectivePrivilege = euid === null ? "unknown" : euid === 0 ? "root" : "non-root";
  const virtualization = values.get("VIRTUALIZATION");
  if (![
    "bare-metal",
    "virtual-machine",
    "container",
    "unknown",
  ].includes(virtualization ?? "")) {
    throw new Error("Discovery virtualization class was invalid");
  }
  const rawCgroupVersion = values.get("CGROUP_VERSION");
  const cgroupVersion = rawCgroupVersion === "" ? null : nullableInteger(values, "CGROUP_VERSION");
  if (cgroupVersion !== null && cgroupVersion !== 1 && cgroupVersion !== 2) {
    throw new Error("Discovery cgroup version was invalid");
  }
  const packageManagersRaw = values.get("PACKAGE_MANAGERS") ?? "";
  const packageManagers = packageManagersRaw === "" ? [] : packageManagersRaw.split(",");
  const allowedPackageManagers = new Set(["apt", "dnf", "yum", "zypper", "apk"]);
  if (
    packageManagers.some((manager) => !allowedPackageManagers.has(manager)) ||
    new Set(packageManagers).size !== packageManagers.length
  ) {
    throw new Error("Discovery package managers were invalid");
  }
  const machineIdDigest = values.get("MACHINE_ID_DIGEST") ?? "";
  if (machineIdDigest !== "" && !/^[0-9a-f]{64}$/.test(machineIdDigest)) {
    throw new Error("Discovery machine identity digest was invalid");
  }

  const kvmDevice = booleanValue(values, "KVM_DEVICE");
  const cpuVirtualization = booleanValue(values, "CPU_VIRTUALIZATION");
  const kvmReady = kvmDevice && cpuVirtualization;
  const normalizedHostFingerprint = normalizeProxmoxSshHostFingerprint(
    input.normalizedHostFingerprint,
  );
  const hostIdentityDigest = createHash("sha256")
    .update(HOST_DISCOVERY_PROTOCOL)
    .update("\0")
    .update(input.connectionId)
    .update("\0")
    .update(normalizedHostFingerprint)
    .update("\0")
    .update(machineIdDigest || "machine-id-unavailable")
    .digest("hex");
  const observedAt = input.observedAt.toISOString();
  const expiresAt = new Date(
    input.observedAt.getTime() + HOST_DISCOVERY_SNAPSHOT_TTL_MS,
  ).toISOString();
  const engines = HOST_ISOLATION_ENGINE_IDS.map((id) =>
    engineEvidence({
      values,
      id,
      osId,
      osVersionId,
      linux: osFamily === "linux",
      root: effectivePrivilege === "root",
      architecture,
      packageManagers,
      kvmReady,
      cgroupVersion,
    }),
  );

  return {
    discoveryId: input.discoveryId,
    connectionId: input.connectionId,
    connectionRevision: input.connectionRevision,
    contractVersion: HOST_DISCOVERY_CONTRACT_VERSION,
    observedAt,
    expiresAt,
    hostIdentityDigest,
    host: {
      os: { family: osFamily, id: osId, versionId: osVersionId },
      kernel: { release: kernelRelease, architecture },
      environment: {
        effectivePrivilege,
        virtualization,
        cgroupVersion,
        packageManagers,
      },
      capacity: {
        cpu: { logicalCores: nullableInteger(values, "CPU_LOGICAL_CORES") },
        memoryBytes: {
          total: nullableInteger(values, "MEMORY_TOTAL_BYTES"),
          available: nullableInteger(values, "MEMORY_AVAILABLE_BYTES"),
        },
        rootStorageBytes: {
          total: nullableInteger(values, "ROOT_STORAGE_TOTAL_BYTES"),
          available: nullableInteger(values, "ROOT_STORAGE_AVAILABLE_BYTES"),
        },
      },
      kvm: { devicePresent: kvmDevice, cpuVirtualization },
    },
    engines,
  };
}

function connectionFailureCode(error: unknown): HostDiscoveryErrorCode {
  if (error instanceof InfrastructureConnectionStoreError) {
    if (error.code === "not_found") return "CONNECTION_NOT_FOUND";
    if (error.code === "credential_error" || error.code === "invalid_request") {
      return "INVALID_CONNECTION";
    }
  }
  return "DISCOVERY_INTERNAL_ERROR";
}

function networkFailureCode(error: InfrastructureNetworkError): HostDiscoveryErrorCode {
  if (error.code === "ssh_host_unresolvable") return "HOST_RESOLUTION_FAILED";
  if (error.code === "ssh_host_forbidden") return "HOST_ADDRESS_BLOCKED";
  return "INVALID_CONNECTION";
}

export async function discoverInfrastructureHost(
  userId: string,
  connectionId: string,
  dependencies: Partial<DiscoveryDependencies> = {},
): Promise<HostDiscoveryResult> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const attemptedAt = deps.now().toISOString();
  let connection: LoadedInfrastructureConnection;

  try {
    connection = await deps.loadConnection(userId, connectionId);
  } catch (error) {
    return failure(connectionId, attemptedAt, connectionFailureCode(error));
  }

  let normalizedHostFingerprint: string;
  try {
    if (!connection.endpoint.sshHostFingerprintSha256?.trim()) {
      return failure(connectionId, attemptedAt, "INVALID_CONNECTION");
    }
    normalizedHostFingerprint = normalizeProxmoxSshHostFingerprint(
      connection.endpoint.sshHostFingerprintSha256,
    );
  } catch {
    return failure(connectionId, attemptedAt, "INVALID_CONNECTION");
  }

  let destination: Awaited<ReturnType<typeof resolveValidatedSshDestination>>;
  try {
    destination = await deps.resolveDestination(connection.endpoint.sshHost);
  } catch (error) {
    return failure(
      connectionId,
      attemptedAt,
      error instanceof InfrastructureNetworkError
        ? networkFailureCode(error)
        : "DISCOVERY_INTERNAL_ERROR",
    );
  }

  const runId = deps.newRunId();
  let leaseClaimed = false;
  let leaseSettled = false;
  try {
    leaseClaimed = await deps.beginDiscovery({
      userId,
      connectionId,
      expectedRevision: connection.revision,
      runId,
    });
    if (!leaseClaimed) return failure(connectionId, attemptedAt, "DISCOVERY_SUPERSEDED");

    const env = buildUserProxmoxEnvironment(
      {
        id: connection.id,
        sshHost: connection.endpoint.sshHost,
        sshPort: connection.endpoint.sshPort,
        sshUser: connection.endpoint.sshUser,
        sshHostFingerprintSha256: normalizedHostFingerprint,
        sshPrivateKey: connection.credentials.sshPrivateKey,
      },
      destination,
    );
    const execution = await deps.executeHostScript(
      buildReadOnlyHostDiscoveryScript(connectionId),
      env,
      {
        timeoutMs: DISCOVERY_TIMEOUT_MS,
        maxOutputBytes: MAX_HOST_DISCOVERY_OUTPUT_BYTES,
      },
    );
    if (!execution.ok) {
      return failure(
        connectionId,
        attemptedAt,
        classifyTransportFailure(execution.error ?? execution.stderr),
      );
    }

    let snapshot: HostDiscoverySnapshot;
    try {
      snapshot = parseHostDiscoveryOutput({
        output: execution.stdout,
        discoveryId: runId,
        connectionId,
        connectionRevision: connection.revision,
        connectionProvider: connection.provider,
        normalizedHostFingerprint,
        observedAt: deps.now(),
      });
    } catch {
      return failure(connectionId, attemptedAt, "DISCOVERY_OUTPUT_INVALID");
    }

    const persisted = await deps.completeDiscovery({
      userId,
      connectionId,
      expectedRevision: connection.revision,
      runId,
      snapshot,
    });
    if (!persisted) return failure(connectionId, attemptedAt, "DISCOVERY_SUPERSEDED");
    leaseSettled = true;
    return HostDiscoveryResultSchema.parse({ ok: true, snapshot });
  } catch (error) {
    if (error instanceof HostDiscoveryStoreError && error.code === "database_conflict") {
      return failure(connectionId, attemptedAt, "DISCOVERY_SUPERSEDED");
    }
    return failure(connectionId, attemptedAt, "DISCOVERY_INTERNAL_ERROR");
  } finally {
    if (leaseClaimed && !leaseSettled) {
      try {
        await deps.releaseDiscovery({
          userId,
          connectionId,
          expectedRevision: connection.revision,
          runId,
        });
      } catch {
        // The DB-bounded lease is the fallback if an exact best-effort release
        // loses a connection revision race or the database is unavailable.
      }
    }
  }
}
