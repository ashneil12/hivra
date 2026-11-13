import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import release from "../../../../provisioner-releases/2026.11.13.5.json";
import doorbellRelease from "../../../../provisioner-releases/2026.11.13.4.json";
import hostCredentialRelease from "../../../../provisioner-releases/2026.11.13.3.json";
import hostIngressStartRelease from "../../../../provisioner-releases/2026.11.13.2.json";
import wakeProxyRelease from "../../../../provisioner-releases/2026.11.13.1.json";
import nuphosRelease from "../../../../provisioner-releases/2026.11.12.5.json";
import openbotRelease from "../../../../provisioner-releases/2026.11.12.4.json";
import restorePointsRelease from "../../../../provisioner-releases/2026.11.12.3.json";
import gitGuardRelease from "../../../../provisioner-releases/2026.11.12.2.json";
import hermesModelRelease from "../../../../provisioner-releases/2026.11.12.1.json";
import webappRelease from "../../../../provisioner-releases/2026.11.11.7.json";
import libatomicRelease from "../../../../provisioner-releases/2026.11.11.6.json";
import gatewayRelease from "../../../../provisioner-releases/2026.11.11.5.json";
import hermesRelease from "../../../../provisioner-releases/2026.11.11.4.json";
import chatEffortRelease from "../../../../provisioner-releases/2026.11.11.3.json";
import chromePinRelease from "../../../../provisioner-releases/2026.11.11.2.json";
import browserViewRelease from "../../../../provisioner-releases/2026.11.11.1.json";
import deepseekModelRelease from "../../../../provisioner-releases/2026.11.10.5.json";
import linuxServerRelease from "../../../../provisioner-releases/2026.11.10.4.json";
import freshnessRelease from "../../../../provisioner-releases/2026.11.10.3.json";
import creditsRelease from "../../../../provisioner-releases/2026.11.10.2.json";
import hardeningRelease from "../../../../provisioner-releases/2026.11.10.1.json";
import clipboardRelease from "../../../../provisioner-releases/2026.11.03.1.json";
import appUpdateRelease from "../../../../provisioner-releases/2026.10.20.2.json";
import ownedUpdateRelease from "../../../../provisioner-releases/2026.10.20.1.json";
import claudeAppRelease from "../../../../provisioner-releases/2026.10.07.1.json";
import terminalFollowupsRelease from "../../../../provisioner-releases/2026.09.24.4.json";
import terminalSocketsRelease from "../../../../provisioner-releases/2026.09.24.3.json";
import persistentSessionsRelease from "../../../../provisioner-releases/2026.09.24.2.json";
import detachedRunsRelease from "../../../../provisioner-releases/2026.09.24.1.json";
import desktopPlannerRelease from "../../../../provisioner-releases/2026.09.22.2.json";
import capacityRelease from "../../../../provisioner-releases/2026.09.15.2.json";
import omarchyCursorRelease from "../../../../provisioner-releases/2026.09.21.1.json";
import providerRelease from "../../../../provisioner-releases/2026.09.08.3.json";
import {
  AGENT_CLI_VERSIONS,
  PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES,
  PORTABLE_HIVRA_PROVISIONER_VERSION,
  PORTABLE_HIVRA_PROVIDER_VM_PROVISIONER_VERSION,
  provisionerSupportsActivityTelemetry,
  provisionerSupportsWindowsInstaller,
  isCompatibleProxmoxProvisionerVersion,
  isCompatibleProviderVmProvisionerVersion,
  portableProvisionerSupportsCatalogRuntime,
  supportsModelSettingsProvisionerVersion,
  providerProvisionerSupportsCatalogRuntime,
  provisionerSupportsHostCredential,
  provisionerSupportsWakeDoorbell,
  provisionerSupportsWakeProxy,
} from "../portable-provisioner-contract";

it("binds every reviewed portable provisioner asset to the immutable current release", () => {
  expect(release.schema).toBe(1);
  expect(release.version).toBe(PORTABLE_HIVRA_PROVISIONER_VERSION);
  expect(release.files.map(file => file.path)).toEqual([...PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES]);
  for (const file of release.files) {
    const content = readFileSync(path.join(process.cwd(), "provisioner", file.path));
    expect({ path: file.path, bytes: content.length, sha256: createHash("sha256").update(content).digest("hex") })
      .toEqual(file);
  }
});

it.each(["2026.09.05.5", "2026.09.05.6", "2026.09.05.7", "2026.09.05.8", "2026.09.05.9", "2026.09.05.10", "2026.09.06.1", "2026.09.06.2", "2026.09.06.3", "2026.09.06.4", "2026.09.07.1", "2026.09.08.1", "2026.09.08.2", "2026.09.08.3", "2026.09.15.2"])("retains predecessor %s across lifecycle, desktop, provider and model-settings gates", version => {
  expect(isCompatibleProxmoxProvisionerVersion(version)).toBe(true);
  expect(portableProvisionerSupportsCatalogRuntime(version, "linux-desktop")).toBe(true);
  expect(isCompatibleProviderVmProvisionerVersion(version)).toBe(true);
  expect(supportsModelSettingsProvisionerVersion(version)).toBe(true);
});

it("offers fresh provider desktop placement only for the current prepared bundle", () => {
  expect(providerProvisionerSupportsCatalogRuntime(PORTABLE_HIVRA_PROVIDER_VM_PROVISIONER_VERSION, "linux-desktop")).toBe(true);
  for (const version of ["2026.09.04.2", "2026.09.05.9", "2026.09.05.10", "2026.09.06.1", "2026.09.06.2", "2026.09.06.3", "2026.09.07.1", "unknown"])
    expect(providerProvisionerSupportsCatalogRuntime(version, "linux-desktop")).toBe(false);
});

it("advertises Windows installation only from the exact reviewed host releases that ship it", () => {
  expect(provisionerSupportsWindowsInstaller(PORTABLE_HIVRA_PROVISIONER_VERSION)).toBe(true);
  // The current release must not silently drop the capability from hosts
  // still on the first admitted release that shipped it.
  expect(provisionerSupportsWindowsInstaller("2026.09.15.2")).toBe(true);
  for (const version of ["2026.09.15.1", "2026.09.08.2", "2026.09.08.3", "2026.09.07.1", "2099.01.01.1", undefined])
    expect(provisionerSupportsWindowsInstaller(version)).toBe(false);
});

it("ships the agent-run reporter only in a new release, never its tests or into the sealed predecessor", () => {
  const paths = release.files.map(file => file.path);
  expect(paths).toEqual(expect.arrayContaining(["hivra-agent-trace.py", "hivra-agent-trace.service"]));
  expect(paths.filter(file => /(^|\/)test_|\.test\./.test(file))).toEqual([]);
  expect(capacityRelease.version).toBe("2026.09.15.2");
  expect(capacityRelease.files.map(file => file.path)).not.toContain("hivra-agent-trace.py");
  // Credentials are issued only to a host bundle known to carry the reporter.
  expect(provisionerSupportsActivityTelemetry(PORTABLE_HIVRA_PROVISIONER_VERSION)).toBe(true);
  expect(provisionerSupportsActivityTelemetry("2026.09.15.2")).toBe(false);
  expect(omarchyCursorRelease.version).toBe("2026.09.21.1");
  expect(omarchyCursorRelease.files.map(file => file.path)).not.toContain("hivra-agent-trace.py");
  expect(provisionerSupportsActivityTelemetry("2026.09.21.1")).toBe(false);
});

it("ships the detached chat-run supervisor with the gateway, never into the sealed predecessor", () => {
  const paths = release.files.map(file => file.path);
  expect(paths).toContain("hivra-chat/chat-runs.cjs");
  expect(PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES).toContain("hivra-chat/chat-runs.cjs");
  expect(desktopPlannerRelease.version).toBe("2026.09.22.2");
  expect(desktopPlannerRelease.files.map(file => file.path)).not.toContain("hivra-chat/chat-runs.cjs");
  // Hosts still on the predecessor keep every capability they had.
  expect(isCompatibleProxmoxProvisionerVersion("2026.09.22.2")).toBe(true);
  expect(provisionerSupportsActivityTelemetry("2026.09.22.2")).toBe(true);
  expect(supportsModelSettingsProvisionerVersion("2026.09.22.2")).toBe(true);
});

it("ships the socket-aware terminal checks in 2026.09.24.4, keeping 2026.09.24.3 admitted", () => {
  expect(terminalFollowupsRelease.version).toBe("2026.09.24.4");
  // The guest half of the updater moved into its own file in 2026.10.20.1.
  const updater = readFileSync(path.join(process.cwd(), "provisioner/hivra-guest-runtime-update.sh"), "utf8");
  expect(updater).toContain("terminal_idle 7681 /run/hivra-terminal/ttyd.sock && RESTART_AGENT_TTYD=1");
  const server = readFileSync(path.join(process.cwd(), "provisioner/hivra-chat/server.js"), "utf8");
  expect(server).toContain("return terminalUnitUsesSocket(port) ? { unavailable: true } : { port };");
  for (const file of ["hivra-update-guest-runtime.sh", "hivra-chat/server.js"]) {
    const current = terminalFollowupsRelease.files.find(entry => entry.path === file)!;
    const prior = terminalSocketsRelease.files.find(entry => entry.path === file)!;
    expect(current.sha256).not.toBe(prior.sha256);
  }
  expect(isCompatibleProxmoxProvisionerVersion("2026.09.24.3")).toBe(true);
  expect(provisionerSupportsActivityTelemetry("2026.09.24.3")).toBe(true);
});

