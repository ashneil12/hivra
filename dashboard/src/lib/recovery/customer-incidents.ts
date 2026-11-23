import "server-only";

import { createHash } from "node:crypto";

import { log } from "@/lib/logger";
import { reportOpsEvent, type OpsEventInput } from "@/lib/ops-events";
import { configuredOpsAdminUserIds, normalizeOpsUserId } from "@/lib/ops-access";
import { isCanaryDeployment } from "@/lib/deployment-channel";
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

export type IncidentRule =
  | "box_down"
  | "box_unreachable"
  | "launch_failed"
  | "lifecycle_stuck"
  | "cron_unhealthy";
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
  /** Last sleep/wake tier transition — bumped on every wake, so it marks the current runtime's start. */
  sleepTierChangedAt: string | null;
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
  /** Row creation time — the dead-man reference for a cron that never succeeded. */
  createdAt: string | null;
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
  subjectKind: string | null;
  /**
   * The occurrence this snapshot observed. reportOpsEvent bumps both fields
   * on every re-report, so an archive that still matches them cannot close a
   * recurrence that landed after the scan read the row.
   */
  occurrenceCount: number | null;
  lastSeenAt: string | null;
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
  /**
   * Newest surface failure/recovery receipt per agent id, fetched by its own
   * per-kind queries so the 30-row mixed diagnosis timeline — and a burst of
   * opposite-kind receipts — cannot push it out of view.
   * This — not a scan of the timeline — decides box_down open/resolve.
   */
  latestSurfaceReceiptByAgent: ReadonlyMap<string, WatchdogEventSnapshot>;
  /** Agents whose watchdog-event fetch failed — box_down cannot be evaluated for them. */
  watchdogUnknownAgentIds: ReadonlySet<string>;
  /**
   * agentId → outage start (ms epoch) for agents whose dashboard-side public
   * probe is currently failing. Drives box_unreachable.
   */
  publicOutageStartedAtMs?: ReadonlyMap<string, number>;
  /** Agents whose public probe could not be evaluated this scan. */
  publicProbeUnknownAgentIds?: ReadonlySet<string>;
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
const BOX_UNREACHABLE_MIN_AGE_MS = 10 * 60 * 1000;
// A box_down whose newest surface receipt is this old AND whose public
// /healthz probe succeeded this scan is a stale record, not a live outage:
// the box answers publicly and simply stopped emitting receipts (watchdog
// removed, relays lost). Archive it silently — no resolved notice.
const BOX_DOWN_STALE_RECEIPT_MS = 24 * 60 * 60 * 1000;
const LAUNCH_FAILED_WINDOW_MS = 24 * 60 * 60 * 1000;
const LAUNCH_FAILED_STUCK_MS = 25 * 60 * 1000;
const LIFECYCLE_STUCK_MS = 15 * 60 * 1000;
const CRON_STALE_PERIOD_MULTIPLIER = 3;
const CRON_NEVER_SUCCEEDED_PERIOD_MULTIPLIER = 3;
const CRON_FAILURE_STREAK = 3;
const WATCHDOG_TIMELINE_LIMIT = 10;

const BOX_DOWN_EVENT_TYPES = new Set(["gateway_down", "unit_restart", "recovery_exhausted"]);
const BOX_RECOVERY_EVENT_TYPES = new Set(["recovered", "gateway_recovered"]);
// Only surface failure/recovery receipts decide open/resolve state.
// unit_failing and watchdog_error are diagnostic noise for this rule — a
// unit_failing emitted after recovery_exhausted must not clear a live
// outage, and they stay in the diagnosis timeline either way.
const BOX_SURFACE_EVENT_TYPES = new Set([
  ...BOX_DOWN_EVENT_TYPES,
  ...BOX_RECOVERY_EVENT_TYPES,
]);
const BOX_DOWN_EVENT_TYPE_LIST = [...BOX_DOWN_EVENT_TYPES];
const BOX_RECOVERY_EVENT_TYPE_LIST = [...BOX_RECOVERY_EVENT_TYPES];

/**
 * The newest runtime (re)start marker the hivra_agents row actually records:
 * first provision, the last sleep/wake tier transition (bumped on every
 * wake), or an in-flight lifecycle operation's start. There is no dedicated
 * "last restart" column — completed operations clear operation_started_at
 * and provisioned_at keeps its first value — so this is the honest bound:
 * receipts older than it belong to a previous runtime and cannot describe
 * the box's current state.
 */
function agentRuntimeMarkerMs(agent: HivraAgentSnapshot): number | null {
  let marker: number | null = null;
  for (const value of [agent.provisionedAt, agent.sleepTierChangedAt, agent.operationStartedAt]) {
    const ms = parseTimeMs(value);
    if (ms != null && (marker == null || ms > marker)) marker = ms;
  }
  return marker;
}
const LAUNCH_FAILED_AGENT_STATUSES = new Set(["error", "deleted"]);
const LAUNCH_FAILED_INSTANCE_STATUSES = new Set(["failed", "error"]);

function parseTimeMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function isAdminUser(userId: string | null | undefined, adminUserIds: ReadonlySet<string>): boolean {
  const normalized = normalizeOpsUserId(userId);
  return normalized != null && adminUserIds.has(normalized);
}

/**
 * Admin ids arrive from OPS_ADMIN_USER_IDS (already lowercased) or an injected
 * dep; stored user ids come from the database with their original casing.
 * Normalize BOTH sides with the same rule isOpsAdminUser uses so a casing
 * difference can never turn an operator's box into a customer page.
 */
