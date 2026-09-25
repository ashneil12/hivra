/**
 * Versioned contract shared by Simple-mode preparation, read-only preflight,
 * and target-bound lifecycle execution.
 *
 * Keep this module free of filesystem and credential access so importing the
 * contract cannot accidentally pull server secrets into a client bundle.
 */
import agentCliVersions from "../../../provisioner/agent-cli-versions.json";

export const PORTABLE_HIVRA_PROVISIONER_VERSION = "2026.09.24.4";
/** Exact reviewed releases with the same Proxmox lifecycle/runtime ABI. An
 * installed computer retains its observed version; accepting this predecessor
 * does not install, upgrade, or advertise the new provider-VM option there.
 * Earlier releases lacked required lifecycle/security fixes and stay rejected.
 */
export const PORTABLE_HIVRA_COMPATIBLE_PROXMOX_VERSIONS = [
  "2026.08.26.10",
  "2026.08.27.1",
  "2026.08.27.2",
  "2026.08.27.3",
  "2026.08.27.4",
  "2026.08.28.1",
  "2026.08.28.2",
  "2026.08.28.3",
  "2026.08.28.4",
  "2026.08.29.1",
  "2026.08.29.2",
  "2026.08.29.3",
  "2026.08.29.4",
  "2026.08.29.5",
  "2026.08.30.1",
  "2026.08.30.2",
  "2026.08.31.1",
  "2026.08.31.4",
  "2026.09.01.1",
  "2026.09.01.2",
  "2026.09.01.6",
  "2026.09.01.7",
  "2026.09.01.8",
  "2026.09.01.9",
  "2026.09.04.2",
  "2026.09.04.3",
  "2026.09.04.4",
  "2026.09.05.1",
  "2026.09.05.3",
  "2026.09.05.4",
  "2026.09.05.5",
  "2026.09.05.6",
  "2026.09.05.7",
  "2026.09.05.8",
  "2026.09.05.9",
  "2026.09.05.10",
  "2026.09.06.1",
  "2026.09.06.2",
  "2026.09.06.3",
  "2026.09.06.4",
  "2026.09.07.1",
  "2026.09.08.1",
  "2026.09.08.2",
  "2026.09.08.3",
  "2026.09.15.2",
  "2026.09.21.1",
  "2026.09.22.1",
  "2026.09.22.2",
  "2026.09.24.1",
  "2026.09.24.2",
  "2026.09.24.3",
  PORTABLE_HIVRA_PROVISIONER_VERSION,
] as const;
export function isCompatibleProxmoxProvisionerVersion(version: unknown): version is string {
  return typeof version === "string"
    && (PORTABLE_HIVRA_COMPATIBLE_PROXMOX_VERSIONS as readonly string[]).includes(version);
}
export const PORTABLE_HIVRA_RUNTIME_COMPATIBILITY_CONTRACT_VERSION = 1 as const;

/**
 * Catalog runtimes the vendored provisioner accepts and installs today.
 *
 * This list is an evidence contract, not a product preference. Keep it aligned
 * with the accepted AGENT_KIND values and runtime-specific readiness checks in
 * hivra-provision-on-host.sh and provision-claude-code-box.sh.
 */
const PORTABLE_HIVRA_LEGACY_CATALOG_RUNTIME_IDS = [
  "claude-code",
  "codex",
  "aeon",
  "openclaw",
  "agent-zero",
  "deepseek-harness",
] as const;

export const PORTABLE_HIVRA_SUPPORTED_CATALOG_RUNTIME_IDS = [
  ...PORTABLE_HIVRA_LEGACY_CATALOG_RUNTIME_IDS,
  "linux-desktop",
] as const;

