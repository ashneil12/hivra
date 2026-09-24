/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import type {
  DeploymentTargetDto,
  InfrastructureConnectionDto,
  ProxmoxPreflightResult,
} from "@/lib/infrastructure/contracts";
import type { HostDiscoveryResult } from "@/lib/infrastructure/host-discovery-contracts";
import { getHivraCloudCapacity } from "@/lib/infrastructure/hivra-cloud-client";
import { InfrastructureConnectionsPage } from "@/components/infrastructure/InfrastructureConnectionsPage";
import {
  deleteInfrastructureConnection,
  discoverInfrastructureHost,
  listInfrastructureConnections,
  listInfrastructureTargets,
  prepareInfrastructureConnection,
  preflightInfrastructureConnection,
} from "@/lib/infrastructure/client";

jest.mock("next/navigation", () => ({
  ...jest.requireActual("next/navigation"),
  useRouter: () => ({ push: jest.fn() }),
}));
jest.mock("@/lib/infrastructure/client", () => ({
  InfrastructureApiError: jest.requireActual("@/lib/infrastructure/client").InfrastructureApiError,
  createInfrastructureConnection: jest.fn(),
  updateInfrastructureConnection: jest.fn(),
  deleteInfrastructureConnection: jest.fn(),
  discoverInfrastructureHost: jest.fn(),
  listInfrastructureConnections: jest.fn(),
  listInfrastructureTargets: jest.fn(),
  prepareInfrastructureConnection: jest.fn(),
  preflightInfrastructureConnection: jest.fn(),
}));

jest.mock("@/lib/infrastructure/hivra-cloud-client", () => ({
  getHivraCloudCapacity: jest.fn(),
}));
// My server is command first (slice 13); the SSH details wizard is its
// advanced path.
jest.mock("@/lib/infrastructure/server-enrollment-client", () => ({
  listServerEnrollments: jest.fn(async () => ({ enrollments: [], uninstallCommand: null })),
  issueServerEnrollment: jest.fn(async () => { throw new Error("Setup commands aren't available on this deployment."); }),
  getServerEnrollment: jest.fn(),
  cancelServerEnrollment: jest.fn(async () => undefined),
}));

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const CHECKED_AT = "2026-08-25T17:00:00.000Z";

const connection: InfrastructureConnectionDto = {
  id: CONNECTION_ID,
  name: "Home Proxmox",
  provider: "proxmox",
  operatingMode: "self-managed",
  setupMode: "simple",
  status: "ready",
  endpoint: {
    sshHost: "pve.example.com",
    sshPort: 22,
    sshUser: "root",
    sshHostFingerprintSha256: "a".repeat(64),
  },
  configuration: null,
  credentialsConfigured: true,
  lastCheckedAt: CHECKED_AT,
  lastErrorCode: null,
  createdAt: CHECKED_AT,
  updatedAt: CHECKED_AT,
};

const unavailableTarget: DeploymentTargetDto = {
  id: "22222222-2222-4222-8222-222222222222",
  connectionId: CONNECTION_ID,
  evidenceConnectionRevision: 3,
  externalId: "pve-01",
  displayName: "Home Proxmox / pve-01",
  status: "unavailable",
  capacity: {
    cpu: { totalCores: 8, utilizationRatio: 0.25 },
    memoryBytes: { total: 32 * 1024 ** 3, available: 24 * 1024 ** 3 },
    storageBytes: { total: 1_000 * 1024 ** 3, available: 750 * 1024 ** 3 },
  },
  capabilities: {
    proxmoxVersion: "pve-manager/8.4.1",
    launchReady: false,
    directRootAccess: true,
    kvmAvailable: true,
    bridges: ["vmbr0"],
    selectedBridge: "vmbr0",
    storages: ["local-lvm"],
    selectedStorage: "local-lvm",
    template: null,
    provisioner: null,
    runtimeCompatibility: null,
    vmidRange: { start: 200, end: 399, freeCount: 180, firstAvailable: 200 },
    issues: [{
      code: "PROVISIONER_UNAVAILABLE",
      message: "Prepared assets are not configured.",
    }],
  },
  supportedIsolationDrivers: ["proxmox-kvm"],
  isolationClass: "hardware-vm",
  lastPreflightAt: CHECKED_AT,
  lastErrorCode: "PROVISIONER_UNAVAILABLE",
  createdAt: CHECKED_AT,
  updatedAt: CHECKED_AT,
};

