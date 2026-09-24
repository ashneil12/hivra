/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { HetznerCloudCapacityDialog } from "../HetznerCloudCapacityDialog";
import { HetznerCloudConnectionCard } from "../HetznerCloudConnectionCard";
import { HetznerCloudConnectionDialog } from "../HetznerCloudConnectionDialog";

import { InfrastructureConnectionsPage } from "../InfrastructureConnectionsPage";
import {
  advanceProviderComputerSetup,
  checkGvisorConnection,
  prepareGvisorConnection,
  connectHetznerCloudProject,
  createHetznerCloudCapacity,
  createInfrastructureConnection,
  deleteInfrastructureConnection,
  discoverInfrastructureHost,
  forceForgetHetznerCloudConnection,
  getHetznerCloudCapacitySlot,
  getHetznerCloudInventory,
  getHetznerCloudOfferCatalog,
  InfrastructureApiError,
  listInfrastructureConnections,
  listInfrastructureTargets,
  listProviderComputerSetupEvidence,
  listProviderComputerSetups,
  preflightInfrastructureConnection,
  prepareInfrastructureConnection,
  quoteHetznerCloudCapacity,
  refreshHetznerCloudInventory,
  replaceHetznerCloudToken,
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
  advanceProviderComputerSetup: jest.fn(),
  checkGvisorConnection: jest.fn(),
  prepareGvisorConnection: jest.fn(),
  createInfrastructureConnection: jest.fn(),
  connectHetznerCloudProject: jest.fn(),
  createHetznerCloudCapacity: jest.fn(),
  deleteInfrastructureConnection: jest.fn(),
  discoverInfrastructureHost: jest.fn(),
  getHetznerCloudInventory: jest.fn(),
  getHetznerCloudOfferCatalog: jest.fn(),
  forceForgetHetznerCloudConnection: jest.fn(),
  getHetznerCloudCapacitySlot: jest.fn(),
  listInfrastructureConnections: jest.fn(),
  listInfrastructureTargets: jest.fn(),
  listProviderComputerSetupEvidence: jest.fn(),
  listProviderComputerSetups: jest.fn(),
  preflightInfrastructureConnection: jest.fn(),
  prepareInfrastructureConnection: jest.fn(),
  quoteHetznerCloudCapacity: jest.fn(),
  refreshHetznerCloudInventory: jest.fn(),
  replaceHetznerCloudToken: jest.fn(),
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
  // A gVisor host can launch only within 15 minutes of its last strict check,
  // so a ready fixture was checked a minute before the suite runs.
  lastPreflightAt: new Date(Date.now() - 60_000).toISOString(),
  lastErrorCode: null,
  createdAt: "2026-09-15T12:00:00.000Z",
  updatedAt: "2026-09-15T12:00:00.000Z",
};

