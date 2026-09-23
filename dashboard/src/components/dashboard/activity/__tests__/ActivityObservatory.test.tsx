/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { ActivityObservatory } from "../ActivityObservatory";
import type {
  ActivitySnapshot,
  ActivityEventKind,
} from "@/lib/activity-observability/types";

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
      capabilities: [
        { key: "tool_activity", label: "Agent tools", state: "missing" },
      ],
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

function withNarrowScreen(run: (scroll: jest.Mock) => Promise<void>) {
  return async () => {
    const scroll = jest.fn();
    const originalMedia = window.matchMedia;
    const originalScroll = HTMLElement.prototype.scrollIntoView;
    window.matchMedia = jest.fn().mockReturnValue({ matches: true });
    HTMLElement.prototype.scrollIntoView = scroll;
    try {
      await run(scroll);
    } finally {
      window.matchMedia = originalMedia;
      HTMLElement.prototype.scrollIntoView = originalScroll;
    }
  };
}

it(
  "opens the tapped record in place on a narrow screen and keeps it in view",
  withNarrowScreen(async (scroll) => {
    render(<ActivityObservatory />);
    const started = await screen.findByRole("button", { name: /Agent started/ });
    // No record is opened for the user; the list comes first.
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(scroll).not.toHaveBeenCalled();
    const action = screen.getByRole("button", {
      name: /Agent action reported/,
    });
    fireEvent.click(action);
    const inspector = screen.getByRole("complementary", {
      name: "Event inspector",
    });
    // Inline, directly under the tapped record, and the only inspector.
    expect(action.nextElementSibling).toBe(inspector);
    expect(screen.getAllByRole("complementary")).toHaveLength(1);
    expect(action).toHaveAttribute("aria-expanded", "true");
    expect(started).toHaveAttribute("aria-expanded", "false");
    expect(scroll).toHaveBeenCalledWith({
      block: "nearest",
      behavior: "instant",
    });
    expect(scroll.mock.instances.at(-1)).toBe(action);
    fireEvent.click(started);
    expect(started.nextElementSibling).toBe(
      screen.getByRole("complementary", { name: "Event inspector" }),
    );
    expect(action.nextElementSibling).not.toBe(
      screen.getByRole("complementary"),
    );
    fireEvent.click(started);
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(started).toHaveAttribute("aria-expanded", "false");
  }),
);

it(
  "brings a tapped record to the top when its detail would open below the fold",
  withNarrowScreen(async (scroll) => {
    render(<ActivityObservatory />);
    const started = await screen.findByRole("button", { name: /Agent started/ });
    const rect = jest
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        const inspector = this.tagName === "ASIDE";
        return {
          top: inspector ? 591 : 468,
          bottom: inspector ? window.innerHeight + 400 : 591,
          left: 0,
          right: 375,
          width: 375,
          height: inspector ? 459 : 123,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        } as DOMRect;
      });
    try {
      fireEvent.click(started);
      expect(scroll).toHaveBeenLastCalledWith({
        block: "start",
        behavior: "instant",
      });
      expect(scroll.mock.instances.at(-1)).toBe(started);
    } finally {
      rect.mockRestore();
    }
  }),
);

it(
  "scrolls only for a tap, not when an open record returns after a view or search change",
  withNarrowScreen(async (scroll) => {
    render(<ActivityObservatory />);
    const started = await screen.findByRole("button", { name: /Agent started/ });
    fireEvent.click(started);
    expect(scroll).toHaveBeenCalledTimes(1);

    // The open record leaves the list and comes back with its detail still
    // open; the page stays where the user is working.
    fireEvent.click(screen.getByRole("button", { name: /Needs attention/ }));
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    expect(
      screen.getByRole("button", { name: /Agent started/ }).nextElementSibling,
    ).toBe(screen.getByRole("complementary", { name: "Event inspector" }));

    const search = screen.getByRole("searchbox", {
      name: "Search recorded events",
    });
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    fireEvent.change(search, { target: { value: "" } });
    expect(screen.getByRole("complementary")).toBeInTheDocument();
    expect(scroll).toHaveBeenCalledTimes(1);

    // A new tap still brings its record into view.
    fireEvent.click(
      screen.getByRole("button", { name: /Agent action reported/ }),
    );
    expect(scroll).toHaveBeenCalledTimes(2);
  }),
);