/** Exact compatible releases that shipped the Linux Desktop runtime. */
const PORTABLE_HIVRA_LINUX_DESKTOP_VERSIONS = [
  "2026.09.04.2",
  "2026.09.04.3",
  "2026.09.04.4",
  "2026.09.05.1",
  "2026.09.05.3",
  "2026.09.05.4",
  "2026.09.05.5",
  "2026.09.05.6",
  "2026.09.05.7",
  "2026.09.05.8",
  "2026.09.05.9",
  "2026.09.05.10",
  "2026.09.06.1",
  "2026.09.06.2",
  "2026.09.06.3",
  "2026.09.06.4",
  "2026.09.07.1",
  "2026.09.08.1",
  "2026.09.08.2",
  "2026.09.08.3",
  "2026.09.15.2",
  "2026.09.21.1",
  "2026.09.22.1",
  "2026.09.22.2",
  "2026.09.24.1",
  "2026.09.24.2",
  "2026.09.24.3",
  PORTABLE_HIVRA_PROVISIONER_VERSION,
] as const;

function provisionerSupportsLinuxDesktop(version: unknown): boolean {
  return (PORTABLE_HIVRA_LINUX_DESKTOP_VERSIONS as readonly unknown[]).includes(version);
}

/** Exact reviewed releases that ship the Windows setup host capability.
 * 2026.09.15.2 is the first admitted lifecycle release carrying it. Earlier
 * compatible lifecycle ABIs must never inherit this host mutation capability,
 * so each later release is listed explicitly rather than implied. */
const PORTABLE_HIVRA_WINDOWS_INSTALLER_VERSIONS = [
  "2026.09.15.2",
  "2026.09.21.1",
  "2026.09.22.1",
  "2026.09.22.2",
  "2026.09.24.1",
  "2026.09.24.2",
  "2026.09.24.3",
  PORTABLE_HIVRA_PROVISIONER_VERSION,
] as const;
export function provisionerSupportsWindowsInstaller(version: unknown): boolean {
  return (PORTABLE_HIVRA_WINDOWS_INSTALLER_VERSIONS as readonly unknown[]).includes(version);
}

/** Legacy provider runtimes; desktop admission is separately version-bound. */
export const PORTABLE_HIVRA_SUPPORTED_PROVIDER_VM_CATALOG_RUNTIME_IDS = [
  ...PORTABLE_HIVRA_LEGACY_CATALOG_RUNTIME_IDS,
] as const;
export const PORTABLE_HIVRA_PROVIDER_VM_PROVISIONER_VERSION = PORTABLE_HIVRA_PROVISIONER_VERSION;

/** Provider VMs run the reviewed guest bundle directly. Proxmox predecessor
 * compatibility is not evidence that those bundles support this substrate. */
export function isCompatibleProviderVmProvisionerVersion(version: unknown): version is string {
  return (PORTABLE_HIVRA_COMPATIBLE_PROVIDER_VM_VERSIONS as readonly unknown[]).includes(version);
}
export function providerProvisionerSupportsCatalogRuntime(version: unknown, runtime: string): boolean {
  return isCompatibleProviderVmProvisionerVersion(version) && (runtime === "linux-desktop"
    ? version === PORTABLE_HIVRA_PROVIDER_VM_PROVISIONER_VERSION
    : (PORTABLE_HIVRA_SUPPORTED_PROVIDER_VM_CATALOG_RUNTIME_IDS as readonly string[]).includes(runtime));
}
export const PORTABLE_HIVRA_COMPATIBLE_PROVIDER_VM_VERSIONS = ["2026.08.28.1", "2026.08.28.2", "2026.08.28.3", "2026.08.28.4", "2026.08.29.1", "2026.08.29.2", "2026.08.29.3", "2026.08.29.4", "2026.08.29.5", "2026.08.30.1", "2026.08.31.1", "2026.08.31.4", "2026.09.01.1", "2026.09.01.2", "2026.09.01.6", "2026.09.01.7", "2026.09.01.8", "2026.09.01.9", "2026.09.04.2", "2026.09.04.3", "2026.09.04.4", "2026.09.05.1", "2026.09.05.3", "2026.09.05.4", "2026.09.05.5", "2026.09.05.6", "2026.09.05.7", "2026.09.05.8", "2026.09.05.9", "2026.09.05.10", "2026.09.06.1", "2026.09.06.2", "2026.09.06.3", "2026.09.06.4", "2026.09.07.1", "2026.09.08.1", "2026.09.08.2", "2026.09.08.3", "2026.09.15.1", "2026.09.15.2", "2026.09.21.1", "2026.09.22.1", "2026.09.22.2", "2026.09.24.1", "2026.09.24.2", "2026.09.24.3", PORTABLE_HIVRA_PROVIDER_VM_PROVISIONER_VERSION] as const;

