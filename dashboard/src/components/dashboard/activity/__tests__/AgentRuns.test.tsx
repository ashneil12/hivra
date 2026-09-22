/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { AgentRuns } from "../AgentRuns";
import type { ActivityEvent } from "@/lib/activity-observability/types";

const record = (
  id: string,
  role: NonNullable<ActivityEvent["role"]>,
  occurredAt: string,
  overrides: Partial<ActivityEvent> = {},
): ActivityEvent => ({
  id,
  kind: "tool_activity",
  title: "Agent activity",
  agentId: "agent-1",
  agentName: "Builder",
  occurredAt,
  role,
  producer: "codex",
  runId: "turn-1",
  traceId: "a".repeat(32),
  spanId: role.startsWith("run.") ? "1".repeat(16) : undefined,
  conversationId: "thread-1",
  outcome: "unknown",
  severity: "info",
  summary: "Report",
  source: { kind: "otlp_log", label: "OpenTelemetry agent log" },
  evidence: [],
  needsAttention: false,
  ...overrides,
});

const finishedRun = [
  record("run-start", "run.started", "2026-09-21T12:00:00Z"),
  record("read-start", "tool.started", "2026-09-21T12:00:01Z", {
    spanId: "2".repeat(16),
    toolName: "Read",
  }),
  record("read-end", "tool.completed", "2026-09-21T12:00:02Z", {
    spanId: "2".repeat(16),
    toolName: "Read",
    outcome: "success",
    durationMs: 850,
  }),
  record("bash-start", "tool.started", "2026-09-21T12:00:02Z", {
    spanId: "3".repeat(16),
    toolName: "Bash",
  }),
  record("bash-end", "tool.failed", "2026-09-21T12:00:03Z", {
    spanId: "3".repeat(16),
    toolName: "Bash",
    outcome: "failure",
    severity: "warning",
  }),
  record("run-end", "run.completed", "2026-09-21T12:00:05Z", {
    outcome: "success",
    durationMs: 5000,
  }),
];

function renderRuns(
  events: ActivityEvent[],
  selected?: string,
  options: {
    matches?: (event: ActivityEvent) => boolean;
    hasOlder?: boolean;
  } = {},
) {
  const onSelect = jest.fn();
  render(
    <AgentRuns
      events={events}
      selected={selected}
      onSelect={onSelect}
      limited={false}
      {...options}
    />,
  );
  return {
    onSelect,
    runs: within(screen.getByRole("region", { name: "Agent runs" })),
  };
}

it("explains what is and is not recorded before any run", () => {
  const { runs } = renderRuns([]);
  expect(
    runs.getByText(
      /never records prompts, replies, commands, file contents, or tool inputs and outputs/,
    ),
  ).toBeVisible();
  expect(runs.getByText(/not an audit of the computer/)).toBeVisible();
  expect(runs.getByText(/not a complete account of a run/)).toBeVisible();
  expect(runs.getByText(/No linked agent runs/)).toBeVisible();
});

it("shows a finished run with producer, reported duration, tool counts and paired steps", () => {
  const { runs, onSelect } = renderRuns(finishedRun);
  const run = within(runs.getByRole("article", { name: "Builder Codex run" }));
  expect(
    run.getByRole("heading", { name: "Builder · Codex run" }),
  ).toBeVisible();
  expect(
    run.getByText("Finished in 5.0 s (reported by the agent)"),
  ).toBeVisible();
  expect(run.getByText(/2 tool calls · 1 tool error/)).toBeVisible();
  // Four rows: start, Read (paired), Bash (paired), finish.
  expect(run.getAllByRole("button")).toHaveLength(4);
  const read = run.getByRole("button", { name: /Tool: Read/ });
  expect(
    within(read).getByText("Succeeded (reported by the agent)"),
  ).toBeVisible();
  expect(within(read).getByText("Took 850 ms")).toBeVisible();
  const bash = run.getByRole("button", { name: /Tool: Bash/ });
  expect(within(bash).getByText("Tool reported an error")).toBeVisible();
  expect(run.getByRole("button", { name: /Task started/ })).toBeVisible();
  expect(run.getByRole("button", { name: /Task finished/ })).toBeVisible();
  fireEvent.click(read);
  expect(onSelect).toHaveBeenCalledWith("read-end");
  expect(
    run.queryByText(/Started before the loaded records/),
  ).not.toBeInTheDocument();
  expect(run.getByText("thread-1")).not.toBeVisible();
});

