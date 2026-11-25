import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  function run(extraEnv: Record<string, string> = {}) {
    return spawnSync("bash", [HELPER, "-", "512", "1024", "1", "512", "0", "1000", "1000", "0"], {
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

});
