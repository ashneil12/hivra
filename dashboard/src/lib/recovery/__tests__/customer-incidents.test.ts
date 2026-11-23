/** @jest-environment node */

const mockDb: { current: unknown } = { current: null };
jest.mock("@/lib/supabase", () => ({ get supabaseAdmin() { return mockDb.current; } }));
jest.mock("@/lib/logger", () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import { reportOpsEvent, type OpsEventInput } from "@/lib/ops-events";

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
  type ProbeFn,
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
    sleepTierChangedAt: null,
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

// The production path fetches the newest surface receipt with its own query;
// in these fixtures the same answer is derived from the events the timeline
// query returned (identical whenever the receipt is inside that window).
// Tests exercising the crowded-out case pass latestSurfaceReceiptByAgent
// explicitly.
function deriveLatestSurfaceReceipts(
  byAgent: ReadonlyMap<string, WatchdogEventSnapshot[]>,
): Map<string, WatchdogEventSnapshot> {
  const out = new Map<string, WatchdogEventSnapshot>();
  const surface = new Set([
    "gateway_down",
    "gateway_recovered",
    "unit_restart",
    "recovered",
    "recovery_exhausted",
  ]);
  for (const [agentId, events] of byAgent) {
    const sorted = [...events].sort((a, b) => {
      const at = Date.parse(a.eventAt ?? a.firstSeenAt ?? "") || 0;
      const bt = Date.parse(b.eventAt ?? b.firstSeenAt ?? "") || 0;
      return bt - at;
    });
    const receipt = sorted.find((e) => e.eventType != null && surface.has(e.eventType));
    if (receipt) out.set(agentId, receipt);
  }
  return out;
}

function evalInput(over: Partial<IncidentEvaluationInput> = {}): IncidentEvaluationInput {
  const watchdogEventsByAgent =
    over.watchdogEventsByAgent ?? new Map<string, WatchdogEventSnapshot[]>();
  return {
    now: NOW,
    adminUserIds: new Set<string>(),
    agents: [],
    watchdogEventsByAgent,
    latestSurfaceReceiptByAgent:
      over.latestSurfaceReceiptByAgent ?? deriveLatestSurfaceReceipts(watchdogEventsByAgent),
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

  it("still HOLDS an already-open incident while a newer failure receipt is inside the grace window", () => {
    // The 10-minute minimum gates OPENING only. The incident paged on an
    // older receipt; the newest failure receipt is 2 minutes old — inside
    // grace — but still describes a box that is down on the current runtime.
    // Suppressing the finding would let the resolve pass archive the live
    // row (and send a resolved notice), then re-page the same outage once
    // the receipt ages out.
    const a = agent();
    const result = evaluateCustomerIncidents(evalInput({
      agents: [a],
      watchdogEventsByAgent: new Map([[a.id, [
        watchdogEvent({ eventType: "gateway_down", eventAt: iso(2 * MIN), eventId: "g2-2" }),
        watchdogEvent({ eventType: "gateway_down", eventAt: iso(30 * MIN), eventId: "g2-1" }),
      ]]]),
      openIncidentKeys: new Set(["box_down:agent-1"]),
    }));
    expect(result.findings.map((f) => f.key)).toEqual(["box_down:agent-1"]);
  });

  it("still resolves an open incident when the newest receipt is a recovery — grace only defers failures", () => {
    const a = agent();
    const result = evaluateCustomerIncidents(evalInput({
      agents: [a],
      watchdogEventsByAgent: new Map([[a.id, [
        watchdogEvent({ eventType: "recovered", eventAt: iso(1 * MIN), eventId: "g3-2" }),
        watchdogEvent({ eventType: "gateway_down", eventAt: iso(30 * MIN), eventId: "g3-1" }),
      ]]]),
      openIncidentKeys: new Set(["box_down:agent-1"]),
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

  it("ignores surface receipts that predate the agent's latest runtime start", () => {
    // The box restarted (wake) 2h ago; the newest surface receipt is a
    // gateway_down from 30h ago — it describes the PREVIOUS runtime and must
    // not hold a box_down open against the current one.
    const a = agent({ sleepTierChangedAt: iso(2 * 60 * MIN) });
    const stale = watchdogEvent({ eventType: "gateway_down", eventAt: iso(30 * 60 * MIN), eventId: "old-1" });
    const result = evaluateCustomerIncidents(evalInput({
      agents: [a],
      watchdogEventsByAgent: new Map([[a.id, [stale]]]),
      latestSurfaceReceiptByAgent: new Map([[a.id, stale]]),
    }));
    expect(result.findings).toHaveLength(0);

    // A receipt AFTER the marker still counts: same agent, fresh gateway_down.
    const fresh = watchdogEvent({ eventType: "gateway_down", eventAt: iso(45 * MIN), eventId: "new-1" });
    const firing = evaluateCustomerIncidents(evalInput({
      agents: [a],
      watchdogEventsByAgent: new Map([[a.id, [fresh]]]),
      latestSurfaceReceiptByAgent: new Map([[a.id, fresh]]),
    }));
    expect(firing.findings.map((f) => f.key)).toEqual(["box_down:agent-1"]);
  });

  it("decides on the dedicated newest-surface-receipt query, not the 30-row timeline", () => {
    const a = agent();
    // The mixed timeline's newest surface receipt is a recovery, but the
    // dedicated receipt query found a NEWER gateway_down that the timeline
    // window crowded out — the box is down.
    const timeline = [
      watchdogEvent({ eventType: "unit_failing", eventAt: iso(5 * MIN), eventId: "noise-1" }),
      watchdogEvent({ eventType: "recovered", eventAt: iso(20 * MIN), eventId: "rec-1" }),
    ];
    const hiddenDown = watchdogEvent({ eventType: "gateway_down", eventAt: iso(10 * MIN), eventId: "hidden-1" });
    const result = evaluateCustomerIncidents(evalInput({
      agents: [a],
      watchdogEventsByAgent: new Map([[a.id, timeline]]),
      latestSurfaceReceiptByAgent: new Map([[a.id, hiddenDown]]),
    }));
    expect(result.findings.map((f) => f.key)).toEqual(["box_down:agent-1"]);
    // The diagnosis timeline still carries the mixed rows.
    expect(result.findings[0].watchdogTimeline.map((e) => e.eventId)).toEqual(["noise-1", "rec-1"]);
  });

  it("treats a stale (>24h) receipt with an unknown probe as unknown — never a finding", () => {
    // The box's newest surface receipt is a 30h-old failure on the CURRENT
    // runtime — stale bookkeeping, not a live outage. A healthy probe
    // suppresses the finding so the row archives; but a probe that could
    // not be evaluated must not produce a finding either — reporting one
    // would REOPEN an archived row and re-page with no new outage
    // evidence. The key goes unknown instead: an already-open row stays
    // open untouched.
    const a = agent();
    const stale = watchdogEvent({
      eventType: "gateway_down",
      eventAt: iso(30 * 60 * MIN),
      firstSeenAt: iso(30 * 60 * MIN),
      eventId: "stale-1",
    });
    const result = evaluateCustomerIncidents(evalInput({
      agents: [a],
      watchdogEventsByAgent: new Map([[a.id, [stale]]]),
      latestSurfaceReceiptByAgent: new Map([[a.id, stale]]),
      publicProbeUnknownAgentIds: new Set([a.id]),
    }));
    expect(result.findings).toHaveLength(0);
    expect(result.unknownKeys.has("box_down:agent-1")).toBe(true);
  });

  it("still fires a stale-receipt box_down while the public probe is failing", () => {
    // Same 30h receipt, but the probe outage is live — only a FAILED probe
    // (or a fresh receipt) reopens a stale box_down.
    const a = agent();
    const stale = watchdogEvent({
      eventType: "gateway_down",
      eventAt: iso(30 * 60 * MIN),
      firstSeenAt: iso(30 * 60 * MIN),
      eventId: "stale-2",
    });
    const result = evaluateCustomerIncidents(evalInput({
      agents: [a],
      watchdogEventsByAgent: new Map([[a.id, [stale]]]),
      latestSurfaceReceiptByAgent: new Map([[a.id, stale]]),
      publicOutageStartedAtMs: new Map([[a.id, NOW - 5 * MIN]]),
    }));
    expect(result.findings.map((f) => f.key)).toEqual(["box_down:agent-1"]);
    expect(result.unknownKeys.has("box_down:agent-1")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// evaluateCustomerIncidents — launch_failed / lifecycle_stuck / cron_unhealthy
// ---------------------------------------------------------------------------

describe("evaluateCustomerIncidents box_unreachable", () => {
  it("fires when the public probe outage is at least 10 minutes old", () => {
    const a = agent();
    const result = evaluateCustomerIncidents(evalInput({
      agents: [a],
      publicOutageStartedAtMs: new Map([[a.id, NOW - 15 * MIN]]),
    }));
    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0];
    expect(finding.rule).toBe("box_unreachable");
    expect(finding.key).toBe("box_unreachable:agent-1");
    expect(finding.subjectKind).toBe("hivra_agent");
    expect(finding.userId).toBe("user-1");
    expect(finding.route).toBe("/dashboard/agent/agent-1");
  });

  it("does not fire while the outage is younger than 10 minutes", () => {
    const a = agent();
    const result = evaluateCustomerIncidents(evalInput({
      agents: [a],
      publicOutageStartedAtMs: new Map([[a.id, NOW - 5 * MIN]]),
    }));
    expect(result.findings).toHaveLength(0);
  });

  it("still HOLDS an already-open incident while the live outage is younger than 10 minutes", () => {
    // The probe row's outage clock restarted (a reopen, or the runtime-reset
    // first_seen_at pin) while the box is STILL unreachable. The minimum age
    // gates a NEW page; an already-open incident must not resolve + notice +
    // re-page the same unreachable box once the young outage ages out.
    const a = agent();
    const result = evaluateCustomerIncidents(evalInput({
      agents: [a],
      publicOutageStartedAtMs: new Map([[a.id, NOW - 5 * MIN]]),
      openIncidentKeys: new Set(["box_unreachable:agent-1"]),
    }));
    expect(result.findings.map((f) => f.key)).toEqual(["box_unreachable:agent-1"]);
  });

  it("still resolves an open incident when the probe outage is gone — no-outage is not a grace gate", () => {
    const a = agent();
    const result = evaluateCustomerIncidents(evalInput({
      agents: [a],
      openIncidentKeys: new Set(["box_unreachable:agent-1"]),
    }));
    expect(result.findings).toHaveLength(0);
  });

  it("marks the key unknown when the probe could not be evaluated", () => {
    const a = agent();
    const result = evaluateCustomerIncidents(evalInput({
      agents: [a],
      publicProbeUnknownAgentIds: new Set([a.id]),
      publicOutageStartedAtMs: new Map([[a.id, NOW - 60 * MIN]]),
    }));
    expect(result.findings).toHaveLength(0);
    expect(result.unknownKeys.has("box_unreachable:agent-1")).toBe(true);
  });

  it("does not fire for sleeping, non-running or admin agents", () => {
    const sleeping = agent({ id: "agent-sleep", sleepState: "asleep" });
    const stopped = agent({ id: "agent-stop", status: "stopped" });
    const admin = agent({ id: "agent-admin", userId: "admin-1" });
    const outages = new Map<string, number>([
      [sleeping.id, NOW - 60 * MIN],
      [stopped.id, NOW - 60 * MIN],
      [admin.id, NOW - 60 * MIN],
    ]);
    const result = evaluateCustomerIncidents(evalInput({
      agents: [sleeping, stopped, admin],
      adminUserIds: new Set(["admin-1"]),
      publicOutageStartedAtMs: outages,
    }));
    expect(result.findings).toHaveLength(0);
  });
});

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
    sleep_tier_changed_at: null,
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
  /** When true, the open probe-row read fails (box_unreachable goes unknown). */
  publicProbeRowsFail?: boolean;
  /** When true, per-agent watchdog event queries fail (box_down goes unknown). */
  watchdogFetchFails?: boolean;
  /** When true, ops_events updates touching public-probe rows fail. */
  probeRowUpdateFails?: boolean;
  /** When set, an ops_events update filtered on this row id never resolves. */
  hangUpdateOnRowId?: string;
  /**
   * When set, any query whose (table, calls) matches never resolves —
   * exercises the collection-deadline race: the op stays in flight while
   * the scan must still finish.
   */
  hangWhen?: (table: string, calls: unknown[][]) => boolean;
  /**
   * Runs inside each query resolution before its filters apply — simulates
   * a concurrent write landing in the read→write gap of a multi-step op
   * (e.g. a probe-row refresh racing a healthy-verdict archive).
   */
  mutateWhen?: (table: string, calls: unknown[][]) => void;
  /** When true, ops_events updates touching incident.* rows fail. */
  incidentRowUpdateFails?: boolean;
  /** When true, single-row subject lookups (launch_failed expiry checks) fail. */
  subjectLookupFails?: boolean;
  /** When true, single-row subject lookups throw instead of returning an error. */
  subjectLookupThrows?: boolean;
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
  "or",
]);

/** Split a PostgREST expression list on top-level commas (paren-aware). */
function splitFilterTerms(expr: string): string[] {
  const terms: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < expr.length; i += 1) {
    const ch = expr[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (ch === "," && depth === 0) {
      terms.push(expr.slice(start, i));
      start = i + 1;
    }
  }
  terms.push(expr.slice(start));
  return terms.map((term) => term.trim()).filter((term) => term.length > 0);
}

/** Evaluate one `column.op.value` leaf of a PostgREST expression. */
function fakeLeafMatches(row: Row, leaf: string): boolean {
  const firstDot = leaf.indexOf(".");
  if (firstDot < 0) return true;
  const column = leaf.slice(0, firstDot);
  let rest = leaf.slice(firstDot + 1);
  let negated = false;
  if (rest.startsWith("not.")) {
    negated = true;
    rest = rest.slice(4);
  }
  const secondDot = rest.indexOf(".");
  const op = secondDot < 0 ? rest : rest.slice(0, secondDot);
  const raw = secondDot < 0 ? "" : rest.slice(secondDot + 1);
  const value = fakeColumnValue(row, column);
  let result: boolean;
  switch (op) {
    case "is":
      result = raw === "null" ? value == null : value === raw;
      break;
    case "eq":
      result = fakeValuesEqual(value, raw);
      break;
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      if (value == null) return negated;
      const cmp = fakeCompare(value, raw);
      result =
        op === "gt" ? cmp > 0 : op === "gte" ? cmp >= 0 : op === "lt" ? cmp < 0 : cmp <= 0;
      break;
    }
    case "in": {
      const inner = raw.startsWith("(") && raw.endsWith(")") ? raw.slice(1, -1) : raw;
      result = inner
        .split(",")
        .some((candidate) => fakeValuesEqual(value, candidate.trim()));
      break;
    }
    default:
      result = true;
  }
  return negated ? !result : result;
}

/** Evaluate an `.or(filters)` string: `and(...)`, `or(...)` groups or bare leaves. */
function fakeOrMatches(row: Row, expr: string): boolean {
  return splitFilterTerms(expr).some((term) => {
    if (term.startsWith("and(") && term.endsWith(")")) {
      return splitFilterTerms(term.slice(4, -1)).every((inner) => fakeLeafMatches(row, inner));
    }
    if (term.startsWith("or(") && term.endsWith(")")) {
      return fakeOrMatches(row, term.slice(3, -1));
    }
    return fakeLeafMatches(row, term);
  });
}

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
    case "or":
      return fakeOrMatches(row, String(a1));
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
    tableRows: rowsFor,
    from(table: string) {
      const calls: unknown[][] = [];
      const chain: Record<string, unknown> = {};
      let terminal: "none" | "single" | "maybe" = "none";
      for (const method of [
        "select",
        "update",
        "insert",
        "eq",
        "is",
        "not",
        "gte",
        "gt",
        "lt",
        "lte",
        "in",
        "like",
        "or",
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
        config.mutateWhen?.(table, calls);
        const isWatchdogQuery =
          table === "ops_events" &&
          calls.some((c) => c[0] === "eq" && c[1] === "instance_id");
        if (
          config.subjectLookupThrows &&
          terminal !== "none" &&
          (table === "hivra_agents" || table === "hermes_instances")
        ) {
          throw new Error("subject lookup exploded");
        }
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
        const isProbeRowsQuery =
          table === "ops_events" &&
          calls.some(
            (c) => c[0] === "eq" && c[1] === "source" && c[2] === "box.public_probe.unreachable",
          );
        if (config.publicProbeRowsFail && isProbeRowsQuery) {
          return { data: null, error: { message: "probe rows read failed" } };
        }
        let rows = rowsFor(table).filter((row) =>
          calls
            .filter((c) => FAKE_FILTER_METHODS.has(String(c[0])))
            .every((call) => fakeRowMatches(row, call)),
        );
        const insertCall = calls.find((c) => c[0] === "insert");
        if (insertCall) {
          // .insert(payload)[.select(...)]: append the row like production,
          // honouring the unique fingerprint constraint reportOpsEvent and
          // the probe-verdict writer rely on for their races.
          const payload = insertCall[1] as Row | Row[];
          const inserted: Row[] = (Array.isArray(payload) ? payload : [payload]).map(
            (row, index) => ({ id: `inserted-${recordedCalls.length}-${index}`, ...row }),
          );
          const tableRows = rowsFor(table);
          const conflict = inserted.find(
            (row) =>
              row.fingerprint != null &&
              tableRows.some((existing) => existing.fingerprint === row.fingerprint),
          );
          if (conflict) {
            return {
              data: null,
              error: {
                message: `duplicate key value violates unique constraint "ops_events_fingerprint_key"`,
              },
            };
          }
          for (const row of inserted) tableRows.push(row);
          if (terminal !== "none") {
            return { data: inserted[0] ?? null, error: null };
          }
          if (calls.some((c) => c[0] === "select")) {
            return { data: inserted, error: null };
          }
          return { data: null, error: null };
        }
        const updateCall = calls.find((c) => c[0] === "update");
        if (updateCall) {
          if (
            config.probeRowUpdateFails &&
            rows.some((row) => row.source === "box.public_probe.unreachable")
          ) {
            return { data: null, error: { message: "probe row update failed" } };
          }
          if (
            config.incidentRowUpdateFails &&
            rows.some((row) => String(row.source ?? "").startsWith("incident."))
          ) {
            return { data: null, error: { message: "incident row update failed" } };
          }
          // .update(payload).eq(...): mutate every filtered row in place so
          // later reads in the same scan see the write, like production.
          const payload = updateCall[1] as Row;
          for (const row of rows) Object.assign(row, payload);
          return { data: rows, error: null };
        }
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
      chain.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) => {
        if (
          config.hangUpdateOnRowId &&
          calls.some((c) => c[0] === "update") &&
          calls.some(
            (c) => c[0] === "eq" && c[1] === "id" && c[2] === config.hangUpdateOnRowId,
          )
        ) {
          // A write that never resolves — exercises the in-flight deadline
          // race: the op keeps running while the scan must still finish.
          return new Promise(() => {});
        }
        if (config.hangWhen?.(table, calls)) {
          // A read that never resolves — exercises the collection deadline.
          return new Promise(() => {});
        }
        return Promise.resolve(resolve()).then(onFulfilled, onRejected);
      };
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
    // The gateway-independent signal probe still runs once per candidate
    // (healthz only); no diagnosis probes fire for a still-open incident.
    expect(second.probe as jest.Mock).toHaveBeenCalledTimes(1);
    expect((second.probe as jest.Mock).mock.calls[0][0]).toBe(
      "https://box-1.hivra.example/healthz",
    );
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
    expect(deps.archiveIncident as jest.Mock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "evt-open-1" }),
    );
    expect(deps.notifyResolved as jest.Mock).toHaveBeenCalledTimes(1);
    const notice = (deps.notifyResolved as jest.Mock).mock.calls[0][0];
    expect(notice.title).toBe("Resolved: Customer incident: agent box down");
    expect(notice.metadata.incident_key).toBe("box_down:agent-1");
    expect(notice.fingerprint).not.toBe("fp-incident-1");
  });

  it("does NOT resolve + re-page an open box_down while a newer failure receipt is inside the grace window", async () => {
    // Regression: the incident paged on an older failure receipt; the newest
    // surface receipt (2m old) is still inside the 10-minute opening grace —
    // but it describes a box that is still down on the current runtime. The
    // suppressed finding used to let the resolve pass archive the live row
    // and send a resolved notice, then re-page the same outage once the
    // receipt aged past the window.
    const deps = scanDeps({
      db: fakeIncidentDb({
        agents: [agentDbRow()],
        openIncidents: [incidentDbRow()],
        watchdogByAgent: {
          "agent-1": [
            watchdogDbRow("unit_restart", 2 * MIN),
            watchdogDbRow("gateway_down", 45 * MIN),
          ],
        },
      }),
    });
    const summary = await runCustomerIncidentScan(deps as never);

    expect(summary).toMatchObject({ opened: 0, resolved: 0, stillOpen: 1 });
    expect(deps.archiveIncident as jest.Mock).not.toHaveBeenCalled();
    expect(deps.notifyResolved as jest.Mock).not.toHaveBeenCalled();
    expect(deps.report as jest.Mock).not.toHaveBeenCalled();
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

  it("excludes an ops admin configured only by OPS_ADMIN_EMAILS", async () => {
    // The ops pages already treat a verified-primary email match as an
    // admin; the scan's exclusion must resolve the same identity to its
    // account id or the operator's own boxes page as customer incidents.
    const prevEmails = process.env.OPS_ADMIN_EMAILS;
    const prevIds = process.env.OPS_ADMIN_USER_IDS;
    process.env.OPS_ADMIN_EMAILS = "ops@example.com";
    delete process.env.OPS_ADMIN_USER_IDS;
    try {
      const deps = scanDeps({
        db: fakeIncidentDb({
          agents: [agentDbRow({ user_id: "user_ops_1" })],
          watchdogByAgent: { "agent-1": [watchdogDbRow("recovery_exhausted", 5 * MIN)] },
        }),
        opsAdminDirectory: {
          getUserList: jest.fn(async (params: { emailAddress: string[] }) => ({
            data:
              params.emailAddress[0] === "ops@example.com"
                ? [
                    {
                      id: "user_ops_1",
                      primaryEmailAddress: {
                        emailAddress: "ops@example.com",
                        verification: { status: "verified" },
                      },
                    },
                  ]
                : [],
          })),
        },
      });
      // The dep is unset so the scan resolves the configured emails itself.
      delete (deps as Record<string, unknown>).adminUserIds;
      const summary = await runCustomerIncidentScan(deps as never);

      expect(summary).toMatchObject({ findings: 0, opened: 0 });
      expect(deps.report as jest.Mock).not.toHaveBeenCalled();
      expect(deps.probe as jest.Mock).not.toHaveBeenCalled();
    } finally {
      if (prevEmails === undefined) delete process.env.OPS_ADMIN_EMAILS;
      else process.env.OPS_ADMIN_EMAILS = prevEmails;
      if (prevIds === undefined) delete process.env.OPS_ADMIN_USER_IDS;
      else process.env.OPS_ADMIN_USER_IDS = prevIds;
    }
  });

  it("does not exclude a box when the configured email only matches an unverified address", async () => {
    // The request-time check requires the configured email on a VERIFIED
    // primary address; the exclusion applies the same bar — a user holding
    // the address unverified is a customer, not an operator.
    const prevEmails = process.env.OPS_ADMIN_EMAILS;
    const prevIds = process.env.OPS_ADMIN_USER_IDS;
    process.env.OPS_ADMIN_EMAILS = "ops@example.com";
    delete process.env.OPS_ADMIN_USER_IDS;
    try {
      const deps = scanDeps({
        db: fakeIncidentDb({
          agents: [agentDbRow({ user_id: "user_cust_1" })],
          watchdogByAgent: { "agent-1": [watchdogDbRow("recovery_exhausted", 5 * MIN)] },
        }),
        opsAdminDirectory: {
          getUserList: jest.fn(async () => ({
            data: [
              {
                id: "user_cust_1",
                primaryEmailAddress: {
                  emailAddress: "ops@example.com",
                  verification: { status: "unverified" },
                },
              },
            ],
          })),
        },
      });
      delete (deps as Record<string, unknown>).adminUserIds;
      const summary = await runCustomerIncidentScan(deps as never);

      // Not excluded: the recovery_exhausted box_down still fires.
      expect(summary.findings).toBe(1);
      expect(deps.report as jest.Mock).toHaveBeenCalledWith(
        expect.objectContaining({ source: "incident.box_down" }),
      );
    } finally {
      if (prevEmails === undefined) delete process.env.OPS_ADMIN_EMAILS;
      else process.env.OPS_ADMIN_EMAILS = prevEmails;
      if (prevIds === undefined) delete process.env.OPS_ADMIN_USER_IDS;
      else process.env.OPS_ADMIN_USER_IDS = prevIds;
    }
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
    expect(deps.archiveIncident as jest.Mock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "evt-resolved-1" }),
    );
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

  it("fails the pass — an honest failed run — when a core collection read stalls past the collection deadline", async () => {
    // Regression: the core reads had no deadline — a stalled hivra_agents
    // query held the invocation until the function ceiling killed it, so the
    // scan died BEFORE the heartbeat write and recorded as a cron failure.
    // A core read that outlives the shared collection deadline now fails the
    // pass the same way a read error does: nothing reported, nothing
    // archived, nothing resolved.
    const deps = scanDeps({
      collectionBudgetMs: 20,
      db: fakeIncidentDb({
        agents: [agentDbRow()],
        watchdogByAgent: { "agent-1": [watchdogDbRow("gateway_down", 45 * MIN)] },
        hangWhen: (table) => table === "hivra_agents",
      }),
    });
    const summary = await runCustomerIncidentScan(deps as never);

    expect(summary).toMatchObject({ failed: 1, opened: 0, resolved: 0 });
    expect(deps.report as jest.Mock).not.toHaveBeenCalled();
    expect(deps.archiveIncident as jest.Mock).not.toHaveBeenCalled();
    expect(deps.notifyResolved as jest.Mock).not.toHaveBeenCalled();
  });

  it("marks every candidate unknown + degraded when the open probe-row read stalls past the collection deadline", async () => {
    // Same shared deadline, softer verdict — identical to the read-failure
    // path: probe rows unreadable means box_unreachable goes unknown, an
    // open incident stays open, and the pass counts degraded.
    const deps = scanDeps({
      collectionBudgetMs: 20,
      db: fakeIncidentDb({
        agents: [agentDbRow()],
        watchdogByAgent: { "agent-1": [watchdogDbRow("recovered", 20 * MIN)] },
        openIncidents: [
          incidentDbRow({
            id: "evt-unreach-hang-read",
            source: "incident.box_unreachable",
            metadata: { incident_key: "box_unreachable:agent-1" },
          }),
        ],
        hangWhen: (table, calls) =>
          table === "ops_events" &&
          calls.some(
            (c) => c[0] === "eq" && c[1] === "source" && c[2] === "box.public_probe.unreachable",
          ),
      }),
    });
    const summary = await runCustomerIncidentScan(deps as never);

    expect(summary).toMatchObject({ opened: 0, resolved: 0, unknown: 1 });
    expect(summary.degraded).toBeGreaterThanOrEqual(1);
    expect(deps.probe as jest.Mock).not.toHaveBeenCalled();
    expect(deps.archiveIncident as jest.Mock).not.toHaveBeenCalled();
    expect(deps.notifyResolved as jest.Mock).not.toHaveBeenCalled();
  });

  it("reads the open probe rows inside the collection window — a slow watchdog phase cannot starve them", async () => {
    // Regression: the probe-row read used to begin only after the watchdog
    // phase, so a watchdog phase slower than the shared collection deadline
    // left the read deadline-late on arrival — every box's public-probe
    // eval went unknown exactly when watchdog reads were slow. The read now
    // starts with the core reads and is awaited before the watchdog phase:
    // here the watchdog reads hang past the whole 20ms collection window
    // (their own 40ms deadline still bounds them) yet the probe-row read
    // already has its result.
    const deps = scanDeps({
      collectionBudgetMs: 20,
      watchdogBudgetMs: 40,
      db: fakeIncidentDb({
        agents: [agentDbRow()],
        openIncidents: [
          incidentDbRow({
            id: "evt-unreach-wd",
            source: "incident.box_unreachable",
            metadata: { incident_key: "box_unreachable:agent-1" },
          }),
        ],
        hangWhen: (table, calls) =>
          table === "ops_events" &&
          calls.some((c) => c[0] === "eq" && c[1] === "instance_id"),
      }),
    });
    const summary = await runCustomerIncidentScan(deps as never);

    // The probe rows stayed readable: the probe ran and answered healthy,
    // so the open box_unreachable incident resolved normally — unknown is
    // only the watchdog-read degradation, not the probe signal.
    expect(deps.probe as jest.Mock).toHaveBeenCalledTimes(1);
    expect(summary.resolved).toBe(1);
    expect(summary.unknown).toBe(0);
    expect(summary.degraded).toBe(1);
  });

  it("degrades the diagnosis bundle to missing plan data when the subscription lookup stalls past the collection deadline", async () => {
    // Enrichment shares the collection deadline but fails soft — the same
    // shape as a lookup error: the incident still opens, its metadata just
    // carries no plan.
    const deps = scanDeps({
      collectionBudgetMs: 20,
      db: fakeIncidentDb({
        agents: [agentDbRow()],
        subscriptions: [{ user_id: "user-1", plan: "pro", status: "active" }],
        watchdogByAgent: { "agent-1": [watchdogDbRow("gateway_down", 45 * MIN)] },
        hangWhen: (table) => table === "hermes_subscriptions",
      }),
    });
    const summary = await runCustomerIncidentScan(deps as never);

    expect(summary.opened).toBe(1);
    const report = deps.report as jest.Mock;
    const ops = report.mock.calls
      .map((c) => c[0])
      .find((o) => String(o.source).startsWith("incident."));
    expect(ops.metadata.incident_key).toBe("box_down:agent-1");
    expect(ops.metadata.customer).toEqual({
      clerk_user_id: "user-1",
      plan: null,
      subscription_status: null,
    });
  });

  it("keeps a completed probe-row read when subscription enrichment stalls past the collection deadline", async () => {
    // Regression: the probe-row read raced the shared collection deadline
    // but was awaited AFTER subscription enrichment — a stalled lookup
    // consumed the window and the already-finished probe-row result was
    // discarded, sending every candidate's public probe to unknown. The
    // probe rows gate incident correctness and enrichment only decorates
    // it, so the read is now awaited first: here the probe still resolves
    // the open box_unreachable while plan data degrades.
    const deps = scanDeps({
      collectionBudgetMs: 20,
      db: fakeIncidentDb({
        agents: [agentDbRow()],
        subscriptions: [{ user_id: "user-1", plan: "pro", status: "active" }],
        openIncidents: [
          incidentDbRow({
            id: "evt-unreach-enrich",
            source: "incident.box_unreachable",
            metadata: { incident_key: "box_unreachable:agent-1" },
          }),
        ],
        watchdogByAgent: { "agent-1": [watchdogDbRow("recovered", 20 * MIN)] },
        hangWhen: (table) => table === "hermes_subscriptions",
      }),
    });
    const summary = await runCustomerIncidentScan(deps as never);

    // The probe-row result landed in-budget: the probe ran, answered
    // healthy, and the open incident resolved normally.
    expect(deps.probe as jest.Mock).toHaveBeenCalledTimes(1);
    expect(summary.resolved).toBe(1);
    expect(summary.unknown).toBe(0);
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

  it("reads every agent in one consistent snapshot — a mid-scan restart cannot tear eligibility", async () => {
    // Regression: the three eligibility predicates ran as separate paged
    // queries merged by id, last-writer-wins. An agent that stopped between
    // the running-read and the in-flight-op read contributed the SECOND
    // snapshot — stopped — so box_down saw no live agent and the open
    // incident resolved (with a notice) without the box ever being probed.
    // One union read gives each row exactly one snapshot; here the row is
    // swapped only if the retired in-flight-op query shape ever runs.
    const agents = [
      agentDbRow({
        status: "running",
        operation_kind: "restart",
        // A live op — not yet stuck (10m < 15m) — but recent enough to be
        // the runtime marker: the failure receipt must postdate it.
        operation_started_at: iso(10 * MIN),
      }),
    ];
    const db = fakeIncidentDb({
      agents,
      openIncidents: [incidentDbRow({ occurrence_count: 1, last_seen_at: iso(4 * MIN) })],
      watchdogByAgent: { "agent-1": [watchdogDbRow("gateway_down", 5 * MIN)] },
      mutateWhen: (table, calls) => {
        // The retired in-flight-op subject read is the only query carrying
        // this NOT-IS-NULL pair: land the restart there to reproduce the
        // torn merge. The single union read never issues it.
        if (
          table === "hivra_agents" &&
          calls.some((c) => c[0] === "not" && c[1] === "operation_kind") &&
          calls.some((c) => c[0] === "not" && c[1] === "operation_started_at")
        ) {
          agents[0] = agentDbRow({
            status: "stopped",
            operation_kind: "restart",
            operation_started_at: iso(10 * MIN),
          });
        }
      },
    });
    const deps = scanDeps({ db });
    const summary = await runCustomerIncidentScan(deps as never);

    // The read saw the box as it was — running with a fresh gateway_down
    // receipt — so the open incident holds: touched, not resolved, never
    // re-paged.
    expect(summary.resolved).toBe(0);
    expect(deps.notifyResolved as jest.Mock).not.toHaveBeenCalled();
    expect(deps.archiveIncident as jest.Mock).not.toHaveBeenCalled();
    // The subject read itself carries the union in ONE ordered paged
    // query — no second per-predicate read remains to capture a torn row.
    const subjectReads = db.calls.filter(
      (entry) =>
        entry.table === "hivra_agents" &&
        entry.calls.some((call) => call[0] === "order" && call[1] === "id"),
    );
    expect(subjectReads).toHaveLength(1);
    expect(subjectReads[0].calls.some((call) => call[0] === "or")).toBe(true);
  });

  it("marks remaining probes as skipped once the scan probe budget is exhausted", async () => {
    let tick = 0;
    const deps = scanDeps({
      clock: () => (tick += 100_000), // each read jumps past the 90s budget
      probeBudgetMs: 90_000,
      // The watchdog read, collection and report deadlines share the same
      // clock; keep them far away so only the probe budget is exercised here.
      watchdogBudgetMs: 24 * 60 * 60 * 1000,
      collectionBudgetMs: 24 * 60 * 60 * 1000,
      reportBudgetMs: 24 * 60 * 60 * 1000,
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
    // clock: the scan-start deadline reads (probe, watchdog, collection)
    // return 0, as do the four collection-phase races (core reads,
    // ops-admin id resolution, probe rows, subscriptions — the probe-row
    // read and the admin-id resolution now run inside the collection
    // window); agent-1's watchdog admission check and its in-flight bound
    // read are still inside the 60s budget; the admission check for
    // agent-2 jumps past it, so its receipts are never read — it must be
    // unknown, not resolved.
    const times = [0, 0, 0, 0, 0, 0, 0, 0, 0, 200_000];
    let tick = 0;
    const clock = () => times[Math.min(tick++, times.length - 1)];
    const deps = scanDeps({
      clock,
      watchdogBudgetMs: 60_000,
      // Keep the public-probe budget far away so only the watchdog deadline
      // is exercised; the default probe answers 200 (up) for both agents.
      probeBudgetMs: 24 * 60 * 60 * 1000,
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
    expect(deps.archiveIncident as jest.Mock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "evt-lf-1" }),
      { closedReason: "expired_unresolved" },
    );
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
    expect(deps.archiveIncident as jest.Mock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "evt-lf-2" }),
    );
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
    expect(summary.degraded).toBe(1);
    expect(deps.archiveIncident as jest.Mock).not.toHaveBeenCalled();
  });

  it("counts a thrown launch_failed subject lookup as degraded and leaves the row open", async () => {
    const deps = scanDeps({
      db: fakeIncidentDb({
        agents: [
          agentDbRow({
            id: "agent-thrown",
            status: "error",
            provisioned_at: null,
            created_at: iso(30 * 24 * 60 * MIN),
          }),
        ],
        subjectLookupThrows: true,
        openIncidents: [
          incidentDbRow({
            id: "evt-lf-t",
            source: "incident.launch_failed",
            metadata: {
              incident_key: "launch_failed:agent-thrown",
              subject_kind: "hivra_agent",
            },
          }),
        ],
      }),
    });
    const summary = await runCustomerIncidentScan(deps as never);
    expect(summary).toMatchObject({ expired: 0, resolved: 0 });
    expect(summary.degraded).toBe(1);
    expect(deps.archiveIncident as jest.Mock).not.toHaveBeenCalled();
  });

  it("does not archive an incident row whose occurrence moved after the snapshot", async () => {
    const racedRow = incidentDbRow({
      id: "evt-raced",
      occurrence_count: 3,
      last_seen_at: iso(2 * MIN),
      metadata: { incident_key: "box_down:gone-race" },
    });
    const deps = scanDeps({
      // No archiveIncident dep — the real defaultArchiveIncident runs against
      // the fake DB so the occurrence guard is exercised end to end.
      archiveIncident: undefined,
      report: jest.fn(async () => {
        // A concurrent re-report lands between the snapshot read and the
        // archive: occurrence_count and last_seen_at move, so the observed
        // occurrence is no longer the row's current state.
        racedRow.occurrence_count = 4;
        racedRow.last_seen_at = iso(0);
        return { id: "evt-new-1", fingerprint: "fp" };
      }),
      db: fakeIncidentDb({
        agents: [],
        heartbeats: [
          {
            cron_name: "test-cron",
            last_run_at: iso(5 * MIN),
            last_success_at: iso(5 * MIN),
            run_count: 30,
            ok_count: 20,
            consecutive_failures: 3,
            last_detail: "failed=2",
          },
        ],
        openIncidents: [racedRow],
      }),
    });
    const summary = await runCustomerIncidentScan(deps as never);

    // The cron_unhealthy finding still opens; the raced row stays open and
    // unarchived — the next pass re-evaluates the fresh occurrence.
    expect(summary.opened).toBe(1);
    expect(summary.resolved).toBe(0);
    expect(deps.notifyResolved as jest.Mock).not.toHaveBeenCalled();
    expect(racedRow.archived_at).toBeUndefined();
  });

  it("archives normally when the observed occurrence is still current", async () => {
    const deps = scanDeps({
      archiveIncident: undefined,
      db: fakeIncidentDb({
        agents: [],
        openIncidents: [
          incidentDbRow({
            id: "evt-current",
            occurrence_count: 2,
            last_seen_at: iso(4 * MIN),
            metadata: { incident_key: "box_down:gone-current" },
          }),
        ],
      }),
    });
    const summary = await runCustomerIncidentScan(deps as never);

    expect(summary.resolved).toBe(1);
    expect(deps.notifyResolved as jest.Mock).toHaveBeenCalledTimes(1);
  });

  it("sends a distinct resolved notice for each archive transition of the same incident", async () => {
    const mkRow = (count: number, seenAgo: number) =>
      incidentDbRow({
        id: "evt-recurring",
        occurrence_count: count,
        last_seen_at: iso(seenAgo),
        metadata: { incident_key: "box_down:gone-recurring" },
      });

    // Transition 1: the incident resolves on this tick.
    const deps1 = scanDeps({
      db: fakeIncidentDb({ agents: [], openIncidents: [mkRow(1, 10 * MIN)] }),
    });
    await runCustomerIncidentScan(deps1 as never);
    const first = (deps1.notifyResolved as jest.Mock).mock.calls[0][0].fingerprint;

    // reportOpsEvent un-archives the row on recurrence (occurrence 2); it
    // resolves again one tick later.
    const deps2 = scanDeps({
      now: () => NOW + 5 * MIN,
      db: fakeIncidentDb({ agents: [], openIncidents: [mkRow(2, 5 * MIN)] }),
    });
    await runCustomerIncidentScan(deps2 as never);
    const second = (deps2.notifyResolved as jest.Mock).mock.calls[0][0].fingerprint;

    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
  });

  it("archives a stale box_down silently when receipts went quiet and the public probe is healthy", async () => {
    // The box restarted 2h ago (sleep-tier marker); its only surface receipt
    // is a gateway_down from 30h ago — pre-restart, so box_down does not hold.
    // The public /healthz probe succeeds this scan, so the open incident row
    // is stale bookkeeping: archive with closed_reason, no resolved notice.
    const db = fakeIncidentDb({
      agents: [agentDbRow({ sleep_tier_changed_at: iso(2 * 60 * MIN) })],
      watchdogByAgent: {
        "agent-1": [watchdogDbRow("gateway_down", 30 * 60 * MIN)],
      },
      openIncidents: [incidentDbRow()],
    });
    const deps = scanDeps({
      db,
      probe: jest.fn(async () => ({ status: 200, latencyMs: 8, error: null })),
    });
    const summary = await runCustomerIncidentScan(deps as never);

    expect(summary).toMatchObject({ findings: 0, opened: 0, resolved: 0, expired: 1 });
    expect(deps.archiveIncident).toHaveBeenCalledWith(
      expect.objectContaining({ id: "evt-open-1" }),
      { closedReason: "stale_no_new_receipts" },
    );
    expect(deps.notifyResolved).not.toHaveBeenCalled();
  });

  it("does NOT stale-archive a box_down while the public probe is still failing", async () => {
    const db = fakeIncidentDb({
      agents: [agentDbRow({ sleep_tier_changed_at: iso(2 * 60 * MIN) })],
      watchdogByAgent: {
        "agent-1": [watchdogDbRow("gateway_down", 30 * 60 * MIN)],
      },
      openIncidents: [incidentDbRow()],
    });
    const deps = scanDeps({
      db,
      probe: jest.fn(async () => ({ status: 502, latencyMs: 120, error: null })),
    });
    const summary = await runCustomerIncidentScan(deps as never);

    // Probe failing → the outage is live (box_unreachable may fire); the
    // box_down row still resolves through the normal noticed path.
    expect(summary.expired).toBe(0);
    const archiveCalls = (deps.archiveIncident as jest.Mock).mock.calls;
    expect(archiveCalls).toHaveLength(1);
    expect(archiveCalls[0][0]).toEqual(expect.objectContaining({ id: "evt-open-1" }));
    expect(archiveCalls[0][1]).toBeUndefined();
  });

  it("picks the newest surface receipt by effective time, not raw event_at ordering", async () => {
    // A receipt row with a missing event_at sorts FIRST under DESC ordering
    // in Postgres — a limit(1) read on event_at would pick it and drop the
    // genuinely newer gateway_down. The window read orders by first_seen_at
    // and the newest effective time wins in code.
    const db = fakeIncidentDb({
      agents: [agentDbRow()],
      watchdogByAgent: {
        "agent-1": [
          // Recorded 45m ago, no box-reported event_at — effective time is
          // first_seen_at (45m), so it is OLDER than the gateway_down.
          watchdogDbRow("recovered", 45 * MIN, { event_at: null }),
          watchdogDbRow("gateway_down", 30 * MIN),
        ],
      },
    });
    const deps = scanDeps({ db });
    const summary = await runCustomerIncidentScan(deps as never);

    expect(summary.opened).toBe(1);
    const ops = (deps.report as jest.Mock).mock.calls
      .map((c) => c[0])
      .find((o) => String(o.source).startsWith("incident."));
    expect(ops.metadata.incident_key).toBe("box_down:agent-1");
  });

  it("does not let late-relayed failure receipts starve a newer recovery out of the receipt window", async () => {
    // A recovery was recorded, then a burst of receipts with OLDER event_at
    // but NEWER first_seen_at got relayed (backlog drain). A single mixed
    // first_seen_at window fills with the late failures and the recovery
    // falls outside it — the evaluator would keep a box_down open for a box
    // that already recovered. Each receipt kind gets its own window, so
    // neither can push the other out.
    const lateFailures = Array.from({ length: 12 }, (_, i) =>
      watchdogDbRow("unit_restart", 2 * MIN, {
        event_id: `stale-${i}`,
        // Recorded 2m ago but effective 35m+ ago — older than the recovery.
        event_at: iso((35 + i) * MIN),
      }),
    );
    const db = fakeIncidentDb({
      agents: [agentDbRow()],
      watchdogByAgent: {
        "agent-1": [
          // The genuinely newest effective receipt — recovery 3m ago.
          watchdogDbRow("recovered", 3 * MIN, { event_id: "rec-now" }),
          ...lateFailures,
        ],
      },
      openIncidents: [incidentDbRow()],
    });
    const deps = scanDeps({ db });
    const summary = await runCustomerIncidentScan(deps as never);

    expect(summary.opened).toBe(0);
    // The open box_down incident resolves: the recovery is the newest
    // effective receipt even though the window is full of newer-RECORDED
    // failure rows.
    expect(summary.resolved).toBe(1);
    expect(deps.notifyResolved).toHaveBeenCalled();
  });

  it("does not let late-relayed recovery receipts starve a live failure out of the receipt window", async () => {
    // Mirror image: a live failure is the newest effective receipt, but a
    // burst of stale recoveries recorded afterwards fills a mixed window —
    // a box that is actually down would silently resolve.
    const lateRecoveries = Array.from({ length: 12 }, (_, i) =>
      watchdogDbRow("recovered", 2 * MIN, {
        event_id: `stale-rec-${i}`,
        event_at: iso((40 + i) * MIN),
      }),
    );
    const db = fakeIncidentDb({
      agents: [agentDbRow()],
      watchdogByAgent: {
        "agent-1": [
          // Newest effective receipt: gateway_down 15m ago (past grace).
          watchdogDbRow("gateway_down", 15 * MIN, { event_id: "down-now" }),
          ...lateRecoveries,
        ],
      },
      openIncidents: [incidentDbRow()],
    });
    const deps = scanDeps({ db });
    const summary = await runCustomerIncidentScan(deps as never);

    // The live outage is still seen: the incident stays open and is never
    // resolved on a window full of stale recoveries.
    expect(summary.resolved).toBe(0);
    expect(summary.stillOpen).toBe(1);
    expect(deps.archiveIncident).not.toHaveBeenCalled();
    expect(deps.notifyResolved).not.toHaveBeenCalled();
  });

  it("archives a stale box_down whose receipt is post-marker but over 24h old while the probe is healthy", async () => {
    // No runtime marker newer than the receipt: the gateway_down is 30h old
    // but belongs to the CURRENT runtime, so it still produces a finding
    // upstream of this fix — pinning the open incident forever. With the
    // probe healthy this scan it is stale bookkeeping: archive silently,
    // and never re-page (a fresh incident report would reopen the row next
    // tick and page again).
    const db = fakeIncidentDb({
      agents: [agentDbRow()],
      watchdogByAgent: {
        "agent-1": [watchdogDbRow("gateway_down", 30 * 60 * MIN)],
      },
      openIncidents: [incidentDbRow()],
    });
    const deps = scanDeps({ db }); // default probe answers 200 → healthy
    const summary = await runCustomerIncidentScan(deps as never);

    expect(summary).toMatchObject({ findings: 0, opened: 0, resolved: 0, expired: 1 });
    expect(deps.archiveIncident).toHaveBeenCalledWith(
      expect.objectContaining({ id: "evt-open-1" }),
      { closedReason: "stale_no_new_receipts" },
    );
    expect(deps.notifyResolved).not.toHaveBeenCalled();
    // No incident ops event was reported — the row cannot re-open and re-page.
    const report = deps.report as jest.Mock;
    expect(
      report.mock.calls.map((c) => c[0]).filter((o) => String(o.source).startsWith("incident.")),
    ).toHaveLength(0);
  });

  it("keeps a stale-receipt box_down open while the public probe is still failing", async () => {
    // Same 30h post-marker receipt, but the probe is down: the outage is
    // live, so the finding must still hold the incident open.
    const db = fakeIncidentDb({
      agents: [agentDbRow()],
      watchdogByAgent: {
        "agent-1": [watchdogDbRow("gateway_down", 30 * 60 * MIN)],
      },
      openIncidents: [incidentDbRow()],
    });
    const deps = scanDeps({
      db,
      probe: jest.fn(async () => ({ status: 502, latencyMs: 120, error: null })),
    });
    const summary = await runCustomerIncidentScan(deps as never);

    expect(summary).toMatchObject({ stillOpen: 1, expired: 0, resolved: 0 });
    expect(deps.archiveIncident).not.toHaveBeenCalled();
  });

  it("does not reopen + re-page a stale box_down when the probe cannot be evaluated", async () => {
    // Same 30h post-marker receipt, but this scan could not evaluate the
    // probe at all (the open probe-row read failed). The stale receipt
    // alone is not evidence of a new outage: producing a finding would
    // REOPEN the silently archived incident row through reportOpsEvent
    // and re-page with no new outage evidence. The key must go unknown —
    // no incident ops event is reported.
    const db = fakeIncidentDb({
      agents: [agentDbRow()],
      watchdogByAgent: {
        "agent-1": [watchdogDbRow("gateway_down", 30 * 60 * MIN)],
      },
      publicProbeRowsFail: true,
      // No open incident row — it was silently archived on an earlier
      // healthy-probe scan.
    });
    const deps = scanDeps({ db });
    const summary = await runCustomerIncidentScan(deps as never);

    const incidentReports = (deps.report as jest.Mock).mock.calls
      .map((c) => c[0])
      .filter((o) => String(o.source).startsWith("incident."));
    expect(incidentReports).toHaveLength(0);
    expect(summary.opened).toBe(0);
    // The unread probe marks every candidate unknown + degraded.
    expect(summary.degraded).toBe(1);
  });

  it("leaves an open stale box_down row untouched while the probe is unknown", async () => {
    // An open row backed by the stale receipt: the unknown probe means the
    // scan can neither confirm the outage (re-report) nor clear it
    // (archive) — the row stays open, untouched, for the next pass.
    const row = incidentDbRow();
    const db = fakeIncidentDb({
      agents: [agentDbRow()],
      watchdogByAgent: {
        "agent-1": [watchdogDbRow("gateway_down", 30 * 60 * MIN)],
      },
      publicProbeRowsFail: true,
      openIncidents: [row],
    });
    const deps = scanDeps({ db });
    const summary = await runCustomerIncidentScan(deps as never);

    const incidentReports = (deps.report as jest.Mock).mock.calls
      .map((c) => c[0])
      .filter((o) => String(o.source).startsWith("incident."));
    expect(incidentReports).toHaveLength(0);
    expect(summary.unknown).toBe(1);
    expect(summary.resolved).toBe(0);
    expect(summary.expired).toBe(0);
    expect(deps.archiveIncident).not.toHaveBeenCalled();
    // Not even the still-open version touch: the row is completely
    // untouched this pass.
    expect(row.last_seen_at).toBeUndefined();
  });

  it("does not page box_down on a failure receipt that only just landed before the insert", async () => {
    // The evaluation aged a 45-minute-old gateway_down past the grace —
    // but the outage it described ended and a new one began in the
    // report gap: the newest receipt at insert time is seconds old and
    // has not earned a page. The re-check must age the CURRENT receipt,
    // not reuse the evaluated age.
    let subjectReRead = false;
    const db = fakeIncidentDb({
      agents: [agentDbRow()],
      watchdogByAgent: { "agent-1": [watchdogDbRow("gateway_down", 45 * MIN)] },
      mutateWhen: (table, calls) => {
        // The pre-insert re-check reads the subject, then the receipt
        // windows: land the fresh failure in that gap. The subject re-read
        // is the only hivra_agents lookup filtered by id.
        if (
          table === "hivra_agents" &&
          calls.some((c) => c[0] === "eq" && c[1] === "id")
        ) {
          subjectReRead = true;
        }
        if (
          subjectReRead &&
          table === "ops_events" &&
          calls.some((c) => c[0] === "in" && c[1] === "metadata->>event_type")
        ) {
          db.tableRows("ops_events").push({
            ...watchdogDbRow("gateway_down", 1 * MIN, { event_id: "e2" }),
            id: "ops-fresh-down",
            source: "box.surface_watchdog.event",
            instance_id: "agent-1",
          });
          subjectReRead = false;
        }
      },
    });
    const deps = scanDeps({ db });
    const summary = await runCustomerIncidentScan(deps as never);

    expect(summary.opened).toBe(0);
    const incidentReports = (deps.report as jest.Mock).mock.calls
      .map((c) => c[0])
      .filter((o) => String(o.source).startsWith("incident."));
    expect(incidentReports).toHaveLength(0);
  });

  it("pages box_down immediately on a fresh recovery_exhausted receipt, grace aside", async () => {
    // Same gap, but the new receipt is recovery_exhausted — the box's own
    // recovery gave up. That verdict keeps its immediate page; the grace
    // window only holds back receipts that may still be recovering.
    let subjectReRead = false;
    const db = fakeIncidentDb({
      agents: [agentDbRow()],
      watchdogByAgent: { "agent-1": [watchdogDbRow("unit_restart", 45 * MIN)] },
      mutateWhen: (table, calls) => {
        if (
          table === "hivra_agents" &&
          calls.some((c) => c[0] === "eq" && c[1] === "id")
        ) {
          subjectReRead = true;
        }
        if (
          subjectReRead &&
          table === "ops_events" &&
          calls.some((c) => c[0] === "in" && c[1] === "metadata->>event_type")
        ) {
          db.tableRows("ops_events").push({
            ...watchdogDbRow("recovery_exhausted", 1 * MIN, { event_id: "e2" }),
            id: "ops-fresh-exhausted",
            source: "box.surface_watchdog.event",
            instance_id: "agent-1",
          });
          subjectReRead = false;
        }
      },
    });
    const deps = scanDeps({ db });
    const summary = await runCustomerIncidentScan(deps as never);

    expect(summary.opened).toBe(1);
    const incidentReports = (deps.report as jest.Mock).mock.calls
      .map((c) => c[0])
      .filter((o) => String(o.source).startsWith("incident."));
    expect(incidentReports).toHaveLength(1);
    expect(incidentReports[0].metadata.incident_key).toBe("box_down:agent-1");
  });

  // ---- public probe signal (box_unreachable) -------------------------------

  describe("public probe signal", () => {
    const probeRow = (over: Row = {}): Row => ({
      id: "probe-row-1",
      fingerprint: "fp-probe-1",
      source: "box.public_probe.unreachable",
      instance_id: "agent-1",
      first_seen_at: iso(15 * MIN),
      ...over,
    });
    const incidentReports = (report: jest.Mock) =>
      report.mock.calls.map((c) => c[0]).filter((o) => String(o.source).startsWith("incident."));
    const probeReports = (report: jest.Mock) =>
      report.mock.calls
        .map((c) => c[0])
        .filter((o) => o.source === "box.public_probe.unreachable");
    const opsUpdates = (db: { calls: Array<{ table: string; calls: unknown[][] }> }) =>
      db.calls
        .filter((e) => e.table === "ops_events")
        .flatMap((e) => e.calls)
        .filter((c) => c[0] === "update");

    it("records a fresh probe outage as a warn row and restarts its clock on reopen", async () => {
      const db = fakeIncidentDb({ agents: [agentDbRow()] });
      const deps = scanDeps({
        db,
        probe: jest.fn(async () => ({ status: 502, latencyMs: 120, error: null })),
      });
      const summary = await runCustomerIncidentScan(deps as never);

      expect(summary.opened).toBe(0);
      const report = deps.report as jest.Mock;
      expect(incidentReports(report)).toHaveLength(0);
      const rows = probeReports(report);
      expect(rows).toHaveLength(1);
      expect(rows[0].severity).toBe("warn");
      expect(rows[0].page).toBe(false);
      expect(rows[0].instanceId).toBe("agent-1");
      expect(rows[0].userId).toBe("user-1");
      // The outage-start pin is atomic with the reopen: reportOpsEvent resets
      // first_seen_at inside the same archived→open write, so a recurrence
      // cannot inherit the previous outage's clock.
      expect(rows[0].resetFirstSeenOnReopen).toBe(true);
      // No separate timestamp write remains.
      const pin = opsUpdates(db).find(
        (c) => (c[1] as Row).first_seen_at === new Date(NOW).toISOString(),
      );
      expect(pin).toBeUndefined();
    });

    it("pages box_unreachable once the open probe outage is 10+ minutes old", async () => {
      const deps = scanDeps({
        db: fakeIncidentDb({
          agents: [agentDbRow()],
          probeRows: [probeRow()],
        }),
        probe: jest.fn(async () => ({ status: null, latencyMs: 5000, error: "The operation timed out" })),
      });
      const summary = await runCustomerIncidentScan(deps as never);

      expect(summary.opened).toBe(1);
      const report = deps.report as jest.Mock;
      const rows = probeReports(report);
      expect(rows).toHaveLength(1);
      expect(rows[0].severity).toBe("warn");
      expect(rows[0].page).toBe(false);
      const incidents = incidentReports(report);
      expect(incidents).toHaveLength(1);
      expect(incidents[0].source).toBe("incident.box_unreachable");
      expect(incidents[0].page).toBe(true);
      expect(incidents[0].metadata.incident_key).toBe("box_unreachable:agent-1");
      expect(incidents[0].metadata.agent).toMatchObject({ id: "agent-1" });
      expect(incidents[0].metadata.watchdog).toBeNull();
    });

    it("archives the probe row and resolves the incident when the probe succeeds", async () => {
      const db = fakeIncidentDb({
        agents: [agentDbRow()],
        probeRows: [probeRow()],
        openIncidents: [
          incidentDbRow({
            id: "evt-unreach-1",
            source: "incident.box_unreachable",
            title: "Customer incident: agent box unreachable",
            metadata: { incident_key: "box_unreachable:agent-1" },
          }),
        ],
        watchdogByAgent: { "agent-1": [watchdogDbRow("recovered", 20 * MIN)] },
      });
      const deps = scanDeps({ db }); // default probe answers 200 → up
      const summary = await runCustomerIncidentScan(deps as never);

      expect(summary.resolved).toBe(1);
      expect(opsUpdates(db).some((c) => (c[1] as Row).archived_at != null)).toBe(true);
      expect(deps.archiveIncident as jest.Mock).toHaveBeenCalledWith(
        expect.objectContaining({ id: "evt-unreach-1" }),
      );
      expect(deps.notifyResolved as jest.Mock).toHaveBeenCalledTimes(1);
      expect(incidentReports(deps.report as jest.Mock)).toHaveLength(0);
    });

    it("never opens box_unreachable from a stale probe row when the healthy-probe archive fails", async () => {
      // The probe answered 200 but archiving the 15-minute-old outage row
      // failed: the stored row is stale data, not evidence of a live
      // outage. Treating it as one would page a box that just answered
      // publicly — the subject must go unknown instead, which also keeps an
      // existing incident open for a later pass to retry the archive.
      const row = probeRow(); // first_seen 15m ago — past the page threshold
      const db = fakeIncidentDb({
        agents: [agentDbRow()],
        probeRows: [row],
        probeRowUpdateFails: true,
        openIncidents: [
          incidentDbRow({
            id: "evt-unreach-archerr",
            source: "incident.box_unreachable",
            title: "Customer incident: agent box unreachable",
            metadata: { incident_key: "box_unreachable:agent-1" },
          }),
        ],
      });
      const deps = scanDeps({ db }); // default probe answers 200 → up
      const summary = await runCustomerIncidentScan(deps as never);

      expect(row.archived_at).toBeUndefined();
      expect(summary.opened).toBe(0);
      expect(summary.resolved).toBe(0);
      expect(summary.unknown).toBe(1);
      expect(summary.degraded).toBe(1);
      expect(incidentReports(deps.report as jest.Mock)).toHaveLength(0);
      expect(deps.archiveIncident as jest.Mock).not.toHaveBeenCalled();
    });

    it("a budget-skipped probe neither opens nor resolves box_unreachable", async () => {
      const deps = scanDeps({
        probeBudgetMs: 0,
        watchdogBudgetMs: 24 * 60 * 60 * 1000,
        db: fakeIncidentDb({
          agents: [agentDbRow()],
          probeRows: [probeRow()],
          openIncidents: [
            incidentDbRow({
              id: "evt-unreach-2",
              source: "incident.box_unreachable",
              metadata: { incident_key: "box_unreachable:agent-1" },
            }),
          ],
          watchdogByAgent: { "agent-1": [watchdogDbRow("recovered", 20 * MIN)] },
        }),
      });
      const summary = await runCustomerIncidentScan(deps as never);

      expect(deps.probe as jest.Mock).not.toHaveBeenCalled();
      expect(summary.resolved).toBe(0);
      expect(summary.unknown).toBe(1);
      expect(summary.degraded).toBe(1);
      expect(deps.archiveIncident as jest.Mock).not.toHaveBeenCalled();
      expect(incidentReports(deps.report as jest.Mock)).toHaveLength(0);
    });

    it("marks every candidate's box_unreachable unknown when probe rows cannot be read", async () => {
      const deps = scanDeps({
        db: fakeIncidentDb({
          agents: [agentDbRow()],
          publicProbeRowsFail: true,
          openIncidents: [
            incidentDbRow({
              id: "evt-unreach-3",
              source: "incident.box_unreachable",
              metadata: { incident_key: "box_unreachable:agent-1" },
            }),
          ],
        }),
      });
      const summary = await runCustomerIncidentScan(deps as never);

      expect(deps.probe as jest.Mock).not.toHaveBeenCalled();
      expect(summary.resolved).toBe(0);
      expect(summary.unknown).toBe(1);
      expect(summary.degraded).toBe(1);
      expect(deps.archiveIncident as jest.Mock).not.toHaveBeenCalled();
    });

    it("a recurring outage restarts the 10-minute clock instead of inheriting the archived row's age", async () => {
      const db = fakeIncidentDb({
        agents: [agentDbRow()],
        // The previous outage's row was archived an hour ago; it is invisible
        // to the open-row read but reportOpsEvent would un-archive it — the
        // resetFirstSeenOnReopen option rewrites first_seen_at inside that
        // same write so THIS outage gets a fresh 10-minute clock.
        probeRows: [
          probeRow({
            id: "probe-old",
            archived_at: iso(60 * MIN),
            first_seen_at: iso(60 * MIN),
          }),
        ],
      });
      const deps = scanDeps({
        db,
        probe: jest.fn(async () => ({ status: 503, latencyMs: 80, error: null })),
      });
      const summary = await runCustomerIncidentScan(deps as never);

      expect(summary.opened).toBe(0);
      const rows = probeReports(deps.report as jest.Mock);
      expect(rows).toHaveLength(1);
      expect(rows[0].resetFirstSeenOnReopen).toBe(true);
      expect(incidentReports(deps.report as jest.Mock)).toHaveLength(0);
    });

    it("counts the tunnel catch-all's edge-side 404 as down, not up", async () => {
      // The Cloudflare tunnel config ends in a catch-all http_status:404
      // ingress rule: a hostname with no live ingress answers 404 without
      // reaching the box. Only a 200 proves the box served /healthz.
      const deps = scanDeps({
        db: fakeIncidentDb({
          agents: [agentDbRow()],
          probeRows: [probeRow()],
        }),
        probe: jest.fn(async () => ({ status: 404, latencyMs: 30, error: null })),
      });
      const summary = await runCustomerIncidentScan(deps as never);

      // The 15-minute outage stands → box_unreachable pages.
      expect(summary.opened).toBe(1);
      const incidents = incidentReports(deps.report as jest.Mock);
      expect(incidents.map((o) => o.metadata.incident_key)).toEqual([
        "box_unreachable:agent-1",
      ]);
    });

    it("does not archive the probe row when its version moved after the scan read it", async () => {
      // The scan observes the row open, probes healthy, then archives — but
      // a concurrent scan recorded a fresh failure in between (last_seen_at
      // and occurrence_count bumped). The version-guarded archive must
      // no-op, leaving the new outage clock intact and the subject unknown.
      const racedRow = probeRow({
        occurrence_count: 4,
        last_seen_at: iso(10 * MIN),
      });
      const db = fakeIncidentDb({
        agents: [agentDbRow()],
        probeRows: [racedRow],
        openIncidents: [
          incidentDbRow({
            id: "evt-unreach-race",
            source: "incident.box_unreachable",
            metadata: { incident_key: "box_unreachable:agent-1" },
          }),
        ],
      });
      const deps = scanDeps({
        db,
        probe: jest.fn(async () => {
          // The concurrent failure lands between the open-row read and the
          // healthy-probe archive.
          racedRow.occurrence_count = 5;
          racedRow.last_seen_at = iso(1 * MIN);
          return { status: 200, latencyMs: 9, error: null };
        }),
      });
      const summary = await runCustomerIncidentScan(deps as never);

      expect(racedRow.archived_at).toBeUndefined();
      expect(summary.resolved).toBe(0);
      expect(summary.unknown).toBe(1);
      expect(deps.archiveIncident as jest.Mock).not.toHaveBeenCalled();
    });

    it("archives the probe row when its version is still what the scan observed", async () => {
      const row = probeRow({ occurrence_count: 4, last_seen_at: iso(10 * MIN) });
      const db = fakeIncidentDb({ agents: [agentDbRow()], probeRows: [row] });
      const deps = scanDeps({ db, clock: () => NOW }); // default probe answers 200 → up
      await runCustomerIncidentScan(deps as never);

      expect(row.archived_at).toBe(new Date(NOW).toISOString());
    });

    it("stamps the archive with the healthy probe's observation time, not scan start", async () => {
      // Verdict timestamps order the outage record by when the observation
      // was taken: an archived_at stamped at scan start would predate a
      // stalled down-report observed between scan start and the healthy
      // probe, letting that obsolete observation satisfy reportOpsEvent's
      // stale-reopen guard and resurrect the outage the probe just closed.
      const row = probeRow({ occurrence_count: 4, last_seen_at: iso(10 * MIN) });
      const probe = jest.fn(async () => ({ status: 200, latencyMs: 9, error: null }));
      const db = fakeIncidentDb({ agents: [agentDbRow()], probeRows: [row] });
      const deps = scanDeps({
        db,
        // Scan start (deps.now) is NOW; the probe returns 45s later on the
        // scan clock — the archive must carry THAT time.
        clock: () => (probe.mock.calls.length > 0 ? NOW + 45_000 : NOW),
        probe,
      });
      await runCustomerIncidentScan(deps as never);

      expect(row.archived_at).toBe(new Date(NOW + 45_000).toISOString());
    });

    it("persists the healthy verdict on the probe fingerprint row when no outage is open", async () => {
      // A healthy scan used to write nothing when no probe row was open —
      // leaving a stalled down-report INSERT nothing to contradict. The
      // scan now stamps an already-archived verdict row at the healthy
      // observation time, so reportOpsEvent's stale-verdict guard can
      // refuse the late write on arrival.
      const db = fakeIncidentDb({ agents: [agentDbRow()] });
      const deps = scanDeps({ db, clock: () => NOW }); // default probe answers 200 → up
      await runCustomerIncidentScan(deps as never);

      const rows = db
        .tableRows("ops_events")
        .filter(
          (row) =>
            row.source === "box.public_probe.unreachable" &&
            row.instance_id === "agent-1",
        );
      expect(rows).toHaveLength(1);
      expect(rows[0].archived_at).toBe(new Date(NOW).toISOString());
      expect(rows[0].occurrence_count).toBe(0);
      expect((rows[0].metadata as Row).probe).toEqual({
        verdict: "up",
        checked_at: new Date(NOW).toISOString(),
      });
      // A real down report shares this row's fingerprint: the scan's own
      // deps.report is mocked, so the fingerprint collision is proven by
      // the superseded-refusal test below.
      expect(String(rows[0].fingerprint)).toMatch(/^[0-9a-f]{64}$/);
    });

    it("refuses a stalled down-report observed before the healthy verdict — no phantom outage", async () => {
      // The whole bug: a probe-row write that loses the deadline race
      // keeps running in the background and can commit after a later
      // healthy observation. Before the verdict row, that INSERT was
      // unguarded and established an outage spanning the healthy probe.
      const captured: OpsEventInput[] = [];
      const db = fakeIncidentDb({ agents: [agentDbRow()] });
      // Scan 1: probe fails — the report is captured (the "stalled" write)
      // and never commits inside this scan.
      await runCustomerIncidentScan(
        scanDeps({
          db,
          clock: () => NOW,
          probe: jest.fn(async () => ({ status: 503, latencyMs: 10, error: null })),
          report: jest.fn(async (input: OpsEventInput) => {
            captured.push(input);
            return { id: "evt-stalled", fingerprint: "fp-stalled" };
          }),
        }) as never,
      );
      const stalled = captured.find((o) => o.source === "box.public_probe.unreachable");
      expect(stalled?.observedAt).toBe(new Date(NOW).toISOString());

      // Scan 2, five minutes later: probe healthy — the verdict persists.
      await runCustomerIncidentScan(
        scanDeps({ db, now: () => NOW + 5 * MIN, clock: () => NOW + 5 * MIN }) as never,
      );

      // The stalled write lands now, through the REAL reportOpsEvent
      // (supabaseAdmin points at the same fake db).
      mockDb.current = db;
      const landed = await reportOpsEvent(stalled!);
      expect(landed?.superseded).toBe(true);

      // No outage was established: the fingerprint row is still archived
      // at the healthy observation, not reopened by the stale report.
      const rows = db
        .tableRows("ops_events")
        .filter(
          (row) =>
            row.source === "box.public_probe.unreachable" &&
            row.instance_id === "agent-1",
        );
      expect(rows).toHaveLength(1);
      expect(rows[0].archived_at).toBe(new Date(NOW + 5 * MIN).toISOString());
    });

    it("reopens the verdict row for a fresh outage, then keeps its start across consecutive failures", async () => {
      // A verdict row must not block a real outage: a down report observed
      // AFTER the healthy verdict reopens it and gets a fresh clock, and
      // consecutive failures on the same outage keep the original
      // first_seen_at (the 10-minute rule is not restarted by refresh).
      // The runtime marker (provisioned_at) is pinned to the distant past
      // so the stored outage start — real clock — always postdates it and
      // the pre-runtime reset branch stays out of the assertion.
      const db = fakeIncidentDb({
        agents: [
          agentDbRow({
            created_at: "2020-01-01T00:00:00.000Z",
            provisioned_at: "2020-01-01T00:05:00.000Z",
          }),
        ],
      });
      // The verdict and the reports must stay ordered by the timestamps
      // reportOpsEvent compares — but Date.now() has 1ms resolution and
      // the >= guard treats equal times as superseded, so a monotonic tick
      // clock keeps each observation strictly after the last.
      let tick = Date.now();
      const tickClock = () => (tick += 100);
      const realDeps = (down: boolean) =>
        scanDeps({
          db,
          now: () => tick,
          clock: tickClock,
          report: reportOpsEvent,
          probe: jest.fn(async () =>
            down
              ? { status: 503, latencyMs: 10, error: null }
              : { status: 200, latencyMs: 9, error: null },
          ),
        });
      mockDb.current = db;

      // Healthy scan persists the verdict.
      await runCustomerIncidentScan(realDeps(false) as never);
      const readRow = () =>
        db
          .tableRows("ops_events")
          .filter(
            (row) =>
              row.source === "box.public_probe.unreachable" &&
              row.instance_id === "agent-1",
          );

      // First real failure: the archived verdict reopens — fresh outage.
      await runCustomerIncidentScan(realDeps(true) as never);
      const afterFirst = readRow();
      expect(afterFirst).toHaveLength(1);
      expect(afterFirst[0].archived_at).toBeNull();
      const outageStart = afterFirst[0].first_seen_at;
      expect(typeof outageStart).toBe("string");
      // The fake's rows are live references — capture before the next
      // scan mutates them.
      const firstCount = Number(afterFirst[0].occurrence_count);
      expect(firstCount).toBeGreaterThanOrEqual(1);

      // Second consecutive failure: the open row refreshes — the outage
      // keeps the start it established.
      await runCustomerIncidentScan(realDeps(true) as never);
      const afterSecond = readRow();
      expect(afterSecond).toHaveLength(1);
      expect(afterSecond[0].archived_at).toBeNull();
      expect(afterSecond[0].first_seen_at).toBe(outageStart);
      expect(afterSecond[0].occurrence_count).toBe(firstCount + 1);
    });

    it("treats a verdict refresh that lost its race to a reopen as contested, not recorded", async () => {
      // The stored verdict row is archived (from an earlier healthy scan).
      // A down report reopens it (archived_at → null) between this scan's
      // fingerprint read and its verdict-refresh write: the .lt(archived_at)
      // predicate then matches zero rows. Returning "recorded" there would
      // let box_unreachable resolve while the outage row is open again.
      let onResolve: ((table: string, calls: unknown[][]) => void) | undefined = undefined;
      const db = fakeIncidentDb({
        agents: [agentDbRow()],
        openIncidents: [
          incidentDbRow({
            id: "evt-unreach-reopen-race",
            source: "incident.box_unreachable",
            metadata: { incident_key: "box_unreachable:agent-1" },
          }),
        ],
        mutateWhen: (table, calls) => onResolve?.(table, calls),
      });
      // Scan 1: healthy probe persists the verdict row (real fingerprint).
      await runCustomerIncidentScan(
        scanDeps({ db, now: () => NOW - 10 * MIN, clock: () => NOW - 10 * MIN }) as never,
      );
      const verdictRow = db
        .tableRows("ops_events")
        .find(
          (row) =>
            row.source === "box.public_probe.unreachable" && row.instance_id === "agent-1",
        )!;
      expect(verdictRow.archived_at).toBe(new Date(NOW - 10 * MIN).toISOString());

      onResolve = (table, calls) => {
        if (
          table === "ops_events" &&
          calls.some((c) => c[0] === "update") &&
          calls.some((c) => c[0] === "lt" && c[1] === "archived_at")
        ) {
          // The racing reopen cleared archived_at before the refresh landed.
          verdictRow.archived_at = null;
        }
      };
      const deps = scanDeps({ db, clock: () => NOW }); // healthy probe again
      const summary = await runCustomerIncidentScan(deps as never);

      expect(verdictRow.archived_at).toBeNull();
      expect(summary.resolved).toBe(0);
      expect(summary.unknown).toBe(1);
      expect(deps.archiveIncident as jest.Mock).not.toHaveBeenCalled();
    });

    it("does not archive a fingerprint-found outage a newer down report refreshed mid-write", async () => {
      // The healthy scan missed the row at collection (it was still
      // archived) and finds it open by fingerprint — an outage established
      // in between, whose start predates this healthy observation. A newer
      // failed probe then refreshes the row in the read→archive gap:
      // first_seen_at is preserved but last_seen_at moves past the healthy
      // observation, so the archive must no-op instead of clearing the
      // newer down verdict and reading the box as healthy.
      let onResolve: ((table: string, calls: unknown[][]) => void) | undefined = undefined;
      const db = fakeIncidentDb({
        agents: [agentDbRow()],
        openIncidents: [
          incidentDbRow({
            id: "evt-unreach-refresh-race",
            source: "incident.box_unreachable",
            metadata: { incident_key: "box_unreachable:agent-1" },
          }),
        ],
        mutateWhen: (table, calls) => onResolve?.(table, calls),
      });
      // Scan 1: healthy probe persists the verdict row (real fingerprint).
      await runCustomerIncidentScan(
        scanDeps({ db, now: () => NOW - 10 * MIN, clock: () => NOW - 10 * MIN }) as never,
      );
      const verdictRow = db
        .tableRows("ops_events")
        .find(
          (row) =>
            row.source === "box.public_probe.unreachable" && row.instance_id === "agent-1",
        )!;
      expect(verdictRow.archived_at).toBe(new Date(NOW - 10 * MIN).toISOString());

      onResolve = (table, calls) => {
        if (table !== "ops_events") return;
        const isFingerprintRead =
          calls.some((c) => c[0] === "eq" && c[1] === "fingerprint") &&
          calls.some((c) => c[0] === "maybeSingle");
        const isVerdictArchive =
          calls.some((c) => c[0] === "update") &&
          calls.some((c) => c[0] === "eq" && c[1] === "first_seen_at");
        if (isFingerprintRead && verdictRow.archived_at != null) {
          // A racing down report reopened the row between the collection
          // read and this fingerprint lookup.
          verdictRow.archived_at = null;
          verdictRow.first_seen_at = iso(30 * MIN);
          verdictRow.last_seen_at = iso(30 * MIN);
        } else if (isVerdictArchive) {
          // A newer failed probe refreshed the row between that read and
          // the archive write: last_seen_at moves past this scan's healthy
          // observation while first_seen_at is preserved.
          verdictRow.last_seen_at = new Date(NOW + 5 * MIN).toISOString();
        }
      };
      const deps = scanDeps({ db, clock: () => NOW }); // healthy probe
      const summary = await runCustomerIncidentScan(deps as never);

      expect(verdictRow.archived_at).toBeNull();
      expect(summary.resolved).toBe(0);
      expect(summary.unknown).toBe(1);
      expect(deps.archiveIncident as jest.Mock).not.toHaveBeenCalled();
    });

    it("leaves a fingerprint-found outage refreshed after the healthy observation alone", async () => {
      // Same gap, already visible at read time: the row the fingerprint
      // lookup returns was refreshed (last_seen_at) after this scan's
      // healthy probe ran — the observation cannot supersede it, so the
      // verdict write is never attempted and the subject stays contested.
      let onResolve: ((table: string, calls: unknown[][]) => void) | undefined = undefined;
      const db = fakeIncidentDb({
        agents: [agentDbRow()],
        openIncidents: [
          incidentDbRow({
            id: "evt-unreach-fresh-refresh",
            source: "incident.box_unreachable",
            metadata: { incident_key: "box_unreachable:agent-1" },
          }),
        ],
        mutateWhen: (table, calls) => onResolve?.(table, calls),
      });
      await runCustomerIncidentScan(
        scanDeps({ db, now: () => NOW - 10 * MIN, clock: () => NOW - 10 * MIN }) as never,
      );
      const verdictRow = db
        .tableRows("ops_events")
        .find(
          (row) =>
            row.source === "box.public_probe.unreachable" && row.instance_id === "agent-1",
        )!;

      onResolve = (table, calls) => {
        if (table !== "ops_events") return;
        const isFingerprintRead =
          calls.some((c) => c[0] === "eq" && c[1] === "fingerprint") &&
          calls.some((c) => c[0] === "maybeSingle");
        if (isFingerprintRead && verdictRow.archived_at != null) {
          verdictRow.archived_at = null;
          verdictRow.first_seen_at = iso(30 * MIN);
          // The refresh that postdates this scan's healthy observation.
          verdictRow.last_seen_at = new Date(NOW + 5 * MIN).toISOString();
        }
      };
      const deps = scanDeps({ db, clock: () => NOW });
      const summary = await runCustomerIncidentScan(deps as never);

      expect(verdictRow.archived_at).toBeNull();
      expect(summary.resolved).toBe(0);
      expect(summary.unknown).toBe(1);
      expect(deps.archiveIncident as jest.Mock).not.toHaveBeenCalled();
    });

    it("restarts the outage clock when the open probe row predates the box's current runtime", async () => {
      // The box woke 1h ago (sleep-tier marker) but the probe row's outage
      // started 3h ago — on the PREVIOUS runtime. The first failed probe
      // after the wake must not inherit the pre-sleep start, or it would
      // page instantly. The row's first_seen_at is pinned to this outage's
      // start inside a write guarded on the observed value.
      const row = probeRow({ first_seen_at: iso(3 * 60 * MIN) });
      const db = fakeIncidentDb({
        agents: [agentDbRow({ sleep_tier_changed_at: iso(60 * MIN) })],
        probeRows: [row],
      });
      const deps = scanDeps({
        db,
        probe: jest.fn(async () => ({ status: 502, latencyMs: 80, error: null })),
      });
      const summary = await runCustomerIncidentScan(deps as never);

      // New outage is under 10 minutes → no box_unreachable page.
      expect(summary.opened).toBe(0);
      expect(incidentReports(deps.report as jest.Mock)).toHaveLength(0);
      expect(row.first_seen_at).toBe(new Date(NOW).toISOString());

      // Next scan, 20 minutes later, probe still down: the pinned clock is
      // now past 10 minutes on the SAME runtime → the incident pages.
      const deps2 = scanDeps({
        db,
        now: () => NOW + 20 * MIN,
        probe: jest.fn(async () => ({ status: 502, latencyMs: 80, error: null })),
      });
      const summary2 = await runCustomerIncidentScan(deps2 as never);
      expect(summary2.opened).toBe(1);
      expect(
        incidentReports(deps2.report as jest.Mock).map((o) => o.metadata.incident_key),
      ).toEqual(["box_unreachable:agent-1"]);
    });

    it("preserves the outage clock for failures continuing on the same runtime", async () => {
      // Marker 1h ago, outage 15m ago — entirely inside this runtime.
      const row = probeRow({ first_seen_at: iso(15 * MIN) });
      const db = fakeIncidentDb({
        agents: [agentDbRow({ sleep_tier_changed_at: iso(60 * MIN) })],
        probeRows: [row],
      });
      const deps = scanDeps({
        db,
        probe: jest.fn(async () => ({ status: 502, latencyMs: 80, error: null })),
      });
      const summary = await runCustomerIncidentScan(deps as never);

      expect(row.first_seen_at).toBe(iso(15 * MIN));
      expect(summary.opened).toBe(1);
      expect(
        incidentReports(deps.report as jest.Mock).map((o) => o.metadata.incident_key),
      ).toEqual(["box_unreachable:agent-1"]);
    });

    it("stops probe-row writes once the write budget lapses — subjects stay unknown", async () => {
      // Probing itself is inside its budget, but the decision/write phase
      // deadline has already passed: no outage rows are written or
      // archived, and no incident opens or resolves on a skipped write.
      const deps = scanDeps({
        // Write deadline = probeDeadline + probeWriteBudgetMs < scan start.
        probeWriteBudgetMs: -(90_000 + 60_000),
        db: fakeIncidentDb({
          agents: [agentDbRow()],
          probeRows: [probeRow()],
          openIncidents: [
            incidentDbRow({
              id: "evt-unreach-wb",
              source: "incident.box_unreachable",
              metadata: { incident_key: "box_unreachable:agent-1" },
            }),
          ],
        }),
        probe: jest.fn(async () => ({ status: 200, latencyMs: 9, error: null })),
      });
      const summary = await runCustomerIncidentScan(deps as never);

      expect(deps.probe as jest.Mock).toHaveBeenCalledTimes(1);
      expect(probeReports(deps.report as jest.Mock)).toHaveLength(0);
      expect(summary.resolved).toBe(0);
      expect(summary.unknown).toBe(1);
      expect(summary.degraded).toBe(1);
      expect(deps.archiveIncident as jest.Mock).not.toHaveBeenCalled();
    });

    it("rotates the candidate order each tick so the probe budget window covers every box", async () => {
      // 20 candidates, a probe budget that only admits the first 16 of the
      // ordering: a fixed order would probe the same 16 and permanently
      // skip the same 4 tail boxes. Rotating by the scan-tick bucket moves
      // the window each pass.
      const agents = Array.from({ length: 20 }, (_, i) =>
        agentDbRow({
          id: `agent-${String(i).padStart(2, "0")}`,
          cf_hostname: `box-${String(i).padStart(2, "0")}.hivra.example`,
        }),
      );
      const probedHosts = async (nowMs: number): Promise<Set<string>> => {
        const probe: jest.MockedFunction<ProbeFn> = jest.fn();
        probe.mockResolvedValue({ status: 200, latencyMs: 5, error: null });
        // The clock flips past every deadline once 16 probes have run, so
        // exactly the first 16 candidates of the rotated order are probed.
        const deps = scanDeps({
          db: fakeIncidentDb({ agents }),
          now: () => nowMs,
          clock: () => (probe.mock.calls.length >= 16 ? 1e15 : 0),
          probe,
        });
        await runCustomerIncidentScan(deps as never);
        return new Set(
          probe.mock.calls.map((call) => new URL(String(call[0])).hostname),
        );
      };

      const tickMs = 5 * 60 * 1000;
      const first = await probedHosts(NOW);
      const second = await probedHosts(NOW + tickMs);
      expect(first.size).toBe(16);
      expect(second.size).toBe(16);
      // Consecutive ticks rotate the window by one slot: the probed sets
      // differ, and across a few ticks every box lands inside it.
      expect(second).not.toEqual(first);
      const union = new Set([...first, ...second]);
      for (let t = 2; t <= 5; t++) {
        for (const host of await probedHosts(NOW + t * tickMs)) union.add(host);
      }
      expect(union.size).toBe(20);
    });

    it("does not let a null-event_at receipt be crowded out by event_at-bearing receipts of its kind", async () => {
      // The genuinely newest EFFECTIVE receipt is a recovery recorded 15m
      // ago carrying NO event_at — its effective time is the first_seen_at
      // fallback. A burst of stale recoveries relayed 2m ago (event_at
      // 60m+, first_seen_at 2m) fills BOTH windows that could see it: the
      // event_at-ordered window excludes nulls by construction, and the
      // recorded-time window admits the burst on recency. Without the
      // dedicated null-event_at window the real recovery is invisible and
      // the gateway_down verdict keeps a resolved incident open.
      const staleRecoveries = Array.from({ length: 12 }, (_, i) =>
        watchdogDbRow("recovered", 2 * MIN, {
          event_id: `stale-rec-${i}`,
          event_at: iso((60 + i) * MIN),
        }),
      );
      const db = fakeIncidentDb({
        agents: [agentDbRow()],
        watchdogByAgent: {
          "agent-1": [
            // Newest effective receipt: recovery 15m ago, event_at NULL.
            watchdogDbRow("recovered", 15 * MIN, { event_id: "rec-now", event_at: null }),
            // Older effective failure the burst would otherwise hide behind.
            watchdogDbRow("gateway_down", 30 * MIN, { event_id: "down-before" }),
            ...staleRecoveries,
          ],
        },
        openIncidents: [incidentDbRow()],
      });
      const deps = scanDeps({ db });
      const summary = await runCustomerIncidentScan(deps as never);

      expect(summary.stillOpen).toBe(0);
      expect(summary.resolved).toBe(1);
      expect(deps.notifyResolved as jest.Mock).toHaveBeenCalled();
      // The null-event_at window exists per kind: event_at IS NULL,
      // ordered by recorded time.
      const nullWindows = db.calls.filter(
        (entry) =>
          entry.table === "ops_events" &&
          entry.calls.some(
            (c) => c[0] === "is" && c[1] === "metadata->>event_at" && c[2] === null,
          ) &&
          entry.calls.some((c) => c[0] === "order" && c[1] === "first_seen_at") &&
          entry.calls.some((c) => c[0] === "in" && c[1] === "metadata->>event_type"),
      );
      expect(nullWindows).toHaveLength(2);
    });

    it("does not reuse the observed outage start when a racing archive turned the report into a reopen", async () => {
      // Scan A reads an open probe row whose outage is 30m old — already
      // past the box_unreachable page threshold. Before A's down-signal
      // report lands, a racing scan's healthy-probe archive closes the
      // row: A's report REOPENS it, and resetFirstSeenOnReopen pins
      // first_seen_at to the NEW outage's start in the same write.
      // Reusing the observed start here would page a brand-new outage
      // instantly; the stored post-write start is what counts.
      const row = probeRow({
        first_seen_at: iso(30 * MIN),
        occurrence_count: 4,
        last_seen_at: iso(5 * MIN),
      });
      const db = fakeIncidentDb({ agents: [agentDbRow()], probeRows: [row] });
      const report: jest.Mock = jest.fn(async () => {
        // reportOpsEvent's reopen: archived→open with first_seen_at reset
        // to this outage's start in the same write.
        row.archived_at = undefined;
        row.first_seen_at = new Date(NOW).toISOString();
        return { id: "probe-row-1", fingerprint: "fp-probe-1" };
      });
      const deps = scanDeps({
        db,
        report,
        probe: jest.fn(async () => ({ status: 502, latencyMs: 80, error: null })),
      });
      const summary = await runCustomerIncidentScan(deps as never);

      // The outage is seconds old — no box_unreachable page this pass.
      expect(summary.opened).toBe(0);
      expect(summary.unknown).toBe(0);
      expect(incidentReports(report)).toHaveLength(0);
      // And the outage start the scan recorded came from the row's stored
      // post-write first_seen_at, not the 30-minute-old observation.
      const startReads = db.calls.filter(
        (entry) =>
          entry.table === "ops_events" &&
          entry.calls.some((c) => c[0] === "eq" && c[1] === "id" && c[2] === "probe-row-1") &&
          entry.calls.some((c) => c[0] === "maybeSingle"),
      );
      expect(startReads.length).toBeGreaterThan(0);
    });

    it("uses the observed outage start when the write confirms the outage continued", async () => {
      // No racing archive: the report refreshes the open row and its
      // stored first_seen_at is unchanged — the continuing outage keeps
      // its real start and still pages at 15 minutes.
      const row = probeRow({ first_seen_at: iso(15 * MIN) });
      const db = fakeIncidentDb({ agents: [agentDbRow()], probeRows: [row] });
      const deps = scanDeps({
        db,
        probe: jest.fn(async () => ({ status: 502, latencyMs: 80, error: null })),
      });
      const summary = await runCustomerIncidentScan(deps as never);

      expect(row.first_seen_at).toBe(iso(15 * MIN));
      expect(summary.opened).toBe(1);
      expect(
        incidentReports(deps.report as jest.Mock).map((o) => o.metadata.incident_key),
      ).toEqual(["box_unreachable:agent-1"]);
    });

    it("marks the subject unknown when the outage start cannot be read back", async () => {
      // The read-back of the probe row fails: the scan cannot verify the
      // outage age, so box_unreachable stays unknown — it never opens on
      // an unverified age, and an existing incident is never resolved.
      const row = probeRow({ first_seen_at: iso(15 * MIN) });
      const inner = fakeIncidentDb({
        agents: [agentDbRow()],
        probeRows: [row],
        openIncidents: [
          incidentDbRow({
            id: "evt-unreach-rb",
            source: "incident.box_unreachable",
            metadata: { incident_key: "box_unreachable:agent-1" },
          }),
        ],
      });
      // Fail ONLY the first_seen_at read-back (the maybeSingle on
      // ops_events filtered by row id): poison that one chain method.
      const poisoned = {
        from(table: string) {
          const chain = inner.from(table) as Record<string, unknown>;
          if (table !== "ops_events") return chain;
          const base = chain.maybeSingle as (...a: unknown[]) => unknown;
          chain.maybeSingle = (...args: unknown[]) => {
            const link = base(...args) as Record<string, unknown>;
            link.then = (onFulfilled: (v: unknown) => unknown) =>
              Promise.resolve({
                data: null,
                error: { message: "read-back failed" },
              }).then(onFulfilled);
            return link;
          };
          return chain;
        },
      };
      const deps = scanDeps({
        db: poisoned,
        probe: jest.fn(async () => ({ status: 502, latencyMs: 80, error: null })),
      });
      const summary = await runCustomerIncidentScan(deps as never);

      expect(summary.opened).toBe(0);
      expect(summary.resolved).toBe(0);
      expect(summary.unknown).toBe(1);
      expect(deps.archiveIncident as jest.Mock).not.toHaveBeenCalled();
      expect(incidentReports(deps.report as jest.Mock)).toHaveLength(0);
    });

    it("bounds an in-flight probe-row write by the write deadline — subject stays unknown", async () => {
      // The probe succeeds and the open row should be archived, but the
      // archive write hangs past the write deadline. The op races the
      // deadline and loses: the subject is left unprocessed — unknown +
      // degraded — so no box_unreachable opens on the stale stored row
      // and nothing resolves on a maybe.
      const row = probeRow({ first_seen_at: iso(15 * MIN) });
      // Clock sequence: scan-start deadline reads → 0; the collection-phase
      // races (core reads, subscription, probe-row read) and everything
      // through the probe-write admission → ~1-2s (inside every budget);
      // everything after → 149.95s, leaving ~50ms of the 150s probe-write
      // deadline for the hung archive to race and lose.
      let calls = 0;
      const clock = () => {
        const c = ++calls;
        if (c <= 2) return 0;
        if (c === 3) return 1_000;
        if (c <= 11) return 2_000;
        return 149_950;
      };
      const deps = scanDeps({
        clock,
        db: fakeIncidentDb({
          agents: [agentDbRow()],
          probeRows: [row],
          hangUpdateOnRowId: "probe-row-1",
          openIncidents: [
            incidentDbRow({
              id: "evt-unreach-hang",
              source: "incident.box_unreachable",
              metadata: { incident_key: "box_unreachable:agent-1" },
            }),
          ],
        }),
      });
      const summary = await runCustomerIncidentScan(deps as never);

      expect(row.archived_at).toBeUndefined();
      expect(summary.opened).toBe(0);
      expect(summary.resolved).toBe(0);
      expect(summary.unknown).toBe(1);
      expect(summary.degraded).toBe(1);
      expect(deps.archiveIncident as jest.Mock).not.toHaveBeenCalled();
      expect(incidentReports(deps.report as jest.Mock)).toHaveLength(0);
    });

    it("skips the probe-row archive when the write deadline lapses before the write starts", async () => {
      // The healthy probe came back inside the budget, but the write
      // deadline lapsed between the apply's admission and the archive
      // itself: a subject already counted unprocessed must not have a NEW
      // write start behind that count — the row stays open for the next
      // pass, unknown + degraded.
      const row = probeRow({ first_seen_at: iso(15 * MIN) });
      // Clock ticks: scan-start deadline reads ×3 → 0; the three
      // collection-phase races, watchdog admission + in-flight bound,
      // probe admission + observation stamp, apply admission + bound → 0;
      // the apply's internal pre-write checkpoint lands on 1e15.
      const times = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1e15];
      let tick = 0;
      const db = fakeIncidentDb({
        agents: [agentDbRow()],
        probeRows: [row],
        openIncidents: [
          incidentDbRow({
            id: "evt-unreach-prew",
            source: "incident.box_unreachable",
            metadata: { incident_key: "box_unreachable:agent-1" },
          }),
        ],
      });
      const deps = scanDeps({
        clock: () => times[Math.min(tick++, times.length - 1)],
        db,
      });
      const summary = await runCustomerIncidentScan(deps as never);

      expect(row.archived_at).toBeUndefined();
      expect(
        opsUpdates(db).some((c) => (c[1] as Row).archived_at != null),
      ).toBe(false);
      expect(summary.opened).toBe(0);
      expect(summary.resolved).toBe(0);
      expect(summary.unknown).toBe(1);
      // One for the deferred probe-row write, one for the open incident
      // row the resolve deadline then skips — both left for the next pass.
      expect(summary.degraded).toBe(2);
      expect(deps.archiveIncident as jest.Mock).not.toHaveBeenCalled();
    });

    it("stamps the probe's own observation time as observedAt on the down report", async () => {
      // The deadline race stops WAITING on the down report but cannot recall
      // its write: a stalled report can commit after a later healthy scan
      // archived the probe row. observedAt is what lets the write itself
      // refuse to land over a newer verdict — so it must be the probe's own
      // observation time, not a later scan clock.
      const deps = scanDeps({
        clock: () => NOW,
        db: fakeIncidentDb({ agents: [agentDbRow()] }),
        probe: jest.fn(async () => ({ status: 502, latencyMs: 80, error: null })),
      });
      await runCustomerIncidentScan(deps as never);

      const rows = probeReports(deps.report as jest.Mock);
      expect(rows).toHaveLength(1);
      expect(rows[0].observedAt).toBe(new Date(NOW).toISOString());
    });

    it("a superseded down report leaves the subject unknown — nothing opens and nothing resolves", async () => {
      // reportOpsEvent refused the write: a newer scan already closed the
      // probe row (or recorded a newer outage) after this scan's probe ran.
      // The observation is stale, so this pass must not claim an outage age
      // it never established — the subject is contested (unknown, NOT
      // degraded — the write was refused, not failed) and the open incident
      // stays open for the next pass.
      const deps = scanDeps({
        db: fakeIncidentDb({
          agents: [agentDbRow()],
          openIncidents: [
            incidentDbRow({
              id: "evt-unreach-superseded",
              source: "incident.box_unreachable",
              metadata: { incident_key: "box_unreachable:agent-1" },
            }),
          ],
        }),
        probe: jest.fn(async () => ({ status: 502, latencyMs: 80, error: null })),
        report: jest.fn(async (input: { source: string }) =>
          input.source === "box.public_probe.unreachable"
            ? { fingerprint: "fp-probe-1", superseded: true }
            : { id: "evt-new-1", fingerprint: "fp" }),
      });
      const summary = await runCustomerIncidentScan(deps as never);

      expect(summary).toMatchObject({ opened: 0, resolved: 0, unknown: 1, degraded: 0 });
      expect(deps.archiveIncident as jest.Mock).not.toHaveBeenCalled();
      expect(deps.notifyResolved as jest.Mock).not.toHaveBeenCalled();
      expect(incidentReports(deps.report as jest.Mock)).toHaveLength(0);
    });

    it("keeps the probe-row result when ops-admin email resolution stalls past the collection deadline", async () => {
      // Regression: the probe-row read raced the shared collection deadline
      // but its race was armed only when awaited — the ops-admin
      // directory wait in between consumed the window first, and a result
      // that had already landed inside it was discarded, sending every
      // candidate's public probe to unknown. The race is now armed at read
      // start, so the finished result survives the stalled wait.
      const prevEmails = process.env.OPS_ADMIN_EMAILS;
      const prevIds = process.env.OPS_ADMIN_USER_IDS;
      process.env.OPS_ADMIN_EMAILS = "ops@example.com";
      delete process.env.OPS_ADMIN_USER_IDS;
      try {
        const deps = scanDeps({
          collectionBudgetMs: 20,
          db: fakeIncidentDb({
            agents: [agentDbRow()],
            probeRows: [probeRow()],
          }),
          probe: jest.fn(async () => ({ status: 502, latencyMs: 80, error: null })),
          opsAdminDirectory: {
            // The directory never answers — the wait consumes the whole
            // collection window before the probe-row outcome is awaited.
            getUserList: jest.fn(() => new Promise<never>(() => {})),
          },
        });
        delete (deps as Record<string, unknown>).adminUserIds;
        const summary = await runCustomerIncidentScan(deps as never);

        // The probe-row read landed inside the window and still counts: the
        // probe ran, the 15-minute outage stood, and box_unreachable paged.
        expect(deps.probe as jest.Mock).toHaveBeenCalled();
        expect(summary.opened).toBe(1);
        expect(summary.unknown).toBe(0);
        const incidents = incidentReports(deps.report as jest.Mock);
        expect(incidents.map((o) => o.metadata.incident_key)).toEqual([
          "box_unreachable:agent-1",
        ]);
      } finally {
        if (prevEmails === undefined) delete process.env.OPS_ADMIN_EMAILS;
        else process.env.OPS_ADMIN_EMAILS = prevEmails;
        if (prevIds === undefined) delete process.env.OPS_ADMIN_USER_IDS;
        else process.env.OPS_ADMIN_USER_IDS = prevIds;
      }
    });

    it("does not page box_unreachable when the box answers publicly again before the incident insert", async () => {
      // A delayed report can outlive the scan that produced it and still
      // reach the write: the subject is re-checked immediately before the
      // insert, and a box whose /healthz answers again is confirmed
      // recovery — the stale insert would page an incident nothing is open
      // for anymore. Here the scan probe fails but the report-pass
      // diagnosis probe already answers 200.
      const probe = jest
        .fn()
        .mockResolvedValueOnce({ status: 502, latencyMs: 80, error: null })
        .mockResolvedValue({ status: 200, latencyMs: 9, error: null });
      const deps = scanDeps({
        db: fakeIncidentDb({
          agents: [agentDbRow()],
          probeRows: [probeRow()],
        }),
        probe,
      });
      const summary = await runCustomerIncidentScan(deps as never);

      expect(summary.opened).toBe(0);
      expect(incidentReports(deps.report as jest.Mock)).toHaveLength(0);
      expect(deps.archiveIncident as jest.Mock).not.toHaveBeenCalled();
    });

    it("does not page box_unreachable when a concurrent healthy scan already archived the outage", async () => {
      // Same skip, via the stored verdict rather than the live probe: the
      // scan's own probe still fails, but another scan's healthy probe
      // archived the outage row between this pass's collection and its
      // report write. The stored row is re-read before the insert — an
      // archived row says the outage already ended.
      const row = probeRow();
      const db = fakeIncidentDb({
        agents: [agentDbRow()],
        probeRows: [row],
        mutateWhen: (table, calls) => {
          // The pre-insert probe-row re-read is the only source+instance_id
          // filtered probe-row query: land the concurrent archive in the
          // gap it guards.
          if (
            table === "ops_events" &&
            calls.some((c) => c[0] === "eq" && c[1] === "instance_id") &&
            calls.some(
              (c) => c[0] === "eq" && c[1] === "source" && c[2] === "box.public_probe.unreachable",
            )
          ) {
            row.archived_at = new Date(NOW).toISOString();
          }
        },
      });
      const deps = scanDeps({
        db,
        probe: jest.fn(async () => ({ status: 502, latencyMs: 80, error: null })),
      });
      const summary = await runCustomerIncidentScan(deps as never);

      expect(summary.opened).toBe(0);
      expect(incidentReports(deps.report as jest.Mock)).toHaveLength(0);
      expect(deps.archiveIncident as jest.Mock).not.toHaveBeenCalled();
    });

    it("does not page box_unreachable when the recorded outage closed and restarted before the insert", async () => {
      // The evaluation aged the outage from the row's first_seen_at — but
      // a verdict write can close that outage and reopen the row with a
      // FRESH start between evaluation and the report insert. The
      // re-check must age the CURRENT outage start, not reuse the
      // evaluated snapshot's: a seconds-old new outage has not earned a
      // page yet.
      const row = probeRow(); // first_seen_at: iso(15 * MIN) — aged at eval
      const db = fakeIncidentDb({
        agents: [agentDbRow()],
        probeRows: [row],
        mutateWhen: (table, calls) => {
          // The pre-insert probe-row re-read is the only source+instance_id
          // filtered probe-row query: a racing verdict closes the old
          // outage and starts a new one in the gap it guards.
          if (
            table === "ops_events" &&
            calls.some((c) => c[0] === "eq" && c[1] === "instance_id") &&
            calls.some(
              (c) => c[0] === "eq" && c[1] === "source" && c[2] === "box.public_probe.unreachable",
            )
          ) {
            row.first_seen_at = iso(2 * MIN);
          }
        },
      });
      const deps = scanDeps({
        db,
        probe: jest.fn(async () => ({ status: 502, latencyMs: 80, error: null })),
      });
      const summary = await runCustomerIncidentScan(deps as never);

      expect(summary.opened).toBe(0);
      expect(incidentReports(deps.report as jest.Mock)).toHaveLength(0);
      // The outage record still fails the probe — it is simply too young
      // to page; the next scan re-ages and reports it.
    });

    it("does not resolve a live incident when a newer outage row appears under the healthy verdict write", async () => {
      // The scan's collection saw no open probe row and the probe answered
      // 200, so the verdict write went to persist that healthy observation —
      // but a delayed down report committed a NEWER outage in between (its
      // first_seen is after this probe ran). Recording healthy over it
      // would archive a live box_unreachable incident: the verdict must
      // come back "moved", leaving the subject unknown and the open
      // incident for a later pass.
      const db = fakeIncidentDb({
        agents: [agentDbRow()],
        openIncidents: [
          incidentDbRow({
            id: "evt-unreach-verdict-race",
            source: "incident.box_unreachable",
            metadata: { incident_key: "box_unreachable:agent-1" },
          }),
        ],
        mutateWhen: (table, calls) => {
          if (table !== "ops_events") return;
          // The verdict write's fingerprint lookup is the only
          // fingerprint-filtered read: land the delayed outage there.
          const fp = calls.find((c) => c[0] === "eq" && c[1] === "fingerprint");
          if (!fp) return;
          db.tableRows("ops_events").push(
            probeRow({
              id: "probe-row-late",
              fingerprint: String(fp[2]),
              // Committed after the healthy observation — this probe cannot
              // disprove an outage it predates. The observation timestamp is
              // the real clock (scanDeps does not inject `clock`), so the
              // "newer" outage must postdate real now, not fixture NOW.
              first_seen_at: new Date(Date.now() + 10 * MIN).toISOString(),
              last_seen_at: new Date(Date.now() + 10 * MIN).toISOString(),
            }),
          );
        },
      });
      const deps = scanDeps({ db }); // default probe answers 200 → up
      const summary = await runCustomerIncidentScan(deps as never);

      expect(summary.resolved).toBe(0);
      expect(summary.unknown).toBe(1);
      expect(deps.archiveIncident as jest.Mock).not.toHaveBeenCalled();
      expect(deps.notifyResolved as jest.Mock).not.toHaveBeenCalled();
    });
  });

  // ---- report pass deadline + still-open version refresh -------------------

  it("stops reporting findings once the report budget lapses and records the rest as degraded", async () => {
    // Two failing crons produce two findings. The report deadline passes
    // after the first report: the second is not reported this pass (it
    // re-emits next scan) and the pass is recorded degraded. The clock
    // ticks are: scan-start deadline reads ×3 (probe, watchdog, collection),
    // the four collection-phase races (core reads, ops-admin id resolution,
    // probe rows, subscription), the first item's admission check, its
    // in-flight bound read, its internal pre-write checkpoint and its
    // post-revalidation checkpoint, then the lapsed admission read.
    const times = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1e15];
    let tick = 0;
    const clock = () => times[Math.min(tick++, times.length - 1)];
    const deps = scanDeps({
      clock,
      db: fakeIncidentDb({
        agents: [],
        heartbeats: [
          {
            cron_name: "cron-a",
            last_run_at: iso(5 * MIN),
            last_success_at: iso(5 * MIN),
            run_count: 30,
            ok_count: 20,
            consecutive_failures: 3,
          },
          {
            cron_name: "cron-b",
            last_run_at: iso(5 * MIN),
            last_success_at: iso(5 * MIN),
            run_count: 30,
            ok_count: 20,
            consecutive_failures: 3,
          },
        ],
      }),
      cronSchedules: new Map<string, CronScheduleInfo>([
        ["cron-a", { periodMinutes: 5, path: "/api/cron/cron-a" }],
        ["cron-b", { periodMinutes: 5, path: "/api/cron/cron-b" }],
      ]),
    });
    const summary = await runCustomerIncidentScan(deps as never);

    expect(summary.opened).toBe(1);
    expect(summary.degraded).toBe(1);
    expect(deps.report as jest.Mock).toHaveBeenCalledTimes(1);
  });

  it("never starts a report once the deadline lapses inside the admitted item", async () => {
    // The race admitted the item while budget remained, but the deadline
    // lapsed before the write itself: the item is counted deferred and NO
    // report — or page — fires behind a count that already recorded it.
    const times = [0, 0, 0, 0, 0, 0, 0, 0, 1e15];
    let tick = 0;
    const clock = () => times[Math.min(tick++, times.length - 1)];
    const deps = scanDeps({
      clock,
      db: fakeIncidentDb({
        agents: [],
        heartbeats: [
          {
            cron_name: "cron-a",
            last_run_at: iso(5 * MIN),
            last_success_at: iso(5 * MIN),
            run_count: 30,
            ok_count: 20,
            consecutive_failures: 3,
          },
        ],
      }),
      cronSchedules: new Map<string, CronScheduleInfo>([
        ["cron-a", { periodMinutes: 5, path: "/api/cron/cron-a" }],
      ]),
    });
    const summary = await runCustomerIncidentScan(deps as never);

    expect(summary.opened).toBe(0);
    expect(summary.degraded).toBe(1);
    expect(deps.report as jest.Mock).not.toHaveBeenCalled();
  });

  it("reports nothing once the report deadline has already passed", async () => {
    // reportDeadlineAt = probeWriteDeadlineAt + reportBudgetMs — a negative
    // budget puts it before the scan started, so every finding is skipped.
    const deps = scanDeps({
      reportBudgetMs: -(90_000 + 60_000 + 60_000),
      db: fakeIncidentDb({
        agents: [agentDbRow()],
        watchdogByAgent: { "agent-1": [watchdogDbRow("gateway_down", 45 * MIN)] },
      }),
    });
    const summary = await runCustomerIncidentScan(deps as never);

    expect(summary.findings).toBe(1);
    expect(summary.opened).toBe(0);
    expect(summary.degraded).toBe(1);
    expect(deps.report as jest.Mock).not.toHaveBeenCalled();
  });

  it("refreshes the open row's guarded version without re-paging while the incident still holds", async () => {
    // Scan B confirms the incident still holds on an already-open row: it
    // must not re-report (dedup — no second page), but it MUST move the
    // version the resolve pass's archive is guarded on, or a concurrent
    // scan's stale archive can close the live incident.
    const row = incidentDbRow({
      id: "evt-so-1",
      occurrence_count: 2,
      last_seen_at: iso(10 * MIN),
      metadata: { incident_key: "box_down:agent-1" },
    });
    const db = fakeIncidentDb({
      agents: [agentDbRow()],
      watchdogByAgent: { "agent-1": [watchdogDbRow("gateway_down", 45 * MIN)] },
      openIncidents: [row],
    });
    const deps = scanDeps({ db, archiveIncident: undefined });
    const summary = await runCustomerIncidentScan(deps as never);

    expect(summary.stillOpen).toBe(1);
    // No re-report for an already-open row — the page dedup is unchanged.
    expect(deps.report as jest.Mock).not.toHaveBeenCalled();
    // The version moved to this scan's time; the update was guarded on the
    // version this scan observed (id + archived_at-null + old occurrence).
    expect(row.last_seen_at).toBe(new Date(NOW).toISOString());
    expect(row.occurrence_count).toBe(2);
    const touchCalls = db.calls.filter(
      (entry) =>
        entry.table === "ops_events" &&
        entry.calls.some(
          (c) => c[0] === "update" && (c[1] as Row).last_seen_at === new Date(NOW).toISOString(),
        ),
    );
    expect(touchCalls).toHaveLength(1);
    const chain = touchCalls[0].calls;
    expect(
      chain.some((c) => c[0] === "eq" && c[1] === "occurrence_count" && c[2] === 2),
    ).toBe(true);
    expect(
      chain.some((c) => c[0] === "eq" && c[1] === "last_seen_at" && c[2] === iso(10 * MIN)),
    ).toBe(true);
    expect(
      chain.some((c) => c[0] === "is" && c[1] === "archived_at" && c[2] === null),
    ).toBe(true);
  });

  it("never moves the guarded version backward when the stored marker is ahead of this scan's now", async () => {
    // The scan's `now` is captured at scan start. A row whose stored marker
    // is already ahead of it — e.g. a refresh stamped from an event time
    // rather than the scan clock — used to be overwritten with the OLDER
    // scan-start value. That regression handed any resolver holding the
    // older version a matching row to archive: live incident closed,
    // resolved notice sent. The refresh is a compare-and-swap that only
    // advances: it writes observed+1ms under the observed-version
    // predicates, so the version still moves (stale archives still no-op)
    // but never retreats.
    const ahead = iso(-5 * MIN); // five minutes past this scan's `now`
    const row = incidentDbRow({
      id: "evt-so-fwd",
      occurrence_count: 2,
      last_seen_at: ahead,
      metadata: { incident_key: "box_down:agent-1" },
    });
    const db = fakeIncidentDb({
      agents: [agentDbRow()],
      watchdogByAgent: { "agent-1": [watchdogDbRow("gateway_down", 45 * MIN)] },
      openIncidents: [row],
    });
    const deps = scanDeps({ db, archiveIncident: undefined });
    const summary = await runCustomerIncidentScan(deps as never);

    expect(summary.stillOpen).toBe(1);
    // The marker advanced past the stored value — never back to this
    // scan's older `now` — and still moved, so a resolver holding the
    // observed version cannot match it.
    expect(row.last_seen_at).toBe(new Date(Date.parse(ahead) + 1).toISOString());
    expect(Date.parse(row.last_seen_at as string)).toBeGreaterThan(Date.parse(ahead));
    const touchCalls = db.calls.filter(
      (entry) =>
        entry.table === "ops_events" &&
        entry.calls.some(
          (c) => c[0] === "update" && typeof (c[1] as Row).last_seen_at === "string",
        ),
    );
    expect(touchCalls).toHaveLength(1);
    const chain = touchCalls[0].calls;
    // Guarded on the version this scan observed — a concurrent write
    // between read and touch still no-ops the refresh entirely.
    expect(
      chain.some((c) => c[0] === "eq" && c[1] === "occurrence_count" && c[2] === 2),
    ).toBe(true);
    expect(
      chain.some((c) => c[0] === "eq" && c[1] === "last_seen_at" && c[2] === ahead),
    ).toBe(true);
    expect(deps.report as jest.Mock).not.toHaveBeenCalled();
  });

  it("a stale archive cannot close a live incident once a still-open refresh moved its version", async () => {
    // Scan A read the incident row, then scan B's still-open refresh landed
    // (bumping last_seen_at), then A's guarded archive fired. The version
    // predicate no longer matches — the archive no-ops instead of closing a
    // live incident and paging a resolved notice.
    const row = incidentDbRow({
      id: "evt-so-2",
      occurrence_count: 2,
      last_seen_at: iso(10 * MIN),
      metadata: { incident_key: "box_down:agent-1" },
    });
    const db = fakeIncidentDb({
      agents: [agentDbRow()],
      // The condition cleared in A's evaluation (newest receipt is a
      // recovery) so A attempts the archive.
      watchdogByAgent: {
        "agent-1": [
          watchdogDbRow("gateway_down", 90 * MIN),
          watchdogDbRow("recovered", 20 * MIN),
        ],
      },
      openIncidents: [row],
    });
    const deps = scanDeps({
      db,
      archiveIncident: undefined, // real guarded archive against the fake db
      probe: jest.fn(async () => {
        // B's concurrent still-open refresh lands between A's row read and
        // its archive: last_seen_at moves past what A observed.
        row.last_seen_at = iso(0);
        return { status: 200, latencyMs: 9, error: null };
      }),
    });
    const summary = await runCustomerIncidentScan(deps as never);

    expect(row.archived_at).toBeUndefined();
    expect(summary.resolved).toBe(0);
    expect(deps.notifyResolved as jest.Mock).not.toHaveBeenCalled();
  });

  it("counts a failed still-open version refresh as degraded without paging again", async () => {
    const row = incidentDbRow({
      id: "evt-so-3",
      occurrence_count: 2,
      last_seen_at: iso(10 * MIN),
      metadata: { incident_key: "box_down:agent-1" },
    });
    const db = fakeIncidentDb({
      agents: [agentDbRow()],
      watchdogByAgent: { "agent-1": [watchdogDbRow("gateway_down", 45 * MIN)] },
      openIncidents: [row],
      incidentRowUpdateFails: true,
    });
    const deps = scanDeps({ db });
    const summary = await runCustomerIncidentScan(deps as never);

    expect(summary.stillOpen).toBe(1);
    expect(summary.degraded).toBe(1);
    expect(row.last_seen_at).toBe(iso(10 * MIN));
    expect(deps.report as jest.Mock).not.toHaveBeenCalled();
  });

  it("does not let a same-kind backlog burst crowd the newest failure out of the receipt window", async () => {
    // The box's newest SURFACE event is a gateway_down 15m ago — a live
    // outage — but a backlog relay then re-delivered 12 stale failure
    // receipts (event_at 40m+, first_seen_at 2m). A per-kind window ordered
    // ONLY by recorded time fills with the late copies and drops the real
    // failure; the recovery at 25m then wins the cross-kind comparison and
    // the live incident silently resolves. Each kind is read under BOTH
    // orderings — recorded time and event time — so the burst cannot hide
    // the newest event.
    const staleBurst = Array.from({ length: 12 }, (_, i) =>
      watchdogDbRow("unit_restart", 2 * MIN, {
        event_id: `stale-${i}`,
        event_at: iso((40 + i) * MIN),
      }),
    );
    const db = fakeIncidentDb({
      agents: [agentDbRow()],
      watchdogByAgent: {
        "agent-1": [
          // The genuinely newest effective receipt — failure 15m ago,
          // recorded 45m ago, so the burst evicts it from a
          // first_seen_at-ordered window.
          watchdogDbRow("gateway_down", 45 * MIN, {
            event_id: "down-now",
            event_at: iso(15 * MIN),
          }),
          watchdogDbRow("recovered", 25 * MIN, { event_id: "rec-before" }),
          ...staleBurst,
        ],
      },
      openIncidents: [incidentDbRow()],
    });
    const deps = scanDeps({ db });
    const summary = await runCustomerIncidentScan(deps as never);

    expect(summary.stillOpen).toBe(1);
    expect(summary.resolved).toBe(0);
    expect(deps.archiveIncident).not.toHaveBeenCalled();
    expect(deps.notifyResolved).not.toHaveBeenCalled();
    // The event-time window exists per kind, ordered by metadata.event_at
    // with nulls excluded (a null event_at sorts first under DESC and
    // would waste window slots on receipts the recorded-time window
    // already covers).
    const eventTimeWindows = db.calls.filter(
      (entry) =>
        entry.table === "ops_events" &&
        entry.calls.some((c) => c[0] === "order" && c[1] === "metadata->>event_at") &&
        entry.calls.some((c) => c[0] === "in" && c[1] === "metadata->>event_type"),
    );
    expect(eventTimeWindows).toHaveLength(2);
    for (const entry of eventTimeWindows) {
      expect(
        entry.calls.some(
          (c) => c[0] === "not" && c[1] === "metadata->>event_at" && c[2] === "is" && c[3] === null,
        ),
      ).toBe(true);
    }
  });

  it("reports a new finding before still-open refreshes when the report budget admits only one item", async () => {
    // Evaluator order puts the still-open box_down first and the new
    // cron_unhealthy last; a shared head-first queue lets the still-open
    // refresh consume the whole report budget and the new page never
    // fires. New findings report first; the refresh keeps what is left.
    const row = incidentDbRow({
      id: "evt-prio-1",
      occurrence_count: 2,
      last_seen_at: iso(10 * MIN),
      metadata: { incident_key: "box_down:agent-1" },
    });
    const report: jest.Mock = jest.fn(async () => ({ id: "evt-new-1", fingerprint: "fp" }));
    const db = fakeIncidentDb({
      agents: [agentDbRow()],
      watchdogByAgent: { "agent-1": [watchdogDbRow("gateway_down", 45 * MIN)] },
      openIncidents: [row],
      heartbeats: [
        {
          cron_name: "cron-new",
          last_run_at: iso(5 * MIN),
          last_success_at: iso(5 * MIN),
          run_count: 30,
          ok_count: 20,
          consecutive_failures: 3,
        },
      ],
    });
    // The report deadline lapses as soon as ONE report-pass item has been
    // processed — either the new incident's report call or a still-open
    // refresh's update write.
    const reportPassWorked = () =>
      report.mock.calls.length > 0 ||
      db.calls.some(
        (entry) =>
          entry.table === "ops_events" && entry.calls.some((c) => c[0] === "update"),
      );
    const deps = scanDeps({
      db,
      report,
      clock: () => (reportPassWorked() ? 1e15 : 0),
      cronSchedules: new Map<string, CronScheduleInfo>([
        ["cron-new", { periodMinutes: 5, path: "/api/cron/cron-new" }],
      ]),
    });
    const summary = await runCustomerIncidentScan(deps as never);

    expect(summary.opened).toBe(1);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0].source).toBe("incident.cron_unhealthy");
    // The still-open refresh lost the single slot this pass — the row's
    // guarded version stays as observed and the skipped item is degraded.
    expect(row.last_seen_at).toBe(iso(10 * MIN));
    expect(summary.stillOpen).toBe(0);
    // Degraded twice: the skipped refresh in the report pass, and the same
    // row's resolve-pass check — the lapsed clock is also past the resolve
    // deadline, so the row stays open unprocessed for the next pass.
    expect(summary.degraded).toBe(2);
  });

  it("rotates new findings across ticks when the report budget admits only one per pass", async () => {
    // Three new findings and a budget that admits one report per scan: a
    // fixed order would page the same finding every tick and starve the
    // rest forever; the scan-tick rotation walks the list like the probe
    // candidate order does.
    const heartbeats = ["cron-a", "cron-b", "cron-c"].map((name) => ({
      cron_name: name,
      last_run_at: iso(5 * MIN),
      last_success_at: iso(5 * MIN),
      run_count: 30,
      ok_count: 20,
      consecutive_failures: 3,
    }));
    const reportedKeys = async (nowMs: number): Promise<Set<string>> => {
      const report: jest.Mock = jest.fn(async () => ({ id: "evt-new-1", fingerprint: "fp" }));
      const deps = scanDeps({
        db: fakeIncidentDb({ heartbeats }),
        now: () => nowMs,
        clock: () => (report.mock.calls.length >= 1 ? 1e15 : 0),
        report,
        cronSchedules: new Map<string, CronScheduleInfo>([
          ["cron-a", { periodMinutes: 5, path: "/api/cron/cron-a" }],
          ["cron-b", { periodMinutes: 5, path: "/api/cron/cron-b" }],
          ["cron-c", { periodMinutes: 5, path: "/api/cron/cron-c" }],
        ]),
      });
      await runCustomerIncidentScan(deps as never);
      return new Set(report.mock.calls.map((c) => String(c[0].metadata.incident_key)));
    };

    const tickMs = 5 * 60 * 1000;
    const union = new Set<string>();
    for (let t = 0; t < 3; t += 1) {
      for (const key of await reportedKeys(NOW + t * tickMs)) union.add(key);
    }
    expect(union).toEqual(
      new Set([
        "cron_unhealthy:cron-a",
        "cron_unhealthy:cron-b",
        "cron_unhealthy:cron-c",
      ]),
    );
  });

  it("skips the whole resolve pass once its deadline has already passed", async () => {
    // resolveDeadlineAt = reportDeadlineAt + resolveBudgetMs, chained after
    // probe (90s) + probe-write (60s) + report (60s) budgets. A budget that
    // puts it in the past must stop every row — the remaining margin is
    // reserved for the heartbeat write; unprocessed rows stay open for the
    // next pass.
    const deps = scanDeps({
      resolveBudgetMs: -(90_000 + 60_000 + 60_000 + 60_000 + 60_000),
      db: fakeIncidentDb({
        agents: [],
        openIncidents: [
          incidentDbRow({ id: "evt-rd-1", metadata: { incident_key: "box_down:gone-1" } }),
          incidentDbRow({ id: "evt-rd-2", metadata: { incident_key: "box_down:gone-2" } }),
        ],
      }),
    });
    const summary = await runCustomerIncidentScan(deps as never);

    expect(summary.resolved).toBe(0);
    expect(summary.expired).toBe(0);
    expect(summary.degraded).toBe(2);
    expect(deps.archiveIncident).not.toHaveBeenCalled();
    expect(deps.notifyResolved).not.toHaveBeenCalled();
  });

  it("stops resolving mid-pass once the resolve deadline lapses and counts the rest as degraded", async () => {
    // Thirty resolvable rows and a deadline that lapses as soon as the
    // first archive lands: in-flight rows finish but nothing new starts —
    // the leftovers stay open (no archive) and count as degraded. Thirty
    // exceeds any sane resolve concurrency so the pass cannot finish.
    const archive = jest.fn(async () => true);
    const deps = scanDeps({
      archiveIncident: archive,
      clock: () => (archive.mock.calls.length > 0 ? 1e15 : 0),
      db: fakeIncidentDb({
        agents: [],
        openIncidents: Array.from({ length: 30 }, (_, i) =>
          incidentDbRow({
            id: `evt-rm-${i}`,
            metadata: { incident_key: `box_down:gone-${i}` },
          }),
        ),
      }),
    });
    const summary = await runCustomerIncidentScan(deps as never);

    const archivedCount = archive.mock.calls.length;
    expect(archivedCount).toBeGreaterThan(0);
    expect(archivedCount).toBeLessThan(30);
    expect(summary.resolved).toBe(archivedCount);
    expect(summary.degraded).toBe(30 - archivedCount);
    expect((deps.notifyResolved as jest.Mock).mock.calls.length).toBe(archivedCount);
  });

  it("never starts an archive once the deadline lapses between the subject read and the write", async () => {
    // A launch_failed row needs a subject read before its archive: the
    // deadline lapsing between that read and the archive leaves the row
    // untouched — counted deferred — instead of resolving behind a count
    // that already recorded it deferred.
    const db = fakeIncidentDb({
      openIncidents: [
        incidentDbRow({
          id: "evt-rd-check",
          source: "incident.launch_failed",
          metadata: {
            incident_key: "launch_failed:agent-still-broken",
            subject_kind: "hivra_agent",
          },
        }),
      ],
    });
    const deps = scanDeps({
      db,
      // The single-row subject lookup is the last read before the archive —
      // the clock flips past every deadline once it lands.
      clock: () =>
        db.calls.some(
          (entry) =>
            entry.table === "hivra_agents" &&
            entry.calls.some((c) => c[0] === "maybeSingle"),
        )
          ? 1e15
          : 0,
    });
    const summary = await runCustomerIncidentScan(deps as never);

    expect(deps.archiveIncident as jest.Mock).not.toHaveBeenCalled();
    expect(deps.notifyResolved as jest.Mock).not.toHaveBeenCalled();
    expect(summary.resolved).toBe(0);
    expect(summary.expired).toBe(0);
    expect(summary.degraded).toBe(1);
  });

  it("bounds an in-flight resolve op by the deadline — timed-out rows stay open and degraded", async () => {
    // Admission checks alone cannot stop an op that started inside the
    // budget and then stalls: one hung archive used to run the invocation
    // past maxDuration and kill the heartbeat write. The op now races the
    // resolve deadline and loses — the row is left open untouched (any
    // write it still lands is version-guarded) and counts degraded.
    const archive = jest.fn(() => new Promise<boolean>(() => {}));
    // Clock: the two scan-start deadline reads → 0 (resolve deadline at
    // 270s); everything after → 269.95s, inside the deadline with ~50ms
    // of budget left for the hung archive to race and lose.
    let calls = 0;
    const clock = () => (++calls <= 2 ? 0 : 269_950);
    const deps = scanDeps({
      archiveIncident: archive,
      clock,
      db: fakeIncidentDb({
        agents: [],
        openIncidents: [
          incidentDbRow({ id: "evt-hang-1", metadata: { incident_key: "box_down:gone-1" } }),
          incidentDbRow({ id: "evt-hang-2", metadata: { incident_key: "box_down:gone-2" } }),
        ],
      }),
    });
    const summary = await runCustomerIncidentScan(deps as never);

    expect(archive).toHaveBeenCalled(); // the op started, then stalled
    expect(summary.resolved).toBe(0);
    expect(summary.expired).toBe(0);
    expect(summary.degraded).toBe(2);
    expect(deps.notifyResolved as jest.Mock).not.toHaveBeenCalled();
  });

  it("bounds in-flight report work by the deadline — the item and the rest of the queue are degraded", async () => {
    // Two new findings; the first report call hangs. The report deadline
    // leaves ~50ms once work starts, so the item loses its race — it and
    // every item queued behind it count degraded and re-emit next scan
    // instead of the invocation dying inside the report pass.
    const report: jest.Mock = jest.fn(() => new Promise(() => {}));
    // Clock: scan-start deadline reads → 0 (report deadline at 210s);
    // everything after → 209.95s.
    let calls = 0;
    const clock = () => (++calls <= 2 ? 0 : 209_950);
    const deps = scanDeps({
      report,
      clock,
      db: fakeIncidentDb({
        agents: [],
        heartbeats: [
          {
            cron_name: "cron-a",
            last_run_at: iso(5 * MIN),
            last_success_at: iso(5 * MIN),
            run_count: 30,
            ok_count: 20,
            consecutive_failures: 3,
          },
          {
            cron_name: "cron-b",
            last_run_at: iso(5 * MIN),
            last_success_at: iso(5 * MIN),
            run_count: 30,
            ok_count: 20,
            consecutive_failures: 3,
          },
        ],
      }),
      cronSchedules: new Map<string, CronScheduleInfo>([
        ["cron-a", { periodMinutes: 5, path: "/api/cron/cron-a" }],
        ["cron-b", { periodMinutes: 5, path: "/api/cron/cron-b" }],
      ]),
    });
    const summary = await runCustomerIncidentScan(deps as never);

    expect(report).toHaveBeenCalledTimes(1);
    expect(summary.opened).toBe(0);
    expect(summary.degraded).toBe(2);
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