function normalizeAdminIdSet(ids: ReadonlySet<string>): ReadonlySet<string> {
  const normalized = new Set<string>();
  for (const id of ids) {
    const value = normalizeOpsUserId(id);
    if (value) normalized.add(value);
  }
  return normalized;
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
  box_unreachable:
    "A customer's agent box is unreachable over its public hostname: the dashboard-side " +
    "probe of https://<hostname>/healthz has been failing for at least 10 minutes. This " +
    "signal does not depend on the box gateway, so it still fires while the gateway itself " +
    "is down. The customer likely cannot open their agent at all. Diagnosis is in this " +
    "event's metadata.",
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
  const { now } = input;
  const adminUserIds = normalizeAdminIdSet(input.adminUserIds);

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
    // The newest SURFACE receipt comes from its own query — the 30-row mixed
    // timeline can be crowded out by newer diagnostic events. Receipts that
    // predate the current runtime's start marker belong to a previous boot
    // and cannot open or hold an incident for this one.
    const latest = input.latestSurfaceReceiptByAgent.get(agent.id);
    if (!latest?.eventType) continue;
    if (!BOX_SURFACE_EVENT_TYPES.has(latest.eventType)) continue;
    const receiptMs = parseTimeMs(latest.eventAt) ?? parseTimeMs(latest.firstSeenAt);
    const runtimeMarkerMs = agentRuntimeMarkerMs(agent);
    if (receiptMs != null && runtimeMarkerMs != null && receiptMs < runtimeMarkerMs) continue;
    if (BOX_RECOVERY_EVENT_TYPES.has(latest.eventType)) continue;
    if (!BOX_DOWN_EVENT_TYPES.has(latest.eventType)) continue;
    const immediate = latest.eventType === "recovery_exhausted";
    if (!immediate && (receiptMs == null || now - receiptMs < BOX_DOWN_MIN_AGE_MS)) continue;
    // A failure receipt older than 24h is stale bookkeeping UNLESS the
    // public probe says otherwise this scan. Probe succeeded → suppress
    // the finding so the resolve pass archives the row
    // (stale_no_new_receipts): the box answers publicly and simply stopped
    // emitting receipts. Probe still failing → the outage is live; the
    // finding stands. Probe UNKNOWN → the stale receipt alone is not
    // evidence of a new outage: emit no finding — reporting one would
    // REOPEN a silently archived row and re-page with no new outage
    // evidence — but mark the key unknown so an already-open row stays
    // open untouched instead of being resolved on a probe we could not
    // run. Only a failed probe or a fresh (≤24h) receipt reopens a stale
    // box_down.
    if (
      receiptMs != null &&
      now - receiptMs > BOX_DOWN_STALE_RECEIPT_MS &&
      input.publicOutageStartedAtMs?.get(agent.id) == null
    ) {
      if (input.publicProbeUnknownAgentIds?.has(agent.id)) {
        unknownKeys.add(key);
      }
      continue;
    }
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

  // ---- box_unreachable -----------------------------------------------------
  // Gateway-independent signal: the dashboard-side probe of the box's public
  // /healthz keeps failing while the box reports running. The outage clock is
  // the probe row's first_seen_at, so a flap under 10 minutes never pages. A
  // probe that could not run this scan (budget, read failure, no hostname)
  // marks the key unknown — an open incident is never resolved on a guess.
  for (const agent of input.agents) {
    if (agent.status !== "running" || agent.sleepState !== "awake") continue;
    if (isAdminUser(agent.userId, adminUserIds)) continue;
    const key = `box_unreachable:${agent.id}`;
    if (input.publicProbeUnknownAgentIds?.has(agent.id)) {
      unknownKeys.add(key);
      continue;
    }
    const outageStartMs = input.publicOutageStartedAtMs?.get(agent.id);
    if (outageStartMs == null || now - outageStartMs < BOX_UNREACHABLE_MIN_AGE_MS) continue;
    const events = sortWatchdogEventsByEventAt(input.watchdogEventsByAgent.get(agent.id) ?? []);
    findings.push({
      key,
      rule: "box_unreachable",
      subjectId: agent.id,
      subjectKind: "hivra_agent",
      userId: agent.userId,
      title: "Customer incident: agent box unreachable",
      message: RULE_MESSAGES.box_unreachable,
      route: `/dashboard/agent/${agent.id}`,
      instanceId: agent.id,
      agent,
      instance: null,
      cron: null,
      watchdogTimeline: events.slice(0, WATCHDOG_TIMELINE_LIMIT),
      nextStep:
        "Check the box's Cloudflare tunnel, DNS and public hostname — the dashboard-side " +
        "/healthz probe has failed for 10+ minutes while the box reports running",
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
    // A cron that ran but never succeeded has no last_success_at — use
    // last_run_at as the staleness reference so a silent-after-first-failure
    // cron is still caught. The same 3x grace applies from the last run.
    const referenceMs =
      parseTimeMs(heartbeat.lastSuccessAt) ?? parseTimeMs(heartbeat.lastRunAt);
    const stale =
      periodMinutes != null &&
      referenceMs != null &&
      now - referenceMs > CRON_STALE_PERIOD_MULTIPLIER * periodMinutes * 60 * 1000;
    // A cron that ran but never succeeded keeps refreshing last_run_at on
    // every failure, so the staleness check above can never see it. Mirror
    // the independent watchdog: run_count > 0, no success ever, and the row
    // is older than 3x its period means the cron has been dead since birth.
    const neverSucceededMs = parseTimeMs(heartbeat.createdAt);
    const neverSucceededStale =
      periodMinutes != null &&
      heartbeat.lastSuccessAt == null &&
      (heartbeat.runCount ?? 0) > 0 &&
      neverSucceededMs != null &&
      now - neverSucceededMs > CRON_NEVER_SUCCEEDED_PERIOD_MULTIPLIER * periodMinutes * 60 * 1000;
    if (streak < CRON_FAILURE_STREAK && !stale && !neverSucceededStale) continue;
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
  sleep_tier_changed_at: string | null;
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
  created_at: string | null;
}

interface WatchdogOpsRow {
  id: string;
  title: string | null;
  first_seen_at: string | null;
  metadata: Record<string, unknown> | null;
}

const AGENT_SELECT =
  "id,user_id,type,name,status,sleep_state,desired_state,created_at,provisioned_at," +
  "sleep_tier_changed_at," +
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
    sleepTierChangedAt: row.sleep_tier_changed_at,
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
    createdAt: row.created_at,
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

// PostgREST caps every response at max_rows (1000 in this project) and says
// nothing when it truncates — an unpaged subject query silently drops rows,
// which for this scan means a customer incident that never opens or a stale
// one that resolves early. Page every subject read until a short page.
//
// Keyset, not offsets: an offset read skips whichever row moves across the
// page boundary between requests (an agent that stops running mid-scan
// shifts every later row up one slot), and the resolver would then archive
// that subject's open incident as recovered. Ordering by the unique column
// and resuming `.gt(col, last)` can neither skip nor repeat a row. An error
// mid-read throws — the caller aborts the pass, so partial data is never
// treated as evidence of recovery.
const SUBJECT_PAGE_SIZE = 1000;

async function selectAllPages<RowT>(
  label: string,
  build: (
    cursor: string | null,
  ) => PromiseLike<{ data: unknown; error: { message?: string } | null }>,
  cursorOf: (row: RowT) => string | null,
): Promise<RowT[]> {
  const rows: RowT[] = [];
  let cursor: string | null = null;
  for (;;) {
    const { data, error } = await build(cursor);
    if (error) throw new Error(error.message || `${label} query failed`);
    const page = (data ?? []) as RowT[];
    rows.push(...page);
    if (page.length < SUBJECT_PAGE_SIZE) return rows;
    const tail = cursorOf(page[page.length - 1]);
    if (tail == null) throw new Error(`${label} pagination cursor missing`);
    cursor = tail;
  }
}

async function collectAgents(db: DbClient, now: number): Promise<HivraAgentSnapshot[]> {
  const cutoff24 = new Date(now - LAUNCH_FAILED_WINDOW_MS).toISOString();
  // Three bounded queries merged by id: unprovisioned-recent (launch_failed),
  // running (box_down), and in-flight operations (lifecycle_stuck — the stuck
  // op may sit on a non-running status like provisioning/deleting).
  const [unprovisioned, running, inFlight] = await Promise.all([
    selectAllPages<AgentDbRow>(
      "hivra_agents unprovisioned",
      (cursor) => {
        let query = db
          .from("hivra_agents")
          .select(AGENT_SELECT)
          .is("provisioned_at", null)
          .gte("created_at", cutoff24)
          .order("id", { ascending: true });
        if (cursor != null) query = query.gt("id", cursor);
        return query.limit(SUBJECT_PAGE_SIZE);
      },
      (row) => row.id,
    ),
    selectAllPages<AgentDbRow>(
      "hivra_agents running",
      (cursor) => {
        let query = db
          .from("hivra_agents")
          .select(AGENT_SELECT)
          .eq("status", "running")
          .order("id", { ascending: true });
        if (cursor != null) query = query.gt("id", cursor);
        return query.limit(SUBJECT_PAGE_SIZE);
      },
      (row) => row.id,
    ),
    selectAllPages<AgentDbRow>(
      "hivra_agents in-flight",
      (cursor) => {
        let query = db
          .from("hivra_agents")
          .select(AGENT_SELECT)
          .not("operation_kind", "is", null)
          .not("operation_started_at", "is", null)
          .order("id", { ascending: true });
        if (cursor != null) query = query.gt("id", cursor);
        return query.limit(SUBJECT_PAGE_SIZE);
      },
      (row) => row.id,
    ),
  ]);
  const byId = new Map<string, HivraAgentSnapshot>();
  for (const row of [...unprovisioned, ...running, ...inFlight]) {
    byId.set(row.id, toAgentSnapshot(row));
  }
  return [...byId.values()];
}

async function collectHermesInstances(db: DbClient, now: number): Promise<HermesInstanceSnapshot[]> {
  const cutoff24 = new Date(now - LAUNCH_FAILED_WINDOW_MS).toISOString();
  const rows = await selectAllPages<HermesInstanceDbRow>(
    "hermes_instances",
    (cursor) => {
      let query = db
        .from("hermes_instances")
        .select("id,user_id,name,status,lifecycle_state,gateway_url,created_at")
        .gte("created_at", cutoff24)
        .order("id", { ascending: true });
      if (cursor != null) query = query.gt("id", cursor);
      return query.limit(SUBJECT_PAGE_SIZE);
    },
    (row) => row.id,
  );
  return rows.map(toInstanceSnapshot);
}

async function collectHeartbeats(db: DbClient): Promise<CronHeartbeatSnapshot[]> {
  const rows = await selectAllPages<HeartbeatDbRow>(
    "ops_cron_heartbeats",
    (cursor) => {
      // cron_name is the table's primary key — the keyset cursor column.
      let query = db
        .from("ops_cron_heartbeats")
        .select("cron_name,last_run_at,last_success_at,run_count,ok_count,consecutive_failures,last_detail,created_at")
        .order("cron_name", { ascending: true });
      if (cursor != null) query = query.gt("cron_name", cursor);
      return query.limit(SUBJECT_PAGE_SIZE);
    },
    (row) => row.cron_name,
  );
  return rows.map(toHeartbeatSnapshot);
}

async function collectOpenIncidentRows(db: DbClient): Promise<OpenIncidentRow[]> {
  const data = await selectAllPages<Record<string, unknown>>(
    "open incident rows",
    (cursor) => {
      let query = db
        .from("ops_events")
        .select("id,fingerprint,title,source,metadata,occurrence_count,last_seen_at")
        .like("source", "incident.%")
        .is("archived_at", null)
        .order("id", { ascending: true });
      if (cursor != null) query = query.gt("id", cursor);
      return query.limit(SUBJECT_PAGE_SIZE);
    },
    (row) => (typeof row.id === "string" ? row.id : null),
  );
  const rows: OpenIncidentRow[] = [];
  for (const row of data) {
    const metadata = (row.metadata ?? {}) as Record<string, unknown>;
    rows.push({
      id: String(row.id),
      fingerprint: String(row.fingerprint ?? ""),
      source: String(row.source ?? ""),
      title: String(row.title ?? ""),
      incidentKey: strOrNull(metadata.incident_key),
      subjectKind: strOrNull(metadata.subject_kind),
      occurrenceCount:
        typeof row.occurrence_count === "number" ? row.occurrence_count : null,
      lastSeenAt: typeof row.last_seen_at === "string" ? row.last_seen_at : null,
    });
  }
  return rows;
}

const WATCHDOG_FETCH_CONCURRENCY = 8;
const WATCHDOG_EVENTS_PER_AGENT_LIMIT = 30;
// Bounded window PER RECEIPT KIND AND PER ORDERING for the
// newest-surface-receipt reads. SQL cannot order by the receipt's
// EFFECTIVE time (a null or unparseable metadata.event_at sorts first
// under DESC in Postgres and would shadow a genuinely newer row), so the
// newest by effective time is picked in code with the same rule the
// evaluator uses (event_at, else first_seen_at). The window is per kind
// because a single mixed window starves: a recovery recorded just before
// a burst of late-relayed failure receipts (backlog drain) falls outside
// it and the evaluator pages for a box that already recovered — and the
// mirror image hides a live outage behind stale recoveries.
//
// Three orderings per kind because no two of them bound same-kind
// crowding in every direction. Ordering by first_seen_at desc alone lets
// a burst of OLD-event_at receipts recorded later push the genuinely
// newest EVENT out of the window — a backlog relay re-delivering 10 stale
// failures can hide the latest failure behind them, flipping the
// cross-kind verdict to a recovery that is actually older. Ordering by
// metadata->>event_at desc alone cannot see a receipt whose event_at is
// missing or unparseable — and neither can the recorded-time window when
// a burst of newer-recorded receipts that DO carry event_at fills it:
// a null-event_at receipt then has no window at all, even when its
// first_seen_at fallback makes it the newest effective receipt of its
// kind. The third window bounds the null-event_at subset on its own
// (recorded-time order over rows filtered event_at IS NULL), so a
// receipt can only be displaced from the union by same-kind receipts
// that genuinely beat its effective time.
const SURFACE_RECEIPT_WINDOW = 10;
// The per-agent watchdog reads are the scan's least bounded loop: with no
// deadline, (agents ÷ 8) × per-query latency can exceed the route's
// maxDuration and the invocation dies before reporting, resolving or the
// heartbeat write. Agents not reached before this deadline are unknown —
// never resolved on partial data — and count as degraded.
const SCAN_WATCHDOG_READ_BUDGET_MS = 60_000;

async function collectWatchdogEvents(
  db: DbClient,
  agentIds: string[],
  options?: { deadlineAt?: number; clock?: () => number },
): Promise<{
  byAgent: Map<string, WatchdogEventSnapshot[]>;
  latestSurfaceByAgent: Map<string, WatchdogEventSnapshot>;
  unknownAgentIds: Set<string>;
}> {
  const byAgent = new Map<string, WatchdogEventSnapshot[]>();
  const latestSurfaceByAgent = new Map<string, WatchdogEventSnapshot>();
  const unknownAgentIds = new Set<string>();
  const queue = [...agentIds];
  const clock = options?.clock ?? Date.now;
  const deadlineAt = options?.deadlineAt;
  const markRestUnknown = (currentId: string | undefined) => {
    if (currentId !== undefined) unknownAgentIds.add(currentId);
    for (let rest = queue.shift(); rest !== undefined; rest = queue.shift()) {
      unknownAgentIds.add(rest);
    }
  };
  // One agent's reads: the mixed diagnosis timeline plus the bounded
  // per-kind/per-ordering surface-receipt windows. Extracted so the whole
  // unit can race the watchdog deadline — a stalled read must not hold a
  // worker past the budget the report pass and heartbeat depend on.
  const readAgent = async (id: string): Promise<void> => {
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
      return;
    }
    byAgent.set(
      id,
      ((data ?? []) as WatchdogOpsRow[]).map(watchdogEventFromOpsRow),
    );
    // The newest surface failure/recovery receipt gets its own bounded
    // reads — THREE ORDERINGS per receipt kind, all in flight at once.
    // The 30-row mixed timeline above is diagnostic context and can be
    // entirely newer non-surface receipts, which would hide the
    // receipt that actually decides whether the box is down; and a
    // single mixed receipt window lets one kind crowd the other out
    // of view (a late-relayed burst of stale failures can push a
    // newer recovery outside it — or stale recoveries a live
    // failure). Within one kind the three orderings bound the same
    // crowding in every direction: the recorded-time window sees
    // receipts whose effective time is the first_seen_at fallback, the
    // event-time window cannot be crowded out by late-recorded stale
    // events, and the null-event_at window keeps fallback-timestamped
    // receipts visible when newer-recorded event_at-bearing receipts
    // fill the recorded-time window.
    const receiptWindowQueries = (eventTypes: string[]) => {
      const base = () =>
        db
          .from("ops_events")
          .select("id,title,first_seen_at,metadata")
          .eq("instance_id", id)
          .like("source", "box.surface_watchdog.%")
          .in("metadata->>event_type", eventTypes)
          .limit(SURFACE_RECEIPT_WINDOW);
      return [
        // Newest-RECORDED receipts of the kind: first_seen_at is
        // always populated, so this window covers receipts whose
        // effective time is the record-time fallback.
        base().order("first_seen_at", { ascending: false }),
        // Newest box-REPORTED events of the kind: a burst of stale
        // receipts relayed late cannot push the genuinely newest
        // event below this window's cutoff. Rows without event_at
        // are filtered out — they would sort first under DESC and
        // waste window slots on receipts the recorded-time window
        // already covers.
        base()
          .not("metadata->>event_at", "is", null)
          .order("metadata->>event_at", { ascending: false }),
        // Newest-recorded receipts with NO event_at: the two windows
        // above can both fill with event_at-bearing receipts — the
        // event-time window excludes nulls by construction and the
        // recorded-time window admits them on recency — so a
        // fallback-timestamped receipt could otherwise be crowded out
        // entirely even when it is the newest effective receipt of
        // its kind. Its effective time IS first_seen_at, so only
        // newer-recorded null-event_at receipts may displace it.
        base()
          .is("metadata->>event_at", null)
          .order("first_seen_at", { ascending: false }),
      ];
    };
    const [
      downRecorded,
      downEvents,
      downNulls,
      recoveryRecorded,
      recoveryEvents,
      recoveryNulls,
    ] = await Promise.all([
      ...receiptWindowQueries(BOX_DOWN_EVENT_TYPE_LIST),
      ...receiptWindowQueries(BOX_RECOVERY_EVENT_TYPE_LIST),
    ]);
    const receiptError =
      downRecorded.error ??
      downEvents.error ??
      downNulls.error ??
      recoveryRecorded.error ??
      recoveryEvents.error ??
      recoveryNulls.error;
    if (receiptError) {
      // The timeline read succeeded but a deciding receipt did not —
      // box_down cannot be evaluated for this agent this pass.
      unknownAgentIds.add(id);
      log.warn("customer-incidents: surface receipt fetch failed for agent", {
        source: "customer-incidents",
        failureType: "surface_receipt_fetch_failed",
        instanceId: id,
        errorMessage: receiptError.message,
      });
      return;
    }
    // Pick the newest receipt by EFFECTIVE time (event_at, else
    // first_seen_at) across the union of all six windows — the same
    // rule evaluateCustomerIncidents applies, so a receipt with a
    // missing/invalid event_at cannot shadow a genuinely newer one.
    // A row inside several windows appears several times; dedupe by
    // row id so the comparison sees each receipt once.
    const unionRows = new Map<string, WatchdogOpsRow>();
    for (const result of [
      downRecorded,
      downEvents,
      downNulls,
      recoveryRecorded,
      recoveryEvents,
      recoveryNulls,
    ]) {
      for (const row of (result.data ?? []) as WatchdogOpsRow[]) {
        unionRows.set(String(row.id), row);
      }
    }
    const receipt = sortWatchdogEventsByEventAt(
      [...unionRows.values()].map(watchdogEventFromOpsRow),
    )[0];
    if (receipt) {
      latestSurfaceByAgent.set(id, receipt);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(WATCHDOG_FETCH_CONCURRENCY, queue.length) }, async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        if (deadlineAt != null && clock() >= deadlineAt) {
          markRestUnknown(id);
          return;
        }
        if (deadlineAt == null) {
          await readAgent(id);
          continue;
        }
        // Hard deadline on the reads themselves, not just admission: a
        // stalled query must not hold a worker past the budget — the
        // agent is unread (unknown — never resolved on partial data) and
        // the queue drains for the next pass.
        const completed = await finishedBeforeDeadline(
          () => readAgent(id),
          deadlineAt,
          clock,
        );
        if (!completed) {
          log.warn("customer-incidents: watchdog reads exceeded the scan deadline for agent", {
            source: "customer-incidents",
            failureType: "watchdog_reads_deadline",
            instanceId: id,
          });
          markRestUnknown(id);
          return;
        }
      }
    }),
  );
  return { byAgent, latestSurfaceByAgent, unknownAgentIds };
}