const incompletePreflight: ProxmoxPreflightResult = {
  ok: true,
  connectionId: CONNECTION_ID,
  checkedAt: CHECKED_AT,
  target: {
    externalId: "pve-01",
    displayName: "Home Proxmox / pve-01",
    proxmoxVersion: "8.4.1",
    launchReady: false,
    capacity: {
      cpu: { totalCores: 8, utilizationRatio: 0.25 },
      memoryBytes: { total: 32 * 1024 ** 3, available: 24 * 1024 ** 3 },
      storageBytes: { total: 1_000 * 1024 ** 3, available: 750 * 1024 ** 3 },
    },
    capabilities: {
      isolationDrivers: ["proxmox-kvm"],
      isolationClass: "hardware-vm",
      kvmAvailable: true,
      bridges: ["vmbr0"],
      storages: ["local-lvm"],
      template: null,
      provisioner: null,
      runtimeCompatibility: null,
      vmidRange: { start: 200, end: 399, freeCount: 180 },
    },
  },
  warnings: ["Prepared assets are not configured."],
  unmetRequirements: [{ code: "PROVISIONER_UNAVAILABLE", message: "Prepared assets are not configured." }],
};

const supportedDiscovery: HostDiscoveryResult = {
  ok: true,
  snapshot: {
    discoveryId: "33333333-3333-4333-8333-333333333333",
    connectionId: CONNECTION_ID,
    connectionRevision: 3,
    connectionProvider: "proxmox",
    contractVersion: 1,
    observedAt: "2026-08-26T12:00:00.000Z",
    expiresAt: "2026-08-26T12:15:00.000Z",
    hostIdentityDigest: "b".repeat(64),
    host: {
      os: { family: "linux", id: "debian", versionId: "12" },
      kernel: { release: "6.8.12", architecture: "amd64" },
      environment: {
        effectivePrivilege: "root",
        virtualization: "bare-metal",
        cgroupVersion: 2,
        packageManagers: ["apt"],
      },
      capacity: {
        cpu: { logicalCores: 8 },
        memoryBytes: { total: 32 * 1024 ** 3, available: 24 * 1024 ** 3 },
        rootStorageBytes: { total: 500 * 1024 ** 3, available: 400 * 1024 ** 3 },
      },
      kvm: { devicePresent: true, cpuVirtualization: true },
    },
    engines: [
      { id: "proxmox-kvm", availability: "installed", supported: true, detectedVersion: "pve-manager/8.4.1", unmetRequirements: [] },
      { id: "qemu-kvm", availability: "installed", supported: false, detectedVersion: "9.0", unmetRequirements: ["RUNTIME_ADAPTER_UNAVAILABLE"] },
      { id: "gvisor", availability: "unavailable", supported: false, detectedVersion: null, unmetRequirements: ["RUNTIME_ADAPTER_UNAVAILABLE"] },
      { id: "docker", availability: "unavailable", supported: false, detectedVersion: null, unmetRequirements: ["RUNTIME_ADAPTER_UNAVAILABLE"] },
      { id: "containerd", availability: "unavailable", supported: false, detectedVersion: null, unmetRequirements: ["RUNTIME_ADAPTER_UNAVAILABLE"] },
      { id: "podman", availability: "unavailable", supported: false, detectedVersion: null, unmetRequirements: ["RUNTIME_ADAPTER_UNAVAILABLE"] },
      { id: "oci-runc", availability: "unavailable", supported: false, detectedVersion: null, unmetRequirements: ["RUNTIME_ADAPTER_UNAVAILABLE"] },
      { id: "oci-crun", availability: "unavailable", supported: false, detectedVersion: null, unmetRequirements: ["RUNTIME_ADAPTER_UNAVAILABLE"] },
      { id: "lxc", availability: "unavailable", supported: false, detectedVersion: null, unmetRequirements: ["RUNTIME_ADAPTER_UNAVAILABLE"] },
    ],
  },
};

