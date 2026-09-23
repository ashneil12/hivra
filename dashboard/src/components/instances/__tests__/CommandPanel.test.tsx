/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { CommandPanel } from "@/components/instances/CommandPanel";

// Composio is mocked ON (with a saved key) so the Apps section renders. Connecting
// an app opens the hosted OAuth directly via composio.launch(slug); we assert it.
const mockLaunch = jest.fn(() => Promise.resolve({ ok: true }));
jest.mock("@/lib/composio/use-composio-connect", () => ({
  useComposioConnect: () => ({ enabled: true, launching: null, launch: mockLaunch }),
  useComposioConnectedApps: () => ({ apps: new Set<string>(), loading: false, refresh: jest.fn() }),
  useComposioKey: () => ({
    enabled: true,
    loading: false,
    hasKey: true,
    keyPreview: "ck_...abc",
    save: jest.fn(),
    remove: jest.fn(),
    refresh: jest.fn(),
  }),
}));

function installFetch(
  state = "idle",
  channelStatuses: Record<string, { configured?: boolean; partial?: boolean }> = {},
) {
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/activity")) {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            data: {
              state,
              headline: "Ready when you are",
              detail: "Send a message in the chat to put your agent to work.",
              lastActiveAt: null,
              activeStreams: 0,
              source: "webui",
              recentSessions: [],
              attentionItems: [],
            },
          }),
      } as unknown as Response);
    }
    if (url.includes("/integrations")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ data: { statuses: channelStatuses } }),
      } as unknown as Response);
    }
    if (url.includes("/composio/catalog")) {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              apps: [
                { slug: "notion", name: "Notion", logo: "", category: "productivity", toolCount: 5 },
                { slug: "gmail", name: "Gmail", logo: "", category: "email", toolCount: 10 },
              ],
              categories: ["email", "productivity"],
            },
          }),
      } as unknown as Response);
    }
    if (url.includes("/composio/connected-apps")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ data: { apps: [] } }),
      } as unknown as Response);
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as unknown as Response);
  }) as unknown as typeof fetch;
}

