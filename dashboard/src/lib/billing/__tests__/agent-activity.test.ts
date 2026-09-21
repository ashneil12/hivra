/**
 * Unit tests for the per-user "Your agent at work" usage surface.
 *
 * `getUserAgentActivity` reads two tables off the `supabaseAdmin` singleton:
 *   1. hermes_instances  → the user's non-deleted Hermes instance ids
 *   2. instance_usage_snapshots → daily snapshot rows for those ids
 *
 * The mock dispatches on the table name so we can feed instances + snapshot
 * rows independently, and asserts the totals sum, the daily zero-fill across
 * `days`, the by_model / skills jsonb aggregation, and that the error path
 * returns a zeroed object without throwing.
 */

interface FakeInstanceRow {
  id: string;
}

interface FakeSnapshotRow {
  stat_date: string;
  input_tokens?: number | string | null;
  output_tokens?: number | string | null;
  total_tokens?: number | string | null;
  cache_read_tokens?: number | string | null;
  reasoning_tokens?: number | string | null;
  estimated_cost_usd?: number | string | null;
  sessions?: number | string | null;
  api_calls?: number | string | null;
  tool_calls?: number | string | null;
  by_model?: unknown;
  skills?: unknown;
}

// Mutable fixtures the per-test setup writes into; the mock reads them.
let instanceRows: FakeInstanceRow[] = [];
let snapshotRows: FakeSnapshotRow[] = [];
let eventRows: unknown[] = [];
let hivraSessionRows: unknown[] = [];
let hivraFleetRows: unknown[] = [];
let throwOnTable: string | null = null;

/**
 * Filters captured per table, so a test can assert WHAT was asked for — not
 * merely what came back. The previous all-passthrough mock discarded every
 * filter, which is precisely why the Hermes-lane-only scope and the
 * deleted_at gate shipped undetected: the tests fed rows in and never noticed
 * that the query would never have selected them in production.
 */
const capturedFilters: Record<string, Array<[string, unknown]>> = {};

/**
 * A thenable query-builder stub. Filter methods record their args and return
 * `this`; awaiting the chain resolves to `{ data, error }`. `range(from, to)`
 * returns the slice so the module's explicit pagination terminates.
 */
function makeChain(rows: unknown[], table: string) {
  let from = 0;
  let to = rows.length;
  const result = () =>
    throwOnTable === table
      ? { data: null, error: { message: `boom: ${table}`, code: "XXTEST" } }
      : { data: rows.slice(from, to + 1), error: null };
  const chain: Record<string, unknown> = {};
  const record = (op: string) => (col: string, val: unknown) => {
    (capturedFilters[table] ??= []).push([`${op}:${col}`, val]);
    return chain;
  };
  const passthrough = () => chain;
  chain.select = passthrough;
  chain.eq = record("eq");
  chain.neq = record("neq");
  chain.in = record("in");
  chain.is = record("is");
  chain.gte = record("gte");
  chain.order = passthrough;
  chain.range = (f: number, t: number) => {
    from = f;
    to = t;
    return chain;
  };
  // PromiseLike: awaiting the chain resolves the query.
  chain.then = (resolve: (value: { data: unknown; error: unknown }) => unknown) =>
    Promise.resolve(result()).then(resolve);
  return chain;
}

const fakeAdmin = {
  from: (table: string) => {
    if (table === "hermes_instances") return makeChain(instanceRows, table);
    if (table === "instance_usage_snapshots") return makeChain(snapshotRows, table);
    if (table === "hivra_agent_events") return makeChain(eventRows, table);
    if (table === "hivra_remote_desktop_sessions") return makeChain(hivraSessionRows, table);
    if (table === "hivra_agents") return makeChain(hivraFleetRows, table);
    throw new Error(`unexpected table: ${table}`);
  },
};

jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: fakeAdmin,
}));

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

import {
  getUserAgentActivity,
  aggregateSnapshots,
  clampDays,
  lastNDayKeys,
} from "@/lib/billing/agent-activity";
import { SELF_HOST_USER_ID } from "@/lib/self-host/config";

