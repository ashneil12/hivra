/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { ActivityObservatory } from "../ActivityObservatory";
import type { ActivitySnapshot, ActivityEventKind } from "@/lib/activity-observability/types";

jest.mock("@/components/dashboard/AgentActivityPanel", () => ({
  AgentActivityPanel: () => <div>Metered usage panel</div>,
}));
const snapshot: ActivitySnapshot = {
  schemaVersion: 1,
  generatedAt: "2026-09-21T12:00:00Z",
  degraded: false,
  truncated: false,
  events: [
    {
      id: "event-1",
      kind: "lifecycle",
      title: "Agent started",
      agentId: "a1",
      agentName: "Builder",
      occurredAt: "2026-09-21T11:00:00Z",
      outcome: "unknown",
      severity: "info",
      summary: "Lifecycle record only.",
      source: { kind: "hivra_lifecycle", label: "Lifecycle ledger" },
      evidence: [{ label: "Recorded status", value: "running" }],
      needsAttention: false,
    },
    {
      id: "event-2",
      kind: "trace_span",
      title: "Test command failed",
      agentId: "a2",
      agentName: "Researcher",
      occurredAt: "2026-09-21T11:30:00Z",
      outcome: "failure",
      severity: "error",
      summary: "Runtime reported an error.",
      source: { kind: "otlp_trace", label: "Agent-reported trace" },
      traceId: "trace-123",
      spanId: "span-123",
      evidence: [{ label: "Command", value: "npm test" }],
      needsAttention: true,
    },
  ],
  resources: [
    {
      id: "a1",
      name: "Builder",
      capabilities: [{ key: "tool_activity", label: "Agent tools", state: "missing" }],
    },
  ],
  sources: [
    {
      id: "hivra-lifecycle",
      label: "Lifecycle ledger",
      state: "active",
      detail: "Database records available.",
    },
    {
      id: "otlp-logs",
      label: "Process collector",
      state: "missing",
      detail: "Independent process monitoring is not connected.",
    },
  ],
};
function respond(data = snapshot) {
  (global.fetch as jest.Mock).mockResolvedValue({
    ok: true,
    json: async () => ({ data }),
  });
}
beforeEach(() => {
  global.fetch = jest.fn();
  respond();
});

it("inspects real evidence and source provenance and filters without inventing controls", async () => {
  render(<ActivityObservatory />);
  await screen.findByRole("button", { name: /Agent started/ });
  fireEvent.click(
    screen.getByRole("button", { name: /Agent action reported/ }),
  );
  const inspector = within(
    screen.getByRole("complementary", { name: "Event inspector" }),
  );
  expect(inspector.getByText("trace-123")).not.toBeVisible();
  fireEvent.click(inspector.getByText("Technical details"));
  expect(inspector.getByText("trace-123")).toBeVisible();
  expect(inspector.getByText("Agent-reported trace")).toBeVisible();
  expect(inspector.getByText("npm test")).toBeVisible();
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "running" },
  });
  expect(
    screen.queryByRole("button", { name: /Agent action reported/ }),
  ).not.toBeInTheDocument();
  expect(inspector.queryByText("trace-123")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /stop|block/i }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByText(/total tokens|percent complete/i),
  ).not.toBeInTheDocument();
});
it("combines attention, agent, and kind filters and clears stale inspector content", async () => {
  render(<ActivityObservatory />);
  await screen.findByRole("button", { name: /Agent started/ });
  fireEvent.click(screen.getByRole("button", { name: /Needs attention/ }));
  expect(
    screen.queryByRole("button", { name: /Agent started/ }),
  ).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Filter by agent"), {
    target: { value: "a1" },
  });
  expect(screen.getByText(/No recorded events match/)).toBeVisible();
  expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "History" }));
  fireEvent.change(screen.getByLabelText("Filter by agent"), {
    target: { value: "all" },
  });
  fireEvent.change(screen.getByLabelText("Filter by kind"), {
    target: { value: "trace_span" },
  });
  expect(
    screen.getByRole("button", { name: /Agent action reported/ }),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: /Agent started/ }),
  ).not.toBeInTheDocument();
});
it("shows missing coverage explicitly and keeps usage opt-in", async () => {
  render(<ActivityObservatory />);
  await screen.findByRole("button", { name: "Monitoring limits" });
  expect(screen.queryByText("Metered usage panel")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "What is monitored" }));
  expect(screen.getByText("Agent tool use · No records yet")).toBeVisible();
  expect(screen.getByText(/Missing reports do not tell us/)).toBeVisible();
  expect(
    screen.getByText("Independent process monitoring is not connected."),
  ).not.toBeVisible();
  fireEvent.click(screen.getAllByText("Technical source details")[1]);
  expect(
    screen.getByText("Independent process monitoring is not connected."),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Usage" }));
  expect(screen.getByText("Metered usage panel")).toBeVisible();
});
it("does not interpret degraded empty results as no activity", async () => {
  respond({ ...snapshot, events: [], degraded: true, truncated: true });
  render(<ActivityObservatory showUsage={false} />);
  expect(
    await screen.findByText(/This history may be incomplete/),
  ).toBeVisible();
  expect(screen.getByText(/No activity was returned/)).toBeVisible();
  expect(
    screen.getByText(/Search and filters only cover these records/),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Usage" }),
  ).not.toBeInTheDocument();
});
it("has an honest healthy empty state and retries errors", async () => {
  (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: false, status: 503 });
  render(<ActivityObservatory />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Activity could not be loaded",
  );
  respond({ ...snapshot, events: [] });
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(
    await screen.findByText(/No activity was recorded in the last 30 days/),
  ).toBeVisible();
});
it("preserves the previous snapshot with a freshness warning when refresh fails", async () => {
  render(<ActivityObservatory />);
  await screen.findByRole("button", { name: /Agent started/ });
  (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: false, status: 503 });
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "It may be out of date",
  );
  expect(screen.getByRole("button", { name: /Agent started/ })).toBeVisible();
});

