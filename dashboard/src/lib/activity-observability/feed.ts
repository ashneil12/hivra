import "server-only";

import { attachActivityLine } from "@/lib/agent-computers/attach-activity";
import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";
import { supportsNativeTracing } from "./collectors";
import {
  describeNativeRecord,
  isNativeProducer,
  isNativeRunRole,
  nativeCorrelationId,
  nativeDurationMs,
  nativeErrorType,
  nativeEvidence,
  nativeToolName,
  type NativeRecordFields,
} from "./otlp";
import {
  ACTIVITY_SCHEMA_VERSION,
  NATIVE_TRACING_AGENT_TYPES,
  type ActivityCapability,
  type ActivityEvent,
  type ActivityOutcome,
  type ActivitySeverity,
  type ActivitySnapshot,
  type ActivitySource,
  type NativeProducer,
} from "./types";

const STALE_MS = 15 * 60_000;
/** A freshly issued reporter gets this long to deliver its first heartbeat before it counts as missing. */
const FIRST_REPORT_GRACE_MS = 10 * 60_000;
/** Installer failure codes, as the collectors table constrains them. */
const INSTALL_REASON = /^[a-z_]{1,40}$/;
const FETCH_CAP = 1000;
const DESKTOP_ID_PREFIX = "desktop:";
const TELEMETRY_EVENTS = ["otel_span", "otel_log"];

export interface ActivityEventRow { id:string; agent_id:string|null; event:string; agent_type:string|null; detail:unknown; created_at:string }
export interface ActivitySessionRow { id:string; computer_id:string; transport:string; input_role:string; created_at:string }
export interface ActivityAgentRow { id:string; name:string; type:string; status:string; created_at:string; computer_substrate?:string|null }
/** One row per computer in hivra_activity_collectors (guest reporter state). */
export interface ActivityCollectorRow {
  agent_id:string; issued_at:string|null; credential_expires_at:string|null; last_heartbeat_at:string|null; last_event_at:string|null; last_rejected_at:string|null; last_rejected_reason:string|null;
  /** The launch installer's or start helper's last HIVRA_ACTIVITY_COLLECTOR result for this computer. */
  last_install_status?:string|null; last_install_reason?:string|null; last_install_at?:string|null;
}
/** Slim rows used only to find each computer's latest record of a kind, independent of the history page. */
export interface ActivityCoverageEventRow { agent_id:string|null; event:string; created_at:string; received_at?:string|null }
export interface ActivityCoverageSessionRow { computer_id:string; created_at:string }
export interface ActivityCoverageInput {
  lifecycleRows:ActivityCoverageEventRow[]; telemetryRows:ActivityCoverageEventRow[]; sessionRows:ActivityCoverageSessionRow[];
  lifecycleDegraded?:boolean; telemetryDegraded?:boolean; sessionDegraded?:boolean;
}

export interface ActivityCursor { at: string; id: string }
type Cursor = ActivityCursor;

const TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Canonical UTC sort key with nanosecond digits, so "…:00Z", "…:00.5+00:00"
 * and microsecond database values order as instants rather than as text.
 * Empty when unparseable.
 */
function timeKey(value: string): string {
  const match = TIMESTAMP.exec(value);
  if (match) {
    const whole = Date.parse(`${match[1]}${match[3]}`);
    if (!Number.isNaN(whole)) return `${new Date(whole).toISOString().slice(0, 19)}.${(match[2] ?? "").padEnd(9, "0")}`;
  }
  const ms = Date.parse(value); if (Number.isNaN(ms)) return "";
  const iso = new Date(ms).toISOString(); return `${iso.slice(0, 19)}.${iso.slice(20, 23)}000000`;
}
const laneRank = (id: string): number => id.startsWith(DESKTOP_ID_PREFIX) ? 0 : 1;
/**
 * History order, newest first: instant, then event rows before desktop rows at
 * the same instant, then id in code-unit order (which is uuid order in SQL).
 * historyCursorFilter expresses exactly this order per lane.
 */
