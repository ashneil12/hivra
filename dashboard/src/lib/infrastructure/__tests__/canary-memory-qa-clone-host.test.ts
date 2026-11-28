import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const WRAPPER = path.join(process.cwd(), "provisioner", "hivra-canary-memory-qa-clone.sh");
const VMID = "9304";
const TAG = `hivra-qa-mem-${"a".repeat(32)}`;
const BOOT = "d8294236-c7df-49cb-a647-a49d7bea10fb";
const PID = "1428";
const START = "72300";
const PRESSURE_BASELINE = `${BOOT}:0:3344:0:32`;
const TEMPLATE = "template: 1\nostype: l26\nonboot: 0\nnet0: virtio=AA:BB:CC:DD:EE:FF,bridge=hivra0\nnet7: virtio=AA:BB:CC:DD:EE:11,bridge=hivra0\nscsi0: local-lvm:base-9007-disk-0,size=12G\n";

const MOCK_HOST = String.raw`#!/usr/bin/env python3
import fcntl
import json
import os
import sys
from pathlib import Path

root = Path(os.environ["MOCK_ROOT"])
vmid, tag, pid, start = (os.environ[name] for name in ("MOCK_VMID", "MOCK_TAG", "MOCK_PID", "MOCK_START"))
name = Path(sys.argv[0]).name
args = sys.argv[1:]
mode = os.environ.get("MOCK_MODE")
config = root / f"pve/nodes/pve11/qemu-server/{vmid}.conf"
ledger = root / f"references/qa-memory-{vmid}.operator.list"
wake = root / f"ops/wake-{vmid}.selected"
pidfile = root / f"run/qemu-server/{vmid}.pid"
locks = [root / "locks/hivra-allocation.lock", root / f"locks/hivra-vmids/{vmid}.lock"]
with (root / "calls").open("a") as calls:
    print(json.dumps([name, *args]), file=calls)

def held(descriptors=False):
    for fd, lock in enumerate(locks, 8):
        with lock.open() as test:
            try:
                fcntl.flock(test.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                pass
            else:
                sys.exit("required lock was not held")
        if descriptors:
            assert os.path.samestat(os.fstat(fd), lock.stat())

if name == "pvesh":
    held()
    assert args == ["get", "/cluster/nextid", "--vmid", vmid]
    print("9320" if mode == "cluster-conflict" else vmid)
elif name == "hivra-host-capacity-admission":
    held(descriptors=True)
    assert args[1:] == ["4096", "4096", "0.25", "8192", "1", "3333", "1000", "0", "local-lvm", "40", "5"]
    assert os.environ["HIVRA_CAPACITY_CANARY_PRESSURE_BASELINE"] == os.environ["MOCK_PRESSURE_BASELINE"]
    assert not wake.exists()
    if args[0] == "-":
        assert not ledger.exists() and not config.exists()
        if mode == "capacity-denied":
            sys.exit("mock capacity denial")
    else:
        assert args[0] == vmid and config.exists() and not pidfile.exists()
        assert ledger.read_text() == f"{vmid}\n"
elif name == "qm":
    action, target, *options = args
    if action == "config":
        assert options == ["--current", "1"]
        print((root / "template" if target == "9007" else config).read_text(), end="")
    elif action == "clone":
        held()
        assert not Path("/proc/self/fd/8").exists() and not Path("/proc/self/fd/9").exists()
        assert target == "9007" and options == [vmid, "--name", tag, "--full", "0"]
        assert not config.exists() and ledger.read_text() == f"{vmid}\n"
        stock = (root / "template").read_text().replace("template: 1\n", "")
        config.write_text(f"name: {tag}\n" + stock)
    elif action == "set":
        held()
        assert target == vmid and not pidfile.exists() and not wake.exists()
        values = dict(line.split(": ", 1) for line in config.read_text().splitlines())
        if options[0] == "--delete":
            for key in options[1].split(","):
                values.pop(key)
        else:
            values.update((key.removeprefix("--"), value) for key, value in zip(options[::2], options[1::2]))
        config.write_text("".join(f"{key}: {value}\n" for key, value in values.items()))
    elif action == "start":
        held()
        assert not Path("/proc/self/fd/8").exists() and not Path("/proc/self/fd/9").exists()
        assert target == vmid and not options
        assert wake.read_text() == f"v1 {vmid} {tag} 4096\n"
        data = dict(line.split(": ", 1) for line in config.read_text().splitlines())
        assert data["onboot"] == "0" and data["tags"] == tag
        assert not any(key.startswith("net") for key in data)
        process = root / f"proc/{pid}"
        process.mkdir()
        (process / "stat").write_text(f"{pid} (kvm) S " + "0 " * 18 + f"{start} 0\n")
        (process / "exe").symlink_to(root / "kvm")
        identity = "9993" if mode == "pid-mismatch" else vmid
        (process / "cmdline").write_bytes(f"/usr/bin/kvm\0-id\0{identity}\0".encode())
        pidfile.write_text(f"{pid}\n")
        if mode == "start-timeout":
            sys.exit(124)
    elif action == "status":
        assert target == vmid
        status = "running" if pidfile.exists() else "stopped"
        print(f"status: {status}")
        if options == ["--verbose"]:
            print(f"qmpstatus: {status}")
            print(f"pid: {pid}")
    elif action == "guest":
        held()
        assert target == "cmd" and options == [vmid, "ping"] and pidfile.exists()
    else:
        sys.exit("unexpected qm command")
else:
    sys.exit("unexpected network or host command")
`;

