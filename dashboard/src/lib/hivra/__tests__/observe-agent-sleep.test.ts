jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

const mockDb: { value: unknown } = { value: null };
jest.mock("@/lib/supabase", () => ({
  get supabaseAdmin() {
    return mockDb.value;
  },
}));

import { log } from "@/lib/logger";
import { EVENT_MAX_PAGES, EVENT_PAGE_SIZE, OBSERVE_PAGE_SIZE, runObserveAgentSleepSweep } from "../observe-agent-sleep";

const NOW = Date.UTC(2026, 10, 12, 12, 0, 0);
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const HOUR = 3_600_000;

type Result = { data?: unknown; error?: unknown };
interface Call {
  table: string;
  ops: Array<[string, unknown[]]>;
}

/** A chainable stand-in for the Supabase query builder; every chain resolves to the table's next result. */
function fakeDb(results: Record<string, Result[]>) {
  const calls: Call[] = [];
  const db = {
    from(table: string) {
      const call: Call = { table, ops: [] };
      calls.push(call);
      const builder: Record<string, unknown> = {
        then(resolve: (value: Result) => unknown, reject: (reason: unknown) => unknown) {
          const queue = results[table] ?? [];
          const next: Result = (queue.length > 1 ? queue.shift() : queue[0]) ?? { data: [], error: null };
          return Promise.resolve(next).then(resolve, reject);
        },
      };
      for (const op of ["select", "eq", "is", "in", "gt", "gte", "lt", "order", "limit", "range", "insert", "delete"]) {
        builder[op] = (...args: unknown[]) => {
          call.ops.push([op, args]);
          return builder;
        };
      }
      return builder;
    },
  };
  return { db, calls };
}

const agent = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: "claude-code",
  operation_id: null,
  created_at: iso(30 * 24 * HOUR),
  always_on: false,
  sleep_policy: "off",
  ...extra,
});

const inserted = (calls: Call[]) =>
  calls
    .filter((c) => c.table === "hivra_agent_sleep_observations" && c.ops.some(([op]) => op === "insert"))
    .flatMap((c) => c.ops.find(([op]) => op === "insert")![1][0] as Array<Record<string, unknown>>);

