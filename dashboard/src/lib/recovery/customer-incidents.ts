import "server-only";

import { createHash } from "node:crypto";

import { log } from "@/lib/logger";
import { reportOpsEvent, type OpsEventInput } from "@/lib/ops-events";
import { configuredOpsAdminUserIds } from "@/lib/ops-access";
import { supabaseAdmin } from "@/lib/supabase";
import vercelConfig from "../../../vercel.json";

// Customer-impact incident detection.
//
// Why this exists: telemetry recorded a paying customer's ~10 incidents in 10
// days and nobody was told — the customer reported each one first. ops_events
// is pull-only, so this cron evaluates a small set of customer-impact rules
// every 5 minutes and turns each into a paging ops event (severity error +
// page:true) whose metadata carries a full diagnosis bundle: who the customer
// is, what plan they are on, the box's watchdog timeline, and live public
// probe results — enough to fix the incident without asking the customer.
//
// Shape: evaluateCustomerIncidents() is pure (all IO injected) so every rule
// is unit-testable; runCustomerIncidentScan() collects, evaluates, reports new
// incidents, and resolves closed ones. Incident identity is a stable
// `incident_key` (`<rule>:<subject id>`) stored in metadata; the ops-event
// fingerprint is stable per (rule, subject) via fixed titles/messages plus
// userId/instanceId/route, so an open incident pages exactly once and an
// archived-then-recurring one pages again through reportOpsEvent.

export type IncidentRule = "box_down" | "launch_failed" | "lifecycle_stuck" | "cron_unhealthy";
export type IncidentSubjectKind = "hivra_agent" | "hermes_instance" | "cron";

export interface HivraAgentSnapshot {
  id: string;
  userId: string;
  type: string | null;
  name: string | null;
  status: string | null;
  sleepState: string | null;
  desiredState: string | null;
  createdAt: string | null;
  provisionedAt: string | null;
  operationKind: string | null;
  operationStartedAt: string | null;
  operationId: string | null;
  error: string | null;
  cfHostname: string | null;
  chatUrl: string | null;
  proxmoxHost: string | null;
  vmid: number | null;
  ip: string | null;
}

export interface HermesInstanceSnapshot {
  id: string;
  userId: string;
  name: string | null;
  status: string | null;
  lifecycleState: string | null;
  gatewayUrl: string | null;
  createdAt: string | null;
}

export interface WatchdogEventSnapshot {
  eventId: string | null;
  eventType: string | null;
  /** Box-reported event time (metadata.event_at). Ordering key for the rules. */
  eventAt: string | null;
  /** Ops-row first_seen_at — fallback clock when event_at is missing. */
  firstSeenAt: string | null;
  unit: string | null;
  kind: string | null;
  reason: string | null;
  downForS: number | null;
  nRestarts: number | null;
  attempt: number | null;
  restarts: number | null;
  ok: boolean | null;
}

export interface CronHeartbeatSnapshot {
  cronName: string;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  runCount: number | null;
  okCount: number | null;
  consecutiveFailures: number | null;
  lastDetail: string | null;
}

export interface CronScheduleInfo {
  /** Expected gap between runs in minutes, parsed from vercel.json. Null = unparseable. */
  periodMinutes: number | null;
  /** The cron's route path, e.g. /api/cron/hivra-surface-watchdog. */
  path: string | null;
}

export interface IncidentFinding {
  /** Stable per (rule, subject): `<rule>:<subject id>`. */
  key: string;
  rule: IncidentRule;
  subjectId: string;
  subjectKind: IncidentSubjectKind;
  userId: string | null;
  title: string;
  message: string;
  route: string | null;
  instanceId: string | null;
  agent: HivraAgentSnapshot | null;
  instance: HermesInstanceSnapshot | null;
  cron: { name: string; schedule: CronScheduleInfo; heartbeat: CronHeartbeatSnapshot } | null;
  /** Last 10 watchdog events for the agent, newest event_at first. */
  watchdogTimeline: WatchdogEventSnapshot[];
  /** One-line suggested next step for the on-call human. */
  nextStep: string;
}

export interface OpenIncidentRow {
  id: string;
  fingerprint: string;
  source: string;
  title: string;
  incidentKey: string | null;
}

export interface CustomerSubscriptionSnapshot {
  plan: string | null;
  status: string | null;
}

export interface IncidentEvaluationInput {
  /** ms epoch. */
  now: number;
  adminUserIds: ReadonlySet<string>;
  agents: HivraAgentSnapshot[];
  /** Watchdog events per agent id (ops_events rows with source box.surface_watchdog.*). */
  watchdogEventsByAgent: ReadonlyMap<string, WatchdogEventSnapshot[]>;
  /** Agents whose watchdog-event fetch failed — box_down cannot be evaluated for them. */
  watchdogUnknownAgentIds: ReadonlySet<string>;
  hermesInstances: HermesInstanceSnapshot[];
  heartbeats: CronHeartbeatSnapshot[];
  cronSchedules: ReadonlyMap<string, CronScheduleInfo>;
}

export interface IncidentEvaluation {
  findings: IncidentFinding[];
  /**
   * incident_keys that could not be evaluated this run (a per-subject IO
   * failure). Open incidents with these keys must NOT be resolved — we simply
   * do not know.
   */
  unknownKeys: ReadonlySet<string>;
}

