/** @jest-environment node */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * HIVRA_PROVISION_MODE=empty makes a computer's place on a host (number,
 * address, blank disk, settings, stored mark) and stops. The real script runs
 * here against stand-in host tools, with its fixed paths moved into a temp dir.
 */

const source = readFileSync(join(process.cwd(), "provisioner/hivra-provision-on-host.sh"), "utf8");
const BINDING = `hivra-bind-${"a".repeat(32)}`;
const OPERATION = "11111111-1111-4111-8111-111111111111";

function run(mode: string | null, kind = "hermes") {
  const root = mkdtempSync(join(tmpdir(), "hivra-empty-mode-"));
  try {
    const bin = join(root, "bin");
    for (const dir of ["bin", "run", "run/lock", "var/lib/hivra", "etc/pve/qemu-server", "prov", "keys"]) {
      mkdirSync(join(root, dir), { recursive: true });
    }
    const script = source
      .replaceAll("/run/", `${root}/run/`)
      .replaceAll("/var/lib/hivra", `${root}/var/lib/hivra`)
      .replaceAll("/etc/pve/", `${root}/etc/pve/`);
    writeFileSync(join(root, "script.sh"), script);
    writeFileSync(join(root, "img"), "");
    writeFileSync(join(root, "prov/hivra-install-agent.py"), "");
    writeFileSync(join(root, "keys/vm"), "");
    writeFileSync(join(root, "keys/vm.pub"), "ssh-ed25519 AAAA test\n");
    // qm: nothing exists until `create`; every call is recorded.
    writeFileSync(join(bin, "qm"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${root}/qm.log"
case "$1" in
  status) [ -e "${root}/created" ] || exit 2; echo "status: stopped" ;;
  create) : > "${root}/created" ;;
  config) echo "tags: ${BINDING};hivra-op-${OPERATION.replaceAll("-", "")}" ;;
esac
exit 0
`, { mode: 0o755 });
    for (const tool of ["ssh", "scp", "curl", "pvesm"]) {
      writeFileSync(join(bin, tool), `#!/usr/bin/env bash\nprintf '%s\\n' "${tool} $*" >> "${root}/remote.log"\nexit 1\n`, { mode: 0o755 });
    }
    const result = spawnSync("bash", [join(root, "script.sh"), "9500", "50", "2", "4096", kind], {
      encoding: "utf8",
      timeout: 20_000,
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        ...(mode === null ? {} : { HIVRA_PROVISION_MODE: mode }),
        HIVRA_OPERATION_ID: OPERATION,
        HIVRA_BINDING_TAG: BINDING,
        HIVRA_UBUNTU_IMG: join(root, "img"),
        HIVRA_PROV_DIR: join(root, "prov"),
        HIVRA_VM_SSH_KEY_PATH: join(root, "keys/vm"),
        HIVRA_DISK_GB: "40",
        HIVRA_SUBNET_PREFIX: "10.250.20",
      },
    });
    const read = (name: string) => (existsSync(join(root, name)) ? readFileSync(join(root, name), "utf8") : "");
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      qm: read("qm.log"),
      remote: read("remote.log"),
      storedMark: read("var/lib/hivra-sleep/stored-9500"),
      receipt: read("run/hivra-provision/9500.allocated"),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("hivra-provision-on-host.sh in empty mode", () => {
  it("makes a stopped computer with a blank disk, its address and the stored mark, and never reaches the guest", () => {
    const out = run("empty");
    expect(out.stderr).toContain("mode=empty");
    expect(out.status).toBe(0);
    const receipt = JSON.parse(out.stdout.trim().split("\n").pop() ?? "{}");
    expect(receipt).toMatchObject({ vmid: 9500, ip: "10.250.20.50", empty: true, ready: false, disk_gb: 40 });
    expect(out.qm).toContain(`--tags ${BINDING};hivra-op-`);
    expect(out.qm).toContain("set 9500 --scsi0 local-lvm:40,discard=on,ssd=1");
    expect(out.qm).toContain("set 9500 --ipconfig0 ip=10.250.20.50/24,gw=10.250.20.1");
    expect(out.qm).not.toContain("import-from");
    expect(out.qm).not.toContain("cicustom");
    expect(out.qm).not.toMatch(/^start /m);
    expect(out.qm).not.toMatch(/^destroy /m);
    expect(out.storedMark.trim()).toBe(BINDING);
    expect(out.receipt).toContain("vmid=9500");
    // No guest connection at all, so the installer cannot have run.
    expect(out.remote).toBe("");
  });

  it("takes no launch input, so a kind that needs a tunnel to install is still made empty", () => {
    const out = run("empty", "deepseek-harness");
    expect(out.status).toBe(0);
    expect(out.remote).toBe("");
  });

  it("refuses a mode it does not know before touching the host", () => {
    const out = run("blank");
    expect(out.status).toBe(1);
    expect(out.qm).toBe("");
  });

  it("left unset, still installs: the disk is imported and the computer started", () => {
    const out = run(null);
    expect(out.qm).toContain("import-from=");
    expect(out.qm).toMatch(/^start 9500/m);
    expect(out.storedMark).toBe("");
  });
});
