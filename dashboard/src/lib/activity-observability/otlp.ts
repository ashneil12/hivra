import crypto from "node:crypto";

import type { ActivityOutcome, ActivitySeverity } from "./types";

const MAX_ITEMS = 500;
const MAX_ATTRIBUTES = 64;
const SAFE_ATTRIBUTE_KEYS = new Set([
  "service.name", "service.namespace", "deployment.environment.name",
  "gen_ai.operation.name", "gen_ai.system", "gen_ai.request.model", "gen_ai.response.model",
  "tool.name", "tool_name", "tool", "success", "session.id", "duration_ms", "error.type",
  "rpc.system", "http.request.method", "event.id",
]);
const BLOCKED_KEY = /(prompt|command|content|body|message|query|input|output|argument|response|completion|system_prompt)/i;

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
}
export interface OtlpNormalization { events: NormalizedTelemetryEvent[]; rejectedSpans: number; rejectedLogRecords: number }

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null => v && typeof v === "object" && !Array.isArray(v) ? v as Rec : null;
const arr = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const str = (v: unknown, max = 200): string | undefined => typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined;
const hex = (v: unknown, len: number): string | undefined => typeof v === "string" && new RegExp(`^[a-fA-F0-9]{${len}}$`).test(v) ? v.toLowerCase() : undefined;

function anyValue(key: string, value: unknown): string | number | boolean | undefined {
  const r = rec(value);
  if (!r) return undefined;
  if (typeof r.stringValue === "string") {
    const candidate=r.stringValue;
    // Attribute keys are allowlisted and values are token-shaped. Free-form
    // strings (commands, prompts, headers and tool bodies) never reach storage.
    const secretLike=/^(?:sk-|gh[opsu]_|github_pat_|xox[baprs]-|AKIA|ASIA|eyJ[A-Za-z0-9_-]*\.)/i.test(candidate)||/bearer/i.test(candidate);
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

export function normalizeOtlpJson(body: unknown, resourceId: string, now = new Date()): OtlpNormalization | null {
  const root = rec(body); if (!root) return null;
  const hasSpans = Array.isArray(root.resourceSpans);
  const hasLogs = Array.isArray(root.resourceLogs);
  if (!hasSpans && !hasLogs) return null;
  const out: NormalizedTelemetryEvent[] = []; let rejectedSpans=0; let rejectedLogRecords=0;
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
    const resourceAttrs = attributes(rec(resourceLog.resource)?.attributes);
    for (const scopeValue of arr(resourceLog.scopeLogs)) {
      const scope = rec(scopeValue); if (!scope) continue;
      for (const logValue of arr(scope.logRecords)) {
        if (out.length >= MAX_ITEMS) throw new Error("too_many_telemetry_items");
        const record = rec(logValue); if (!record) continue;
        const rawTime=record.timeUnixNano ?? record.observedTimeUnixNano;
        const occurredAt = nanoToIso(rawTime); if (!occurredAt || !timestampAllowed(occurredAt)) { rejectedLogRecords++; continue; }
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
  return {events:out,rejectedSpans,rejectedLogRecords};
}
