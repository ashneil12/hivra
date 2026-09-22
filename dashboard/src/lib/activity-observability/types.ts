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

/**
 * native_tracing only: which of a state's contract causes applies, so the page
 * can explain it without guessing.
 */
export type NativeTracingReason =
  /** unsupported: the agent type has no verified producer. */
  | "agent_type"
  /** unsupported: Claude Code or Codex on a host type without a verified producer. */
  | "substrate"
  /** expired: the recorded credential's expiry has passed. */
  | "credential_ran_out"
  /** expired: the computer presented an expired credential after the latest issuance and check-in. */
  | "expired_credential_presented"
  /** missing: no credential was ever recorded (launched before reporting, or issuance failed). */
  | "not_set_up"
  /** missing: the latest install attempt after issuance failed and nothing has checked in since. */
  | "install_failed"
  /** missing: a credential was issued 10+ minutes ago and the reporter has never checked in. */
  | "never_checked_in"
  /** stale: the reporter checks in, but its run records are refused because the computer's clock is wrong. */
  | "clock_skew";

export interface ActivityCapability {
  key: "lifecycle" | "desktop" | "traces" | "tool_activity" | "native_tracing";
  label: string;
  state: ActivityCapabilityState;
  lastSeenAt?: string;
  /** native_tracing only: when the credential in use stops being accepted. */
  expiresAt?: string;
  /** native_tracing only: when the latest credential was issued. */
  issuedAt?: string;
  /** native_tracing only: which cause of `state` applies, when a state has several. */
  reason?: NativeTracingReason;
  /** native_tracing only, reason "install_failed": when the failed install attempt was recorded. */
  installFailedAt?: string;
  /** native_tracing only, reason "install_failed": the installer's failure code (`^[a-z_]{1,40}$`). */
  installFailureReason?: string;
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
