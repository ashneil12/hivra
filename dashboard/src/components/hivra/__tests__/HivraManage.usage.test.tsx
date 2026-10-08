/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { HivraManage } from "../HivraManage";
import { ComputerUsageError, type HivraAgent, type PlanInfo } from "@/lib/hivra/agent-api";
import type { ComputerUsageView } from "@/lib/hivra/computer-usage-contract";
import { getAgent } from "@/lib/hivra/agent-catalog";
import { manageCapabilitiesFor, type ManageCapabilitiesContext } from "@/lib/hivra/manage-capabilities";

// Manage for a computer's live usage and power: the Usage card in Overview
// (first look, refresh, a state change, and every honest "not available"),
// Force off and Force restart in Advanced behind a confirmation that says
// unsaved work is lost, and a Stop that says when it had to switch the
// computer off.

const mockGetComputerUsage = jest.fn();
const mockStopAgent = jest.fn();
const mockRestartAgent = jest.fn();
const mockForceStopAgent = jest.fn();
const mockForceRestartAgent = jest.fn();
const mockListBoxChatRuns = jest.fn();
jest.mock("@/lib/hivra/agent-api", () => ({
  ...jest.requireActual("@/lib/hivra/agent-api"),
  getComputerUsage: (...args: unknown[]) => mockGetComputerUsage(...args),
  stopAgent: (...args: unknown[]) => mockStopAgent(...args),
  restartAgent: (...args: unknown[]) => mockRestartAgent(...args),
  forceStopAgent: (...args: unknown[]) => mockForceStopAgent(...args),
  forceRestartAgent: (...args: unknown[]) => mockForceRestartAgent(...args),
  listAgentSnapshots: async () => ({ snapshots: [], supported: true, maximum: 5 }),
  getAgentEvents: async () => [],
  getProviderResizeState: () => new Promise(() => undefined),
  getBoxModel: async () => ({ model: null }),
  getBoxRestrict: async () => ({ restrict: "" }),
  listBoxMcp: async () => ({ servers: [] }),
  listBoxChatRuns: (...args: unknown[]) => mockListBoxChatRuns(...args),
}));
jest.mock("@/lib/hivra/agent-model-settings-api", () => ({
  ...jest.requireActual("@/lib/hivra/agent-model-settings-api"),
  getAgentModelSettings: async () => ({ llm: null, pending: null }),
}));
jest.mock("@/lib/hivra/computer-contract-client", () => ({
  fetchComputerContract: async () => ({ kind: "not_started", channel: "proxmox-seed" }),
  runComputerContractAction: jest.fn(),
}));
jest.mock("@/components/instances/CookieImportModal", () => ({ CookieImportModal: () => null }));
jest.mock("../ToolInstallPicker", () => ({ ToolInstallPicker: () => null }));
jest.mock("../HivraPrivateAccessPanel", () => ({ HivraPrivateAccessPanel: () => null }));
jest.mock("@/components/billing/UpgradePaywallModal", () => ({ UpgradePaywallModal: () => null }));

const plan: PlanInfo = { key: "command", name: "Command", subscribed: true, maxAgents: 8, maxCpuPerAgent: 8, maxRamPerAgent: 16, poolCpu: 24, poolRam: 128, usage: { agentCount: 1, usedCpu: 2, usedRam: 4 } };
const desk = {
  id: "computer-a", name: "Desk", type: "linux-desktop", computer_profile: "ubuntu-desktop", status: "running", desired_state: "running",
  cpu: 2, ram: 4, cpu_max: 4, ram_max: 8, deployment_mode: "hivra-managed", computer_substrate: "proxmox-kvm",
  infrastructure_binding_token_enforced: true, vmid: 1113, ip: "10.250.20.63", proxmox_host: "fixturenode11",
  created_at: "2026-09-01T10:00:00.000Z",
};
const codex = { ...desk, id: "agent-a", name: "Builder", type: "codex", computer_profile: null, chat_url: "https://box.example.test", api_token: "fixture-token" };

function served(row: Record<string, unknown>, ctx: Partial<ManageCapabilitiesContext> = {}): HivraAgent {
  const manage = manageCapabilitiesFor(row, { preparedMatch: true, ...ctx });
  const { infrastructure_binding_token_enforced: _binding, desired_state: _desired, ...visible } = row;
  void _binding; void _desired;
  return { ...(visible as unknown as HivraAgent), manage };
}

