export const AGENT_START_FAILURE_DEDUPE_MS = 5 * 60 * 1000;

type AgentStartRecoveryAction =
  | "wait_and_retry"
  | "open_console_logs"
  | "open_billing"
  | "contact_support";

export interface AgentStartFailureInput {
  status?: number;
  error?: unknown;
  code?: unknown;
  failureType?: unknown;
}

export interface AgentStartFailureDescription {
  code: string;
  rawMessage: string;
  userMessage: string;
  retryable: boolean;
  recoveryAction: AgentStartRecoveryAction;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readErrorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (!isRecord(error)) return "";
  return readString(error.error) || readString(error.message) || "";
}

function readFailureCode(input: AgentStartFailureInput): string | undefined {
  return (
    readString(input.failureType) ||
    readString(input.code) ||
    (isRecord(input.error)
      ? readString(input.error.failureType) || readString(input.error.code)
      : undefined)
  );
}

function hashText(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function describeAgentStartFailure(
  input: AgentStartFailureInput,
): AgentStartFailureDescription {
  const rawMessage = readErrorText(input.error);
  const normalized = rawMessage.toLowerCase();
  const explicitCode = readFailureCode(input);

  if (explicitCode === "instance_entitlement_suspended" || input.status === 402) {
    return {
      code: "instance_entitlement_suspended",
      rawMessage,
      retryable: false,
      recoveryAction: "open_billing",
      userMessage:
        "Compute is suspended for this agent. Open Billing to restore eligibility before starting it again.",
    };
  }

  if (
    explicitCode === "instance_host_recovery_pending" ||
    explicitCode === "instance_host_routing_recovered"
  ) {
    return {
      code: explicitCode,
      rawMessage,
      retryable: true,
      recoveryAction: "wait_and_retry",
      userMessage:
        explicitCode === "instance_host_routing_recovered"
          ? "The runtime was found and its routing was repaired. Wait about 30 seconds, then retry Start."
          : "The runtime host is still being checked. The agent was preserved; wait about 30 seconds, then retry Start.",
    };
  }

  if (
    explicitCode === "instance_host_missing" ||
    explicitCode === "instance_host_missing_across_fleet" ||
    explicitCode === "instance_runtime_target_unresolved"
  ) {
    return {
      code: explicitCode,
      rawMessage,
      retryable: false,
      recoveryAction: "contact_support",
      userMessage:
        "The runtime routing needs support repair. This agent was preserved; do not delete or re-create it. Send support the diagnostic report.",
    };
  }

  if (
    input.status === 409 ||
    normalized.includes("still starting") ||
    normalized.includes("warming") ||
    normalized.includes("provisioning")
  ) {
    return {
      code: explicitCode || "runtime_starting",
      rawMessage,
      retryable: true,
      recoveryAction: "wait_and_retry",
      userMessage:
        "The agent runtime is still starting. Wait about 30 seconds, then retry once.",
    };
  }

  if (
    input.status === 502 ||
    normalized.includes("econnrefused") ||
    normalized.includes("connection refused") ||
    normalized.includes("timed out") ||
    normalized.includes("timeout") ||
    normalized.includes("gateway") ||
    normalized.includes("ssh")
  ) {
    return {
      code: explicitCode || "runtime_unreachable",
      rawMessage,
      retryable: true,
      recoveryAction: "open_console_logs",
      userMessage:
        "The agent runtime is not accepting chat yet. Open Console -> Logs to see the start error, then use Repair runtime once. If it repeats, copy the diagnostic report instead of repeatedly restarting.",
    };
  }

  return {
    code: explicitCode || "agent_start_failed",
    rawMessage,
    retryable: true,
    recoveryAction: "open_console_logs",
    userMessage:
      rawMessage ||
      "The agent did not start. Open Console -> Logs, then use Repair runtime once if the same error repeats.",
  };
}

export function getAgentStartFailureTelemetryKey(
  instanceId: string,
  failure: AgentStartFailureDescription,
): string {
  return [
    instanceId,
    failure.code,
    failure.recoveryAction,
    hashText(failure.rawMessage.slice(0, 500)),
  ].join(":");
}

export function shouldCaptureAgentStartFailure(
  seen: Map<string, number>,
  key: string,
  now = Date.now(),
): boolean {
  for (const [seenKey, seenAt] of seen) {
    if (now - seenAt > AGENT_START_FAILURE_DEDUPE_MS) {
      seen.delete(seenKey);
    }
  }

  const lastSeenAt = seen.get(key);
  if (lastSeenAt !== undefined && now - lastSeenAt <= AGENT_START_FAILURE_DEDUPE_MS) {
    return false;
  }

  seen.set(key, now);
  return true;
}