const BOX_DOWN_MIN_AGE_MS = 10 * 60 * 1000;
const LAUNCH_FAILED_WINDOW_MS = 24 * 60 * 60 * 1000;
const LAUNCH_FAILED_STUCK_MS = 25 * 60 * 1000;
const LIFECYCLE_STUCK_MS = 15 * 60 * 1000;
const CRON_STALE_PERIOD_MULTIPLIER = 3;
const CRON_FAILURE_STREAK = 3;
const WATCHDOG_TIMELINE_LIMIT = 10;

const BOX_DOWN_EVENT_TYPES = new Set(["gateway_down", "unit_restart", "recovery_exhausted"]);
const BOX_RECOVERY_EVENT_TYPES = new Set(["recovered", "gateway_recovered"]);
const LAUNCH_FAILED_AGENT_STATUSES = new Set(["error", "deleted"]);
const LAUNCH_FAILED_INSTANCE_STATUSES = new Set(["failed", "error"]);

function parseTimeMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function isAdminUser(userId: string | null | undefined, adminUserIds: ReadonlySet<string>): boolean {
  return !!userId && adminUserIds.has(userId);
}

/** Newest-first ordering by the box-reported event_at; falls back to first_seen_at. */
export function sortWatchdogEventsByEventAt(events: WatchdogEventSnapshot[]): WatchdogEventSnapshot[] {
  return [...events].sort((a, b) => {
    const at = parseTimeMs(a.eventAt) ?? parseTimeMs(a.firstSeenAt) ?? 0;
    const bt = parseTimeMs(b.eventAt) ?? parseTimeMs(b.firstSeenAt) ?? 0;
    return bt - at;
  });
}

function boxDownNextStep(agent: HivraAgentSnapshot): string {
  if (agent.proxmoxHost || agent.vmid != null) {
    return `Run hivra-instance-triage on ${agent.proxmoxHost ?? "unknown-host"}/${agent.vmid ?? "?"}`;
  }
  return "Open the agent page and restart the box; read the watchdog receipts on the box";
}

const RULE_MESSAGES: Record<Exclude<IncidentRule, "cron_unhealthy">, string> = {
  box_down:
    "A customer's agent box is down: the box-side watchdog's latest event is a failure " +
    "(gateway down, unit restart, or recovery exhausted) with no later recovery event, " +
    "open for at least 10 minutes — recovery_exhausted pages immediately. The customer is " +
    "likely unable to reach their agent right now. Diagnosis (customer, plan, watchdog " +
    "timeline, live public probes) is in this event's metadata.",
  launch_failed:
    "A customer's agent or instance created in the last 24 hours never reached a running " +
    "state: provisioning never completed (provisioned_at still null past the grace window " +
    "or the row ended in a failed/error status). The customer likely cannot start their " +
    "agent. Diagnosis is in this event's metadata.",
  lifecycle_stuck:
    "A customer's agent has had a lifecycle operation (start, stop, delete, restore) in " +
    "progress for over 15 minutes. The customer likely sees the action hang or fail — " +
    "'can't start or delete'. Diagnosis is in this event's metadata.",
};

function cronUnhealthyMessage(cronName: string): string {
  return (
    `Cron '${cronName}' is unhealthy: it has failed its most recent runs repeatedly or has ` +
    `not recorded a success within 3x its scheduled interval. Work it owns may be stalled ` +
    `for customers. Run counts, streak and last detail are in this event's metadata.`
  );
}

/**
 * Pure rule evaluation. Every rule reads only the injected snapshots; the only
 * clock is `now`. Returns the incidents that currently HOLD plus the set of
 * incident_keys that could not be evaluated (IO gaps) so callers neither
 * re-report nor wrongly resolve them.
 */
