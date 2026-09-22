import {
  NATIVE_PRODUCERS,
  NATIVE_RUN_ROLES,
  type ActivityCapability,
  type ActivityEvent,
  type ActivityResource,
  type ActivitySource,
  type NativeProducer,
  type NativeRunRole,
  type NativeTracingReason,
} from "@/lib/activity-observability/types";

export const kindLabels: Record<string, string> = {
  lifecycle: "Computer changes",
  desktop_session: "Desktop access",
  trace_span: "Agent actions",
  tool_activity: "Agent tools",
};
export const sourceNames: Record<string, string> = {
  "hivra-lifecycle": "Computer changes",
  "hivra-desktop": "Desktop access",
  "otlp-traces": "Agent actions",
  "otlp-logs": "Agent tool use",
  "agent-tracing": "Agent run reporting",
};
export const capabilityNames: Record<string, string> = {
  lifecycle: "Computer changes",
  desktop: "Desktop access",
  traces: "Agent actions",
  tool_activity: "Agent tool use",
  native_tracing: "Agent run reporting",
};
export const monitoringStates: Record<string, string> = {
  active: "Available to read",
  observed: "Records available",
  configured: "Waiting for first report",
  missing: "No records yet",
  stale: "No recent reports",
  expired: "Reporting credential expired",
  unsupported: "Not available for this agent",
  not_running: "Agent not running",
  degraded: "Unable to load",
};
// Agent run reporting is a live check-in, not a store of records, so its
// healthy and silent states read differently from the history capabilities.
const nativeTracingStates: Record<string, string> = {
  observed: "Reporting",
  missing: "No reports received",
  stale: "Stopped checking in",
};
export const producerNames: Record<NativeProducer, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
};

const SAFE_TOOL = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/;
const SAFE_ERROR_TYPE = /^[a-z0-9_]{1,40}$/;

/** The native run role of a record, re-checked against the closed list. */
export function nativeRole(event: ActivityEvent): NativeRunRole | undefined {
  return event.role &&
    (NATIVE_RUN_ROLES as readonly string[]).includes(event.role)
    ? event.role
    : undefined;
}
export function producerName(event: ActivityEvent): string | undefined {
  return event.producer &&
    (NATIVE_PRODUCERS as readonly string[]).includes(event.producer)
    ? producerNames[event.producer]
    : undefined;
}
export function safeToolName(event: ActivityEvent): string | undefined {
  return event.toolName && SAFE_TOOL.test(event.toolName)
    ? event.toolName
    : undefined;
}
export function safeErrorType(event: ActivityEvent): string | undefined {
  return event.errorType && SAFE_ERROR_TYPE.test(event.errorType)
    ? event.errorType
    : undefined;
}
export function reportedDurationMs(event: ActivityEvent): number | undefined {
  const value = event.durationMs;
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 604_800_000
    ? value
    : undefined;
}
/** "850 ms", "2.0 s", "1 min 5 s", "2 h 4 min". */
export function formatDuration(ms: number): string | undefined {
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 59_950) return `${(ms / 1000).toFixed(1)} s`;
  const total = Math.round(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return hours ? `${hours} h ${minutes} min` : `${minutes} min ${total % 60} s`;
}

const NOT_RECORDED =
  "Hivra never records prompts, replies, commands, file contents, or tool inputs and outputs.";

