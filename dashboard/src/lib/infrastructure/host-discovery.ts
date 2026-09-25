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
import { blockedAddressRemediation, internalFailureRemediation } from "./remediation-copy";
import { sha256FingerprintDisplay } from "./ssh-host-key";
import {
  HOST_DISCOVERY_CONTRACT_VERSION,
  HOST_DISCOVERY_PROTOCOL,
  HOST_DISCOVERY_SCRIPT_PROTOCOL_VERSION,
  PROVIDER_GUEST_DISCOVERY_CONTRACT_VERSION,
  PROVIDER_GUEST_DISCOVERY_SCRIPT_PROTOCOL_VERSION,
  type HostDiscoveryScriptLane,
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
import type { SudoTransportFailure } from "@/lib/services/proxmox-sudo-transport";
import { loadEnrolledServerFacts, recordServerEnrollmentIdentityMismatch } from "./server-enrollment-store";
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

// The provider lane's version 1 protocol has exactly these keys; the host
// lane's version 2 adds PASSWORDLESS_SUDO.
const PROVIDER_GUEST_OUTPUT_KEYS = new Set([
  ...BASE_OUTPUT_KEYS,
  ...Object.values(ENGINE_OUTPUT_KEYS).flatMap(({ installed, version }) => [
    installed,
    version,
  ]),
  "END",
]);
const HOST_OUTPUT_KEYS = new Set([...PROVIDER_GUEST_OUTPUT_KEYS, "PASSWORDLESS_SUDO"]);

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
    // Mode-dependent; see discoveryErrorCopy.
  },
  SSH_HOST_KEY_MISMATCH: {
    message: "The server presented a different SSH identity than the one Hivra pinned.",
    remediation: "If the server was rebuilt, run a new setup command to reconnect. Otherwise compare both fingerprints with your provider's console before you change anything.",
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
  SSH_SUDO_UNAVAILABLE: {
    message: "Hivra signed in, but sudo wouldn't run its command.",
    // Specific copy per diagnosis; see sudoFailureCopy.
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
    // Mode-dependent; see discoveryErrorCopy.
  },
};

/** Hosted owners are never told to read server logs or change network policy. */
function discoveryErrorCopy(code: HostDiscoveryErrorCode): { message: string; remediation?: string } {
  const copy = PUBLIC_ERROR_COPY[code];
  if (code === "HOST_ADDRESS_BLOCKED") return { ...copy, remediation: blockedAddressRemediation() };
  if (code === "DISCOVERY_INTERNAL_ERROR") return { ...copy, remediation: internalFailureRemediation() };
  return copy;
}

/** One sentence per sudo diagnosis. The password copy appears only when sudo
 * itself refused to run without one, never for a missing tool. */
export function sudoFailureCopy(failure: SudoTransportFailure, sshUser: string): { message: string; remediation?: string } {
  if (failure.kind === "missing_tool") {
    return { message: `This server is missing ${failure.path}, which Hivra needs.`,
      remediation: "Install it (it comes with the base system on Ubuntu), then check again." };
  }
  if (failure.kind === "password_required") {
    return { message: `Hivra signed in as ${sshUser}, but sudo wouldn't run without a password.`,
      remediation: "Run the setup command again, or give this user passwordless sudo, then check again." };
  }
  return { message: "sudo on this server wouldn't run Hivra's command.",
    remediation: `Hivra needs the rule \`${sshUser} ALL=(ALL:ALL) NOPASSWD: ALL\`. Add it in /etc/sudoers.d, then check again.` };
}

type DiscoveryDependencies = {
  loadConnection: typeof loadInfrastructureConnectionSecret;
  beginDiscovery: typeof beginInfrastructureHostDiscovery;
  completeDiscovery: typeof completeInfrastructureHostDiscovery;
  releaseDiscovery: typeof releaseInfrastructureHostDiscovery;
  resolveDestination: typeof resolveValidatedSshDestination;
  executeHostScript: typeof runProxmoxHostScript;
  now: () => Date;
  newRunId: () => string;
  /** Best-effort receipt when the first sign-in after Yes met another key. */
  recordIdentityMismatch: (userId: string, connectionId: string) => Promise<unknown>;
  /** What an enrolled server reported, for failure copy after Yes. */
  enrolledFacts: (userId: string, connectionId: string) => Promise<{ sshMatchRules: boolean } | null>;
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
  recordIdentityMismatch: recordServerEnrollmentIdentityMismatch,
  enrolledFacts: loadEnrolledServerFacts,
};

function failure(
  connectionId: string,
  attemptedAt: string,
  code: HostDiscoveryErrorCode,
  copy?: { message: string; remediation?: string; hostKey?: { expected: string; presented: string } },
): HostDiscoveryResult {
  return HostDiscoveryResultSchema.parse({
    ok: false,
    connectionId,
    attemptedAt,
    error: { code, ...(copy ?? discoveryErrorCopy(code)) },
  });
}

