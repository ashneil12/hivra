import crypto from "node:crypto";

import {
  NATIVE_PRODUCERS,
  NATIVE_RUN_ROLES,
  type ActivityEvidence,
  type ActivityOutcome,
  type ActivitySeverity,
  type NativeProducer,
  type NativeRunRole,
} from "./types";

const MAX_ITEMS = 500;
const MAX_ATTRIBUTES = 64;
const SAFE_ATTRIBUTE_KEYS = new Set([
  "service.name", "service.namespace", "deployment.environment.name",
  "gen_ai.operation.name", "gen_ai.system", "gen_ai.request.model", "gen_ai.response.model",
  "tool.name", "tool_name", "tool", "success", "session.id", "duration_ms", "error.type",
  "rpc.system", "http.request.method", "event.id",
]);
const BLOCKED_KEY = /(prompt|command|content|body|message|query|input|output|argument|response|completion|system_prompt)/i;

// Native agent-run records (docs/superpowers/specs/2026-09-22-agent-run-tracing-contract.md).
// They are recognised only by resource/record attribute service.namespace and
// validated field by field against the contract; the generic allowlist above
// never applies to them.
export const NATIVE_NAMESPACE = "hivra.native";
export const NATIVE_HEARTBEAT_EVENT = "collector.heartbeat";
const NATIVE_HEARTBEAT_SERVICE = "hivra-agent-trace";
export const NATIVE_MAX_DURATION_MS = 604_800_000;
export const NATIVE_TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/;
export const NATIVE_CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,119}$/;
export const NATIVE_ERROR_TYPE = /^[a-z0-9_]{1,40}$/;
const NATIVE_EVENT_ID = /^[a-f0-9]{32}$/;
const NATIVE_SPAN_ID = /^[a-f0-9]{16}$/;
const NATIVE_KEYS = new Set([
  "service.namespace", "service.name", "event.name", "event.id", "conversation.id", "session.id",
  "tool.name", "success", "duration_ms", "error.type", "parent.span.id",
]);
const PRODUCER_LABELS: Record<NativeProducer, string> = { codex: "Codex", "claude-code": "Claude Code" };

export interface NormalizedTelemetryEvent {
  id: string;
  resourceId: string;
  sourceKind: "otlp_trace" | "otlp_log";
  event: "otel_span" | "otel_log";
  occurredAt: string;
  title: string;
  summary: string;
  outcome: ActivityOutcome;
  severity: ActivitySeverity;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  runId?: string;
  evidence: Array<{ label: string; value: string }>;
  safeAttributes: Record<string, string | number | boolean>;
  /** Native run records only; every field is contract-validated. */
  role?: NativeRunRole;
  producer?: NativeProducer;
  toolName?: string;
  durationMs?: number;
  conversationId?: string;
  errorType?: string;
}
/** A reporter liveness signal. Never stored as an activity event; ingest records server receive time. */
export interface NativeHeartbeat { occurredAt: string }
export interface OtlpNormalization { events: NormalizedTelemetryEvent[]; heartbeats: NativeHeartbeat[]; rejectedSpans: number; rejectedLogRecords: number }

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null => v && typeof v === "object" && !Array.isArray(v) ? v as Rec : null;
const arr = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const str = (v: unknown, max = 200): string | undefined => typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined;
const hex = (v: unknown, len: number): string | undefined => typeof v === "string" && new RegExp(`^[a-fA-F0-9]{${len}}$`).test(v) ? v.toLowerCase() : undefined;

/** Credential-shaped identifiers are dropped even when their charset is allowed. */
export function looksSecret(candidate: string): boolean {
  return /^(?:sk-|gh[opsu]_|github_pat_|xox[baprs]-|AKIA|ASIA|eyJ[A-Za-z0-9_-]*\.)/i.test(candidate)||/bearer/i.test(candidate);
}