/** Native launch compatibility is not model-key delivery capability. Only the
 * reviewed atomic model-settings release can opt into launch-time custody.
 * Actual guest capability and receipt checks still run before key delivery. */
export const PORTABLE_HIVRA_MODEL_SETTINGS_VERSIONS = ["2026.08.28.2", "2026.08.28.3", "2026.08.28.4", "2026.08.29.1", "2026.08.29.2", "2026.08.29.3", "2026.08.29.4", "2026.08.29.5", "2026.08.30.1", "2026.08.30.2", "2026.08.31.1", "2026.08.31.4", "2026.09.01.1", "2026.09.01.2", "2026.09.01.6", "2026.09.01.7", "2026.09.01.8", "2026.09.01.9", "2026.09.04.2", "2026.09.04.3", "2026.09.04.4", "2026.09.05.1", "2026.09.05.3", "2026.09.05.4", "2026.09.05.5", "2026.09.05.6", "2026.09.05.7", "2026.09.05.8", "2026.09.05.9", "2026.09.05.10", "2026.09.06.1", "2026.09.06.2", "2026.09.06.3", "2026.09.06.4", "2026.09.07.1", "2026.09.08.1", "2026.09.08.2", "2026.09.08.3", "2026.09.15.1", "2026.09.15.2", "2026.09.21.1", "2026.09.22.1", "2026.09.22.2", "2026.09.24.1", "2026.09.24.2", "2026.09.24.3", PORTABLE_HIVRA_PROVISIONER_VERSION] as const;
export function supportsModelSettingsProvisionerVersion(version: unknown): version is string {
  return (PORTABLE_HIVRA_MODEL_SETTINGS_VERSIONS as readonly unknown[]).includes(version);
}

/** Releases whose host script and guest installer carry the agent-run
 * reporter (launch document v4). A predecessor ignores the credential, so the
 * control plane does not issue one to a host known to run an older bundle. */
export const PORTABLE_HIVRA_ACTIVITY_TELEMETRY_VERSIONS = ["2026.09.22.1", "2026.09.22.2", "2026.09.24.1", "2026.09.24.2", "2026.09.24.3", "2026.09.24.4"] as const;
export function provisionerSupportsActivityTelemetry(version: unknown): version is string {
  return (PORTABLE_HIVRA_ACTIVITY_TELEMETRY_VERSIONS as readonly unknown[]).includes(version);
}

type PortableHivraSupportedCatalogRuntimeId =
  (typeof PORTABLE_HIVRA_SUPPORTED_CATALOG_RUNTIME_IDS)[number];

export function portableProvisionerSupportsCatalogRuntime(
  version: unknown,
  catalogRuntimeId: string,
): boolean {
  if (!isCompatibleProxmoxProvisionerVersion(version)) return false;
  const supported = provisionerSupportsLinuxDesktop(version)
      ? [...PORTABLE_HIVRA_LEGACY_CATALOG_RUNTIME_IDS, "linux-desktop"]
      : PORTABLE_HIVRA_LEGACY_CATALOG_RUNTIME_IDS;
  return (supported as readonly string[]).includes(catalogRuntimeId);
}

export type PortableHivraRuntimeCompatibilityRecord = {
  contractVersion: typeof PORTABLE_HIVRA_RUNTIME_COMPATIBILITY_CONTRACT_VERSION;
  provisionerVersion: string;
  supportedCatalogRuntimeIds: PortableHivraSupportedCatalogRuntimeId[];
  supportedHostCapabilities?: Array<"windows-installer">;
};

export const PORTABLE_HIVRA_RUNTIME_COMPATIBILITY: PortableHivraRuntimeCompatibilityRecord = {
  contractVersion: PORTABLE_HIVRA_RUNTIME_COMPATIBILITY_CONTRACT_VERSION,
  provisionerVersion: PORTABLE_HIVRA_PROVISIONER_VERSION,
  supportedCatalogRuntimeIds: [...PORTABLE_HIVRA_SUPPORTED_CATALOG_RUNTIME_IDS],
  supportedHostCapabilities: ["windows-installer"],
};

