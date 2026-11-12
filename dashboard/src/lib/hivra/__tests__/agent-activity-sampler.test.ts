/** @jest-environment node */
import type { AgentActivityReading } from "../agent-cli-meta";

const mockDb: { current: unknown } = { current: null };
jest.mock("@/lib/supabase", () => ({ get supabaseAdmin() { return mockDb.current; } }));
jest.mock("@/lib/logger", () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import { agentActivitySamplingEnabled, interpretAgentActivity, runAgentActivitySampling, type StoredAgentActivity } from "../agent-activity-sampler";

const at = (iso: string) => Date.parse(iso);
const NOW = at("2026-11-05T10:20:00Z");
const quiet: AgentActivityReading = { bootId: "b1", appLastUsedAt: null, appOpenConnections: 0, runningReplies: 0, lastReplyActivityAt: null, terminalAttached: false };
const before: StoredAgentActivity = { observedAt: at("2026-11-05T10:10:00Z"), bootId: "b1", appLastUsedAt: at("2026-11-05T09:00:00Z"), lastReplyAt: at("2026-11-05T08:00:00Z"), lastUsedAt: at("2026-11-05T09:00:00Z") };
const hour = (iso: string) => at(iso);

describe("agentActivitySamplingEnabled", () => {
  it("is on only when the setting is exactly 1", () => {
    expect(agentActivitySamplingEnabled({})).toBe(false);
    expect(agentActivitySamplingEnabled({ HIVRA_AGENT_ACTIVITY_SAMPLING: "true" })).toBe(false);
    expect(agentActivitySamplingEnabled({ HIVRA_AGENT_ACTIVITY_SAMPLING: "1" })).toBe(true);
  });
});

describe("interpretAgentActivity", () => {
  it("finds nothing in a quiet reading and keeps the last known use", () => {
    expect(interpretAgentActivity(before, { ...quiet, appLastUsedAt: before.appLastUsedAt, lastReplyActivityAt: before.lastReplyAt }, NOW))
      .toEqual({ active: false, lastUsedAt: before.lastUsedAt, usedHours: [] });
    expect(interpretAgentActivity(null, quiet, NOW)).toEqual({ active: false, lastUsedAt: null, usedHours: [] });
  });

  it.each([
    ["an open app connection", { appOpenConnections: 1 }],
    ["a reply being written", { runningReplies: 2 }],
    ["an attached terminal", { terminalAttached: true }],
  ])("counts %s as in use now", (_case, extra) => {
    expect(interpretAgentActivity(before, { ...quiet, ...extra }, NOW))
      .toEqual({ active: true, lastUsedAt: NOW, usedHours: [hour("2026-11-05T10:00:00Z")] });
  });

  it("places app use since the previous reading in the hour it happened", () => {
    const seen = interpretAgentActivity({ ...before, observedAt: at("2026-11-05T09:50:00Z") }, { ...quiet, appLastUsedAt: at("2026-11-05T09:55:00Z") }, NOW);
    expect(seen).toEqual({ active: true, lastUsedAt: at("2026-11-05T09:55:00Z"), usedHours: [hour("2026-11-05T09:00:00Z")] });
  });

  it("treats the first reading after a restart, and the first reading ever, as a baseline for app use", () => {
    // The connection service's own start counts as a use, so its time alone proves nothing.
    const fresh = { ...quiet, bootId: "b2", appLastUsedAt: at("2026-11-05T10:18:00Z") };
    expect(interpretAgentActivity(before, fresh, NOW).active).toBe(false);
    expect(interpretAgentActivity(null, fresh, NOW).active).toBe(false);
    expect(interpretAgentActivity({ ...before, appLastUsedAt: null }, { ...fresh, bootId: "b1" }, NOW).active).toBe(false);
  });

  it("counts a new reply, also on the first reading when it is recent", () => {
    const replied = { ...quiet, lastReplyActivityAt: at("2026-11-05T10:12:00Z") };
    expect(interpretAgentActivity(before, replied, NOW)).toEqual({ active: true, lastUsedAt: at("2026-11-05T10:12:00Z"), usedHours: [hour("2026-11-05T10:00:00Z")] });
    expect(interpretAgentActivity(null, replied, NOW).active).toBe(true);
    // The same reply seen again is not new.
    expect(interpretAgentActivity({ ...before, lastReplyAt: replied.lastReplyActivityAt }, replied, NOW).active).toBe(false);
  });

  it("leaves out history and times from the future", () => {
    // Days-old replies on a first reading are history.
    expect(interpretAgentActivity(null, { ...quiet, lastReplyActivityAt: at("2026-11-01T10:00:00Z") }, NOW).active).toBe(false);
    // A clock far ahead of ours is not believed; one slightly ahead is placed at now.
    expect(interpretAgentActivity(before, { ...quiet, lastReplyActivityAt: at("2026-11-05T12:00:00Z") }, NOW).active).toBe(false);
    expect(interpretAgentActivity(before, { ...quiet, lastReplyActivityAt: NOW + 60_000 }, NOW)).toMatchObject({ active: true, lastUsedAt: NOW });
  });

  it("counts each hour once when several signals fall in it, and both hours when they differ", () => {
    const seen = interpretAgentActivity(before, { ...quiet, appOpenConnections: 3, appLastUsedAt: at("2026-11-05T09:58:00Z"), lastReplyActivityAt: at("2026-11-05T10:01:00Z") }, NOW);
    expect(seen.usedHours).toEqual([hour("2026-11-05T09:00:00Z"), hour("2026-11-05T10:00:00Z")]);
    expect(seen.lastUsedAt).toBe(NOW);
  });
});

type Row = Record<string, unknown>;

function fakeDb(tables: Record<string, Row[] | Error>, rpcError: string | null = null) {
  const rpc = jest.fn<Promise<{ error: { message: string } | null }>, [string, Row]>(async () => ({ error: rpcError ? { message: rpcError } : null }));
  const filters: Array<{ table: string; method: string; args: unknown[] }> = [];
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const method of ["select", "eq", "is", "not", "order"]) {
      chain[method] = (...args: unknown[]) => { filters.push({ table, method, args }); return chain; };
    }
    chain.range = async (start: number, end: number) => {
      const rows = tables[table] ?? [];
      return rows instanceof Error ? { data: null, error: { message: rows.message } } : { data: rows.slice(start, end + 1), error: null };
    };
    return chain;
  };
  return { db: { from, rpc }, rpc, filters };
}

