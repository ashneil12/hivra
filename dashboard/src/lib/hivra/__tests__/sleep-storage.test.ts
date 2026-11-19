/** @jest-environment node */

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));
jest.mock("@/lib/services/proxmox-instance-service", () => ({
  runProxmoxHostScript: jest.fn(),
  runProxmoxHostScriptWithStdin: jest.fn(),
}));
jest.mock("@/lib/cold-storage-ssh", () => ({ buildColdStorageInstallScriptOrExit: () => "true" }));
jest.mock("../agent-wake", () => ({ resolveSleepTarget: jest.fn() }));

import {
  isAgentStored,
  requestAgentUnstore,
  resetSleepStorageState,
  runSleepStorage,
  sleepStoreAfterDays,
  UNSTORE_RETRY_MS,
  type SleepStorageInput,
} from "../sleep-storage";

type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;

/** A small in-memory stand-in for the two tables, with just the query shapes this code uses. */
function makeDb(seed: { agents: Row[]; jobs?: Row[]; candidates?: () => Row[] }) {
  const tables: Record<string, Row[]> = { hivra_agents: seed.agents, hivra_computer_backups: seed.jobs ?? [] };
  const rpc = jest.fn(async () => ({ data: seed.candidates ? seed.candidates() : [], error: null }));
  const from = (table: string) => {
    const filters: Filter[] = [];
    let mode: "select" | "update" | "insert" = "select";
    let patch: Row = {};
    let single = false;
    let returning = false;
    let order: { column: string; ascending: boolean } | null = null;
    let limit = Infinity;
    const resolve = () => {
      if (mode === "insert") return { data: null, error: null };
      let rows = tables[table].filter((row) => filters.every((f) => f(row)));
      if (order) {
        const { column, ascending } = order;
        rows = rows.slice().sort((a, b) => (String(a[column]) < String(b[column]) ? -1 : 1) * (ascending ? 1 : -1));
      }
      rows = rows.slice(0, limit);
      if (mode === "update") {
        for (const row of rows) Object.assign(row, patch);
        return { data: returning ? rows.map((r) => ({ id: r.id })) : null, error: null };
      }
      if (single) return { data: rows[0] ?? null, error: null };
      return { data: rows.map((r) => ({ ...r })), error: null };
    };
    const builder: Record<string, unknown> = {
      select() { if (mode === "update") returning = true; return builder; },
      update(values: Row) { mode = "update"; patch = values; return builder; },
      insert(values: Row) { mode = "insert"; tables[table].push({ ...values }); return builder; },
      eq(column: string, value: unknown) { filters.push((r) => r[column] === value); return builder; },
      neq(column: string, value: unknown) { filters.push((r) => r[column] !== value); return builder; },
      in(column: string, values: unknown[]) { filters.push((r) => values.includes(r[column])); return builder; },
      is(column: string, value: unknown) { filters.push((r) => (r[column] ?? null) === value); return builder; },
      not(column: string, _op: string, value: unknown) { filters.push((r) => (r[column] ?? null) !== value); return builder; },
      or(expr: string) {
        const columns = expr.split(",").map((term) => term.replace(/\.not\.is\.null$/, ""));
        filters.push((r) => columns.some((c) => (r[c] ?? null) !== null));
        return builder;
      },
      order(column: string, opts: { ascending: boolean }) { order = { column, ascending: opts.ascending }; return builder; },
      limit(n: number) { limit = n; return builder; },
      maybeSingle() { single = true; return Promise.resolve(resolve()); },
      then(onOk: (value: unknown) => unknown, onErr?: (reason: unknown) => unknown) {
        return Promise.resolve(resolve()).then(onOk, onErr);
      },
    };
    return builder;
  };
  return { db: { from, rpc } as unknown as SleepStorageInput["db"], tables, rpc };
}

const TAG = `hivra-bind-${"a".repeat(32)}`;
const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const DISKS = [{ key: "scsi0", sha256: "b".repeat(64), bytes: 1024, snapshotId: "c".repeat(64) }];
const ENV = { HIVRA_SLEEP_STORE_AFTER_DAYS: "7", HIVRA_COMPUTER_BACKUP_KEY: "k".repeat(40) };

const agent = (n: number, over: Row = {}): Row => ({
  id: id(n), user_id: "user_1", status: "running", sleep_state: "hibernated", operation_id: null, proxmox_host: "h1", vmid: 1000 + n,
  sleep_stored_at: null, sleep_store_job_id: null, sleep_store_tried_at: null, sleep_unstore_requested_at: null, sleep_unstore_job_id: null,
  ...over,
});