describe("runObserveAgentSleepSweep", () => {
  afterEach(() => jest.clearAllMocks());

  it.each([undefined, "", "off", "nonsense"])("does nothing at all when HIVRA_SLEEP_MODE is %p", async (value) => {
    const { db, calls } = fakeDb({});
    mockDb.value = db;
    const summary = await runObserveAgentSleepSweep({ env: { HIVRA_SLEEP_MODE: value }, now: NOW });
    expect(summary).toMatchObject({ mode: "off", skipped: true, scanned: 0, inserted: 0, pruned: 0 });
    expect(calls).toHaveLength(0);
  });

  it("skips quietly in observe mode when the database client is missing", async () => {
    mockDb.value = null;
    const summary = await runObserveAgentSleepSweep({ env: { HIVRA_SLEEP_MODE: "observe" }, now: NOW });
    expect(summary).toMatchObject({ skipped: true, reason: "supabase_unavailable" });
    expect(log.error).toHaveBeenCalled();
  });

  it("writes one awake observation per agent, listing the signals it could not know", async () => {
    const { db, calls } = fakeDb({
      hivra_agents: [{ data: [agent("a1"), agent("a2", { type: "aeon" }), agent("a3", { always_on: true })] }],
      hivra_agent_events: [{ data: [{ agent_id: "a1", created_at: iso(HOUR) }] }],
      hivra_remote_desktop_sessions: [{ data: [] }],
      hivra_agent_sleep_observations: [{ data: [] }],
    });
    mockDb.value = db;
    const summary = await runObserveAgentSleepSweep({ env: { HIVRA_SLEEP_MODE: "observe" }, now: NOW });

    expect(summary).toMatchObject({ mode: "observe", skipped: false, scanned: 3, inserted: 3, errors: 0 });
    expect(summary.verdicts).toEqual({ awake: 1, would_nap: 0, would_hibernate: 0, ineligible: 2 });

    const rows = inserted(calls);
    expect(rows.map((r) => r.agent_id)).toEqual(["a1", "a2", "a3"]);
    const [a1, a2, a3] = rows;
    expect(a1).toMatchObject({ mode: "observe", verdict: "awake", agent_type: "claude-code", idle_seconds: 3600 });
    expect(a1.reasons).toEqual(expect.arrayContaining(["unknown_signal:openConnections", "unknown_signal:activeRun"]));
    expect(a2).toMatchObject({ verdict: "ineligible", reasons: ["autonomous_kind:aeon"] });
    expect(a3).toMatchObject({ verdict: "ineligible", reasons: ["always_on"] });
  });

  it("treats a lifecycle operation and an attached desktop as busy", async () => {
    const { db, calls } = fakeDb({
      hivra_agents: [{ data: [agent("a1", { operation_id: "op" }), agent("a2", { type: "linux-desktop" })] }],
      hivra_agent_events: [{ data: [] }],
      hivra_remote_desktop_sessions: [{ data: [{ computer_id: "a2" }] }],
    });
    mockDb.value = db;
    await runObserveAgentSleepSweep({ env: { HIVRA_SLEEP_MODE: "canary" }, now: NOW });
    const [a1, a2] = inserted(calls);
    expect(a1.reasons).toContain("operation_in_flight");
    expect(a2.reasons).toContain("desktop_attached");
    expect(a1.mode).toBe("canary");
  });

  it("never reads idle time earlier than the agent's birth", async () => {
    const { db, calls } = fakeDb({
      hivra_agents: [{ data: [agent("a1", { created_at: iso(10 * 60_000) })] }],
      hivra_agent_events: [{ data: [] }],
    });
    mockDb.value = db;
    await runObserveAgentSleepSweep({ env: { HIVRA_SLEEP_MODE: "observe" }, now: NOW });
    expect(inserted(calls)[0].idle_seconds).toBe(600);
  });

  it("keeps the events page size within the server's 1000 row cap", () => {
    expect(EVENT_PAGE_SIZE).toBeLessThanOrEqual(1000);
  });

  it("pages past a full events page instead of treating it as everything", async () => {
    const fullPage = Array.from({ length: EVENT_PAGE_SIZE }, () => ({ agent_id: "a1", created_at: iso(HOUR) }));
    const { db, calls } = fakeDb({
      hivra_agents: [{ data: [agent("a1"), agent("a2")] }],
      hivra_agent_events: [{ data: fullPage }, { data: [{ agent_id: "a2", created_at: iso(2 * HOUR) }] }],
    });
    mockDb.value = db;
    const summary = await runObserveAgentSleepSweep({ env: { HIVRA_SLEEP_MODE: "observe" }, now: NOW });
    const [a1, a2] = inserted(calls);
    expect(a1.idle_seconds).toBe(3600);
    expect(a2.idle_seconds).toBe(7200);
    expect(summary.truncated).toBe(false);
    const ranges = calls.filter((c) => c.table === "hivra_agent_events").map((c) => c.ops.find(([op]) => op === "range")![1]);
    expect(ranges).toEqual([
      [0, EVENT_PAGE_SIZE - 1],
      [EVENT_PAGE_SIZE, 2 * EVENT_PAGE_SIZE - 1],
    ]);
  });

  it("reads a full page then an empty one as complete: agents with no event are idle for the lookback", async () => {
    const fullPage = Array.from({ length: EVENT_PAGE_SIZE }, () => ({ agent_id: "a1", created_at: iso(HOUR) }));
    const { db, calls } = fakeDb({
      hivra_agents: [{ data: [agent("a1"), agent("a2")] }],
      hivra_agent_events: [{ data: fullPage }, { data: [] }],
    });
    mockDb.value = db;
    const summary = await runObserveAgentSleepSweep({ env: { HIVRA_SLEEP_MODE: "observe" }, now: NOW });
    const [, a2] = inserted(calls);
    expect(a2.idle_seconds).toBe(6 * 3600);
    expect(summary.truncated).toBe(false);
  });

  it("treats an agent with no row as unknown, not idle, when the events read is truncated", async () => {
    const fullPage = Array.from({ length: EVENT_PAGE_SIZE }, () => ({ agent_id: "a1", created_at: iso(HOUR) }));
    const { db, calls } = fakeDb({
      hivra_agents: [{ data: [agent("a1"), agent("a2")] }],
      // Every page is full of a1 events, so a2 is never seen before the page cap.
      hivra_agent_events: [{ data: fullPage }],
    });
    mockDb.value = db;
    const summary = await runObserveAgentSleepSweep({ env: { HIVRA_SLEEP_MODE: "observe" }, now: NOW });
    expect(calls.filter((c) => c.table === "hivra_agent_events")).toHaveLength(EVENT_MAX_PAGES);
    expect(summary.truncated).toBe(true);
    const [a1, a2] = inserted(calls);
    expect(a1.idle_seconds).toBe(3600);
    expect(a2).toMatchObject({ verdict: "awake", idle_seconds: null });
    expect(a2.reasons).toContain("unknown_signal:lastActivityAt");
  });

  it("leaves idle time unknown when events cannot be read", async () => {
    const { db, calls } = fakeDb({
      hivra_agents: [{ data: [agent("a1")] }],
      hivra_agent_events: [{ error: { message: "boom" } }],
    });
    mockDb.value = db;
    const summary = await runObserveAgentSleepSweep({ env: { HIVRA_SLEEP_MODE: "observe" }, now: NOW });
    const [row] = inserted(calls);
    expect(row).toMatchObject({ verdict: "awake", idle_seconds: null });
    expect(row.reasons).toContain("unknown_signal:lastActivityAt");
    expect(summary.errors).toBe(1);
  });

  it("reads only running managed agents, in pages, and never writes anywhere else", async () => {
    const page = Array.from({ length: OBSERVE_PAGE_SIZE }, (_, i) => agent(`a${String(i).padStart(4, "0")}`));
    const { db, calls } = fakeDb({
      hivra_agents: [{ data: page }, { data: [agent("z9999")] }],
      hivra_agent_events: [{ data: [] }],
    });
    mockDb.value = db;
    const summary = await runObserveAgentSleepSweep({ env: { HIVRA_SLEEP_MODE: "observe" }, now: NOW });
    expect(summary.scanned).toBe(OBSERVE_PAGE_SIZE + 1);

    const agentReads = calls.filter((c) => c.table === "hivra_agents");
    expect(agentReads).toHaveLength(2);
    expect(agentReads[0].ops).toEqual(
      expect.arrayContaining([
        ["eq", ["status", "running"]],
        ["eq", ["deployment_mode", "hivra-managed"]],
        ["is", ["deployment_target_id", null]],
      ]),
    );
    expect(agentReads[1].ops).toContainEqual(["gt", ["id", page[page.length - 1].id]]);

    const writes = calls.filter((c) => c.ops.some(([op]) => op === "insert" || op === "delete"));
    expect(writes.every((c) => c.table === "hivra_agent_sleep_observations")).toBe(true);
  });

  it("prunes observations older than 30 days", async () => {
    const { db, calls } = fakeDb({
      hivra_agents: [{ data: [] }],
      hivra_agent_sleep_observations: [{ data: [{ id: 1 }, { id: 2 }] }, { data: null }],
    });
    mockDb.value = db;
    const summary = await runObserveAgentSleepSweep({ env: { HIVRA_SLEEP_MODE: "observe" }, now: NOW });
    expect(summary.pruned).toBe(2);
    const select = calls.find((c) => c.table === "hivra_agent_sleep_observations")!;
    expect(select.ops).toContainEqual(["lt", ["observed_at", iso(30 * 24 * HOUR)]]);
    const del = calls.find((c) => c.ops.some(([op]) => op === "delete"))!;
    expect(del.ops).toContainEqual(["in", ["id", [1, 2]]]);
  });

  it("stops and reports when the agent query fails", async () => {
    const { db, calls } = fakeDb({ hivra_agents: [{ error: { message: "column always_on does not exist" } }] });
    mockDb.value = db;
    const summary = await runObserveAgentSleepSweep({ env: { HIVRA_SLEEP_MODE: "observe" }, now: NOW });
    expect(summary).toMatchObject({ scanned: 0, inserted: 0, errors: 1 });
    expect(inserted(calls)).toHaveLength(0);
  });
});