function renderManage(row: Record<string, unknown>) {
  const props = { plan, browserOn: false, onChanged: jest.fn(), onDestroyed: jest.fn() };
  const view = render(<HivraManage agent={served(row)} def={getAgent(String(row.type))} {...props} />);
  return { ...view, props, rerenderRow: (next: Record<string, unknown>) => view.rerender(<HivraManage agent={served(next)} def={getAgent(String(next.type))} {...props} />) };
}

/** What the usage route sends for the captured 1113 read. */
function usage(overrides: Partial<ComputerUsageView> = {}): ComputerUsageView {
  return {
    supported: true, source: "proxmox", observedAt: "2026-09-25T12:00:00.000Z", ageSeconds: 2, stale: false, refreshing: false,
    power: { observed: "running", recorded: "running", matches: true },
    uptimeSeconds: 688433,
    cpu: { percent: 1.1, vcpus: 4 },
    memory: { usedBytes: 4209631232, maximumBytes: 8589934592, includesCache: true },
    disk: { usedBytes: 21686575104, sizeBytes: 41412915200, allocatedBytes: 42949672960, filesystem: "ext4", guestReported: true },
    notes: [],
    ...overrides,
  };
}
const unread = usage({ observedAt: null, ageSeconds: null, stale: true, power: { observed: "unknown", recorded: "running", matches: null }, uptimeSeconds: null, cpu: null, memory: null, disk: null });

const openSection = (name: string) => fireEvent.click(screen.getByRole("tab", { name }));
const usageCard = () => screen.getByTestId("manage-usage");
const calls = () => mockGetComputerUsage.mock.calls.map(([id, options]) => ({ id, cached: Boolean(options?.cached) }));

beforeEach(() => {
  jest.clearAllMocks();
  window.history.replaceState(null, "", "/dashboard/agent/computer-a?tab=manage");
  mockGetComputerUsage.mockImplementation(async (_id: string, options?: { cached?: boolean }) => (options?.cached ? unread : usage()));
  mockStopAgent.mockResolvedValue({ switchedOff: false, waitedSeconds: null });
  mockRestartAgent.mockResolvedValue({ switchedOff: false, waitedSeconds: null });
  mockForceStopAgent.mockResolvedValue(undefined);
  mockForceRestartAgent.mockResolvedValue(undefined);
  mockListBoxChatRuns.mockResolvedValue(null);
});