export function evaluateCustomerIncidents(input: IncidentEvaluationInput): IncidentEvaluation {
  const findings: IncidentFinding[] = [];
  const unknownKeys = new Set<string>();
  const { now, adminUserIds } = input;

  // ---- box_down -----------------------------------------------------------
  // A running, awake hivra_agent whose LATEST watchdog event by event_at is a
  // down-type with no later recovery, aged past the grace window — or
  // recovery_exhausted, which pages immediately. Ordering is by the box's own
  // event_at, never ops_events.last_seen_at (re-reads used to make an old
  // outage look current).
  for (const agent of input.agents) {
    if (agent.status !== "running" || agent.sleepState !== "awake") continue;
    if (isAdminUser(agent.userId, adminUserIds)) continue;
    const key = `box_down:${agent.id}`;
    if (input.watchdogUnknownAgentIds.has(agent.id)) {
      unknownKeys.add(key);
      continue;
    }
    const events = sortWatchdogEventsByEventAt(input.watchdogEventsByAgent.get(agent.id) ?? []);
    const latest = events[0];
    if (!latest?.eventType) continue;
    if (BOX_RECOVERY_EVENT_TYPES.has(latest.eventType)) continue;
    if (!BOX_DOWN_EVENT_TYPES.has(latest.eventType)) continue;
    const eventMs = parseTimeMs(latest.eventAt) ?? parseTimeMs(latest.firstSeenAt);
    const immediate = latest.eventType === "recovery_exhausted";
    if (!immediate && (eventMs == null || now - eventMs < BOX_DOWN_MIN_AGE_MS)) continue;
    findings.push({
      key,
      rule: "box_down",
      subjectId: agent.id,
      subjectKind: "hivra_agent",
      userId: agent.userId,
      title: "Customer incident: agent box down",
      message: RULE_MESSAGES.box_down,
      route: `/dashboard/agent/${agent.id}`,
      instanceId: agent.id,
      agent,
      instance: null,
      cron: null,
      watchdogTimeline: events.slice(0, WATCHDOG_TIMELINE_LIMIT),
      nextStep: boxDownNextStep(agent),
    });
  }

  // ---- launch_failed ------------------------------------------------------
  for (const agent of input.agents) {
    if (isAdminUser(agent.userId, adminUserIds)) continue;
    const createdMs = parseTimeMs(agent.createdAt);
    if (createdMs == null || now - createdMs > LAUNCH_FAILED_WINDOW_MS || now - createdMs < 0) continue;
    if (agent.provisionedAt != null) continue;
    const failedStatus = agent.status != null && LAUNCH_FAILED_AGENT_STATUSES.has(agent.status);
    const stuckAge = now - createdMs > LAUNCH_FAILED_STUCK_MS;
    if (!failedStatus && !stuckAge) continue;
    findings.push({
      key: `launch_failed:${agent.id}`,
      rule: "launch_failed",
      subjectId: agent.id,
      subjectKind: "hivra_agent",
      userId: agent.userId,
      title: "Customer incident: agent launch failed",
      message: RULE_MESSAGES.launch_failed,
      route: `/dashboard/agent/${agent.id}`,
      instanceId: agent.id,
      agent,
      instance: null,
      cron: null,
      watchdogTimeline: [],
      nextStep:
        "Check the launch/provisioning logs for this agent row; if the box never came up, " +
        "remove the row and let the customer relaunch",
    });
  }
  for (const instance of input.hermesInstances) {
    if (isAdminUser(instance.userId, adminUserIds)) continue;
    const createdMs = parseTimeMs(instance.createdAt);
    if (createdMs == null || now - createdMs > LAUNCH_FAILED_WINDOW_MS || now - createdMs < 0) continue;
    const failed =
      (instance.status != null && LAUNCH_FAILED_INSTANCE_STATUSES.has(instance.status)) ||
      instance.lifecycleState === "failed";
    if (!failed) continue;
    findings.push({
      key: `launch_failed:${instance.id}`,
      rule: "launch_failed",
      subjectId: instance.id,
      subjectKind: "hermes_instance",
      userId: instance.userId,
      title: "Customer incident: instance launch failed",
      message: RULE_MESSAGES.launch_failed,
      route: `/dashboard/instances/${instance.id}/console`,
      instanceId: instance.id,
      agent: null,
      instance,
      cron: null,
      watchdogTimeline: [],
      nextStep:
        "Check the provisioning logs for this instance; if the VM never came up, clean up " +
        "the row and let the customer relaunch",
    });
  }

  // ---- lifecycle_stuck ----------------------------------------------------
  for (const agent of input.agents) {
    if (isAdminUser(agent.userId, adminUserIds)) continue;
    if (!agent.operationKind || !agent.operationStartedAt) continue;
    const startedMs = parseTimeMs(agent.operationStartedAt);
    if (startedMs == null || now - startedMs < LIFECYCLE_STUCK_MS) continue;
    findings.push({
      key: `lifecycle_stuck:${agent.id}`,
      rule: "lifecycle_stuck",
      subjectId: agent.id,
      subjectKind: "hivra_agent",
      userId: agent.userId,
      title: "Customer incident: agent lifecycle stuck",
      message: RULE_MESSAGES.lifecycle_stuck,
      route: `/dashboard/agent/${agent.id}`,
      instanceId: agent.id,
      agent,
      instance: null,
      cron: null,
      watchdogTimeline: [],
      nextStep:
        "Inspect the stuck operation fields on the agent row; if the VM is gone, clear " +
        "operation_kind/operation_started_at and retry the customer's action",
    });
  }

  // ---- cron_unhealthy -----------------------------------------------------
  for (const heartbeat of input.heartbeats) {
    const schedule = input.cronSchedules.get(heartbeat.cronName);
    if (!schedule) continue;
    const periodMinutes = schedule.periodMinutes;
    const streak = heartbeat.consecutiveFailures ?? 0;
    const lastSuccessMs = parseTimeMs(heartbeat.lastSuccessAt);
    const stale =
      periodMinutes != null &&
      lastSuccessMs != null &&
      now - lastSuccessMs > CRON_STALE_PERIOD_MULTIPLIER * periodMinutes * 60 * 1000;
    if (streak < CRON_FAILURE_STREAK && !stale) continue;
    findings.push({
      key: `cron_unhealthy:${heartbeat.cronName}`,
      rule: "cron_unhealthy",
      subjectId: heartbeat.cronName,
      subjectKind: "cron",
      userId: null,
      title: `Customer incident: cron unhealthy — ${heartbeat.cronName}`,
      message: cronUnhealthyMessage(heartbeat.cronName),
      route: schedule.path,
      instanceId: null,
      agent: null,
      instance: null,
      cron: { name: heartbeat.cronName, schedule, heartbeat },
      watchdogTimeline: [],
      nextStep: `Check Vercel Cron delivery and the route logs for ${schedule.path ?? heartbeat.cronName}`,
    });
  }

  return { findings, unknownKeys };
}

// ---------------------------------------------------------------------------
// IO layer — everything below touches Supabase / the network and is injectable.
// ---------------------------------------------------------------------------

type DbClient = NonNullable<typeof supabaseAdmin>;