const NOW = new Date("2026-06-13T12:00:00.000Z");

beforeEach(() => {
  instanceRows = [];
  snapshotRows = [];
  eventRows = [];
  hivraSessionRows = [];
  hivraFleetRows = [];
  throwOnTable = null;
  for (const key of Object.keys(capturedFilters)) delete capturedFilters[key];
});

describe("clampDays", () => {
  it("defaults to 30 and clamps to 1..90", () => {
    expect(clampDays(undefined)).toBe(30);
    expect(clampDays(null)).toBe(30);
    expect(clampDays(0)).toBe(1);
    expect(clampDays(-5)).toBe(1);
    expect(clampDays(45)).toBe(45);
    expect(clampDays(1000)).toBe(90);
    expect(clampDays(Number.NaN)).toBe(30);
  });
});

describe("lastNDayKeys", () => {
  it("returns n UTC day keys oldest→newest ending today", () => {
    const keys = lastNDayKeys(3, NOW);
    expect(keys).toEqual(["2026-06-11", "2026-06-12", "2026-06-13"]);
  });
});

describe("aggregateSnapshots", () => {
  it("zero-fills the daily series across the full range", () => {
    const dayKeys = lastNDayKeys(5, NOW);
    const out = aggregateSnapshots(
      [{ stat_date: "2026-06-12", total_tokens: 100, sessions: 2, estimated_cost_usd: 0.5 }],
      dayKeys,
      1,
      NOW
    );
    expect(out.daily).toHaveLength(5);
    expect(out.daily.map((d) => d.date)).toEqual(dayKeys);
    const filled = out.daily.find((d) => d.date === "2026-06-12")!;
    expect(filled).toEqual({ date: "2026-06-12", totalTokens: 100, sessions: 2, estimatedCostUsd: 0.5 });
    // Every other day is a zero.
    expect(out.daily.filter((d) => d.totalTokens === 0)).toHaveLength(4);
  });

  it("aggregates top models and top skills from jsonb (top 5, descending)", () => {
    const dayKeys = lastNDayKeys(3, NOW);
    const out = aggregateSnapshots(
      [
        {
          stat_date: "2026-06-12",
          by_model: { "anthropic/claude": 300, "nous/hermes": 100 },
          skills: { search: 4, deploy: 1 },
        },
        {
          stat_date: "2026-06-13",
          by_model: { "nous/hermes": 50, "openai/gpt": 600 },
          skills: ["search", "search", "summarize"],
        },
      ],
      dayKeys,
      1,
      NOW
    );
    expect(out.topModels).toEqual([
      { model: "openai/gpt", totalTokens: 600 },
      { model: "anthropic/claude", totalTokens: 300 },
      { model: "nous/hermes", totalTokens: 150 },
    ]);
    expect(out.topSkills).toEqual([
      { skill: "search", count: 6 },
      { skill: "deploy", count: 1 },
      { skill: "summarize", count: 1 },
    ]);
  });
});

