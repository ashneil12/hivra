/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { HetznerCloudCapacityDialog } from "../HetznerCloudCapacityDialog";
import { HetznerCloudConnectionCard } from "../HetznerCloudConnectionCard";

import { InfrastructureConnectionsPage } from "../InfrastructureConnectionsPage";
import {
  connectHetznerCloudProject,
  createHetznerCloudCapacity,
  createInfrastructureConnection,
  deleteInfrastructureConnection,
  discoverInfrastructureHost,
  forceForgetHetznerCloudConnection,
  getHetznerCloudInventory,
  getHetznerCloudOfferCatalog,
  InfrastructureApiError,
  listInfrastructureConnections,
  listInfrastructureTargets,
  preflightInfrastructureConnection,
  prepareInfrastructureConnection,
  quoteHetznerCloudCapacity,
  refreshHetznerCloudInventory,
  updateInfrastructureConnection,
} from "@/lib/infrastructure/client";
import type { DeploymentTargetDto, InfrastructureConnectionDto } from "@/lib/infrastructure/contracts";
import type { HostDiscoveryResult } from "@/lib/infrastructure/host-discovery-contracts";
import { HETZNER_CLOUD_FORCE_FORGET_CONFIRMATION, HETZNER_CLOUD_SIMPLE_MODE_POLICY } from "@/lib/infrastructure/contracts";
import { getHivraCloudCapacity } from "@/lib/infrastructure/hivra-cloud-client";
import { providerVmTarget } from "@/lib/infrastructure/__tests__/provider-vm-target.fixtures";
import { verifyExternalCleanup } from "@/lib/infrastructure/hetzner-external-cleanup-client";
jest.mock("@/lib/infrastructure/hetzner-external-cleanup-client",()=>({verifyExternalCleanup:jest.fn()}));
import {
  redirectToCheckoutUrl,
  requestSubscriptionCheckout,
} from "@/lib/billing/client";

const mockSearchParamsGet = jest.fn();

jest.mock("next/navigation", () => ({
  useSearchParams: () => ({ get: mockSearchParamsGet }),
}));

jest.mock("@/lib/infrastructure/client", () => ({
  InfrastructureApiError: class InfrastructureApiError extends Error {
    constructor(
      message: string,
      public readonly status: number,
      public readonly code?: string,
    ) {
      super(message);
      this.name = "InfrastructureApiError";
    }
  },
  createInfrastructureConnection: jest.fn(),
  connectHetznerCloudProject: jest.fn(),
  createHetznerCloudCapacity: jest.fn(),
  deleteInfrastructureConnection: jest.fn(),
  discoverInfrastructureHost: jest.fn(),
  getHetznerCloudInventory: jest.fn(),
  getHetznerCloudOfferCatalog: jest.fn(),
  forceForgetHetznerCloudConnection: jest.fn(),
  listInfrastructureConnections: jest.fn(),
  listInfrastructureTargets: jest.fn(),
  preflightInfrastructureConnection: jest.fn(),
  prepareInfrastructureConnection: jest.fn(),
  quoteHetznerCloudCapacity: jest.fn(),
  refreshHetznerCloudInventory: jest.fn(),
  updateInfrastructureConnection: jest.fn(),
}));

jest.mock("@/lib/infrastructure/hivra-cloud-client", () => ({
  getHivraCloudCapacity: jest.fn(),
}));

jest.mock("@/lib/billing/client", () => ({
  requestSubscriptionCheckout: jest.fn(),
  redirectToCheckoutUrl: jest.fn(() => ({ ok: true })),
}));

const NO_HIVRA_CLOUD = {
  subscribed: false,
  paid: false,
  plan: null,
  usage: null,
};

const ACTIVE_HIVRA_CLOUD = {
  subscribed: true,
  paid: true,
  plan: {
    key: "operator",
    name: "Pro",
    price: 999,
    maxAgents: 3,
    maxCpuPerAgent: 2,
    maxRamPerAgent: 4096,
    totalCpu: 2,
    totalRam: 4096,
    status: "active",
    currentPeriodEnd: null,
    source: "stripe",
    canChangePlanInPlace: true,
  },
  usage: {
    agentCount: 2,
    maxAgents: 3,
    usedCpu: 1.5,
    totalCpu: 2,
    usedRam: 3072,
    totalRam: 4096,
    instances: [
      {
        source: "hermes" as const,
        id: "hermes-one",
        name: "Hermes One",
        status: "running",
        cpu: 1,
        ram: 2048,
        disk_size_gb: 40,
        disk_upgraded: false,
        backups_enabled: false,
      },
      {
        source: "hivra" as const,
        id: "codex-one",
        name: "Codex One",
        status: "running",
        cpu: 0.5,
        ram: 1024,
        disk_size_gb: 0,
        disk_upgraded: false,
        backups_enabled: false,
        type: "codex",
      },
    ],
  },
};

const HETZNER_CONNECTION = {
  id: "00000000-0000-4000-8000-000000001039",
  name: "Personal cloud",
  provider: "hetzner-cloud" as const,
  operatingMode: "self-managed" as const,
  setupMode: "simple" as const,
  status: "ready" as const,
  endpoint: null,
  configuration: null,
  credentialsConfigured: true,
  capabilities: {
    inventory: true as const,
    offerCatalog: true as const,
    createCapacity: true as const,
    agentLaunch: false as const,
    reason: "Hetzner Cloud servers can be created powered off, but they are not prepared or authorized for agent launch.",
  },
  lastErrorCode: null,
  lastCheckedAt: "2026-08-26T14:30:00.000Z",
  createdAt: "2026-08-26T14:30:00.000Z",
  updatedAt: "2026-08-26T14:30:00.000Z",
};

const PENDING_HOST_CONNECTION: InfrastructureConnectionDto = {
  id: "00000000-0000-4000-8000-000000001040",
  name: "Linux host",
  provider: "host",
  operatingMode: "self-managed",
  setupMode: "simple",
  status: "pending",
  endpoint: {
    sshHost: "host.example.test",
    sshPort: 22,
    sshUser: "root",
    sshHostFingerprintSha256: "a".repeat(64),
  },
  configuration: null,
  credentialsConfigured: true,
  lastErrorCode: null,
  lastCheckedAt: null,
  createdAt: "2026-09-15T12:00:00.000Z",
  updatedAt: "2026-09-15T12:00:00.000Z",
};

const READY_GVISOR_TARGET: DeploymentTargetDto = {
  id: "00000000-0000-4000-8000-000000001041",
  connectionId: PENDING_HOST_CONNECTION.id,
  evidenceConnectionRevision: 1,
  externalId: `gvisor-${"b".repeat(24)}`,
  displayName: "Linux host — gVisor",
  status: "ready",
  capacity: {
    cpu: { totalCores: 8, utilizationRatio: null },
    memoryBytes: { total: 32 * 1024 ** 3, available: 24 * 1024 ** 3 },
    storageBytes: { total: 500 * 1024 ** 3, available: 400 * 1024 ** 3 },
  },
  capabilities: {
    kind: "gvisor",
    launchReady: true,
    hostIdentityDigest: "c".repeat(64),
    adapter: { version: "2026.09.15.1", sha256: "d".repeat(64) },
    runtime: { path: "/usr/local/bin/runsc", sha256: "e".repeat(64) },
    runtimeCompatibility: { contractVersion: 1, supportedWorkloadKinds: ["linux-terminal"] },
    resourcePolicy: { reservationEqualsMaximum: true, aggregateAdmission: "serialized-host-headroom-v1" },
    access: { terminal: "owner-gated-command-v1", publicPorts: false },
    desktop: false,
    windows: false,
  },
  supportedIsolationDrivers: ["gvisor-runsc"],
  isolationClass: "application-kernel",
  lastPreflightAt: "2026-09-15T12:00:00.000Z",
  lastErrorCode: null,
  createdAt: "2026-09-15T12:00:00.000Z",
  updatedAt: "2026-09-15T12:00:00.000Z",
};

const DISCOVERED_INSTALLED_GVISOR: HostDiscoveryResult = {
  ok: true,
  snapshot: {
    discoveryId: "00000000-0000-4000-8000-000000001043",
    connectionId: PENDING_HOST_CONNECTION.id,
    connectionRevision: 1,
    connectionProvider: "host",
    contractVersion: 1,
    observedAt: "2026-09-15T12:00:00.000Z",
    expiresAt: "2026-09-15T12:15:00.000Z",
    hostIdentityDigest: "c".repeat(64),
    host: {
      os: { family: "linux", id: "ubuntu", versionId: "24.04" },
      kernel: { release: "6.8.0", architecture: "amd64" },
      environment: {
        effectivePrivilege: "root",
        virtualization: "virtual-machine",
        cgroupVersion: 2,
        packageManagers: ["apt"],
      },
      capacity: {
        cpu: { logicalCores: 8 },
        memoryBytes: { total: 32 * 1024 ** 3, available: 24 * 1024 ** 3 },
        rootStorageBytes: { total: 500 * 1024 ** 3, available: 400 * 1024 ** 3 },
      },
      kvm: { devicePresent: false, cpuVirtualization: true },
    },
    engines: [
      { id: "proxmox-kvm", availability: "unavailable", supported: false, detectedVersion: null, unmetRequirements: ["ENGINE_NOT_INSTALLED"] },
      { id: "qemu-kvm", availability: "unavailable", supported: false, detectedVersion: null, unmetRequirements: ["ENGINE_NOT_INSTALLED"] },
      { id: "gvisor", availability: "installed", supported: true, detectedVersion: "runsc version release-20260907.0", unmetRequirements: [] },
      { id: "docker", availability: "installed", supported: false, detectedVersion: "Docker version 29.1.3", unmetRequirements: ["RUNTIME_ADAPTER_UNAVAILABLE"] },
      { id: "containerd", availability: "unavailable", supported: false, detectedVersion: null, unmetRequirements: ["ENGINE_NOT_INSTALLED"] },
      { id: "podman", availability: "unavailable", supported: false, detectedVersion: null, unmetRequirements: ["ENGINE_NOT_INSTALLED"] },
      { id: "oci-runc", availability: "installed", supported: false, detectedVersion: "runc version 1.1.12", unmetRequirements: ["RUNTIME_ADAPTER_UNAVAILABLE"] },
      { id: "oci-crun", availability: "unavailable", supported: false, detectedVersion: null, unmetRequirements: ["ENGINE_NOT_INSTALLED"] },
      { id: "lxc", availability: "unavailable", supported: false, detectedVersion: null, unmetRequirements: ["ENGINE_NOT_INSTALLED"] },
    ],
  },
};

const DISCOVERED_PROXMOX: HostDiscoveryResult = {
  ...DISCOVERED_INSTALLED_GVISOR,
  snapshot: {
    ...DISCOVERED_INSTALLED_GVISOR.snapshot,
    engines: DISCOVERED_INSTALLED_GVISOR.snapshot.engines.map((engine) => {
      if (engine.id === "proxmox-kvm") {
        return {
          ...engine,
          availability: "installed" as const,
          supported: true,
          detectedVersion: "pve-manager/8.4.1",
          unmetRequirements: [],
        };
      }
      if (engine.id === "gvisor") {
        return {
          ...engine,
          availability: "unavailable" as const,
          supported: false,
          detectedVersion: null,
          unmetRequirements: ["ENGINE_NOT_INSTALLED" as const],
        };
      }
      return engine;
    }),
  },
};

const PREPARABLE_PROXMOX_TARGET: DeploymentTargetDto = {
  id: "00000000-0000-4000-8000-000000001042",
  connectionId: PENDING_HOST_CONNECTION.id,
  evidenceConnectionRevision: 1,
  externalId: "pve-01",
  displayName: "Linux host / pve-01",
  status: "unavailable",
  capacity: {
    cpu: { totalCores: 8, utilizationRatio: null },
    memoryBytes: { total: 32 * 1024 ** 3, available: 24 * 1024 ** 3 },
    storageBytes: { total: 500 * 1024 ** 3, available: 400 * 1024 ** 3 },
  },
  capabilities: {
    proxmoxVersion: "pve-manager/8.4.1",
    launchReady: false,
    directRootAccess: true,
    kvmAvailable: true,
    bridges: ["hivra0"],
    selectedBridge: "hivra0",
    storages: ["local-lvm"],
    selectedStorage: "local-lvm",
    template: null,
    provisioner: { configured: true, ready: false, version: "2026.09.15.2" },
    runtimeCompatibility: null,
    vmidRange: { start: 200, end: 399, freeCount: 200, firstAvailable: 200 },
    issues: [{ code: "PROVISIONER_UNAVAILABLE", message: "Install the host tools." }],
  },
  supportedIsolationDrivers: ["proxmox-kvm"],
  isolationClass: "hardware-vm",
  lastPreflightAt: "2026-09-15T12:00:00.000Z",
  lastErrorCode: "PROVISIONER_UNAVAILABLE",
  createdAt: "2026-09-15T12:00:00.000Z",
  updatedAt: "2026-09-15T12:00:00.000Z",
};

const READY_PROXMOX_TARGET: DeploymentTargetDto = {
  ...PREPARABLE_PROXMOX_TARGET,
  status: "ready",
  capabilities: {
    ...PREPARABLE_PROXMOX_TARGET.capabilities,
    launchReady: true,
    provisioner: { configured: true, ready: true, version: "2026.09.15.2" },
    issues: [],
  },
  lastErrorCode: null,
};

