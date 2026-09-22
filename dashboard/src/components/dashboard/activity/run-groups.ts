import type {
  ActivityEvent,
  NativeRunRole,
} from "@/lib/activity-observability/types";
import {
  formatDuration,
  nativeRole,
  presentEvent,
  producerName,
  reportedDurationMs,
  safeErrorType,
  safeToolName,
} from "./presentation";

/** Set only from an explicit run.completed, run.failed or run.stopped record. */
export type ActivityRunStatus =
  "completed" | "failed" | "stopped" | "no_end_reported";

/**
 * One row of a run. A native tool call's start and end records pair on span id
 * into one step; every other record is its own step.
 */
export interface ActivityRunStep {
  /** The record the inspector opens: the tool's end when reported, otherwise its only record. */
  id: string;
  event: ActivityEvent;
  kind: "run" | "tool" | "report";
  start?: ActivityEvent;
  end?: ActivityEvent;
  records: ActivityEvent[];
}

export interface ActivityRunGroup {
  key: string;
  agentId: string;
  agentName: string;
  correlation: "run" | "trace";
  correlationId: string;
  steps: ActivityRunStep[];
  hasFailures: boolean;
  /** Any record carries a native run role (Claude Code or Codex reporting). */
  native: boolean;
  producer?: string;
  conversationId?: string;
  /** A subagent's run (`agent:<id>`), delegated within the same conversation. */
  delegated: boolean;
  status: ActivityRunStatus;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  /** True when durationMs came from the agent's own run end record. */
  durationReported: boolean;
  errorType?: string;
  /** The latest loaded record; groups sort newest first by it. */
  latest: ActivityEvent;
  hasStart: boolean;
  /** The run's start is not among the loaded records. */
  incomplete: boolean;
  toolCount: number;
  toolErrors: number;
  openTools: number;
}

const RUN_ENDS: ReadonlySet<NativeRunRole> = new Set([
  "run.completed",
  "run.failed",
  "run.stopped",
]);
const TOOL_ENDS: ReadonlySet<NativeRunRole> = new Set([
  "tool.completed",
  "tool.failed",
]);

function roleRank(event: ActivityEvent) {
  const role = nativeRole(event);
  if (role === "run.started") return 0;
  if (role === "tool.started" || !role) return 1;
  if (TOOL_ENDS.has(role)) return 2;
  return 3;
}
function time(value: string) {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}
/** Time (parsed, so fractional seconds order correctly), then role, then id. */
function chronological(a: ActivityEvent, b: ActivityEvent) {
  const at = time(a.occurredAt);
  const bt = time(b.occurredAt);
  const byTime =
    at !== undefined && bt !== undefined
      ? at - bt
      : a.occurredAt.localeCompare(b.occurredAt);
  return byTime || roleRank(a) - roleRank(b) || a.id.localeCompare(b.id);
}

function elapsed(from: ActivityEvent, to: ActivityEvent) {
  const start = time(from.occurredAt);
  const end = time(to.occurredAt);
  return start !== undefined && end !== undefined && end >= start
    ? end - start
    : undefined;
}

/** Reporter check-ins are coverage evidence, never part of a run. */
function isReporterHeartbeat(event: ActivityEvent) {
  return (
    /collector\.heartbeat/i.test(event.title) ||
    event.evidence.some(
      (item) =>
        /^(service|service\.name)$/i.test(item.label.trim()) &&
        item.value.trim() === "hivra-agent-trace",
    )
  );
}

function buildSteps(records: ActivityEvent[]) {
  const steps: ActivityRunStep[] = [];
  const tools = new Map<string, ActivityRunStep>();
  for (const event of records) {
    const role = nativeRole(event);
    const isTool = role?.startsWith("tool.");
    const span = event.spanId?.trim().toLowerCase();
    const slot = role === "tool.started" ? "start" : "end";
    const open = isTool && span ? tools.get(span) : undefined;
    if (open && !open[slot]) {
      open[slot] = event;
      open.records.push(event);
      if (slot === "end") {
        open.event = event;
        open.id = event.id;
      }
      continue;
    }
    const step: ActivityRunStep = {
      id: event.id,
      event,
      kind: isTool ? "tool" : role ? "run" : "report",
      records: [event],
      ...(isTool ? { [slot]: event } : {}),
    };
    if (isTool && span && !open) tools.set(span, step);
    steps.push(step);
  }
  return steps;
}

