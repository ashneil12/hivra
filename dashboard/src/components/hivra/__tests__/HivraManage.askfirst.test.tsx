/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HivraManage } from "../HivraManage";
import type { HivraAgent, PlanInfo } from "@/lib/hivra/agent-api";
import { getAgent } from "@/lib/hivra/agent-catalog";
import { manageCapabilitiesFor } from "@/lib/hivra/manage-capabilities";

// "Ask me first" in Manage › Model › Permissions: Claude Code only, shown when
// the server says it is available, and a tap changes it through the route.

jest.mock("@/lib/hivra/agent-api", () => ({
  ...jest.requireActual("@/lib/hivra/agent-api"),
  listAgentSnapshots: async () => ({ snapshots: [], supported: true, maximum: 5 }),
  getAgentEvents: async () => [],
  getProviderResizeState: () => new Promise(() => undefined),
  getComputerUsage: () => new Promise(() => undefined),
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
jest.mock("../ToolInstallPicker", () => ({ ToolInstallPicker: () => <div>Tool picker</div> }));
jest.mock("../HivraPrivateAccessPanel", () => ({ HivraPrivateAccessPanel: () => null }));
jest.mock("@/components/billing/UpgradePaywallModal", () => ({ UpgradePaywallModal: () => null }));

const plan: PlanInfo = { key: "command", name: "Command", subscribed: true, maxAgents: 8, maxCpuPerAgent: 8, maxRamPerAgent: 16, poolCpu: 24, poolRam: 128, usage: { agentCount: 1, usedCpu: 2, usedRam: 4 } };
const claudeRow = {
  id: "agent-a", name: "Coder", type: "claude-code", status: "running", cpu: 2, ram: 4,
  deployment_mode: "hivra-managed", computer_substrate: "proxmox-kvm", desired_state: "running",
  infrastructure_binding_token_enforced: true, chat_url: "https://box.example.test", api_token: "fixture-token",
  vmid: 1130, ip: "10.250.20.31", proxmox_host: "fixturenode11", created_at: "2026-09-01T10:00:00.000Z",
};

function renderManage(row: Record<string, unknown>) {
  const manage = manageCapabilitiesFor(row, { preparedMatch: true });
  const agent = { ...(row as unknown as HivraAgent), manage };
  return render(<HivraManage agent={agent} def={getAgent(String(row.type))} plan={plan} browserOn={false} onChanged={jest.fn()} onDestroyed={jest.fn()} />);
}

const fetchMock = jest.fn();
beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
  window.history.replaceState(null, "", "/dashboard/agent/agent-a?tab=manage&section=model");
});

const ok = (data: unknown) => ({ ok: true, json: async () => ({ success: true, data }) });

it("turns Ask me first on for a Claude Code agent", async () => {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/ask-first")) {
      return init?.method === "PUT" ? ok({ available: true, enabled: true }) : ok({ available: true, enabled: false });
    }
    return { ok: false, json: async () => ({}) };
  });
  renderManage(claudeRow);
  const toggle = await screen.findByRole("switch", { name: "Ask me first" });
  expect(toggle).toHaveAttribute("aria-checked", "false");
  await act(async () => { fireEvent.click(toggle); });
  await waitFor(() => expect(screen.getByRole("switch", { name: "Ask me first" })).toHaveAttribute("aria-checked", "true"));
  const put = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
  expect(put?.[0]).toBe("/api/hivra/agents/agent-a/ask-first");
  expect(JSON.parse(String(put?.[1]?.body))).toEqual({ enabled: true });
});

it("hides Ask me first when the server says it is not available", async () => {
  fetchMock.mockImplementation(async (url: string) => (String(url).endsWith("/ask-first") ? ok({ available: false, enabled: false }) : { ok: false, json: async () => ({}) }));
  renderManage(claudeRow);
  await act(async () => undefined);
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  expect(screen.queryByRole("switch", { name: "Ask me first" })).not.toBeInTheDocument();
});

it("never asks for a Codex agent", async () => {
  fetchMock.mockResolvedValue({ ok: false, json: async () => ({}) });
  renderManage({ ...claudeRow, type: "codex" });
  await act(async () => undefined);
  expect(fetchMock.mock.calls.some(([url]) => String(url).includes("ask-first"))).toBe(false);
});
