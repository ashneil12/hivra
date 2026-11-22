import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import release from "../../../../provisioner-releases/2026.11.15.1.json";
import stateImportRelease from "../../../../provisioner-releases/2026.11.15.2.json";
import resilienceRelease from "../../../../provisioner-releases/2026.11.15.3.json";
import lockFdRelease from "../../../../provisioner-releases/2026.11.15.5.json";
import watchdogRelease from "../../../../provisioner-releases/2026.11.15.6.json";
import openclawAeonRelease from "../../../../provisioner-releases/2026.11.17.4.json";
import tgApplyHardeningRelease from "../../../../provisioner-releases/2026.11.17.5.json";
import agentZeroPresetRelease from "../../../../provisioner-releases/2026.11.17.6.json";
import openclawBasePathRelease from "../../../../provisioner-releases/2026.11.17.7.json";
import openclawReadinessRelease from "../../../../provisioner-releases/2026.11.17.8.json";
import installReasonRelease from "../../../../provisioner-releases/2026.11.17.9.json";
import veniceChatRelease from "../../../../provisioner-releases/2026.11.18.1.json";
import emptyModeRelease from "../../../../provisioner-releases/2026.11.18.2.json";
import snapFreeBootRelease from "../../../../provisioner-releases/2026.11.18.3.json";
import noBootUpgradeRelease from "../../../../provisioner-releases/2026.11.18.4.json";
import directSigninRelease from "../../../../provisioner-releases/2026.11.21.1.json";
import staleFailedUnitRelease from "../../../../provisioner-releases/2026.11.22.3.json";
import catalogStackRuntimeRelease from "../../../../provisioner-releases/2026.11.20.5.json";
import cliSetupContractRelease from "../../../../provisioner-releases/2026.11.20.4.json";
import universalCatalogHardenedRelease from "../../../../provisioner-releases/2026.11.20.3.json";
import universalCatalogRelease from "../../../../provisioner-releases/2026.11.20.2.json";
import cliTransportRelease from "../../../../provisioner-releases/2026.11.20.1.json";
import xpraBrowserRelease from "../../../../provisioner-releases/2026.11.19.1.json";
import cliConnectorRelease from "../../../../provisioner-releases/2026.11.18.5.json";
import agentZeroSettingsRelease from "../../../../provisioner-releases/2026.11.17.3.json";
import backgroundReadsRelease from "../../../../provisioner-releases/2026.11.17.2.json";
import latestAgentsRelease from "../../../../provisioner-releases/2026.11.17.1.json";
import usrPluginsRelease from "../../../../provisioner-releases/2026.11.15.7.json";
import connectGrantsRelease from "../../../../provisioner-releases/2026.11.14.1.json";
import wakeHardeningRelease from "../../../../provisioner-releases/2026.11.13.6.json";
import discordRelease from "../../../../provisioner-releases/2026.11.13.5.json";
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


it("ships the direct sign-in gateway in 2026.11.21.1, keeping 2026.11.20.5 admitted and no new asset", () => {
  expect(directSigninRelease.files.map(file => file.path)).toEqual(catalogStackRuntimeRelease.files.map(file => file.path));
  const changed = directSigninRelease.files.filter(file => file.sha256 !== catalogStackRuntimeRelease.files.find(entry => entry.path === file.path)!.sha256)
    .map(file => file.path).sort();
  // Only the box gateway, the worker's release labels and the release documents change.
  expect(changed).toEqual(["PROVENANCE.md", "VERSION", "hivra-chat/server.js", "hivra-provider-worker.py"]);
  const gateway = readFileSync("provisioner/hivra-chat/server.js", "utf8");
  expect(gateway).toContain("/api/signin-password");
  expect(gateway).toContain("handleLoginPage");
  expect(catalogStackRuntimeRelease.version).toBe("2026.11.20.5");
  for (const version of ["2026.11.20.5", "2026.11.21.1"]) {
    expect(isCompatibleProxmoxProvisionerVersion(version)).toBe(true);
    expect(isCompatibleProviderVmProvisionerVersion(version)).toBe(true);
    expect(provisionerSupportsActivityTelemetry(version)).toBe(true);
    expect(supportsModelSettingsProvisionerVersion(version)).toBe(true);
  }
});

