import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildColdStorageScriptInstall,
  type ColdStorageHostScript,
} from "../cold-storage-host-scripts";

const dashboardRoot = join(__dirname, "../../../..");

function readOpsScript(name: string): string {
  return readFileSync(join(dashboardRoot, "scripts/ops", name), "utf8");
}

/**
 * Pull the base64 payload back out of the generated install shell and decode it,
 * so the assertion is on what the HOST actually receives — not on the constant.
 */
function decodeInstalledScript(name: ColdStorageHostScript): string {
  const install = buildColdStorageScriptInstall(name);
  const marker = `HERMES_${name.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;
  const match = install.match(
    new RegExp(`<<'${marker}'\\n([\\s\\S]*?)\\n${marker}\\n`)
  );
  if (!match) throw new Error(`could not extract base64 payload for ${name}`);
  return Buffer.from(match[1], "base64").toString("utf8");
}

describe("cold-storage host script self-install", () => {
  const scripts: ColdStorageHostScript[] = [
    "archive-vm-cold.sh",
    "restore-vm-cold.sh",
  ];

  // The whole point of the generated module: hosts must never run a stale copy.
  // If this fails, run: node scripts/generate-cold-storage-host-scripts.cjs
  it.each(scripts)(
    "embeds %s byte-for-byte identical to the ops script",
    (name) => {
      expect(decodeInstalledScript(name)).toBe(readOpsScript(name));
    }
  );

  it.each(scripts)("installs %s ATOMICALLY and executable", (name) => {
    const install = buildColdStorageScriptInstall(name);
    // Must land via mktemp + mv, never a direct redirect onto the live path:
    // restore-batch runs up to 20 restores concurrently and several can hit the
    // same host, and bash reads a script incrementally as it executes — an
    // in-place truncate would corrupt a concurrently-running invocation.
    expect(install).toContain(`__tmp=$(mktemp /usr/local/sbin/.${name}.XXXXXX)`);
    expect(install).toContain(`mv -f "$__tmp" /usr/local/sbin/${name}`);
    expect(install).toContain(`chmod 755 "$__tmp"`);
    expect(install).not.toMatch(
      new RegExp(`base64 -d > /usr/local/sbin/${name.replace(/\./g, "\\.")}`)
    );
    // …and must not reset /usr/local/sbin's mode (Debian ships it 2775 root:staff).
    expect(install).not.toContain("install -d");
  });

  it.each(scripts)("aborts before invoking %s if any install step fails", (name) => {
    const install = buildColdStorageScriptInstall(name);
    // Every step must carry its OWN status check. `( set -e … ) || { … }` looks
    // equivalent but is not: bash suppresses errexit inside a compound command
    // on the left of `||`, so a corrupt payload sailed straight through it,
    // clobbered the good script and still ran the invocation (verified on a
    // real host). Guard against a well-meaning refactor reintroducing that.
    expect(install).not.toContain("set -e");
    expect(install).toContain(`|| { echo "[cold-storage] mktemp failed for ${name}"`);
    expect(install).toContain(`[ $? -eq 0 ] || { rm -f "$__tmp";`);
    expect(install).toContain(`failed to decode ${name}`);
    expect(install).toContain(`failed to chmod ${name}`);
    expect(install).toContain(`failed to install ${name}`);
    // every failure path exits AND removes the temp file
    const failurePaths = install.match(/rm -f "\$__tmp"/g) ?? [];
    expect(failurePaths.length).toBe(3); // decode, chmod, mv
    expect(install.match(/exit 1/g)?.length).toBe(4); // + mktemp
  });

  it("uses a distinct heredoc marker per script so the two can't collide", () => {
    const a = buildColdStorageScriptInstall("archive-vm-cold.sh");
    const r = buildColdStorageScriptInstall("restore-vm-cold.sh");
    expect(a).toContain("HERMES_ARCHIVE_VM_COLD_SH");
    expect(r).toContain("HERMES_RESTORE_VM_COLD_SH");
  });

  it("restores an originally-stopped VM when archive execution is interrupted", () => {
    const script = readOpsScript("archive-vm-cold.sh");

    expect(script).toContain("trap cleanup EXIT HUP INT TERM");
    expect(script).toContain('if [ "$START_STATE" != "running" ]');
    expect(script).toContain('qm shutdown "$VMID" --timeout 60');
    expect(script).toContain('qm stop "$VMID"');
  });

  it("rejects a guest identity mismatch before reading data or stopping containers", () => {
    const script = readOpsScript("archive-vm-cold.sh");

    expect(script).toContain('EXPECTED_INSTANCE_ID="${2:-}"');
    expect(script).toContain('if [ "$INSTANCE_ID" != "$EXPECTED_INSTANCE_ID" ]');
    expect(script).toContain("guest identity mismatch");

    const identityGuard = script.indexOf('if [ "$INSTANCE_ID" != "$EXPECTED_INSTANCE_ID" ]');
    expect(identityGuard).toBeGreaterThan(0);
    expect(identityGuard).toBeLessThan(script.indexOf('echo "  archiving:"'));
    expect(identityGuard).toBeLessThan(script.indexOf("sudo docker stop"));
  });

  // A heredoc terminator appearing inside the payload would truncate the install
  // and write a corrupt script to the host. base64 is [A-Za-z0-9+/=] so it can
  // never contain the marker, but assert it rather than trust it.
  it.each(scripts)("payload for %s cannot terminate its own heredoc", (name) => {
    const marker = `HERMES_${name.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;
    const install = buildColdStorageScriptInstall(name);
    const payload = install.split(`<<'${marker}'\n`)[1].split(`\n${marker}\n`)[0];
    expect(payload).toMatch(/^[A-Za-z0-9+/=\n"\s+]*$/);
    expect(payload).not.toContain(marker);
  });
});

/**
 * Guest SSH from these host scripts must be pinned to the host key that QEMU
 * Guest Agent attests for the VMID, the same protection
 * buildHermesVmidBoundGuestSshPrelude gives the TypeScript callers. Checks off
 * (StrictHostKeyChecking=no, UserKnownHostsFile=/dev/null) let a neighbour or a
 * recycled IP receive the guest's secrets and the archive or restore run
 * without noticing.
 */
describe("host scripts pin guest SSH to an attested host key", () => {
  const scripts = [
    "archive-vm-cold.sh",
    "restore-vm-cold.sh",
    "backup-vm-restic.sh",
  ] as const;

  function vmidBoundBlock(script: string): string {
    const start = script.indexOf("# >>> VMID-bound guest SSH");
    const end = script.indexOf("# <<< VMID-bound guest SSH <<<");
    if (start < 0 || end < start) throw new Error("VMID-bound guest SSH block not found");
    return script.slice(start, end);
  }

  it.each(scripts)("%s never disables host-key checks", (name) => {
    const script = readOpsScript(name);
    expect(script).not.toContain("StrictHostKeyChecking=no");
    expect(script).not.toContain("UserKnownHostsFile=/dev/null");
  });

  it("carries one identical VMID-bound block in every script", () => {
    const [first, ...rest] = scripts.map((name) => vmidBoundBlock(readOpsScript(name)));
    expect(first).toContain("qm guest exec \"$VMID\" -- /bin/cat /etc/ssh/ssh_host_ed25519_key.pub");
    for (const block of rest) expect(block).toBe(first);
  });

  it.each(scripts)("%s attests the guest before its first guest connection", (name) => {
    const script = readOpsScript(name);
    const attest = script.search(/attest_guest_ssh_pin \d+/);
    const firstGuestUse = script.search(/\$\{SSH_OPTS\[@\]\}|\$SSH_OPTS\b/);
    expect(attest).toBeGreaterThan(0);
    expect(firstGuestUse).toBeGreaterThan(attest);
    expect(script).toContain("StrictHostKeyChecking=yes");
    expect(script).toContain("HostKeyAlias=");
  });

  it("refuses before any connection when the guest identity cannot be attested", () => {
    const archive = readOpsScript("archive-vm-cold.sh");
    expect(archive).toContain("attest_guest_ssh_pin 36 || { echo");
    expect(archive).toContain("exit 3; }");

    const restore = readOpsScript("restore-vm-cold.sh");
    // the clone this run just made is destroyed rather than left running unattested
    expect(restore).toMatch(/if ! attest_guest_ssh_pin 36; then[\s\S]*qm destroy "\$NEW_VMID"[\s\S]*exit 3/);

    const backup = readOpsScript("backup-vm-restic.sh");
    expect(backup).toContain("attest_guest_ssh_pin 12 || exit 10");
  });

  it("gives the restored clone a QEMU Guest Agent channel before it boots", () => {
    const restore = readOpsScript("restore-vm-cold.sh");
    expect(restore).toMatch(/--agent enabled=1[\s\S]*qm start "\$NEW_VMID"/);
  });

  it("removes the pinned known_hosts directory on every archive and restore exit", () => {
    const archive = readOpsScript("archive-vm-cold.sh");
    expect(archive).toContain("trap cleanup EXIT HUP INT TERM");
    expect(archive).toMatch(/cleanup\(\) \{[\s\S]*cleanup_hivra_guest_ssh_identity[\s\S]*\n\}/);

    const restore = readOpsScript("restore-vm-cold.sh");
    expect(restore).toContain("trap 'rm -rf \"$SCRATCH\"; cleanup_hivra_guest_ssh_identity || true' EXIT");
  });
});

/**
 * The restore host-script ceiling MUST stay under every calling route's
 * maxDuration. When it didn't (900s script vs 800s function), Vercel SIGKILLed
 * the handler mid-restore: nothing reverted, the CAS lock stayed held, and the
 * clone leaked as a running VM no DB row pointed at — the ghost-VM class that
 * had to be cleaned up by hand on 2026-07-24. That invariant was comment-only;
 * this pins it.
 */
describe("restore script timeout vs caller function budget", () => {
  const routes = [
    "src/app/api/instances/[id]/route.ts",
    "src/app/api/admin/restore-batch/route.ts",
  ];

  function readDefaultRestoreTimeoutMs(): number {
    const svc = readFileSync(
      join(dashboardRoot, "src/lib/services/cold-storage-service.ts"),
      "utf8"
    );
    const m = svc.match(
      /const DEFAULT_RESTORE_SCRIPT_TIMEOUT_MS = (\d+) \* 1000;/
    );
    if (!m) throw new Error("DEFAULT_RESTORE_SCRIPT_TIMEOUT_MS not found");
    return Number(m[1]) * 1000;
  }

  it.each(routes)("stays strictly below maxDuration in %s", (route) => {
    const src = readFileSync(join(dashboardRoot, route), "utf8");
    const m = src.match(/export const maxDuration = (\d+);/);
    if (!m) throw new Error(`maxDuration not found in ${route}`);
    const maxDurationMs = Number(m[1]) * 1000;

    expect(readDefaultRestoreTimeoutMs()).toBeLessThan(maxDurationMs);
    // and leave real room for the surrounding work (allocation, DB, DNS/Caddy)
    expect(maxDurationMs - readDefaultRestoreTimeoutMs()).toBeGreaterThanOrEqual(
      120_000
    );
  });
});
