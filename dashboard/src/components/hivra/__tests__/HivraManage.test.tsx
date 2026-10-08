/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { HivraManage as RealHivraManage } from "../HivraManage";
import { AgentActionError, ProviderResizeApiError, type HivraAgent, type PlanInfo } from "@/lib/hivra/agent-api";
import { getAgent } from "@/lib/hivra/agent-catalog";
import { manageCapabilitiesFor, type ManageCapabilitiesContext } from "@/lib/hivra/manage-capabilities";
import { ATTACH_UPDATE_RUNTIME_COPY } from "@/lib/agent-computers/attach-copy";

/**
 * The agent as GET /api/hivra/agents/[id] returns it: with the server's
 * capability map, computed from the stored row. A Proxmox row carries its
 * ownership binding unless the test says otherwise.
 */
function withManage(agent: HivraAgent, row: Record<string, unknown> = {}, ctx: Partial<ManageCapabilitiesContext> = {}): HivraAgent {
  const stored = {
    infrastructure_binding_token_enforced: true,
    desired_state: agent.status === "stopped" ? "stopped" : "running",
    ...agent,
    ...row,
  };
  return { ...agent, manage: manageCapabilitiesFor(stored, { preparedMatch: true, ...ctx }) };
}

/** Renders Manage with the server's map, unless the test passes its own. */
function HivraManage({ row, ctx, ...props }: ComponentProps<typeof RealHivraManage> & {
  row?: Record<string, unknown>;
  ctx?: Partial<ManageCapabilitiesContext>;
}) {
  const agent = props.agent.manage ? props.agent : withManage(props.agent, row, ctx);
  return <RealHivraManage {...props} agent={agent} />;
}

const openSection = (name: string) => fireEvent.click(screen.getByRole("tab", { name }));

const mockBrowserToggle = jest.fn();
const mockDeleteAgent = jest.fn();
const mockUpdateAgentRuntime = jest.fn();
const mockStartAgent = jest.fn();
const mockStopAgent = jest.fn();
const mockRestartAgent = jest.fn();
const mockResizeAgent = jest.fn();
const mockListAgentSnapshots = jest.fn();
const mockSnapshotAgent = jest.fn();
const mockRestoreAgentSnapshot = jest.fn();
const mockGetProviderResizeState = jest.fn();
const mockListBoxMcp = jest.fn();
const mockRemoveBoxMcp = jest.fn();
const mockAddBoxMcp = jest.fn();
const mockListBoxChatRuns = jest.fn();
const mockGetAgentEvents = jest.fn();
jest.mock("@/lib/hivra/agent-api", () => ({
  ...jest.requireActual("@/lib/hivra/agent-api"),
  browserToggle: (...args: unknown[]) => mockBrowserToggle(...args),
  deleteAgent: (...args: unknown[]) => mockDeleteAgent(...args),
  updateAgentRuntime: (...args: unknown[]) => mockUpdateAgentRuntime(...args),
  startAgent: (...args: unknown[]) => mockStartAgent(...args),
  stopAgent: (...args: unknown[]) => mockStopAgent(...args),
  restartAgent: (...args: unknown[]) => mockRestartAgent(...args),
  resizeAgent: (...args: unknown[]) => mockResizeAgent(...args),
  listAgentSnapshots: (...args: unknown[]) => mockListAgentSnapshots(...args),
  snapshotAgent: (...args: unknown[]) => mockSnapshotAgent(...args),
  restoreAgentSnapshot: (...args: unknown[]) => mockRestoreAgentSnapshot(...args),
  getProviderResizeState: (...args: unknown[]) => mockGetProviderResizeState(...args),
  getBoxModel: async () => ({ model: null }),
  getBoxRestrict: async () => ({ restrict: "" }),
  listBoxMcp: (...args: unknown[]) => mockListBoxMcp(...args),
  removeBoxMcp: (...args: unknown[]) => mockRemoveBoxMcp(...args),
  addBoxMcp: (...args: unknown[]) => mockAddBoxMcp(...args),
  listBoxChatRuns: (...args: unknown[]) => mockListBoxChatRuns(...args),
  getAgentEvents: (...args: unknown[]) => mockGetAgentEvents(...args),
}));
jest.mock("@/lib/hivra/agent-model-settings-api", () => ({
  ...jest.requireActual("@/lib/hivra/agent-model-settings-api"),
  getAgentModelSettings: async () => ({ llm: null, pending: null }),
}));

const mockFetchComputerContract = jest.fn();
jest.mock("@/lib/hivra/computer-contract-client", () => ({
  fetchComputerContract: (...args: unknown[]) => mockFetchComputerContract(...args),
  runComputerContractAction: jest.fn(),
}));
jest.mock("@/components/instances/CookieImportModal", () => ({ CookieImportModal: () => null }));
jest.mock("../ToolInstallPicker", () => ({ ToolInstallPicker: () => <div>Tool picker</div> }));
jest.mock("../HivraPrivateAccessPanel", () => ({ HivraPrivateAccessPanel: () => <div>Private access panel</div> }));
jest.mock("@/components/billing/UpgradePaywallModal", () => ({ UpgradePaywallModal: () => null }));

