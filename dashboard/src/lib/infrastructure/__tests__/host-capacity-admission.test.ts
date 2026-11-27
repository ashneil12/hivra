import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const HELPER = path.join(process.cwd(), "provisioner", "hivra-host-capacity-admission");

describe("serialized host capacity admission helper", () => {
  let fixtureDir: string;

  beforeEach(() => {
    fixtureDir = mkdtempSync(path.join(tmpdir(), "hivra-capacity-"));
    writeFileSync(path.join(fixtureDir, "meminfo"), "MemTotal:       33554432 kB\n");
    mkdirSync(path.join(fixtureDir, "intents"));
    writeExecutable("nproc", "#!/usr/bin/env bash\nprintf '8\\n'\n");
    writeExecutable("qm", `#!/usr/bin/env bash
set -eu
case "\${1:-}" in
  list)
    [ "\${FAIL_QM_LIST:-0}" != 1 ] || exit 42
    [ "\${EMPTY_QM_LIST:-0}" != 1 ] || exit 0
    [ "\${MALFORMED_QM_LIST:-0}" != 1 ] || { printf 'not-an-inventory\\n'; exit 0; }
    printf ' VMID NAME STATUS MEM(MB) BOOTDISK(GB) PID\\n101 active running 1024 8 123\\n'
    [ "\${ADD_SECOND_GUEST:-0}" != 1 ] || printf '102 peer running 1024 8 124\\n'
    ;;
  config)
    printf 'memory: 1024\\n'
    if [ "\${QM_NO_BALLOON:-0}" != 1 ]; then printf 'balloon: 512\\n'; fi
    printf 'cores: 2\\nsockets: 2\\ncpulimit: 0\\n'
    if [ "\${2:-}" = "\${EXACT_VMID:--}" ]; then
      printf 'tags: hivra-op-%s;%s\\n' "\${EXACT_OP_HEX:-}" "\${EXACT_BINDING:-}"
      printf 'ipconfig0: ip=%s/24,gw=10.251.20.1\\n' "\${EXACT_IP:-}"
    elif [ "\${2:-}" = "\${COORD_IP_VMID:--}" ]; then
      printf 'ipconfig0: ip=%s/24,gw=10.251.20.1\\n' "\${EXACT_IP:-}"
    fi
    if [ "\${2:-}" = "\${DISK_VMID:--}" ]; then
      size_spec="\${DISK_SIZE_SPEC:-}"
      [ -n "\$size_spec" ] || size_spec="\${DISK_SIZE_GB:-40}G"
      printf 'scsi0: %s:vm-%s-disk-0,discard=on,ssd=1,size=%s\\n' "\${DISK_STORAGE:-local-lvm}" "\${2:-}" "\$size_spec"
    fi
    ;;
  status)
    [ "\${FAIL_QM_STATUS:-0}" != 1 ] || exit 43
    printf 'status: %s\\n' "\${QM_STATUS-running}"
    ;;
  *) exit 44 ;;
esac
`);
    writeExecutable("pct", `#!/usr/bin/env bash
set -eu
case "\${1:-}" in
  list)
    [ "\${FAIL_PCT_LIST:-0}" != 1 ] || exit 42
    [ "\${MALFORMED_PCT_LIST:-0}" != 1 ] || { printf 'not-an-inventory\\n'; exit 0; }
    ;;
  *) exit 44 ;;
esac
`);
    writeExecutable("pvesm", `#!/usr/bin/env bash
set -eu
case "\${PVESM_MODE:-ok}" in
  fail) exit 42 ;;
  missing) printf 'other dir active 100 1 2 1\n'; exit 0 ;;
  inactive) printf 'local-lvm lvmthin inactive 100 1 2 1\n'; exit 0 ;;
  malformed) printf 'local-lvm lvmthin active 100 1 not-a-number 1\n'; exit 0 ;;
esac
printf 'local-lvm lvmthin active 200000000 100000000 %s 50\n' "\${PVESM_AVAILABLE_KB:-89128960}"
`);
  });

  afterEach(() => rmSync(fixtureDir, { recursive: true, force: true }));

  function writeExecutable(name: string, body: string) {
    const file = path.join(fixtureDir, name);
    writeFileSync(file, body);
    chmodSync(file, 0o700);
  }

  function run(extraEnv: Record<string, string> = {}, helper = HELPER) {
    return spawnSync("bash", [helper, "-", "512", "1024", "1", "512", "0", "1000", "1000", "0"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fixtureDir}:/usr/bin:/bin`,
        HIVRA_CAPACITY_MEMINFO_PATH: path.join(fixtureDir, "meminfo"),
        HIVRA_PROVISION_OPERATIONS_DIR: path.join(fixtureDir, "intents"),
        ...extraEnv,
      },
    });
  }

  it("counts a paused (napping) guest as active instead of refusing every launch on the host", () => {
    const result = run({ QM_STATUS: "paused" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("active_floor_mb=512 active_max_mb=1024 active_max_cpu_milli=4000");
  });

  it("does not count a stopped guest, counts a transient one, and refuses an unreadable status", () => {
    expect(run({ QM_STATUS: "stopped" }).stdout).toContain("active_floor_mb=0 active_max_mb=0 active_max_cpu_milli=0");
    expect(run({ QM_STATUS: "prelaunch" }).stdout).toContain("active_floor_mb=512 active_max_mb=1024 active_max_cpu_milli=4000");
    const unreadable = run({ QM_STATUS: "" });
    expect(unreadable.status).not.toBe(0);
    expect(unreadable.stderr).toContain("invalid QEMU status");
  });

  it("fails closed when the QEMU inventory command fails", () => {
    const result = run({ FAIL_QM_LIST: "1" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("could not read QEMU inventory");
  });

  it("treats a successful empty QEMU inventory as zero active guests", () => {
    const result = run({ EMPTY_QM_LIST: "1" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("active_floor_mb=0 active_max_mb=0 active_max_cpu_milli=0");
  });

  it("treats a successful empty container inventory as zero containers", () => {
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("active_floor_mb=512 active_max_mb=1024 active_max_cpu_milli=4000");
  });

  it.each([
    [{ FAIL_PCT_LIST: "1" }, "could not read container inventory"],
    [{ MALFORMED_QM_LIST: "1" }, "invalid QEMU inventory"],
    [{ MALFORMED_PCT_LIST: "1" }, "invalid container inventory"],
  ])("still rejects failed or malformed inventory: %s", (environment, error) => {
    const result = run(environment);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(error);
  });

  it("fails closed when an inventoried guest status cannot be read", () => {
    const result = run({ FAIL_QM_STATUS: "1" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("could not inspect QEMU status");
  });

  it("counts every socket when an active QEMU guest has no CPU limit", () => {
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("active_max_cpu_milli=4000");
  });

  describe("batched Proxmox inventory", () => {
    let batchHelper: string;
    let configs: string;

    beforeEach(() => {
      configs = path.join(fixtureDir, "configs");
      mkdirSync(configs);
      mkdirSync(path.join(fixtureDir, "PVE"));
      batchHelper = path.join(fixtureDir, "capacity-batch");
      writeFileSync(batchHelper, readFileSync(HELPER, "utf8").replace("/etc/pve/qemu-server", configs));
      writeFileSync(path.join(fixtureDir, "PVE", "Cluster.pm"), `package PVE::Cluster;
sub cfs_update { $ENV{FIXTURE_FAIL_CLUSTER} and die "missing pmxcfs"; $ENV{FIXTURE_CLUSTER_READY}=1; }
1;
`);
      writeFileSync(path.join(fixtureDir, "PVE", "QemuServer.pm"), `package PVE::QemuServer;
use JSON::PP qw(decode_json);
sub vmstatus {
  my ($id, $full) = @_;
  die "wrong inventory or not initialized" if defined($id) || !$full || !$ENV{FIXTURE_CLUSTER_READY};
  return decode_json($ENV{FIXTURE_QEMU_INVENTORY});
}
1;
`);
      writeFileSync(path.join(fixtureDir, "PVE", "QemuConfig.pm"), `package PVE::QemuConfig;
use JSON::PP qw(decode_json);
sub load_current_config {
  my ($class, $id, $current) = @_;
  die "wrong policy or missing config" if $current || $ENV{FIXTURE_FAIL_CONFIG};
  return decode_json($ENV{FIXTURE_QEMU_CONFIG})->{$id};
}
1;
`);
    });

    function batch(
      ids: readonly number[],
      states: Record<string, unknown>,
      facts: Record<string, unknown>,
      extraEnv: Record<string, string> = {},
    ) {
      for (const id of ids) writeFileSync(path.join(configs, `${id}.conf`), "");
      return run({
        HIVRA_CAPACITY_BATCH_QEMU: "1",
        PERL5LIB: fixtureDir,
        FIXTURE_QEMU_INVENTORY: JSON.stringify(states),
        FIXTURE_QEMU_CONFIG: JSON.stringify(facts),
        FAIL_QM_LIST: "1",
        FAIL_QM_STATUS: "1",
        ...extraEnv,
      }, batchHelper);
    }

    it.each(["running", "stopped", "paused", "prelaunch", "unknown"])("matches old resource accounting for %s", status => {
      const old = run({ QM_STATUS: status });
      const result = batch([101], { 101: { vmid: 101, qmpstatus: status } }, {
        101: { memory: 1024, balloon: 512, cores: 2, sockets: 2, cpulimit: 0 },
      });
      expect(old.status).toBe(0);
      expect(result).toMatchObject({ status: 0, stdout: old.stdout });
    });

    it("preserves pending overlay values and excludes templates", () => {
      const result = batch([101, 102], {
        101: { vmid: 101, qmpstatus: "paused" },
        102: { vmid: 102 },
      }, {
        101: { memory: 4096, balloon: 2048, cores: 4, cpulimit: 2.5 },
        102: { template: 1, memory: 32768 },
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("active_floor_mb=2048 active_max_mb=4096 active_max_cpu_milli=2500");
    });

    it("admits against a running Hermes standby exactly like any other running guest", () => {
      const state = { 101: { vmid: 101, qmpstatus: "running" } };
      const resources = { memory: 1024, balloon: 0, cores: 2, cpulimit: 2 };
      const standby = batch([101], state, { 101: { ...resources, tags: "hivra-standby-" + "1".repeat(32) } });
      const customer = batch([101], state, { 101: { ...resources, tags: "hivra-op-" + "2".repeat(32) + ";hivra-bind-" + "3".repeat(32) } });
      expect(standby.status).toBe(0);
      expect(standby.stdout).toContain("active_floor_mb=1024 active_max_mb=1024 active_max_cpu_milli=2000");
      expect(standby.stdout).toBe(customer.stdout);
    });

    it("fails closed for missing, extra, malformed, or unreadable host evidence", () => {
      const good = { 101: { vmid: 101, qmpstatus: "running" } };
      const valid = { 101: { memory: 1024, cores: 2 } };
      for (const result of [
        batch([101], {}, valid),
        batch([101], { 102: { vmid: 102, qmpstatus: "stopped" } }, valid),
        batch([101], { 101: { vmid: 101, qmpstatus: "bad status" } }, valid),
        batch([101], good, { 101: { ...valid[101], tags: "tag\ncpulimit: 4" } }),
        batch([101], good, valid, { FIXTURE_FAIL_CONFIG: "1" }),
        batch([101], good, valid, { FIXTURE_FAIL_CLUSTER: "1" }),
      ]) {
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("could not read complete batched QEMU inventory");
      }
    });

    it("has capacity on a verified empty node", () => {
      const result = batch([], {}, {});
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("active_floor_mb=0 active_max_mb=0 active_max_cpu_milli=0");
    });

    it.each([true, false])("matches existing pending reservation identity accounting (exact: %s)", exact => {
      const ip = "10.251.20.50";
      writeIntent(OPERATION_ID, schemaIntent(OPERATION_ID, 101, ip));
      const old = run({
        EXACT_VMID: "101", EXACT_OP_HEX: OPERATION_HEX, EXACT_BINDING: exact ? BINDING : `hivra-bind-${"b".repeat(32)}`, EXACT_IP: ip,
      });
      const result = batch([101], { 101: { vmid: 101, qmpstatus: "running" } }, {
        101: {
          memory: 1024, balloon: 512, cores: 2, sockets: 2,
          tags: `hivra-op-${OPERATION_HEX};${exact ? BINDING : `hivra-bind-${"b".repeat(32)}`}`,
          ipconfig0: `ip=${ip}/24,gw=10.251.20.1`,
        },
      });
      expect(old.status).toBe(0);
      expect(result).toMatchObject({ status: 0, stdout: old.stdout });
      expect(result.stdout).toContain(`pending_floor_mb=${exact ? 0 : 512}`);
    });
  });

  it("does not let a memory reduction increase another overcommitted dimension", () => {
    const result = spawnSync("bash", [HELPER, "101", "256", "512", "6", "512", "1", "1000", "1000", "1"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fixtureDir}:/usr/bin:/bin`,
        HIVRA_CAPACITY_MEMINFO_PATH: path.join(fixtureDir, "meminfo"),
        HIVRA_PROVISION_OPERATIONS_DIR: path.join(fixtureDir, "intents"),
        ADD_SECOND_GUEST: "1",
      },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("active CPU ceilings exceed the configured density");
  });

  const OPERATION_ID = "11111111-1111-4111-8111-111111111111";
  const OPERATION_HEX = OPERATION_ID.replaceAll("-", "");
  const BINDING = `hivra-bind-${"a".repeat(32)}`;

  function writeIntent(name: string, body: string) {
    writeFileSync(path.join(fixtureDir, "intents", `operation-${name}.selected`), body);
  }

  function schemaIntent(
    operationId: string,
    vmid: number,
    ip: string,
    overrides: Partial<Record<"floor" | "maximum" | "cpuMilli" | "diskGb", number> & { storage: string | null }> = {},
  ) {
    const values = { floor: 512, maximum: 1024, cpuMilli: 1000, diskGb: 40, storage: "local-lvm" as string | null, ...overrides };
    return [
      "schema_version=1",
      `operation_id=${operationId}`,
      `vmid=${vmid}`,
      `ip=${ip}`,
      `binding_tag=${BINDING}`,
      "binding_enforced=1",
      `floor_memory_mb=${values.floor}`,
      `maximum_memory_mb=${values.maximum}`,
      `maximum_cpu_milli=${values.cpuMilli}`,
      `disk_gb=${values.diskGb}`,
      ...(values.storage === null ? [] : [`storage=${values.storage}`]),
      "",
    ].join("\n");
  }

  function runDiskAdmission(extraEnv: Record<string, string> = {}) {
    return spawnSync("bash", [HELPER, "-", "1024", "1024", "1", "512", "0", "1000", "1000", "0", "local-lvm", "40", "5"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fixtureDir}:/usr/bin:/bin`,
        HIVRA_CAPACITY_MEMINFO_PATH: path.join(fixtureDir, "meminfo"),
        HIVRA_PROVISION_OPERATIONS_DIR: path.join(fixtureDir, "intents"),
        EMPTY_QM_LIST: "1",
        ...extraEnv,
      },
    });
  }

  function runAsTarget(target: string, floorMb: string, maximumMb: string, maximumCpu: string, extraEnv: Record<string, string> = {}) {
    return spawnSync("bash", [HELPER, target, floorMb, maximumMb, maximumCpu, "512", "0", "1000", "1000", "0"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fixtureDir}:/usr/bin:/bin`,
        HIVRA_CAPACITY_MEMINFO_PATH: path.join(fixtureDir, "meminfo-small"),
        HIVRA_PROVISION_OPERATIONS_DIR: path.join(fixtureDir, "intents"),
        ...extraEnv,
      },
    });
  }

  function useSmallHost(totalKb = 3145728) {
    writeFileSync(path.join(fixtureDir, "meminfo-small"), `MemTotal:       ${totalKb} kB\n`);
  }

  it("charges a pre-create durable reservation at initial maximum memory for physical admission", () => {
    useSmallHost();
    writeIntent(OPERATION_ID, schemaIntent(OPERATION_ID, 201, "10.251.20.51", { floor: 1024, maximum: 2048, cpuMilli: 1000 }));
    const result = runAsTarget("-", "1024", "1024", "1", { EMPTY_QM_LIST: "1" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("active memory floors plus host reserve exceed physical memory");
  });

  it("deduplicates a running exact match already counted in active inventory", () => {
    writeFileSync(path.join(fixtureDir, "meminfo-small"), "MemTotal:       3145728 kB\n");
    writeIntent(OPERATION_ID, schemaIntent(OPERATION_ID, 101, "10.251.20.50", { floor: 1024, maximum: 2048, cpuMilli: 1000 }));
    const result = runAsTarget("-", "1024", "1024", "1", {
      QM_NO_BALLOON: "1",
      EXACT_VMID: "101",
      EXACT_OP_HEX: OPERATION_HEX,
      EXACT_BINDING: BINDING,
      EXACT_IP: "10.251.20.50",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("active_floor_mb=1024 active_max_mb=1024 active_max_cpu_milli=4000");
    expect(result.stdout).toContain("pending_floor_mb=0 pending_max_mb=0 pending_cpu_milli=0 pending_disk_gb=0");
  });

  it("keeps an exact stopped guest reserved for other admissions but lets a covering exact target represent it", () => {
    useSmallHost();
    writeIntent(OPERATION_ID, schemaIntent(OPERATION_ID, 101, "10.251.20.50", { floor: 1024, maximum: 2048, cpuMilli: 2000 }));
    const env = {
      QM_STATUS: "stopped",
      EXACT_VMID: "101",
      EXACT_OP_HEX: OPERATION_HEX,
      EXACT_BINDING: BINDING,
      EXACT_IP: "10.251.20.50",
    };
    const otherAdmission = runAsTarget("-", "1024", "1024", "1", env);
    expect(otherAdmission.status).not.toBe(0);
    expect(otherAdmission.stderr).toContain("active memory floors plus host reserve exceed physical memory");

    const coveringTarget = runAsTarget("101", "1024", "2048", "2", env);
    expect(coveringTarget.status).toBe(0);
    expect(coveringTarget.stdout).toContain("pending_floor_mb=0 pending_max_mb=0 pending_cpu_milli=0");

    const nonCoveringTarget = runAsTarget("101", "1024", "1024", "1", env);
    expect(nonCoveringTarget.status).not.toBe(0);
    expect(nonCoveringTarget.stderr).toContain("active memory floors plus host reserve exceed physical memory");
  });

  it("requires startup memory plus reserve for an exact stopped target, with a positive counterpart", () => {
    writeIntent(OPERATION_ID, schemaIntent(OPERATION_ID, 101, "10.251.20.50", { floor: 1024, maximum: 2048, cpuMilli: 2000 }));
    const env = {
      QM_STATUS: "stopped",
      EXACT_VMID: "101",
      EXACT_OP_HEX: OPERATION_HEX,
      EXACT_BINDING: BINDING,
      EXACT_IP: "10.251.20.50",
    };

    useSmallHost(2359296); // 2304 MiB: below the 2048+512 MiB startup requirement.
    const insufficient = runAsTarget("101", "1024", "2048", "2", env);
    expect(insufficient.status).not.toBe(0);
    expect(insufficient.stderr).toContain("active memory floors plus host reserve exceed physical memory");

    useSmallHost(3145728); // 3072 MiB: above the same 2560 MiB requirement.
    const sufficient = runAsTarget("101", "1024", "2048", "2", env);
    expect(sufficient.status).toBe(0);
    expect(sufficient.stdout).toContain("pending_floor_mb=0 pending_max_mb=0 pending_cpu_milli=0");
  });

  it("does not let an unrelated active guest reusing only VMID/IP coordinates clear the reservation", () => {
    useSmallHost();
    writeIntent(OPERATION_ID, schemaIntent(OPERATION_ID, 101, "10.251.20.50", { floor: 1024, maximum: 2048, cpuMilli: 1000 }));
    const result = runAsTarget("-", "1024", "1024", "1", {
      COORD_IP_VMID: "101",
      EXACT_IP: "10.251.20.50",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("active memory floors plus host reserve exceed physical memory");
  });

  it("fails closed for a legacy pending reservation with no resource envelope", () => {
    writeIntent(OPERATION_ID, [
      `operation_id=${OPERATION_ID}`,
      "vmid=201",
      "ip=10.251.20.51",
      `binding_tag=${BINDING}`,
      "binding_enforced=1",
      "",
    ].join("\n"));
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("legacy pending allocation intent has no safe resource envelope");
  });

  it("accumulates five concurrent durable requests without double-counting or dropping reservations", () => {
    for (let index = 0; index < 5; index += 1) {
      const operationId = `22222222-2222-4222-8222-${String(index + 1).padStart(12, "0")}`;
      writeIntent(operationId, schemaIntent(operationId, 201 + index, `10.251.20.${51 + index}`, { floor: 512, maximum: 1024, cpuMilli: 1000, diskGb: 40 }));
    }
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("active_floor_mb=5632 active_max_mb=6144 active_max_cpu_milli=9000");
    expect(result.stdout).toContain("pending_floor_mb=2560 pending_max_mb=5120 pending_cpu_milli=5000 pending_disk_gb=200");
  });


  it("fails closed for unknown schema keys or duplicate pending coordinates", () => {
    writeIntent(OPERATION_ID, `${schemaIntent(OPERATION_ID, 201, "10.251.20.51")}extra_key=1\n`);
    const unknown = run();
    expect(unknown.status).not.toBe(0);
    expect(unknown.stderr).toContain("invalid pending allocation intent schema");
    rmSync(path.join(fixtureDir, "intents", `operation-${OPERATION_ID}.selected`));

    const secondOperation = "33333333-3333-4333-8333-333333333333";
    writeIntent(OPERATION_ID, schemaIntent(OPERATION_ID, 201, "10.251.20.51"));
    writeIntent(secondOperation, schemaIntent(secondOperation, 201, "10.251.20.52"));
    const duplicateVmid = run();
    expect(duplicateVmid.status).not.toBe(0);
    expect(duplicateVmid.stderr).toContain("duplicate pending allocation intent VMID or IP");
  });


  it("rejects same-pool pending disk saturation at 70 GiB and admits the exact 85 GiB boundary", () => {
    writeIntent(OPERATION_ID, schemaIntent(OPERATION_ID, 201, "10.251.20.51", { diskGb: 40 }));
    const insufficient = runDiskAdmission({ PVESM_AVAILABLE_KB: String(70 * 1024 * 1024) });
    expect(insufficient.status).not.toBe(0);
    expect(insufficient.stderr).toContain("insufficient live storage headroom for this launch");
    expect(insufficient.stderr).not.toContain("could not read storage inventory");
    expect(insufficient.stderr).not.toContain("invalid storage capacity observation");

    const exactBoundary = runDiskAdmission({ PVESM_AVAILABLE_KB: String(85 * 1024 * 1024) });
    expect(exactBoundary.status).toBe(0);
    expect(exactBoundary.stdout).toContain("pending_disk_gb=40");
  });

  it("keeps malformed, failed, missing, and inactive pvesm observations distinct from saturation", () => {
    writeIntent(OPERATION_ID, schemaIntent(OPERATION_ID, 201, "10.251.20.51", { diskGb: 40 }));
    for (const [mode, error] of [
      ["malformed", "invalid storage capacity observation"],
      ["fail", "could not read storage inventory"],
      ["missing", "could not measure exact configured storage capacity"],
      ["inactive", "configured storage is not active for VM images"],
    ] as const) {
      const result = runDiskAdmission({ PVESM_MODE: mode, PVESM_AVAILABLE_KB: String(200 * 1024 * 1024) });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(error);
      expect(result.stderr).not.toContain("insufficient live storage headroom for this launch");
    }
  });

  it("does not charge a reservation explicitly assigned to another storage pool", () => {
    writeIntent(OPERATION_ID, schemaIntent(OPERATION_ID, 201, "10.251.20.51", { diskGb: 40, storage: "fast-zfs" }));
    const result = runDiskAdmission({ PVESM_AVAILABLE_KB: String(45 * 1024 * 1024) });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("pending_disk_gb=40");
  });

  it("fails closed instead of assuming a storage identity for a pending pre-create reservation", () => {
    writeIntent(OPERATION_ID, schemaIntent(OPERATION_ID, 201, "10.251.20.51", { diskGb: 40, storage: null }));
    const result = runDiskAdmission({ PVESM_AVAILABLE_KB: String(200 * 1024 * 1024) });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("pending allocation intent storage identity unavailable");
  });

  it("does not double-count disk already committed for the exact owned stopped guest", () => {
    writeIntent(OPERATION_ID, schemaIntent(OPERATION_ID, 101, "10.251.20.50", { floor: 512, maximum: 1024, cpuMilli: 1000, diskGb: 40 }));
    const result = runDiskAdmission({
      EMPTY_QM_LIST: "0",
      QM_STATUS: "stopped",
      EXACT_VMID: "101",
      EXACT_OP_HEX: OPERATION_HEX,
      EXACT_BINDING: BINDING,
      EXACT_IP: "10.251.20.50",
      DISK_VMID: "101",
      DISK_STORAGE: "local-lvm",
      PVESM_AVAILABLE_KB: String(45 * 1024 * 1024),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("pending_disk_gb=0");
  });

  it("does not let a foreign stopped guest on the same VMID and storage clear the pending disk reservation", () => {
    writeIntent(OPERATION_ID, schemaIntent(OPERATION_ID, 101, "10.251.20.50", { floor: 512, maximum: 1024, cpuMilli: 1000, diskGb: 40 }));
    const result = runDiskAdmission({
      EMPTY_QM_LIST: "0",
      QM_STATUS: "stopped",
      DISK_VMID: "101",
      DISK_STORAGE: "local-lvm",
      PVESM_AVAILABLE_KB: String(70 * 1024 * 1024),
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("insufficient live storage headroom for this launch");
  });


  it("counts only the uncommitted remainder of a partial exact owned disk", () => {
    writeIntent(OPERATION_ID, schemaIntent(OPERATION_ID, 101, "10.251.20.50", { floor: 512, maximum: 1024, cpuMilli: 1000, diskGb: 40 }));
    const env = {
      EMPTY_QM_LIST: "0",
      QM_STATUS: "stopped",
      EXACT_VMID: "101",
      EXACT_OP_HEX: OPERATION_HEX,
      EXACT_BINDING: BINDING,
      EXACT_IP: "10.251.20.50",
      DISK_VMID: "101",
      DISK_STORAGE: "local-lvm",
      DISK_SIZE_GB: "2",
    };
    const insufficient = runDiskAdmission({ ...env, PVESM_AVAILABLE_KB: String(70 * 1024 * 1024) });
    expect(insufficient.status).not.toBe(0);
    expect(insufficient.stderr).toContain("insufficient live storage headroom for this launch");

    const exactBoundary = runDiskAdmission({ ...env, PVESM_AVAILABLE_KB: String(83 * 1024 * 1024) });
    expect(exactBoundary.status).toBe(0);
    expect(exactBoundary.stdout).toContain("pending_disk_gb=38");
  });


  it("does not round a slightly short MiB-sized committed disk up to a full reservation", () => {
    writeIntent(OPERATION_ID, schemaIntent(OPERATION_ID, 101, "10.251.20.50", { floor: 512, maximum: 1024, cpuMilli: 1000, diskGb: 40 }));
    const env = {
      EMPTY_QM_LIST: "0",
      QM_STATUS: "stopped",
      EXACT_VMID: "101",
      EXACT_OP_HEX: OPERATION_HEX,
      EXACT_BINDING: BINDING,
      EXACT_IP: "10.251.20.50",
      DISK_VMID: "101",
      DISK_STORAGE: "local-lvm",
      DISK_SIZE_SPEC: "39937M",
    };
    const insufficient = runDiskAdmission({ ...env, PVESM_AVAILABLE_KB: String(45 * 1024 * 1024) });
    expect(insufficient.status).not.toBe(0);
    expect(insufficient.stderr).toContain("insufficient live storage headroom for this launch");

    const sufficient = runDiskAdmission({ ...env, PVESM_AVAILABLE_KB: String(46 * 1024 * 1024) });
    expect(sufficient.status).toBe(0);
    expect(sufficient.stdout).toContain("pending_disk_gb=1");
  });

  describe("ordinary Proxmox wake without a pending launch intent", () => {
    const startSource = readFileSync(path.join(path.dirname(HELPER), "hivra-start-on-host.sh"), "utf8");
    // Execute the admission and power-on block without the real host lock,
    // guest SSH, or health checks. The shared capacity helper runs unchanged.
    const wakeBlock = startSource.match(/^qm status "\$VMID" >\/dev\/null[\s\S]*?(?=^release_lifecycle_lock$)/m)?.[0];
    const bindingTag = `hivra-bind-${"a".repeat(32)}`;

    function wake(totalMb: number, overrides: Record<string, string> = {}) {
      expect(wakeBlock).toBeDefined();
      const started = path.join(fixtureDir, "started");
      writeFileSync(path.join(fixtureDir, "meminfo"), `MemTotal: ${totalMb * 1024} kB\n`);
      writeExecutable("qm", `#!/usr/bin/env bash
set -eu
case "$1" in
  list) printf 'VMID NAME STATUS\n101 fixture %s\n' "$QM_STATUS" ;;
  status) printf 'status: %s\n' "$QM_STATUS" ;;
  config) printf 'memory: 2048\nballoon: %s\ncores: 2\ntags: %s\n' "$BALLOON_MB" "$VM_TAG" ;;
  start) touch "$STARTED" ;;
  *) exit 44 ;;
esac
`);
      const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-euc", wakeBlock!], {
        encoding: "utf8",
        timeout: 5000,
        env: {
          PATH: `${fixtureDir}:/usr/bin:/bin`,
          BASH_ENV: "/dev/null",
          NODE_ENV: "test",
          PROVISIONER_DIR: path.dirname(HELPER),
          HIVRA_CAPACITY_MEMINFO_PATH: path.join(fixtureDir, "meminfo"),
          HIVRA_PROVISION_OPERATIONS_DIR: path.join(fixtureDir, "intents"),
          VMID: "101",
          BINDING_TAG_ENFORCED: "1",
          BINDING_TAG: bindingTag,
          VM_TAG: bindingTag,
          QM_STATUS: "stopped",
          BALLOON_MB: "1024",
          HOST_RESERVE_MB: "512",
          ENFORCE_CEILINGS: "0",
          CPU_DENSITY_MILLI: "1000",
          MEMORY_DENSITY_MILLI: "1000",
          STARTED: started,
          ...overrides,
        },
      });
      expect(result.error).toBeUndefined();
      return { status: result.status, stderr: result.stderr, started: existsSync(started) };
    }

    it("refuses 2304 MiB before qm start when startup plus reserve requires 2560 MiB", () => {
      expect(wake(2304)).toMatchObject({
        status: 1,
        stderr: expect.stringContaining("active memory floors plus host reserve exceed physical memory"),
        started: false,
      });
    });

    it("starts at exactly 2560 MiB", () => {
      expect(wake(2560)).toEqual({ status: 0, stderr: "", started: true });
    });

    it("rejects a balloon floor above configured startup memory", () => {
      expect(wake(8192, { BALLOON_MB: "4096" })).toMatchObject({
        status: 1,
        stderr: expect.stringContaining("invalid requested memory maximum"),
        started: false,
      });
    });

    it("still requires the exact Hivra binding tag", () => {
      expect(wake(8192, { VM_TAG: `hivra-bind-${"b".repeat(32)}` })).toMatchObject({
        status: 1,
        stderr: expect.stringContaining("without its exact Hivra binding tag"),
        started: false,
      });
    });

    it("skips admission and power-on for a running VM", () => {
      expect(wake(2304, { QM_STATUS: "running", BALLOON_MB: "4096" })).toEqual({
        status: 0,
        stderr: "",
        started: false,
      });
    });
  });
});