function anyValue(key: string, value: unknown): string | number | boolean | undefined {
  const r = rec(value);
  if (!r) return undefined;
  if (typeof r.stringValue === "string") {
    const candidate=r.stringValue;
    // Attribute keys are allowlisted and values are token-shaped. Free-form
    // strings (commands, prompts, headers and tool bodies) never reach storage.
    const secretLike=looksSecret(candidate);
    return !secretLike && candidate.length <= 120 && /^[A-Za-z0-9][A-Za-z0-9_.:/@-]*$/.test(candidate) ? candidate : undefined;
  }
  if (typeof r.boolValue === "boolean") return r.boolValue;
  if (typeof r.intValue === "number" || typeof r.intValue === "string") {
    const n = Number(r.intValue); return Number.isSafeInteger(n) ? n : undefined;
  }
  if (typeof r.doubleValue === "number" && Number.isFinite(r.doubleValue)) return r.doubleValue;
  return undefined;
}

function attributes(value: unknown): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const entry of arr(value).slice(0, MAX_ATTRIBUTES)) {
    const item = rec(entry); const key = str(item?.key, 120);
    if (!key || BLOCKED_KEY.test(key) || !SAFE_ATTRIBUTE_KEYS.has(key)) continue;
    const parsed = anyValue(key, item?.value);
    if (parsed !== undefined) out[key] = parsed;
  }
  return out;
}

function nanoToIso(value: unknown): string | null {
  try {
    const ns = BigInt(typeof value === "number" ? Math.trunc(value) : String(value));
    if (ns <= 0n) return null;
    const ms = Number(ns / 1_000_000n);
    const d = new Date(ms);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  } catch { return null; }
}

function deterministicId(parts: string[]): string {
  const h = crypto.createHash("sha256").update(parts.join("\0"), "utf8").digest("hex").slice(0, 32).split("");
  h[12] = "5"; h[16] = ((parseInt(h[16], 16) & 3) | 8).toString(16);
  return `${h.slice(0,8).join("")}-${h.slice(8,12).join("")}-${h.slice(12,16).join("")}-${h.slice(16,20).join("")}-${h.slice(20).join("")}`;
}
function canonical(value:unknown):string {
  if(value===null||typeof value!=="object") return JSON.stringify(value)??"undefined";
  if(Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Rec).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}
function privateFingerprint(value:unknown):string { return crypto.createHash("sha256").update(canonical(value),"utf8").digest("hex"); }

function evidence(a: Record<string, string | number | boolean>): Array<{label:string;value:string}> {
  const labels: Record<string,string> = { "service.name":"Service", "gen_ai.system":"Provider", "gen_ai.request.model":"Model", "gen_ai.response.model":"Model", "tool.name":"Tool", tool_name:"Tool", tool:"Tool", "session.id":"Session", duration_ms:"Duration (ms)", "error.type":"Error type" };
  return Object.entries(a).filter(([k]) => labels[k]).slice(0, 5).map(([k,v]) => ({ label: labels[k], value: String(v) }));
}

function spanOutcome(status: Rec | null): ActivityOutcome {
  const code = status?.code;
  return code === 2 || code === "STATUS_CODE_ERROR" ? "failure" : code === 1 || code === "STATUS_CODE_OK" ? "success" : "unknown";
}

function logSeverity(record: Rec): ActivitySeverity {
  const n = Number(record.severityNumber ?? 0);
  const text = String(record.severityText ?? "").toUpperCase();
  return n >= 17 || /ERROR|FATAL/.test(text) ? "error" : n >= 13 || /WARN/.test(text) ? "warning" : "info";
}

type NativeRaw = Map<string, string | number | boolean>;

/** Contract keys only, raw typed values, record attributes overriding resource attributes. */
function nativeRaw(...lists: unknown[]): NativeRaw {
  const out: NativeRaw = new Map();
  for (const list of lists) {
    for (const entry of arr(list).slice(0, MAX_ATTRIBUTES)) {
      const item = rec(entry); const key = str(item?.key, 120); const value = rec(item?.value);
      if (!key || !NATIVE_KEYS.has(key) || !value) continue;
      if (typeof value.stringValue === "string" && value.stringValue.length <= 200) out.set(key, value.stringValue);
      else if (typeof value.boolValue === "boolean") out.set(key, value.boolValue);
      else if (typeof value.intValue === "number" || (typeof value.intValue === "string" && /^-?\d{1,16}$/.test(value.intValue))) {
        const n = Number(value.intValue); if (Number.isSafeInteger(n)) out.set(key, n);
      } else out.delete(key);
    }
  }
  return out;
}

