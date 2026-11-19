/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { HivraManage as RealHivraManage } from "../HivraManage";
import type { HivraAgent } from "@/lib/hivra/agent-api";
import { manageCapabilitiesFor, type ManageCapabilitiesContext } from "@/lib/hivra/manage-capabilities";

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

describe("HivraManage sleep", () => {
  const previous = process.env.NEXT_PUBLIC_HIVRA_AGENT_SLEEP;
  beforeEach(() => {
    jest.clearAllMocks();
    window.history.replaceState(null, "", "/dashboard/agent/test-agent?tab=manage");
    mockListAgentSnapshots.mockResolvedValue({ snapshots: [], supported: true, maximum: 5 });
    mockGetProviderResizeState.mockImplementation(() => new Promise(() => undefined));
    mockListBoxMcp.mockResolvedValue({ servers: [] });
    mockFetchComputerContract.mockResolvedValue({ kind: "not_started", channel: "proxmox-seed" });
    mockListBoxChatRuns.mockResolvedValue(null);
    mockGetAgentEvents.mockResolvedValue([]);
    process.env.NEXT_PUBLIC_HIVRA_AGENT_SLEEP = "1";
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_HIVRA_AGENT_SLEEP;
    else process.env.NEXT_PUBLIC_HIVRA_AGENT_SLEEP = previous;
  });
  const agent: HivraAgent = {
    id: "test-agent", name: "TEST", type: "codex", status: "running", cpu: 2, ram: 4,
    deployment_mode: "hivra-managed", computer_substrate: "proxmox-kvm", sleep_state: "awake",
  };
  const renderManage = (row: HivraAgent) =>
    render(<HivraManage agent={row} plan={null} onChanged={jest.fn()} onDestroyed={jest.fn()} browserOn={false} />);

  it("offers the sleep settings and the test buttons on a running Hivra agent", () => {
    renderManage(agent);
    expect(screen.getByTestId("manage-sleep")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Sleep when idle" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Keep awake" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Nap now" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hibernate now" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Wake" })).toBeInTheDocument();
  });

  it("is dark with the switch off", () => {
    delete process.env.NEXT_PUBLIC_HIVRA_AGENT_SLEEP;
    renderManage(agent);
    expect(screen.queryByTestId("manage-sleep")).not.toBeInTheDocument();
  });

  it("offers nothing for an agent that is stopped or runs on its owner's own server", () => {
    const stopped = renderManage({ ...agent, status: "stopped" });
    expect(screen.queryByTestId("manage-sleep")).not.toBeInTheDocument();
    stopped.unmount();
    renderManage({ ...agent, deployment_mode: "self-managed" });
    expect(screen.queryByTestId("manage-sleep")).not.toBeInTheDocument();
  });

  it("says Asleep, or Waking up, in the header instead of running", () => {
    const napping = renderManage({ ...agent, sleep_state: "napping" });
    expect(screen.getByRole("heading", { name: "TEST" }).parentElement?.parentElement).toHaveTextContent("Asleep");
    napping.unmount();
    renderManage({ ...agent, sleep_state: "waking" });
    expect(screen.getByRole("heading", { name: "TEST" }).parentElement?.parentElement).toHaveTextContent("Waking up");
  });

  it("keeps saying running for an awake agent", () => {
    renderManage(agent);
    expect(screen.getByRole("heading", { name: "TEST" }).parentElement?.parentElement).toHaveTextContent("running");
  });
});
