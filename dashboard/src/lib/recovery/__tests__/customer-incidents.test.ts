/** @jest-environment node */

const mockDb: { current: unknown } = { current: null };
jest.mock("@/lib/supabase", () => ({ get supabaseAdmin() { return mockDb.current; } }));
jest.mock("@/lib/logger", () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import {
  buildIncidentMetadata,
  cronPeriodMinutes,
  cronSchedulesFromVercel,
  evaluateCustomerIncidents,
  incidentOpsEvent,
  incidentPagingEnabled,
  probeAgentPublicSurface,
  runCustomerIncidentScan,
  sortWatchdogEventsByEventAt,
  type CronHeartbeatSnapshot,
  type CronScheduleInfo,
  type HivraAgentSnapshot,
  type HermesInstanceSnapshot,
  type IncidentEvaluationInput,
  type WatchdogEventSnapshot,
} from "../customer-incidents";

const NOW = Date.parse("2026-11-22T12:00:00.000Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const MIN = 60 * 1000;

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Snapshot factories (pure evaluation inputs)
// ---------------------------------------------------------------------------

function agent(over: Partial<HivraAgentSnapshot> = {}): HivraAgentSnapshot {
  return {
    id: "agent-1",
    userId: "user-1",
    type: "agent-zero",
    name: "Box",
    status: "running",
    sleepState: "awake",
    desiredState: "running",
    createdAt: iso(30 * 24 * 60 * MIN),
    provisionedAt: iso(30 * 24 * 60 * MIN - 5 * MIN),
    operationKind: null,
    operationStartedAt: null,
    operationId: null,
    error: null,
    cfHostname: "box-1.hivra.example",
    chatUrl: "https://box-1.hivra.example/",
    proxmoxHost: "pve-1",
    vmid: 101,
    ip: "192.0.2.5",
    ...over,
  };
}

function instance(over: Partial<HermesInstanceSnapshot> = {}): HermesInstanceSnapshot {
  return {
    id: "inst-1",
    userId: "user-2",
    name: "Old Instance",
    status: "running",
    lifecycleState: "active",
    gatewayUrl: "https://inst-1.hivra.example",
    createdAt: iso(30 * 24 * 60 * MIN),
    ...over,
  };
}

function watchdogEvent(over: Partial<WatchdogEventSnapshot> = {}): WatchdogEventSnapshot {
  return {
    eventId: "e1-1",
    eventType: "unit_restart",
    eventAt: iso(30 * MIN),
    firstSeenAt: iso(30 * MIN),
    unit: "hivra-agent-zero.service",
    kind: "agent-zero",
    reason: null,
    downForS: null,
    nRestarts: null,
    attempt: 1,
    restarts: null,
    ok: true,
    ...over,
  };
}

function heartbeat(over: Partial<CronHeartbeatSnapshot> = {}): CronHeartbeatSnapshot {
  return {
    cronName: "test-cron",
    lastRunAt: iso(5 * MIN),
    lastSuccessAt: iso(5 * MIN),
    runCount: 100,
    okCount: 100,
    consecutiveFailures: 0,
    lastDetail: null,
    createdAt: null,
    ...over,
  };
}

function evalInput(over: Partial<IncidentEvaluationInput> = {}): IncidentEvaluationInput {
  return {
    now: NOW,
    adminUserIds: new Set<string>(),
    agents: [],
    watchdogEventsByAgent: new Map<string, WatchdogEventSnapshot[]>(),
    watchdogUnknownAgentIds: new Set<string>(),
    hermesInstances: [],
    heartbeats: [],
    cronSchedules: new Map<string, CronScheduleInfo>(),
    ...over,
  };
}

// ---------------------------------------------------------------------------
// evaluateCustomerIncidents — box_down
// ---------------------------------------------------------------------------

describe("evaluateCustomerIncidents box_down", () => {
  it("fires when the latest watchdog event by event_at is a down-type older than 10 minutes", () => {
    const a = agent();
    const result = evaluateCustomerIncidents(evalInput({
      agents: [a],
      watchdogEventsByAgent: new Map([[a.id, [
        watchdogEvent({ eventType: "recovered", eventAt: iso(60 * MIN), eventId: "e1-0" }),
        watchdogEvent({ eventType: "gateway_down", eventAt: iso(30 * MIN), eventId: "e1-1" }),
      ]]]),
    }));
    // gateway_down at T-30m is newer than recovered at T-60m → still down.
    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0];
    expect(finding.rule).toBe("box_down");
    expect(finding.key).toBe("box_down:agent-1");
    expect(finding.subjectKind).toBe("hivra_agent");
    expect(finding.userId).toBe("user-1");
    expect(finding.instanceId).toBe("agent-1");
    expect(finding.watchdogTimeline).toHaveLength(2);
    expect(finding.nextStep).toContain("pve-1/101");
  });

  it("orders by event_at, not relay time: an old event re-seen recently does not mask a newer down event", () => {
    const a = agent();
    // recovered happened 30m ago on the box but its ops row was only written 2m
    // ago (backlog drain); gateway_down happened 20m ago, written 25m ago.
    // Ordering by first_seen/last_seen would pick the recovered row; event_at
    // correctly picks gateway_down as latest.
    const result = evaluateCustomerIncidents(evalInput({
      agents: [a],
      watchdogEventsByAgent: new Map([[a.id, [
        watchdogEvent({
          eventType: "recovered",
          eventAt: iso(30 * MIN),
          firstSeenAt: iso(2 * MIN),
          eventId: "e2-9",
        }),
        watchdogEvent({
          eventType: "gateway_down",
          eventAt: iso(20 * MIN),
          firstSeenAt: iso(25 * MIN),
          eventId: "e2-8",
        }),
      ]]]),
    }));
    expect(result.findings.map((f) => f.rule)).toEqual(["box_down"]);
  });

  it("does not fire while the down event is younger than 10 minutes", () => {
    const a = agent();
    const result = evaluateCustomerIncidents(evalInput({
      agents: [a],
      watchdogEventsByAgent: new Map([[a.id, [watchdogEvent({ eventAt: iso(5 * MIN) })]]]),
    }));
    expect(result.findings).toHaveLength(0);
  });

  it("pages immediately on recovery_exhausted regardless of age", () => {
    const a = agent();
    const result = evaluateCustomerIncidents(evalInput({
      agents: [a],
      watchdogEventsByAgent: new Map([[a.id, [
        watchdogEvent({ eventType: "recovery_exhausted", eventAt: iso(2 * MIN), restarts: 3 }),
      ]]]),
    }));
    expect(result.findings).toHaveLength(1);
  });

  it("does not fire when the latest event is a recovery", () => {
    const a = agent();
    const result = evaluateCustomerIncidents(evalInput({
      agents: [a],
      watchdogEventsByAgent: new Map([[a.id, [
        watchdogEvent({ eventType: "gateway_down", eventAt: iso(60 * MIN), eventId: "e3-1" }),
        watchdogEvent({ eventType: "recovered", eventAt: iso(10 * MIN), eventId: "e3-2" }),
      ]]]),
    }));
    expect(result.findings).toHaveLength(0);
  });

  it("ignores non-surface events when picking the newest: unit_failing cannot clear an outage", () => {
    const a = agent();
    // recovery_exhausted 30m ago, then a unit_failing receipt 5m ago. The
    // unit_failing is newer by event_at but is not a surface state change —
    // the box is still down.
    const result = evaluateCustomerIncidents(evalInput({
      agents: [a],
      watchdogEventsByAgent: new Map([[a.id, [
        watchdogEvent({ eventType: "unit_failing", eventAt: iso(5 * MIN), eventId: "e4-2" }),
        watchdogEvent({ eventType: "recovery_exhausted", eventAt: iso(30 * MIN), eventId: "e4-1" }),
      ]]]),
    }));
    expect(result.findings.map((f) => f.rule)).toEqual(["box_down"]);
    // The ignored event is still in the diagnosis timeline.
    expect(result.findings[0].watchdogTimeline.map((e) => e.eventType)).toEqual([
      "unit_failing",
      "recovery_exhausted",
    ]);

    // Same shape with a watchdog_error on top of an old gateway_down.
    const noisy = evaluateCustomerIncidents(evalInput({
      agents: [agent({ id: "a-noisy" })],
      watchdogEventsByAgent: new Map([["a-noisy", [
        watchdogEvent({ eventType: "watchdog_error", eventAt: iso(2 * MIN), eventId: "e5-2" }),
        watchdogEvent({ eventType: "gateway_down", eventAt: iso(45 * MIN), eventId: "e5-1" }),
      ]]]),
    }));
    expect(noisy.findings.map((f) => f.key)).toEqual(["box_down:a-noisy"]);
  });

  it("does not fire for sleeping or non-running agents, and skips admin users", () => {
    const sleeping = agent({ id: "a-sleep", sleepState: "sleeping" });
    const stopped = agent({ id: "a-stop", status: "stopped" });
    const adminAgent = agent({ id: "a-admin", userId: "admin-1" });
    const events = new Map([
      ["a-sleep", [watchdogEvent({ eventAt: iso(60 * MIN) })]],
      ["a-stop", [watchdogEvent({ eventAt: iso(60 * MIN) })]],
      ["a-admin", [watchdogEvent({ eventAt: iso(60 * MIN) })]],
    ]);
    const result = evaluateCustomerIncidents(evalInput({
      agents: [sleeping, stopped, adminAgent],
      watchdogEventsByAgent: events,
      adminUserIds: new Set(["admin-1"]),
    }));
    expect(result.findings).toHaveLength(0);
  });

  it("matches admin users regardless of id casing on either side", () => {
    // Stored user ids keep their database casing; configured admin ids are
    // lowercased by the allowlist parser. Both directions must normalize.
    const mixedCaseStored = agent({ id: "a-case-1", userId: "User_Admin-1" });
    const lowerStored = agent({ id: "a-case-2", userId: "admin-2" });
    const result = evaluateCustomerIncidents(evalInput({
      agents: [mixedCaseStored, lowerStored],
      // Uppercase entry exercises normalization of the configured side too.
      adminUserIds: new Set(["user_admin-1", "ADMIN-2"]),
      watchdogEventsByAgent: new Map([
        ["a-case-1", [watchdogEvent({ eventAt: iso(60 * MIN) })]],
        ["a-case-2", [watchdogEvent({ eventAt: iso(60 * MIN) })]],
      ]),
    }));
    expect(result.findings).toHaveLength(0);
  });

  it("marks box_down unknown (never resolved) when the watchdog fetch failed for that agent", () => {
    const a = agent();
    const result = evaluateCustomerIncidents(evalInput({
      agents: [a],
      watchdogUnknownAgentIds: new Set([a.id]),
    }));
    expect(result.findings).toHaveLength(0);
    expect(result.unknownKeys.has("box_down:agent-1")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// evaluateCustomerIncidents — launch_failed / lifecycle_stuck / cron_unhealthy
// ---------------------------------------------------------------------------

describe("evaluateCustomerIncidents launch_failed", () => {
  const schedules = new Map<string, CronScheduleInfo>();

  it("fires for an unprovisioned agent older than 25 minutes", () => {
    const a = agent({
      id: "a-stuck",
      createdAt: iso(2 * 60 * MIN),
      provisionedAt: null,
      status: "provisioning",
    });
    const result = evaluateCustomerIncidents(evalInput({ agents: [a], cronSchedules: schedules }));
    expect(result.findings.map((f) => f.key)).toEqual(["launch_failed:a-stuck"]);
    expect(result.findings[0].subjectKind).toBe("hivra_agent");
  });

  it("does not fire for a young provisioning agent or a provisioned one", () => {
    const young = agent({ id: "a-young", createdAt: iso(10 * MIN), provisionedAt: null, status: "provisioning" });
    const done = agent({ id: "a-done", createdAt: iso(2 * 60 * MIN), provisionedAt: iso(110 * MIN), status: "running" });
    const result = evaluateCustomerIncidents(evalInput({ agents: [young, done], cronSchedules: schedules }));
    expect(result.findings).toHaveLength(0);
  });

  it("fires immediately for error/deleted status within 24h even when young", () => {
    const failed = agent({ id: "a-err", createdAt: iso(5 * MIN), provisionedAt: null, status: "error" });
    const result = evaluateCustomerIncidents(evalInput({ agents: [failed], cronSchedules: schedules }));
    expect(result.findings.map((f) => f.key)).toEqual(["launch_failed:a-err"]);
  });

  it("ignores agents older than the 24h window and admin users", () => {
    const old = agent({ id: "a-old", createdAt: iso(25 * 60 * MIN), provisionedAt: null, status: "error" });
    const admin = agent({ id: "a-admin", userId: "admin-1", createdAt: iso(60 * MIN), provisionedAt: null, status: "error" });
    const result = evaluateCustomerIncidents(evalInput({
      agents: [old, admin],
      adminUserIds: new Set(["admin-1"]),
      cronSchedules: schedules,
    }));
    expect(result.findings).toHaveLength(0);
  });

  it("fires for a hermes_instances row created in 24h in a failed/error status", () => {
    const failed = instance({ id: "hi-1", status: "failed", lifecycleState: "failed", createdAt: iso(3 * 60 * MIN) });
    const running = instance({ id: "hi-2", status: "running", createdAt: iso(3 * 60 * MIN) });
    const old = instance({ id: "hi-3", status: "failed", createdAt: iso(30 * 60 * MIN) });
    const result = evaluateCustomerIncidents(evalInput({
      hermesInstances: [failed, running, old],
      cronSchedules: schedules,
    }));
    expect(result.findings.map((f) => f.key)).toEqual(["launch_failed:hi-1"]);
    expect(result.findings[0].subjectKind).toBe("hermes_instance");
    expect(result.findings[0].route).toBe("/dashboard/instances/hi-1/console");
  });
});

describe("evaluateCustomerIncidents lifecycle_stuck", () => {
  it("fires when operation_started_at is older than 15 minutes", () => {
    const a = agent({
      id: "a-op",
      operationKind: "delete",
      operationStartedAt: iso(20 * MIN),
      operationId: "op-1",
    });
    const result = evaluateCustomerIncidents(evalInput({ agents: [a] }));
    expect(result.findings.map((f) => f.key)).toEqual(["lifecycle_stuck:a-op"]);
  });

  it("does not fire for fresh operations or no operation", () => {
    const fresh = agent({ id: "a-fresh", operationKind: "start", operationStartedAt: iso(5 * MIN) });
    const none = agent({ id: "a-none" });
    const result = evaluateCustomerIncidents(evalInput({ agents: [fresh, none] }));
    expect(result.findings).toHaveLength(0);
  });
});

describe("evaluateCustomerIncidents cron_unhealthy", () => {
  const schedules = new Map<string, CronScheduleInfo>([
    ["test-cron", { periodMinutes: 5, path: "/api/cron/test-cron" }],
    ["daily-cron", { periodMinutes: 1440, path: "/api/cron/daily-cron" }],
  ]);

  it("fires on a failure streak of 3+ even when the last success is fresh", () => {
    const result = evaluateCustomerIncidents(evalInput({
      heartbeats: [heartbeat({ cronName: "test-cron", consecutiveFailures: 3, lastSuccessAt: iso(5 * MIN) })],
      cronSchedules: schedules,
    }));
    expect(result.findings.map((f) => f.key)).toEqual(["cron_unhealthy:test-cron"]);
    expect(result.findings[0].route).toBe("/api/cron/test-cron");
    expect(result.findings[0].userId).toBeNull();
  });

  it("fires when last_success_at is older than 3x the schedule", () => {
    const result = evaluateCustomerIncidents(evalInput({
      heartbeats: [heartbeat({ cronName: "test-cron", lastSuccessAt: iso(16 * MIN), consecutiveFailures: 0 })],
      cronSchedules: schedules,
    }));
    expect(result.findings.map((f) => f.key)).toEqual(["cron_unhealthy:test-cron"]);
  });

  it("does not fire for a healthy cron or one with no known schedule", () => {
    const result = evaluateCustomerIncidents(evalInput({
      heartbeats: [
        heartbeat({ cronName: "test-cron", lastSuccessAt: iso(4 * MIN), consecutiveFailures: 1 }),
        heartbeat({ cronName: "unknown-cron", consecutiveFailures: 9, lastSuccessAt: null }),
      ],
      cronSchedules: schedules,
    }));
    expect(result.findings).toHaveLength(0);
  });

  it("uses last_run_at as the staleness reference when the cron never succeeded", () => {
    // Ran once an hour ago and failed; never recorded a success. Without the
    // fallback, last_success_at stays null and the cron looks healthy forever.
    const stale = evaluateCustomerIncidents(evalInput({
      heartbeats: [heartbeat({
        cronName: "test-cron",
        lastRunAt: iso(60 * MIN),
        lastSuccessAt: null,
        consecutiveFailures: 1,
      })],
      cronSchedules: schedules,
    }));
    expect(stale.findings.map((f) => f.key)).toEqual(["cron_unhealthy:test-cron"]);

    // A first failure inside the grace window still gets the regular grace.
    const fresh = evaluateCustomerIncidents(evalInput({
      heartbeats: [heartbeat({
        cronName: "test-cron",
        lastRunAt: iso(4 * MIN),
        lastSuccessAt: null,
        consecutiveFailures: 1,
      })],
      cronSchedules: schedules,
    }));
    expect(fresh.findings).toHaveLength(0);
  });

  it("fires for a cron that ran but never succeeded once its row is 3x its period old", () => {
    // test-cron runs every 5 min → never-succeeded budget is 15 min. The row
    // was created an hour ago and has failed every run since; last_run_at
    // stays fresh on each failure so only created_at exposes the dead cron.
    const dead = evaluateCustomerIncidents(evalInput({
      heartbeats: [heartbeat({
        cronName: "test-cron",
        lastRunAt: iso(1 * MIN),
        lastSuccessAt: null,
        runCount: 50,
        okCount: 0,
        consecutiveFailures: 50,
        createdAt: iso(60 * MIN),
      })],
      cronSchedules: schedules,
    }));
    expect(dead.findings.map((f) => f.key)).toEqual(["cron_unhealthy:test-cron"]);

    // Same failing shape but the heartbeat row is only 10 minutes old —
    // inside the 15-minute never-succeeded grace, sub-streak, fresh last run.
    const grace = evaluateCustomerIncidents(evalInput({
      heartbeats: [heartbeat({
        cronName: "test-cron",
        lastRunAt: iso(1 * MIN),
        lastSuccessAt: null,
        runCount: 2,
        consecutiveFailures: 2,
        createdAt: iso(10 * MIN),
      })],
      cronSchedules: schedules,
    }));
    expect(grace.findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// schedule parsing
// ---------------------------------------------------------------------------

describe("cronPeriodMinutes", () => {
  it.each([
    ["*/5 * * * *", 5],
    ["*/10 * * * *", 10],
    ["0 */4 * * *", 240],
    ["30 2 * * *", 1440],
    ["0 7 * * 1", 10080],
    ["15 * * * *", 60],
    ["* * * * *", 1],
    ["0 * * * *", 60],
  ])("parses %s as %d minutes", (schedule, expected) => {
    expect(cronPeriodMinutes(schedule)).toBe(expected);
  });

  it("returns null for schedules it cannot bound", () => {
    expect(cronPeriodMinutes("not a schedule")).toBeNull();
    expect(cronPeriodMinutes("0 9 1 * *")).toBe(43200);
    expect(cronPeriodMinutes("0 9 * * 1-5")).toBe(10080);
  });
});

describe("cronSchedulesFromVercel", () => {
  it("maps cron paths to heartbeat names, including nested paths", () => {
    const map = cronSchedulesFromVercel([
      { path: "/api/cron/hivra-surface-watchdog", schedule: "*/5 * * * *" },
      { path: "/api/cron/seo/analyst-brief", schedule: "0 8 * * *" },
      { path: "/api/other/thing", schedule: "* * * * *" },
      { schedule: "*/5 * * * *" },
    ]);
    expect(map.get("hivra-surface-watchdog")).toEqual({
      periodMinutes: 5,
      path: "/api/cron/hivra-surface-watchdog",
    });
    expect(map.get("seo-analyst-brief")).toEqual({
      periodMinutes: 1440,
      path: "/api/cron/seo/analyst-brief",
    });
    expect(map.has("thing")).toBe(false);
    expect(map.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// sortWatchdogEventsByEventAt / probeAgentPublicSurface
// ---------------------------------------------------------------------------

describe("sortWatchdogEventsByEventAt", () => {
  it("orders newest event_at first regardless of first_seen_at", () => {
    const sorted = sortWatchdogEventsByEventAt([
      watchdogEvent({ eventId: "old", eventAt: iso(60 * MIN), firstSeenAt: iso(1 * MIN) }),
      watchdogEvent({ eventId: "new", eventAt: iso(10 * MIN), firstSeenAt: iso(50 * MIN) }),
    ]);
    expect(sorted.map((e) => e.eventId)).toEqual(["new", "old"]);
  });
});

describe("probeAgentPublicSurface", () => {
  it("probes healthz and the entry URL with no credentials", async () => {
    const seen: string[] = [];
    const results = await probeAgentPublicSurface(
      { cfHostname: "Box-1.Hivra.Example", chatUrl: "https://box-1.hivra.example/chat" },
      async (url) => {
        seen.push(url);
        return { status: 200, latencyMs: 12, error: null };
      },
    );
    expect(seen).toEqual([
      "https://box-1.hivra.example/healthz",
      "https://box-1.hivra.example/chat",
    ]);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ name: "healthz", status: 200, latencyMs: 12 });
  });

  it("falls back to the box root when there is no chat_url, and records probe errors", async () => {
    const results = await probeAgentPublicSurface(
      { cfHostname: "box-2.hivra.example", chatUrl: null },
      async () => ({ status: null, latencyMs: 5001, error: "The operation was aborted" }),
    );
    expect(results.map((r) => r.name)).toEqual(["healthz", "entry"]);
    expect(results[1].url).toBe("https://box-2.hivra.example/");
    expect(results[0].error).toContain("aborted");
  });
});

// ---------------------------------------------------------------------------
// runCustomerIncidentScan — end-to-end with an injected fake db
// ---------------------------------------------------------------------------

// DB row factories (snake_case, as supabase returns them)
function agentDbRow(over: Row = {}): Row {
  return {
    id: "agent-1",
    user_id: "user-1",
    type: "agent-zero",
    name: "Box",
    status: "running",
    sleep_state: "awake",
    desired_state: "running",
    created_at: iso(30 * 24 * 60 * MIN),
    provisioned_at: iso(30 * 24 * 60 * MIN - 5 * MIN),
    operation_kind: null,
    operation_started_at: null,
    operation_id: null,
    error: null,
    cf_hostname: "box-1.hivra.example",
    chat_url: "https://box-1.hivra.example/",
    proxmox_host: "pve-1",
    vmid: 101,
    ip: "192.0.2.5",
    ...over,
  };
}

function watchdogDbRow(eventType: string, eventAtMsAgo: number, extra: Row = {}): Row {
  return {
    id: `ops-${eventType}-${eventAtMsAgo}`,
    title: `surface watchdog: ${eventType} hivra-agent-zero.service [e1]`,
    first_seen_at: iso(eventAtMsAgo),
    metadata: {
      event_id: "e1",
      event_type: eventType,
      event_at: iso(eventAtMsAgo),
      unit: "hivra-agent-zero.service",
      reason: "csrf answered HTTP 502",
      down_for_s: 120,
      ...extra,
    },
  };
}

function incidentDbRow(over: Row = {}): Row {
  return {
    id: "evt-open-1",
    fingerprint: "fp-incident-1",
    source: "incident.box_down",
    title: "Customer incident: agent box down",
    metadata: { incident_key: "box_down:agent-1" },
    ...over,
  };
}

interface FakeDbConfig {
  agents?: Row[];
  instances?: Row[];
  heartbeats?: Row[];
  subscriptions?: Row[];
  openIncidents?: Row[];
  watchdogByAgent?: Record<string, Row[]>;
  /** Open box.public_probe.* rows (public-reachability signal rows). */
  probeRows?: Row[];
  /** When true, per-agent watchdog event queries fail (box_down goes unknown). */
  watchdogFetchFails?: boolean;
  /** When true, single-row subject lookups (launch_failed expiry checks) fail. */
  subjectLookupFails?: boolean;
  /** When set, queries against this table fail from the second keyset page on. */
  failKeysetPageFor?: string;
}

// PostgREST caps every response at max_rows even when the query asks for
// more — the fake applies the same cap so a scan that stops paginating
// silently loses rows exactly like production would.
const FAKE_POSTGREST_MAX_ROWS = 1000;

function fakeColumnValue(row: Row, column: string): unknown {
  if (column.includes("->>")) {
    const [base, key] = column.split("->>");
    const container = row[base.trim()];
    if (!container || typeof container !== "object") return undefined;
    return (container as Row)[key.trim()];
  }
  return row[column];
}

function fakeCompare(a: unknown, b: unknown): number {
  const sa = String(a);
  const sb = String(b);
  const na = Number(a);
  const nb = Number(b);
  if (
    sa.trim() !== "" &&
    sb.trim() !== "" &&
    Number.isFinite(na) &&
    Number.isFinite(nb)
  ) {
    return na - nb;
  }
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function fakeValuesEqual(a: unknown, b: unknown): boolean {
  if (a == null || b == null) return false;
  return a === b || String(a) === String(b);
}

const FAKE_FILTER_METHODS = new Set([
  "eq",
  "neq",
  "is",
  "not",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "like",
]);

function fakeRowMatches(row: Row, call: unknown[]): boolean {
  const [method, a1, a2, a3] = call as [string, string, unknown, unknown];
  switch (method) {
    case "eq":
    case "neq": {
      const matched = fakeValuesEqual(fakeColumnValue(row, a1), a2);
      return method === "eq" ? matched : !matched;
    }
    case "is":
      return a2 === null
        ? fakeColumnValue(row, a1) == null
        : fakeColumnValue(row, a1) === a2;
    case "not": {
      // .not(column, op, value)
      const column = a1;
      const op = a2 as string;
      const value = a3;
      if (op === "is") {
        return value === null
          ? fakeColumnValue(row, column) != null
          : fakeColumnValue(row, column) !== value;
      }
      if (op === "eq") {
        return !fakeValuesEqual(fakeColumnValue(row, column), value);
      }
      return true;
    }
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const value = fakeColumnValue(row, a1);
      if (value == null) return false;
      const cmp = fakeCompare(value, a2);
      if (method === "gt") return cmp > 0;
      if (method === "gte") return cmp >= 0;
      if (method === "lt") return cmp < 0;
      return cmp <= 0;
    }
    case "in":
      return (
        Array.isArray(a2) &&
        a2.some((candidate) => fakeValuesEqual(fakeColumnValue(row, a1), candidate))
      );
    case "like": {
      const value = fakeColumnValue(row, a1);
      if (typeof value !== "string") return false;
      const pattern = String(a2);
      if (pattern.endsWith("%") && !pattern.slice(0, -1).includes("%")) {
        return value.startsWith(pattern.slice(0, -1));
      }
      return value === pattern;
    }
    default:
      return true;
  }
}

function fakeApplyOrder(rows: Row[], orderCalls: unknown[][]): Row[] {
  if (orderCalls.length === 0) return rows;
  const keys = orderCalls.map((call) => {
    const options = call[2] as { ascending?: boolean } | undefined;
    return {
      column: String(call[1]),
      ascending: options?.ascending !== false,
    };
  });
  return [...rows].sort((left, right) => {
    for (const key of keys) {
      const a = fakeColumnValue(left, key.column);
      const b = fakeColumnValue(right, key.column);
      if (a == null && b == null) continue;
      if (a == null) return key.ascending ? 1 : -1;
      if (b == null) return key.ascending ? -1 : 1;
      const cmp = fakeCompare(a, b);
      if (cmp !== 0) return key.ascending ? cmp : -cmp;
    }
    return 0;
  });
}

/** Thenable query-builder fake: applies filters, ordering and the row cap. */
function fakeIncidentDb(config: FakeDbConfig) {
  // ops_events holds every event-ish row: open incident rows, relayed
  // watchdog receipts (keyed to their agent) and public-probe rows. The
  // source/instance filters pick the right subset per query, like production.
  const opsEventRows: Row[] = [
    ...(config.openIncidents ?? []),
    ...(config.probeRows ?? []),
    ...Object.entries(config.watchdogByAgent ?? {}).flatMap(([agentId, rows]) =>
      rows.map((row) => ({
        source: "box.surface_watchdog.event",
        instance_id: agentId,
        ...row,
      })),
    ),
  ];
  const rowsFor = (table: string): Row[] => {
    switch (table) {
      case "hivra_agents":
        return config.agents ?? [];
      case "hermes_instances":
        return config.instances ?? [];
      case "ops_cron_heartbeats":
        return config.heartbeats ?? [];
      case "hermes_subscriptions":
        return config.subscriptions ?? [];
      case "ops_events":
        return opsEventRows;
      default:
        return [];
    }
  };
  const recordedCalls: Array<{ table: string; calls: unknown[][] }> = [];
  return {
    calls: recordedCalls,
    from(table: string) {
      const calls: unknown[][] = [];
      const chain: Record<string, unknown> = {};
      let terminal: "none" | "single" | "maybe" = "none";
      for (const method of [
        "select",
        "eq",
        "is",
        "not",
        "gte",
        "gt",
        "lt",
        "lte",
        "in",
        "like",
        "order",
        "limit",
        "range",
      ]) {
        chain[method] = (...args: unknown[]) => {
          calls.push([method, ...args]);
          return chain;
        };
      }
      chain.single = () => {
        terminal = "single";
        calls.push(["single"]);
        return chain;
      };
      chain.maybeSingle = () => {
        terminal = "maybe";
        calls.push(["maybeSingle"]);
        return chain;
      };
      const resolve = (): { data: unknown; error: { message: string } | null } => {
        recordedCalls.push({ table, calls: [...calls] });
        const isWatchdogQuery =
          table === "ops_events" &&
          calls.some((c) => c[0] === "eq" && c[1] === "instance_id");
        if (
          config.subjectLookupFails &&
          terminal !== "none" &&
          (table === "hivra_agents" || table === "hermes_instances")
        ) {
          return { data: null, error: { message: "subject lookup failed" } };
        }
        if (config.watchdogFetchFails && isWatchdogQuery) {
          return { data: null, error: { message: "watchdog events query failed" } };
        }
        if (config.failKeysetPageFor === table && calls.some((c) => c[0] === "gt")) {
          return { data: null, error: { message: "keyset page two failed" } };
        }
        let rows = rowsFor(table).filter((row) =>
          calls
            .filter((c) => FAKE_FILTER_METHODS.has(String(c[0])))
            .every((call) => fakeRowMatches(row, call)),
        );
        rows = fakeApplyOrder(
          rows,
          calls.filter((c) => c[0] === "order"),
        );
        const limitCall = calls.find((c) => c[0] === "limit");
        const cap = Math.min(
          limitCall ? Number(limitCall[1]) : FAKE_POSTGREST_MAX_ROWS,
          FAKE_POSTGREST_MAX_ROWS,
        );
        rows = rows.slice(0, cap);
        const rangeCall = calls.find((c) => c[0] === "range");
        if (rangeCall) {
          rows = rows.slice(Number(rangeCall[1]), Number(rangeCall[2]) + 1);
        }
        if (terminal !== "none") {
          return { data: rows[0] ?? null, error: null };
        }
        return { data: rows, error: null };
      };
      chain.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
        Promise.resolve(resolve()).then(onFulfilled, onRejected);
      return chain;
    },
  };
}

function scanDeps(over: Record<string, unknown> = {}) {
  return {
    now: () => NOW,
    adminUserIds: new Set<string>(),
    report: jest.fn(async () => ({ id: "evt-new-1", fingerprint: "fp" })),
    probe: jest.fn(async () => ({ status: 200, latencyMs: 9, error: null })),
    archiveIncident: jest.fn(async () => true),
    notifyResolved: jest.fn(async () => undefined),
    cronSchedules: new Map<string, CronScheduleInfo>([
      ["test-cron", { periodMinutes: 5, path: "/api/cron/test-cron" }],
    ]),
    // Tests exercise the paging path explicitly; the production-origin gate
    // has its own cases below.
    pagingEnabled: true,
    ...over,
  };
}

describe("runCustomerIncidentScan", () => {
  beforeEach(() => {
    mockDb.current = null;
  });

  it("pages a new box_down incident with the full diagnosis bundle", async () => {
    const deps = scanDeps({
      db: fakeIncidentDb({
        agents: [agentDbRow()],
        subscriptions: [{ user_id: "user-1", plan: "pro", status: "active" }],
        watchdogByAgent: {
          "agent-1": [
            watchdogDbRow("gateway_down", 45 * MIN),
            watchdogDbRow("unit_restart", 40 * MIN, { attempt: 2 }),
          ],
        },
      }),
    });
    const summary = await runCustomerIncidentScan(deps as never);

    expect(summary).toMatchObject({ findings: 1, opened: 1, resolved: 0, failed: 0 });
    const report = deps.report as jest.Mock;
    expect(report).toHaveBeenCalledTimes(1);
    const ops = report.mock.calls[0][0];
    expect(ops.source).toBe("incident.box_down");
    expect(ops.severity).toBe("error");
    expect(ops.page).toBe(true);
    expect(ops.userId).toBe("user-1");
    expect(ops.instanceId).toBe("agent-1");
    expect(ops.route).toBe("/dashboard/agent/agent-1");
    expect(ops.metadata.incident_key).toBe("box_down:agent-1");
    expect(ops.metadata.rule).toBe("box_down");
    expect(ops.metadata.customer).toEqual({
      clerk_user_id: "user-1",
      plan: "pro",
      subscription_status: "active",
    });
    expect(ops.metadata.agent).toMatchObject({ id: "agent-1", vmid: 101, proxmox_host: "pve-1" });
    expect(ops.metadata.watchdog.timeline).toHaveLength(2);
    // Newest event_at first: unit_restart (T-40m) is newer than gateway_down (T-45m).
    expect(ops.metadata.watchdog.timeline[0].event_type).toBe("unit_restart");
    expect(ops.metadata.probes).toHaveLength(2);
    expect(ops.metadata.next_step).toContain("pve-1/101");
    // No secrets anywhere in the bundle.
    expect(JSON.stringify(ops.metadata)).not.toContain("api_token");
    expect((deps.probe as jest.Mock)).toHaveBeenCalledWith("https://box-1.hivra.example/healthz");
  });

  it("sends nothing on a second run while the incident is still open", async () => {
    const dbConfig = {
      agents: [agentDbRow()],
      subscriptions: [{ user_id: "user-1", plan: "pro", status: "active" }],
      watchdogByAgent: { "agent-1": [watchdogDbRow("gateway_down", 45 * MIN)] },
    };
    const first = scanDeps({ db: fakeIncidentDb(dbConfig) });
    await runCustomerIncidentScan(first as never);
    expect((first.report as jest.Mock)).toHaveBeenCalledTimes(1);

    // Same world, but the incident row now exists open.
    const second = scanDeps({
      db: fakeIncidentDb({ ...dbConfig, openIncidents: [incidentDbRow()] }),
    });
    const summary = await runCustomerIncidentScan(second as never);
    expect(summary).toMatchObject({ opened: 0, stillOpen: 1 });
    expect(second.report as jest.Mock).not.toHaveBeenCalled();
    expect(second.probe as jest.Mock).not.toHaveBeenCalled();
  });

  it("archives the row and sends exactly one resolved notice when the rule clears", async () => {
    const deps = scanDeps({
      db: fakeIncidentDb({
        agents: [agentDbRow()],
        openIncidents: [incidentDbRow()],
        // Latest event is now a recovery → box_down no longer holds.
        watchdogByAgent: {
          "agent-1": [
            watchdogDbRow("gateway_down", 90 * MIN),
            watchdogDbRow("recovered", 20 * MIN),
          ],
        },
      }),
    });
    const summary = await runCustomerIncidentScan(deps as never);

    expect(summary).toMatchObject({ opened: 0, resolved: 1, failed: 0 });
    expect(deps.archiveIncident as jest.Mock).toHaveBeenCalledWith("evt-open-1");
    expect(deps.notifyResolved as jest.Mock).toHaveBeenCalledTimes(1);
    const notice = (deps.notifyResolved as jest.Mock).mock.calls[0][0];
    expect(notice.title).toBe("Resolved: Customer incident: agent box down");
    expect(notice.metadata.incident_key).toBe("box_down:agent-1");
    expect(notice.fingerprint).not.toBe("fp-incident-1");
  });

  it("does NOT resolve an open incident when its watchdog evaluation was uncertain", async () => {
    const deps = scanDeps({
      db: fakeIncidentDb({
        agents: [agentDbRow()],
        openIncidents: [incidentDbRow()],
        watchdogFetchFails: true,
      }),
    });
    const summary = await runCustomerIncidentScan(deps as never);
    // The per-agent fetch failed → box_down:agent-1 is unknown → the open
    // incident is neither re-reported nor wrongly archived.
    expect(summary).toMatchObject({ opened: 0, resolved: 0, unknown: 1 });
    expect(deps.archiveIncident as jest.Mock).not.toHaveBeenCalled();
    expect(deps.notifyResolved as jest.Mock).not.toHaveBeenCalled();
  });

  it("excludes admin users end-to-end", async () => {
    const deps = scanDeps({
      adminUserIds: new Set(["admin-1"]),
      db: fakeIncidentDb({
        agents: [agentDbRow({ user_id: "admin-1" })],
        watchdogByAgent: { "agent-1": [watchdogDbRow("recovery_exhausted", 5 * MIN)] },
      }),
    });
    const summary = await runCustomerIncidentScan(deps as never);
    expect(summary).toMatchObject({ findings: 0, opened: 0 });
    expect(deps.report as jest.Mock).not.toHaveBeenCalled();
  });

  it("pages a cron_unhealthy incident for a failing heartbeat", async () => {
    const deps = scanDeps({
      db: fakeIncidentDb({
        agents: [],
        heartbeats: [{
          cron_name: "test-cron",
          last_run_at: iso(5 * MIN),
          last_success_at: iso(5 * MIN),
          run_count: 30,
          ok_count: 20,
          consecutive_failures: 3,
          last_detail: "failed=2",
        }],
      }),
    });
    const summary = await runCustomerIncidentScan(deps as never);
    expect(summary.opened).toBe(1);
    const ops = (deps.report as jest.Mock).mock.calls[0][0];
    expect(ops.source).toBe("incident.cron_unhealthy");
    expect(ops.route).toBe("/api/cron/test-cron");
    expect(ops.metadata.cron.consecutive_failures).toBe(3);
  });

  it("writes incidents with page:false and skips resolved notices when paging is disabled", async () => {
    const deps = scanDeps({
      pagingEnabled: false,
      db: fakeIncidentDb({
        agents: [agentDbRow()],
        subscriptions: [{ user_id: "user-1", plan: "pro", status: "active" }],
        watchdogByAgent: { "agent-1": [watchdogDbRow("gateway_down", 45 * MIN)] },
        openIncidents: [incidentDbRow({ id: "evt-resolved-1", metadata: { incident_key: "box_down:gone-1" } })],
      }),
    });
    const summary = await runCustomerIncidentScan(deps as never);

    expect(summary.opened).toBe(1);
    const ops = (deps.report as jest.Mock).mock.calls[0][0];
    expect(ops.page).toBe(false);
    // The stale open row for a different key still resolves (archive) but no
    // resolved notice is sent off-production.
    expect(deps.archiveIncident as jest.Mock).toHaveBeenCalledWith("evt-resolved-1");
    expect(deps.notifyResolved as jest.Mock).not.toHaveBeenCalled();
  });

  it("aborts the whole pass when a core collection query fails", async () => {
    const failingDb = {
      from() {
        const chain: Record<string, unknown> = {};
        for (const m of ["select", "eq", "is", "not", "gte", "in", "like", "order", "limit", "range"]) {
          chain[m] = () => chain;
        }
        chain.then = (onFulfilled: (v: unknown) => unknown) =>
          Promise.resolve({ data: null, error: { message: "db down" } }).then(onFulfilled);
        return chain;
      },
    };
    const deps = scanDeps({ db: failingDb });
    const summary = await runCustomerIncidentScan(deps as never);
    expect(summary.failed).toBe(1);
    expect(deps.report as jest.Mock).not.toHaveBeenCalled();
    expect(deps.archiveIncident as jest.Mock).not.toHaveBeenCalled();
    expect(deps.notifyResolved as jest.Mock).not.toHaveBeenCalled();
  });

  it("pages subject queries by keyset past the PostgREST row cap", async () => {
    // 1000 eligible unprovisioned rows sorting before the failing row fill
    // the first page exactly. Without keyset pagination the failing row is
    // never read and the incident never opens; the fake applies the real
    // filters and the 1000-row cap, so removing pagination fails this test.
    // Fillers are young provisioning rows: collected, but inside no rule's
    // firing condition (under 25 minutes, not a failed status).
    const fillers = Array.from({ length: 1000 }, (_, i) =>
      agentDbRow({
        id: `agent-fill-${String(i).padStart(4, "0")}`,
        status: "provisioning",
        provisioned_at: null,
        created_at: iso(20 * MIN),
      }),
    );
    const failing = agentDbRow({
      id: "agent-zz-fail",
      status: "error",
      provisioned_at: null,
      created_at: iso(2 * 60 * MIN),
    });
    const db = fakeIncidentDb({ agents: [...fillers, failing] });
    const deps = scanDeps({ db });
    const summary = await runCustomerIncidentScan(deps as never);

    expect(summary.opened).toBe(1);
    const ops = (deps.report as jest.Mock).mock.calls[0][0];
    expect(ops.metadata.incident_key).toBe("launch_failed:agent-zz-fail");
    // The second page was actually requested: a .gt keyset cursor on id.
    const agentQueries = db.calls.filter((entry) => entry.table === "hivra_agents");
    expect(
      agentQueries.some((entry) =>
        entry.calls.some((call) => call[0] === "gt" && call[1] === "id"),
      ),
    ).toBe(true);
  });

  it("aborts the pass when a keyset page fails mid-read — partial data never resolves", async () => {
    const fillers = Array.from({ length: 1000 }, (_, i) =>
      agentDbRow({
        id: `agent-fill-${String(i).padStart(4, "0")}`,
        status: "provisioning",
        provisioned_at: null,
        created_at: iso(20 * MIN),
      }),
    );
    const deps = scanDeps({
      db: fakeIncidentDb({
        agents: [...fillers, agentDbRow({ id: "agent-zz-fail", status: "error", provisioned_at: null, created_at: iso(2 * 60 * MIN) })],
        failKeysetPageFor: "hivra_agents",
        openIncidents: [incidentDbRow()],
      }),
    });
    const summary = await runCustomerIncidentScan(deps as never);
    // Page two errored → the whole collection aborts → nothing opens,
    // resolves or archives on incomplete subject data.
    expect(summary.failed).toBe(1);
    expect(deps.report as jest.Mock).not.toHaveBeenCalled();
    expect(deps.archiveIncident as jest.Mock).not.toHaveBeenCalled();
    expect(deps.notifyResolved as jest.Mock).not.toHaveBeenCalled();
  });

  it("marks remaining probes as skipped once the scan probe budget is exhausted", async () => {
    let tick = 0;
    const deps = scanDeps({
      clock: () => (tick += 100_000), // each read jumps past the 90s budget
      probeBudgetMs: 90_000,
      // The watchdog read deadline shares the same clock; keep it far away
      // so only the probe budget is exercised here.
      watchdogBudgetMs: 24 * 60 * 60 * 1000,
      db: fakeIncidentDb({
        agents: [agentDbRow()],
        watchdogByAgent: { "agent-1": [watchdogDbRow("gateway_down", 45 * MIN)] },
      }),
    });
    const summary = await runCustomerIncidentScan(deps as never);
    expect(summary.opened).toBe(1);
    expect(deps.probe as jest.Mock).not.toHaveBeenCalled();
    const ops = (deps.report as jest.Mock).mock.calls[0][0];
    const probes = ops.metadata.probes as Array<{ error: string | null }>;
    expect(probes.length).toBeGreaterThan(0);
    expect(probes.every((p) => p.error === "skipped: scan budget")).toBe(true);
  });

  it("marks agents the watchdog deadline never reached as unknown and degraded", async () => {
    // clock: the two scan-start deadline reads return 0; the per-agent
    // deadline check for the second agent jumps past the 60s budget, so
    // agent-2's receipts are never read — it must be unknown, not resolved.
    const times = [0, 0, 0, 200_000];
    let tick = 0;
    const clock = () => times[Math.min(tick++, times.length - 1)];
    const deps = scanDeps({
      clock,
      watchdogBudgetMs: 60_000,
      db: fakeIncidentDb({
        agents: [agentDbRow({ id: "agent-1" }), agentDbRow({ id: "agent-2" })],
        watchdogByAgent: { "agent-1": [watchdogDbRow("recovered", 20 * MIN)] },
        openIncidents: [
          incidentDbRow({ id: "evt-dl-1", metadata: { incident_key: "box_down:agent-2" } }),
        ],
      }),
    });
    const summary = await runCustomerIncidentScan(deps as never);
    expect(summary.degraded).toBe(1);
    expect(summary.unknown).toBe(1);
    // agent-2's open box_down incident is neither resolved nor re-reported.
    expect(deps.archiveIncident as jest.Mock).not.toHaveBeenCalled();
    expect(deps.notifyResolved as jest.Mock).not.toHaveBeenCalled();
  });

  it("counts watchdog fetch failures as degraded without resolving their incidents", async () => {
    const deps = scanDeps({
      db: fakeIncidentDb({
        agents: [agentDbRow()],
        watchdogFetchFails: true,
        openIncidents: [incidentDbRow()],
      }),
    });
    const summary = await runCustomerIncidentScan(deps as never);
    expect(summary.degraded).toBe(1);
    // The open box_down row stays open — a failed read never resolves it.
    expect(deps.archiveIncident as jest.Mock).not.toHaveBeenCalled();
  });

  it("counts an incident as failed, not opened, when the report persists no id", async () => {
    const deps = scanDeps({
      report: jest.fn(async () => null),
      db: fakeIncidentDb({
        agents: [agentDbRow()],
        watchdogByAgent: { "agent-1": [watchdogDbRow("gateway_down", 45 * MIN)] },
      }),
    });
    const summary = await runCustomerIncidentScan(deps as never);
    expect(summary).toMatchObject({ opened: 0, failed: 1 });
  });

  it("archives an aged-out launch_failed incident silently when the subject is still failed", async () => {
    const deps = scanDeps({
      db: fakeIncidentDb({
        agents: [
          agentDbRow({
            id: "agent-still-broken",
            status: "error",
            provisioned_at: null,
            // Outside the 24h rule window — the rule emits no finding.
            created_at: iso(30 * 24 * 60 * MIN),
          }),
        ],
        openIncidents: [
          incidentDbRow({
            id: "evt-lf-1",
            source: "incident.launch_failed",
            metadata: {
              incident_key: "launch_failed:agent-still-broken",
              subject_kind: "hivra_agent",
            },
          }),
        ],
      }),
    });
    const summary = await runCustomerIncidentScan(deps as never);
    expect(summary).toMatchObject({ expired: 1, resolved: 0 });
    expect(deps.archiveIncident as jest.Mock).toHaveBeenCalledWith("evt-lf-1", {
      closedReason: "expired_unresolved",
    });
    expect(deps.notifyResolved as jest.Mock).not.toHaveBeenCalled();
  });

  it("resolves an aged-out launch_failed incident with a notice when the subject now runs", async () => {
    const deps = scanDeps({
      db: fakeIncidentDb({
        agents: [agentDbRow({ id: "agent-recovered" })],
        openIncidents: [
          incidentDbRow({
            id: "evt-lf-2",
            source: "incident.launch_failed",
            metadata: {
              incident_key: "launch_failed:agent-recovered",
              subject_kind: "hivra_agent",
            },
          }),
        ],
      }),
    });
    const summary = await runCustomerIncidentScan(deps as never);
    expect(summary).toMatchObject({ expired: 0, resolved: 1 });
    expect(deps.archiveIncident as jest.Mock).toHaveBeenCalledWith("evt-lf-2");
    expect(deps.notifyResolved as jest.Mock).toHaveBeenCalledTimes(1);
  });

  it("leaves an aged-out launch_failed incident open when the subject lookup fails", async () => {
    const deps = scanDeps({
      db: fakeIncidentDb({
        agents: [agentDbRow({ id: "agent-unknown" })],
        subjectLookupFails: true,
        openIncidents: [
          incidentDbRow({
            id: "evt-lf-3",
            source: "incident.launch_failed",
            metadata: {
              incident_key: "launch_failed:agent-unknown",
              subject_kind: "hivra_agent",
            },
          }),
        ],
      }),
    });
    const summary = await runCustomerIncidentScan(deps as never);
    expect(summary).toMatchObject({ expired: 0, resolved: 0 });
    expect(deps.archiveIncident as jest.Mock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// incidentPagingEnabled — production-only admin paging
// ---------------------------------------------------------------------------

describe("incidentPagingEnabled", () => {
  it("pages from a production Vercel env that is not the Canary deployment", () => {
    // Prod's NEXT_PUBLIC_APP_URL reads back empty, so the gate keys on
    // VERCEL_ENV plus the deployment channel — no app URL required.
    expect(incidentPagingEnabled({ VERCEL_ENV: "production" })).toBe(true);
    expect(
      incidentPagingEnabled({
        VERCEL_ENV: "production",
        VERCEL_PROJECT_PRODUCTION_URL: "hivra.cloud",
      }),
    ).toBe(true);
  });

  it("does not page from Canary even though it also reports VERCEL_ENV=production", () => {
    expect(
      incidentPagingEnabled({
        VERCEL_ENV: "production",
        HERMES_DEPLOY_CHANNEL: "canary",
      }),
    ).toBe(false);
    expect(
      incidentPagingEnabled({
        VERCEL_ENV: "production",
        VERCEL_PROJECT_PRODUCTION_URL: "canary.hermesos.cloud",
      }),
    ).toBe(false);
  });

  it("does not page from previews, local runs, or missing env", () => {
    expect(incidentPagingEnabled({ VERCEL_ENV: "preview" })).toBe(false);
    expect(incidentPagingEnabled({ VERCEL_ENV: "development" })).toBe(false);
    expect(incidentPagingEnabled({})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// metadata / ops-event assembly
// ---------------------------------------------------------------------------

describe("buildIncidentMetadata + incidentOpsEvent", () => {
  it("builds a stable fingerprinted ops event: fixed title/message, subject in ids+route", () => {
    const a = agent();
    const result = evaluateCustomerIncidents(evalInput({
      agents: [a],
      watchdogEventsByAgent: new Map([[a.id, [watchdogEvent({ eventAt: iso(60 * MIN) })]]]),
    }));
    const finding = result.findings[0];
    const ops = incidentOpsEvent(finding, buildIncidentMetadata(finding, {
      subscription: { plan: "pro", status: "active" },
      probes: [{ name: "healthz", url: "https://box-1.hivra.example/healthz", status: 200, latencyMs: 5, error: null }],
    }));
    expect(ops.source).toBe("incident.box_down");
    expect(ops.page).toBe(true);
    expect(ops.title).toBe("Customer incident: agent box down");
    // Same inputs → same fingerprint inputs (dedupe while open).
    const ops2 = incidentOpsEvent(finding, buildIncidentMetadata(finding));
    expect(ops2.title).toBe(ops.title);
    expect(ops2.message).toBe(ops.message);
    expect(ops2.route).toBe(ops.route);
    expect(ops2.userId).toBe(ops.userId);
    expect(ops2.instanceId).toBe(ops.instanceId);
  });
});
