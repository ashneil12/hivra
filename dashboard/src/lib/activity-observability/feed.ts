import "server-only";

import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";
import {
  ACTIVITY_SCHEMA_VERSION,
  type ActivityCapability,
  type ActivityEvent,
  type ActivityOutcome,
  type ActivitySeverity,
  type ActivitySnapshot,
  type ActivitySource,
} from "./types";

const STALE_MS = 15 * 60_000;
const FETCH_CAP = 1000;

export interface ActivityEventRow { id:string; agent_id:string|null; event:string; agent_type:string|null; detail:unknown; created_at:string }
export interface ActivitySessionRow { id:string; computer_id:string; transport:string; input_role:string; created_at:string }
export interface ActivityAgentRow { id:string; name:string; type:string; status:string; created_at:string }

interface Cursor { at: string; id: string }
function encodeCursor(event: ActivityEvent): string { return Buffer.from(JSON.stringify({ at:event.occurredAt,id:event.id }),"utf8").toString("base64url"); }
export function decodeActivityCursor(value: string | undefined): Cursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value,"base64url").toString("utf8"));
    return typeof parsed?.at === "string" && !Number.isNaN(Date.parse(parsed.at)) && typeof parsed?.id === "string" ? parsed : null;
  } catch { return null; }
}

const object = (value: unknown): Record<string,unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string,unknown> : null;
const text = (value: unknown, fallback = ""): string => typeof value === "string" && value.length <= 300 ? value : fallback;
const outcome = (value: unknown): ActivityOutcome => value === "success" || value === "failure" ? value : "unknown";
const severity = (value: unknown): ActivitySeverity => value === "warning" || value === "error" ? value : "info";

const lifecycleTitles: Record<string,string> = {
  launch_requested:"Launch requested", provisioned:"Computer provisioned", failed:"Computer action failed",
  resized:"Computer resized", stopped:"Computer stopped", started:"Computer started",
  restarted:"Computer restarted", deleted:"Computer deleted",
};

function normalizeEvent(row: ActivityEventRow, names: Map<string,string>): ActivityEvent | null {
  if (!row.id || !row.created_at) return null;
  const agentId=row.agent_id||`unattributed:${row.id}`;
  const detail = object(row.detail); const telemetry = object(detail?.telemetry);
  const isTrace = row.event === "otel_span" && detail?.source === "otlp_trace" && detail?.schemaVersion === 1;
  const isLog = row.event === "otel_log" && detail?.source === "otlp_log" && detail?.schemaVersion === 1;
  const eventOutcome = outcome(telemetry?.outcome);
  const eventSeverity = severity(telemetry?.severity);
  const agentName = text(detail?.agentName) || (row.agent_id?names.get(row.agent_id):undefined) || (row.agent_id?`${row.agent_type || "Hivra"} computer`:"Unattributed launch");
  if (isTrace || isLog) {
    const evidence = Array.isArray(telemetry?.evidence) ? telemetry.evidence.slice(0,5).flatMap((item) => {
      const r=object(item); const label=text(r?.label); const value=text(r?.value); return label && value ? [{label,value}] : [];
    }) : [];
    return { id:row.id, kind:isTrace?"trace_span":"tool_activity", title:text(telemetry?.title,isTrace?"Instrumented operation":"Agent activity"), occurredAt:row.created_at, agentId, agentName, ...(row.agent_id?{computerId:row.agent_id}:{}), runId:text(telemetry?.runId)||undefined, traceId:text(telemetry?.traceId)||undefined, spanId:text(telemetry?.spanId)||undefined, parentSpanId:text(telemetry?.parentSpanId)||undefined, source:{kind:isTrace?"otlp_trace":"otlp_log",label:isTrace?"OpenTelemetry trace":"OpenTelemetry agent log"}, outcome:eventOutcome, severity:eventSeverity, summary:text(telemetry?.summary,"Agent-reported telemetry observed."), evidence, needsAttention:eventOutcome==="failure"||eventSeverity==="error" };
  }
  const failed = row.event === "failed" || /fail|error/i.test(row.event);
  return { id:row.id, kind:"lifecycle", title:lifecycleTitles[row.event] || row.event.replaceAll("_"," "), occurredAt:row.created_at, agentId, agentName, ...(row.agent_id?{computerId:row.agent_id}:{}), source:{kind:"hivra_lifecycle",label:"Hivra lifecycle"}, outcome:failed?"failure":"unknown", severity:failed?"error":"info", summary:failed?"A lifecycle operation reported a failure.":"A computer lifecycle change was recorded.", evidence:row.agent_type?[{label:"Computer type",value:row.agent_type}]:[], needsAttention:failed };
}