it(
  "folds view guidance into a collapsed disclosure on a narrow screen",
  withNarrowScreen(async () => {
    render(<ActivityObservatory />);
    await screen.findByRole("button", { name: /Agent started/ });
    const help = screen.getByText(/This is your saved history/);
    expect(help).not.toBeVisible();
    fireEvent.click(screen.getByText("About this view"));
    expect(help).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Agent runs" }));
    expect(screen.getByText(/not an audit of the computer/)).toBeVisible();
    expect(
      within(screen.getByRole("region", { name: "Agent runs" })).queryByText(
        /not an audit of the computer/,
      ),
    ).not.toBeInTheDocument();
  }),
);

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
      "No computers or agents are shown. Some information could not be loaded; refresh to try again.",
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

it("shows bounded run steps and lets a step open its original evidence", async () => {
  respond({
    ...snapshot,
    truncated: true,
    events: [
      {
        ...snapshot.events[1],
        id: "step-later",
        runId: "run-123",
        occurredAt: "2026-09-21T12:00:00Z",
        evidence: [
          { label: "Tool", value: "shell" },
          { label: "Duration (ms)", value: "80" },
        ],
      },
      {
        ...snapshot.events[1],
        id: "step-earlier",
        runId: "run-123",
        occurredAt: "2026-09-21T11:00:00Z",
        outcome: "unknown",
        severity: "info",
        needsAttention: false,
        evidence: [],
      },
      {
        ...snapshot.events[1],
        id: "ungrouped",
        runId: undefined,
        traceId: undefined,
      },
    ],
  });
  render(<ActivityObservatory />);
  await screen.findByRole("button", { name: "Agent runs" });
  await screen.findByRole("button", { name: "Monitoring limits" });
  fireEvent.click(screen.getByRole("button", { name: "Agent runs" }));
  const runs = within(
    screen.getByRole("region", { name: "Agent runs" }),
  );
  expect(runs.getByText(/not a complete account of a run/)).toBeVisible();
  expect(
    runs.getByText(/Some records are missing or outside this view/),
  ).toBeVisible();
  expect(runs.getByText("A step reported a problem")).toBeVisible();
  expect(runs.getByText("80 ms reported")).toBeVisible();
  expect(runs.getByText("Reports without a linked run")).toBeVisible();
  expect(runs.getByText("run-123")).not.toBeVisible();
  fireEvent.click(runs.getByRole("button", { name: /Tool: shell/ }));
  const inspector = within(
    screen.getByRole("complementary", { name: "Event inspector" }),
  );
  fireEvent.click(inspector.getByText("Technical details"));
  expect(inspector.getByText("step-later")).toBeVisible();
  expect(inspector.getByText("shell")).toBeVisible();
});

it("does not present successful or unknown steps as a completed run", async () => {
  respond({
    ...snapshot,
    events: [
      {
        ...snapshot.events[1],
        runId: "run",
        outcome: "success",
        severity: "info",
        needsAttention: false,
      },
    ],
  });
  render(<ActivityObservatory />);
  await screen.findByRole("button", { name: "Monitoring limits" });
  fireEvent.click(screen.getByRole("button", { name: "Agent runs" }));
  expect(screen.getByText("Final result not confirmed")).toBeVisible();
  expect(
    within(
      screen.getByRole("region", { name: "Agent runs" }),
    ).getByText("Reported successful"),
  ).toBeVisible();
});

const tracingResource = (
  id: string,
  name: string,
  status: string,
  capability: Partial<ActivitySnapshot["resources"][number]["capabilities"][number]>,
): ActivitySnapshot["resources"][number] => ({
  id,
  name,
  agentType: "codex",
  status,
  capabilities: [
    { key: "lifecycle", label: "Lifecycle", state: "observed" },
    { key: "native_tracing", label: "Agent run reporting", state: "observed", ...capability },
  ],
});

