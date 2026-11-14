/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AgentQuickSettings, type AgentQuickSettingsProps } from "../agent-shell/quick-settings";
import { AgentPill } from "../agent-shell/AgentPill";
import { resetAgentSoftwareForTests } from "../useAgentSoftware";
import { AgentActionError, type HivraAgent } from "@/lib/hivra/agent-api";
import type { AgentSoftwareState } from "@/lib/hivra/agent-software-api";
import type { AgentSoftwareView } from "@/lib/hivra/agent-cli-status";
import { agentRow, tabsFor } from "../command-panel/__tests__/fixtures";

jest.mock("@/components/ui/ThinkingOrb", () => ({ ThinkingOrb: () => <i data-testid="orb" /> }));

const mockUpdate = jest.fn();
const mockRestart = jest.fn();
jest.mock("@/lib/hivra/agent-api", () => {
  const actual = jest.requireActual("@/lib/hivra/agent-api");
  return {
    ...actual,
    updateAgentRuntime: (...args: unknown[]) => mockUpdate(...args),
    restartAgent: (...args: unknown[]) => mockRestart(...args),
  };
});
const mockSoftware = jest.fn();
jest.mock("@/lib/hivra/agent-software-api", () => ({
  getAgentSoftware: (...args: unknown[]) => mockSoftware(...args),
  setAgentSoftwareAutoUpdate: jest.fn(),
}));
jest.mock("../HermesModelSettings", () => ({ HermesModelSettings: ({ agentName }: { agentName: string }) => <p>Hermes model picker for {agentName}</p> }));

const TESTED = "2026.6.10";
function softwareState(view: AgentSoftwareView): AgentSoftwareState {
  return {
    supported: true, cli: null, app: "openclaw", view, tested: TESTED, observedAt: "2026-09-25T11:58:00.000Z", update: null, lastRequest: null, autoUpdate: null,
  };
}

/** The quick settings drawn the way the page draws them: inside the pill. */
async function setup(agent: HivraAgent = agentRow("openclaw"), overrides: Partial<AgentQuickSettingsProps> = {}) {
  const props = {
    onOpenSurface: jest.fn(),
    onOpenManageSection: jest.fn(),
    onChanged: jest.fn(),
    onConnectionServiceRestarted: jest.fn(),
    ...overrides,
  };
  const ui = (
    <AgentQuickSettings key={agent.id} agent={agent} surfaces={tabsFor(agent)} enabled={agent.status === "running"} {...props}>
      {({ settings, busy, suggestion }) => (
        <AgentPill name={agent.name} status={agent.status} busy={busy} quickSettings={settings} suggestion={suggestion} actionSurface="aeon" views={[]} />
      )}
    </AgentQuickSettings>
  );
  let view!: ReturnType<typeof render>;
  await act(async () => { view = render(ui); });
  return { ...view, ...props, agent, remount: async () => { view.unmount(); await act(async () => { view = render(ui); }); } };
}

const openPill = () => fireEvent.click(screen.getByRole("button", { name: /Show controls$/ }));
const openRow = (name: RegExp) => { openPill(); fireEvent.click(screen.getByRole("button", { name })); };
const status = () => screen.getByRole("status");

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem("hivra:agent-pill-intro-seen", "1");
  resetAgentSoftwareForTests();
  mockSoftware.mockResolvedValue(softwareState({ kind: "behind", installed: "2026.5.1" } as AgentSoftwareView));
  mockUpdate.mockResolvedValue({ status: "running" });
  mockRestart.mockResolvedValue({ switchedOff: false, waitedSeconds: null });
});
afterEach(() => { jest.restoreAllMocks(); });

