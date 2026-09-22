import type { ActivityEvent } from "@/lib/activity-observability/types";
import { groupActivityRuns, presentRunStep } from "../run-groups";
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
it("deduplicates reports and records failure without inferring a run finish from successful or unknown steps", () => {
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
  expect(result.groups[0]).not.toHaveProperty("completed");
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
  expect(result.groups.flatMap(group => group.steps).find(step => step.id === "run-padded")?.runId).toBe(" run-1 ");
});