it("shows agent run reporting per computer with its check-in, credential and an honest explanation", async () => {
  respond({
    ...snapshot,
    resources: [
      tracingResource("c1", "Codex box", "running", {
        state: "observed",
        lastSeenAt: "2026-09-21T11:58:00Z",
        expiresAt: "2026-09-25T12:00:00Z",
      }),
      tracingResource("c2", "Old box", "running", { state: "missing" }),
      tracingResource("c3", "Paused box", "stopped", { state: "not_running", lastSeenAt: "2026-09-20T10:00:00Z" }),
      tracingResource("c4", "Expired box", "running", {
        state: "expired",
        lastSeenAt: "2026-09-19T10:00:00Z",
        expiresAt: "2026-09-20T10:00:00Z",
      }),
      { id: "c5", name: "Desktop box", agentType: "linux-desktop", status: "running", capabilities: [{ key: "native_tracing", label: "Agent run reporting", state: "unsupported" }] },
    ],
    sources: [
      ...snapshot.sources,
      { id: "agent-tracing", label: "Agent run reporting", state: "stale", detail: "1 of 3 running Codex/Claude Code computers reporting." },
    ],
  });
  render(<ActivityObservatory />);
  await screen.findByRole("button", { name: "Monitoring limits" });
  fireEvent.click(screen.getByRole("button", { name: "What is monitored" }));
  const coverage = within(screen.getByRole("region", { name: "Monitoring coverage" }));
  expect(coverage.getByText(/not proof that nothing happened/)).toBeVisible();
  expect(coverage.getByText(/some of its runs may be missing/)).toBeVisible();
  expect(coverage.getByText("Reporting")).toBeVisible();
  expect(coverage.getByText(/Reporter last checked in: Sep 21, 2026/)).toBeVisible();
  expect(coverage.getByText(/Reporting credential valid until Sep 25, 2026/)).toBeVisible();
  // A computer with no collector row predates reporting: it was never set up.
  expect(coverage.getByText("Not set up")).toBeVisible();
  expect(coverage.getByText(/get it when they are restarted after their host is updated/)).toBeVisible();
  expect(coverage.getByText("Agent not running")).toBeVisible();
  expect(coverage.getByText("Stopped; no reports expected until it starts again.")).toBeVisible();
  expect(coverage.getAllByText("Reporting credential expired").length).toBeGreaterThan(0);
  expect(coverage.getByText(/Reporting credential expired Sep 20, 2026/)).toBeVisible();
  expect(coverage.getByText("Not available for this agent")).toBeVisible();
  expect(coverage.getByText(/Claude Code and Codex computers only/)).toBeVisible();
  // The history capabilities keep their chips; run reporting is not repeated as a chip.
  expect(coverage.getAllByText("Computer changes · Records available")).toHaveLength(4);
  expect(coverage.queryByText(/Agent run reporting ·/)).not.toBeInTheDocument();
});

it("tells a computer that was never set up apart from one set up but silent and one whose reporter could not be installed", async () => {
  respond({
    ...snapshot,
    resources: [
      tracingResource("m1", "Legacy box", "running", { state: "missing", reason: "not_set_up" }),
      tracingResource("m2", "Silent box", "running", {
        state: "missing",
        reason: "never_checked_in",
        issuedAt: "2026-09-21T10:00:00Z",
        expiresAt: "2026-09-28T10:00:00Z",
      }),
      tracingResource("m3", "Failed box", "running", {
        state: "missing",
        reason: "install_failed",
        issuedAt: "2026-09-21T11:00:00Z",
        installFailedAt: "2026-09-21T11:01:00Z",
        installFailureReason: "transfer_failed",
      }),
    ],
  });
  render(<ActivityObservatory />);
  await screen.findByRole("button", { name: "Monitoring limits" });
  fireEvent.click(screen.getByRole("button", { name: "What is monitored" }));
  const coverage = within(screen.getByRole("region", { name: "Monitoring coverage" }));
  const row = (name: string) =>
    within(coverage.getByText(name, { selector: "strong" }).closest("div")!.parentElement!);
  const legacy = row("Legacy box");
  expect(legacy.getByText("Not set up")).toBeVisible();
  expect(legacy.getByText(/has not been set up on this computer/)).toBeVisible();
  expect(legacy.queryByText(/Reporting set up/)).not.toBeInTheDocument();
  const silent = row("Silent box");
  expect(silent.getByText("No reports received")).toBeVisible();
  expect(silent.getByText(/Reporting was set up, but the reporter has never checked in/)).toBeVisible();
  expect(silent.getByText(/Reporting set up Sep 21, 2026/)).toBeVisible();
  expect(silent.queryByText(/launched before automatic reporting/)).not.toBeInTheDocument();
  const failed = row("Failed box");
  expect(failed.getByText("Reporter could not be installed")).toBeVisible();
  expect(failed.getByText(/could not be installed, so runs on this computer are not being recorded/)).toBeVisible();
  expect(failed.getByText(/Last install attempt failed Sep 21, 2026.*: it could not be copied to the computer/)).toBeVisible();
  expect(failed.queryByText(/launched before automatic reporting/)).not.toBeInTheDocument();
});

