/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AgentSoftwarePanel, agentSoftwareUpdateError, type AgentSoftwareUpdateOutcome } from "../AgentSoftwarePanel";
import { AgentSoftwareChip } from "../AgentSoftwareChip";
import { nextAgentSoftwarePoll, resetAgentSoftwareForTests } from "../useAgentSoftware";
import { manageCapabilitiesFor } from "@/lib/hivra/manage-capabilities";
import type { HivraAgent } from "@/lib/hivra/agent-api";
import type { AgentSoftwareView } from "@/lib/hivra/agent-cli-status";
import type { AgentSoftwareState } from "@/lib/hivra/agent-software-api";

const mockGet = jest.fn();
const mockSetAuto = jest.fn();
jest.mock("@/lib/hivra/agent-software-api", () => ({
  getAgentSoftware: (...args: unknown[]) => mockGet(...args),
  setAgentSoftwareAutoUpdate: (...args: unknown[]) => mockSetAuto(...args),
}));

const TESTED = "0.149.1";
function agentOf(extra: Partial<HivraAgent> = {}): HivraAgent {
  const agent = { id: "agent-1", name: "CODEX_AGENT", type: "codex", status: "running", cpu: 2, ram: 4, deployment_mode: "hivra-managed", computer_substrate: "proxmox-kvm", ...extra } as HivraAgent;
  return { ...agent, manage: manageCapabilitiesFor({ ...agent, infrastructure_binding_token_enforced: true, desired_state: "running" }, { preparedMatch: true }) };
}
function stateOf(view: AgentSoftwareView, extra: Partial<Extract<AgentSoftwareState, { supported: true }>> = {}): AgentSoftwareState {
  return {
    supported: true, cli: "codex", view, tested: TESTED, observedAt: "2026-09-25T11:58:00.000Z", update: null, lastRequest: null,
    autoUpdate: { mode: "off", enabled: true, source: "default", pausedFor: null }, ...extra,
  };
}
const ok: AgentSoftwareUpdateOutcome = { ok: true, report: { name: "codex", version: "0.140.0", target: TESTED, state: "scheduled" } };

function renderPanel(options: { agent?: HivraAgent; onUpdate?: () => Promise<AgentSoftwareUpdateOutcome>; busy?: boolean; name?: string } = {}) {
  const onUpdate = options.onUpdate ?? jest.fn(async () => ok);
  const view = render(<AgentSoftwarePanel agent={options.agent ?? agentOf()} name={options.name ?? "Codex"} busy={options.busy ?? false} updating={false} onUpdate={onUpdate} />);
  return { onUpdate, ...view };
}
const stateText = async () => (await screen.findByTestId("agent-software-state")).textContent;

beforeEach(() => {
  jest.clearAllMocks();
  resetAgentSoftwareForTests();
});