it("marks the paired step as selected when either of its records is selected", () => {
  const { runs } = renderRuns(finishedRun, "read-start");
  expect(runs.getByRole("button", { name: /Tool: Read/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

it.each<[NonNullable<ActivityEvent["role"]> | null, string]>([
  ["run.failed", "Ended with a failure"],
  ["run.stopped", "Stopped before finishing"],
  [null, "No finish reported yet"],
])("states the run status from the explicit end record (%s)", (role, text) => {
  const events = [record("start", "run.started", "2026-09-21T12:00:00Z")];
  if (role) events.push(record("end", role, "2026-09-21T12:00:03Z"));
  const { runs } = renderRuns(events);
  // The heading's status line comes first; the end record's own step repeats it.
  const [heading] = runs.getAllByText(text);
  expect(heading.previousElementSibling).toHaveTextContent(
    "Builder · Codex run",
  );
});

it("says when a run started before the loaded records and when a tool has no finish", () => {
  const { runs } = renderRuns(
    [
      record("tool", "tool.started", "2026-09-21T12:00:01Z", {
        spanId: "2".repeat(16),
        toolName: "web_search",
      }),
    ],
    undefined,
    { hasOlder: true },
  );
  expect(
    runs.getByText(
      "Started before the loaded records; load older events for earlier steps.",
    ),
  ).toBeVisible();
  expect(runs.getByText(/1 with no finish reported/)).toBeVisible();
  expect(runs.getByText("No finish reported")).toBeVisible();
  expect(runs.getByText("No finish reported yet")).toBeVisible();
});

it("labels a subagent run as delegated within the same conversation", () => {
  const { runs } = renderRuns([
    record("parent", "run.started", "2026-09-21T12:00:00Z", {
      producer: "claude-code",
      runId: "prompt-1",
    }),
    record("child", "run.started", "2026-09-21T12:00:01Z", {
      producer: "claude-code",
      runId: "agent:abc",
    }),
  ]);
  const child = within(
    runs.getByRole("article", { name: "Builder Claude Code delegated run" }),
  );
  expect(child.getByText(/same conversation/)).toBeVisible();
  expect(
    runs.getByRole("article", { name: "Builder Claude Code run" }),
  ).toBeVisible();
});

it("offers older events for a run's start only when an older page exists", () => {
  const { runs } = renderRuns([
    record("tool", "tool.started", "2026-09-21T12:00:01Z", {
      spanId: "2".repeat(16),
      toolName: "web_search",
    }),
  ]);
  expect(
    runs.getByText(
      "Its start is not in the loaded records: the run began more than 30 days ago, or its start was never reported.",
    ),
  ).toBeVisible();
  expect(runs.queryByText(/load older events/)).not.toBeInTheDocument();
});

it("searches for runs without trimming them: status, start and counts come from every loaded record", () => {
  const other = [
    record("o-start", "run.started", "2026-09-21T13:00:00Z", {
      runId: "turn-2",
    }),
    record("o-end", "run.failed", "2026-09-21T13:00:04Z", {
      runId: "turn-2",
      outcome: "failure",
      severity: "error",
    }),
  ];
  const bash = (event: ActivityEvent) => event.toolName === "Bash";
  const { runs } = renderRuns([...finishedRun, ...other], undefined, {
    matches: bash,
  });
  const run = within(runs.getByRole("article", { name: "Builder Codex run" }));
  expect(run.getByText("Finished in 5.0 s (reported by the agent)")).toBeVisible();
  expect(run.getByText(/^Started/)).toBeVisible();
  expect(run.getByText(/2 tool calls · 1 tool error/)).toBeVisible();
  expect(run.queryByText(/not in the loaded records|Started before/)).not.toBeInTheDocument();
  expect(run.getAllByRole("button")).toHaveLength(4);
  expect(
    within(run.getByRole("button", { name: /Tool: Bash/ })).getByText(
      /Matches your search/,
    ),
  ).toBeVisible();
  expect(
    within(run.getByRole("button", { name: /Tool: Read/ })).queryByText(
      /Matches your search/,
    ),
  ).not.toBeInTheDocument();
  expect(runs.getByText(/Showing runs with a step that matches your search/)).toBeVisible();
  // The failed run has no matching record, so it is not shown.
  expect(runs.getAllByRole("article")).toHaveLength(1);
  expect(runs.queryByText("Ended with a failure")).not.toBeInTheDocument();
});

it("keeps a failed run's status when only a tool step matches the search", () => {
  const failed = [
    record("start", "run.started", "2026-09-21T12:00:00Z"),
    record("t-start", "tool.started", "2026-09-21T12:00:01Z", {
      spanId: "4".repeat(16),
      toolName: "Bash",
    }),
    record("t-end", "tool.completed", "2026-09-21T12:00:02Z", {
      spanId: "4".repeat(16),
      toolName: "Bash",
    }),
    record("end", "run.failed", "2026-09-21T12:00:03Z", {
      outcome: "failure",
      severity: "error",
    }),
  ];
  const { runs } = renderRuns(failed, undefined, {
    matches: (event) => event.toolName === "Bash",
  });
  const [heading] = runs.getAllByText("Ended with a failure");
  expect(heading.previousElementSibling).toHaveTextContent("Builder · Codex run");
  expect(heading).toHaveClass("warning");
});

it("says plainly when no run matches the search", () => {
  const { runs } = renderRuns(finishedRun, undefined, { matches: () => false });
  expect(
    runs.getByText("No agent run has a step that matches your search."),
  ).toBeVisible();
});