/** The same host, last checked long enough ago that a launch would be refused. */
const STALE_GVISOR_TARGET: DeploymentTargetDto = {
  ...READY_GVISOR_TARGET,
  lastPreflightAt: "2026-09-15T12:00:00.000Z",
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
    name: "ubuntu-22.04",
    description: "Ubuntu 22.04",
    architecture: "x86" as const,
    osFlavor: "ubuntu",
    osVersion: "22.04",
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
    name: "ubuntu-22.04",
    description: "Ubuntu 22.04",
    architecture: "x86" as const,
    osFlavor: "ubuntu" as const,
    osVersion: "22.04",
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

const HETZNER_UNSUPPORTED_IMAGE = {
  id: 101,
  name: "ubuntu-24.04",
  description: "Ubuntu 24.04",
  architecture: "x86" as const,
  osFlavor: "ubuntu",
  osVersion: "24.04",
  deprecated: false,
};

/** The setup view Hivra saves for a freshly created, not yet started server. */
function hetznerSetupView(patch: Record<string, unknown> = {}) {
  return {
    orderId: "00000000-0000-4000-8000-000000001016",
    connectionId: HETZNER_CONNECTION.id,
    connectionRevision: 1,
    serverName: "hivra-a1b2c3d4",
    providerServerId: "4815162343",
    stage: "awaiting_setup" as const,
    targetId: null,
    observedAt: null,
    launchReady: false,
    // A newly created server: its 15 minutes start at Start setup, so the
    // server reports no deadline before then.
    enrollmentExpiresAt: null, enrollmentClosesAt: null,
    enrollmentWindow: "since_start" as const,
    ...patch,
  };
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
    (listProviderComputerSetups as jest.Mock).mockResolvedValue([]);
    // The card's evidence is the same setup list plus Hivra's created-server records.
    (listProviderComputerSetupEvidence as jest.Mock).mockImplementation(async (connectionId: string) => ({
      computers: await (listProviderComputerSetups as jest.Mock)(connectionId),
      createdServers: [],
    }));
    (getHetznerCloudCapacitySlot as jest.Mock).mockResolvedValue({ held: false, serverName: null, connectionId: null, status: null });
  });

  it("leads with Hivra Cloud, then truthful self-managed paths, and hides empty-state dashboard clutter", async () => {
    render(<InfrastructureConnectionsPage />);

    const chooser = await screen.findByRole("region", {
      name: "How would you like to add capacity?",
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

    const chooser = await screen.findByRole("region", { name: "How would you like to add capacity?" });
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

  it("preserves a selected agent through capacity setup and opens its launch on the ready server", async () => {
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
      `/dashboard/launch?kind=agent&start=1&profile=codex&targetId=${target.id}`,
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

    const banner = (await screen.findByText(/Capacity is ready for Linux Sandbox/i)).closest('[role="status"]') as HTMLElement;
    expect(within(banner).getByRole("link", { name: /Continue launch/i })).toHaveAttribute(
      "href",
      `/dashboard/launch?kind=computer&start=1&profile=linux-terminal&targetId=${READY_GVISOR_TARGET.id}`,
    );
    // The ready host's own card continues the same launch, with a truthful badge.
    const card = screen.getByRole("heading", { name: "Linux host" }).closest("article") as HTMLElement;
    expect(within(card).getByText("Ready for Linux Sandbox")).toBeInTheDocument();
    expect(within(card).queryByText("Inspected")).not.toBeInTheDocument();
    expect(within(card).getByRole("link", { name: "Continue launch" })).toHaveAttribute(
      "href",
      `/dashboard/launch?kind=computer&start=1&profile=linux-terminal&targetId=${READY_GVISOR_TARGET.id}`,
    );
  });

  it("doesn't send a Linux Sandbox launch back to a gVisor host whose check is stale", async () => {
    mockSearchParamsGet.mockImplementation((key: string) => key === "launch" ? "linux-terminal" : null);
    (listInfrastructureConnections as jest.Mock).mockResolvedValue([{
      ...PENDING_HOST_CONNECTION,
      status: "ready",
      lastCheckedAt: "2026-09-15T12:00:00.000Z",
    }]);
    (listInfrastructureTargets as jest.Mock).mockResolvedValue([STALE_GVISOR_TARGET]);

    render(<InfrastructureConnectionsPage />);

    const card = (await screen.findByRole("heading", { name: "Linux host" })).closest("article") as HTMLElement;
    expect(await within(card).findByText("Needs a check")).toBeInTheDocument();
    expect(screen.queryByText(/Capacity is ready for Linux Sandbox/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Continue launch/i })).not.toBeInTheDocument();
  });

  // INF-06: a ready gVisor host is one click from launching Linux Sandbox.
  it("offers Launch on this server on a ready gVisor host's card", async () => {
    (listInfrastructureConnections as jest.Mock).mockResolvedValue([{
      ...PENDING_HOST_CONNECTION,
      status: "ready",
      lastCheckedAt: "2026-09-15T12:00:00.000Z",
    }]);
    (listInfrastructureTargets as jest.Mock).mockResolvedValue([READY_GVISOR_TARGET]);

    render(<InfrastructureConnectionsPage />);

    const card = (await screen.findByRole("heading", { name: "Linux host" })).closest("article") as HTMLElement;
    expect(await within(card).findByText("Ready for Linux Sandbox")).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: "Launch on this server" })).toHaveAttribute(
      "href",
      `/dashboard/launch?kind=computer&profile=linux-terminal&start=1&targetId=${READY_GVISOR_TARGET.id}`,
    );
  });

  // Review of slice 5: an owner who set up Linux Sandbox and came back an
  // hour later got Ready and a Launch button the server then refused.
  it("asks for a readiness check on a gVisor host whose last check is stale, then offers Launch", async () => {
    const readyConnection: InfrastructureConnectionDto = {
      ...PENDING_HOST_CONNECTION,
      status: "ready",
      lastCheckedAt: "2026-09-15T12:00:00.000Z",
    };
    (listInfrastructureConnections as jest.Mock).mockResolvedValue([readyConnection]);
    (listInfrastructureTargets as jest.Mock)
      .mockResolvedValueOnce([STALE_GVISOR_TARGET])
      .mockResolvedValue([READY_GVISOR_TARGET]);
    (discoverInfrastructureHost as jest.Mock).mockResolvedValue(DISCOVERED_INSTALLED_GVISOR);
    (checkGvisorConnection as jest.Mock).mockResolvedValue({ targetId: READY_GVISOR_TARGET.id, ready: true });

    render(<InfrastructureConnectionsPage />);

    const card = (await screen.findByRole("heading", { name: "Linux host" })).closest("article") as HTMLElement;
    expect(await within(card).findByText("Needs a check")).toBeInTheDocument();
    expect(within(card).queryByText("Ready for Linux Sandbox")).not.toBeInTheDocument();
    expect(within(card).queryByRole("link", { name: "Launch on this server" })).not.toBeInTheDocument();

    // One click: inspect, then the strict check, with no second button.
    fireEvent.click(within(card).getByRole("button", { name: "Check readiness" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByRole("heading", { name: "Linux host is ready for Linux Sandbox." })).toBeInTheDocument();
    expect(discoverInfrastructureHost).toHaveBeenCalledWith(PENDING_HOST_CONNECTION.id);
    expect(checkGvisorConnection).toHaveBeenCalledTimes(1);
    expect(prepareGvisorConnection).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("link", { name: "Launch on this server" })).toHaveAttribute(
      "href",
      `/dashboard/launch?kind=computer&profile=linux-terminal&start=1&targetId=${READY_GVISOR_TARGET.id}`,
    );

    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(await within(card).findByText("Ready for Linux Sandbox")).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: "Launch on this server" })).toBeInTheDocument();
  });

  it("offers Launch on this server on a ready Proxmox host's card", async () => {
    (listInfrastructureConnections as jest.Mock).mockResolvedValue([{
      ...PENDING_HOST_CONNECTION,
      status: "ready",
      lastCheckedAt: "2026-09-15T12:05:00.000Z",
    }]);
    (listInfrastructureTargets as jest.Mock).mockResolvedValue([READY_PROXMOX_TARGET]);

    render(<InfrastructureConnectionsPage />);

    const card = (await screen.findByRole("heading", { name: "Linux host" })).closest("article") as HTMLElement;
    expect(await within(card).findByText("Ready for agents")).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: "Launch on this server" })).toHaveAttribute(
      "href",
      `/dashboard/launch?start=1&targetId=${READY_PROXMOX_TARGET.id}`,
    );
    expect(within(card).queryByRole("button", { name: "Review setup" })).not.toBeInTheDocument();
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

    fireEvent.click(await screen.findByRole("button", { name: "Review setup" }));
    const prepareDialog = await screen.findByRole("dialog");
    expect(within(prepareDialog).getByRole("heading", { name: "Set up Linux host for agents?" })).toBeInTheDocument();
    fireEvent.click(within(prepareDialog).getByRole("button", { name: "Set up Linux host" }));
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
    (prepareGvisorConnection as jest.Mock).mockResolvedValue({ targetId: READY_GVISOR_TARGET.id, ready: true });

    render(<InfrastructureConnectionsPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Inspect again" }));
    expect(await screen.findByRole("heading", { name: "Linux host already has gVisor, which Linux Sandbox runs on." })).toBeInTheDocument();
    await waitFor(() => expect(listInfrastructureTargets).toHaveBeenCalledTimes(2));

    // Repair is a host change, so it goes through the same review dialog.
    fireEvent.click(screen.getByRole("button", { name: "Reinstall Linux Sandbox setup" }));
    const review = await screen.findByRole("dialog", { name: "Reinstall Linux Sandbox setup on Linux host?" });
    expect(prepareGvisorConnection).not.toHaveBeenCalled();
    fireEvent.click(within(review).getByRole("button", { name: "Reinstall setup" }));
    expect(await screen.findByRole("heading", { name: "Linux host is ready for Linux Sandbox." })).toBeInTheDocument();
    expect(prepareGvisorConnection).toHaveBeenCalledWith(PENDING_HOST_CONNECTION.id);
    await waitFor(() => expect(listInfrastructureTargets).toHaveBeenCalledTimes(3));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("link", { name: "Continue launch" })).toHaveAttribute("href", expect.stringContaining(READY_GVISOR_TARGET.id));

    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));

    await waitFor(() => expect(listInfrastructureTargets).toHaveBeenCalledTimes(4));
    expect((await screen.findAllByRole("link", { name: /Continue launch/i }))[0]).toHaveAttribute("href", expect.stringContaining(READY_GVISOR_TARGET.id));
  });

  it("checks an installed Linux Sandbox setup from the card's inspection and offers Launch on this server", async () => {
    const readyConnection: InfrastructureConnectionDto = {
      ...PENDING_HOST_CONNECTION,
      status: "ready",
      lastCheckedAt: "2026-09-15T12:05:00.000Z",
    };
    (listInfrastructureConnections as jest.Mock)
      .mockResolvedValueOnce([PENDING_HOST_CONNECTION])
      .mockResolvedValue([readyConnection]);
    (listInfrastructureTargets as jest.Mock)
      .mockResolvedValueOnce([])
      .mockResolvedValue([READY_GVISOR_TARGET]);
    (discoverInfrastructureHost as jest.Mock).mockResolvedValue(DISCOVERED_INSTALLED_GVISOR);
    (checkGvisorConnection as jest.Mock).mockResolvedValue({ targetId: READY_GVISOR_TARGET.id, ready: true });

    render(<InfrastructureConnectionsPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Inspect again" }));
    fireEvent.click(await screen.findByRole("button", { name: "Check readiness" }));
    expect(await screen.findByRole("heading", { name: "Linux host is ready for Linux Sandbox." })).toBeInTheDocument();
    expect(prepareGvisorConnection).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("link", { name: "Launch on this server" })).toHaveAttribute(
      "href",
      `/dashboard/launch?kind=computer&profile=linux-terminal&start=1&targetId=${READY_GVISOR_TARGET.id}`,
    );
  });

  it("closes the inspection and opens the host's settings when discovery needs a root login", async () => {
    (listInfrastructureConnections as jest.Mock).mockResolvedValue([{ ...PENDING_HOST_CONNECTION, endpoint: { ...PENDING_HOST_CONNECTION.endpoint!, sshUser: "ubuntu" } }]);
    (discoverInfrastructureHost as jest.Mock).mockResolvedValue({
      ...DISCOVERED_INSTALLED_GVISOR,
      snapshot: {
        ...DISCOVERED_INSTALLED_GVISOR.snapshot,
        host: {
          ...DISCOVERED_INSTALLED_GVISOR.snapshot.host,
          environment: { ...DISCOVERED_INSTALLED_GVISOR.snapshot.host.environment, effectivePrivilege: "non-root" },
        },
        engines: DISCOVERED_INSTALLED_GVISOR.snapshot.engines.map((engine) => engine.id === "gvisor"
          ? { ...engine, supported: false, unmetRequirements: ["ROOT_REQUIRED" as const] }
          : engine),
      },
    } satisfies HostDiscoveryResult);

    render(<InfrastructureConnectionsPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Inspect again" }));
    expect(await screen.findByRole("heading", { name: "Signed in as ubuntu without root access." })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Connect as root" }));
    expect(await screen.findByRole("dialog", { name: "Update Linux host" })).toBeInTheDocument();
    expect(screen.getByLabelText("SSH user")).toHaveValue("ubuntu");
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
      name: "Linux host runs Proxmox VE 8.4.1.",
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
      `/dashboard/launch?kind=agent&profile=codex&targetId=${target.id}`,
    );
  });

  it("keeps self-host onboarding local while offering Hivra Cloud as an explicit external option", async () => {
    const previousMode = process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE;
    process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE = "local";
    try {
      render(<InfrastructureConnectionsPage />);

      const chooser = await screen.findByRole("region", {
        name: "How would you like to add capacity?",
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
    expect(screen.queryByRole("region", { name: "How would you like to add capacity?" })).not.toBeInTheDocument();
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
    const chooser = screen.getByRole("region", { name: "How would you like to add capacity?" });
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
      name: "How would you like to add capacity?",
    });
    fireEvent.click(within(chooser).getByRole("button", { name: /Choose Hivra Cloud/i }));

    const dialog = screen.getByRole("dialog", { name: "Choose Hivra Cloud power" });
    expect(requestSubscriptionCheckout).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("radio", { name: /Power/i }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Yearly" }));
    fireEvent.click(within(dialog).getByRole("button", { name: /Continue to secure checkout/i }));

    await waitFor(() => expect(requestSubscriptionCheckout).toHaveBeenCalledWith("fleet", "yearly", { returnTo: null }));
    expect(redirectToCheckoutUrl).toHaveBeenCalledWith("https://checkout.stripe.test/hivra-cloud");
  });

  it("returns a Hivra Cloud checkout started from a launch detour to that launch", async () => {
    mockSearchParamsGet.mockImplementation((key: string) => ({ launch: "codex", returnTo: "unified-launch" } as Record<string, string>)[key] ?? null);
    render(<InfrastructureConnectionsPage />);

    fireEvent.click(await screen.findByRole("button", { name: /Choose Hivra Cloud/i }));
    fireEvent.click(screen.getByRole("button", { name: /Continue to secure checkout/i }));

    await waitFor(() => expect(requestSubscriptionCheckout).toHaveBeenCalledWith("operator", "monthly", { returnTo: "/dashboard/launch" }));
  });

  it("refreshes Infrastructure when Hivra Cloud activates without a checkout redirect", async () => {
    (requestSubscriptionCheckout as jest.Mock).mockResolvedValueOnce({
      ok: true,
      activated: true,
    });
    render(<InfrastructureConnectionsPage />);

    const chooser = await screen.findByRole("region", {
      name: "How would you like to add capacity?",
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

  it("labels each project server by what Hivra can do with it", () => {
    const onSetup = jest.fn();
    const onConnect = jest.fn();
    const ready = { ...HETZNER_OFF_SERVER, id: "00000000-0000-4000-8000-000000001007", providerResourceId: "4815162344", name: "hivra-ready" };
    render(<HetznerCloudConnectionCard connection={HETZNER_CONNECTION}
      inventory={[HETZNER_SERVER, HETZNER_OFF_SERVER, ready]}
      setups={[
        hetznerSetupView(),
        hetznerSetupView({ orderId: "00000000-0000-4000-8000-000000001017", providerServerId: "4815162344", serverName: "hivra-ready",
          stage: "environment_prepared", launchReady: true, targetId: "00000000-0000-4000-8000-000000001099",
          observedAt: "2026-08-26T15:30:00.000Z", enrollmentExpiresAt: null, enrollmentClosesAt: null }),
      ]}
      setupEvidence="loaded"
      loading={false}
      onCreateCapacity={jest.fn()} onRefresh={jest.fn()} onDelete={jest.fn()} onSetup={onSetup} onConnectExistingServer={onConnect} />);

    const existing = screen.getByText("agent-box-1").closest("article") as HTMLElement;
    expect(within(existing).getByText("Not created by Hivra — connect with the setup command.")).toBeInTheDocument();
    fireEvent.click(within(existing).getByRole("button", { name: "Connect this server" }));
    expect(onConnect).toHaveBeenCalledWith(HETZNER_SERVER);

    const created = screen.getByText("hivra-a1b2c3d4").closest("article") as HTMLElement;
    expect(within(created).getByText("Needs setup")).toBeInTheDocument();
    fireEvent.click(within(created).getByRole("button", { name: "Start setup" }));
    expect(onSetup).toHaveBeenCalledWith("00000000-0000-4000-8000-000000001016");

    const prepared = screen.getByText("hivra-ready").closest("article") as HTMLElement;
    expect(within(prepared).getByText("Ready for agents")).toBeInTheDocument();
    expect(within(prepared).getByRole("link", { name: "Launch on this server" }))
      .toHaveAttribute("href", "/dashboard/launch?start=1&targetId=00000000-0000-4000-8000-000000001099");
    expect(screen.queryByText(/Open Computer setup to check agent readiness/)).not.toBeInTheDocument();
  });

  it.each([["since_start", "It didn't connect back within 15 minutes of starting setup."],
    ["since_creation", "Its one-time setup key expired."]] as const)("explains an expired %s setup window by its own rule", (window, hint) => {
    render(<HetznerCloudConnectionCard connection={HETZNER_CONNECTION} inventory={[HETZNER_OFF_SERVER]}
      setups={[hetznerSetupView({ stage: "expired", enrollmentWindow: window })]} setupEvidence="loaded" loading={false}
      onCreateCapacity={jest.fn()} onRefresh={jest.fn()} onDelete={jest.fn()} onSetup={jest.fn()} onConnectExistingServer={jest.fn()} />);
    const created = screen.getByText("hivra-a1b2c3d4").closest("article") as HTMLElement;
    expect(within(created).getByText("Setup window expired")).toBeInTheDocument();
    expect(within(created).getByText(new RegExp(hint.replace(/[.]/g, "\\.")))).toBeInTheDocument();
  });

  it("names no server as someone else's until Hivra's records have loaded", () => {
    const onConnect = jest.fn();
    const props = {
      connection: HETZNER_CONNECTION, inventory: [HETZNER_SERVER], loading: false,
      onCreateCapacity: jest.fn(), onRefresh: jest.fn(), onDelete: jest.fn(), onConnectExistingServer: onConnect,
    };
    const { rerender } = render(<HetznerCloudConnectionCard {...props} />);
    // Loading (also the default): no provenance, no SSH wizard.
    const server = () => screen.getByText("agent-box-1").closest("article") as HTMLElement;
    expect(within(server()).getByText("Checking whether Hivra created this server…")).toBeInTheDocument();
    expect(screen.queryByText(/Not created by Hivra/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect this server" })).not.toBeInTheDocument();

    rerender(<HetznerCloudConnectionCard {...props} setupEvidence="loaded" />);
    expect(within(server()).getByText("Not created by Hivra — connect with the setup command.")).toBeInTheDocument();
    expect(within(server()).getByRole("button", { name: "Connect this server" })).toBeInTheDocument();
  });

  it("keeps setup reachable and labels nothing when Hivra's records can't be read", () => {
    const onRetry = jest.fn();
    const onSetup = jest.fn();
    render(<HetznerCloudConnectionCard connection={HETZNER_CONNECTION} inventory={[HETZNER_SERVER, HETZNER_OFF_SERVER]}
      setupEvidence="failed" onRetrySetupEvidence={onRetry} loading={false} onSetup={onSetup}
      onCreateCapacity={jest.fn()} onRefresh={jest.fn()} onDelete={jest.fn()} onConnectExistingServer={jest.fn()} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Hivra couldn't load which of these servers it created or how far their setup got.");
    expect(screen.queryByText(/Not created by Hivra/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Checking whether Hivra created/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect this server" })).not.toBeInTheDocument();
    // Computer setup reads its own list, so the way into setup stays.
    fireEvent.click(screen.getByRole("button", { name: "Computer setup" }));
    expect(onSetup).toHaveBeenCalledWith();
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("labels a server Hivra created from its order records even without a setup view", () => {
    const abandoned = { ...HETZNER_SERVER, id: "00000000-0000-4000-8000-000000001008", providerResourceId: "4815162399", name: "hivra-abandoned" };
    const lookalike = { ...HETZNER_SERVER, id: "00000000-0000-4000-8000-000000001009", providerResourceId: "4815162398", name: "hivra-removed-by-hand" };
    render(<HetznerCloudConnectionCard connection={HETZNER_CONNECTION}
      inventory={[HETZNER_OFF_SERVER, abandoned, lookalike]}
      createdServers={[
        // Still being confirmed: no server id yet, so its generated name identifies it.
        { orderId: "00000000-0000-4000-8000-000000001016", serverName: "hivra-a1b2c3d4", providerServerId: null, status: "ambiguous" },
        { orderId: "00000000-0000-4000-8000-000000001017", serverName: "hivra-abandoned", providerServerId: "4815162399", status: "cleanup_abandoned" },
        // Confirmed with another id: a same-named server is not this order's.
        { orderId: "00000000-0000-4000-8000-000000001018", serverName: "hivra-removed-by-hand", providerServerId: "1", status: "created_off" },
      ]}
      setupEvidence="loaded" loading={false} onConnectExistingServer={jest.fn()}
      onCreateCapacity={jest.fn()} onRefresh={jest.fn()} onDelete={jest.fn()} />);

    const confirming = screen.getByText("hivra-a1b2c3d4").closest("article") as HTMLElement;
    expect(within(confirming).getByText("Created by Hivra")).toBeInTheDocument();
    expect(within(confirming).getByText("Hivra is still confirming how this server's creation ended.")).toBeInTheDocument();
    expect(within(confirming).queryByRole("button", { name: "Connect this server" })).not.toBeInTheDocument();

    const stuck = screen.getByText("hivra-abandoned").closest("article") as HTMLElement;
    expect(within(stuck).getByText("Created by Hivra")).toBeInTheDocument();
    expect(within(stuck).getByText(/Hivra stopped removing this server/)).toBeInTheDocument();
    expect(within(stuck).queryByRole("button", { name: "Connect this server" })).not.toBeInTheDocument();

    const other = screen.getByText("hivra-removed-by-hand").closest("article") as HTMLElement;
    expect(within(other).getByText("Not created by Hivra — connect with the setup command.")).toBeInTheDocument();
    expect(within(other).getByRole("button", { name: "Connect this server" })).toBeInTheDocument();
  });

  it("doesn't treat a same-named server in another project as the one holding the server slot", () => {
    render(<HetznerCloudConnectionCard connection={HETZNER_CONNECTION} inventory={[HETZNER_SERVER]}
      slot={{ held: true, serverName: HETZNER_SERVER.name, connectionId: "00000000-0000-4000-8000-000000009999", status: "created_off" }}
      setupEvidence="loaded" loading={false} onConnectExistingServer={jest.fn()}
      onCreateCapacity={jest.fn()} onRefresh={jest.fn()} onDelete={jest.fn()} />);
    expect(screen.queryByText("Created by Hivra")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect this server" })).toBeInTheDocument();
  });

  it("disables Create with its reason once the account's server slot is used", () => {
    const onCreate = jest.fn();
    render(<HetznerCloudConnectionCard connection={HETZNER_CONNECTION} inventory={[]} loading={false}
      slot={{ held: true, serverName: "hivra-a1b2c3d4", connectionId: HETZNER_CONNECTION.id, status: "created_off" }}
      onCreateCapacity={onCreate} onRefresh={jest.fn()} onDelete={jest.fn()} />);
    const create = screen.getByRole("button", { name: "Create cloud server" });
    expect(create).toBeDisabled();
    expect(screen.getByRole("note")).toHaveTextContent(
      "Right now Hivra can create one Hetzner server per account. hivra-a1b2c3d4 is using it. Remove it with Remove created server on its project to create another.",
    );
  });

  it("keeps a saved request checkable while it holds the slot", () => {
    window.localStorage.setItem(`hivra:hetzner-capacity-recovery:${HETZNER_CONNECTION.id}`, JSON.stringify({
      version: 2, connectionId: HETZNER_CONNECTION.id,
      quoteId: "11111111-1111-4111-8111-111111111111", idempotencyKey: "22222222-2222-4222-8222-222222222222", prepare: true,
    }));
    const onCreate = jest.fn();
    render(<HetznerCloudConnectionCard connection={HETZNER_CONNECTION} inventory={[]} loading={false}
      slot={{ held: true, serverName: "hivra-a1b2c3d4", connectionId: HETZNER_CONNECTION.id, status: "ambiguous" }}
      onCreateCapacity={onCreate} onRefresh={jest.fn()} onDelete={jest.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Check saved request" }));
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("offers Replace token as the fix when Hetzner rejected the project token", () => {
    const onReplace = jest.fn();
    render(<HetznerCloudConnectionCard
      connection={{ ...HETZNER_CONNECTION, status: "error", lastErrorCode: "invalid_credentials" }}
      inventory={[HETZNER_SERVER]} loading={false} onReplaceToken={onReplace}
      onCreateCapacity={jest.fn()} onRefresh={jest.fn()} onDelete={jest.fn()} />);
    expect(screen.getByText("Token rejected")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/Replace it with a new Read & Write token from the same project/);
    fireEvent.click(screen.getByRole("button", { name: "Replace token" }));
    expect(onReplace).toHaveBeenCalledTimes(1);
  });

  it("connects a project with a disclosed write check, reviews one timeline, and starts setup next", async () => {
    (connectHetznerCloudProject as jest.Mock).mockResolvedValue({
      connection: HETZNER_CONNECTION,
      inventory: [],
      writeCheck: { strayKeyName: null },
    });
    (listProviderComputerSetups as jest.Mock).mockResolvedValue([hetznerSetupView()]);
    render(<InfrastructureConnectionsPage />);

    const chooser = await screen.findByRole("region", {
      name: "How would you like to add capacity?",
    });
    fireEvent.click(within(chooser).getByRole("button", { name: /Choose cloud provider/i }));
    fireEvent.click(within(chooser).getByRole("button", { name: /Start with Hetzner/i }));

    const dialog = screen.getByRole("dialog", { name: "Connect Hetzner Cloud" });
    // The guide sits above the one field; nothing to expand first.
    const steps = within(dialog).getByRole("list", { name: "Hetzner token steps" });
    expect(within(steps).getByText("Generate a Read & Write API token")).toBeVisible();
    expect(steps.compareDocumentPosition(within(dialog).getByLabelText(/Read & Write project API token/))
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(dialog).getByText(/adding, then removing, a test SSH key named hivra-check/)).toBeInTheDocument();
    const tokenField = within(dialog).getByLabelText(/Read & Write project API token/);
    const nameField = within(dialog).getByLabelText("Connection name");
    expect(nameField).not.toBeVisible();

    fireEvent.click(within(dialog).getByText("Customize connection name"));
    fireEvent.change(nameField, { target: { value: "Personal cloud" } });
    fireEvent.change(tokenField, { target: { value: "secure-project-token-1234567890" } });
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
    expect(within(capacityDialog).queryByText(/Enable guided computer setup/i)).not.toBeInTheDocument();

    fireEvent.click(within(capacityDialog).getByRole("button", { name: "Review current rates" }));
    await waitFor(() => expect(quoteHetznerCloudCapacity).toHaveBeenCalledWith(
      HETZNER_CONNECTION.id,
      { serverTypeId: 22, locationId: 1, imageId: 100 },
    ));

    await within(capacityDialog).findByRole("heading", { name: "Review and create" });
    const timeline = within(capacityDialog).getByRole("region", { name: "What happens next" });
    expect(within(timeline).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "1CreateHetzner starts billing.",
      "2Set it up for agentsAbout 5 minutes; you start it next.",
      "3LaunchYou review it next.",
    ]);
    // One confirmation, with the price it binds; the rest is disclosed on demand.
    expect(within(capacityDialog).getAllByRole("checkbox", { name: /I understand/ })).toHaveLength(1);
    const billing = within(capacityDialog).getByText("Billing details").closest("details") as HTMLElement;
    expect(billing).not.toHaveAttribute("open");
    expect(within(billing).getByText("Primary IPv4")).toBeInTheDocument();
    expect(within(billing).getByText(/Traffic beyond 20 TiB/i)).toBeInTheDocument();
    expect(within(billing).getByText(/rare migration or hardware-failure cases/i)).toBeInTheDocument();
    expect(within(billing).getByText(/Setup applies and checks a Hetzner firewall before it turns the server on/)).toBeInTheDocument();
    expect(within(capacityDialog).queryByText(/Canary/)).not.toBeInTheDocument();

    const createButton = within(capacityDialog).getByRole("button", {
      name: "Create server and start billing",
    });
    expect(createButton).toBeDisabled();
    fireEvent.click(within(capacityDialog).getByRole("checkbox", {
      name: /I understand Hetzner bills this server EUR 0\.0067 an hour, at most EUR 4\.5101 a month, from now until I delete it/,
    }));
    expect(createButton).toBeEnabled();
    fireEvent.click(createButton);

    // Setup is on by default: the request carries the recipe consent.
    await waitFor(() => expect(createHetznerCloudCapacity).toHaveBeenCalledWith(
      HETZNER_CONNECTION.id,
      {
        quoteId: HETZNER_QUOTE.id,
        idempotencyKey: "00000000-0000-4000-8000-000000001048",
        spendingConfirmation: "Create server and start billing",
        preparationConfirmation: "Prepare this computer for agent launch",
      },
    ));
    expect(await within(capacityDialog).findByRole("heading", { name: "Set it up for agents" })).toBeInTheDocument();
    expect(within(capacityDialog).getByText("Server created (powered off). Billing has started.")).toBeInTheDocument();
    // No countdown before Start setup: the window opens when Hivra powers it on.
    expect(await within(capacityDialog).findByText(/Setup must finish within 15 minutes of starting/)).toBeInTheDocument();
    expect(within(capacityDialog).queryByText(/Setup key valid for/)).not.toBeInTheDocument();
    expect(within(capacityDialog).queryByText(/left for the server to connect back/)).not.toBeInTheDocument();
    // Start setup is the only primary action; no "Return to infrastructure" first.
    expect(within(capacityDialog).getByRole("button", { name: "Start setup" })).toBeEnabled();
    expect(within(capacityDialog).queryByRole("button", { name: /Return to infrastructure/ })).not.toBeInTheDocument();
    expect(advanceProviderComputerSetup).not.toHaveBeenCalled();
    expect(screen.queryByDisplayValue("secure-project-token-1234567890")).not.toBeInTheDocument();
  });

  it("starts setup from the result and ends on the launch the server was created for", async () => {
    mockSearchParamsGet.mockImplementation((key: string) => key === "launch" ? "codex" : null);
    (listInfrastructureConnections as jest.Mock).mockResolvedValue([HETZNER_CONNECTION]);
    (listProviderComputerSetups as jest.Mock).mockResolvedValue([hetznerSetupView()]);
    (advanceProviderComputerSetup as jest.Mock).mockResolvedValue(hetznerSetupView({
      stage: "environment_prepared", launchReady: true, targetId: "00000000-0000-4000-8000-000000001099",
      observedAt: "2026-08-26T15:30:00.000Z", enrollmentExpiresAt: null, enrollmentClosesAt: null,
    }));
    render(<InfrastructureConnectionsPage />);
    const card = (await screen.findByRole("heading", { name: "Personal cloud" })).closest("article") as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: "Create cloud server" }));
    const dialog = await screen.findByRole("dialog", { name: "Choose a Hetzner server" });
    fireEvent.click(await within(dialog).findByRole("button", { name: "Review current rates" }));
    expect(await within(dialog).findByText("3")).toBeInTheDocument();
    expect(within(dialog).getByText("Launch Codex")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /I understand Hetzner bills this server/i }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Create server and start billing" }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Start setup" }));

    expect(await within(dialog).findByRole("link", { name: "Continue launch" })).toHaveAttribute(
      "href", "/dashboard/launch?kind=agent&start=1&profile=codex&targetId=00000000-0000-4000-8000-000000001099",
    );
    expect(advanceProviderComputerSetup).toHaveBeenCalledWith(HETZNER_CONNECTION.id, {
      orderId: "00000000-0000-4000-8000-000000001016", expectedConnectionRevision: 1,
    });
    expect(within(dialog).getByText("hivra-a1b2c3d4 is ready for agents.", { exact: false })).toBeInTheDocument();
  });

  it("creates a plain server only when the user opts out under Advanced", async () => {
    (listInfrastructureConnections as jest.Mock).mockResolvedValue([HETZNER_CONNECTION]);
    render(<InfrastructureConnectionsPage />);
    const card = (await screen.findByRole("heading", { name: "Personal cloud" })).closest("article") as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: "Create cloud server" }));
    const dialog = await screen.findByRole("dialog", { name: "Choose a Hetzner server" });
    fireEvent.click(await within(dialog).findByRole("button", { name: "Review current rates" }));
    const plain = await within(dialog).findByRole("checkbox", { name: /Create a plain server without agent setup/ });
    expect(plain).not.toBeChecked();
    fireEvent.click(plain);
    expect(within(dialog).getByText("Skipped. You chose a plain server under Advanced.")).toBeInTheDocument();
    expect(within(dialog).getByText(/Hivra does not request or manage a provider firewall/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /I understand Hetzner bills this server/i }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Create server and start billing" }));
    await waitFor(() => expect(createHetznerCloudCapacity).toHaveBeenCalledTimes(1));
    expect((createHetznerCloudCapacity as jest.Mock).mock.calls[0][1]).not.toHaveProperty("preparationConfirmation");
    expect(await within(dialog).findByText(/You chose a plain server/)).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Start setup" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Done" })).toBeInTheDocument();
  });

  it("blocks a new price review with the reason while the account's slot is used", async () => {
    (listInfrastructureConnections as jest.Mock).mockResolvedValue([HETZNER_CONNECTION]);
    (getHetznerCloudCapacitySlot as jest.Mock).mockResolvedValue({ held: true, serverName: "hivra-a1b2c3d4", connectionId: null, status: "created_off" });
    render(<HetznerCloudCapacityDialog connection={HETZNER_CONNECTION} onClose={jest.fn()} onInventoryChanged={jest.fn()}
      slot={{ held: true, serverName: "hivra-a1b2c3d4", connectionId: null, status: "created_off" }} />);
    const dialog = await screen.findByRole("dialog", { name: "Choose a Hetzner server" });
    expect(await within(dialog).findByRole("button", { name: "Review current rates" })).toBeDisabled();
    expect(within(dialog).getByText(/hivra-a1b2c3d4 is using it/)).toBeInTheDocument();
    expect(quoteHetznerCloudCapacity).not.toHaveBeenCalled();
  });

  it("replaces a rejected project token from the card without disconnecting", async () => {
    const rejected = { ...HETZNER_CONNECTION, status: "error" as const, lastErrorCode: "invalid_credentials" as const };
    (listInfrastructureConnections as jest.Mock).mockResolvedValue([rejected]);
    (getHetznerCloudInventory as jest.Mock).mockResolvedValue([HETZNER_OFF_SERVER]);
    (replaceHetznerCloudToken as jest.Mock).mockResolvedValue({
      connection: HETZNER_CONNECTION, inventory: [HETZNER_OFF_SERVER], writeCheck: { strayKeyName: null }, projectCheck: "confirmed",
    });
    render(<InfrastructureConnectionsPage />);
    const card = (await screen.findByRole("heading", { name: "Personal cloud" })).closest("article") as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: "Replace token" }));
    const dialog = screen.getByRole("dialog", { name: "Replace Hetzner token" });
    expect(within(dialog).queryByLabelText("Connection name")).not.toBeInTheDocument();
    expect(within(dialog).getByText(/can see the servers and keys it created in this project/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText(/Read & Write project API token/), { target: { value: "replacement-project-token-1234" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Replace token" }));

    await waitFor(() => expect(replaceHetznerCloudToken).toHaveBeenCalledWith(HETZNER_CONNECTION.id, "replacement-project-token-1234"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await screen.findByText("Token replaced for Personal cloud. Its servers and setup carried over.")).toBeInTheDocument();
    expect(within(card).getByText("Connected")).toBeInTheDocument();
    expect(deleteInfrastructureConnection).not.toHaveBeenCalled();
  });

  it("says plainly when a replaced token couldn't be matched to the same project, and syncs a list it couldn't save", async () => {
    (listInfrastructureConnections as jest.Mock).mockResolvedValue([HETZNER_CONNECTION]);
    (replaceHetznerCloudToken as jest.Mock).mockResolvedValue({
      connection: HETZNER_CONNECTION, inventory: null, writeCheck: { strayKeyName: null }, projectCheck: "unconfirmed",
    });
    (refreshHetznerCloudInventory as jest.Mock).mockResolvedValue([HETZNER_SERVER]);
    render(<InfrastructureConnectionsPage />);
    const card = (await screen.findByRole("heading", { name: "Personal cloud" })).closest("article") as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: "Replace token" }));
    const dialog = screen.getByRole("dialog", { name: "Replace Hetzner token" });
    fireEvent.change(within(dialog).getByLabelText(/Read & Write project API token/), { target: { value: "replacement-project-token-1234" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Replace token" }));

    expect(await screen.findByText(/couldn't confirm this is the same project/)).toBeInTheDocument();
    expect(screen.queryByText(/Its servers and setup carried over/)).not.toBeInTheDocument();
    // The token is saved but its list wasn't: read it with the new token instead of showing an empty project.
    await waitFor(() => expect(refreshHetznerCloudInventory).toHaveBeenCalledWith(HETZNER_CONNECTION.id));
    expect(await within(card).findByText("agent-box-1")).toBeInTheDocument();
  });

  it("re-reads the connection when a replaced token couldn't be confirmed, and never says nothing was replaced", async () => {
    (listInfrastructureConnections as jest.Mock).mockResolvedValue([HETZNER_CONNECTION]);
    (replaceHetznerCloudToken as jest.Mock).mockRejectedValue(new InfrastructureApiError(
      "Hivra saved your new token but couldn't confirm it's the one this project uses now. It may have changed again straight after. Use Sync servers to check it.",
      409, "replaced_unconfirmed",
    ));
    render(<InfrastructureConnectionsPage />);
    const card = (await screen.findByRole("heading", { name: "Personal cloud" })).closest("article") as HTMLElement;
    await waitFor(() => expect(listInfrastructureConnections).toHaveBeenCalledTimes(1));
    fireEvent.click(within(card).getByRole("button", { name: "Replace token" }));
    const dialog = screen.getByRole("dialog", { name: "Replace Hetzner token" });
    const field = within(dialog).getByLabelText(/Read & Write project API token/);
    fireEvent.change(field, { target: { value: "replacement-project-token-1234" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Replace token" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Hivra saved your new token");
    expect(within(dialog).queryByText(/Nothing was replaced/)).not.toBeInTheDocument();
    await waitFor(() => expect(listInfrastructureConnections).toHaveBeenCalledTimes(2));
    expect(field).toHaveValue("");
  });

  it("labels no server until the card's evidence arrives, and offers a retry when it fails", async () => {
    (listInfrastructureConnections as jest.Mock).mockResolvedValue([HETZNER_CONNECTION]);
    (getHetznerCloudInventory as jest.Mock).mockResolvedValue([HETZNER_SERVER, HETZNER_OFF_SERVER]);
    let failRead!: (error: Error) => void;
    (listProviderComputerSetupEvidence as jest.Mock).mockImplementationOnce(() => new Promise((_resolve, reject) => { failRead = reject; }));
    render(<InfrastructureConnectionsPage />);
    const card = (await screen.findByRole("heading", { name: "Personal cloud" })).closest("article") as HTMLElement;
    expect(await within(card).findByText("hivra-a1b2c3d4")).toBeInTheDocument();
    // Still reading Hivra's records: the server Hivra created is not called someone else's.
    expect(within(card).queryByText(/Not created by Hivra/)).not.toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "Connect this server" })).not.toBeInTheDocument();

    await act(async () => failRead(new Error("Setup evidence unavailable")));
    const alert = await within(card).findByRole("alert");
    expect(alert).toHaveTextContent("Hivra couldn't load which of these servers it created");
    expect(within(card).queryByText(/Not created by Hivra/)).not.toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Computer setup" })).toBeInTheDocument();

    (listProviderComputerSetups as jest.Mock).mockResolvedValue([hetznerSetupView()]);
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    const created = (await within(card).findByText("Needs setup")).closest("article") as HTMLElement;
    expect(within(created).getByText("hivra-a1b2c3d4")).toBeInTheDocument();
    const existing = within(card).getByText("agent-box-1").closest("article") as HTMLElement;
    expect(within(existing).getByText("Not created by Hivra — connect with the setup command.")).toBeInTheDocument();
    expect(within(card).queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each([
    ["connect", "This token is read-only. Generate a Read & Write token in the same project and paste it here."],
    ["replace", "This token is for a different Hetzner project. It can't see the servers or keys Hivra created here. Generate a Read & Write token in the same project and paste it here."],
  ])("keeps the %s dialog open with the fix when the token check fails", async (mode, message) => {
    const failure = new InfrastructureApiError(message, 422, mode === "connect" ? "token_read_only" : "token_project_mismatch");
    (connectHetznerCloudProject as jest.Mock).mockRejectedValue(failure);
    (replaceHetznerCloudToken as jest.Mock).mockRejectedValue(failure);
    const onConnected = jest.fn();
    const onReplaceUnconfirmed = jest.fn();
    render(mode === "replace"
      ? <HetznerCloudConnectionDialog replacing={HETZNER_CONNECTION} onClose={jest.fn()} onReplaced={onConnected} onReplaceUnconfirmed={onReplaceUnconfirmed} />
      : <HetznerCloudConnectionDialog onClose={jest.fn()} onConnected={onConnected} />);
    fireEvent.change(screen.getByLabelText(/Read & Write project API token/), { target: { value: "some-hetzner-token-1234567" } });
    fireEvent.click(screen.getByRole("button", { name: mode === "connect" ? "Connect and choose a server" : "Replace token" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(onConnected).not.toHaveBeenCalled();
    // A refused check replaced nothing; there's nothing to re-read.
    expect(onReplaceUnconfirmed).not.toHaveBeenCalled();
    // Fixed on the same screen: the field is ready for the next token.
    expect(screen.getByLabelText(/Read & Write project API token/)).toBeEnabled();
  });

  it("shows the stray test key's name when Hivra couldn't remove it", async () => {
    (connectHetznerCloudProject as jest.Mock).mockResolvedValue({
      connection: HETZNER_CONNECTION, inventory: [], writeCheck: { strayKeyName: "hivra-check-0123456789ab" },
    });
    const onConnected = jest.fn();
    render(<HetznerCloudConnectionDialog onClose={jest.fn()} onConnected={onConnected} />);
    fireEvent.change(screen.getByLabelText(/Read & Write project API token/), { target: { value: "some-hetzner-token-1234567" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect and choose a server" }));
    expect(await screen.findByRole("heading", { name: "Project connected." })).toBeInTheDocument();
    expect(screen.getByText(/Hivra couldn't remove its test SSH key hivra-check-0123456789ab/)).toBeInTheDocument();
    expect(onConnected).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onConnected).toHaveBeenCalledWith(HETZNER_CONNECTION, []);
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
    await within(dialog).findByRole("heading", { name: "Review and create" });

    expect(within(dialog).getByText("USD 7.788 / month cap")).toBeInTheDocument();
    expect(within(dialog).getByText("USD 0.72 / month cap")).toBeInTheDocument();
    expect(within(dialog).getByText("USD 0 / hour gross")).toBeInTheDocument();
    expect(within(dialog).getByText("USD 0.0000000000000001 / month cap")).toBeInTheDocument();
    expect(within(dialog).getByText("USD 1.44")).toBeInTheDocument();
    expect(within(dialog).getByText(/Hetzner's VAT rate of 20%/)).toBeInTheDocument();
    expect(within(dialog).getByRole("checkbox", {
      name: /bills this server USD 0\.01368 an hour, at most USD 8\.5080000000000001 a month/,
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
    const reviewHeading = await within(dialog).findByRole("heading", { name: "Review and create" });
    expect(dialog.scrollTop).toBe(0);
    expect(reviewHeading).toHaveFocus();

    dialog.scrollTop = 850;
    fireEvent.click(within(dialog).getByRole("button", { name: "Change configuration" }));
    const chooseHeading = await within(dialog).findByRole("heading", { name: "Choose a Hetzner server" });
    expect(dialog.scrollTop).toBe(0);
    expect(chooseHeading).toHaveFocus();

    fireEvent.click(within(dialog).getByRole("button", { name: "Review current rates" }));
    fireEvent.click(await within(dialog).findByRole("checkbox", { name: /I understand Hetzner bills this server/ }));
    dialog.scrollTop = 850;
    fireEvent.click(within(dialog).getByRole("button", { name: "Create server and start billing" }));
    const resultHeading = await within(dialog).findByRole("heading", { name: "Set it up for agents" });
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
    const reviewHeading = await within(dialog).findByRole("heading", { name: "Review and create" });
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

  it("explains the firewall sequence setup will run without claiming it has run", async () => {
    (listInfrastructureConnections as jest.Mock).mockResolvedValue([HETZNER_CONNECTION]);
    render(<InfrastructureConnectionsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Create cloud server" }));
    const dialog = await screen.findByRole("dialog", { name: "Choose a Hetzner server" });
    await within(dialog).findByLabelText("Server size");
    fireEvent.click(within(dialog).getByRole("button", { name: "Review current rates" }));
    await within(dialog).findByRole("heading", { name: "Review and create" });
    expect(within(dialog).getByText(/Setup applies and checks a Hetzner firewall before it turns the server on/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/Hivra does not request or manage a provider firewall/)).not.toBeInTheDocument();
    expect(within(dialog).getByText("About 5 minutes; you start it next.")).toBeInTheDocument();
    expect(within(dialog).getByRole("checkbox", { name: /I understand Hetzner bills this server/ })).not.toBeChecked();
    expect(within(dialog).getByRole("button", { name: "Create server and start billing" })).toBeDisabled();
    expect(createHetznerCloudCapacity).not.toHaveBeenCalled();
  });

  it("lists only images Hivra can set up and says so when none are offered", async () => {
    (listInfrastructureConnections as jest.Mock).mockResolvedValue([HETZNER_CONNECTION]);
    (getHetznerCloudOfferCatalog as jest.Mock).mockResolvedValueOnce({
      ...HETZNER_CATALOG,
      images: [HETZNER_UNSUPPORTED_IMAGE, ...HETZNER_CATALOG.images],
    });
    const view = render(<InfrastructureConnectionsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Create cloud server" }));
    let dialog = await screen.findByRole("dialog", { name: "Choose a Hetzner server" });
    const image = await within(dialog).findByLabelText("System image");
    expect(within(image).getAllByRole("option").map((option) => option.textContent)).toEqual(["Ubuntu 22.04 · 22.04"]);
    view.unmount();

    (getHetznerCloudOfferCatalog as jest.Mock).mockResolvedValueOnce({ ...HETZNER_CATALOG, images: [HETZNER_UNSUPPORTED_IMAGE] });
    render(<InfrastructureConnectionsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Create cloud server" }));
    dialog = await screen.findByRole("dialog", { name: "Choose a Hetzner server" });
    expect(await within(dialog).findByRole("heading", { name: "No server Hivra can set up is available here." })).toBeInTheDocument();
    expect(within(dialog).getByText(/Hivra sets up Ubuntu 22.04 on x86 servers/)).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Review current rates" })).not.toBeInTheDocument();
    expect(quoteHetznerCloudCapacity).not.toHaveBeenCalled();
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
      name: "How would you like to add capacity?",
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
      name: /I understand Hetzner bills this server/i,
    });
    fireEvent.click(confirmation);
    fireEvent.click(within(dialog).getByRole("button", {
      name: "Create server and start billing",
    }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      /read-only\. Use Replace token on the project card with a Read & Write token from the same project/i,
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
      /older saved token that can't create servers\. Use Replace token on the project card/i,
    );
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      /The server list keeps working meanwhile/i,
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
      name: /I understand Hetzner bills this server/i,
    }));
    fireEvent.click(within(dialog).getByRole("button", {
      name: "Create server and start billing",
    }));

    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent(/one Hetzner server per account/i);
    expect(alert).toHaveTextContent(
      /Deleting the server directly in Hetzner doesn't free it/i,
    );
    expect(alert).toHaveTextContent(/use Remove created server on its project/i);
    expect(alert).toHaveTextContent(/Older or unresolved launches need manual review/i);
    expect(alert).not.toHaveTextContent(/reconnect/i);
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
    fireEvent.click(await within(dialog).findByRole("checkbox", { name: /I understand Hetzner bills this server/i }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Create server and start billing" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("This attempt did not request a new server");
    expect((createHetznerCloudCapacity as jest.Mock).mock.calls[0][1]).toHaveProperty(
      "preparationConfirmation", "Prepare this computer for agent launch",
    );
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
      name: /I understand Hetzner bills this server/i,
    }));
    fireEvent.click(within(dialog).getByRole("button", {
      name: "Create server and start billing",
    }));

    expect(await within(dialog).findByText(
      /This request uses the account's one Hetzner server slot/i,
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
      name: /I understand Hetzner bills this server/i,
    }));
    fireEvent.click(within(dialog).getByRole("button", {
      name: "Create server and start billing",
    }));

    expect(await within(dialog).findByText(
      /This request did not keep the account's Hetzner server slot/i,
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
    fireEvent.click(await within(dialog).findByRole("checkbox",{name:/I understand Hetzner bills this server/i}));
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
    fireEvent.click(within(dialog).getByRole("button",{name:"Close"}));
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
    fireEvent.click(await within(dialog).findByRole("checkbox",{name:/I understand Hetzner bills this server/i}));
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
      name: /I understand Hetzner bills this server/i,
    }));

    expect(within(dialog).getByRole("button", {
      name: "Create server and start billing",
    })).toBeDisabled();
    expect(within(dialog).getByRole("alert")).toHaveTextContent(/This price has expired/i);
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
      name: /I understand Hetzner bills this server/i,
    }));
    const setItem = jest.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
      throw new Error("Storage denied");
    });

    fireEvent.click(within(dialog).getByRole("button", {
      name: "Create server and start billing",
    }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      /couldn't save the non-secret recovery identifiers/i,
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
      name: /I understand Hetzner bills this server/i,
    }));
    fireEvent.click(within(dialog).getByRole("button", {
      name: "Create server and start billing",
    }));

    expect(await within(dialog).findByRole("heading", {
      name: "Creation outcome needs reconciliation.",
    })).toBeInTheDocument();
    expect(within(dialog).getByText(/uses the account's one Hetzner server slot/i))
      .toBeInTheDocument();
    expect(within(dialog).getByText(/Inspect retained Hetzner resources/i))
      .toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Check this request again" }));

    expect(await within(dialog).findByText("Server created (powered off). Billing has started.")).toBeInTheDocument();
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
        name: /I understand Hetzner bills this server/i,
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
      name: /I understand Hetzner bills this server/i,
    }));
    if (!prepare) fireEvent.click(within(dialog).getByRole("checkbox", { name: /Create a plain server without agent setup/i }));
    if (prepare) (listProviderComputerSetups as jest.Mock).mockResolvedValue([hetznerSetupView()]);
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
    // The card offers the saved check, not a second purchase.
    fireEvent.click(within(projectCard).getByRole("button", { name: "Check saved request" }));
    dialog = await screen.findByRole("dialog", { name: "Recover pending request" });

    expect(createHetznerCloudCapacity).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "Check saved request" }));
    expect(await within(dialog).findByText("Server created (powered off). Billing has started.")).toBeInTheDocument();
    expect(createHetznerCloudCapacity).toHaveBeenCalledTimes(2);
    expect((createHetznerCloudCapacity as jest.Mock).mock.calls[0]).toEqual(
      (createHetznerCloudCapacity as jest.Mock).mock.calls[1],
    );
    expect(quoteHetznerCloudCapacity).toHaveBeenCalledTimes(1);
    expect(window.localStorage.length).toBe(0);
    if (prepare) {
      expect(await within(dialog).findByRole("button", { name: "Start setup" })).toBeInTheDocument();
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
    const chooser = screen.getByRole("region", { name: "How would you like to add capacity?" });
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

  it.each([
    ["invalid_credentials", "Token rejected", true],
    ["provider_unavailable", "Sync issue", false],
  ])("shows a failed Hetzner refresh (%s) as stale evidence instead of connected health", async (code, badge, replaceIsPrimary) => {
    (listInfrastructureConnections as jest.Mock).mockResolvedValue([HETZNER_CONNECTION]);
    (getHetznerCloudInventory as jest.Mock).mockResolvedValue([HETZNER_SERVER]);
    (refreshHetznerCloudInventory as jest.Mock).mockRejectedValue(
      new InfrastructureApiError("Hetzner Cloud inventory could not be refreshed.", 422, code),
    );
    render(<InfrastructureConnectionsPage />);

    const projectHeading = await screen.findByRole("heading", { name: "Personal cloud" });
    const projectCard = projectHeading.closest("article") as HTMLElement;
    fireEvent.click(within(projectCard).getByRole("button", { name: "Sync servers" }));

    expect(await within(projectCard).findByText(badge)).toBeInTheDocument();
    expect(within(projectCard).getByRole("alert")).toHaveTextContent(
      /Showing the last successful server snapshot/i,
    );
    expect(within(projectCard).queryByText(/^Connected$/)).not.toBeInTheDocument();
    const replace = within(projectCard).getAllByRole("button", { name: "Replace token" });
    expect(replace).toHaveLength(1);
    // A rejected token puts Replace token first, ahead of Create cloud server.
    const create = within(projectCard).getByRole("button", { name: "Create cloud server" });
    expect(Boolean(replace[0].compareDocumentPosition(create) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(replaceIsPrimary);
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
    const chooser = await screen.findByRole("region", { name: "How would you like to add capacity?" });
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