function newestFirst(a: { occurredAt: string; id: string }, b: { occurredAt: string; id: string }): number {
  const at = timeKey(a.occurredAt), bt = timeKey(b.occurredAt);
  if (at !== bt) return at < bt ? 1 : -1;
  if (laneRank(a.id) !== laneRank(b.id)) return laneRank(b.id) - laneRank(a.id);
  return a.id === b.id ? 0 : a.id < b.id ? 1 : -1;
}

function encodeCursor(event: ActivityEvent): string { return Buffer.from(JSON.stringify({ at:event.occurredAt,id:event.id }),"utf8").toString("base64url"); }
/**
 * Cursor values reach a PostgREST filter string, so both are held to exact
 * shapes: a timestamp as the database returns it and a row uuid (optionally
 * desktop-prefixed). Anything else is refused.
 */
export function decodeActivityCursor(value: string | undefined): Cursor | null {
  if (!value || value.length > 512) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value,"base64url").toString("utf8"));
    const at: unknown = parsed?.at, id: unknown = parsed?.id;
    if (typeof at !== "string" || !TIMESTAMP.test(at) || !timeKey(at) || typeof id !== "string") return null;
    return UUID.test(id.startsWith(DESKTOP_ID_PREFIX) ? id.slice(DESKTOP_ID_PREFIX.length) : id) ? { at, id } : null;
  } catch { return null; }
}

export type HistoryCursorFilter = { op: "lt" | "lte"; at: string } | { op: "or"; filter: string };
/**
 * The SQL form of "strictly after the cursor" for one history lane, so older
 * history is reachable however many rows precede it. The lane that owns the
 * cursor row compares the (created_at, id) tuple; the other lane compares the
 * instant alone, because at an equal instant every event row sorts before
 * every desktop row.
 */
export function historyCursorFilter(cursor: Cursor | null | undefined, lane: "events" | "desktop"): HistoryCursorFilter | null {
  if (!cursor) return null;
  const desktopCursor = cursor.id.startsWith(DESKTOP_ID_PREFIX);
  if (lane === "events" && desktopCursor) return { op: "lt", at: cursor.at };
  if (lane === "desktop" && !desktopCursor) return { op: "lte", at: cursor.at };
  const id = desktopCursor ? cursor.id.slice(DESKTOP_ID_PREFIX.length) : cursor.id;
  return { op: "or", filter: `created_at.lt."${cursor.at}",and(created_at.eq."${cursor.at}",id.lt."${id}")` };
}

const object = (value: unknown): Record<string,unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string,unknown> : null;
const text = (value: unknown, fallback = ""): string => typeof value === "string" && value.length <= 300 ? value : fallback;
const outcome = (value: unknown): ActivityOutcome => value === "success" || value === "failure" ? value : "unknown";
const severity = (value: unknown): ActivitySeverity => value === "warning" || value === "error" ? value : "info";
const hexId = (value: unknown, length: 16 | 32): string | undefined => typeof value === "string" && (length === 16 ? /^[0-9a-f]{16}$/ : /^[0-9a-f]{32}$/).test(value) ? value : undefined;
/** The generic OTLP ingest charset for correlation ids. */
const genericId = (value: unknown): string | undefined => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,119}$/.test(value) ? value : undefined;
const validTime = (value: unknown): string | undefined => typeof value === "string" && timeKey(value) ? value : undefined;
const later = (a: string | undefined, b: string | undefined): string | undefined => !a ? b : !b ? a : timeKey(a) >= timeKey(b) ? a : b;
/** Strictly after `reference`, or true when there is no reference. Both are validTime values. */
const after = (value: string, reference: string | undefined): boolean => !reference || timeKey(value) > timeKey(reference);

const lifecycleTitles: Record<string,string> = {
  launch_requested:"Launch requested", provisioned:"Computer provisioned", failed:"Computer action failed",
  resized:"Computer resized", stopped:"Computer stopped", started:"Computer started",
  restarted:"Computer restarted", deleted:"Computer deleted",
};

/**
 * Native run fields re-validated on read against the same rules as ingest, so
 * an older or tampered row cannot inject text: titles, summaries and evidence
 * are rebuilt from the validated fields, never taken from the stored copy.
 */
