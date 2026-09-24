/** @jest-environment jsdom */
// Slice 10: capacity is added in a sheet over Launch, and what it makes ready
// comes back to the same launch.

import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import type { DeploymentTargetDto } from "@/lib/infrastructure/contracts";
import { PORTABLE_HIVRA_PROVISIONER_VERSION, PORTABLE_HIVRA_RUNTIME_COMPATIBILITY } from "@/lib/infrastructure/portable-provisioner-contract";
import { LaunchJourney } from "../LaunchJourney";

const routerPushMock = jest.fn();
const fetchPlanStrictMock = jest.fn();
const summaryMock = jest.fn();
const sheetPropsMock = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPushMock }),
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

// The Capacity page itself is covered by its own tests; here it stands in for
// "the owner made a server ready inside the sheet".
jest.mock("@/components/infrastructure/InfrastructureConnectionsPage", () => ({
  InfrastructureConnectionsPage: (props: { embedded: { launchResourceId: string | null; onLaunchTarget: (id: string) => void; onClose: () => void } }) => {
    sheetPropsMock(props);
    return (
      <div>
        <h1 id="launch-capacity-sheet-heading">Add capacity for your launch</h1>
        <button type="button" onClick={() => props.embedded.onLaunchTarget("22222222-2222-4222-8222-222222222222")}>Launch on the new server</button>
      </div>
    );
  },
}));

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

let serverReady: boolean;

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/dashboard/launch");
  serverReady = false;
  fetchPlanStrictMock.mockResolvedValue(FREE_PLAN);
  summaryMock.mockResolvedValue({ ok: true, summary: { wallets: {
    card: { balanceMicroUsd: 0, availableMicroUsd: 0, reservedMicroUsd: 0 },
    hermesos: { tokenDisplay: "0", lockedValueMicroUsd: 0, availableMicroUsd: 0, reservedMicroUsd: 0 },
  } } });
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    // The server exists only once the owner made it ready in the sheet.
    if (url.includes("/api/infrastructure/targets")) return json({ success: true, data: { targets: serverReady ? [SERVER] : [] } });
    if (url === "/api/vault") return json({ success: true, data: [] });
    if (url === "/api/hivra/agents") return json({ success: true, data: { agents: [] } });
    if (url === "/api/instances?summary=true") return json({ success: true, data: [] });
    if (url === "/api/hivra/managed-sessions") return json({ success: true, data: { sessions: [], targets: [] } });
    throw new Error(`Unexpected request: ${url}`);
  }) as unknown as typeof fetch;
});

it("adds capacity in a sheet over the launch and comes back to the same launch with the new server chosen", async () => {
  render(<LaunchJourney />);
  await screen.findByRole("heading", { name: "What do you want to launch?" });
  fireEvent.click(screen.getByRole("button", { name: /^Codex/ }));
  const name = screen.getByLabelText(/Agent name/i);
  fireEvent.change(name, { target: { value: "My Codex" } });

  // Codex with its browser is more than Free holds: the blocker offers own capacity.
  fireEvent.click(screen.getByRole("checkbox", { name: /Browser for Codex/ }));
  const blocker = await screen.findByRole("alert");
  fireEvent.click(within(blocker).getByRole("button", { name: "Set up your own capacity" }));

  const sheet = await screen.findByRole("dialog", { name: "Add capacity for your launch" });
  expect(sheetPropsMock).toHaveBeenLastCalledWith(expect.objectContaining({ embedded: expect.objectContaining({ launchResourceId: "codex" }) }));
  expect(routerPushMock).not.toHaveBeenCalled();
  expect(screen.getByRole("heading", { name: "Codex — here's the plan" })).toBeInTheDocument();

  serverReady = true;
  fireEvent.click(within(sheet).getByRole("button", { name: "Launch on the new server" }));

  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add capacity for your launch" })).not.toBeInTheDocument());
  // Same launch: its name kept, the new server chosen, no page change.
  expect(screen.getByLabelText(/Agent name/i)).toHaveValue("My Codex");
  expect(await screen.findAllByText("New Proxmox / pve-01")).not.toHaveLength(0);
  expect(routerPushMock).not.toHaveBeenCalled();
});

it("closes the sheet with Back to your launch and keeps the launch as it was", async () => {
  render(<LaunchJourney />);
  await screen.findByRole("heading", { name: "What do you want to launch?" });
  fireEvent.click(screen.getByRole("button", { name: /^Codex/ }));
  fireEvent.click(screen.getByRole("checkbox", { name: /Browser for Codex/ }));
  fireEvent.click(within(await screen.findByRole("alert")).getByRole("button", { name: "Set up your own capacity" }));
  await screen.findByRole("dialog", { name: "Add capacity for your launch" });

  fireEvent.click(screen.getByRole("button", { name: "Back to your launch" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(screen.getByRole("heading", { name: "Codex — here's the plan" })).toBeInTheDocument();
  expect(screen.getByRole("checkbox", { name: /Browser for Codex/ })).toBeChecked();
});