/**
 * Compatibility is only derivable when preflight proves the exact vendored
 * compatible provisioner version. Unknown/custom bundles must advertise no compatibility
 * until their own versioned runtime contract exists.
 */
export function portableRuntimeCompatibilityForProvisioner(
  provisioner: { ready: boolean; version: string | null } | null,
): PortableHivraRuntimeCompatibilityRecord | null {
  if (
    !provisioner?.ready ||
    !isCompatibleProxmoxProvisionerVersion(provisioner.version)
  ) {
    return null;
  }
  return {
    ...PORTABLE_HIVRA_RUNTIME_COMPATIBILITY,
    provisionerVersion: provisioner.version,
    // A compatible predecessor remains usable for the runtimes it actually
    // shipped, but must not inherit a new catalog claim merely because the
    // control plane was upgraded.
    supportedCatalogRuntimeIds: provisionerSupportsLinuxDesktop(provisioner.version)
        ? [...PORTABLE_HIVRA_LEGACY_CATALOG_RUNTIME_IDS, "linux-desktop"]
        : [...PORTABLE_HIVRA_LEGACY_CATALOG_RUNTIME_IDS],
    supportedHostCapabilities: provisionerSupportsWindowsInstaller(provisioner.version)
      ? ["windows-installer"] : [],
  };
}
export const PORTABLE_HIVRA_PROVISIONER_DIRECTORY = "/opt/hivra/provisioner";
export const PORTABLE_HIVRA_PROVISIONER_BUNDLE_DIRECTORY = "provisioner";
export const PORTABLE_HIVRA_PROVISIONER_PREPARE_SCRIPT = "prepare-proxmox-host.sh";
export const PORTABLE_HIVRA_PROVISIONER_RESULT_MARKER = "HIVRA_PREPARE_RESULT";
export const PORTABLE_HIVRA_SIMPLE_BRIDGE = "hivra0";
export const PORTABLE_HIVRA_SIMPLE_VMID_RANGE = { start: 200, end: 399 } as const;
const PORTABLE_HIVRA_SIMPLE_UBUNTU_IMAGE = "/var/lib/vz/template/iso/hivra-ubuntu-jammy.img";
const PORTABLE_HIVRA_SIMPLE_UBUNTU_IMAGE_SHA256 = "ff271290a23279ce764561dbe2e9c3ec29da899535b571a987c37b47970c2ad9";

/**
 * The Claude Code and Codex versions this release installs and updates to
 * (provisioner/agent-cli-versions.json, read by the guest installer and the
 * runtime updater). Vendor self-updaters are off on Hivra computers, so a
 * computer reporting a different version (GET /api/meta agentCli) is behind or
 * ahead of the vetted release until update_runtime reconciles it.
 */
export const AGENT_CLI_VERSIONS: Readonly<Record<"claude-code" | "codex", string>> = Object.freeze({
  "claude-code": agentCliVersions["claude-code"],
  codex: agentCliVersions.codex,
});

/**
 * Explicit allowlist of files streamed to a user-owned Proxmox host. New
 * runtime files must be intentionally added here; directory traversal and
 * accidental credential files can never enter the upload through a glob.
 */
