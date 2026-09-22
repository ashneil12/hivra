import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import release from "../../../../provisioner-releases/2026.09.21.1.json";
import providerRelease from "../../../../provisioner-releases/2026.09.08.3.json";
import {
  PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES,
  PORTABLE_HIVRA_PROVISIONER_VERSION,
  PORTABLE_HIVRA_PROVIDER_VM_PROVISIONER_VERSION,
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

it.each(["2026.09.05.5", "2026.09.05.6", "2026.09.05.7", "2026.09.05.8", "2026.09.05.9", "2026.09.05.10", "2026.09.06.1", "2026.09.06.2", "2026.09.06.3", "2026.09.06.4", "2026.09.07.1", "2026.09.08.1", "2026.09.08.2"])("retains predecessor %s across lifecycle, desktop, provider and model-settings gates", version => {
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

it("advertises Windows installation only from the new signed host release", () => {
  expect(provisionerSupportsWindowsInstaller(PORTABLE_HIVRA_PROVISIONER_VERSION)).toBe(true);
  for (const version of ["2026.09.08.2", "2026.09.08.3", "2026.09.07.1"])
    expect(provisionerSupportsWindowsInstaller(version)).toBe(false);
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
