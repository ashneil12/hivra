/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { HivraManage } from "../HivraManage";
import { ComputerUsageError, type HivraAgent, type PlanInfo } from "@/lib/hivra/agent-api";
import { COMPUTER_MISSING_ON_HOST_ERROR, type ComputerUsageView } from "@/lib/hivra/computer-usage-contract";
import { getAgent } from "@/lib/hivra/agent-catalog";
import { manageCapabilitiesFor } from "@/lib/hivra/manage-capabilities";

// One banner at the top of Manage when the computer can't be reached (instead
// of every card saying so), and "Remove from Hivra" for a computer its host
// reports gone.

const mockGetComputerUsage = jest.fn();
const mockRestartAgent = jest.fn();
const mockDeleteAgent = jest.fn();
jest.mock("@/lib/hivra/agent-api", () => ({
  ...jest.requireActual("@/lib/hivra/agent-api"),
  getComputerUsage: (...args: unknown[]) => mockGetComputerUsage(...args),
  restartAgent: (...args: unknown[]) => mockRestartAgent(...args),
  deleteAgent: (...args: unknown[]) => mockDeleteAgent(...args),
  listAgentSnapshots: async () => ({ snapshots: [], supported: true, maximum: 5 }),
  getAgentEvents: async () => [],
  getProviderResizeState: () => new Promise(() => undefined),
  getBoxModel: async () => ({ model: null }),
  getBoxRestrict: async () => ({ restrict: "" }),
  listBoxMcp: async () => ({ servers: [] }),
  listBoxChatRuns: async () => null,
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
  created_at: "2026-09-01T10:00:00.000Z", provisioned_at: "2026-09-01T10:05:00.000Z",
};

function served(row: Record<string, unknown>): HivraAgent {
  const manage = manageCapabilitiesFor(row, { preparedMatch: true });
  const { infrastructure_binding_token_enforced: _binding, desired_state: _desired, ...visible } = row;
  void _binding; void _desired;
  return { ...(visible as unknown as HivraAgent), manage };
}

function renderManage(row: Record<string, unknown>) {
  const props = { plan, browserOn: false, onChanged: jest.fn(), onDestroyed: jest.fn() };
  render(<HivraManage agent={served(row)} def={getAgent(String(row.type))} {...props} />);
  return props;
}

function usage(overrides: Partial<ComputerUsageView> = {}): ComputerUsageView {
  return {
    supported: true, source: "proxmox", observedAt: "2026-09-25T12:00:00.000Z", ageSeconds: 2, stale: false, refreshing: false,
    power: { observed: "running", recorded: "running", matches: true },
    uptimeSeconds: 100, cpu: { percent: 1, vcpus: 4 },
    memory: { usedBytes: 1, maximumBytes: 2, includesCache: true },
    disk: { usedBytes: 1, sizeBytes: 2, allocatedBytes: 2, filesystem: "ext4", guestReported: true },
    notes: [],
    ...overrides,
  };
}

const BANNER = "Hivra can't reach this computer right now.";
const UNAVAILABLE = "Unavailable while the computer can't be reached";

beforeEach(() => {
  jest.clearAllMocks();
  window.history.replaceState(null, "", "/dashboard/agent/computer-a?tab=manage");
  mockGetComputerUsage.mockImplementation(async () => usage());
  mockRestartAgent.mockResolvedValue({ switchedOff: false, waitedSeconds: null });
  mockDeleteAgent.mockResolvedValue(undefined);
});

describe("when the computer can't be reached", () => {
  it("says nothing while everything answers", async () => {
    renderManage(desk);
    expect(await screen.findByText("Running for 1 minute")).toBeVisible();
    expect(screen.queryByTestId("manage-reachability-banner")).not.toBeInTheDocument();
  });

  it("shows one banner with Restart, and the usage card says only that it is unavailable", async () => {
    mockGetComputerUsage.mockImplementation(async (_id: string, options?: { cached?: boolean }) => {
      if (options?.cached) throw new ComputerUsageError("Hivra couldn't reach this computer's host just now.", 503, null, "host_unreachable");
      throw new ComputerUsageError("Hivra couldn't reach this computer's host just now.", 503, null, "host_unreachable");
    });
    const props = renderManage(desk);
    const banner = await screen.findByTestId("manage-reachability-banner");
    expect(screen.getAllByTestId("manage-reachability-banner")).toHaveLength(1);
    expect(banner).toHaveTextContent(BANNER);
    expect(banner).toHaveTextContent("Restarting usually brings it back.");
    // The card no longer repeats the error in its own words.
    const card = screen.getByTestId("manage-usage");
    expect(within(card).getByText(UNAVAILABLE)).toBeVisible();
    expect(card).not.toHaveTextContent("couldn't reach this computer's host");
    expect(within(banner).queryByRole("button", { name: "Remove from Hivra" })).not.toBeInTheDocument();

    fireEvent.click(within(banner).getByRole("button", { name: "Restart" }));
    await waitFor(() => expect(mockRestartAgent).toHaveBeenCalledWith("computer-a"));
    await waitFor(() => expect(props.onChanged).toHaveBeenCalled());
  });

  it("goes away once the computer answers again", async () => {
    let failing = true;
    mockGetComputerUsage.mockImplementation(async () => {
      if (failing) throw new ComputerUsageError("Hivra couldn't reach this computer's host just now.", 503, null, "host_unreachable");
      return usage();
    });
    renderManage(desk);
    await screen.findByTestId("manage-reachability-banner");
    failing = false;
    fireEvent.click(within(screen.getByTestId("manage-usage")).getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.queryByTestId("manage-reachability-banner")).not.toBeInTheDocument());
  });
});

describe("a computer its host no longer has", () => {
  const gone = { ...desk, status: "error", error: COMPUTER_MISSING_ON_HOST_ERROR };

  it("offers Remove from Hivra instead of the power controls, and removes only the record", async () => {
    mockGetComputerUsage.mockImplementation(async () => usage({
      power: { observed: "missing", recorded: "error", matches: null }, notes: ["vm_missing"],
      cpu: null, memory: null, disk: null, uptimeSeconds: null,
    }));
    const props = renderManage(gone);
    const banner = await screen.findByTestId("manage-reachability-banner");
    expect(banner).toHaveAttribute("data-mode", "missing");
    expect(banner).toHaveTextContent("This computer no longer exists.");
    // No power controls and no repeated error card.
    for (const name of ["Start", "Stop", "Restart"]) expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    expect(screen.queryByText("This computer isn’t ready")).not.toBeInTheDocument();

    fireEvent.click(within(banner).getByRole("button", { name: "Remove from Hivra" }));
    expect(mockDeleteAgent).not.toHaveBeenCalled();
    fireEvent.click(within(banner).getByRole("button", { name: "Remove from Hivra" }));
    await waitFor(() => expect(mockDeleteAgent).toHaveBeenCalledWith("computer-a", { recordOnly: true }));
    await waitFor(() => expect(props.onDestroyed).toHaveBeenCalled());
  });

  it("blocks every power control on the server's map", () => {
    const { power } = manageCapabilitiesFor(gone, { preparedMatch: true });
    for (const cap of [power.start, power.stop, power.restart, power.forceStop, power.forceRestart]) {
      expect(cap).toMatchObject({ state: "blocked", code: "missing_on_host" });
    }
  });
});