export const PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES = [
  ".gitignore",
  "PROVENANCE.md",
  "README.md",
  "VERSION",
  "agent-cli-versions.json",
  "bux-hivra-chat.service",
  "bux-local-browser.service",
  "bux-box-ttyd.service",
  "bux-ttyd-base-path.conf",
  "deepseek-harness/native-broker.cjs",
  "deepseek-harness/gateway-policy.cjs",
  "deepseek-harness/runtime-process.cjs",
  "deepseek-harness/package.json",
  "deepseek-harness/package-lock.json",
  "deepseek-harness/install-native.py",
  "deepseek-harness/service-owner.py",
  "deepseek-harness/install-guest.py",
  "deepseek-harness/bux-hivra-chat.service",
  "hivra-agent-cli-update.sh",
  "hivra-agent-shell",
  "hivra-agent-trace.py",
  "hivra-codex-config-pin.py",
  "hivra-agent-trace.service",
  "hivra-guest-ssh-known-hosts",
  "hivra-host-capacity-admission",
  "hivra-install-agent.py",
  "hivra-provider-worker.py",
  "hivra-copy-desktop-image.py",
  "hivra-browser-apply",
  "hivra-network-preflight",
  "hivra-runtime-receipt.py",
  "hivra-chat/app.js",
  "hivra-chat/index.html",
  "hivra-chat/llm-application.js",
  "hivra-chat/guarded-files.cjs",
  "hivra-chat/agent-zero-editor.cjs",
  "hivra-chat/chat-runs.cjs",
  "hivra-chat/server.js",
  "hivra-chat/workspace-access-policy.cjs",
  "hivra-chat/workspace-sessions.cjs",
  "hivra-chat/workspace-control.cjs",
  "hivra-chat/workspace-router.cjs",
  "hivra-chat/workspace-handoff.cjs",
  "hivra-provision-on-host.sh",
  "hivra-start-on-host.sh",
  "hivra-update-guest-runtime.sh",
  "hivra-tg-apply",
  "local-browser-keeper.py",
  "prepare-proxmox-host.sh",
  "provision-claude-code-box.sh",
  "remote-desktop/broker.cjs",
  "remote-desktop/install-guest.py",
  "remote-desktop/provider-service-owner.py",
  "remote-desktop/provider-service-plan.py",
  "remote-desktop/server.cjs",
  "system-prompt-codex.md",
  "system-prompt.md",
] as const;

/** Assets that prove the installed Simple-mode runtime is usable, not merely
 * that a VERSION file happens to exist. */
export const PORTABLE_HIVRA_SIMPLE_REQUIRED_ASSETS = [
  {
    id: "provision-agent",
    kind: "executable" as const,
    path: `${PORTABLE_HIVRA_PROVISIONER_DIRECTORY}/hivra-provision-on-host.sh`,
  },
  {
    id: "start-agent",
    kind: "executable" as const,
    path: `${PORTABLE_HIVRA_PROVISIONER_DIRECTORY}/hivra-start-on-host.sh`,
  },
  {
    id: "target-contract",
    kind: "file" as const,
    path: `${PORTABLE_HIVRA_PROVISIONER_DIRECTORY}/TARGET.json`,
  },
  {
    id: "target-environment",
    kind: "file" as const,
    path: "/etc/hivra/target.env",
  },
  {
    id: "vm-orchestrator-key",
    kind: "private-file" as const,
    path: "/etc/hivra/keys/vm-orchestrator",
  },
  {
    id: "vm-orchestrator-public-key",
    kind: "file" as const,
    path: "/etc/hivra/keys/vm-orchestrator.pub",
  },
  {
    id: "ubuntu-image",
    kind: "disk-image" as const,
    path: PORTABLE_HIVRA_SIMPLE_UBUNTU_IMAGE,
    sha256: PORTABLE_HIVRA_SIMPLE_UBUNTU_IMAGE_SHA256,
  },
  {
    id: "network-isolation",
    kind: "hivra-network" as const,
    path: "/etc/hivra/network-apply",
  },
  {
    id: "network-owner",
    kind: "file" as const,
    path: "/etc/hivra/network-owner",
  },
  {
    id: "network-service",
    kind: "file" as const,
    path: "/etc/systemd/system/hivra-network.service",
  },
] as const;

/**
 * The vendored contract permits Advanced mode to relocate the provisioner
 * directory, but every other critical host asset keeps its canonical path.
 */
export function portableHivraRequiredAssetsForProvisionerDirectory(
  provisionerDirectory: string,
) {
  const normalizedDirectory = provisionerDirectory.replace(/\/+$/, "");
  return PORTABLE_HIVRA_SIMPLE_REQUIRED_ASSETS.map((asset) => {
    const relativeProvisionerPath = asset.path.startsWith(
      `${PORTABLE_HIVRA_PROVISIONER_DIRECTORY}/`,
    )
      ? asset.path.slice(PORTABLE_HIVRA_PROVISIONER_DIRECTORY.length)
      : null;
    return {
      ...asset,
      path: relativeProvisionerPath === null
        ? asset.path
        : `${normalizedDirectory}${relativeProvisionerPath}`,
    };
  });
}
