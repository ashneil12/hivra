import "server-only";

/**
 * Portable Proxmox preflight protocol.
 *
 * This module deliberately knows nothing about Hivra's managed fleet, Caddy,
 * public domains, or provisioning scripts. It only inspects a Proxmox target
 * and reports whether the explicitly requested, owner-controlled target is
 * capable of hosting isolated VMs. The caller owns SSH transport and host-key
 * verification; dependency injection keeps those concerns out of this module.
 */

export const PROXMOX_PREFLIGHT_PROTOCOL = "HIVRA_PROXMOX_PREFLIGHT_V1";
export const MAX_PROXMOX_PREFLIGHT_OUTPUT_BYTES = 1280 * 1024;
const SUPPORTED_PROXMOX_MAJOR_VERSIONS = [8, 9] as const;
const PROXMOX_HOST_MEMORY_RESERVE_BYTES = 2 * 1024 ** 3;

const MAX_VMID_SPAN = 10_000;
const MAX_REQUIRED_ASSETS = 16;
const MAX_DYNAMIC_JSON_BYTES = 256 * 1024;

const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const STORAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BRIDGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,14}$/;
const ASSET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ABSOLUTE_ASSET_PATH_PATTERN = /^\/(?:[A-Za-z0-9._+@-]+\/)*[A-Za-z0-9._+@-]+$/;
const PREPARED_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

type ProxmoxPreparedAssetKind =
  | "file"
  | "directory"
  | "executable"
  | "private-file"
  | "disk-image"
  | "hivra-network";

interface ProxmoxPreparedAssetRequirement {
  id: string;
  kind: ProxmoxPreparedAssetKind;
  path: string;
  sha256?: string;
}

export interface PortableProxmoxPreflightInput {
  /** Cluster node to inspect. Omit to inspect the SSH target's local node. */
  node?: string | null;
  /** Required Linux bridge. Omit to auto-detect an available bridge. */
  bridge?: string | null;
  /** Required Proxmox storage. Omit to auto-select active VM-capable storage. */
  storage?: string | null;
  vmidRange: {
    start: number;
    end: number;
  };
  capacityPolicy?: {
    mode: "observe" | "enforce";
    hostMemoryReserveMb: number;
    cpuCeilingDensity: number;
    memoryCeilingDensity: number;
  };
  preparedTarget?: {
    /** Existing Proxmox VM template used by a later provisioner. */
    templateVmid?: number | null;
    /** When configured, the observed Proxmox VM name must match exactly. */
    templateExpectedName?: string | null;
    /** Portable provisioner contract: an exact reviewed version, never semver ranges. */
    provisioner?: {
      directory: string;
      expectedVersion?: string | null;
      /** Internal Simple-mode rolling-release policy. Advanced user config
       * does not expose this; when absent the exact expected version wins. */
      compatibleVersions?: string[];
      /** Relative checksum manifest generated inside `directory`. */
      manifestFile?: string | null;
    } | null;
    /** Generic target assets; no managed-Hivra paths are assumed. */
    requiredAssets?: ProxmoxPreparedAssetRequirement[];
  } | null;
}

interface NormalizedPreflightInput {
  node: string | null;
  bridge: string | null;
  storage: string | null;
  vmidRange: { start: number; end: number };
  capacityPolicy: NonNullable<PortableProxmoxPreflightInput["capacityPolicy"]>;
  preparedTarget: {
    templateVmid: number | null;
    templateExpectedName: string | null;
    provisioner: {
      directory: string;
      expectedVersion: string | null;
      compatibleVersions: string[];
      manifestFile: string | null;
    } | null;
    requiredAssets: ProxmoxPreparedAssetRequirement[];
  };
}

type ProxmoxPreflightIssueCode =
  | "PROXMOX_TOOL_PVEVERSION_MISSING"
  | "PROXMOX_TOOL_PVESH_MISSING"
  | "PROXMOX_TOOL_QM_MISSING"
  | "PROXMOX_TOOL_PVESM_MISSING"
  | "PROXMOX_TOOL_IP_MISSING"
  | "PROXMOX_TOOL_BASE64_MISSING"
  | "PROXMOX_TOOL_ID_MISSING"
  | "PROXMOX_ROOT_PERMISSION_REQUIRED"
  | "PROXMOX_VERSION_UNAVAILABLE"
  | "PROXMOX_VERSION_UNSUPPORTED"
  | "PROXMOX_NODE_UNAVAILABLE"
  | "PROXMOX_NODE_MISMATCH"
  | "PROXMOX_NODE_STATUS_UNAVAILABLE"
  | "PROXMOX_KVM_UNAVAILABLE"
  | "PROXMOX_CPU_VIRTUALIZATION_UNAVAILABLE"
  | "PROXMOX_CPU_CAPACITY_UNAVAILABLE"
  | "PROXMOX_MEMORY_CAPACITY_UNAVAILABLE"
  | "PROXMOX_MEMORY_CAPACITY_EXHAUSTED"
  | "PROXMOX_STORAGE_UNAVAILABLE"
  | "PROXMOX_STORAGE_NOT_FOUND"
  | "PROXMOX_STORAGE_INACTIVE"
  | "PROXMOX_STORAGE_DISABLED"
  | "PROXMOX_STORAGE_NOT_VM_CAPABLE"
  | "PROXMOX_STORAGE_CAPACITY_UNAVAILABLE"
  | "PROXMOX_STORAGE_CAPACITY_EXHAUSTED"
  | "PROXMOX_BRIDGE_UNAVAILABLE"
  | "PROXMOX_BRIDGE_NOT_FOUND"
  | "PROXMOX_VMID_INVENTORY_UNAVAILABLE"
  | "PROXMOX_VMID_RANGE_EXHAUSTED"
  | "PROXMOX_PREPARED_TARGET_UNSPECIFIED"
  | "PROXMOX_TEMPLATE_MISSING"
  | "PROXMOX_TEMPLATE_NOT_TEMPLATE"
  | "PROXMOX_TEMPLATE_NAME_MISMATCH"
  | "PROXMOX_PROVISIONER_VERSION_REQUIRED"
  | "PROXMOX_PROVISIONER_VERSION_MISSING"
  | "PROXMOX_PROVISIONER_VERSION_MISMATCH"
  | "PROXMOX_PROVISIONER_MANIFEST_INVALID"
  | "PROXMOX_REQUIRED_ASSET_MISSING";

export interface ProxmoxPreflightIssue {
  code: ProxmoxPreflightIssueCode;
  /** Sanitized, user-facing context. Never contains command output or paths. */
  message: string;
  subject?: string;
}

interface ProxmoxStorageCapability {
  id: string;
  type: string | null;
  content: string[];
  active: boolean;
  enabled: boolean;
  shared: boolean;
}

export interface ProxmoxPreflightReport {
  protocolVersion: 1;
  provider: "proxmox";
  /** The SSH target is Proxmox and this direct-command adapter can operate it. */
  connectionReady: boolean;
  /** The target has all capabilities and prepared assets needed for later launch. */
  launchReady: boolean;
  node: {
    id: string | null;
    proxmoxVersion: string | null;
  };
  capabilities: {
    /** Later lifecycle scripts invoke qm/pvesh directly and therefore require root. */
    directRootAccess: boolean;
    kvmDevice: boolean;
    cpuVirtualization: boolean;
    supportedIsolationDrivers: Array<"proxmox-kvm">;
    bridges: string[];
    selectedBridge: string | null;
    storage: ProxmoxStorageCapability[];
    selectedStorage: string | null;
    preparedTarget: {
      configured: boolean;
      ready: boolean;
      template: {
        vmid: number;
        exists: boolean;
        isTemplate: boolean;
        nameMatches: boolean;
      } | null;
      provisioner: {
        configured: boolean;
        ready: boolean;
        version: string | null;
      } | null;
      assets: Array<{
        id: string;
        kind: ProxmoxPreparedAssetKind;
        available: boolean;
      }>;
    };
  };
  capacity: {
    cpu: {
      totalCores: number | null;
      utilizationRatio: number | null;
    };
    memory: {
      totalBytes: number | null;
      /** Kernel-reported free memory before VM reservation accounting. */
      reportedFreeBytes: number | null;
      /** Configured memory claimed by every QEMU and LXC guest. */
      reservedGuestBytes: number | null;
      /** Memory deliberately left to the Proxmox host itself. */
      hostReserveBytes: number;
      /** Safe launch headroom: the lower of live free and unreserved memory. */
      availableBytes: number | null;
    };
    policy?: {
      mode: "observe" | "enforce";
      cpuCeilingDensity: number;
      memoryCeilingDensity: number;
      activeFloorMemoryBytes: number | null;
      activeCeilingMemoryBytes: number | null;
      activeCeilingCpu: number | null;
      floorMemoryHeadroomBytes: number | null;
      ceilingMemoryHeadroomBytes: number | null;
      ceilingCpuHeadroom: number | null;
    };
    storage: {
      id: string;
      totalBytes: number | null;
      availableBytes: number | null;
    } | null;
    vmids: {
      start: number;
      end: number;
      availableCount: number;
      firstAvailable: number | null;
    };
  };
  unmetRequirements: ProxmoxPreflightIssue[];
}