interface AgentDbRow {
  id: string;
  user_id: string;
  type: string | null;
  name: string | null;
  status: string | null;
  sleep_state: string | null;
  desired_state: string | null;
  created_at: string | null;
  provisioned_at: string | null;
  operation_kind: string | null;
  operation_started_at: string | null;
  operation_id: string | null;
  error: string | null;
  cf_hostname: string | null;
  chat_url: string | null;
  proxmox_host: string | null;
  vmid: number | null;
  ip: string | null;
}

interface HermesInstanceDbRow {
  id: string;
  user_id: string;
  name: string | null;
  status: string | null;
  lifecycle_state: string | null;
  gateway_url: string | null;
  created_at: string | null;
}

interface HeartbeatDbRow {
  cron_name: string;
  last_run_at: string | null;
  last_success_at: string | null;
  run_count: number | null;
  ok_count: number | null;
  consecutive_failures: number | null;
  last_detail: string | null;
}

interface WatchdogOpsRow {
  id: string;
  title: string | null;
  first_seen_at: string | null;
  metadata: Record<string, unknown> | null;
}

const AGENT_SELECT =
  "id,user_id,type,name,status,sleep_state,desired_state,created_at,provisioned_at," +
  "operation_kind,operation_started_at,operation_id,error,cf_hostname,chat_url," +
  "proxmox_host,vmid,ip";

function toAgentSnapshot(row: AgentDbRow): HivraAgentSnapshot {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    name: row.name,
    status: row.status,
    sleepState: row.sleep_state,
    desiredState: row.desired_state,
    createdAt: row.created_at,
    provisionedAt: row.provisioned_at,
    operationKind: row.operation_kind,
    operationStartedAt: row.operation_started_at,
    operationId: row.operation_id,
    error: row.error,
    cfHostname: row.cf_hostname,
    chatUrl: row.chat_url,
    proxmoxHost: row.proxmox_host,
    vmid: row.vmid,
    ip: row.ip,
  };
}

function toInstanceSnapshot(row: HermesInstanceDbRow): HermesInstanceSnapshot {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    status: row.status,
    lifecycleState: row.lifecycle_state,
    gatewayUrl: row.gateway_url,
    createdAt: row.created_at,
  };
}

function toHeartbeatSnapshot(row: HeartbeatDbRow): CronHeartbeatSnapshot {
  return {
    cronName: row.cron_name,
    lastRunAt: row.last_run_at,
    lastSuccessAt: row.last_success_at,
    runCount: row.run_count,
    okCount: row.ok_count,
    consecutiveFailures: row.consecutive_failures,
    lastDetail: row.last_detail,
  };
}

function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function strOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function watchdogEventFromOpsRow(row: WatchdogOpsRow): WatchdogEventSnapshot {
  const meta = row.metadata ?? {};
  const boolOrNull = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
  return {
    eventId: strOrNull(meta.event_id),
    eventType: strOrNull(meta.event_type),
    eventAt: strOrNull(meta.event_at),
    firstSeenAt: row.first_seen_at,
    unit: strOrNull(meta.unit),
    kind: strOrNull(meta.kind),
    reason: strOrNull(meta.reason),
    downForS: numOrNull(meta.down_for_s),
    nRestarts: numOrNull(meta.n_restarts),
    attempt: numOrNull(meta.attempt),
    restarts: numOrNull(meta.restarts),
    ok: boolOrNull(meta.ok),
  };
}

async function collectAgents(db: DbClient, now: number): Promise<HivraAgentSnapshot[]> {
  const cutoff24 = new Date(now - LAUNCH_FAILED_WINDOW_MS).toISOString();
  // Three bounded queries merged by id: unprovisioned-recent (launch_failed),
  // running (box_down), and in-flight operations (lifecycle_stuck — the stuck
  // op may sit on a non-running status like provisioning/deleting).
  const [unprovisioned, running, inFlight] = await Promise.all([
    db
      .from("hivra_agents")
      .select(AGENT_SELECT)
      .is("provisioned_at", null)
      .gte("created_at", cutoff24),
    db.from("hivra_agents").select(AGENT_SELECT).eq("status", "running"),
    db
      .from("hivra_agents")
      .select(AGENT_SELECT)
      .not("operation_kind", "is", null)
      .not("operation_started_at", "is", null),
  ]);
  for (const result of [unprovisioned, running, inFlight]) {
    if (result.error) throw new Error(result.error.message || "hivra_agents query failed");
  }
  const byId = new Map<string, HivraAgentSnapshot>();
  for (const row of [
    ...((unprovisioned.data ?? []) as unknown as AgentDbRow[]),
    ...((running.data ?? []) as unknown as AgentDbRow[]),
    ...((inFlight.data ?? []) as unknown as AgentDbRow[]),
  ]) {
    byId.set(row.id, toAgentSnapshot(row));
  }
  return [...byId.values()];
}

async function collectHermesInstances(db: DbClient, now: number): Promise<HermesInstanceSnapshot[]> {
  const cutoff24 = new Date(now - LAUNCH_FAILED_WINDOW_MS).toISOString();
  const { data, error } = await db
    .from("hermes_instances")
    .select("id,user_id,name,status,lifecycle_state,gateway_url,created_at")
    .gte("created_at", cutoff24);
  if (error) throw new Error(error.message || "hermes_instances query failed");
  return ((data ?? []) as HermesInstanceDbRow[]).map(toInstanceSnapshot);
}

