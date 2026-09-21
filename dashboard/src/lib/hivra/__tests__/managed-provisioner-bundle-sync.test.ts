import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { managedHivraHostReadinessScript } from "@/lib/hivra/managed-provisioner-readiness";

import {
  buildManagedProvisionerBundleSyncScript,
  inspectManagedProvisionerBundle,
  syncManagedProvisionerBundle,
} from "@/lib/hivra/managed-provisioner-bundle-sync";
import {
  PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES,
  PORTABLE_HIVRA_PROVISIONER_VERSION,
} from "@/lib/infrastructure/portable-provisioner-contract";

const ORIGINAL_ENV = process.env;

function bundle() {
  return PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES.map((relativePath) => ({
    relativePath,
    content: Buffer.from(
      relativePath === "VERSION" ? `${PORTABLE_HIVRA_PROVISIONER_VERSION}\n` : `${relativePath}\n`,
    ),
  }));
}

describe("managed provisioner bundle sync", () => {
  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      HERMES_PROXMOX_TARGETS: "fixturenode12",
      PROXMOX_FIXTURENODE12_SSH_HOST: "192.0.2.12",
      PROXMOX_FIXTURENODE12_SSH_USER: "root",
      PROXMOX_FIXTURENODE12_SSH_PRIVATE_KEY_B64: "dGVzdA==",
    };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it("builds an exact checksum-verified atomic swap with rollback", () => {
    const script = buildManagedProvisionerBundleSyncScript("default", bundle(), "fixturenode12");

    expect(script).toContain("sha256sum -c --status BUNDLE.sha256");
    expect(script).toContain('move_exclusive "$TARGET" "$BACKUP_DIR"');
    expect(script).toContain("trap rollback EXIT");
    expect(script).toContain("rm -rf -- \"$TARGET\"");
    expect(script).toContain("HIVRA_MANAGED_BUNDLE_SYNC status=updated");
    expect(script).toContain(`EXPECTED_VERSION='${PORTABLE_HIVRA_PROVISIONER_VERSION}'`);
    expect(script).toContain("EXPECTED_HOSTNAME='fixturenode12'");
    expect(script).toContain("managed bundle target identity mismatch");
    expect(script).toContain("managed bundle sync changed the VM inventory");
    expect(script).toContain("managed bundle sync changed the Caddy service state");
    expect(script).toContain("HIVRA_MANAGED_HOST_PRESERVED");
    const lock = script.indexOf("exec 8>/run/lock/hivra-allocation.lock");
    expect(lock).toBeGreaterThan(script.indexOf('sha256sum -c --status BUNDLE.sha256'));
    expect(lock).toBeLessThan(script.indexOf('HOST_VM_STATE_BEFORE="$(host_vm_state)"'));
    expect(lock).toBeLessThan(script.indexOf('if [ -d "$TARGET" ]'));
    expect(lock).toBeLessThan(script.indexOf("HIVRA_HOST_READY"));
    expect(script).not.toContain('bash "$UPLOAD_DIR/prepare-proxmox-host.sh"');
    expect(script.indexOf("trap rollback EXIT")).toBeLessThan(script.indexOf('move_exclusive "$TARGET" "$BACKUP_DIR"'));
    expect(script).toContain('mv -T -n -- "$1" "$2"');
    expect(script.lastIndexOf("SWAPPED=0")).toBeGreaterThan(script.lastIndexOf("emit_preservation_receipt"));
    expect(spawnSync("bash", ["-n"], { input: script, encoding: "utf8" })).toMatchObject({
      status: 0,
      stderr: "",
    });
  });

  it.each([
    ["before-original-move", true],
    ["after-original-move", true],
    ["after-upload-move", true],
    ["signal-after-original-move", true],
    ["signal-after-upload-move", true],
    ["readiness", true],
    ["preservation", true],
    ["foreign-target", true],
    ["after-upload-move", false],
    ["signal-after-upload-move", false],
    ["success", true],
    ["success", false],
  ])("preserves real filesystem state for %s (existing target: %s)", (stage, existing) => {
    const root = mkdtempSync(join(tmpdir(), "hivra-bundle-swap-"));
    const target = join(root, "target");
    const upload = join(root, "upload");
    const backups = join(root, "backups");
    try {
      mkdirSync(upload);
      writeFileSync(join(upload, "marker"), "new");
      if (existing) {
        mkdirSync(target);
        writeFileSync(join(target, "marker"), "original");
      }
      const generated = buildManagedProvisionerBundleSyncScript("canary", bundle(), "fixturenode12");
      // Execute the real rollback helpers and swap tail. Only the unrelated
      // host prerequisites/readiness and preservation probes are stubbed.
      const helpers = generated.slice(generated.indexOf('BACKUP_DIR=""'), generated.indexOf("emit_preservation_receipt()"));
      let swap = generated.slice(generated.indexOf('install -d -m 0700 "$ROLLBACK_ROOT"'));
      swap = swap.replace(managedHivraHostReadinessScript("canary", "runtime-update"), stage === "readiness" ? "false" : ":");
      const oldMove = 'move_exclusive "$TARGET" "$BACKUP_DIR"';
      const newMove = 'move_exclusive "$UPLOAD_DIR" "$TARGET"';
      if (stage === "before-original-move") swap = swap.replace(oldMove, `false\n${oldMove}`);
      if (stage === "after-original-move") swap = swap.replace(oldMove, `${oldMove}\nfalse`);
      if (stage === "after-upload-move") swap = swap.replace(newMove, `${newMove}\nfalse`);
      if (stage === "signal-after-original-move") swap = swap.replace(oldMove, () => `${oldMove}\nkill -TERM $$`);
      if (stage === "signal-after-upload-move") swap = swap.replace(newMove, () => `${newMove}\nkill -TERM $$`);
      if (stage === "foreign-target") swap = swap.replace(oldMove, `${oldMove}\nmkdir "$TARGET"\nprintf foreign > "$TARGET/marker"`);
      const dockerImage = process.env.HIVRA_BUNDLE_SWAP_DOCKER_IMAGE;
      const script = `set -euo pipefail
${process.platform === "darwin" && !dockerImage ? `# BSD mv has no -T; emulate only GNU no-nesting/no-clobber flags for these deterministic fixtures.
mv() {
  if [ "$1" = '-T' ]; then
    shift; shift; shift
    if [ -e "$2" ] || [ -L "$2" ]; then return 0; fi
    command mv -- "$1" "$2"
  else command mv "$@"; fi
}` : ""}
TARGET=${JSON.stringify(target)}
UPLOAD_DIR=${JSON.stringify(upload)}
ROLLBACK_ROOT=${JSON.stringify(backups)}
EXPECTED_VERSION=test
${helpers}
emit_preservation_receipt() { ${stage === "preservation" ? "false" : ":"}; }
trap rollback EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
${swap}`;
      // Optional local Linux acceptance uses an already-present pinned image,
      // no network or host mounts. Use Linux tmpfs: macOS shared-folder inode
      // translation is not the inode-preserving rename contract of the host.
      if (dockerImage) expect(dockerImage).toMatch(/^sha256:[a-f0-9]{64}$/);
      const linuxScript = `set -eu
mkdir -p /tmp/fixture/upload
printf new > /tmp/fixture/upload/marker
${existing ? "mkdir /tmp/fixture/target; printf original > /tmp/fixture/target/marker" : ""}
set +e
bash -s > /tmp/stdout 2> /tmp/stderr <<'HIVRA_SWAP_CASE'
${script.split(root).join("/tmp/fixture")}
HIVRA_SWAP_CASE
case_status=$?
python3 - "$case_status" <<'HIVRA_SWAP_RESULT'
import pathlib,json,sys
r=pathlib.Path('/tmp/fixture')
t=r/'target'/'marker'
print(json.dumps(dict(status=int(sys.argv[1]), stdout=pathlib.Path('/tmp/stdout').read_text(), stderr=pathlib.Path('/tmp/stderr').read_text(), target=t.read_text() if t.exists() else None, upload=(r/'upload').exists(), backups=[p.read_text() for p in (r/'backups').glob('*/original/marker')])))
HIVRA_SWAP_RESULT`;
      const result = dockerImage
        ? spawnSync("docker", ["run", "--rm", "--pull=never", "-i", "--network=none", "--read-only", "--user=0", "--tmpfs=/tmp", "--entrypoint=/bin/bash", dockerImage, "-s"], { input: linuxScript, encoding: "utf8", timeout: 15000 })
        : spawnSync("bash", ["-s"], { input: script, encoding: "utf8", timeout: 5000 });
      expect(result.error).toBeUndefined();
      if (dockerImage && result.status !== 0) throw new Error(result.stderr);
      const outcome = dockerImage ? JSON.parse(result.stdout) : {
        status: result.status, stdout: result.stdout, stderr: result.stderr,
        target: existsSync(target) ? readFileSync(join(target, "marker"), "utf8") : null,
        upload: existsSync(upload),
        backups: existsSync(backups) ? readdirSync(backups).flatMap((name) => {
          const marker = join(backups, name, "original", "marker");
          return existsSync(marker) ? [readFileSync(marker, "utf8")] : [];
        }) : [],
      };
      const expectedStatus = stage === "success" ? 0 : stage.startsWith("signal-") ? 143 : 1;
      if (outcome.status !== expectedStatus) throw new Error(JSON.stringify({ stage, expectedStatus, ...outcome }));
      expect(outcome.target).toBe(stage === "success" ? "new" : stage === "foreign-target" ? "foreign" : existing ? "original" : null);
      expect(outcome.upload).toBe(false);
      if (stage !== "success") expect(outcome.stdout).not.toContain("status=updated");
      if (stage === "foreign-target") {
        expect(outcome.backups).toEqual(["original"]);
        expect(outcome.stderr).toContain("foreign target; original backup retained");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an invalid host identity before building a mutable script", () => {
    expect(() => buildManagedProvisionerBundleSyncScript("default", bundle(), "fixturenode12; reboot")).toThrow(
      "requires an explicit Proxmox host id",
    );
  });

  it("rejects a target outside the configured managed rotation before loading or SSH", async () => {
    const loadBundle = jest.fn();
    const runHostScript = jest.fn();

    const result = await syncManagedProvisionerBundle("default", "fixturenode99", {
      loadBundle,
      runHostScript,
    } as never);

    expect(result).toMatchObject({ ok: false, targetId: "fixturenode99", changed: false });
    expect(loadBundle).not.toHaveBeenCalled();
    expect(runHostScript).not.toHaveBeenCalled();
  });

  it("returns a changed receipt only after the bound host reports the update marker", async () => {
    const runHostScript = jest.fn().mockResolvedValue({
      ok: true,
      stdout: `HIVRA_HOST_READY\nHIVRA_MANAGED_HOST_PRESERVED target=fixturenode12 vm_before=12/3/15 vm_after=12/3/15 caddy_before=active caddy_after=active storage_before=100/40/60 storage_after=100/40/60\nHIVRA_MANAGED_BUNDLE_SYNC status=updated version=${PORTABLE_HIVRA_PROVISIONER_VERSION}\n`,
      stderr: "",
    });

    const result = await syncManagedProvisionerBundle("default", "fixturenode12", {
      loadBundle: jest.fn().mockResolvedValue(bundle()),
      runHostScript,
    } as never);

    expect(result).toEqual({
      ok: true,
      targetId: "fixturenode12",
      channel: "default",
      requestedVersion: PORTABLE_HIVRA_PROVISIONER_VERSION,
      changed: true,
      observedVersion: PORTABLE_HIVRA_PROVISIONER_VERSION,
      preservation: {
        hostname: "fixturenode12",
        vmStateBefore: "12/3/15",
        vmStateAfter: "12/3/15",
        caddyBefore: "active",
        caddyAfter: "active",
        storageBefore: "100/40/60",
        storageAfter: "100/40/60",
      },
    });
    expect(runHostScript).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the host does not return a preservation receipt", async () => {
    const runHostScript = jest.fn().mockResolvedValue({
      ok: true,
      stdout: `HIVRA_HOST_READY\nHIVRA_MANAGED_BUNDLE_SYNC status=updated version=${PORTABLE_HIVRA_PROVISIONER_VERSION}\n`,
      stderr: "",
    });

    const result = await syncManagedProvisionerBundle("default", "fixturenode12", {
      loadBundle: jest.fn().mockResolvedValue(bundle()),
      runHostScript,
    } as never);

    expect(result).toMatchObject({
      ok: false,
      targetId: "fixturenode12",
      changed: false,
      error: "Bundle sync or preservation receipt was missing.",
    });
  });

  it("keeps dry-run inspection read-only and reports the observed predecessor", async () => {
    const runHostScript = jest.fn().mockResolvedValue({
      ok: true,
      stdout: "VERSION=2026.08.28.4\n",
      stderr: "",
    });
    const checkReadiness = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      message: "current bundle required",
      error: {},
    });

    const result = await inspectManagedProvisionerBundle("default", "fixturenode12", {
      runHostScript,
      checkReadiness,
    } as never);

    expect(result).toMatchObject({
      ok: false,
      targetId: "fixturenode12",
      changed: false,
      observedVersion: "2026.08.28.4",
      error: "current bundle required",
    });
    expect(runHostScript).toHaveBeenCalledTimes(1);
    expect(checkReadiness).toHaveBeenCalledTimes(1);
    expect(checkReadiness).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "default", purpose: "runtime-update" }),
      runHostScript,
    );
  });

  it("syncs Canary only through its isolated target, upload, and rollback paths", () => {
    const script = buildManagedProvisionerBundleSyncScript("canary", bundle(), "fixturenode12");

    expect(script).toContain("TARGET='/root/hivra-provisioner-canary'");
    expect(script).toContain("ROLLBACK_ROOT='/root/.hivra-provisioner-canary-rollbacks'");
    expect(script).toContain("mktemp -d '/root/.hivra-provisioner-canary-upload.XXXXXXXX'");
    expect(script).not.toMatch(/TARGET='\/root\/hivra-provisioner'/);
    expect(script).not.toContain("ROLLBACK_ROOT='/root/.hivra-provisioner-rollbacks'");
    expect(spawnSync("bash", ["-n"], { input: script, encoding: "utf8" }).status).toBe(0);
  });
});