describe("Usage in Overview", () => {
  it("shows what Hivra last read, then reads again because nothing was read yet", async () => {
    renderManage(desk);
    const card = usageCard();
    expect(await within(card).findByText("Running for 7 days 23 hours")).toBeVisible();
    expect(calls()).toEqual([{ id: "computer-a", cached: true }, { id: "computer-a", cached: false }]);
    expect(within(card).getByText("1.1% of 4 CPU")).toBeVisible();
    expect(within(card).getByText("3.9 GB in use of 8 GB")).toBeVisible();
    expect(within(card).getByText("Includes the computer's file cache, so it can read high.")).toBeVisible();
    expect(within(card).getByText("20.2 GB used of 38.6 GB")).toBeVisible();
    expect(within(card).getByText("Updated just now")).toBeVisible();
  });

  it("doesn't read the host again when the last read is recent", async () => {
    mockGetComputerUsage.mockResolvedValue(usage({ ageSeconds: 10 }));
    renderManage(desk);
    expect(await within(usageCard()).findByText("Updated 10 s ago")).toBeVisible();
    expect(calls()).toEqual([{ id: "computer-a", cached: true }]);
  });

  it("reads again on Refresh", async () => {
    mockGetComputerUsage.mockResolvedValue(usage({ ageSeconds: 10 }));
    renderManage(desk);
    await within(usageCard()).findByText("Updated 10 s ago");
    fireEvent.click(within(usageCard()).getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(calls()).toEqual([{ id: "computer-a", cached: true }, { id: "computer-a", cached: false }]));
  });

  it("reads again when the computer changes state, and shows it switched off", async () => {
    mockGetComputerUsage.mockResolvedValue(usage({ ageSeconds: 10 }));
    const view = renderManage(desk);
    await within(usageCard()).findByText("Running for 7 days 23 hours");
    mockGetComputerUsage.mockResolvedValue(usage({
      power: { observed: "stopped", recorded: "stopped", matches: true }, uptimeSeconds: null, cpu: null, memory: null,
      disk: { usedBytes: null, sizeBytes: null, allocatedBytes: 42949672960, filesystem: null, guestReported: false },
    }));
    view.rerenderRow({ ...desk, status: "stopped", desired_state: "stopped" });
    expect(await within(usageCard()).findByText("Switched off")).toBeVisible();
    expect(calls().at(-1)).toEqual({ id: "computer-a", cached: false });
    expect(within(usageCard()).queryByText("CPU")).not.toBeInTheDocument();
    expect(within(usageCard()).getByText("40 GB disk")).toBeVisible();
  });

  it("doesn't read anything while Overview is hidden", async () => {
    window.history.replaceState(null, "", "/dashboard/agent/computer-a?tab=manage&section=advanced");
    renderManage(desk);
    await act(async () => undefined);
    expect(mockGetComputerUsage).not.toHaveBeenCalled();
    openSection("Overview");
    await waitFor(() => expect(mockGetComputerUsage).toHaveBeenCalled());
  });

  it.each([
    ["the guest agent didn't answer", usage({ notes: ["guest_agent_unavailable"], disk: { usedBytes: null, sizeBytes: null, allocatedBytes: 42949672960, filesystem: null, guestReported: false } }),
      "Disk use isn't available: the computer's guest agent didn't answer."],
    ["the host couldn't be reached", usage({ ageSeconds: 300, stale: true, notes: ["host_unreachable"] }),
      "Last read 5 min ago. Hivra couldn't reach this computer's host just now."],
    ["the computer isn't on its host", usage({ power: { observed: "missing", recorded: "stopped", matches: true }, notes: ["vm_missing"], cpu: null, memory: null, disk: null, uptimeSeconds: null }),
      "Hivra couldn't find this computer on its host."],
  ])("says so when %s", async (_case, view, text) => {
    mockGetComputerUsage.mockResolvedValue(view);
    renderManage(desk);
    expect(await within(usageCard()).findByText(text)).toBeVisible();
  });

  // Regression: a computer its host couldn't find, recorded as on, was
  // reported as switched off with "Use Stop and then Start", and Stop fails on
  // a computer its host doesn't have (and then blocks every power control).
  it("doesn't call a computer its host can't find switched off, or send the owner to Stop and Start", async () => {
    mockGetComputerUsage.mockResolvedValue(usage({ power: { observed: "missing", recorded: "running", matches: false }, notes: ["vm_missing"], cpu: null, memory: null, disk: null, uptimeSeconds: null }));
    renderManage(desk);
    const card = usageCard();
    expect(await within(card).findByText("Not found on its host")).toBeVisible();
    const alerts = within(card).getAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toHaveTextContent("Hivra couldn't find this computer on its host. Contact support.");
    expect(card).not.toHaveTextContent(/switched off|Stop and then Start/);
  });

  // Regression: after a read failed with nothing read before, a Refresh within
  // the next 20 s was answered "refreshing", and the card showed "Reading…"
  // for a read that wasn't happening, with the failure hidden.
  it("says the host couldn't be reached when a read failed and nothing was read before", async () => {
    const failed = usage({ ...unread, refreshing: false, notes: ["host_unreachable"] });
    mockGetComputerUsage.mockImplementation(async (_id: string, options?: { cached?: boolean }) => {
      if (options?.cached) return unread;
      throw new ComputerUsageError("Hivra couldn't reach this computer's host just now.", 503, null);
    });
    renderManage(desk);
    const card = usageCard();
    expect(await within(card).findByRole("alert")).toHaveTextContent("Hivra couldn't reach this computer's host just now.");
    mockGetComputerUsage.mockResolvedValue(failed);
    fireEvent.click(within(card).getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(calls()).toHaveLength(3));
    expect(await within(card).findByRole("alert")).toHaveTextContent("Hivra couldn't reach this computer's host just now.");
    expect(card).not.toHaveTextContent(/Reading/);
  });

  it("stops saying it is reading once the read another request was making must be over", async () => {
    jest.useFakeTimers();
    try {
      mockGetComputerUsage.mockImplementation(async (_id: string, options?: { cached?: boolean }) => (options?.cached ? unread : { ...unread, refreshing: true }));
      renderManage(desk);
      await act(async () => { await jest.advanceTimersByTimeAsync(0); });
      expect(usageCard()).toHaveTextContent("Reading this computer's usage…");
      // A reader holds the refresh for at most 20 s.
      for (let tick = 0; tick < 10; tick += 1) {
        await act(async () => { await jest.advanceTimersByTimeAsync(3_000); });
      }
      const asked = calls().length;
      expect(asked).toBeGreaterThan(1 + 20 / 3);
      expect(usageCard()).not.toHaveTextContent(/Reading/);
      expect(usageCard()).toHaveTextContent("No usage read yet. Use Refresh to read it.");
      await act(async () => { await jest.advanceTimersByTimeAsync(30_000); });
      expect(calls()).toHaveLength(asked);
    } finally {
      jest.useRealTimers();
    }
  });

  // Regression: "Updated … ago" was a polite live region that the clock
  // rewrote every 15 s, so a screen reader announced it over and over.
  it("announces a finished read once, not every tick of the clock", async () => {
    jest.useFakeTimers();
    try {
      mockGetComputerUsage.mockResolvedValue(usage({ ageSeconds: 10 }));
      renderManage(desk);
      await act(async () => { await jest.advanceTimersByTimeAsync(0); });
      const label = within(usageCard()).getByText("Updated 10 s ago");
      expect(label.closest("[aria-live], [role=status]")).toBeNull();
      mockGetComputerUsage.mockResolvedValue(usage({ ageSeconds: 0 }));
      fireEvent.click(within(usageCard()).getByRole("button", { name: "Refresh" }));
      await act(async () => { await jest.advanceTimersByTimeAsync(0); });
      const announced = () => within(usageCard()).getAllByRole("status").map((node) => node.textContent);
      expect(announced()).toEqual(["Usage updated just now."]);
      await act(async () => { await jest.advanceTimersByTimeAsync(45_000); });
      expect(within(usageCard()).getByText("Updated 45 s ago")).toBeVisible();
      expect(announced()).toEqual(["Usage updated just now."]);

      // A read that failed says so, instead of "updated".
      mockGetComputerUsage.mockResolvedValue(usage({ ageSeconds: 300, stale: true, notes: ["host_unreachable"] }));
      fireEvent.click(within(usageCard()).getByRole("button", { name: "Refresh" }));
      await act(async () => { await jest.advanceTimersByTimeAsync(0); });
      expect(announced()).toEqual(["Hivra couldn't reach this computer's host just now."]);
    } finally {
      jest.useRealTimers();
    }
  });

  it("flags a computer Hivra records as on but its host has switched off, and says what to do", async () => {
    mockGetComputerUsage.mockResolvedValue(usage({ power: { observed: "stopped", recorded: "running", matches: false }, uptimeSeconds: null, cpu: null, memory: null }));
    renderManage(desk);
    expect(await within(usageCard()).findByRole("alert")).toHaveTextContent(
      "Hivra's record says this computer is on, but its host says it's switched off. Use Stop and then Start to bring them back in line.");
  });

  it.each([
    [new ComputerUsageError("Hivra couldn't confirm this computer belongs to you, so it didn't read it.", 409, null), "Hivra couldn't confirm this computer belongs to you, so it didn't read it."],
    [new ComputerUsageError("Usage was refreshed a lot just now.", 429, 42), "Usage was refreshed a lot just now. Try again in 42 seconds."],
  ])("explains a refused read (%s)", async (error, text) => {
    mockGetComputerUsage.mockRejectedValue(error);
    renderManage(desk);
    expect(await within(usageCard()).findByRole("alert")).toHaveTextContent(text);
  });

  it("says where to look for a My cloud computer, and reads nothing", async () => {
    renderManage({ ...desk, computer_substrate: "provider-vm", deployment_mode: "self-managed", vmid: null, ip: "192.0.2.80" });
    expect(within(usageCard()).getByText("Live usage isn't available for My cloud computers yet. Your provider's console shows it.")).toBeVisible();
    await act(async () => undefined);
    expect(mockGetComputerUsage).not.toHaveBeenCalled();
    expect(within(usageCard()).queryByRole("button", { name: "Refresh" })).not.toBeInTheDocument();
  });

  it("waits for a computer that is still being set up", async () => {
    renderManage({ ...desk, status: "provisioning", vmid: null });
    expect(within(usageCard()).getByText("Usage appears once this computer is set up.")).toBeVisible();
    await act(async () => undefined);
    expect(mockGetComputerUsage).not.toHaveBeenCalled();
  });
});

