import type {
  DeploymentTargetDto,
  InfrastructureConnectionDto,
  ProxmoxPreflightResult,
} from "../contracts";
import {
  canPrepareFromPreflight,
  canPrepareFromSavedTarget,
} from "../preparation-eligibility";
import { providerVmTarget } from "./provider-vm-target.fixtures";

it("never offers the Proxmox preparation recipe for a provider VM", () => {
  expect(canPrepareFromSavedTarget(connection, providerVmTarget())).toBe(false);
});

const CHECKED_AT = "2026-08-26T12:00:00.000Z";

const connection: InfrastructureConnectionDto = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "My host",
  provider: "host",
  operatingMode: "self-managed",
  setupMode: "simple",
  status: "ready",
  endpoint: {
    sshHost: "host.example.com",
    sshPort: 22,
    sshUser: "root",
    sshHostFingerprintSha256: "a".repeat(64),
  },
  configuration: null,
  credentialsConfigured: true,
  lastCheckedAt: CHECKED_AT,
  lastErrorCode: "PROVISIONER_UNAVAILABLE",
  createdAt: CHECKED_AT,
  updatedAt: CHECKED_AT,
};

const incomplete: ProxmoxPreflightResult = {
  ok: true,
  connectionId: connection.id,
  checkedAt: CHECKED_AT,
  target: {
    externalId: "fixturenode1",
    displayName: "My host / fixturenode1",
    proxmoxVersion: "8.4.1",
    launchReady: false,
    capacity: {
      cpu: { totalCores: 8, utilizationRatio: 0.2 },
      memoryBytes: { total: 32_000, available: 24_000 },
      storageBytes: { total: 500_000, available: 400_000 },
    },
    capabilities: {
      isolationDrivers: ["proxmox-kvm"],
      isolationClass: "hardware-vm",
      kvmAvailable: true,
      bridges: ["hivra0"],
      storages: ["local-lvm"],
      template: null,
      provisioner: { ready: false, version: null },
      runtimeCompatibility: null,
      vmidRange: { start: 200, end: 399, freeCount: 180 },
    },
  },
  warnings: ["The versioned host tools are unavailable."],
  unmetRequirements: [{
    code: "PROVISIONER_UNAVAILABLE",
    message: "The versioned host tools are unavailable.",
  }],
};

const savedTarget: DeploymentTargetDto = {
  id: "22222222-2222-4222-8222-222222222222",
  connectionId: connection.id,
  evidenceConnectionRevision: 2,
  externalId: "fixturenode1",
  displayName: "My host / fixturenode1",
  status: "unavailable",
  capacity: {
    cpu: { totalCores: 8, utilizationRatio: 0.2 },
    memoryBytes: { total: 32_000, available: 24_000 },
    storageBytes: { total: 500_000, available: 400_000 },
  },
  capabilities: {
    proxmoxVersion: "8.4.1",
    launchReady: false,
    directRootAccess: true,
    kvmAvailable: true,
    bridges: ["hivra0"],
    selectedBridge: "hivra0",
    storages: ["local-lvm"],
    selectedStorage: "local-lvm",
    template: null,
    provisioner: { configured: true, ready: false, version: null },
    runtimeCompatibility: null,
    vmidRange: { start: 200, end: 399, freeCount: 180, firstAvailable: 200 },
    issues: [{
      code: "PROVISIONER_UNAVAILABLE",
      message: "The versioned host tools are unavailable.",
    }],
  },
  supportedIsolationDrivers: ["proxmox-kvm"],
  isolationClass: "hardware-vm",
  lastPreflightAt: CHECKED_AT,
  lastErrorCode: "PROVISIONER_UNAVAILABLE",
  createdAt: CHECKED_AT,
  updatedAt: CHECKED_AT,
};

describe("preparation eligibility", () => {
  it("allows Simple preparation only for requirements the action can repair", () => {
    expect(canPrepareFromPreflight(connection, incomplete)).toBe(true);
    expect(canPrepareFromSavedTarget(connection, savedTarget)).toBe(true);

    const missingOwnedBridge: ProxmoxPreflightResult = {
      ok: false,
      connectionId: connection.id,
      checkedAt: CHECKED_AT,
      error: {
        code: "BRIDGE_UNAVAILABLE",
        message: "The dedicated Hivra network is not configured.",
      },
      unmetRequirements: [{
        code: "BRIDGE_UNAVAILABLE",
        message: "The dedicated Hivra network is not configured.",
      }],
    };
    expect(canPrepareFromPreflight(connection, missingOwnedBridge)).toBe(true);
  });

  it("rejects capacity and VMID failures instead of offering unrelated mutation", () => {
    const capacityFailure: ProxmoxPreflightResult = {
      ...incomplete,
      warnings: ["No memory remains."],
      unmetRequirements: [{ code: "CAPACITY_UNAVAILABLE", message: "No memory remains." }],
    };
    const exhaustedTarget: DeploymentTargetDto = {
      ...savedTarget,
      capabilities: {
        ...savedTarget.capabilities,
        issues: [{ code: "VMID_RANGE_UNAVAILABLE", message: "No VM IDs remain." }],
      },
      lastErrorCode: "VMID_RANGE_UNAVAILABLE",
    };
    expect(canPrepareFromPreflight(connection, capacityFailure)).toBe(false);
    expect(canPrepareFromSavedTarget(connection, exhaustedTarget)).toBe(false);
  });

  it("rejects Advanced mode and stale pending connection evidence", () => {
    expect(canPrepareFromPreflight({ ...connection, setupMode: "advanced" }, incomplete)).toBe(false);
    expect(canPrepareFromSavedTarget({ ...connection, status: "pending" }, savedTarget)).toBe(false);
  });
});
