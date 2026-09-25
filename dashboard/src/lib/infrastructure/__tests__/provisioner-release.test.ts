import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import release from "../../../../provisioner-releases/2026.09.24.4.json";
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
  expect(release.version).toBe("2026.09.24.4");
  const updater = readFileSync(path.join(process.cwd(), "provisioner/hivra-update-guest-runtime.sh"), "utf8");
  expect(updater).toContain("terminal_idle 7681 /run/hivra-terminal/ttyd.sock && RESTART_AGENT_TTYD=1");
  const server = readFileSync(path.join(process.cwd(), "provisioner/hivra-chat/server.js"), "utf8");
  expect(server).toContain("return terminalUnitUsesSocket(port) ? { unavailable: true } : { port };");
  for (const file of ["hivra-update-guest-runtime.sh", "hivra-chat/server.js"]) {
    const current = release.files.find(entry => entry.path === file)!;
    const prior = terminalSocketsRelease.files.find(entry => entry.path === file)!;
    expect(current.sha256).not.toBe(prior.sha256);
  }
  expect(isCompatibleProxmoxProvisionerVersion("2026.09.24.3")).toBe(true);
  expect(provisionerSupportsActivityTelemetry("2026.09.24.3")).toBe(true);
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
  for (const version of ["2026.09.24.3", "2026.09.24.2", "2026.09.24.1"]) {
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
    "20260925110000_provider_release_admission_2026_09_24_4.sql"]
    .map(name => readFileSync(`supabase/migrations/${name}`, "utf8")).join("\n");
  for (const version of ["2026.09.15.1", "2026.09.15.2", "2026.09.21.1", "2026.09.22.1", "2026.09.22.2", "2026.09.24.1", "2026.09.24.2", "2026.09.24.3", PORTABLE_HIVRA_PROVIDER_VM_PROVISIONER_VERSION]) {
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