function presentNativeEvent(event: ActivityEvent, role: NativeRunRole) {
  const agent = producerName(event) ?? "The agent";
  const tool = safeToolName(event);
  const duration = reportedDurationMs(event);
  const took =
    duration === undefined ? "" : ` after ${formatDuration(duration)}`;
  const errorType = safeErrorType(event);
  const routine =
    "This is routine history, not an alert. No action is requested by this record.";
  switch (role) {
    case "run.started":
      return {
        title: `${agent} started a task`,
        status: "Recorded",
        happened: `The agent’s own transcript shows a new task began. ${NOT_RECORDED}`,
        guidance: routine,
        warning: false,
      };
    case "run.completed":
      return {
        title: `${agent} finished a task`,
        status: "Finished (reported by the agent)",
        happened: `The agent recorded that the task ended normally${took}. This does not check whether the work is correct.`,
        guidance:
          "Open the agent to review what it produced. No action is requested by this record.",
        warning: false,
      };
    case "run.failed":
      return {
        title: `${agent} task ended with a failure`,
        status: "Ended with a failure",
        happened: `The agent recorded that the task stopped with an error${errorType ? ` (type: ${errorType})` : ""}${took}. The error message stays on the computer; Hivra does not copy it.`,
        guidance:
          "Open the agent to see what went wrong and whether the task needs to be run again. Review the technical details below for the reported error type.",
        warning: true,
      };
    case "run.stopped":
      return {
        title: `${agent} task was stopped`,
        status: "Stopped before finishing",
        happened: `The task was interrupted or replaced before it finished${took}. This usually means someone stopped it or sent a new request.`,
        guidance:
          "Not a failure by itself. If you did not expect the task to stop, open the agent to check where it left off.",
        warning: false,
      };
    case "tool.started":
      return {
        title: tool ? `Tool ${tool} started` : "A tool started",
        status: "Recorded",
        happened: `The agent called a tool. Its input is not recorded. ${NOT_RECORDED}`,
        guidance: routine,
        warning: false,
      };
    case "tool.completed":
      return {
        title: tool ? `Tool ${tool} finished` : "A tool finished",
        status:
          event.outcome === "success"
            ? "Reported successful"
            : "Finished; result not reported",
        happened:
          event.outcome === "success"
            ? `The agent recorded that the tool call returned without an error${took}. Its output is not recorded.`
            : `The tool call returned${took}. The agent did not record whether it succeeded, and its output is not recorded.`,
        guidance: routine,
        warning: false,
      };
    case "tool.failed":
      return {
        title: tool
          ? `Tool ${tool} reported an error`
          : "Tool reported an error",
        status: "Tool reported an error",
        happened: `The agent recorded that a tool call failed${errorType ? ` (type: ${errorType})` : ""}${took}. Its input and output are not recorded.`,
        guidance:
          "Agents often recover from tool errors and carry on. Check whether the task finished in Agent runs before acting.",
        warning: true,
      };
  }
}

export function presentEvent(event: ActivityEvent) {
  const role = nativeRole(event);
  if (role) return presentNativeEvent(event, role);
  const desktop = event.kind === "desktop_session";
  const failed = event.outcome === "failure" || event.severity === "error";
  const title = desktop
    ? "Desktop access allowed"
    : event.kind === "trace_span"
      ? "Agent action reported"
      : event.kind === "tool_activity"
        ? "Agent tool used"
        : ((
            {
              "Computer provisioned": "Computer created",
              "Launch requested": "Computer launch requested",
              "Instrumented operation": "Agent reported an action",
              "Agent activity": "Agent reported an action",
            } as Record<string, string>
          )[event.title] ?? event.title);
  const status = failed
    ? "Reported a problem"
    : event.needsAttention
      ? "Worth checking"
      : event.outcome === "success"
        ? "Reported successful"
        : "Recorded";
  let happened: string;
  if (desktop)
    happened =
      "Hivra allowed a request to access this computer’s desktop. This record does not confirm that anyone connected or used the desktop.";
  else if (event.kind === "lifecycle")
    happened = failed
      ? "Hivra recorded a problem while changing this computer. This record alone does not tell us its current state."
      : `${title}. Hivra saved this change in the computer’s history.`;
  else
    happened = failed
      ? "The agent reported a problem with an action. This does not tell us whether the rest of its work finished."
      : "The agent sent a record of an action. This does not confirm that its overall task is complete.";
  const guidance = failed
    ? "Open the agent or computer to check its current state. Review the technical details below for the reported error before deciding whether to retry."
    : event.needsAttention
      ? "This record was marked for review. Check the technical details and the agent or computer before taking action."
      : desktop
        ? "This is routine access history, not an alert. If you did not expect desktop access at this time, review access to your account."
        : "This is routine history, not an alert. No action is requested by this record.";
  return {
    title,
    status,
    happened,
    guidance,
    warning: failed || event.needsAttention,
  };
}
/**
 * What a source's state means. For agent run reporting, `resources` (the
 * computers on the page) tells "none can report here" apart from "none is
 * reporting right now".
 */