async function collectHeartbeats(db: DbClient): Promise<CronHeartbeatSnapshot[]> {
  const { data, error } = await db
    .from("ops_cron_heartbeats")
    .select("cron_name,last_run_at,last_success_at,run_count,ok_count,consecutive_failures,last_detail");
  if (error) throw new Error(error.message || "ops_cron_heartbeats query failed");
  return ((data ?? []) as HeartbeatDbRow[]).map(toHeartbeatSnapshot);
}

async function collectOpenIncidentRows(db: DbClient): Promise<OpenIncidentRow[]> {
  const { data, error } = await db
    .from("ops_events")
    .select("id,fingerprint,title,source,metadata")
    .like("source", "incident.%")
    .is("archived_at", null);
  if (error) throw new Error(error.message || "open incident rows query failed");
  const rows: OpenIncidentRow[] = [];
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const metadata = (row.metadata ?? {}) as Record<string, unknown>;
    rows.push({
      id: String(row.id),
      fingerprint: String(row.fingerprint ?? ""),
      source: String(row.source ?? ""),
      title: String(row.title ?? ""),
      incidentKey: strOrNull(metadata.incident_key),
    });
  }
  return rows;
}

const WATCHDOG_FETCH_CONCURRENCY = 8;
const WATCHDOG_EVENTS_PER_AGENT_LIMIT = 30;

async function collectWatchdogEvents(
  db: DbClient,
  agentIds: string[],
): Promise<{ byAgent: Map<string, WatchdogEventSnapshot[]>; unknownAgentIds: Set<string> }> {
  const byAgent = new Map<string, WatchdogEventSnapshot[]>();
  const unknownAgentIds = new Set<string>();
  const queue = [...agentIds];
  await Promise.all(
    Array.from({ length: Math.min(WATCHDOG_FETCH_CONCURRENCY, queue.length) }, async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        const { data, error } = await db
          .from("ops_events")
          .select("id,title,first_seen_at,metadata")
          .eq("instance_id", id)
          .like("source", "box.surface_watchdog.%")
          .order("metadata->>event_at", { ascending: false })
          .limit(WATCHDOG_EVENTS_PER_AGENT_LIMIT);
        if (error) {
          unknownAgentIds.add(id);
          log.warn("customer-incidents: watchdog event fetch failed for agent", {
            source: "customer-incidents",
            failureType: "watchdog_events_fetch_failed",
            instanceId: id,
            errorMessage: error.message,
          });
          continue;
        }
        byAgent.set(
          id,
          ((data ?? []) as WatchdogOpsRow[]).map(watchdogEventFromOpsRow),
        );
      }
    }),
  );
  return { byAgent, unknownAgentIds };
}

async function collectSubscriptions(
  db: DbClient,
  userIds: string[],
): Promise<Map<string, CustomerSubscriptionSnapshot>> {
  const map = new Map<string, CustomerSubscriptionSnapshot>();
  if (userIds.length === 0) return map;
  const { data, error } = await db
    .from("hermes_subscriptions")
    .select("user_id,plan,status")
    .in("user_id", userIds);
  if (error) {
    // Diagnosis enrichment only — never block incident detection on it.
    log.warn("customer-incidents: subscription lookup failed", {
      source: "customer-incidents",
      failureType: "subscription_lookup_failed",
      errorMessage: error.message,
    });
    return map;
  }
  for (const row of (data ?? []) as Array<{ user_id: string; plan: string | null; status: string | null }>) {
    map.set(row.user_id, { plan: row.plan, status: row.status });
  }
  return map;
}

// ---- cron schedules from vercel.json ---------------------------------------

interface VercelCronEntry {
  path?: string;
  schedule?: string;
}

/**
 * Expected period in minutes for the cron expressions used in vercel.json.
 * Covers the shapes the file actually uses (every-N-minutes, every-N-hours,
 * daily, weekday-only, day-of-month). Returns null for anything else — the
 * cron_unhealthy rule then skips that cron rather than guess a budget.
 */
export function cronPeriodMinutes(schedule: string): number | null {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dom, month, dow] = parts;
  const everyMinutes = /^\*\/(\d+)$/.exec(minute);
  if (everyMinutes && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    const n = Number(everyMinutes[1]);
    return n > 0 ? n : null;
  }
  const everyHours = /^\*\/(\d+)$/.exec(hour);
  if (/^\d+$/.test(minute) && everyHours && dom === "*" && month === "*" && dow === "*") {
    const n = Number(everyHours[1]);
    return n > 0 ? n * 60 : null;
  }
  // Every minute and fixed-minute-hourly shapes used across vercel.json.
  if (minute === "*" && hour === "*" && dom === "*" && month === "*" && dow === "*") return 1;
  if (/^\d+$/.test(minute) && hour === "*" && dom === "*" && month === "*" && dow === "*") return 60;
  const fixedMinute = /^\d+$/.test(minute);
  const fixedHour = /^\d+$/.test(hour);
  if (fixedMinute && fixedHour && dom === "*" && month === "*" && dow === "*") return 1440;
  if (fixedMinute && fixedHour && dom === "*" && month === "*" && dow !== "*") return 10080;
  if (fixedMinute && fixedHour && dom !== "*" && month === "*" && dow === "*") return 43200;
  return null;
}