it("brings selected evidence into view on a narrow screen", async () => {
  const scroll = jest.fn();
  const originalMedia = window.matchMedia;
  const originalScroll = HTMLElement.prototype.scrollIntoView;
  window.matchMedia = jest.fn().mockReturnValue({ matches: true });
  HTMLElement.prototype.scrollIntoView = scroll;
  try {
    render(<ActivityObservatory />);
    await screen.findByRole("button", { name: /Agent started/ });
    expect(scroll).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: /Agent action reported/ }),
    );
    expect(scroll).toHaveBeenCalledWith({
      block: "nearest",
      behavior: "instant",
    });
  } finally {
    window.matchMedia = originalMedia;
    HTMLElement.prototype.scrollIntoView = originalScroll;
  }
});

it("appends older events once, preserves selection and coverage, and refresh resets history", async () => {
  respond({
    ...snapshot,
    truncated: true,
    nextCursor: "page/2",
  } as typeof snapshot);
  render(<ActivityObservatory />);
  await screen.findByRole("button", { name: /Agent started/ });
  fireEvent.click(
    screen.getByRole("button", { name: /Agent action reported/ }),
  );
  const older = { ...snapshot.events[0], id: "older-1", title: "Older launch" };
  respond({
    ...snapshot,
    events: [snapshot.events[1], older, older],
    resources: [],
    sources: [],
    truncated: false,
  });
  fireEvent.click(screen.getByRole("button", { name: "Load older events" }));
  await screen.findByRole("button", { name: /Older launch/ });
  expect(global.fetch).toHaveBeenLastCalledWith(
    "/api/activity?days=30&limit=100&cursor=page%2F2",
    expect.any(Object),
  );
  expect(screen.getAllByRole("button", { name: /Older launch/ })).toHaveLength(
    1,
  );
  fireEvent.click(screen.getByText("Technical details"));
  expect(
    within(screen.getByRole("complementary")).getByText("event-2"),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /Older launch/ }));
  expect(
    within(screen.getByRole("complementary")).getByText("older-1"),
  ).not.toBeVisible();
  fireEvent.click(screen.getByText("Technical details"));
  expect(
    within(screen.getByRole("complementary")).getByText("older-1"),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Load older events" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "What is monitored" }));
  expect(screen.getByText("Agent tool use · No records yet")).toBeVisible();
  respond(snapshot);
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByRole("button", { name: "Refresh" });
  fireEvent.click(screen.getByRole("button", { name: "History" }));
  expect(
    screen.queryByRole("button", { name: /Older launch/ }),
  ).not.toBeInTheDocument();
  expect(global.fetch).toHaveBeenLastCalledWith(
    "/api/activity?days=30&limit=100",
    expect.any(Object),
  );
});

it("preserves loaded events and cursor after a pagination error", async () => {
  respond({
    ...snapshot,
    truncated: true,
    nextCursor: "retry-cursor",
  } as typeof snapshot);
  render(<ActivityObservatory />);
  await screen.findByRole("button", { name: /Agent started/ });
  (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: false, status: 503 });
  fireEvent.click(screen.getByRole("button", { name: "Load older events" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Your loaded events are preserved",
  );
  expect(screen.getByRole("button", { name: /Agent started/ })).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Load older events" }),
  ).toBeEnabled();
  expect(
    screen.getByText(/Search and filters only cover these records/),
  ).toBeVisible();
});

it("retains a failed source and retry cursor when an older page is degraded", async () => {
  respond({
    ...snapshot,
    truncated: true,
    nextCursor: "retry-cursor",
  } as typeof snapshot);
  render(<ActivityObservatory />);
  await screen.findByRole("button", { name: /Agent started/ });
  respond({
    ...snapshot,
    events: [],
    degraded: true,
    sources: [
      { ...snapshot.sources[0], state: "degraded", detail: "Read failed." },
    ],
  });
  fireEvent.click(screen.getByRole("button", { name: "Load older events" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "retry this page to fill the gap",
  );
  expect(
    screen.getByRole("button", { name: "Load older events" }),
  ).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "What is monitored" }));
  expect(screen.getByText("Unable to load")).toBeVisible();
  fireEvent.click(screen.getAllByText("Technical source details")[0]);
  expect(screen.getByText("Read failed.")).toBeVisible();
});

