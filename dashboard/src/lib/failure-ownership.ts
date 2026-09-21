type FailureSeverity = "info" | "warn" | "error" | "fatal";

export type FailureOwner =
  | "user"
  | "hermes"
  | "runtime"
  | "provider"
  | "hypervisor"
  | "upstream";

export type FailurePhase =
  | "provisioning"
  | "auth"
  | "runtime"
  | "chat"
  | "egress"
  | "update"
  | "delete"
  | "billing"
  | "network"
  | "storage";

export type RecoveryAction =
  | "update_provider_key"
  | "open_console"
  | "repair_runtime"
  | "restart_gateway"
  | "redeploy"
  | "contact_support"
  | "retry_later"
  | "none";

export interface InstanceFailureAlert {
  title: string;
  message: string;
  lastSeenAt: string;
  owner: FailureOwner;
  ownerLabel: string;
  phase: FailurePhase;
  phaseLabel: string;
  severity: FailureSeverity;
  recoveryAction: RecoveryAction;
  recoveryLabel: string;
  failureType?: string;
  requestId?: string;
  source?: string;
  runType?: "manual" | "scheduled";
  reason?: string;
}

export interface FailureOpsEventInput {
  source: string;
  severity: unknown;
  title: unknown;
  message: unknown;
  lastSeenAt: unknown;
  metadata?: Record<string, unknown> | null;
}

const OWNER_LABELS: Record<FailureOwner, string> = {
  user: "Your action needed",
  hermes: "Hermes issue",
  runtime: "Runtime issue",
  provider: "Provider issue",
  hypervisor: "Infrastructure issue",
  upstream: "Upstream issue",
};

const PHASE_LABELS: Record<FailurePhase, string> = {
  provisioning: "Provisioning",
  auth: "Authentication",
  runtime: "Runtime",
  chat: "Chat",
  egress: "Network egress",
  update: "Update",
  delete: "Deletion",
  billing: "Billing",
  network: "Network",
  storage: "Storage",
};

const RECOVERY_LABELS: Record<RecoveryAction, string> = {
  update_provider_key: "Update provider key",
  open_console: "Open console",
  repair_runtime: "Repair runtime",
  restart_gateway: "Restart gateway",
  redeploy: "Redeploy",
  contact_support: "Contact support",
  retry_later: "Retry later",
  none: "No action available",
};

const FAILURE_OWNERS = new Set<FailureOwner>([
  "user",
  "hermes",
  "runtime",
  "provider",
  "hypervisor",
  "upstream",
]);

const FAILURE_PHASES = new Set<FailurePhase>([
  "provisioning",
  "auth",
  "runtime",
  "chat",
  "egress",
  "update",
  "delete",
  "billing",
  "network",
  "storage",
]);

const RECOVERY_ACTIONS = new Set<RecoveryAction>([
  "update_provider_key",
  "open_console",
  "repair_runtime",
  "restart_gateway",
  "redeploy",
  "contact_support",
  "retry_later",
  "none",
]);

const FAILURE_SEVERITIES = new Set<FailureSeverity>(["info", "warn", "error", "fatal"]);

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeSeverity(value: unknown): FailureSeverity {
  const normalized = normalizeOptionalString(value);
  return normalized && FAILURE_SEVERITIES.has(normalized as FailureSeverity)
    ? (normalized as FailureSeverity)
    : "error";
}

function normalizeOwner(value: unknown, fallback: FailureOwner): FailureOwner {
  const normalized = normalizeOptionalString(value);
  return normalized && FAILURE_OWNERS.has(normalized as FailureOwner)
    ? (normalized as FailureOwner)
    : fallback;
}

function normalizePhase(value: unknown, fallback: FailurePhase): FailurePhase {
  const normalized = normalizeOptionalString(value);
  return normalized && FAILURE_PHASES.has(normalized as FailurePhase)
    ? (normalized as FailurePhase)
    : fallback;
}

function normalizeRecoveryAction(value: unknown, fallback: RecoveryAction): RecoveryAction {
  const normalized = normalizeOptionalString(value);
  return normalized && RECOVERY_ACTIONS.has(normalized as RecoveryAction)
    ? (normalized as RecoveryAction)
    : fallback;
}

function normalizeRunType(value: unknown): "manual" | "scheduled" | undefined {
  const normalized = normalizeOptionalString(value);
  return normalized === "manual" || normalized === "scheduled" ? normalized : undefined;
}

export function getFailureOwnerLabel(owner: FailureOwner): string {
  return OWNER_LABELS[owner];
}

export function getFailurePhaseLabel(phase: FailurePhase): string {
  return PHASE_LABELS[phase];
}

export function getRecoveryActionLabel(action: RecoveryAction): string {
  return RECOVERY_LABELS[action];
}

export function buildInstanceFailureAlertFromOpsEvent(
  event: FailureOpsEventInput
): InstanceFailureAlert | null {
  const title = normalizeOptionalString(event.title);
  const message = normalizeOptionalString(event.message);
  const lastSeenAt = normalizeOptionalString(event.lastSeenAt);
  if (!title || !message || !lastSeenAt) return null;

  const metadata = event.metadata ?? {};
  const source = normalizeOptionalString(event.source) ?? "unknown";
  const status = normalizeOptionalString(metadata.status);
  const explicitOwner = normalizeOptionalString(metadata.failureOwner);

  if (source === "instance-update-status") {
    if (status !== "failed") return null;

    const owner = normalizeOwner(metadata.failureOwner, "hermes");
    const phase = normalizePhase(metadata.failurePhase, "update");
    const recoveryAction = normalizeRecoveryAction(metadata.recoveryAction, "open_console");

    return {
      title,
      message,
      lastSeenAt,
      owner,
      ownerLabel: getFailureOwnerLabel(owner),
      phase,
      phaseLabel: getFailurePhaseLabel(phase),
      severity: normalizeSeverity(event.severity),
      recoveryAction,
      recoveryLabel: getRecoveryActionLabel(recoveryAction),
      failureType: normalizeOptionalString(metadata.failureType),
      requestId: normalizeOptionalString(metadata.requestId),
      source,
      runType: normalizeRunType(metadata.runType),
      reason: normalizeOptionalString(metadata.reason),
    };
  }

  if (!explicitOwner) return null;

  const owner = normalizeOwner(metadata.failureOwner, "hermes");
  const phase = normalizePhase(metadata.failurePhase, "runtime");
  const recoveryAction = normalizeRecoveryAction(metadata.recoveryAction, "open_console");

  return {
    title,
    message,
    lastSeenAt,
    owner,
    ownerLabel: getFailureOwnerLabel(owner),
    phase,
    phaseLabel: getFailurePhaseLabel(phase),
    severity: normalizeSeverity(event.severity),
    recoveryAction,
    recoveryLabel: getRecoveryActionLabel(recoveryAction),
    failureType: normalizeOptionalString(metadata.failureType),
    requestId: normalizeOptionalString(metadata.requestId),
    source,
    runType: normalizeRunType(metadata.runType),
    reason: normalizeOptionalString(metadata.reason),
  };
}
