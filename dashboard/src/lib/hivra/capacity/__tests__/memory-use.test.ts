import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildHostCapacityScript, parseVmMemoryLines, VM_MEMORY_PROGRAM } from "../host-probe";
import {
  agentMemorySamplingEnabled, foldMemorySample, recordHostMemorySamples, summarizeMemoryUse, type StoredMemoryUse,
} from "../memory-use";
import { memoryFloorFor } from "../memory-floor";

const NOW = Date.parse("2026-11-17T12:00:00.000Z");
const HOUR = 3_600_000;
const AGENT = "00000000-0000-4000-8000-000000000001";

describe("agentMemorySamplingEnabled", () => {
  it("is on only for exactly 1", () => {
    expect(agentMemorySamplingEnabled({})).toBe(false);
    expect(agentMemorySamplingEnabled({ HIVRA_AGENT_MEMORY_SAMPLING: "true" })).toBe(false);
    expect(agentMemorySamplingEnabled({ HIVRA_AGENT_MEMORY_SAMPLING: " 1 " })).toBe(true);
  });
});

describe("parseVmMemoryLines", () => {
  it("reads used memory as total minus available, and drops lines that cannot be right", () => {
    const out = [
      "HIVRA_CAPACITY mem total_mb=128000 available_mb=64000",
      "HIVRA_CAPACITY vm id=1100 total_mb=1963 available_mb=417",
      "HIVRA_CAPACITY vm id=1107 total_mb=3911 available_mb=2924",
      "HIVRA_CAPACITY vm id=1200 total_mb=100 available_mb=200",
      "HIVRA_CAPACITY vm id=7 total_mb=100 available_mb=50",
      "HIVRA_CAPACITY vm id=1300 total_mb=abc available_mb=50",
      "HIVRA_CAPACITY vm id=1400 total_mb=4000 available_mb=1000",
      "HIVRA_CAPACITY vm id=1400 total_mb=4000 available_mb=3000",
      "not ours HIVRA_CAPACITY vm id=1500 total_mb=4000 available_mb=3000",
    ].join("\n");
    expect(parseVmMemoryLines(out)).toEqual([
      { vmid: 1100, totalMb: 1963, usedMb: 1546 },
      { vmid: 1107, totalMb: 3911, usedMb: 987 },
    ]);
    expect(parseVmMemoryLines("")).toEqual([]);
  });
});

