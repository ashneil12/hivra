export const ACTIVITY_SCHEMA_VERSION = 1 as const;

export type ActivityEventKind = "lifecycle" | "desktop_session" | "trace_span" | "tool_activity";
export type ActivityOutcome = "success" | "failure" | "unknown";
export type ActivitySeverity = "info" | "warning" | "error";
export type ActivitySourceKind = "hivra_lifecycle" | "hivra_desktop" | "otlp_trace" | "otlp_log";
export type ActivitySourceState = "active" | "missing" | "stale" | "degraded";
export type ActivityCapabilityState = "observed" | "configured" | "missing" | "stale";

export interface ActivityEvidence {
  label: string;
  value: string;
}

export interface ActivityEvent {
  id: string;
  kind: ActivityEventKind;
  title: string;
  occurredAt: string;
  agentId: string;
  agentName: string;
  computerId?: string;
  runId?: string;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  source: { kind: ActivitySourceKind; label: string };
  outcome: ActivityOutcome;
  severity: ActivitySeverity;
  summary: string;
  evidence: ActivityEvidence[];
  needsAttention: boolean;
}

export interface ActivityCapability {
  key: "lifecycle" | "desktop" | "traces" | "tool_activity";
  label: string;
  state: ActivityCapabilityState;
  lastSeenAt?: string;
}

export interface ActivityResource {
  id: string;
  name: string;
  capabilities: ActivityCapability[];
  lastSeenAt?: string;
}

export interface ActivitySource {
  id: "hivra-lifecycle" | "hivra-desktop" | "otlp-traces" | "otlp-logs";
  label: string;
  state: ActivitySourceState;
  detail: string;
}

export interface ActivitySnapshot {
  schemaVersion: typeof ACTIVITY_SCHEMA_VERSION;
  generatedAt: string;
  events: ActivityEvent[];
  resources: ActivityResource[];
  sources: ActivitySource[];
  degraded: boolean;
  truncated: boolean;
  nextCursor?: string;
}