describe("AgentQuickSettings rows", () => {
  it("lists settings for the agent, and leaves out the views the pill already has as buttons", async () => {
    await setup();
    openPill();
    const list = within(screen.getByRole("region", { name: "Quick settings" }));
    for (const label of ["Update OpenClaw", "Restart", "Model", "Computer size", "Chat apps"]) {
      expect(list.getByRole("button", { name: new RegExp(`^${label}`) })).toBeInTheDocument();
    }
    for (const label of ["Terminal", "Browser", "Files"]) expect(list.queryByRole("button", { name: new RegExp(`^${label}`) })).not.toBeInTheDocument();
    await screen.findByText("An update is available");
  });

  it("shows nothing for a chat agent, a computer, or an agent that is not running", async () => {
    const chat = await setup(agentRow("codex"));
    openPill();
    expect(screen.queryByRole("region", { name: "Quick settings" })).not.toBeInTheDocument();
    chat.unmount();
    await setup(agentRow("openclaw", { status: "stopped" }));
    openPill();
    expect(screen.queryByRole("region", { name: "Quick settings" })).not.toBeInTheDocument();
  });

  it("opens Settings sections from Model and Computer size, and closes the dropdown", async () => {
    const { onOpenManageSection } = await setup();
    openRow(/^Model/);
    fireEvent.click(screen.getByRole("button", { name: "Change model in Settings" }));
    expect(onOpenManageSection).toHaveBeenLastCalledWith("model");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    openRow(/^Computer size/);
    expect(screen.getByText(/CPU|GB|memory/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Change size in Settings" }));
    expect(onOpenManageSection).toHaveBeenLastCalledWith("resources");
  });

  it("shows the Hermes model picker for Hermes, with a link to all models", async () => {
    const { onOpenManageSection } = await setup(agentRow("hermes"));
    openRow(/^Model/);
    expect(screen.getByText("Hermes model picker for Hermes")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /All models in Settings/ }));
    expect(onOpenManageSection).toHaveBeenLastCalledWith("model");
  });

  it("opens the agent's own screen from Chat apps", async () => {
    const { onOpenSurface } = await setup();
    openRow(/^Chat apps/);
    expect(screen.getByText(/Telegram, WhatsApp, Signal/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open OpenClaw" }));
    expect(onOpenSurface).toHaveBeenCalledWith("aeon");
  });
});

describe("AgentQuickSettings update", () => {
  it("runs the update, shows its progress and result, and says Updating on the pill", async () => {
    let resolveUpdate: (value: { status: string }) => void = () => undefined;
    mockUpdate.mockReturnValue(new Promise((resolve) => { resolveUpdate = resolve; }));
    const { onChanged, onConnectionServiceRestarted, agent } = await setup();
    openRow(/^Update OpenClaw/);
    fireEvent.click(screen.getByRole("button", { name: "Update now" }));
    expect(mockUpdate).toHaveBeenCalledWith(agent.id);
    expect(status()).toHaveTextContent("Updating OpenClaw…");
    expect(screen.getByRole("button", { name: "Update now" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Show controls$/ })).toHaveTextContent("Updating");

    mockSoftware.mockResolvedValue(softwareState({ kind: "updating", phase: "installing", target: TESTED } as AgentSoftwareView));
    await act(async () => { resolveUpdate({ status: "running" }); });
    expect(onConnectionServiceRestarted).toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalled();
    await waitFor(() => expect(status()).toHaveTextContent("Installing the OpenClaw update"));
    // It keeps the button off while the computer reports the update running.
    expect(screen.getByRole("button", { name: "Update now" })).toBeDisabled();
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });

  it("opens Updates in Settings", async () => {
    const { onOpenManageSection } = await setup();
    openRow(/^Update OpenClaw/);
    fireEvent.click(screen.getByRole("button", { name: /Open Updates in Settings/ }));
    expect(onOpenManageSection).toHaveBeenLastCalledWith("updates");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("says in plain words why an update was refused", async () => {
    mockUpdate.mockRejectedValue(new AgentActionError("Busy", 409, "busy"));
    await setup();
    openRow(/^Update OpenClaw/);
    fireEvent.click(screen.getByRole("button", { name: "Update now" }));
    await waitFor(() => expect(status()).toHaveTextContent("Another action is running on this agent. Try again when it finishes."));
    expect(status()).toHaveAttribute("data-tone", "error");
    expect(screen.getByRole("button", { name: "Update now" })).toBeEnabled();
  });
});

describe("AgentQuickSettings restart", () => {
  it("asks before restarting, then restarts the computer", async () => {
    const { onChanged, agent } = await setup();
    openRow(/^Restart/);
    expect(screen.getByText("Restart OpenClaw's computer?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mockRestart).not.toHaveBeenCalled();
    expect(screen.getByRole("navigation", { name: "Views" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Restart/ }));
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    expect(mockRestart).toHaveBeenCalledWith(agent.id);
    await waitFor(() => expect(status()).toHaveTextContent("Restart started. OpenClaw is back in about a minute."));
    expect(onChanged).toHaveBeenCalled();
  });

  it("says Restarting on the pill while it runs, and reports a restart that fails", async () => {
    let rejectRestart: (error: Error) => void = () => undefined;
    mockRestart.mockReturnValue(new Promise((_resolve, reject) => { rejectRestart = reject; }));
    await setup();
    openRow(/^Restart/);
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    expect(screen.getByRole("button", { name: /Show controls$/ })).toHaveTextContent("Restarting");
    expect(screen.getByRole("button", { name: "Restart" })).toBeDisabled();
    await act(async () => { rejectRestart(new Error("This computer is busy.")); });
    expect(status()).toHaveTextContent("This computer is busy.");
    expect(status()).toHaveAttribute("data-tone", "error");
  });
});

describe("AgentQuickSettings suggestion", () => {
  it("offers one suggested next step with a dot on the pill, and Set up opens it and does not ask again", async () => {
    const first = await setup();
    expect(screen.getByTestId("agent-pill-badge")).toBeInTheDocument();
    openPill();
    const card = screen.getByRole("region", { name: "Suggestion: Chat from your phone" });
    fireEvent.click(within(card).getByRole("button", { name: "Set up" }));
    expect(first.onOpenSurface).toHaveBeenCalledWith("aeon");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByTestId("agent-pill-badge")).not.toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem(`hivra:agent-suggestion-dismissed:${first.agent.id}`) ?? "[]")).toEqual(["channels"]);

    await first.remount();
    expect(screen.queryByTestId("agent-pill-badge")).not.toBeInTheDocument();
  });

  it("Not now dismisses it for good, and it stays dismissed after a reload", async () => {
    const first = await setup();
    openPill();
    fireEvent.click(within(screen.getByRole("region", { name: /Suggestion/ })).getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("region", { name: /Suggestion/ })).not.toBeInTheDocument();
    expect(first.onOpenSurface).not.toHaveBeenCalled();
    await first.remount();
    openPill();
    expect(screen.queryByRole("region", { name: /Suggestion/ })).not.toBeInTheDocument();
  });

  it("shows no suggestion for an agent with nowhere to set it up", async () => {
    await setup(agentRow("agent-zero"));
    expect(screen.queryByTestId("agent-pill-badge")).not.toBeInTheDocument();
  });

  it("still works when storage throws", async () => {
    jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    await setup();
    openPill();
    fireEvent.click(within(screen.getByRole("region", { name: /Suggestion/ })).getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("region", { name: /Suggestion/ })).not.toBeInTheDocument();
  });
});