/** A connection the setup command created: user hivra through sudo. */
function isEnrolledConnection(connection: LoadedInfrastructureConnection): boolean {
  return connection.endpoint.sshUser === "hivra" && connection.endpoint.sshPrivilege === "sudo";
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

// Host lane only: can a non-root login run sudo without a password? One
// read-only probe. When sudo asks for a password it fails at once; the
// server's auth log records one failed attempt, and a user sudo doesn't know
// at all is reported as a sudo incident (mailed to root where mail is set up).
const SUDO_PROBE = `
# Only for a non-root login: can it run sudo without a password? One
# read-only probe; when sudo asks for a password it fails at once, and the
# server's auth log records one failed attempt.
passwordless_sudo=''
if [ -n "$euid" ] && [ "$euid" != 0 ] && command -v sudo >/dev/null 2>&1 && command -v timeout >/dev/null 2>&1; then
  if [ "$(timeout 5 sudo -n -- /usr/bin/id -u 2>/dev/null </dev/null || true)" = 0 ]; then
    passwordless_sudo=1
  else
    passwordless_sudo=0
  fi
fi
emit PASSWORDLESS_SUDO "$passwordless_sudo"
`;

/**
 * Static, bounded and read-only Linux capability probe. Dynamic host values are
 * base64 encoded and length-limited before crossing the protocol boundary.
 * Machine identity is salted on-host and never emitted verbatim.
 */
export function buildReadOnlyHostDiscoveryScript(
  connectionId: string,
  lane: HostDiscoveryScriptLane = "host",
): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(connectionId)) {
    throw new Error("Invalid discovery connection id");
  }
  if (lane !== "host" && lane !== "provider-guest") throw new Error("Invalid discovery lane");
  // The provider lane's first-boot recipe keeps its version 1 script byte for
  // byte (a test pins its sha256). Only host and Proxmox connections ask the
  // new sudo question.
  const protocol = lane === "host" ? HOST_DISCOVERY_SCRIPT_PROTOCOL_VERSION : PROVIDER_GUEST_DISCOVERY_SCRIPT_PROTOCOL_VERSION;
  const sudoProbe = lane === "host" ? SUDO_PROBE : "";

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

emit PROTOCOL '${protocol}'

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
${sudoProbe}
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

