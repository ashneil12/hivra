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
  /** When true, per-agent watchdog event queries fail (box_down goes unknown). */
  watchdogFetchFails?: boolean;
}

/** Thenable query-builder fake: records the chain, resolves per table on await. */
function fakeIncidentDb(config: FakeDbConfig) {
  const resolveTable = (
    table: string,
    calls: unknown[][],
  ): { data: Row[] | null; error: { message: string } | null } => {
    const ok = (data: Row[]) => ({ data, error: null });
    if (table === "hivra_agents") return ok(config.agents ?? []);
    if (table === "hermes_instances") return ok(config.instances ?? []);
    if (table === "ops_cron_heartbeats") return ok(config.heartbeats ?? []);
    if (table === "hermes_subscriptions") return ok(config.subscriptions ?? []);
    if (table === "ops_events") {
      const isIncidentFeed = calls.some(
        (c) => c[0] === "like" && c[1] === "source" && String(c[2]).startsWith("incident"),
      );
      if (isIncidentFeed) return ok(config.openIncidents ?? []);
      const instanceCall = calls.find((c) => c[0] === "eq" && c[1] === "instance_id");
      const agentId = instanceCall ? String(instanceCall[2]) : null;
      if (config.watchdogFetchFails) {
        return { data: null, error: { message: "watchdog events query failed" } };
      }
      return ok(agentId ? config.watchdogByAgent?.[agentId] ?? [] : []);
    }
    return ok([]);
  };
  return {
    from(table: string) {
      const calls: unknown[][] = [];
      const chain: Record<string, unknown> = {};
      for (const method of ["select", "eq", "is", "not", "gte", "in", "like", "order", "limit"]) {
        chain[method] = (...args: unknown[]) => {
          calls.push([method, ...args]);
          return chain;
        };
      }
      chain.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
        Promise.resolve(resolveTable(table, calls)).then(onFulfilled, onRejected);
      return chain;
    },
  };
}

function scanDeps(over: Record<string, unknown> = {}) {
  return {
    now: () => NOW,
    adminUserIds: new Set<string>(),
    report: jest.fn(async () => ({ fingerprint: "fp" })),
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
        openIncidents: [incidentDbRow({ id: "evt-resolved-1", metadata: { incident_key: "launch_failed:gone" } })],
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
        for (const m of ["select", "eq", "is", "not", "gte", "in", "like", "order", "limit"]) {
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