const matches = (value: unknown, pattern: RegExp): string | undefined =>
  typeof value === "string" && pattern.test(value) && !looksSecret(value) ? value : undefined;
export const isNativeRunRole = (value: unknown): value is NativeRunRole =>
  typeof value === "string" && (NATIVE_RUN_ROLES as readonly string[]).includes(value);
export const isNativeProducer = (value: unknown): value is NativeProducer =>
  typeof value === "string" && (NATIVE_PRODUCERS as readonly string[]).includes(value);
export const nativeToolName = (value: unknown): string | undefined => matches(value, NATIVE_TOOL_NAME);
export const nativeCorrelationId = (value: unknown): string | undefined => matches(value, NATIVE_CORRELATION_ID);
export const nativeErrorType = (value: unknown): string | undefined => matches(value, NATIVE_ERROR_TYPE);
export const nativeSpanId = (value: unknown): string | undefined => typeof value === "string" && NATIVE_SPAN_ID.test(value) ? value : undefined;
export const nativeDurationMs = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= NATIVE_MAX_DURATION_MS ? value : undefined;

/** "850 ms", "2.0 s", "1 min 5 s", "2 h 3 min". */
export function formatNativeDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(Math.floor(ms / 100) / 10).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} min ${Math.floor((ms % 60_000) / 1000)} s`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export interface NativeRecordFields {
  role: NativeRunRole;
  producer: NativeProducer;
  runId?: string;
  toolName?: string;
  durationMs?: number;
  errorType?: string;
  /** tool.completed only: the producer recorded a structured success. */
  succeeded?: boolean;
}

/**
 * Plain-English text for a native record, derived only from validated
 * fields. The feed calls this again on read, so stored text is never trusted.
 */
export function describeNativeRecord(fields: NativeRecordFields): { title: string; summary: string; outcome: ActivityOutcome; severity: ActivitySeverity } {
  const agent = PRODUCER_LABELS[fields.producer];
  const tool = fields.toolName ? `Tool ${fields.toolName}` : "A tool";
  const took = fields.durationMs === undefined ? "" : formatNativeDuration(fields.durationMs);
  switch (fields.role) {
    case "run.started":
      return { title: `${agent} started a task`, summary: "Hivra does not record what was asked.", outcome: "unknown", severity: "info" };
    case "run.completed":
      return { title: took ? `${agent} finished a task in ${took}` : `${agent} finished a task`, summary: "The agent reported the task ended normally; this does not check the work.", outcome: "success", severity: "info" };
    case "run.failed":
      return { title: `${agent} task ended with a failure`, summary: "The agent reported the task stopped before finishing.", outcome: "failure", severity: "error" };
    case "run.stopped":
      return { title: `${agent} task was stopped`, summary: "The agent reported the task was interrupted or replaced before it finished, so its outcome is unknown.", outcome: "unknown", severity: "info" };
    case "tool.started":
      return { title: `${tool} started`, summary: "Its input is not recorded.", outcome: "unknown", severity: "info" };
    case "tool.completed":
      return { title: took ? `${tool} finished in ${took}` : `${tool} finished`, summary: fields.succeeded ? "The agent reported it succeeded." : "The agent did not report whether it succeeded.", outcome: fields.succeeded ? "success" : "unknown", severity: "info" };
    case "tool.failed":
      return { title: took ? `${tool} failed after ${took}` : `${tool} failed`, summary: "Agents often recover from tool errors.", outcome: "failure", severity: "warning" };
  }
}

export function nativeEvidence(fields: NativeRecordFields): ActivityEvidence[] {
  return [
    { label: "Agent", value: PRODUCER_LABELS[fields.producer] },
    ...(fields.toolName ? [{ label: "Tool", value: fields.toolName }] : []),
    ...(fields.durationMs !== undefined ? [{ label: "Duration (ms)", value: String(fields.durationMs) }] : []),
    ...(fields.errorType ? [{ label: "Error type", value: fields.errorType }] : []),
    ...(fields.runId ? [{ label: "Run", value: fields.runId }] : []),
  ];
}

type NativeResult = { kind: "event"; event: NormalizedTelemetryEvent } | { kind: "heartbeat" } | { kind: "rejected" };

function normalizeNativeLog(raw: NativeRaw, record: Rec, resourceId: string, occurredAt: string): NativeResult {
  const role = raw.get("event.name");
  const service = raw.get("service.name");
  if (role === NATIVE_HEARTBEAT_EVENT) return service === NATIVE_HEARTBEAT_SERVICE ? { kind: "heartbeat" } : { kind: "rejected" };
  if (!isNativeRunRole(role) || !isNativeProducer(service)) return { kind: "rejected" };
  const eventId = raw.get("event.id");
  const runId = nativeCorrelationId(raw.get("session.id"));
  if (typeof eventId !== "string" || !NATIVE_EVENT_ID.test(eventId) || !runId) return { kind: "rejected" };
  const isTool = role.startsWith("tool.");
  const fields: NativeRecordFields = {
    role, producer: service, runId,
    toolName: isTool ? nativeToolName(raw.get("tool.name")) : undefined,
    durationMs: nativeDurationMs(raw.get("duration_ms")),
    errorType: role.endsWith(".failed") ? nativeErrorType(raw.get("error.type")) : undefined,
    succeeded: role === "tool.completed" && raw.get("success") === true,
  };
  const conversationId = nativeCorrelationId(raw.get("conversation.id"));
  const text = describeNativeRecord(fields);
  const safeAttributes: Record<string, string | number | boolean> = {
    "service.namespace": NATIVE_NAMESPACE, "service.name": service, "event.name": role, "event.id": eventId, "session.id": runId,
    ...(conversationId ? { "conversation.id": conversationId } : {}),
    ...(fields.toolName ? { "tool.name": fields.toolName } : {}),
    ...(fields.durationMs !== undefined ? { duration_ms: fields.durationMs } : {}),
    ...(fields.errorType ? { "error.type": fields.errorType } : {}),
    ...(role === "tool.completed" && typeof raw.get("success") === "boolean" ? { success: raw.get("success") as boolean } : {}),
  };
  return { kind: "event", event: {
    // Keyed on the reporter's stable event id only, so replays after a crash or
    // restart land on the same row whatever their timestamp or batch.
    id: deterministicId([resourceId, "native", eventId]), resourceId, sourceKind: "otlp_log", event: "otel_log", occurredAt,
    ...text, traceId: hex(record.traceId, 32), spanId: hex(record.spanId, 16), parentSpanId: nativeSpanId(raw.get("parent.span.id")),
    runId, evidence: nativeEvidence(fields), safeAttributes,
    role, producer: service, toolName: fields.toolName, durationMs: fields.durationMs, conversationId, errorType: fields.errorType,
  } };
}

export function normalizeOtlpJson(body: unknown, resourceId: string, now = new Date()): OtlpNormalization | null {
  const root = rec(body); if (!root) return null;
  const hasSpans = Array.isArray(root.resourceSpans);
  const hasLogs = Array.isArray(root.resourceLogs);
  if (!hasSpans && !hasLogs) return null;
  const out: NormalizedTelemetryEvent[] = []; const heartbeats: NativeHeartbeat[] = []; let rejectedSpans=0; let rejectedLogRecords=0;
  const timestampAllowed=(iso:string)=>{const ms=new Date(iso).getTime(); return ms<=now.getTime()+5*60_000&&ms>=now.getTime()-90*86_400_000;};

  for (const resourceSpanValue of arr(root.resourceSpans)) {
    const resourceSpan = rec(resourceSpanValue); if (!resourceSpan) continue;
    const resourceAttrs = attributes(rec(resourceSpan.resource)?.attributes);
    for (const scopeValue of arr(resourceSpan.scopeSpans)) {
      const scope = rec(scopeValue); if (!scope) continue;
      for (const spanValue of arr(scope.spans)) {
        if (out.length >= MAX_ITEMS) throw new Error("too_many_telemetry_items");
        const span = rec(spanValue); if (!span) continue;
        const traceId = hex(span.traceId, 32); const spanId = hex(span.spanId, 16);
        const occurredAt = nanoToIso(span.startTimeUnixNano);
        if (!traceId || !spanId || !occurredAt || !timestampAllowed(occurredAt)) { rejectedSpans++; continue; }
        const a = { ...resourceAttrs, ...attributes(span.attributes) };
        const outcome = spanOutcome(rec(span.status));
        const operation=str(a["gen_ai.operation.name"],80);
        out.push({ id: deterministicId([resourceId,"span",traceId,spanId]), resourceId, sourceKind:"otlp_trace", event:"otel_span", occurredAt, title:operation?`${operation} operation`:"Instrumented operation", summary: outcome === "failure" ? "Instrumented operation reported an error." : "Instrumented operation observed.", outcome, severity: outcome === "failure" ? "error" : "info", traceId, spanId, parentSpanId: hex(span.parentSpanId,16), runId: str(a["session.id"],120), evidence:evidence(a), safeAttributes:a });
      }
    }
  }

  for (const resourceLogValue of arr(root.resourceLogs)) {
    const resourceLog = rec(resourceLogValue); if (!resourceLog) continue;
    const resourceAttributeList = rec(resourceLog.resource)?.attributes;
    const resourceAttrs = attributes(resourceAttributeList);
    for (const scopeValue of arr(resourceLog.scopeLogs)) {
      const scope = rec(scopeValue); if (!scope) continue;
      for (const logValue of arr(scope.logRecords)) {
        if (out.length + heartbeats.length >= MAX_ITEMS) throw new Error("too_many_telemetry_items");
        const record = rec(logValue); if (!record) continue;
        const rawTime=record.timeUnixNano ?? record.observedTimeUnixNano;
        const occurredAt = nanoToIso(rawTime); if (!occurredAt || !timestampAllowed(occurredAt)) { rejectedLogRecords++; continue; }
        const native = nativeRaw(resourceAttributeList, record.attributes);
        if (native.get("service.namespace") === NATIVE_NAMESPACE) {
          const result = normalizeNativeLog(native, record, resourceId, occurredAt);
          if (result.kind === "event") out.push(result.event);
          else if (result.kind === "heartbeat") heartbeats.push({ occurredAt });
          else rejectedLogRecords++;
          continue;
        }
        const a = { ...resourceAttrs, ...attributes(record.attributes) };
        const tool = str(a.tool_name ?? a["tool.name"] ?? a.tool,120);
        const success = a.success;
        const outcome: ActivityOutcome = success === true || success === "true" ? "success" : success === false || success === "false" ? "failure" : "unknown";
        const severity = logSeverity(record);
        const traceId = hex(record.traceId,32); const spanId = hex(record.spanId,16);
        const eventId=str(a["event.id"],120)??"";
        out.push({ id: deterministicId([resourceId,"log",traceId ?? "",spanId ?? "",String(rawTime),eventId,tool??"",privateFingerprint(record)]), resourceId, sourceKind:"otlp_log", event:"otel_log", occurredAt, title: tool ? `${tool} used` : "Agent activity", summary: outcome === "failure" || severity === "error" ? "Agent-reported activity needs attention." : "Agent-reported activity observed.", outcome, severity, traceId, spanId, runId:str(a["session.id"],120), evidence:evidence(a), safeAttributes:a });
      }
    }
  }
  return {events:out,heartbeats,rejectedSpans,rejectedLogRecords};
}