// ---- public reachability signal (box_unreachable) ---------------------------
//
// box_down reads the box-side watchdog THROUGH the box gateway, so a gateway
// outage produces no receipts and the rule stays silent for the whole
// outage. The public probe is dashboard-side: it asks the box's public
// hostname directly, so it keeps working while the gateway path is dead.
// Each scan probes every running, awake, non-admin box's
// https://<cf_hostname>/healthz and maintains one ops_events row per box
// (source box.public_probe.unreachable, warn, never pages). The row's
// first_seen_at is the outage start; box_unreachable pages once it is 10
// minutes old, and the row is archived the first scan the probe succeeds.

const PUBLIC_PROBE_CONCURRENCY = 16;
const PUBLIC_PROBE_WRITE_CONCURRENCY = 8;
export const PUBLIC_PROBE_SOURCE = "box.public_probe.unreachable";

type PublicProbeSignal =
  | { kind: "up" }
  | { kind: "down"; status: number | null; latencyMs: number | null; error: string | null }
  | { kind: "skipped"; reason: "budget" | "no_hostname" | "invalid_hostname" };

interface OpenProbeRow {
  id: string;
  agentId: string;
  firstSeenAt: string | null;
  /**
   * The row version this scan observed. reportOpsEvent bumps both fields on
   * every report, so a write that still matches them cannot clobber a
   * concurrent failure/refresh that landed after the read.
   */
  occurrenceCount: number | null;
  lastSeenAt: string | null;
}

interface ProbeRowDbRow {
  id: string;
  instance_id: string | null;
  first_seen_at: string | null;
  occurrence_count: number | null;
  last_seen_at: string | null;
}

async function runPool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
        await fn(item);
      }
    }),
  );
}