function setup(seed: Parameters<typeof makeDb>[0], over: Partial<SleepStorageInput> = {}) {
  const made = makeDb(seed);
  const started: string[] = [];
  let next = 100;
  const wake = jest.fn(async () => undefined);
  const runHostScript = jest.fn(async (_script: string) => ({ ok: true, stdout: "", stderr: "" }));
  const runHostScriptWithStdin = jest.fn(async (script: string) => {
    const job = /JOB_ID='([0-9a-f-]{36})'/.exec(script)?.[1] ?? "";
    const kind = /KIND='([a-z]+)'/.exec(script)?.[1] ?? "";
    started.push(`${kind}:${job}`);
    return { ok: true, stdout: `HIVRA_BACKUP_START {"ok":true,"reason":"started","job":"${job}"}\n`, stderr: "" };
  });
  const input: SleepStorageInput = {
    db: made.db,
    env: ENV,
    now: () => NOW,
    deadline: NOW + 250_000,
    hostActs: async () => true,
    resolveTarget: async (row) => ({ ok: true, target: { vmid: Number(row.vmid), bindingTag: TAG, env: {} } as never }),
    wake,
    runHostScript: runHostScript as never,
    runHostScriptWithStdin: runHostScriptWithStdin as never,
    newId: () => id(next++),
    ...over,
  };
  return { ...made, input, wake, runHostScript, runHostScriptWithStdin, started };
}

const finished = (job: string, status: string, reason: string) =>
  ({ ok: true, stderr: "", stdout: `HIVRA_BACKUP_JOB ${job} ${JSON.stringify({ job, kind: "x", status, reason, addedBytes: 5, disks: DISKS, finishedAt: "2026-11-18T12:00:00Z" })}\n` });

beforeEach(() => resetSleepStorageState());

describe("settings and state", () => {
  it("packs nothing unless the setting holds 1 to 365 days", () => {
    for (const value of [undefined, "", "0", "366", "x", "1.5"]) expect(sleepStoreAfterDays(value)).toBeNull();
    expect(sleepStoreAfterDays("7")).toBe(7);
  });

  it("counts an agent as stored only while it is not awake", () => {
    expect(isAgentStored(agent(1, { sleep_stored_at: "2026-11-10T00:00:00Z" }))).toBe(true);
    expect(isAgentStored(agent(1, { sleep_stored_at: "2026-11-10T00:00:00Z", sleep_state: "wake_failed" }))).toBe(true);
    expect(isAgentStored(agent(1, { sleep_stored_at: "2026-11-10T00:00:00Z", sleep_state: "awake" }))).toBe(false);
    expect(isAgentStored(agent(1))).toBe(false);
    expect(isAgentStored(null)).toBe(false);
  });

  it("notes the first request to bring an agent back and keeps it", async () => {
    const { db, tables } = makeDb({ agents: [agent(1, { sleep_stored_at: "2026-11-10T00:00:00Z" })] });
    expect(await requestAgentUnstore(db, id(1), NOW)).toBe(true);
    const first = tables.hivra_agents[0].sleep_unstore_requested_at;
    expect(first).toBe(new Date(NOW).toISOString());
    await requestAgentUnstore(db, id(1), NOW + 5000);
    expect(tables.hivra_agents[0].sleep_unstore_requested_at).toBe(first);
  });
});

