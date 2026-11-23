/** @jest-environment node */

const mockDb: { current: unknown } = { current: null };
jest.mock("@/lib/supabase", () => ({ get supabaseAdmin() { return mockDb.current; } }));
jest.mock("@/lib/logger", () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import { readSurfaceWatchdogFromBox, type SurfaceWatchdogReading } from "@/lib/hivra/agent-cli-meta";
import { opsEventForWatchdogEvent, runSurfaceWatchdogSweep } from "../hivra-surface-watchdog-sweep";

const HOST = "box-7f3a.hivra.example";
const ORIGIN = `https://${HOST}`;
const TOKEN = "a".repeat(64);
const CURRENT_META = { agentKind: "agent-zero", surfaceAuth: "post-cookie-v1", bootId: "95cd11d8e6b99c5b1d212a07568d2d73" };

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    ...init,
  });
}

const watchdogTarget = { chatUrl: ORIGIN, cfHostname: HOST, apiToken: TOKEN };

function event(id: string, type: string, extra: Record<string, unknown> = {}) {
  return { id, at: "2026-11-15T17:30:00.000Z", type, ...extra };
}

const reportBody = (events: unknown[], extra: Record<string, unknown> = {}) => ({
  ok: true,
  agentKind: "agent-zero",
  updatedAt: "2026-11-15T17:30:05.000Z",
  surface: { status: "ok", reason: null, restarts: 0 },
  events,
  ...extra,
});