it("ships the owned DeepSeek update and the updater's guest half in 2026.10.20.1 without touching desktop assets", () => {
  const release = ownedUpdateRelease;
  expect(release.version).toBe("2026.10.20.1");
  const paths = release.files.map(file => file.path);
  for (const file of ["deepseek-harness/update-guest.py", "hivra-guest-runtime-update.sh"]) {
    expect(paths).toContain(file);
    expect(PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES).toContain(file);
    expect(claudeAppRelease.files.map(entry => entry.path)).not.toContain(file);
  }
  // The isolation proof and the remote-desktop bundle revision are preserved,
  // and the DeepSeek install, its package pins and the gateway are unchanged.
  for (const file of ["remote-desktop/install-guest.py", "remote-desktop/broker.cjs", "remote-desktop/server.cjs",
    "deepseek-harness/install-guest.py", "deepseek-harness/install-native.py", "deepseek-harness/service-owner.py",
    "deepseek-harness/package.json", "deepseek-harness/package-lock.json", "hivra-chat/server.js", "provision-claude-code-box.sh"]) {
    const current = release.files.find(entry => entry.path === file)!;
    const prior = claudeAppRelease.files.find(entry => entry.path === file)!;
    expect(current.sha256).toBe(prior.sha256);
  }
  expect(release.files.find(entry => entry.path === "hivra-update-guest-runtime.sh")!.sha256)
    .not.toBe(claudeAppRelease.files.find(entry => entry.path === "hivra-update-guest-runtime.sh")!.sha256);
  // The previous release stays admitted everywhere it was.
  expect(isCompatibleProxmoxProvisionerVersion("2026.10.07.1")).toBe(true);
  expect(isCompatibleProviderVmProvisionerVersion("2026.10.07.1")).toBe(true);
  expect(provisionerSupportsActivityTelemetry("2026.10.07.1")).toBe(true);
  expect(supportsModelSettingsProvisionerVersion("2026.10.07.1")).toBe(true);
  expect(provisionerSupportsWindowsInstaller("2026.10.07.1")).toBe(true);
});

it("ships the optional Claude app (helper, inert unit, pin) in 2026.10.07.1 without touching the desktop container's assets", () => {
  expect(claudeAppRelease.version).toBe("2026.10.07.1");
  const paths = claudeAppRelease.files.map(file => file.path);
  for (const file of ["hivra-claude-app.py", "hivra-claude-app.service", "claude-desktop-pin.json"]) {
    expect(paths).toContain(file);
    expect(PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES).toContain(file);
    expect(terminalFollowupsRelease.files.map(entry => entry.path)).not.toContain(file);
  }
  // The isolation proof and the remote-desktop bundle revision are preserved:
  // the sealed desktop installer, broker and server are byte-identical.
  for (const file of ["remote-desktop/install-guest.py", "remote-desktop/broker.cjs", "remote-desktop/server.cjs"]) {
    const current = claudeAppRelease.files.find(entry => entry.path === file)!;
    const prior = terminalFollowupsRelease.files.find(entry => entry.path === file)!;
    expect(current.sha256).toBe(prior.sha256);
  }
  // The gateway, both lanes that install the helper, and the vetted CLI pin moved.
  for (const file of ["hivra-chat/server.js", "hivra-update-guest-runtime.sh", "provision-claude-code-box.sh", "agent-cli-versions.json"]) {
    const current = claudeAppRelease.files.find(entry => entry.path === file)!;
    const prior = terminalFollowupsRelease.files.find(entry => entry.path === file)!;
    expect(current.sha256).not.toBe(prior.sha256);
  }
  expect(AGENT_CLI_VERSIONS["claude-code"]).toBe("2.1.292");
  // The pin names Anthropic's own repository and matches the evidence documents.
  const pin = JSON.parse(readFileSync(path.join(process.cwd(), "provisioner/claude-desktop-pin.json"), "utf8")) as { version: string; sha256: string; bytes: number; url: string };
  expect(pin.url).toBe(`https://downloads.claude.ai/claude-desktop/apt/stable/pool/main/c/claude-desktop/claude-desktop_${pin.version}_amd64.deb`);
  for (const evidence of ["../docs/release/runtime-distribution-boundary.json", "../docs/release/RUNTIME-DISTRIBUTION.md", "../docs/release/DEPENDENCIES.md", "provisioner/PROVENANCE.md"]) {
    expect(readFileSync(path.join(process.cwd(), evidence), "utf8")).toContain(pin.sha256);
  }
  // The previous release stays admitted everywhere it was.
  expect(isCompatibleProxmoxProvisionerVersion("2026.09.24.4")).toBe(true);
  expect(provisionerSupportsActivityTelemetry("2026.09.24.4")).toBe(true);
  expect(supportsModelSettingsProvisionerVersion("2026.09.24.4")).toBe(true);
});

it("ships the computer hardening (git routes off, ttyd on owner-only sockets) as a new release", () => {
  // The current release's gateway answers /api/git/* with 404 on a computer,
  // and its terminal units listen on unix sockets, not loopback ports.
  // Introduced in 2026.09.24.3 and carried by every later release.
  expect(terminalSocketsRelease.version).toBe("2026.09.24.3");
  const server = readFileSync(path.join(process.cwd(), "provisioner/hivra-chat/server.js"), "utf8");
  expect(server).toContain("git_unavailable_on_computer");
  for (const [file, socket] of [["bux-ttyd-base-path.conf", "/run/hivra-terminal/ttyd.sock"], ["bux-box-ttyd.service", "/run/hivra-box-terminal/ttyd.sock"]]) {
    const unit = release.files.find(f => f.path === file)!;
    const bytes = readFileSync(path.join(process.cwd(), "provisioner", file), "utf8");
    expect(bytes).toContain(`-i ${socket}`);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(unit.sha256);
  }
  // It is sealed on top of the persistent-sessions release: its terminals
  // keep the persistent tmux sessions, now on the sockets.
  for (const file of ["bux-ttyd-base-path.conf", "bux-box-ttyd.service"]) {
    const bytes = readFileSync(path.join(process.cwd(), "provisioner", file), "utf8");
    expect(bytes).toContain("-a -W /usr/local/bin/hivra-agent-shell --");
    expect(bytes).toContain("KillMode=process\n");
  }
  expect(persistentSessionsRelease.version).toBe("2026.09.24.2");
  for (const file of persistentSessionsRelease.files.map(entry => entry.path)) expect(release.files.map(entry => entry.path)).toContain(file);
  // The prior releases stay admitted and fully compatible.
  for (const version of ["2026.09.24.4", "2026.09.24.3", "2026.09.24.2", "2026.09.24.1"]) {
    expect(isCompatibleProxmoxProvisionerVersion(version)).toBe(true);
    expect(provisionerSupportsActivityTelemetry(version)).toBe(true);
    expect(supportsModelSettingsProvisionerVersion(version)).toBe(true);
  }
});

it("ships persistent work (terminal sessions, vetted agent CLIs, saved sign-ins) only in the new release", () => {
  const paths = release.files.map(file => file.path);
  for (const file of ["agent-cli-versions.json", "hivra-agent-cli-update.sh", "hivra-codex-config-pin.py"]) {
    expect(paths).toContain(file);
    expect(PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES).toContain(file);
    expect(detachedRunsRelease.files.map(entry => entry.path)).not.toContain(file);
  }
  expect(detachedRunsRelease.version).toBe("2026.09.24.1");
  // Hosts still on the predecessor keep every capability they had.
  expect(isCompatibleProxmoxProvisionerVersion("2026.09.24.1")).toBe(true);
  expect(provisionerSupportsActivityTelemetry("2026.09.24.1")).toBe(true);
  expect(supportsModelSettingsProvisionerVersion("2026.09.24.1")).toBe(true);
});

it("keeps the retained provider predecessor bound to its independently sealed bundle", () => {
  const rows = providerRelease.files.map(file => [file.path, file.sha256, file.bytes,
    file.path.endsWith(".sh") || ["hivra-browser-apply", "hivra-guest-ssh-known-hosts", "hivra-network-preflight", "hivra-tg-apply"].includes(file.path) ? 0o700 : 0o600])
    .sort((a, b) => String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0);
  const digest = createHash("sha256").update(JSON.stringify(rows)).digest("hex");
  const sql = readFileSync("supabase/migrations/20260908090000_desktop_handoff_latency_release.sql", "utf8");
  expect(sql).toContain(digest);
  expect(sql).toContain("73ba80eb4007cdba90046637af0efc4712b395532a3fe890cc6a2bbb6dc322cb");
  expect(sql).toContain("2026.09.08.3");
  expect(sql).toContain("Desktop handoff latency release anchor mismatch");
});