it("names the host type when Claude Code or Codex runs where reporting is not supported", async () => {
  respond({
    ...snapshot,
    resources: [
      { id: "p1", name: "Provider box", agentType: "claude-code", status: "running", capabilities: [{ key: "native_tracing", label: "Agent run reporting", state: "unsupported", reason: "substrate" }] },
    ],
    sources: [
      ...snapshot.sources,
      { id: "agent-tracing", label: "Agent run reporting", state: "missing", detail: "Available for Claude Code and Codex computers on Hivra hosts." },
    ],
  });
  render(<ActivityObservatory />);
  await screen.findByRole("button", { name: "Monitoring limits" });
  fireEvent.click(screen.getByRole("button", { name: "What is monitored" }));
  const coverage = within(screen.getByRole("region", { name: "Monitoring coverage" }));
  expect(coverage.getByText("Not available on this host type")).toBeVisible();
  expect(coverage.getByText(/this computer’s host type isn’t supported yet/)).toBeVisible();
  expect(coverage.getByText(/Your Claude Code or Codex computers run on a host type that isn’t supported yet/)).toBeVisible();
  expect(coverage.queryByText(/computers only/)).not.toBeInTheDocument();
  expect(coverage.queryByText(/No running Claude Code or Codex computer is reporting/)).not.toBeInTheDocument();
});

it("words an expired credential presented after a re-issue without claiming the valid one is in use", async () => {
  respond({
    ...snapshot,
    resources: [
      tracingResource("x1", "Reissued box", "running", {
        state: "expired",
        reason: "expired_credential_presented",
        issuedAt: "2026-09-21T11:30:00Z",
        expiresAt: "2026-09-28T11:30:00Z",
        lastSeenAt: "2026-09-19T10:00:00Z",
      }),
    ],
  });
  render(<ActivityObservatory />);
  await screen.findByRole("button", { name: "Monitoring limits" });
  fireEvent.click(screen.getByRole("button", { name: "What is monitored" }));
  const coverage = within(screen.getByRole("region", { name: "Monitoring coverage" }));
  expect(coverage.getByText("Reporting credential expired")).toBeVisible();
  expect(coverage.getByText(/presented an expired reporting credential after its latest one was issued/)).toBeVisible();
  expect(coverage.getByText(/New reporting credential issued Sep 21, 2026.*the computer has not checked in with it/)).toBeVisible();
  expect(coverage.queryByText(/valid until/)).not.toBeInTheDocument();
});

