/** @jest-environment node */

jest.mock("server-only", () => ({}));

import type { ProxmoxDeploymentTargetDto } from "../contracts";
import type { LoadedInfrastructureConnection } from "../connection-store";
import { providerVmTarget } from "./provider-vm-target.fixtures";
import {
  ProxmoxExecutionContextError,
  resolveSelfManagedProxmoxExecutionContext,
} from "../proxmox-execution-context";
import {
  PORTABLE_HIVRA_PROVISIONER_VERSION,
  PORTABLE_HIVRA_RUNTIME_COMPATIBILITY,
} from "../portable-provisioner-contract";

const connectionId = "11111111-1111-4111-8111-111111111111";
const targetId = "22222222-2222-4222-8222-222222222222";
const now = "2026-08-26T12:00:00.000Z";

function connection(
  overrides: Partial<LoadedInfrastructureConnection> = {},
): LoadedInfrastructureConnection {
  return {
    id: connectionId,
    name: "Personal Proxmox",
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
    lastCheckedAt: now,
    lastErrorCode: null,
    createdAt: now,
    updatedAt: now,
    revision: 4,
    pendingBindingRebindFromRevision: null,
    credentials: { sshPrivateKey: "private-key" },
    ...overrides,
  };
}

function target(overrides: Partial<ProxmoxDeploymentTargetDto> = {}): ProxmoxDeploymentTargetDto {
  return {
    id: targetId,
    connectionId,
    evidenceConnectionRevision: 4,
    externalId: "pve-home",
    displayName: "Personal Proxmox / pve-home",
    status: "ready",
    capacity: {
      cpu: { totalCores: 16, utilizationRatio: 0.2 },
      memoryBytes: { total: 64_000, available: 48_000 },
      storageBytes: { total: 1_000_000, available: 800_000 },
    },
    capabilities: {
      proxmoxVersion: "8.4.1",
      launchReady: true,
      directRootAccess: true,
      kvmAvailable: true,
      bridges: ["hivra0", "vmbr0"],
      selectedBridge: "hivra0",
      storages: ["local-lvm"],
      selectedStorage: "local-lvm",
      template: null,
      provisioner: {
        configured: true,
        ready: true,
        version: PORTABLE_HIVRA_PROVISIONER_VERSION,
      },
      runtimeCompatibility: {
        ...PORTABLE_HIVRA_RUNTIME_COMPATIBILITY,
        supportedCatalogRuntimeIds: [
          ...PORTABLE_HIVRA_RUNTIME_COMPATIBILITY.supportedCatalogRuntimeIds,
        ],
      },
      vmidRange: { start: 200, end: 399, freeCount: 200, firstAvailable: 200 },
      issues: [],
    },
    supportedIsolationDrivers: ["proxmox-kvm"],
    isolationClass: "hardware-vm",
    lastPreflightAt: now,
    lastErrorCode: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const selection = {
  connectionId,
  targetId,
  expectedConnectionRevision: 4,
};

describe("portable Proxmox execution context", () => {
  it.each(["lifecycle", "teardown"] as const)("rejects a provider VM before network resolution for %s", async purpose => {
    const resolveDestination = jest.fn();
    const provider = providerVmTarget();
    // Even a forged ready/compatibility claim cannot enter the wrong adapter.
    provider.status = "ready";
    provider.capabilities.launchReady = true;
    await expect(resolveSelfManagedProxmoxExecutionContext("user_a", { ...selection, purpose }, {
      loadConnection: jest.fn(async () => connection()),
      getTarget: jest.fn(async () => provider),
      resolveDestination,
    })).rejects.toMatchObject({ code: "target_mismatch" });
    expect(resolveDestination).not.toHaveBeenCalled();
  });
  it.each(["2026.08.26.4", "custom-1", "2099.01.01.1"])(
    "does not infer Simple teardown authority for an unconfigured version %s",
    async (version) => {
      const unconfiguredTarget = target();
      unconfiguredTarget.capabilities.provisioner!.version = version;
      await expect(resolveSelfManagedProxmoxExecutionContext(
        "user_a", { ...selection, purpose: "teardown" }, {
          loadConnection: jest.fn(async () => connection()),
          getTarget: jest.fn(async () => unconfiguredTarget),
          resolveDestination: jest.fn(async () => ({
            hostname: "pve.example.com", address: "203.0.113.20", family: 4 as const,
          })),
        },
      )).rejects.toMatchObject({ code: "target_not_ready" });
    },
  );
  it.each(["2026.08.26.4", "custom-1"])(
    "preserves owner-bound teardown for Advanced bundle %s without admitting lifecycle work",
    async (version) => {
      const configuredConnection = connection({
        setupMode: "advanced",
        configuration: {
          provisioner: { directory: "/opt/hivra/provisioner", expectedVersion: version },
        },
      });
      const configuredTarget = target();
      configuredTarget.capabilities.provisioner!.version = version;
      const dependencies = {
        loadConnection: jest.fn(async () => configuredConnection),
        getTarget: jest.fn(async () => configuredTarget),
        resolveDestination: jest.fn(async () => ({
          hostname: "pve.example.com", address: "203.0.113.20", family: 4 as const,
        })),
      };
      await expect(
        resolveSelfManagedProxmoxExecutionContext("user_a", selection, dependencies),
      ).rejects.toMatchObject({ code: "target_not_ready" });

      configuredConnection.status = "error";
      configuredTarget.status = "unavailable";
      configuredTarget.capabilities.launchReady = false;
      const teardown = await resolveSelfManagedProxmoxExecutionContext(
        "user_a", { ...selection, purpose: "teardown" }, dependencies,
      );
      expect(teardown.runtime.provisionerVersion).toBe(version);
      expect(teardown.connectionRevision).toBe(selection.expectedConnectionRevision);
      expect(teardown.env.PROXMOX_SSH_HOST_FINGERPRINT).toBe("a".repeat(64));

      configuredTarget.capabilities.provisioner!.version = "different-version";
      await expect(
        resolveSelfManagedProxmoxExecutionContext(
          "user_a", { ...selection, purpose: "teardown" }, dependencies,
        ),
      ).rejects.toMatchObject({ code: "target_not_ready" });
    },
  );
  it("pins lifecycle execution to the observed compatible predecessor, not the newest bundle",async()=>{
    const previous=target();previous.capabilities.provisioner!.version="2026.08.26.10";
    previous.capabilities.runtimeCompatibility!.provisionerVersion="2026.08.26.10";
    const result=await resolveSelfManagedProxmoxExecutionContext("user_a",selection,{
      loadConnection:jest.fn(async()=>connection()),getTarget:jest.fn(async()=>previous),
      resolveDestination:jest.fn(async()=>({hostname:"pve.example.com",address:"203.0.113.20",family:4})),
    });
    expect(result.runtime.provisionerVersion).toBe("2026.08.26.10");
  });
  it("builds a fresh pinned environment and portable runtime from one exact target", async () => {
    const result = await resolveSelfManagedProxmoxExecutionContext("user_a", selection, {
      loadConnection: jest.fn(async () => connection()),
      getTarget: jest.fn(async () => target()),
      resolveDestination: jest.fn(async () => ({
        hostname: "pve.example.com",
        address: "203.0.113.20",
        family: 4,
      })),
    });

    expect(result).toMatchObject({
      kind: "self-managed",
      connectionId,
      targetId,
      connectionRevision: 4,
      runtime: {
        node: "pve-home",
        bridge: "hivra0",
        storage: "local-lvm",
        provisionerDirectory: "/opt/hivra/provisioner",
      },
    });
    expect(result.env).toEqual(
      expect.objectContaining({
        HIVRA_USER_INFRA_CONNECTION: "true",
        PROXMOX_SSH_HOST: "203.0.113.20",
        PROXMOX_SSH_PRIVATE_KEY: "private-key",
        PROXMOX_SSH_HOST_FINGERPRINT: "a".repeat(64),
        PROXMOX_NODE: "pve-home",
        PROXMOX_BRIDGE: "hivra0",
        PROXMOX_STORAGE: "local-lvm",
        PROXMOX_VMID_START: "200",
        PROXMOX_VMID_END: "399",
        PROXMOX_PRIVATE_SUBNET_PREFIX: "10.251.20",
        PROXMOX_PRIVATE_GATEWAY: "10.251.20.1",
        PROXMOX_IP_LAST_OCTET_START: "50",
      }),
    );
    expect(result.env).not.toHaveProperty("PROXMOX_SSH_KEY_PATH");
    expect(result.env).not.toHaveProperty("PROXMOX_API_TOKEN");
  });

  it.each([
    ["changed connection", connection({ revision: 5 }), target(), "connection_stale"],
    ["stale evidence", connection(), target({ evidenceConnectionRevision: 3 }), "connection_stale"],
    ["different connection", connection(), target({ connectionId: "33333333-3333-4333-8333-333333333333" }), "target_mismatch"],
    ["unavailable target", connection(), target({ status: "unavailable", capabilities: { ...target().capabilities, launchReady: false }, supportedIsolationDrivers: [], isolationClass: null, lastErrorCode: "PREFLIGHT_SUPERSEDED" }), "target_not_ready"],
  ] as const)("fails closed for %s", async (_label, loadedConnection, loadedTarget, code) => {
    await expect(
      resolveSelfManagedProxmoxExecutionContext("user_a", selection, {
        loadConnection: jest.fn(async () => loadedConnection as LoadedInfrastructureConnection),
        getTarget: jest.fn(async () => loadedTarget as ProxmoxDeploymentTargetDto),
        resolveDestination: jest.fn(async () => ({ hostname: "pve.example.com", address: "203.0.113.20", family: 4 })),
      }),
    ).rejects.toMatchObject<Partial<ProxmoxExecutionContextError>>({ code });
  });

  it("refuses a template-only target because the current Hivra adapter requires its versioned provisioner", async () => {
    await expect(
      resolveSelfManagedProxmoxExecutionContext("user_a", selection, {
        loadConnection: jest.fn(async () => connection()),
        getTarget: jest.fn(async () => target({
          capabilities: {
            ...target().capabilities,
            provisioner: null,
            template: { vmid: 9000, exists: true, isTemplate: true, nameMatches: true, ready: true },
          },
        })),
        resolveDestination: jest.fn(async () => ({ hostname: "pve.example.com", address: "203.0.113.20", family: 4 })),
      }),
    ).rejects.toMatchObject({ code: "target_not_ready" });
  });

  it("allows teardown on degraded readiness while preserving identity, revision, and pinned SSH", async () => {
    const degradedTarget = target({
      status: "unavailable",
      capabilities: { ...target().capabilities, launchReady: false },
      supportedIsolationDrivers: [],
      isolationClass: null,
      lastErrorCode: "PREFLIGHT_SUPERSEDED",
    });
    const result = await resolveSelfManagedProxmoxExecutionContext(
      "user_a",
      { ...selection, purpose: "teardown" },
      {
        loadConnection: jest.fn(async () => connection({ status: "error" })),
        getTarget: jest.fn(async () => degradedTarget),
        resolveDestination: jest.fn(async () => ({
          hostname: "pve.example.com",
          address: "203.0.113.20",
          family: 4,
        })),
      },
    );
    expect(result).toMatchObject({ connectionId, targetId, connectionRevision: 4 });
    expect(result.env.PROXMOX_SSH_HOST_FINGERPRINT).toBe("a".repeat(64));
  });

  it("uses a credential-recovery N+1 key for teardown only while preserving exact N target evidence", async () => {
    const recoveredConnection = connection({
      revision: 5,
      status: "pending",
      pendingBindingRebindFromRevision: 4,
      credentials: { sshPrivateKey: "rotated-private-key" },
    });
    const degradedTarget = target({
      status: "unavailable",
      capabilities: { ...target().capabilities, launchReady: false },
      supportedIsolationDrivers: [],
      isolationClass: null,
      lastErrorCode: "PREFLIGHT_SUPERSEDED",
    });
    const dependencies = {
      loadConnection: jest.fn(async () => recoveredConnection),
      getTarget: jest.fn(async () => degradedTarget),
      resolveDestination: jest.fn(async () => ({
        hostname: "pve.example.com",
        address: "203.0.113.20",
        family: 4 as const,
      })),
    };

    const teardown = await resolveSelfManagedProxmoxExecutionContext(
      "user_a",
      { ...selection, purpose: "teardown" },
      dependencies,
    );
    expect(teardown.connectionRevision).toBe(5);
    expect(teardown.env.PROXMOX_SSH_PRIVATE_KEY).toBe("rotated-private-key");

    await expect(
      resolveSelfManagedProxmoxExecutionContext("user_a", selection, dependencies),
    ).rejects.toMatchObject({ code: "connection_not_ready" });
  });

  it("keeps the exact N teardown bridge across repeated credential-only repair revisions", async () => {
    const repeatedlyRecoveredConnection = connection({
      revision: 6,
      status: "pending",
      pendingBindingRebindFromRevision: 4,
      credentials: { sshPrivateKey: "second-rotated-private-key" },
    });
    const degradedTarget = target({
      status: "unavailable",
      capabilities: { ...target().capabilities, launchReady: false },
      supportedIsolationDrivers: [],
      isolationClass: null,
      lastErrorCode: "PREFLIGHT_SUPERSEDED",
    });

    const teardown = await resolveSelfManagedProxmoxExecutionContext(
      "user_a",
      { ...selection, purpose: "teardown" },
      {
        loadConnection: jest.fn(async () => repeatedlyRecoveredConnection),
        getTarget: jest.fn(async () => degradedTarget),
        resolveDestination: jest.fn(async () => ({
          hostname: "pve.example.com",
          address: "203.0.113.20",
          family: 4,
        })),
      },
    );

    expect(teardown.connectionRevision).toBe(6);
    expect(teardown.env.PROXMOX_SSH_PRIVATE_KEY).toBe("second-rotated-private-key");
  });

  it("rejects a teardown recovery bridge unless the pending old revision is exact", async () => {
    await expect(
      resolveSelfManagedProxmoxExecutionContext(
        "user_a",
        { ...selection, purpose: "teardown" },
        {
          loadConnection: jest.fn(async () => connection({
            revision: 5,
            status: "pending",
            pendingBindingRebindFromRevision: 3,
          })),
          getTarget: jest.fn(async () => target()),
          resolveDestination: jest.fn(async () => ({
            hostname: "pve.example.com",
            address: "203.0.113.20",
            family: 4,
          })),
        },
      ),
    ).rejects.toMatchObject({ code: "connection_stale" });
  });
});