type ProxmoxPreflightFailureCode =
  | "PROXMOX_PREFLIGHT_INPUT_INVALID"
  | "PROXMOX_PREFLIGHT_EXECUTION_FAILED"
  | "PROXMOX_PREFLIGHT_OUTPUT_INVALID";

export type PortableProxmoxPreflightOutcome =
  | { ok: true; report: ProxmoxPreflightReport }
  | { ok: false; code: ProxmoxPreflightFailureCode; message: string };

interface ProxmoxPreflightExecutionResult {
  ok: boolean;
  stdout: string;
}

export type ProxmoxPreflightExecutor = (
  script: string,
) => Promise<ProxmoxPreflightExecutionResult>;

export class ProxmoxPreflightInputError extends Error {
  readonly code = "PROXMOX_PREFLIGHT_INPUT_INVALID" as const;
}

class ProxmoxPreflightOutputError extends Error {
  readonly code = "PROXMOX_PREFLIGHT_OUTPUT_INVALID" as const;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function inputError(message: string): never {
  throw new ProxmoxPreflightInputError(message);
}

function optionalIdentifier(
  value: unknown,
  label: string,
  pattern: RegExp,
): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") inputError(`${label} must be a string`);
  const normalized = value.trim();
  if (!pattern.test(normalized)) inputError(`${label} has an invalid format`);
  return normalized;
}

function vmid(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 100 || (value as number) > 999_999_999) {
    inputError(`${label} must be an integer between 100 and 999999999`);
  }
  return value as number;
}

function preparedPath(value: unknown, label: string): string {
  if (typeof value !== "string") inputError(`${label} must be a string`);
  const trimmed = value.trim();
  const normalized = trimmed.length > 1 ? trimmed.replace(/\/+$/g, "") : trimmed;
  if (!ABSOLUTE_ASSET_PATH_PATTERN.test(normalized)) {
    inputError(`${label} must be a simple absolute path`);
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    inputError(`${label} cannot contain traversal segments`);
  }
  return normalized;
}