/**
 * Bound one unit of scan work by a phase deadline — a HARD bound, not just
 * the admission check at the queue head. The supabase/PostgREST client in
 * this codebase exposes no per-query timeout, so the bound is a RACE
 * rather than a cancellation: when the deadline wins, the op keeps
 * running in the background while the scan moves on and still reaches the
 * heartbeat write. That is safe because every write the op can still land
 * is version-guarded (a stale archive/reset no-ops against a row that
 * moved) or idempotent, and the caller counts the timed-out unit as
 * degraded and treats its subject as unprocessed — rows unarchived and
 * unresolved, retried next pass.
 *
 * `start` is a thunk so work past the deadline is never even started: a
 * write that begins at the deadline boundary would otherwise run in the
 * background untracked. Returns false when the deadline won; rejections
 * from the work itself propagate exactly as a direct await would.
 */
async function finishedBeforeDeadline(
  start: () => PromiseLike<unknown>,
  deadlineAt: number,
  clock: () => number,
): Promise<boolean> {
  const remainingMs = deadlineAt - clock();
  if (remainingMs <= 0) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const winner = await Promise.race([
      Promise.resolve(start()),
      new Promise<"deadline">((resolve) => {
        timer = setTimeout(() => resolve("deadline"), remainingMs);
      }),
    ]);
    return winner !== "deadline";
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Rotate a work list by the scan-tick bucket so budget-bounded loops walk
 * their tail across passes: a fixed order would starve whichever items
 * land outside the window every tick — their incidents could then never
 * open or resolve — while the rotated order periodically brings every
 * item inside it.
 */
function rotateByScanTick<T>(items: T[], scanTick: number): T[] {
  return items.length > 1
    ? [
        ...items.slice(scanTick % items.length),
        ...items.slice(0, scanTick % items.length),
      ]
    : items;
}

/** Open box.public_probe.* rows, keyed later by agent id. */
async function collectOpenProbeRows(db: DbClient): Promise<OpenProbeRow[]> {
  const rows = await selectAllPages<ProbeRowDbRow>(
    "open public probe rows",
    (cursor) => {
      let query = db
        .from("ops_events")
        .select("id,instance_id,first_seen_at,occurrence_count,last_seen_at")
        .eq("source", PUBLIC_PROBE_SOURCE)
        .is("archived_at", null)
        .order("id", { ascending: true });
      if (cursor != null) query = query.gt("id", cursor);
      return query.limit(SUBJECT_PAGE_SIZE);
    },
    (row) => row.id,
  );
  const open: OpenProbeRow[] = [];
  for (const row of rows) {
    if (typeof row.instance_id === "string" && row.instance_id.length > 0) {
      open.push({
        id: row.id,
        agentId: row.instance_id,
        firstSeenAt: typeof row.first_seen_at === "string" ? row.first_seen_at : null,
        occurrenceCount:
          typeof row.occurrence_count === "number" ? row.occurrence_count : null,
        lastSeenAt: typeof row.last_seen_at === "string" ? row.last_seen_at : null,
      });
    }
  }
  return open;
}

/**
 * Probe every candidate's public /healthz. "Up" means HTTP 200 only — the
 * same policy the ingress edge check uses (hivra/ingress/enable.ts): the
 * Cloudflare tunnel config ends in a catch-all `http_status:404` ingress
 * rule, so a hostname with no live ingress answers 404 at the edge WITHOUT
 * ever reaching the box, and counting it as up would falsely clear a real
 * outage. Transport failures and everything else (5xx Cloudflare origin
 * errors, redirects, other 4xx) mean the box did not serve a healthy
 * /healthz. Budget-skipped and unprobable hosts are reported distinctly so
 * the caller can mark them unknown without counting them as scan
 * degradation.
 */
async function collectPublicProbeSignals(
  agents: HivraAgentSnapshot[],
  probe: ProbeFn,
  budget: { deadlineAt: number; clock: () => number },
): Promise<Map<string, PublicProbeSignal>> {
  const signals = new Map<string, PublicProbeSignal>();
  const queue = [...agents];
  const skipRest = (reason: "budget") => {
    for (let rest = queue.shift(); rest !== undefined; rest = queue.shift()) {
      signals.set(rest.id, { kind: "skipped", reason });
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(PUBLIC_PROBE_CONCURRENCY, queue.length) }, async () => {
      for (let agent = queue.shift(); agent !== undefined; agent = queue.shift()) {
        if (budget.clock() >= budget.deadlineAt) {
          signals.set(agent.id, { kind: "skipped", reason: "budget" });
          skipRest("budget");
          return;
        }
        const host = agent.cfHostname?.trim().toLowerCase();
        if (!host) {
          signals.set(agent.id, { kind: "skipped", reason: "no_hostname" });
          continue;
        }
        let url: string;
        try {
          url = new URL(`https://${host}/healthz`).toString();
        } catch {
          signals.set(agent.id, { kind: "skipped", reason: "invalid_hostname" });
          continue;
        }
        const outcome = await probe(url);
        // Only 200 proves the box itself served /healthz — any other status
        // (including the tunnel catch-all's edge-side 404) is down.
        const healthy = outcome.status === 200;
        signals.set(
          agent.id,
          healthy
            ? { kind: "up" }
            : {
                kind: "down",
                status: outcome.status,
                latencyMs: outcome.latencyMs,
                error: outcome.error,
              },
        );
      }
    }),
  );
  return signals;
}

/**
 * The probe row's title/message are fixed per box so the fingerprint is
 * stable while the outage continues; volatile detail (status, error) lives
 * in metadata, which is not part of the fingerprint.
 */
function publicProbeUnreachableOpsEvent(
  agent: HivraAgentSnapshot,
  signal: Extract<PublicProbeSignal, { kind: "down" }>,
): OpsEventInput {
  return {
    source: PUBLIC_PROBE_SOURCE,
    severity: "warn",
    page: false,
    // first_seen_at is the outage start: a recurrence after archival must
    // restart the clock in the same write that reopens the row.
    resetFirstSeenOnReopen: true,
    title: "Customer box public probe unreachable",
    message:
      "The dashboard-side public probe cannot get a healthy response from the box's " +
      "public /healthz endpoint. This signal does not depend on the box gateway, so it " +
      "covers gateway outages the watchdog path cannot see. Latest probe detail is in " +
      "this event's metadata.",
    route: `/dashboard/agent/${agent.id}`,
    userId: agent.userId,
    instanceId: agent.id,
    metadata: {
      detected_by: "cron:customer-incidents",
      agent_id: agent.id,
      cf_hostname: agent.cfHostname,
      probe: {
        status: signal.status,
        latency_ms: signal.latencyMs,
        error: signal.error,
        checked_at: new Date().toISOString(),
      },
    },
  };
}

type ProbeRowArchiveOutcome = "archived" | "moved" | "error";

/**
 * Archive the probe-outage row this scan OBSERVED — not whatever the row
 * has become since. A concurrent scan can record a fresh failure on the
 * same row between this scan's read and its healthy-probe archive; the
 * occurrence_count/last_seen_at predicates make that update a no-op so the
 * new outage clock is never reset by a stale observation. A zero-row
 * result is "moved": the row was archived or version-bumped by someone
 * else, and the caller treats the subject as unknown rather than resolved.
 */
async function archivePublicProbeRow(
  db: DbClient,
  row: OpenProbeRow,
  archivedAtIso: string,
): Promise<ProbeRowArchiveOutcome> {
  let query = db
    .from("ops_events")
    .update({ archived_at: archivedAtIso, archived_by_user_id: null })
    .eq("id", row.id)
    .is("archived_at", null);
  query =
    row.occurrenceCount == null
      ? query.is("occurrence_count", null)
      : query.eq("occurrence_count", row.occurrenceCount);
  query =
    row.lastSeenAt == null
      ? query.is("last_seen_at", null)
      : query.eq("last_seen_at", row.lastSeenAt);
  const { data, error } = await query.select("id");
  if (error) {
    log.warn("customer-incidents: public probe row archive failed", {
      source: "customer-incidents",
      failureType: "public_probe_archive_failed",
      opsEventId: row.id,
      errorMessage: error.message,
    });
    return "error";
  }
  return (data?.length ?? 0) > 0 ? "archived" : "moved";
}

type ProbeRowResetOutcome = "reset" | "moved" | "error";

/**
 * Pin an open probe-outage row's first_seen_at to a fresh outage start,
 * guarded on the first_seen_at this scan observed so a concurrent reset or
 * archive is not clobbered. Used when the stored outage predates the box's
 * current runtime — see applyPublicProbeSignals.
 */
async function resetPublicProbeRowFirstSeen(
  db: DbClient,
  row: OpenProbeRow,
  firstSeenAtIso: string,
): Promise<ProbeRowResetOutcome> {
  let query = db
    .from("ops_events")
    .update({ first_seen_at: firstSeenAtIso })
    .eq("id", row.id)
    .is("archived_at", null);
  query =
    row.firstSeenAt == null
      ? query.is("first_seen_at", null)
      : query.eq("first_seen_at", row.firstSeenAt);
  const { data, error } = await query.select("id");
  if (error) {
    log.warn("customer-incidents: public probe row outage reset failed", {
      source: "customer-incidents",
      failureType: "public_probe_reset_failed",
      opsEventId: row.id,
      errorMessage: error.message,
    });
    return "error";
  }
  return (data?.length ?? 0) > 0 ? "reset" : "moved";
}