it("admits every retained and current provider bundle in SQL, bound to its sealed manifest", () => {
  // Regression: 2026.09.15.1, .15.2 and .21.1 shipped TypeScript identities but
  // SQL admission stopped at 2026.09.08.3, so their provider computers could
  // never be admitted or keep a valid identity.
  const sql = ["20260922201510_provider_release_admission_2026_09_22.sql", "20260924180000_provider_release_admission_2026_09_24.sql",
    "20260924220000_provider_release_admission_2026_09_24_2.sql", "20260925100100_provider_release_admission_2026_09_24_3.sql",
    "20260925110000_provider_release_admission_2026_09_24_4.sql", "20261007130000_provider_release_admission_2026_10_07_1.sql",
    "20261020110000_provider_release_admission_2026_10_20_1.sql", "20261020130000_provider_release_admission_2026_10_20_2.sql",
    "20261103120000_provider_release_admission_2026_11_03_1.sql", "20261110120000_provider_release_admission_2026_11_10_1.sql", "20261110180000_provider_release_admission_2026_11_10_2.sql", "20261110200000_provider_release_admission_2026_11_10_3.sql", "20261110220000_provider_release_admission_2026_11_10_4.sql", "20261111160000_provider_release_admission_2026_11_10_5.sql", "20261111180000_provider_release_admission_2026_11_11_1.sql", "20261111200000_provider_release_admission_2026_11_11_2.sql", "20261111220000_provider_release_admission_2026_11_11_3.sql", "20261111233000_provider_release_admission_2026_11_11_4.sql", "20261112100000_provider_release_admission_2026_11_11_5.sql", "20261112120000_provider_release_admission_2026_11_11_6.sql", "20261112160000_provider_release_admission_2026_11_11_7.sql", "20261112170000_provider_release_admission_2026_11_12_1.sql", "20261112180000_provider_release_admission_2026_11_12_2.sql", "20261112190000_provider_release_admission_2026_11_12_3.sql", "20261112210000_provider_release_admission_2026_11_12_4.sql", "20261113091000_provider_release_admission_2026_11_12_5.sql", "20261113103000_provider_release_admission_2026_11_13_1.sql", "20261113111000_provider_release_admission_2026_11_13_2.sql", "20261113121000_provider_release_admission_2026_11_13_3.sql", "20261113130000_provider_release_admission_2026_11_13_4.sql", "20261113140000_provider_release_admission_2026_11_13_5.sql"]
    .map(name => readFileSync(`supabase/migrations/${name}`, "utf8")).join("\n");
  for (const version of ["2026.09.15.1", "2026.09.15.2", "2026.09.21.1", "2026.09.22.1", "2026.09.22.2", "2026.09.24.1", "2026.09.24.2", "2026.09.24.3", "2026.09.24.4", "2026.10.07.1", "2026.10.20.1", "2026.10.20.2", "2026.11.03.1", "2026.11.10.1", "2026.11.10.2", "2026.11.10.3", "2026.11.10.4", "2026.11.10.5", "2026.11.11.1", "2026.11.11.2", "2026.11.11.3", "2026.11.11.4", "2026.11.11.5", "2026.11.11.6", "2026.11.11.7", "2026.11.12.1", "2026.11.12.2", "2026.11.12.3", "2026.11.12.4", "2026.11.12.5", "2026.11.13.1", "2026.11.13.2", "2026.11.13.3", "2026.11.13.4", PORTABLE_HIVRA_PROVIDER_VM_PROVISIONER_VERSION]) {
    const manifest = JSON.parse(readFileSync(`provisioner-releases/${version}.json`, "utf8")) as typeof release;
    const rows = manifest.files.map(file => [file.path, file.sha256, file.bytes,
      file.path.endsWith(".sh") || ["hivra-browser-apply", "hivra-guest-ssh-known-hosts", "hivra-network-preflight", "hivra-tg-apply"].includes(file.path) ? 0o700 : 0o600])
      .sort((a, b) => String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0);
    const digest = createHash("sha256").update(JSON.stringify(rows)).digest("hex");
    expect(sql).toContain(`''bundleSha256''=''${digest}'' and p_identity->''bundle''->>''provisionerVersion''=''${version}''`);
    expect(sql).toContain(`''${version}''`);
  }
  expect(sql).toContain("Provider release admission anchor mismatch");
});

it("ships the agent app updater and pins in 2026.10.20.2, keeping 2026.10.20.1 admitted and desktop assets unchanged", () => {
  expect(appUpdateRelease.version).toBe("2026.10.20.2");
  const paths = appUpdateRelease.files.map(file => file.path);
  for (const file of ["agent-app-versions.json", "hivra-agent-app-update.sh"]) {
    expect(paths).toContain(file);
    expect(PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES).toContain(file);
    expect(ownedUpdateRelease.files.map(entry => entry.path)).not.toContain(file);
  }
  // The isolation proof, the remote-desktop bundle revision and the DeepSeek package are preserved.
  for (const file of ["remote-desktop/install-guest.py", "remote-desktop/broker.cjs", "remote-desktop/server.cjs",
    "deepseek-harness/install-guest.py", "deepseek-harness/install-native.py", "deepseek-harness/update-guest.py",
    "deepseek-harness/package.json", "deepseek-harness/package-lock.json", "agent-cli-versions.json", "hivra-agent-cli-update.sh"]) {
    const current = appUpdateRelease.files.find(entry => entry.path === file)!;
    const prior = ownedUpdateRelease.files.find(entry => entry.path === file)!;
    expect(current.sha256).toBe(prior.sha256);
  }
  for (const file of ["hivra-chat/server.js", "hivra-update-guest-runtime.sh", "hivra-guest-runtime-update.sh", "provision-claude-code-box.sh"]) {
    expect(appUpdateRelease.files.find(entry => entry.path === file)!.sha256)
      .not.toBe(ownedUpdateRelease.files.find(entry => entry.path === file)!.sha256);
  }
  expect(isCompatibleProxmoxProvisionerVersion("2026.10.20.1")).toBe(true);
  expect(isCompatibleProviderVmProvisionerVersion("2026.10.20.1")).toBe(true);
  expect(provisionerSupportsActivityTelemetry("2026.10.20.1")).toBe(true);
  expect(supportsModelSettingsProvisionerVersion("2026.10.20.1")).toBe(true);
  expect(provisionerSupportsWindowsInstaller("2026.10.20.1")).toBe(true);
});