function validatePortableProxmoxPreflightInput(
  input: PortableProxmoxPreflightInput,
): NormalizedPreflightInput {
  if (!isPlainObject(input)) inputError("preflight input must be an object");
  if (!isPlainObject(input.vmidRange)) inputError("vmidRange must be an object");
  const rawPolicy = input.capacityPolicy ?? {
    mode: "observe", hostMemoryReserveMb: 2048, cpuCeilingDensity: 1, memoryCeilingDensity: 1,
  };
  if (!isPlainObject(rawPolicy)
    || (rawPolicy.mode !== "observe" && rawPolicy.mode !== "enforce")
    || !Number.isSafeInteger(rawPolicy.hostMemoryReserveMb) || rawPolicy.hostMemoryReserveMb < 512 || rawPolicy.hostMemoryReserveMb > 1_048_576
    || typeof rawPolicy.cpuCeilingDensity !== "number" || rawPolicy.cpuCeilingDensity < 1 || rawPolicy.cpuCeilingDensity > 4
    || typeof rawPolicy.memoryCeilingDensity !== "number" || rawPolicy.memoryCeilingDensity < 1 || rawPolicy.memoryCeilingDensity > 4) {
    inputError("capacityPolicy is invalid");
  }

  const start = vmid(input.vmidRange.start, "vmidRange.start");
  const end = vmid(input.vmidRange.end, "vmidRange.end");
  if (end < start) inputError("vmidRange.end must be greater than or equal to vmidRange.start");
  if (end - start + 1 > MAX_VMID_SPAN) {
    inputError(`vmidRange cannot contain more than ${MAX_VMID_SPAN} VMIDs`);
  }

  const preparedInput = input.preparedTarget;
  if (preparedInput !== undefined && preparedInput !== null && !isPlainObject(preparedInput)) {
    inputError("preparedTarget must be an object");
  }
  const templateVmid = preparedInput?.templateVmid == null
    ? null
    : vmid(preparedInput.templateVmid, "preparedTarget.templateVmid");
  const templateExpectedName = optionalIdentifier(
    preparedInput?.templateExpectedName,
    "preparedTarget.templateExpectedName",
    NODE_ID_PATTERN,
  );
  if (templateExpectedName && templateVmid === null) {
    inputError("preparedTarget.templateExpectedName requires preparedTarget.templateVmid");
  }

  const rawProvisioner = preparedInput?.provisioner;
  if (rawProvisioner !== undefined && rawProvisioner !== null && !isPlainObject(rawProvisioner)) {
    inputError("preparedTarget.provisioner must be an object");
  }
  const provisioner = rawProvisioner == null
    ? null
    : {
        directory: preparedPath(
          rawProvisioner.directory,
          "preparedTarget.provisioner.directory",
        ),
        expectedVersion: optionalIdentifier(
          rawProvisioner.expectedVersion,
          "preparedTarget.provisioner.expectedVersion",
          PREPARED_VERSION_PATTERN,
        ),
        compatibleVersions: [] as string[],
        manifestFile: optionalIdentifier(
          rawProvisioner.manifestFile,
          "preparedTarget.provisioner.manifestFile",
          ASSET_ID_PATTERN,
        ),
      };

  if (rawProvisioner?.compatibleVersions !== undefined) {
    const versions = rawProvisioner.compatibleVersions;
    if (
      !provisioner || !Array.isArray(versions) || versions.length === 0 || versions.length > 4
      || versions.some(version => typeof version !== "string" || !PREPARED_VERSION_PATTERN.test(version))
      || new Set(versions).size !== versions.length || !versions.includes(provisioner.expectedVersion ?? "")
      || provisioner.manifestFile === null
    ) {
      inputError("compatibleVersions requires exact unique versions, the expected version, and a checksum manifest");
    }
    provisioner.compatibleVersions = [...versions];
  }

  const rawAssets = preparedInput?.requiredAssets ?? [];
  if (!Array.isArray(rawAssets)) inputError("preparedTarget.requiredAssets must be an array");
  if (rawAssets.length > MAX_REQUIRED_ASSETS) {
    inputError(`preparedTarget.requiredAssets cannot contain more than ${MAX_REQUIRED_ASSETS} entries`);
  }

  const assetIds = new Set<string>();
  const requiredAssets = rawAssets.map((asset, index) => {
    if (!isPlainObject(asset)) inputError(`preparedTarget.requiredAssets[${index}] must be an object`);
    const id = optionalIdentifier(asset.id, `preparedTarget.requiredAssets[${index}].id`, ASSET_ID_PATTERN);
    if (!id) inputError(`preparedTarget.requiredAssets[${index}].id is required`);
    if (assetIds.has(id)) inputError(`preparedTarget.requiredAssets contains duplicate id ${id}`);
    assetIds.add(id);

    if (
      asset.kind !== "file" &&
      asset.kind !== "directory" &&
      asset.kind !== "executable" &&
      asset.kind !== "private-file" &&
      asset.kind !== "disk-image" &&
      asset.kind !== "hivra-network"
    ) {
      inputError(`preparedTarget.requiredAssets[${index}].kind is invalid`);
    }
    const path = preparedPath(asset.path, `preparedTarget.requiredAssets[${index}].path`);
    const sha256 = optionalIdentifier(
      asset.sha256,
      `preparedTarget.requiredAssets[${index}].sha256`,
      /^[0-9a-f]{64}$/,
    );
    if (sha256 && (asset.kind === "directory" || asset.kind === "hivra-network")) {
      inputError(`preparedTarget.requiredAssets[${index}].sha256 is not supported for this kind`);
    }

    return sha256 ? { id, kind: asset.kind, path, sha256 } : { id, kind: asset.kind, path };
  });

  return {
    node: optionalIdentifier(input.node, "node", NODE_ID_PATTERN),
    bridge: optionalIdentifier(input.bridge, "bridge", BRIDGE_ID_PATTERN),
    storage: optionalIdentifier(input.storage, "storage", STORAGE_ID_PATTERN),
    vmidRange: { start, end },
    capacityPolicy: rawPolicy as NormalizedPreflightInput["capacityPolicy"],
    preparedTarget: {
      templateVmid,
      templateExpectedName,
      provisioner,
      requiredAssets,
    },
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function assetTest(asset: ProxmoxPreparedAssetRequirement, bridge: string | null): string {
  const quotedPath = shellQuote(asset.path);
  let baseTest: string;
  if (asset.kind === "directory") baseTest = `[ -d ${quotedPath} ]`;
  else if (asset.kind === "executable") baseTest = `[ -f ${quotedPath} ] && [ -x ${quotedPath} ]`;
  else if (asset.kind === "private-file") {
    baseTest = `[ -s ${quotedPath} ] && [ "$(stat -c '%a:%U:%G' ${quotedPath} 2>/dev/null)" = '600:root:root' ]`;
  } else if (asset.kind === "disk-image") {
    baseTest = `[ -s ${quotedPath} ] && qemu-img info ${quotedPath} >/dev/null 2>&1`;
  } else if (asset.kind === "hivra-network") {
    if (!bridge) return "false";
    const quotedBridge = shellQuote(bridge);
    baseTest = `[ -x ${quotedPath} ] && systemctl is-active --quiet hivra-network.service && `
      + `iptables -C INPUT -i ${quotedBridge} -j HIVRA_INPUT >/dev/null 2>&1 && `
      + `iptables -C FORWARD -i ${quotedBridge} -j HIVRA_EGRESS >/dev/null 2>&1 && `
      + `ip6tables -C INPUT -i ${quotedBridge} -j HIVRA6_INPUT >/dev/null 2>&1 && `
      + `ip6tables -C FORWARD -i ${quotedBridge} -j HIVRA6_EGRESS >/dev/null 2>&1 && `
      + `nft list chain bridge hivra_isolation forward 2>/dev/null | grep -Fq drop`;
  } else baseTest = `[ -f ${quotedPath} ]`;
  if (asset.sha256) {
    baseTest += ` && printf '%s  %s\\n' ${shellQuote(asset.sha256)} ${quotedPath} | sha256sum -c --status -`;
  }
  return baseTest;
}

/** Build a bounded, read-only shell probe. It contains no package install,
 * allocation, configuration, start/stop, or filesystem mutation commands. */
export function buildPortableProxmoxPreflightScript(
  input: PortableProxmoxPreflightInput,
): string {
  const config = validatePortableProxmoxPreflightInput(input);
  const templateVmid = config.preparedTarget.templateVmid;
  const provisioner = config.preparedTarget.provisioner;

  const assetChecks = config.preparedTarget.requiredAssets.map((asset, index) => `
if ${assetTest(asset, config.bridge)}; then
  emit "ASSET_${index}" "1"
else
  emit "ASSET_${index}" "0"
fi`).join("\n");

  const templateCheck = templateVmid === null ? "" : `
if [ "$HAS_QM" = "1" ] && qm status ${templateVmid} >/dev/null 2>&1; then
  emit "TEMPLATE_EXISTS" "1"
  capture_b64 "TEMPLATE_CONFIG_B64" 65536 qm config ${templateVmid}
else
  emit "TEMPLATE_EXISTS" "0"
fi`;

  const provisionerCheck = provisioner === null ? "" : `
if [ -d ${shellQuote(provisioner.directory)} ]; then
  emit "PROVISIONER_DIRECTORY" "1"
  capture_b64 "PROVISIONER_VERSION_B64" 256 cat ${shellQuote(`${provisioner.directory}/VERSION`)}
  ${provisioner.manifestFile ? `if (cd ${shellQuote(provisioner.directory)} && sha256sum -c --status ${shellQuote(provisioner.manifestFile)}) 2>/dev/null; then
    emit "PROVISIONER_MANIFEST" "1"
  else
    emit "PROVISIONER_MANIFEST" "0"
  fi` : ""}
else
  emit "PROVISIONER_DIRECTORY" "0"
  ${provisioner.manifestFile ? 'emit "PROVISIONER_MANIFEST" "0"' : ""}
fi`;

  const mismatchPreparedMarkers = [
    ...(templateVmid === null ? [] : ['emit "TEMPLATE_EXISTS" "0"']),
    ...(provisioner === null ? [] : [
      'emit "PROVISIONER_DIRECTORY" "0"',
      ...(provisioner.manifestFile ? ['emit "PROVISIONER_MANIFEST" "0"'] : []),
    ]),
    ...config.preparedTarget.requiredAssets.map((_, index) => `emit "ASSET_${index}" "0"`),
  ].join("\n  ");
  const capacityInspection = `
CAPACITY_EVIDENCE=1
ACTIVE_FLOOR_MB=0
ACTIVE_MAX_MB=0
ACTIVE_MAX_CPU_MILLI=0
if [ "$HAS_QM" = "1" ]; then
  QEMU_INVENTORY="$(qm list 2>/dev/null)" || CAPACITY_EVIDENCE=0
  QEMU_CANDIDATES="$(printf '%s\\n' "$QEMU_INVENTORY" | awk 'NF && !header {header=1; if ($1!="VMID") exit 2; next} NF {if ($1 !~ /^[0-9]+$/) exit 3; print $1}')" || CAPACITY_EVIDENCE=0
  while IFS= read -r candidate; do
    [ -n "$candidate" ] || continue
    config="$(qm config "$candidate" 2>/dev/null)" || { CAPACITY_EVIDENCE=0; continue; }
    [ "$(printf '%s\\n' "$config" | awk '$1=="template:" {print $2; exit}')" = "1" ] && continue
    status_output="$(qm status "$candidate" 2>/dev/null)" || { CAPACITY_EVIDENCE=0; continue; }
    status="$(printf '%s\\n' "$status_output" | awk 'NF==2 && $1=="status:" && ($2=="running" || $2=="stopped") {print $2}')"
    [ -n "$status" ] || { CAPACITY_EVIDENCE=0; continue; }
    [ "$status" = "running" ] || continue
    floor="$(printf '%s\\n' "$config" | awk '$1=="balloon:" {print $2; exit}')"
    case "$floor" in ''|*[!0-9]*|0) floor="$(printf '%s\\n' "$config" | awk '$1=="memory:" {print $2; exit}')" ;; esac
    maximum="$(printf '%s\\n' "$config" | awk '$1=="memory:" {print $2; exit}')"
    cpu="$(printf '%s\\n' "$config" | awk '$1=="cpulimit:" {print $2; exit}')"
    case "$cpu" in ''|0)
      cores="$(printf '%s\\n' "$config" | awk '$1=="cores:" {print $2; exit}')"
      sockets="$(printf '%s\\n' "$config" | awk '$1=="sockets:" {print $2; exit}')"
      [ -n "$sockets" ] || sockets=1
      case "$cores:$sockets" in *[!0-9:]*) CAPACITY_EVIDENCE=0; continue ;; esac
      [ "$cores" -gt 0 ] && [ "$sockets" -gt 0 ] || { CAPACITY_EVIDENCE=0; continue; }
      cpu=$((cores * sockets))
      ;;
    esac
    case "$floor:$maximum:$cpu" in *[!0-9.:]*) CAPACITY_EVIDENCE=0; continue ;; esac
    ACTIVE_FLOOR_MB=$((ACTIVE_FLOOR_MB + floor))
    ACTIVE_MAX_MB=$((ACTIVE_MAX_MB + maximum))
    cpu_milli="$(awk -v v="$cpu" 'BEGIN { printf "%d", (v * 1000) + 0.5 }')"
    ACTIVE_MAX_CPU_MILLI=$((ACTIVE_MAX_CPU_MILLI + cpu_milli))
  done <<EOF
$QEMU_CANDIDATES
EOF
else
  CAPACITY_EVIDENCE=0
fi
if command -v pct >/dev/null 2>&1; then
  PCT_INVENTORY="$(pct list 2>/dev/null)" || CAPACITY_EVIDENCE=0
  PCT_CANDIDATES="$(printf '%s\\n' "$PCT_INVENTORY" | awk 'NF && !header {header=1; if ($1!="VMID") exit 2; next} NF {if ($1 !~ /^[0-9]+$/) exit 3; print $1}')" || CAPACITY_EVIDENCE=0
  while IFS= read -r candidate; do
    [ -n "$candidate" ] || continue
    status_output="$(pct status "$candidate" 2>/dev/null)" || { CAPACITY_EVIDENCE=0; continue; }
    status="$(printf '%s\\n' "$status_output" | awk 'NF==2 && $1=="status:" && ($2=="running" || $2=="stopped") {print $2}')"
    [ -n "$status" ] || { CAPACITY_EVIDENCE=0; continue; }
    [ "$status" = "running" ] || continue
    config="$(pct config "$candidate" 2>/dev/null)" || { CAPACITY_EVIDENCE=0; continue; }
    memory="$(printf '%s\\n' "$config" | awk '$1=="memory:" {print $2; exit}')"
    cpu="$(printf '%s\\n' "$config" | awk '$1=="cpulimit:" {print $2; exit}')"
    case "$cpu" in ''|0) cpu="$(printf '%s\\n' "$config" | awk '$1=="cores:" {print $2; exit}')" ;; esac
    case "$memory:$cpu" in *[!0-9.:]*) CAPACITY_EVIDENCE=0; continue ;; esac
    ACTIVE_FLOOR_MB=$((ACTIVE_FLOOR_MB + memory))
    ACTIVE_MAX_MB=$((ACTIVE_MAX_MB + memory))
    cpu_milli="$(awk -v v="$cpu" 'BEGIN { printf "%d", (v * 1000) + 0.5 }')"
    ACTIVE_MAX_CPU_MILLI=$((ACTIVE_MAX_CPU_MILLI + cpu_milli))
  done <<EOF
$PCT_CANDIDATES
EOF
fi
emit "CAPACITY_EVIDENCE" "$CAPACITY_EVIDENCE"
emit "ACTIVE_FLOOR_MB" "$ACTIVE_FLOOR_MB"
emit "ACTIVE_MAX_MB" "$ACTIVE_MAX_MB"
emit "ACTIVE_MAX_CPU_MILLI" "$ACTIVE_MAX_CPU_MILLI"`;

  return `#!/bin/sh
set -u
export LC_ALL=C
PREFIX=${shellQuote(PROXMOX_PREFLIGHT_PROTOCOL)}

emit() {
  printf '%s|%s|%s\\n' "$PREFIX" "$1" "$2"
}

has_command() {
  if command -v "$1" >/dev/null 2>&1; then printf '1'; else printf '0'; fi
}

HAS_PVEVERSION="$(has_command pveversion)"
HAS_PVESH="$(has_command pvesh)"
HAS_QM="$(has_command qm)"
HAS_PVESM="$(has_command pvesm)"
HAS_IP="$(has_command ip)"
HAS_BASE64="$(has_command base64)"
HAS_ID="$(has_command id)"

capture_b64() {
  key="$1"
  limit="$2"
  shift 2
  if [ "$HAS_BASE64" != "1" ]; then return 0; fi
  value="$("$@" 2>/dev/null | head -c "$limit" | base64 | tr -d '\\n' || true)"
  emit "$key" "$value"
}

emit "PROTOCOL" "1"
emit "TOOL_PVEVERSION" "$HAS_PVEVERSION"
emit "TOOL_PVESH" "$HAS_PVESH"
emit "TOOL_QM" "$HAS_QM"
emit "TOOL_PVESM" "$HAS_PVESM"
emit "TOOL_IP" "$HAS_IP"
emit "TOOL_BASE64" "$HAS_BASE64"
emit "TOOL_ID" "$HAS_ID"

EFFECTIVE_UID=""
if [ "$HAS_ID" = "1" ]; then
  EFFECTIVE_UID="$(id -u 2>/dev/null | head -n 1 | head -c 16 || true)"
  case "$EFFECTIVE_UID" in
    ''|*[!0-9]*) EFFECTIVE_UID="" ;;
  esac
fi
emit "EFFECTIVE_UID" "$EFFECTIVE_UID"

LOCAL_NODE="$(hostname -s 2>/dev/null | head -c 64)"
NODE=${config.node ? shellQuote(config.node) : '"$LOCAL_NODE"'}
if [ "$HAS_BASE64" = "1" ]; then
  encoded_local_node="$(printf '%s' "$LOCAL_NODE" | head -c 64 | base64 | tr -d '\\n' || true)"
  emit "LOCAL_NODE_B64" "$encoded_local_node"
  encoded_node="$(printf '%s' "$NODE" | head -c 64 | base64 | tr -d '\\n' || true)"
  emit "NODE_B64" "$encoded_node"
fi

if [ -n "$LOCAL_NODE" ] && [ "$NODE" = "$LOCAL_NODE" ]; then
  emit "NODE_MATCH" "1"
else
  emit "NODE_MATCH" "0"
fi

if [ "$HAS_PVEVERSION" = "1" ]; then
  capture_b64 "PVE_VERSION_B64" 512 pveversion
fi

# All remaining checks are local-node observations. Never combine remote-node
# API capacity with local KVM, bridge, storage, template, or asset evidence.
if [ "$NODE" != "$LOCAL_NODE" ]; then
  emit "KVM_DEVICE" "0"
  emit "CPU_VIRTUALIZATION" "0"
  ${mismatchPreparedMarkers}
  emit "CAPACITY_EVIDENCE" "0"
  emit "ACTIVE_FLOOR_MB" "0"
  emit "ACTIVE_MAX_MB" "0"
  emit "ACTIVE_MAX_CPU_MILLI" "0"
  emit "END" "1"
  exit 0
fi

if [ "$HAS_PVESH" = "1" ] && [ -n "$NODE" ]; then
  capture_b64 "NODE_STATUS_B64" 65536 pvesh get "/nodes/$NODE/status" --output-format json
  capture_b64 "NODE_NETWORK_B64" 65536 pvesh get "/nodes/$NODE/network" --output-format json
  capture_b64 "STORAGE_CONFIG_B64" 131072 pvesh get /storage --output-format json
  capture_b64 "STORAGE_STATUS_B64" 131072 pvesh get "/nodes/$NODE/storage" --output-format json
  capture_b64 "VM_RESOURCES_B64" ${MAX_DYNAMIC_JSON_BYTES} pvesh get /cluster/resources --type vm --output-format json
fi
${capacityInspection}

if [ "$HAS_IP" = "1" ]; then
  capture_b64 "BRIDGES_B64" 65536 ip -json link show type bridge
fi

if [ -c /dev/kvm ] && [ -r /dev/kvm ] && [ -w /dev/kvm ]; then
  emit "KVM_DEVICE" "1"
else
  emit "KVM_DEVICE" "0"
fi

if grep -Eq -m1 '(vmx|svm)' /proc/cpuinfo 2>/dev/null; then
  emit "CPU_VIRTUALIZATION" "1"
else
  emit "CPU_VIRTUALIZATION" "0"
fi
${templateCheck}
${provisionerCheck}
${assetChecks}

emit "END" "1"
`;
}

function outputError(message: string): never {
  throw new ProxmoxPreflightOutputError(message);
}

function parseProtocolMarkers(stdout: string, allowedKeys: Set<string>): Map<string, string> {
  if (Buffer.byteLength(stdout, "utf8") > MAX_PROXMOX_PREFLIGHT_OUTPUT_BYTES) {
    outputError("preflight output exceeded the limit");
  }
  const markers = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith(`${PROXMOX_PREFLIGHT_PROTOCOL}|`)) continue;
    if (Buffer.byteLength(line, "utf8") > MAX_DYNAMIC_JSON_BYTES * 2) {
      outputError("preflight marker exceeded the limit");
    }
    const pieces = line.split("|");
    if (pieces.length !== 3) outputError("preflight marker was malformed");
    const [, key, value] = pieces;
    if (!allowedKeys.has(key)) outputError("preflight output contained an unknown marker");
    if (markers.has(key)) outputError("preflight output contained a duplicate marker");
    markers.set(key, value);
  }
  if (markers.get("PROTOCOL") !== "1" || markers.get("END") !== "1") {
    outputError("preflight output was incomplete");
  }
  return markers;
}