describe("getUserAgentActivity", () => {
  it("sums totals across two instances' snapshot rows", async () => {
    instanceRows = [{ id: "inst-a" }, { id: "inst-b" }];
    snapshotRows = [
      {
        stat_date: "2026-06-11",
        input_tokens: 100,
        output_tokens: 40,
        total_tokens: 140,
        cache_read_tokens: 10,
        reasoning_tokens: 5,
        estimated_cost_usd: "0.12",
        sessions: 2,
        api_calls: 8,
        tool_calls: 3,
        by_model: { "nous/hermes": 140 },
        skills: { search: 2 },
      },
      {
        stat_date: "2026-06-13",
        input_tokens: "200",
        output_tokens: "60",
        total_tokens: "260",
        cache_read_tokens: 20,
        reasoning_tokens: 0,
        estimated_cost_usd: 0.38,
        sessions: 3,
        api_calls: 12,
        tool_calls: 7,
        by_model: { "openai/gpt": 260 },
        skills: ["deploy"],
      },
    ];

    const out = await getUserAgentActivity("user-1", { days: 7 }, NOW);

    expect(out.instanceCount).toBe(2);
    expect(out.totals).toEqual({
      inputTokens: 300,
      outputTokens: 100,
      totalTokens: 400,
      cacheReadTokens: 30,
      reasoningTokens: 5,
      estimatedCostUsd: 0.5,
      sessions: 5,
      apiCalls: 20,
      toolCalls: 10,
    });
    // days=7 → exactly 7 zero-filled daily points.
    expect(out.daily).toHaveLength(7);
    expect(out.activeDays).toBe(2);
    expect(out.topModels.map((m) => m.model)).toEqual(["openai/gpt", "nous/hermes"]);
    expect(out.topSkills.map((s) => s.skill).sort()).toEqual(["deploy", "search"]);
  });

  it("returns a zeroed object (no instances) when the user has none", async () => {
    instanceRows = [];
    const out = await getUserAgentActivity("user-2", { days: 14 }, NOW);
    expect(out.instanceCount).toBe(0);
    expect(out.totals.totalTokens).toBe(0);
    expect(out.daily).toHaveLength(14);
    expect(out.topModels).toEqual([]);
    expect(out.topSkills).toEqual([]);
  });

  it("keeps the self-hosted operator on a healthy empty activity state", async () => {
    // A query would fail and mark the result degraded; the self-host sentinel
    // must never be sent to the hosted UUID column.
    throwOnTable = "hermes_instances";

    const out = await getUserAgentActivity(SELF_HOST_USER_ID, { days: 30 }, NOW);

    expect(out.instanceCount).toBe(0);
    expect(out.totals.totalTokens).toBe(0);
    expect(out.degraded).not.toBe(true);
  });

  it("returns a zeroed object without throwing when a query errors", async () => {
    instanceRows = [{ id: "inst-a" }];
    throwOnTable = "instance_usage_snapshots";

    const out = await getUserAgentActivity("user-3", { days: 30 }, NOW);

    expect(out.totals.totalTokens).toBe(0);
    expect(out.daily).toHaveLength(30);
    expect(out.topModels).toEqual([]);
    expect(out.topSkills).toEqual([]);
    expect(out.generatedAt).toBe(NOW.toISOString());
  });
});

