import type { ActivityEvent } from "@/lib/activity-observability/types";
import {
  describeRunCounts,
  describeRunStatus,
  describeRunStep,
  groupActivityRuns,
  presentRunStep,
} from "../run-groups";
const event = (overrides: Partial<ActivityEvent> = {}): ActivityEvent => ({
  id: "one",
  kind: "tool_activity",
  title: "tool.call operation",
  agentId: "agent-1",
  agentName: "Builder",
  occurredAt: "2026-09-21T12:00:00Z",
  outcome: "unknown",
  severity: "info",
  summary: "Report",
  source: { kind: "otlp_log", label: "Agent" },
  evidence: [],
  needsAttention: false,
  ...overrides,
});

it("separates identical run IDs across agents and sorts steps chronologically", () => {
  const result = groupActivityRuns([
    event({ id: "later", runId: "shared", occurredAt: "2026-09-21T13:00:00Z" }),
    event({ id: "other", agentId: "agent-2", runId: "shared" }),
    event({ id: "earlier", runId: "shared" }),
  ]);
  expect(result.groups).toHaveLength(2);
  expect(
    result.groups
      .find((group) => group.agentId === "agent-1")
      ?.steps.map((step) => step.id),
  ).toEqual(["earlier", "later"]);
});
it("uses trace fallback without merging run/trace namespace collisions and leaves missing IDs ungrouped", () => {
  const result = groupActivityRuns([
    event({ id: "run", runId: "same" }),
    event({ id: "trace", traceId: "same" }),
    event({ id: "none" }),
    event({ id: "blank", runId: " ", traceId: " " }),
    event({ id: "lifecycle", kind: "lifecycle", runId: "same" }),
  ]);
  expect(result.groups.map((group) => group.correlation).sort()).toEqual([
    "run",
    "trace",
  ]);
  expect(result.ungrouped.map((step) => step.id)).toEqual(["blank", "none"]);
  expect(result.groups.flatMap((group) => group.steps)).toHaveLength(2);
});
it("deduplicates reports and records failure without inferring a run status from successful or unknown steps", () => {
  const success = event({ runId: "run", outcome: "success" });
  const result = groupActivityRuns([
    success,
    success,
    event({ id: "two", runId: "run", outcome: "unknown" }),
    event({ id: "failed", runId: "failed", outcome: "failure" }),
  ]);
  expect(
    result.groups.find((group) => group.correlationId === "run"),
  ).toMatchObject({ hasFailures: false });
  expect(
    result.groups.find((group) => group.correlationId === "run")?.steps,
  ).toHaveLength(2);
  expect(
    result.groups.find((group) => group.correlationId === "failed"),
  ).toMatchObject({ hasFailures: true });
  // Status comes only from explicit run records; older reports never have one.
  for (const group of result.groups) {
    expect(group).toMatchObject({ native: false, status: "no_end_reported", incomplete: false });
    expect(group).not.toHaveProperty("endedAt");
  }
  expect(describeRunStatus(result.groups.find((group) => group.correlationId === "run")!)).toEqual({
    text: "Final result not confirmed",
    warning: false,
  });
  expect(describeRunStatus(result.groups.find((group) => group.correlationId === "failed")!)).toEqual({
    text: "A step reported a problem",
    warning: true,
  });
});
it("shows only reported duration and safe tool identifiers", () => {
  expect(
    presentRunStep(
      event({
        evidence: [
          { label: "Tool", value: "browser.open" },
          { label: "Duration (ms)", value: "125.5" },
        ],
      }),
    ),
  ).toMatchObject({
    title: "Tool: browser.open",
    duration: "125.5 ms reported",
    status: "Recorded",
  });
  expect(
    presentRunStep(
      event({
        evidence: [
          { label: "Tool", value: "<script>" },
          { label: "Duration (ms)", value: "-1" },
        ],
      }),
    ),
  ).toMatchObject({ title: "Agent tool used", duration: undefined });
});


it("normalizes correlation whitespace for keys and display while retaining original evidence", () => {
  const result = groupActivityRuns([
    event({ id: "run-clean", runId: "run-1" }),
    event({ id: "run-padded", runId: " run-1 " }),
    event({ id: "trace-clean", traceId: "trace-1" }),
    event({ id: "trace-padded", runId: " ", traceId: " trace-1 " }),
  ]);
  expect(result.groups).toHaveLength(2);
  expect(result.groups.map(group => group.correlationId).sort()).toEqual(["run-1", "trace-1"]);
  expect(result.groups.map(group => group.steps.length)).toEqual([2, 2]);
  expect(result.groups.flatMap(group => group.steps).find(step => step.id === "run-padded")?.event.runId).toBe(" run-1 ");
});