it("binds every reviewed portable provisioner asset to the immutable current release", () => {
  expect(staleFailedUnitRelease.schema).toBe(1);
  expect(staleFailedUnitRelease.version).toBe(PORTABLE_HIVRA_PROVISIONER_VERSION);
  expect(staleFailedUnitRelease.files.map(file => file.path)).toEqual([...PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES]);
  for (const file of staleFailedUnitRelease.files) {
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
    // The CLI pin file left the bundle in 2026.11.17.1; the helpers stay.
    if (file !== "agent-cli-versions.json") expect(PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES).toContain(file);
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
    "20261103120000_provider_release_admission_2026_11_03_1.sql", "20261110120000_provider_release_admission_2026_11_10_1.sql", "20261110180000_provider_release_admission_2026_11_10_2.sql", "20261110200000_provider_release_admission_2026_11_10_3.sql", "20261110220000_provider_release_admission_2026_11_10_4.sql", "20261111160000_provider_release_admission_2026_11_10_5.sql", "20261111180000_provider_release_admission_2026_11_11_1.sql", "20261111200000_provider_release_admission_2026_11_11_2.sql", "20261111220000_provider_release_admission_2026_11_11_3.sql", "20261111233000_provider_release_admission_2026_11_11_4.sql", "20261112100000_provider_release_admission_2026_11_11_5.sql", "20261112120000_provider_release_admission_2026_11_11_6.sql", "20261112160000_provider_release_admission_2026_11_11_7.sql", "20261112170000_provider_release_admission_2026_11_12_1.sql", "20261112180000_provider_release_admission_2026_11_12_2.sql", "20261112190000_provider_release_admission_2026_11_12_3.sql", "20261112210000_provider_release_admission_2026_11_12_4.sql", "20261113091000_provider_release_admission_2026_11_12_5.sql", "20261113103000_provider_release_admission_2026_11_13_1.sql", "20261113111000_provider_release_admission_2026_11_13_2.sql", "20261113121000_provider_release_admission_2026_11_13_3.sql", "20261113130000_provider_release_admission_2026_11_13_4.sql", "20261113140000_provider_release_admission_2026_11_13_5.sql", "20261113150000_provider_release_admission_2026_11_13_6.sql", "20261114120000_provider_release_admission_2026_11_14_1.sql", "20261115120000_provider_release_admission_2026_11_15_1.sql", "20261115130000_provider_release_admission_2026_11_15_2.sql", "20261115140000_provider_release_admission_2026_11_15_3.sql", "20261115150000_provider_release_admission_2026_11_15_5.sql", "20261116010000_provider_release_admission_2026_11_15_6.sql", "20261116020000_provider_release_admission_2026_11_15_7.sql",
    "20261116030000_provider_release_admission_2026_11_15_7_resealed.sql", "20261116040000_provider_release_admission_2026_11_15_7_resealed_2.sql", "20261117120000_provider_release_admission_2026_11_17_1.sql", "20261117130000_provider_release_admission_2026_11_17_2.sql", "20261117140000_provider_release_admission_2026_11_17_3.sql", "20261117160000_provider_release_admission_2026_11_17_4.sql", "20261117200000_provider_release_admission_2026_11_17_5.sql", "20261117230000_provider_release_admission_2026_11_17_6.sql", "20261118060000_provider_release_admission_2026_11_17_7.sql", "20261118070000_provider_release_admission_2026_11_17_8.sql", "20261118080000_provider_release_admission_2026_11_17_9.sql", "20261118090000_provider_release_admission_2026_11_18_1.sql", "20261118150000_provider_release_admission_2026_11_18_2.sql", "20261118160000_provider_release_admission_2026_11_18_3.sql", "20261118170000_provider_release_admission_2026_11_18_4.sql", "20261118230000_provider_release_admission_2026_11_18_5.sql", "20261119151000_provider_release_admission_2026_11_19_1.sql", "20261120140000_provider_release_admission_2026_11_20_1.sql", "20261120161000_provider_release_admission_2026_11_20_2.sql", "20261120162000_provider_release_admission_2026_11_20_3.sql", "20261120163000_provider_release_admission_2026_11_20_4.sql", "20261121100000_provider_release_admission_2026_11_20_5.sql", "20261121170000_provider_release_admission_2026_11_21_1.sql", "20261122004000_provider_release_admission_2026_11_22_1.sql", "20261122162000_provider_release_admission_2026_11_22_2.sql", "20261123000000_provider_release_admission_2026_11_22_3.sql"]
    .map(name => readFileSync(`supabase/migrations/${name}`, "utf8")).join("\n");
  for (const version of ["2026.09.15.1", "2026.09.15.2", "2026.09.21.1", "2026.09.22.1", "2026.09.22.2", "2026.09.24.1", "2026.09.24.2", "2026.09.24.3", "2026.09.24.4", "2026.10.07.1", "2026.10.20.1", "2026.10.20.2", "2026.11.03.1", "2026.11.10.1", "2026.11.10.2", "2026.11.10.3", "2026.11.10.4", "2026.11.10.5", "2026.11.11.1", "2026.11.11.2", "2026.11.11.3", "2026.11.11.4", "2026.11.11.5", "2026.11.11.6", "2026.11.11.7", "2026.11.12.1", "2026.11.12.2", "2026.11.12.3", "2026.11.12.4", "2026.11.12.5", "2026.11.13.1", "2026.11.13.2", "2026.11.13.3", "2026.11.13.4", "2026.11.13.5", "2026.11.13.6", "2026.11.14.1", "2026.11.15.1", "2026.11.15.2", "2026.11.15.3", "2026.11.15.5", "2026.11.15.6", "2026.11.15.7", "2026.11.17.1", PORTABLE_HIVRA_PROVIDER_VM_PROVISIONER_VERSION]) {
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
    // The app pin file left the bundle in 2026.11.17.1; the updater stays.
    if (file !== "agent-app-versions.json") expect(PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES).toContain(file);
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
  expect(discordRelease.version).toBe("2026.11.13.5");
  expect(discordRelease.files.map(file => file.path)).toEqual(doorbellRelease.files.map(file => file.path));
  const changed = discordRelease.files.filter(file => file.sha256 !== doorbellRelease.files.find(entry => entry.path === file.path)!.sha256)
    .map(file => file.path).sort();
  // Only the doorbell, the documents, the version and the provider worker's release labels move; its unit and the wake proxy do not.
  expect(changed).toEqual(["PROVENANCE.md", "README.md", "VERSION", "hivra-provider-worker.py", "hivra-wake-doorbell.py"]);
  expect(discordRelease.files.map(file => file.path)).not.toContain("test_hivra_wake_doorbell_discord.py");
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

it("hardens the host wake proxy, the doorbell and their units in 2026.11.13.6, keeping 2026.11.13.5 admitted, the file count and every guest asset unchanged", () => {
  expect(wakeHardeningRelease.version).toBe("2026.11.13.6");
  // No file added: the bundle stays at the provider worker's file cap (the pins unit is written by the install step).
  expect(wakeHardeningRelease.files.map(file => file.path)).toEqual(discordRelease.files.map(file => file.path));
  const changed = wakeHardeningRelease.files.filter(file => file.sha256 !== discordRelease.files.find(entry => entry.path === file.path)!.sha256)
    .map(file => file.path).sort();
  expect(changed).toEqual([
    "PROVENANCE.md", "README.md", "VERSION", "hivra-cf-template.service", "hivra-provider-worker.py",
    "hivra-wake-doorbell.py", "hivra-wake-doorbell.service", "hivra-wake-helper.service", "hivra-wake-proxy.py", "hivra-wake-proxy.service",
  ]);
  for (const name of ["test_hivra_wake_proxy.py", "test_hivra_wake_doorbell.py", "test_hivra_wake_doorbell_discord.py"]) {
    expect(wakeHardeningRelease.files.map(file => file.path)).not.toContain(name);
  }
  // Every daemon keeps restarting: none is ever left failed by systemd's start limit.
  for (const unit of ["hivra-wake-proxy.service", "hivra-wake-helper.service", "hivra-wake-doorbell.service", "hivra-cf-template.service"]) {
    const text = readFileSync(`provisioner/${unit}`, "utf8");
    const unitSection = text.slice(text.indexOf("[Unit]"), text.indexOf("[Service]"));
    expect(unitSection).toContain("\nStartLimitIntervalSec=0\n");
    expect(text).toContain("Restart=always");
  }
  expect(readFileSync("provisioner/hivra-wake-doorbell.service", "utf8")).toContain("TasksMax=64\n");
  // The pins go back before the proxy and every host connector.
  expect(readFileSync("provisioner/hivra-wake-proxy.service", "utf8")).toMatch(/^After=.*hivra-ingress-pins\.service/m);
  expect(readFileSync("provisioner/hivra-cf-template.service", "utf8")).toMatch(/^After=.*hivra-ingress-pins\.service/m);
  const proxy = readFileSync("provisioner/hivra-wake-proxy.py", "utf8");
  expect(proxy).not.toContain("\u0000");
  // The internet-facing forwarder can never ask Hivra for a wake by itself.
  expect(/FORWARDER_COMMANDS = frozenset\(\(([^)]*)\)\)/.exec(proxy)?.[1]).not.toContain('"request"');
  expect(proxy).toContain('if mode == "apply-pins":');
  const doorbell = readFileSync("provisioner/hivra-wake-doorbell.py", "utf8");
  expect(doorbell).not.toContain("\u0000");
  expect(doorbell).toContain("address.is_global");
  expect(provisionerSupportsWakeDoorbell("2026.11.13.6")).toBe(true);
  for (const version of ["2026.11.13.5", "2026.11.13.6"]) {
    expect(provisionerSupportsHostCredential(version)).toBe(true);
    expect(provisionerSupportsWakeProxy(version)).toBe(true);
    expect(isCompatibleProxmoxProvisionerVersion(version)).toBe(true);
    expect(isCompatibleProviderVmProvisionerVersion(version)).toBe(true);
    expect(provisionerSupportsActivityTelemetry(version)).toBe(true);
    expect(supportsModelSettingsProvisionerVersion(version)).toBe(true);
    expect(portableProvisionerSupportsCatalogRuntime(version, "nuphos")).toBe(true);
  }
});


it("ships the Agent Zero splash-layout entry fallback in 2026.11.15.1, keeping 2026.11.14.1 admitted and no new asset", () => {
  expect(release.version).toBe("2026.11.15.1");
  expect(release.files.map(file => file.path)).toEqual(connectGrantsRelease.files.map(file => file.path));
  const changed = release.files.filter(file => file.sha256 !== connectGrantsRelease.files.find(entry => entry.path === file.path)!.sha256)

    .map(file => file.path).sort();
  // Only the box gateway, the worker's release labels and the release documents change.
  expect(changed).toEqual(["PROVENANCE.md", "README.md", "VERSION", "hivra-chat/server.js", "hivra-provider-worker.py"]);
  const gateway = readFileSync("provisioner/hivra-chat/server.js", "utf8");
  // The entry document falls back to the canonical paths newer versions expose;
  // the splash bootstrap itself is never served, and /ui/index returns to the mount.
  expect(gateway).toContain("entryCandidates");
  expect(gateway).toContain('"/ui/index"');
  for (const version of ["2026.11.14.1", "2026.11.15.1"]) {
    expect(provisionerSupportsHostCredential(version)).toBe(true);
    expect(provisionerSupportsWakeProxy(version)).toBe(true);
    expect(provisionerSupportsWakeDoorbell(version)).toBe(true);
    expect(isCompatibleProxmoxProvisionerVersion(version)).toBe(true);
    expect(isCompatibleProviderVmProvisionerVersion(version)).toBe(true);
    expect(provisionerSupportsActivityTelemetry(version)).toBe(true);
    expect(supportsModelSettingsProvisionerVersion(version)).toBe(true);
    expect(portableProvisionerSupportsCatalogRuntime(version, "nuphos")).toBe(true);
  }
});

it("ships the box state import in 2026.11.15.2, keeping 2026.11.15.1 admitted", () => {
  expect(stateImportRelease.version).toBe("2026.11.15.2");
  const added = stateImportRelease.files.map(file => file.path).filter(file => !release.files.some(entry => entry.path === file));
  expect(added).toEqual(["hivra-chat/import-state.cjs"]);
  const changed = stateImportRelease.files.filter(file => release.files.some(entry => entry.path === file.path)
      && file.sha256 !== release.files.find(entry => entry.path === file.path)!.sha256)
    .map(file => file.path).sort();
  // Only the box gateway, the worker's release labels and the release documents change.
  expect(changed).toEqual(["PROVENANCE.md", "README.md", "VERSION", "hivra-chat/server.js",
      "hivra-guest-runtime-update.sh", "hivra-provider-worker.py", "hivra-runtime-receipt.py",
      "hivra-update-guest-runtime.sh", "provision-claude-code-box.sh"]);
  const gateway = readFileSync("provisioner/hivra-chat/server.js", "utf8");
  // Transfer tokens are management-bearer minted; the scoped token only opens /api/import.
  expect(gateway).toContain('"/api/import/token"');
  expect(gateway).toContain('"/api/import"');
  for (const version of ["2026.11.15.1", "2026.11.15.2"]) {
    expect(provisionerSupportsHostCredential(version)).toBe(true);
    expect(provisionerSupportsWakeProxy(version)).toBe(true);
    expect(provisionerSupportsWakeDoorbell(version)).toBe(true);
    expect(isCompatibleProxmoxProvisionerVersion(version)).toBe(true);
    expect(isCompatibleProviderVmProvisionerVersion(version)).toBe(true);
    expect(provisionerSupportsActivityTelemetry(version)).toBe(true);
    expect(supportsModelSettingsProvisionerVersion(version)).toBe(true);
    expect(portableProvisionerSupportsCatalogRuntime(version, "nuphos")).toBe(true);
  }
});

it("ships the agent-app update hold in 2026.11.15.3, keeping 2026.11.15.2 admitted and no new asset", () => {
  expect(resilienceRelease.version).toBe("2026.11.15.3");
  expect(resilienceRelease.files.map(file => file.path)).toEqual(stateImportRelease.files.map(file => file.path));
  const changed = resilienceRelease.files.filter(file => file.sha256 !== stateImportRelease.files.find(entry => entry.path === file.path)!.sha256)
    .map(file => file.path).sort();
  // Only the box gateway, the worker's release labels and the release documents change.
  expect(changed).toEqual(["PROVENANCE.md", "README.md", "VERSION", "hivra-chat/server.js", "hivra-provider-worker.py"]);
  const gateway = readFileSync("provisioner/hivra-chat/server.js", "utf8");
  // An unreachable agent-app port answers the update hold, not a dead 502; the
  // check keys off the AGENT_APP table so every kind gets it.
  expect(gateway).toContain("agentAppHoldPage");
  expect(gateway).toContain("isAgentAppPort");
  for (const version of ["2026.11.15.2", "2026.11.15.3"]) {
    expect(provisionerSupportsHostCredential(version)).toBe(true);
    expect(provisionerSupportsWakeProxy(version)).toBe(true);
    expect(provisionerSupportsWakeDoorbell(version)).toBe(true);
    expect(isCompatibleProxmoxProvisionerVersion(version)).toBe(true);
    expect(isCompatibleProviderVmProvisionerVersion(version)).toBe(true);
    expect(provisionerSupportsActivityTelemetry(version)).toBe(true);
    expect(supportsModelSettingsProvisionerVersion(version)).toBe(true);
    expect(portableProvisionerSupportsCatalogRuntime(version, "nuphos")).toBe(true);
  }
});

it("ships the surface watchdog, browserless keeper cleanup and real-path readiness in 2026.11.15.6, keeping 2026.11.15.5 admitted", () => {
  expect(watchdogRelease.version).toBe("2026.11.15.6");
  const added = watchdogRelease.files.map(file => file.path).filter(file => !lockFdRelease.files.some(entry => entry.path === file));
  expect(added).toEqual(["hivra-surface-watchdog.py", "hivra-surface-watchdog.service"]);
  const changed = watchdogRelease.files.filter(file => lockFdRelease.files.some(entry => entry.path === file.path)
      && file.sha256 !== lockFdRelease.files.find(entry => entry.path === file.path)!.sha256)
    .map(file => file.path).sort();
  // The watchdog assets are additive; the changed files are the gateway, the
  // update/provision scripts that install it and clean up bux-browser-keeper,
  // the worker's release labels and the release documents.
  expect(changed).toEqual(["PROVENANCE.md", "README.md", "VERSION", "hivra-chat/server.js",
      "hivra-guest-runtime-update.sh", "hivra-provider-worker.py", "hivra-update-guest-runtime.sh",
      "provision-claude-code-box.sh"]);
  const gateway = readFileSync("provisioner/hivra-chat/server.js", "utf8");
  // Receipts are served at the bounded allow-listed route, never raw state.
  expect(gateway).toContain('"/api/surface-watchdog"');
  expect(gateway).toContain("SURFACE_WATCHDOG_DIR");
  // Legacy bux-browser-keeper.service is disabled unconditionally during provision
  // (before the WANT_BROWSER=1 branch) and on non-claude runtime updates so
  // browserless kinds do not leave it crash-looping.
  const installer = readFileSync("provisioner/provision-claude-code-box.sh", "utf8");
  expect(installer.indexOf("bux-browser-keeper.service")).toBeLessThan(installer.indexOf('if [ "$WANT_BROWSER" = 1 ]; then\n\n  # Drop in the local keeper'));
  const guestUpdater = readFileSync("provisioner/hivra-guest-runtime-update.sh", "utf8");
  expect(guestUpdater).toContain('if [ "${KIND_BEFORE:-}" != claude ]');
  expect(guestUpdater).toContain("bux-browser-keeper.service");
  for (const version of ["2026.11.15.5", "2026.11.15.6"]) {
    expect(provisionerSupportsHostCredential(version)).toBe(true);
    expect(provisionerSupportsWakeProxy(version)).toBe(true);
    expect(provisionerSupportsWakeDoorbell(version)).toBe(true);
    expect(isCompatibleProxmoxProvisionerVersion(version)).toBe(true);
    expect(isCompatibleProviderVmProvisionerVersion(version)).toBe(true);
    expect(provisionerSupportsActivityTelemetry(version)).toBe(true);
    expect(supportsModelSettingsProvisionerVersion(version)).toBe(true);
    expect(portableProvisionerSupportsCatalogRuntime(version, "nuphos")).toBe(true);
  }
});

it("serves Agent Zero plugin web UI imports and pins v2.15 in 2026.11.15.7, keeping 2026.11.15.6 admitted", () => {
  expect(usrPluginsRelease.version).toBe("2026.11.15.7");
  const added = usrPluginsRelease.files.map(file => file.path).filter(file => !watchdogRelease.files.some(entry => entry.path === file));
  expect(added).toEqual([]);
  const changed = usrPluginsRelease.files.filter(file => watchdogRelease.files.some(entry => entry.path === file.path)
      && file.sha256 !== watchdogRelease.files.find(entry => entry.path === file.path)!.sha256)
    .map(file => file.path).sort();
  // Only the gateway, the watchdog probe proof, the runtime updater's
  // watchdog restart + key, the installer's marker strip, provision's key,
  // the app pin file, the worker's release labels and the release documents
  // change.
  expect(changed).toEqual(["PROVENANCE.md", "README.md", "VERSION", "agent-app-versions.json",
      "hivra-chat/server.js", "hivra-guest-runtime-update.sh", "hivra-install-agent.py",
      "hivra-provider-worker.py", "hivra-surface-watchdog.py", "provision-claude-code-box.sh"]);
  const watchdog = readFileSync("provisioner/hivra-surface-watchdog.py", "utf8");
  // The probe marks itself so the gateway does not count it as app use.
  expect(watchdog).toContain("X-Hivra-Surface-Watchdog");
  // The shared key is staged inside a root-owned sibling directory and
  // published by atomic rename — a bux-planted symlink at any predictable
  // sibling path can never redirect the root-run writer.
  for (const file of ["hivra-guest-runtime-update.sh", "provision-claude-code-box.sh"]) {
    const source = readFileSync(`provisioner/${file}`, "utf8");
    expect(source).toContain(".watchdog-key-stage");
    expect(source).toMatch(/mv -f -- "\$KEY_STAGE" /);
    expect(source).not.toContain("surface-watchdog-key.next");
  }
  const installer = readFileSync("provisioner/hivra-install-agent.py", "utf8");
  // Boxes provisioned before the marker strip keep a generated Caddyfile
  // that differs from today's bytes; it migrates atomically rather than
  // failing re-enrollment with explicit repair required.
  expect(installer).toContain("legacy_direct_config");
  expect(installer).toContain("replace_exact(DIRECT_CONFIG_FILE");
  const gateway = readFileSync("provisioner/hivra-chat/server.js", "utf8");
  // Plugin web UI module imports under /usr/plugins pass the no-Referer allowlist.
  expect(gateway).toContain("usr/plugins");
  // The v2.15 pin file itself left the bundle in 2026.11.17.1 (no pins).
  for (const version of ["2026.11.15.6", "2026.11.15.7"]) {
    expect(provisionerSupportsHostCredential(version)).toBe(true);
    expect(provisionerSupportsWakeProxy(version)).toBe(true);
    expect(provisionerSupportsWakeDoorbell(version)).toBe(true);
    expect(isCompatibleProxmoxProvisionerVersion(version)).toBe(true);
    expect(isCompatibleProviderVmProvisionerVersion(version)).toBe(true);
    expect(provisionerSupportsActivityTelemetry(version)).toBe(true);
    expect(supportsModelSettingsProvisionerVersion(version)).toBe(true);
    expect(portableProvisionerSupportsCatalogRuntime(version, "nuphos")).toBe(true);
  }
});

it("drops the agent version pins in 2026.11.17.1, keeping 2026.11.15.7 admitted", () => {
  expect(latestAgentsRelease.version).toBe("2026.11.17.1");
  const paths = latestAgentsRelease.files.map(file => file.path);
  const removed = usrPluginsRelease.files.map(file => file.path).filter(file => !paths.includes(file));
  expect(removed).toEqual(["agent-app-versions.json", "agent-cli-versions.json"]);
  expect(paths.filter(file => !usrPluginsRelease.files.some(entry => entry.path === file))).toEqual([]);
  const changed = latestAgentsRelease.files.filter(file => file.sha256 !== usrPluginsRelease.files.find(entry => entry.path === file.path)!.sha256)
    .map(file => file.path).sort();
  // Only the installer, the two updaters, the runtime updater on both sides,
  // the gateway's update report, a comment in the Codex config helper, the
  // worker's release labels and the release documents change.
  expect(changed).toEqual(["PROVENANCE.md", "README.md", "VERSION", "hivra-agent-app-update.sh", "hivra-agent-cli-update.sh",
    "hivra-chat/server.js", "hivra-codex-config-pin.py", "hivra-guest-runtime-update.sh", "hivra-provider-worker.py",
    "hivra-update-guest-runtime.sh", "provision-claude-code-box.sh"]);
  // Remote-desktop assets are untouched, so the desktop bundle revision holds.
  for (const file of ["remote-desktop/install-guest.py", "remote-desktop/broker.cjs", "remote-desktop/server.cjs"]) {
    expect(latestAgentsRelease.files.find(entry => entry.path === file)!.sha256)
      .toBe(usrPluginsRelease.files.find(entry => entry.path === file)!.sha256);
  }
  for (const version of ["2026.11.15.7", "2026.11.17.1"]) {
    expect(provisionerSupportsHostCredential(version)).toBe(true);
    expect(provisionerSupportsWakeProxy(version)).toBe(true);
    expect(provisionerSupportsWakeDoorbell(version)).toBe(true);
    expect(isCompatibleProxmoxProvisionerVersion(version)).toBe(true);
    expect(isCompatibleProviderVmProvisionerVersion(version)).toBe(true);
    expect(provisionerSupportsActivityTelemetry(version)).toBe(true);
    expect(supportsModelSettingsProvisionerVersion(version)).toBe(true);
    expect(portableProvisionerSupportsCatalogRuntime(version, "nuphos")).toBe(true);
  }
});

it("keeps background reads from waking a napped computer in 2026.11.17.2, keeping 2026.11.17.1 admitted", () => {
  expect(backgroundReadsRelease.version).toBe("2026.11.17.2");
  const paths = backgroundReadsRelease.files.map(file => file.path);
  expect(latestAgentsRelease.files.map(file => file.path)).toEqual(paths);
  const changed = backgroundReadsRelease.files.filter(file => file.sha256 !== latestAgentsRelease.files.find(entry => entry.path === file.path)!.sha256)
    .map(file => file.path).sort();
  // Only the wake proxy, the worker's release labels and the release documents change.
  expect(changed).toEqual(["PROVENANCE.md", "README.md", "VERSION", "hivra-provider-worker.py", "hivra-wake-proxy.py"]);
  const proxy = readFileSync("provisioner/hivra-wake-proxy.py", "utf8");
  expect(proxy).toContain('BACKGROUND_HEADER = "x-hivra-background"');
  // Remote-desktop assets are untouched, so the desktop bundle revision holds.
  for (const file of ["remote-desktop/install-guest.py", "remote-desktop/broker.cjs", "remote-desktop/server.cjs"]) {
    expect(backgroundReadsRelease.files.find(entry => entry.path === file)!.sha256)
      .toBe(latestAgentsRelease.files.find(entry => entry.path === file)!.sha256);
  }
  for (const version of ["2026.11.17.1", "2026.11.17.2"]) {
    expect(provisionerSupportsHostCredential(version)).toBe(true);
    expect(provisionerSupportsWakeProxy(version)).toBe(true);
    expect(provisionerSupportsWakeDoorbell(version)).toBe(true);
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
  for (const version of ["2026.11.10.4", "2026.11.10.5", "2026.11.11.1", "2026.11.11.2", "2026.11.11.3", "2026.11.11.4", "2026.11.11.5", "2026.11.11.6", "2026.11.11.7", "2026.11.12.1", "2026.11.12.2", "2026.11.12.3", "2026.11.12.4", "2026.11.12.5", "2026.11.13.1", "2026.11.13.2", "2026.11.13.3", "2026.11.13.4", "2026.11.13.5", "2026.11.13.6", "2026.11.14.1", "2026.11.15.1", "2026.11.15.2", "2026.11.15.3", "2026.11.15.5", "2026.11.15.6", "2026.11.15.7", "2026.11.17.1", "2026.11.17.2"]) expect(portableProvisionerSupportsCatalogRuntime(version, "linux-server")).toBe(true);
});

it("ships the lifecycle lock fd fix in 2026.11.15.5, keeping 2026.11.15.3 admitted", () => {
  expect(lockFdRelease.version).toBe("2026.11.15.5");
  expect(lockFdRelease.files.map(file => file.path)).toEqual(resilienceRelease.files.map(file => file.path));
  const changed = lockFdRelease.files.filter(file => file.sha256 !== resilienceRelease.files.find(entry => entry.path === file.path)!.sha256)
    .map(file => file.path).sort();
  // Only the two start scripts, the worker's release labels and the release documents change.
  expect(changed).toEqual(["PROVENANCE.md", "README.md", "VERSION", "hivra-provider-worker.py", "hivra-provision-on-host.sh", "hivra-start-on-host.sh"]);
  const start = readFileSync("provisioner/hivra-start-on-host.sh", "utf8");
  const provision = readFileSync("provisioner/hivra-provision-on-host.sh", "utf8");
  // The kvm child must not inherit the shared lock fd, or the lock pins open
  // for the VM's whole lifetime.
  expect(start).toContain('qm start "$VMID" 8>&-');
  expect(provision).toContain('qm start "$VMID" 8>&-');
  for (const version of ["2026.11.15.3", "2026.11.15.5"]) {
    expect(provisionerSupportsHostCredential(version)).toBe(true);
    expect(provisionerSupportsWakeProxy(version)).toBe(true);
    expect(provisionerSupportsWakeDoorbell(version)).toBe(true);
    expect(isCompatibleProxmoxProvisionerVersion(version)).toBe(true);
    expect(isCompatibleProviderVmProvisionerVersion(version)).toBe(true);
    expect(provisionerSupportsActivityTelemetry(version)).toBe(true);
    expect(supportsModelSettingsProvisionerVersion(version)).toBe(true);
    expect(portableProvisionerSupportsCatalogRuntime(version, "nuphos")).toBe(true);
  }
});

it("seeds Agent Zero's settings where current images read them in 2026.11.17.3, keeping 2026.11.17.2 admitted", () => {
  expect(agentZeroSettingsRelease.version).toBe("2026.11.17.3");
  const paths = agentZeroSettingsRelease.files.map(file => file.path);
  expect(backgroundReadsRelease.files.map(file => file.path)).toEqual(paths);
  const changed = agentZeroSettingsRelease.files.filter(file => file.sha256 !== backgroundReadsRelease.files.find(entry => entry.path === file.path)!.sha256)
    .map(file => file.path).sort();
  // Only the guest installer, the worker's release labels and the release documents change.
  expect(changed).toEqual(["PROVENANCE.md", "README.md", "VERSION", "hivra-provider-worker.py", "provision-claude-code-box.sh"]);
  // Regression: Agent Zero v2.15+ reads only /a0/usr/.env, so a login written
  // only to the mounted /a0/.env left the box with no login and a CSRF endpoint
  // that refused the gateway; every Agent Zero launch then failed readiness.
  const box = readFileSync("provisioner/provision-claude-code-box.sh", "utf8");
  expect(box).toContain('A0_USR_ENV="${A0_ROOT}/usr/.env"');
  expect(box.indexOf('A0_USR_ENV="${A0_ROOT}/usr/.env"')).toBeLessThan(box.indexOf("cat > /etc/systemd/system/hivra-agent-zero.service"));
  for (const file of ["remote-desktop/install-guest.py", "remote-desktop/broker.cjs", "remote-desktop/server.cjs"]) {
    expect(agentZeroSettingsRelease.files.find(entry => entry.path === file)!.sha256)
      .toBe(backgroundReadsRelease.files.find(entry => entry.path === file)!.sha256);
  }
  for (const version of ["2026.11.17.2", "2026.11.17.3"]) {
    expect(provisionerSupportsHostCredential(version)).toBe(true);
    expect(provisionerSupportsWakeProxy(version)).toBe(true);
    expect(provisionerSupportsWakeDoorbell(version)).toBe(true);
    expect(isCompatibleProxmoxProvisionerVersion(version)).toBe(true);
    expect(isCompatibleProviderVmProvisionerVersion(version)).toBe(true);
    expect(provisionerSupportsActivityTelemetry(version)).toBe(true);
    expect(supportsModelSettingsProvisionerVersion(version)).toBe(true);
    expect(portableProvisionerSupportsCatalogRuntime(version, "nuphos")).toBe(true);
  }
});

it("lets OpenClaw 2026.11.5+ and current Aeon launch in 2026.11.17.4, keeping 2026.11.17.3 admitted", () => {
  expect(openclawAeonRelease.version).toBe("2026.11.17.4");
  const paths = openclawAeonRelease.files.map(file => file.path);
  expect(agentZeroSettingsRelease.files.map(file => file.path)).toEqual(paths);
  const changed = openclawAeonRelease.files.filter(file => file.sha256 !== agentZeroSettingsRelease.files.find(entry => entry.path === file.path)!.sha256)
    .map(file => file.path).sort();
  // Only the gateway, the guest installer, the app updater, the host capacity check, the worker's release labels and the documents change.
  expect(changed).toEqual(["PROVENANCE.md", "README.md", "VERSION", "hivra-agent-app-update.sh", "hivra-chat/server.js", "hivra-host-capacity-admission", "hivra-install-agent.py", "hivra-provider-worker.py", "provision-claude-code-box.sh"]);
  // Regression: OpenClaw 2026.11.5 refuses loopback traffic that carries
  // forwarded-client headers (proxy_attribution_required), so /openclaw drops them.
  const gateway = readFileSync("provisioner/hivra-chat/server.js", "utf8");
  expect(gateway).toContain("proxy_attribution_required");
  expect(gateway).toMatch(/OPENCLAW_SET_HEADERS = \{ forwarded: null, "x-forwarded-for": null/);
  // Regression: Aeon's own next.config.ts sets the bundler root its build needs,
  // so Hivra wraps it instead of replacing it, at launch and on Update.
  for (const file of ["provisioner/provision-claude-code-box.sh", "provisioner/hivra-agent-app-update.sh"]) {
    expect(readFileSync(file, "utf8")).toContain("import upstream from './next.config.hivra-upstream'");
    expect(readFileSync(file, "utf8")).not.toContain("basePath ? { basePath, assetPrefix: basePath } : {}");
  }
  for (const file of ["remote-desktop/install-guest.py", "remote-desktop/broker.cjs", "remote-desktop/server.cjs"]) {
    expect(openclawAeonRelease.files.find(entry => entry.path === file)!.sha256)
      .toBe(agentZeroSettingsRelease.files.find(entry => entry.path === file)!.sha256);
  }
  for (const version of ["2026.11.17.3", "2026.11.17.4"]) {
    expect(provisionerSupportsHostCredential(version)).toBe(true);
    expect(provisionerSupportsWakeProxy(version)).toBe(true);
    expect(provisionerSupportsWakeDoorbell(version)).toBe(true);
    expect(isCompatibleProxmoxProvisionerVersion(version)).toBe(true);
    expect(isCompatibleProviderVmProvisionerVersion(version)).toBe(true);
    expect(provisionerSupportsActivityTelemetry(version)).toBe(true);
    expect(supportsModelSettingsProvisionerVersion(version)).toBe(true);
    expect(portableProvisionerSupportsCatalogRuntime(version, "nuphos")).toBe(true);
  }
});

it("hardens hivra-tg-apply against symlink redirection in 2026.11.17.5, keeping 2026.11.17.4 admitted", () => {
  expect(tgApplyHardeningRelease.version).toBe("2026.11.17.5");
  const paths = tgApplyHardeningRelease.files.map(file => file.path);
  expect(openclawAeonRelease.files.map(file => file.path)).toEqual(paths);
  const changed = tgApplyHardeningRelease.files.filter(file => file.sha256 !== openclawAeonRelease.files.find(entry => entry.path === file.path)!.sha256)
    .map(file => file.path).sort();
  // Only hivra-tg-apply, the worker's release labels and the release documents change.
  expect(changed).toEqual(["PROVENANCE.md", "VERSION", "hivra-provider-worker.py", "hivra-tg-apply"]);
  const helper = readFileSync("provisioner/hivra-tg-apply", "utf8");
  // The secret is staged in the root-only parent dir and renamed into place, never written onto the group-writable entry.
  expect(helper).not.toContain('cat > "$TG_ENV_DIR/tg.env"');
  expect(helper).toContain('mktemp "$(dirname "$TG_ENV_DIR")/.hivra-tg.env.XXXXXX"');
  expect(helper).toContain('mv -f "$staging" "$TG_ENV_DIR/tg.env"');
  // Remote-desktop assets are untouched, so the desktop bundle revision holds.
  for (const file of ["remote-desktop/install-guest.py", "remote-desktop/broker.cjs", "remote-desktop/server.cjs"]) {
    expect(tgApplyHardeningRelease.files.find(entry => entry.path === file)!.sha256)
      .toBe(openclawAeonRelease.files.find(entry => entry.path === file)!.sha256);
  }
  for (const version of ["2026.11.17.4", "2026.11.17.5"]) {
    expect(provisionerSupportsHostCredential(version)).toBe(true);
    expect(provisionerSupportsWakeProxy(version)).toBe(true);
    expect(provisionerSupportsWakeDoorbell(version)).toBe(true);
    expect(isCompatibleProxmoxProvisionerVersion(version)).toBe(true);
    expect(isCompatibleProviderVmProvisionerVersion(version)).toBe(true);
    expect(provisionerSupportsActivityTelemetry(version)).toBe(true);
    expect(supportsModelSettingsProvisionerVersion(version)).toBe(true);
    expect(portableProvisionerSupportsCatalogRuntime(version, "nuphos")).toBe(true);
  }
});

it("seeds current Agent Zero's model preset in 2026.11.17.6, keeping 2026.11.17.5 admitted", () => {
  expect(agentZeroPresetRelease.version).toBe("2026.11.17.6");
  const paths = agentZeroPresetRelease.files.map(file => file.path);
  expect(tgApplyHardeningRelease.files.map(file => file.path)).toEqual(paths);
  const changed = agentZeroPresetRelease.files.filter(file => file.sha256 !== tgApplyHardeningRelease.files.find(entry => entry.path === file.path)!.sha256)
    .map(file => file.path).sort();
  expect(changed).toEqual(["PROVENANCE.md", "README.md", "VERSION", "deepseek-harness/install-guest.py", "hivra-provider-worker.py", "hivra-runtime-receipt.py", "provision-claude-code-box.sh"]);
  // The DeepSeek gateway gets every module server.js requires at start.
  const server = readFileSync("provisioner/hivra-chat/server.js", "utf8");
  const guest = readFileSync("provisioner/deepseek-harness/install-guest.py", "utf8");
  for (const [, name] of server.matchAll(/^const [^\n]*= require\("\.\/([^"/]+)"\);$/gm)) expect(guest).toContain(`"${name}"`);
  const script = readFileSync("provisioner/provision-claude-code-box.sh", "utf8");
  // Written only on a fresh box with a managed key, never over the owner's presets.
  expect(script).toContain('A0_PRESETS="${A0_ROOT}/usr/plugins/_model_config/presets.yaml"');
  expect(script).toContain('[ ! -e "$A0_PRESETS" ] && [ ! -L "$A0_PRESETS" ]');
  for (const file of ["remote-desktop/install-guest.py", "remote-desktop/broker.cjs", "remote-desktop/server.cjs"]) {
    expect(agentZeroPresetRelease.files.find(entry => entry.path === file)!.sha256)
      .toBe(tgApplyHardeningRelease.files.find(entry => entry.path === file)!.sha256);
  }
  for (const version of ["2026.11.17.5", "2026.11.17.6"]) {
    expect(provisionerSupportsHostCredential(version)).toBe(true);
    expect(provisionerSupportsWakeProxy(version)).toBe(true);
    expect(provisionerSupportsWakeDoorbell(version)).toBe(true);
    expect(isCompatibleProxmoxProvisionerVersion(version)).toBe(true);
    expect(isCompatibleProviderVmProvisionerVersion(version)).toBe(true);
    expect(provisionerSupportsActivityTelemetry(version)).toBe(true);
    expect(supportsModelSettingsProvisionerVersion(version)).toBe(true);
    expect(portableProvisionerSupportsCatalogRuntime(version, "agent-zero")).toBe(true);
  }
});

it("serves OpenClaw's Control UI at its own basePath in 2026.11.17.7, keeping 2026.11.17.6 admitted", () => {
  expect(openclawBasePathRelease.version).toBe("2026.11.17.7");
  const paths = openclawBasePathRelease.files.map(file => file.path);
  expect(agentZeroPresetRelease.files.map(file => file.path)).toEqual(paths);
  const changed = openclawBasePathRelease.files.filter(file => file.sha256 !== agentZeroPresetRelease.files.find(entry => entry.path === file.path)!.sha256)
    .map(file => file.path).sort();
  expect(changed).toEqual(["PROVENANCE.md", "README.md", "VERSION", "hivra-chat/server.js", "hivra-provider-worker.py", "provision-claude-code-box.sh"]);
  // A new launch names the mount as OpenClaw's own base path; the gateway keeps
  // the prefix for such a computer and strips it only for an older config.
  const script = readFileSync("provisioner/provision-claude-code-box.sh", "utf8");
  expect(script).toContain('"controlUi": { "basePath": "/openclaw", "dangerouslyAllowHostHeaderOriginFallback": true }');
  const server = readFileSync("provisioner/hivra-chat/server.js", "utf8");
  expect(server).toContain('strip: basePath === "/openclaw" ? "" : "/openclaw"');
  for (const file of ["remote-desktop/install-guest.py", "remote-desktop/broker.cjs", "remote-desktop/server.cjs"]) {
    expect(openclawBasePathRelease.files.find(entry => entry.path === file)!.sha256)
      .toBe(agentZeroPresetRelease.files.find(entry => entry.path === file)!.sha256);
  }
  for (const version of ["2026.11.17.6", "2026.11.17.7"]) {
    expect(provisionerSupportsHostCredential(version)).toBe(true);
    expect(provisionerSupportsWakeProxy(version)).toBe(true);
    expect(provisionerSupportsWakeDoorbell(version)).toBe(true);
    expect(isCompatibleProxmoxProvisionerVersion(version)).toBe(true);
    expect(isCompatibleProviderVmProvisionerVersion(version)).toBe(true);
    expect(provisionerSupportsActivityTelemetry(version)).toBe(true);
    expect(supportsModelSettingsProvisionerVersion(version)).toBe(true);
    expect(portableProvisionerSupportsCatalogRuntime(version, "openclaw")).toBe(true);
  }
});

it("checks OpenClaw's install readiness at its basePath in 2026.11.17.8, keeping 2026.11.17.7 admitted", () => {
  expect(openclawReadinessRelease.version).toBe("2026.11.17.8");
  const paths = openclawReadinessRelease.files.map(file => file.path);
  expect(openclawBasePathRelease.files.map(file => file.path)).toEqual(paths);
  const changed = openclawReadinessRelease.files.filter(file => file.sha256 !== openclawBasePathRelease.files.find(entry => entry.path === file.path)!.sha256)
    .map(file => file.path).sort();
  expect(changed).toEqual(["PROVENANCE.md", "README.md", "VERSION", "hivra-provider-worker.py", "provision-claude-code-box.sh"]);
  // With basePath=/openclaw the gateway root answers 503, so readiness asks for the base path.
  const script = readFileSync("provisioner/provision-claude-code-box.sh", "utf8");
  expect(script).toContain(`if grep -Eq '"basePath": *"/openclaw"' "\${OPENCLAW_CFG_DIR}/openclaw.json" 2>/dev/null; then OPENCLAW_UI_PATH="/openclaw/"; fi`);
  expect(script).toContain('wait_for_http "http://127.0.0.1:${OPENCLAW_PORT}${OPENCLAW_UI_PATH}" || die "OpenClaw Control UI did not become ready"');
  expect(script).not.toContain('wait_for_http "http://127.0.0.1:${OPENCLAW_PORT}/"');
  for (const version of ["2026.11.17.7", "2026.11.17.8"]) {
    expect(isCompatibleProxmoxProvisionerVersion(version)).toBe(true);
    expect(isCompatibleProviderVmProvisionerVersion(version)).toBe(true);
    expect(supportsModelSettingsProvisionerVersion(version)).toBe(true);
    expect(portableProvisionerSupportsCatalogRuntime(version, "openclaw")).toBe(true);
  }
});

it("names the provisioning step's own failure message in 2026.11.17.9, keeping 2026.11.17.8 admitted", () => {
  expect(installReasonRelease.version).toBe("2026.11.17.9");
  const paths = installReasonRelease.files.map(file => file.path);
  expect(openclawReadinessRelease.files.map(file => file.path)).toEqual(paths);
  const changed = installReasonRelease.files.filter(file => file.sha256 !== openclawReadinessRelease.files.find(entry => entry.path === file.path)!.sha256)
    .map(file => file.path).sort();
  expect(changed).toEqual(["PROVENANCE.md", "README.md", "VERSION", "hivra-install-agent.py", "hivra-provider-worker.py", "provision-claude-code-box.sh"]);
  const script = readFileSync("provisioner/provision-claude-code-box.sh", "utf8");
  expect(script).toContain(`die()  { warn "$*"; ( umask 077; printf '%s\\n' "$*" > /run/hivra-install-failure-reason ) 2>/dev/null || true; exit 1; }`);
  const installer = readFileSync("provisioner/hivra-install-agent.py", "utf8");
  // Cleared before the step runs; only short plain text reaches the host log.
  expect(installer).toContain('DIE_REASON = Path("/run/hivra-install-failure-reason")');
  expect(installer).toContain('re.fullmatch(r"[A-Za-z0-9 .,:;()_/+-]{1,200}", text)');
  for (const version of ["2026.11.17.8", "2026.11.17.9"]) {
    expect(isCompatibleProxmoxProvisionerVersion(version)).toBe(true);
    expect(isCompatibleProviderVmProvisionerVersion(version)).toBe(true);
    expect(supportsModelSettingsProvisionerVersion(version)).toBe(true);
    expect(portableProvisionerSupportsCatalogRuntime(version, "aeon")).toBe(true);
  }
});

it("keeps OpenClaw's Venice requests in Venice's schema and Aeon's newer gh in 2026.11.18.1, keeping 2026.11.17.9 admitted", () => {
  expect(veniceChatRelease.version).toBe("2026.11.18.1");
  const paths = veniceChatRelease.files.map(file => file.path);
  expect(installReasonRelease.files.map(file => file.path)).toEqual(paths);
  const changed = veniceChatRelease.files.filter(file => file.sha256 !== installReasonRelease.files.find(entry => entry.path === file.path)!.sha256)
    .map(file => file.path).sort();
  expect(changed).toEqual(["PROVENANCE.md", "README.md", "VERSION", "hivra-chat/server.js", "hivra-provider-worker.py", "provision-claude-code-box.sh"]);
  const script = readFileSync("provisioner/provision-claude-code-box.sh", "utf8");
  expect(script).toContain('"thinkingFormat\\": \\"openai\\"');
  expect(script).toContain('dpkg --compare-versions "$installed" ge "$GH_VERSION"');
  const server = readFileSync("provisioner/hivra-chat/server.js", "utf8");
  expect(server).toContain('block.models[0].compat = { thinkingFormat: "openai" }');
  for (const version of ["2026.11.17.9", "2026.11.18.1"]) {
    expect(isCompatibleProxmoxProvisionerVersion(version)).toBe(true);
    expect(isCompatibleProviderVmProvisionerVersion(version)).toBe(true);
    expect(supportsModelSettingsProvisionerVersion(version)).toBe(true);
    expect(portableProvisionerSupportsCatalogRuntime(version, "aeon")).toBe(true);
  }
});

it("adds the empty-computer mode, keeps cloud-init details on the host and seeds OpenClaw on Flash in 2026.11.18.2, keeping 2026.11.18.1 admitted", () => {
  expect(emptyModeRelease.version).toBe("2026.11.18.2");
  const paths = emptyModeRelease.files.map(file => file.path);
  expect(veniceChatRelease.files.map(file => file.path)).toEqual(paths);
  const changed = emptyModeRelease.files.filter(file => file.sha256 !== veniceChatRelease.files.find(entry => entry.path === file.path)!.sha256)
    .map(file => file.path).sort();
  expect(changed).toEqual(["PROVENANCE.md", "README.md", "VERSION", "hivra-provider-worker.py", "hivra-provision-on-host.sh", "provision-claude-code-box.sh"]);
  const host = readFileSync("provisioner/hivra-provision-on-host.sh", "utf8");
  expect(host).toContain('HIVRA_PROVISION_MODE');
  expect(host).toContain('hivra-prov-${VMID}.cloud-init.txt');
  const script = readFileSync("provisioner/provision-claude-code-box.sh", "utf8");
  expect(script).toContain('OC_MODEL="${HIVRA_HERMES_MODEL:-deepseek-v4-1-flash}"');
  for (const version of ["2026.11.18.1", "2026.11.18.2"]) {
    expect(isCompatibleProxmoxProvisionerVersion(version)).toBe(true);
    expect(isCompatibleProviderVmProvisionerVersion(version)).toBe(true);
    expect(supportsModelSettingsProvisionerVersion(version)).toBe(true);
    expect(portableProvisionerSupportsCatalogRuntime(version, "aeon")).toBe(true);
  }
});

it("installs the guest agent without cloud-init's package module in 2026.11.18.3, keeping 2026.11.18.2 admitted", () => {
  expect(snapFreeBootRelease.version).toBe("2026.11.18.3");
  const paths = snapFreeBootRelease.files.map(file => file.path);
  expect(emptyModeRelease.files.map(file => file.path)).toEqual(paths);
  const changed = snapFreeBootRelease.files.filter(file => file.sha256 !== emptyModeRelease.files.find(entry => entry.path === file.path)!.sha256)
    .map(file => file.path).sort();
  expect(changed).toEqual(["PROVENANCE.md", "README.md", "VERSION", "hivra-provider-worker.py", "hivra-provision-on-host.sh"]);
  const host = readFileSync("provisioner/hivra-provision-on-host.sh", "utf8");
  const vendor = host.slice(host.indexOf("<<'HIVRA_QGA_VENDOR_DATA'"), host.lastIndexOf("HIVRA_QGA_VENDOR_DATA"));
  expect(vendor).not.toContain("package_update");
  expect(vendor).not.toContain("packages:");
  expect(vendor).toContain("install, -y, --no-install-recommends, qemu-guest-agent]");
  expect(vendor.indexOf("qemu-guest-agent]")).toBeLessThan(vendor.indexOf("qemu-guest-agent.service"));
  for (const version of ["2026.11.18.2", "2026.11.18.3"]) {
    expect(isCompatibleProxmoxProvisionerVersion(version)).toBe(true);
    expect(isCompatibleProviderVmProvisionerVersion(version)).toBe(true);
    expect(supportsModelSettingsProvisionerVersion(version)).toBe(true);
    expect(portableProvisionerSupportsCatalogRuntime(version, "aeon")).toBe(true);
  }
});

it("turns off Proxmox's first-boot package upgrade for every VM in 2026.11.18.4, keeping 2026.11.18.3 admitted", () => {
  expect(noBootUpgradeRelease.version).toBe("2026.11.18.4");
  const paths = noBootUpgradeRelease.files.map(file => file.path);
  expect(snapFreeBootRelease.files.map(file => file.path)).toEqual(paths);
  const changed = noBootUpgradeRelease.files.filter(file => file.sha256 !== snapFreeBootRelease.files.find(entry => entry.path === file.path)!.sha256)
    .map(file => file.path).sort();
  expect(changed).toEqual(["PROVENANCE.md", "README.md", "VERSION", "hivra-provider-worker.py", "hivra-provision-on-host.sh"]);
  const host = readFileSync("provisioner/hivra-provision-on-host.sh", "utf8");
  // Both the empty and the install path set it right after the cloud-init drive.
  expect(host.split('qm set "$VMID" --ciupgrade 0').length - 1).toBe(2);
  const vendor = host.slice(host.indexOf("<<'HIVRA_QGA_VENDOR_DATA'"), host.lastIndexOf("HIVRA_QGA_VENDOR_DATA"));
  expect(vendor).not.toContain("package_update");
  expect(vendor).not.toContain("package_upgrade");
  for (const version of ["2026.11.18.3", "2026.11.18.4"]) {
    expect(isCompatibleProxmoxProvisionerVersion(version)).toBe(true);
    expect(isCompatibleProviderVmProvisionerVersion(version)).toBe(true);
    expect(supportsModelSettingsProvisionerVersion(version)).toBe(true);
    expect(portableProvisionerSupportsCatalogRuntime(version, "aeon")).toBe(true);
  }
});

it("lets the A0 CLI reach Agent Zero through the connection service in 2026.11.18.5, keeping 2026.11.18.4 admitted", () => {
  expect(cliConnectorRelease.version).toBe("2026.11.18.5");
  const paths = cliConnectorRelease.files.map(file => file.path);
  expect(noBootUpgradeRelease.files.map(file => file.path)).toEqual(paths);
  const changed = cliConnectorRelease.files.filter(file => file.sha256 !== noBootUpgradeRelease.files.find(entry => entry.path === file.path)!.sha256)
    .map(file => file.path).sort();
  expect(changed).toEqual(["PROVENANCE.md", "README.md", "VERSION", "hivra-chat/server.js", "hivra-provider-worker.py"]);
  const gateway = readFileSync("provisioner/hivra-chat/server.js", "utf8");
  expect(gateway).toContain("/api/plugins/_a0_connector/v1/capabilities");
  for (const version of ["2026.11.18.4", "2026.11.18.5"]) {
    expect(isCompatibleProxmoxProvisionerVersion(version)).toBe(true);
    expect(isCompatibleProviderVmProvisionerVersion(version)).toBe(true);
    expect(supportsModelSettingsProvisionerVersion(version)).toBe(true);
    expect(portableProvisionerSupportsCatalogRuntime(version, "aeon")).toBe(true);
  }
});

it("seals only the Agent Zero browser gateway and release metadata in 2026.11.19.1", () => {
  expect(xpraBrowserRelease.files.map(file => file.path)).toEqual(cliConnectorRelease.files.map(file => file.path));
  const changed = xpraBrowserRelease.files.filter((file, index) => file.sha256 !== cliConnectorRelease.files[index].sha256);
  expect(changed.map(file => file.path).sort()).toEqual(["PROVENANCE.md", "README.md", "VERSION", "hivra-chat/server.js", "hivra-provider-worker.py"]);
});

it("keeps the current bundle inside the file count the provider worker accepts in a manifest", () => {
  // A bundle one file over the cap is rejected before any computer is touched, which
  // otherwise only shows in the Python-parser tests; say so here first.
  const worker = readFileSync(path.join(process.cwd(), "provisioner/hivra-provider-worker.py"), "utf8");
  const cap = Number(/not 1 <= len\(manifest\) <= ([0-9]+):/.exec(worker)?.[1]);
  expect(cap).toBeGreaterThan(0);
  expect(cliSetupContractRelease.files.length).toBeLessThanOrEqual(cap);
  expect(PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES.length).toBe(cliSetupContractRelease.files.length);
});