describe("AgentSoftwarePanel", () => {
  it.each<[string, AgentSoftwareView, RegExp, string | null]>([
    ["behind", { kind: "behind", installed: "0.140.0" }, /^An update is available\. Codex 0\.140\.0 is installed and Hivra has tested 0\.149\.1\.$/, "Update Codex"],
    ["current", { kind: "current", installed: TESTED }, /^Codex is on the version Hivra has tested\.$/, null],
    ["an owner's newer version", { kind: "ahead_custom", installed: "0.160.0" }, /newer than the version Hivra has tested \(0\.149\.1\).*Automatic updates leave it as it is\./, "Switch to 0.149.1"],
    ["a version Hivra installed before lowering its own", { kind: "ahead_hivra", installed: "0.150.0" }, /Hivra now tests Codex 0\.149\.1\. This agent still has 0\.150\.0/, "Update Codex"],
    ["an older connection service", { kind: "older_connection_service" }, /connection service is older, so it doesn't report its Codex version\. Update the connection service below/, null],
    ["an unreadable version", { kind: "version_unreadable" }, /^Hivra couldn't read which Codex version is installed\.$/, "Reinstall 0.149.1"],
    ["starting", { kind: "updating", phase: "starting", target: TESTED, installed: "0.140.0" }, /^Starting the update…$/, null],
    ["downloading", { kind: "updating", phase: "downloading", target: TESTED, installed: "0.140.0" }, /^Downloading Codex 0\.149\.1\. The agent keeps working while it downloads\.$/, null],
    ["waiting", { kind: "updating", phase: "waiting", target: TESTED, installed: "0.140.0" }, /^Waiting for the current reply to finish\..*Hivra waits up to 6 hours\.$/, null],
    ["installing", { kind: "updating", phase: "installing", target: TESTED, installed: "0.140.0" }, /Messages you send now wait a few seconds and then send by themselves\.$/, null],
    ["finishing", { kind: "updating", phase: "finishing", target: TESTED, installed: "0.140.0" }, /^Checking the new version…$/, null],
    ["done", { kind: "update_done", target: TESTED, installed: TESTED }, /^Codex 0\.149\.1 is installed\. Codex sessions already open in the Codex session tab keep the previous version/, null],
    ["deferred", { kind: "update_deferred", target: TESTED, installed: "0.140.0" }, /a reply was still being written after 6 hours\. Nothing was changed\.$/, "Try again"],
    ["rolled back", { kind: "update_rolled_back", target: TESTED, installed: "0.140.0" }, /^The update to 0\.149\.1 didn't install, so Hivra put Codex 0\.140\.0 back\. Your agent works as before\.$/, "Try again"],
    ["a failed download", { kind: "update_failed", reason: "download_failed", target: TESTED, installed: "0.140.0" }, /^Hivra couldn't download Codex 0\.149\.1\. Nothing was changed\.$/, "Try again"],
    ["a failed install", { kind: "update_failed", reason: "install_failed", target: TESTED, installed: null }, /couldn't put the previous version back\. Chat may not work until this is fixed/, "Try again"],
    ["an update that couldn't start", { kind: "update_failed", reason: "could_not_start", target: TESTED, installed: "0.140.0" }, /^The connection service was updated, but the Codex update couldn't start\. Try again\.$/, "Try again"],
    ["unreachable", { kind: "unreachable" }, /^Couldn't reach this agent to check its Codex version\.$/, null],
    ["checking", { kind: "checking" }, /^Checking which Codex version is installed…$/, null],
  ])("says what is true when %s", async (_case, view, text, action) => {
    mockGet.mockResolvedValue(stateOf(view));
    renderPanel();
    expect(await stateText()).toMatch(text);
    if (action) expect(screen.getByRole("button", { name: action })).toBeEnabled();
    else expect(screen.queryByRole("button", { name: /Update Codex|Switch to|Reinstall|Try again/ })).not.toBeInTheDocument();
    // Hivra's tested version, never "latest".
    expect(document.body).not.toHaveTextContent(/latest/i);
    expect(screen.getByText(/older than OpenAI's newest Codex release/)).toBeInTheDocument();
  });

  it("shows both versions and when the computer was last read", async () => {
    mockGet.mockResolvedValue(stateOf({ kind: "behind", installed: "0.140.0" }));
    renderPanel();
    await screen.findByTestId("agent-software-state");
    expect(screen.getByText("Codex installed").nextSibling).toHaveTextContent("0.140.0");
    expect(screen.getByText("Hivra's tested version").nextSibling).toHaveTextContent(TESTED);
    expect(screen.getByText("Last checked")).toBeInTheDocument();
    expect(mockGet).toHaveBeenCalledWith("agent-1", { live: false });
  });

  it("names the vendor for Claude Code", async () => {
    mockGet.mockResolvedValue({ ...stateOf({ kind: "current", installed: "2.1.246" }), cli: "claude-code", tested: "2.1.246" });
    renderPanel({ agent: agentOf({ type: "claude-code" }), name: "Claude Code" });
    expect(await stateText()).toBe("Claude Code is on the version Hivra has tested.");
    expect(screen.getByText(/older than Anthropic's newest Claude Code release/)).toBeInTheDocument();
  });

  it("updates through Manage, then follows the update on the computer", async () => {
    mockGet
      .mockResolvedValueOnce(stateOf({ kind: "behind", installed: "0.140.0" }))
      .mockResolvedValue(stateOf({ kind: "updating", phase: "downloading", target: TESTED, installed: "0.140.0" }));
    const { onUpdate } = renderPanel();
    const update = await screen.findByRole("button", { name: "Update Codex" });
    // What else the update does, said before it is pressed.
    expect(screen.getByText(/Updating also refreshes Hivra's connection service without restarting the computer/)).toBeInTheDocument();
    fireEvent.click(update);
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockGet).toHaveBeenLastCalledWith("agent-1", { live: true }));
    expect(await stateText()).toMatch(/^Downloading Codex 0\.149\.1/);
  });

  it.each([
    ["host_not_ready", "hivra-managed", "Hivra hasn't finished preparing this update yet. Nothing was changed. Try again later."],
    ["host_not_ready", "self-managed", "Prepare My server with Hivra's current setup, then try again. Nothing was changed."],
    ["busy", "hivra-managed", "Another action is running on this agent. Try again when it finishes."],
    ["not_running", "hivra-managed", "Start this agent first."],
    ["unverified", "hivra-managed", "Hivra couldn't confirm the update finished. Check again in a minute."],
    [null, "hivra-managed", "Server said no."],
  ] as const)("explains a %s refusal on %s", async (code, deployment_mode, text) => {
    mockGet.mockResolvedValue(stateOf({ kind: "behind", installed: "0.140.0" }));
    renderPanel({ agent: agentOf({ deployment_mode }), onUpdate: async () => ({ ok: false, code, message: "Server said no." }) });
    fireEvent.click(await screen.findByRole("button", { name: "Update Codex" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(text);
    expect(agentSoftwareUpdateError(code, "Server said no.", deployment_mode === "self-managed")).toBe(text);
  });

  it("holds the button while another Manage action runs", async () => {
    mockGet.mockResolvedValue(stateOf({ kind: "behind", installed: "0.140.0" }));
    renderPanel({ busy: true });
    expect(await screen.findByRole("button", { name: "Update Codex" })).toBeDisabled();
  });

  it.each(["off", "preview"] as const)("hides automatic updates while Hivra's switch is %s", async (mode) => {
    mockGet.mockResolvedValue(stateOf({ kind: "current", installed: TESTED }, { autoUpdate: { mode, enabled: true, source: "default", pausedFor: null } }));
    renderPanel();
    await screen.findByTestId("agent-software-state");
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it("offers automatic updates when Hivra runs them, with its default, and saves the owner's choice", async () => {
    mockGet.mockResolvedValue(stateOf({ kind: "current", installed: TESTED }, { autoUpdate: { mode: "on", enabled: true, source: "default", pausedFor: null } }));
    mockSetAuto.mockResolvedValue(stateOf({ kind: "current", installed: TESTED }, { autoUpdate: { mode: "on", enabled: false, source: "owner", pausedFor: null } }));
    renderPanel();
    const toggle = await screen.findByRole("switch", { name: "Update automatically" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText(/never while a reply is being written\. On by default for agents on Hivra Cloud\./)).toBeInTheDocument();
    fireEvent.click(toggle);
    await waitFor(() => expect(mockSetAuto).toHaveBeenCalledWith("agent-1", false));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Update automatically" })).toHaveAttribute("aria-checked", "false"));
    expect(screen.queryByText(/by default/)).not.toBeInTheDocument();
  });

  it("says automatic updates are paused after a failed one", async () => {
    mockGet.mockResolvedValue(stateOf({ kind: "update_rolled_back", target: TESTED, installed: "0.140.0" }, { autoUpdate: { mode: "on", enabled: true, source: "default", pausedFor: { target: TESTED, reason: "rolled_back" } } }));
    renderPanel();
    expect(await screen.findByText(`Automatic updates are paused for ${TESTED}.`)).toBeInTheDocument();
    expect(screen.getByText(`Paused after the update to ${TESTED} didn't install. Update Codex to try again.`)).toBeInTheDocument();
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

  it("tells an agent without a CLI of its own only that its connection service is older", async () => {
    mockGet.mockResolvedValue({ ...stateOf({ kind: "older_connection_service" }), cli: null, tested: null, autoUpdate: null });
    const view = renderPanel({ agent: agentOf({ type: "aeon" }), name: "Aeon" });
    expect(await stateText()).toMatch(/^This agent's connection service is older than Hivra's current one\. Update the connection service below/);
    view.unmount();
    resetAgentSoftwareForTests();
    mockGet.mockResolvedValue({ ...stateOf({ kind: "not_reported" }), cli: null, tested: null, autoUpdate: null });
    const { container } = renderPanel({ agent: agentOf({ type: "aeon" }), name: "Aeon" });
    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("is not shown for agents Hivra doesn't check here", () => {
    const { container } = renderPanel({ agent: agentOf({ type: "deepseek-harness" }) });
    expect(container).toBeEmptyDOMElement();
    expect(mockGet).not.toHaveBeenCalled();
  });
});

describe("AgentSoftwareChip", () => {
  it.each<[AgentSoftwareView, string, RegExp]>([
    [{ kind: "behind", installed: "0.140.0" }, "Update available", /^Update available: Codex 0\.140\.0 is installed and Hivra has tested 0\.149\.1\. Open Updates\.$/],
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

  it.each<AgentSoftwareView>([
    { kind: "current", installed: TESTED },
    { kind: "ahead_custom", installed: "0.160.0" },
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
    mockGet.mockResolvedValue(stateOf({ kind: "behind", installed: "0.140.0" }));
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
    expect(nextAgentSoftwarePoll(stateOf({ kind: "update_done", target: TESTED, installed: TESTED }), 0, 0, 1_000)).toBeNull();
    expect(nextAgentSoftwarePoll(stateOf({ kind: "behind", installed: "0.140.0" }), null, 0, 0)).toBeNull();
  });
  it("keeps looking for a minute for an update just asked for that the computer hasn't reported", () => {
    const behind = stateOf({ kind: "behind", installed: "0.140.0" });
    expect(nextAgentSoftwarePoll(behind, 0, 0, 10_000)).toBe(3_000);
    expect(nextAgentSoftwarePoll(behind, 0, 0, 61_000)).toBeNull();
    expect(nextAgentSoftwarePoll(stateOf({ kind: "current", installed: TESTED }), 0, 0, 10_000)).toBeNull();
  });

  it("polls while updating, pauses while the page is hidden, and stops when done", async () => {
    jest.useFakeTimers();
    let hidden = false;
    const visibility = jest.spyOn(document, "visibilityState", "get").mockImplementation(() => (hidden ? "hidden" : "visible"));
    try {
      mockGet
        .mockResolvedValueOnce(stateOf({ kind: "updating", phase: "downloading", target: TESTED, installed: "0.140.0" }))
        .mockResolvedValueOnce(stateOf({ kind: "updating", phase: "installing", target: TESTED, installed: "0.140.0" }))
        .mockResolvedValue(stateOf({ kind: "update_done", target: TESTED, installed: TESTED }));
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