describe("InfrastructureConnectionsPage", () => {
  beforeEach(() => {
    (getHivraCloudCapacity as jest.Mock).mockResolvedValue({
      subscribed: false,
      paid: false,
      plan: null,
      usage: null,
    });
    (listInfrastructureConnections as jest.Mock).mockResolvedValue([connection]);
    (listInfrastructureTargets as jest.Mock).mockResolvedValue([unavailableTarget]);
    (deleteInfrastructureConnection as jest.Mock).mockResolvedValue(undefined);
    (prepareInfrastructureConnection as jest.Mock).mockResolvedValue({
      ok: true,
      connectionId: CONNECTION_ID,
      provisionerVersion: "2026.08.26.3",
      preflight: incompletePreflight,
    });
    (discoverInfrastructureHost as jest.Mock).mockResolvedValue(supportedDiscovery);
    (preflightInfrastructureConnection as jest.Mock).mockResolvedValue(incompletePreflight);
  });

  it("rehydrates target evidence and never promotes connection status alone to launch-ready", async () => {
    render(<InfrastructureConnectionsPage />);

    const heading = await screen.findByRole("heading", { name: "Home Proxmox" });
    const card = heading.closest("article");
    expect(card).not.toBeNull();
    expect(within(card as HTMLElement).getByText("Setup incomplete")).toBeInTheDocument();
    expect(within(card as HTMLElement).getByText("Latest readiness")).toBeInTheDocument();
    expect(within(card as HTMLElement).getByText("Prepared assets are not configured.")).toBeInTheDocument();
    expect(within(card as HTMLElement).queryByText("Ready to launch")).not.toBeInTheDocument();
    expect(listInfrastructureTargets).toHaveBeenCalledWith(undefined, expect.any(AbortSignal));
  });

  it("reinspects through discovery before the explicit strict readiness check", async () => {
    render(<InfrastructureConnectionsPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Inspect again" }));

    const discoveryHeading = await screen.findByRole("heading", {
      name: "Home Proxmox runs Proxmox VE 8.4.1.",
    });
    expect(discoveryHeading).toHaveFocus();
    expect(discoverInfrastructureHost).toHaveBeenCalledWith(CONNECTION_ID);
    expect(preflightInfrastructureConnection).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Check Proxmox readiness" }));
    const readinessHeading = await screen.findByRole("heading", { name: "Host inspected - setup needed" });
    expect(readinessHeading).toHaveFocus();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(preflightInfrastructureConnection).toHaveBeenCalledWith(CONNECTION_ID);
  });

  it("deletes only after explicit confirmation", async () => {
    render(<InfrastructureConnectionsPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Delete Home Proxmox" }));
    expect(screen.getByRole("alertdialog", { name: "Disconnect Home Proxmox?" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove connection" }));
    await waitFor(() => expect(deleteInfrastructureConnection).toHaveBeenCalledWith(CONNECTION_ID));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Home Proxmox" })).not.toBeInTheDocument());
  });

  it("prepares a Simple host only after confirmation and refreshes saved evidence", async () => {
    let finishPreparation!: (value: {
      ok: true;
      connectionId: string;
      provisionerVersion: string;
      preflight: ProxmoxPreflightResult;
    }) => void;
    (prepareInfrastructureConnection as jest.Mock).mockImplementation(() => new Promise((resolve) => {
      finishPreparation = resolve;
    }));
    render(<InfrastructureConnectionsPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Review setup" }));
    const dialog = screen.getByRole("dialog", { name: "Set up Home Proxmox for agents?" });
    expect(within(dialog).getByText(/doesn't create an agent or buy anything/i)).toBeInTheDocument();
    expect(prepareInfrastructureConnection).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Set up Home Proxmox" }));
    expect(screen.getByRole("status")).toHaveTextContent(/Running for/i);
    expect(screen.queryByRole("button", { name: "Close host setup" })).not.toBeInTheDocument();
    finishPreparation({
      ok: true,
      connectionId: CONNECTION_ID,
      provisionerVersion: "2026.08.26.3",
      preflight: incompletePreflight,
    });

    expect(await screen.findByRole("heading", {
      name: "Home Proxmox was set up, but still needs attention.",
    })).toBeInTheDocument();
    expect(screen.getByText("Hivra 2026.08.26.3")).toBeInTheDocument();
    expect(prepareInfrastructureConnection).toHaveBeenCalledWith(CONNECTION_ID);
    await waitFor(() => expect(listInfrastructureTargets).toHaveBeenCalledTimes(2));
  });

  it("does not offer automatic host preparation for Advanced connections", async () => {
    (listInfrastructureConnections as jest.Mock).mockResolvedValue([{
      ...connection,
      setupMode: "advanced",
    }]);
    render(<InfrastructureConnectionsPage />);

    await screen.findByRole("heading", { name: "Home Proxmox" });
    expect(screen.queryByRole("button", { name: "Review setup" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Inspect again" }));
    await screen.findByRole("heading", { name: "Home Proxmox runs Proxmox VE 8.4.1." });
    fireEvent.click(screen.getByRole("button", { name: "Check Proxmox readiness" }));
    const readinessDialog = await screen.findByRole("dialog", { name: "Check Home Proxmox" });
    expect(within(readinessDialog).queryByRole("button", { name: "Review setup" })).not.toBeInTheDocument();
  });

  it("does not offer preparation for a capacity-only failure", async () => {
    (listInfrastructureTargets as jest.Mock).mockResolvedValue([{
      ...unavailableTarget,
      capabilities: {
        ...unavailableTarget.capabilities,
        issues: [{ code: "CAPACITY_UNAVAILABLE", message: "No free memory remains." }],
      },
      lastErrorCode: "CAPACITY_UNAVAILABLE",
    }]);
    (preflightInfrastructureConnection as jest.Mock).mockResolvedValue({
      ...incompletePreflight,
      warnings: ["No free memory remains."],
      unmetRequirements: [{ code: "CAPACITY_UNAVAILABLE", message: "No free memory remains." }],
    });
    render(<InfrastructureConnectionsPage />);

    expect(await screen.findByRole("heading", { name: "Home Proxmox" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Review setup" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Inspect again" }));
    await screen.findByRole("heading", { name: "Home Proxmox runs Proxmox VE 8.4.1." });
    fireEvent.click(screen.getByRole("button", { name: "Check Proxmox readiness" }));
    const readinessDialog = await screen.findByRole("dialog", { name: "Check Home Proxmox" });
    expect(within(readinessDialog).queryByRole("button", { name: "Review setup" })).not.toBeInTheDocument();
  });

  it("shows preparation failure as a distinct recoverable state", async () => {
    (prepareInfrastructureConnection as jest.Mock).mockRejectedValue(
      new Error("The server identity did not match the pinned SSH fingerprint."),
    );
    render(<InfrastructureConnectionsPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Review setup" }));
    const confirmation = screen.getByRole("dialog", { name: "Set up Home Proxmox for agents?" });
    fireEvent.click(within(confirmation).getByRole("button", { name: "Set up Home Proxmox" }));

    const failure = await screen.findByRole("alertdialog", { name: "Home Proxmox was not set up." });
    expect(failure).toHaveTextContent(/pinned SSH fingerprint/i);
    expect(within(failure).getByRole("button", { name: "Review and try again" })).toBeEnabled();
  });

  it("keeps secure host-first setup available beside the beginner provider path", async () => {
    (listInfrastructureConnections as jest.Mock).mockResolvedValue([]);
    (listInfrastructureTargets as jest.Mock).mockResolvedValue([]);
    render(<InfrastructureConnectionsPage />);

    fireEvent.click(await screen.findByRole("button", { name: /Choose cloud provider/i }));
    expect(screen.getByRole("button", { name: /Start with Hetzner/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Use an existing server/i }));
    fireEvent.click(screen.getByRole("button", { name: /Connect existing host/i }));

    // The one-line command comes first; SSH details stay one click away.
    const commandFirst = await screen.findByRole("dialog", { name: "Connect a server you already have" });
    fireEvent.click(within(commandFirst).getByRole("button", { name: /Connect with SSH details instead \(advanced\)/ }));
    expect(screen.getByRole("dialog", { name: "Connect a host" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Setup mode" })).not.toBeInTheDocument();
    expect(screen.getByText("Read-only inspection first")).toBeInTheDocument();
  });

  it("does not offer preparation without saved Proxmox isolation evidence", async () => {
    (listInfrastructureTargets as jest.Mock).mockResolvedValue([]);
    render(<InfrastructureConnectionsPage />);

    await screen.findByRole("heading", { name: "Home Proxmox" });
    expect(screen.queryByRole("button", { name: "Review setup" })).not.toBeInTheDocument();
  });

  it("does not reuse stale preparation evidence after the connection changes", async () => {
    (listInfrastructureConnections as jest.Mock).mockResolvedValue([{
      ...connection,
      status: "pending",
    }]);
    render(<InfrastructureConnectionsPage />);

    await screen.findByRole("heading", { name: "Home Proxmox" });
    expect(screen.getByText("Needs inspection")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Review setup" })).not.toBeInTheDocument();
  });
});
