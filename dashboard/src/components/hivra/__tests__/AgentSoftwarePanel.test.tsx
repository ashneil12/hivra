/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AgentSoftwarePanel, agentSoftwareUpdateError, type AgentSoftwareUpdateOutcome, type SoftwareRecovery } from "../AgentSoftwarePanel";
import { AgentSoftwareChip } from "../AgentSoftwareChip";
import { nextAgentSoftwarePoll, resetAgentSoftwareForTests } from "../useAgentSoftware";
import { manageCapabilitiesFor } from "@/lib/hivra/manage-capabilities";
import type { HivraAgent } from "@/lib/hivra/agent-api";
import type { AgentSoftwareView } from "@/lib/hivra/agent-cli-status";
import type { AgentSoftwareState } from "@/lib/hivra/agent-software-api";

const mockGet = jest.fn();
jest.mock("@/lib/hivra/agent-software-api", () => ({
  getAgentSoftware: (...args: unknown[]) => mockGet(...args),
}));

// Every update aims at upstream's newest release: Hivra pins no version.
const TESTED = "latest";
function agentOf(extra: Partial<HivraAgent> = {}): HivraAgent {
  const agent = { id: "agent-1", name: "CODEX_AGENT", type: "codex", status: "running", cpu: 2, ram: 4, deployment_mode: "hivra-managed", computer_substrate: "proxmox-kvm", ...extra } as HivraAgent;
  return { ...agent, manage: manageCapabilitiesFor({ ...agent, infrastructure_binding_token_enforced: true, desired_state: "running" }, { preparedMatch: true }) };
}
function stateOf(view: AgentSoftwareView, extra: Partial<Extract<AgentSoftwareState, { supported: true }>> = {}): AgentSoftwareState {
  return {
    supported: true, cli: "codex", app: null, view, observedAt: "2026-09-25T11:58:00.000Z", update: null, lastRequest: null, ...extra,
  };
}
const ok: AgentSoftwareUpdateOutcome = { ok: true, report: { name: "codex", version: "0.140.0", target: TESTED, state: "scheduled" } };

function renderPanel(options: { agent?: HivraAgent; onUpdate?: () => Promise<AgentSoftwareUpdateOutcome>; busy?: boolean; name?: string; recovery?: SoftwareRecovery | null } = {}) {
  const onUpdate = options.onUpdate ?? jest.fn(async () => ok);
  const view = render(<AgentSoftwarePanel agent={options.agent ?? agentOf()} name={options.name ?? "Codex"} busy={options.busy ?? false} updating={false} onUpdate={onUpdate} recovery={options.recovery} />);
  return { onUpdate, ...view };
}
const stateText = async () => (await screen.findByTestId("agent-software-state")).textContent;

beforeEach(() => {
  jest.clearAllMocks();
  resetAgentSoftwareForTests();
});