describe("HivraManage lifecycle guidance", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.history.replaceState(null, "", "/dashboard/agent/test-agent?tab=manage");
    mockBrowserToggle.mockResolvedValue({ ok: true });
    mockDeleteAgent.mockReset();
    mockUpdateAgentRuntime.mockResolvedValue(undefined);
    mockStartAgent.mockResolvedValue(undefined);
    mockStopAgent.mockResolvedValue(undefined);
    mockRestartAgent.mockResolvedValue(undefined);
    mockResizeAgent.mockResolvedValue(undefined);
    mockSnapshotAgent.mockResolvedValue(undefined);
    mockRestoreAgentSnapshot.mockResolvedValue(undefined);
    mockListAgentSnapshots.mockResolvedValue({ snapshots: [], supported: true, maximum: 5 });
    mockGetProviderResizeState.mockImplementation(() => new Promise(() => undefined));
    mockListBoxMcp.mockResolvedValue({ servers: [] });
    mockRemoveBoxMcp.mockResolvedValue({ ok: true });
    mockFetchComputerContract.mockResolvedValue({ kind: "not_started", channel: "proxmox-seed" });
    mockListBoxChatRuns.mockResolvedValue(null);
    mockGetAgentEvents.mockResolvedValue([]);
  });
  const agent: HivraAgent = { id: "test-agent", name: "TEST", type: "codex", status: "running", cpu: 2, ram: 4, deployment_mode: "hivra-managed" };
  const plan: PlanInfo = { key: "command", name: "Command", subscribed: true, maxAgents: 8, maxCpuPerAgent: 8, maxRamPerAgent: 16, poolCpu: 24, poolRam: 128, usage: { agentCount: 3, usedCpu: 22, usedRam: 124 } };

  function confirmDeletion() {
    openSection("Advanced");
    fireEvent.click(screen.getByRole("button", { name: "Destroy" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /I understand this is irreversible/ }));
    fireEvent.change(screen.getByPlaceholderText("TEST"), { target: { value: "TEST" } });
    fireEvent.click(screen.getByRole("button", { name: "Permanently destroy" }));
  }

  it("keeps provider deletion pending until all cleanup is confirmed and explains the resources being removed", async () => {
    let finish!: () => void;
    mockDeleteAgent.mockImplementation((_id, options) => {
      options.onProgress("Removing the original server and IPs…");
      return new Promise<void>(resolve => { finish = resolve; });
    });
    const onDestroyed = jest.fn();
    render(<HivraManage agent={{ ...agent, computer_substrate: "provider-vm", deployment_mode: "self-managed" }} plan={null} onChanged={jest.fn()} onDestroyed={onDestroyed} browserOn={false} />);
    expect(screen.getByText(/dedicated cloud computer/)).toHaveTextContent("Billing may continue");
    confirmDeletion();
    expect(screen.getByText(/This also deletes its original Hetzner server/)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Removing the original server and IPs");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Permanently destroy" })).toBeDisabled();
    expect(onDestroyed).not.toHaveBeenCalled();
    await act(async () => finish());
    expect(onDestroyed).toHaveBeenCalledTimes(1);
  });

  it("retains the computer after an uncertain deletion and lets its owner inspect before resuming", async () => {
    mockDeleteAgent.mockRejectedValue(new Error("Computer deletion is incomplete. Provider billing may continue."));
    const onDestroyed = jest.fn();
    render(<HivraManage agent={agent} plan={plan} onChanged={jest.fn()} onDestroyed={onDestroyed} browserOn={false} />);
    confirmDeletion();
    await waitFor(() => expect(screen.getByText("Computer deletion is incomplete. Provider billing may continue.")).toBeInTheDocument());
    expect(onDestroyed).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it.each(["unmount", "switch"])("stops further removal checks on %s without pretending changes were undone", async change => {
    let finish!: () => void;
    mockDeleteAgent.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const onDestroyed = jest.fn();
    const props = { agent, plan, onChanged: jest.fn(), onDestroyed, browserOn: false };
    const view = render(<HivraManage {...props} />);
    confirmDeletion();
    const signal = mockDeleteAgent.mock.calls[0][1].signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    if (change === "unmount") view.unmount();
    else view.rerender(<HivraManage {...props} agent={{ ...agent, id: "another-computer" }} />);
    expect(signal.aborted).toBe(true);
    await act(async () => finish());
    expect(onDestroyed).not.toHaveBeenCalled();
  });

  it("pauses managed browser enable while the plan is unknown", async () => {
    const onChanged = jest.fn();
    render(<HivraManage agent={{ ...agent, chat_url: "https://box.example.com", api_token: "test-token" }} def={getAgent("codex")} plan={null} browserOn={false} onChanged={onChanged} onDestroyed={jest.fn()} />);
    openSection("Model & tools");
    const toggle = screen.getByRole("switch", { name: "Enable browser automation" });
    expect(toggle).toBeDisabled();
    fireEvent.click(toggle);
    expect(mockBrowserToggle).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Check plan" }));
    expect(onChanged).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole("button", { name: "Default" })).toBeInTheDocument());
  });

  it("does not imply that disabling a provider computer browser resizes its billed server", () => {
    render(<HivraManage agent={{ ...agent, chat_url: "https://box.test", computer_substrate: "provider-vm", deployment_mode: "self-managed" }} def={getAgent("codex")} plan={null} browserOn={false} onChanged={jest.fn()} onDestroyed={jest.fn()} />);
    expect(screen.getByText(/turning the browser off does not resize/)).toBeInTheDocument();
    expect(screen.queryByText(/can resize down to/)).not.toBeInTheDocument();
  });

  it("describes a connected computer without claiming Hivra-operated host access", async () => {
    render(<HivraManage agent={{ ...agent, chat_url: "https://box.test", computer_substrate: "provider-vm", deployment_mode: "self-managed" }} def={getAgent("codex")} plan={null} browserOn={false} onChanged={jest.fn()} onDestroyed={jest.fn()} />);
    expect(screen.getByText(/Hivra does not become the host operator/)).toBeInTheDocument();
    expect(screen.queryByText(/Hivra administrators retain infrastructure access/)).not.toBeInTheDocument();
    openSection("Model & tools");
    await waitFor(() => expect(screen.getByRole("button", { name: "Default" })).toBeInTheDocument());
  });

  it.each([
    { deployment_mode: "self-managed", browserOn: false, next: true, name: "Enable browser automation" },
    { deployment_mode: "hivra-managed", browserOn: true, next: false, name: "Disable browser automation" },
  ] as const)("allows $name for $deployment_mode without managed plan evidence", async ({ deployment_mode, browserOn, next, name }) => {
    render(<HivraManage agent={{ ...agent, deployment_mode, chat_url: "https://box.example.com", api_token: "test-token" }} def={getAgent("codex")} plan={null} browserOn={browserOn} onChanged={jest.fn()} onDestroyed={jest.fn()} />);
    openSection("Model & tools");
    fireEvent.click(screen.getByRole("switch", { name }));
    await waitFor(() => expect(mockBrowserToggle).toHaveBeenCalledWith("https://box.example.com", next, "test-token"));
  });

  it("limits resize using account-wide usage", () => {
    render(<HivraManage agent={agent} plan={plan} onChanged={jest.fn()} onDestroyed={jest.fn()} browserOn={false} />);
    openSection("Resources");
    expect(within(screen.getByLabelText("Reserved CPU")).getByRole("button", { name: "4 CPU" })).toBeEnabled();
    expect(within(screen.getByLabelText("Reserved CPU")).getByRole("button", { name: "8 CPU" })).toBeDisabled();
    expect(within(screen.getByLabelText("Reserved memory")).getByRole("button", { name: "16 GB" })).toBeDisabled();
    expect(within(screen.getByLabelText("Maximum CPU")).getByRole("button", { name: "8 CPU" })).toBeEnabled();
  });

  it("loads saved maxima and sends a maxima-only resize", async () => {
    const onChanged = jest.fn();
    render(<HivraManage agent={{ ...agent, cpu_max: 4, ram_max: 8 }} plan={plan} onChanged={onChanged} onDestroyed={jest.fn()} browserOn={false} />);
    openSection("Resources");
    expect(within(screen.getByLabelText("Maximum CPU")).getByRole("button", { name: "4 CPU" })).toHaveAttribute("aria-pressed", "true");
    expect(within(screen.getByLabelText("Maximum memory")).getByRole("button", { name: "8 GB" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(screen.getByLabelText("Maximum CPU")).getByRole("button", { name: "6 CPU" }));
    fireEvent.click(screen.getByRole("button", { name: /Apply · 2 CPU \/ 4 GB reserved · 6 CPU \/ 8 GB max/ }));
    await waitFor(() => expect(mockResizeAgent).toHaveBeenCalledWith("test-agent", 2, 4, 6, 8));
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("keeps saved fractional CPU and 3 GB memory visible as selected resource choices", () => {
    render(<HivraManage agent={{ ...agent, cpu: 1.5, ram: 3, cpu_max: 2, ram_max: 4 }} plan={plan} onChanged={jest.fn()} onDestroyed={jest.fn()} browserOn={false} />);
    // Overview's size links to Resources, which opens in place.
    fireEvent.click(screen.getByRole("button", { name: "See resources" }));
    expect(screen.getByRole("tab", { name: "Resources" })).toHaveAttribute("aria-selected", "true");
    expect(within(screen.getByLabelText("Reserved CPU")).getByRole("button", { name: "1.5 CPU" })).toHaveAttribute("aria-pressed", "true");
    expect(within(screen.getByLabelText("Reserved memory")).getByRole("button", { name: "3 GB" })).toHaveAttribute("aria-pressed", "true");
  });

  it("scrolls to Resources after a hash-linked Manage surface mounts", async () => {
    window.history.replaceState(null, "", "/dashboard/agent/test-agent?tab=manage#resources");
    const scrollIntoView = jest.fn();
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    try {
      render(<HivraManage agent={agent} plan={plan} onChanged={jest.fn()} onDestroyed={jest.fn()} browserOn={false} />);
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" }));
      expect(document.getElementById("resources")).toBeInTheDocument();
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
    }
  });

  it("canonicalizes a duplicated Resources fragment before scrolling", async () => {
    window.history.replaceState(null, "", "/dashboard/agent/test-agent?tab=manage#resources#resources");
    const scrollIntoView = jest.fn();
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    try {
      render(<HivraManage agent={agent} plan={plan} onChanged={jest.fn()} onDestroyed={jest.fn()} browserOn={false} />);
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" }));
      expect(window.location.hash).toBe("#resources");
      expect(new URLSearchParams(window.location.search).get("tab")).toBe("manage");
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
    }
  });

  // Reproduced on Canary 2026-09-25: a computer whose Start failed opened on
  // Manage with only an "Error" badge; the reason sat under Advanced.
  it("says on Overview why a started computer is in Error and what to do next", () => {
    render(<HivraManage agent={{ ...agent, status: "error", provisioned_at: "2026-09-12T08:30:00Z",
      error: "This computer turned on, but Hivra couldn’t confirm its desktop is safe to open. Choose Restart in Manage to try again." }}
      plan={plan} onChanged={jest.fn()} onDestroyed={jest.fn()} browserOn={false} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("This computer isn’t ready");
    expect(alert).toHaveTextContent("Choose Restart in Manage to try again.");
  });
  it("shows no error callout once the computer is running again", () => {
    render(<HivraManage agent={{ ...agent, status: "running", error: "stale" }} plan={plan} onChanged={jest.fn()} onDestroyed={jest.fn()} browserOn={false} />);
    expect(screen.queryByText("This computer isn’t ready")).not.toBeInTheDocument();
  });
  it("allows removal but not conflicting power or resize actions during provisioning", () => {
    render(<HivraManage agent={{ ...agent, status: "provisioning", deployment_mode: "self-managed", computer_substrate: "provider-vm" }} plan={null} onChanged={jest.fn()} onDestroyed={jest.fn()} browserOn={false} />);
    expect(screen.getByRole("button", { name: "Stop" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Restart" })).toBeDisabled();
    expect(screen.getByText("Wait for the current operation to finish.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "4" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Apply" })).not.toBeInTheDocument();
    openSection("Advanced");
    expect(screen.getByRole("button", { name: "Destroy" })).toBeEnabled();
  });
  it("shows the saved resource envelope but prevents edits during a pending Proxmox lifecycle", () => {
    render(<HivraManage agent={{ ...agent, status: "provisioning", computer_substrate: "proxmox-kvm", cpu_max: 4, ram_max: 8 }} plan={plan} onChanged={jest.fn()} onDestroyed={jest.fn()} browserOn={false} />);
    openSection("Resources");
    expect(screen.getByLabelText("Reserved CPU")).toBeVisible();
    expect(within(screen.getByLabelText("Maximum CPU")).getByRole("button", { name: "4 CPU" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
  });
  it("shows an unsupported provider resize as a fixed size while provider power controls remain available", async () => {
    mockGetProviderResizeState.mockRejectedValue(new ProviderResizeApiError("This computer does not have a verified Hetzner resize capability.", 409, "not_supported"));
    render(<HivraManage agent={{ ...agent, computer_substrate: "provider-vm", deployment_mode: "self-managed" }} plan={null} onChanged={jest.fn()} onDestroyed={jest.fn()} browserOn={false} />);
    await waitFor(() => expect(mockGetProviderResizeState).toHaveBeenCalledWith("test-agent"));
    expect(screen.queryByTestId("provider-resize-panel")).not.toBeInTheDocument();
    // Resources is never empty: it says the size is fixed, and why.
    expect(await screen.findByTestId("provider-resize-fixed")).toHaveTextContent("Hivra can't change this Hetzner server type from here.");
    expect(screen.queryByRole("button", { name: "Apply" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Restart" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Update connection service" })).not.toBeInTheDocument();
  });
  it("updates a running Proxmox computer's runtime in place without presenting a restart", async () => {
    let finish!: () => void;
    mockUpdateAgentRuntime.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const onChanged = jest.fn();
    const onConnectionServiceRestarted = jest.fn();
    render(<HivraManage agent={{ ...agent, computer_substrate: "proxmox-kvm" }} plan={plan} onChanged={onChanged} onConnectionServiceRestarted={onConnectionServiceRestarted} onDestroyed={jest.fn()} browserOn={false} />);
    openSection("Updates");
    expect(screen.queryByRole("button", { name: /Update & restart/ })).not.toBeInTheDocument();
    const update = screen.getByRole("button", { name: "Update connection service" });
    // The attach gate sends the owner here by this button's name. It used to
    // say "choose Update & restart", a button Manage doesn't have.
    expect(ATTACH_UPDATE_RUNTIME_COPY).toContain(`choose ${update.textContent?.trim()},`);
    expect(update).toHaveAttribute("title", expect.stringMatching(/without restarting the computer/));
    const guidance = screen.getByText(/brings Hivra’s connection service up to date/);
    expect(guidance).toHaveTextContent("without restarting the computer");
    expect(guidance).toHaveTextContent("model credentials");
    expect(guidance).not.toHaveTextContent(/then reboots/);
    // Only what the page actually does: it signs its terminals in again.
    expect(guidance).toHaveTextContent("Terminals open on this page reconnect when it finishes.");
    expect(guidance).not.toHaveTextContent(/after a few seconds/);

    fireEvent.click(update);

    const progress = screen.getByText("Updating the connection service…").closest("[role=\"status\"]");
    expect(progress).toHaveTextContent("The computer keeps running");
    expect(progress).not.toHaveTextContent(/reboot/i);
    await waitFor(() => expect(mockUpdateAgentRuntime).toHaveBeenCalledWith("test-agent"));
    // The gateway is not back yet: surfaces must not sign in to it early.
    expect(onConnectionServiceRestarted).not.toHaveBeenCalled();
    await act(async () => finish());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(onConnectionServiceRestarted).toHaveBeenCalledTimes(1);
    // The update never asks the computer about replies: detached runs survive it.
    expect(mockListBoxChatRuns).not.toHaveBeenCalled();
  });

  it.each([
    ["an unverified outcome, which may have restarted or rolled back the gateway", 502, 1],
    ["a refusal before anything reached the computer", 409, 0],
  ])("signs page surfaces in again after %s only when the gateway may have restarted", async (_case, status, calls) => {
    mockUpdateAgentRuntime.mockRejectedValue(new AgentActionError("Update outcome fixture.", status));
    const onConnectionServiceRestarted = jest.fn();
    render(<HivraManage agent={{ ...agent, computer_substrate: "proxmox-kvm" }} plan={plan} onChanged={jest.fn()} onConnectionServiceRestarted={onConnectionServiceRestarted} onDestroyed={jest.fn()} browserOn={false} />);
    openSection("Updates");

    fireEvent.click(screen.getByRole("button", { name: "Update connection service" }));

    expect(await screen.findByText("Update outcome fixture.")).toBeInTheDocument();
    expect(onConnectionServiceRestarted).toHaveBeenCalledTimes(calls);
  });

  it("does not offer an in-place update to a DeepSeek computer, which the server refuses", () => {
    render(<HivraManage agent={{ ...agent, type: "deepseek-harness", computer_substrate: "proxmox-kvm" }} def={getAgent("deepseek-harness")} plan={plan} onChanged={jest.fn()} onDestroyed={jest.fn()} browserOn={false} />);

    expect(screen.queryByRole("button", { name: "Update connection service" })).not.toBeInTheDocument();
    expect(screen.queryByText(/brings Hivra’s connection service up to date/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restart" })).toBeEnabled();
    // Nothing disappears silently: Advanced says why.
    expect(screen.queryByRole("tab", { name: "Updates" })).not.toBeInTheDocument();
    openSection("Advanced");
    expect(screen.getByText("DeepSeek computers can't update their connection service here yet.")).toBeVisible();
  });

  describe("replies in progress before an action that powers the computer off", () => {
    const chatAgent: HivraAgent = {
      ...agent,
      computer_substrate: "proxmox-kvm",
      chat_url: "https://box-test.example",
      api_token: "box-fixture-token",
    };
    const running = (runId: string) => ({ runId, clientRef: null, state: "running" as const, title: "t", code: null, stopped: null, interrupted: false, agentSessionId: null, createdAt: "2026-09-24T10:00:00.000Z", finishedAt: null });
    const finished = (runId: string) => ({ ...running(runId), state: "finished" as const, code: 0, finishedAt: "2026-09-24T10:01:00.000Z" });
    function renderChat(props: Partial<{ agent: HivraAgent; def: ReturnType<typeof getAgent> }> = {}) {
      const onChanged = jest.fn();
      render(<HivraManage agent={props.agent ?? chatAgent} def={props.def ?? getAgent("codex")} plan={plan} onChanged={onChanged} onDestroyed={jest.fn()} browserOn={false} />);
      return onChanged;
    }

    it.each([
      ["Restart", mockRestartAgent, "Restart anyway", "2 replies are still being written and will stop."],
      ["Stop", mockStopAgent, "Stop anyway", "2 replies are still being written and will stop."],
    ] as const)("asks before %s ends replies the computer is still writing", async (button, request, proceed, message) => {
      mockListBoxChatRuns.mockResolvedValue([running("run-a"), finished("run-b"), running("run-c")]);
      const onChanged = renderChat();

      fireEvent.click(screen.getByRole("button", { name: button }));

      const dialog = await screen.findByRole("alertdialog");
      expect(dialog).toHaveTextContent(message);
      expect(mockListBoxChatRuns).toHaveBeenCalledWith("https://box-test.example", "box-fixture-token", expect.any(AbortSignal));
      expect(request).not.toHaveBeenCalled();

      fireEvent.click(within(dialog).getByRole("button", { name: proceed }));

      await waitFor(() => expect(request).toHaveBeenCalledWith("test-agent"));
      await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });

    it("uses the singular for one reply and sends nothing when the owner cancels", async () => {
      mockListBoxChatRuns.mockResolvedValue([running("run-a")]);
      renderChat({ def: getAgent("claude-code") });

      fireEvent.click(screen.getByRole("button", { name: "Restart" }));
      const dialog = await screen.findByRole("alertdialog");
      expect(dialog).toHaveTextContent("1 reply is still being written and will stop.");
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      expect(mockRestartAgent).not.toHaveBeenCalled();
      expect(mockStopAgent).not.toHaveBeenCalled();
    });

    it.each([
      ["has no run API (older runtime or unreachable)", null],
      ["has only finished replies", [finished("run-a")]],
      ["has no replies", []],
    ])("restarts straight away when the computer %s", async (_case, runs) => {
      mockListBoxChatRuns.mockResolvedValue(runs);
      const onChanged = renderChat();

      fireEvent.click(screen.getByRole("button", { name: "Restart" }));

      await waitFor(() => expect(mockRestartAgent).toHaveBeenCalledWith("test-agent"));
      await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });

    it("does not hold Stop behind a computer that never answers", async () => {
      jest.useFakeTimers();
      try {
        mockListBoxChatRuns.mockImplementation((_url: string, _token: string, signal: AbortSignal) => new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve(null));
        }));
        renderChat();

        fireEvent.click(screen.getByRole("button", { name: "Stop" }));
        expect(screen.getByRole("button", { name: "Restart" })).toBeDisabled();
        expect(mockStopAgent).not.toHaveBeenCalled();
        await act(async () => { jest.advanceTimersByTime(4_000); });

        expect(mockStopAgent).toHaveBeenCalledWith("test-agent");
        expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      } finally {
        jest.useRealTimers();
      }
    });

    it("asks before a resize restarts the computer and sends the size selected when confirmed", async () => {
      mockListBoxChatRuns.mockResolvedValue([running("run-a")]);
      const onChanged = renderChat();
      openSection("Resources");

      fireEvent.click(within(screen.getByLabelText("Maximum CPU")).getByRole("button", { name: "6 CPU" }));
      fireEvent.click(screen.getByRole("button", { name: /Apply · 2 CPU \/ 4 GB reserved · 6 CPU \/ 4 GB max/ }));

      const dialog = await screen.findByRole("alertdialog");
      expect(dialog).toHaveTextContent("1 reply is still being written and will stop.");
      expect(dialog).toHaveTextContent("Resizing restarts the computer, which ends it now.");
      expect(mockResizeAgent).not.toHaveBeenCalled();

      fireEvent.click(within(dialog).getByRole("button", { name: "Resize anyway" }));

      await waitFor(() => expect(mockResizeAgent).toHaveBeenCalledWith("test-agent", 2, 4, 6, 4));
      await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });

    it("resizes a stopped computer without asking it anything", async () => {
      renderChat({ agent: { ...chatAgent, status: "stopped" } });
      openSection("Resources");

      fireEvent.click(within(screen.getByLabelText("Maximum CPU")).getByRole("button", { name: "6 CPU" }));
      fireEvent.click(screen.getByRole("button", { name: /Apply · 2 CPU \/ 4 GB reserved · 6 CPU \/ 4 GB max/ }));

      await waitFor(() => expect(mockResizeAgent).toHaveBeenCalledWith("test-agent", 2, 4, 6, 4));
      expect(mockListBoxChatRuns).not.toHaveBeenCalled();
    });

    it("asks before a restore stops the computer, after the restore confirmation", async () => {
      mockListAgentSnapshots.mockResolvedValue({
        supported: true,
        maximum: 5,
        snapshots: [{
          id: "snapshot-1",
          status: "ready",
          retentionPolicy: "until_agent_delete",
          createdAt: "2026-08-30T12:00:00.000Z",
          readyAt: "2026-08-30T12:00:01.000Z",
          lastRestoredAt: null,
          restoreCount: 0,
          error: null,
        }],
      });
      mockListBoxChatRuns.mockResolvedValue([running("run-a"), running("run-b")]);
      const onChanged = renderChat();
      openSection("Recovery");

      fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
      fireEvent.click(screen.getByRole("button", { name: "Confirm restore" }));

      const dialog = await screen.findByRole("alertdialog");
      expect(dialog).toHaveTextContent("2 replies are still being written and will stop.");
      expect(dialog).toHaveTextContent("Restoring stops the computer, which ends them now.");
      expect(mockRestoreAgentSnapshot).not.toHaveBeenCalled();

      fireEvent.click(within(dialog).getByRole("button", { name: "Restore anyway" }));

      await waitFor(() => expect(mockRestoreAgentSnapshot).toHaveBeenCalledWith("test-agent", "snapshot-1"));
      await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    });

    it("asks nothing of a computer without a chat agent", async () => {
      renderChat({ agent: { ...chatAgent, type: "linux-desktop", computer_profile: "ubuntu-desktop" }, def: getAgent("linux-desktop") });

      fireEvent.click(screen.getByRole("button", { name: "Restart" }));

      await waitFor(() => expect(mockRestartAgent).toHaveBeenCalledWith("test-agent"));
      expect(mockListBoxChatRuns).not.toHaveBeenCalled();
    });
  });
  it("keeps clear restart progress visible until the lifecycle request finishes", async () => {
    let finish!: () => void;
    mockRestartAgent.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const onChanged = jest.fn();
    render(<HivraManage agent={{ ...agent, type: "linux-desktop", computer_profile: "omarchy" }} plan={plan} onChanged={onChanged} onDestroyed={jest.fn()} browserOn={false} />);

    fireEvent.click(screen.getByRole("button", { name: "Restart" }));

    expect(screen.getByRole("status")).toHaveTextContent("Restarting the computer");
    expect(screen.getByRole("status")).toHaveTextContent("desktop will disconnect briefly");
    expect(screen.getByRole("button", { name: "Stop" })).toBeDisabled();
    expect(onChanged).not.toHaveBeenCalled();

    await act(async () => finish());
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    expect(onChanged).toHaveBeenCalledTimes(1);
  });
  it("keeps agent-free Ubuntu management copy computer-specific", () => {
    render(<HivraManage
      agent={{ ...agent, type: "linux-desktop", computer_profile: "ubuntu-desktop", computer_substrate: "proxmox-kvm" }}
      def={getAgent("linux-desktop")}
      plan={plan}
      onChanged={jest.fn()}
      onDestroyed={jest.fn()}
      browserOn={false}
    />);
    expect(screen.getByText("Computer")).toBeInTheDocument();
    expect(screen.getByText(/apps, files, and local logins stay as they are/)).toHaveTextContent("without restarting the computer");
    expect(screen.getByText(/Permanently deletes this computer and everything on it/)).toBeInTheDocument();
    expect(screen.queryByText(/Permanently deletes the agent and everything on it/)).not.toBeInTheDocument();
  });
  it.each([
    { profile: "windows" as const, name: "Windows" },
    { profile: "omarchy" as const, name: "Omarchy" },
  ])("uses the real $name profile and hides unsupported prepared-image controls", ({ profile, name }) => {
    render(<HivraManage
      agent={{ ...agent, type: "linux-desktop", computer_profile: profile, computer_substrate: "proxmox-kvm" }}
      def={getAgent("linux-desktop")}
      plan={plan}
      onChanged={jest.fn()}
      onDestroyed={jest.fn()}
      browserOn={false}
    />);

    expect(screen.getByText(`${name} · Hivra Cloud`)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Restart" })).toBeEnabled();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Overview", "Agents", "Resources", "Advanced"]);
    openSection("Resources");
    expect(screen.getByTestId("manage-fixed-size")).toHaveTextContent(`This ${name} preview has a fixed size of 2 CPU / 4 GB. Hivra can't resize prepared computers yet.`);
    expect(screen.queryByRole("button", { name: /^Apply/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Update connection service" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create restore point" })).not.toBeInTheDocument();
    openSection("Advanced");
    expect(screen.getByText("Prepared Windows and Omarchy computers don't have restore points yet.")).toBeVisible();
    expect(screen.getByText("Hivra can't update prepared Windows and Omarchy computers yet.")).toBeVisible();
    expect(screen.queryByText(/isolated Linux VM/i)).not.toBeInTheDocument();
  });
  it("creates and refreshes an honestly labelled same-host restore point", async () => {
    const onChanged = jest.fn();
    render(<HivraManage agent={{ ...agent, computer_substrate: "proxmox-kvm" }} plan={plan} onChanged={onChanged} onDestroyed={jest.fn()} browserOn={false} />);
    openSection("Recovery");
    expect(await screen.findByText("Same-host recovery")).toBeInTheDocument();
    expect(screen.getByText(/they are not an off-host backup/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create restore point" }));
    await waitFor(() => expect(mockSnapshotAgent).toHaveBeenCalledWith("test-agent"));
    expect(mockListAgentSnapshots).toHaveBeenCalledTimes(2);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });
  it("requires an explicit restore confirmation and explains that the computer stays stopped", async () => {
    mockListAgentSnapshots.mockResolvedValue({
      supported: true,
      maximum: 5,
      snapshots: [{
        id: "snapshot-1",
        status: "ready",
        retentionPolicy: "until_agent_delete",
        createdAt: "2026-08-30T12:00:00.000Z",
        readyAt: "2026-08-30T12:00:01.000Z",
        lastRestoredAt: null,
        restoreCount: 0,
        error: null,
      }],
    });
    const onChanged = jest.fn();
    render(<HivraManage agent={{ ...agent, computer_substrate: "proxmox-kvm" }} plan={plan} onChanged={onChanged} onDestroyed={jest.fn()} browserOn={false} />);
    openSection("Recovery");
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
    expect(screen.getByText(/permanently removes changes made afterward/i)).toHaveTextContent("left stopped");
    expect(mockRestoreAgentSnapshot).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm restore" }));
    await waitFor(() => expect(mockRestoreAgentSnapshot).toHaveBeenCalledWith("test-agent", "snapshot-1"));
    expect(onChanged).toHaveBeenCalledTimes(1);
  });
  it("does not advertise Proxmox restore points for provider computers", async () => {
    render(<HivraManage agent={{ ...agent, computer_substrate: "provider-vm", deployment_mode: "self-managed" }} plan={null} onChanged={jest.fn()} onDestroyed={jest.fn()} browserOn={false} />);
    expect(screen.queryByRole("tab", { name: "Recovery" })).not.toBeInTheDocument();
    expect(screen.queryByText("Same-host recovery")).not.toBeInTheDocument();
    expect(screen.getByText("Restore points aren't available on My cloud computers yet.")).toBeInTheDocument();
    expect(mockListAgentSnapshots).not.toHaveBeenCalled();
  });
  it("keeps the exact pending power activity and uncertainty visible in Manage", () => {
    render(<HivraManage agent={{ ...agent, status: "provisioning", activity: "restart", power_stage: "request_uncertain", computer_substrate: "provider-vm", deployment_mode: "self-managed" }} plan={null} onChanged={jest.fn()} onDestroyed={jest.fn()} browserOn={false} />);
    expect(screen.getByText("restarting")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("No retry or forced power-off");
    // Where it runs, never a made-up region.
    expect(within(screen.getByRole("tabpanel", { name: "Overview" })).getByText("My cloud")).toBeVisible();
    expect(screen.queryByText("EU")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restart" })).toBeDisabled();
  });

  it("does not infer a live browser from catalog support before the computer reports its state", () => {
    const props = { agent: { ...agent, status: "provisioning" as const, deployment_mode: "self-managed" as const, computer_substrate: "provider-vm" as const }, def: getAgent("codex"), plan: null, onChanged: jest.fn(), onDestroyed: jest.fn() };
    const view = render(<HivraManage {...props} browserOn={null} />);
    openSection("Model & tools");
    expect(screen.getByText("Not verified yet")).toBeInTheDocument();
    expect(screen.queryByText("On")).not.toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.queryByText(/agent has a live, self-hosted Chrome/)).not.toBeInTheDocument();
    view.rerender(<HivraManage {...props} browserOn={false} />);
    expect(screen.queryByText("Not verified yet")).not.toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Enable browser automation" })).toBeDisabled();
  });

  it("keeps managed slot-only dashboard sizing fixed", () => {
    render(<HivraManage agent={{ ...agent, type: "aeon", cpu: 0.5, ram: 1 }} plan={plan} onChanged={jest.fn()} onDestroyed={jest.fn()} browserOn={false} />);
    openSection("Resources");
    expect(within(screen.getByLabelText("Reserved CPU")).getByRole("button", { name: "0.5 CPU" })).toBeEnabled();
    expect(within(screen.getByLabelText("Reserved CPU")).getByRole("button", { name: "4 CPU" })).toBeDisabled();
    expect(screen.getByText(/fixed 0.5 CPU \/ 1 GB allocation/)).toBeInTheDocument();
  });

  it("invalidates a selected size when the usage snapshot disappears and offers a refresh", () => {
    const onChanged = jest.fn();
    const props = { agent, onChanged, onDestroyed: jest.fn(), browserOn: false };
    const view = render(<HivraManage {...props} plan={plan} />);
    openSection("Resources");
    fireEvent.click(within(screen.getByLabelText("Reserved CPU")).getByRole("button", { name: "4 CPU" }));
    expect(screen.getByRole("button", { name: /Apply · 4 CPU \/ 4 GB reserved/ })).toBeEnabled();
    view.rerender(<HivraManage {...props} plan={null} />);
    expect(screen.getByRole("button", { name: /Apply · 4 CPU \/ 4 GB reserved/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Refresh capacity" }));
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("keeps self-managed resizing available without managed billing data", () => {
    render(<HivraManage agent={{ ...agent, deployment_mode: "self-managed" }} plan={null} onChanged={jest.fn()} onDestroyed={jest.fn()} browserOn={false} />);
    openSection("Resources");
    expect(within(screen.getByLabelText("Maximum CPU")).getByRole("button", { name: "8 CPU" })).toBeEnabled();
    expect(screen.getByText(/Host capacity is checked before applying/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refresh capacity" })).not.toBeInTheDocument();
  });

  it("replaces the catalog install with an honest line on an agent in the owner's own cloud", async () => {
    // The ?tools=1 deep link must not open an install the server can only refuse.
    window.history.replaceState(null, "", "/dashboard/agent/test-agent?tab=manage&tools=1");
    render(<HivraManage agent={{ ...agent, chat_url: "https://box.test", computer_substrate: "provider-vm", deployment_mode: "self-managed" }} def={getAgent("codex")} plan={null} browserOn={false} onChanged={jest.fn()} onDestroyed={jest.fn()} />);
    expect(screen.getByText("Catalog tools aren't available on computers in your own cloud yet. Use Advanced MCP.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Browse tools/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Tool picker")).not.toBeInTheDocument();
    // Advanced MCP talks to the box itself, so it stays available.
    expect(await screen.findByText("Advanced — connect a raw MCP server")).toBeInTheDocument();
  });

  it.each(["proxmox-kvm", undefined] as const)("keeps the catalog install for a %s agent", (substrate) => {
    window.history.replaceState(null, "", "/dashboard/agent/test-agent?tab=manage&tools=1");
    render(<HivraManage agent={{ ...agent, chat_url: "https://box.test", computer_substrate: substrate }} def={getAgent("codex")} plan={null} browserOn={false} onChanged={jest.fn()} onDestroyed={jest.fn()} />);
    expect(screen.getByRole("button", { name: /Browse tools/ })).toBeInTheDocument();
    expect(screen.getByText("Tool picker")).toBeInTheDocument();
    expect(screen.queryByText(/Catalog tools aren't available/)).not.toBeInTheDocument();
  });

  // Regression: the enrollment panel rendered for every computer and agent,
  // including ones the server refuses (agents, prepared and Hetzner rows).
  it("offers a private network only where the server allows one, and says why elsewhere", () => {
    const props = { plan, onChanged: jest.fn(), onDestroyed: jest.fn(), browserOn: false };
    const ubuntu = { ...agent, type: "linux-desktop" as const, computer_profile: "ubuntu-desktop" as const };
    const view = render(<HivraManage {...props} agent={{ ...ubuntu, computer_substrate: "proxmox-kvm" }} />);
    openSection("Private network");
    expect(screen.getByText("Private access panel")).toBeVisible();
    view.unmount();

    const hetzner = render(<HivraManage {...props} agent={{ ...ubuntu, computer_substrate: "provider-vm", deployment_mode: "self-managed" }} />);
    expect(screen.queryByRole("tab", { name: "Private network" })).not.toBeInTheDocument();
    expect(screen.queryByText("Private access panel")).not.toBeInTheDocument();
    openSection("Advanced");
    expect(within(screen.getByRole("tabpanel", { name: "Advanced" })).getByText("A private network is available on Ubuntu computers on Hivra Cloud and My server.")).toBeVisible();
    hetzner.unmount();

    render(<HivraManage {...props} agent={{ ...agent, computer_substrate: "proxmox-kvm" }} def={getAgent("codex")} />);
    expect(screen.queryByRole("tab", { name: "Private network" })).not.toBeInTheDocument();
    expect(screen.queryByText("Private access panel")).not.toBeInTheDocument();
    expect(screen.queryByText(/private network is available/)).not.toBeInTheDocument();
  });

  it.each(["hivra-managed", "self-managed"] as const)("does not promise billing stops for %s computers", (deployment_mode) => {
    render(<HivraManage
      agent={{ id: "test-agent", name: "TEST", type: "codex", status: "running", cpu: 2, ram: 4, deployment_mode }}
      onChanged={jest.fn()}
      onDestroyed={jest.fn()}
      browserOn={false}
    />);
    expect(screen.getByText(/Stopping does not cancel your plan or any provider billing/)).toBeInTheDocument();
    expect(screen.queryByText(/no compute charges/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Restart" })).toBeEnabled();
  });

  describe("touch safety", () => {
    const chatAgent = { ...agent, chat_url: "https://box.example.com", api_token: "test-token" };

    it("asks before removing a raw MCP server, and Cancel keeps it", async () => {
      mockListBoxMcp.mockResolvedValue({ servers: [{ name: "github", command: "npx", args: ["-y", "server-github"] }], error: null });
      render(<HivraManage agent={chatAgent} def={getAgent("codex")} plan={plan} browserOn={false} onChanged={jest.fn()} onDestroyed={jest.fn()} />);
      openSection("Model & tools");
      fireEvent.click(await screen.findByRole("button", { name: "Remove github" }));
      expect(mockRemoveBoxMcp).not.toHaveBeenCalled();
      expect(screen.getByText("Remove?")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Cancel removing github" }));
      expect(screen.queryByRole("button", { name: "Confirm remove github" })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Remove github" }));
      fireEvent.click(screen.getByRole("button", { name: "Confirm remove github" }));
      await waitFor(() => expect(mockRemoveBoxMcp).toHaveBeenCalledWith("https://box.example.com", "github", "test-token"));
      await waitFor(() => expect(screen.queryByText("github")).not.toBeInTheDocument());
    });

    it("turns the focused MCP trash button into Cancel in place, so focus stays on the safe choice", async () => {
      mockListBoxMcp.mockResolvedValue({ servers: [{ name: "sequential-thinking", command: "npx", args: ["-y", "server-sequential-thinking"] }], error: null });
      render(<HivraManage agent={chatAgent} def={getAgent("codex")} plan={plan} browserOn={false} onChanged={jest.fn()} onDestroyed={jest.fn()} />);
      openSection("Model & tools");
      const trash = await screen.findByRole("button", { name: "Remove sequential-thinking" });
      trash.focus();
      fireEvent.click(trash);
      const cancel = screen.getByRole("button", { name: "Cancel removing sequential-thinking" });
      expect(cancel).toBe(trash);
      expect(cancel).toHaveFocus();
      expect(cancel).toHaveTextContent("Cancel");
      const confirm = screen.getByRole("button", { name: "Confirm remove sequential-thinking" });
      expect(confirm.compareDocumentPosition(cancel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(screen.getByText("sequential-thinking")).toHaveStyle({ minWidth: "0", textOverflow: "ellipsis" });
    });

    it("keeps typed ids lowercase on touch keyboards", async () => {
      render(<HivraManage agent={chatAgent} def={getAgent("codex")} plan={plan} browserOn={false} onChanged={jest.fn()} onDestroyed={jest.fn()} />);
      openSection("Model & tools");
      const inputs = [
        await screen.findByRole("textbox", { name: "Custom model id" }),
        screen.getByRole("textbox", { name: "MCP server name" }),
        screen.getByRole("textbox", { name: "MCP server command" }),
      ];
      const modelInputs = [...inputs];
      openSection("Advanced");
      fireEvent.click(screen.getByRole("button", { name: "Destroy" }));
      inputs.push(screen.getByRole("textbox", { name: "Type TEST to confirm" }));
      for (const input of inputs) {
        expect(input).toHaveAttribute("autocapitalize", "none");
        expect(input).toHaveAttribute("autocorrect", "off");
        expect(input).toHaveAttribute("spellcheck", "false");
      }
      expect(modelInputs[0]).toHaveAttribute("enterkeyhint", "done");
      expect(modelInputs[2]).toHaveAttribute("enterkeyhint", "done");
      expect(screen.getByRole("textbox", { name: "Type TEST to confirm" })).not.toHaveFocus();
    });

    it("links each permission preset to its visible hint before it is applied", async () => {
      render(<HivraManage agent={chatAgent} def={getAgent("codex")} plan={plan} browserOn={false} onChanged={jest.fn()} onDestroyed={jest.fn()} />);
      openSection("Model & tools");
      const readOnly = await screen.findByRole("button", { name: "Read-only" });
      expect(readOnly).toHaveAccessibleDescription("Look but don't touch — research and answers only.");
      expect(screen.getByRole("button", { name: "Full access" })).toHaveAttribute("aria-pressed", "true");
    });

    it("shows a failed resize beneath the Resources controls instead of only at the top", async () => {
      mockResizeAgent.mockRejectedValue(new Error("The host has no spare capacity."));
      render(<HivraManage agent={agent} plan={plan} onChanged={jest.fn()} onDestroyed={jest.fn()} browserOn={false} />);
      openSection("Resources");
      fireEvent.click(within(screen.getByLabelText("Reserved CPU")).getByRole("button", { name: "4 CPU" }));
      fireEvent.click(screen.getByRole("button", { name: /Apply · 4 CPU/ }));
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("The host has no spare capacity.");
      expect(document.getElementById("resources")).toContainElement(alert);
    });

    it("labels the destroy target in product terms and keeps the VM id behind Advanced (ATT-12)", () => {
      render(<HivraManage agent={{ ...agent, vmid: 1104 }} plan={plan} onChanged={jest.fn()} onDestroyed={jest.fn()} browserOn={false} />);
      const advanced = document.getElementById("manage-panel-advanced")!;
      expect(advanced).not.toBeVisible();
      expect(within(screen.getByRole("tabpanel", { name: "Overview" })).queryByText("1104")).not.toBeInTheDocument();
      openSection("Advanced");
      expect(within(advanced).getByText("Destroy this agent")).toBeVisible();
      expect(within(advanced).getByText("VM ID (for support)")).toBeVisible();
      expect(within(advanced).getByText("1104")).toBeVisible();
      expect(screen.queryByText(/Destroy this box/)).not.toBeInTheDocument();
      expect(screen.getByTitle("Reboot the computer")).toBeInTheDocument();
      expect(document.body).not.toHaveTextContent(/\bthe box\b/);
    });

    it("shows the agent with its own computer and what it knows about it, before the computer acknowledges (ATT-11)", async () => {
      render(<HivraManage agent={{ ...agent, cpu: 1.5, ram: 3, computer_substrate: "proxmox-kvm" }} def={getAgent("codex")} plan={plan}
        onChanged={jest.fn()} onDestroyed={jest.fn()} browserOn={false} />);
      const section = screen.getByRole("region", { name: "Computer" });
      expect(screen.getByRole("tabpanel", { name: "Overview" })).toContainElement(section);
      expect(within(section).getByText(/runs on its own computer \(Hivra Cloud · 1\.5 CPU \/ 3 GB\)/)).toBeInTheDocument();
      expect(await within(section).findByText("Update pending")).toBeInTheDocument();
      expect(within(section).getByRole("heading", { name: "What TEST knows about its computer" })).toBeInTheDocument();
      expect(section).not.toHaveTextContent(/Delivered/);
      expect(mockFetchComputerContract).toHaveBeenCalledWith("test-agent", expect.anything());
    });

    it("gives a computer an honest Agent slot instead of a contract where attach is not offered", async () => {
      // Production answers the attach route with 404: the slot is what it was.
      const original = global.fetch;
      global.fetch = jest.fn(async () => ({ status: 404, ok: false, json: async () => ({ success: false, error: "Not found" }) })) as unknown as typeof fetch;
      try {
        render(<HivraManage agent={{ ...agent, type: "linux-desktop", computer_profile: "ubuntu-desktop", computer_substrate: "proxmox-kvm" }}
          def={getAgent("linux-desktop")} plan={plan} onChanged={jest.fn()} onDestroyed={jest.fn()} browserOn={false} />);
        // A computer's agents live in its Agents section, not in Overview.
        openSection("Agents");
        const panel = screen.getByRole("tabpanel", { name: "Agents" });
        expect(await within(panel).findByText("No agent works on this computer.")).toBeInTheDocument();
        expect(within(panel).getByRole("link", { name: "Launch an agent" })).toHaveAttribute("href", "/dashboard/launch?kind=agent&start=1");
        expect(global.fetch).toHaveBeenCalledWith(`/api/hivra/computers/${agent.id}/agents`, { cache: "no-store" });
        expect(mockFetchComputerContract).not.toHaveBeenCalled();
      } finally {
        global.fetch = original;
      }
    });

    it("lists an agent's sections from the server's map, in order", async () => {
      render(<HivraManage agent={{ ...chatAgent, computer_substrate: "proxmox-kvm" }} def={getAgent("codex")} plan={plan} browserOn={false} onChanged={jest.fn()} onDestroyed={jest.fn()} />);
      const nav = screen.getByRole("tablist", { name: "Agent settings" });
      expect(within(nav).getAllByRole("tab").map((tab) => tab.textContent))
        .toEqual(["Overview", "Model & tools", "Resources", "Recovery", "Updates", "Advanced"]);
      expect(within(nav).getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
      await waitFor(() => expect(mockListAgentSnapshots).toHaveBeenCalled());
    });

    it("lists an Ubuntu computer's sections, with Private network and no Model & tools", () => {
      render(<HivraManage
        agent={{ ...agent, type: "linux-desktop", computer_profile: "ubuntu-desktop", computer_substrate: "proxmox-kvm" }}
        def={getAgent("linux-desktop")} plan={plan} browserOn={false} onChanged={jest.fn()} onDestroyed={jest.fn()} />);
      const nav = screen.getByRole("tablist", { name: "Computer settings" });
      expect(within(nav).getAllByRole("tab").map((tab) => tab.textContent))
        .toEqual(["Overview", "Agents", "Resources", "Recovery", "Private network", "Updates", "Advanced"]);
    });

    it("keeps every section's targets at least 40px", () => {
      render(<HivraManage agent={{ ...chatAgent, computer_substrate: "proxmox-kvm" }} def={getAgent("codex")} plan={plan} browserOn={false} onChanged={jest.fn()} onDestroyed={jest.fn()} />);
      for (const name of ["Resources", "Recovery", "Updates", "Advanced"]) {
        openSection(name);
        for (const button of within(screen.getByRole("tabpanel", { name })).getAllByRole("button")) {
          expect(Number.parseInt(button.style.minHeight || "0", 10)).toBeGreaterThanOrEqual(40);
        }
      }
    });

    it("moves from the MCP name to the command on Enter instead of doing nothing", async () => {
      render(<HivraManage agent={chatAgent} def={getAgent("codex")} plan={plan} browserOn={false} onChanged={jest.fn()} onDestroyed={jest.fn()} />);
      openSection("Model & tools");
      const name = await screen.findByRole("textbox", { name: "MCP server name" });
      expect(name).toHaveAttribute("enterkeyhint", "next");
      name.focus();
      fireEvent.change(name, { target: { value: "github" } });
      fireEvent.keyDown(name, { key: "Enter" });
      expect(screen.getByRole("textbox", { name: "MCP server command" })).toHaveFocus();
      expect(mockAddBoxMcp).not.toHaveBeenCalled();
    });
  });
});