function nativeFields(telemetry: Record<string,unknown>): { fields: NativeRecordFields; conversationId?: string } | null {
  const role = telemetry.role, producer = telemetry.producer;
  if (!isNativeRunRole(role) || !isNativeProducer(producer)) return null;
  return {
    fields: {
      role, producer: producer as NativeProducer, runId: nativeCorrelationId(telemetry.runId),
      toolName: role.startsWith("tool.") ? nativeToolName(telemetry.toolName) : undefined,
      durationMs: nativeDurationMs(telemetry.durationMs),
      errorType: role.endsWith(".failed") ? nativeErrorType(telemetry.errorType) : undefined,
      succeeded: role === "tool.completed" && telemetry.outcome === "success",
    },
    conversationId: nativeCorrelationId(telemetry.conversationId),
  };
}

function normalizeEvent(row: ActivityEventRow, names: Map<string,string>): ActivityEvent | null {
  if (!row.id || !row.created_at) return null;
  const agentId=row.agent_id||`unattributed:${row.id}`;
  const detail = object(row.detail); const telemetry = object(detail?.telemetry);
  const isTrace = row.event === "otel_span" && detail?.source === "otlp_trace" && detail?.schemaVersion === 1;
  const isLog = row.event === "otel_log" && detail?.source === "otlp_log" && detail?.schemaVersion === 1;
  const eventOutcome = outcome(telemetry?.outcome);
  const eventSeverity = severity(telemetry?.severity);
  const agentName = text(detail?.agentName) || (row.agent_id?names.get(row.agent_id):undefined) || (row.agent_id?`${row.agent_type || "Hivra"} computer`:"Unattributed launch");
  const ids = { traceId:hexId(telemetry?.traceId,32), spanId:hexId(telemetry?.spanId,16), parentSpanId:hexId(telemetry?.parentSpanId,16) };
  const definedIds = Object.fromEntries(Object.entries(ids).filter(([,value])=>value)) as Partial<typeof ids>;
  const native = isLog && telemetry ? nativeFields(telemetry) : null;
  if (native) {
    const { fields, conversationId } = native; const described = describeNativeRecord(fields);
    return {
      id:row.id, kind:"tool_activity", title:described.title, occurredAt:row.created_at, agentId, agentName, ...(row.agent_id?{computerId:row.agent_id}:{}),
      ...(fields.runId?{runId:fields.runId}:{}), ...definedIds,
      role:fields.role, producer:fields.producer,
      ...(fields.toolName?{toolName:fields.toolName}:{}), ...(fields.durationMs!==undefined?{durationMs:fields.durationMs}:{}),
      ...(conversationId?{conversationId}:{}), ...(fields.errorType?{errorType:fields.errorType}:{}),
      source:{kind:"otlp_log",label:"Agent run reporting"}, outcome:described.outcome, severity:described.severity, summary:described.summary,
      evidence:nativeEvidence(fields),
      // A failed task needs a look; a stopped task or a failed tool call is
      // routine (agents usually recover) and stays in History and the run.
      needsAttention:fields.role==="run.failed",
    };
  }
  if (isTrace || isLog) {
    const evidence = Array.isArray(telemetry?.evidence) ? telemetry.evidence.slice(0,5).flatMap((item) => {
      const r=object(item); const label=text(r?.label); const value=text(r?.value); return label && value ? [{label,value}] : [];
    }) : [];
    const runId = genericId(telemetry?.runId);
    return { id:row.id, kind:isTrace?"trace_span":"tool_activity", title:text(telemetry?.title,isTrace?"Instrumented operation":"Agent activity"), occurredAt:row.created_at, agentId, agentName, ...(row.agent_id?{computerId:row.agent_id}:{}), ...(runId?{runId}:{}), ...definedIds, source:{kind:isTrace?"otlp_trace":"otlp_log",label:isTrace?"OpenTelemetry trace":"OpenTelemetry agent log"}, outcome:eventOutcome, severity:eventSeverity, summary:text(telemetry?.summary,"Agent-reported telemetry observed."), evidence, needsAttention:eventOutcome==="failure"||eventSeverity==="error" };
  }
  const failed = row.event === "failed" || /fail|error/i.test(row.event);
  const attachTitle = attachActivityLine(row.event, object(row.detail));
  return { id:row.id, kind:"lifecycle", title:attachTitle || lifecycleTitles[row.event] || row.event.replaceAll("_"," "), occurredAt:row.created_at, agentId, agentName, ...(row.agent_id?{computerId:row.agent_id}:{}), source:{kind:"hivra_lifecycle",label:"Hivra lifecycle"}, outcome:failed?"failure":"unknown", severity:failed?"error":"info", summary:failed?"A lifecycle operation reported a failure.":"A computer lifecycle change was recorded.", evidence:row.agent_type?[{label:"Computer type",value:row.agent_type}]:[], needsAttention:failed };
}