// ---------------------------------------------------------------------------
// The reported defect: a Hivra-lane customer's Activity page rendered
// "No usage yet" while their real activity sat unread in hivra_agent_events.
// ---------------------------------------------------------------------------
describe("getUserAgentActivity — Hivra lane", () => {
  const HIVRA_USER = "user_0000000000000000";

  /** This user's exact situation: Hivra boxes, zero non-deleted Hermes rows. */
  function seedHivraOnlyUser() {
    instanceRows = [];
    eventRows = [
      { id: "e1", agent_id: "a1", event: "provisioned", agent_type: "codex", created_at: "2026-06-12T10:00:00.000Z" },
      { id: "e2", agent_id: "a2", event: "launch_requested", agent_type: "linux-desktop", created_at: "2026-06-12T09:00:00.000Z" },
      { id: "e3", agent_id: null, event: "deleted", agent_type: null, created_at: "2026-06-13T08:00:00.000Z" },
    ];
    hivraSessionRows = [
      { id: "s1", computer_kind: "hivra-agent", created_at: "2026-06-13T11:00:00.000Z" },
    ];
    hivraFleetRows = [
      { id: "a1", type: "codex", status: "running", created_at: "2026-06-05T00:00:00.000Z" },
      { id: "a2", type: "linux-desktop", status: "stopped", created_at: "2026-06-06T00:00:00.000Z" },
    ];
  }

  it("reports recorded activity for a user with zero Hermes instances", async () => {
    seedHivraOnlyUser();

    const out = await getUserAgentActivity(HIVRA_USER, { days: 30 }, NOW);

    // The bug: this used to be a zeroed payload rendering "No usage yet".
    expect(out.coverage).toBe("activity");
    expect(out.hivra.eventCount).toBe(3);
    expect(out.hivra.desktopSessions).toBe(1);
    // Events fall on 06-12 (x2) and 06-13, and the session also lands on 06-13,
    // so the distinct active days are two — not one per row.
    expect(out.hivra.activeDays).toBe(2);
    expect(out.hivra.fleet.runningAgents).toBe(1);
    expect(out.hivra.fleet.totalAgents).toBe(2);
    expect(out.hivra.fleet.firstAgentAt).toBe("2026-06-05T00:00:00.000Z");
    // The Hermes half is still honestly empty, and not an error.
    expect(out.totals.totalTokens).toBe(0);
    expect(out.instanceCount).toBe(0);
    expect(out.degraded).not.toBe(true);
  });

  it("does NOT short-circuit the Hivra read when the user has no Hermes instances", async () => {
    // The old code returned early on `instanceIds.length === 0`, which would
    // have skipped the Hivra read entirely. Assert the read actually happened.
    seedHivraOnlyUser();

    await getUserAgentActivity(HIVRA_USER, { days: 30 }, NOW);

    expect(capturedFilters.hivra_agent_events).toContainEqual(["eq:user_id", HIVRA_USER]);
    expect(capturedFilters.hivra_remote_desktop_sessions).toContainEqual(["eq:user_id", HIVRA_USER]);
  });

  it("scopes every Hivra read to the caller's own user_id", async () => {
    seedHivraOnlyUser();

    await getUserAgentActivity(HIVRA_USER, { days: 30 }, NOW);

    for (const table of ["hivra_agent_events", "hivra_remote_desktop_sessions", "hivra_agents"]) {
      expect(capturedFilters[table]).toContainEqual(["eq:user_id", HIVRA_USER]);
    }
  });

  it("excludes deleted boxes from fleet truth", async () => {
    seedHivraOnlyUser();
    await getUserAgentActivity(HIVRA_USER, { days: 30 }, NOW);

    expect(capturedFilters.hivra_agents).toContainEqual(["neq:status", "deleted"]);
  });

  it("counts the window's activity by UTC day, zero-filled", async () => {
    seedHivraOnlyUser();
    const out = await getUserAgentActivity(HIVRA_USER, { days: 5 }, NOW);

    expect(out.hivra.daily).toEqual([
      { date: "2026-06-09", count: 0 },
      { date: "2026-06-10", count: 0 },
      { date: "2026-06-11", count: 0 },
      { date: "2026-06-12", count: 2 },
      { date: "2026-06-13", count: 2 },
    ]);
  });

  it("isolates a Hivra-lane failure: Hermes totals survive, payload stays non-degraded", async () => {
    // seed first — it resets the fixtures, so anything set before it is lost.
    seedHivraOnlyUser();
    instanceRows = [{ id: "inst-a" }];
    snapshotRows = [{ stat_date: "2026-06-12", total_tokens: 500, sessions: 1 }];
    throwOnTable = "hivra_agent_events";

    const out = await getUserAgentActivity("user-hybrid", { days: 30 }, NOW);

    // One telemetry table failing must not blank a page the other lane fills.
    expect(out.totals.totalTokens).toBe(500);
    expect(out.coverage).toBe("usage");
    expect(out.degraded).not.toBe(true);
    expect(out.hivra.degraded).toBe(true);
  });

  it("still degrades the whole payload when the Hermes query fails", async () => {
    seedHivraOnlyUser();
    throwOnTable = "hermes_instances";

    const out = await getUserAgentActivity("user-hybrid", { days: 30 }, NOW);

    expect(out.degraded).toBe(true);
    // ...but the Hivra half is preserved, so the page still has content, and
    // coverage must reflect that rather than falling back to 'none'.
    expect(out.hivra.eventCount).toBe(3);
    expect(out.coverage).toBe("activity");
  });

  it("reports coverage 'none' only when both lanes are genuinely empty", async () => {
    instanceRows = [];
    const out = await getUserAgentActivity("user-brand-new", { days: 30 }, NOW);

    expect(out.coverage).toBe("none");
    expect(out.hivra.eventCount).toBe(0);
    expect(out.hivra.fleet.totalAgents).toBe(0);
  });
});