const HETZNER_SERVER = {
  id: "00000000-0000-4000-8000-000000001055",
  connectionId: HETZNER_CONNECTION.id,
  providerResourceId: "4815162342",
  name: "agent-box-1",
  status: "running" as const,
  serverType: {
    name: "cx23",
    description: "Shared vCPU",
    cores: 2,
    memoryGb: 4,
    diskGb: 40,
    cpuType: "shared" as const,
    architecture: "x86" as const,
  },
  location: { name: "nbg1", city: "Nuremberg", country: "DE" },
  publicNetwork: { ipv4: "203.0.113.42", ipv6: null },
  providerCreatedAt: "2026-08-26T14:00:00.000Z",
  discoveredAt: "2026-08-26T14:30:00.000Z",
  createdAt: "2026-08-26T14:30:00.000Z",
  updatedAt: "2026-08-26T14:30:00.000Z",
  launchReady: false as const,
  launchBlockedReason: "This provider node has not been prepared for agent launch.",
};

const HETZNER_OFF_SERVER = {
  ...HETZNER_SERVER,
  id: "00000000-0000-4000-8000-000000001006",
  providerResourceId: "4815162343",
  name: "hivra-a1b2c3d4",
  status: "off" as const,
  publicNetwork: { ipv4: "203.0.113.43", ipv6: "2001:db8::43" },
  discoveredAt: "2026-08-26T15:00:04.000Z",
  createdAt: "2026-08-26T15:00:04.000Z",
  updatedAt: "2026-08-26T15:00:04.000Z",
};

const HETZNER_CATALOG = {
  fetchedAt: "2026-08-26T15:00:00.000Z",
  currency: "EUR",
  vatRate: "19.0000",
  serverTypes: [
    {
      id: 22,
      name: "cx23",
      description: "Shared vCPU",
      cores: 2,
      memoryGb: 4,
      diskGb: 40,
      cpuType: "shared" as const,
      architecture: "x86" as const,
      deprecated: false,
      locations: [{ name: "nbg1", available: true, recommended: true, deprecated: false }],
      prices: [{
        location: "nbg1",
        monthly: { currency: "EUR", net: "3.2900", gross: "3.9151" },
        hourly: { currency: "EUR", net: "0.0050", gross: "0.0060" },
        includedTrafficBytes: 21990232555520,
        additionalTrafficPerTb: { currency: "EUR", net: "1.0000", gross: "1.1900" },
      }],
    },
  ],
  locations: [{
    id: 1,
    name: "nbg1",
    city: "Nuremberg",
    country: "DE",
    networkZone: "eu-central",
  }],
  primaryIpPrices: [{
    location: "nbg1",
    ipv4: {
      hourly: { net: "0.0006", gross: "0.0007" },
      monthly: { net: "0.5000", gross: "0.5950" },
    },
    ipv6: {
      hourly: { net: "0.0000", gross: "0.0000" },
      monthly: { net: "0.0000", gross: "0.0000" },
    },
  }],
  images: [{
    id: 100,
    name: "ubuntu-24.04",
    description: "Ubuntu 24.04",
    architecture: "x86" as const,
    osFlavor: "ubuntu",
    osVersion: "24.04",
    deprecated: false,
  }],
  simpleModePolicy: {
    cpuType: "shared" as const,
    minCores: 2 as const,
    minMemoryGb: 4 as const,
    maxCores: 8 as const,
    maxMemoryGb: 32 as const,
    maxDiskGb: 320 as const,
    maxMonthlyGrossByCurrency: [
      { currency: "EUR" as const, amount: "45.00" as const },
      { currency: "USD" as const, amount: "50.00" as const },
    ],
  },
  billing: {
    model: "hourly-with-monthly-cap" as const,
    partialHoursRoundedUp: true as const,
    poweredOffStillBilled: true as const,
    primaryIpLifecycle: "Primary IPs are separate resources; any non-zero provider price is billed while the IP exists. Verify or delete retained IPs after deleting the server." as const,
    trafficOverage: "Included traffic is fixed by the selected offer; additional outgoing traffic is variable usage billed separately." as const,
  },
  capabilities: HETZNER_CONNECTION.capabilities,
};

const HETZNER_QUOTE = {
  id: "00000000-0000-4000-8000-000000001033",
  connectionId: HETZNER_CONNECTION.id,
  connectionRevision: 1,
  serverName: "hivra-a1b2c3d4",
  serverType: {
    id: 22,
    name: "cx23",
    description: "Shared vCPU",
    architecture: "x86" as const,
    cores: 2,
    memoryGb: 4,
    diskGb: 40,
  },
  location: { id: 1, name: "nbg1", city: "Nuremberg", country: "DE" },
  image: {
    id: 100,
    name: "ubuntu-24.04",
    description: "Ubuntu 24.04",
    architecture: "x86" as const,
    osFlavor: "ubuntu" as const,
    osVersion: "24.04",
  },
  price: {
    currency: "EUR",
    vatRate: "19.0000",
    server: {
      hourly: { net: "0.0050", gross: "0.0060" },
      monthly: { net: "3.2900", gross: "3.9151" },
    },
    primaryIpv4: {
      hourly: { net: "0.0006", gross: "0.0007" },
      monthly: { net: "0.5000", gross: "0.5950" },
    },
    primaryIpv6: {
      hourly: { net: "0.0000", gross: "0.0000" },
      monthly: { net: "0.0000", gross: "0.0000" },
    },
    total: {
      hourly: { net: "0.0056", gross: "0.0067" },
      monthly: { net: "3.7900", gross: "4.5101" },
    },
    traffic: {
      includedBytes: 21990232555520,
      additionalPerTb: { net: "1.0000", gross: "1.1900" },
    },
  },
  publicNetwork: { ipv4: true as const, ipv6: true as const },
  backups: false as const,
  volumes: [],
  startAfterCreate: false as const,
  simpleModePolicy: HETZNER_CATALOG.simpleModePolicy,
  billing: HETZNER_CATALOG.billing,
  access: {
    username: "hivra" as const,
    method: "generated-ed25519" as const,
    inboundTcpPortsAfterFirstBoot: [22] as const,
    passwordAuthentication: false as const,
    rootSshLogin: false as const,
    providerFirewallAttached: false as const,
    firewallLimitation: "Hivra does not request or manage a provider firewall in this canary milestone. An existing Hetzner label-selector or project policy may still attach one. The host firewall is applied by cloud-init on first boot, so there is a boot-time gap." as const,
  },
  fetchedAt: "2026-08-26T15:00:00.000Z",
  expiresAt: "2099-08-26T15:05:00.000Z",
  spendingConfirmation: "Create server and start billing" as const,
};

const HETZNER_PREPARABLE_QUOTE = {
  ...HETZNER_QUOTE,
  image: { ...HETZNER_QUOTE.image, name: "ubuntu-22.04", description: "Ubuntu 22.04", osVersion: "22.04" },
};

function mockPreparableHetznerOffer() {
  (getHetznerCloudOfferCatalog as jest.Mock).mockResolvedValue({
    ...HETZNER_CATALOG,
    images: [{ ...HETZNER_PREPARABLE_QUOTE.image, deprecated: false }],
  });
  (quoteHetznerCloudCapacity as jest.Mock).mockResolvedValue(HETZNER_PREPARABLE_QUOTE);
}

const HETZNER_OPERATION = {
  id: "00000000-0000-4000-8000-000000001016",
  connectionId: HETZNER_CONNECTION.id,
  idempotencyKey: "00000000-0000-4000-8000-000000001048",
  status: "created_off" as const,
  providerServerId: HETZNER_OFF_SERVER.providerResourceId,
  providerActionId: "12345",
  providerActionCommand: "create_server",
  providerActionStatus: "success" as const,
  providerNextActions: [],
  observedServerStatus: "off" as const,
  providerObservedAt: "2026-08-26T15:00:04.000Z",
  errorCode: null,
  canarySlotHeld: true,
  replayed: false,
  quote: HETZNER_QUOTE,
  createdPoweredOff: true,
  launchReady: false as const,
  launchBlockedReason: "This provider VM is powered off and has not been prepared for agent launch.",
  createdAt: "2026-08-26T15:00:00.000Z",
  updatedAt: "2026-08-26T15:00:04.000Z",
};