it("ships the clipboard switch, the Code tab backup and the agent browser sandbox in 2026.11.03.1, keeping 2026.10.20.2 admitted and desktop assets unchanged", () => {
  expect(clipboardRelease.version).toBe("2026.11.03.1");
  expect(clipboardRelease.files.map(file => file.path)).toEqual(appUpdateRelease.files.map(file => file.path));
  // The isolation proof, the remote-desktop bundle revision and every other runtime are preserved.
  for (const file of ["remote-desktop/install-guest.py", "remote-desktop/broker.cjs", "remote-desktop/server.cjs",
    "remote-desktop/provider-service-plan.py", "remote-desktop/provider-service-owner.py",
    "deepseek-harness/install-guest.py", "deepseek-harness/install-native.py", "deepseek-harness/update-guest.py",
    "agent-cli-versions.json", "agent-app-versions.json", "claude-desktop-pin.json", "hivra-claude-app.service",
    "hivra-update-guest-runtime.sh", "bux-local-browser.service"]) {
    const current = clipboardRelease.files.find(entry => entry.path === file)!;
    const prior = appUpdateRelease.files.find(entry => entry.path === file)!;
    expect({ file, sha256: current.sha256 }).toEqual({ file, sha256: prior.sha256 });
  }
  for (const file of ["hivra-claude-app.py", "hivra-chat/server.js", "hivra-guest-runtime-update.sh", "provision-claude-code-box.sh", "local-browser-keeper.py"]) {
    expect(clipboardRelease.files.find(entry => entry.path === file)!.sha256)
      .not.toBe(appUpdateRelease.files.find(entry => entry.path === file)!.sha256);
  }
  // The installer and the runtime updater grant the same, exact helper verbs.
  const grant = (file: string) => {
    const text = readFileSync(path.join(process.cwd(), "provisioner", file), "utf8");
    return [...text.matchAll(/NOPASSWD: (\/usr\/local\/bin\/hivra-claude-app [^'"\n]+)/g)].map(match => match[1]);
  };
  expect(grant("hivra-guest-runtime-update.sh")).toEqual(grant("provision-claude-code-box.sh"));
  expect(grant("provision-claude-code-box.sh")[0]).toContain("hivra-claude-app clipboard-put");
  expect(isCompatibleProxmoxProvisionerVersion("2026.10.20.2")).toBe(true);
  expect(isCompatibleProviderVmProvisionerVersion("2026.10.20.2")).toBe(true);
  expect(provisionerSupportsActivityTelemetry("2026.10.20.2")).toBe(true);
  expect(supportsModelSettingsProvisionerVersion("2026.10.20.2")).toBe(true);
  expect(provisionerSupportsWindowsInstaller("2026.10.20.2")).toBe(true);
});

it("ships the launch and start hardening and the agent self-care guidance in 2026.11.10.1, keeping 2026.11.03.1 admitted and desktop assets unchanged", () => {
  expect(hardeningRelease.version).toBe("2026.11.10.1");
  expect(hardeningRelease.files.map(file => file.path)).toEqual(clipboardRelease.files.map(file => file.path));
  const changed = hardeningRelease.files.filter(file => file.sha256 !== clipboardRelease.files.find(entry => entry.path === file.path)!.sha256)
    .map(file => file.path).sort();
  // Exactly the hardened scripts, the two prompts and the release documents change.
  expect(changed).toEqual(["PROVENANCE.md", "README.md", "VERSION", "hivra-provider-worker.py", "hivra-provision-on-host.sh",
    "hivra-start-on-host.sh", "provision-claude-code-box.sh", "system-prompt-codex.md", "system-prompt.md"]);
  expect(isCompatibleProxmoxProvisionerVersion("2026.11.03.1")).toBe(true);
  expect(isCompatibleProviderVmProvisionerVersion("2026.11.03.1")).toBe(true);
  expect(provisionerSupportsActivityTelemetry("2026.11.03.1")).toBe(true);
  expect(supportsModelSettingsProvisionerVersion("2026.11.03.1")).toBe(true);
  expect(provisionerSupportsWindowsInstaller("2026.11.03.1")).toBe(true);
});

it("ships Claude Code on Hivra credits in 2026.11.10.2, keeping 2026.11.10.1 admitted and desktop assets unchanged", () => {
  expect(creditsRelease.version).toBe("2026.11.10.2");
  expect(creditsRelease.files.map(file => file.path)).toEqual(hardeningRelease.files.map(file => file.path));
  const changed = creditsRelease.files.filter(file => file.sha256 !== hardeningRelease.files.find(entry => entry.path === file.path)!.sha256)
    .map(file => file.path).sort();
  // Exactly the installer and the release documents/labels change.
  expect(changed).toEqual(["PROVENANCE.md", "README.md", "VERSION", "hivra-provider-worker.py", "provision-claude-code-box.sh"]);
  expect(isCompatibleProxmoxProvisionerVersion("2026.11.10.1")).toBe(true);
  expect(isCompatibleProviderVmProvisionerVersion("2026.11.10.1")).toBe(true);
  expect(provisionerSupportsActivityTelemetry("2026.11.10.1")).toBe(true);
  expect(supportsModelSettingsProvisionerVersion("2026.11.10.1")).toBe(true);
  expect(provisionerSupportsWindowsInstaller("2026.11.10.1")).toBe(true);
});


it("ships the Codex sign-in freshness fix in 2026.11.10.3, keeping 2026.11.10.2 admitted and desktop assets unchanged", () => {
  expect(freshnessRelease.version).toBe("2026.11.10.3");
  expect(freshnessRelease.files.map(file => file.path)).toEqual(creditsRelease.files.map(file => file.path));
  const changed = freshnessRelease.files.filter(file => file.sha256 !== creditsRelease.files.find(entry => entry.path === file.path)!.sha256)
    .map(file => file.path).sort();
  // Exactly the chat server and the release documents/labels change.
  expect(changed).toEqual(["PROVENANCE.md", "README.md", "VERSION", "hivra-chat/server.js", "hivra-provider-worker.py"]);
  expect(isCompatibleProxmoxProvisionerVersion("2026.11.10.2")).toBe(true);
  expect(isCompatibleProviderVmProvisionerVersion("2026.11.10.2")).toBe(true);
  expect(provisionerSupportsActivityTelemetry("2026.11.10.2")).toBe(true);
  expect(supportsModelSettingsProvisionerVersion("2026.11.10.2")).toBe(true);
  expect(provisionerSupportsWindowsInstaller("2026.11.10.2")).toBe(true);
});

it("ships the linux-server kind in 2026.11.10.4, keeping 2026.11.10.3 admitted and desktop assets unchanged", () => {
  expect(linuxServerRelease.version).toBe("2026.11.10.4");
  expect(linuxServerRelease.files.map(file => file.path)).toEqual(freshnessRelease.files.map(file => file.path));
  const changed = linuxServerRelease.files.filter(file => file.sha256 !== freshnessRelease.files.find(entry => entry.path === file.path)!.sha256)
    .map(file => file.path).sort();
  // Exactly the scripts that accept the new kind and the release documents/labels change.
  // No remote-desktop asset changes, so the desktop bundle revision is preserved.
  expect(changed).toEqual(["PROVENANCE.md", "README.md", "VERSION", "hivra-agent-shell", "hivra-chat/server.js", "hivra-guest-runtime-update.sh",
    "hivra-install-agent.py", "hivra-provider-worker.py", "hivra-provision-on-host.sh", "hivra-runtime-receipt.py", "provision-claude-code-box.sh"]);
  expect(changed.filter(file => file.startsWith("remote-desktop/"))).toEqual([]);
  for (const version of ["2026.11.10.1", "2026.11.10.2", "2026.11.10.3"]) {
    expect(isCompatibleProxmoxProvisionerVersion(version)).toBe(true);
    expect(isCompatibleProviderVmProvisionerVersion(version)).toBe(true);
    expect(provisionerSupportsActivityTelemetry(version)).toBe(true);
    expect(supportsModelSettingsProvisionerVersion(version)).toBe(true);
    expect(provisionerSupportsWindowsInstaller(version)).toBe(true);
  }
  expect(provisionerSupportsActivityTelemetry("2026.11.10.4")).toBe(true);
});

it("ships the DeepSeek launch-time model in 2026.11.10.5, keeping 2026.11.10.4 admitted and desktop assets unchanged", () => {
  expect(deepseekModelRelease.version).toBe("2026.11.10.5");
  expect(deepseekModelRelease.files.map(file => file.path)).toEqual(linuxServerRelease.files.map(file => file.path));
  const changed = deepseekModelRelease.files.filter(file => file.sha256 !== linuxServerRelease.files.find(entry => entry.path === file.path)!.sha256)
    .map(file => file.path).sort();
  // Exactly the host script that forwards the model, the launch parser, the guest
  // composition that seeds it, and the release documents/labels change. The
  // service unit, broker, package pins and remote-desktop assets do not.
  expect(changed).toEqual(["PROVENANCE.md", "README.md", "VERSION", "deepseek-harness/install-guest.py", "hivra-install-agent.py",
    "hivra-provider-worker.py", "hivra-provision-on-host.sh"]);
  expect(changed.filter(file => file.startsWith("remote-desktop/"))).toEqual([]);
  for (const version of ["2026.11.10.1", "2026.11.10.2", "2026.11.10.3", "2026.11.10.4"]) {
    expect(isCompatibleProxmoxProvisionerVersion(version)).toBe(true);
    expect(isCompatibleProviderVmProvisionerVersion(version)).toBe(true);
    expect(provisionerSupportsActivityTelemetry(version)).toBe(true);
    expect(supportsModelSettingsProvisionerVersion(version)).toBe(true);
    expect(provisionerSupportsWindowsInstaller(version)).toBe(true);
  }
  expect(provisionerSupportsActivityTelemetry("2026.11.10.5")).toBe(true);
});

it("admits DeepSeek Harness only from the release that seeds its model, and keeps the Linux server on both", () => {
  expect(portableProvisionerSupportsCatalogRuntime("2026.11.10.5", "deepseek-harness")).toBe(true);
  for (const version of ["2026.11.10.4", "2026.11.10.3", "2026.11.10.2", "2026.11.03.1", "unknown", undefined])
    expect(portableProvisionerSupportsCatalogRuntime(version, "deepseek-harness")).toBe(false);
  for (const version of ["2026.11.10.4", "2026.11.10.5"]) expect(portableProvisionerSupportsCatalogRuntime(version, "linux-server")).toBe(true);
});

it("admits the Linux server only on 2026.11.10.4 and later and never on the provider-VM lane", () => {
  expect(portableProvisionerSupportsCatalogRuntime("2026.11.10.4", "linux-server")).toBe(true);
  for (const version of ["2026.11.10.3", "2026.11.10.2", "2026.11.10.1", "2026.11.03.1", "2026.09.04.2", "unknown", undefined])
    expect(portableProvisionerSupportsCatalogRuntime(version, "linux-server")).toBe(false);
  expect(providerProvisionerSupportsCatalogRuntime(PORTABLE_HIVRA_PROVIDER_VM_PROVISIONER_VERSION, "linux-server")).toBe(false);
});

it("ships the clean agent browser view in 2026.11.11.1, keeping 2026.11.10.5 admitted and desktop assets unchanged", () => {
  expect(browserViewRelease.version).toBe("2026.11.11.1");
  expect(browserViewRelease.files.map(file => file.path)).toEqual(deepseekModelRelease.files.map(file => file.path));
  const changed = browserViewRelease.files.filter(file => file.sha256 !== deepseekModelRelease.files.find(entry => entry.path === file.path)!.sha256)
    .map(file => file.path).sort();
  // Exactly the keeper, the installer that writes the policy and holds Chrome, both
  // halves of the runtime update that carry them to existing computers, and the
  // release documents/labels change. The service unit, broker, package pins and
  // remote-desktop assets do not.
  expect(changed).toEqual(["PROVENANCE.md", "README.md", "VERSION", "hivra-guest-runtime-update.sh", "hivra-provider-worker.py",
    "hivra-update-guest-runtime.sh", "local-browser-keeper.py", "provision-claude-code-box.sh"]);
  expect(changed.filter(file => file.startsWith("remote-desktop/"))).toEqual([]);
  for (const version of ["2026.11.10.1", "2026.11.10.2", "2026.11.10.3", "2026.11.10.4", "2026.11.10.5"]) {
    expect(isCompatibleProxmoxProvisionerVersion(version)).toBe(true);
    expect(isCompatibleProviderVmProvisionerVersion(version)).toBe(true);
    expect(provisionerSupportsActivityTelemetry(version)).toBe(true);
    expect(supportsModelSettingsProvisionerVersion(version)).toBe(true);
    expect(provisionerSupportsWindowsInstaller(version)).toBe(true);
  }
  expect(provisionerSupportsActivityTelemetry("2026.11.11.1")).toBe(true);
});

it("ships the Chrome pin in 2026.11.11.2, keeping 2026.11.11.1 admitted and desktop assets unchanged", () => {
  expect(chromePinRelease.version).toBe("2026.11.11.2");
  // chrome-pin.json is new; everything else that exists in both releases keeps its place.
  expect(chromePinRelease.files.map(file => file.path).filter(file => file !== "chrome-pin.json"))
    .toEqual(browserViewRelease.files.map(file => file.path));
  expect(PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES).toContain("chrome-pin.json");
  expect(browserViewRelease.files.map(file => file.path)).not.toContain("chrome-pin.json");
  const changed = chromePinRelease.files.filter(file => file.sha256 !== browserViewRelease.files.find(entry => entry.path === file.path)?.sha256)
    .map(file => file.path).sort();
  // Exactly the pin, the installer that reads it, both halves of the runtime update
  // that move existing computers to it, and the release documents/labels change. The
  // keeper, the browser unit, the policy, package pins and remote-desktop assets do not.
  expect(changed).toEqual(["PROVENANCE.md", "README.md", "VERSION", "chrome-pin.json", "hivra-guest-runtime-update.sh",
    "hivra-provider-worker.py", "hivra-update-guest-runtime.sh", "provision-claude-code-box.sh"]);
  expect(changed.filter(file => file.startsWith("remote-desktop/"))).toEqual([]);
  // The file in the manifest is the file the installer and the updater read.
  const pin = chromePinRelease.files.find(file => file.path === "chrome-pin.json")!;
  const content = readFileSync(path.join(process.cwd(), "provisioner/chrome-pin.json"));
  expect({ bytes: content.length, sha256: createHash("sha256").update(content).digest("hex") }).toEqual({ bytes: pin.bytes, sha256: pin.sha256 });
  for (const version of ["2026.11.10.5", "2026.11.11.1"]) {
    expect(isCompatibleProxmoxProvisionerVersion(version)).toBe(true);
    expect(isCompatibleProviderVmProvisionerVersion(version)).toBe(true);
    expect(provisionerSupportsActivityTelemetry(version)).toBe(true);
    expect(supportsModelSettingsProvisionerVersion(version)).toBe(true);
    expect(provisionerSupportsWindowsInstaller(version)).toBe(true);
  }
  expect(provisionerSupportsActivityTelemetry("2026.11.11.2")).toBe(true);
});

it("ships real chat effort in 2026.11.11.3, keeping 2026.11.11.2 admitted and every other asset unchanged", () => {
  expect(chatEffortRelease.version).toBe("2026.11.11.3");
  expect(chatEffortRelease.files.map(file => file.path)).toEqual(chromePinRelease.files.map(file => file.path));
  const changed = chatEffortRelease.files.filter(file => file.sha256 !== chromePinRelease.files.find(entry => entry.path === file.path)!.sha256)
    .map(file => file.path).sort();
  // Exactly the chat gateway and the release documents/labels change. server.js is already a
  // runtime update asset (GATEWAY_ASSETS), so existing computers receive it with the update.
  expect(changed).toEqual(["PROVENANCE.md", "README.md", "VERSION", "hivra-chat/server.js", "hivra-provider-worker.py"]);
  expect(changed.filter(file => file.startsWith("remote-desktop/"))).toEqual([]);
  for (const version of ["2026.11.10.5", "2026.11.11.1", "2026.11.11.2"]) {
    expect(isCompatibleProxmoxProvisionerVersion(version)).toBe(true);
    expect(isCompatibleProviderVmProvisionerVersion(version)).toBe(true);
    expect(provisionerSupportsActivityTelemetry(version)).toBe(true);
    expect(supportsModelSettingsProvisionerVersion(version)).toBe(true);
    expect(provisionerSupportsWindowsInstaller(version)).toBe(true);
  }
  for (const script of ["hivra-update-guest-runtime.sh", "hivra-guest-runtime-update.sh"])
    expect(readFileSync(path.join(process.cwd(), "provisioner", script), "utf8")).toMatch(/^ASSETS=\(server\.js /m);
  expect(provisionerSupportsActivityTelemetry("2026.11.11.3")).toBe(true);
});

it("ships the official Hermes Agent in 2026.11.11.4, keeping 2026.11.11.3 admitted and no new asset", () => {
  expect(hermesRelease.version).toBe("2026.11.11.4");
  expect(hermesRelease.files.map(file => file.path)).toEqual(chatEffortRelease.files.map(file => file.path));
  const changed = hermesRelease.files.filter(file => file.sha256 !== chatEffortRelease.files.find(entry => entry.path === file.path)!.sha256)
    .map(file => file.path).sort();
  // Exactly the scripts that install, proxy, update and allow-list the kind, and the
  // release documents/labels change. No Hivra-built image, fork or patch ships: the
  // computer runs Hermes's own installer, and the remote-desktop assets are untouched.
  expect(changed).toEqual([
    "PROVENANCE.md", "README.md", "VERSION", "hivra-agent-app-update.sh", "hivra-agent-shell", "hivra-chat/server.js",
    "hivra-guest-runtime-update.sh", "hivra-install-agent.py", "hivra-provider-worker.py", "hivra-provision-on-host.sh",
    "hivra-runtime-receipt.py", "hivra-update-guest-runtime.sh", "provision-claude-code-box.sh",
  ]);
  expect(changed.filter(file => file.startsWith("remote-desktop/"))).toEqual([]);
  for (const version of ["2026.11.10.5", "2026.11.11.1", "2026.11.11.2", "2026.11.11.3"]) {
    expect(isCompatibleProxmoxProvisionerVersion(version)).toBe(true);
    expect(isCompatibleProviderVmProvisionerVersion(version)).toBe(true);
    expect(provisionerSupportsActivityTelemetry(version)).toBe(true);
    expect(supportsModelSettingsProvisionerVersion(version)).toBe(true);
    expect(provisionerSupportsWindowsInstaller(version)).toBe(true);
  }
  expect(provisionerSupportsActivityTelemetry("2026.11.11.4")).toBe(true);
  // A computer on the previous release cannot install Hermes. This release added the kind,
  // but its installer cannot finish on the Ubuntu image (no libatomic1), so placement now
  // waits for 2026.11.11.6.
  expect(portableProvisionerSupportsCatalogRuntime("2026.11.11.3", "hermes")).toBe(false);
  expect(portableProvisionerSupportsCatalogRuntime("2026.11.11.4", "hermes")).toBe(false);
});

it("runs the Hermes gateway in 2026.11.11.5, keeping 2026.11.11.4 admitted and no new asset", () => {
  expect(gatewayRelease.version).toBe("2026.11.11.5");
  expect(gatewayRelease.files.map(file => file.path)).toEqual(hermesRelease.files.map(file => file.path));
  const changed = gatewayRelease.files.filter(file => file.sha256 !== hermesRelease.files.find(entry => entry.path === file.path)!.sha256)
    .map(file => file.path).sort();
  // Exactly the launch script, the guest half of the runtime update, the worker's release labels
  // and the release documents change. server.js and the remote-desktop assets are untouched.
  expect(changed).toEqual([
    "PROVENANCE.md", "README.md", "VERSION", "hivra-guest-runtime-update.sh", "hivra-provider-worker.py", "provision-claude-code-box.sh",
  ]);
  for (const version of ["2026.11.11.4", "2026.11.11.5"]) {
    expect(isCompatibleProxmoxProvisionerVersion(version)).toBe(true);
    expect(isCompatibleProviderVmProvisionerVersion(version)).toBe(true);
    expect(provisionerSupportsActivityTelemetry(version)).toBe(true);
  }
});

it("installs libatomic1 before Hermes's installer in 2026.11.11.6, keeping 2026.11.11.5 admitted and no new asset", () => {
  expect(libatomicRelease.version).toBe("2026.11.11.6");
  expect(libatomicRelease.files.map(file => file.path)).toEqual(gatewayRelease.files.map(file => file.path));
  const changed = libatomicRelease.files.filter(file => file.sha256 !== gatewayRelease.files.find(entry => entry.path === file.path)!.sha256)
    .map(file => file.path).sort();
  // Exactly the launch script, the worker's release labels and the release documents change.
  expect(changed).toEqual(["PROVENANCE.md", "VERSION", "hivra-provider-worker.py", "provision-claude-code-box.sh"]);
  const script = readFileSync("provisioner/provision-claude-code-box.sh", "utf8");
  const atomic = script.indexOf("apt_get install -y libatomic1");
  expect(atomic).toBeGreaterThan(script.indexOf('if [ "$AGENT_KIND" = "hermes" ]; then'));
  expect(atomic).toBeLessThan(script.indexOf('bash "${HERMES_TMP}/install.sh"'));
  for (const version of ["2026.11.11.5", "2026.11.11.6"]) {
    expect(isCompatibleProxmoxProvisionerVersion(version)).toBe(true);
    expect(isCompatibleProviderVmProvisionerVersion(version)).toBe(true);
    expect(provisionerSupportsActivityTelemetry(version)).toBe(true);
  }
  // Hermes is placed only on a host whose installer can finish (and, from 2026.11.11.7, shows the Desktop).
  expect(portableProvisionerSupportsCatalogRuntime("2026.11.11.5", "hermes")).toBe(false);
});

it("shows Hermes's own Desktop Webapp at /hermes in 2026.11.11.7, keeping 2026.11.11.6 admitted and no new asset", () => {
  expect(webappRelease.version).toBe("2026.11.11.7");
  expect(webappRelease.files.map(file => file.path)).toEqual(libatomicRelease.files.map(file => file.path));
  const changed = webappRelease.files.filter(file => file.sha256 !== libatomicRelease.files.find(entry => entry.path === file.path)!.sha256)
    .map(file => file.path).sort();
  // The box gateway, the guest installer, Update Hermes, the worker's release labels and the
  // release documents change. The remote-desktop assets are untouched.
  expect(changed).toEqual(["PROVENANCE.md", "README.md", "VERSION", "hivra-agent-app-update.sh", "hivra-chat/server.js", "hivra-provider-worker.py", "provision-claude-code-box.sh"]);
  const script = readFileSync("provisioner/provision-claude-code-box.sh", "utf8");
  const build = script.indexOf("webapp --build-only");
  expect(build).toBeGreaterThan(script.indexOf('bash "${HERMES_TMP}/install.sh"'));
  expect(script).toContain("config set webapp.enabled true");
  const update = readFileSync("provisioner/hivra-agent-app-update.sh", "utf8");
  expect(update).toContain("webapp --build-only");
  expect(update).toContain("gateway restart");
  for (const version of ["2026.11.11.6", "2026.11.11.7"]) {
    expect(isCompatibleProxmoxProvisionerVersion(version)).toBe(true);
    expect(isCompatibleProviderVmProvisionerVersion(version)).toBe(true);
    expect(provisionerSupportsActivityTelemetry(version)).toBe(true);
  }
  // A new Hermes computer is placed only where it opens on the Desktop.
  expect(portableProvisionerSupportsCatalogRuntime("2026.11.11.6", "hermes")).toBe(false);
});

it("lets Hivra set Hermes's own model in 2026.11.12.1, keeping 2026.11.11.7 admitted and no new asset", () => {
  expect(hermesModelRelease.version).toBe("2026.11.12.1");
  expect(hermesModelRelease.files.map(file => file.path)).toEqual(webappRelease.files.map(file => file.path));
  const changed = hermesModelRelease.files.filter(file => file.sha256 !== webappRelease.files.find(entry => entry.path === file.path)!.sha256)
    .map(file => file.path).sort();
  // Only the box gateway, the worker's release labels and the release documents change.
  expect(changed).toEqual(["PROVENANCE.md", "README.md", "VERSION", "hivra-chat/server.js", "hivra-provider-worker.py"]);
  const gateway = readFileSync("provisioner/hivra-chat/server.js", "utf8");
  expect(gateway).toContain('["config", "set", "model.default", model]');
  for (const version of ["2026.11.11.7", "2026.11.12.1"]) {
    expect(isCompatibleProxmoxProvisionerVersion(version)).toBe(true);
    expect(isCompatibleProviderVmProvisionerVersion(version)).toBe(true);
    expect(provisionerSupportsActivityTelemetry(version)).toBe(true);
  }
  // A new Hermes computer is placed only where Hivra can set its model.
  expect(portableProvisionerSupportsCatalogRuntime("2026.11.11.7", "hermes")).toBe(false);
  expect(portableProvisionerSupportsCatalogRuntime("2026.11.12.1", "hermes")).toBe(true);
});

it("keeps Claude Code's local approvals out of commits in 2026.11.12.2, keeping 2026.11.12.1 admitted and no new asset", () => {
  expect(gitGuardRelease.version).toBe("2026.11.12.2");
  expect(gitGuardRelease.files.map(file => file.path)).toEqual(hermesModelRelease.files.map(file => file.path));
  const changed = gitGuardRelease.files.filter(file => file.sha256 !== hermesModelRelease.files.find(entry => entry.path === file.path)!.sha256)
    .map(file => file.path).sort();
  // Only the guest installer, the worker's release labels and the release documents change.
  expect(changed).toEqual(["PROVENANCE.md", "README.md", "VERSION", "hivra-provider-worker.py", "provision-claude-code-box.sh"]);
  expect(readFileSync("provisioner/provision-claude-code-box.sh", "utf8")).toContain("\ninstall_git_secret_guard\n");
  for (const version of ["2026.11.12.1", "2026.11.12.2"]) {
    expect(isCompatibleProxmoxProvisionerVersion(version)).toBe(true);
    expect(isCompatibleProviderVmProvisionerVersion(version)).toBe(true);
    expect(provisionerSupportsActivityTelemetry(version)).toBe(true);
  }
  // No runtime needs the new release to be placed; Hermes keeps its 2026.11.12.1 minimum.
  expect(portableProvisionerSupportsCatalogRuntime("2026.11.12.1", "hermes")).toBe(true);
  expect(portableProvisionerSupportsCatalogRuntime("2026.11.12.2", "hermes")).toBe(true);
});

it("lets Hivra turn on Hermes's own restore points in 2026.11.12.3, keeping 2026.11.12.2 admitted and no new asset", () => {
  expect(restorePointsRelease.version).toBe("2026.11.12.3");
  expect(restorePointsRelease.files.map(file => file.path)).toEqual(gitGuardRelease.files.map(file => file.path));
  const changed = restorePointsRelease.files.filter(file => file.sha256 !== gitGuardRelease.files.find(entry => entry.path === file.path)!.sha256)
    .map(file => file.path).sort();
  // Only the box gateway, the worker's release labels and the release documents change.
  expect(changed).toEqual(["PROVENANCE.md", "README.md", "VERSION", "hivra-chat/server.js", "hivra-provider-worker.py"]);
  expect(readFileSync("provisioner/hivra-chat/server.js", "utf8")).toContain('"checkpoints.enabled"');
  for (const version of ["2026.11.12.2", "2026.11.12.3"]) {
    expect(isCompatibleProxmoxProvisionerVersion(version)).toBe(true);
    expect(isCompatibleProviderVmProvisionerVersion(version)).toBe(true);
    expect(provisionerSupportsActivityTelemetry(version)).toBe(true);
  }
  // No runtime needs the new release to be placed; an older Hermes computer asks for the connection service update.
  expect(portableProvisionerSupportsCatalogRuntime("2026.11.12.1", "hermes")).toBe(true);
  expect(portableProvisionerSupportsCatalogRuntime("2026.11.12.3", "hermes")).toBe(true);
});

it("adds OpenBot (CopilotKit) in 2026.11.12.4, keeping 2026.11.12.3 admitted and no new asset", () => {
  expect(openbotRelease.version).toBe("2026.11.12.4");
  expect(openbotRelease.files.map(file => file.path)).toEqual(restorePointsRelease.files.map(file => file.path));
  const changed = openbotRelease.files.filter(file => file.sha256 !== restorePointsRelease.files.find(entry => entry.path === file.path)!.sha256)
    .map(file => file.path).sort();
  // The guest installer, box gateway, updater and the places that list agent kinds learn openbot.
  expect(changed).toEqual(["PROVENANCE.md", "README.md", "VERSION", "hivra-agent-app-update.sh", "hivra-agent-shell", "hivra-chat/server.js",
    "hivra-guest-runtime-update.sh", "hivra-install-agent.py", "hivra-provider-worker.py", "hivra-provision-on-host.sh",
    "hivra-runtime-receipt.py", "hivra-update-guest-runtime.sh", "provision-claude-code-box.sh"]);
  expect(readFileSync("provisioner/provision-claude-code-box.sh", "utf8")).toContain('if [ "$AGENT_KIND" = "openbot" ]; then');
  for (const version of ["2026.11.12.3", "2026.11.12.4"]) {
    expect(isCompatibleProxmoxProvisionerVersion(version)).toBe(true);
    expect(isCompatibleProviderVmProvisionerVersion(version)).toBe(true);
    expect(provisionerSupportsActivityTelemetry(version)).toBe(true);
  }
  // Only OpenBot needs the new release; Hermes keeps its 2026.11.12.1 minimum.
  expect(portableProvisionerSupportsCatalogRuntime("2026.11.12.3", "openbot")).toBe(false);
  expect(portableProvisionerSupportsCatalogRuntime("2026.11.12.4", "openbot")).toBe(true);
  expect(portableProvisionerSupportsCatalogRuntime("2026.11.12.1", "hermes")).toBe(true);
});

it("adds Nuphos in 2026.11.12.5, keeping 2026.11.12.4 admitted and no new asset", () => {
  expect(nuphosRelease.version).toBe("2026.11.12.5");
  expect(nuphosRelease.files.map(file => file.path)).toEqual(openbotRelease.files.map(file => file.path));
  const changed = nuphosRelease.files.filter(file => file.sha256 !== openbotRelease.files.find(entry => entry.path === file.path)!.sha256)
    .map(file => file.path).sort();
  // The guest installer, box gateway, updater and the places that list agent kinds learn nuphos.
  expect(changed).toEqual(["PROVENANCE.md", "README.md", "VERSION", "hivra-agent-app-update.sh", "hivra-agent-shell", "hivra-chat/server.js",
    "hivra-guest-runtime-update.sh", "hivra-install-agent.py", "hivra-provider-worker.py", "hivra-provision-on-host.sh",
    "hivra-runtime-receipt.py", "hivra-update-guest-runtime.sh", "provision-claude-code-box.sh"]);
  expect(readFileSync("provisioner/provision-claude-code-box.sh", "utf8")).toContain('if [ "$AGENT_KIND" = "nuphos" ]; then');
  for (const version of ["2026.11.12.4", "2026.11.12.5"]) {
    expect(isCompatibleProxmoxProvisionerVersion(version)).toBe(true);
    expect(isCompatibleProviderVmProvisionerVersion(version)).toBe(true);
    expect(provisionerSupportsActivityTelemetry(version)).toBe(true);
  }
  // Only Nuphos needs the new release; OpenBot keeps its 2026.11.12.4 minimum.
  expect(portableProvisionerSupportsCatalogRuntime("2026.11.12.4", "nuphos")).toBe(false);
  expect(portableProvisionerSupportsCatalogRuntime("2026.11.12.5", "nuphos")).toBe(true);
  expect(portableProvisionerSupportsCatalogRuntime("2026.11.12.4", "openbot")).toBe(true);
});

it("ships the host wake proxy in 2026.11.13.1 as five new host files, keeping 2026.11.12.5 admitted and every guest asset unchanged", () => {
  expect(wakeProxyRelease.version).toBe("2026.11.13.1");
  const wakeProxyFiles = ["hivra-wake-proxy.py", "hivra-wake-proxy.service", "hivra-wake-helper.service",
    "hivra-cf-template.service", "hivra-ingress.tmpfiles.conf"];
  const previous = nuphosRelease.files.map(file => file.path);
  expect(wakeProxyRelease.files.map(file => file.path).filter(file => !previous.includes(file))).toEqual(wakeProxyFiles);
  expect(previous.filter(file => !wakeProxyRelease.files.some(entry => entry.path === file))).toEqual([]);
  const changed = wakeProxyRelease.files.filter(file => previous.includes(file.path)
    && file.sha256 !== nuphosRelease.files.find(entry => entry.path === file.path)!.sha256).map(file => file.path).sort();
  // Only the documents, the version and the provider worker's release labels move.
  expect(changed).toEqual(["PROVENANCE.md", "README.md", "VERSION", "hivra-provider-worker.py"]);
  // Its tests never ship.
  expect(wakeProxyRelease.files.map(file => file.path)).not.toContain("test_hivra_wake_proxy.py");
  // The host connector keeps its token out of argv and speaks HTTP/2 to the edge.
  const connector = readFileSync("provisioner/hivra-cf-template.service", "utf8");
  expect(connector).toContain("ExecStart=/usr/local/bin/hivra-cloudflared tunnel --no-autoupdate --protocol http2 run\n");
  expect(connector).toContain("EnvironmentFile=/etc/hivra/ingress/%i.env\n");
  expect(connector).not.toMatch(/--token|TUNNEL_TOKEN=/);
  expect(provisionerSupportsWakeProxy("2026.11.13.1")).toBe(true);
  expect(provisionerSupportsWakeProxy("2026.11.12.5")).toBe(false);
  for (const version of ["2026.11.12.5", "2026.11.13.1"]) {
    expect(isCompatibleProxmoxProvisionerVersion(version)).toBe(true);
    expect(isCompatibleProviderVmProvisionerVersion(version)).toBe(true);
    expect(provisionerSupportsActivityTelemetry(version)).toBe(true);
    expect(supportsModelSettingsProvisionerVersion(version)).toBe(true);
    expect(portableProvisionerSupportsCatalogRuntime(version, "nuphos")).toBe(true);
  }
});

it("teaches the start helper about host ingress in 2026.11.13.2, keeping 2026.11.13.1 admitted and every guest asset unchanged", () => {
  expect(hostIngressStartRelease.version).toBe("2026.11.13.2");
  expect(hostIngressStartRelease.files.map(file => file.path)).toEqual(wakeProxyRelease.files.map(file => file.path));
  const changed = hostIngressStartRelease.files.filter(file => file.sha256 !== wakeProxyRelease.files.find(entry => entry.path === file.path)!.sha256)
    .map(file => file.path).sort();
  // Only the start helper, the documents, the version and the provider worker's release labels move.
  expect(changed).toEqual(["PROVENANCE.md", "README.md", "VERSION", "hivra-provider-worker.py", "hivra-start-on-host.sh"]);
  const start = readFileSync("provisioner/hivra-start-on-host.sh", "utf8");
  // A host-ingress computer never gets its guest connector restarted by a start.
  expect(start.indexOf('INGRESS_ROUTE="/etc/hivra/ingress/routes/${VMID}.json"')).toBeLessThan(start.indexOf("sudo systemctl restart hivra-cf-tunnel"));
  expect(provisionerSupportsWakeProxy("2026.11.13.2")).toBe(true);
  expect(provisionerSupportsWakeProxy("2026.11.13.1")).toBe(true);
  for (const version of ["2026.11.13.1", "2026.11.13.2"]) {
    expect(isCompatibleProxmoxProvisionerVersion(version)).toBe(true);
    expect(isCompatibleProviderVmProvisionerVersion(version)).toBe(true);
    expect(provisionerSupportsActivityTelemetry(version)).toBe(true);
    expect(supportsModelSettingsProvisionerVersion(version)).toBe(true);
    expect(portableProvisionerSupportsCatalogRuntime(version, "nuphos")).toBe(true);
  }
});

it("lets the host wake proxy call Hivra in 2026.11.13.3, keeping 2026.11.13.2 admitted and every guest asset unchanged", () => {
  expect(hostCredentialRelease.version).toBe("2026.11.13.3");
  expect(hostCredentialRelease.files.map(file => file.path)).toEqual(hostIngressStartRelease.files.map(file => file.path));
  const changed = hostCredentialRelease.files.filter(file => file.sha256 !== hostIngressStartRelease.files.find(entry => entry.path === file.path)!.sha256)
    .map(file => file.path).sort();
  // Only the wake proxy, the documents, the version and the provider worker's release labels move.
  expect(changed).toEqual(["PROVENANCE.md", "README.md", "VERSION", "hivra-provider-worker.py", "hivra-wake-proxy.py"]);
  const proxy = readFileSync("provisioner/hivra-wake-proxy.py", "utf8");
  // The root helper still has no network of its own; the forwarder sends what the helper signed.
  expect(readFileSync("provisioner/hivra-wake-helper.service", "utf8")).toContain("RestrictAddressFamilies=AF_UNIX\nIPAddressDeny=any\n");
  expect(proxy).toContain('self.credential_path = "/etc/hivra/ingress/host-credential.json"');
  expect(proxy).not.toContain("\u0000");
  expect(provisionerSupportsHostCredential("2026.11.13.3")).toBe(true);
  expect(provisionerSupportsHostCredential("2026.11.13.4")).toBe(true);
  expect(provisionerSupportsHostCredential("2026.11.13.2")).toBe(false);
  for (const version of ["2026.11.13.1", "2026.11.13.2", "2026.11.13.3"]) {
    expect(provisionerSupportsWakeProxy(version)).toBe(true);
    expect(isCompatibleProxmoxProvisionerVersion(version)).toBe(true);
    expect(isCompatibleProviderVmProvisionerVersion(version)).toBe(true);
    expect(provisionerSupportsActivityTelemetry(version)).toBe(true);
    expect(supportsModelSettingsProvisionerVersion(version)).toBe(true);
    expect(portableProvisionerSupportsCatalogRuntime(version, "nuphos")).toBe(true);
  }
});

it("teaches the host wake proxy client wakes and ships the host wake doorbell in 2026.11.13.4 as two new host files, keeping 2026.11.13.3 admitted and every guest asset unchanged", () => {
  expect(doorbellRelease.version).toBe("2026.11.13.4");
  const doorbellFiles = ["hivra-wake-doorbell.py", "hivra-wake-doorbell.service"];
  const previous = hostCredentialRelease.files.map(file => file.path);
  expect(doorbellRelease.files.map(file => file.path).filter(file => !previous.includes(file))).toEqual(doorbellFiles);
  expect(previous.filter(file => !doorbellRelease.files.some(entry => entry.path === file))).toEqual([]);
  const changed = doorbellRelease.files.filter(file => previous.includes(file.path)
    && file.sha256 !== hostCredentialRelease.files.find(entry => entry.path === file.path)!.sha256).map(file => file.path).sort();
  // The wake proxy learns client wakes and the doorbell's role; the documents, the version and the worker's labels move.
  expect(changed).toEqual(["PROVENANCE.md", "README.md", "VERSION", "hivra-provider-worker.py", "hivra-wake-proxy.py"]);
  const proxy = readFileSync("provisioner/hivra-wake-proxy.py", "utf8");
  expect(proxy).toContain('CLIENT_WAKE_DEFAULT = "ticket"');
  expect(proxy).not.toContain("\u0000");
  // The helper's unit is unchanged: the level lives in the state directory it may already write.
  expect(readFileSync("provisioner/hivra-wake-helper.service", "utf8")).toContain("-/run/hivra-ingress-state");
  // Its tests never ship.
  expect(doorbellRelease.files.map(file => file.path)).not.toContain("test_hivra_wake_doorbell.py");
  // The doorbell as 2026.11.13.4 shipped it (the file in the tree is 2026.11.13.5's).
  const doorbell = readFileSync("provisioner/hivra-wake-doorbell.py", "utf8");
  const unit = readFileSync("provisioner/hivra-wake-doorbell.service", "utf8");
  expect(doorbell).not.toContain("\u0000");
  expect(doorbellRelease.files.find(file => file.path === "hivra-wake-doorbell.py")!.sha256)
    .not.toBe(release.files.find(file => file.path === "hivra-wake-doorbell.py")!.sha256);
  // Its own unprivileged user, no capabilities; it reaches the helper only through the wake proxy's group.
  expect(unit).toContain("User=hivra-doorbell\n");
  expect(unit).toContain("SupplementaryGroups=hivra-ingress\n");
  expect(unit).toContain("CapabilityBoundingSet=\nAmbientCapabilities=\nNoNewPrivileges=yes\n");
  // Read-only IMAP: the command allowlist has nothing that changes a mailbox.
  const allowed = /ALLOWED_COMMANDS = frozenset\(\(([^)]*)\)\)/.exec(doorbell)?.[1] ?? "";
  for (const verb of ["SELECT", "STORE", "EXPUNGE", "COPY", "MOVE", "APPEND", "DELETE", "CLOSE"]) expect(allowed).not.toContain(`"${verb}"`);
  expect(allowed).toContain('"EXAMINE"');
  // The helper lets the doorbell's user ask for a wake and read health, nothing more.
  expect(proxy).toContain('DOORBELL_COMMANDS = frozenset(("health", "request"))');
  expect(provisionerSupportsWakeDoorbell("2026.11.13.4")).toBe(true);
  expect(provisionerSupportsWakeDoorbell("2026.11.13.3")).toBe(false);
  for (const version of ["2026.11.13.3", "2026.11.13.4"]) {
    expect(provisionerSupportsHostCredential(version)).toBe(true);
    expect(provisionerSupportsWakeProxy(version)).toBe(true);
    expect(isCompatibleProxmoxProvisionerVersion(version)).toBe(true);
    expect(isCompatibleProviderVmProvisionerVersion(version)).toBe(true);
    expect(provisionerSupportsActivityTelemetry(version)).toBe(true);
    expect(supportsModelSettingsProvisionerVersion(version)).toBe(true);
    expect(portableProvisionerSupportsCatalogRuntime(version, "nuphos")).toBe(true);
  }
});

it("teaches the host wake doorbell Discord in 2026.11.13.5, changing only the doorbell, keeping 2026.11.13.4 admitted and every guest asset unchanged", () => {
  expect(release.version).toBe("2026.11.13.5");
  expect(release.files.map(file => file.path)).toEqual(doorbellRelease.files.map(file => file.path));
  const changed = release.files.filter(file => file.sha256 !== doorbellRelease.files.find(entry => entry.path === file.path)!.sha256)
    .map(file => file.path).sort();
  // Only the doorbell, the documents, the version and the provider worker's release labels move; its unit and the wake proxy do not.
  expect(changed).toEqual(["PROVENANCE.md", "README.md", "VERSION", "hivra-provider-worker.py", "hivra-wake-doorbell.py"]);
  expect(release.files.map(file => file.path)).not.toContain("test_hivra_wake_doorbell_discord.py");
  const doorbell = readFileSync("provisioner/hivra-wake-doorbell.py", "utf8");
  expect(doorbell).not.toContain("\u0000");
  // Its own gateway session never asks for message content (1 << 15) and never posts a message.
  expect(doorbell).toContain("DISCORD_INTENTS = (1 << 0) | (1 << 9) | (1 << 12)");
  expect(doorbell).not.toContain("1 << 15");
  expect(doorbell).not.toContain("/messages");
  expect(doorbell).toContain('"/channels/%s/typing"');
  // Discord's public endpoints only; nothing host-specific.
  expect(doorbell).toContain('DISCORD_REST_BASE = "https://discord.com/api/v10"');
  // Email stays read-only.
  const allowed = /ALLOWED_COMMANDS = frozenset\(\(([^)]*)\)\)/.exec(doorbell)?.[1] ?? "";
  for (const verb of ["SELECT", "STORE", "EXPUNGE"]) expect(allowed).not.toContain(`"${verb}"`);
  expect(provisionerSupportsWakeDoorbell("2026.11.13.4")).toBe(true);
  expect(provisionerSupportsWakeDoorbell("2026.11.13.5")).toBe(true);
  for (const version of ["2026.11.13.4", "2026.11.13.5"]) {
    expect(provisionerSupportsHostCredential(version)).toBe(true);
    expect(provisionerSupportsWakeProxy(version)).toBe(true);
    expect(isCompatibleProxmoxProvisionerVersion(version)).toBe(true);
    expect(isCompatibleProviderVmProvisionerVersion(version)).toBe(true);
    expect(provisionerSupportsActivityTelemetry(version)).toBe(true);
    expect(supportsModelSettingsProvisionerVersion(version)).toBe(true);
    expect(portableProvisionerSupportsCatalogRuntime(version, "nuphos")).toBe(true);
  }
});

it("keeps each runtime's placement minimum where it was when the browser fix ships", () => {
  // The fix reaches browser-enabled computers through the runtime update, so no runtime needs the new release.
  expect(portableProvisionerSupportsCatalogRuntime("2026.11.10.5", "deepseek-harness")).toBe(true);
  for (const version of ["2026.11.10.4", "2026.11.10.5", "2026.11.11.1", "2026.11.11.2", "2026.11.11.3", "2026.11.11.4", "2026.11.11.5", "2026.11.11.6", "2026.11.11.7", "2026.11.12.1", "2026.11.12.2", "2026.11.12.3", "2026.11.12.4", "2026.11.12.5", "2026.11.13.1", "2026.11.13.2", "2026.11.13.3", "2026.11.13.4", "2026.11.13.5"]) expect(portableProvisionerSupportsCatalogRuntime(version, "linux-server")).toBe(true);
});

it("keeps the current bundle inside the file count the provider worker accepts in a manifest", () => {
  // A bundle one file over the cap is rejected before any computer is touched, which
  // otherwise only shows in the Python-parser tests; say so here first.
  const worker = readFileSync(path.join(process.cwd(), "provisioner/hivra-provider-worker.py"), "utf8");
  const cap = Number(/not 1 <= len\(manifest\) <= ([0-9]+):/.exec(worker)?.[1]);
  expect(cap).toBeGreaterThan(0);
  expect(release.files.length).toBeLessThanOrEqual(cap);
  expect(PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES.length).toBe(release.files.length);
});