interface RunBucket {
  key: string;
  agentId: string;
  agentName: string;
  correlation: "run" | "trace";
  correlationId: string;
  records: ActivityEvent[];
}

function summarize(bucket: RunBucket): ActivityRunGroup {
  const { records, ...identity } = bucket;
  records.sort(chronological);
  const steps = buildSteps(records);
  const roles = records.map((event) => [event, nativeRole(event)] as const);
  const native = roles.some(([, role]) => role);
  const start = roles.find(([, role]) => role === "run.started")?.[0];
  const end = roles
    .filter(([, role]) => role && RUN_ENDS.has(role))
    .at(-1)?.[0];
  const endRole = end && nativeRole(end);
  const status: ActivityRunStatus =
    endRole === "run.completed"
      ? "completed"
      : endRole === "run.failed"
        ? "failed"
        : endRole === "run.stopped"
          ? "stopped"
          : "no_end_reported";
  const reported = end ? reportedDurationMs(end) : undefined;
  const derived = start && end ? elapsed(start, end) : undefined;
  const toolSteps = steps.filter((step) => step.kind === "tool");
  const producer = records.map(producerName).find(Boolean);
  const conversationId = records
    .map((event) => event.conversationId?.trim())
    .find(Boolean);
  const errorType = end && safeErrorType(end);
  return {
    ...identity,
    steps,
    hasFailures: records.some(
      (event) => event.outcome === "failure" || event.severity === "error",
    ),
    native,
    ...(producer ? { producer } : {}),
    ...(conversationId ? { conversationId } : {}),
    delegated:
      native &&
      identity.correlation === "run" &&
      identity.correlationId.startsWith("agent:"),
    status,
    startedAt: (start ?? records[0]).occurredAt,
    latest: records[records.length - 1],
    ...(end ? { endedAt: end.occurredAt } : {}),
    ...(reported !== undefined
      ? { durationMs: reported }
      : derived !== undefined
        ? { durationMs: derived }
        : {}),
    durationReported: reported !== undefined,
    ...(errorType ? { errorType } : {}),
    hasStart: Boolean(start),
    incomplete: native && !start,
    toolCount: toolSteps.length,
    toolErrors: toolSteps.filter(
      (step) => step.end && nativeRole(step.end) === "tool.failed",
    ).length,
    openTools: toolSteps.filter((step) => step.start && !step.end).length,
  };
}