describe("runSleepStorage", () => {
  it("starts packing one long sleeper per host and records the job on the agent", async () => {
    const agents = [agent(1), agent(2), agent(3, { proxmox_host: "h2" })];
    const t = setup({ agents, candidates: () => agents.map((a) => ({ id: a.id, proxmox_host: a.proxmox_host })) });
    const result = await runSleepStorage(t.input);
    expect(t.rpc).toHaveBeenCalledWith("hivra_sleep_store_candidates", {
      p_cutoff: new Date(NOW - 7 * 86_400_000).toISOString(), p_limit: 20,
    });
    expect(result.counts).toMatchObject({ storeStarted: 2, refused: 0 });
    expect(result.errors).toBe(0);
    expect(t.started.map((s) => s.split(":")[0])).toEqual(["store", "store"]);
    expect(agents[0].sleep_store_job_id).toBe(id(100));
    expect(agents[0].sleep_store_tried_at).toBe(new Date(NOW).toISOString());
    expect(agents[1].sleep_store_job_id).toBeNull();
    expect(agents[2].sleep_store_job_id).toBe(id(101));
    expect(t.tables.hivra_computer_backups.map((j) => [j.kind, j.status])).toEqual([["store", "running"], ["store", "running"]]);
    // The password goes in on stdin, never in the script.
    const [script, stdin] = t.runHostScriptWithStdin.mock.calls[0] as unknown as [string, string];
    expect(stdin).toMatch(/^[0-9a-f]{64}\n$/);
    expect(script).not.toContain(stdin.trim());
  });

  it("packs nothing with the setting off, or on a host where sleep does not act, but still loads pending work", async () => {
    const agents = [agent(1)];
    const off = setup({ agents, candidates: () => [{ id: id(1), proxmox_host: "h1" }] }, { env: { HIVRA_COMPUTER_BACKUP_KEY: "k".repeat(40) } });
    expect((await runSleepStorage(off.input)).counts.storeStarted).toBe(0);
    expect(off.rpc).not.toHaveBeenCalled();
    const elsewhere = setup({ agents, candidates: () => [{ id: id(1), proxmox_host: "h1" }] }, { hostActs: async () => false });
    expect((await runSleepStorage(elsewhere.input)).counts.storeStarted).toBe(0);
    expect(elsewhere.runHostScriptWithStdin).not.toHaveBeenCalled();
  });

  it("marks the agent stored only when the host says its disks were freed", async () => {
    const jobs = [
      { id: id(50), agent_id: id(1), kind: "store", status: "running", reason: null, disks: [], started_at: new Date(NOW - 60_000).toISOString() },
      { id: id(51), agent_id: id(2), kind: "store", status: "running", reason: null, disks: [], started_at: new Date(NOW - 60_000).toISOString() },
    ];
    const agents = [agent(1, { sleep_store_job_id: id(50) }), agent(2, { sleep_store_job_id: id(51), proxmox_host: "h2" })];
    const t = setup({ agents, jobs });
    t.runHostScript
      .mockImplementationOnce(async () => finished(id(50), "succeeded", "stored"))
      .mockImplementationOnce(async () => finished(id(51), "skipped", "changed_meanwhile"));
    const result = await runSleepStorage(t.input);
    expect(result.counts).toMatchObject({ tracked: 2, stored: 1, storeEnded: 1 });
    expect(result.errors).toBe(0);
    expect(agents[0]).toMatchObject({ sleep_store_job_id: null, sleep_stored_at: new Date(NOW).toISOString() });
    expect(agents[1]).toMatchObject({ sleep_store_job_id: null, sleep_stored_at: null });
    expect(jobs[0]).toMatchObject({ status: "succeeded", reason: "stored", disks: DISKS });
  });

  it("leaves a job that is still running alone and starts nothing else on that host", async () => {
    const jobs = [{ id: id(50), agent_id: id(1), kind: "store", status: "running", reason: null, disks: [], started_at: new Date(NOW - 60_000).toISOString() }];
    const agents = [agent(1, { sleep_store_job_id: id(50) }), agent(2)];
    const t = setup({ agents, jobs, candidates: () => [{ id: id(2), proxmox_host: "h1" }] });
    t.runHostScript.mockImplementation(async () => ({ ok: true, stderr: "", stdout: `HIVRA_BACKUP_JOB ${id(50)} running\n` }));
    const result = await runSleepStorage(t.input);
    expect(result.counts).toMatchObject({ stored: 0, storeStarted: 0 });
    expect(agents[0].sleep_store_job_id).toBe(id(50));
    expect(t.runHostScriptWithStdin).not.toHaveBeenCalled();
  });

  it("brings back an agent someone asked for, before packing anything on that host", async () => {
    const jobs = [{ id: id(40), agent_id: id(1), kind: "store", status: "succeeded", reason: "stored", disks: DISKS, started_at: "2026-11-01T00:00:00Z" }];
    const agents = [
      agent(1, { sleep_stored_at: "2026-11-01T01:00:00Z", sleep_unstore_requested_at: new Date(NOW - 10_000).toISOString() }),
      agent(2),
    ];
    const t = setup({ agents, jobs, candidates: () => [{ id: id(2), proxmox_host: "h1" }] });
    const result = await runSleepStorage(t.input);
    expect(result.counts).toMatchObject({ unstoreStarted: 1, storeStarted: 0 });
    expect(t.started).toEqual([`unstore:${id(100)}`]);
    expect(agents[0].sleep_unstore_job_id).toBe(id(100));
    const script = String(t.runHostScriptWithStdin.mock.calls[0][0]);
    expect(script).toContain(`scsi0 ${"b".repeat(64)} 1024 ${"c".repeat(64)}`);
    expect(t.tables.hivra_computer_backups[1]).toMatchObject({ kind: "unstore", status: "running", source_backup_id: id(40) });
  });

  it("wakes the agent once its disks are back and clears the storage record", async () => {
    const jobs = [{ id: id(60), agent_id: id(1), kind: "unstore", status: "running", reason: null, disks: [], started_at: new Date(NOW - 120_000).toISOString() }];
    const agents = [agent(1, { sleep_stored_at: "2026-11-01T01:00:00Z", sleep_unstore_requested_at: new Date(NOW - 130_000).toISOString(), sleep_unstore_job_id: id(60) })];
    const t = setup({ agents, jobs });
    t.runHostScript.mockImplementationOnce(async () => finished(id(60), "succeeded", "restored"));
    const result = await runSleepStorage(t.input);
    expect(result.counts).toMatchObject({ unstored: 1, unstoreFailed: 0 });
    expect(agents[0]).toMatchObject({ sleep_stored_at: null, sleep_unstore_requested_at: null, sleep_unstore_job_id: null });
    // Nothing is on its way back any more, so the sweep has no reason to look again within this run.
    expect(result.returning).toBe(0);
    expect(t.wake).toHaveBeenCalledWith(id(1));
  });

  it("keeps the request when bringing an agent back fails, reports it, and tries again after a pause", async () => {
    const jobs = [
      { id: id(40), agent_id: id(1), kind: "store", status: "succeeded", reason: "stored", disks: DISKS, started_at: "2026-11-01T00:00:00Z" },
      { id: id(60), agent_id: id(1), kind: "unstore", status: "running", reason: null, disks: [], started_at: new Date(NOW - 120_000).toISOString() },
    ];
    const agents = [agent(1, { sleep_stored_at: "2026-11-01T01:00:00Z", sleep_unstore_requested_at: new Date(NOW - 130_000).toISOString(), sleep_unstore_job_id: id(60) })];
    const t = setup({ agents, jobs });
    t.runHostScript.mockImplementationOnce(async () => finished(id(60), "failed", "download_failed"));
    const result = await runSleepStorage(t.input);
    expect(result.counts).toMatchObject({ unstored: 0, unstoreFailed: 1, unstoreStarted: 0 });
    expect(result.errors).toBe(1);
    // In its pause it is not "on its way back": looking again every few seconds would do nothing.
    expect(result.returning).toBe(0);
    expect(t.wake).not.toHaveBeenCalled();
    expect(agents[0].sleep_unstore_job_id).toBeNull();
    expect(agents[0].sleep_unstore_requested_at).not.toBeNull();
    expect(agents[0].sleep_stored_at).not.toBeNull();
    // After the pause the next run starts it again.
    const later = await runSleepStorage({ ...t.input, now: () => NOW + UNSTORE_RETRY_MS + 1, deadline: NOW + UNSTORE_RETRY_MS + 250_000 });
    expect(later.counts.unstoreStarted).toBe(1);
    // Its job is running now: worth looking again soon.
    expect(later.returning).toBe(1);
  });

  it("drops a request for an agent that is not stored, and counts a lost job as failed", async () => {
    const jobs = [{ id: id(50), agent_id: id(2), kind: "store", status: "running", reason: null, disks: [], started_at: new Date(NOW - 20 * 60_000).toISOString() }];
    const agents = [
      agent(1, { sleep_unstore_requested_at: new Date(NOW - 10_000).toISOString() }),
      agent(2, { sleep_store_job_id: id(50), proxmox_host: "h2" }),
    ];
    const t = setup({ agents, jobs });
    t.runHostScript.mockImplementation(async () => ({ ok: true, stderr: "", stdout: `HIVRA_BACKUP_JOB ${id(50)} missing\n` }));
    const result = await runSleepStorage(t.input);
    expect(agents[0].sleep_unstore_requested_at).toBeNull();
    expect(jobs[0]).toMatchObject({ status: "failed", reason: "job_lost" });
    expect(agents[1]).toMatchObject({ sleep_store_job_id: null, sleep_stored_at: null });
    expect(result.counts).toMatchObject({ storeEnded: 1, stored: 0 });
  });

  it("gives the job back when the host is busy with another job", async () => {
    const agents = [agent(1)];
    const t = setup({ agents, candidates: () => [{ id: id(1), proxmox_host: "h1" }] });
    t.runHostScriptWithStdin.mockImplementationOnce(async (script: string) => {
      const job = /JOB_ID='([0-9a-f-]{36})'/.exec(script)?.[1] ?? "";
      return { ok: true, stderr: "", stdout: `HIVRA_BACKUP_START {"ok":false,"reason":"host_busy","job":"${job}"}\n` };
    });
    const result = await runSleepStorage(t.input);
    expect(result.counts).toMatchObject({ storeStarted: 0, refused: 1 });
    expect(result.errors).toBe(0);
    expect(agents[0].sleep_store_job_id).toBeNull();
    expect(t.tables.hivra_computer_backups[0]).toMatchObject({ status: "skipped", reason: "host_busy" });
  });
});
