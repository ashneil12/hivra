/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState, type ReactNode } from "react";

import type { UnifiedAgent } from "@/lib/hivra/unified-agent";
import {
  WORKSPACE_SELECTION_STORAGE_KEY,
  persistWorkspaceSelection,
} from "@/lib/workspace/workspace-persistence";
import type { WorkspaceSurfaceSource } from "../workspace-surface-adapters";
import {
  useWorkspaceAgents,
  type UseWorkspaceAgentsResult,
} from "../useWorkspaceAgents";
import { AgentSwitcherMenu } from "../AgentSwitcherMenu";
import { UnifiedWorkspace } from "../UnifiedWorkspace";

jest.mock("../useWorkspaceAgents", () => ({
  useWorkspaceAgents: jest.fn(),
}));

jest.mock("@/components/webui/WebuiIframe", () => ({
  WebuiIframe: ({ instanceId }: { instanceId: string }) => (
    <p>{`HERMES_CONVERSATION_${instanceId}`}</p>
  ),
}));

jest.mock("@/components/hivra/HivraChat", () => ({
  HivraChat: ({ agentName }: { agentName: string }) => (
    <p>{`HIVRA_CONVERSATION_${agentName}`}</p>
  ),
}));

jest.mock("@/components/hivra/HivraFiles", () => ({
  HivraFiles: () => <p>REAL_HIVRA_FILES</p>,
}));

jest.mock("@/components/hivra/HivraGit", () => ({
  HivraGit: () => <p>REAL_HIVRA_GIT</p>,
}));

jest.mock("@/components/hivra/HivraRemoteDesktop", () => ({
  HivraRemoteDesktop: () => <div data-testid="real-remote-desktop">Remote desktop</div>,
}));
jest.mock("@/components/hivra/HivraOmarchyDesktop", () => ({
  HivraOmarchyDesktop: () => <div data-testid="real-omarchy-desktop">Omarchy desktop</div>,
}));
jest.mock("@/components/hivra/HivraConsoleDesktop", () => ({
  HivraConsoleDesktop: ({ autoOpenFast }: { autoOpenFast?: boolean }) => (
    <div data-testid="real-windows-desktop" data-auto-open={String(Boolean(autoOpenFast))}>
      Windows desktop
    </div>
  ),
}));
jest.mock("@/components/ShellTerminalWorkspace", () => ({
  ShellTerminalWorkspace: ({ instanceId }: { instanceId: string }) => (
    <p>{`REAL_HERMES_TERMINAL_${instanceId}`}</p>
  ),
}));

const mockedUseWorkspaceAgents = jest.mocked(useWorkspaceAgents);
const originalFetch = global.fetch;

function agent(
  uid: `h-${string}` | `x-${string}`,
  name: string,
): UnifiedAgent {
  const kind = uid.startsWith("h-") ? "hermes" : "hivra";
  return {
    uid,
    kind,
    id: uid.slice(2),
    name,
    statusRaw: "running",
    state: "running",
    dot: "#22c55e",
    vendor: kind === "hermes" ? "Hermes" : "OpenAI",
    typeLabel: kind === "hermes" ? "Hermes" : "Codex",
  };
}

const hermesAgent = agent("h-alpha", "Alpha");
const hivraAgent = agent("x-beta", "Beta");