function normalizeSession(row: ActivitySessionRow, names: Map<string,string>): ActivityEvent {
  return { id:`desktop:${row.id}`, kind:"desktop_session", title:row.input_role==="controller"?"Desktop control session":"Desktop viewing session", occurredAt:row.created_at, agentId:row.computer_id, agentName:names.get(row.computer_id)||"Computer", computerId:row.computer_id, source:{kind:"hivra_desktop",label:"Hivra desktop broker"}, outcome:"unknown", severity:"info", summary:"A remote desktop session was authorized.", evidence:[{label:"Transport",value:row.transport},{label:"Access",value:row.input_role}], needsAttention:false };
}

function latest(events: ActivityEvent[], kinds: ActivityEvent["kind"][]): string | undefined {
  return events.find((event)=>kinds.includes(event.kind))?.occurredAt;
}
function latestReceipt(rows:ActivityEventRow[],event:string,agentId?:string):string|undefined {
  return rows.flatMap(row=>{
    if(row.event!==event||(agentId&&row.agent_id!==agentId)) return [];
    const receivedAt=text(object(row.detail)?.receivedAt); return receivedAt&&!Number.isNaN(Date.parse(receivedAt))?[receivedAt]:[];
  }).sort().at(-1);
}
function telemetrySourceState(lastSeenAt: string|undefined, degraded:boolean, now:Date): ActivitySource["state"] {
  if (degraded) return "degraded"; if (!lastSeenAt) return "missing";
  return now.getTime()-new Date(lastSeenAt).getTime()>STALE_MS?"stale":"active";
}
function telemetryCapability(label:string,key:ActivityCapability["key"],lastSeenAt:string|undefined,now:Date):ActivityCapability {
  if (!lastSeenAt) return {key,label,state:"missing"};
  return {key,label,state:now.getTime()-new Date(lastSeenAt).getTime()>STALE_MS?"stale":"observed",lastSeenAt};
}

export function buildActivitySnapshot(input:{eventRows:ActivityEventRow[];sessionRows:ActivitySessionRow[];agentRows:ActivityAgentRow[];eventDegraded?:boolean;sessionDegraded?:boolean;agentDegraded?:boolean;inputTruncated?:boolean;limit:number;cursor?:Cursor|null;now?:Date}):ActivitySnapshot {
  const now=input.now??new Date(); const names=new Map(input.agentRows.map(a=>[a.id,a.name]));
  let events=[...input.eventRows.flatMap(r=>{const e=normalizeEvent(r,names);return e?[e]:[]}),...input.sessionRows.map(r=>normalizeSession(r,names))]
    .sort((a,b)=>b.occurredAt.localeCompare(a.occurredAt)||b.id.localeCompare(a.id));
  if(input.cursor) events=events.filter(e=>e.occurredAt<input.cursor!.at||(e.occurredAt===input.cursor!.at&&e.id<input.cursor!.id));
  const hasMore=events.length>input.limit; events=events.slice(0,input.limit);
  const allForCoverage=[...input.eventRows.flatMap(r=>{const e=normalizeEvent(r,names);return e?[e]:[]}),...input.sessionRows.map(r=>normalizeSession(r,names))].sort((a,b)=>b.occurredAt.localeCompare(a.occurredAt));
  const resources=input.agentRows.map(agent=>{
    const own=allForCoverage.filter(e=>e.agentId===agent.id); const trace=latestReceipt(input.eventRows,"otel_span",agent.id); const tools=latestReceipt(input.eventRows,"otel_log",agent.id); const lifecycle=latest(own,["lifecycle"]); const desktop=latest(own,["desktop_session"]);
    const observed=[trace,tools].filter(Boolean).sort().at(-1);
    const historical=(label:string,key:ActivityCapability["key"],seen:string|undefined):ActivityCapability=>seen?{key,label,state:"observed",lastSeenAt:seen}:{key,label,state:"missing"};
    return {id:agent.id,name:agent.name,capabilities:[historical("Lifecycle", "lifecycle",lifecycle),historical("Desktop sessions","desktop",desktop),telemetryCapability("Traces","traces",trace,now),telemetryCapability("Agent tools","tool_activity",tools,now)],...(observed?{lastSeenAt:observed}:{})};
  });
  const trace=latestReceipt(input.eventRows,"otel_span"); const tools=latestReceipt(input.eventRows,"otel_log"); const lifecycle=latest(allForCoverage,["lifecycle"]); const desktop=latest(allForCoverage,["desktop_session"]);
  const sources:ActivitySource[]=[
    {id:"hivra-lifecycle",label:"Hivra lifecycle",state:input.eventDegraded?"degraded":"active",detail:input.eventDegraded?"Lifecycle records could not be read.":lifecycle?`Available. Last event ${lifecycle}.`:"Available; no lifecycle records in this window."},
    {id:"hivra-desktop",label:"Desktop broker",state:input.sessionDegraded?"degraded":"active",detail:input.sessionDegraded?"Desktop records could not be read.":desktop?`Available. Last session ${desktop}.`:"Available; no desktop sessions in this window."},
    {id:"otlp-traces",label:"OpenTelemetry traces",state:telemetrySourceState(trace,!!input.eventDegraded,now),detail:input.eventDegraded?"Trace records could not be read.":trace?`Last received ${trace}; silence alone does not prove an outage.`:"No trace telemetry received in this window."},
    {id:"otlp-logs",label:"OpenTelemetry agent logs",state:telemetrySourceState(tools,!!input.eventDegraded,now),detail:input.eventDegraded?"Agent log records could not be read.":tools?`Last received ${tools}; silence alone does not prove an outage.`:"No agent tool telemetry received in this window."},
  ];
  return {schemaVersion:ACTIVITY_SCHEMA_VERSION,generatedAt:now.toISOString(),events,resources,sources,degraded:!!(input.eventDegraded||input.sessionDegraded||input.agentDegraded),truncated:hasMore||!!input.inputTruncated,...(hasMore&&events.length?{nextCursor:encodeCursor(events.at(-1)!)}:{})};
}