function parseProtocolValues(output: string, lane: HostDiscoveryScriptLane): Map<string, string> {
  const expectedKeys = lane === "host" ? HOST_OUTPUT_KEYS : PROVIDER_GUEST_OUTPUT_KEYS;
  const protocol = lane === "host" ? HOST_DISCOVERY_SCRIPT_PROTOCOL_VERSION : PROVIDER_GUEST_DISCOVERY_SCRIPT_PROTOCOL_VERSION;
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
    if (!expectedKeys.has(key) || values.has(key)) {
      throw new Error("Unknown or duplicate discovery marker");
    }
    values.set(key, value);
  }

  if (values.size !== expectedKeys.size) {
    throw new Error("Discovery output was incomplete");
  }
  if (values.get("PROTOCOL") !== String(protocol) || values.get("END") !== "1") {
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
  amd64: boolean;
  packageManager: boolean;
  apt: boolean;
  kvmReady: boolean;
  proxmoxVersionSupported: boolean;
  cgroupV2: boolean;
  dockerInstalled: boolean;
  supportedGvisorOs: boolean;
}): HostEngineRequirement[] {
  const requirements: HostEngineRequirement[] = [];
  // Hivra's two supported paths, Proxmox KVM and gVisor, run on x86 (amd64)
  // with apt only. Name those here so every reason `supported` is false is an
  // unmet requirement the owner can read, not a silent refusal.
  const hivraPath = input.id === "proxmox-kvm" || input.id === "gvisor";
  if (!input.linux) requirements.push("LINUX_REQUIRED");
  if (!input.root) requirements.push("ROOT_REQUIRED");
  if (hivraPath ? !input.amd64 : !input.supportedArchitecture) requirements.push("SUPPORTED_ARCH_REQUIRED");
  if ((!input.installed && !input.packageManager) || (input.id === "gvisor" && !input.apt)) {
    requirements.push("PACKAGE_MANAGER_REQUIRED");
  }
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
    amd64: input.architecture === "amd64",
    packageManager,
    apt: input.packageManagers.includes("apt"),
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

export function parseHostDiscoveryOutput(input:DiscoveryOutputInput & {
  connectionProvider:"proxmox"|"host";
  /** The connection's privilege: how this run reached root. */
  privilegeVia?:"login"|"sudo";
}):HostDiscoverySnapshot {
  const {passwordlessSudo,...evidence}=parseDiscoveryOutput(input,"host");
  return HostDiscoverySnapshotSchema.parse({...evidence,contractVersion:HOST_DISCOVERY_CONTRACT_VERSION,
    connectionProvider:input.connectionProvider,
    host:{...evidence.host,environment:{...evidence.host.environment,
      passwordlessSudo,privilegeVia:input.privilegeVia ?? "login"}}});
}

export function parseProviderGuestDiscoveryOutput(input:DiscoveryOutputInput & {
  providerServerId:string;capacityOrderId:string;enrollmentAttemptId:string;
}):ProviderGuestDiscoverySnapshot {
  // The provider lane's version 1 protocol has no sudo field.
  const {passwordlessSudo:_unused,...evidence}=parseDiscoveryOutput(input,"provider-guest");
  void _unused;
  return ProviderGuestDiscoverySnapshotSchema.parse({...evidence,connectionProvider:"hetzner-cloud",
    contractVersion:PROVIDER_GUEST_DISCOVERY_CONTRACT_VERSION,
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

function parseDiscoveryOutput(input:DiscoveryOutputInput,lane:HostDiscoveryScriptLane) {
  const values = parseProtocolValues(input.output, lane);
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
  const rawPasswordlessSudo = lane === "host" ? values.get("PASSWORDLESS_SUDO") : "";
  if (rawPasswordlessSudo !== "" && rawPasswordlessSudo !== "0" && rawPasswordlessSudo !== "1") {
    throw new Error("Discovery sudo probe was invalid");
  }
  const passwordlessSudo = rawPasswordlessSudo === "" ? null : rawPasswordlessSudo === "1";
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
    passwordlessSudo,
    discoveryId: input.discoveryId,
    connectionId: input.connectionId,
    connectionRevision: input.connectionRevision,
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

/** Copy for an enrolled server that Hivra couldn't reach or sign in to. */
async function enrolledFailureCopy(
  code: "SSH_AUTHENTICATION_FAILED" | "SSH_CONNECTION_FAILED",
  connection: LoadedInfrastructureConnection,
  factsPromise: Promise<{ sshMatchRules: boolean } | null>,
): Promise<{ message: string; remediation: string }> {
  const address = connection.endpoint.sshHost;
  if (code === "SSH_CONNECTION_FAILED") {
    return {
      message: `Hivra couldn't reach ${address} on port ${connection.endpoint.sshPort}.`,
      remediation: "Allow SSH from the internet in your provider's firewall (on AWS, the security group), then check again. Home or office machines aren't supported yet.",
    };
  }
  const facts = await factsPromise;
  return facts?.sshMatchRules
    ? {
        message: "Hivra reached the server but couldn't sign in as hivra.",
        remediation: "This server's SSH settings have rules for particular addresses; allow hivra from any address, then check again.",
      }
    : {
        message: "Hivra couldn't sign in as hivra. The server may have undone the setup, or its key was replaced.",
        remediation: "Run a new setup command on the server to reconnect.",
      };
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
        sshPrivilege: connection.endpoint.sshPrivilege,
        sshHostKeyType: connection.endpoint.sshHostKeyType,
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
      if (execution.presentedHostFingerprintSha256) {
        const presented = sha256FingerprintDisplay(execution.presentedHostFingerprintSha256);
        const expected = sha256FingerprintDisplay(normalizedHostFingerprint);
        await deps.recordIdentityMismatch(userId, connectionId).catch(() => undefined);
        return failure(connectionId, attemptedAt, "SSH_HOST_KEY_MISMATCH",
          presented && expected ? { ...discoveryErrorCopy("SSH_HOST_KEY_MISMATCH"), hostKey: { expected, presented } } : undefined);
      }
      if (execution.sudoFailure) {
        return failure(connectionId, attemptedAt, "SSH_SUDO_UNAVAILABLE",
          sudoFailureCopy(execution.sudoFailure, connection.endpoint.sshUser));
      }
      const code = classifyTransportFailure(execution.error ?? execution.stderr);
      if (isEnrolledConnection(connection) && (code === "SSH_AUTHENTICATION_FAILED" || code === "SSH_CONNECTION_FAILED")) {
        return failure(connectionId, attemptedAt, code,
          await enrolledFailureCopy(code, connection, deps.enrolledFacts(userId, connectionId).catch(() => null)));
      }
      return failure(connectionId, attemptedAt, code);
    }

    let snapshot: HostDiscoverySnapshot;
    try {
      snapshot = parseHostDiscoveryOutput({
        output: execution.stdout,
        discoveryId: runId,
        connectionId,
        connectionRevision: connection.revision,
        connectionProvider: connection.provider,
        privilegeVia: connection.endpoint.sshPrivilege ?? "login",
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