function state(
  overrides: Partial<UseWorkspaceAgentsResult> = {},
): UseWorkspaceAgentsResult {
  return {
    agents: [hermesAgent, hivraAgent],
    loading: false,
    hermesError: null,
    hivraError: null,
    lastRefreshedAt: "2026-08-24T19:00:00.000Z",
    retryHermes: jest.fn(async () => undefined),
    retryHivra: jest.fn(async () => undefined),
    retryAll: jest.fn(async () => undefined),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function detail(selected: UnifiedAgent): WorkspaceSurfaceSource {
  if (selected.kind === "hermes") {
    return {
      kind: "hermes",
      uid: selected.uid,
      instance: {
        id: selected.id,
        name: selected.name,
        status: "running",
        backend: "gateway",
      },
    };
  }

  return {
    kind: "hivra",
    uid: selected.uid,
    agent: {
      id: selected.id,
      type: "codex",
      name: selected.name,
      status: "running",
      cpu: 2,
      ram: 4,
      chat_url: "https://box.invalid",
      api_token: "SECRET_DETAIL_TOKEN",
    },
  };
}

function AgentFixture({ selected }: { selected: UnifiedAgent }) {
  const [draft, setDraft] = useState("");
  return (
    <div>
      <p>{selected.uid}_TRANSCRIPT</p>
      <p>{selected.uid}_PENDING</p>
      <label>
        Draft for {selected.name}
        <input
          aria-label={`Draft for ${selected.name}`}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
    </div>
  );
}

describe("UnifiedWorkspace", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
    global.fetch = (() =>
      new Promise<Response>(() => undefined)) as typeof fetch;
    window.history.replaceState({}, "", "/dashboard/workspace");
    mockedUseWorkspaceAgents.mockReturnValue(state());
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it("shows the explicit starter without auto-selecting an agent", () => {
    render(<UnifiedWorkspace />);

    expect(screen.getByRole("heading", { name: "Choose an agent" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "Select an agent to open its conversation and available computer surfaces.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("option", { current: true })).not.toBeInTheDocument();
    expect(window.location.search).toBe("");
  });

  it("lets explicit valid URL state win over a different saved selection", async () => {
    persistWorkspaceSelection({ uid: "h-alpha", surface: "terminal" });
    window.history.replaceState(
      {},
      "",
      "/dashboard/workspace?agent=x-beta&surface=conversation",
    );
    const loadAgentDetail = jest.fn(async (selected: UnifiedAgent) => detail(selected));

    render(<UnifiedWorkspace loadAgentDetail={loadAgentDetail} />);

    expect(await screen.findByText("HIVRA_CONVERSATION_Beta")).toBeInTheDocument();
    expect(loadAgentDetail).toHaveBeenCalledTimes(1);
    expect(loadAgentDetail).toHaveBeenCalledWith(
      expect.objectContaining({ uid: "x-beta" }),
      expect.any(AbortSignal),
    );
    expect(window.location.search).toBe("?agent=x-beta&surface=conversation");
  });

  it("restores a fresh manifest launch only after the exact current agent and detail load", async () => {
    persistWorkspaceSelection({ uid: "x-beta", surface: "files" });
    const selectedDetail = deferred<WorkspaceSurfaceSource>();
    const loadAgentDetail = jest.fn(() => selectedDetail.promise);

    render(<UnifiedWorkspace loadAgentDetail={loadAgentDetail} />);

    expect(await screen.findByText("Opening Beta…")).toBeInTheDocument();
    expect(screen.queryByText("REAL_HIVRA_FILES")).not.toBeInTheDocument();

    await act(async () => {
      selectedDetail.resolve(detail(hivraAgent));
      await selectedDetail.promise;
    });

    expect(await screen.findByText("REAL_HIVRA_FILES")).toBeInTheDocument();
    expect(window.location.search).toBe("?agent=x-beta&surface=files");
    expect(loadAgentDetail).toHaveBeenCalledWith(
      expect.objectContaining({ uid: "x-beta" }),
      expect.any(AbortSignal),
    );
  });

  it("does not let a colliding backing ID restore the wrong source family", async () => {
    const collisionHermes = agent("h-shared", "Hermes shared");
    mockedUseWorkspaceAgents.mockReturnValue(state({ agents: [collisionHermes] }));
    persistWorkspaceSelection({ uid: "x-shared", surface: "conversation" });

    render(<UnifiedWorkspace />);

    expect(screen.getByRole("heading", { name: "Choose an agent" })).toBeInTheDocument();
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Your saved agent is no longer available. Choose an agent to continue.",
    );
    expect(window.localStorage.getItem(WORKSPACE_SELECTION_STORAGE_KEY)).toBeNull();
    expect(window.location.search).toBe("");
  });

  it("clears a removed agent instead of activating another saved or listed identity", async () => {
    persistWorkspaceSelection({ uid: "x-removed", surface: "terminal" });

    render(<UnifiedWorkspace />);

    expect(screen.getByRole("heading", { name: "Choose an agent" })).toBeInTheDocument();
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Your saved agent is no longer available. Choose an agent to continue.",
    );
    expect(window.localStorage.getItem(WORKSPACE_SELECTION_STORAGE_KEY)).toBeNull();
  });

  it("revalidates saved surfaces against fresh capabilities and falls back visibly", async () => {
    persistWorkspaceSelection({ uid: "x-beta", surface: "browser" });
    const loadAgentDetail = jest.fn(async (selected: UnifiedAgent) => detail(selected));

    render(<UnifiedWorkspace loadAgentDetail={loadAgentDetail} />);

    expect(await screen.findByText("HIVRA_CONVERSATION_Beta")).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Browser" })).not.toBeInTheDocument();
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Your saved Browser surface is no longer available. Conversation opened instead.",
    );
    expect(window.location.search).toBe("?agent=x-beta&surface=conversation");
    expect(JSON.parse(window.localStorage.getItem(WORKSPACE_SELECTION_STORAGE_KEY)!)).toEqual({
      version: 1,
      uid: "x-beta",
      surface: "conversation",
    });
  });

  it("synchronously removes every A boundary sentinel when B is selected", async () => {
    const alphaResolution = deferred<ReactNode>();
    const alphaSignals: AbortSignal[] = [];
    window.history.replaceState(
      {},
      "",
      "/dashboard/workspace?agent=h-alpha&surface=conversation",
    );

    render(
      <UnifiedWorkspace
        renderAgentContent={(selected) => <AgentFixture selected={selected} />}
        resolveAgentContent={(selected, signal) => {
          if (selected.uid === "h-alpha") {
            alphaSignals.push(signal);
            return alphaResolution.promise;
          }
          return Promise.resolve(<p>{selected.uid}_RESOLVED</p>);
        }}
        renderSurfaceContent={(selected, surface) => (
          <p>{`${selected.uid}_${surface}_SURFACE`}</p>
        )}
      />,
    );

    expect(screen.getByText("h-alpha_TRANSCRIPT")).toBeInTheDocument();
    expect(screen.getByText("h-alpha_PENDING")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Draft for Alpha" }), {
      target: { value: "h-alpha_DRAFT" },
    });
    expect(screen.getByDisplayValue("h-alpha_DRAFT")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Switch agent/ }));
    fireEvent.click(screen.getByRole("option", { name: /Beta/ }));

    expect(screen.queryByText("h-alpha_TRANSCRIPT")).not.toBeInTheDocument();
    expect(screen.queryByText("h-alpha_PENDING")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("h-alpha_DRAFT")).not.toBeInTheDocument();
    expect(window.location.search).toBe("?agent=x-beta&surface=conversation");
    expect(alphaSignals[0]?.aborted).toBe(true);

    await act(async () => {
      alphaResolution.resolve(<p>h-alpha_LATE_RESOLUTION</p>);
      await alphaResolution.promise;
    });

    expect(screen.queryByText("h-alpha_LATE_RESOLUTION")).not.toBeInTheDocument();
    expect(screen.getByText("x-beta_TRANSCRIPT")).toBeInTheDocument();
  });

  it("shows one content area, so a surface and a conversation never stack", async () => {
    // Selecting a surface used to open a second, fixed-width column and leave
    // the conversation rendering beside it. Both are real content, so the pane
    // showed two things at once and neither had the room.
    window.history.replaceState(
      {},
      "",
      "/dashboard/workspace?agent=x-beta&surface=conversation",
    );
    const loadAgentDetail = jest.fn(async (selected: UnifiedAgent) =>
      detail(selected),
    );
    render(<UnifiedWorkspace loadAgentDetail={loadAgentDetail} />);

    expect(await screen.findByText("HIVRA_CONVERSATION_Beta")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Terminal" }));

    // The terminal takes the content area; the conversation is not still open
    // beside it, and there is no second copy of the pane.
    expect(screen.queryByText("HIVRA_CONVERSATION_Beta")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("surface-panel")).toHaveLength(1);
  });

  it("groups computers apart from agents and marks duplicate names with a short id", () => {
    const computer = {
      ...agent("x-gamma", "Gamma"),
      typeLabel: "Ubuntu Desktop",
      resourceKind: "computer" as const,
    };
    const duplicate = agent("x-alpha2", "Alpha");
    mockedUseWorkspaceAgents.mockReturnValue(
      state({ agents: [hermesAgent, hivraAgent, computer, duplicate] }),
    );
    window.history.replaceState(
      {},
      "",
      "/dashboard/workspace?agent=h-alpha&surface=conversation",
    );

    render(<UnifiedWorkspace />);
    fireEvent.click(screen.getByRole("button", { name: /^Switch agent/ }));

    const agentsGroup = screen.getByRole("group", { name: "Agents" });
    const computersGroup = screen.getByRole("group", { name: "Computers" });
    expect(within(agentsGroup).getAllByRole("option", { name: /Alpha/ })).toHaveLength(2);
    expect(within(computersGroup).getByRole("option", { name: /Gamma/ })).toBeInTheDocument();
    expect(within(computersGroup).queryByRole("option", { name: /Alpha/ })).not.toBeInTheDocument();
    for (const option of within(agentsGroup).getAllByRole("option", { name: /Alpha/ })) {
      expect(option).toHaveTextContent("#");
    }
  });

  it("keeps stable mixed-family labels and aria-selected selection", () => {
    window.history.replaceState(
      {},
      "",
      "/dashboard/workspace?agent=x-beta&surface=conversation",
    );
    render(<UnifiedWorkspace />);
    fireEvent.click(screen.getByRole("button", { name: /^Switch agent/ }));

    expect(screen.getByRole("option", { name: /Alpha/ })).toHaveTextContent(
      "Hermes · Running",
    );
    expect(screen.getByRole("option", { name: /Beta/ })).toHaveTextContent(
      "Codex · Running",
    );
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      expect.stringContaining("Alpha"),
      expect.stringContaining("Beta"),
    ]);
    // role="option" marks the current row with aria-selected; aria-current is
    // for navigation landmarks and was never the right attribute here.
    expect(screen.getByRole("option", { name: /Beta/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("option", { name: /Alpha/ })).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });

  it("shows source-local failures and retries only that family", async () => {
    const retryHermes = jest.fn(async () => undefined);
    mockedUseWorkspaceAgents.mockReturnValue(
      state({
        agents: [hivraAgent],
        hermesError: "Some agents couldn't be loaded. Retry to check again.",
        retryHermes,
      }),
    );

    render(<UnifiedWorkspace />);
    fireEvent.click(await screen.findByRole("button", { name: /^Switch agent/ }));

    expect(
      screen.getByText("Some agents and computers couldn't be loaded. The rest are listed."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retryHermes).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("option", { name: /Beta/ })).toBeInTheDocument();
  });

  it("distinguishes loading, empty, and total failure states", () => {
    mockedUseWorkspaceAgents.mockReturnValue(state({ agents: [], loading: true }));
    const view = render(<UnifiedWorkspace />);
    expect(
      screen.getByText("Loading your agents…"),
    ).toBeInTheDocument();

    mockedUseWorkspaceAgents.mockReturnValue(state({ agents: [] }));
    view.rerender(<UnifiedWorkspace />);
    expect(screen.getByRole("heading", { name: "No agents yet" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Create agent" })).toBeInTheDocument();

    const retryAll = jest.fn(async () => undefined);
    mockedUseWorkspaceAgents.mockReturnValue(
      state({
        agents: [],
        hermesError: "Hermes failed",
        hivraError: "Hivra failed",
        retryAll,
      }),
    );
    view.rerender(<UnifiedWorkspace />);
    expect(
      screen.getByRole("heading", { name: "We couldn't load your agents" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to dashboard" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry agent list" }));
    expect(retryAll).toHaveBeenCalledTimes(1);
  });

  it("has no sidebar: the agent list is a menu off the header switcher", () => {
    // The rail cost 264px beside a conversation and re-rendered the same fleet
    // the header already named. It is gone — the header switcher opens a menu
    // at every width, so there is no pane and no width preference to remember.
    window.localStorage.clear();
    window.history.replaceState(
      {},
      "",
      "/dashboard/workspace?agent=h-alpha&surface=conversation",
    );
    render(<UnifiedWorkspace />);

    expect(screen.queryByTestId("agent-rail")).not.toBeInTheDocument();
    expect(window.localStorage.getItem("hivra.workspace.rail-open")).toBeNull();

    const trigger = screen.getByRole("button", { name: /^Switch agent/ });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("option", { name: /Beta/ })).not.toBeInTheDocument();

    fireEvent.click(trigger);
    // A menu, not a sidebar: the options appear and the trigger says so.
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("dialog", { name: "Switch agent or computer" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Beta/ })).toBeInTheDocument();
    // The rail's own affordances came with it rather than being dropped.
    expect(screen.getByRole("link", { name: /Launch an agent or computer/ })).toBeInTheDocument();
  });

  it("closes the agent menu when the user clicks away from it", () => {
    window.history.replaceState(
      {},
      "",
      "/dashboard/workspace?agent=h-alpha&surface=conversation",
    );
    render(<UnifiedWorkspace />);

    fireEvent.click(screen.getByRole("button", { name: /^Switch agent/ }));
    expect(screen.getByRole("dialog", { name: "Switch agent or computer" })).toBeInTheDocument();

    // Clicking anywhere outside the menu and its trigger dismisses it. This was
    // an explicit request: the previous overlay could only be closed by finding
    // its own close control.
    fireEvent.pointerDown(document.body);
    expect(
      screen.queryByRole("dialog", { name: "Switch agent or computer" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^Switch agent/ }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("renders a selected surface in the content area, not beside it", () => {
    window.history.replaceState(
      {},
      "",
      "/dashboard/workspace?agent=h-alpha&surface=terminal",
    );
    render(
      <UnifiedWorkspace
        renderSurfaceContent={(selected, surface) => (
          <p>{`${selected.uid}_${surface}`}</p>
        )}
      />,
    );

    const shell = screen.getByTestId("unified-workspace");
    expect(shell).toHaveAttribute("data-surface", "terminal");
    expect(screen.getByTestId("surface-panel")).toBeInTheDocument();
    // The surface IS the content area. It used to render as a fixed-width
    // right-hand pane with the conversation still open next to it.
    expect(screen.queryByTestId("workspace-conversation-content")).not.toBeInTheDocument();

    // The header's X is the way back, and it says what it does.
    fireEvent.click(
      screen.getByRole("button", {
        name: "Close surface and return to conversation",
      }),
    );
    expect(screen.getByTestId("unified-workspace")).toHaveAttribute(
      "data-surface",
      "conversation",
    );
    expect(screen.queryByTestId("surface-panel")).not.toBeInTheDocument();
  });

  it("retains labeled selection and bounded conversation space at narrow widths", () => {
    window.history.replaceState(
      {},
      "",
      "/dashboard/workspace?agent=x-beta&surface=conversation",
    );
    render(<UnifiedWorkspace />);

    const shell = screen.getByTestId("unified-workspace");
    expect(shell.className).toContain("h-full");
    // A flex column with one content area, so both axes are contained — there
    // is no second column that could overflow horizontally any more.
    expect(shell.className).toContain("overflow-hidden");
    expect(shell.className).toContain("flex-col");
    expect(screen.getByRole("button", { name: /^Switch agent/ })).toHaveTextContent("Beta");
    // No surface is selected, so there is nothing to close.
    expect(
      screen.queryByRole("button", {
        name: "Close surface and return to conversation",
      }),
    ).not.toBeInTheDocument();
    // The guide moved into the agent menu's footer, so it is behind the menu.
    expect(screen.queryByRole("button", { name: /test guide/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Switch agent/ }));
    expect(screen.getByRole("button", { name: /test guide/i })).toBeInTheDocument();
    const conversation = screen.getByTestId("workspace-conversation");
    expect(conversation.className).toContain("min-w-0");
  });

  it("rechecks real readiness while a selected agent is provisioning", async () => {
    jest.useFakeTimers();
    const provisioningDetail: WorkspaceSurfaceSource = {
      kind: "hivra",
      uid: hivraAgent.uid,
      agent: {
        id: hivraAgent.id,
        type: "codex",
        name: hivraAgent.name,
        status: "provisioning",
        cpu: 2,
        ram: 4,
      },
    };
    const loadAgentDetail = jest
      .fn<Promise<WorkspaceSurfaceSource>, [UnifiedAgent, AbortSignal]>()
      .mockResolvedValueOnce(provisioningDetail)
      .mockResolvedValue(detail(hivraAgent));
    window.history.replaceState(
      {},
      "",
      "/dashboard/workspace?agent=x-beta&surface=conversation",
    );

    render(<UnifiedWorkspace loadAgentDetail={loadAgentDetail} />);
    expect(await screen.findByText(/Beta is still starting/)).toBeInTheDocument();
    expect(loadAgentDetail).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(5_000);
      await Promise.resolve();
    });

    expect(await screen.findByText("HIVRA_CONVERSATION_Beta")).toBeInTheDocument();
    expect(loadAgentDetail).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });

  it("offers the same menu at every width and closes it on Escape", () => {
    // The picker used to be a modal below 1200px and the rail above it, and the
    // rail force-closed the modal, so the header switcher did nothing at all on
    // desktop. One menu serves both widths now.
    window.history.replaceState(
      {},
      "",
      "/dashboard/workspace?agent=x-beta&surface=conversation",
    );
    render(<UnifiedWorkspace />);

    const trigger = screen.getByRole("button", { name: /^Switch agent/ });
    fireEvent.click(trigger);

    const menu = screen.getByRole("dialog", { name: "Switch agent or computer" });
    expect(menu).toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    fireEvent.keyDown(window, { key: "Escape" });

    expect(
      screen.queryByRole("dialog", { name: "Switch agent or computer" }),
    ).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("filters the agent menu by name and reports an empty result honestly", () => {
    window.history.replaceState(
      {},
      "",
      "/dashboard/workspace?agent=x-beta&surface=conversation",
    );
    render(<UnifiedWorkspace />);

    fireEvent.click(screen.getByRole("button", { name: /^Switch agent/ }));
    const search = screen.getByRole("combobox", { name: "Search your agents and computers" });

    fireEvent.change(search, { target: { value: "alph" } });
    expect(screen.getByRole("option", { name: /Alpha/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Beta/ })).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: "zzzz" } });
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
    expect(screen.getByText("Nothing matches that search.")).toBeInTheDocument();
  });

  it("returns keyboard agent selection focus to the switcher trigger", async () => {
    window.history.replaceState(
      {},
      "",
      "/dashboard/workspace?agent=x-beta&surface=conversation",
    );
    render(<UnifiedWorkspace />);

    fireEvent.click(screen.getByRole("button", { name: /^Switch agent/ }));
    fireEvent.click(screen.getByRole("option", { name: /Alpha/ }), { detail: 0 });

    const trigger = screen.getByRole("button", { name: /^Switch agent/ });
    expect(trigger).toHaveTextContent("Alpha");
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(
      screen.queryByRole("dialog", { name: "Switch agent or computer" }),
    ).not.toBeInTheDocument();
  });

  it("resolves only the selected detail through both registries and restores surface-trigger focus", async () => {
    const loadAgentDetail = jest.fn(async (selected: UnifiedAgent) => detail(selected));
    window.history.replaceState(
      {},
      "",
      "/dashboard/workspace?agent=x-beta&surface=conversation",
    );

    render(<UnifiedWorkspace loadAgentDetail={loadAgentDetail} />);

    expect(await screen.findByText("HIVRA_CONVERSATION_Beta")).toBeInTheDocument();
    expect(loadAgentDetail).toHaveBeenCalledTimes(1);
    expect(loadAgentDetail).toHaveBeenCalledWith(
      expect.objectContaining({ uid: "x-beta" }),
      expect.any(AbortSignal),
    );

    const filesTrigger = screen.getByRole("tab", { name: "Files" });
    fireEvent.click(filesTrigger);

    expect(await screen.findByText("REAL_HIVRA_FILES")).toBeInTheDocument();
    expect(window.location.search).toBe("?agent=x-beta&surface=files");
    // Files takes the content area; the conversation is swapped out, not stacked.
    expect(screen.queryByText("HIVRA_CONVERSATION_Beta")).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => expect(filesTrigger).toHaveFocus());
    expect(window.location.search).toBe("?agent=x-beta&surface=conversation");
    expect(screen.getByText("HIVRA_CONVERSATION_Beta")).toBeInTheDocument();
  });

  it("clears the selected adapter and ignores stale detail generations after a UID switch", async () => {
    const alphaDetail = deferred<WorkspaceSurfaceSource>();
    const loadAgentDetail = jest.fn(
      (selected: UnifiedAgent): Promise<WorkspaceSurfaceSource> =>
        selected.uid === "h-alpha"
          ? alphaDetail.promise
          : Promise.resolve(detail(selected)),
    );
    window.history.replaceState(
      {},
      "",
      "/dashboard/workspace?agent=h-alpha&surface=conversation",
    );

    render(<UnifiedWorkspace loadAgentDetail={loadAgentDetail} />);
    expect(screen.getByText("Opening Alpha…")).toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: /^Switch agent/ }));
    fireEvent.click(screen.getByRole("option", { name: /Beta/ }));
    expect(screen.queryByText("Opening Alpha…")).not.toBeInTheDocument();
    expect(await screen.findByText("HIVRA_CONVERSATION_Beta")).toBeInTheDocument();

    await act(async () => {
      alphaDetail.resolve(detail(hermesAgent));
      await alphaDetail.promise;
    });

    expect(screen.queryByText("HERMES_CONVERSATION_alpha")).not.toBeInTheDocument();
    expect(screen.getByText("HIVRA_CONVERSATION_Beta")).toBeInTheDocument();
    expect(loadAgentDetail.mock.calls.map(([selected]) => selected.uid)).toEqual([
      "h-alpha",
      "x-beta",
    ]);
  });

  it("removes resolved capabilities while retrying the same agent detail", async () => {
    const refreshedDetail = deferred<WorkspaceSurfaceSource>();
    const detailWithoutFiles: WorkspaceSurfaceSource = {
      kind: "hivra",
      uid: hivraAgent.uid,
      agent: {
        id: hivraAgent.id,
        type: "codex",
        name: hivraAgent.name,
        status: "running",
        cpu: 2,
        ram: 4,
      },
    };
    let request = 0;
    const loadAgentDetail = jest.fn((): Promise<WorkspaceSurfaceSource> => {
      request += 1;
      return request === 1
        ? Promise.resolve(detailWithoutFiles)
        : refreshedDetail.promise;
    });
    window.history.replaceState(
      {},
      "",
      "/dashboard/workspace?agent=x-beta&surface=files",
    );

    render(<UnifiedWorkspace loadAgentDetail={loadAgentDetail} />);

    expect(await screen.findByRole("tab", { name: "Terminal" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry surface" }));

    expect(screen.queryByRole("tab", { name: "Terminal" })).not.toBeInTheDocument();
    expect(screen.getByText("Opening Beta…")).toBeInTheDocument();

    await act(async () => {
      refreshedDetail.resolve(detail(hivraAgent));
      await refreshedDetail.promise;
    });

    expect(await screen.findByText("REAL_HIVRA_FILES")).toBeInTheDocument();
    expect(loadAgentDetail).toHaveBeenCalledTimes(2);
  });

  it("gates resolved adapters when a list refresh reconstructs the same UID", async () => {
    const refreshedDetail = deferred<WorkspaceSurfaceSource>();
    let request = 0;
    const loadAgentDetail = jest.fn(
      (selected: UnifiedAgent): Promise<WorkspaceSurfaceSource> => {
        request += 1;
        return request === 1
          ? Promise.resolve(detail(selected))
          : refreshedDetail.promise;
      },
    );
    window.history.replaceState(
      {},
      "",
      "/dashboard/workspace?agent=x-beta&surface=files",
    );

    const view = render(<UnifiedWorkspace loadAgentDetail={loadAgentDetail} />);
    expect(await screen.findByText("REAL_HIVRA_FILES")).toBeInTheDocument();

    const reconstructedHivraAgent = agent("x-beta", "Beta");
    mockedUseWorkspaceAgents.mockReturnValue(
      state({ agents: [hermesAgent, reconstructedHivraAgent] }),
    );
    view.rerender(<UnifiedWorkspace loadAgentDetail={loadAgentDetail} />);

    expect(screen.queryByText("REAL_HIVRA_FILES")).not.toBeInTheDocument();
    expect(screen.getByText("Opening Beta…")).toBeInTheDocument();

    await act(async () => {
      refreshedDetail.resolve(detail(reconstructedHivraAgent));
      await refreshedDetail.promise;
    });

    expect(await screen.findByText("REAL_HIVRA_FILES")).toBeInTheDocument();
    expect(loadAgentDetail).toHaveBeenCalledTimes(2);
    expect(loadAgentDetail.mock.calls[1][0]).toBe(reconstructedHivraAgent);
  });
});

describe("agent switcher menu positioning", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
    global.fetch = (() => new Promise<Response>(() => undefined)) as typeof fetch;
    mockedUseWorkspaceAgents.mockReturnValue(state());
  });

  it("anchors the menu under its trigger rather than at the viewport origin", async () => {
    // SafePortal mounts its children from an effect, so the menu element is not
    // in the tree on the first commit. Positioning from a mount effect measured a
    // null ref, did nothing, and never re-ran — the menu rendered pinned to the
    // top-left corner of the viewport instead of under the button. A callback ref
    // fires when the node attaches, which is the first moment it can be measured.
    window.history.replaceState(
      {},
      "",
      "/dashboard/workspace?agent=x-beta&surface=conversation",
    );
    const trigger = document.createElement("button");
    trigger.getBoundingClientRect = () =>
      ({ left: 220, right: 520, top: 12, bottom: 44, width: 300, height: 32 }) as DOMRect;
    const anchorRef = { current: trigger };

    render(
      <AgentSwitcherMenu
        open
        agents={[hermesAgent, hivraAgent]}
        selectedUid="x-beta"
        loading={false}
        hermesError={null}
        hivraError={null}
        anchorRef={anchorRef}
        onSelect={jest.fn()}
        onClose={jest.fn()}
        onRetryHermes={jest.fn()}
        onRetryHivra={jest.fn()}
        onOpenTestGuide={jest.fn()}
      />,
    );

    const menu = await screen.findByRole("dialog", { name: "Switch agent or computer" });
    // Not left at the default 0 — it was measured against the anchor.
    expect(menu.style.left).toBe("220px");
    expect(menu.style.top).toBe("48px");
    // At least the menu's own minimum, and never the trigger's narrower width.
    expect(menu.style.width).toBe("320px");
  });
});

