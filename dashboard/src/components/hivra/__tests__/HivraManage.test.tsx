/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { HivraManage } from "../HivraManage";
import { ProviderResizeApiError, type HivraAgent, type PlanInfo } from "@/lib/hivra/agent-api";
import { getAgent } from "@/lib/hivra/agent-catalog";

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
  listBoxMcp: async () => ({ servers: [] }),
}));
jest.mock("@/lib/hivra/agent-model-settings-api", () => ({
  ...jest.requireActual("@/lib/hivra/agent-model-settings-api"),
  getAgentModelSettings: async () => ({ llm: null, pending: null }),
}));

jest.mock("@/components/instances/CookieImportModal", () => ({ CookieImportModal: () => null }));
jest.mock("../ToolInstallPicker", () => ({ ToolInstallPicker: () => null }));
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
  });
  const agent: HivraAgent = { id: "test-agent", name: "TEST", type: "codex", status: "running", cpu: 2, ram: 4, deployment_mode: "hivra-managed" };
  const plan: PlanInfo = { key: "command", name: "Command", subscribed: true, maxAgents: 8, maxCpuPerAgent: 8, maxRamPerAgent: 16, poolCpu: 24, poolRam: 128, usage: { agentCount: 3, usedCpu: 22, usedRam: 124 } };

  function confirmDeletion() {
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
    await waitFor(() => expect(screen.getByRole("button", { name: "Default" })).toBeInTheDocument());
  });

  it.each([
    { deployment_mode: "self-managed", browserOn: false, next: true, name: "Enable browser automation" },
    { deployment_mode: "hivra-managed", browserOn: true, next: false, name: "Disable browser automation" },
  ] as const)("allows $name for $deployment_mode without managed plan evidence", async ({ deployment_mode, browserOn, next, name }) => {
    render(<HivraManage agent={{ ...agent, deployment_mode, chat_url: "https://box.example.com", api_token: "test-token" }} def={getAgent("codex")} plan={null} browserOn={browserOn} onChanged={jest.fn()} onDestroyed={jest.fn()} />);
    fireEvent.click(screen.getByRole("switch", { name }));
    await waitFor(() => expect(mockBrowserToggle).toHaveBeenCalledWith("https://box.example.com", next, "test-token"));
  });

  it("limits resize using account-wide usage", () => {
    render(<HivraManage agent={agent} plan={plan} onChanged={jest.fn()} onDestroyed={jest.fn()} browserOn={false} />);
    expect(within(screen.getByLabelText("Reserved CPU")).getByRole("button", { name: "4 CPU" })).toBeEnabled();
    expect(within(screen.getByLabelText("Reserved CPU")).getByRole("button", { name: "8 CPU" })).toBeDisabled();
    expect(within(screen.getByLabelText("Reserved memory")).getByRole("button", { name: "16 GB" })).toBeDisabled();
    expect(within(screen.getByLabelText("Maximum CPU")).getByRole("button", { name: "8 CPU" })).toBeEnabled();
  });

  it("loads saved maxima and sends a maxima-only resize", async () => {
    const onChanged = jest.fn();
    render(<HivraManage agent={{ ...agent, cpu_max: 4, ram_max: 8 }} plan={plan} onChanged={onChanged} onDestroyed={jest.fn()} browserOn={false} />);
    expect(within(screen.getByLabelText("Maximum CPU")).getByRole("button", { name: "4 CPU" })).toHaveAttribute("aria-pressed", "true");
    expect(within(screen.getByLabelText("Maximum memory")).getByRole("button", { name: "8 GB" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(screen.getByLabelText("Maximum CPU")).getByRole("button", { name: "6 CPU" }));
    fireEvent.click(screen.getByRole("button", { name: /Apply · 2 CPU \/ 4 GB reserved · 6 CPU \/ 8 GB max/ }));
    await waitFor(() => expect(mockResizeAgent).toHaveBeenCalledWith("test-agent", 2, 4, 6, 8));
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("keeps saved fractional CPU and 3 GB memory visible as selected resource choices", () => {
    render(<HivraManage agent={{ ...agent, cpu: 1.5, ram: 3, cpu_max: 2, ram_max: 4 }} plan={plan} onChanged={jest.fn()} onDestroyed={jest.fn()} browserOn={false} />);
    expect(within(screen.getByLabelText("Reserved CPU")).getByRole("button", { name: "1.5 CPU" })).toHaveAttribute("aria-pressed", "true");
    expect(within(screen.getByLabelText("Reserved memory")).getByRole("button", { name: "3 GB" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("link", { name: "Resources" })).toHaveAttribute("href", "#resources");
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

  it("allows removal but not conflicting power or resize actions during provisioning", () => {
    render(<HivraManage agent={{ ...agent, status: "provisioning", deployment_mode: "self-managed", computer_substrate: "provider-vm" }} plan={null} onChanged={jest.fn()} onDestroyed={jest.fn()} browserOn={false} />);
    expect(screen.getByRole("button", { name: "Stop" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Restart" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "4" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Apply" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Destroy" })).toBeEnabled();
  });
  it("shows the saved resource envelope but prevents edits during a pending Proxmox lifecycle", () => {
    render(<HivraManage agent={{ ...agent, status: "provisioning", computer_substrate: "proxmox-kvm", cpu_max: 4, ram_max: 8 }} plan={plan} onChanged={jest.fn()} onDestroyed={jest.fn()} browserOn={false} />);
    expect(screen.getByLabelText("Reserved CPU")).toBeVisible();
    expect(within(screen.getByLabelText("Maximum CPU")).getByRole("button", { name: "4 CPU" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
  });
  it("hides an unsupported provider resize while provider power controls remain available", async () => {
    mockGetProviderResizeState.mockRejectedValue(new ProviderResizeApiError("Not supported", 409, "not_supported"));
    render(<HivraManage agent={{ ...agent, computer_substrate: "provider-vm", deployment_mode: "self-managed" }} plan={null} onChanged={jest.fn()} onDestroyed={jest.fn()} browserOn={false} />);
    await waitFor(() => expect(mockGetProviderResizeState).toHaveBeenCalledWith("test-agent"));
    expect(screen.queryByTestId("provider-resize-panel")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Apply" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Restart" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Update & restart" })).not.toBeInTheDocument();
  });
  it("lets a running Proxmox computer refresh its Hivra runtime through the durable restart path", async () => {
    const onChanged = jest.fn();
    render(<HivraManage agent={{ ...agent, computer_substrate: "proxmox-kvm" }} plan={plan} onChanged={onChanged} onDestroyed={jest.fn()} browserOn={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Update & restart" }));
    await waitFor(() => expect(mockUpdateAgentRuntime).toHaveBeenCalledWith("test-agent"));
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/refreshes Hivra’s connection service/)).toHaveTextContent("model credentials");
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
    expect(screen.getByText(/your files and local logins remain on the computer/)).toBeInTheDocument();
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

    expect(screen.getByText(`${name} · Operating system`)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`prepared ${name} computer`, "i"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Restart" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Update & restart" })).not.toBeInTheDocument();
    expect(screen.queryByText("Restore points")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Apply/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/isolated Linux VM/i)).not.toBeInTheDocument();
  });
  it("creates and refreshes an honestly labelled same-host restore point", async () => {
    const onChanged = jest.fn();
    render(<HivraManage agent={{ ...agent, computer_substrate: "proxmox-kvm" }} plan={plan} onChanged={onChanged} onDestroyed={jest.fn()} browserOn={false} />);
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
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
    expect(screen.getByText(/permanently removes changes made afterward/i)).toHaveTextContent("left stopped");
    expect(mockRestoreAgentSnapshot).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm restore" }));
    await waitFor(() => expect(mockRestoreAgentSnapshot).toHaveBeenCalledWith("test-agent", "snapshot-1"));
    expect(onChanged).toHaveBeenCalledTimes(1);
  });
  it("does not advertise Proxmox restore points for provider computers", async () => {
    render(<HivraManage agent={{ ...agent, computer_substrate: "provider-vm", deployment_mode: "self-managed" }} plan={null} onChanged={jest.fn()} onDestroyed={jest.fn()} browserOn={false} />);
    expect(screen.queryByText("Restore points")).not.toBeInTheDocument();
    expect(mockListAgentSnapshots).not.toHaveBeenCalled();
  });
  it("keeps the exact pending power activity and uncertainty visible in Manage", () => {
    render(<HivraManage agent={{ ...agent, status: "provisioning", activity: "restart", power_stage: "request_uncertain", computer_substrate: "provider-vm", deployment_mode: "self-managed" }} plan={null} onChanged={jest.fn()} onDestroyed={jest.fn()} browserOn={false} />);
    expect(screen.getByText("restarting")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("No retry or forced power-off");
    expect(screen.getByText("See your provider project")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restart" })).toBeDisabled();
  });

  it("does not infer a live browser from catalog support before the computer reports its state", () => {
    const props = { agent: { ...agent, status: "provisioning" as const, deployment_mode: "self-managed" as const, computer_substrate: "provider-vm" as const }, def: getAgent("codex"), plan: null, onChanged: jest.fn(), onDestroyed: jest.fn() };
    const view = render(<HivraManage {...props} browserOn={null} />);
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
    expect(within(screen.getByLabelText("Reserved CPU")).getByRole("button", { name: "0.5 CPU" })).toBeEnabled();
    expect(within(screen.getByLabelText("Reserved CPU")).getByRole("button", { name: "4 CPU" })).toBeDisabled();
    expect(screen.getByText(/fixed 0.5 CPU \/ 1 GB allocation/)).toBeInTheDocument();
  });

  it("invalidates a selected size when the usage snapshot disappears and offers a refresh", () => {
    const onChanged = jest.fn();
    const props = { agent, onChanged, onDestroyed: jest.fn(), browserOn: false };
    const view = render(<HivraManage {...props} plan={plan} />);
    fireEvent.click(within(screen.getByLabelText("Reserved CPU")).getByRole("button", { name: "4 CPU" }));
    expect(screen.getByRole("button", { name: /Apply · 4 CPU \/ 4 GB reserved/ })).toBeEnabled();
    view.rerender(<HivraManage {...props} plan={null} />);
    expect(screen.getByRole("button", { name: /Apply · 4 CPU \/ 4 GB reserved/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Refresh capacity" }));
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("keeps self-managed resizing available without managed billing data", () => {
    render(<HivraManage agent={{ ...agent, deployment_mode: "self-managed" }} plan={null} onChanged={jest.fn()} onDestroyed={jest.fn()} browserOn={false} />);
    expect(within(screen.getByLabelText("Maximum CPU")).getByRole("button", { name: "8 CPU" })).toBeEnabled();
    expect(screen.getByText(/Host capacity is checked before applying/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refresh capacity" })).not.toBeInTheDocument();
  });

  it("keeps private-access support discoverable on unsupported computers", () => {
    const props = { plan, onChanged: jest.fn(), onDestroyed: jest.fn(), browserOn: false };
    const view = render(<HivraManage {...props} agent={{ ...agent, type: "linux-desktop", computer_profile: "ubuntu-desktop", computer_substrate: "proxmox-kvm" }} />);
    expect(screen.getByText("Private access panel")).toBeInTheDocument();
    view.rerender(<HivraManage {...props} agent={{ ...agent, type: "linux-desktop", computer_profile: "ubuntu-desktop", computer_substrate: "provider-vm" }} />);
    expect(screen.getByText("Private access panel")).toBeInTheDocument();
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
});
