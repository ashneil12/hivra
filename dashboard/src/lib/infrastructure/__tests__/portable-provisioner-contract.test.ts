/** @jest-environment node */

import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  PORTABLE_HIVRA_PROVISIONER_BUNDLE_DIRECTORY,
  PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES,
  PORTABLE_HIVRA_PROVISIONER_VERSION,
  PORTABLE_HIVRA_PROVIDER_VM_PROVISIONER_VERSION,
  PORTABLE_HIVRA_RUNTIME_COMPATIBILITY,
  PORTABLE_HIVRA_SIMPLE_REQUIRED_ASSETS,
  PORTABLE_HIVRA_SUPPORTED_CATALOG_RUNTIME_IDS,
  PORTABLE_HIVRA_SUPPORTED_PROVIDER_VM_CATALOG_RUNTIME_IDS,
  portableHivraRequiredAssetsForProvisionerDirectory,
  portableProvisionerSupportsCatalogRuntime,
  portableRuntimeCompatibilityForProvisioner,
  isCompatibleProviderVmProvisionerVersion,
  supportsModelSettingsProvisionerVersion,
  isCompatibleProxmoxProvisionerVersion,
  provisionerSupportsWindowsInstaller,
  providerProvisionerSupportsCatalogRuntime,
} from "../portable-provisioner-contract";

const bundleRoot = path.join(process.cwd(), PORTABLE_HIVRA_PROVISIONER_BUNDLE_DIRECTORY);
const source = (relativePath: string) =>
  readFileSync(path.join(bundleRoot, relativePath), "utf8");
const LEGACY_RUNTIME_IDS = [
  "claude-code", "codex", "aeon", "openclaw", "agent-zero", "deepseek-harness",
];

function shellFunction(sourceText: string, name: string, nextMarker: string): string {
  const start = sourceText.indexOf(`${name}() {`);
  const end = sourceText.indexOf(nextMarker, start);
  if (start < 0 || end < 0) throw new Error(`Could not extract ${name}`);
  return sourceText.slice(start, end);
}

function runNetworkPreflight(input: {
  owned?: boolean;
  bridgeExists?: boolean;
  routes?: string;
  addresses?: string;
}) {
  const fixture = mkdtempSync(path.join(tmpdir(), "hivra-network-preflight-"));
  const fakeBin = path.join(fixture, "bin");
  const marker = path.join(fixture, "network-owner");
  const service = path.join(fixture, "hivra-network.service");
  mkdirSync(fakeBin);
  writeFileSync(path.join(fakeBin, "ip"), `#!/usr/bin/env bash
case "$*" in
  "link show hivra0") [ "\${FAKE_BRIDGE_EXISTS:-0}" = "1" ] ;;
  "-d link show hivra0") printf '%s\n' '7: hivra0: <BROADCAST> mtu 1500 bridge' ;;
  "-o -4 address show dev hivra0") printf '%s\n' "\${FAKE_ADDRESSES:-}" ;;
  "-4 route show table all") printf '%s\n' "\${FAKE_ROUTES:-}" ;;
  *) exit 1 ;;
esac
`);
  chmodSync(path.join(fakeBin, "ip"), 0o755);
  if (input.owned) {
    writeFileSync(marker, [
      "schema=1",
      "owner=hivra",
      "bridge=hivra0",
      "subnet=10.251.20.0/24",
      "gateway=10.251.20.1",
      `service=${service}`,
      "",
    ].join("\n"), { mode: 0o644 });
    writeFileSync(service, "# Hivra-owned fixture\n", { mode: 0o644 });
  }
  const result = spawnSync(
    path.join(bundleRoot, "hivra-network-preflight"),
    ["hivra0", "10.251.20", "10.251.20.1", marker, service],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        FAKE_BRIDGE_EXISTS: input.bridgeExists ? "1" : "0",
        FAKE_ROUTES: input.routes ?? "",
        FAKE_ADDRESSES: input.addresses ?? "",
      },
    },
  );
  rmSync(fixture, { recursive: true, force: true });
  return result;
}