export async function getActivitySnapshot(userId:string,opts:{days:number;limit:number;cursor?:Cursor|null;now?:Date}):Promise<ActivitySnapshot>{
  if(!supabaseAdmin) throw new Error("activity database unavailable");
  const now=opts.now??new Date(); const since=new Date(now.getTime()-opts.days*86_400_000).toISOString();
  const [eventResult,sessionResult,agentResult]=await Promise.allSettled([
    supabaseAdmin.from("hivra_agent_events").select("id,agent_id,event,agent_type,detail,created_at").eq("user_id",userId).gte("created_at",since).order("created_at",{ascending:false}).order("id",{ascending:false}).limit(FETCH_CAP+1),
    supabaseAdmin.from("hivra_remote_desktop_sessions").select("id,computer_id,transport,input_role,created_at").eq("user_id",userId).gte("created_at",since).order("created_at",{ascending:false}).order("id",{ascending:false}).limit(FETCH_CAP+1),
    supabaseAdmin.from("hivra_agents").select("id,name,type,status,created_at").eq("user_id",userId).neq("status","deleted").order("created_at",{ascending:false}).limit(FETCH_CAP+1),
  ]);
  const lane=<T>(result:PromiseSettledResult<{data:T[]|null;error:{message?:string}|null}>):{rows:T[];degraded:boolean}=>result.status==="fulfilled"&&!result.value.error?{rows:result.value.data??[],degraded:false}:{rows:[],degraded:true};
  const e=lane<ActivityEventRow>(eventResult as never),s=lane<ActivitySessionRow>(sessionResult as never),a=lane<ActivityAgentRow>(agentResult as never);
  if(e.degraded||s.degraded||a.degraded) log.warn("activity feed lane degraded",{source:"activity-observability",userId,eventDegraded:e.degraded,sessionDegraded:s.degraded,agentDegraded:a.degraded});
  const inputTruncated=e.rows.length>FETCH_CAP||s.rows.length>FETCH_CAP||a.rows.length>FETCH_CAP;
  return buildActivitySnapshot({eventRows:e.rows.slice(0,FETCH_CAP),sessionRows:s.rows.slice(0,FETCH_CAP),agentRows:a.rows.slice(0,FETCH_CAP),eventDegraded:e.degraded,sessionDegraded:s.degraded,agentDegraded:a.degraded,inputTruncated,limit:opts.limit,cursor:opts.cursor,now});
}