type ProbeRowStartRead =
  | { outcome: "open"; firstSeenAt: string | null }
  | { outcome: "archived" | "missing" | "error" };

/**
 * Read back the outage start a probe-row write just established. After a
 * down-signal report the stored row — not this scan's earlier snapshot —
 * is the truth: a racing archive turns the report's reopen into a fresh
 * first_seen_at (resetFirstSeenOnReopen pins the NEW outage's start in
 * the same write), so the observed start cannot be trusted to describe
 * the row's current outage. A row archived or gone at read-back time is
 * contested state; the caller treats it as unknown rather than page on
 * either version.
 */
async function readPublicProbeRowStart(
  db: DbClient,
  rowId: string,
): Promise<ProbeRowStartRead> {
  const { data, error } = await db
    .from("ops_events")
    .select("first_seen_at,archived_at")
    .eq("id", rowId)
    .maybeSingle();
  if (error) {
    log.warn("customer-incidents: public probe row outage start read-back failed", {
      source: "customer-incidents",
      failureType: "public_probe_start_read_failed",
      opsEventId: rowId,
      errorMessage: error.message,
    });
    return { outcome: "error" };
  }
  if (!data) return { outcome: "missing" };
  const row = data as { first_seen_at?: unknown; archived_at?: unknown };
  if (row.archived_at != null) return { outcome: "archived" };
  return {
    outcome: "open",
    firstSeenAt: typeof row.first_seen_at === "string" ? row.first_seen_at : null,
  };
}

export interface PublicProbeApplication {
  /** agentId → outage start (ms epoch) for probes currently failing. */
  outageStartedAtMs: Map<string, number>;
  /** Agents whose probe state could not be determined — never resolve them. */
  unknownAgentIds: Set<string>;
  /** Agents whose probe state is degraded this scan (feeds summary.degraded). */
  degradedAgentIds: Set<string>;
}

/**
 * Turn raw probe signals into probe-row writes and the post-scan outage
 * state evaluateCustomerIncidents consumes. A "down" signal on a box with
 * no open row is a NEW outage: reportOpsEvent inserts or un-archives, and
 * un-archiving keeps the OLD row's first_seen_at — so the scan pins
 * first_seen_at to this outage's start or a recurrence would look 10
 * minutes old instantly. An "up" signal archives the open row; a failed
 * archive leaves the outage standing for evaluation. On a box WITH an
 * observed open row the down-signal report may have REOPENED it after a
 * racing archive — the post-write row's first_seen_at, not the observed
 * snapshot, then decides the outage start. Subjects still queued when the
 * write deadline passes are left unprocessed — unknown, so their
 * incidents neither open nor resolve on a skipped write.
 */
async function applyPublicProbeSignals(
  db: DbClient,
  agents: HivraAgentSnapshot[],
  signals: Map<string, PublicProbeSignal>,
  openRowsByAgent: Map<string, OpenProbeRow>,
  deps: { report: typeof reportOpsEvent; now: number },
  budget: { deadlineAt: number; clock: () => number },
): Promise<PublicProbeApplication> {
  const result: PublicProbeApplication = {
    outageStartedAtMs: new Map(),
    unknownAgentIds: new Set(),
    degradedAgentIds: new Set(),
  };
  const nowIso = new Date(deps.now).toISOString();

  const applyToAgent = async (agent: HivraAgentSnapshot): Promise<void> => {
    const signal: PublicProbeSignal =
      signals.get(agent.id) ?? { kind: "skipped", reason: "budget" };
    const openRow = openRowsByAgent.get(agent.id) ?? null;

    if (signal.kind === "skipped") {
      result.unknownAgentIds.add(agent.id);
      // Only budget exhaustion is scan degradation; a box without a usable
      // public hostname is a standing data gap, not a failed read.
      if (signal.reason === "budget") result.degradedAgentIds.add(agent.id);
      return;
    }

    if (signal.kind === "up") {
      if (!openRow) return;
      const archive = await archivePublicProbeRow(db, openRow, nowIso);
      if (archive === "error") {
        // The probe just answered 200 but the archive write failed, so the
        // stored outage row is stale data — not evidence of a live outage.
        // Keeping it visible would let box_unreachable OPEN a new incident
        // for a box that provably answered publicly. Unknown instead: an
        // existing incident stays open for a later pass to retry the
        // archive, and nothing opens from a row we failed to update.
        result.degradedAgentIds.add(agent.id);
        result.unknownAgentIds.add(agent.id);
      } else if (archive === "moved") {
        // The row changed under this scan (a concurrent failure report or
        // archive landed between the read and the archive): its state is no
        // longer what we observed — re-evaluate next pass rather than
        // resolving on a stale snapshot.
        result.unknownAgentIds.add(agent.id);
      }
      // "archived" means no open outage remains.
      return;
    }

    // signal.kind === "down"
    const reported = await deps.report(publicProbeUnreachableOpsEvent(agent, signal));
    if (openRow) {
      // A failed refresh does not change the outage state, but it is
      // degraded.
      if (reported == null) result.degradedAgentIds.add(agent.id);
      // Whether the outage CONTINUED or was REOPENED decides its start —
      // and the observed snapshot cannot tell them apart. A racing scan's
      // healthy-probe archive between this scan's row read and the report
      // flips the report into a reopen, and resetFirstSeenOnReopen pins
      // first_seen_at to the NEW outage's start in that same write. Using
      // the observed start then backdates a brand-new outage by the
      // archived row's age and the evaluator pages it instantly. Read back
      // the start the write actually left: only a stored first_seen_at
      // confirms the outage the row now records. (The observed row is the
      // outage record — reportOpsEvent dedupes onto it by fingerprint
      // whenever it exists.)
      const stored = await readPublicProbeRowStart(db, openRow.id);
      const storedStartMs =
        stored.outcome === "open" ? parseTimeMs(stored.firstSeenAt) : null;
      if (stored.outcome !== "open" || storedStartMs == null) {
        // The outage start could not be confirmed: the read failed, the
        // row was archived or deleted under this scan, or it carries no
        // usable timestamp. Unknown — never page on an unverified age.
        result.unknownAgentIds.add(agent.id);
        if (stored.outcome === "error" || stored.outcome === "open") {
          result.degradedAgentIds.add(agent.id);
        }
        return;
      }
      // A stored outage start that predates the current runtime marker
      // (the same provisioned_at / sleep_tier_changed_at /
      // operation_started_at bound receipts are checked against) belongs
      // to the previous boot: the first failed probe after a wake or
      // reprovision must not inherit the pre-sleep outage start, or it
      // would page instantly. Pin the row's first_seen_at to now —
      // guarded on the read-back value — so this and later scans measure
      // THIS outage; failures continuing on the same runtime keep their
      // clock.
      const runtimeMarkerMs = agentRuntimeMarkerMs(agent);
      if (runtimeMarkerMs != null && storedStartMs < runtimeMarkerMs) {
        const reset = await resetPublicProbeRowFirstSeen(
          db,
          { ...openRow, firstSeenAt: stored.firstSeenAt },
          nowIso,
        );
        if (reset === "reset") {
          result.outageStartedAtMs.set(agent.id, deps.now);
        } else {
          // The row changed under this scan (or the write failed): its
          // outage start is no longer what we observed — re-evaluate next
          // pass.
          result.unknownAgentIds.add(agent.id);
          if (reset === "error") result.degradedAgentIds.add(agent.id);
        }
        return;
      }
      result.outageStartedAtMs.set(agent.id, storedStartMs);
      return;
    }

    if (reported?.id == null) {
      // The outage could not be recorded — its state is unknown, and an
      // open incident must not resolve on a guess.
      result.unknownAgentIds.add(agent.id);
      result.degradedAgentIds.add(agent.id);
      return;
    }

    // Fresh outage (insert, or un-archive of a previously closed row).
    // resetFirstSeenOnReopen pins first_seen_at to this outage's start inside
    // the same write that reopens the row, so the 10-minute rule measures
    // THIS outage, not the first one ever seen.
    result.outageStartedAtMs.set(agent.id, deps.now);
  };

  await runPool(agents, PUBLIC_PROBE_WRITE_CONCURRENCY, async (agent) => {
    // The probe deadline bounds network I/O but not this per-subject
    // decision/write phase; once the invocation approaches its limit the
    // remaining subjects stay unprocessed — unknown, never resolved on a
    // skipped write — and the scan still reaches the heartbeat.
    if (budget.clock() >= budget.deadlineAt) {
      result.unknownAgentIds.add(agent.id);
      result.degradedAgentIds.add(agent.id);
      return;
    }
    // The deadline also races work already started: a stalled report or
    // archive leaves the subject unprocessed (unknown + degraded, retried
    // next pass) instead of holding the invocation past the heartbeat
    // margin. Any write it still lands is version-guarded.
    const completed = await finishedBeforeDeadline(
      () => applyToAgent(agent),
      budget.deadlineAt,
      budget.clock,
    );
    if (!completed) {
      result.unknownAgentIds.add(agent.id);
      result.degradedAgentIds.add(agent.id);
      log.warn("customer-incidents: probe-row write exceeded the scan deadline", {
        source: "customer-incidents",
        failureType: "probe_row_write_deadline",
        instanceId: agent.id,
      });
    }
  });

  return result;
}