describe("AgentSoftwarePanel after an update that failed and could not be undone", () => {
  const broken: AgentSoftwareView = { kind: "update_failed", reason: "install_failed", target: TESTED, installed: null };

  it("points to Recovery with a button that opens it, keeping support as the last resort", async () => {
    mockGet.mockResolvedValue(stateOf(broken));
    const open = jest.fn();
    renderPanel({ recovery: { kind: "restore", open } });
    expect(await stateText()).toMatch(/restore this agent from a restore point made before the update.*Contact support only if that doesn't help either\./);
    fireEvent.click(screen.getByRole("button", { name: "Open Recovery" }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("points to Force restart in Advanced when there are no restore points", async () => {
    mockGet.mockResolvedValue(stateOf(broken));
    const open = jest.fn();
    renderPanel({ recovery: { kind: "force-restart", open } });
    expect(await stateText()).toMatch(/use Force restart in Advanced/);
    fireEvent.click(screen.getByRole("button", { name: "Open Advanced" }));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("keeps the old wording and no extra button where Manage has no recovery", async () => {
    mockGet.mockResolvedValue(stateOf(broken));
    renderPanel();
    expect(await stateText()).toMatch(/Try again, or contact support\.$/);
    expect(screen.queryByTestId("agent-software-recovery")).not.toBeInTheDocument();
  });

  it("does the same for a hosted app", async () => {
    mockGet.mockResolvedValue({ ...stateOf({ kind: "update_failed", reason: "install_failed", target: TESTED, installed: null }), cli: null, app: "agent-zero" });
    renderPanel({ agent: agentOf({ type: "agent-zero" }), name: "Agent Zero", recovery: { kind: "restore", open: jest.fn() } });
    expect(await stateText()).toMatch(/restore this agent from a restore point/);
    expect(screen.getByRole("button", { name: "Open Recovery" })).toBeInTheDocument();
  });

  it("offers no recovery button when the download failed", async () => {
    mockGet.mockResolvedValue(stateOf({ kind: "update_failed", reason: "download_failed", target: TESTED, installed: "0.140.0" }));
    renderPanel({ recovery: { kind: "restore", open: jest.fn() } });
    await stateText();
    expect(screen.queryByTestId("agent-software-recovery")).not.toBeInTheDocument();
  });
});

describe("AgentSoftwarePanel", () => {
  it.each<[string, AgentSoftwareView, RegExp, string | null]>([
    ["current", { kind: "current", installed: "0.149.1" }, /^$/, "Update Codex"],
    ["an older connection service", { kind: "older_connection_service" }, /connection service is older, so it doesn't report its Codex version\. Update the connection service below: it also updates Codex to its newest release\./, null],
    ["an unreadable version", { kind: "version_unreadable" }, /^Hivra couldn't read which Codex version is installed\.$/, "Update Codex"],
    ["starting", { kind: "updating", phase: "starting", target: TESTED, installed: "0.140.0" }, /^Starting the update…$/, null],
    ["downloading", { kind: "updating", phase: "downloading", target: TESTED, installed: "0.140.0" }, /^Downloading Codex's newest release\. Codex keeps working while it downloads\.$/, null],
    ["waiting", { kind: "updating", phase: "waiting", target: TESTED, installed: "0.140.0" }, /^Waiting for the current reply to finish\..*Hivra waits up to 6 hours\.$/, null],
    ["installing", { kind: "updating", phase: "installing", target: TESTED, installed: "0.140.0" }, /Messages you send now wait a few seconds and then send by themselves\.$/, null],
    ["finishing", { kind: "updating", phase: "finishing", target: TESTED, installed: "0.140.0" }, /^Checking the new version…$/, null],
    ["done", { kind: "update_done", target: "0.169.0", installed: "0.169.0" }, /^Codex 0\.169\.0 is installed\. It is the newest release\.$/, "Update Codex"],
    ["deferred", { kind: "update_deferred", target: TESTED, installed: "0.140.0" }, /still in use after 6 hours\. Nothing was changed\.$/, "Try again"],
    ["rolled back", { kind: "update_rolled_back", target: TESTED, installed: "0.140.0" }, /^Codex's newest release didn't start properly, so Hivra put Codex 0\.140\.0 back\. Your agent works as before\.$/, "Try again"],
    ["a failed download", { kind: "update_failed", reason: "download_failed", target: TESTED, installed: "0.140.0" }, /^Hivra couldn't download Codex's newest release\. Nothing was changed\.$/, "Try again"],
    ["a failed install", { kind: "update_failed", reason: "install_failed", target: TESTED, installed: null }, /couldn't put the previous version back\. Codex may not work until this is fixed/, "Try again"],
    ["an update that couldn't start", { kind: "update_failed", reason: "could_not_start", target: TESTED, installed: "0.140.0" }, /^The connection service was updated, but the Codex update couldn't start\. Try again\.$/, "Try again"],
    ["unreachable", { kind: "unreachable" }, /^Unavailable while the computer can't be reached$/, null],
    ["checking", { kind: "checking" }, /^Checking which Codex version is installed…$/, null],
  ])("says what is true when %s", async (_case, view, text, action) => {
    mockGet.mockResolvedValue(stateOf(view));
    renderPanel();
    expect(await stateText()).toMatch(text);
    if (action) expect(screen.getByRole("button", { name: action })).toBeEnabled();
    else expect(screen.queryByRole("button", { name: /Update Codex|Try again/ })).not.toBeInTheDocument();
    // No tested version: Hivra pins none.
    expect(document.body).not.toHaveTextContent(/tested|vetted/i);
    expect(screen.getByText(/never changes it by itself\. Update installs the newest release again\./)).toBeInTheDocument();
  });

  it("shows the installed version and when the computer was last read", async () => {
    mockGet.mockResolvedValue(stateOf({ kind: "current", installed: "0.140.0" }));
    renderPanel();
    await screen.findByTestId("agent-software-state");
    expect(screen.getByText("Codex installed").nextSibling).toHaveTextContent("0.140.0");
    expect(screen.queryByText("Hivra's tested version")).not.toBeInTheDocument();
    expect(screen.getByText("Last checked")).toBeInTheDocument();
    expect(mockGet).toHaveBeenCalledWith("agent-1", { live: false });
  });

  it("gives Codex's own update command for Terminal", async () => {
    mockGet.mockResolvedValue(stateOf({ kind: "current", installed: "0.140.0" }));
    renderPanel();
    expect(await screen.findByText("npm install -g @openai/codex@latest")).toBeInTheDocument();
  });

  it("updates through Manage, then follows the update on the computer", async () => {
    mockGet
      .mockResolvedValueOnce(stateOf({ kind: "current", installed: "0.140.0" }))
      .mockResolvedValue(stateOf({ kind: "updating", phase: "downloading", target: TESTED, installed: "0.140.0" }));
    const { onUpdate } = renderPanel();
    const update = await screen.findByRole("button", { name: "Update Codex" });
    // What else the update does, said before it is pressed.
    expect(screen.getByText(/Updating installs Codex's newest release and also refreshes Hivra's connection service without restarting the computer/)).toBeInTheDocument();
    fireEvent.click(update);
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockGet).toHaveBeenLastCalledWith("agent-1", { live: true }));
    expect(await stateText()).toMatch(/^Downloading Codex's newest release/);
  });

  it.each([
    ["host_not_ready", "hivra-managed", "Hivra hasn't finished preparing this update yet. Nothing was changed. Try again later."],
    ["host_not_ready", "self-managed", "Prepare My server with Hivra's current setup, then try again. Nothing was changed."],
    ["busy", "hivra-managed", "Another action is running on this agent. Try again when it finishes."],
    ["not_running", "hivra-managed", "Start this agent first."],
    ["unverified", "hivra-managed", "Hivra couldn't confirm the update finished. Check again in a minute."],
    [null, "hivra-managed", "Server said no."],
  ] as const)("explains a %s refusal on %s", async (code, deployment_mode, text) => {
    mockGet.mockResolvedValue(stateOf({ kind: "current", installed: "0.140.0" }));
    renderPanel({ agent: agentOf({ deployment_mode }), onUpdate: async () => ({ ok: false, code, message: "Server said no." }) });
    fireEvent.click(await screen.findByRole("button", { name: "Update Codex" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(text);
    expect(agentSoftwareUpdateError(code, "Server said no.", deployment_mode === "self-managed")).toBe(text);
  });

  it("keeps one polite live region for the state line, so the end of an update is heard", async () => {
    mockGet
      .mockResolvedValueOnce(stateOf({ kind: "updating", phase: "installing", target: TESTED, installed: "0.140.0" }))
      .mockResolvedValueOnce(stateOf({ kind: "update_done", target: "0.169.0", installed: "0.169.0" }))
      .mockResolvedValue(stateOf({ kind: "update_rolled_back", target: TESTED, installed: "0.140.0" }));
    renderPanel();
    const region = await screen.findByTestId("agent-software-state");
    expect(region).toHaveAttribute("role", "status");
    expect(region).toHaveAttribute("aria-live", "polite");
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(region).toHaveTextContent(/^Codex 0\.169\.0 is installed\./));
    // The same element, still a live region: only its words changed.
    expect(screen.getByTestId("agent-software-state")).toBe(region);
    expect(region).toHaveAttribute("role", "status");
    expect(region).toHaveAttribute("aria-live", "polite");
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(region).toHaveTextContent(/^Codex's newest release didn't start properly/));
    expect(screen.getByTestId("agent-software-state")).toBe(region);
    expect(region).toHaveAttribute("aria-live", "polite");
  });

  it("says it couldn't check, with Check again, when the first read fails", async () => {
    mockGet.mockRejectedValueOnce(new Error("Too Many Requests")).mockResolvedValue(stateOf({ kind: "version_unreadable" }));
    renderPanel();
    expect(await screen.findByTestId("agent-software-unavailable")).toHaveTextContent("Couldn't check which Codex version is installed just now.");
    expect(screen.queryByText(/Too Many Requests/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(mockGet).toHaveBeenLastCalledWith("agent-1", { live: true }));
    expect(await stateText()).toMatch(/^Hivra couldn't read which Codex version is installed\./);
    expect(screen.queryByTestId("agent-software-unavailable")).not.toBeInTheDocument();
  });

  it("says nothing about a failed read for an agent that isn't running", async () => {
    mockGet.mockRejectedValue(new Error("Could not load this agent."));
    const { container } = renderPanel({ agent: agentOf({ status: "stopped" }) });
    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("holds the button while another Manage action runs", async () => {
    mockGet.mockResolvedValue(stateOf({ kind: "current", installed: "0.140.0" }));
    renderPanel({ busy: true });
    expect(await screen.findByRole("button", { name: "Update Codex" })).toBeDisabled();
  });

  it("asks a stopped agent to start first, and says nothing about one being set up", async () => {
    mockGet.mockResolvedValue(stateOf({ kind: "not_running" }));
    const view = renderPanel({ agent: agentOf({ status: "stopped" }) });
    expect(await stateText()).toBe("Start this agent to check or update Codex.");
    view.unmount();
    resetAgentSoftwareForTests();
    mockGet.mockClear();
    renderPanel({ agent: agentOf({ status: "provisioning" }) });
    expect(mockGet).not.toHaveBeenCalled();
  });

  // Agent apps: a digest is shown short, never in full.
  const ZERO = `sha256:${"a".repeat(64)}`;
  const appState = (view: AgentSoftwareView, app: "agent-zero" | "aeon" | "openclaw" = "agent-zero") =>
    ({ ...stateOf(view), cli: null, app });
  it.each<[string, AgentSoftwareView, RegExp, string | null]>([
    ["current", { kind: "current", installed: ZERO }, /^$/, "Update Agent Zero"],
    ["not recorded", { kind: "version_unreadable" }, /^Hivra couldn't read which Agent Zero version is installed\.$/, "Update Agent Zero"],
    ["an older connection service", { kind: "not_reported" }, /doesn't report its Agent Zero version\. Update the connection service below: it also updates Agent Zero to its newest release\./, null],
    ["waiting", { kind: "updating", phase: "waiting", target: TESTED, installed: ZERO }, /^Waiting until nobody is using Agent Zero\. It updates once Agent Zero has been idle for 5 minutes with no task running/, null],
    ["installing", { kind: "updating", phase: "installing", target: TESTED, installed: ZERO }, /restarts and is back in a few minutes\.$/, null],
    ["deferred", { kind: "update_deferred", target: TESTED, installed: ZERO }, /still in use after 6 hours\. Nothing was changed\.$/, "Try again"],
    ["rolled back", { kind: "update_rolled_back", target: TESTED, installed: ZERO }, /didn't start properly, so Hivra put Agent Zero image aaaaaaaaaaaa back/, "Try again"],
    ["no disk space", { kind: "update_failed", reason: "no_space", target: TESTED, installed: ZERO }, /^There isn't enough free disk space/, null],
  ])("says what is true for an Agent Zero agent when %s", async (_case, view, text, action) => {
    mockGet.mockResolvedValue(appState(view));
    renderPanel({ agent: agentOf({ type: "agent-zero" }), name: "Agent Zero" });
    expect(await stateText()).toMatch(text);
    if (action) expect(screen.getByRole("button", { name: action })).toBeEnabled();
    else expect(screen.queryByRole("button", { name: /Update Agent Zero|Try again/ })).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(ZERO);
    expect(screen.queryByText("Hivra's tested version")).not.toBeInTheDocument();
  });

  it("calls Aeon's part the dashboard Hivra hosts, building rather than downloading", async () => {
    mockGet.mockResolvedValue(appState({ kind: "updating", phase: "downloading", target: TESTED, installed: null }, "aeon"));
    renderPanel({ agent: agentOf({ type: "aeon" }), name: "Aeon" });
    expect(await stateText()).toMatch(/^Building Aeon dashboard's newest version\. Aeon dashboard keeps working while it builds/);
    expect(screen.getByText(/your Aeon skills and workflows live in your GitHub fork/)).toBeInTheDocument();
  });

  it("is not shown for agents Hivra doesn't check here", () => {
    const { container } = renderPanel({ agent: agentOf({ type: "deepseek-harness" }) });
    expect(container).toBeEmptyDOMElement();
    expect(mockGet).not.toHaveBeenCalled();
  });
});

describe("AgentSoftwarePanel for Hermes (Hivra pins no version)", () => {
  const hermesState = (view: AgentSoftwareView) =>
    ({ ...stateOf(view), cli: null, app: "hermes" });
  const renderHermes = () => renderPanel({ agent: agentOf({ type: "hermes" }), name: "Hermes" });

  it("shows the installed version, no tested version, and an Update Hermes button with the Terminal hint", async () => {
    mockGet.mockResolvedValue(hermesState({ kind: "current", installed: "0.23.1" }));
    renderHermes();
    expect(await screen.findByText("Hermes installed")).toBeInTheDocument();
    expect(screen.getByText("Hermes installed").nextSibling).toHaveTextContent("0.23.1");
    expect(screen.queryByText("Hivra's tested version")).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/vetted|tested version/i);
    expect(screen.getByRole("button", { name: "Update Hermes" })).toBeEnabled();
    // The same update, by hand.
    expect(screen.getAllByText("hermes update").length).toBeGreaterThan(0);
    expect(screen.queryByText(/Update automatically/)).not.toBeInTheDocument();
  });

  it("runs the update when the button is pressed", async () => {
    mockGet.mockResolvedValue(hermesState({ kind: "current", installed: "0.23.1" }));
    const { onUpdate } = renderHermes();
    fireEvent.click(await screen.findByRole("button", { name: "Update Hermes" }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
  });

  it("explains an update stopped by the owner's own changes, pointing at Terminal", async () => {
    mockGet.mockResolvedValue(hermesState({ kind: "update_failed", reason: "local_changes", target: "latest", installed: "0.23.1" }));
    renderHermes();
    expect(await stateText()).toMatch(/changes of your own.*Run hermes update in Terminal/);
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it("shows an update in progress with no button", async () => {
    mockGet.mockResolvedValue(hermesState({ kind: "updating", phase: "installing", target: "latest", installed: "0.23.1" }));
    renderHermes();
    expect(await stateText()).toMatch(/Installing Hermes's newest release/);
    expect(screen.queryByRole("button", { name: "Update Hermes" })).not.toBeInTheDocument();
  });
});

describe("AgentSoftwareChip", () => {
  it.each<[AgentSoftwareView, string, RegExp]>([
    [{ kind: "update_deferred", target: TESTED, installed: "0.140.0" }, "Update available", /^Update available\. Open Updates\.$/],
    [{ kind: "older_connection_service" }, "Update available", /connection service is older than Hivra's current one/],
    [{ kind: "updating", phase: "waiting", target: TESTED, installed: "0.140.0" }, "Updating…", /^Updating Codex\./],
    [{ kind: "update_rolled_back", target: TESTED, installed: "0.140.0" }, "Update didn't finish", /^The Codex update didn't finish\./],
  ])("shows %j as %s and opens Updates", async (view, text, label) => {
    mockGet.mockResolvedValue(stateOf(view));
    const onOpen = jest.fn();
    render(<AgentSoftwareChip agent={agentOf()} onOpen={onOpen} />);
    const chip = await screen.findByTestId("agent-software-chip");
    expect(chip).toHaveTextContent(text);
    expect(chip).toHaveAccessibleName(label);
    fireEvent.click(chip);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it.each<[AgentSoftwareView, string]>([
    [{ kind: "older_connection_service" }, "Update"],
    [{ kind: "updating", phase: "waiting", target: TESTED, installed: "0.140.0" }, "Updating…"],
    [{ kind: "update_failed", reason: "install_failed", target: TESTED, installed: null }, "Update failed"],
  ])("carries a short word for phones for %j, and a finger-sized target", async (view, short) => {
    mockGet.mockResolvedValue(stateOf(view));
    render(<AgentSoftwareChip agent={agentOf()} onOpen={jest.fn()} />);
    const chip = await screen.findByTestId("agent-software-chip");
    expect(chip.querySelector("[data-chip-short]")).toHaveTextContent(new RegExp(`^${short}$`));
    expect(chip).toHaveStyle({ minHeight: "44px", minWidth: "44px" });
  });

  it.each<AgentSoftwareView>([
    { kind: "current", installed: "0.140.0" },
    { kind: "update_done", target: "0.169.0", installed: "0.169.0" },
    { kind: "checking" },
    { kind: "unreachable" },
  ])("stays out of the way for %j", async (view) => {
    mockGet.mockResolvedValue(stateOf(view));
    render(<AgentSoftwareChip agent={agentOf()} onOpen={jest.fn()} />);
    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    expect(screen.queryByTestId("agent-software-chip")).not.toBeInTheDocument();
  });

  it("asks nothing for an agent that isn't running, or without the server's capability map", () => {
    render(<AgentSoftwareChip agent={agentOf({ status: "stopped" })} onOpen={jest.fn()} />);
    render(<AgentSoftwareChip agent={{ ...agentOf(), manage: undefined }} onOpen={jest.fn()} />);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("shares one reading with the Updates section", async () => {
    mockGet.mockResolvedValue(stateOf({ kind: "older_connection_service" }));
    render(<><AgentSoftwareChip agent={agentOf()} onOpen={jest.fn()} />{" "}<AgentSoftwarePanel agent={agentOf()} name="Codex" busy={false} updating={false} onUpdate={async () => ok} /></>);
    await screen.findByTestId("agent-software-chip");
    await screen.findByTestId("agent-software-state");
    expect(mockGet).toHaveBeenCalledTimes(1);
  });
});

describe("following an update", () => {
  it("reads every 3 s for 30 s, every 10 s to 3 minutes, then every minute, and every minute while waiting", () => {
    const updating = (phase: "downloading" | "waiting") => stateOf({ kind: "updating", phase, target: TESTED, installed: "0.140.0" });
    expect(nextAgentSoftwarePoll(updating("downloading"), 0, 0, 10_000)).toBe(3_000);
    expect(nextAgentSoftwarePoll(updating("downloading"), 0, 0, 60_000)).toBe(10_000);
    expect(nextAgentSoftwarePoll(updating("downloading"), 0, 0, 10 * 60_000)).toBe(60_000);
    expect(nextAgentSoftwarePoll(updating("waiting"), 0, 0, 10_000)).toBe(60_000);
    expect(nextAgentSoftwarePoll(updating("downloading"), 0, 0, 7 * 60 * 60_000)).toBeNull();
  });
  it("asks a still-checking computer three times, and stops once settled", () => {
    const checking = stateOf({ kind: "checking" });
    expect(nextAgentSoftwarePoll(checking, null, 2, 0)).toBe(5_000);
    expect(nextAgentSoftwarePoll(checking, null, 3, 0)).toBeNull();
    expect(nextAgentSoftwarePoll(stateOf({ kind: "update_done", target: "0.169.0", installed: "0.169.0" }), 0, 0, 1_000)).toBeNull();
    expect(nextAgentSoftwarePoll(stateOf({ kind: "version_unreadable" }), null, 0, 0)).toBeNull();
  });
  it("keeps looking for a minute for an update just asked for that the computer hasn't reported", () => {
    const unread = stateOf({ kind: "version_unreadable" });
    expect(nextAgentSoftwarePoll(unread, 0, 0, 10_000)).toBe(3_000);
    expect(nextAgentSoftwarePoll(unread, 0, 0, 61_000)).toBeNull();
    expect(nextAgentSoftwarePoll(stateOf({ kind: "current", installed: "0.140.0" }), 0, 0, 10_000)).toBeNull();
  });

  it("polls while updating, pauses while the page is hidden, and stops when done", async () => {
    jest.useFakeTimers();
    let hidden = false;
    const visibility = jest.spyOn(document, "visibilityState", "get").mockImplementation(() => (hidden ? "hidden" : "visible"));
    try {
      mockGet
        .mockResolvedValueOnce(stateOf({ kind: "updating", phase: "downloading", target: TESTED, installed: "0.140.0" }))
        .mockResolvedValueOnce(stateOf({ kind: "updating", phase: "installing", target: TESTED, installed: "0.140.0" }))
        .mockResolvedValue(stateOf({ kind: "update_done", target: "0.169.0", installed: "0.169.0" }));
      render(<AgentSoftwareChip agent={agentOf()} onOpen={jest.fn()} />);
      await act(async () => { await Promise.resolve(); });
      expect(mockGet).toHaveBeenCalledTimes(1);
      await act(async () => { await jest.advanceTimersByTimeAsync(3_000); });
      expect(mockGet).toHaveBeenCalledTimes(2);
      expect(mockGet).toHaveBeenLastCalledWith("agent-1", { live: true });
      hidden = true;
      await act(async () => { await jest.advanceTimersByTimeAsync(30_000); });
      expect(mockGet).toHaveBeenCalledTimes(2);
      hidden = false;
      await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await Promise.resolve(); });
      expect(mockGet).toHaveBeenCalledTimes(3);
      await act(async () => { await jest.advanceTimersByTimeAsync(10 * 60_000); });
      expect(mockGet).toHaveBeenCalledTimes(3);
    } finally {
      visibility.mockRestore();
      jest.useRealTimers();
    }
  });
});