// Native Claude Code / Codex run records (contract 2026-09-22).
const native = (
  id: string,
  role: NonNullable<ActivityEvent["role"]>,
  at: string,
  overrides: Partial<ActivityEvent> = {},
): ActivityEvent =>
  event({
    id,
    role,
    occurredAt: at,
    runId: "turn-1",
    traceId: "a".repeat(32),
    spanId: role.startsWith("run.") ? "1".repeat(16) : undefined,
    producer: "codex",
    conversationId: "thread-1",
    outcome: role === "tool.failed" || role === "run.failed" ? "failure" : "unknown",
    ...overrides,
  });

it("orders same-second records by role so a run start always leads its steps", () => {
  const at = "2026-09-21T12:00:00Z";
  const result = groupActivityRuns([
    native("z-end", "run.completed", at),
    native("b-tool-end", "tool.completed", at, { spanId: "2".repeat(16) }),
    native("c-tool-start", "tool.started", at, { spanId: "2".repeat(16), toolName: "exec" }),
    native("y-start", "run.started", at),
  ]);
  expect(result.groups).toHaveLength(1);
  expect(result.groups[0].steps.map((step) => step.kind)).toEqual(["run", "tool", "run"]);
  expect(result.groups[0].steps[0].id).toBe("y-start");
  expect(result.groups[0].steps.at(-1)?.id).toBe("z-end");
});

it("orders fractional-second timestamps by time, not by string", () => {
  const result = groupActivityRuns([
    native("second", "tool.started", "2026-09-21T12:00:00.500Z", { spanId: "3".repeat(16) }),
    native("first", "tool.started", "2026-09-21T12:00:00Z", { spanId: "4".repeat(16) }),
  ]);
  expect(result.groups[0].steps.map((step) => step.id)).toEqual(["first", "second"]);
});

it("pairs a tool's start and end on span id into one step and keeps unfinished tools open", () => {
  const result = groupActivityRuns([
    native("start", "run.started", "2026-09-21T12:00:00Z"),
    native("read-start", "tool.started", "2026-09-21T12:00:01Z", { spanId: "AB".repeat(8), toolName: "Read" }),
    native("read-end", "tool.completed", "2026-09-21T12:00:01.850Z", {
      spanId: "ab".repeat(8),
      toolName: "Read",
      outcome: "success",
      durationMs: 850,
    }),
    native("bash-start", "tool.started", "2026-09-21T12:00:02Z", { spanId: "cd".repeat(8), toolName: "Bash" }),
    native("bash-end", "tool.failed", "2026-09-21T12:00:04Z", { spanId: "cd".repeat(8), toolName: "Bash" }),
    native("web-start", "tool.started", "2026-09-21T12:00:05Z", { spanId: "ef".repeat(8), toolName: "web_search" }),
    native("exec-start", "tool.started", "2026-09-21T12:00:06Z", { spanId: "01".repeat(8), toolName: "exec" }),
    native("exec-end", "tool.completed", "2026-09-21T12:00:08Z", { spanId: "01".repeat(8), toolName: "exec" }),
  ]);
  const [group] = result.groups;
  expect(group.steps.map((step) => step.id)).toEqual(["start", "read-end", "bash-end", "web-start", "exec-end"]);
  const read = group.steps[1];
  expect(read.records.map((record) => record.id)).toEqual(["read-start", "read-end"]);
  expect(describeRunStep(read)).toEqual({
    title: "Tool: Read",
    status: "Succeeded (reported by the agent)",
    duration: "Took 850 ms",
    warning: false,
  });
  expect(describeRunStep(group.steps[2])).toMatchObject({ status: "Tool reported an error", warning: true, duration: "About 2.0 s between records" });
  expect(describeRunStep(group.steps[3])).toMatchObject({ title: "Tool: web_search", status: "No finish reported", duration: undefined });
  expect(describeRunStep(group.steps[4])).toMatchObject({ status: "Returned; success not reported" });
  expect(group).toMatchObject({ toolCount: 4, toolErrors: 1, openTools: 1, status: "no_end_reported", hasStart: true, incomplete: false });
  expect(describeRunCounts(group)).toEqual(["4 tool calls", "1 tool error", "1 with no finish reported"]);
  expect(describeRunStatus(group)).toEqual({ text: "No finish reported yet", warning: false });
});