describe("Force off and Force restart in Advanced", () => {
  it("confirms first, saying unsaved work is lost, and only then forces the computer off", async () => {
    renderManage(desk);
    openSection("Advanced");
    const card = screen.getByTestId("manage-force-power");
    fireEvent.click(within(card).getByRole("button", { name: "Force off" }));
    const dialog = await within(card).findByRole("alertdialog", { name: "Force off Desk?" });
    expect(dialog).toHaveTextContent("This switches the computer off immediately, like pulling the plug. Anything not saved in open apps is lost.");
    expect(mockForceStopAgent).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(within(card).queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(mockForceStopAgent).not.toHaveBeenCalled();

    fireEvent.click(within(card).getByRole("button", { name: "Force off" }));
    fireEvent.click(within(await within(card).findByRole("alertdialog")).getByRole("button", { name: "Force off" }));
    await waitFor(() => expect(mockForceStopAgent).toHaveBeenCalledWith("computer-a"));
  });

  // Keyboard and screen-reader users are taken to the confirmation, with
  // Cancel first as in the danger zone, and back to the button on Cancel.
  it("moves focus to Cancel when the confirmation opens, and back to Force off when it is cancelled", async () => {
    renderManage(desk);
    openSection("Advanced");
    const card = screen.getByTestId("manage-force-power");
    const trigger = within(card).getByRole("button", { name: "Force off" });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = await within(card).findByRole("alertdialog", { name: "Force off Desk?" });
    const [first, second] = within(dialog).getAllByRole("button");
    expect(first).toHaveTextContent("Cancel");
    expect(second).toHaveTextContent("Force off");
    await waitFor(() => expect(first).toHaveFocus());
    fireEvent.click(first);
    expect(within(card).queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(mockForceStopAgent).not.toHaveBeenCalled();
  });

  // Regression: this said to use Force off when Stop doesn't work, but a
  // failed Stop keeps its operation, which turns Force off off; and Stop
  // already switches a computer off when it doesn't shut down in time.
  it("says what forcing does instead of sending owners here when Stop fails", () => {
    renderManage(desk);
    openSection("Advanced");
    const card = screen.getByTestId("manage-force-power");
    expect(card).toHaveTextContent("Force off and Force restart switch the computer off at once, like pulling the plug, instead of waiting for it to shut down. Use them when the computer is frozen. Anything not saved in open apps is lost.");
    expect(card).not.toHaveTextContent(/doesn't work/);
  });

  it("forces a restart after its own confirmation", async () => {
    renderManage(desk);
    openSection("Advanced");
    const card = screen.getByTestId("manage-force-power");
    fireEvent.click(within(card).getByRole("button", { name: "Force restart" }));
    const dialog = await within(card).findByRole("alertdialog", { name: "Force a restart of Desk?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Force restart" }));
    await waitFor(() => expect(mockForceRestartAgent).toHaveBeenCalledWith("computer-a"));
    expect(mockForceStopAgent).not.toHaveBeenCalled();
  });

  it("names the replies a forced switch-off would end", async () => {
    window.history.replaceState(null, "", "/dashboard/agent/agent-a?tab=manage");
    mockListBoxChatRuns.mockResolvedValue([{ id: "run-1", state: "running" }]);
    renderManage(codex);
    openSection("Advanced");
    fireEvent.click(within(screen.getByTestId("manage-force-power")).getByRole("button", { name: "Force off" }));
    expect(await screen.findByRole("alertdialog", { name: "Force off Builder?" })).toHaveTextContent("1 reply is still being written and will stop.");
  });

  it("can't force a stopped computer off", () => {
    renderManage({ ...desk, status: "stopped", desired_state: "stopped" });
    openSection("Advanced");
    const card = screen.getByTestId("manage-force-power");
    expect(within(card).getByRole("button", { name: "Force off" })).toBeDisabled();
    expect(within(card).getByRole("button", { name: "Force restart" })).toBeDisabled();
  });

  it("sends a My cloud computer to its provider's console instead", () => {
    renderManage({ ...desk, computer_substrate: "provider-vm", deployment_mode: "self-managed", vmid: null, ip: "192.0.2.80" });
    openSection("Advanced");
    const card = screen.getByTestId("manage-force-power");
    expect(within(card).getByText("Hivra can't force a My cloud computer off. Use your provider's console to force it off.")).toBeVisible();
    expect(within(card).queryByRole("button", { name: "Force off" })).not.toBeInTheDocument();
  });

  it("isn't shown where no power control works", () => {
    renderManage({ ...desk, computer_profile: "windows", deployment_mode: "self-managed" });
    openSection("Advanced");
    expect(screen.queryByTestId("manage-force-power")).not.toBeInTheDocument();
  });
});

// Regression: Stop switched a computer off after 50 seconds without saying so,
// while Manage said it was shutting it down cleanly.
describe("a truthful Stop", () => {
  it("says when the computer didn't shut down in time and Hivra switched it off", async () => {
    mockStopAgent.mockResolvedValue({ switchedOff: true, waitedSeconds: 50 });
    renderManage(desk);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(await screen.findByText("The computer didn't shut down within 50 seconds, so Hivra switched it off.")).toBeVisible();
  });

  it("says the same for a Restart that had to switch the computer off", async () => {
    mockRestartAgent.mockResolvedValue({ switchedOff: true, waitedSeconds: 40 });
    renderManage(desk);
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    expect(await screen.findByText("The computer didn't shut down within 40 seconds, so Hivra switched it off before starting it again.")).toBeVisible();
  });

  it("says the computer was switched off without a number when its shutdown failed sooner", async () => {
    mockStopAgent.mockResolvedValue({ switchedOff: true, waitedSeconds: null });
    renderManage(desk);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(await screen.findByText("The computer didn't shut down, so Hivra switched it off.")).toBeVisible();
  });

  // Regression: the notice stayed next to the Stop button of a computer that
  // had been started again.
  it("keeps the switch-off notice while the computer is off, and drops it once it is started again", async () => {
    mockStopAgent.mockResolvedValue({ switchedOff: true, waitedSeconds: 50 });
    const view = renderManage(desk);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    const notice = "The computer didn't shut down within 50 seconds, so Hivra switched it off.";
    expect(await screen.findByText(notice)).toBeVisible();
    view.rerenderRow({ ...desk, status: "stopped", desired_state: "stopped" });
    expect(screen.getByText(notice)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(screen.queryByText(notice)).not.toBeInTheDocument();
    view.rerenderRow({ ...desk, status: "running" });
    expect(screen.queryByText(notice)).not.toBeInTheDocument();
  });

  it("drops the switch-off notice when the computer is started from somewhere else", async () => {
    mockStopAgent.mockResolvedValue({ switchedOff: true, waitedSeconds: 50 });
    const view = renderManage(desk);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    const notice = "The computer didn't shut down within 50 seconds, so Hivra switched it off.";
    expect(await screen.findByText(notice)).toBeVisible();
    view.rerenderRow({ ...desk, status: "stopped", desired_state: "stopped" });
    view.rerenderRow({ ...desk, status: "running" });
    expect(screen.queryByText(notice)).not.toBeInTheDocument();
  });

  // Regression: Manage told a My cloud owner that Stop switches the computer
  // off if it doesn't shut down in time; Hivra only asks Hetzner to shut it
  // down, and the same card said no forced power-off was being started.
  it("doesn't promise a switch-off for a My cloud computer, whose Stop only asks it to shut down", async () => {
    let finish!: () => void;
    mockStopAgent.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const myCloud = { ...desk, computer_substrate: "provider-vm", deployment_mode: "self-managed", vmid: null, ip: "192.0.2.80", power_stage: "provider_pending" };
    renderManage(myCloud);
    expect(document.body).toHaveTextContent("Stop shuts down the computer; Start brings it back. Restart reboots in place.");
    expect(document.body).toHaveTextContent("No replacement or forced power-off is being started.");
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    const progress = await screen.findByText("Stopping the computer…");
    expect(progress.parentElement).toHaveTextContent("Hivra is asking it to shut down and confirming that it is off.");
    expect(document.body).not.toHaveTextContent(/switches it off|switched it off/);
    await act(async () => finish());
  });

  it("says nothing extra when it shut down by itself", async () => {
    renderManage(desk);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(mockStopAgent).toHaveBeenCalled());
    expect(screen.queryByText(/switched it off/)).not.toBeInTheDocument();
  });

  it("doesn't promise a clean shutdown while stopping", async () => {
    let finish!: () => void;
    mockStopAgent.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    renderManage(desk);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    const progress = await screen.findByText("Stopping the computer…");
    expect(progress.parentElement).toHaveTextContent("If it doesn't shut down in time, Hivra switches it off.");
    expect(document.body.textContent).not.toMatch(/shutting it down cleanly/);
    await act(async () => finish());
  });
});