describe("the host script", () => {
  it("asks VMs for their memory only when told to, and still only reads", () => {
    expect(buildHostCapacityScript()).not.toContain("guest-stats");
    const script = buildHostCapacityScript({ vmMemory: true });
    expect(script).toContain("guest-stats");
    expect(script).not.toContain("\0");
    expect(execFileSync("bash", ["-n"], { input: script, encoding: "utf8" })).toBe("");
    // Three read-only monitor queries, and nothing that changes a VM.
    expect(VM_MEMORY_PROGRAM.match(/call\(sock, stream, "([a-z_-]+)"/g)?.map((m) => m.split('"')[1]))
      .toEqual(["qmp_capabilities", "query-status", "qom-get"]);
    expect(VM_MEMORY_PROGRAM).not.toMatch(/qom-set|"balloon"|"stop"|"cont"|system_|guest-exec/);
  });

  const hasPython = (() => { try { execFileSync("python3", ["--version"]); return true; } catch { return false; } })();
  (hasPython ? it : it.skip)("reads a running VM over its monitor socket and skips a paused or stale one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hivra-qmp-"));
    const now = Math.floor(Date.now() / 1000);
    const server = join(dir, "server.py");
    // One fake monitor per VM: greeting, an event before an answer, then the answers.
    writeFileSync(server, String.raw`import json, os, socket, sys, threading
d, vms = sys.argv[1], json.loads(sys.argv[2])
def serve(vmid, vm):
    s = socket.socket(socket.AF_UNIX); s.bind(os.path.join(d, vmid + ".qmp")); s.listen(1)
    c, _ = s.accept(); f = c.makefile("r")
    c.sendall(b'{"QMP": {}}\n')
    for line in f:
        cmd = json.loads(line)["execute"]
        if cmd == "qmp_capabilities": r = {}
        elif cmd == "query-status": c.sendall(b'{"event": "X"}\n'); r = {"status": vm["status"]}
        else: r = {"stats": vm["stats"], "last-update": vm["updated"]}
        c.sendall((json.dumps({"return": r}) + "\n").encode())
ts = [threading.Thread(target=serve, args=kv, daemon=True) for kv in vms.items()]
[t.start() for t in ts]
print("ready", flush=True)
sys.stdin.read()
`);
    const stats = (total: number, available: number) => ({
      "stat-total-memory": total, "stat-available-memory": available, "stat-oom-kills": 18446744073709551615n.toString(),
    });
    const vms = {
      "1100": { status: "running", updated: now, stats: stats(2059206656, 437276672) },
      "1107": { status: "paused", updated: now, stats: stats(4101836800, 3066929152) },
      "1108": { status: "running", updated: now - 900, stats: stats(4101836800, 3066929152) },
      "1109": { status: "running", updated: now, stats: { "stat-total-memory": 4101836800 } },
    };
    const child = spawn("python3", [server, dir, JSON.stringify(vms)], { stdio: ["pipe", "pipe", "inherit"] });
    try {
      await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
      const out = execFileSync("python3", ["-I", "-B", "-c", VM_MEMORY_PROGRAM], {
        env: { ...process.env, HIVRA_QEMU_RUN_DIR: dir }, encoding: "utf8",
      });
      // 1100: the numbers measured on a real host, 1547 MB used of 1963.
      expect(parseVmMemoryLines(out)).toEqual([{ vmid: 1100, totalMb: 1963, usedMb: 1963 - 417 }]);
    } finally {
      child.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("foldMemorySample and summarizeMemoryUse", () => {
  const sample = (usedMb: number, vmid = 1107) => ({ vmid, totalMb: 3911, usedMb });

  it("keeps a peak and a count per day, and drops days older than the window", () => {
    let row: StoredMemoryUse | null = null;
    row = foldMemorySample(row, AGENT, sample(900), NOW - 20 * 24 * HOUR);
    row = foldMemorySample(row, AGENT, sample(1200), NOW - 2 * 24 * HOUR);
    row = foldMemorySample(row, AGENT, sample(1000), NOW - HOUR);
    row = foldMemorySample(row, AGENT, sample(800), NOW);
    expect(row.days).toEqual({ "2026-11-15": { peak: 1200, n: 1 }, "2026-11-17": { peak: 1000, n: 2 } });
    expect(row).toMatchObject({ last_used_mb: 800, total_mb: 3911, last_sample_at: "2026-11-17T12:00:00.000Z" });
    const summary = summarizeMemoryUse(row, NOW);
    expect(summary.peakUsedMb).toBe(1200);
    expect(summary.samples).toBe(3);
    // The span starts at the oldest day still kept, not at a first sample that has aged out.
    expect(summary.spanHours).toBe(60);
  });

  it("starts again when the agent has another VM, and ignores a broken stored value", () => {
    const first = foldMemorySample(null, AGENT, sample(3000), NOW - 48 * HOUR);
    const rebuilt = foldMemorySample(first, AGENT, sample(500, 1200), NOW);
    expect(rebuilt.days).toEqual({ "2026-11-17": { peak: 500, n: 1 } });
    expect(rebuilt.first_sample_at).toBe("2026-11-17T12:00:00.000Z");
    const broken = { ...first, days: { "2026-11-16": { peak: "x", n: 1 }, nope: { peak: 1, n: 1 }, "2099-01-01": { peak: 9, n: 9 } } } as unknown as StoredMemoryUse;
    expect(foldMemorySample(broken, AGENT, sample(700), NOW).days).toEqual({ "2026-11-17": { peak: 700, n: 1 } });
    expect(summarizeMemoryUse({ ...first, days: {} }, NOW)).toEqual({ peakUsedMb: null, samples: 0, spanHours: 0 });
  });

  it("feeds the floor: nothing changes until a day of samples exists", () => {
    let row: StoredMemoryUse | null = null;
    for (let i = 300; i >= 0; i -= 1) row = foldMemorySample(row, AGENT, sample(1000), NOW - i * 5 * 60_000);
    const summary = summarizeMemoryUse(row as StoredMemoryUse, NOW);
    expect(summary.samples).toBe(301);
    expect(memoryFloorFor({ memoryMb: 8192, ...summary })).toEqual({ floorMb: 2560, reason: "measured" });
    expect(memoryFloorFor({ memoryMb: 8192, ...summarizeMemoryUse(foldMemorySample(null, AGENT, sample(1000), NOW), NOW) }).reason)
      .toBe("not_enough_samples");
  });
});

describe("recordHostMemorySamples", () => {
  type Row = Record<string, unknown>;
  function fakeDb(agents: Row[], stored: Row[], fail: { agents?: boolean; write?: boolean } = {}) {
    const upserts: Row[][] = [];
    return {
      upserts,
      from(table: string) {
        let rows = table === "hivra_agents" ? [...agents] : [...stored];
        const query = {
          select: () => query,
          eq: (column: string, value: unknown) => { rows = rows.filter((row) => row[column] === value); return query; },
          neq: (column: string, value: unknown) => { rows = rows.filter((row) => row[column] !== value); return query; },
          is: (column: string, value: unknown) => { rows = rows.filter((row) => (row[column] ?? null) === value); return query; },
          in: (column: string, values: unknown[]) => { rows = rows.filter((row) => values.includes(row[column])); return query; },
          upsert: (value: Row[]) => { upserts.push(value); return Promise.resolve({ error: fail.write ? { message: "down" } : null }); },
          then: (resolve: (value: unknown) => unknown) => resolve(
            table === "hivra_agents" && fail.agents ? { data: null, error: { message: "down" } } : { data: rows, error: null },
          ),
        };
        return query;
      },
    };
  }
  const agent = (id: string, vmid: number, proxmox_host: string, over: Row = {}): Row => ({
    id, vmid, proxmox_host, status: "running", deployment_mode: "hivra-managed", computer_substrate: "proxmox-kvm",
    deployment_target_id: null, ...over,
  });
  const samples = [{ vmid: 1100, totalMb: 1963, usedMb: 1546 }, { vmid: 1107, totalMb: 3911, usedMb: 987 }, { vmid: 1999, totalMb: 4000, usedMb: 100 }];

  it("stores samples only for agents that own that VM on that host", async () => {
    const db = fakeDb([
      agent("a", 1100, "nodea"), agent("b", 1107, "nodea"),
      agent("c", 1999, "nodeb"), agent("d", 1107, "nodea", { status: "deleted" }),
    ], [{ agent_id: "b", vmid: 1107, total_mb: 3911, last_used_mb: 1500, first_sample_at: new Date(NOW - HOUR).toISOString(), last_sample_at: new Date(NOW - HOUR).toISOString(), days: { "2026-11-17": { peak: 1500, n: 4 } } }]);
    expect(await recordHostMemorySamples(db, "NodeA", samples, NOW)).toEqual({ recorded: 2, failed: false });
    expect(db.upserts).toHaveLength(1);
    expect(db.upserts[0].map((row) => [row.agent_id, row.last_used_mb, row.days])).toEqual([
      ["a", 1546, { "2026-11-17": { peak: 1546, n: 1 } }],
      ["b", 987, { "2026-11-17": { peak: 1500, n: 5 } }],
    ]);
  });

  it("gives a VM that two rows claim to neither, and reports a failed read or write without throwing", async () => {
    const twice = fakeDb([agent("a", 1100, "nodea"), agent("b", 1100, "nodea")], []);
    expect(await recordHostMemorySamples(twice, "nodea", samples, NOW)).toEqual({ recorded: 0, failed: false });
    expect(twice.upserts).toEqual([]);
    expect(await recordHostMemorySamples(fakeDb([], [], { agents: true }), "nodea", samples, NOW)).toEqual({ recorded: 0, failed: true });
    expect(await recordHostMemorySamples(fakeDb([agent("a", 1100, "nodea")], [], { write: true }), "nodea", samples, NOW))
      .toEqual({ recorded: 0, failed: true });
    expect(await recordHostMemorySamples(fakeDb([], []), "nodea", [], NOW)).toEqual({ recorded: 0, failed: false });
  });
});