function normalizeSession(row: ActivitySessionRow, names: Map<string,string>): ActivityEvent {
  return { id:`${DESKTOP_ID_PREFIX}${row.id}`, kind:"desktop_session", title:row.input_role==="controller"?"Desktop control session":"Desktop viewing session", occurredAt:row.created_at, agentId:row.computer_id, agentName:names.get(row.computer_id)||"Computer", computerId:row.computer_id, source:{kind:"hivra_desktop",label:"Hivra desktop broker"}, outcome:"unknown", severity:"info", summary:"A remote desktop session was authorized.", evidence:[{label:"Transport",value:row.transport},{label:"Access",value:row.input_role}], needsAttention:false };
}

/** Latest valid timestamp per key (and overall under "*"). */
function latestBy<T>(rows: T[], key: (row: T) => string | null | undefined, at: (row: T) => unknown): Map<string,string> {
  const out = new Map<string,string>();
  for (const row of rows) {
    const seen = validTime(at(row)); if (!seen) continue;
    for (const k of [key(row), "*"]) if (k) out.set(k, later(out.get(k), seen)!);
  }
  return out;
}

function telemetrySourceState(lastSeenAt: string|undefined, degraded:boolean, anyRunning:boolean, now:Date): ActivitySource["state"] {
  if (degraded) return "degraded"; if (!lastSeenAt) return "missing";
  return anyRunning&&now.getTime()-Date.parse(lastSeenAt)>STALE_MS?"stale":"active";
}
/** Silence from a computer that is not running is expected, so only a running computer can be stale. */
function telemetryCapability(label:string,key:ActivityCapability["key"],lastSeenAt:string|undefined,running:boolean,degraded:boolean,now:Date):ActivityCapability {
  if (degraded) return {key,label,state:"degraded",...(lastSeenAt?{lastSeenAt}:{})};
  if (!lastSeenAt) return {key,label,state:"missing"};
  return {key,label,state:running&&now.getTime()-Date.parse(lastSeenAt)>STALE_MS?"stale":"observed",lastSeenAt};
}

/**
 * Coverage state machine for the guest agent-run reporter; first match wins
 * (docs/superpowers/specs/2026-09-22-agent-run-tracing-contract.md).
 */
