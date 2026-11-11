/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AgentCommandPanel, CommandPanelDock } from "../CommandPanel";
import { commandPanelCapabilities } from "../capabilities";
import { resetAgentSoftwareForTests } from "../../useAgentSoftware";
import { AgentActionError, type HivraAgent } from "@/lib/hivra/agent-api";
import type { AgentSoftwareState } from "@/lib/hivra/agent-software-api";
import type { AgentSoftwareView } from "@/lib/hivra/agent-cli-status";
import { agentRow, tabsFor } from "./fixtures";

const mockUpdate = jest.fn();
const mockRestart = jest.fn();
const mockEvents = jest.fn();
jest.mock("@/lib/hivra/agent-api", () => {
  const actual = jest.requireActual("@/lib/hivra/agent-api");
  return {
    ...actual,
    updateAgentRuntime: (...args: unknown[]) => mockUpdate(...args),
    restartAgent: (...args: unknown[]) => mockRestart(...args),
    getAgentEvents: (...args: unknown[]) => mockEvents(...args),
  };
});
const mockSoftware = jest.fn();
jest.mock("@/lib/hivra/agent-software-api", () => ({
  getAgentSoftware: (...args: unknown[]) => mockSoftware(...args),
  setAgentSoftwareAutoUpdate: jest.fn(),
}));

const TESTED = "2026.6.10";
function softwareState(view: AgentSoftwareView): AgentSoftwareState {
  return {
    supported: true, cli: null, app: "openclaw", view, tested: TESTED, observedAt: "2026-09-25T11:58:00.000Z", update: null, lastRequest: null, autoUpdate: null,
  };
}

async function setup(agent: HivraAgent = agentRow("openclaw"), overrides: Partial<React.ComponentProps<typeof AgentCommandPanel>> = {}) {
  const props = {
    onOpenSurface: jest.fn(),
    onOpenManageSection: jest.fn(),
    onChanged: jest.fn(),
    onConnectionServiceRestarted: jest.fn(),
    ...overrides,
  };
  const caps = commandPanelCapabilities(agent, tabsFor(agent))!;
  let view!: ReturnType<typeof render>;
  await act(async () => { view = render(<AgentCommandPanel key={agent.id} agent={agent} caps={caps} {...props} />); });
  return { ...view, ...props, agent };
}

afterEach(() => { jest.restoreAllMocks(); });

const status = () => screen.getByRole("status");

beforeEach(() => {
  window.localStorage.clear();
  resetAgentSoftwareForTests();
  mockSoftware.mockResolvedValue(softwareState({ kind: "behind", installed: "2026.5.1" } as AgentSoftwareView));
  mockEvents.mockResolvedValue([]);
  mockUpdate.mockResolvedValue({ status: "running" });
  mockRestart.mockResolvedValue({ switchedOff: false, waitedSeconds: null });
});