describe("portable provisioner source contract", () => {
  it("retains .05.9 compatibility but reserves fresh provider desktops for the corrected release", () => {
    const prior = "2026.09.05.9";
    expect(isCompatibleProxmoxProvisionerVersion(prior)).toBe(true);
    expect(isCompatibleProviderVmProvisionerVersion(prior)).toBe(true);
    expect(supportsModelSettingsProvisionerVersion(prior)).toBe(true);
    expect(portableProvisionerSupportsCatalogRuntime(prior, "linux-desktop")).toBe(true);
    expect(providerProvisionerSupportsCatalogRuntime(prior, "codex")).toBe(true);
    expect(providerProvisionerSupportsCatalogRuntime(prior, "linux-desktop")).toBe(false);
    expect(providerProvisionerSupportsCatalogRuntime(PORTABLE_HIVRA_PROVIDER_VM_PROVISIONER_VERSION, "linux-desktop")).toBe(true);
    expect(portableRuntimeCompatibilityForProvisioner({ ready: true, version: prior })?.provisionerVersion).toBe(prior);
  });
  it("keeps the immediately prior releases compatible after a version bump", () => {
    // Regression: the lists end with the current-version constant, so bumping it
    // to 2026.09.21.1 silently dropped installed 2026.09.15.2 computers.
    for (const prior of ["2026.09.15.1", "2026.09.15.2", "2026.09.21.1", "2026.09.22.1"]) {
      expect(isCompatibleProviderVmProvisionerVersion(prior)).toBe(true);
      expect(supportsModelSettingsProvisionerVersion(prior)).toBe(true);
    }
    // 2026.09.22.2 changes only the provider-VM desktop planner, so hosts on
    // 2026.09.22.1 keep the identical Proxmox lifecycle ABI and capabilities.
    expect(isCompatibleProxmoxProvisionerVersion("2026.09.22.1")).toBe(true);
    expect(portableProvisionerSupportsCatalogRuntime("2026.09.22.1", "linux-desktop")).toBe(true);
    expect(provisionerSupportsWindowsInstaller("2026.09.22.1")).toBe(true);
  });
  it("does not confuse native launch compatibility with model-settings delivery", () => {
    expect(supportsModelSettingsProvisionerVersion("2026.08.28.2")).toBe(true);
    expect(supportsModelSettingsProvisionerVersion("2026.08.28.3")).toBe(true);
    expect(supportsModelSettingsProvisionerVersion("2026.08.28.4")).toBe(true);
    expect(supportsModelSettingsProvisionerVersion("2026.08.29.1")).toBe(true);
    expect(supportsModelSettingsProvisionerVersion("2026.08.29.2")).toBe(true);
    expect(supportsModelSettingsProvisionerVersion("2026.08.29.3")).toBe(true);
    expect(supportsModelSettingsProvisionerVersion("2026.08.29.4")).toBe(true);
    expect(supportsModelSettingsProvisionerVersion("2026.09.04.2")).toBe(true);
    expect(supportsModelSettingsProvisionerVersion("2026.09.04.3")).toBe(true);
    expect(supportsModelSettingsProvisionerVersion("2026.09.04.4")).toBe(true);
    expect(supportsModelSettingsProvisionerVersion("2026.09.05.1")).toBe(true);
    expect(supportsModelSettingsProvisionerVersion("2026.09.05.3")).toBe(true);
    expect(supportsModelSettingsProvisionerVersion(PORTABLE_HIVRA_PROVISIONER_VERSION)).toBe(true);
    for (const version of [null, undefined, "2026.08.26.10", "2026.08.28.1", "2026.08.28.5", "latest"]) {
      expect(supportsModelSettingsProvisionerVersion(version)).toBe(false);
    }
    expect(isCompatibleProviderVmProvisionerVersion("2026.08.28.1")).toBe(true);
  });
  it("retains the exact reviewed predecessor ABI without claiming it is the new release",()=>{
    expect(isCompatibleProviderVmProvisionerVersion("2026.08.28.1")).toBe(true);
    expect(isCompatibleProviderVmProvisionerVersion("2026.08.28.2")).toBe(true);
    expect(isCompatibleProviderVmProvisionerVersion("2026.08.28.3")).toBe(true);
    expect(isCompatibleProviderVmProvisionerVersion("2026.08.28.4")).toBe(true);
    expect(isCompatibleProviderVmProvisionerVersion("2026.08.29.1")).toBe(true);
    expect(isCompatibleProviderVmProvisionerVersion("2026.08.29.2")).toBe(true);
    expect(isCompatibleProviderVmProvisionerVersion("2026.08.29.3")).toBe(true);
    expect(isCompatibleProviderVmProvisionerVersion("2026.08.29.4")).toBe(true);
    expect(isCompatibleProviderVmProvisionerVersion("2026.09.04.2")).toBe(true);
    expect(isCompatibleProviderVmProvisionerVersion("2026.09.04.3")).toBe(true);
    expect(isCompatibleProviderVmProvisionerVersion("2026.09.04.4")).toBe(true);
    expect(isCompatibleProviderVmProvisionerVersion("2026.09.05.1")).toBe(true);
    expect(isCompatibleProviderVmProvisionerVersion("2026.09.05.3")).toBe(true);
    expect(isCompatibleProviderVmProvisionerVersion(PORTABLE_HIVRA_PROVIDER_VM_PROVISIONER_VERSION)).toBe(true);
    expect(isCompatibleProviderVmProvisionerVersion("2026.08.28.5")).toBe(false);
    expect(isCompatibleProviderVmProvisionerVersion(null)).toBe(false);
    expect(portableRuntimeCompatibilityForProvisioner({ready:true,version:"2026.08.28.1"})?.provisionerVersion).toBe("2026.08.28.1");
    expect(portableRuntimeCompatibilityForProvisioner({ready:true,version:"2026.08.26.10"})).toEqual({
      ...PORTABLE_HIVRA_RUNTIME_COMPATIBILITY, provisionerVersion:"2026.08.26.10",
      supportedHostCapabilities: [],
      supportedCatalogRuntimeIds: LEGACY_RUNTIME_IDS,
    });
    expect(portableRuntimeCompatibilityForProvisioner({ready:false,version:"2026.08.26.10"})).toBeNull();
    expect(portableRuntimeCompatibilityForProvisioner({ready:true,version:"2026.08.27.1"})).toEqual({
      ...PORTABLE_HIVRA_RUNTIME_COMPATIBILITY, provisionerVersion:"2026.08.27.1",
      supportedHostCapabilities: [],
      supportedCatalogRuntimeIds: LEGACY_RUNTIME_IDS,
    });
    expect(portableRuntimeCompatibilityForProvisioner({ready:true,version:"2026.08.27.2"})).toEqual({
      ...PORTABLE_HIVRA_RUNTIME_COMPATIBILITY, provisionerVersion:"2026.08.27.2",
      supportedHostCapabilities: [],
      supportedCatalogRuntimeIds: LEGACY_RUNTIME_IDS,
    });
    expect(portableRuntimeCompatibilityForProvisioner({ready:true,version:"2026.08.26.4"})).toBeNull();
    expect(portableRuntimeCompatibilityForProvisioner({ready:true,version:"2026.08.27.3"})).toEqual({
      ...PORTABLE_HIVRA_RUNTIME_COMPATIBILITY, provisionerVersion:"2026.08.27.3",
      supportedHostCapabilities: [],
      supportedCatalogRuntimeIds: LEGACY_RUNTIME_IDS,
    });
    expect(portableRuntimeCompatibilityForProvisioner({ready:true,version:"2026.08.27.4"})).toEqual({
      ...PORTABLE_HIVRA_RUNTIME_COMPATIBILITY, provisionerVersion:"2026.08.27.4",
      supportedHostCapabilities: [],
      supportedCatalogRuntimeIds: LEGACY_RUNTIME_IDS,
    });
    expect(portableRuntimeCompatibilityForProvisioner({ready:true,version:"2026.09.04.2"})).toEqual({
      ...PORTABLE_HIVRA_RUNTIME_COMPATIBILITY, provisionerVersion:"2026.09.04.2",
      supportedHostCapabilities: [],
      supportedCatalogRuntimeIds: [...LEGACY_RUNTIME_IDS, "linux-desktop"],
    });
    expect(portableProvisionerSupportsCatalogRuntime("2026.09.04.2", "linux-desktop")).toBe(true);
    expect(portableRuntimeCompatibilityForProvisioner({ready:true,version:"2026.09.04.3"})).toEqual({
      ...PORTABLE_HIVRA_RUNTIME_COMPATIBILITY, provisionerVersion:"2026.09.04.3",
      supportedHostCapabilities: [],
      supportedCatalogRuntimeIds: [...LEGACY_RUNTIME_IDS, "linux-desktop"],
    });
    expect(portableProvisionerSupportsCatalogRuntime("2026.09.04.3", "linux-desktop")).toBe(true);
    expect(portableRuntimeCompatibilityForProvisioner({ready:true,version:"2026.09.04.4"})).toEqual({
      ...PORTABLE_HIVRA_RUNTIME_COMPATIBILITY, provisionerVersion:"2026.09.04.4",
      supportedHostCapabilities: [],
      supportedCatalogRuntimeIds: [...LEGACY_RUNTIME_IDS, "linux-desktop"],
    });
    expect(portableProvisionerSupportsCatalogRuntime("2026.09.04.4", "linux-desktop")).toBe(true);
    expect(portableProvisionerSupportsCatalogRuntime("2026.09.05.1", "linux-desktop")).toBe(true);
    expect(portableProvisionerSupportsCatalogRuntime("2026.09.05.3", "linux-desktop")).toBe(true);
    expect(portableProvisionerSupportsCatalogRuntime(PORTABLE_HIVRA_PROVISIONER_VERSION, "linux-desktop")).toBe(true);
    expect(portableRuntimeCompatibilityForProvisioner({ready:true,version:"2026.08.27.5"})).toBeNull();
  });
  it("ships the guest model-setting dependency in the verified bundle and installer", () => {
    expect(PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES).toContain("hivra-chat/llm-application.js");
    expect(source("provision-claude-code-box.sh")).toContain("hivra-chat/llm-application.js");
    expect(source("provision-claude-code-box.sh")).toContain("for f in server.js llm-application.js guarded-files.cjs agent-zero-editor.cjs index.html app.js; do");
    expect(source("hivra-chat/server.js")).toContain('require("./llm-application.js")');
  });
  it("derives runtime compatibility from every runtime the vendored bundle accepts", () => {
    expect(PORTABLE_HIVRA_RUNTIME_COMPATIBILITY).toEqual({
      contractVersion: 1,
      provisionerVersion: PORTABLE_HIVRA_PROVISIONER_VERSION,
      supportedCatalogRuntimeIds: [
        "claude-code",
        "codex",
        "aeon",
        "openclaw",
        "agent-zero",
        "deepseek-harness",
        "linux-desktop",
      ],
      supportedHostCapabilities: ["windows-installer"],
    });
    expect(PORTABLE_HIVRA_SUPPORTED_CATALOG_RUNTIME_IDS).toEqual(
      PORTABLE_HIVRA_RUNTIME_COMPATIBILITY.supportedCatalogRuntimeIds,
    );
    expect(PORTABLE_HIVRA_SUPPORTED_PROVIDER_VM_CATALOG_RUNTIME_IDS).toEqual(LEGACY_RUNTIME_IDS);
    expect(portableRuntimeCompatibilityForProvisioner({
      ready: true,
      version: PORTABLE_HIVRA_PROVISIONER_VERSION,
    })?.supportedCatalogRuntimeIds).toContain("linux-desktop");
    expect(portableRuntimeCompatibilityForProvisioner({
      ready: true,
      version: "2026.09.08.3",
    })?.supportedHostCapabilities).not.toContain("windows-installer");
    expect(portableRuntimeCompatibilityForProvisioner({
      ready: true,
      version: "2026.09.01.9",
    })?.supportedCatalogRuntimeIds).not.toContain("linux-desktop");

    const hostProvisioner = source("hivra-provision-on-host.sh");
    const runtimeInstaller = source("provision-claude-code-box.sh");
    expect(hostProvisioner).toContain(
      'case "$AGENT_KIND" in claude|codex|aeon|openclaw|agent-zero|deepseek-harness|linux-desktop)',
    );
    for (const agentKind of ["codex", "aeon", "openclaw", "agent-zero"]) {
      expect(runtimeInstaller).toContain(`[ "$AGENT_KIND" = "${agentKind}" ]`);
    }
    expect(runtimeInstaller).toContain(
      'LOGIN_HINT="sudo -iu ${AGENT_USER} claude auth login"',
    );
  });

  it("rebases only provisioner-directory critical assets for Advanced mode", () => {
    const rebased = portableHivraRequiredAssetsForProvisionerDirectory(
      "/srv/hivra/custom-provisioner/",
    );

    expect(rebased.find((asset) => asset.id === "provision-agent")?.path)
      .toBe("/srv/hivra/custom-provisioner/hivra-provision-on-host.sh");
    expect(rebased.find((asset) => asset.id === "start-agent")?.path)
      .toBe("/srv/hivra/custom-provisioner/hivra-start-on-host.sh");
    expect(rebased.find((asset) => asset.id === "target-contract")?.path)
      .toBe("/srv/hivra/custom-provisioner/TARGET.json");
    for (const asset of PORTABLE_HIVRA_SIMPLE_REQUIRED_ASSETS.filter(
      (entry) => !["provision-agent", "start-agent", "target-contract"].includes(entry.id),
    )) {
      expect(rebased.find((entry) => entry.id === asset.id)?.path).toBe(asset.path);
    }
  });

  it("keeps VERSION and every explicit allowlist entry present, regular, and in-root", () => {
    expect(source("VERSION").trim()).toBe(PORTABLE_HIVRA_PROVISIONER_VERSION);

    for (const relativePath of PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES) {
      expect(path.isAbsolute(relativePath)).toBe(false);
      expect(relativePath.split("/")).not.toContain("..");
      const stat = lstatSync(path.join(bundleRoot, relativePath));
      expect(stat.isFile()).toBe(true);
      expect(stat.isSymbolicLink()).toBe(false);
    }
  });

  it("ships every shell/runtime entrypoint with valid syntax and executable metadata", () => {
    const executableEntries = [
      "hivra-agent-shell",
      "hivra-guest-ssh-known-hosts",
      "hivra-browser-apply",
      "hivra-network-preflight",
      "hivra-runtime-receipt.py",
      "hivra-provision-on-host.sh",
      "hivra-start-on-host.sh",
      "hivra-update-guest-runtime.sh",
      "hivra-tg-apply",
      "local-browser-keeper.py",
      "prepare-proxmox-host.sh",
      "provision-claude-code-box.sh",
    ];
    const shellEntries = executableEntries.filter(
      (relativePath) => readFileSync(path.join(bundleRoot, relativePath), "utf8").startsWith("#!/usr/bin/env bash"),
    );

    for (const relativePath of executableEntries) {
      const mode = lstatSync(path.join(bundleRoot, relativePath)).mode;
      expect(mode & 0o111).not.toBe(0);
    }

    for (const relativePath of shellEntries) {
      const syntax = spawnSync("bash", ["-n", path.join(bundleRoot, relativePath)], {
        encoding: "utf8",
      });
      expect({ relativePath, status: syntax.status, stderr: syntax.stderr }).toEqual({
        relativePath,
        status: 0,
        stderr: "",
      });
    }
  });

  it("binds every host-to-guest provisioner transfer to the exact VMID-attested SSH key", () => {
    const hostProvisioner = source("hivra-provision-on-host.sh");
    const identityGate = hostProvisioner.indexOf("prepare_guest_ssh_identity");
    const sshClient = hostProvisioner.indexOf("GSSH=(ssh", identityGate);
    const secretDocument = hostProvisioner.indexOf("guest_launch_document |", sshClient);

    expect(hostProvisioner).toContain('qm guest exec "$VMID" -- /bin/cat /etc/ssh/ssh_host_ed25519_key.pub');
    expect(hostProvisioner).toContain("qemu-guest-agent.service");
    expect(hostProvisioner).toContain('--cicustom "vendor=${CLOUD_INIT_SNIPPET_STORAGE}:snippets/$(basename "$CLOUD_INIT_SNIPPET")"');
    expect(hostProvisioner).toContain('qm set "$VMID" --delete cicustom');
    expect(hostProvisioner.indexOf("qemu-guest-agent.service")).toBeLessThan(identityGate);
    expect(hostProvisioner).toContain('vm_owned_by_operation || fail "VM ownership changed before guest SSH identity binding"');
    expect(hostProvisioner).toContain('-o StrictHostKeyChecking=yes');
    expect(hostProvisioner).toContain('-o HostKeyAlgorithms=ssh-ed25519');
    expect(hostProvisioner).toContain('-o HostKeyAlias="$GUEST_SSH_HOST_ALIAS"');
    expect(hostProvisioner).toContain('GSCP=(scp');
    expect(hostProvisioner).toContain('"${GSCP[@]}" -r "$PROV_DIR"');
    expect(hostProvisioner).not.toContain("StrictHostKeyChecking=no");
    expect(hostProvisioner).not.toContain("UserKnownHostsFile=/dev/null");
    expect(identityGate).toBeGreaterThan(0);
    expect(sshClient).toBeGreaterThan(identityGate);
    expect(secretDocument).toBeGreaterThan(sshClient);

    const identityHelper = source("hivra-guest-ssh-known-hosts");
    const startScript = source("hivra-start-on-host.sh");
    const updateScript = source("hivra-update-guest-runtime.sh");
    expect(identityHelper).toContain('qm guest exec "$VMID" -- /bin/cat /etc/ssh/ssh_host_ed25519_key.pub');
    expect(identityHelper).toContain('qm config "$VMID"');
    for (const lifecycleScript of [startScript, updateScript]) {
      expect(lifecycleScript).toContain("hivra-guest-ssh-known-hosts");
      expect(lifecycleScript).toContain("StrictHostKeyChecking=yes");
      expect(lifecycleScript).toContain('HostKeyAlias="hivra-vmid-$VMID"');
      expect(lifecycleScript).not.toContain("StrictHostKeyChecking=no");
      expect(lifecycleScript).not.toContain("UserKnownHostsFile=/dev/null");
    }
  });

  it("generates private receipt, SBOM and notice evidence only after readiness succeeds", () => {
    const installer = source("provision-claude-code-box.sh");
    const receipt = source("hivra-runtime-receipt.py");
    expect(PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES).toContain("hivra-runtime-receipt.py");
    expect(installer).toContain('python3 "$SRC_DIR/hivra-runtime-receipt.py"');
    expect(installer.indexOf('python3 "$SRC_DIR/hivra-runtime-receipt.py"'))
      .toBeGreaterThan(installer.indexOf('ok "Agent Zero passed runtime-specific readiness"'));
    expect(installer).toContain("sha256sum -c --status runtime-receipt.sha256");
    expect(installer).toContain("sha256sum -c --status runtime-sbom.sha256");
    expect(installer).toContain("sha256sum -c --status runtime-notice-manifest.sha256");
    expect(receipt).toContain('"bomFormat": "CycloneDX"');
    expect(receipt).toContain('"format": "hivra-installed-runtime-notice-manifest-v1"');
    expect(receipt).toContain('"sourceReceiptSha256": receipt_digest');
    expect(receipt).toContain('"releaseApproved": False');
    expect(receipt).toContain('"systemPackages": packages');
    expect(receipt).toContain('"containerImages"');
    expect(receipt).not.toMatch(/\.credentials\.json|api-token|tunnelToken|modelKey|process\.environ|docker inspect .*Config/i);
  });

  it("publishes lifecycle results to the caller-bound log with the exact operation receipt", () => {
    const startHelper = source("hivra-start-on-host.sh");

    expect(startHelper).toContain(
      'RESULT_LOG_PATH="${HIVRA_RESULT_LOG_PATH:-${LOG_DIR}/provision-${VMID}.log}"',
    );
    expect(startHelper).toContain("invalid lifecycle result log path");
    expect(startHelper).toContain("printf 'HIVRA_OPERATION_ID %s\\n' \"$OPERATION_ID\"");
    expect(startHelper).toContain('mv -f -- "$tmp" "$LOG"');
    expect(startHelper).not.toMatch(/ready":(?:true|false).*?>\s*"\$LOG"/);
  });

  it("ships a bounded guest runtime updater that preserves identity and rolls back failed gateway assets", () => {
    const updater = source("hivra-update-guest-runtime.sh");
    expect(PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES).toContain("hivra-update-guest-runtime.sh");
    expect(updater).toContain("ASSETS=(server.js llm-application.js guarded-files.cjs agent-zero-editor.cjs index.html app.js)");
    expect(updater).toContain('ARCHIVE_SHA256="$(sha256sum "$ARCHIVE"');
    expect(updater).toContain('install -o root -g root -m 0600 "$ARCHIVE" "$ROOT_ARCHIVE"');
    expect(updater).toContain('sha256sum "$ROOT_ARCHIVE"');
    expect(updater.indexOf('sha256sum "$ROOT_ARCHIVE"')).toBeLessThan(updater.indexOf('tar -xzf "$ROOT_ARCHIVE"'));
    expect(updater).toContain('TOKEN_HASH_BEFORE="$(sha256sum "$TOKEN"');
    expect(updater).toContain('TOKEN_INODE_BEFORE="$(stat -c');
    expect(updater).toContain('KIND_BEFORE="$(cat "$KIND")"');
    expect(updater).toContain("rollback()");
    expect(updater).toContain('meta.surfaceAuth === "post-cookie-v1"');
    expect(updater).toContain("HIVRA_GUEST_RUNTIME_UPDATED");
    expect(updater).not.toMatch(/\.codex|\.claude|\/home\/bux\/\.env|SOUL\.md|USER\.md/);
  });

  it("does not default installer dependencies to a moving main/latest reference", () => {
    const installerSource = [
      source("prepare-proxmox-host.sh"),
      source("provision-claude-code-box.sh"),
    ]
      .join("\n")
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");

    expect(installerSource).not.toMatch(/\$\{[A-Z0-9_]+:-(?:main|latest)\}/i);
    expect(installerSource).not.toMatch(/(?:^|\s)--branch\s+(?:main|latest)(?:\s|$)/i);
    expect(installerSource).not.toMatch(/(?:@|\/releases\/)(?:main|latest)(?:[\s/"']|$)/i);
    expect(installerSource).toContain("BUX_REF=\"${BUX_REF:-f17c1b31d6688dd92e745ade650e00d46b4dc4da}\"");
    expect(installerSource).toContain("AEON_REF=\"${AEON_REF:-8b8d719715ec9bb68fb858a1e334d23209047d82}\"");
  });

  it("keeps the plain Linux computer independent from the Bux agent checkout", () => {
    const installer = source("provision-claude-code-box.sh");

    expect(installer).toContain('if [ "$AGENT_KIND" = "linux-desktop" ]; then');
    expect(installer).toContain("standalone Linux Desktop access base");
    expect(installer).toContain("node-v${NODE_VERSION}-linux-x64.tar.xz");
    expect(installer).toContain("ttyd/releases/download/${TTYD_VERSION}/ttyd.x86_64");
    expect(installer).toContain("NODE_LINUX_X64_SHA256");
    expect(installer).toContain("TTYD_LINUX_X64_SHA256");
  });

  it("installs and starts the QEMU guest agent that the VM contract enables", () => {
    const hostProvisioner = source("hivra-provision-on-host.sh");
    const runtimeInstaller = source("provision-claude-code-box.sh");

    expect(hostProvisioner).toContain("--agent enabled=1");
    expect(runtimeInstaller).toMatch(/apt-get install -y[^\n]*qemu-guest-agent/);
    expect(runtimeInstaller).toContain("systemctl enable --now qemu-guest-agent");
  });

  it("keeps preparation mutually exclusive, checksum-gated, and east-west isolated", () => {
    const prepare = source("prepare-proxmox-host.sh");

    expect(prepare).toContain("/run/lock/hivra-host-prepare.lock");
    expect(prepare).toContain("flock -n 9");
    expect(prepare).toContain("UBUNTU_IMAGE_SHA256");
    expect(prepare).toContain("sha256sum -c -");
    expect(prepare).toContain("table bridge hivra_isolation");
    expect(prepare).toContain('meta ibrname "${BRIDGE}" meta obrname "${BRIDGE}" drop');
    expect(prepare).toContain("HIVRA6_INPUT");
    expect(prepare).toContain("HIVRA6_EGRESS");
    expect(prepare).toContain("sha256sum -c --status BUNDLE.sha256");
    expect(prepare).toContain("systemctl is-active --quiet hivra-network.service");
    expect(prepare).not.toMatch(/\bqm\s+(?:create|clone|start|stop|destroy|set|resize)\b/);
  });

  it("refuses foreign network objects and overlapping routes before host mutation", () => {
    const foreignBridge = runNetworkPreflight({ bridgeExists: true });
    expect(foreignBridge.status).not.toBe(0);
    expect(foreignBridge.stderr).toContain("refusing to adopt an existing unowned bridge");

    const overlap = runNetworkPreflight({
      routes: "10.251.0.0/16 dev vmbr0 proto kernel scope link",
    });
    expect(overlap.status).not.toBe(0);
    expect(overlap.stderr).toContain("selected subnet overlaps existing route");
  });

  it("allows an exact, marked Hivra network contract to upgrade idempotently", () => {
    const result = runNetworkPreflight({
      owned: true,
      bridgeExists: true,
      addresses: "7: hivra0    inet 10.251.20.1/24 scope global hivra0",
      routes: [
        "10.251.20.0/24 dev hivra0 proto kernel scope link src 10.251.20.1",
        "local 10.251.20.1 dev hivra0 table local proto kernel scope host",
        "default via 192.0.2.1 dev vmbr0",
      ].join("\n"),
    });
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
    expect(result.stdout).toContain("HIVRA_NETWORK_PREFLIGHT_OK");
  });

  it("keeps allocation failures truthful and releases the shared IP lock only after reservation", () => {
    const provision = source("hivra-provision-on-host.sh");

    expect(provision).toContain("umask 077");
    expect(provision).toContain("unsupported agent kind");
    expect(provision).not.toContain('*) AGENT_KIND="claude"');
    expect(provision).toContain('ALLOCATION_LOCK_FD="${HIVRA_ALLOCATION_LOCK_FD:-}"');
    expect(provision).toContain('qm set "$VMID" --ipconfig0');
    expect(provision.indexOf('qm set "$VMID" --ipconfig0')).toBeLessThan(
      provision.indexOf("release_allocation_lock", provision.indexOf('qm set "$VMID" --ipconfig0')),
    );
    expect(provision.indexOf('qm create "$VMID"')).toBeLessThan(
      provision.indexOf("CREATED=1", provision.indexOf('qm create "$VMID"')),
    );
    expect(provision).toContain("cleanup could not be verified");
    expect(provision).toContain("cleanup verified");
    expect(provision).toContain('pvesm list "$STORAGE"');
    expect(provision).toContain('ALLOCATION_RECEIPT_FILE="/run/hivra-provision/${VMID}.allocated"');
    expect(provision).toContain('binding_tag=%s\\nvmid=%s');
    expect(provision).toContain('--tags "${BINDING_TAG};${OPERATION_TAG}"');
    expect(provision.indexOf("release_allocation_lock", provision.indexOf("cleanup()"))).toBeGreaterThan(
      provision.indexOf("cleanup verification failed", provision.indexOf("cleanup()")),
    );
    expect(provision).not.toMatch(/"api_token"/);
  });

  it("keeps bearer secrets out of URLs, logs, and ssh/sudo argv", () => {
    const server = source("hivra-chat/server.js");
    const provision = source("hivra-provision-on-host.sh");
    const page = readFileSync(
      path.join(process.cwd(), "src/app/dashboard/agent/[id]/page.tsx"),
      "utf8",
    );

    expect(server).toContain('req.method === "POST" && u === "/auth/bootstrap"');
    expect(server).toContain('const AUTH_COOKIE = "__Host-hivra_auth"');
    expect(server).toContain("cookieAuthMayMutate(req)");
    expect(server).toContain('parsed.protocol === "https:" && parsed.host.toLowerCase() === host');
    expect(server).toContain('String(req.headers["upgrade"] || "").toLowerCase() === "websocket"');
    expect(server).not.toContain('searchParams.get("token")');
    expect(server).not.toContain("?token=");
    expect(server).toContain('surfaceAuth: "post-cookie-v1"');
    expect(page).toContain('method="POST"');
    expect(page).toContain('/auth/bootstrap');
    expect(page).toContain('record.surfaceAuth === "post-cookie-v1"');
    expect(page).not.toContain('legacyQueryToken');
    expect(page).not.toContain('encodeURIComponent(token)');
    expect(page).not.toContain('searchParams.set("token"');
    expect(provision).not.toMatch(/sudo env[^\n]*HIVRA_MODEL_KEY/);
    expect(provision).not.toMatch(/HIVRA_TUNNEL_TOKEN_B64=[^\n]*bash -s/);
    expect(provision).toContain("guest_launch_document |");
    // The agent-run reporter credential is optional in the handoff, never
    // inherited by host children, and reaches the guest only inside the
    // strictly validated stdin document.
    expect(provision).not.toMatch(/HIVRA_ACTIVITY_TELEMETRY[^\n]*bash -s/);
    expect(provision).toContain('HIVRA_ACTIVITY_TELEMETRY="$(read_optional_secret_b64 HIVRA_ACTIVITY_TELEMETRY_B64)"');
    expect(provision).toContain("export -n HIVRA_ACTIVITY_TELEMETRY");
    expect(provision).toContain('"$HIVRA_COMPUTER_ID" "$HIVRA_CONTROL_ORIGIN" "${HIVRA_ACTIVITY_TELEMETRY:-}"');
    expect(provision).toContain('set(value) != {"endpoint", "resourceId", "token", "expiresAt"}');
    expect(provision).toContain('r"(?::[0-9]{1,5})?/api/activity/ingest"');
    expect(provision).toContain('r"hvra_otlp_v1\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+"');
    expect(provision).toContain('if values[0] not in ("claude", "codex"):');
    expect(provision).toContain("GUEST_PROVISIONER=/tmp/hivra-provisioner");
    expect(provision).toContain('if [ "$AGENT_KIND" = "deepseek-harness" ]; then');
    expect(provision).toContain("GUEST_PROVISIONER=/opt/hivra/provider-bundle");
    expect(provision).toContain("sudo -n /usr/bin/python3 -I -B ${GUEST_PROVISIONER}/hivra-install-agent.py");
    expect(provision).toContain("native provisioner source is not root-owned");
    expect(provision).not.toContain("GUEST_MODEL_SECRET");
    expect(provision).not.toContain("GUEST_TUNNEL_SECRET");
    expect(provision).toContain("/var/lib/hivra/provision-results/${VMID}.secret");
  });

  it("serializes and ownership-guards lifecycle mutations with live admission and resize rollback", () => {
    const start = source("hivra-start-on-host.sh");
    const action = readFileSync(
      path.join(process.cwd(), "src/app/api/hivra/agents/[id]/action/route.ts"),
      "utf8",
    );

    expect(start).toContain("/run/lock/hivra-allocation.lock");
    expect(start).toContain("HIVRA_BINDING_TAG_ENFORCED");
    expect(start).toContain("refusing to start VMID $VMID without its exact Hivra binding tag");
    // Live memory/CPU admission is delegated to the shared host-capacity helper
    // (behaviourally covered in host-capacity-admission.test.ts) and must run
    // under the lifecycle lock before the VM is started.
    const admission = start.indexOf('bash "${PROVISIONER_DIR}/hivra-host-capacity-admission" "$VMID"');
    expect(admission).toBeGreaterThan(start.indexOf("flock -w 60 8"));
    expect(admission).toBeLessThan(start.indexOf('qm start "$VMID"'));
    expect(start.indexOf("release_lifecycle_lock")).toBeLessThan(start.indexOf("# wait for the box to boot"));
    expect(action).toContain("lifecycleMutationPrelude");
    expect(action).toContain("const serializedAdmission = buildHostCapacityAdmissionCommand(");
    // Resize admission runs under the lifecycle prelude, before the VM is stopped and resized.
    const resizeAdmission = action.indexOf("${serializedAdmission}");
    expect(resizeAdmission).toBeGreaterThan(action.indexOf("${lifecyclePrelude}"));
    expect(resizeAdmission).toBeLessThan(action.indexOf("${verifiedStopVmBody(vmid, 40)}", resizeAdmission));
    expect(action).toContain("restore_previous_size");
    expect(action).toContain("new size failed to start and prior config could not be restored");
    expect(action).toContain("HIVRA_BINDING_TAG_ENFORCED=${executionContext.infrastructureBindingTagEnforced");
  });

  it("refuses to start the box gateway without a valid 256-bit token", () => {
    const fakeHome = mkdtempSync(path.join(tmpdir(), "hivra-auth-test-"));
    try {
      const result = spawnSync(process.execPath, [path.join(bundleRoot, "hivra-chat/server.js")], {
        encoding: "utf8",
        env: { ...process.env, HOME: fakeHome, HIVRA_CHAT_PORT: "0" },
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("refusing to start an unauthenticated access gateway");
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("fails hard on web-runtime install/start/readiness and pins mutable sources", () => {
    const installer = source("provision-claude-code-box.sh");

    expect(installer).toContain("cd '${AEON_DASH}' && npm ci");
    expect(installer).toContain('|| die "aeon production build failed"');
    expect(installer).toContain('|| die "openclaw npm install failed"');
    expect(installer).toContain('|| die "Agent Zero image pull failed');
    expect(installer).toContain("agent0ai/agent-zero@${AGENT_ZERO_IMAGE_DIGEST}");
    expect(installer).toContain("wait_for_http");
    expect(installer).toContain("wait_for_exact_http_200");
    expect(installer).toContain("wait_for_browser_ready");
    expect(installer).toContain(
      'wait_for_exact_http_200 "http://127.0.0.1:${HIVRA_CHAT_PORT}/healthz"',
    );
    expect(installer).toContain('die "browser automation and live view did not become ready"');
    expect(installer).toContain("hivra-xvfb.service hivra-x11vnc.service hivra-novnc.service bux-local-browser.service");
    expect(installer).toContain("http://127.0.0.1:6080/vnc.html");
    expect(installer).toContain('"http://127.0.0.1:${cdp_port}/json/version"');
    expect(source("bux-hivra-chat.service")).toContain("Environment=BUX_LOCAL_CDP_PORT=9222");
    expect(installer).toContain(
      's#^Environment=BUX_LOCAL_CDP_PORT=.*#Environment=BUX_LOCAL_CDP_PORT=${CDP_PORT}#',
    );
    expect(installer).not.toContain('warn "browser.env not written yet');
    expect(installer).not.toContain(
      'curl -fsS --max-time 5 "http://127.0.0.1:${HIVRA_CHAT_PORT}/healthz"',
    );
    expect(installer).toContain("passed runtime-specific readiness");
    expect(installer).not.toContain("https://get.docker.com");
    expect(installer).not.toContain("npm ci || npm install");
  });

  it("waits through delayed chat readiness and fails when exact HTTP 200 never arrives", () => {
    const installer = source("provision-claude-code-box.sh");
    const helper = shellFunction(
      installer,
      "wait_for_exact_http_200",
      "wait_for_browser_ready() {",
    );
    const fixture = mkdtempSync(path.join(tmpdir(), "hivra-chat-readiness-"));
    const counter = path.join(fixture, "attempts");
    try {
      const delayed = spawnSync("bash", [], {
        encoding: "utf8",
        input: `curl() {
  n=0; [ ! -f '${counter}' ] || n="$(cat '${counter}')"
  n=$((n + 1)); printf '%s' "$n" > '${counter}'
  if [ "$n" -lt 3 ]; then printf '503'; else printf '200'; fi
}
sleep() { :; }
${helper}
wait_for_exact_http_200 'http://127.0.0.1:8080/healthz'
printf 'attempts=%s\n' "$(cat '${counter}')"
`,
      });
      expect(delayed).toMatchObject({ status: 0, stdout: "attempts=3\n", stderr: "" });

      const timeout = spawnSync("bash", [], {
        encoding: "utf8",
        input: `curl() { printf '503'; }
sleep() { :; }
${helper}
wait_for_exact_http_200 'http://127.0.0.1:8080/healthz'
`,
      });
      expect(timeout.status).toBe(1);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("waits for every browser service, custom-port CDP, and live-view readiness", () => {
    const installer = source("provision-claude-code-box.sh");
    const helper = shellFunction(
      installer,
      "wait_for_browser_ready",
      '\nverify_native_terminals\n',
    );
    const fixture = mkdtempSync(path.join(tmpdir(), "hivra-browser-readiness-"));
    const envFile = path.join(fixture, "browser.env");
    const counter = path.join(fixture, "attempts");
    const serviceCalls = path.join(fixture, "service-calls");
    const curlCalls = path.join(fixture, "curl-calls");
    try {
      const delayed = spawnSync("bash", [], {
        encoding: "utf8",
        input: `systemctl() { printf '%s\n' "$*" >> '${serviceCalls}'; return 0; }
curl() {
  local url="\${!#}"
  printf '%s\n' "$url" >> '${curlCalls}'
  case "$url" in
    'http://127.0.0.1:9333/json/version'|'http://127.0.0.1:6080/vnc.html') printf '200' ;;
    *) printf '404' ;;
  esac
}
sleep() {
  n=0; [ ! -f '${counter}' ] || n="$(cat '${counter}')"
  n=$((n + 1)); printf '%s' "$n" > '${counter}'
  if [ "$n" -ge 2 ]; then
    printf '%s\n' 'BU_CDP_WS=ws://127.0.0.1:9333/devtools/browser/test-id' > '${envFile}'
  fi
}
${helper}
wait_for_browser_ready '${envFile}' 9333
printf 'attempts=%s\n' "$(cat '${counter}')"
`,
      });
      expect(delayed).toMatchObject({ status: 0, stdout: "attempts=2\n", stderr: "" });
      expect(readFileSync(serviceCalls, "utf8")).toContain("is-active --quiet hivra-xvfb.service");
      expect(readFileSync(serviceCalls, "utf8")).toContain("is-active --quiet hivra-x11vnc.service");
      expect(readFileSync(serviceCalls, "utf8")).toContain("is-active --quiet hivra-novnc.service");
      expect(readFileSync(serviceCalls, "utf8")).toContain("is-active --quiet bux-local-browser.service");
      expect(readFileSync(curlCalls, "utf8")).toContain("http://127.0.0.1:9333/json/version");
      expect(readFileSync(curlCalls, "utf8")).toContain("http://127.0.0.1:6080/vnc.html");

      writeFileSync(envFile, "BU_CDP_WS=ws://127.0.0.1:9333/devtools/browser/test-id\n");
      const brokenLiveView = spawnSync("bash", [], {
        encoding: "utf8",
        input: `systemctl() { return 0; }
curl() {
  local url="\${!#}"
  if [ "$url" = 'http://127.0.0.1:6080/vnc.html' ]; then printf '503'; else printf '200'; fi
}
sleep() { :; }
${helper}
wait_for_browser_ready '${envFile}' 9333
`,
      });
      expect(brokenLiveView.status).toBe(1);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("documents every fetched runtime and integrity pin", () => {
    const provenance = source("PROVENANCE.md");
    for (const pin of [
      "ff271290a23279ce764561dbe2e9c3ec29da899535b571a987c37b47970c2ad9",
      "f17c1b31d6688dd92e745ade650e00d46b4dc4da",
      "8b8d719715ec9bb68fb858a1e334d23209047d82",
      "2026.8.2",
      "fcfb02b575a52ca1af2e3267af4e1517bcdeb30ac48c834c69abaed3c0576ad2",
      "152.0.7977.64-1",
      "4eae0736a812d9bc851cd2937f7af00e47dbaf8305845eed452703ff009873c7",
      "2.98.0",
      "f65a3fa2fa0eb2e97c445ee3f5e087a40aae03b64847f45a8f13805e504535d6",
      "@anthropic-ai/claude-code@2.1.246",
      "@openai/codex@0.149.1",
      "openclaw@2026.6.10",
      "sha256:d8fd86114b02e9b4b6f14ef6f696b1ba7af46e52327734bb8a77f7aaf8556cf0",
    ]) {
      expect(provenance).toContain(pin);
    }
  });
});