export function nativeTracingCapability(agent: ActivityAgentRow, row: ActivityCollectorRow | undefined, degraded: boolean, now: Date): ActivityCapability {
  const base = { key: "native_tracing" as const, label: "Agent run reporting" };
  if (degraded) return { ...base, state: "degraded" };
  if (!supportsNativeTracing(agent)) {
    // Claude Code and Codex are supported types, so for them the host type is the limit.
    return { ...base, state: "unsupported", reason: agent.type && NATIVE_TRACING_AGENT_TYPES.has(agent.type) ? "substrate" : "agent_type" };
  }
  const heartbeat = validTime(row?.last_heartbeat_at), expiresAt = validTime(row?.credential_expires_at), issuedAt = validTime(row?.issued_at);
  const seen = { ...(heartbeat ? { lastSeenAt: heartbeat } : {}), ...(expiresAt ? { expiresAt } : {}), ...(issuedAt ? { issuedAt } : {}) };
  if (agent.status !== "running") return { ...base, state: "not_running", ...seen };
  if (!row) return { ...base, state: "missing", reason: "not_set_up" };
  // The latest install attempt, at or after the latest issuance, failed and no
  // check-in has arrived since (a check-in proves a reporter is delivering).
  // This outranks expiry: the credential never reached a working reporter.
  const installAt = validTime(row.last_install_at);
  if (row.last_install_status === "failed" && installAt && (!issuedAt || timeKey(installAt) >= timeKey(issuedAt)) && after(installAt, heartbeat)) {
    const installFailureReason = typeof row.last_install_reason === "string" && INSTALL_REASON.test(row.last_install_reason) ? row.last_install_reason : undefined;
    return { ...base, state: "missing", reason: "install_failed", ...seen, installFailedAt: installAt, ...(installFailureReason ? { installFailureReason } : {}) };
  }
  // A credential that ran out is "expired" only if a reporter was using it;
  // one that never produced a check-in after its issuance is "never checked in".
  const checkedInSinceIssue = !!heartbeat && (!issuedAt || timeKey(heartbeat) >= timeKey(issuedAt));
  if (expiresAt && Date.parse(expiresAt) <= now.getTime()) {
    return checkedInSinceIssue || !issuedAt
      ? { ...base, state: "expired", reason: "credential_ran_out", ...seen }
      : { ...base, state: "missing", reason: "never_checked_in", ...seen };
  }
  // A refusal counts only when it is newer than both the last check-in and the
  // latest issuance: a re-issue supersedes an earlier refusal, while an expired
  // credential presented after it means the computer never picked the new one up.
  const rejectedAt = validTime(row.last_rejected_at);
  if (row.last_rejected_reason === "expired" && rejectedAt && after(rejectedAt, heartbeat) && after(rejectedAt, issuedAt)) {
    return { ...base, state: "expired", reason: "expired_credential_presented", ...seen };
  }
  const withinFirstReportGrace = !!issuedAt && now.getTime() - Date.parse(issuedAt) < FIRST_REPORT_GRACE_MS;
  if (!heartbeat) {
    if (!issuedAt) return { ...base, state: "missing", reason: "not_set_up", ...seen };
    return withinFirstReportGrace
      ? { ...base, state: "configured", ...seen }
      : { ...base, state: "missing", reason: "never_checked_in", ...seen };
  }
  const silent = now.getTime() - Date.parse(heartbeat) > STALE_MS;
  // Checking in while its run records are refused for a wrong clock is not
  // healthy reporting: show the gap until the refusals stop.
  if (!silent && row.last_rejected_reason === "clock_skew" && rejectedAt && now.getTime() - Date.parse(rejectedAt) <= STALE_MS) {
    return { ...base, state: "stale", reason: "clock_skew", ...seen };
  }
  // A start, restart or runtime update re-issues the credential and reinstalls
  // the reporter, so until the first check-in after that issuance is due the
  // computer is waiting for its first report, not stale. A renewal from a
  // healthy reporter keeps its recent check-in and stays observed.
  if (silent && withinFirstReportGrace && after(issuedAt!, heartbeat)) return { ...base, state: "configured", ...seen };
  return { ...base, state: silent ? "stale" : "observed", ...seen };
}

const PRODUCER_NAMES: Array<[string, string]> = [["claude-code", "Claude Code"], ["codex", "Codex"]];
function agentTracingSource(entries: Array<{ agent: ActivityAgentRow; native: ActivityCapability }>, degraded: boolean): ActivitySource {
  const base = { id: "agent-tracing" as const, label: "Agent run reporting" };
  if (degraded) return { ...base, state: "degraded", detail: "Agent run reporting status could not be read." };
  const supported = entries.filter(({ native }) => native.state !== "unsupported");
  if (!supported.length) {
    // Claude Code or Codex on another host type is not the same as having none.
    const otherHost = entries.some(({ native }) => native.reason === "substrate");
    return { ...base, state: "missing", detail: otherHost
      ? "Available for Claude Code and Codex computers on Hivra hosts; this account's Claude Code or Codex computers run on a host type that is not supported yet."
      : "Available for Claude Code and Codex computers on Hivra hosts; there are none in this account." };
  }
  const running = supported.filter(({ agent }) => agent.status === "running");
  if (!running.length) return { ...base, state: "missing", detail: "No Claude Code or Codex computer is running, so no reports are expected." };
  const count = (state: ActivityCapability["state"]) => running.filter(({ native }) => native.state === state).length;
  const producers = PRODUCER_NAMES.filter(([type]) => running.some(({ agent }) => agent.type === type)).map(([, name]) => name).join("/");
  const observed = count("observed"), stale = count("stale"), expired = count("expired"), waiting = count("configured");
  const installFailed = running.filter(({ native }) => native.state === "missing" && native.reason === "install_failed").length;
  const silent = count("missing") - installFailed;
  const detail = [
    `${observed} of ${running.length} running ${producers} computer${running.length === 1 ? "" : "s"} reporting.`,
    ...(stale ? [`${stale} stopped reporting.`] : []),
    ...(expired ? [`${expired} with an expired reporting credential.`] : []),
    ...(waiting ? [`${waiting} waiting for a first report.`] : []),
    ...(installFailed ? [`${installFailed} could not install the reporter.`] : []),
    ...(silent ? [`${silent} not reporting.`] : []),
  ].join(" ");
  return { ...base, state: stale || expired ? "stale" : observed ? "active" : "missing", detail };
}