describe("Canary memory QA clone host wrapper", () => {
  let dir: string;
  let script: string;

  function put(file: string, contents: string, mode = 0o600) {
    writeFileSync(path.join(dir, file), contents, { mode });
  }

  function text(file: string) {
    return readFileSync(path.join(dir, file), "utf8");
  }

  function exists(file: string) {
    return existsSync(path.join(dir, file));
  }

  function callLog(): string[][] {
    return exists("calls") ? text("calls").trim().split("\n").map(line => JSON.parse(line)) : [];
  }

  function run({
    env = {}, vmid = VMID, tag = TAG, digest = createHash("sha256").update(text("template")).digest("hex"), cpuBudget = "40000",
    lockFile = "locks/hivra-allocation.lock",
  } = {}) {
    const runner = lockFile
      ? ["-euc", 'exec 8>>"$1"; flock -nx 8; shift; exec bash "$@"', "stub-route", path.join(dir, lockFile)]
      : [];
    return spawnSync("bash", [...runner, script, vmid, tag, digest, cpuBudget], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        PATH: `${dir}/bin:/usr/bin:/bin`,
        HIVRA_CAPACITY_CANARY_OVERCOMMIT_MILLI: "1250",
        HIVRA_CAPACITY_CANARY_OVERCOMMIT_UNTIL: String(Math.floor(Date.now() / 1000) + 60),
        HIVRA_CAPACITY_CANARY_MEASURED_GUESTS: `${VMID}:${TAG}`,
        HIVRA_CAPACITY_CANARY_PRESSURE_BASELINE: PRESSURE_BASELINE,
        MOCK_PRESSURE_BASELINE: PRESSURE_BASELINE,
        MOCK_ROOT: dir,
        MOCK_CPUS: "12",
        MOCK_VMID: VMID,
        MOCK_TAG: TAG,
        MOCK_PID: PID,
        MOCK_START: START,
        ...env,
      },
    });
  }

  function noMutation() {
    expect(callLog().filter(([cmd, action]) => cmd === "qm" && ["clone", "set", "start", "stop", "destroy"].includes(action))).toEqual([]);
    expect(exists(`references/qa-memory-${VMID}.operator.list`)).toBe(false);
    expect(exists(`ops/wake-${VMID}.selected`)).toBe(false);
    expect(exists(`ops/qa-memory-${VMID}.enrolled`)).toBe(false);
  }

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "hivra-qa-clone-"));
    for (const name of ["bin", "bundle", "proc/sys/kernel/random", "pve/nodes/pve11/qemu-server", "pve/nodes/pve11/lxc", "locks", "run/qemu-server", "run/hivra-provision", "ops", "references", "results"]) {
      mkdirSync(path.join(dir, name), { recursive: true });
    }
    const rewrites = {
      "/root/hivra-provisioner-canary": "bundle",
      "/var/lib/hivra/provision-operations": "ops",
      "/var/lib/hivra/vmid-references": "references",
      "/var/lib/hivra/provision-results": "results",
      "/etc/pve": "pve",
      "/run/qemu-server": "run/qemu-server",
      "/run/hivra-provision": "run/hivra-provision",
      "/run/lock": "locks",
      "/proc": "proc",
      "/usr/bin/qemu-system-x86_64": "kvm",
    };
    let source = readFileSync(WRAPPER, "utf8");
    for (const [original, replacement] of Object.entries(rewrites)) {
      source = source.replaceAll(original, path.join(dir, replacement));
    }
    put("bundle/hivra-canary-memory-qa-clone.sh", source
      .replaceAll(path.join(dir, "proc/self/fd"), "/proc/self/fd")
      .replace('"${EUID}" == 0', '"${EUID}" == "$(id -u)"')
      .replace('"$EUID" == 0', '"$EUID" == "$(id -u)"')
      .replace('"$owner" == 0', '"$owner" == "$(id -u)"'));
    script = path.join(dir, "bundle/hivra-canary-memory-qa-clone.sh");
    put("proc/sys/kernel/hostname", "pve11\n");
    put("proc/sys/kernel/random/boot_id", `${BOOT}\n`);
    put("template", TEMPLATE);
    put("kvm", "");
    put("bin/mock-host", MOCK_HOST, 0o700);
    put("bin/nproc", "#!/bin/sh\nprintenv MOCK_CPUS\n", 0o700);
    for (const name of ["qm", "pvesh", "ssh", "scp", "curl", "wget"]) {
      symlinkSync("mock-host", path.join(dir, "bin", name));
    }
    put("bundle/hivra-host-capacity-admission", '#!/bin/bash\nexec "$MOCK_ROOT/bin/hivra-host-capacity-admission" "$@"\n');
    symlinkSync("mock-host", path.join(dir, "bin/hivra-host-capacity-admission"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("requires an exact permit and excludes VM 9302 before consulting the host", () => {
    expect(run({ env: { HIVRA_CAPACITY_CANARY_MEASURED_GUESTS: `${VMID}:${TAG}e` } })).toMatchObject({
      status: 1, stderr: expect.stringContaining("current exact pilot permit"),
    });
    expect(run({ vmid: "9302" })).toMatchObject({ status: 1, stderr: expect.stringContaining("invalid fixture scope") });
    expect(callLog()).toEqual([]);
    noMutation();
  });

  it("refuses a missing FD8 or an FD8 for the wrong inode before touching inventory", () => {
    for (const lockFile of ["", "locks/foreign.lock"]) {
      expect(run({ lockFile })).toMatchObject({
        status: 1, stderr: expect.stringContaining("the allocation lock is required on FD 8"),
      });
    }
    expect(callLog()).toEqual([]);
    noMutation();
  });

  it("does not touch an existing foreign config", () => {
    const foreign = "name: untouched\ntags: hivra-bind-00000000000000000000000000000000\n";
    put(`pve/nodes/pve11/qemu-server/${VMID}.conf`, foreign);
    expect(run()).toMatchObject({ status: 1, stderr: expect.stringContaining("VMID has existing host state") });
    expect(callLog()).toEqual([]);
    expect(text(`pve/nodes/pve11/qemu-server/${VMID}.conf`)).toBe(foreign);
    noMutation();
  });

  it("respects exact cluster, managed claim, and capacity denial before mutation", () => {
    expect(run({ env: { MOCK_MODE: "cluster-conflict" } })).toMatchObject({
      status: 1, stderr: expect.stringContaining("VMID is not free cluster-wide"),
    });
    put("ops/operation-test.selected", `vmid=${VMID}\n`);
    expect(run()).toMatchObject({ status: 1, stderr: expect.stringContaining("VMID has a managed claim") });
    rmSync(path.join(dir, "ops/operation-test.selected"));
    expect(run({ env: { MOCK_MODE: "capacity-denied" } })).toMatchObject({
      status: 1, stderr: expect.stringContaining("mock capacity denial"),
    });
    expect(run({ cpuBudget: "11000" })).toMatchObject({
      status: 1, stderr: expect.stringContaining("CPU budget is below the supported host admission envelope"),
    });
    put("references/unsafe.list", "9380\n");
    chmodSync(path.join(dir, "references/unsafe.list"), 0o666);
    expect(run()).toMatchObject({ status: 1, stderr: expect.stringContaining("VMID reference ledger is not trusted") });
    noMutation();
  });

  it("does not clone a template configured to autostart", () => {
    put("template", TEMPLATE.replace("onboot: 0", "onboot: 1"));
    expect(run()).toMatchObject({ status: 1, stderr: expect.stringContaining("template autostart is not safely disabled") });
    noMutation();
  });

  it("claims the exact VMID under FD8, strips network and autostart, and publishes the PID-bound receipt", () => {
    expect(run()).toMatchObject({ status: 0, stdout: expect.stringContaining(`HIVRA_CANARY_MEMORY_QA_RUNNING ${VMID} ${TAG}`) });
    const config = text(`pve/nodes/pve11/qemu-server/${VMID}.conf`);
    expect(config).not.toMatch(/^net[0-9]+:/m);
    expect(config).toMatch(/^onboot: 0$/m);
    expect(config).toMatch(/^cpulimit: 0\.25$/m);
    expect(text(`references/qa-memory-${VMID}.operator.list`)).toBe(`${VMID}\n`);
    const enrolled = `ops/qa-memory-${VMID}.enrolled`;
    expect(text(enrolled)).toBe(`v1 ${VMID} ${TAG} ${BOOT} ${PID} ${START}\n`);
    expect(statSync(path.join(dir, enrolled)).mode & 0o777).toBe(0o600);
    expect(exists(`ops/wake-${VMID}.selected`)).toBe(false);
    expect(callLog().filter(([cmd, action]) => cmd === "hivra-host-capacity-admission" || (cmd === "qm" && ["clone", "start"].includes(action))).map(([cmd, action]) => [cmd, action])).toEqual([
      ["hivra-host-capacity-admission", "-"], ["qm", "clone"], ["hivra-host-capacity-admission", VMID], ["qm", "start"],
    ]);
    expect(callLog().every(([cmd]) => ["qm", "pvesh", "hivra-host-capacity-admission"].includes(cmd))).toBe(true);
  });

  it.each([
    ["start-timeout", "start not confirmed"],
    ["pid-mismatch", "fixture VMID and QEMU PID do not match"],
  ])("keeps the full startup fence when the process proof is ambiguous (%s)", (mode, error) => {
    expect(run({ env: { MOCK_MODE: mode } })).toMatchObject({ status: 1, stderr: expect.stringContaining(error) });
    expect(text(`ops/wake-${VMID}.selected`)).toBe(`v1 ${VMID} ${TAG} 4096\n`);
    expect(exists(`ops/qa-memory-${VMID}.enrolled`)).toBe(false);
    expect(exists(`references/qa-memory-${VMID}.operator.list`)).toBe(true);
    expect(exists(`run/qemu-server/${VMID}.pid`)).toBe(true);
  });
});