describe("computer resources land on their desktop", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
    global.fetch = (() => new Promise<Response>(() => undefined)) as typeof fetch;
  });

  function computer(profile: string | null, status = "running"): UnifiedAgent {
    return {
      ...agent("x-my-computer", "My Computer"),
      state: status as UnifiedAgent["state"],
      statusRaw: status,
      resourceKind: "computer",
      computerProfile: profile,
      agentType: "linux-desktop",
      surfaceKind: "computer",
      typeLabel: "Ubuntu Desktop",
    };
  }

  it.each([
    ["ubuntu-desktop", false],
    ["omarchy", false],
    ["windows", true],
    [null, false],
  ] as const)(
    "opens a running %s computer on surface=desktop, not a conversation",
    async (profile, autoOpen) => {
      // The owner-visible bug: an Ubuntu computer opened on a terminal, and a
      // Windows computer opened a "Conversation" tab with a manual
      // "Open fast desktop" button. Both are the same missing decision.
      mockedUseWorkspaceAgents.mockReturnValue(
        state({ agents: [computer(profile)] }),
      );
      window.history.replaceState({}, "", "/dashboard/workspace");

      const loadAgentDetail = jest.fn(
        async (selected: UnifiedAgent): Promise<WorkspaceSurfaceSource> => ({
          kind: "hivra",
          uid: selected.uid,
          agent: {
            id: selected.id,
            type: "linux-desktop",
            name: selected.name,
            status: "running",
            cpu: 2,
            ram: 4,
            chat_url: null,
            api_token: null,
            computer_profile: profile,
          },
        }),
      );

      render(<UnifiedWorkspace loadAgentDetail={loadAgentDetail} />);
      await act(async () => {});

      // The desktop is the selected surface, and it is a real tab.
      await waitFor(() =>
        expect(screen.getByTestId("unified-workspace")).toHaveAttribute(
          "data-surface",
          "desktop",
        ),
      );
      expect(screen.getByRole("tab", { name: "Desktop" })).toBeInTheDocument();
      // No conversation, because a computer has none.
      expect(
        screen.queryByRole("tab", { name: "Conversation" }),
      ).not.toBeInTheDocument();

      // Windows opens itself; the others stream on mount. Either way the user
      // does not have to click anything.
      const windows = screen.queryByTestId("real-windows-desktop");
      if (profile === "windows") {
        expect(windows).toHaveAttribute("data-auto-open", String(autoOpen));
      }
    },
  );

  it("keeps a chat agent on its conversation", async () => {
    // The non-regression guard: this whole change must not move agents.
    mockedUseWorkspaceAgents.mockReturnValue(state({ agents: [hivraAgent] }));
    window.history.replaceState({}, "", "/dashboard/workspace");

    const loadAgentDetail = jest.fn(async (selected: UnifiedAgent) => detail(selected));
    render(<UnifiedWorkspace loadAgentDetail={loadAgentDetail} />);

    expect(await screen.findByText("HIVRA_CONVERSATION_Beta")).toBeInTheDocument();
    expect(screen.getByTestId("unified-workspace")).toHaveAttribute(
      "data-surface",
      "conversation",
    );
  });
});