export function buildActivitySnapshot(input:{
  eventRows:ActivityEventRow[]; sessionRows:ActivitySessionRow[]; agentRows:ActivityAgentRow[];
  collectorRows?:ActivityCollectorRow[];
  /** Per-kind latest-record lanes; derived from the history rows when omitted. */
  coverage?:ActivityCoverageInput;
  eventDegraded?:boolean; sessionDegraded?:boolean; agentDegraded?:boolean; collectorDegraded?:boolean;
  inputTruncated?:boolean; limit:number; cursor?:Cursor|null; now?:Date;
}):ActivitySnapshot {
  const now=input.now??new Date(); const names=new Map(input.agentRows.map(a=>[a.id,a.name]));
  let events=[...input.eventRows.flatMap(r=>{const e=normalizeEvent(r,names);return e?[e]:[]}),...input.sessionRows.map(r=>normalizeSession(r,names))].sort(newestFirst);
  if(input.cursor){const cursor={occurredAt:input.cursor.at,id:input.cursor.id}; events=events.filter(e=>newestFirst(cursor,e)<0);}
  const hasMore=events.length>input.limit; events=events.slice(0,input.limit);

  const coverage:ActivityCoverageInput=input.coverage??{
    lifecycleRows:input.eventRows.filter(r=>!TELEMETRY_EVENTS.includes(r.event)),
    telemetryRows:input.eventRows.filter(r=>TELEMETRY_EVENTS.includes(r.event)).map(r=>({agent_id:r.agent_id,event:r.event,created_at:r.created_at,received_at:text(object(r.detail)?.receivedAt)||null})),
    sessionRows:input.sessionRows,
  };
  const lifecycleDegraded=!!(input.eventDegraded||coverage.lifecycleDegraded), desktopDegraded=!!(input.sessionDegraded||coverage.sessionDegraded);
  const telemetryDegraded=!!(input.eventDegraded||coverage.telemetryDegraded), nativeDegraded=!!(input.collectorDegraded||input.agentDegraded);
  const lifecycle=latestBy(coverage.lifecycleRows,r=>r.agent_id,r=>r.created_at);
  const desktop=latestBy(coverage.sessionRows,r=>r.computer_id,r=>r.created_at);
  const traces=latestBy(coverage.telemetryRows.filter(r=>r.event==="otel_span"),r=>r.agent_id,r=>r.received_at);
  // Accepted native events advance the collector row, so a busy computer's
  // rows cannot hide another computer's latest report from this lane.
  const collectorRows=input.collectorRows??[];
  const tools=latestBy<{agent_id:string|null;at:unknown}>([
    ...coverage.telemetryRows.filter(r=>r.event==="otel_log").map(r=>({agent_id:r.agent_id,at:r.received_at})),
    ...collectorRows.map(r=>({agent_id:r.agent_id,at:r.last_event_at})),
  ],r=>r.agent_id,r=>r.at);
  const collectors=new Map(collectorRows.map(r=>[r.agent_id,r]));
  const anyRunning=input.agentRows.some(a=>a.status==="running");

  const entries=input.agentRows.map(agent=>({agent,native:nativeTracingCapability(agent,collectors.get(agent.id),nativeDegraded,now)}));
  const resources=entries.map(({agent,native})=>{
    const running=agent.status==="running"; const trace=traces.get(agent.id), tool=tools.get(agent.id);
    const historical=(label:string,key:ActivityCapability["key"],seen:string|undefined,degraded:boolean):ActivityCapability=>degraded?{key,label,state:"degraded",...(seen?{lastSeenAt:seen}:{})}:seen?{key,label,state:"observed",lastSeenAt:seen}:{key,label,state:"missing"};
    // "Last agent report" means agent telemetry only. The reporter's heartbeat
    // is liveness, shown as its own check-in; accepted native run records
    // already reach the tool lane through the collector's last_event_at.
    const observed=later(trace,tool);
    return {id:agent.id,name:agent.name,agentType:agent.type,status:agent.status,capabilities:[
      historical("Lifecycle","lifecycle",lifecycle.get(agent.id),lifecycleDegraded),
      historical("Desktop sessions","desktop",desktop.get(agent.id),desktopDegraded),
      telemetryCapability("Traces","traces",trace,running,telemetryDegraded,now),
      telemetryCapability("Agent tools","tool_activity",tool,running,telemetryDegraded,now),
      native,
    ],...(observed?{lastSeenAt:observed}:{})};
  });
  const lastLifecycle=lifecycle.get("*"), lastDesktop=desktop.get("*"), lastTrace=traces.get("*"), lastTool=tools.get("*");
  const sources:ActivitySource[]=[
    {id:"hivra-lifecycle",label:"Hivra lifecycle",state:lifecycleDegraded?"degraded":"active",detail:lifecycleDegraded?"Lifecycle records could not be read.":lastLifecycle?`Available. Last event ${lastLifecycle}.`:"Available; no lifecycle records in this window."},
    {id:"hivra-desktop",label:"Desktop broker",state:desktopDegraded?"degraded":"active",detail:desktopDegraded?"Desktop records could not be read.":lastDesktop?`Available. Last session ${lastDesktop}.`:"Available; no desktop sessions in this window."},
    {id:"otlp-traces",label:"OpenTelemetry traces",state:telemetrySourceState(lastTrace,telemetryDegraded,anyRunning,now),detail:telemetryDegraded?"Trace records could not be read.":lastTrace?`Last received ${lastTrace}; silence alone does not prove an outage.`:"No trace telemetry received in this window."},
    {id:"otlp-logs",label:"OpenTelemetry agent logs",state:telemetrySourceState(lastTool,telemetryDegraded,anyRunning,now),detail:telemetryDegraded?"Agent log records could not be read.":lastTool?`Last received ${lastTool}; silence alone does not prove an outage.`:"No agent tool telemetry received in this window."},
    agentTracingSource(entries,nativeDegraded),
  ];
  const degraded=!!(input.eventDegraded||input.sessionDegraded||input.agentDegraded||input.collectorDegraded||coverage.lifecycleDegraded||coverage.telemetryDegraded||coverage.sessionDegraded);
  return {schemaVersion:ACTIVITY_SCHEMA_VERSION,generatedAt:now.toISOString(),events,resources,sources,degraded,truncated:hasMore||!!input.inputTruncated,...(hasMore&&events.length?{nextCursor:encodeCursor(events.at(-1)!)}:{})};
}

