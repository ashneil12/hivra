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
// Activity opens on Needs you whenever something needs the person, so tests
// about the timeline pick History first.
async function renderHistory(ui: React.ReactElement) {
  const view = render(ui);
  fireEvent.click(screen.getByRole("button", { name: "History" }));
  return view;
}
beforeEach(() => {
  global.fetch = jest.fn();
  respond();
});

it("inspects real evidence and source provenance and filters without inventing controls", async () => {
  await renderHistory(<ActivityObservatory />);
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
  await renderHistory(<ActivityObservatory />);
  await screen.findByRole("button", { name: /Agent started/ });
  fireEvent.click(screen.getByRole("button", { name: /Needs you/ }));
  expect(
    screen.queryByRole("button", { name: /Agent started/ }),
  ).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Filter by agent")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "History" }));
  fireEvent.change(screen.getByLabelText("Filter by agent"), {
    target: { value: "a1" },
  });
  fireEvent.change(screen.getByLabelText("Filter by kind"), {
    target: { value: "trace_span" },
  });
  expect(screen.getByText(/No recorded events match/)).toBeVisible();
  expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
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
it("explains what Hivra keeps a record of without technical details, and keeps usage opt-in", async () => {
  await renderHistory(<ActivityObservatory />);
  await screen.findByText(/Last updated/);
  expect(screen.queryByText("Metered usage panel")).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("Sources"));
  expect(screen.getByText(/Missing reports do not tell us/)).toBeVisible();
  expect(screen.queryByText("Technical source details")).not.toBeInTheDocument();
  expect(
    screen.queryByText("Independent process monitoring is not connected."),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Usage" }));
  expect(screen.getByText("Metered usage panel")).toBeVisible();
});
it("does not interpret degraded empty results as no activity", async () => {
  respond({ ...snapshot, events: [], degraded: true, truncated: true });
  await renderHistory(<ActivityObservatory showUsage={false} />);
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
  await renderHistory(<ActivityObservatory />);
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
  await renderHistory(<ActivityObservatory />);
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
    await renderHistory(<ActivityObservatory />);
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
    await renderHistory(<ActivityObservatory />);
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
    await renderHistory(<ActivityObservatory />);
    const started = await screen.findByRole("button", { name: /Agent started/ });
    fireEvent.click(started);
    expect(scroll).toHaveBeenCalledTimes(1);

    // The open record leaves the list and comes back with its detail still
    // open; the page stays where the user is working.
    fireEvent.click(screen.getByRole("button", { name: /Needs you/ }));
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
    await renderHistory(<ActivityObservatory />);
    await screen.findByRole("button", { name: /Agent started/ });
    const help = screen.getByText(/This is your saved history/);
    expect(help).not.toBeVisible();
    fireEvent.click(screen.getByText("About this view"));
    expect(help).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Runs" }));
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
  await renderHistory(<ActivityObservatory />);
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
  await renderHistory(<ActivityObservatory />);
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
  await renderHistory(<ActivityObservatory />);
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
  fireEvent.click(screen.getByText("Sources"));
  expect(screen.getByText("Unable to load")).toBeVisible();
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
  await renderHistory(<ActivityObservatory />);
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

it("opens on Needs you with a plain sentence and one Open action per flagged record", async () => {
  render(<ActivityObservatory />);
  await screen.findByText(/Last updated/);
  expect(screen.getByRole("button", { name: /Needs you/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(screen.getByRole("button", { name: "History" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  const list = within(screen.getByRole("region", { name: "Needs you" }));
  expect(list.getByText(/Researcher: /)).toBeVisible();
  expect(list.getByText("Reported a problem")).toBeVisible();
  expect(list.getByRole("link", { name: "Open Researcher" })).toHaveAttribute(
    "href",
    "/dashboard/agent/a2",
  );
  expect(screen.queryByLabelText("Filter by agent")).not.toBeInTheDocument();
  expect(screen.queryByText(/Agent started/)).not.toBeInTheDocument();
});

it("hides the Needs you tab, and opens History, when nothing needs the person", async () => {
  respond({
    ...snapshot,
    events: [snapshot.events[0]],
    resources: [tracingResource("c1", "Healthy box", "running", { state: "observed" })],
  });
  render(<ActivityObservatory />);
  expect(await screen.findByRole("button", { name: /Agent started/ })).toBeVisible();
  expect(screen.queryByRole("button", { name: /Needs you/ })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "History" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(screen.getByRole("button", { name: "Runs" })).toBeVisible();
  expect(screen.queryByText(/Monitoring limits|observatory|telemetry/i)).not.toBeInTheDocument();
});

it("says a computer stopped reporting, with a relative time and an Open action", async () => {
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
  await screen.findByText(/Last updated/);
  // One flagged record plus two reporting gaps.
  expect(screen.getByRole("button", { name: /Needs you/ })).toHaveTextContent("Needs you3");
  const list = within(screen.getByRole("region", { name: "Needs you" }));
  expect(list.getByText("Stale box stopped reporting 30 minutes ago")).toBeVisible();
  expect(list.getByText(/^Expired box stopped reporting/)).toBeVisible();
  expect(list.getByRole("link", { name: "Open Stale box" })).toHaveAttribute(
    "href",
    "/dashboard/agent/c1",
  );
  expect(list.queryByText(/Stopped box|Healthy box/)).not.toBeInTheDocument();
});

it("keeps Sources collapsed at the bottom of History and explains it in plain words", async () => {
  respond({
    ...snapshot,
    resources: [
      {
        ...tracingResource("c1", "Codex box", "running", { state: "observed" }),
        lastSeenAt: "2026-09-21T11:58:00Z",
      },
    ],
  });
  await renderHistory(<ActivityObservatory />);
  await screen.findByText(/Last updated/);
  expect(screen.getByText("What Hivra keeps a record of")).not.toBeVisible();
  fireEvent.click(screen.getByText("Sources"));
  expect(screen.getByText("What Hivra keeps a record of")).toBeVisible();
  expect(screen.getByText("Last reported 2 minutes ago")).toBeVisible();
  expect(screen.queryByText("c1")).not.toBeInTheDocument();
  expect(screen.queryByText("Technical source details")).not.toBeInTheDocument();
});

it("states why each computer is or is not reporting, in plain words", async () => {
  respond({
    ...snapshot,
    resources: [
      tracingResource("m1", "Legacy box", "running", { state: "missing", reason: "not_set_up" }),
      tracingResource("m3", "Failed box", "running", {
        state: "missing",
        reason: "install_failed",
        installFailedAt: "2026-09-21T11:01:00Z",
        installFailureReason: "transfer_failed",
      }),
      tracingResource("x1", "Reissued box", "running", {
        state: "expired",
        reason: "expired_credential_presented",
        issuedAt: "2026-09-21T11:30:00Z",
        expiresAt: "2026-09-28T11:30:00Z",
        lastSeenAt: "2026-09-19T10:00:00Z",
      }),
      { id: "p1", name: "Provider box", agentType: "claude-code", status: "running", capabilities: [{ key: "native_tracing", label: "Agent run reporting", state: "unsupported", reason: "substrate" }] },
    ],
  });
  await renderHistory(<ActivityObservatory />);
  await screen.findByText(/Last updated/);
  fireEvent.click(screen.getByText("Sources"));
  expect(screen.getByText("Not set up")).toBeVisible();
  expect(screen.getByText("Reporter could not be installed")).toBeVisible();
  expect(screen.getByText("Reporting credential expired")).toBeVisible();
  expect(screen.getByText("Not available on this host type")).toBeVisible();
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
  await renderHistory(<ActivityObservatory />);
  await screen.findByRole("button", { name: /Reported successful/ });
  expect(
    within(screen.getByRole("complementary")).getByText("Reported successful"),
  ).toBeVisible();
  expect(
    screen.getByText(/does not confirm that its overall task is complete/),
  ).toBeVisible();
});

it("distinguishes readable sources from capabilities with actual records", async () => {
  respond({ ...snapshot, events: [] });
  await renderHistory(<ActivityObservatory />);
  await screen.findByText(/Last updated/);
  fireEvent.click(screen.getByText("Sources"));
  expect(screen.getByText("Available to read", { exact: true })).toBeVisible();
});

it("does not present an unconfirmed resource list as a healthy empty list", async () => {
  respond({ ...snapshot, resources: [], degraded: true });
  await renderHistory(<ActivityObservatory />);
  await screen.findByText(/Some records could not be loaded/);
  expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
  fireEvent.click(screen.getByText("Sources"));
  expect(
    screen.getByText(
      "No computers or agents are shown. Some information could not be loaded; try again.",
    ),
  ).toBeVisible();
  expect(
    screen.queryByText(
      "No computers or agents have reported yet.",
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
    await renderHistory(<ActivityObservatory />);
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
  await renderHistory(<ActivityObservatory />);
  await screen.findByRole("button", { name: "Runs" });
  await screen.findByText(/Last updated/);
  fireEvent.click(screen.getByRole("button", { name: "Runs" }));
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
  await renderHistory(<ActivityObservatory />);
  await screen.findByText(/Last updated/);
  fireEvent.click(screen.getByRole("button", { name: "Runs" }));
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
  await renderHistory(<ActivityObservatory />);
  await screen.findByRole("button", { name: /Tool Bash reported an error/ });
  expect(screen.queryByRole("button", { name: /Needs you/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Tool Bash reported an error/ }));
  const inspector = within(screen.getByRole("complementary", { name: "Event inspector" }));
  expect(inspector.getByText(/Agents often recover from tool errors/)).toBeVisible();
  fireEvent.click(inspector.getByText("Technical details"));
  expect(inspector.getByText("tool.failed")).toBeVisible();
  expect(inspector.getByText("Claude Code")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Runs" }));
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
  await renderHistory(<ActivityObservatory />);
  await screen.findByText(/Last updated/);
  fireEvent.click(screen.getByRole("button", { name: "Runs" }));
  const run = within(screen.getByRole("article", { name: "Researcher Codex run" }));
  expect(run.getByText(note)).toBeVisible();
  if (offered) expect(screen.getByRole("button", { name: "Load older events" })).toBeVisible();
  else {
    expect(screen.queryByText(/load older events/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load older events" })).not.toBeInTheDocument();
  }
});