async function collectSubscriptions(
  db: DbClient,
  userIds: string[],
): Promise<Map<string, CustomerSubscriptionSnapshot>> {
  const map = new Map<string, CustomerSubscriptionSnapshot>();
  if (userIds.length === 0) return map;
  try {
    const rows = await selectAllPages<{ user_id: string; plan: string | null; status: string | null }>(
      "hermes_subscriptions",
      (cursor) => {
        // user_id is UNIQUE — the keyset cursor column.
        let query = db
          .from("hermes_subscriptions")
          .select("user_id,plan,status")
          .in("user_id", userIds)
          .order("user_id", { ascending: true });
        if (cursor != null) query = query.gt("user_id", cursor);
        return query.limit(SUBJECT_PAGE_SIZE);
      },
      (row) => row.user_id,
    );
    for (const row of rows) {
      map.set(row.user_id, { plan: row.plan, status: row.status });
    }
  } catch (err) {
    // Diagnosis enrichment only — never block incident detection on it.
    log.warn("customer-incidents: subscription lookup failed", {
      source: "customer-incidents",
      failureType: "subscription_lookup_failed",
      errorMessage: err instanceof Error ? err.message : String(err),
    });
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

// One scan can open many incidents at once; without a shared budget a slow box
// fleet could spend the whole maxDuration budget probing and never reach the
// resolve pass or the heartbeat. Remaining probes are recorded as skipped.
const SCAN_PROBE_BUDGET_MS = 90_000;
// The per-subject probe-row decision/write phase gets its own bound, measured
// from the end of the probe budget: probing plus writing stays inside
// maxDuration with room to resolve rows and write the heartbeat.
const SCAN_PROBE_WRITE_BUDGET_MS = 60_000;
// The incident report pass (new-incident diagnosis probes + ops-event
// writes, plus the still-open version refreshes) gets its own bound,
// chained after the probe-write budget: hundreds of findings reporting
// serially could otherwise consume the route's maxDuration before the
// resolve pass and the heartbeat write. Findings left unreported re-emit
// on the next scan — nothing is lost, the pass just records degradation.
const SCAN_REPORT_BUDGET_MS = 60_000;
// The resolve pass (per-row subject lookups, guarded archives and resolved
// notices) gets the last bound in the chain: 90+60+60+60 = 270s leaves a
// ~30s margin under the route's 300s maxDuration, reserved so the cron
// heartbeat write always fits — a scan that dies before it looks like a
// failed cron run rather than a long one. Rows the deadline skips stay
// open and are re-read next pass; running it at the usual concurrency
// keeps a large open-row set inside the bound.
const SCAN_RESOLVE_BUDGET_MS = 60_000;
const SCAN_RESOLVE_CONCURRENCY = 8;
// The cron's */5-minute schedule in vercel.json — the scan-tick bucket used
// to rotate the candidate order each pass.
const SCAN_INTERVAL_MS = 5 * 60 * 1000;

async function defaultProbe(url: string): Promise<{ status: number | null; latencyMs: number | null; error: string | null }> {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { "user-agent": "hivra-customer-incidents/1.0", accept: "*/*" },
    });
    // We only need the status — cancel the body instead of buffering it so a
    // large or slow response cannot stall the scan.
    await res.body?.cancel().catch(() => undefined);
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
  budget?: { deadlineAt: number; now?: () => number },
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
  const clock = budget?.now ?? Date.now;
  const results: PublicProbeResult[] = [];
  for (const target of targets) {
    if (budget && clock() >= budget.deadlineAt) {
      results.push({
        name: target.name,
        url: target.url,
        status: null,
        latencyMs: null,
        error: "skipped: scan budget",
      });
      continue;
    }
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
    created_at: heartbeat.createdAt,
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
 * on purpose — and also reports VERCEL_ENV=production, so the deployment
 * channel is the discriminator: page only when Vercel says production AND
 * the deployment is not Canary. Everywhere else the scan still writes the
 * incident ops events (the ops feed shows them) but with page:false, and
 * resolved notices are skipped.
 */
export function incidentPagingEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.VERCEL_ENV === "production" && !isCanaryDeployment(env);
}

export interface CustomerIncidentScanDeps {
  db?: DbClient | null;
  now?: () => number;
  /** Monotonic-ish clock for the scan-wide probe budget. Defaults to Date.now. */
  clock?: () => number;
  /** Total wall-clock budget for all public probes in one scan. */
  probeBudgetMs?: number;
  /**
   * Extra wall-clock budget (measured from the end of the probe budget) for
   * the per-subject probe-row write phase in one scan.
   */
  probeWriteBudgetMs?: number;
  /**
   * Extra wall-clock budget (measured from the end of the probe-write
   * budget) for the incident report pass: new-incident reports and
   * still-open version refreshes.
   */
  reportBudgetMs?: number;
  /**
   * Extra wall-clock budget (measured from the end of the report budget)
   * for the resolve pass: per-row subject lookups, guarded archives and
   * resolved notices. Sized so the chained phase budgets leave a reserved
   * margin under the route's maxDuration for the heartbeat write.
   */
  resolveBudgetMs?: number;
  /** Total wall-clock budget for the watchdog read loop in one scan. */
  watchdogBudgetMs?: number;
  report?: typeof reportOpsEvent;
  probe?: ProbeFn;
  adminUserIds?: ReadonlySet<string>;
  cronSchedules?: ReadonlyMap<string, CronScheduleInfo>;
  /** Page admins for new incidents + send resolved notices. Defaults to the production-deployment check. */
  pagingEnabled?: boolean;
  /** Archive the observed incident row; returns true when this call won the archive. */
  archiveIncident?: (row: OpenIncidentRow, options?: { closedReason?: string }) => Promise<boolean>;
  /** Send the one resolved notice through the admin transport. */
  notifyResolved?: (input: ResolvedNoticeInput) => Promise<void>;
}

export interface CustomerIncidentScanSummary {
  findings: number;
  opened: number;
  stillOpen: number;
  resolved: number;
  /** Open incidents archived without a resolved notice (aged out unresolved). */
  expired: number;
  unknown: number;
  /** Subject data we could not read — incidents for them are neither opened nor resolved this pass. */
  degraded: number;
  failed: number;
}

function emptySummary(): CustomerIncidentScanSummary {
  return { findings: 0, opened: 0, stillOpen: 0, resolved: 0, expired: 0, unknown: 0, degraded: 0, failed: 0 };
}

async function defaultArchiveIncident(
  db: DbClient,
  row: OpenIncidentRow,
  options?: { closedReason?: string },
): Promise<boolean> {
  const rowId = row.id;
  const update: Record<string, unknown> = {
    archived_at: new Date().toISOString(),
    archived_by_user_id: null,
  };
  if (options?.closedReason) {
    // Merge into the existing metadata so the archive records why it closed
    // silently. ops_events.metadata is write-once in practice, so a
    // read-modify-write here cannot lose concurrent fields.
    const { data: existing, error: readError } = await db
      .from("ops_events")
      .select("metadata")
      .eq("id", rowId)
      .maybeSingle();
    if (readError) throw new Error(readError.message || "archive incident metadata read failed");
    const prior = (existing as { metadata?: unknown } | null)?.metadata;
    update.metadata = {
      ...(prior && typeof prior === "object" && !Array.isArray(prior)
        ? (prior as Record<string, unknown>)
        : {}),
      closed_reason: options.closedReason,
    };
  }
  let query = db
    .from("ops_events")
    .update(update)
    .eq("id", rowId)
    .is("archived_at", null);
  // The scan closes the occurrence it OBSERVED, not whatever the row has
  // become since: a re-report bumps occurrence_count and last_seen_at, and an
  // archive that ignores the drift would resolve an incident that recurred
  // after the snapshot. Matching the observed values makes the update a
  // no-op in that case — the next pass re-evaluates the fresh occurrence.
  if (row.occurrenceCount != null) {
    query = query.eq("occurrence_count", row.occurrenceCount);
  }
  if (row.lastSeenAt != null) {
    query = query.eq("last_seen_at", row.lastSeenAt);
  }
  const { data, error } = await query.select("id");
  if (error) throw new Error(error.message || "archive incident failed");
  return (data?.length ?? 0) > 0;
}

type IncidentRowTouchOutcome = "touched" | "moved" | "error";

/**
 * Refresh the version fields a still-open incident's archive is guarded on
 * — WITHOUT re-paging (dedup semantics stay: an already-open row never
 * pages again). Race this closes: scan A reads the row, decides the
 * incident cleared, and pauses before its version-guarded archive; scan B
 * confirms the same incident still holds but writes nothing because the
 * row is already open. A's archive then still matches the untouched
 * occurrence_count/last_seen_at and closes a live incident — plus sends a
 * resolved notice. Stamping the row here makes A's stale archive a no-op;
 * the next pass re-evaluates and archives then if the condition truly
 * cleared. Guarded on the observed version so a row that already moved
 * under this scan is left alone — its fresher state defeats stale archives
 * on its own.
 */
async function touchOpenIncidentRow(
  db: DbClient,
  row: OpenIncidentRow,
  lastSeenAtIso: string,
): Promise<IncidentRowTouchOutcome> {
  let query = db
    .from("ops_events")
    .update({ last_seen_at: lastSeenAtIso })
    .eq("id", row.id)
    .is("archived_at", null);
  query =
    row.occurrenceCount == null
      ? query.is("occurrence_count", null)
      : query.eq("occurrence_count", row.occurrenceCount);
  query =
    row.lastSeenAt == null
      ? query.is("last_seen_at", null)
      : query.eq("last_seen_at", row.lastSeenAt);
  const { data, error } = await query.select("id");
  if (error) {
    log.warn("customer-incidents: still-open incident version refresh failed", {
      source: "customer-incidents",
      failureType: "incident_still_open_touch_failed",
      opsEventId: row.id,
      incidentKey: row.incidentKey,
      errorMessage: error.message,
    });
    return "error";
  }
  return (data?.length ?? 0) > 0 ? "touched" : "moved";
}

/**
 * Idempotency key for the resolved notice. The incident row id + the
 * resolution time make every archive TRANSITION unique: the same incident
 * row can recur (un-archived by reportOpsEvent) and resolve again, and the
 * second resolution must page admins just like the first.
 */
function resolvedNoticeFingerprint(row: OpenIncidentRow, resolvedAtMs: number): string {
  return createHash("sha256")
    .update(`incident-resolved:${row.id}:${resolvedAtMs}:${row.fingerprint}`)
    .digest("hex");
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

const LAUNCH_FAILED_SUBJECT_PREFIX = "launch_failed:";
const BOX_DOWN_SUBJECT_PREFIX = "box_down:";

type LaunchFailedExpiry = "resolved" | "expired" | "unknown";

/**
 * A launch_failed incident only fires while its subject is inside the rule's
 * 24h window, so an open row eventually stops producing a finding even though
 * the launch may still be failed. Before closing such a row, read the
 * subject's current state: "resolved" (launch succeeded or the owner deleted
 * it — worth a resolved notice) vs "expired" (still failed, archive silently)
 * vs "unknown" (could not read — leave the row open for the next pass).
 */
async function classifyLaunchFailedExpiry(
  db: DbClient,
  row: OpenIncidentRow,
): Promise<LaunchFailedExpiry> {
  const subjectId = row.incidentKey?.slice(LAUNCH_FAILED_SUBJECT_PREFIX.length);
  if (!subjectId) return "expired";
  const kind = row.subjectKind;

  if (kind === "hivra_agent" || kind == null) {
    const { data, error } = await db
      .from("hivra_agents")
      .select("id,status,provisioned_at")
      .eq("id", subjectId)
      .maybeSingle();
    if (error) {
      log.warn("customer-incidents: launch_failed subject lookup failed", {
        source: "customer-incidents",
        failureType: "launch_failed_subject_lookup_failed",
        opsEventId: row.id,
        subjectId,
        errorMessage: error.message,
      });
      return "unknown";
    }
    if (data) {
      const agent = data as { status?: string | null; provisioned_at?: string | null };
      return agent.provisioned_at != null ||
        agent.status === "running" ||
        agent.status === "deleted"
        ? "resolved"
        : "expired";
    }
    if (kind === "hivra_agent") return "expired";
  }

  if (kind === "hermes_instance" || kind == null) {
    const { data, error } = await db
      .from("hermes_instances")
      .select("id,status,lifecycle_state")
      .eq("id", subjectId)
      .maybeSingle();
    if (error) {
      log.warn("customer-incidents: launch_failed subject lookup failed", {
        source: "customer-incidents",
        failureType: "launch_failed_subject_lookup_failed",
        opsEventId: row.id,
        subjectId,
        errorMessage: error.message,
      });
      return "unknown";
    }
    if (data) {
      const instance = data as { status?: string | null; lifecycle_state?: string | null };
      const launched =
        instance.status === "running" ||
        instance.status === "deleted" ||
        instance.lifecycle_state === "active" ||
        instance.lifecycle_state === "stopped" ||
        instance.lifecycle_state === "paused" ||
        instance.lifecycle_state === "cold_archived" ||
        instance.lifecycle_state === "deleted";
      return launched ? "resolved" : "expired";
    }
  }

  // The subject row is gone entirely — nothing left to recover, close quietly.
  return "expired";
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
  const clock = deps.clock ?? Date.now;
  // Probe budget is measured from scan start so collection time counts against
  // it — the scan must finish inside maxDuration with room to resolve rows and
  // write the heartbeat.
  const probeDeadlineAt = clock() + (deps.probeBudgetMs ?? SCAN_PROBE_BUDGET_MS);
  // The probe-row write phase is bounded separately from network probing so
  // a large fleet of down signals cannot consume the resolve pass and the
  // heartbeat inside the same invocation.
  const probeWriteDeadlineAt =
    probeDeadlineAt + (deps.probeWriteBudgetMs ?? SCAN_PROBE_WRITE_BUDGET_MS);
  // The report pass is bounded too, chained after the probe-write window so
  // the phase budgets sum to a hard ceiling under the route's maxDuration:
  // a fleet of new findings can no longer starve the resolve pass and the
  // heartbeat write inside one invocation.
  const reportDeadlineAt =
    probeWriteDeadlineAt + (deps.reportBudgetMs ?? SCAN_REPORT_BUDGET_MS);
  // The resolve pass is the last bounded phase. Its deadline reserves the
  // remaining margin under maxDuration for the heartbeat write, so a scan
  // that spent its earlier budgets still reports its own completion
  // instead of dying as an apparent cron failure. Rows left unprocessed
  // stay open and are re-read next pass.
  const resolveDeadlineAt =
    reportDeadlineAt + (deps.resolveBudgetMs ?? SCAN_RESOLVE_BUDGET_MS);
  const watchdogDeadlineAt = clock() + (deps.watchdogBudgetMs ?? SCAN_WATCHDOG_READ_BUDGET_MS);
  const report = deps.report ?? reportOpsEvent;
  const probe = deps.probe ?? defaultProbe;
  const adminUserIds = normalizeAdminIdSet(deps.adminUserIds ?? configuredOpsAdminUserIds());
  const cronSchedules = deps.cronSchedules ?? VERCEL_CRONS;
  const pagingEnabled = deps.pagingEnabled ?? incidentPagingEnabled();
  const archiveIncident =
    deps.archiveIncident ??
    ((row: OpenIncidentRow, options?: { closedReason?: string }) =>
      db ? defaultArchiveIncident(db, row, options) : Promise.resolve(false));
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
        .filter((id): id is string => typeof id === "string" && id.length > 0 && !isAdminUser(id, adminUserIds)),
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
  // Every budget-bounded loop below consumes candidates head-first, so a
  // fixed order would starve the same tail boxes whenever a budget runs out
  // mid-scan — their incidents could then never open OR resolve. Rotate the
  // list by the scan-tick bucket so every box periodically lands inside the
  // window; subjects skipped on a given pass still stay "unknown".
  const scanTick = Math.floor(now / SCAN_INTERVAL_MS);
  const scanCandidates = rotateByScanTick(boxDownCandidates, scanTick);
  const {
    byAgent: watchdogEventsByAgent,
    latestSurfaceByAgent,
    unknownAgentIds,
  } = await collectWatchdogEvents(
    db,
    scanCandidates.map((agent) => agent.id),
    { deadlineAt: watchdogDeadlineAt, clock },
  );
  const boxDownCandidateIds = new Set(boxDownCandidates.map((agent) => agent.id));

  // ---- public reachability probes (box_unreachable signal) ------------------
  // Same candidate set as box_down: running + awake + non-admin. Probe rows
  // are the outage record; a failed probe-row read marks every candidate's
  // box_unreachable unknown rather than resolving incidents on missing data.
  const degradedAgentIds = new Set(unknownAgentIds);
  const publicOutageStartedAtMs = new Map<string, number>();
  const publicProbeUnknownAgentIds = new Set<string>();
  const openProbeRowsByAgent = new Map<string, OpenProbeRow>();
  let probeRowsReadable = false;
  try {
    for (const row of await collectOpenProbeRows(db)) {
      openProbeRowsByAgent.set(row.agentId, row);
    }
    probeRowsReadable = true;
  } catch (err) {
    log.warn("customer-incidents: public probe row read failed; box_unreachable unknown", {
      source: "customer-incidents",
      failureType: "public_probe_rows_read_failed",
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }

  if (probeRowsReadable) {
    const signals = await collectPublicProbeSignals(scanCandidates, probe, {
      deadlineAt: probeDeadlineAt,
      clock,
    });
    const applied = await applyPublicProbeSignals(
      db,
      scanCandidates,
      signals,
      openProbeRowsByAgent,
      { report, now },
      { deadlineAt: probeWriteDeadlineAt, clock },
    );
    for (const [agentId, startMs] of applied.outageStartedAtMs) {
      publicOutageStartedAtMs.set(agentId, startMs);
    }
    for (const agentId of applied.unknownAgentIds) publicProbeUnknownAgentIds.add(agentId);
    for (const agentId of applied.degradedAgentIds) degradedAgentIds.add(agentId);
  } else {
    for (const agent of boxDownCandidates) {
      publicProbeUnknownAgentIds.add(agent.id);
      degradedAgentIds.add(agent.id);
    }
  }

  // ---- evaluate ------------------------------------------------------------
  const evaluation = evaluateCustomerIncidents({
    now,
    adminUserIds,
    agents,
    watchdogEventsByAgent,
    latestSurfaceReceiptByAgent: latestSurfaceByAgent,
    watchdogUnknownAgentIds: unknownAgentIds,
    publicOutageStartedAtMs,
    publicProbeUnknownAgentIds,
    hermesInstances,
    heartbeats,
    cronSchedules,
  });
  summary.findings = evaluation.findings.length;
  summary.unknown = [...evaluation.unknownKeys].filter((key) =>
    openIncidentRows.some((row) => row.incidentKey === key),
  ).length;
  // Watchdog fetch failures and degraded probe reads mean we could not
  // evaluate those subjects — count them so the heartbeat records the pass
  // as degraded.
  summary.degraded = degradedAgentIds.size;

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
  // The pass is deadline-bounded like the probe-write phase AND ordered:
  // the evaluator emits findings in its fixed rule order, so a shared
  // head-first queue would let still-open refreshes and earlier findings
  // consume the whole budget every tick and starve the same tail — and a
  // NEW finding that never reports is a page that never fires. Brand-new
  // findings report first; still-open version refreshes share what is
  // left. Each class rotates by the scan-tick bucket so a class that alone
  // exceeds the budget walks its own tail across passes instead of
  // starving it permanently (a skipped refresh retries next scan — the
  // guarded archive it defends against is itself version-checked, so the
  // worst case is a transient re-page, not a lost incident). Findings not
  // processed this pass re-emit next scan; the skipped count is degraded.
  const nowIso = new Date(now).toISOString();
  const newFindings: IncidentFinding[] = [];
  const stillOpenTouches: Array<{ finding: IncidentFinding; row: OpenIncidentRow }> = [];
  for (const finding of evaluation.findings) {
    const openRow = openByKey.get(finding.key);
    if (openRow) stillOpenTouches.push({ finding, row: openRow });
    else newFindings.push(finding);
  }
  type ReportItem =
    | { kind: "new"; finding: IncidentFinding }
    | { kind: "touch"; finding: IncidentFinding; row: OpenIncidentRow };
  const reportOrder: ReportItem[] = [
    ...rotateByScanTick(newFindings, scanTick).map(
      (finding): ReportItem => ({ kind: "new", finding }),
    ),
    ...rotateByScanTick(stillOpenTouches, scanTick).map(
      (item): ReportItem => ({ kind: "touch", finding: item.finding, row: item.row }),
    ),
  ];
  const processReportItem = async (item: ReportItem): Promise<void> => {
    if (item.kind === "touch") {
      summary.stillOpen += 1;
      // The incident still holds and the row is already open — no re-page,
      // but the row's guarded version MUST move: a concurrent scan that
      // decided this incident cleared can otherwise archive a live incident
      // (and send a resolved notice) with the version it read. The guarded
      // refresh makes that stale archive a no-op. "moved" means the row
      // changed under this scan — already safe; "error" is degraded.
      const touch = await touchOpenIncidentRow(db, item.row, nowIso);
      if (touch === "error") summary.degraded += 1;
      return;
    }
    const finding = item.finding;
    let probes: PublicProbeResult[] = [];
    if (finding.agent) {
      try {
        probes = await probeAgentPublicSurface(finding.agent, probe, {
          deadlineAt: probeDeadlineAt,
          now: clock,
        });
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
      const reported = await report(incidentOpsEvent(finding, metadata, pagingEnabled));
      // Only a persisted row counts as opened — an insert that returned no id
      // (or null on lookup failure) means nothing was recorded.
      if (reported?.id) {
        summary.opened += 1;
      } else {
        summary.failed += 1;
        log.error(
          "customer-incidents: incident report returned no persisted id",
          new Error("reportOpsEvent returned no row id"),
          {
            source: "customer-incidents",
            failureType: "incident_report_unconfirmed",
            incidentKey: finding.key,
          },
        );
      }
    } catch (err) {
      summary.failed += 1;
      log.error("customer-incidents: incident report failed", err, {
        source: "customer-incidents",
        failureType: "incident_report_failed",
        incidentKey: finding.key,
      });
    }
  };
  for (let index = 0; index < reportOrder.length; index += 1) {
    if (clock() >= reportDeadlineAt) {
      summary.degraded += reportOrder.length - index;
      break;
    }
    const item = reportOrder[index];
    // The deadline also races the item's own work: a report or version
    // refresh that stalls past the budget counts this item and the whole
    // remaining queue as degraded — they re-emit next scan — rather than
    // pushing the invocation past the resolve pass and the heartbeat.
    const completed = await finishedBeforeDeadline(
      () => processReportItem(item),
      reportDeadlineAt,
      clock,
    );
    if (!completed) {
      summary.degraded += reportOrder.length - index;
      log.warn("customer-incidents: report work exceeded the scan deadline; remaining items deferred", {
        source: "customer-incidents",
        failureType: "report_pass_deadline",
        remaining: reportOrder.length - index,
      });
      break;
    }
  }

  // ---- resolve closed incidents ----------------------------------------------
  // Bounded like every other phase: the per-row lookups, archives and
  // resolved notices used to run serially to completion, so a large open
  // row set could push the invocation past maxDuration before the cron
  // heartbeat write — which then records as a failed run. Rows the resolve
  // deadline skips stay open and are re-read next pass (they are never
  // touched), and the set rotates by scan tick like the candidate order so
  // a chronic budget shortfall does not starve the same tail rows
  // forever. Each skipped row counts as degraded so the heartbeat does
  // not read clean on a pass the deadline cut short.
  const findingKeys = new Set(evaluation.findings.map((finding) => finding.key));
  const resolveRows = rotateByScanTick(
    openIncidentRows.filter(
      (row): row is OpenIncidentRow & { incidentKey: string } => row.incidentKey != null,
    ),
    scanTick,
  );
  const resolveOpenIncidentRow = async (
    row: OpenIncidentRow & { incidentKey: string },
  ): Promise<void> => {
    // A box_down whose newest surface receipt is over 24h old while the
    // box's public /healthz probe succeeded this scan is stale bookkeeping,
    // not a live outage — archive it silently like an aged-out launch. The
    // check runs BEFORE treating a present finding as still-open: the
    // evaluator suppresses stale-receipt findings on a healthy probe, but
    // if a stale finding is ever emitted the row must still not pin open.
    // A live failure keeps the incident open; an unknown probe leaves it
    // untouched via unknownKeys — it neither resolves nor re-reports.
    let staleBoxDown = false;
    if (row.incidentKey.startsWith(BOX_DOWN_SUBJECT_PREFIX)) {
      const agentId = row.incidentKey.slice(BOX_DOWN_SUBJECT_PREFIX.length);
      const receipt = latestSurfaceByAgent.get(agentId);
      const receiptMs = receipt
        ? parseTimeMs(receipt.eventAt) ?? parseTimeMs(receipt.firstSeenAt)
        : null;
      staleBoxDown =
        boxDownCandidateIds.has(agentId) &&
        !publicOutageStartedAtMs.has(agentId) &&
        !publicProbeUnknownAgentIds.has(agentId) &&
        receiptMs != null &&
        now - receiptMs > BOX_DOWN_STALE_RECEIPT_MS;
    }
    if (findingKeys.has(row.incidentKey) && !staleBoxDown) return;
    if (evaluation.unknownKeys.has(row.incidentKey)) return;
    // launch_failed rows age out of the rule's 24h subject window, so the rule
    // stops emitting a finding while the launch may still be failed. Read the
    // subject's current state: archive-with-notice only when it actually
    // launched or was deleted; archive silently when it aged out unresolved.
    let expiredUnresolved = false;
    if (row.incidentKey.startsWith(LAUNCH_FAILED_SUBJECT_PREFIX)) {
      let disposition: LaunchFailedExpiry;
      try {
        disposition = await classifyLaunchFailedExpiry(db, row);
      } catch (err) {
        summary.degraded += 1;
        log.warn("customer-incidents: launch_failed expiry check failed; leaving row open", {
          source: "customer-incidents",
          failureType: "launch_failed_expiry_check_failed",
          opsEventId: row.id,
          incidentKey: row.incidentKey,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      if (disposition === "unknown") {
        // The subject lookup failed — the row stays open for the next pass,
        // but the pass is degraded so the heartbeat does not read clean.
        summary.degraded += 1;
        return;
      }
      expiredUnresolved = disposition === "expired";
    }
    const silentClosedReason = expiredUnresolved
      ? "expired_unresolved"
      : staleBoxDown
        ? "stale_no_new_receipts"
        : null;
    let archived = false;
    try {
      archived = silentClosedReason
        ? await archiveIncident(row, { closedReason: silentClosedReason })
        : await archiveIncident(row);
    } catch (err) {
      summary.failed += 1;
      log.error("customer-incidents: incident archive failed", err, {
        source: "customer-incidents",
        failureType: "incident_archive_failed",
        opsEventId: row.id,
        incidentKey: row.incidentKey,
      });
      return;
    }
    if (!archived) return; // another invocation already resolved it
    if (silentClosedReason) {
      // Closed without a "resolved" notice: aged out still failed, or a stale
      // box_down record whose box is publicly healthy — nothing recovered.
      summary.expired += 1;
      return;
    }
    summary.resolved += 1;
    if (!pagingEnabled) return; // non-production: archive only, no admin mail
    try {
      await notifyResolved({
        fingerprint: resolvedNoticeFingerprint(row, now),
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
  };
  await runPool(resolveRows, SCAN_RESOLVE_CONCURRENCY, async (row) => {
    if (clock() >= resolveDeadlineAt) {
      summary.degraded += 1;
      return;
    }
    // The deadline races the row's work too, not just its admission: a
    // subject lookup, archive or resolved notice that stalls past the
    // budget leaves the row open for the next pass (any write it still
    // lands is version-guarded) instead of running the invocation past
    // the heartbeat margin.
    const completed = await finishedBeforeDeadline(
      () => resolveOpenIncidentRow(row),
      resolveDeadlineAt,
      clock,
    );
    if (!completed) {
      summary.degraded += 1;
      log.warn(
        "customer-incidents: resolve work exceeded the scan deadline; row left open",
        {
          source: "customer-incidents",
          failureType: "incident_resolve_deadline",
          opsEventId: row.id,
          incidentKey: row.incidentKey,
        },
      );
    }
  });

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