describe("InfrastructureConnectionsPage first-run entry", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSearchParamsGet.mockReturnValue(null);
    window.localStorage.clear();
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      configurable: true,
      value: jest.fn(() => "00000000-0000-4000-8000-000000001048"),
    });
    (listInfrastructureConnections as jest.Mock).mockResolvedValue([]);
    (listInfrastructureTargets as jest.Mock).mockResolvedValue([]);
    (getHivraCloudCapacity as jest.Mock).mockResolvedValue(NO_HIVRA_CLOUD);
    (requestSubscriptionCheckout as jest.Mock).mockResolvedValue({
      ok: true,
      url: "https://checkout.stripe.test/hivra-cloud",
      resumed: false,
    });
    (getHetznerCloudInventory as jest.Mock).mockResolvedValue([]);
    (getHetznerCloudOfferCatalog as jest.Mock).mockResolvedValue(HETZNER_CATALOG);
    (quoteHetznerCloudCapacity as jest.Mock).mockResolvedValue(HETZNER_QUOTE);
    (createHetznerCloudCapacity as jest.Mock).mockResolvedValue({
      operation: HETZNER_OPERATION,
      inventory: [HETZNER_OFF_SERVER],
    });
    (deleteInfrastructureConnection as jest.Mock).mockResolvedValue(undefined);
    (forceForgetHetznerCloudConnection as jest.Mock).mockResolvedValue({
      connectionDeleted: true,
      localCredentialsWiped: true,
      providerCleanupPerformed: false,
      canarySlotHeld: true,
    });
    (refreshHetznerCloudInventory as jest.Mock).mockResolvedValue([]);
  });

  it("leads with Hivra Cloud, then truthful self-managed paths, and hides empty-state dashboard clutter", async () => {
    render(<InfrastructureConnectionsPage />);

    const chooser = await screen.findByRole("region", {
      name: "How would you like to add infrastructure?",
    });
    expect(screen.queryByLabelText("Infrastructure summary")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Available infrastructure" })).not.toBeInTheDocument();

    const paths = within(chooser).getAllByRole("article");
    expect(within(paths[0]).getByRole("heading", { name: "Let Hivra host it" })).toBeInTheDocument();
    expect(within(paths[1]).getByRole("heading", { name: "Use my cloud account" })).toBeInTheDocument();
    expect(within(paths[2]).getByRole("heading", { name: "Connect my own machine" })).toBeInTheDocument();
    expect(requestSubscriptionCheckout).not.toHaveBeenCalled();
    expect(connectHetznerCloudProject).not.toHaveBeenCalled();
    expect(createHetznerCloudCapacity).not.toHaveBeenCalled();
    fireEvent.click(within(chooser).getByRole("button", { name: /Choose cloud provider/i }));
    expect(within(chooser).getByRole("heading", { name: "Another provider or existing server" })).toBeInTheDocument();
    expect(within(chooser).getByText(/This uses SSH inspection, not a provider API/i)).toBeInTheDocument();
    expect(within(chooser).getByRole("link", { name: /API token guide/i })).toHaveAttribute("href", "https://docs.hetzner.com/cloud/api/getting-started/generating-api-token/");

  });

  it("keeps first-run self-managed setup available when managed capacity cannot be loaded", async () => {
    (getHivraCloudCapacity as jest.Mock).mockRejectedValueOnce(new Error("Usage temporarily unavailable"));
    render(<InfrastructureConnectionsPage />);

    const chooser = await screen.findByRole("region", { name: "How would you like to add infrastructure?" });
    expect(screen.getByRole("alert")).toHaveTextContent(/Managed capacity could not be loaded/);
    expect(screen.getByRole("button", { name: "Retry Hivra Cloud capacity" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Hivra Cloud capacity" })).not.toBeInTheDocument();
    fireEvent.click(within(chooser).getByRole("button", { name: /Choose cloud provider/i }));
    fireEvent.click(within(chooser).getByRole("button", { name: /Use an existing server/i }));
    fireEvent.click(within(chooser).getByRole("button", { name: /Connect existing host/i }));
    expect(screen.getByRole("dialog", { name: "Connect a host" })).toBeInTheDocument();
    expect(requestSubscriptionCheckout).not.toHaveBeenCalled();
    expect(createInfrastructureConnection).not.toHaveBeenCalled();
    expect(connectHetznerCloudProject).not.toHaveBeenCalled();
    expect(createHetznerCloudCapacity).not.toHaveBeenCalled();
    expect(discoverInfrastructureHost).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close infrastructure setup" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/Managed capacity could not be loaded/);
  });

  it("preserves a selected agent through capacity setup and returns to its deploy form", async () => {
    const target = providerVmTarget();
    target.connectionId = HETZNER_CONNECTION.id;
    target.status = "ready";
    target.lastErrorCode = null;
    target.capabilities.launchReady = true;
    target.capabilities.provisioner.ready = true;
    mockSearchParamsGet.mockImplementation((key: string) => key === "launch" ? "codex" : null);
    (listInfrastructureConnections as jest.Mock).mockResolvedValue([HETZNER_CONNECTION]);
    (listInfrastructureTargets as jest.Mock).mockResolvedValue([target]);

    render(<InfrastructureConnectionsPage />);

    expect(await screen.findByRole("link", { name: /Continue launch/i })).toHaveAttribute(
      "href",
      `/dashboard/welcome?step=deploy&agentType=codex&targetId=${target.id}`,
    );
    expect(screen.getByText(/Capacity is ready for Codex/i)).toBeInTheDocument();
  });

  it("does not claim Linux Sandbox readiness from Hivra Cloud while a host is still pending", async () => {
    mockSearchParamsGet.mockImplementation((key: string) => key === "launch" ? "linux-terminal" : null);
    (listInfrastructureConnections as jest.Mock).mockResolvedValue([PENDING_HOST_CONNECTION]);
    (getHivraCloudCapacity as jest.Mock).mockResolvedValue(ACTIVE_HIVRA_CLOUD);

    render(<InfrastructureConnectionsPage />);

    expect(await screen.findByRole("heading", { name: "Hivra Cloud capacity" })).toBeInTheDocument();
    expect(screen.queryByText(/Capacity is ready for Linux Sandbox/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Continue launch/i })).not.toBeInTheDocument();
  });

  it("returns to Linux Sandbox launch when a compatible gVisor target is ready", async () => {
    mockSearchParamsGet.mockImplementation((key: string) => key === "launch" ? "linux-terminal" : null);
    (listInfrastructureConnections as jest.Mock).mockResolvedValue([{
      ...PENDING_HOST_CONNECTION,
      status: "ready",
      lastCheckedAt: "2026-09-15T12:00:00.000Z",
    }]);
    (listInfrastructureTargets as jest.Mock).mockResolvedValue([READY_GVISOR_TARGET]);

    render(<InfrastructureConnectionsPage />);

    expect(await screen.findByRole("link", { name: /Continue launch/i })).toHaveAttribute(
      "href",
      `/dashboard/computers?launch=1&targetId=${READY_GVISOR_TARGET.id}`,
    );
    expect(screen.getByText(/Capacity is ready for Linux Sandbox/i)).toBeInTheDocument();
  });

  it("refreshes saved readiness again when a completed preparation closes", async () => {
    const staleConnection: InfrastructureConnectionDto = {
      ...PENDING_HOST_CONNECTION,
      status: "error",
      lastCheckedAt: "2026-09-15T12:00:00.000Z",
      lastErrorCode: "PROVISIONER_UNAVAILABLE",
    };
    const readyConnection: InfrastructureConnectionDto = {
      ...staleConnection,
      status: "ready",
      lastCheckedAt: "2026-09-15T12:05:00.000Z",
      lastErrorCode: null,
    };
    (listInfrastructureConnections as jest.Mock)
      .mockResolvedValueOnce([staleConnection])
      .mockResolvedValueOnce([staleConnection])
      .mockResolvedValue([readyConnection]);
    (listInfrastructureTargets as jest.Mock)
      .mockResolvedValueOnce([PREPARABLE_PROXMOX_TARGET])
      .mockResolvedValueOnce([PREPARABLE_PROXMOX_TARGET])
      .mockResolvedValue([READY_PROXMOX_TARGET]);
    (prepareInfrastructureConnection as jest.Mock).mockResolvedValue({
      ok: true,
      connectionId: staleConnection.id,
      provisionerVersion: "2026.09.15.2",
      preflight: {
        ok: true,
        connectionId: staleConnection.id,
        checkedAt: "2026-09-15T12:05:00.000Z",
        target: {
          externalId: "pve-01",
          displayName: "Linux host / pve-01",
          proxmoxVersion: "pve-manager/8.4.1",
          launchReady: true,
          capacity: READY_PROXMOX_TARGET.capacity,
          capabilities: {
            isolationDrivers: ["proxmox-kvm"],
            isolationClass: "hardware-vm",
            kvmAvailable: true,
            bridges: ["hivra0"],
            storages: ["local-lvm"],
            template: null,
            provisioner: { ready: true, version: "2026.09.15.2" },
            runtimeCompatibility: null,
            vmidRange: { start: 200, end: 399, freeCount: 200 },
          },
        },
        warnings: [],
        unmetRequirements: [],
      },
    });

    render(<InfrastructureConnectionsPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Prepare recommended setup" }));
    const prepareDialog = await screen.findByRole("dialog");
    fireEvent.click(within(prepareDialog).getByRole("button", { name: "Prepare recommended setup" }));
    expect(await screen.findByRole("heading", { name: /Linux host is ready for agents/i })).toBeInTheDocument();
    expect(listInfrastructureTargets).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    await waitFor(() => expect(listInfrastructureTargets).toHaveBeenCalledTimes(3));
    expect(await screen.findByText("Ready for agents")).toBeInTheDocument();
  });

  it("refreshes saved readiness when gVisor repair closes the inspection dialog", async () => {
    mockSearchParamsGet.mockImplementation((key: string) => key === "launch" ? "linux-terminal" : null);
    const readyConnection: InfrastructureConnectionDto = {
      ...PENDING_HOST_CONNECTION,
      status: "ready",
      lastCheckedAt: "2026-09-15T12:05:00.000Z",
      lastErrorCode: null,
    };
    (listInfrastructureConnections as jest.Mock)
      .mockResolvedValueOnce([PENDING_HOST_CONNECTION])
      .mockResolvedValueOnce([PENDING_HOST_CONNECTION])
      .mockResolvedValue([readyConnection]);
    (listInfrastructureTargets as jest.Mock)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValue([READY_GVISOR_TARGET]);
    (discoverInfrastructureHost as jest.Mock).mockResolvedValue(DISCOVERED_INSTALLED_GVISOR);
    const originalFetch = global.fetch;
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true }),
    });
    Object.defineProperty(global, "fetch", { value: fetchMock, configurable: true });

    try {
      render(<InfrastructureConnectionsPage />);

      fireEvent.click(await screen.findByRole("button", { name: "Inspect again" }));
      expect(await screen.findByRole("heading", {
        name: "A supported Linux sandbox path is available.",
      })).toBeInTheDocument();
      await waitFor(() => expect(listInfrastructureTargets).toHaveBeenCalledTimes(2));

      fireEvent.click(screen.getByRole("button", { name: "Repair gVisor" }));
      expect(await screen.findByText(/pinned runtime, application adapter, and exact host evidence passed/i)).toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/infrastructure/connections/${PENDING_HOST_CONNECTION.id}/gvisor/prepare`,
        expect.objectContaining({ method: "POST" }),
      );

      fireEvent.click(screen.getByRole("button", { name: "Done" }));

      await waitFor(() => expect(listInfrastructureTargets).toHaveBeenCalledTimes(3));
      expect(await screen.findByRole("link", { name: /Continue launch/i })).toHaveAttribute("href", expect.stringContaining(READY_GVISOR_TARGET.id));
    } finally {
      Object.defineProperty(global, "fetch", { value: originalFetch, configurable: true });
    }
  });

  it("refreshes saved readiness when Edit host readiness closes the wizard", async () => {
    const initialConnection: InfrastructureConnectionDto = {
      ...PENDING_HOST_CONNECTION,
      status: "ready",
      lastCheckedAt: "2026-09-15T12:00:00.000Z",
    };
    const pendingConnection: InfrastructureConnectionDto = {
      ...initialConnection,
      status: "pending",
      lastCheckedAt: null,
      configuration: {
        capacityPolicy: {
          mode: "observe",
          hostMemoryReserveMb: 2304,
          cpuCeilingDensity: 1,
          memoryCeilingDensity: 1,
        },
      },
    };
    const reboundConnection: InfrastructureConnectionDto = {
      ...pendingConnection,
      status: "ready",
      lastCheckedAt: "2026-09-15T12:05:00.000Z",
    };
    (listInfrastructureConnections as jest.Mock)
      .mockResolvedValueOnce([initialConnection])
      .mockResolvedValueOnce([pendingConnection])
      .mockResolvedValue([reboundConnection]);
    (listInfrastructureTargets as jest.Mock)
      .mockResolvedValueOnce([READY_PROXMOX_TARGET])
      .mockResolvedValueOnce([PREPARABLE_PROXMOX_TARGET])
      .mockResolvedValue([READY_PROXMOX_TARGET]);
    (updateInfrastructureConnection as jest.Mock).mockResolvedValue(pendingConnection);
    (discoverInfrastructureHost as jest.Mock).mockResolvedValue(DISCOVERED_PROXMOX);
    (preflightInfrastructureConnection as jest.Mock).mockResolvedValue({
      ok: true,
      connectionId: initialConnection.id,
      checkedAt: "2026-09-15T12:05:00.000Z",
      target: {
        externalId: "pve-01",
        displayName: "Linux host / pve-01",
        proxmoxVersion: "pve-manager/8.4.1",
        launchReady: true,
        capacity: READY_PROXMOX_TARGET.capacity,
        capabilities: {
          isolationDrivers: ["proxmox-kvm"],
          isolationClass: "hardware-vm",
          kvmAvailable: true,
          bridges: ["hivra0"],
          storages: ["local-lvm"],
          template: null,
          provisioner: { ready: true, version: "2026.09.15.2" },
          runtimeCompatibility: null,
          vmidRange: { start: 200, end: 399, freeCount: 200 },
        },
      },
      warnings: [],
      unmetRequirements: [],
    });

    render(<InfrastructureConnectionsPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const wizard = await screen.findByRole("dialog");
    fireEvent.change(within(wizard).getByLabelText("Host memory reserve (MB)"), {
      target: { value: "2304" },
    });
    fireEvent.click(within(wizard).getByRole("button", { name: "Save and inspect" }));

    expect(await within(wizard).findByRole("heading", {
      name: "A supported isolation engine is installed.",
    })).toBeInTheDocument();
    fireEvent.click(within(wizard).getByRole("button", { name: "Check Proxmox readiness" }));
    expect(await within(wizard).findByRole("heading", { name: "Ready for agents" })).toBeInTheDocument();
    await waitFor(() => expect(listInfrastructureTargets).toHaveBeenCalledTimes(2));

    fireEvent.click(within(wizard).getByRole("button", { name: "Done" }));

    await waitFor(() => expect(listInfrastructureTargets).toHaveBeenCalledTimes(3));
    expect(await screen.findByText("Ready for agents")).toBeInTheDocument();
  });

  it("returns unified Codex capacity setup to the saved launch journey", async () => {
    const target = providerVmTarget();
    target.connectionId = HETZNER_CONNECTION.id;
    target.status = "ready";
    target.lastErrorCode = null;
    target.capabilities.launchReady = true;
    target.capabilities.provisioner.ready = true;
    mockSearchParamsGet.mockImplementation((key: string) => {
      if (key === "launch") return "codex";
      if (key === "returnTo") return "unified-launch";
      return null;
    });
    (listInfrastructureConnections as jest.Mock).mockResolvedValue([HETZNER_CONNECTION]);
    (listInfrastructureTargets as jest.Mock).mockResolvedValue([target]);

    render(<InfrastructureConnectionsPage />);

    expect(await screen.findByRole("link", { name: /Continue launch/i })).toHaveAttribute(
      "href",
      `/dashboard/launch?kind=agent&targetId=${target.id}`,
    );
  });

  it("keeps self-host onboarding local while offering Hivra Cloud as an explicit external option", async () => {
    const previousMode = process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE;
    process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE = "local";
    try {
      render(<InfrastructureConnectionsPage />);

      const chooser = await screen.findByRole("region", {
        name: "How would you like to add infrastructure?",
      });
      expect(screen.getByText(/Connect a cloud project or bring a computer you control/i)).toBeInTheDocument();
      expect(screen.queryByText(/Managed capacity appears here as soon as your plan is active/i)).not.toBeInTheDocument();
      expect(getHivraCloudCapacity).not.toHaveBeenCalled();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(within(chooser).getByRole("link", { name: /Open Hivra Cloud/i })).toHaveAttribute(
        "href",
        "https://hivra.cloud/dashboard/infrastructure",
      );
      expect(within(chooser).queryByRole("button", { name: /Choose Hivra Cloud/i })).not.toBeInTheDocument();
      expect(within(chooser).getByRole("button", { name: /Choose cloud provider/i })).toBeInTheDocument();
      expect(within(chooser).getByRole("button", { name: /Choose my machine/i })).toBeInTheDocument();
    } finally {
      if (previousMode === undefined) delete process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE;
      else process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE = previousMode;
    }
  });

  it("shows an active Hivra Cloud pool and the managed computers already using it", async () => {
    (getHivraCloudCapacity as jest.Mock).mockResolvedValue(ACTIVE_HIVRA_CLOUD);
    render(<InfrastructureConnectionsPage />);

    expect(await screen.findByRole("heading", { name: "Hivra Cloud capacity" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "How would you like to add infrastructure?" })).not.toBeInTheDocument();
    const cloudCard = screen.getByRole("heading", { name: "Hivra Cloud" }).closest("article") as HTMLElement;
    expect(within(cloudCard).getByText(/Your plan's CPU and RAM allowance/i)).toHaveTextContent("The servers that host them have separate capacity.");
    expect(within(cloudCard).getByText("1.5 vCPU allocated")).toBeInTheDocument();
    expect(within(cloudCard).getByText("3 GB allocated")).toBeInTheDocument();
    expect(within(cloudCard).getByText("0.5 of 2")).toBeInTheDocument();
    expect(within(cloudCard).getByText("1 GB of 4 GB")).toBeInTheDocument();
    expect(within(cloudCard).getByRole("link", { name: "Open Hermes One" })).toHaveAttribute(
      "href",
      "/dashboard/instances/hermes-one",
    );
    expect(within(cloudCard).getByRole("link", { name: "Manage resources for Codex One" })).toHaveAttribute(
      "href",
      "/dashboard/agent/codex-one?tab=manage#resources",
    );
    expect(within(cloudCard).getByRole("link", { name: "Open Codex One" })).toHaveAttribute(
      "href",
      "/dashboard/agent/codex-one",
    );
    expect(within(cloudCard).getByRole("link", { name: /Launch an agent/i })).toHaveAttribute(
      "href",
      "/dashboard/launch?start=1&kind=agent",
    );
    expect(within(cloudCard).getByRole("link", { name: /Launch a computer/i })).toHaveAttribute(
      "href",
      "/dashboard/launch?start=1&kind=computer",
    );

    fireEvent.click(screen.getByRole("button", { name: "Add capacity" }));
    const chooser = screen.getByRole("region", { name: "How would you like to add infrastructure?" });
    expect(within(chooser).getByText("Pro is active. Review plan options in Billing.")).toBeInTheDocument();
    expect(requestSubscriptionCheckout).not.toHaveBeenCalled();
    expect(within(chooser).getByRole("link", { name: /Manage Hivra Cloud/i })).toHaveAttribute(
      "href",
      "/dashboard/billing",
    );
    expect(within(chooser).queryByRole("button", { name: /Choose Hivra Cloud/i })).not.toBeInTheDocument();
  });

  it.each([
    { source: "stripe", canChangePlanInPlace: true, label: "Upgrade or manage plan" },
    { source: "grant", canChangePlanInPlace: false, label: "View plan options" },
  ])("routes a paid $source plan to Billing without a new purchase", async ({ source, canChangePlanInPlace, label }) => {
    (getHivraCloudCapacity as jest.Mock).mockResolvedValue({
      ...ACTIVE_HIVRA_CLOUD,
      plan: { ...ACTIVE_HIVRA_CLOUD.plan, source, canChangePlanInPlace },
    });
    render(<InfrastructureConnectionsPage />);
    expect(await screen.findByRole("link", { name: label })).toHaveAttribute("href", "/dashboard/billing");
    expect(screen.queryByRole("button", { name: /Buy more capacity/i })).not.toBeInTheDocument();
    expect(requestSubscriptionCheckout).not.toHaveBeenCalled();
  });

  it("opens Hivra Cloud checkout only after the user chooses power and confirms", async () => {
    render(<InfrastructureConnectionsPage />);

    const chooser = await screen.findByRole("region", {
      name: "How would you like to add infrastructure?",
    });
    fireEvent.click(within(chooser).getByRole("button", { name: /Choose Hivra Cloud/i }));

    const dialog = screen.getByRole("dialog", { name: "Choose Hivra Cloud power" });
    expect(requestSubscriptionCheckout).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("radio", { name: /Power/i }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Yearly" }));
    fireEvent.click(within(dialog).getByRole("button", { name: /Continue to secure checkout/i }));

    await waitFor(() => expect(requestSubscriptionCheckout).toHaveBeenCalledWith("fleet", "yearly"));
    expect(redirectToCheckoutUrl).toHaveBeenCalledWith("https://checkout.stripe.test/hivra-cloud");
  });

  it("refreshes Infrastructure when Hivra Cloud activates without a checkout redirect", async () => {
    (requestSubscriptionCheckout as jest.Mock).mockResolvedValueOnce({
      ok: true,
      activated: true,
    });
    render(<InfrastructureConnectionsPage />);

    const chooser = await screen.findByRole("region", {
      name: "How would you like to add infrastructure?",
    });
    fireEvent.click(within(chooser).getByRole("button", { name: /Choose Hivra Cloud/i }));
    fireEvent.click(screen.getByRole("button", { name: /Continue to secure checkout/i }));

    await waitFor(() => expect(getHivraCloudCapacity).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("dialog", { name: "Choose Hivra Cloud power" })).not.toBeInTheDocument();
    expect(redirectToCheckoutUrl).not.toHaveBeenCalled();
  });

  it("offers existing plan management when subscription state changes before checkout", async () => {
    (requestSubscriptionCheckout as jest.Mock).mockResolvedValueOnce({
      ok: false, reason: "ACTIVE_SUBSCRIPTION", message: "Already subscribed",
    });
    render(<InfrastructureConnectionsPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Choose Hivra Cloud/i }));
    fireEvent.click(screen.getByRole("button", { name: /Continue to secure checkout/i }));
    expect(await screen.findByRole("link", { name: /Manage existing plan/i })).toHaveAttribute("href", "/dashboard/billing");
    expect(screen.getByRole("button", { name: /Continue to secure checkout/i })).toBeDisabled();
    expect(redirectToCheckoutUrl).not.toHaveBeenCalled();
    expect(getHivraCloudCapacity).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /Close Hivra Cloud purchase/i }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps inventory separate from agent readiness, which is checked in Computer setup", () => {
    render(<HetznerCloudConnectionCard connection={HETZNER_CONNECTION} inventory={[HETZNER_OFF_SERVER]} loading={false}
      onCreateCapacity={jest.fn()} onRefresh={jest.fn()} onDelete={jest.fn()} onSetup={jest.fn()} />);
    expect(screen.getByText("Provider inventory · Open Computer setup to check agent readiness")).toBeInTheDocument();
    expect(screen.queryByText(/not launch.ready/i)).not.toBeInTheDocument();
  });

  it("connects a project, observes current provider billing, and shows only verified powered-off inventory", async () => {
    (connectHetznerCloudProject as jest.Mock).mockResolvedValue({
      connection: HETZNER_CONNECTION,
      inventory: [],
    });
    render(<InfrastructureConnectionsPage />);

    const chooser = await screen.findByRole("region", {
      name: "How would you like to add infrastructure?",
    });
    fireEvent.click(within(chooser).getByRole("button", { name: /Choose cloud provider/i }));
    fireEvent.click(within(chooser).getByRole("button", { name: /Start with Hetzner/i }));

    const dialog = screen.getByRole("dialog", { name: "Connect Hetzner Cloud" });
    const tokenField = within(dialog).getByLabelText(/Read & Write project API token/);
    const nameField = within(dialog).getByLabelText("Connection name");
    const namingDisclosure = within(dialog).getByText("Customize connection name").closest("details");
    const helpDisclosure = within(dialog).getByText("Need a Hetzner project or API token?").closest("details");
    expect(tokenField).toBeVisible();
    expect(nameField).not.toBeVisible();
    expect(namingDisclosure).not.toHaveAttribute("open");
    expect(helpDisclosure).not.toHaveAttribute("open");

    fireEvent.click(within(dialog).getByText("Customize connection name"));
    expect(nameField).toBeVisible();
    fireEvent.change(nameField, {
      target: { value: "Personal cloud" },
    });
    fireEvent.change(tokenField, {
      target: { value: "secure-project-token-1234567890" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Connect and choose a server" }));

    await waitFor(() => expect(connectHetznerCloudProject).toHaveBeenCalledWith({
      name: "Personal cloud",
      provider: "hetzner-cloud",
      operatingMode: "self-managed",
      setupMode: "simple",
      credentials: { apiToken: "secure-project-token-1234567890" },
    }));
    const capacityDialog = await screen.findByRole("dialog", { name: "Choose a Hetzner server" });
    expect(await within(capacityDialog).findByLabelText("Server size")).toHaveValue("22");
    expect(within(capacityDialog).getByLabelText("Location")).toHaveValue("1");
    expect(within(capacityDialog).getByLabelText("System image")).toHaveValue("100");
    expect(within(capacityDialog).getByText(/Nothing is created yet/i)).toBeInTheDocument();
    expect(within(capacityDialog).getByText(
      /Canary allows one non-rejected in-app Hetzner server per Hivra account across all connected projects/i,
    )).toBeInTheDocument();

    fireEvent.click(within(capacityDialog).getByRole("button", { name: "Review current rates" }));
    await waitFor(() => expect(quoteHetznerCloudCapacity).toHaveBeenCalledWith(
      HETZNER_CONNECTION.id,
      { serverTypeId: 22, locationId: 1, imageId: 100 },
    ));

    expect(await within(capacityDialog).findByText("EUR 4.5101")).toBeInTheDocument();
    expect(within(capacityDialog).getByText("Primary IPv4")).toBeInTheDocument();
    expect(within(capacityDialog).getByText("Primary IPv6")).toBeInTheDocument();
    expect(within(capacityDialog).getByText(/Traffic beyond 20 TiB/i)).toBeInTheDocument();
    expect(within(capacityDialog).getByText(/Powered off.*point-in-time provider observation/i)).toBeInTheDocument();
    expect(within(capacityDialog).getByText(/rare migration or hardware-failure cases/i)).toBeInTheDocument();
    expect(within(capacityDialog).getByText(/Hetzner determines final billing and may reject or change/i))
      .toBeInTheDocument();
    expect(within(capacityDialog).getByText(
      "One non-rejected in-app Hetzner server per Hivra account",
    )).toBeInTheDocument();
    expect(within(capacityDialog).getByText(
      /Hivra does not request or manage a provider firewall.*existing Hetzner label-selector or project policy may still attach one.*boot-time gap/i,
    )).toBeInTheDocument();

    const createButton = within(capacityDialog).getByRole("button", {
      name: "Create server and start billing",
    });
    expect(createButton).toBeDisabled();
    fireEvent.click(within(capacityDialog).getByRole("checkbox", { name: /I approve this observed configuration/i }));
    expect(createButton).toBeEnabled();
    fireEvent.click(createButton);

    await waitFor(() => expect(createHetznerCloudCapacity).toHaveBeenCalledWith(
      HETZNER_CONNECTION.id,
      {
        quoteId: HETZNER_QUOTE.id,
        idempotencyKey: "00000000-0000-4000-8000-000000001048",
        spendingConfirmation: "Create server and start billing",
      },
    ));
    expect(await within(capacityDialog).findByRole("heading", {
      name: "Created, powered off, not prepared.",
    })).toBeInTheDocument();
    expect(within(capacityDialog).getByText("hivra-a1b2c3d4")).toBeInTheDocument();
    expect(within(capacityDialog).getByText("Not prepared")).toBeInTheDocument();
    expect(within(capacityDialog).getByText(/Launch remains blocked/i)).toBeInTheDocument();
    expect(within(capacityDialog).getByText(/uses the account's one Canary capacity slot/i))
      .toBeInTheDocument();
    expect(screen.queryByDisplayValue("secure-project-token-1234567890")).not.toBeInTheDocument();
  });

  it("displays precise provider amounts without insignificant trailing zeros", async () => {
    const quote = {
      ...HETZNER_QUOTE,
      price: {
        ...HETZNER_QUOTE.price,
        currency: "USD",
        vatRate: "20.000000",
        server: {
          hourly: { net: "0.0104000000", gross: "0.0124800000000000" },
          monthly: { net: "6.4900000000", gross: "7.7880000000000000" },
        },
        primaryIpv4: {
          hourly: { net: "0.0010000000", gross: "0.0012000000000000" },
          monthly: { net: "0.6000000000", gross: "0.7200000000000000" },
        },
        primaryIpv6: {
          hourly: { net: "0.0000000000000000", gross: "0.0000000000000000" },
          monthly: { net: "0.0000000000000001", gross: "0.0000000000000001" },
        },
        total: {
          hourly: { net: "0.0114000000", gross: "0.0136800000000000" },
          monthly: { net: "7.0900000000000001", gross: "8.5080000000000001" },
        },
        traffic: {
          ...HETZNER_QUOTE.price.traffic,
          additionalPerTb: { net: "1.2000000000", gross: "1.4400000000000000" },
        },
      },
    };
    const originalQuote = JSON.stringify(quote);
    (listInfrastructureConnections as jest.Mock).mockResolvedValue([HETZNER_CONNECTION]);
    (getHetznerCloudInventory as jest.Mock).mockResolvedValue([]);
    (quoteHetznerCloudCapacity as jest.Mock).mockResolvedValue(quote);
    render(<InfrastructureConnectionsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Create cloud server" }));
    const dialog = await screen.findByRole("dialog", { name: "Choose a Hetzner server" });
    await within(dialog).findByLabelText("Server size");
    fireEvent.click(within(dialog).getByRole("button", { name: "Review current rates" }));
    await within(dialog).findByRole("heading", { name: "Review price and creation" });

    expect(within(dialog).getByText("USD 7.788 / month cap")).toBeInTheDocument();
    expect(within(dialog).getByText("USD 0.72 / month cap")).toBeInTheDocument();
    expect(within(dialog).getByText("USD 0 / hour gross")).toBeInTheDocument();
    expect(within(dialog).getByText("USD 0.0000000000000001 / month cap")).toBeInTheDocument();
    expect(within(dialog).getByText("USD 1.44")).toBeInTheDocument();
    expect(within(dialog).getByText(/Hetzner VAT rate: 20%/)).toBeInTheDocument();
    expect(within(dialog).getByRole("checkbox", {
      name: /gross base rate of USD 0\.01368 per hour, capped at USD 8\.5080000000000001 per month/,
    })).not.toBeChecked();
    expect(within(dialog).getByRole("button", { name: "Create server and start billing" })).toBeDisabled();
    expect(JSON.stringify(quote)).toBe(originalQuote);
    expect(createHetznerCloudCapacity).not.toHaveBeenCalled();
  });

  it("resets the scrolled dialog and focuses each new capacity step", async () => {
    (listInfrastructureConnections as jest.Mock).mockResolvedValue([HETZNER_CONNECTION]);
    (getHetznerCloudInventory as jest.Mock).mockResolvedValue([]);
    render(<InfrastructureConnectionsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Create cloud server" }));
    const dialog = await screen.findByRole("dialog", { name: "Choose a Hetzner server" });
    await within(dialog).findByLabelText("Server size");
    dialog.scrollTop = 350;
    fireEvent.click(within(dialog).getByRole("button", { name: "Review current rates" }));
    const reviewHeading = await within(dialog).findByRole("heading", { name: "Review price and creation" });
    expect(dialog.scrollTop).toBe(0);
    expect(reviewHeading).toHaveFocus();

    dialog.scrollTop = 850;
    fireEvent.click(within(dialog).getByRole("button", { name: "Change configuration" }));
    const chooseHeading = await within(dialog).findByRole("heading", { name: "Choose a Hetzner server" });
    expect(dialog.scrollTop).toBe(0);
    expect(chooseHeading).toHaveFocus();

    fireEvent.click(within(dialog).getByRole("button", { name: "Review current rates" }));
    fireEvent.click(await within(dialog).findByRole("checkbox", { name: /I approve this observed configuration/ }));
    dialog.scrollTop = 850;
    fireEvent.click(within(dialog).getByRole("button", { name: "Create server and start billing" }));
    const resultHeading = await within(dialog).findByRole("heading", { name: "Provider result" });
    expect(dialog.scrollTop).toBe(0);
    expect(resultHeading).toHaveFocus();
  });

  it("brings each new capacity step into view when the dashboard page scrolls the dialog", async () => {
    (listInfrastructureConnections as jest.Mock).mockResolvedValue([HETZNER_CONNECTION]);
    render(<InfrastructureConnectionsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Create cloud server" }));
    const dialog = await screen.findByRole("dialog", { name: "Choose a Hetzner server" });
    await within(dialog).findByLabelText("Server size");
    // Phone CSS makes the dialog overflow visible so the dashboard main scrolls it.
    dialog.style.overflowY = "visible";
    const scrollIntoView = jest.fn();
    dialog.scrollIntoView = scrollIntoView;

    fireEvent.click(within(dialog).getByRole("button", { name: "Review current rates" }));
    const reviewHeading = await within(dialog).findByRole("heading", { name: "Review price and creation" });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    expect(reviewHeading).toHaveFocus();

    fireEvent.click(within(dialog).getByRole("button", { name: "Change configuration" }));
    await within(dialog).findByRole("heading", { name: "Choose a Hetzner server" });
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["phone", "visible", true],
    ["desktop", "auto", false],
  ])("on %s layouts, scrolls an opened dialog's top into view only when the page scrolls it", async (_layout, overflowY, scrolls) => {
    (listInfrastructureConnections as jest.Mock).mockResolvedValue([HETZNER_CONNECTION]);
    (getHetznerCloudInventory as jest.Mock).mockResolvedValue([HETZNER_OFF_SERVER]);
    // Phone CSS makes in-flow dialogs overflow visible so the dashboard main
    // scrolls them; desktop dialogs scroll themselves.
    const layout = document.createElement("style");
    layout.textContent = `[role="dialog"], [role="alertdialog"] { overflow-y: ${overflowY}; }`;
    document.head.appendChild(layout);
    try {
      const { container } = render(<InfrastructureConnectionsPage />);
      const card = (await screen.findByRole("heading", { name: "Personal cloud" })).closest("article") as HTMLElement;
      const anchor = container.querySelector("[data-infrastructure-modal-anchor]") as HTMLElement;
      const scrollIntoView = jest.fn();
      anchor.scrollIntoView = scrollIntoView;

      fireEvent.click(within(card).getByRole("button", { name: "Disconnect project Personal cloud" }));
      await screen.findByRole("alertdialog", { name: "Disconnect Personal cloud?" });
      expect(scrollIntoView).toHaveBeenCalledTimes(scrolls ? 1 : 0);
      if (scrolls) expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "start" });

      fireEvent.click(screen.getByRole("button", { name: "Keep connection" }));
      await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
      expect(scrollIntoView).toHaveBeenCalledTimes(scrolls ? 1 : 0);

      fireEvent.click(within(card).getByRole("button", { name: "Create cloud server" }));
      await screen.findByRole("dialog", { name: "Choose a Hetzner server" });
      expect(scrollIntoView).toHaveBeenCalledTimes(scrolls ? 2 : 0);
    } finally {
      layout.remove();
    }
  });

  it("scrolls a phone dialog to its top before moving focus into it", async () => {
    (listInfrastructureConnections as jest.Mock).mockResolvedValue([PENDING_HOST_CONNECTION]);
    const layout = document.createElement("style");
    layout.textContent = '[role="alertdialog"] { overflow-y: visible; }';
    document.head.appendChild(layout);
    try {
      const { container } = render(<InfrastructureConnectionsPage />);
      const card = (await screen.findByRole("heading", { name: "Linux host" })).closest("article") as HTMLElement;
      const anchor = container.querySelector("[data-infrastructure-modal-anchor]") as HTMLElement;
      const focusedAtScroll: Array<Element | null> = [];
      anchor.scrollIntoView = jest.fn(() => {
        focusedAtScroll.push(document.activeElement);
      });
      const opener = within(card).getByRole("button", { name: "Disconnect host Linux host" });
      opener.focus();

      fireEvent.click(opener);
      const dialog = await screen.findByRole("alertdialog", { name: "Disconnect Linux host?" });

      // Focusing the initial control afterwards only scrolls when it is out of
      // view, so the dialog does not open at the scroll offset of its last action.
      expect(focusedAtScroll).toEqual([opener]);
      expect(within(dialog).getByRole("button", { name: "Keep connection" })).toHaveFocus();
    } finally {
      layout.remove();
    }
  });

  it("shows saved recovery identifiers in full and copies each exact value", async () => {
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const record = {
      version: 2,
      connectionId: HETZNER_CONNECTION.id,
      quoteId: "11111111-1111-4111-8111-111111111111",
      idempotencyKey: "22222222-2222-4222-8222-222222222222",
      prepare: false,
    };
    window.localStorage.setItem(
      `hivra:hetzner-capacity-recovery:${HETZNER_CONNECTION.id}`,
      JSON.stringify(record),
    );
    try {
      render(<HetznerCloudCapacityDialog connection={HETZNER_CONNECTION} onClose={jest.fn()} onInventoryChanged={jest.fn()} />);
      const dialog = await screen.findByRole("dialog", { name: "Recover pending request" });
      const facts = within(dialog).getByLabelText("Saved recovery identifiers");
      expect(within(facts).getByText(record.connectionId)).toBeInTheDocument();
      expect(within(facts).getByText(record.quoteId)).toBeInTheDocument();

      fireEvent.click(within(facts).getByRole("button", { name: "Copy request key" }));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(record.idempotencyKey));
      expect(await within(facts).findByRole("button", { name: "Copied request key" })).toBeInTheDocument();
      expect(within(facts).getByText("Copied request key")).toHaveAttribute("role", "status");

      fireEvent.click(within(facts).getByRole("button", { name: "Copy quote id" }));
      await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(record.quoteId));
      expect(createHetznerCloudCapacity).not.toHaveBeenCalled();
    } finally {
      if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
      else delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });

  it.each([
    ["denied", () => ({ writeText: jest.fn().mockRejectedValue(new Error("NotAllowedError")) })],
    ["missing", () => undefined],
  ])("selects a recovery id and says so when clipboard access is %s", async (_case, makeClipboard) => {
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: makeClipboard() });
    const record = {
      version: 2,
      connectionId: HETZNER_CONNECTION.id,
      quoteId: "11111111-1111-4111-8111-111111111111",
      idempotencyKey: "22222222-2222-4222-8222-222222222222",
      prepare: false,
    };
    window.localStorage.setItem(
      `hivra:hetzner-capacity-recovery:${HETZNER_CONNECTION.id}`,
      JSON.stringify(record),
    );
    try {
      render(<HetznerCloudCapacityDialog connection={HETZNER_CONNECTION} onClose={jest.fn()} onInventoryChanged={jest.fn()} />);
      const dialog = await screen.findByRole("dialog", { name: "Recover pending request" });
      const facts = within(dialog).getByLabelText("Saved recovery identifiers");

      fireEvent.click(within(facts).getByRole("button", { name: "Copy request key" }));

      expect(await within(facts).findByText("Selected — use Copy")).toHaveAttribute("role", "status");
      expect(window.getSelection()?.toString()).toBe(record.idempotencyKey);
      // Nothing claims a copy that did not happen.
      expect(within(facts).queryByRole("button", { name: /^Copied/ })).not.toBeInTheDocument();
    } finally {
      window.getSelection()?.removeAllRanges();
      if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
      else delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });

  it("explains the selected guided firewall sequence without claiming it has run", async () => {
    (listInfrastructureConnections as jest.Mock).mockResolvedValue([HETZNER_CONNECTION]);
    (getHetznerCloudInventory as jest.Mock).mockResolvedValue([]);
    mockPreparableHetznerOffer();
    render(<InfrastructureConnectionsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Create cloud server" }));
    const dialog = await screen.findByRole("dialog", { name: "Choose a Hetzner server" });
    await within(dialog).findByLabelText("Server size");
    fireEvent.click(within(dialog).getByRole("button", { name: "Review current rates" }));
    const preparation = await within(dialog).findByRole("checkbox", { name: /Enable guided computer setup/ });
    expect(preparation).toBeEnabled();
    expect(within(dialog).getByText(/Hivra does not request or manage a provider firewall/)).toBeInTheDocument();

    fireEvent.click(preparation);
    expect(preparation).toBeChecked();
    expect(within(dialog).getByText("Guided setup checks the firewall before startup.")).toBeInTheDocument();
    expect(within(dialog).getByText(/applies and verifies the provider firewall before requesting power-on/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Selecting this option does not apply changes/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/Hivra does not request or manage a provider firewall/)).not.toBeInTheDocument();
    expect(within(dialog).getByRole("checkbox", { name: /I approve this observed configuration/ })).not.toBeChecked();
    expect(within(dialog).getByRole("button", { name: "Create server and start billing" })).toBeDisabled();
    expect(createHetznerCloudCapacity).not.toHaveBeenCalled();

    fireEvent.click(preparation);
    expect(within(dialog).getByText(/Hivra does not request or manage a provider firewall/)).toBeInTheDocument();
    expect(within(dialog).queryByText("Guided setup checks the firewall before startup.")).not.toBeInTheDocument();
    expect(createHetznerCloudCapacity).not.toHaveBeenCalled();
  });

  it("does not promise guided firewall setup for an unsupported system image", async () => {
    (listInfrastructureConnections as jest.Mock).mockResolvedValue([HETZNER_CONNECTION]);
    (getHetznerCloudInventory as jest.Mock).mockResolvedValue([]);
    render(<InfrastructureConnectionsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Create cloud server" }));
    const dialog = await screen.findByRole("dialog", { name: "Choose a Hetzner server" });
    await within(dialog).findByLabelText("Server size");
    fireEvent.click(within(dialog).getByRole("button", { name: "Review current rates" }));
    const preparation = await within(dialog).findByRole("checkbox", { name: /Enable guided computer setup/ });
    expect(preparation).toBeDisabled();
    expect(preparation).not.toBeChecked();
    expect(within(dialog).queryByText("Guided setup checks the firewall before startup.")).not.toBeInTheDocument();
    expect(within(dialog).getByText(/Hivra does not request or manage a provider firewall/)).toBeInTheDocument();
    expect(createHetznerCloudCapacity).not.toHaveBeenCalled();
  });

  it("offers the available 8 GiB USD desktop host while retaining explicit price review", async () => {
    const catalog = JSON.parse(JSON.stringify(HETZNER_CATALOG));
    catalog.currency = "USD";
    catalog.simpleModePolicy = HETZNER_CLOUD_SIMPLE_MODE_POLICY;
    Object.assign(catalog.serverTypes[0],{name:"cpx32",cores:4,memoryGb:8});
    catalog.serverTypes[0].prices[0].monthly = {currency:"USD",net:"41.99",gross:"50.388"};
    (getHetznerCloudOfferCatalog as jest.Mock).mockResolvedValue(catalog);
    (listInfrastructureConnections as jest.Mock).mockResolvedValue([HETZNER_CONNECTION]);
    (getHetznerCloudInventory as jest.Mock).mockResolvedValue([]);
    render(<InfrastructureConnectionsPage />);
    fireEvent.click(await screen.findByRole("button",{name:"Create cloud server"}));
    const dialog = await screen.findByRole("dialog",{name:"Choose a Hetzner server"});
    expect(await within(dialog).findByRole("option",{name:/cpx32.*8 GB/})).toBeInTheDocument();
    expect(within(dialog).getByRole("button",{name:"Review current rates"})).toBeEnabled();
    expect(createHetznerCloudCapacity).not.toHaveBeenCalled();
  });

  it("defaults to the cheapest policy-eligible offer instead of provider list order", async () => {
    const expensive = {
      ...HETZNER_CATALOG.serverTypes[0],
      id: 88,
      name: "cx-expensive",
      cores: 8,
      memoryGb: 16,
      diskGb: 160,
      prices: [{
        ...HETZNER_CATALOG.serverTypes[0].prices[0],
        monthly: { currency: "EUR", net: "20.0000", gross: "23.8000" },
        hourly: { currency: "EUR", net: "0.0320", gross: "0.0381" },
      }],
    };
    const tooSmall = {
      ...HETZNER_CATALOG.serverTypes[0],
      id: 11,
      name: "cx-small",
      cores: 1,
      memoryGb: 2,
      prices: [{
        ...HETZNER_CATALOG.serverTypes[0].prices[0],
        monthly: { currency: "EUR", net: "1.0000", gross: "1.1900" },
        hourly: { currency: "EUR", net: "0.0020", gross: "0.0024" },
      }],
    };
    (listInfrastructureConnections as jest.Mock).mockResolvedValue([HETZNER_CONNECTION]);
    (getHetznerCloudInventory as jest.Mock).mockResolvedValue([]);
    (getHetznerCloudOfferCatalog as jest.Mock).mockResolvedValue({
      ...HETZNER_CATALOG,
      serverTypes: [expensive, tooSmall, HETZNER_CATALOG.serverTypes[0]],
    });
    render(<InfrastructureConnectionsPage />);

    const projectHeading = await screen.findByRole("heading", { name: "Personal cloud" });
    const projectCard = projectHeading.closest("article") as HTMLElement;
    fireEvent.click(within(projectCard).getByRole("button", { name: "Create cloud server" }));

    const dialog = await screen.findByRole("dialog", { name: "Choose a Hetzner server" });
    const serverType = within(dialog).getByLabelText("Server size");
    expect(serverType).toHaveValue("22");
    expect(within(serverType).queryByRole("option", { name: /cx-small/i })).not.toBeInTheDocument();
    expect(within(serverType).getByRole("option", { name: /cx-expensive/i })).toBeInTheDocument();
  });

  it("routes existing and manual-server choices into the current secure SSH wizard", async () => {
    render(<InfrastructureConnectionsPage />);

    const chooser = await screen.findByRole("region", {
      name: "How would you like to add infrastructure?",
    });
    fireEvent.click(within(chooser).getByRole("button", { name: /Choose my machine/i }));
    fireEvent.click(within(chooser).getByRole("button", { name: /^Remote server/i }));
    fireEvent.click(within(chooser).getByRole("button", { name: /Connect existing host/i }));

    const dialog = screen.getByRole("dialog", { name: "Connect a host" });
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText("Read-only inspection first")).toBeInTheDocument();
    const settingsSummary = within(dialog).getByText("SSH settings").closest("summary");
    const settings = settingsSummary?.closest("details");
    expect(settings).not.toHaveAttribute("open");
    expect(within(dialog).getByText(/root · port 22/i)).toBeInTheDocument();

    fireEvent.click(settingsSummary as HTMLElement);
    expect(settings).toHaveAttribute("open");
    expect(within(dialog).getByLabelText("SSH user")).toHaveValue("root");
    expect(within(dialog).getByLabelText("Port")).toHaveValue(22);

    fireEvent.click(within(dialog).getByRole("button", { name: "Close infrastructure setup" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("keeps creation blocked and explains how to replace a read-only project token", async () => {
    (listInfrastructureConnections as jest.Mock).mockResolvedValue([HETZNER_CONNECTION]);
    (getHetznerCloudInventory as jest.Mock).mockResolvedValue([]);
    (createHetznerCloudCapacity as jest.Mock).mockRejectedValue(
      new InfrastructureApiError(
        "The connected token cannot create servers.",
        403,
        "token_read_only",
      ),
    );
    render(<InfrastructureConnectionsPage />);

    const projectHeading = await screen.findByRole("heading", { name: "Personal cloud" });
    const projectCard = projectHeading.closest("article") as HTMLElement;
    const createCapacity = within(projectCard).getByRole("button", { name: "Create cloud server" });
    fireEvent.click(createCapacity);

    const dialog = await screen.findByRole("dialog", { name: "Choose a Hetzner server" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Review current rates" }));
    const confirmation = await within(dialog).findByRole("checkbox", {
      name: /I approve this observed configuration/i,
    });
    fireEvent.click(confirmation);
    fireEvent.click(within(dialog).getByRole("button", {
      name: "Create server and start billing",
    }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      /reconnect it with a Read & Write project token/i,
    );
    expect(within(dialog).queryByText(/Created, powered off/i)).not.toBeInTheDocument();
  });

  it("requires legacy inventory credentials to reconnect before any in-app creation", async () => {
    (listInfrastructureConnections as jest.Mock).mockResolvedValue([HETZNER_CONNECTION]);
    (getHetznerCloudInventory as jest.Mock).mockResolvedValue([HETZNER_SERVER]);
    (quoteHetznerCloudCapacity as jest.Mock).mockRejectedValue(
      new InfrastructureApiError(
        "Reconnect this legacy project credential before creating capacity.",
        422,
        "credential_reconnect_required",
      ),
    );
    render(<InfrastructureConnectionsPage />);

    const projectHeading = await screen.findByRole("heading", { name: "Personal cloud" });
    const projectCard = projectHeading.closest("article") as HTMLElement;
    fireEvent.click(within(projectCard).getByRole("button", { name: "Create cloud server" }));
    const dialog = await screen.findByRole("dialog", { name: "Choose a Hetzner server" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Review current rates" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      /Disconnect and reconnect this Hetzner project.*before in-app server creation/i,
    );
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      /Existing read-only inventory may still work/i,
    );
    expect(createHetznerCloudCapacity).not.toHaveBeenCalled();
  });

  it("distinguishes Hivra's active price-review limit from Hetzner rate limiting", async () => {
    (listInfrastructureConnections as jest.Mock).mockResolvedValue([HETZNER_CONNECTION]);
    (getHetznerCloudInventory as jest.Mock).mockResolvedValue([]);
    (quoteHetznerCloudCapacity as jest.Mock).mockRejectedValue(
      new InfrastructureApiError(
        "This account has too many unclaimed capacity quotes.",
        429,
        "quote_rate_limited",
      ),
    );
    render(<InfrastructureConnectionsPage />);

    const projectHeading = await screen.findByRole("heading", { name: "Personal cloud" });
    const projectCard = projectHeading.closest("article") as HTMLElement;
    fireEvent.click(within(projectCard).getByRole("button", { name: "Create cloud server" }));
    const dialog = await screen.findByRole("dialog", { name: "Choose a Hetzner server" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Review current rates" }));

    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent(
      "Too many active price reviews; wait for one to expire or use an existing review.",
    );
    expect(alert).not.toHaveTextContent(/Hetzner is rate limiting/i);
    expect(createHetznerCloudCapacity).not.toHaveBeenCalled();
  });

  it("explains the one-claim Canary spend guard without suggesting a reconnect bypass", async () => {
    (listInfrastructureConnections as jest.Mock).mockResolvedValue([HETZNER_CONNECTION]);
    (getHetznerCloudInventory as jest.Mock).mockResolvedValue([]);
    (createHetznerCloudCapacity as jest.Mock).mockRejectedValue(
      new InfrastructureApiError(
        "This account already has a non-rejected capacity order.",
        409,
        "canary_capacity_limit",
      ),
    );
    render(<InfrastructureConnectionsPage />);

    const projectHeading = await screen.findByRole("heading", { name: "Personal cloud" });
    const projectCard = projectHeading.closest("article") as HTMLElement;
    fireEvent.click(within(projectCard).getByRole("button", { name: "Create cloud server" }));
    const dialog = await screen.findByRole("dialog", { name: "Choose a Hetzner server" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Review current rates" }));
    fireEvent.click(await within(dialog).findByRole("checkbox", {
      name: /I approve this observed configuration/i,
    }));
    fireEvent.click(within(dialog).getByRole("button", {
      name: "Create server and start billing",
    }));

    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent(/one across all Hetzner connections/i);
    expect(alert).toHaveTextContent(
      /deleting the server directly in Hetzner does not automatically free this slot/i,
    );
    expect(alert).toHaveTextContent(/Use Remove created server on the original project/i);
    expect(alert).toHaveTextContent(/Older or unresolved launches require manual review/i);
    expect(alert).toHaveTextContent(/additional simultaneous capacity is not supported/i);
  });

  it("shows callback rejection as an unstarted purchase, not a stuck recovery", async () => {
    (listInfrastructureConnections as jest.Mock).mockResolvedValue([HETZNER_CONNECTION]);
    (getHetznerCloudInventory as jest.Mock).mockResolvedValue([]);
    (createHetznerCloudCapacity as jest.Mock).mockRejectedValue(new InfrastructureApiError(
      "This attempt did not request a new server. The operator needs to check public callback routing.",
      503, "first_boot_callback_unreachable",
    ));
    render(<InfrastructureConnectionsPage />);
    const card = (await screen.findByRole("heading", { name: "Personal cloud" })).closest("article") as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: "Create cloud server" }));
    const dialog = await screen.findByRole("dialog", { name: "Choose a Hetzner server" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Review current rates" }));
    fireEvent.click(await within(dialog).findByRole("checkbox", { name: /I approve this observed configuration/i }));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /Enable guided computer setup/i }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Create server and start billing" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("This attempt did not request a new server");
    expect(within(dialog).getByRole("alert").compareDocumentPosition(
      within(dialog).getByLabelText("Server size"),
    ) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(dialog).getByRole("heading", { name: "Choose a Hetzner server" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Review current rates" })).toBeEnabled();
    expect(within(dialog).queryByRole("button", { name: /Check.*request/i })).not.toBeInTheDocument();
    expect(createHetznerCloudCapacity).toHaveBeenCalledTimes(1);
  });

  it("uses authoritative slot evidence when a rejected request retained a provider resource", async () => {
    (listInfrastructureConnections as jest.Mock).mockResolvedValue([HETZNER_CONNECTION]);
    (getHetznerCloudInventory as jest.Mock).mockResolvedValue([]);
    (createHetznerCloudCapacity as jest.Mock).mockResolvedValue({
      operation: {
        ...HETZNER_OPERATION,
        status: "provider_rejected",
        providerServerId: null,
        providerActionId: null,
        providerActionCommand: null,
        providerActionStatus: null,
        observedServerStatus: null,
        providerObservedAt: null,
        errorCode: "provider_resource_limit",
        createdPoweredOff: false,
      },
      inventory: [],
    });
    render(<InfrastructureConnectionsPage />);

    const projectHeading = await screen.findByRole("heading", { name: "Personal cloud" });
    const projectCard = projectHeading.closest("article") as HTMLElement;
    fireEvent.click(within(projectCard).getByRole("button", { name: "Create cloud server" }));
    const dialog = await screen.findByRole("dialog", { name: "Choose a Hetzner server" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Review current rates" }));
    fireEvent.click(await within(dialog).findByRole("checkbox", {
      name: /I approve this observed configuration/i,
    }));
    fireEvent.click(within(dialog).getByRole("button", {
      name: "Create server and start billing",
    }));

    expect(await within(dialog).findByText(
      /This request uses the account's one Canary capacity slot/i,
    )).toBeInTheDocument();
    expect(within(dialog).getByText(/Inspect retained Hetzner resources/i))
      .toBeInTheDocument();
    expect(within(dialog).getByText(
      /Hivra project SSH key and separately billable Primary IPv4 or IPv6 resources/i,
    )).toBeInTheDocument();
    expect(within(dialog).getByText(/Hivra does not auto-delete them in v1/i))
      .toBeInTheDocument();
  });

  it("allows retry only when authoritative evidence says a rejected request retained no resource", async () => {
    (listInfrastructureConnections as jest.Mock).mockResolvedValue([HETZNER_CONNECTION]);
    (getHetznerCloudInventory as jest.Mock).mockResolvedValue([]);
    (createHetznerCloudCapacity as jest.Mock).mockResolvedValue({
      operation: {
        ...HETZNER_OPERATION,
        status: "provider_rejected",
        providerServerId: null,
        providerActionId: null,
        providerActionCommand: null,
        providerActionStatus: null,
        observedServerStatus: null,
        providerObservedAt: null,
        errorCode: "provider_resource_limit",
        canarySlotHeld: false,
        createdPoweredOff: false,
      },
      inventory: [],
    });
    render(<InfrastructureConnectionsPage />);

    const projectHeading = await screen.findByRole("heading", { name: "Personal cloud" });
    const projectCard = projectHeading.closest("article") as HTMLElement;
    fireEvent.click(within(projectCard).getByRole("button", { name: "Create cloud server" }));
    const dialog = await screen.findByRole("dialog", { name: "Choose a Hetzner server" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Review current rates" }));
    fireEvent.click(await within(dialog).findByRole("checkbox", {
      name: /I approve this observed configuration/i,
    }));
    fireEvent.click(within(dialog).getByRole("button", {
      name: "Create server and start billing",
    }));

    expect(await within(dialog).findByText(
      /This request did not retain the Canary capacity slot/i,
    )).toBeInTheDocument();
    expect(within(dialog).getByText(/You can retry after fixing the reported cause/i))
      .toBeInTheDocument();
    expect(within(dialog).queryByText(/Inspect retained Hetzner resources/i))
      .not.toBeInTheDocument();
  });

  it("verifies external cleanup explicitly, preserves ambiguity, disables replay and clears only browser recovery", async () => {
    (listInfrastructureConnections as jest.Mock).mockResolvedValue([HETZNER_CONNECTION]);
    (createHetznerCloudCapacity as jest.Mock).mockResolvedValue({operation:{...HETZNER_OPERATION,id:HETZNER_QUOTE.id,status:"ambiguous",createdPoweredOff:false},inventory:[HETZNER_OFF_SERVER]});
    (verifyExternalCleanup as jest.Mock).mockResolvedValue({resolutionId:HETZNER_OPERATION.id,resolvedAt:"2026-08-28T19:00:00Z"});
    render(<InfrastructureConnectionsPage />);
    const card=(await screen.findByRole("heading",{name:"Personal cloud"})).closest("article")!;
    fireEvent.click(within(card).getByRole("button",{name:"Create cloud server"}));
    const dialog=await screen.findByRole("dialog",{name:"Choose a Hetzner server"});
    fireEvent.click(within(dialog).getByRole("button",{name:"Review current rates"}));
    fireEvent.click(await within(dialog).findByRole("checkbox",{name:/I approve this observed configuration/i}));
    fireEvent.click(within(dialog).getByRole("button",{name:"Create server and start billing"}));
    const verify=await within(dialog).findByRole("button",{name:"Verify resources I removed in Hetzner"});
    expect(verifyExternalCleanup).not.toHaveBeenCalled();
    dialog.scrollTop = 850;
    fireEvent.click(verify);
    expect(await within(dialog).findByRole("heading",{name:"External cleanup verified."})).toBeInTheDocument();
    expect(dialog.scrollTop).toBe(0);
    expect(within(dialog).getByText(/original creation outcome remains ambiguous/i)).toBeInTheDocument();
    expect(within(dialog).queryByRole("button",{name:"Check this request again"})).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/recorded no provider server/i)).not.toBeInTheDocument();
    expect(createHetznerCloudCapacity).toHaveBeenCalledTimes(1);
    expect(verifyExternalCleanup).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog).getByRole("button",{name:"Return to infrastructure"}));
    fireEvent.click(within(card).getByRole("button",{name:"Create cloud server"}));
    expect(await screen.findByRole("dialog",{name:"Choose a Hetzner server"})).toBeInTheDocument();
  });

  it("fences delayed external-cleanup callbacks after navigation and preserves a newer recovery request", async () => {
    let finish!: (value: {resolutionId:string;resolvedAt:string}) => void;
    (verifyExternalCleanup as jest.Mock).mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
    (createHetznerCloudCapacity as jest.Mock).mockResolvedValue({operation:{...HETZNER_OPERATION,id:HETZNER_QUOTE.id,status:"ambiguous",createdPoweredOff:false},inventory:[HETZNER_OFF_SERVER]});
    const onInventoryChanged=jest.fn(),onClose=jest.fn();
    const view=render(<HetznerCloudCapacityDialog connection={HETZNER_CONNECTION} onClose={onClose} onInventoryChanged={onInventoryChanged} />);
    const dialog=await screen.findByRole("dialog",{name:"Choose a Hetzner server"});
    fireEvent.click(await within(dialog).findByRole("button",{name:"Review current rates"}));
    fireEvent.click(await within(dialog).findByRole("checkbox",{name:/I approve this observed configuration/i}));
    fireEvent.click(within(dialog).getByRole("button",{name:"Create server and start billing"}));
    fireEvent.click(await within(dialog).findByRole("button",{name:"Verify resources I removed in Hetzner"}));
    expect(within(dialog).getByRole("button",{name:"Close Hetzner server setup"})).toBeDisabled();
    fireEvent.keyDown(document,{key:"Escape"});expect(onClose).not.toHaveBeenCalled();
    const storageKey=Object.keys(window.localStorage)[0];
    expect(storageKey).toBeDefined();
    view.unmount();onInventoryChanged.mockClear();
    const newer={...JSON.parse(window.localStorage.getItem(storageKey)!),quoteId:"11111111-1111-4111-8111-111111111111",idempotencyKey:"22222222-2222-4222-8222-222222222222"};
    window.localStorage.setItem(storageKey,JSON.stringify(newer));
    render(<HetznerCloudCapacityDialog connection={HETZNER_CONNECTION} onClose={jest.fn()} onInventoryChanged={jest.fn()} />);
    await act(async()=>finish({resolutionId:HETZNER_OPERATION.id,resolvedAt:"2026-08-28T19:00:00Z"}));
    expect(JSON.parse(window.localStorage.getItem(storageKey)!)).toEqual(newer);
    expect(onInventoryChanged).not.toHaveBeenCalled();
  });

  it("never enables billing from an expired quote even after confirmation", async () => {
    (listInfrastructureConnections as jest.Mock).mockResolvedValue([HETZNER_CONNECTION]);
    (getHetznerCloudInventory as jest.Mock).mockResolvedValue([]);
    (quoteHetznerCloudCapacity as jest.Mock).mockResolvedValue({
      ...HETZNER_QUOTE,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    render(<InfrastructureConnectionsPage />);

    const projectHeading = await screen.findByRole("heading", { name: "Personal cloud" });
    const projectCard = projectHeading.closest("article") as HTMLElement;
    fireEvent.click(within(projectCard).getByRole("button", { name: "Create cloud server" }));

    const dialog = await screen.findByRole("dialog", { name: "Choose a Hetzner server" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Review current rates" }));
    fireEvent.click(await within(dialog).findByRole("checkbox", {
      name: /I approve this observed configuration/i,
    }));

    expect(within(dialog).getByRole("button", {
      name: "Create server and start billing",
    })).toBeDisabled();
    expect(within(dialog).getByRole("alert")).toHaveTextContent(/rate observation has expired/i);
    expect(createHetznerCloudCapacity).not.toHaveBeenCalled();
  });

  it("fails closed before quoting when secure request identifiers are unavailable", async () => {
    (listInfrastructureConnections as jest.Mock).mockResolvedValue([HETZNER_CONNECTION]);
    (getHetznerCloudInventory as jest.Mock).mockResolvedValue([]);
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      configurable: true,
      value: undefined,
    });
    render(<InfrastructureConnectionsPage />);

    const projectHeading = await screen.findByRole("heading", { name: "Personal cloud" });
    const projectCard = projectHeading.closest("article") as HTMLElement;
    fireEvent.click(within(projectCard).getByRole("button", { name: "Create cloud server" }));

    const dialog = await screen.findByRole("dialog", { name: "Choose a Hetzner server" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Review current rates" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      /Secure request identifiers are unavailable/i,
    );
    expect(quoteHetznerCloudCapacity).not.toHaveBeenCalled();
    expect(createHetznerCloudCapacity).not.toHaveBeenCalled();
  });

  it("fails closed before the provider call when browser recovery storage is unavailable", async () => {
    (listInfrastructureConnections as jest.Mock).mockResolvedValue([HETZNER_CONNECTION]);
    (getHetznerCloudInventory as jest.Mock).mockResolvedValue([]);
    render(<InfrastructureConnectionsPage />);

    const projectHeading = await screen.findByRole("heading", { name: "Personal cloud" });
    const projectCard = projectHeading.closest("article") as HTMLElement;
    fireEvent.click(within(projectCard).getByRole("button", { name: "Create cloud server" }));
    const dialog = await screen.findByRole("dialog", { name: "Choose a Hetzner server" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Review current rates" }));
    fireEvent.click(await within(dialog).findByRole("checkbox", {
      name: /I approve this observed configuration/i,
    }));
    const setItem = jest.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
      throw new Error("Storage denied");
    });

    fireEvent.click(within(dialog).getByRole("button", {
      name: "Create server and start billing",
    }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      /could not save the non-secret recovery identifiers/i,
    );
    expect(createHetznerCloudCapacity).not.toHaveBeenCalled();
    setItem.mockRestore();
  });

  it("rechecks an ambiguous create with the same quote and idempotency key", async () => {
    (listInfrastructureConnections as jest.Mock).mockResolvedValue([HETZNER_CONNECTION]);
    (getHetznerCloudInventory as jest.Mock).mockResolvedValue([]);
    (createHetznerCloudCapacity as jest.Mock)
      .mockResolvedValueOnce({
        operation: {
          ...HETZNER_OPERATION,
          status: "ambiguous",
          providerActionCommand: null,
          providerActionStatus: null,
          observedServerStatus: null,
          providerObservedAt: null,
          createdPoweredOff: false,
        },
        inventory: [],
      })
      .mockResolvedValueOnce({ operation: HETZNER_OPERATION, inventory: [HETZNER_OFF_SERVER] });
    render(<InfrastructureConnectionsPage />);

    const projectHeading = await screen.findByRole("heading", { name: "Personal cloud" });
    const projectCard = projectHeading.closest("article") as HTMLElement;
    fireEvent.click(within(projectCard).getByRole("button", { name: "Create cloud server" }));
    const dialog = await screen.findByRole("dialog", { name: "Choose a Hetzner server" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Review current rates" }));
    fireEvent.click(await within(dialog).findByRole("checkbox", {
      name: /I approve this observed configuration/i,
    }));
    fireEvent.click(within(dialog).getByRole("button", {
      name: "Create server and start billing",
    }));

    expect(await within(dialog).findByRole("heading", {
      name: "Creation outcome needs reconciliation.",
    })).toBeInTheDocument();
    expect(within(dialog).getByText(/uses the account's one Canary capacity slot/i))
      .toBeInTheDocument();
    expect(within(dialog).getByText(/Inspect retained Hetzner resources/i))
      .toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Check this request again" }));

    expect(await within(dialog).findByRole("heading", {
      name: "Created, powered off, not prepared.",
    })).toBeInTheDocument();
    expect(createHetznerCloudCapacity).toHaveBeenCalledTimes(2);
    expect((createHetznerCloudCapacity as jest.Mock).mock.calls[0]).toEqual(
      (createHetznerCloudCapacity as jest.Mock).mock.calls[1],
    );
  });

  it.each(["running", "starting"] as const)(
    "shows an urgent manual power warning when Hetzner observes the server as %s",
    async (observedServerStatus) => {
      (listInfrastructureConnections as jest.Mock).mockResolvedValue([HETZNER_CONNECTION]);
      (getHetznerCloudInventory as jest.Mock).mockResolvedValue([]);
      (createHetznerCloudCapacity as jest.Mock).mockResolvedValue({
        operation: {
          ...HETZNER_OPERATION,
          status: "ambiguous",
          observedServerStatus,
          createdPoweredOff: false,
        },
        inventory: [],
      });
      render(<InfrastructureConnectionsPage />);

      const projectHeading = await screen.findByRole("heading", { name: "Personal cloud" });
      const projectCard = projectHeading.closest("article") as HTMLElement;
      fireEvent.click(within(projectCard).getByRole("button", { name: "Create cloud server" }));
      const dialog = await screen.findByRole("dialog", { name: "Choose a Hetzner server" });
      fireEvent.click(within(dialog).getByRole("button", { name: "Review current rates" }));
      fireEvent.click(await within(dialog).findByRole("checkbox", {
        name: /I approve this observed configuration/i,
      }));
      fireEvent.click(within(dialog).getByRole("button", {
        name: "Create server and start billing",
      }));

      const urgentWarning = await within(dialog).findByRole("alert");
      expect(urgentWarning).toHaveTextContent(/Server observed powered on/i);
      expect(urgentWarning).toHaveTextContent(
        new RegExp(`Hetzner reported this server as ${observedServerStatus}`, "i"),
      );
      expect(urgentWarning).toHaveTextContent(/did not authorize an agent launch/i);
      expect(urgentWarning).toHaveTextContent(/will not power the server off automatically/i);
      expect(urgentWarning).toHaveTextContent(/power it off if it should not be running/i);
      expect(within(urgentWarning).getByRole("link", { name: /Open Hetzner Console/i }))
        .toHaveAttribute("href", "https://console.hetzner.com/projects");
    },
  );

  it.each([false, true])("restores a lost-response request with its exact identifiers and setup consent (%s)", async prepare => {
    (listInfrastructureConnections as jest.Mock).mockResolvedValue([HETZNER_CONNECTION]);
    (getHetznerCloudInventory as jest.Mock).mockResolvedValue([]);
    if (prepare) mockPreparableHetznerOffer();
    (createHetznerCloudCapacity as jest.Mock)
      .mockRejectedValueOnce(new Error("The provider response was lost."))
      .mockResolvedValueOnce({ operation: HETZNER_OPERATION, inventory: [HETZNER_OFF_SERVER] });

    const firstRender = render(<InfrastructureConnectionsPage />);
    let projectHeading = await screen.findByRole("heading", { name: "Personal cloud" });
    let projectCard = projectHeading.closest("article") as HTMLElement;
    fireEvent.click(within(projectCard).getByRole("button", { name: "Create cloud server" }));
    let dialog = await screen.findByRole("dialog", { name: "Choose a Hetzner server" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Review current rates" }));
    fireEvent.click(await within(dialog).findByRole("checkbox", {
      name: /I approve this observed configuration/i,
    }));
    if (prepare) fireEvent.click(within(dialog).getByRole("checkbox", { name: /Enable guided computer setup/i }));
    fireEvent.click(within(dialog).getByRole("button", {
      name: "Create server and start billing",
    }));

    expect(await screen.findByRole("dialog", { name: "Recover pending request" }))
      .toHaveTextContent(/no success, failure, or agent readiness is assumed/i);
    expect(window.localStorage.length).toBe(1);
    const recoveryKey = window.localStorage.key(0);
    expect(recoveryKey).not.toBeNull();
    const recoveryRecord = JSON.parse(window.localStorage.getItem(recoveryKey as string) as string);
    expect(Object.keys(recoveryRecord).sort()).toEqual([
      "connectionId",
      "idempotencyKey",
      "prepare",
      "quoteId",
      "version",
    ]);
    expect(recoveryRecord).toMatchObject({ version: 2, prepare });
    expect(JSON.stringify(recoveryRecord)).not.toContain("secure-project-token");
    firstRender.unmount();

    render(<InfrastructureConnectionsPage />);
    projectHeading = await screen.findByRole("heading", { name: "Personal cloud" });
    projectCard = projectHeading.closest("article") as HTMLElement;
    fireEvent.click(within(projectCard).getByRole("button", { name: "Create cloud server" }));
    dialog = await screen.findByRole("dialog", { name: "Recover pending request" });

    expect(createHetznerCloudCapacity).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "Check saved request" }));
    expect(await within(dialog).findByRole("heading", {
      name: "Created, powered off, not prepared.",
    })).toBeInTheDocument();
    expect(createHetznerCloudCapacity).toHaveBeenCalledTimes(2);
    expect((createHetznerCloudCapacity as jest.Mock).mock.calls[0]).toEqual(
      (createHetznerCloudCapacity as jest.Mock).mock.calls[1],
    );
    expect(quoteHetznerCloudCapacity).toHaveBeenCalledTimes(1);
    expect(window.localStorage.length).toBe(0);
    if (prepare) {
      expect(within(dialog).getByRole("button", { name: "Continue computer setup" })).toBeInTheDocument();
      expect((createHetznerCloudCapacity as jest.Mock).mock.calls[0][1]).toHaveProperty(
        "preparationConfirmation", "Prepare this computer for agent launch",
      );
    } else {
      expect((createHetznerCloudCapacity as jest.Mock).mock.calls[0][1]).not.toHaveProperty("preparationConfirmation");
    }
  });

  it("restores focus to a populated project card after server setup closes", async () => {
    (listInfrastructureConnections as jest.Mock).mockResolvedValue([HETZNER_CONNECTION]);
    (getHetznerCloudInventory as jest.Mock).mockResolvedValue([]);
    render(<InfrastructureConnectionsPage />);

    const projectHeading = await screen.findByRole("heading", { name: "Personal cloud" });
    const projectCard = projectHeading.closest("article") as HTMLElement;
    const createCapacity = within(projectCard).getByRole("button", { name: "Create cloud server" });
    createCapacity.focus();
    fireEvent.click(createCapacity);

    const dialog = await screen.findByRole("dialog", { name: "Choose a Hetzner server" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Close Hetzner server setup" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(createCapacity).toHaveFocus();
  });

  it("restores the selected cloud step and trigger focus when its connection dialog closes", async () => {
    (listInfrastructureConnections as jest.Mock).mockResolvedValue([HETZNER_CONNECTION]);
    (getHetznerCloudInventory as jest.Mock).mockResolvedValue([HETZNER_SERVER]);
    render(<InfrastructureConnectionsPage />);

    const addCapacity = await screen.findByRole("button", { name: "Add capacity" });
    fireEvent.click(addCapacity);
    const chooser = screen.getByRole("region", { name: "How would you like to add infrastructure?" });
    fireEvent.click(within(chooser).getByRole("button", { name: /Choose cloud provider/i }));
    const openDialog = within(chooser).getByRole("button", { name: /Start with Hetzner/i });
    openDialog.focus();
    fireEvent.click(openDialog);

    const dialog = screen.getByRole("dialog", { name: "Connect Hetzner Cloud" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Close Hetzner Cloud setup" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(openDialog).toHaveFocus();
    expect(screen.getByRole("heading", { name: "Which cloud account do you use?" })).toBeInTheDocument();
  });

  it("shows a failed Hetzner refresh as stale evidence instead of connected health", async () => {
    (listInfrastructureConnections as jest.Mock).mockResolvedValue([HETZNER_CONNECTION]);
    (getHetznerCloudInventory as jest.Mock).mockResolvedValue([HETZNER_SERVER]);
    (refreshHetznerCloudInventory as jest.Mock).mockRejectedValue(
      new InfrastructureApiError(
        "Hetzner Cloud rejected this project API token.",
        422,
        "invalid_credentials",
      ),
    );
    render(<InfrastructureConnectionsPage />);

    const projectHeading = await screen.findByRole("heading", { name: "Personal cloud" });
    const projectCard = projectHeading.closest("article") as HTMLElement;
    fireEvent.click(within(projectCard).getByRole("button", { name: "Sync servers" }));

    expect(await within(projectCard).findByText("Sync issue")).toBeInTheDocument();
    expect(within(projectCard).getByRole("alert")).toHaveTextContent(
      /Showing the last successful server snapshot/i,
    );
    expect(within(projectCard).queryByText(/^Connected$/)).not.toBeInTheDocument();
  });

  it("keeps explicit Hetzner disconnect available while warning that Hivra loses reconciliation", async () => {
    (listInfrastructureConnections as jest.Mock).mockResolvedValue([HETZNER_CONNECTION]);
    (getHetznerCloudInventory as jest.Mock).mockResolvedValue([HETZNER_OFF_SERVER]);
    render(<InfrastructureConnectionsPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Disconnect Personal cloud" }));
    const dialog = screen.getByRole("alertdialog", { name: "Disconnect Personal cloud?" });
    expect(dialog).toHaveTextContent(/permanently removes Hivra’s stored project token/i);
    expect(dialog).toHaveTextContent(/only saved generated SSH private key/i);
    expect(dialog).toHaveTextContent(
      /Hivra cannot reconcile an ambiguous request or clean up its provider resources/i,
    );
    expect(dialog).toHaveTextContent(/does not delete the provider server, Primary IPs.*public key/i);
    expect(dialog).toHaveTextContent(/billing continues/i);
    expect(dialog).toHaveTextContent(/Hetzner rescue mode or a rebuild/i);
    expect(within(dialog).getByRole("button", { name: "Remove connection" })).toBeEnabled();
  });

  it("offers a labelled project disconnect that opens the same confirmation", async () => {
    (listInfrastructureConnections as jest.Mock).mockResolvedValue([HETZNER_CONNECTION]);
    (getHetznerCloudInventory as jest.Mock).mockResolvedValue([HETZNER_OFF_SERVER]);
    render(<InfrastructureConnectionsPage />);

    const card = (await screen.findByRole("heading", { name: "Personal cloud" })).closest("article") as HTMLElement;
    expect(within(card).getByRole("button", { name: "Remove created server" })).toBeInTheDocument();
    // The accessible name keeps the visible label and names the connection it removes.
    const labelled = within(card).getByRole("button", { name: "Disconnect project Personal cloud" });
    expect(labelled).toHaveTextContent("Disconnect project");
    fireEvent.click(labelled);
    expect(screen.getByRole("alertdialog", { name: "Disconnect Personal cloud?" })).toBeInTheDocument();
    expect(deleteInfrastructureConnection).not.toHaveBeenCalled();
  });

  it.each([
    ["Disconnect host Linux host", "alertdialog", "Keep connection"],
    ["Edit", "dialog", "Close infrastructure setup"],
  ])("returns focus to the card's %s control when its dialog closes", async (trigger, role, closeName) => {
    (listInfrastructureConnections as jest.Mock).mockResolvedValue([PENDING_HOST_CONNECTION]);
    render(<InfrastructureConnectionsPage />);

    const card = (await screen.findByRole("heading", { name: "Linux host" })).closest("article") as HTMLElement;
    const opener = within(card).getByRole("button", { name: trigger });
    opener.focus();
    fireEvent.click(opener);

    const dialog = await screen.findByRole(role as "dialog" | "alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: closeName }));

    await waitFor(() => expect(screen.queryByRole(role as "dialog" | "alertdialog")).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
    expect(screen.getByRole("button", { name: "Add capacity" })).not.toHaveFocus();
  });

  it("requires typed confirmation before force-forgetting an idle ambiguous Hetzner connection", async () => {
    (listInfrastructureConnections as jest.Mock).mockResolvedValue([HETZNER_CONNECTION]);
    (getHetznerCloudInventory as jest.Mock).mockResolvedValue([HETZNER_OFF_SERVER]);
    (deleteInfrastructureConnection as jest.Mock).mockRejectedValue(
      new InfrastructureApiError(
        "Normal disconnect is blocked because provider cleanup is unresolved.",
        409,
        "capacity_force_forget_required",
      ),
    );
    render(<InfrastructureConnectionsPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Disconnect Personal cloud" }));
    fireEvent.click(within(
      screen.getByRole("alertdialog", { name: "Disconnect Personal cloud?" }),
    ).getByRole("button", { name: "Remove connection" }));

    const dialog = await screen.findByRole("alertdialog", {
      name: "Forget Hivra access to Personal cloud?",
    });
    expect(dialog).toHaveTextContent(/provider resources and billing may remain/i);
    expect(dialog).toHaveTextContent(/server, Primary IPv4\/IPv6, and Hivra-created SSH key/i);
    expect(dialog).toHaveTextContent(/permanently wipes Hivra’s stored project token and sole private key/i);
    expect(dialog).toHaveTextContent(/does not free this account’s one Canary capacity slot/i);
    expect(dialog).toHaveTextContent(/does not cancel or delete anything at Hetzner/i);

    const forceButton = within(dialog).getByRole("button", {
      name: "Forget Hivra access only",
    });
    const confirmation = within(dialog).getByLabelText("Type the exact confirmation");
    expect(confirmation).toHaveAttribute("autocapitalize", "characters");
    expect(confirmation).toHaveAttribute("autocorrect", "off");
    expect(confirmation).toHaveAttribute("spellcheck", "false");
    expect(forceButton).toBeDisabled();
    expect(within(dialog).queryByText("Doesn't match yet")).not.toBeInTheDocument();
    fireEvent.change(confirmation, { target: { value: "FORGET" } });
    expect(forceButton).toBeDisabled();
    expect(confirmation).toHaveAccessibleDescription(/Doesn't match yet/);
    fireEvent.change(confirmation, {
      target: { value: HETZNER_CLOUD_FORCE_FORGET_CONFIRMATION },
    });
    expect(forceButton).toBeEnabled();
    expect(within(dialog).queryByText("Doesn't match yet")).not.toBeInTheDocument();
    fireEvent.click(forceButton);

    await waitFor(() => expect(forceForgetHetznerCloudConnection).toHaveBeenCalledWith(
      HETZNER_CONNECTION.id,
      { confirmation: HETZNER_CLOUD_FORCE_FORGET_CONFIRMATION },
    ));
    expect(await screen.findByRole("status")).toHaveTextContent(/No provider cleanup was performed/i);
    expect(screen.getByRole("status")).toHaveTextContent(/Canary capacity slot stays held/i);
    expect(screen.queryByRole("heading", { name: "Personal cloud" })).not.toBeInTheDocument();
  });

  it("does not expose force-forget while a Hetzner capacity operation is busy", async () => {
    (listInfrastructureConnections as jest.Mock).mockResolvedValue([HETZNER_CONNECTION]);
    (getHetznerCloudInventory as jest.Mock).mockResolvedValue([]);
    (deleteInfrastructureConnection as jest.Mock).mockRejectedValue(
      new InfrastructureApiError(
        "A capacity request is still being reconciled.",
        409,
        "capacity_busy",
      ),
    );
    render(<InfrastructureConnectionsPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Disconnect Personal cloud" }));
    fireEvent.click(within(
      screen.getByRole("alertdialog", { name: "Disconnect Personal cloud?" }),
    ).getByRole("button", { name: "Remove connection" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/still being reconciled/i);
    expect(screen.queryByRole("alertdialog", {
      name: "Forget Hivra access to Personal cloud?",
    })).not.toBeInTheDocument();
    expect(forceForgetHetznerCloudConnection).not.toHaveBeenCalled();
  });

  it("keeps the force-forget dialog open if the operation becomes busy again", async () => {
    (listInfrastructureConnections as jest.Mock).mockResolvedValue([HETZNER_CONNECTION]);
    (getHetznerCloudInventory as jest.Mock).mockResolvedValue([]);
    (deleteInfrastructureConnection as jest.Mock).mockRejectedValue(
      new InfrastructureApiError(
        "Normal disconnect is blocked because provider cleanup is unresolved.",
        409,
        "capacity_force_forget_required",
      ),
    );
    (forceForgetHetznerCloudConnection as jest.Mock).mockRejectedValue(
      new InfrastructureApiError(
        "The capacity request resumed reconciliation. Try again after it becomes idle.",
        409,
        "capacity_busy",
      ),
    );
    render(<InfrastructureConnectionsPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Disconnect Personal cloud" }));
    fireEvent.click(within(
      screen.getByRole("alertdialog", { name: "Disconnect Personal cloud?" }),
    ).getByRole("button", { name: "Remove connection" }));
    const dialog = await screen.findByRole("alertdialog", {
      name: "Forget Hivra access to Personal cloud?",
    });
    fireEvent.change(within(dialog).getByLabelText("Type the exact confirmation"), {
      target: { value: HETZNER_CLOUD_FORCE_FORGET_CONFIRMATION },
    });
    fireEvent.click(within(dialog).getByRole("button", {
      name: "Forget Hivra access only",
    }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/resumed reconciliation/i);
    expect(screen.getByRole("alertdialog", {
      name: "Forget Hivra access to Personal cloud?",
    })).toBeInTheDocument();
  });

  it.each([
    { trigger: "Start with Hetzner", title: "Connect Hetzner Cloud" },
    { trigger: "Connect existing host", title: "Connect a host" },
  ])("pins $title inside the dashboard scrollport", async ({ trigger, title }) => {
    const { container, unmount } = render(<InfrastructureConnectionsPage />);
    const chooser = await screen.findByRole("region", { name: "How would you like to add infrastructure?" });
    if (trigger === "Start with Hetzner") {
      fireEvent.click(within(chooser).getByRole("button", { name: /Choose cloud provider/i }));
    } else {
      fireEvent.click(within(chooser).getByRole("button", { name: /Choose my machine/i }));
      fireEvent.click(within(chooser).getByRole("button", { name: /^Remote server/i }));
    }
    fireEvent.click(within(chooser).getByRole("button", { name: trigger }));

    const dialog = await screen.findByRole("dialog", { name: title });
    const anchor = dialog.closest("[data-infrastructure-modal-anchor]");
    expect(anchor).not.toBeNull();
    expect(container).toContainElement(dialog);
    expect(container.querySelector("main")).toHaveAttribute("inert");
    expect(dialog.closest("[inert]")).toBeNull();

    unmount();
    expect(anchor).not.toBeInTheDocument();
  });
});