describe("AgentCommandPanel", () => {
  it("shows the default quick actions as tiles and keeps the extra ones hidden", async () => {
    await setup();
    const grid = within(screen.getByRole("region", { name: "Quick actions" }));
    for (const label of ["Update OpenClaw", "Restart", "Terminal", "Browser", "Files", "Model", "Computer size"]) {
      expect(grid.getByRole("button", { name: new RegExp(`^${label}`) })).toBeInTheDocument();
    }
    expect(grid.queryByRole("button", { name: /^Chat apps/ })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Command panel" })).toBeInTheDocument();
    await screen.findByText("An update is available");
  });

  it("opens the surface or Manage section each tile is wired to", async () => {
    const { onOpenSurface, onOpenManageSection } = await setup();
    fireEvent.click(screen.getByRole("button", { name: /^Terminal/ }));
    expect(onOpenSurface).toHaveBeenLastCalledWith("box");
    expect(status()).toHaveTextContent("Opening Terminal");
    fireEvent.click(screen.getByRole("button", { name: /^Files/ }));
    expect(onOpenSurface).toHaveBeenLastCalledWith("files");
    fireEvent.click(screen.getByRole("button", { name: /^Browser/ }));
    expect(onOpenSurface).toHaveBeenLastCalledWith("browser");
    fireEvent.click(screen.getByRole("button", { name: /^Model/ }));
    expect(onOpenManageSection).toHaveBeenLastCalledWith("model");
    fireEvent.click(screen.getByRole("button", { name: /^Computer size/ }));
    expect(onOpenManageSection).toHaveBeenLastCalledWith("resources");
  });

  it("runs the agent-software update and shows its progress and result", async () => {
    let resolveUpdate: (value: { status: string }) => void = () => undefined;
    mockUpdate.mockReturnValue(new Promise((resolve) => { resolveUpdate = resolve; }));
    const { onChanged, onConnectionServiceRestarted, agent } = await setup();
    fireEvent.click(screen.getByRole("button", { name: /^Update OpenClaw/ }));
    expect(mockUpdate).toHaveBeenCalledWith(agent.id);
    expect(status()).toHaveTextContent("Updating OpenClaw…");
    expect(screen.getByRole("button", { name: /^Update OpenClaw/ })).toHaveAttribute("aria-busy", "true");

    // The computer reports the update running, then done.
    mockSoftware.mockResolvedValue(softwareState({ kind: "updating", phase: "installing", target: TESTED } as AgentSoftwareView));
    await act(async () => { resolveUpdate({ status: "running" }); });
    expect(onConnectionServiceRestarted).toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalled();
    await waitFor(() => expect(status()).toHaveTextContent("Installing the OpenClaw update"));

    mockSoftware.mockResolvedValue(softwareState({ kind: "update_done", target: TESTED } as AgentSoftwareView));
    // Press again while it is still running: it says so and does not start another.
    fireEvent.click(screen.getByRole("button", { name: /^Update OpenClaw/ }));
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(status()).toHaveTextContent("OpenClaw is already updating.");
  });

  it("says in plain words why an update was refused", async () => {
    mockUpdate.mockRejectedValue(new AgentActionError("Busy", 409, "busy"));
    await setup();
    fireEvent.click(screen.getByRole("button", { name: /^Update OpenClaw/ }));
    await waitFor(() => expect(status()).toHaveTextContent("Another action is running on this agent. Try again when it finishes."));
    expect(status()).toHaveAttribute("data-tone", "error");
  });

  it("asks before restarting, then restarts the computer", async () => {
    const { onChanged, agent } = await setup();
    fireEvent.click(screen.getByRole("button", { name: /^Restart/ }));
    expect(mockRestart).not.toHaveBeenCalled();
    const group = screen.getByRole("group", { name: /Restart OpenClaw's computer\?/ });
    fireEvent.click(within(group).getByRole("button", { name: "Cancel" }));
    expect(mockRestart).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /^Restart/ }));
    fireEvent.click(within(screen.getByRole("group", { name: /Restart OpenClaw's computer\?/ })).getByRole("button", { name: "Restart" }));
    expect(mockRestart).toHaveBeenCalledWith(agent.id);
    await waitFor(() => expect(status()).toHaveTextContent("Restart started. OpenClaw is back in about a minute."));
    expect(onChanged).toHaveBeenCalled();
  });

  it("reports a restart that fails, and nothing about an action that was not asked", async () => {
    mockRestart.mockRejectedValue(new Error("This computer is busy."));
    await setup();
    fireEvent.click(screen.getByRole("button", { name: /^Restart/ }));
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    await waitFor(() => expect(status()).toHaveTextContent("This computer is busy."));
  });

  it("hides and shows tiles and a suggestion in Customize, and remembers it per agent", async () => {
    const first = await setup();
    fireEvent.click(screen.getByRole("button", { name: "Customize" }));
    expect(screen.getByRole("button", { name: "Done" })).toHaveAttribute("aria-pressed", "true");
    expect(status()).toHaveTextContent("Nothing is deleted.");
    const files = screen.getByRole("checkbox", { name: "Files" });
    expect(files).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Chat apps" })).not.toBeChecked();
    fireEvent.click(files);
    fireEvent.click(screen.getByRole("checkbox", { name: "Chat apps" }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("button", { name: /^Files/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Chat apps/ })).toBeInTheDocument();

    first.unmount();
    await setup();
    expect(screen.queryByRole("button", { name: /^Files/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Chat apps/ })).toBeInTheDocument();
  });

  it("offers Set up and Not interested, and does not ask again after either", async () => {
    const first = await setup();
    const card = screen.getByRole("region", { name: "Suggestion: Chat from your phone" });
    fireEvent.click(within(card).getByRole("button", { name: "Not interested" }));
    expect(screen.queryByRole("region", { name: /Suggestion/ })).not.toBeInTheDocument();
    expect(status()).toHaveTextContent("Customize brings it back");
    first.unmount();

    const second = await setup();
    expect(screen.queryByRole("region", { name: /Suggestion/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Customize" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Chat from your phone suggestion" }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.click(within(screen.getByRole("region", { name: /Suggestion/ })).getByRole("button", { name: "Set up" }));
    expect(second.onOpenSurface).toHaveBeenCalledWith("aeon");
    expect(screen.queryByRole("region", { name: /Suggestion/ })).not.toBeInTheDocument();
  });

  it("shows no suggestion for an agent with nowhere to set it up", async () => {
    await setup(agentRow("agent-zero"));
    expect(screen.queryByRole("region", { name: /Suggestion/ })).not.toBeInTheDocument();
  });

  it("collapses to a button that opens it again, and remembers the choice", async () => {
    const first = await setup();
    fireEvent.click(screen.getByRole("button", { name: "Hide command panel" }));
    expect(screen.queryByRole("heading", { name: "Command panel" })).not.toBeInTheDocument();
    const show = screen.getByRole("button", { name: "Show command panel" });
    expect(show).toHaveAttribute("aria-expanded", "false");
    expect(show).toHaveFocus();
    first.unmount();
    await setup();
    expect(screen.queryByRole("heading", { name: "Command panel" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show command panel" }));
    expect(screen.getByRole("heading", { name: "Command panel" })).toBeInTheDocument();
  });

  it("lists the computer's recent history when there is some, and leaves the section out when there is none", async () => {
    mockEvents.mockResolvedValue([
      { event: "restarted", createdAt: "2026-09-25T11:58:00.000Z", label: "Restarted" },
      { event: "started", createdAt: "2026-09-25T11:50:00.000Z", label: "Started" },
    ]);
    const first = await setup();
    const section = await screen.findByRole("region", { name: "Recent activity" });
    expect(within(section).getByText("Restarted")).toBeInTheDocument();
    const toggle = within(section).getByRole("button", { name: /Recent activity/ });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(within(section).queryByText("Restarted")).not.toBeInTheDocument();
    first.unmount();

    mockEvents.mockResolvedValue([]);
    await setup();
    await waitFor(() => expect(mockEvents).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("region", { name: "Recent activity" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Customize" }));
    expect(screen.queryByRole("checkbox", { name: "Recent activity" })).not.toBeInTheDocument();
  });

  it("still works when storage throws", async () => {
    jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    await setup();
    fireEvent.click(screen.getByRole("button", { name: "Customize" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Files" }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("button", { name: /^Files/ })).not.toBeInTheDocument();
  });
});

describe("CommandPanelDock", () => {
  const dock = (agent: HivraAgent, activeSurface = "aeon") => (
    <CommandPanelDock agent={agent} surfaces={tabsFor(agent)} activeSurface={activeSurface} onOpenSurface={jest.fn()} onOpenManageSection={jest.fn()} onChanged={jest.fn()}>
      <div data-testid="work-pane" />
    </CommandPanelDock>
  );

  it("sits beside the work pane for a dashboard agent and keeps the pane mounted when it steps aside", async () => {
    const { rerender } = render(dock(agentRow("openclaw")));
    const pane = screen.getByTestId("work-pane");
    expect(screen.getByRole("complementary", { name: "Command panel" })).toBeInTheDocument();
    rerender(dock(agentRow("openclaw"), "manage"));
    expect(screen.queryByRole("complementary", { name: "Command panel" })).not.toBeInTheDocument();
    expect(screen.getByTestId("work-pane")).toBe(pane);
  });

  it("shows nothing beside a chat agent or an agent that is not running", async () => {
    const { rerender } = render(dock(agentRow("codex")));
    expect(screen.getByTestId("work-pane")).toBeInTheDocument();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    rerender(dock(agentRow("openclaw", { status: "stopped" })));
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });
});