const agentRow = (id: string, type: string, extra: Row = {}): Row => ({
  id, user_id: `owner-of-${id}`, type, chat_url: `https://${id}.hivra.example`, cf_hostname: `${id}.hivra.example`,
  api_token: "a".repeat(64), computer_profile: null, computer_substrate: null, ...extra,
});

describe("runAgentActivitySampling", () => {
  const on = { HIVRA_AGENT_ACTIVITY_SAMPLING: "1" };
  afterEach(() => { mockDb.current = null; });

  it("reads nothing while the setting is off", async () => {
    const { db, rpc } = fakeDb({ hivra_agents: [agentRow("a1", "hermes")] });
    mockDb.current = db;
    const read = jest.fn();
    expect(await runAgentActivitySampling({ env: {}, read })).toEqual({ enabled: false, scanned: 0, sampled: 0, active: 0, unreachable: 0, notReached: 0, failed: 0 });
    expect(read).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("stores each reading against the previous one, and an unreachable computer as unreachable", async () => {
    const { db, rpc, filters } = fakeDb({
      hivra_agents: [
        agentRow("claw", "openclaw"), agentRow("coder", "claude-code"), agentRow("down", "hermes"),
        agentRow("generic", "generic"), agentRow("other-substrate", "hermes", { computer_substrate: "docker" }),
      ],
      hivra_agent_activity: [
        { agent_id: "claw", observed_at: "2026-11-05T10:10:00Z", boot_id: "b1", app_last_used_at: "2026-11-05T09:00:00Z", last_reply_at: null, last_used_at: "2026-11-05T09:00:00Z" },
      ],
    });
    mockDb.current = db;
    const read = jest.fn(async (target: { chatUrl: unknown }): Promise<AgentActivityReading | null> => {
      if (String(target.chatUrl).includes("down")) return null;
      if (String(target.chatUrl).includes("claw")) return { ...quiet, appLastUsedAt: at("2026-11-05T10:15:00Z") };
      return { ...quiet, bootId: "c1", appOpenConnections: null, terminalAttached: null };
    });

    const summary = await runAgentActivitySampling({ env: on, now: () => NOW, read });

    expect(summary).toEqual({ enabled: true, scanned: 3, sampled: 2, active: 1, unreachable: 1, notReached: 0, failed: 0 });
    // Agents Hivra cannot read (another kind, another substrate) are never contacted.
    expect(read).toHaveBeenCalledTimes(3);
    expect(read.mock.calls[0][0]).toMatchObject({ apiToken: "a".repeat(64), subject: { gatewayKind: expect.any(String) } });
    const stored = Object.fromEntries(rpc.mock.calls.map(([name, args]) => {
      expect(name).toBe("hivra_record_agent_activity");
      return [args.p_agent_id, args];
    }));
    expect(stored.claw).toEqual({
      p_agent_id: "claw", p_user_id: "owner-of-claw", p_agent_type: "openclaw", p_observed_at: "2026-11-05T10:20:00.000Z", p_reachable: true,
      p_boot_id: "b1", p_app_last_used_at: "2026-11-05T10:15:00.000Z", p_last_reply_at: null, p_last_used_at: "2026-11-05T10:15:00.000Z",
      p_open_connections: 0, p_active_runs: 0, p_terminal_attached: false, p_used_hours: ["2026-11-05T10:00:00.000Z"],
    });
    expect(stored.coder).toMatchObject({ p_reachable: true, p_boot_id: "c1", p_open_connections: null, p_terminal_attached: null, p_last_used_at: null, p_used_hours: [] });
    expect(stored.down).toEqual({ p_agent_id: "down", p_user_id: "owner-of-down", p_agent_type: "hermes", p_observed_at: "2026-11-05T10:20:00.000Z", p_reachable: false });
    // The bearer is handed to the reader only, never stored.
    expect(JSON.stringify(rpc.mock.calls)).not.toContain("a".repeat(64));
    expect(filters).toContainEqual({ table: "hivra_agents", method: "eq", args: ["status", "running"] });
  });

  it("reads the longest unread agents first and leaves the rest when time runs out", async () => {
    const { db, rpc } = fakeDb({
      hivra_agents: [agentRow("recent", "hermes"), agentRow("never", "hermes"), agentRow("old", "hermes")],
      hivra_agent_activity: [
        { agent_id: "recent", observed_at: "2026-11-05T10:19:00Z" },
        { agent_id: "old", observed_at: "2026-11-05T08:00:00Z" },
      ],
    });
    mockDb.current = db;
    let clock = NOW;
    const order: string[] = [];
    const read = jest.fn(async (target: { chatUrl: unknown }) => {
      order.push(String(target.chatUrl));
      clock += 30_000; // each computer takes far too long
      return quiet;
    });

    const summary = await runAgentActivitySampling({ env: on, now: () => clock, read });

    expect(order[0]).toContain("never");
    expect(summary.sampled + summary.notReached).toBe(3);
    expect(summary.notReached).toBeGreaterThan(0);
    expect(rpc).toHaveBeenCalledTimes(summary.sampled);
  });

  it("reads no agent when the previous readings cannot be read, and counts readings it could not store", async () => {
    const broken = fakeDb({ hivra_agents: [agentRow("a1", "hermes")], hivra_agent_activity: new Error("permission denied") });
    mockDb.current = broken.db;
    const read = jest.fn(async () => quiet);
    expect(await runAgentActivitySampling({ env: on, now: () => NOW, read })).toMatchObject({ scanned: 1, sampled: 0 });
    expect(read).not.toHaveBeenCalled();

    const failing = fakeDb({ hivra_agents: [agentRow("a1", "hermes")] }, "function does not exist");
    mockDb.current = failing.db;
    expect(await runAgentActivitySampling({ env: on, now: () => NOW, read })).toMatchObject({ sampled: 1, failed: 1 });
  });
});