/** Only explicit runtime correlation groups reports; names and timestamps never do. */
export function groupActivityRuns(events: ActivityEvent[]) {
  const buckets = new Map<string, RunBucket>();
  const ungrouped: ActivityEvent[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (event.kind !== "trace_span" && event.kind !== "tool_activity") continue;
    if (isReporterHeartbeat(event)) continue;
    const identity = JSON.stringify([event.agentId, event.id]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const runId = event.runId?.trim();
    const traceId = event.traceId?.trim();
    const correlation = runId ? "run" : "trace";
    const correlationId = runId || traceId;
    if (!correlationId || !event.agentId?.trim()) {
      ungrouped.push(event);
      continue;
    }
    const key = JSON.stringify([event.agentId, correlation, correlationId]);
    const bucket = buckets.get(key) ?? {
      key,
      agentId: event.agentId,
      agentName: event.agentName,
      correlation,
      correlationId,
      records: [],
    };
    bucket.records.push(event);
    buckets.set(key, bucket);
  }
  ungrouped.sort(chronological);
  return {
    groups: [...buckets.values()]
      .map(summarize)
      .sort((a, b) => chronological(b.latest, a.latest)),
    ungrouped,
  };
}

/**
 * Runs to show. Groups are always built from every record passed in, so a
 * run's status, start and counts never depend on the search; `matches` only
 * decides which runs (any record matches) and ungrouped reports are shown.
 */
export function selectRuns(
  events: ActivityEvent[],
  matches?: (event: ActivityEvent) => boolean,
) {
  const { groups, ungrouped } = groupActivityRuns(events);
  if (!matches) return { groups, ungrouped };
  return {
    groups: groups.filter((group) =>
      group.steps.some((step) => step.records.some(matches)),
    ),
    ungrouped: ungrouped.filter(matches),
  };
}

/**
 * Why an incomplete run has no start. "Load older events" is offered only
 * when an older page exists; otherwise the start is outside the 30-day window
 * or was never reported.
 */
export function describeIncompleteRun(hasOlder: boolean): string {
  return hasOlder
    ? "Started before the loaded records; load older events for earlier steps."
    : "Its start is not in the loaded records: the run began more than 30 days ago, or its start was never reported.";
}

/** The run's one-line status. Native runs speak only from explicit run records. */
export function describeRunStatus(group: ActivityRunGroup): {
  text: string;
  warning: boolean;
} {
  if (!group.native)
    return group.hasFailures
      ? { text: "A step reported a problem", warning: true }
      : { text: "Final result not confirmed", warning: false };
  const duration =
    group.durationMs === undefined
      ? undefined
      : formatDuration(group.durationMs);
  switch (group.status) {
    case "completed":
      return {
        text: !duration
          ? "Finished (reported by the agent)"
          : group.durationReported
            ? `Finished in ${duration} (reported by the agent)`
            : `Finished after about ${duration} (reported by the agent)`,
        warning: false,
      };
    case "failed":
      return { text: "Ended with a failure", warning: true };
    case "stopped":
      return { text: "Stopped before finishing", warning: false };
    default:
      return { text: "No finish reported yet", warning: false };
  }
}

/** Short plain-language facts under a native run's heading. */
export function describeRunCounts(group: ActivityRunGroup): string[] {
  const facts = [
    `${group.toolCount} tool ${group.toolCount === 1 ? "call" : "calls"}`,
  ];
  if (group.toolErrors)
    facts.push(
      `${group.toolErrors} tool ${group.toolErrors === 1 ? "error" : "errors"}`,
    );
  if (group.openTools) facts.push(`${group.openTools} with no finish reported`);
  return facts;
}

const runStepTitles: Partial<Record<NativeRunRole, string>> = {
  "run.started": "Task started",
  "run.completed": "Task finished",
  "run.failed": "Task ended with a failure",
  "run.stopped": "Task stopped",
};

/** Title, outcome and duration for one run step. */
export function describeRunStep(step: ActivityRunStep) {
  if (step.kind === "report") return presentRunStep(step.event);
  const role = nativeRole(step.event)!;
  if (step.kind === "run") {
    const ms = reportedDurationMs(step.event);
    return {
      title: runStepTitles[role] ?? presentEvent(step.event).title,
      status: presentEvent(step.event).status,
      duration: ms === undefined ? undefined : `Took ${formatDuration(ms)}`,
      warning: role === "run.failed",
    };
  }
  const tool =
    (step.start && safeToolName(step.start)) ??
    (step.end && safeToolName(step.end));
  const endRole = step.end && nativeRole(step.end);
  const reported = step.end ? reportedDurationMs(step.end) : undefined;
  const derived =
    step.start && step.end ? elapsed(step.start, step.end) : undefined;
  return {
    title: tool ? `Tool: ${tool}` : "A tool call",
    status: !step.end
      ? "No finish reported"
      : endRole === "tool.failed"
        ? "Tool reported an error"
        : step.end.outcome === "success"
          ? "Succeeded (reported by the agent)"
          : "Returned; success not reported",
    duration:
      reported !== undefined
        ? `Took ${formatDuration(reported)}`
        : derived !== undefined
          ? `About ${formatDuration(derived)} between records`
          : undefined,
    warning: endRole === "tool.failed",
  };
}

/** A single record's step presentation, with the evidence fallback for reports that predate typed fields. */
export function presentRunStep(event: ActivityEvent) {
  const typedTool = safeToolName(event);
  const typedDuration = reportedDurationMs(event);
  const tool =
    typedTool ??
    event.evidence.find((item) =>
      ["tool", "tool.name", "gen_ai.tool.name"].includes(
        item.label.toLowerCase(),
      ),
    )?.value;
  // A tool identifier is helpful; arbitrary payloads belong in technical details.
  const safeTool = tool && /^[\w .:/-]{1,80}$/.test(tool) ? tool : undefined;
  const durationValue = event.evidence.find((item) =>
    ["duration (ms)", "duration_ms"].includes(item.label.toLowerCase()),
  )?.value;
  const duration =
    durationValue?.trim() && /^\d+(\.\d+)?$/.test(durationValue.trim())
      ? Number(durationValue)
      : undefined;
  return {
    title: safeTool ? `Tool: ${safeTool}` : presentEvent(event).title,
    status: presentEvent(event).status,
    duration:
      typedDuration !== undefined
        ? `Took ${formatDuration(typedDuration)}`
        : duration !== undefined && Number.isFinite(duration)
          ? `${duration.toLocaleString()} ms reported`
          : undefined,
    warning: event.outcome === "failure" || event.severity === "error",
  };
}