function markerFlag(markers: Map<string, string>, key: string, required = true): boolean {
  const value = markers.get(key);
  if (value === undefined && !required) return false;
  if (value !== "0" && value !== "1") outputError(`preflight marker ${key} was invalid`);
  return value === "1";
}

function decodeBase64Marker(
  markers: Map<string, string>,
  key: string,
  maxBytes: number,
): string | null {
  const encoded = markers.get(key);
  if (encoded === undefined || encoded === "") return null;
  if (encoded.length > Math.ceil(maxBytes / 3) * 4 + 4) outputError(`${key} exceeded the limit`);
  if (encoded.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    outputError(`${key} was not canonical base64`);
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length > maxBytes || bytes.toString("base64") !== encoded) outputError(`${key} was invalid`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    outputError(`${key} was not valid UTF-8`);
  }
}

function parseJsonValue(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value)
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= Number.MAX_SAFE_INTEGER ? parsed : null;
}

function safeInteger(value: unknown): number | null {
  const parsed = finiteNumber(value);
  return parsed !== null && Number.isSafeInteger(parsed) ? parsed : null;
}

function positiveSafeInteger(value: unknown): number | null {
  const parsed = safeInteger(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function safeObject(value: unknown): Record<string, unknown> | null {
  return isPlainObject(value) ? value : null;
}

function safeArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function safeDisplayText(value: string | null, maxLength: number): string | null {
  if (!value) return null;
  const firstLine = value.split(/\r?\n/, 1)[0].trim();
  if (!firstLine) return null;
  return firstLine.slice(0, maxLength).replace(/[^A-Za-z0-9._+~:/() -]/g, "?");
}

export function isSupportedProxmoxVersion(value: string | null): boolean {
  if (!value) return false;
  const match = value.match(/^pve-manager\/(\d+)\.(\d+)(?:\.\d+)?(?:\/|$)/);
  if (!match) return false;
  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  return Number.isSafeInteger(major)
    && Number.isSafeInteger(minor)
    && (SUPPORTED_PROXMOX_MAJOR_VERSIONS as readonly number[]).includes(major);
}

function observedConfigValue(config: string | null, key: string, pattern: RegExp): string | null {
  if (!config) return null;
  const prefix = `${key}:`;
  for (const line of config.split(/\r?\n/)) {
    if (!line.startsWith(prefix)) continue;
    const value = line.slice(prefix.length).trim();
    return pattern.test(value) ? value : null;
  }
  return null;
}

function sanitizeStorage(
  storageConfigValue: unknown,
  storageStatusValue: unknown,
): Array<ProxmoxStorageCapability & { totalBytes: number | null; availableBytes: number | null }> {
  const configs = new Map<string, Record<string, unknown>>();
  for (const raw of safeArray(storageConfigValue).slice(0, 128)) {
    const item = safeObject(raw);
    const id = typeof item?.storage === "string" && STORAGE_ID_PATTERN.test(item.storage)
      ? item.storage
      : null;
    if (id) configs.set(id, item!);
  }

  const statuses = new Map<string, Record<string, unknown>>();
  for (const raw of safeArray(storageStatusValue).slice(0, 128)) {
    const item = safeObject(raw);
    const id = typeof item?.storage === "string" && STORAGE_ID_PATTERN.test(item.storage)
      ? item.storage
      : null;
    if (id) statuses.set(id, item!);
  }

  const ids = Array.from(new Set([...configs.keys(), ...statuses.keys()])).sort().slice(0, 64);
  return ids.map((id) => {
    const config = configs.get(id) ?? {};
    const status = statuses.get(id) ?? {};
    const rawType = typeof config.type === "string" ? config.type : status.type;
    const type = typeof rawType === "string" && /^[A-Za-z0-9._-]{1,32}$/.test(rawType)
      ? rawType
      : null;
    const rawContent = typeof config.content === "string" ? config.content.split(",") : [];
    const content = rawContent
      .map((entry) => entry.trim())
      .filter((entry) => /^[A-Za-z0-9_-]{1,24}$/.test(entry))
      .slice(0, 16);
    return {
      id,
      type,
      content,
      active: status.active === 1 || status.active === true || status.active === "1",
      enabled: !(config.disable === 1 || config.disable === true || config.disable === "1")
        && !(status.enabled === 0 || status.enabled === false || status.enabled === "0"),
      shared: config.shared === 1 || config.shared === true || config.shared === "1",
      totalBytes: safeInteger(status.total),
      availableBytes: (() => {
        const total = safeInteger(status.total);
        const available = safeInteger(status.avail);
        return total !== null && available !== null && available <= total ? available : null;
      })(),
    };
  });
}

function sanitizeBridges(networkValue: unknown, linkValue: unknown): string[] {
  const configured = new Set<string>();
  for (const raw of safeArray(networkValue).slice(0, 128)) {
    const item = safeObject(raw);
    const name = typeof item?.iface === "string"
      ? item.iface
      : typeof item?.ifname === "string"
        ? item.ifname
        : null;
    if (item?.type === "bridge" && name && BRIDGE_ID_PATTERN.test(name)) {
      configured.add(name);
    }
  }

  const administrativelyUp = new Set<string>();
  for (const raw of safeArray(linkValue).slice(0, 128)) {
    const item = safeObject(raw);
    const flags = Array.isArray(item?.flags)
      ? item.flags.filter((flag): flag is string => typeof flag === "string")
      : [];
    if (
      typeof item?.ifname === "string"
      && BRIDGE_ID_PATTERN.test(item.ifname)
      && flags.includes("UP")
    ) {
      administrativelyUp.add(item.ifname);
    }
  }

  return Array.from(configured)
    .filter((name) => administrativelyUp.has(name))
    .sort()
    .slice(0, 32);
}

function sanitizeVmInventory(value: unknown, selectedNodeId: string | null): {
  available: boolean;
  used: Set<number>;
  reservedMemoryBytes: number | null;
} {
  const result = new Set<number>();
  if (!Array.isArray(value) || value.length > 100_000) {
    return { available: false, used: result, reservedMemoryBytes: null };
  }
  let reservedMemoryBytes = 0;
  let reservationEvidenceAvailable = selectedNodeId !== null;
  for (const raw of value) {
    const item = safeObject(raw);
    const id = safeInteger(item?.vmid);
    if (!item || id === null) {
      return { available: false, used: new Set<number>(), reservedMemoryBytes: null };
    }
    result.add(id);
    const itemType = item.type === "qemu" || item.type === "lxc" ? item.type : null;
    const itemNode = typeof item.node === "string" && NODE_ID_PATTERN.test(item.node)
      ? item.node
      : null;
    const templateFlag = safeInteger(item.template);
    if (itemType === null || itemNode === null || (templateFlag !== 0 && templateFlag !== 1)) {
      reservationEvidenceAvailable = false;
      continue;
    }
    if (itemNode !== selectedNodeId || templateFlag === 1) continue;
    const maxMemory = positiveSafeInteger(item.maxmem);
    if (maxMemory === null) {
      reservationEvidenceAvailable = false;
      continue;
    }
    const nextReservation = reservedMemoryBytes + maxMemory;
    if (!Number.isSafeInteger(nextReservation)) {
      reservationEvidenceAvailable = false;
      continue;
    }
    reservedMemoryBytes = nextReservation;
  }
  return {
    available: true,
    used: result,
    reservedMemoryBytes: reservationEvidenceAvailable ? reservedMemoryBytes : null,
  };
}

function issue(
  issues: ProxmoxPreflightIssue[],
  code: ProxmoxPreflightIssueCode,
  message: string,
  subject?: string,
): void {
  issues.push(subject ? { code, message, subject } : { code, message });
}

/** Parse only the constrained protocol markers and return a sanitized DTO. */
export function parsePortableProxmoxPreflightOutput(
  stdout: string,
  input: PortableProxmoxPreflightInput,
): ProxmoxPreflightReport {
  const config = validatePortableProxmoxPreflightInput(input);
  const allowedKeys = new Set([
    "PROTOCOL",
    "TOOL_PVEVERSION",
    "TOOL_PVESH",
    "TOOL_QM",
    "TOOL_PVESM",
    "TOOL_IP",
    "TOOL_BASE64",
    "TOOL_ID",
    "EFFECTIVE_UID",
    "LOCAL_NODE_B64",
    "NODE_B64",
    "NODE_MATCH",
    "PVE_VERSION_B64",
    "NODE_STATUS_B64",
    "NODE_NETWORK_B64",
    "STORAGE_CONFIG_B64",
    "STORAGE_STATUS_B64",
    "VM_RESOURCES_B64",
    "CAPACITY_EVIDENCE",
    "ACTIVE_FLOOR_MB",
    "ACTIVE_MAX_MB",
    "ACTIVE_MAX_CPU_MILLI",
    "BRIDGES_B64",
    "KVM_DEVICE",
    "CPU_VIRTUALIZATION",
    "TEMPLATE_EXISTS",
    "TEMPLATE_CONFIG_B64",
    "PROVISIONER_DIRECTORY",
    "PROVISIONER_VERSION_B64",
    "PROVISIONER_MANIFEST",
    "END",
    ...config.preparedTarget.requiredAssets.map((_, index) => `ASSET_${index}`),
  ]);
  const markers = parseProtocolMarkers(stdout, allowedKeys);
  const issues: ProxmoxPreflightIssue[] = [];

  const tools = {
    pveversion: markerFlag(markers, "TOOL_PVEVERSION"),
    pvesh: markerFlag(markers, "TOOL_PVESH"),
    qm: markerFlag(markers, "TOOL_QM"),
    pvesm: markerFlag(markers, "TOOL_PVESM"),
    ip: markerFlag(markers, "TOOL_IP"),
    base64: markerFlag(markers, "TOOL_BASE64"),
    id: markerFlag(markers, "TOOL_ID"),
  };
  const toolIssues: Array<[keyof typeof tools, ProxmoxPreflightIssueCode, string]> = [
    ["pveversion", "PROXMOX_TOOL_PVEVERSION_MISSING", "pveversion is not installed"],
    ["pvesh", "PROXMOX_TOOL_PVESH_MISSING", "pvesh is not installed"],
    ["qm", "PROXMOX_TOOL_QM_MISSING", "qm is not installed"],
    ["pvesm", "PROXMOX_TOOL_PVESM_MISSING", "pvesm is not installed"],
    ["ip", "PROXMOX_TOOL_IP_MISSING", "ip is not installed"],
    ["base64", "PROXMOX_TOOL_BASE64_MISSING", "base64 is not installed"],
    ["id", "PROXMOX_TOOL_ID_MISSING", "id is not installed"],
  ];
  for (const [key, code, message] of toolIssues) {
    if (!tools[key]) issue(issues, code, message);
  }

  const directRootAccess = tools.id && markers.get("EFFECTIVE_UID") === "0";
  if (tools.id && !directRootAccess) {
    issue(
      issues,
      "PROXMOX_ROOT_PERMISSION_REQUIRED",
      "The SSH account must have effective UID 0 for direct Proxmox lifecycle commands",
    );
  }

  const localNodeText = decodeBase64Marker(markers, "LOCAL_NODE_B64", 64);
  const localNodeId = localNodeText && NODE_ID_PATTERN.test(localNodeText.trim())
    ? localNodeText.trim()
    : null;
  const nodeText = decodeBase64Marker(markers, "NODE_B64", 64);
  const nodeId = nodeText && NODE_ID_PATTERN.test(nodeText.trim()) ? nodeText.trim() : null;
  if (!nodeId) issue(issues, "PROXMOX_NODE_UNAVAILABLE", "The Proxmox node could not be identified");
  const nodeMatchMarker = markerFlag(markers, "NODE_MATCH");
  const selectedNodeMatchesSshNode = Boolean(
    nodeMatchMarker && localNodeId && nodeId && localNodeId === nodeId,
  );
  if (!selectedNodeMatchesSshNode) {
    issue(
      issues,
      "PROXMOX_NODE_MISMATCH",
      "The selected Proxmox node does not match the SSH host node",
    );
  }

  const proxmoxVersion = safeDisplayText(
    decodeBase64Marker(markers, "PVE_VERSION_B64", 512),
    160,
  );
  if (!proxmoxVersion) issue(issues, "PROXMOX_VERSION_UNAVAILABLE", "The Proxmox version could not be read");
  else if (!isSupportedProxmoxVersion(proxmoxVersion)) {
    issue(issues, "PROXMOX_VERSION_UNSUPPORTED", "The detected Proxmox version is not supported");
  }

  const nodeStatus = safeObject(parseJsonValue(
    decodeBase64Marker(markers, "NODE_STATUS_B64", 65_536),
  ));
  if (!nodeStatus) issue(issues, "PROXMOX_NODE_STATUS_UNAVAILABLE", "The Proxmox node status could not be read");
  const vmResourcesValue = parseJsonValue(
    decodeBase64Marker(markers, "VM_RESOURCES_B64", MAX_DYNAMIC_JSON_BYTES),
  );
  const vmInventory = sanitizeVmInventory(vmResourcesValue, nodeId);
  const hasCapacityMarkers = markers.has("CAPACITY_EVIDENCE");
  const capacityEvidence = hasCapacityMarkers && markerFlag(markers, "CAPACITY_EVIDENCE", false);
  const activeFloorMb = capacityEvidence ? safeInteger(markers.get("ACTIVE_FLOOR_MB")) : null;
  const activeMaxMb = capacityEvidence ? safeInteger(markers.get("ACTIVE_MAX_MB")) : null;
  const activeMaxCpuMilli = capacityEvidence ? safeInteger(markers.get("ACTIVE_MAX_CPU_MILLI")) : null;

  const cpuInfo = safeObject(nodeStatus?.cpuinfo);
  const totalCores = positiveSafeInteger(nodeStatus?.maxcpu)
    ?? positiveSafeInteger(cpuInfo?.cpus)
    ?? (() => {
      const cores = positiveSafeInteger(cpuInfo?.cores);
      const sockets = positiveSafeInteger(cpuInfo?.sockets);
      if (cores === null || sockets === null) return null;
      const product = cores * sockets;
      return Number.isSafeInteger(product) && product > 0 ? product : null;
    })();
  const utilization = finiteNumber(nodeStatus?.cpu);
  const utilizationRatio = utilization !== null && utilization <= 1 ? utilization : null;
  if (!totalCores || utilizationRatio === null) {
    issue(issues, "PROXMOX_CPU_CAPACITY_UNAVAILABLE", "CPU capacity could not be read");
  }

  const memory = safeObject(nodeStatus?.memory);
  const totalMemory = safeInteger(memory?.total) ?? safeInteger(nodeStatus?.maxmem);
  const usedMemory = safeInteger(memory?.used) ?? safeInteger(nodeStatus?.mem);
  const reportedFreeMemory = safeInteger(memory?.free)
    ?? (totalMemory !== null && usedMemory !== null && usedMemory <= totalMemory
      ? totalMemory - usedMemory
      : null);
  const normalizedReportedFreeMemory = totalMemory !== null
    && reportedFreeMemory !== null
    && reportedFreeMemory <= totalMemory
    ? reportedFreeMemory
    : null;
  const hostReserveBytes = config.capacityPolicy.hostMemoryReserveMb * 1024 ** 2;
  const activeFloorBytes = hasCapacityMarkers
    ? activeFloorMb === null ? null : activeFloorMb * 1024 ** 2
    : vmInventory.reservedMemoryBytes;
  const activeMaxBytes = hasCapacityMarkers
    ? activeMaxMb === null ? null : activeMaxMb * 1024 ** 2
    : vmInventory.reservedMemoryBytes;
  const reservationAvailableMemory = totalMemory !== null
    && activeFloorBytes !== null
    ? Math.max(0, totalMemory - activeFloorBytes - hostReserveBytes)
    : null;
  const availableMemory = hasCapacityMarkers
    ? reservationAvailableMemory
    : normalizedReportedFreeMemory !== null && reservationAvailableMemory !== null
      ? Math.min(normalizedReportedFreeMemory, reservationAvailableMemory)
      : null;
  if (!totalMemory || normalizedReportedFreeMemory === null) {
    issue(issues, "PROXMOX_MEMORY_CAPACITY_UNAVAILABLE", "Memory capacity could not be read");
  } else if ((hasCapacityMarkers && !capacityEvidence) || activeFloorBytes === null) {
    issue(
      issues,
      "PROXMOX_MEMORY_CAPACITY_UNAVAILABLE",
      "Memory admission could not account for active VM and container floors",
    );
  } else if (availableMemory === 0) {
    issue(
      issues,
      "PROXMOX_MEMORY_CAPACITY_EXHAUSTED",
      "No unreserved memory remains after existing computers and host headroom",
    );
  }

  const storage = sanitizeStorage(
    parseJsonValue(decodeBase64Marker(markers, "STORAGE_CONFIG_B64", 131_072)),
    parseJsonValue(decodeBase64Marker(markers, "STORAGE_STATUS_B64", 131_072)),
  );
  const selectedStorage = config.storage
    ? storage.find((entry) => entry.id === config.storage) ?? null
    : storage.find((entry) => entry.active && entry.enabled && entry.content.includes("images"))
      ?? null;
  if (!selectedStorage) {
    issue(
      issues,
      config.storage ? "PROXMOX_STORAGE_NOT_FOUND" : "PROXMOX_STORAGE_UNAVAILABLE",
      config.storage ? "The selected storage was not found" : "No active Proxmox storage was detected",
      config.storage ?? undefined,
    );
  } else {
    if (!selectedStorage.active) issue(issues, "PROXMOX_STORAGE_INACTIVE", "The selected storage is inactive", selectedStorage.id);
    if (!selectedStorage.enabled) issue(issues, "PROXMOX_STORAGE_DISABLED", "The selected storage is disabled", selectedStorage.id);
    if (!selectedStorage.content.includes("images")) {
      issue(issues, "PROXMOX_STORAGE_NOT_VM_CAPABLE", "The selected storage does not accept VM images", selectedStorage.id);
    }
    if (selectedStorage.totalBytes === null || selectedStorage.availableBytes === null) {
      issue(issues, "PROXMOX_STORAGE_CAPACITY_UNAVAILABLE", "Storage capacity could not be read", selectedStorage.id);
    } else if (selectedStorage.availableBytes === 0) {
      issue(issues, "PROXMOX_STORAGE_CAPACITY_EXHAUSTED", "No storage capacity is currently available", selectedStorage.id);
    }
  }

  const bridges = sanitizeBridges(
    parseJsonValue(decodeBase64Marker(markers, "NODE_NETWORK_B64", 65_536)),
    parseJsonValue(decodeBase64Marker(markers, "BRIDGES_B64", 65_536)),
  );
  const selectedBridge = config.bridge
    ? bridges.find((entry) => entry === config.bridge) ?? null
    : bridges[0] ?? null;
  if (!selectedBridge) {
    issue(
      issues,
      config.bridge ? "PROXMOX_BRIDGE_NOT_FOUND" : "PROXMOX_BRIDGE_UNAVAILABLE",
      config.bridge ? "The selected network bridge was not found" : "No network bridge was detected",
      config.bridge ?? undefined,
    );
  }

  const vmInventoryAvailable = vmInventory.available;
  const allocatedVmids = vmInventory.used;
  let availableCount = 0;
  let firstAvailable: number | null = null;
  if (vmInventoryAvailable) {
    for (let id = config.vmidRange.start; id <= config.vmidRange.end; id += 1) {
      if (!allocatedVmids.has(id)) {
        availableCount += 1;
        firstAvailable ??= id;
      }
    }
  }
  if (!vmInventoryAvailable) {
    issue(issues, "PROXMOX_VMID_INVENTORY_UNAVAILABLE", "The cluster VMID inventory could not be read");
  } else if (availableCount === 0) {
    issue(issues, "PROXMOX_VMID_RANGE_EXHAUSTED", "The configured VMID range is exhausted");
  }

  const kvmDevice = markerFlag(markers, "KVM_DEVICE");
  const cpuVirtualization = markerFlag(markers, "CPU_VIRTUALIZATION");
  if (!kvmDevice) issue(issues, "PROXMOX_KVM_UNAVAILABLE", "The KVM device is unavailable");
  if (!cpuVirtualization) {
    issue(issues, "PROXMOX_CPU_VIRTUALIZATION_UNAVAILABLE", "CPU virtualization support is unavailable");
  }

  const templateVmid = config.preparedTarget.templateVmid;
  let template: ProxmoxPreflightReport["capabilities"]["preparedTarget"]["template"] = null;
  if (templateVmid !== null) {
    const exists = markerFlag(markers, "TEMPLATE_EXISTS", false);
    const templateConfig = decodeBase64Marker(markers, "TEMPLATE_CONFIG_B64", 65_536);
    const isTemplate = exists && Boolean(templateConfig?.split(/\r?\n/).some((line) => /^template:\s*1\s*$/.test(line)));
    const observedName = observedConfigValue(templateConfig, "name", NODE_ID_PATTERN);
    const nameMatches = config.preparedTarget.templateExpectedName === null
      || observedName === config.preparedTarget.templateExpectedName;
    template = { vmid: templateVmid, exists, isTemplate, nameMatches };
    if (!exists) issue(issues, "PROXMOX_TEMPLATE_MISSING", "The configured VM template was not found", String(templateVmid));
    else if (!isTemplate) issue(issues, "PROXMOX_TEMPLATE_NOT_TEMPLATE", "The configured VM is not marked as a template", String(templateVmid));
    else if (!nameMatches) {
      issue(
        issues,
        "PROXMOX_TEMPLATE_NAME_MISMATCH",
        "The configured VM template name does not match",
        String(templateVmid),
      );
    }
  }

  const configuredProvisioner = config.preparedTarget.provisioner;
  let provisioner: ProxmoxPreflightReport["capabilities"]["preparedTarget"]["provisioner"] = null;
  if (configuredProvisioner) {
    const directoryAvailable = markerFlag(markers, "PROVISIONER_DIRECTORY", false);
    const rawVersion = decodeBase64Marker(markers, "PROVISIONER_VERSION_B64", 256);
    const firstVersionLine = rawVersion?.split(/\r?\n/, 1)[0].trim() ?? "";
    const observedVersion = PREPARED_VERSION_PATTERN.test(firstVersionLine)
      ? firstVersionLine
      : null;
    const expectedVersion = configuredProvisioner.expectedVersion;
    const versionMatches = observedVersion !== null && (observedVersion === expectedVersion
      || configuredProvisioner.compatibleVersions.includes(observedVersion));
    const manifestValid = configuredProvisioner.manifestFile === null
      || markerFlag(markers, "PROVISIONER_MANIFEST", false);
    const ready = directoryAvailable
      && expectedVersion !== null
      && versionMatches
      && manifestValid;
    provisioner = { configured: true, ready, version: observedVersion };
    if (expectedVersion === null) {
      issue(
        issues,
        "PROXMOX_PROVISIONER_VERSION_REQUIRED",
        "A provisioner version must be configured before launch",
      );
    } else if (!directoryAvailable || observedVersion === null) {
      issue(
        issues,
        "PROXMOX_PROVISIONER_VERSION_MISSING",
        "The versioned provisioner evidence is unavailable",
      );
    } else if (!versionMatches) {
      issue(
        issues,
        "PROXMOX_PROVISIONER_VERSION_MISMATCH",
        "The installed provisioner version does not match",
      );
    } else if (!manifestValid) {
      issue(
        issues,
        "PROXMOX_PROVISIONER_MANIFEST_INVALID",
        "The installed provisioner bundle failed checksum verification",
      );
    }
  }

  const assets = config.preparedTarget.requiredAssets.map((asset, index) => {
    const available = markerFlag(markers, `ASSET_${index}`);
    if (!available) {
      issue(issues, "PROXMOX_REQUIRED_ASSET_MISSING", `Required ${asset.kind} is unavailable`, asset.id);
    }
    return { id: asset.id, kind: asset.kind, available };
  });
  const preparedConfigured = templateVmid !== null || provisioner !== null || assets.length > 0;
  if (!preparedConfigured) {
    issue(
      issues,
      "PROXMOX_PREPARED_TARGET_UNSPECIFIED",
      "No prepared-target template or assets were configured",
    );
  }
  const preparedReady = preparedConfigured
    && (template === null || (template.exists && template.isTemplate && template.nameMatches))
    && (provisioner === null || provisioner.ready)
    && assets.every((asset) => asset.available);

  const connectionBlockingCodes = new Set<ProxmoxPreflightIssueCode>([
    "PROXMOX_TOOL_PVEVERSION_MISSING",
    "PROXMOX_TOOL_PVESH_MISSING",
    "PROXMOX_TOOL_QM_MISSING",
    "PROXMOX_TOOL_PVESM_MISSING",
    "PROXMOX_TOOL_BASE64_MISSING",
    "PROXMOX_TOOL_ID_MISSING",
    "PROXMOX_ROOT_PERMISSION_REQUIRED",
    "PROXMOX_VERSION_UNAVAILABLE",
    "PROXMOX_VERSION_UNSUPPORTED",
    "PROXMOX_NODE_UNAVAILABLE",
    "PROXMOX_NODE_MISMATCH",
    "PROXMOX_NODE_STATUS_UNAVAILABLE",
  ]);
  const connectionReady = !issues.some((entry) => connectionBlockingCodes.has(entry.code));
  const launchReady = connectionReady
    && directRootAccess
    && tools.ip
    && kvmDevice
    && cpuVirtualization
    && Boolean(totalCores)
    && utilizationRatio !== null
    && Boolean(totalMemory)
    && availableMemory !== null
    && availableMemory > 0
    && Boolean(selectedBridge)
    && Boolean(
      selectedStorage?.active
      && selectedStorage.enabled
      && selectedStorage.content.includes("images")
      && selectedStorage.totalBytes !== null
      && selectedStorage.availableBytes !== null
      && selectedStorage.availableBytes > 0
    )
    && vmInventoryAvailable
    && availableCount > 0
    && preparedReady;

  return {
    protocolVersion: 1,
    provider: "proxmox",
    connectionReady,
    launchReady,
    node: { id: nodeId, proxmoxVersion },
    capabilities: {
      directRootAccess,
      kvmDevice,
      cpuVirtualization,
      supportedIsolationDrivers:
        selectedNodeMatchesSshNode && kvmDevice && cpuVirtualization
          ? ["proxmox-kvm"]
          : [],
      bridges,
      selectedBridge,
      storage: storage.map((entry) => ({
        id: entry.id,
        type: entry.type,
        content: entry.content,
        active: entry.active,
        enabled: entry.enabled,
        shared: entry.shared,
      })),
      selectedStorage: selectedStorage?.id ?? null,
      preparedTarget: {
        configured: preparedConfigured,
        ready: preparedReady,
        template,
        provisioner,
        assets,
      },
    },
    capacity: {
      cpu: { totalCores, utilizationRatio },
      memory: {
        totalBytes: totalMemory,
        reportedFreeBytes: normalizedReportedFreeMemory,
        reservedGuestBytes: vmInventory.reservedMemoryBytes,
        hostReserveBytes,
        availableBytes: availableMemory,
      },
      ...(hasCapacityMarkers ? { policy: {
        mode: config.capacityPolicy.mode,
        cpuCeilingDensity: config.capacityPolicy.cpuCeilingDensity,
        memoryCeilingDensity: config.capacityPolicy.memoryCeilingDensity,
        activeFloorMemoryBytes: activeFloorBytes,
        activeCeilingMemoryBytes: activeMaxBytes,
        activeCeilingCpu: activeMaxCpuMilli === null ? null : activeMaxCpuMilli / 1000,
        floorMemoryHeadroomBytes: reservationAvailableMemory,
        ceilingMemoryHeadroomBytes: totalMemory === null || activeMaxBytes === null ? null : Math.max(0, totalMemory * config.capacityPolicy.memoryCeilingDensity - activeMaxBytes),
        ceilingCpuHeadroom: totalCores === null || activeMaxCpuMilli === null ? null : Math.max(0, totalCores * config.capacityPolicy.cpuCeilingDensity - activeMaxCpuMilli / 1000),
      } } : {}),
      storage: selectedStorage
        ? {
            id: selectedStorage.id,
            totalBytes: selectedStorage.totalBytes,
            availableBytes: selectedStorage.availableBytes,
          }
        : null,
      vmids: {
        start: config.vmidRange.start,
        end: config.vmidRange.end,
        availableCount,
        firstAvailable,
      },
    },
    unmetRequirements: issues,
  };
}

/** Execute through an injected, host-key-verifying SSH adapter. This function
 * never logs or returns stderr/raw stdout. */
export async function runPortableProxmoxPreflight(
  input: PortableProxmoxPreflightInput,
  executor: ProxmoxPreflightExecutor,
): Promise<PortableProxmoxPreflightOutcome> {
  let script: string;
  try {
    script = buildPortableProxmoxPreflightScript(input);
  } catch (error) {
    if (error instanceof ProxmoxPreflightInputError) {
      return { ok: false, code: error.code, message: error.message };
    }
    return { ok: false, code: "PROXMOX_PREFLIGHT_INPUT_INVALID", message: "The preflight configuration is invalid" };
  }

  let execution: ProxmoxPreflightExecutionResult;
  try {
    execution = await executor(script);
  } catch {
    return {
      ok: false,
      code: "PROXMOX_PREFLIGHT_EXECUTION_FAILED",
      message: "The Proxmox preflight could not be executed",
    };
  }
  if (!execution.ok || typeof execution.stdout !== "string") {
    return {
      ok: false,
      code: "PROXMOX_PREFLIGHT_EXECUTION_FAILED",
      message: "The Proxmox preflight did not complete successfully",
    };
  }

  try {
    return { ok: true, report: parsePortableProxmoxPreflightOutput(execution.stdout, input) };
  } catch (error) {
    if (error instanceof ProxmoxPreflightInputError) {
      return { ok: false, code: error.code, message: error.message };
    }
    return {
      ok: false,
      code: "PROXMOX_PREFLIGHT_OUTPUT_INVALID",
      message: "The Proxmox preflight returned invalid output",
    };
  }
}
