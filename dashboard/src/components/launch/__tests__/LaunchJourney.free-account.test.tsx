/** @jest-environment jsdom */
// A free account on Launch: Hermes (Hivra Cloud only) never points at a
// computer, and a ready connected server is the default over a paid-plan wall.

import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { DeploymentTargetDto } from "@/lib/infrastructure/contracts";
import { PORTABLE_HIVRA_PROVISIONER_VERSION, PORTABLE_HIVRA_RUNTIME_COMPATIBILITY } from "@/lib/infrastructure/portable-provisioner-contract";
import { LaunchJourney } from "../LaunchJourney";

const fetchPlanStrictMock = jest.fn();
const summaryMock = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn() }),
  useSearchParams: () => ({ get: () => null, getAll: () => [] }),
}));
jest.mock("@/lib/hivra/agent-api", () => ({
  ...jest.requireActual("@/lib/hivra/agent-api"),
  fetchPlanStrict: () => fetchPlanStrictMock(),
}));
jest.mock("@/lib/billing/managed-venice-client", () => ({
  ...jest.requireActual("@/lib/billing/managed-venice-client"),
  requestManagedVeniceSummary: () => summaryMock(),
}));
jest.mock("@/lib/abuse/client-fingerprint", () => ({ getFingerprintRequestId: async () => null }));
jest.mock("@/hooks/useTokenGeoAccess", () => ({ useTokenGeoAccess: () => ({ status: "allowed", notice: null }) }));
jest.mock("@/components/billing/ManagedVeniceDepositModal", () => ({ ManagedVeniceDepositModal: () => null }));

const SERVER: DeploymentTargetDto = {
  id: "22222222-2222-4222-8222-222222222222",
  connectionId: "11111111-1111-4111-8111-111111111111",
  evidenceConnectionRevision: 7,
  externalId: "pve-01",
  displayName: "New Proxmox / pve-01",
  status: "ready",
  capacity: {
    cpu: { totalCores: 6, utilizationRatio: 0.2 },
    memoryBytes: { total: 16 * 1024 ** 3, available: 8 * 1024 ** 3 },
    storageBytes: { total: 500 * 1024 ** 3, available: 350 * 1024 ** 3 },
  },
  capabilities: {
    proxmoxVersion: "pve-manager/8.4.1", launchReady: true, directRootAccess: true, kvmAvailable: true,
    bridges: ["vmbr1"], selectedBridge: "vmbr1", storages: ["local-lvm"], selectedStorage: "local-lvm",
    template: { vmid: 9000, exists: true, isTemplate: true, nameMatches: true, ready: true },
    provisioner: { configured: true, ready: true, version: PORTABLE_HIVRA_PROVISIONER_VERSION },
    runtimeCompatibility: { ...PORTABLE_HIVRA_RUNTIME_COMPATIBILITY, supportedCatalogRuntimeIds: ["codex", "linux-desktop"] },
    vmidRange: { start: 200, end: 399, freeCount: 180, firstAvailable: 200 },
    issues: [],
  },
  supportedIsolationDrivers: ["proxmox-kvm"],
  isolationClass: "hardware-vm",
  lastPreflightAt: "2026-09-24T12:00:00.000Z",
  lastErrorCode: null,
  createdAt: "2026-09-24T12:00:00.000Z",
  updatedAt: "2026-09-24T12:00:00.000Z",
};

const FREE_PLAN = {
  subscribed: false, name: "Free", key: "free", maxAgents: 1, maxCpuPerAgent: 0.5, maxRamPerAgent: 1,
  poolCpu: 0.5, poolRam: 1, usage: { agentCount: 0, usedCpu: 0, usedRam: 0 },
};

let targets: DeploymentTargetDto[];

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/dashboard/launch");
  targets = [];
  fetchPlanStrictMock.mockResolvedValue(FREE_PLAN);
  summaryMock.mockResolvedValue({ ok: true, summary: { wallets: {
    card: { balanceMicroUsd: 0, availableMicroUsd: 0, reservedMicroUsd: 0 },
    hermesos: { tokenDisplay: "0", lockedValueMicroUsd: 0, availableMicroUsd: 0, reservedMicroUsd: 0 },
  } } });
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/infrastructure/targets")) return json({ success: true, data: { targets } });
    if (url === "/api/vault") return json({ success: true, data: [] });
    if (url === "/api/hivra/agents") return json({ success: true, data: { agents: [] } });
    if (url === "/api/instances?summary=true") return json({ success: true, data: [] });
    if (url === "/api/hivra/managed-sessions") return json({ success: true, data: { sessions: [], targets: [] } });
    throw new Error(`Unexpected request: ${url}`);
  }) as unknown as typeof fetch;
});

it("tells a free account Hermes runs on Hivra Cloud only, without offering a computer", async () => {
  render(<LaunchJourney />);
  await screen.findByRole("heading", { name: "What do you want to launch?" });
  fireEvent.click(screen.getByRole("button", { name: /^Hermes/ }));

  expect(await screen.findByText("Hermes runs on Hivra Cloud only, and that needs a paid plan. Choose a plan to launch it.")).toBeInTheDocument();
  expect(screen.queryByText(/works with your own computer|connect one/i)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Set up your own capacity" })).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: /Upgrade to|Review plans/ })).toBeInTheDocument();
});

it("opens a free account on its ready connected server instead of the paid-plan blocker", async () => {
  targets = [SERVER];
  render(<LaunchJourney />);
  await screen.findByRole("heading", { name: "What do you want to launch?" });
  fireEvent.click(screen.getByRole("button", { name: /^Codex/ }));

  expect(await screen.findAllByText("New Proxmox / pve-01")).not.toHaveLength(0);
  await waitFor(() => expect(screen.getByTestId("launch-primary-action")).toBeEnabled());
  expect(screen.queryByText(/on Hivra Cloud needs a paid plan/)).not.toBeInTheDocument();
});
