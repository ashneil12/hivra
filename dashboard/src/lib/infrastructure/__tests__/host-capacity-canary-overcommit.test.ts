import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const HELPER = path.join(process.cwd(), "provisioner", "hivra-host-capacity-admission");
const BINDING = `hivra-bind-${"a".repeat(32)}`;
const QA_TAG = `hivra-qa-mem-${"b".repeat(32)}`;
const BOOT_ID = "cc6ed82b-4fc6-43f9-bd77-807c5061f61b";
const OPERATION = "11111111-1111-4111-8111-111111111111";

describe("sealed Canary memory overcommit admission", () => {
  let dir: string;
  let helper: string;
  let qemu: ChildProcess | undefined;
  let states: Record<string, { vmid: number; qmpstatus: string; pid?: number }>;
  let configs: Record<string, Record<string, string | number>>;
  let currentConfigs: typeof configs;

  function put(file: string, contents: string | Buffer) {
    writeFileSync(path.join(dir, file), contents);
  }

  function meminfo({ availableMb = 20 * 1024, swapUsedKb = 0, missing = false } = {}) {
    put("proc/meminfo", `MemTotal: 33554432 kB\n${missing ? "" : `MemAvailable: ${availableMb * 1024} kB\n`}SwapTotal: 65536 kB\nSwapFree: ${65536 - swapUsedKb} kB\n`);
  }

  async function active(maximumMb: number, {
    young = false, status = "running", qmpStatus = status, vmid = 101, duringSample = "",
  } = {}) {
    const hz = Number(spawnSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).stdout);
    qemu = spawn("python3", ["-u", "-c", `
import json, socket, sys
from pathlib import Path
with socket.socket(socket.AF_UNIX) as listener:
    listener.bind(sys.argv[1])
    listener.listen()
    print("ready")
    while True:
        client, _ = listener.accept()
        with client, client.makefile("rb") as reader:
            client.sendall(b'{"QMP":{}}\\r\\n')
            for _ in range(2):
                request = json.loads(reader.readline())
                status = sys.argv[2]
                if request["execute"] == "query-status" and sys.argv[4]:
                    Path(sys.argv[3]).write_text(sys.argv[4])
                answer = {"running": status == "running", "status": status} if request["execute"] == "query-status" else {}
                client.sendall(json.dumps({"id": request["id"], "return": answer}).encode() + b"\\r\\n")
`, path.join(dir, "run", `${vmid}.qmp`), qmpStatus, path.join(dir, "proc/meminfo"), duringSample], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    await once(qemu.stdout!, "data");
    const pid = qemu.pid!;
    put(`run/${vmid}.pid`, `${pid}\n`);
    mkdirSync(path.join(dir, "proc", String(pid)));
    put(`proc/${pid}/stat`, `${pid} (QEMU (KVM)) S ${"0 ".repeat(18)}${(young ? 950 : 500) * hz} 0\n`);
    put(`proc/${pid}/cmdline`, Buffer.from(`/usr/bin/kvm\0-id\0${vmid}\0-name\0fixture\0`));
    symlinkSync("/usr/bin/qemu-system-x86_64", path.join(dir, "proc", String(pid), "exe"));
    put(`proc/${pid}/smaps_rollup`, "Pss: 3145728 kB\nPss_Anon: 3145728 kB\nSwap: 0 kB\nSwapPss: 0 kB\nShared_Hugetlb: 0 kB\nPrivate_Hugetlb: 0 kB\n");
    guest(vmid, maximumMb, status, pid);
    return pid;
  }

  function guest(vmid: number, maximumMb: number, status = "stopped", pid?: number) {
    states[vmid] = { vmid, qmpstatus: status, pid };
    configs[vmid] = currentConfigs[vmid] = { memory: maximumMb, balloon: 512, cores: 2, tags: BINDING };
    put(`configs/${vmid}.conf`, "");
  }

  function pending(vmid: number, maximumMb: number) {
    put(`intents/operation-${OPERATION}.selected`, [
      "schema_version=1", `operation_id=${OPERATION}`, `vmid=${vmid}`, "ip=10.251.20.51", `binding_tag=${BINDING}`,
      "binding_enforced=1", "floor_memory_mb=512", `maximum_memory_mb=${maximumMb}`, "maximum_cpu_milli=1000", "disk_gb=40",
      "storage=local-lvm", "",
    ].join("\n"));
  }

  function enroll(vmid: number, pid: number, { bootId = BOOT_ID, pidDelta = 0, startDelta = 0 } = {}) {
    const start = Number(readFileSync(path.join(dir, "proc", String(pid), "stat"), "utf8").split(") ").at(-1)!.split(" ")[19]);
    const receipt = `intents/qa-memory-${vmid}.enrolled`;
    put(receipt, `v1 ${vmid} ${QA_TAG} ${bootId} ${pid + pidDelta} ${start + startDelta}\n`);
    chmodSync(path.join(dir, receipt), 0o600);
    return receipt;
  }

  function run({
    requestMb = 10 * 1024, target = "-", env = {}, executable = helper, reserveMb = 512, lock = true, pilot = true, enforce = false,
  }: {
    requestMb?: number; target?: string; env?: Record<string, string>; executable?: string;
    reserveMb?: number; lock?: boolean; pilot?: boolean; enforce?: boolean;
  } = {}) {
    const args = [executable, target, "512", String(requestMb), "1", String(reserveMb), enforce ? "1" : "0", "1000", "1000", "0"];
    const wrapper = lock ? ["-euc", 'exec 8>"$1"; flock -nx 8; shift; exec bash "$@"', "test", path.join(dir, "allocation.lock")] : [];
    return spawnSync("bash", [...wrapper, ...args], {
      encoding: "utf8",
      timeout: 7500,
      env: {
        PATH: `${dir}:/usr/bin:/bin`,
        PERL5LIB: dir,
        ...(pilot ? {
          HIVRA_CAPACITY_CANARY_OVERCOMMIT_MILLI: "1250",
          HIVRA_CAPACITY_CANARY_OVERCOMMIT_UNTIL: String(Math.floor(Date.now() / 1000) + 60),
          HIVRA_CAPACITY_CANARY_MEASURED_GUESTS: `101:${BINDING}`,
          HIVRA_CAPACITY_CANARY_PRESSURE_BASELINE: `${BOOT_ID}:0:0:0:0`,
        } : {}),
        FIXTURE_STATES: JSON.stringify(states),
        FIXTURE_CONFIGS: JSON.stringify(configs),
        FIXTURE_CURRENT_CONFIGS: JSON.stringify(currentConfigs),
        ...env,
      },
    });
  }

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "hivra-overcommit-"));
    for (const name of ["proc/pressure", "proc/sys/kernel/random", "run", "intents", "configs", "PVE"]) {
      mkdirSync(path.join(dir, name), { recursive: true });
    }
    states = {};
    configs = {};
    currentConfigs = {};
    helper = path.join(dir, "hivra-host-capacity-admission");
    put("hivra-host-capacity-admission", readFileSync(HELPER, "utf8")
      .replaceAll("/proc/self/fd/8", "PRESERVE_FD_PATH")
      .replaceAll("/proc", path.join(dir, "proc"))
      .replaceAll("PRESERVE_FD_PATH", "/proc/self/fd/8")
      .replaceAll("/run/lock/hivra-allocation.lock", path.join(dir, "allocation.lock"))
      .replaceAll("/run/qemu-server", path.join(dir, "run"))
      .replaceAll("/var/lib/hivra/provision-operations", path.join(dir, "intents"))
      .replaceAll("/etc/pve/qemu-server", path.join(dir, "configs"))
      .replace('/root/hivra-provisioner-canary/hivra-host-capacity-admission', helper)
      .replace('"$EUID" = 0', '"$EUID" = "${EUID}"'));
    put("proc/sys/kernel/hostname", "pve11\n");
    put("proc/sys/kernel/random/boot_id", `${BOOT_ID}\n`);
    meminfo();
    put("proc/uptime", "1000.00 4000.00\n");
    put("proc/vmstat", "pswpin 0\npswpout 0\noom_kill 0\n");
    put("proc/pressure/memory", "some avg10=0.00 avg60=0.00 avg300=0.00 total=123\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=10\n");
    put("PVE/Cluster.pm", "package PVE::Cluster; sub cfs_update {} 1;\n");
    put("PVE/QemuServer.pm", `package PVE::QemuServer; use JSON::PP qw(decode_json);
sub vmstatus { return decode_json($ENV{FIXTURE_STATES}); } 1;\n`);
    put("PVE/QemuConfig.pm", `package PVE::QemuConfig; use JSON::PP qw(decode_json);
sub load_current_config { my ($class, $vmid, $current) = @_; return decode_json($ENV{$current ? "FIXTURE_CURRENT_CONFIGS" : "FIXTURE_CONFIGS"})->{$vmid}; } 1;\n`);
    put("pct", "#!/bin/sh\n[ \"$1\" = list ] && printf 'VMID Status Lock Name\\n'\n");
    chmodSync(path.join(dir, "pct"), 0o700);
    put("qm", "#!/bin/sh\n[ \"$1\" = list ] && printf 'VMID Name Status\\n'\n");
    chmodSync(path.join(dir, "qm"), 0o700);
  });

  afterEach(async () => {
    if (qemu) {
      const finished = once(qemu, "exit");
      qemu.kill();
      await finished;
      qemu = undefined;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("admits healthy exact mature pilot QEMU PSS above 1x and takes the live active config, not a pending shrink", async () => {
    await active(24 * 1024);
    configs["101"] = { ...configs["101"], memory: 512 };
    expect(run()).toMatchObject({ status: 0, stdout: expect.stringContaining("floor_headroom_mb=2048 active_floor_mb=512 active_max_mb=24576") });
    expect(run({ requestMb: 17 * 1024 })).toMatchObject({
      status: 1, stderr: expect.stringContaining("active memory ceilings exceed the Canary hard density"),
    });
  });

  it("admits a synthetic 34 GiB configured crossing on a 32 GiB host only with exact QA attribution, preserving 8 GiB", async () => {
    const pid = await active(24 * 1024, { vmid: 9301 });
    configs["9301"].tags = `fixture;${QA_TAG}`;
    enroll(9301, pid);
    const env = { HIVRA_CAPACITY_CANARY_MEASURED_GUESTS: `101:${BINDING}|9301:${QA_TAG}` };
    expect(run({ env })).toMatchObject({ status: 0, stdout: expect.stringContaining("floor_headroom_mb=2048 active_floor_mb=512 active_max_mb=24576") });
    expect(run({ pilot: false, enforce: true, env: { HIVRA_CAPACITY_BATCH_QEMU: "1" } })).toMatchObject({
      status: 1, stderr: expect.stringContaining("active memory ceilings exceed the configured density"),
    });
    expect(run({ env, requestMb: 17 * 1024 })).toMatchObject({
      status: 1, stderr: expect.stringContaining("active memory ceilings exceed the Canary hard density"),
    });
    meminfo({ availableMb: 18 * 1024 });
    expect(run({ env })).toMatchObject({ status: 1, stderr: expect.stringContaining("insufficient live memory headroom") });
    meminfo({ swapUsedKb: 1 });
    expect(run({ env })).toMatchObject({ status: 1, stderr: expect.stringContaining("swap is in use") });
    put("proc/sys/kernel/hostname", "pve13\n");
    expect(run({ env })).toMatchObject({ status: 1, stderr: expect.stringContaining("requires the installed Canary bundle on pve11") });
  });

  it("charges full maximum for missing, stale, unsafe or mismatched QA enrollment", async () => {
    const pid = await active(24 * 1024, { vmid: 9301 });
    configs["9301"].tags = QA_TAG;
    const env = { HIVRA_CAPACITY_CANARY_MEASURED_GUESTS: `9301:${QA_TAG}` };
    const fullCharge = () => expect(run({ env })).toMatchObject({
      status: 1, stderr: expect.stringContaining("measured memory plus host reserve"),
    });
    fullCharge();
    enroll(9301, pid, { bootId: OPERATION });
    fullCharge();
    enroll(9301, pid, { pidDelta: 1 });
    fullCharge();
    enroll(9301, pid, { startDelta: 1 });
    fullCharge();
    const receipt = enroll(9301, pid);
    chmodSync(path.join(dir, receipt), 0o644);
    fullCharge();
    enroll(9301, pid);
    const valid = readFileSync(path.join(dir, receipt));
    rmSync(path.join(dir, receipt));
    put("otherwise-valid-receipt", valid);
    chmodSync(path.join(dir, "otherwise-valid-receipt"), 0o600);
    symlinkSync(path.join(dir, "otherwise-valid-receipt"), path.join(dir, receipt));
    fullCharge();
    rmSync(path.join(dir, receipt));
    enroll(9301, pid);
    for (const extraTag of [QA_TAG, BINDING, `hivra-op-${OPERATION.replaceAll("-", "")}`]) {
      configs["9301"].tags = `${QA_TAG};${extraTag}`;
      fullCharge();
    }
    configs["9301"].tags = `${QA_TAG};${BINDING}`;
    expect(run({ env: { HIVRA_CAPACITY_CANARY_MEASURED_GUESTS: `9301:${BINDING}` } })).toMatchObject({
      status: 1, stderr: expect.stringContaining("measured memory plus host reserve"),
    });
  });

  it("rejects QA authorization outside its isolated VM range and duplicate lane assignment", () => {
    for (const vmid of [101, 9299, 9302, 9400]) {
      expect(run({ env: { HIVRA_CAPACITY_CANARY_MEASURED_GUESTS: `${vmid}:${QA_TAG}` } })).toMatchObject({
        status: 1, stderr: expect.stringContaining("measured guest"),
      });
    }
    expect(run({ env: { HIVRA_CAPACITY_CANARY_MEASURED_GUESTS: `9301:${QA_TAG}|9301:${BINDING}` } })).toMatchObject({
      status: 1, stderr: expect.stringContaining("invalid measured guest authorization"),
    });
  });

  it.each([{ young: true }, { qmpStatus: "paused" }])("does not discount an enrolled QA clone without mature running proof (%j)", async options => {
    const pid = await active(24 * 1024, { vmid: 9301, ...options });
    configs["9301"].tags = QA_TAG;
    enroll(9301, pid);
    expect(run({ env: { HIVRA_CAPACITY_CANARY_MEASURED_GUESTS: `9301:${QA_TAG}` } })).toMatchObject({
      status: 1, stderr: expect.stringContaining("measured memory plus host reserve"),
    });
  });

  it.each([
    ["proc/vmstat", "pswpin 1\npswpout 0\noom_kill 0\n", "swap activity or OOM kill"],
    ["proc/vmstat", "pswpin 0\npswpout 0\noom_kill 1\n", "swap activity or OOM kill"],
    ["proc/vmstat", "pswpin 0\npswpout 0\n", "missing or invalid oom_kill"],
    ["proc/pressure/memory", "some avg10=0.00 avg60=0.01 avg300=0.00 total=123\n", "memory PSI pressure"],
    ["proc/pressure/memory", "some avg10=0.00 avg60=0.00 avg300=0.00 total=123\n", "incomplete memory PSI"],
  ])("fails closed on unhealthy or partial %s evidence", (file, contents, error) => {
    put(file, contents);
    expect(run()).toMatchObject({ status: 1, stderr: expect.stringContaining(error) });
  });

  it("rejects swap use, missing MemAvailable, and equality at minimum live headroom", () => {
    meminfo({ swapUsedKb: 1 });
    expect(run()).toMatchObject({ status: 1, stderr: expect.stringContaining("swap is in use") });
    meminfo({ missing: true });
    expect(run()).toMatchObject({ status: 1, stderr: expect.stringContaining("missing or invalid MemAvailable") });
    meminfo({ availableMb: 18 * 1024 });
    expect(run()).toMatchObject({ status: 1, stderr: expect.stringContaining("insufficient live memory headroom") });
    meminfo({ availableMb: 18 * 1024 + 1 });
    expect(run()).toMatchObject({ status: 0, stdout: expect.stringContaining("floor_headroom_mb=1") });
    expect(run({ reserveMb: 8193 })).toMatchObject({ status: 1, stderr: expect.stringContaining("insufficient live memory headroom") });
  });

  it("requires an exact same-boot pressure baseline and accepts only stable historical counters and at most 64 KiB swap", () => {
    expect(run({ env: { HIVRA_CAPACITY_CANARY_PRESSURE_BASELINE: "" } })).toMatchObject({
      status: 1, stderr: expect.stringContaining("requires a pressure baseline"),
    });
    put("proc/vmstat", "pswpin 4\npswpout 3344\noom_kill 2\n");
    meminfo({ swapUsedKb: 32 });
    const pressure = (value: string) => run({ env: { HIVRA_CAPACITY_CANARY_PRESSURE_BASELINE: value } });
    expect(pressure(`${BOOT_ID}:4:3344:2:32`)).toMatchObject({ status: 0 });
    expect(pressure(`${BOOT_ID}:4:3344:2:64`)).toMatchObject({ status: 0 });
    expect(pressure(`${BOOT_ID}:4:3344:2:65`)).toMatchObject({ status: 1, stderr: expect.stringContaining("invalid pressure baseline") });
    expect(pressure(`${BOOT_ID}:4:-1:2:32`)).toMatchObject({ status: 1, stderr: expect.stringContaining("invalid pressure baseline") });
    expect(pressure(`${OPERATION}:4:3344:2:32`)).toMatchObject({
      status: 1, stderr: expect.stringContaining("host boot differs from the pressure baseline"),
    });
    for (const recorded of [3343, 3345]) {
      expect(pressure(`${BOOT_ID}:4:${recorded}:2:32`)).toMatchObject({
        status: 1, stderr: expect.stringContaining("counters differ from the pressure baseline"),
      });
    }
    meminfo({ swapUsedKb: 33 });
    expect(pressure(`${BOOT_ID}:4:3344:2:32`)).toMatchObject({
      status: 1, stderr: expect.stringContaining("swap is in use above the pressure baseline"),
    });
  });

  it("rejects swap growth during sampling even below the baseline limit", async () => {
    meminfo({ swapUsedKb: 31 });
    const duringSample = readFileSync(path.join(dir, "proc/meminfo"), "utf8").replace("65505 kB", "65504 kB");
    await active(24 * 1024, { duringSample });
    expect(run({ env: { HIVRA_CAPACITY_CANARY_PRESSURE_BASELINE: `${BOOT_ID}:0:0:0:64` } })).toMatchObject({
      status: 1, stderr: expect.stringContaining("swap use grew during measurement"),
    });
  });

  it("charges pending maximum for a lost worker, and prevents discount of its exact active guest", async () => {
    await active(24 * 1024);
    pending(201, 4 * 1024);
    expect(run()).toMatchObject({ status: 1, stderr: expect.stringContaining("insufficient live memory headroom") });
    meminfo({ availableMb: 23 * 1024 });
    expect(run()).toMatchObject({ status: 0, stdout: expect.stringContaining("pending_max_mb=4096") });
    rmSync(path.join(dir, "intents", `operation-${OPERATION}.selected`));
    Object.assign(configs["101"], { tags: `${BINDING};hivra-op-${OPERATION.replaceAll("-", "")}`, ipconfig0: "ip=10.251.20.51/24" });
    pending(101, 24 * 1024);
    expect(run()).toMatchObject({ status: 1, stderr: expect.stringContaining("measured memory plus host reserve") });
  });

  it.each([
    { young: true },
    { status: "paused" },
    { status: "running", qmpStatus: "paused" },
  ])("charges a young or paused process its full uncovered entitlement (%j)", async options => {
    await active(12 * 1024, options);
    expect(run({ requestMb: 8 * 1024 })).toMatchObject({
      status: 1, stderr: expect.stringContaining("insufficient live memory headroom"),
    });
    meminfo({ availableMb: 26 * 1024 });
    expect(run({ requestMb: 8 * 1024 })).toMatchObject({ status: 0 });
  });

  it("requires an exact authorization tag and charges missing nonpilot PSS in full", async () => {
    const pid = await active(12 * 1024);
    const env = { HIVRA_CAPACITY_CANARY_MEASURED_GUESTS: `101:hivra-bind-${"f".repeat(32)}` };
    expect(run({ requestMb: 8 * 1024, env })).toMatchObject({ status: 1 });
    meminfo({ availableMb: 26 * 1024 });
    expect(run({ requestMb: 8 * 1024, env })).toMatchObject({ status: 0 });
    rmSync(path.join(dir, "proc", String(pid), "smaps_rollup"));
    expect(run({ requestMb: 8 * 1024, env })).toMatchObject({
      status: 1, stderr: expect.stringContaining("insufficient live memory headroom"),
    });
    expect(run({ requestMb: 8 * 1024 })).toMatchObject({
      status: 1, stderr: expect.stringContaining("could not prove authorized QEMU PSS"),
    });
  });

  it("rejects a bad VM process binding or a partial runtime inventory", async () => {
    const pid = await active(12 * 1024);
    put(`proc/${pid}/cmdline`, Buffer.from(["/usr/bin/kvm", "-id", "201", ""].join("\0")));
    expect(run()).toMatchObject({ status: 1, stderr: expect.stringContaining("not bound to its VMID") });
    rmSync(path.join(dir, "run", "101.pid"));
    expect(run()).toMatchObject({ status: 1, stderr: expect.stringContaining("QEMU runtime and config inventories disagree") });
  });

  it("adds zero for a stopped guest but charges full maximum to wake it", () => {
    guest(101, 14 * 1024);
    expect(run()).toMatchObject({ status: 0, stdout: expect.stringContaining("active_max_mb=0") });
    expect(run({ target: "101" })).toMatchObject({ status: 1, stderr: expect.stringContaining("full VM memory maximum") });
    expect(run({ target: "101", requestMb: 14 * 1024 })).toMatchObject({
      status: 1, stderr: expect.stringContaining("insufficient live memory headroom"),
    });
    meminfo({ availableMb: 23 * 1024 });
    expect(run({ target: "101", requestMb: 14 * 1024 })).toMatchObject({ status: 0 });
    put("run/101.pid", "199\n");
    expect(run({ target: "101", requestMb: 14 * 1024 })).toMatchObject({
      status: 1, stderr: expect.stringContaining("QEMU runtime and config inventories disagree"),
    });
  });

  it("requires the allocation lock, and keeps admission blocked while any wake remains unconfirmed", () => {
    expect(run({ lock: false })).toMatchObject({ status: 1, stderr: expect.stringContaining("requires the host allocation lock on FD 8") });
    put("intents/wake-101.selected", `v1 101 ${BINDING} 10240\n`);
    expect(run()).toMatchObject({ status: 1, stderr: expect.stringContaining("while a VM wake is unconfirmed") });
    expect(run({ pilot: false })).toMatchObject({ status: 1, stderr: expect.stringContaining("while a VM wake is unconfirmed") });
    rmSync(path.join(dir, "intents", "wake-101.selected"));
    symlinkSync("/missing-wake-reservation", path.join(dir, "intents", "wake-101.selected"));
    expect(run()).toMatchObject({ status: 1, stderr: expect.stringContaining("while a VM wake is unconfirmed") });
    rmSync(path.join(dir, "intents", "wake-101.selected"));
    expect(run({ pilot: false })).toMatchObject({ status: 0 });
  });

  it("rejects expired, excessive, protected and wrong-host/channel policy input", () => {
    expect(run({ env: { HIVRA_CAPACITY_CANARY_OVERCOMMIT_UNTIL: "1" } })).toMatchObject({
      status: 1, stderr: expect.stringContaining("expired Canary memory overcommit"),
    });
    expect(run({ env: { HIVRA_CAPACITY_CANARY_OVERCOMMIT_MILLI: "1251" } })).toMatchObject({
      status: 1, stderr: expect.stringContaining("invalid Canary memory overcommit"),
    });
    expect(run({ env: { HIVRA_CAPACITY_CANARY_MEASURED_GUESTS: `9302:${BINDING}` } })).toMatchObject({
      status: 1, stderr: expect.stringContaining("invalid measured guest authorization"),
    });
    const alternate = path.join(dir, "uninstalled");
    put("uninstalled", readFileSync(helper));
    expect(run({ executable: alternate })).toMatchObject({
      status: 1, stderr: expect.stringContaining("requires the installed Canary bundle on pve11"),
    });
    put("proc/sys/kernel/hostname", "pve13\n");
    expect(run()).toMatchObject({ status: 1, stderr: expect.stringContaining("requires the installed Canary bundle on pve11") });
  });
});