it("says how many attention items the search and filters hide, and clearing them shows every item the badge counts", async () => {
  respond({
    ...snapshot,
    resources: [
      tracingResource("c1", "Stale box", "running", { state: "stale", lastSeenAt: "2026-09-21T11:30:00Z" }),
    ],
  });
  render(<ActivityObservatory />);
  await screen.findByRole("button", { name: /Agent started/ });
  // One flagged record plus one reporting gap.
  expect(screen.getByRole("button", { name: /Needs attention/ })).toHaveTextContent("Needs attention2");
  fireEvent.click(screen.getByRole("button", { name: /Needs attention/ }));
  expect(screen.queryByText(/hidden by your search or filters/)).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Stale box" } });
  expect(screen.getByRole("region", { name: "Reporting gaps" })).toBeVisible();
  expect(screen.getByText(/No recorded events match/)).toBeVisible();
  expect(screen.getByText(/1 item needs attention but is hidden by your search or filters/)).toBeVisible();
  fireEvent.change(screen.getByLabelText("Filter by kind"), { target: { value: "trace_span" } });
  expect(screen.queryByRole("region", { name: "Reporting gaps" })).not.toBeInTheDocument();
  expect(screen.getByText(/2 items need attention but are hidden by your search or filters/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Clear search and filters" }));
  expect(screen.queryByText(/hidden by your search or filters/)).not.toBeInTheDocument();
  expect(screen.getByRole("region", { name: "Reporting gaps" })).toBeVisible();
  expect(
    within(screen.getByRole("region", { name: "Recorded events" })).getAllByRole("button"),
  ).toHaveLength(1);
  expect(screen.getByRole("button", { name: /Needs attention/ })).toHaveTextContent("Needs attention2");
});

it("raises reporting gaps on running computers in Needs attention and counts them in the badge", async () => {
  respond({
    ...snapshot,
    resources: [
      tracingResource("c1", "Stale box", "running", { state: "stale", lastSeenAt: "2026-09-21T11:30:00Z" }),
      tracingResource("c2", "Expired box", "running", { state: "expired", expiresAt: "2026-09-20T10:00:00Z" }),
      tracingResource("c3", "Stopped box", "stopped", { state: "not_running" }),
      tracingResource("c4", "Healthy box", "running", { state: "observed" }),
    ],
  });
  render(<ActivityObservatory />);
  await screen.findByRole("button", { name: /Agent started/ });
  // One flagged record plus two reporting gaps.
  expect(screen.getByRole("button", { name: /Needs attention/ })).toHaveTextContent("Needs attention3");
  fireEvent.click(screen.getByRole("button", { name: /Needs attention/ }));
  const gaps = within(screen.getByRole("region", { name: "Reporting gaps" }));
  expect(gaps.getByText("Stale box: run reporting stopped checking in")).toBeVisible();
  expect(gaps.getByText(/Hasn’t checked in for 15\+ min while running/)).toBeVisible();
  expect(gaps.getByText("Expired box: run reporting credential expired")).toBeVisible();
  expect(gaps.getByText(/Reporter last checked in: No check-in received/)).toBeVisible();
  expect(gaps.queryByText(/Stopped box|Healthy box/)).not.toBeInTheDocument();
  // Gaps are not recorded events; the event list still holds only flagged records.
  expect(
    within(screen.getByRole("region", { name: "Recorded events" })).getAllByRole("button"),
  ).toHaveLength(1);
  fireEvent.change(screen.getByLabelText("Filter by agent"), { target: { value: "a1" } });
  expect(screen.queryByRole("region", { name: "Reporting gaps" })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Filter by agent"), { target: { value: "all" } });
  fireEvent.click(screen.getByRole("button", { name: "See what is monitored" }));
  expect(screen.getByRole("region", { name: "Monitoring coverage" })).toBeVisible();
});

it("does not show a reporting gap or badge when every running computer is reporting", async () => {
  respond({
    ...snapshot,
    events: [snapshot.events[0]],
    resources: [tracingResource("c1", "Healthy box", "running", { state: "observed" })],
  });
  render(<ActivityObservatory />);
  await screen.findByRole("button", { name: /Agent started/ });
  expect(screen.getByRole("button", { name: /Needs attention/ })).toHaveTextContent(/^Needs attention$/);
  fireEvent.click(screen.getByRole("button", { name: /Needs attention/ }));
  expect(screen.queryByRole("region", { name: "Reporting gaps" })).not.toBeInTheDocument();
});

it("shows a native run's status and steps, and a tool error as a warning that is not an alert", async () => {
  const base = {
    kind: "tool_activity" as const,
    agentId: "a2",
    agentName: "Researcher",
    title: "Agent activity",
    summary: "Report",
    source: { kind: "otlp_log" as const, label: "OpenTelemetry agent log" },
    evidence: [],
    runId: "turn-9",
    traceId: "c".repeat(32),
    producer: "claude-code" as const,
    conversationId: "session-9",
    outcome: "unknown" as const,
    severity: "info" as const,
    needsAttention: false,
  };
  respond({
    ...snapshot,
    events: [
      { ...base, id: "end", role: "run.completed", occurredAt: "2026-09-21T11:40:05Z", spanId: "1".repeat(16), outcome: "success", durationMs: 5000 },
      { ...base, id: "tool-end", role: "tool.failed", occurredAt: "2026-09-21T11:40:02Z", spanId: "2".repeat(16), toolName: "Bash", outcome: "failure", severity: "warning" },
      { ...base, id: "tool-start", role: "tool.started", occurredAt: "2026-09-21T11:40:01Z", spanId: "2".repeat(16), toolName: "Bash" },
      { ...base, id: "start", role: "run.started", occurredAt: "2026-09-21T11:40:00Z", spanId: "1".repeat(16) },
    ],
  });
  render(<ActivityObservatory />);
  await screen.findByRole("button", { name: /Tool Bash reported an error/ });
  expect(screen.getByRole("button", { name: /Needs attention/ })).toHaveTextContent(/^Needs attention$/);
  fireEvent.click(screen.getByRole("button", { name: /Tool Bash reported an error/ }));
  const inspector = within(screen.getByRole("complementary", { name: "Event inspector" }));
  expect(inspector.getByText(/Agents often recover from tool errors/)).toBeVisible();
  fireEvent.click(inspector.getByText("Technical details"));
  expect(inspector.getByText("tool.failed")).toBeVisible();
  expect(inspector.getByText("Claude Code")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Agent runs" }));
  const run = within(screen.getByRole("article", { name: "Researcher Claude Code run" }));
  expect(run.getByText("Finished in 5.0 s (reported by the agent)")).toBeVisible();
  expect(run.getByText(/1 tool call · 1 tool error/)).toBeVisible();
  expect(run.getByRole("button", { name: /Tool: Bash/ })).toBeVisible();
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Bash" } });
  expect(screen.getByRole("button", { name: /Tool: Bash/ })).toBeVisible();
  // The search chooses the run; its status, start and counts still come from
  // every loaded record, not only the matching tool records.
  const searched = within(screen.getByRole("article", { name: "Researcher Claude Code run" }));
  expect(searched.getByText("Finished in 5.0 s (reported by the agent)")).toBeVisible();
  expect(searched.getByText(/1 tool call · 1 tool error/)).toBeVisible();
  expect(searched.getByText(/^Started/)).toBeVisible();
  expect(searched.queryByText(/No finish reported yet|not in the loaded records|Started before/)).not.toBeInTheDocument();
  expect(searched.getAllByRole("button")).toHaveLength(3);
  expect(screen.getByRole("complementary", { name: "Event inspector" })).toBeVisible();
});

it.each<[string | undefined, RegExp, boolean]>([
  [undefined, /^Its start is not in the loaded records: the run began more than 30 days ago, or its start was never reported\.$/, false],
  ["older-page", /^Started before the loaded records; load older events for earlier steps\.$/, true],
])("offers older events for a run's missing start only when an older page exists (cursor: %s)", async (nextCursor, note, offered) => {
  respond({
    ...snapshot,
    ...(nextCursor ? { nextCursor, truncated: true } : {}),
    events: [
      {
        id: "tool-only",
        kind: "tool_activity",
        role: "tool.started",
        producer: "codex",
        title: "Agent activity",
        summary: "Report",
        agentId: "a2",
        agentName: "Researcher",
        occurredAt: "2026-09-21T11:40:01Z",
        runId: "turn-3",
        spanId: "2".repeat(16),
        toolName: "Read",
        outcome: "unknown",
        severity: "info",
        source: { kind: "otlp_log", label: "OpenTelemetry agent log" },
        evidence: [],
        needsAttention: false,
      },
    ],
  });
  render(<ActivityObservatory />);
  await screen.findByRole("button", { name: "Monitoring limits" });
  fireEvent.click(screen.getByRole("button", { name: "Agent runs" }));
  const run = within(screen.getByRole("article", { name: "Researcher Codex run" }));
  expect(run.getByText(note)).toBeVisible();
  if (offered) expect(screen.getByRole("button", { name: "Load older events" })).toBeVisible();
  else {
    expect(screen.queryByText(/load older events/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load older events" })).not.toBeInTheDocument();
  }
});