describe("a stale route for a computer", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
    global.fetch = (() => new Promise<Response>(() => undefined)) as typeof fetch;
  });

  const computer = {
    ...agent("x-my-ubuntu", "My Ubuntu"),
    resourceKind: "computer" as const,
    computerProfile: "ubuntu-desktop",
    agentType: "linux-desktop",
    surfaceKind: "computer" as const,
  };

  function loadDetail() {
    return jest.fn(
      async (selected: UnifiedAgent): Promise<WorkspaceSurfaceSource> => ({
        kind: "hivra",
        uid: selected.uid,
        agent: {
          id: selected.id,
          type: "linux-desktop",
          name: selected.name,
          status: "running",
          cpu: 2,
          ram: 4,
          chat_url: null,
          api_token: null,
          computer_profile: "ubuntu-desktop",
        },
      }),
    );
  }

  it.each([
    ["a deep link", "/dashboard/workspace?agent=x-my-ubuntu&surface=conversation"],
    ["a bare agent link", "/dashboard/workspace?agent=x-my-ubuntu"],
  ])("opens the desktop from %s instead of the compatibility notice", async (_label, url) => {
    // The owner's screenshot: an Ubuntu computer with three tabs and NOTHING
    // selected, under a "This legacy session has no canonical run
    // acknowledgement" notice. The URL said surface=conversation; the initial
    // route skips the restoration effect, so nothing reconcilied it with a
    // resource that has no conversation at all — the tab strip drew with no tab
    // active and the content fell through to the conversation boundary.
    mockedUseWorkspaceAgents.mockReturnValue(state({ agents: [computer] }));
    window.history.replaceState({}, "", url);

    render(<UnifiedWorkspace loadAgentDetail={loadDetail()} />);
    await act(async () => {});

    await waitFor(() =>
      expect(screen.getByTestId("unified-workspace")).toHaveAttribute(
        "data-surface",
        "desktop",
      ),
    );
    // The legacy-session banner must never describe a computer.
    expect(
      screen.queryByText(/no canonical run acknowledgement/i),
    ).not.toBeInTheDocument();
    // And the desktop tab is the selected one, not merely present.
    expect(screen.getByRole("tab", { name: "Desktop" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("repairs the URL and the saved selection to the computer's desktop", async () => {
    mockedUseWorkspaceAgents.mockReturnValue(state({ agents: [computer] }));
    window.history.replaceState(
      {},
      "",
      "/dashboard/workspace?agent=x-my-ubuntu&surface=conversation",
    );

    render(<UnifiedWorkspace loadAgentDetail={loadDetail()} />);
    await act(async () => {});

    await waitFor(() =>
      expect(window.location.search).toBe("?agent=x-my-ubuntu&surface=desktop"),
    );
    // A bookmark or shared link stops pointing at a surface that cannot exist.
    await waitFor(() =>
      expect(window.localStorage.getItem(WORKSPACE_SELECTION_STORAGE_KEY)).toContain(
        '"surface":"desktop"',
      ),
    );
  });

  it("keeps a chat agent's conversation route untouched", async () => {
    // The non-regression guard: reconciliation must not move agents.
    mockedUseWorkspaceAgents.mockReturnValue(state({ agents: [hivraAgent] }));
    window.history.replaceState(
      {},
      "",
      "/dashboard/workspace?agent=x-beta&surface=conversation",
    );

    render(<UnifiedWorkspace loadAgentDetail={jest.fn(async (s: UnifiedAgent) => detail(s))} />);
    expect(await screen.findByText("HIVRA_CONVERSATION_Beta")).toBeInTheDocument();
    expect(window.location.search).toBe("?agent=x-beta&surface=conversation");
    expect(
      screen.queryByText(/no canonical run acknowledgement/i),
    ).not.toBeInTheDocument();
  });
});