describe("readSurfaceWatchdogFromBox", () => {
  it("reads the watchdog report with the bearer after the public meta proves a current connection service", async () => {
    const fetcher = jest.fn(async (url: string, init?: RequestInit) => {
      const authorized = new Headers(init?.headers).get("authorization") === `Bearer ${TOKEN}`;
      if (url === `${ORIGIN}/api/meta`) return json(CURRENT_META);
      if (url === `${ORIGIN}/api/surface-watchdog` && authorized) {
        return json(reportBody([event("e1-1", "unit_failing", { unit: "bux-browser-keeper.service", reason: "failed", nRestarts: 3864 })]));
      }
      return json({ error: "nope" }, { status: 404 });
    });
    const reading = await readSurfaceWatchdogFromBox(watchdogTarget, fetcher);
    expect(reading).toEqual({
      observation: "reported",
      report: {
        agentKind: "agent-zero",
        updatedAt: "2026-11-15T17:30:05.000Z",
        surface: { status: "ok", reason: null, restarts: 0 },
        events: [{ id: "e1-1", at: "2026-11-15T17:30:00.000Z", type: "unit_failing", unit: "bux-browser-keeper.service", reason: "failed", nRestarts: 3864 }],
      },
    });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([`${ORIGIN}/api/meta`, `${ORIGIN}/api/surface-watchdog`]);
    // The bearer never leaves the server in the result.
    expect(JSON.stringify(reading)).not.toContain(TOKEN);
  });

  it("marks every request as a Hivra background read, so the host wake proxy never counts it as use", async () => {
    const fetcher = jest.fn<Promise<Response>, [string, RequestInit?]>(async (url: string) =>
      url.endsWith("/api/meta") ? json(CURRENT_META) : json(reportBody([])));
    expect((await readSurfaceWatchdogFromBox(watchdogTarget, fetcher)).observation).toBe("reported");
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [, init] of fetcher.mock.calls) expect(new Headers(init?.headers).get("x-hivra-background")).toBe("1");
  });

  it("reads a 404 as not_installed — a gateway that predates the endpoint", async () => {
    const fetcher = jest.fn(async (url: string, init?: RequestInit) => {
      if (url === `${ORIGIN}/api/meta`) return json(CURRENT_META);
      const authorized = new Headers(init?.headers).get("authorization") === `Bearer ${TOKEN}`;
      return json({ error: "not_installed" }, { status: authorized ? 404 : 401 });
    });
    expect(await readSurfaceWatchdogFromBox(watchdogTarget, fetcher)).toEqual({ observation: "not_installed" });
  });

  it.each([
    ["an older connection service", { agentKind: "agent-zero" }],
    ["a malformed report", reportBody([], { surface: null })],
    ["a report with a malformed event", reportBody([{ id: "not-an-id", type: "unit_failing" }])],
    ["a report with an unknown event type", reportBody([event("e2-1", "kernel_panic")])],
  ])("reads %s as unreachable", async (_case, body) => {
    const fetcher = jest.fn(async (url: string) =>
      json(url.endsWith("/api/meta") ? body : body));
    expect(await readSurfaceWatchdogFromBox(watchdogTarget, fetcher)).toEqual({ observation: "unreachable" });
  });

  it("never sends the bearer to a reply that does not prove the connection service", async () => {
    const fetcher = jest.fn<Promise<Response>, [string, RequestInit?]>(async () => json({ agentKind: "agent-zero" }));
    await readSurfaceWatchdogFromBox(watchdogTarget, fetcher);
    const sentBearer = fetcher.mock.calls.some(([, init]) => new Headers(init?.headers).has("authorization"));
    expect(sentBearer).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("refuses a malformed bearer without any request", async () => {
    const fetcher = jest.fn(async () => json(CURRENT_META));
    expect(await readSurfaceWatchdogFromBox({ ...watchdogTarget, apiToken: "box-token" }, fetcher))
      .toEqual({ observation: "unreachable" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("opsEventForWatchdogEvent", () => {
  const row = { id: "agent-1", user_id: "owner-1", type: "agent-zero" };

  it("maps the crash-looping unit receipt the incident missed to a warn carrying the unit and its restart count", () => {
    const ops = opsEventForWatchdogEvent(row, event("e3-1", "unit_failing", { unit: "bux-browser-keeper.service", reason: "failed", nRestarts: 3864 }));
    expect(ops.severity).toBe("warn");
    expect(ops.source).toBe("box.surface_watchdog.unit_failing");
    expect(ops.title).toContain("bux-browser-keeper.service");
    expect(ops.title).toContain("e3-1");
    expect(ops.message).toContain("3864");
    expect(ops.userId).toBe("owner-1");
    expect(ops.instanceId).toBe("agent-1");
  });

  it("maps restart / exhausted / recovered to their severities and keeps each event id unique in the title", () => {
    const restart = opsEventForWatchdogEvent(row, event("e9-4", "unit_restart", { unit: "hivra-agent-zero.service", kind: "agent-zero", attempt: 2, downForS: 660, reason: "csrf answered HTTP 502" }));
    expect(restart.severity).toBe("warn");
    expect(restart.message).toContain("attempt 2");
    const exhausted = opsEventForWatchdogEvent(row, event("e9-9", "recovery_exhausted", { unit: "hivra-agent-zero.service", restarts: 3, downForS: 4000 }));
    expect(exhausted.severity).toBe("error");
    const recovered = opsEventForWatchdogEvent(row, event("e9-12", "recovered", { unit: "hivra-agent-zero.service", downForS: 4200 }));
    expect(recovered.severity).toBe("info");
    // Event ids differ -> different fingerprints, so each box event is one ops row.
    const titles = [restart, exhausted, recovered].map((ops) => ops.title);
    expect(new Set(titles).size).toBe(3);
  });
});

type Row = Record<string, unknown>;

/**
 * Table-aware fake: hivra_agents returns `rows` for the candidate query;
 * ops_events answers the relay-dedupe lookup from `storedTitles` — the set a
 * real reportOpsEvent INSERT would have written. Tests populate it via the
 * `report` mock so a second sweep sees the same receipts as already stored.
 */
function fakeDb(rows: Row[] | Error, opts: { storedTitles?: Set<string> } = {}) {
  const storedTitles = opts.storedTitles ?? new Set<string>();
  const agentChain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "is", "not", "order"]) {
    agentChain[method] = () => agentChain;
  }
  agentChain.limit = async () => rows instanceof Error
    ? { data: null, error: { message: rows.message } }
    : { data: rows, error: null };

  const opsChain: Record<string, unknown> = {};
  for (const method of ["select", "eq"]) {
    opsChain[method] = () => opsChain;
  }
  opsChain.in = async (_column: string, values: string[]) => ({
    data: values.filter((title) => storedTitles.has(title)).map((title) => ({ title })),
    error: null,
  });

  return { from: (table: string) => (table === "ops_events" ? opsChain : agentChain) };
}

const agentRow = (id: string, extra: Row = {}): Row => ({
  id,
  user_id: `owner-of-${id}`,
  type: "agent-zero",
  chat_url: `https://${id}.hivra.example`,
  cf_hostname: `${id}.hivra.example`,
  api_token: "b".repeat(64),
  ...extra,
});

const reported = (events: ReturnType<typeof event>[]): SurfaceWatchdogReading => ({
  observation: "reported",
  report: { agentKind: "agent-zero", updatedAt: "2026-11-15T17:30:05.000Z", surface: { status: "ok", reason: null, restarts: 0 }, events },
});

describe("runSurfaceWatchdogSweep", () => {
  beforeEach(() => {
    mockDb.current = null;
  });

  it("relays a box's watchdog events to ops_events", async () => {
    mockDb.current = fakeDb([agentRow("a1")]);
    const reportedOps: unknown[] = [];
    const summary = await runSurfaceWatchdogSweep({
      read: async () => reported([
        event("e1-1", "unit_failing", { unit: "bux-browser-keeper.service", reason: "failed", nRestarts: 3864 }),
        event("e1-2", "unit_restart", { unit: "hivra-agent-zero.service", attempt: 1, ok: true }),
      ]),
      report: async (ops) => { reportedOps.push(ops); return { id: "evt-x", fingerprint: "x" }; },
    });
    expect(summary).toMatchObject({ scanned: 1, reported: 1, relayed: 2, failed: 0 });
    expect(reportedOps.map((ops) => (ops as { title: string }).title)).toEqual([
      expect.stringContaining("e1-1"),
      expect.stringContaining("e1-2"),
    ]);
  });

  it("relays at most the newest events per box so a long-unswept box cannot burst ops rows", async () => {
    mockDb.current = fakeDb([agentRow("a1")]);
    const reportedOps: unknown[] = [];
    const events = Array.from({ length: 15 }, (_, i) => event(`e1-${i + 1}`, "unit_failing", { unit: "bux-x.service" }));
    const summary = await runSurfaceWatchdogSweep({
      read: async () => reported(events),
      report: async (ops) => { reportedOps.push(ops); return { id: "evt-x", fingerprint: "x" }; },
    });
    expect(summary.relayed).toBe(10);
    // The newest 10: e1-6 .. e1-15.
    const titles = reportedOps.map((ops) => (ops as { title: string }).title);
    expect(titles[0]).toContain("e1-6");
    expect(titles[9]).toContain("e1-15");
  });

  it("relays each box event once — a second sweep over the same receipts makes zero reportOpsEvent calls", async () => {
    // Regression: the relay re-read the box's whole receipt list every sweep
    // and each re-read took reportOpsEvent's UPDATE branch, bumping
    // last_seen_at + occurrence_count so an old outage looked current.
    const storedTitles = new Set<string>();
    mockDb.current = fakeDb([agentRow("a1")], { storedTitles });
    const events = [
      event("e7-1", "unit_restart", { unit: "hivra-agent-zero.service", attempt: 1, ok: true }),
      event("e7-2", "recovered", { unit: "hivra-agent-zero.service" }),
    ];
    const report = jest.fn(async (ops: { title: string }) => {
      storedTitles.add(ops.title);
      return { id: "evt-x", fingerprint: "x" };
    });
    const read = async () => reported(events);

    const first = await runSurfaceWatchdogSweep({ read, report });
    expect(first).toMatchObject({ reported: 1, relayed: 2, failed: 0 });

    const second = await runSurfaceWatchdogSweep({ read, report });
    expect(second).toMatchObject({ reported: 1, relayed: 0, failed: 0 });
    expect(report).toHaveBeenCalledTimes(2);
  });

  it("still relays when the dedupe lookup itself fails (delivery over count accuracy)", async () => {
    mockDb.current = {
      from: (table: string) => {
        if (table !== "ops_events") return fakeDb([agentRow("a1")]).from(table);
        const chain: Record<string, unknown> = {};
        for (const method of ["select", "eq"]) chain[method] = () => chain;
        chain.in = async () => ({ data: null, error: { message: "lookup boom" } });
        return chain;
      },
    };
    const report = jest.fn(async () => ({ id: "evt-x", fingerprint: "x" }));
    const summary = await runSurfaceWatchdogSweep({
      read: async () => reported([event("e8-1", "unit_failing", { unit: "x.service" })]),
      report,
    });
    expect(summary.relayed).toBe(1);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("treats a gateway without the endpoint as not_installed and emits no ops row", async () => {
    mockDb.current = fakeDb([agentRow("old-box")]);
    const report = jest.fn();
    const summary = await runSurfaceWatchdogSweep({ read: async () => ({ observation: "not_installed" }), report });
    expect(summary).toMatchObject({ scanned: 1, notInstalled: 1, relayed: 0 });
    expect(report).not.toHaveBeenCalled();
  });

  it("treats an unreadable box as unreachable and emits no ops row (the health crons own that)", async () => {
    mockDb.current = fakeDb([agentRow("down-box")]);
    const report = jest.fn();
    const summary = await runSurfaceWatchdogSweep({ read: async () => ({ observation: "unreachable" }), report });
    expect(summary).toMatchObject({ scanned: 1, unreachable: 1, relayed: 0 });
    expect(report).not.toHaveBeenCalled();
  });

  it("counts a throwing read as failed and keeps sweeping the rest", async () => {
    mockDb.current = fakeDb([agentRow("a1"), agentRow("a2")]);
    const report = jest.fn(async () => ({ id: "evt-x", fingerprint: "x" }));
    const reads: string[] = [];
    const summary = await runSurfaceWatchdogSweep({
      read: async (target) => {
        reads.push(String(target.chatUrl));
        if (String(target.chatUrl).includes("a1")) throw new Error("boom");
        return reported([event("e2-1", "recovered", { unit: "hivra-agent-zero.service" })]);
      },
      report,
    });
    expect(summary).toMatchObject({ scanned: 2, reported: 1, relayed: 1, failed: 1 });
    expect(reads).toHaveLength(2);
  });

  it("counts a failed ops insert without losing the rest of the box's events", async () => {
    mockDb.current = fakeDb([agentRow("a1")]);
    let calls = 0;
    const summary = await runSurfaceWatchdogSweep({
      read: async () => reported([event("e4-1", "unit_failing"), event("e4-2", "unit_failing")]),
      report: async () => { calls += 1; if (calls === 1) throw new Error("db down"); return { id: "evt-x", fingerprint: "x" }; },
    });
    expect(summary).toMatchObject({ relayed: 1, failed: 1 });
  });

  it("counts a report that returns no persisted id as failed, not relayed", async () => {
    // reportOpsEvent answers null when the ops_events write itself failed —
    // the receipt was never stored, so the sweep must not count it relayed
    // or the route heartbeat reads clean while events are being lost.
    mockDb.current = fakeDb([agentRow("a1")]);
    const summary = await runSurfaceWatchdogSweep({
      read: async () => reported([event("e9-1", "unit_failing", { unit: "x.service" })]),
      report: async () => null,
    });
    expect(summary).toMatchObject({ reported: 1, relayed: 0, failed: 1 });
  });

  it("does nothing without the admin client", async () => {
    const summary = await runSurfaceWatchdogSweep({ read: async () => { throw new Error("must not be called"); } });
    expect(summary).toMatchObject({ scanned: 0, relayed: 0, failed: 0 });
  });
});