it("sets run status only from explicit run records and prefers the agent's reported duration", () => {
  const completed = groupActivityRuns([
    native("start", "run.started", "2026-09-21T12:00:00Z"),
    native("end", "run.completed", "2026-09-21T12:00:07Z", { durationMs: 5000, outcome: "success" }),
  ]).groups[0];
  expect(completed).toMatchObject({
    status: "completed",
    startedAt: "2026-09-21T12:00:00Z",
    endedAt: "2026-09-21T12:00:07Z",
    durationMs: 5000,
    durationReported: true,
  });
  expect(describeRunStatus(completed).text).toBe("Finished in 5.0 s (reported by the agent)");

  const derived = groupActivityRuns([
    native("start", "run.started", "2026-09-21T12:00:00Z"),
    native("end", "run.completed", "2026-09-21T12:01:05Z"),
  ]).groups[0];
  expect(derived).toMatchObject({ durationMs: 65_000, durationReported: false });
  expect(describeRunStatus(derived).text).toBe("Finished after about 1 min 5 s (reported by the agent)");

  const failed = groupActivityRuns([
    native("start", "run.started", "2026-09-21T12:00:00Z"),
    native("end", "run.failed", "2026-09-21T12:00:03Z", { errorType: "server_error" }),
  ]).groups[0];
  expect(failed).toMatchObject({ status: "failed", errorType: "server_error" });
  expect(describeRunStatus(failed)).toEqual({ text: "Ended with a failure", warning: true });

  const stopped = groupActivityRuns([
    native("start", "run.started", "2026-09-21T12:00:00Z"),
    native("end", "run.stopped", "2026-09-21T12:00:03Z"),
  ]).groups[0];
  expect(describeRunStatus(stopped)).toEqual({ text: "Stopped before finishing", warning: false });

  // A failed tool and a successful tool never finish or fail the run.
  const toolsOnly = groupActivityRuns([
    native("start", "run.started", "2026-09-21T12:00:00Z"),
    native("ok", "tool.completed", "2026-09-21T12:00:01Z", { spanId: "2".repeat(16), outcome: "success" }),
    native("bad", "tool.failed", "2026-09-21T12:00:02Z", { spanId: "3".repeat(16), severity: "warning" }),
  ]).groups[0];
  expect(toolsOnly).toMatchObject({ status: "no_end_reported", hasFailures: true, toolErrors: 1 });
  expect(toolsOnly).not.toHaveProperty("endedAt");
  expect(toolsOnly).not.toHaveProperty("durationMs");
});

it("marks a run incomplete when its start is outside the loaded records", () => {
  const [group] = groupActivityRuns([
    native("tool", "tool.completed", "2026-09-21T12:00:01Z", { spanId: "2".repeat(16) }),
    native("end", "run.completed", "2026-09-21T12:00:03Z", { durationMs: 9000 }),
  ]).groups;
  expect(group).toMatchObject({ hasStart: false, incomplete: true, status: "completed", startedAt: "2026-09-21T12:00:01Z" });
  expect(describeRunStatus(group).text).toBe("Finished in 9.0 s (reported by the agent)");
});

it("shows a subagent as its own delegated run in the same conversation", () => {
  const { groups } = groupActivityRuns([
    native("parent", "run.started", "2026-09-21T12:00:00Z", { producer: "claude-code", runId: "prompt-1" }),
    native("child", "run.started", "2026-09-21T12:00:02Z", { producer: "claude-code", runId: "agent:a1b2" }),
  ]);
  expect(groups.map((group) => [group.correlationId, group.delegated, group.conversationId, group.producer])).toEqual([
    ["agent:a1b2", true, "thread-1", "Claude Code"],
    ["prompt-1", false, "thread-1", "Claude Code"],
  ]);
  // Only native runs are called delegated; an arbitrary run id is just an id.
  expect(groupActivityRuns([event({ runId: "agent:x" })]).groups[0].delegated).toBe(false);
});

it("never turns reporter check-ins into a run", () => {
  const result = groupActivityRuns([
    event({ id: "hb", runId: "collector", evidence: [{ label: "Service", value: "hivra-agent-trace" }] }),
    event({ id: "hb2", title: "collector.heartbeat", traceId: "b".repeat(32) }),
    native("start", "run.started", "2026-09-21T12:00:00Z"),
  ]);
  expect(result.groups.map((group) => group.correlationId)).toEqual(["turn-1"]);
  expect(result.ungrouped).toEqual([]);
});

it("ignores unknown roles and unsafe typed fields", () => {
  const [group] = groupActivityRuns([
    native("odd", "run.started", "2026-09-21T12:00:00Z", {
      role: "run.exploded" as never,
      producer: "evil" as never,
      toolName: "Bash; rm -rf /",
    }),
  ]).groups;
  expect(group).toMatchObject({ native: false, delegated: false });
  expect(group).not.toHaveProperty("producer");
  expect(presentRunStep(group.steps[0].event).title).toBe("Agent tool used");
});
