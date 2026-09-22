import type { ActivityEvent } from "@/lib/activity-observability/types";
import { presentEvent } from "./presentation";

export interface ActivityRunGroup {
  key: string;
  agentId: string;
  agentName: string;
  correlation: "run" | "trace";
  correlationId: string;
  steps: ActivityEvent[];
  hasFailures: boolean;
}

/** Only explicit runtime correlation groups reports; names and timestamps never do. */
export function groupActivityRuns(events: ActivityEvent[]) {
  const groups = new Map<string, ActivityRunGroup>();
  const ungrouped: ActivityEvent[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (event.kind !== "trace_span" && event.kind !== "tool_activity") continue;
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
    const group = groups.get(key) ?? {
      key,
      agentId: event.agentId,
      agentName: event.agentName,
      correlation,
      correlationId,
      steps: [],
      hasFailures: false,
    };
    group.steps.push(event);
    group.hasFailures ||=
      event.outcome === "failure" || event.severity === "error";
    groups.set(key, group);
  }
  const chronological = (a: ActivityEvent, b: ActivityEvent) =>
    a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id);
  for (const group of groups.values()) group.steps.sort(chronological);
  ungrouped.sort(chronological);
  return {
    groups: [...groups.values()].sort((a, b) =>
      chronological(b.steps[b.steps.length - 1], a.steps[a.steps.length - 1]),
    ),
    ungrouped,
  };
}

export function presentRunStep(event: ActivityEvent) {
  const tool = event.evidence.find((item) =>
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
      duration !== undefined && Number.isFinite(duration)
        ? `${duration.toLocaleString()} ms reported`
        : undefined,
  };
}