describe("CommandPanel", () => {
  beforeEach(() => {
    mockLaunch.mockClear();
    window.localStorage.clear();
    installFetch("idle");
  });

  it('shows a calm "Ready" status pill when the agent is idle', async () => {
    render(<CommandPanel instanceId="i1" instanceName="Bea" />);
    await waitFor(() =>
      expect(screen.getByTestId("command-panel-status-pill")).toHaveTextContent("Ready"),
    );
  });

  it('shows an "Active" pill (never a red alarm) when the agent is responding', async () => {
    installFetch("responding");
    render(<CommandPanel instanceId="i1" instanceName="Bea" />);
    await waitFor(() =>
      expect(screen.getByTestId("command-panel-status-pill")).toHaveTextContent("Active"),
    );
  });

  it("brief does NOT promise a workflow shelf when the workflows flag is off (default)", async () => {
    render(<CommandPanel instanceId="i1" instanceName="Bea" />);

    // Flag NEXT_PUBLIC_WORKFLOWS_RUN_ENABLED is unset in tests → shelf hidden →
    // the brief must not point the user at a "workflow below" that isn't rendered.
    // Wait for the settled (post-fetch) brief, not the transient "Catching up…".
    await screen.findByText(
      /waiting for your first task\. Send a message in the chat to get started\./i,
    );
    expect(screen.queryByText(/ready-to-run workflow below/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/kick off a new workflow/i)).not.toBeInTheDocument();
  });

  it("checklist 'Connect a chat channel' opens the channels modal when tapped", async () => {
    const onOpenChannels = jest.fn();
    render(<CommandPanel instanceId="i1" instanceName="Bea" onOpenChannels={onOpenChannels} />);

    const item = await screen.findByTestId("checklist-item:Connect a chat channel");
    fireEvent.click(item);
    expect(onOpenChannels).toHaveBeenCalledTimes(1);
  });

  it("checklist 'Send your first task' injects a starter prompt via onRunWorkflow when tapped", async () => {
    const onRunWorkflow = jest.fn(() => true);
    render(<CommandPanel instanceId="i1" instanceName="Bea" onRunWorkflow={onRunWorkflow} />);

    // Flag is off in tests → no Workflows shelf → the tap takes the inject path.
    const item = await screen.findByTestId("checklist-item:Send your first task");
    expect(item.tagName).toBe("BUTTON");
    fireEvent.click(item);
    expect(onRunWorkflow).toHaveBeenCalledTimes(1);
    expect(onRunWorkflow).toHaveBeenCalledWith(expect.stringContaining("What can you do"));

    // Optimistically completed → the row becomes a passive div, so a second tap
    // can't re-inject the same prompt.
    await waitFor(() =>
      expect(screen.getByTestId("checklist-item:Send your first task").tagName).not.toBe("BUTTON"),
    );
    fireEvent.click(screen.getByTestId("checklist-item:Send your first task"));
    expect(onRunWorkflow).toHaveBeenCalledTimes(1);
  });

  it("leaves 'Send your first task' inert when no sender is wired (agent not running yet)", async () => {
    render(<CommandPanel instanceId="i1" instanceName="Bea" />);

    const item = await screen.findByTestId("checklist-item:Send your first task");
    expect(item.tagName).not.toBe("BUTTON");
  });

  it("running a workflow completes the Getting-started 'Run your first workflow' step", async () => {
    const prev = process.env.NEXT_PUBLIC_WORKFLOWS_RUN_ENABLED;
    process.env.NEXT_PUBLIC_WORKFLOWS_RUN_ENABLED = "true";
    try {
      const onRunWorkflow = jest.fn(() => true);
      render(<CommandPanel instanceId="i1" instanceName="Bea" onRunWorkflow={onRunWorkflow} />);

      // Flag on + a sender → the managed Workflows list renders and the checklist
      // relabels its final step to "Run your first workflow" (not yet done).
      const runBtn = await screen.findByTestId("workflow-run-weekly-metrics-brief");
      expect(screen.getByTestId("checklist-item:Run your first workflow")).toHaveAttribute("data-done", "false");

      fireEvent.click(runBtn);
      expect(onRunWorkflow).toHaveBeenCalled();

      // Running it optimistically completes the step (retires even if the agent
      // never finishes the run).
      await waitFor(() =>
        expect(screen.getByTestId("checklist-item:Run your first workflow")).toHaveAttribute("data-done", "true"),
      );
    } finally {
      if (prev === undefined) delete process.env.NEXT_PUBLIC_WORKFLOWS_RUN_ENABLED;
      else process.env.NEXT_PUBLIC_WORKFLOWS_RUN_ENABLED = prev;
    }
  });

  it("opens the app picker and connects an app from the catalog", async () => {
    render(<CommandPanel instanceId="i1" instanceName="Bea" />);

    // The Apps section is now a single "Connect apps" button (no hardcoded tiles).
    const openBtn = await screen.findByTestId("command-panel-connect-apps");
    expect(screen.queryByTestId("composio-app-picker")).not.toBeInTheDocument();

    fireEvent.click(openBtn);

    // Picker opens and renders the catalog; connect launches the hosted OAuth.
    await waitFor(() => expect(screen.getByTestId("composio-app-tile:notion")).toBeInTheDocument());
    expect(screen.getByTestId("composio-app-tile:gmail")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("composio-app-tile:notion"));
    expect(mockLaunch).toHaveBeenCalledWith("notion");
  });

  it("expands chat-channels by default when nothing is connected, then collapses on click", async () => {
    render(<CommandPanel instanceId="i1" instanceName="Bea" />);

    const toggle = await screen.findByTestId("command-panel-channels-toggle");
    // 0 connected → auto-expanded so the user's first move (message the agent) is visible.
    await waitFor(() =>
      expect(screen.getByTestId("command-panel-connect-viewall")).toBeInTheDocument(),
    );

    fireEvent.click(toggle);
    expect(screen.queryByTestId("command-panel-connect-viewall")).not.toBeInTheDocument();
  });

  it("collapses chat-channels by default once a channel is connected", async () => {
    installFetch("idle", { Telegram: { configured: true } });
    render(<CommandPanel instanceId="i1" instanceName="Bea" />);

    const toggle = await screen.findByTestId("command-panel-channels-toggle");
    // ≥1 connected → auto-collapsed; the header shows the count instead.
    await waitFor(() => expect(toggle).toHaveTextContent(/1 connected/i));
    expect(screen.queryByTestId("command-panel-connect-viewall")).not.toBeInTheDocument();
  });

  it("deep-links a quick-connect row to that specific channel (not the modal top)", async () => {
    const onOpenChannels = jest.fn();
    render(<CommandPanel instanceId="i1" instanceName="Bea" onOpenChannels={onOpenChannels} />);

    // 0 connected → channels auto-expanded → the per-channel rows are visible.
    const row = await screen.findByTestId("command-panel-connect-Telegram");
    fireEvent.click(row);
    expect(onOpenChannels).toHaveBeenCalledWith("Telegram");
  });

  it("renders the sheet variant with a console link, a 44px close and touch sizing scope", async () => {
    installFetch();
    const onCollapse = jest.fn();
    render(
      <CommandPanel
        instanceId="inst-1"
        instanceName="Atlas"
        variant="sheet"
        consoleHref="/dashboard/instances/inst-1/console"
        onCollapse={onCollapse}
      />,
    );

    const panel = screen.getByTestId("instance-command-panel");
    expect(panel).toHaveAttribute("data-sheet");
    expect(panel).toHaveAttribute("data-cmdp");
    expect(screen.getByTestId("command-panel-console-link")).toHaveAttribute("href", "/dashboard/instances/inst-1/console");
    expect(screen.queryByTestId("command-panel-collapse")).not.toBeInTheDocument();

    const close = screen.getByRole("button", { name: "Close command panel" });
    expect(close).toHaveStyle({ width: "44px", height: "44px" });
    fireEvent.click(close);
    expect(onCollapse).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("command-panel-channels-toggle")).toHaveClass("cmdp-row");
    await waitFor(() => expect(screen.getByTestId("command-panel-status-pill")).toHaveTextContent("Ready"));
  });

  it("keeps the dock variant's collapse control and no console link", async () => {
    installFetch();
    render(<CommandPanel instanceId="inst-1" instanceName="Atlas" />);
    await waitFor(() => expect(screen.getByTestId("command-panel-status-pill")).toHaveTextContent("Ready"));

    const panel = screen.getByTestId("instance-command-panel");
    expect(panel).not.toHaveAttribute("data-sheet");
    expect(screen.getByTestId("command-panel-collapse")).toBeInTheDocument();
    expect(screen.queryByTestId("command-panel-console-link")).not.toBeInTheDocument();
  });
});
