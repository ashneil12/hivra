/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { HivraManage } from "../HivraManage";
import { resetAgentSoftwareForTests } from "../useAgentSoftware";
import { AgentActionError, type HivraAgent, type PlanInfo } from "@/lib/hivra/agent-api";
import { getAgent } from "@/lib/hivra/agent-catalog";
import { manageCapabilitiesFor } from "@/lib/hivra/manage-capabilities";
import type { AgentSoftwareView } from "@/lib/hivra/agent-cli-status";

// Manage › Updates for a Codex agent: what its computer reports about Codex
// next to Hivra's tested version, Update going through Manage's own in-place
// update, and the header's "Update available" that opens this section.

const mockUpdateAgentRuntime = jest.fn();
const mockGetSoftware = jest.fn();
jest.mock("@/lib/hivra/agent-api", () => ({
  ...jest.requireActual("@/lib/hivra/agent-api"),
  updateAgentRuntime: (...args: unknown[]) => mockUpdateAgentRuntime(...args),
  listAgentSnapshots: async () => ({ snapshots: [], supported: true, maximum: 5 }),
  getAgentEvents: async () => [],
  getProviderResizeState: () => new Promise(() => undefined),
  getBoxModel: async () => ({ model: null }),
  getBoxRestrict: async () => ({ restrict: "" }),
  listBoxMcp: async () => ({ servers: [] }),
  listBoxChatRuns: async () => null,
}));
jest.mock("@/lib/hivra/agent-software-api", () => ({
  getAgentSoftware: (...args: unknown[]) => mockGetSoftware(...args),
  setAgentSoftwareAutoUpdate: jest.fn(),
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

const TESTED = "0.149.1";
const plan: PlanInfo = { key: "command", name: "Command", subscribed: true, maxAgents: 8, maxCpuPerAgent: 8, maxRamPerAgent: 16, poolCpu: 24, poolRam: 128, usage: { agentCount: 1, usedCpu: 2, usedRam: 4 } };
const row = {
  id: "agent-a", name: "Builder", type: "codex", status: "running", cpu: 2, ram: 4, deployment_mode: "hivra-managed",
  computer_substrate: "proxmox-kvm", desired_state: "running", infrastructure_binding_token_enforced: true,
  chat_url: "https://box.example.test", api_token: "fixture-token", vmid: 1130,
};
const agent = { ...(row as unknown as HivraAgent), manage: manageCapabilitiesFor(row, { preparedMatch: true }) };
const software = (view: AgentSoftwareView) => ({
  supported: true, cli: "codex", view, tested: TESTED, observedAt: "2026-09-25T11:58:00.000Z", update: null, lastRequest: null,
  autoUpdate: { mode: "off", enabled: true, source: "default", pausedFor: null },
});

function renderManage(props: Partial<Parameters<typeof HivraManage>[0]> = {}) {
  const handlers = { onChanged: jest.fn(), onDestroyed: jest.fn(), onConnectionServiceRestarted: jest.fn() };
  const view = render(<HivraManage agent={agent} def={getAgent("codex")} plan={plan} browserOn={false} {...handlers} {...props} />);
  return { ...view, ...handlers };
}
const openSection = (name: string) => fireEvent.click(screen.getByRole("tab", { name }));

beforeEach(() => {
  jest.clearAllMocks();
  resetAgentSoftwareForTests();
  window.history.replaceState(null, "", "/dashboard/agent/agent-a?tab=manage");
  mockGetSoftware.mockResolvedValue(software({ kind: "behind", installed: "0.140.0" }));
});

it("shows Codex next to Hivra's tested version in Updates, above the connection service", async () => {
  renderManage();
  openSection("Updates");
  const panel = screen.getByRole("tabpanel", { name: "Updates" });
  expect(await within(panel).findByTestId("agent-software-state")).toHaveTextContent("Codex 0.140.0 is installed and Hivra has tested 0.149.1.");
  const codexCard = within(panel).getByRole("button", { name: "Update Codex" });
  const connection = within(panel).getByRole("button", { name: "Update connection service" });
  expect(codexCard.compareDocumentPosition(connection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(document.getElementById("agent-software")).toContainElement(codexCard);
});

it("updates Codex through Manage's in-place update: one action at a time, surfaces signed in again, then follows it", async () => {
  let finish!: (value: unknown) => void;
  mockUpdateAgentRuntime.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const { onChanged, onConnectionServiceRestarted } = renderManage();
  openSection("Updates");
  fireEvent.click(await screen.findByRole("button", { name: "Update Codex" }));

  expect(mockUpdateAgentRuntime).toHaveBeenCalledWith("agent-a");
  expect(screen.getByText("Updating the connection service…").closest("[role=\"status\"]")).toHaveTextContent(/moves the agent to its tested version once no reply is being written/);
  // Manage's busy lock covers the other update and every other action.
  expect(screen.getByRole("button", { name: "Update connection service" })).toBeDisabled();
  expect(onConnectionServiceRestarted).not.toHaveBeenCalled();

  mockGetSoftware.mockResolvedValue(software({ kind: "updating", phase: "downloading", target: TESTED, installed: "0.140.0" }));
  await act(async () => finish({ status: "running", agentCli: { name: "codex", version: "0.140.0", target: TESTED, state: "scheduled" } }));
  await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  expect(onConnectionServiceRestarted).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(mockGetSoftware).toHaveBeenLastCalledWith("agent-a", { live: true }));
  expect(await screen.findByText(/^Downloading Codex 0\.149\.1\./)).toBeInTheDocument();
});

it("explains a refusal by its code in the Codex card, not as a raw server message", async () => {
  mockUpdateAgentRuntime.mockRejectedValue(new AgentActionError("Managed Hivra host readiness failed: stale bundle", 503, "host_not_ready"));
  const { onConnectionServiceRestarted } = renderManage();
  openSection("Updates");
  fireEvent.click(await screen.findByRole("button", { name: "Update Codex" }));
  expect(await screen.findByText("Hivra hasn't finished preparing this update yet. Nothing was changed. Try again later.")).toBeInTheDocument();
  expect(screen.queryByText(/stale bundle/)).not.toBeInTheDocument();
  expect(onConnectionServiceRestarted).not.toHaveBeenCalled();
});

it("still says what the connection service update did when an older computer can't answer with a code", async () => {
  mockUpdateAgentRuntime.mockRejectedValue(new AgentActionError("Update outcome fixture.", 502));
  const { onConnectionServiceRestarted } = renderManage();
  openSection("Updates");
  fireEvent.click(screen.getByRole("button", { name: "Update connection service" }));
  expect(await screen.findByText("Update outcome fixture.")).toBeInTheDocument();
  expect(onConnectionServiceRestarted).toHaveBeenCalledTimes(1);
});

it.each([
  ["hivra-managed", "Hivra hasn't finished preparing this update yet. Nothing was changed. Try again later."],
  ["self-managed", "Prepare My server with Hivra's current setup, then try again. Nothing was changed."],
] as const)("explains Update connection service's refusal by its code too (%s)", async (deploymentMode, text) => {
  // The route's own words for this (managed-provisioner-readiness.ts) are for Hivra's operators.
  mockUpdateAgentRuntime.mockRejectedValue(new AgentActionError(
    "This computer cannot be updated until its infrastructure target has the current Hivra runtime bundle. Prepare the target, then try again.",
    503,
    "host_not_ready",
  ));
  mockGetSoftware.mockResolvedValue(software({ kind: "older_connection_service" }));
  renderManage({ agent: { ...agent, deployment_mode: deploymentMode } });
  openSection("Updates");
  await screen.findByTestId("agent-software-state");
  fireEvent.click(screen.getByRole("button", { name: "Update connection service" }));
  expect(await screen.findByText(text)).toBeInTheDocument();
  expect(screen.queryByText(/infrastructure target|runtime bundle/)).not.toBeInTheDocument();
});

it("says which is busy, the agent, when Update connection service is refused for another action", async () => {
  mockUpdateAgentRuntime.mockRejectedValue(new AgentActionError("Another lifecycle operation is already in progress.", 409, "busy"));
  renderManage();
  openSection("Updates");
  fireEvent.click(screen.getByRole("button", { name: "Update connection service" }));
  expect(await screen.findByText("Another action is running on this agent. Try again when it finishes.")).toBeInTheDocument();
  expect(screen.queryByText(/lifecycle operation/)).not.toBeInTheDocument();
});

it("follows the Codex update the connection service update starts", async () => {
  mockUpdateAgentRuntime.mockResolvedValue({ status: "running", agentCli: { name: "codex", version: "0.140.0", target: TESTED, state: "scheduled" } });
  renderManage();
  openSection("Updates");
  await screen.findByTestId("agent-software-state");
  mockGetSoftware.mockResolvedValue(software({ kind: "updating", phase: "starting", target: TESTED, installed: "0.140.0" }));
  fireEvent.click(screen.getByRole("button", { name: "Update connection service" }));
  await waitFor(() => expect(mockGetSoftware).toHaveBeenLastCalledWith("agent-a", { live: true }));
  expect(await screen.findByText("Starting the update…")).toBeInTheDocument();
});

it("puts Update available in Manage's header, which opens Updates", async () => {
  renderManage();
  const chip = await screen.findByTestId("agent-software-chip");
  expect(chip).toHaveTextContent("Update available");
  expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
  fireEvent.click(chip);
  expect(screen.getByRole("tab", { name: "Updates" })).toHaveAttribute("aria-selected", "true");
  expect(new URLSearchParams(window.location.search).get("section")).toBe("updates");
});

it("leaves the chip to the page where the page shows it beside the agent's name", async () => {
  renderManage({ softwareChipInHeader: false });
  openSection("Updates");
  await screen.findByTestId("agent-software-state");
  expect(screen.queryByTestId("agent-software-chip")).not.toBeInTheDocument();
});

it("opens Updates when the page asks an already open Manage to", async () => {
  const view = renderManage({ sectionRequest: null });
  expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
  view.rerender(<HivraManage agent={agent} def={getAgent("codex")} plan={plan} browserOn={false} onChanged={view.onChanged} onDestroyed={view.onDestroyed} sectionRequest={{ section: "updates", id: 1 }} />);
  expect(screen.getByRole("tab", { name: "Updates" })).toHaveAttribute("aria-selected", "true");
  // The same request isn't followed twice: the owner can move on.
  openSection("Overview");
  view.rerender(<HivraManage agent={{ ...agent }} def={getAgent("codex")} plan={plan} browserOn={false} onChanged={view.onChanged} onDestroyed={view.onDestroyed} sectionRequest={{ section: "updates", id: 1 }} />);
  expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
});

it("opens Updates from the #agent-software link", async () => {
  window.history.replaceState(null, "", "/dashboard/agent/agent-a?tab=manage#agent-software");
  renderManage();
  expect(screen.getByRole("tab", { name: "Updates" })).toHaveAttribute("aria-selected", "true");
  expect(await screen.findByTestId("agent-software-state")).toBeVisible();
});