export function sourceExplanation(
  source: ActivitySource,
  resources?: ActivityResource[],
) {
  if (source.state === "degraded")
    return "Hivra could not load these records. Refresh to try again; activity may be missing until the read succeeds.";
  if (source.id === "agent-tracing") {
    if (source.state === "stale")
      return "At least one running Claude Code or Codex computer has stopped checking in or has an expired reporting credential, so some of its runs may be missing.";
    if (source.state === "missing") {
      const tracing = (resources ?? []).flatMap((resource) =>
        resource.capabilities
          .filter((capability) => capability.key === "native_tracing")
          .map((capability) => ({ resource, capability })),
      );
      const supported = tracing.filter(
        ({ capability }) => capability.state !== "unsupported",
      );
      if (resources && !supported.length)
        return tracing.some(
          ({ resource, capability }) =>
            nativeTracingReason(capability, {
              agentType: resource.agentType,
            }) === "substrate",
        )
          ? "Automatic run reporting works for Claude Code and Codex on Hivra-hosted computers. Your Claude Code or Codex computers run on a host type that isn’t supported yet, so none of them report runs."
          : "Automatic run reporting covers Claude Code and Codex computers on Hivra hosts. There are none in this account, so no runs are reported.";
      if (
        resources &&
        supported.every(({ capability }) => capability.state === "not_running")
      )
        return "No Claude Code or Codex computer is running, so no reports are expected.";
      return "No running Claude Code or Codex computer is reporting right now. Silence does not mean the agents were idle.";
    }
    return "Claude Code and Codex computers report when tasks start and end and which tools they call. This is what the agent reports about itself, not an audit of the computer.";
  }
  if (source.state === "missing")
    return "No reports of this kind have arrived in the last 30 days. Reporting may not be set up, or there may have been nothing to report. Missing reports do not tell us whether the computer is working.";
  if (source.state === "stale")
    return "Reports arrived before, but none recently. A quiet agent does not necessarily mean monitoring has stopped.";
  return "Hivra can read saved history, but there may be no records in the last 30 days. This does not cover everything happening on the computer.";
}

/** What the page knows about the computer a capability belongs to. */
export interface CapabilityContext {
  /** The computer's own status, e.g. "running", "stopped", "provisioning". */
  status?: string;
  agentType?: string;
  /** The snapshot's generation time, for comparing credential expiry. */
  now?: string;
}

const NATIVE_TRACING_TYPES: ReadonlySet<string> = new Set(["claude-code", "codex"]);

/**
 * The cause of a native_tracing state. The feed states it; when it does not
 * (an older response), it is inferred only from facts the page already has.
 */
export function nativeTracingReason(
  capability: ActivityCapability,
  context: CapabilityContext = {},
): NativeTracingReason | undefined {
  if (capability.key !== "native_tracing") return undefined;
  if (capability.reason) return capability.reason;
  switch (capability.state) {
    case "unsupported":
      return context.agentType && NATIVE_TRACING_TYPES.has(context.agentType)
        ? "substrate"
        : "agent_type";
    case "missing":
      return capability.installFailedAt
        ? "install_failed"
        : capability.issuedAt || capability.expiresAt
          ? "never_checked_in"
          : "not_set_up";
    case "expired": {
      const expires = capability.expiresAt
        ? Date.parse(capability.expiresAt)
        : NaN;
      const now = context.now ? Date.parse(context.now) : NaN;
      return !Number.isNaN(expires) && !Number.isNaN(now) && expires > now
        ? "expired_credential_presented"
        : "credential_ran_out";
    }
    default:
      return undefined;
  }
}