type LaneResult<T>={rows:T[];degraded:boolean};
const lane=<T>(result:PromiseSettledResult<{data:unknown;error:{message?:string}|null}>):LaneResult<T>=>result.status==="fulfilled"&&!result.value.error?{rows:(result.value.data as T[]|null)??[],degraded:false}:{rows:[],degraded:true};

export async function getActivitySnapshot(userId:string,opts:{days:number;limit:number;cursor?:Cursor|null;now?:Date}):Promise<ActivitySnapshot>{
  if(!supabaseAdmin) throw new Error("activity database unavailable");
  const db=supabaseAdmin;
  const now=opts.now??new Date(); const since=new Date(now.getTime()-opts.days*86_400_000).toISOString();
  // History lanes are paged in SQL, one row past the page to detect more.
  const page=opts.limit+1;
  let events=db.from("hivra_agent_events").select("id,agent_id,event,agent_type,detail,created_at").eq("user_id",userId).gte("created_at",since);
  const eventCursor=historyCursorFilter(opts.cursor,"events");
  if(eventCursor) events=eventCursor.op==="or"?events.or(eventCursor.filter):eventCursor.op==="lt"?events.lt("created_at",eventCursor.at):events.lte("created_at",eventCursor.at);
  let sessions=db.from("hivra_remote_desktop_sessions").select("id,computer_id,transport,input_role,created_at").eq("user_id",userId).gte("created_at",since);
  const sessionCursor=historyCursorFilter(opts.cursor,"desktop");
  if(sessionCursor) sessions=sessionCursor.op==="or"?sessions.or(sessionCursor.filter):sessionCursor.op==="lt"?sessions.lt("created_at",sessionCursor.at):sessions.lte("created_at",sessionCursor.at);
  const results=await Promise.allSettled([
    events.order("created_at",{ascending:false}).order("id",{ascending:false}).limit(page),
    sessions.order("created_at",{ascending:false}).order("id",{ascending:false}).limit(page),
    db.from("hivra_agents").select("id,name,type,status,computer_substrate,created_at").eq("user_id",userId).neq("status","deleted").order("created_at",{ascending:false}).limit(FETCH_CAP+1),
    db.from("hivra_activity_collectors").select("agent_id,issued_at,credential_expires_at,last_heartbeat_at,last_event_at,last_rejected_at,last_rejected_reason,last_install_status,last_install_reason,last_install_at").eq("user_id",userId).limit(FETCH_CAP+1),
    // Coverage lanes: slim, per kind, and never cursor-bound, so busy agent
    // telemetry cannot crowd lifecycle or desktop history out of coverage.
    db.from("hivra_agent_events").select("agent_id,event,created_at").eq("user_id",userId).gte("created_at",since).not("event","in",`(${TELEMETRY_EVENTS.join(",")})`).order("created_at",{ascending:false}).limit(FETCH_CAP),
    db.from("hivra_agent_events").select("agent_id,event,created_at,received_at:detail->>receivedAt").eq("user_id",userId).gte("created_at",since).in("event",TELEMETRY_EVENTS).order("created_at",{ascending:false}).limit(FETCH_CAP),
    db.from("hivra_remote_desktop_sessions").select("computer_id,created_at").eq("user_id",userId).gte("created_at",since).order("created_at",{ascending:false}).limit(FETCH_CAP),
  ]);
  const [e,s,a,c,lc,tc,sc]=[lane<ActivityEventRow>(results[0]),lane<ActivitySessionRow>(results[1]),lane<ActivityAgentRow>(results[2]),lane<ActivityCollectorRow>(results[3]),lane<ActivityCoverageEventRow>(results[4]),lane<ActivityCoverageEventRow>(results[5]),lane<ActivityCoverageSessionRow>(results[6])];
  if([e,s,a,c,lc,tc,sc].some(l=>l.degraded)) log.warn("activity feed lane degraded",{source:"activity-observability",userId,eventDegraded:e.degraded,sessionDegraded:s.degraded,agentDegraded:a.degraded,collectorDegraded:c.degraded,lifecycleCoverageDegraded:lc.degraded,telemetryCoverageDegraded:tc.degraded,sessionCoverageDegraded:sc.degraded});
  return buildActivitySnapshot({
    eventRows:e.rows,sessionRows:s.rows,agentRows:a.rows.slice(0,FETCH_CAP),collectorRows:c.rows,
    coverage:{lifecycleRows:lc.rows,telemetryRows:tc.rows,sessionRows:sc.rows,lifecycleDegraded:lc.degraded,telemetryDegraded:tc.degraded,sessionDegraded:sc.degraded},
    eventDegraded:e.degraded,sessionDegraded:s.degraded,agentDegraded:a.degraded,collectorDegraded:c.degraded,
    inputTruncated:a.rows.length>FETCH_CAP,limit:opts.limit,cursor:opts.cursor,now,
  });
}