it("explains desktop authorization without inventing a connection or actor", async () => {
  respond({
    ...snapshot,
    events: [
      {
        ...snapshot.events[0],
        kind: "desktop_session",
        title: "Desktop control session",
        computerId: "computer-123",
      },
    ],
  } as typeof snapshot);
  render(<ActivityObservatory />);
  await screen.findByRole("button", { name: /Desktop access allowed/ });
  const inspector = within(screen.getByRole("complementary"));
  expect(
    inspector.getByText(/does not confirm that anyone connected/),
  ).toBeVisible();
  expect(
    inspector.getByText(/routine access history, not an alert/),
  ).toBeVisible();
  expect(inspector.getByText("Recorded", { exact: true })).toBeVisible();
  expect(inspector.getByText("unknown", { exact: true })).not.toBeVisible();
  expect(inspector.getByText("computer-123")).not.toBeVisible();
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "Desktop access allowed" },
  });
  expect(
    screen.getByRole("button", { name: /Desktop access allowed/ }),
  ).toBeVisible();
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "computer-123" },
  });
  expect(
    screen.getByRole("button", { name: /Desktop access allowed/ }),
  ).toBeVisible();
});

it("provides failure guidance and scopes the attention count to loaded records", async () => {
  render(<ActivityObservatory />);
  await screen.findByRole("button", { name: /Agent action reported/ });
  fireEvent.click(screen.getByRole("button", { name: /Needs attention/ }));
  const inspector = within(screen.getByRole("complementary"));
  expect(inspector.getByText("What to do")).toBeVisible();
  expect(
    inspector.getByText(
      /Open the agent or computer to check its current state/,
    ),
  ).toBeVisible();
  expect(screen.getByText(/count covers loaded records/)).toBeVisible();
  expect(inspector.getByText("Reported a problem")).toBeVisible();
});

it("distinguishes a reported successful action from overall task completion", async () => {
  respond({
    ...snapshot,
    events: [
      {
        ...snapshot.events[1],
        outcome: "success",
        severity: "info",
        needsAttention: false,
      },
    ],
  });
  render(<ActivityObservatory />);
  await screen.findByRole("button", { name: /Reported successful/ });
  expect(
    within(screen.getByRole("complementary")).getByText("Reported successful"),
  ).toBeVisible();
  expect(
    screen.getByText(/does not confirm that its overall task is complete/),
  ).toBeVisible();
});

it("distinguishes readable sources from capabilities with actual records", async () => {
  respond({
    ...snapshot,
    events: [],
    resources: [
      {
        ...snapshot.resources[0],
        capabilities: [
          { key: "lifecycle", label: "Lifecycle", state: "observed" },
        ],
      },
    ],
  });
  render(<ActivityObservatory />);
  await screen.findByRole("button", { name: "Monitoring limits" });
  fireEvent.click(screen.getByRole("button", { name: "What is monitored" }));
  expect(screen.getByText("Available to read", { exact: true })).toBeVisible();
  expect(
    screen.getByText("Computer changes · Records available"),
  ).toBeVisible();
  expect(
    screen.getByText(/there may be no records in the last 30 days/),
  ).toBeVisible();
});

it("does not present an unconfirmed resource list as a healthy empty list", async () => {
  respond({ ...snapshot, resources: [], degraded: true });
  render(<ActivityObservatory />);
  await screen.findByRole("button", {
    name: "Some records could not be loaded",
  });
  fireEvent.click(screen.getByRole("button", { name: "What is monitored" }));
  expect(
    screen.getByText(
      "The list of computers and agents could not be confirmed. Refresh to try again.",
    ),
  ).toBeVisible();
  expect(
    screen.queryByText(
      "No computers or agents were returned by the available history.",
    ),
  ).not.toBeInTheDocument();
});

it.each<[ActivityEventKind, string]>([
  ["trace_span", "Agent action reported"],
  ["tool_activity", "Agent tool used"],
])(
  "keeps raw %s operation titles in optional technical details",
  async (kind, title) => {
    respond({
      ...snapshot,
      events: [{ ...snapshot.events[1], kind, title: "tool.call operation" }],
    });
    render(<ActivityObservatory />);
    await screen.findByRole("button", { name: new RegExp(title) });
    expect(screen.getByText("tool.call operation")).not.toBeVisible();
    fireEvent.click(screen.getByText("Technical details"));
    expect(screen.getByText("tool.call operation")).toBeVisible();
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "tool.call operation" },
    });
    expect(
      screen.getByRole("button", { name: new RegExp(title) }),
    ).toBeVisible();
  },
);
