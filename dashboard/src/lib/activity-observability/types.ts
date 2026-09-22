export const ACTIVITY_SCHEMA_VERSION = 1 as const;

export type ActivityEventKind = "lifecycle" | "desktop_session" | "trace_span" | "tool_activity";
export type ActivityOutcome = "success" | "failure" | "unknown";
export type ActivitySeverity = "info" | "warning" | "error";
export type ActivitySourceKind = "hivra_lifecycle" | "hivra_desktop" | "otlp_trace" | "otlp_log";
export type ActivitySourceState = "active" | "missing" | "stale" | "degraded";
export type ActivityCapabilityState =
  | "observed"
  | "configured"
  | "missing"
  | "stale"
  | "expired"
  | "unsupported"
  | "not_running"
  | "degraded";

/** Closed list of native agent-run roles (docs/superpowers/specs/2026-09-22-agent-run-tracing-contract.md). */
export const NATIVE_RUN_ROLES = [
  "run.started",
  "run.completed",
  "run.failed",
  "run.stopped",
  "tool.started",
  "tool.completed",
  "tool.failed",
] as const;
export type NativeRunRole = (typeof NATIVE_RUN_ROLES)[number];

/** Producers that write native run records. */
export const NATIVE_PRODUCERS = ["codex", "claude-code"] as const;
export type NativeProducer = (typeof NATIVE_PRODUCERS)[number];

/** Catalog agent types with a verified native producer. */
export const NATIVE_TRACING_AGENT_TYPES: ReadonlySet<string> = new Set(["claude-code", "codex"]);

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
  /** Native run records only. */
  role?: NativeRunRole;
  producer?: NativeProducer;
  toolName?: string;
  durationMs?: number;
  conversationId?: string;
  errorType?: string;
  source: { kind: ActivitySourceKind; label: string };
  outcome: ActivityOutcome;
  severity: ActivitySeverity;
  summary: string;
  evidence: ActivityEvidence[];
  needsAttention: boolean;
}

export interface ActivityCapability {
  key: "lifecycle" | "desktop" | "traces" | "tool_activity" | "native_tracing";
  label: string;
  state: ActivityCapabilityState;
  lastSeenAt?: string;
  /** native_tracing only: when the credential in use stops being accepted. */
  expiresAt?: string;
}

export interface ActivityResource {
  id: string;
  name: string;
  agentType?: string;
  status?: string;
  capabilities: ActivityCapability[];
  lastSeenAt?: string;
}

export interface ActivitySource {
  id: "hivra-lifecycle" | "hivra-desktop" | "otlp-traces" | "otlp-logs" | "agent-tracing";
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
