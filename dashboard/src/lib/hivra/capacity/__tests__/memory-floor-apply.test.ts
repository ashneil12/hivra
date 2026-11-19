import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildMemoryFloorHostScript, memoryFloorsMode, parseMemoryFloorReceipt, runMemoryFloorSweep,
} from "../memory-floor-apply";

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));
jest.mock("@/lib/services/proxmox-instance-service", () => ({ runProxmoxHostScript: jest.fn() }));
jest.mock("@/lib/hivra/agent-wake", () => ({ resolveSleepTarget: jest.fn() }));

const TAG = `hivra-bind-${"a".repeat(32)}`;
const NOW = Date.parse("2026-11-20T12:00:00.000Z");

describe("memoryFloorsMode", () => {
  it("is off unless set to dry, on or restore", () => {
    expect(memoryFloorsMode({})).toBe("off");
    expect(memoryFloorsMode({ HIVRA_AGENT_MEMORY_FLOORS: "1" })).toBe("off");
    expect(memoryFloorsMode({ HIVRA_AGENT_MEMORY_FLOORS: " Dry " })).toBe("dry");
    expect(memoryFloorsMode({ HIVRA_AGENT_MEMORY_FLOORS: "on" })).toBe("on");
    expect(memoryFloorsMode({ HIVRA_AGENT_MEMORY_FLOORS: "restore" })).toBe("restore");
  });
});