/** vercel.json cron path → heartbeat name: /api/cron/a/b → a-b. */
export function cronSchedulesFromVercel(
  crons: readonly VercelCronEntry[],
): Map<string, CronScheduleInfo> {
  const map = new Map<string, CronScheduleInfo>();
  for (const cron of crons) {
    if (!cron.path || !cron.path.startsWith("/api/cron/")) continue;
    const name = cron.path.slice("/api/cron/".length).replace(/\//g, "-");
    map.set(name, {
      periodMinutes: cron.schedule ? cronPeriodMinutes(cron.schedule) : null,
      path: cron.path,
    });
  }
  return map;
}

const VERCEL_CRONS = cronSchedulesFromVercel(
  ((vercelConfig as { crons?: VercelCronEntry[] }).crons ?? []) as VercelCronEntry[],
);

// ---- diagnosis bundle ------------------------------------------------------

export interface PublicProbeResult {
  name: string;
  url: string;
  status: number | null;
  latencyMs: number | null;
  error: string | null;
}

export interface ProbeFn {
  (url: string): Promise<{ status: number | null; latencyMs: number | null; error: string | null }>;
}

const PROBE_TIMEOUT_MS = 5000;

async function defaultProbe(url: string): Promise<{ status: number | null; latencyMs: number | null; error: string | null }> {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { "user-agent": "hivra-customer-incidents/1.0", accept: "*/*" },
    });
    // Drain a bounded prefix so the socket is reused; we only need the status.
    await res.arrayBuffer().catch(() => undefined);
    return { status: res.status, latencyMs: Date.now() - started, error: null };
  } catch (err) {
    return {
      status: null,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function safePublicUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Live public probes: /healthz on the box hostname + the agent's entry URL. No credentials. */
export async function probeAgentPublicSurface(
  agent: Pick<HivraAgentSnapshot, "cfHostname" | "chatUrl">,
  probe: ProbeFn = defaultProbe,
): Promise<PublicProbeResult[]> {
  const targets: Array<{ name: string; url: string }> = [];
  const healthzHost = agent.cfHostname?.trim().toLowerCase();
  if (healthzHost) {
    targets.push({ name: "healthz", url: `https://${healthzHost}/healthz` });
  }
  const entryUrl = safePublicUrl(agent.chatUrl) ?? (healthzHost ? `https://${healthzHost}/` : null);
  if (entryUrl && !targets.some((t) => t.url === entryUrl)) {
    targets.push({ name: "entry", url: entryUrl });
  }
  const results: PublicProbeResult[] = [];
  for (const target of targets) {
    const outcome = await probe(target.url);
    results.push({ name: target.name, url: target.url, ...outcome });
  }
  return results;
}

function agentDiagnosisFields(agent: HivraAgentSnapshot): Record<string, unknown> {
  return {
    id: agent.id,
    type: agent.type,
    name: agent.name,
    status: agent.status,
    sleep_state: agent.sleepState,
    desired_state: agent.desiredState,
    provisioned_at: agent.provisionedAt,
    created_at: agent.createdAt,
    error: agent.error,
    operation_kind: agent.operationKind,
    operation_started_at: agent.operationStartedAt,
    operation_id: agent.operationId,
    proxmox_host: agent.proxmoxHost,
    vmid: agent.vmid,
    ip: agent.ip,
    cf_hostname: agent.cfHostname,
    public_url: agent.chatUrl,
  };
}

function instanceDiagnosisFields(instance: HermesInstanceSnapshot): Record<string, unknown> {
  return {
    id: instance.id,
    name: instance.name,
    status: instance.status,
    lifecycle_state: instance.lifecycleState,
    gateway_url: instance.gatewayUrl,
    created_at: instance.createdAt,
  };
}

function watchdogTimelineFields(events: WatchdogEventSnapshot[]): Record<string, unknown>[] {
  return events.slice(0, WATCHDOG_TIMELINE_LIMIT).map((event) => ({
    event_id: event.eventId,
    event_type: event.eventType,
    event_at: event.eventAt,
    unit: event.unit ?? event.kind,
    reason: event.reason,
    down_for_s: event.downForS,
    n_restarts: event.nRestarts,
    attempt: event.attempt,
    restarts: event.restarts,
    ok: event.ok,
  }));
}

function cronDiagnosisFields(finding: IncidentFinding): Record<string, unknown> | null {
  if (!finding.cron) return null;
  const { name, schedule, heartbeat } = finding.cron;
  return {
    name,
    path: schedule.path,
    period_minutes: schedule.periodMinutes,
    last_run_at: heartbeat.lastRunAt,
    last_success_at: heartbeat.lastSuccessAt,
    run_count: heartbeat.runCount,
    ok_count: heartbeat.okCount,
    consecutive_failures: heartbeat.consecutiveFailures,
    last_detail: heartbeat.lastDetail,
  };
}

export function buildIncidentMetadata(
  finding: IncidentFinding,
  extras: {
    subscription?: CustomerSubscriptionSnapshot | null;
    probes?: PublicProbeResult[];
  } = {},
): Record<string, unknown> {
  return {
    incident_key: finding.key,
    rule: finding.rule,
    subject_kind: finding.subjectKind,
    subject_id: finding.subjectId,
    detected_by: "cron:customer-incidents",
    customer: {
      clerk_user_id: finding.userId,
      plan: extras.subscription?.plan ?? null,
      subscription_status: extras.subscription?.status ?? null,
    },
    agent: finding.agent ? agentDiagnosisFields(finding.agent) : null,
    instance: finding.instance ? instanceDiagnosisFields(finding.instance) : null,
    cron: cronDiagnosisFields(finding),
    watchdog: finding.watchdogTimeline.length
      ? { timeline: watchdogTimelineFields(finding.watchdogTimeline) }
      : null,
    probes: extras.probes ?? [],
    next_step: finding.nextStep,
  };
}

export function incidentOpsEvent(
  finding: IncidentFinding,
  metadata: Record<string, unknown>,
  page = true,
): OpsEventInput {
  return {
    source: `incident.${finding.rule}`,
    severity: "error",
    page,
    title: finding.title,
    message: finding.message,
    route: finding.route ?? undefined,
    userId: finding.userId,
    instanceId: finding.instanceId,
    metadata,
  };
}

// ---- orchestration ---------------------------------------------------------

export interface ResolvedNoticeInput {
  fingerprint: string;
  source: string;
  title: string;
  message: string;
  route: string | null;
  instanceId: string | null;
  userId: string | null;
  metadata: Record<string, unknown>;
}

/**
 * Customer incidents page admins only from the production deployment.
 * Canary runs the same crons against its own database — whose fixtures fail
 * on purpose — and also reports VERCEL_ENV=production, so the deployment's
 * public app origin is the only reliable discriminator. Everywhere else the
 * scan still writes the incident ops events (the ops feed shows them) but
 * with page:false, and resolved notices are skipped.
 */
export function incidentPagingEnabled(appUrl: string | null | undefined): boolean {
  if (!appUrl) return false;
  try {
    return new URL(appUrl).hostname === "hivra.cloud";
  } catch {
    return false;
  }
}

export interface CustomerIncidentScanDeps {
  db?: DbClient | null;
  now?: () => number;
  report?: typeof reportOpsEvent;
  probe?: ProbeFn;
  adminUserIds?: ReadonlySet<string>;
  cronSchedules?: ReadonlyMap<string, CronScheduleInfo>;
  /** Page admins for new incidents + send resolved notices. Defaults to the production-origin check. */
  pagingEnabled?: boolean;
  /** Archive an incident row by id; returns true when this call won the archive. */
  archiveIncident?: (rowId: string) => Promise<boolean>;
  /** Send the one resolved notice through the admin transport. */
  notifyResolved?: (input: ResolvedNoticeInput) => Promise<void>;
}

export interface CustomerIncidentScanSummary {
  findings: number;
  opened: number;
  stillOpen: number;
  resolved: number;
  unknown: number;
  failed: number;
}

function emptySummary(): CustomerIncidentScanSummary {
  return { findings: 0, opened: 0, stillOpen: 0, resolved: 0, unknown: 0, failed: 0 };
}

async function defaultArchiveIncident(db: DbClient, rowId: string): Promise<boolean> {
  const { data, error } = await db
    .from("ops_events")
    .update({ archived_at: new Date().toISOString(), archived_by_user_id: null })
    .eq("id", rowId)
    .is("archived_at", null)
    .select("id");
  if (error) throw new Error(error.message || "archive incident failed");
  return (data?.length ?? 0) > 0;
}

function resolvedNoticeFingerprint(incidentFingerprint: string): string {
  return createHash("sha256").update(`incident-resolved:${incidentFingerprint}`).digest("hex");
}

async function defaultNotifyResolved(input: ResolvedNoticeInput): Promise<void> {
  const { sendOpsFatalAdminAlert } = await import("@/lib/email/ops-fatal-admin");
  await sendOpsFatalAdminAlert({
    fingerprint: input.fingerprint,
    source: input.source,
    title: input.title,
    message: input.message,
    route: input.route,
    instanceId: input.instanceId,
    userId: input.userId,
    metadata: input.metadata,
  });
}

/**
 * One evaluation pass: collect customer-impact inputs, evaluate the rules,
 * page newly-open incidents with a diagnosis bundle, and resolve incidents
 * whose condition cleared. Best-effort per section — a collection failure
 * aborts the pass rather than risk wrong resolves; per-agent watchdog fetch
 * failures mark only that agent's box_down unknown.
 */
export async function runCustomerIncidentScan(
  deps: CustomerIncidentScanDeps = {},
): Promise<CustomerIncidentScanSummary> {
  const summary = emptySummary();
  const db = deps.db === undefined ? supabaseAdmin : deps.db;
  const now = deps.now?.() ?? Date.now();
  const report = deps.report ?? reportOpsEvent;
  const probe = deps.probe ?? defaultProbe;
  const adminUserIds = deps.adminUserIds ?? configuredOpsAdminUserIds();
  const cronSchedules = deps.cronSchedules ?? VERCEL_CRONS;
  const pagingEnabled =
    deps.pagingEnabled ?? incidentPagingEnabled(process.env.NEXT_PUBLIC_APP_URL);
  const archiveIncident =
    deps.archiveIncident ?? ((rowId: string) => (db ? defaultArchiveIncident(db, rowId) : Promise.resolve(false)));
  const notifyResolved = deps.notifyResolved ?? defaultNotifyResolved;

  if (!db) {
    log.error("supabaseAdmin not configured; skipping customer incident scan", new Error("supabaseAdmin missing"), {
      source: "customer-incidents",
      failureType: "supabase_admin_unavailable",
    });
    summary.failed += 1;
    return summary;
  }

  // ---- collect -------------------------------------------------------------
  let agents: HivraAgentSnapshot[];
  let hermesInstances: HermesInstanceSnapshot[];
  let heartbeats: CronHeartbeatSnapshot[];
  let openIncidentRows: OpenIncidentRow[];
  try {
    [agents, hermesInstances, heartbeats, openIncidentRows] = await Promise.all([
      collectAgents(db, now),
      collectHermesInstances(db, now),
      collectHeartbeats(db),
      collectOpenIncidentRows(db),
    ]);
  } catch (err) {
    // Without complete inputs we cannot tell "resolved" from "unknown" — abort
    // the whole pass. Next tick retries; nothing is reported or archived.
    log.error("customer incident scan collection failed; aborting pass", err, {
      source: "customer-incidents",
      failureType: "incident_collection_failed",
    });
    summary.failed += 1;
    return summary;
  }

  const customerUserIds = [
    ...new Set(
      [...agents, ...hermesInstances]
        .map((row) => row.userId)
        .filter((id): id is string => typeof id === "string" && id.length > 0 && !adminUserIds.has(id)),
    ),
  ];
  const subscriptions = await collectSubscriptions(db, customerUserIds);

  // Watchdog events are only needed for box_down candidates: running + awake +
  // non-admin. A failed per-agent fetch marks that agent's box_down unknown.
  const boxDownCandidates = agents.filter(
    (agent) =>
      agent.status === "running" &&
      agent.sleepState === "awake" &&
      !isAdminUser(agent.userId, adminUserIds),
  );
  const { byAgent: watchdogEventsByAgent, unknownAgentIds } = await collectWatchdogEvents(
    db,
    boxDownCandidates.map((agent) => agent.id),
  );

  // ---- evaluate ------------------------------------------------------------
  const evaluation = evaluateCustomerIncidents({
    now,
    adminUserIds,
    agents,
    watchdogEventsByAgent,
    watchdogUnknownAgentIds: unknownAgentIds,
    hermesInstances,
    heartbeats,
    cronSchedules,
  });
  summary.findings = evaluation.findings.length;
  summary.unknown = [...evaluation.unknownKeys].filter((key) =>
    openIncidentRows.some((row) => row.incidentKey === key),
  ).length;

  const openByKey = new Map<string, OpenIncidentRow>();
  for (const row of openIncidentRows) {
    if (row.incidentKey) openByKey.set(row.incidentKey, row);
    else {
      log.warn("customer-incidents: open incident row missing incident_key; leaving it alone", {
        source: "customer-incidents",
        failureType: "incident_row_missing_key",
        opsEventId: row.id,
      });
    }
  }

  // ---- report new incidents --------------------------------------------------
  for (const finding of evaluation.findings) {
    if (openByKey.has(finding.key)) {
      summary.stillOpen += 1;
      continue;
    }
    let probes: PublicProbeResult[] = [];
    if (finding.agent) {
      try {
        probes = await probeAgentPublicSurface(finding.agent, probe);
      } catch (err) {
        log.warn("customer-incidents: public probe failed", {
          source: "customer-incidents",
          failureType: "public_probe_failed",
          instanceId: finding.agent.id,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const subscription = finding.userId ? subscriptions.get(finding.userId) ?? null : null;
    const metadata = buildIncidentMetadata(finding, { subscription, probes });
    try {
      await report(incidentOpsEvent(finding, metadata, pagingEnabled));
      summary.opened += 1;
    } catch (err) {
      summary.failed += 1;
      log.error("customer-incidents: incident report failed", err, {
        source: "customer-incidents",
        failureType: "incident_report_failed",
        incidentKey: finding.key,
      });
    }
  }

  // ---- resolve closed incidents ----------------------------------------------
  const findingKeys = new Set(evaluation.findings.map((finding) => finding.key));
  for (const row of openIncidentRows) {
    if (!row.incidentKey) continue;
    if (findingKeys.has(row.incidentKey)) continue;
    if (evaluation.unknownKeys.has(row.incidentKey)) continue;
    let archived = false;
    try {
      archived = await archiveIncident(row.id);
    } catch (err) {
      summary.failed += 1;
      log.error("customer-incidents: incident archive failed", err, {
        source: "customer-incidents",
        failureType: "incident_archive_failed",
        opsEventId: row.id,
        incidentKey: row.incidentKey,
      });
      continue;
    }
    if (!archived) continue; // another invocation already resolved it
    summary.resolved += 1;
    if (!pagingEnabled) continue; // non-production: archive only, no admin mail
    try {
      await notifyResolved({
        fingerprint: resolvedNoticeFingerprint(row.fingerprint),
        source: row.source,
        title: `Resolved: ${row.title}`,
        message:
          `The condition that opened this customer incident no longer holds as of ` +
          `${new Date(now).toISOString()}. The incident row is archived; if it recurs it ` +
          `will page again.`,
        route: "/api/cron/customer-incidents",
        instanceId: null,
        userId: null,
        metadata: {
          incident_key: row.incidentKey,
          resolved_at: new Date(now).toISOString(),
          detected_by: "cron:customer-incidents",
        },
      });
    } catch (err) {
      // The row is archived either way — a missed notice must not unresolve it.
      summary.failed += 1;
      log.error("customer-incidents: resolved notice failed", err, {
        source: "customer-incidents",
        failureType: "incident_resolved_notice_failed",
        opsEventId: row.id,
        incidentKey: row.incidentKey,
      });
    }
  }

  if (summary.opened > 0 || summary.resolved > 0 || summary.failed > 0) {
    log.info("customer incident scan complete", {
      source: "customer-incidents",
      pagingEnabled,
      ...summary,
    });
  }
  if (!pagingEnabled && evaluation.findings.length > 0) {
    log.warn("customer-incidents: incidents present but admin paging is disabled on this deployment", {
      source: "customer-incidents",
      failureType: "incident_paging_disabled",
      findings: evaluation.findings.length,
    });
  }
  return summary;
}
