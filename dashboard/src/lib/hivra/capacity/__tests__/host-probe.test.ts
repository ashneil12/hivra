import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildHostCapacityScript, parseHostCapacityOutput } from "../host-probe";

const QM_LIST = `      VMID NAME                 STATUS     MEM(MB)    BOOTDISK(GB) PID
       100 a                    running    8192              40.00 11
       101 b                    paused     8192              40.00 12
       102 c                    stopped    4096              40.00 0
       103 d                    stopped    4096              40.00 0
`;
const PVESM = `Name             Type     Status           Total            Used       Available        %
local             dir     active        98497780        10000000        88497780   10.15%
big           zfspool     active      1887436800      1698693120       188743680   90.00%
off               dir   inactive               0               0               0    0.00%
`;
const LVS_VOLUMES = `  pve||root
  pve|data|vm-100-disk-0
  pve|data|vm-101-disk-0
  pve|data|vm-101-state-suspend
  vg1|slow|vm-102-disk-0
`;

/** Runs the script with fake host tools on PATH. Each tool prints what it is given, or fails. */
function runOnFakeHost(tools: { lvsVolumes?: string; lvsSizes?: string; pvesm?: string; qm?: string; qmShort?: string }): string {
  const dir = mkdtempSync(join(tmpdir(), "hivra-capacity-"));
  try {
    const tool = (name: string, body: string) => {
      writeFileSync(join(dir, name), `#!/bin/bash\n${body}\n`);
      chmodSync(join(dir, name), 0o755);
    };
    const print = (text: string | undefined) => (text === undefined ? "exit 1" : `cat <<'OUT'\n${text}OUT`);
    tool("lvs", `if [[ "$*" == *pool_lv* ]]; then\n${print(tools.lvsVolumes)}\nelse\n${print(tools.lvsSizes)}\nfi`);
    tool("pvesm", print(tools.pvesm));
    // `qm` is the full listing; `qmShort`, when given, is what the listing without --full prints.
    tool("qm", tools.qmShort === undefined
      ? print(tools.qm)
      : `if [[ "$*" == *--full* ]]; then\n${print(tools.qm)}\nelse\n${print(tools.qmShort)}\nfi`);
    return execFileSync("bash", ["-c", buildHostCapacityScript()], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
      encoding: "utf8",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("buildHostCapacityScript", () => {
  it("only reads: no command in it changes the host", () => {
    const script = buildHostCapacityScript();
    expect(script).not.toMatch(/\bqm (set|start|stop|suspend|resume|shutdown|destroy|unlock)\b/);
    expect(script).not.toMatch(/\b(rm|mv|tee|touch|mkdir|install|lvremove|lvcreate|lvextend|systemctl)\b/);
    // The only file a redirect names is /dev/null.
    expect(script.replace(/[<>]\/dev\/null/g, "")).not.toMatch(/>\s*[\/~."$]/);
    expect(script.match(/\bqm\b[^\n]*/g)).toEqual([expect.stringContaining("qm list --full 1"), expect.stringContaining("qm list <")]);
  });

  it("reads memory, the thin pool with the most VM volumes, and the VM counts", () => {
    const out = runOnFakeHost({ lvsVolumes: LVS_VOLUMES, lvsSizes: "  1843200.00|83.47\n", pvesm: PVESM, qm: QM_LIST });
    const probe = parseHostCapacityOutput(out);
    expect(probe?.pool).toEqual({ source: "lvm", name: "pve/data", sizeMb: 1_843_200, usedPercent: 83.5 });
    expect(probe?.vms).toEqual({ running: 1, paused: 1, stopped: 2 });
    expect(probe?.memTotalMb).toBeGreaterThan(0);
    expect(probe?.memAvailableMb).toBeLessThanOrEqual(probe!.memTotalMb);
  });

  it("counts paused VMs from the full listing, and falls back to the short one", () => {
    // The short listing shows a paused VM as running.
    const short = QM_LIST.replace("paused ", "running");
    expect(parseHostCapacityOutput(runOnFakeHost({ qm: QM_LIST, qmShort: short }))?.vms).toEqual({ running: 1, paused: 1, stopped: 2 });
    expect(parseHostCapacityOutput(runOnFakeHost({ qmShort: short }))?.vms).toEqual({ running: 2, paused: 0, stopped: 2 });
  });

  it("keeps its timeouts under the sweep's limit for one host", () => {
    const seconds = [...buildHostCapacityScript().matchAll(/\btimeout (\d+) /g)].map((match) => Number(match[1]));
    expect(seconds.reduce((sum, value) => sum + value, 0)).toBeLessThan(45);
  });

  it("falls back to the largest active pvesm storage when there is no thin pool", () => {
    const probe = parseHostCapacityOutput(runOnFakeHost({ pvesm: PVESM, qm: QM_LIST }));
    expect(probe?.pool).toEqual({ source: "pvesm", name: "big", sizeMb: 1_843_200, usedPercent: 90 });
  });

  it("still gives a memory reading when nothing else can be read", () => {
    const probe = parseHostCapacityOutput(runOnFakeHost({}));
    expect(probe).toMatchObject({ pool: null, vms: null });
    expect(probe?.memTotalMb).toBeGreaterThan(0);
  });
});

describe("parseHostCapacityOutput", () => {
  const MEM = "HIVRA_CAPACITY mem total_mb=128000 available_mb=64000";

  it("parses all three lines amid other output", () => {
    expect(parseHostCapacityOutput([
      "motd noise", MEM,
      "HIVRA_CAPACITY pool source=lvm name=vg0/pool size_mb=900000 used_percent=81.2",
      "HIVRA_CAPACITY vms running=12 paused=3 stopped=9", "",
    ].join("\n"))).toEqual({
      memTotalMb: 128_000,
      memAvailableMb: 64_000,
      pool: { source: "lvm", name: "vg0/pool", sizeMb: 900_000, usedPercent: 81.2 },
      vms: { running: 12, paused: 3, stopped: 9 },
    });
  });

  it.each([
    "", "nothing here", "HIVRA_CAPACITY mem total_mb=abc available_mb=1",
    "HIVRA_CAPACITY mem total_mb=0 available_mb=0", "HIVRA_CAPACITY mem total_mb=100 available_mb=200",
    "HIVRA_CAPACITY mem total_mb=100",
  ])("has no reading for %p", (stdout) => {
    expect(parseHostCapacityOutput(stdout)).toBeNull();
  });

  it.each([
    "HIVRA_CAPACITY pool source=nfs name=x size_mb=1 used_percent=1",
    "HIVRA_CAPACITY pool source=lvm name=a;b size_mb=1 used_percent=1",
    "HIVRA_CAPACITY pool source=lvm name=vg/pool size_mb=0 used_percent=1",
    "HIVRA_CAPACITY pool source=lvm name=vg/pool size_mb=10 used_percent=101",
    "HIVRA_CAPACITY pool source=lvm name=vg/pool size_mb=10 used_percent=nan",
    "HIVRA_CAPACITY vms running=1 paused=x stopped=2",
  ])("drops a malformed part and keeps the memory reading: %p", (line) => {
    expect(parseHostCapacityOutput(`${MEM}\n${line}\n`)).toEqual({
      memTotalMb: 128_000, memAvailableMb: 64_000, pool: null, vms: null,
    });
  });
});