describe("buildMemoryFloorHostScript", () => {
  const input = { vmid: 1107, bindingTag: TAG, floorMb: 2560, expectMemoryMb: 4096 };

  it("refuses values it should never be given", () => {
    expect(() => buildMemoryFloorHostScript({ ...input, vmid: 7 })).toThrow();
    expect(() => buildMemoryFloorHostScript({ ...input, bindingTag: "x; rm -rf /" })).toThrow();
    expect(() => buildMemoryFloorHostScript({ ...input, floorMb: 512 })).toThrow();
    expect(() => buildMemoryFloorHostScript({ ...input, floorMb: 8192 })).toThrow();
    expect(() => buildMemoryFloorHostScript({ ...input, floorMb: 2560.5 })).toThrow();
  });

  it("changes only the balloon minimum, with qm bounded by a timeout", () => {
    const script = buildMemoryFloorHostScript(input);
    expect(script).not.toContain("\0");
    expect(script.match(/qm set[^\n]*/g)).toEqual(['qm set "$VMID" --balloon "$FLOOR_MB" >/dev/null 2>&1 || finish false set_failed "$BALLOON"']);
    expect(script).toContain('qm() { command timeout -k 5 30 qm "$@" </dev/null; }');
    expect(script).not.toMatch(/\bqm (start|stop|suspend|resume|shutdown|destroy|unlock|resize)\b/);
  });

  /** Runs the script against a fake qm that keeps one VM's config in a file. */
  function runOnFakeHost(config: string, over: Partial<typeof input> = {}, options: { setFails?: boolean; held?: boolean } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "hivra-floor-"));
    try {
      writeFileSync(join(dir, "config"), config);
      const tool = (name: string, body: string) => { writeFileSync(join(dir, name), `#!/bin/bash\n${body}\n`); chmodSync(join(dir, name), 0o755); };
      tool("qm", `echo "qm $*" >> "${dir}/calls"
case "$1" in
  config) cat "${dir}/config" ;;
  set) ${options.setFails ? "exit 1" : `sed -i '/^balloon:/d' "${dir}/config"; echo "balloon: $4" >> "${dir}/config"`} ;;
  *) exit 2 ;;
esac`);
      tool("install", "exit 0");
      // The script's lock files live under /run/lock; the fake flock stands in for them.
      tool("flock", options.held ? 'case "$*" in *"-n 9"*) exit 1 ;; esac; exit 0' : "exit 0");
      const script = buildMemoryFloorHostScript({ ...input, ...over })
        .replace(/\/run\/lock\//g, `${dir}/`);
      const stdout = execFileSync("bash", ["-c", script], { env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` }, encoding: "utf8" });
      let calls: string[] = [];
      try { calls = readFileSync(join(dir, "calls"), "utf8").trim().split("\n"); } catch { /* no call */ }
      return { receipt: parseMemoryFloorReceipt(stdout, 1107), calls, config: readFileSync(join(dir, "config"), "utf8") };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const CONFIG = `balloon: 4096\ncores: 2\nmemory: 4096\nname: hivra-cc-1107\ntags: hivra;${TAG}\n`;
  const sets = (calls: string[]) => calls.filter((call) => call.startsWith("qm set"));

  it("sets the floor on the agent's own VM and confirms it", () => {
    const run = runOnFakeHost(CONFIG);
    expect(run.receipt).toEqual({ ok: true, vmid: 1107, reason: "set", from: 4096, to: 2560 });
    expect(sets(run.calls)).toEqual(["qm set 1107 --balloon 2560"]);
    expect(run.config).toContain("balloon: 2560");
  });

  it("treats a VM with no balloon line as keeping its full memory, and does nothing when the floor is already there", () => {
    expect(runOnFakeHost(CONFIG.replace("balloon: 4096\n", "")).receipt).toMatchObject({ ok: true, reason: "set", from: 4096 });
    const same = runOnFakeHost(CONFIG.replace("balloon: 4096", "balloon: 2560"));
    expect(same.receipt).toEqual({ ok: true, vmid: 1107, reason: "unchanged", from: 2560, to: 2560 });
    expect(sets(same.calls)).toEqual([]);
  });

  it.each([
    ["binding_mismatch", CONFIG.replace(TAG, `hivra-bind-${"b".repeat(32)}`), {}],
    ["locked", `${CONFIG}lock: suspended\n`, {}],
    ["template", `${CONFIG}template: 1\n`, {}],
    ["memory_changed", CONFIG.replace("memory: 4096", "memory: 8192"), {}],
    ["balloon_disabled", CONFIG.replace("balloon: 4096", "balloon: 0"), {}],
    ["busy", CONFIG, { held: true }],
  ])("changes nothing and says %s", (reason, config, options) => {
    const run = runOnFakeHost(config, {}, options);
    expect(run.receipt).toMatchObject({ ok: false, reason });
    expect(sets(run.calls)).toEqual([]);
  });

  it("reports a set that failed, with the floor the VM still has", () => {
    expect(runOnFakeHost(CONFIG, {}, { setFails: true }).receipt).toEqual({ ok: false, vmid: 1107, reason: "set_failed", from: 4096, to: 4096 });
  });
});

describe("parseMemoryFloorReceipt", () => {
  it("takes exactly one well-formed line for the expected VM", () => {
    const line = 'HIVRA_FLOOR_RESULT {"ok":true,"vmid":1107,"reason":"set","from":4096,"to":2560}';
    expect(parseMemoryFloorReceipt(`noise\n${line}\n`, 1107)).toEqual({ ok: true, vmid: 1107, reason: "set", from: 4096, to: 2560 });
    expect(parseMemoryFloorReceipt(line, 1100)).toBeNull();
    expect(parseMemoryFloorReceipt(`${line}\n${line}`, 1107)).toBeNull();
    expect(parseMemoryFloorReceipt("HIVRA_FLOOR_RESULT {oops", 1107)).toBeNull();
    expect(parseMemoryFloorReceipt("", 1107)).toBeNull();
  });
});

describe("runMemoryFloorSweep", () => {
  type Row = Record<string, unknown>;
  function fakeDb(use: Row[], agents: Row[]) {
    const updates: Array<{ id: unknown; patch: Row }> = [];
    return {
      updates,
      from(table: string) {
        let rows = table === "hivra_agents" ? [...agents] : [...use];
        let patch: Row | null = null;
        const query = {
          select: () => query, order: () => query, limit: () => query,
          update: (value: Row) => { patch = value; return query; },
          eq: (column: string, value: unknown) => {
            if (patch) { updates.push({ id: value, patch }); return Promise.resolve({ error: null }); }
            rows = rows.filter((row) => row[column] === value);
            return query;
          },
          is: (column: string, value: unknown) => { rows = rows.filter((row) => (row[column] ?? null) === value); return query; },
          in: (column: string, values: unknown[]) => { rows = rows.filter((row) => values.includes(row[column])); return query; },
          then: (resolve: (value: unknown) => unknown) => resolve({ data: rows, error: null }),
        };
        return query;
      },
    };
  }
  const days = (peak: number) => ({ "2026-11-18": { peak, n: 288 }, "2026-11-19": { peak: peak - 100, n: 288 }, "2026-11-20": { peak: peak - 50, n: 144 } });
  const use = (agent_id: string, vmid: number, peak: number, over: Row = {}): Row => ({
    agent_id, vmid, total_mb: 3911, last_used_mb: peak - 200, first_sample_at: "2026-11-18T00:00:00.000Z",
    last_sample_at: new Date(NOW - 300_000).toISOString(), days: days(peak), floor_mb: null, ...over,
  });
  const agent = (id: string, vmid: number, ram: number, over: Row = {}): Row => ({
    id, vmid, ram, ram_max: null, proxmox_host: "nodea", sleep_state: "awake", status: "running", user_id: "u",
    deployment_mode: "hivra-managed", computer_substrate: "proxmox-kvm", deployment_target_id: null, ...over,
  });
  function setup(useRows: Row[], agents: Row[], receipt: (vmid: number, floor: number) => string | null = (vmid, floor) =>
    `HIVRA_FLOOR_RESULT {"ok":true,"vmid":${vmid},"reason":"set","from":0,"to":${floor}}`) {
    const db = fakeDb(useRows, agents);
    const resolveTarget = jest.fn(async (row: Row) => ({ ok: true as const, target: { vmid: row.vmid, bindingTag: TAG, env: { PROXMOX_NODE: "nodea" } } }));
    const runHostScript = jest.fn(async (script: string) => {
      const vmid = Number(/VMID=(\d+)/.exec(script)?.[1]);
      const floor = Number(/FLOOR_MB=(\d+)/.exec(script)?.[1]);
      return { ok: true, stderr: "", stdout: receipt(vmid, floor) ?? "" };
    });
    const run = (mode: string, env: Record<string, string> = {}) => runMemoryFloorSweep({
      db, env: { HIVRA_AGENT_MEMORY_FLOORS: mode, ...env }, now: () => NOW,
      runHostScript: runHostScript as never, resolveTarget: resolveTarget as never,
    });
    return { db, run, runHostScript, resolveTarget };
  }

  it("does nothing with the switch off", async () => {
    const { run, runHostScript } = setup([use("a", 1107, 900)], [agent("a", 1107, 4)]);
    expect(await run("")).toMatchObject({ skipped: true, reason: "flag_off" });
    expect(runHostScript).not.toHaveBeenCalled();
  });

  it("in dry mode reports the plan and touches no host", async () => {
    const { run, runHostScript, db } = setup([use("a", 1107, 900), use("b", 1100, 1547)], [agent("a", 1107, 4), agent("b", 1100, 2)]);
    const summary = await run("dry");
    // 900 MB peak of 4096: 1800 + 512 = 2312, up to 2368. The tight 2 GB one keeps everything.
    expect(summary).toMatchObject({ mode: "dry", considered: 2, wanted: 1, set: 0, unchanged: 1 });
    expect(summary.plan).toEqual([{ vmid: 1107, memoryMb: 4096, fromMb: 4096, toMb: 2368, peakUsedMb: 900 }]);
    expect(runHostScript).not.toHaveBeenCalled();
    expect(db.updates).toEqual([]);
  });

  it("sets the floor on the host and records it", async () => {
    const { run, runHostScript, db } = setup([use("a", 1107, 900)], [agent("a", 1107, 4)]);
    expect(await run("on")).toMatchObject({ considered: 1, wanted: 1, set: 1, errors: 0, refused: {} });
    expect(runHostScript.mock.calls[0][0]).toContain("FLOOR_MB=2368");
    expect(runHostScript.mock.calls[0][0]).toContain("EXPECT_MEMORY_MB=4096");
    expect(db.updates).toEqual([{ id: "a", patch: { floor_mb: 2368, floor_set_at: "2026-11-20T12:00:00.000Z" } }]);
  });

  it("leaves sleeping agents, agents with another VM, other hosts and thin evidence alone", async () => {
    const { run, runHostScript } = setup([
      use("nap", 1101, 900), use("rebuilt", 1102, 900), use("other", 1103, 900),
      use("new", 1104, 900, { days: { "2026-11-20": { peak: 900, n: 12 } }, first_sample_at: new Date(NOW - 3_600_000).toISOString() }),
      use("stopped", 1105, 900),
    ], [
      agent("nap", 1101, 4, { sleep_state: "napping" }), agent("rebuilt", 1999, 4), agent("other", 1103, 4, { proxmox_host: "nodeb" }),
      agent("new", 1104, 4), agent("stopped", 1105, 4, { status: "stopped" }),
    ]);
    expect(await run("on", { HIVRA_HOST_CAPACITY_HOSTS: "nodea" })).toMatchObject({ considered: 1, wanted: 0, set: 0, unchanged: 1 });
    expect(runHostScript).not.toHaveBeenCalled();
  });

  it("moves a floor only by a real step, raises without delay, and gives memory back when samples stop", async () => {
    const small = setup([use("a", 1107, 900, { floor_mb: 2432 })], [agent("a", 1107, 4)]);
    expect(await small.run("on")).toMatchObject({ wanted: 0, unchanged: 1 });
    const raise = setup([use("a", 1107, 1200, { floor_mb: 2368 })], [agent("a", 1107, 4)]);
    expect(await raise.run("on")).toMatchObject({ wanted: 1, set: 1 });
    expect(raise.runHostScript.mock.calls[0][0]).toContain("FLOOR_MB=2944");
    const stale = setup([use("a", 1107, 900, { floor_mb: 2368, last_sample_at: new Date(NOW - 48 * 3_600_000).toISOString() })], [agent("a", 1107, 4)]);
    expect(await stale.run("on")).toMatchObject({ wanted: 1, set: 1 });
    expect(stale.runHostScript.mock.calls[0][0]).toContain("FLOOR_MB=4096");
    expect(stale.db.updates[0].patch.floor_mb).toBeNull();
  });

  it("restore gives every agent with a floor its full memory back, and only those", async () => {
    const { run, runHostScript, db } = setup([use("a", 1107, 900, { floor_mb: 2368 }), use("b", 1100, 900)], [agent("a", 1107, 4), agent("b", 1100, 4)]);
    expect(await run("restore")).toMatchObject({ mode: "restore", considered: 1, set: 1 });
    expect(runHostScript).toHaveBeenCalledTimes(1);
    expect(runHostScript.mock.calls[0][0]).toContain("FLOOR_MB=4096");
    expect(db.updates[0].patch.floor_mb).toBeNull();
  });

  it("counts a refusal by reason and a missing receipt as an error, and records neither", async () => {
    const refused = setup([use("a", 1107, 900)], [agent("a", 1107, 4)], (vmid) => `HIVRA_FLOOR_RESULT {"ok":false,"vmid":${vmid},"reason":"busy","from":0,"to":0}`);
    expect(await refused.run("on")).toMatchObject({ set: 0, refused: { busy: 1 }, errors: 0 });
    expect(refused.db.updates).toEqual([]);
    const silent = setup([use("a", 1107, 900)], [agent("a", 1107, 4)], () => null);
    expect(await silent.run("on")).toMatchObject({ set: 0, errors: 1 });
    expect(silent.db.updates).toEqual([]);
  });
});
