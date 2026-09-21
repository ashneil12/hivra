import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const HELPER = path.join(process.cwd(), "provisioner", "hivra-host-capacity-admission");

describe("serialized host capacity admission helper", () => {
  let fixtureDir: string;

  beforeEach(() => {
    fixtureDir = mkdtempSync(path.join(tmpdir(), "hivra-capacity-"));
    writeFileSync(path.join(fixtureDir, "meminfo"), "MemTotal:       33554432 kB\n");
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
    printf 'memory: 1024\\nballoon: 512\\ncores: 2\\nsockets: 2\\ncpulimit: 0\\n'
    ;;
  status)
    [ "\${FAIL_QM_STATUS:-0}" != 1 ] || exit 43
    printf 'status: running\\n'
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
        ...extraEnv,
      },
    });
  }

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
        ADD_SECOND_GUEST: "1",
      },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("active CPU ceilings exceed the configured density");
  });
});