/** Plain-language state for one capability chip. */
export function capabilityStateLabel(
  capability: ActivityCapability,
  context: CapabilityContext = {},
) {
  if (capability.key === "native_tracing") {
    const reason = nativeTracingReason(capability, context);
    if (reason === "substrate") return "Not available on this host type";
    if (reason === "not_set_up") return "Not set up";
    if (reason === "install_failed") return "Reporter could not be installed";
  }
  return (
    (capability.key === "native_tracing"
      ? nativeTracingStates[capability.state]
      : undefined) ??
    monitoringStates[capability.state] ??
    capability.state
  );
}

// The closed failure codes the launch installer and start helper emit.
const installFailures: Record<string, string> = {
  timeout: "it timed out",
  transfer_failed: "it could not be copied to the computer",
  install_failed: "the installer reported an error",
  invalid_input: "its setup details were refused",
  source_missing: "its files were not available on the host",
  not_attempted: "the start did not reach the install step",
};
/** Plain-language cause of a failed reporter install, from its failure code. */
export function installFailureText(code?: string): string | undefined {
  if (!code) return undefined;
  return installFailures[code] ?? `failure code ${code}`;
}

const notRunningStatus: Record<string, string> = {
  stopped: "Stopped; no reports expected until it starts again.",
  provisioning:
    "Still being set up; reports are expected once it is running.",
  pending: "Still being set up; reports are expected once it is running.",
  starting: "Starting; reports are expected once it is running.",
  error:
    "Hivra recorded a problem with this computer, so it is not running normally; no reports are expected until it is running again.",
};

/**
 * One honest line about what a capability state means. Only automatic agent
 * run reporting has per-computer check-ins worth explaining; other
 * capabilities are described at the source level.
 */
export function capabilityExplanation(
  capability: ActivityCapability,
  context: CapabilityContext = {},
): string | undefined {
  if (capability.key !== "native_tracing") return undefined;
  const reason = nativeTracingReason(capability, context);
  switch (capability.state) {
    case "observed":
      return "Checking in. Runs are what the agent reports about itself, not an audit of everything on the computer.";
    case "configured":
      return "Set up recently; the first check-in should arrive within 10 minutes.";
    case "missing":
      if (reason === "install_failed")
        return "The reporter could not be installed, so runs on this computer are not being recorded. Restarting the computer tries again.";
      if (reason === "never_checked_in")
        return "Reporting was set up, but the reporter has never checked in, so runs on this computer are not being recorded. Restarting the computer reinstalls it.";
      return "Reporting has not been set up on this computer. Computers launched before automatic reporting may start reporting after their next restart.";
    case "stale":
      return "Hasn’t checked in for 15+ min while running; runs in this gap may be missing.";
    case "expired":
      // Only what the records show: an expired credential arrived after the
      // latest issuance and check-in, while the recorded one is still valid.
      if (reason === "expired_credential_presented")
        return `The computer presented an expired reporting credential${capability.issuedAt ? " after its latest one was issued" : ""}, so new runs are not being recorded. Restarting the computer issues a fresh one; if this keeps happening, contact support.`;
      return "The reporting credential ran out, so new runs are not being recorded. Restarting the computer issues a new one.";
    case "unsupported":
      return reason === "substrate"
        ? "Automatic run reporting works for Claude Code and Codex on Hivra-hosted computers; this computer’s host type isn’t supported yet."
        : "Automatic run reporting covers Claude Code and Codex computers only.";
    case "not_running":
      return (
        (context.status && notRunningStatus[context.status]) ??
        "This computer is not running right now, so no reports are expected."
      );
    case "degraded":
      return "Hivra couldn’t read reporting status just now. Refresh to try again.";
    default:
      return undefined;
  }
}

/**
 * Running computers whose automatic run reporting has stopped checking in or
 * whose credential expired. These are Needs-attention items: runs in the gap
 * are not recorded. A computer that is not running is expected to be silent.
 */
export function reportingAlerts(resources: ActivityResource[]) {
  return resources.flatMap((resource) => {
    const capability = resource.capabilities.find(
      (item) => item.key === "native_tracing",
    );
    return capability &&
      (capability.state === "stale" || capability.state === "expired") &&
      (resource.status === undefined || resource.status === "running")
      ? [{ resource, capability }]
      : [];
  });
}
