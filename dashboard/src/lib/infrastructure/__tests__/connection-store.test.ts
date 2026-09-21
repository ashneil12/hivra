jest.mock("server-only", () => ({}));

const mockFrom = jest.fn();
const mockRpc = jest.fn();
const mockEncryptSecret = jest.fn<string, [string]>(() => "sealed-bundle");
const mockDecryptSecret = jest.fn<string, [string]>();
const mockNormalizeFingerprint = jest.fn<string, [string]>(() => "a".repeat(64));

jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => mockFrom(...args),
    rpc: (...args: unknown[]) => mockRpc(...args),
  },
}));

jest.mock("@/lib/crypto", () => ({
  encryptSecret: (plaintext: string) => mockEncryptSecret(plaintext),
  decryptSecret: (ciphertext: string) => mockDecryptSecret(ciphertext),
}));

jest.mock("@/lib/services/proxmox-instance-service", () => ({
  normalizeProxmoxSshHostFingerprint: (fingerprint: string) =>
    mockNormalizeFingerprint(fingerprint),
}));

import {
  beginInfrastructureConnectionPreflight,
  beginInfrastructureConnectionPreparation,
  completeInfrastructureConnectionPreflight,
  createInfrastructureConnection,
  deleteInfrastructureConnection,
  forceForgetHetznerCloudConnection,
  getInfrastructureDeploymentTarget,
  InfrastructureConnectionStoreError,
  listInfrastructureConnections,
  listInfrastructureDeploymentTargets,
  loadInfrastructureConnectionSecret,
  invalidateInfrastructureConnectionPreflight,
  recoverExpiredInfrastructureConnectionRun,
  updateInfrastructureConnection,
} from "../connection-store";
import type { ProxmoxConnectionCreate } from "../contracts";
import { PORTABLE_HIVRA_PROVISIONER_VERSION } from "../portable-provisioner-contract";
import { providerVmTarget } from "./provider-vm-target.fixtures";

describe("provider VM target read model", () => {
  function providerRow() {
    const target = providerVmTarget();
    return {
      id: target.id, connection_id: target.connectionId,
      evidence_connection_revision: target.evidenceConnectionRevision,
      external_id: target.externalId, display_name: target.displayName,
      status: target.status, capacity: target.capacity, capabilities: target.capabilities,
      supported_isolation_drivers: target.supportedIsolationDrivers,
      isolation_class: target.isolationClass, last_preflight_at: target.lastPreflightAt,
      last_error_code: target.lastErrorCode, created_at: target.createdAt, updated_at: target.updatedAt,
    };
  }
  it("returns an owner-scoped provider target without Proxmox normalization or credential reads", async () => {
    mockFrom.mockReset(); mockDecryptSecret.mockClear();
    const builder = query({ data: providerRow(), error: null });
    mockFrom.mockReturnValue(builder);
    expect(await getInfrastructureDeploymentTarget("owner", providerVmTarget().id)).toEqual(providerVmTarget());
    expect(builder.eq).toHaveBeenCalledWith("user_id", "owner");
    expect(builder.eq).toHaveBeenCalledWith("id", providerVmTarget().id);
    expect(mockFrom).toHaveBeenCalledTimes(1);
    expect(mockDecryptSecret).not.toHaveBeenCalled();
  });
  it("keeps mixed provider and Proxmox lists structurally distinct", async () => {
    mockFrom.mockReset();
    mockFrom.mockReturnValue(query({ data: [targetRow(), providerRow()], error: null }));
    const targets = await listInfrastructureDeploymentTargets("owner");
    expect(targets[0].capabilities).toHaveProperty("proxmoxVersion");
    expect(targets[1]).toEqual(providerVmTarget());
  });
  it("fails closed on a provider row claiming readiness", async () => {
    mockFrom.mockReset();
    mockFrom.mockReturnValue(query({ data: { ...providerRow(), status: "ready" }, error: null }));
    await expect(getInfrastructureDeploymentTarget("owner", providerVmTarget().id)).rejects.toThrow();
  });
});

type QueryResult = { data: unknown; error: unknown };

function query(result: QueryResult) {
  const builder: Record<string, jest.Mock> & {
    then?: (resolve: (value: QueryResult) => unknown, reject: (reason: unknown) => unknown) => unknown;
  } = {
    select: jest.fn(),
    insert: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    eq: jest.fn(),
    order: jest.fn(),
    limit: jest.fn(),
    single: jest.fn(() => Promise.resolve(result)),
    maybeSingle: jest.fn(() => Promise.resolve(result)),
  };
  for (const method of ["select", "insert", "update", "delete", "eq", "order", "limit"] as const) {
    builder[method].mockReturnValue(builder);
  }
  builder.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  return builder;
}

const connectionId = "11111111-1111-4111-8111-111111111111";
const targetId = "22222222-2222-4222-8222-222222222222";
const now = "2026-08-25T12:00:00.000Z";
const privateKey = [
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "A".repeat(96),
  "-----END OPENSSH PRIVATE KEY-----",
].join("\n");

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: connectionId,
    user_id: "user_a",
    name: "Home Proxmox",
    provider: "proxmox",
    operating_mode: "self-managed",
    setup_mode: "advanced",
    status: "pending",
    ssh_host: "pve.example.com",
    ssh_port: 22,
    ssh_user: "root",
    ssh_host_fingerprint_sha256: "a".repeat(64),
    config: { bridge: "vmbr0" },
    revision: 1,
    preflight_run_id: null,
    preflight_lease_expires_at: null,
    pending_binding_rebind_from_revision: null,
    last_checked_at: null,
    last_error_code: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function targetRow(overrides: Record<string, unknown> = {}) {
  return {
    id: targetId,
    connection_id: connectionId,
    evidence_connection_revision: 3,
    external_id: "pve-01",
    display_name: "Home Proxmox / pve-01",
    status: "unavailable",
    capacity: {
      cpu: { totalCores: 8, utilizationRatio: 0.25 },
      memoryBytes: { total: 32_000, available: 24_000 },
      storageBytes: { total: 20_000, available: 15_000 },
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
      vmidRange: { start: 200, end: 399, freeCount: 200, firstAvailable: 200 },
      issues: [{
        code: "PROVISIONER_UNAVAILABLE",
        message: "No prepared-target template or assets were configured",
      }],
    },
    supported_isolation_drivers: ["proxmox-kvm"],
    isolation_class: "hardware-vm",
    last_preflight_at: now,
    last_error_code: "PROVISIONER_UNAVAILABLE",
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function createInput(): ProxmoxConnectionCreate {
  return {
    name: "Home Proxmox",
    provider: "proxmox",
    operatingMode: "self-managed",
    setupMode: "advanced",
    endpoint: {
      sshHost: "pve.example.com",
      sshPort: 22,
      sshUser: "root",
      sshHostFingerprintSha256: `SHA256:${"A".repeat(43)}`,
    },
    configuration: { bridge: "vmbr0" },
    credentials: { sshPrivateKey: privateKey },
  };
}

function hostCreateInput() {
  return {
    name: "My host",
    provider: "host" as const,
    operatingMode: "self-managed" as const,
    setupMode: "simple" as const,
    endpoint: createInput().endpoint,
    credentials: { sshPrivateKey: privateKey },
  };
}

describe("infrastructure connection store", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEncryptSecret.mockReturnValue("sealed-bundle");
    mockNormalizeFingerprint.mockReturnValue("a".repeat(64));
    mockRpc.mockReset();
  });

  it("creates owner-scoped metadata and a versioned encrypted credential without returning it", async () => {
    const atomicCreateQuery = query({ data: row(), error: null });
    mockRpc.mockReturnValueOnce(atomicCreateQuery);

    const result = await createInfrastructureConnection("user_a", createInput());

    expect(mockNormalizeFingerprint).toHaveBeenCalledWith(
      createInput().endpoint.sshHostFingerprintSha256,
    );
    expect(mockRpc).toHaveBeenCalledWith(
      "create_infrastructure_connection",
      expect.objectContaining({
        p_user_id: "user_a",
        p_setup_mode: "advanced",
        p_ssh_host_fingerprint_sha256: "a".repeat(64),
        p_encrypted_bundle: "sealed-bundle",
      }),
    );
    expect(mockEncryptSecret).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mockEncryptSecret.mock.calls[0][0] as string)).toEqual({
      version: 1,
      sshPrivateKey: privateKey,
    });
    expect(JSON.stringify(result)).not.toContain(privateKey);
    expect(result.credentialsConfigured).toBe(true);
  });

  it("creates a generic host without configuration or deployment authority", async () => {
    const atomicCreateQuery = query({
      data: row({ provider: "host", name: "My host", setup_mode: "simple", config: {} }),
      error: null,
    });
    mockRpc.mockReturnValueOnce(atomicCreateQuery);

    const result = await createInfrastructureConnection("user_a", hostCreateInput());

    expect(mockRpc).toHaveBeenCalledWith(
      "create_host_infrastructure_connection",
      expect.objectContaining({
        p_user_id: "user_a",
        p_name: "My host",
        p_encrypted_bundle: "sealed-bundle",
      }),
    );
    const parameters = mockRpc.mock.calls[0][1] as Record<string, unknown>;
    expect(parameters).not.toHaveProperty("p_config");
    expect(parameters).not.toHaveProperty("p_setup_mode");
    expect(result).toMatchObject({ provider: "host", status: "pending" });
    expect(mockFrom).not.toHaveBeenCalledWith("deployment_targets");
  });

  it("does not insert metadata when credential encryption fails", async () => {
    mockEncryptSecret.mockImplementationOnce(() => {
      throw new Error("encryption unavailable");
    });

    await expect(
      createInfrastructureConnection("user_a", createInput()),
    ).rejects.toThrow("encryption unavailable");
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("surfaces an atomic create failure without attempting compensating writes", async () => {
    const atomicCreateQuery = query({ data: null, error: { code: "XX000" } });
    mockRpc.mockReturnValueOnce(atomicCreateQuery);

    await expect(
      createInfrastructureConnection("user_a", createInput()),
    ).rejects.toMatchObject({ code: "database_error" });
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });

  it("lists only owner-scoped metadata and credential presence", async () => {
    const metadataQuery = query({ data: [row()], error: null });
    const secretQuery = query({ data: [{ connection_id: connectionId }], error: null });
    mockFrom.mockReturnValueOnce(metadataQuery).mockReturnValueOnce(secretQuery);

    const result = await listInfrastructureConnections("user_a");

    expect(metadataQuery.eq).toHaveBeenCalledWith("user_id", "user_a");
    expect(secretQuery.select).toHaveBeenCalledWith("connection_id");
    expect(secretQuery.eq).toHaveBeenCalledWith("user_id", "user_a");
    expect(result).toHaveLength(1);
    expect(result[0].credentialsConfigured).toBe(true);
    expect(JSON.stringify(result)).not.toContain("encrypted_bundle");
  });

  it("rehydrates persisted Hetzner provider failures without inventing SSH metadata", async () => {
    const metadataQuery = query({
      data: [row({
        name: "Personal cloud",
        provider: "hetzner-cloud",
        setup_mode: "simple",
        status: "error",
        ssh_host: null,
        ssh_port: null,
        ssh_user: null,
        ssh_host_fingerprint_sha256: null,
        config: {},
        last_checked_at: now,
        last_error_code: "invalid_credentials",
      })],
      error: null,
    });
    const secretQuery = query({ data: [{ connection_id: connectionId }], error: null });
    mockFrom.mockReturnValueOnce(metadataQuery).mockReturnValueOnce(secretQuery);

    const result = await listInfrastructureConnections("user_a");

    expect(result).toEqual([
      expect.objectContaining({
        provider: "hetzner-cloud",
        status: "error",
        endpoint: null,
        lastErrorCode: "invalid_credentials",
      }),
    ]);
  });

  it("lists sanitized deployment targets by owner and optional connection", async () => {
    const targetQuery = query({ data: [targetRow()], error: null });
    mockFrom.mockReturnValueOnce(targetQuery);

    const result = await listInfrastructureDeploymentTargets("user_a", { connectionId });

    expect(mockFrom).toHaveBeenCalledWith("deployment_targets");
    expect(targetQuery.eq).toHaveBeenCalledWith("user_id", "user_a");
    expect(targetQuery.eq).toHaveBeenCalledWith("connection_id", connectionId);
    const selectedColumns = String(targetQuery.select.mock.calls[0][0]);
    expect(selectedColumns).toContain("evidence_connection_revision");
    expect(selectedColumns).not.toContain("user_id");
    expect(selectedColumns).not.toContain("encrypted_bundle");
    expect(result).toEqual([
      expect.objectContaining({
        id: targetId,
        connectionId,
        evidenceConnectionRevision: 3,
        externalId: "pve-01",
        supportedIsolationDrivers: ["proxmox-kvm"],
        isolationClass: "hardware-vm",
        lastPreflightAt: now,
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain("user_a");
    expect(JSON.stringify(result)).not.toContain("sealed-bundle");
  });

  it("gets a deployment target only through its owner-scoped identity", async () => {
    const targetQuery = query({ data: targetRow(), error: null });
    mockFrom.mockReturnValueOnce(targetQuery);

    const result = await getInfrastructureDeploymentTarget("user_a", targetId);

    expect(targetQuery.eq).toHaveBeenCalledWith("id", targetId);
    expect(targetQuery.eq).toHaveBeenCalledWith("user_id", "user_a");
    expect(result).toMatchObject({ id: targetId, connectionId });
  });

  it("rehydrates legacy evidence without runtime compatibility as preflight-required", async () => {
    const legacyCapabilities: Record<string, unknown> = {
      ...(targetRow().capabilities as Record<string, unknown>),
      launchReady: true,
    };
    delete legacyCapabilities.runtimeCompatibility;
    const targetQuery = query({
      data: targetRow({
        status: "ready",
        capabilities: legacyCapabilities,
        last_error_code: null,
      }),
      error: null,
    });
    mockFrom.mockReturnValueOnce(targetQuery);

    const result = await getInfrastructureDeploymentTarget("user_a", targetId);

    expect(result).toMatchObject({
      status: "unavailable",
      capabilities: {
        launchReady: false,
        runtimeCompatibility: null,
      },
      supportedIsolationDrivers: [],
      isolationClass: null,
      lastErrorCode: "PREFLIGHT_SUPERSEDED",
    });
  });

  it("rehydrates stale versioned compatibility evidence as preflight-required", async () => {
    const staleCapabilities = {
      ...(targetRow().capabilities as Record<string, unknown>),
      launchReady: true,
      provisioner: {
        configured: true,
        ready: true,
        version: "2026.08.26.4",
      },
      runtimeCompatibility: {
        contractVersion: 1,
        provisionerVersion: "2026.08.26.4",
        supportedCatalogRuntimeIds: ["codex"],
      },
    };
    expect(PORTABLE_HIVRA_PROVISIONER_VERSION).not.toBe("2026.08.26.4");
    const targetQuery = query({
      data: targetRow({
        status: "ready",
        capabilities: staleCapabilities,
        last_error_code: null,
      }),
      error: null,
    });
    mockFrom.mockReturnValueOnce(targetQuery);

    const result = await getInfrastructureDeploymentTarget("user_a", targetId);

    expect(result).toMatchObject({
      status: "unavailable",
      capabilities: {
        launchReady: false,
        runtimeCompatibility: null,
      },
      supportedIsolationDrivers: [],
      isolationClass: null,
      lastErrorCode: "PREFLIGHT_SUPERSEDED",
    });
  });

  it("keeps matching compatible predecessor evidence without upgrading its observed version",async()=>{
    const capabilities={...(targetRow().capabilities as Record<string,unknown>),launchReady:true,
      provisioner:{configured:true,ready:true,version:"2026.08.26.10"},runtimeCompatibility:{contractVersion:1,
        provisionerVersion:"2026.08.26.10",supportedCatalogRuntimeIds:["codex"]}};
    mockFrom.mockReturnValueOnce(query({data:targetRow({status:"ready",capabilities,last_error_code:null}),error:null}));
    expect(await getInfrastructureDeploymentTarget("user_a",targetId)).toMatchObject({status:"ready",capabilities:{launchReady:true,
      provisioner:{version:"2026.08.26.10"},runtimeCompatibility:{provisionerVersion:"2026.08.26.10"}}});
    capabilities.runtimeCompatibility.provisionerVersion=PORTABLE_HIVRA_PROVISIONER_VERSION;
    mockFrom.mockReturnValueOnce(query({data:targetRow({status:"ready",capabilities,last_error_code:null}),error:null}));
    expect(await getInfrastructureDeploymentTarget("user_a",targetId)).toMatchObject({status:"unavailable",capabilities:{launchReady:false,runtimeCompatibility:null}});
  });

  it("uses not-found for a cross-owner deployment target lookup", async () => {
    const targetQuery = query({ data: null, error: null });
    mockFrom.mockReturnValueOnce(targetQuery);

    await expect(
      getInfrastructureDeploymentTarget("user_b", targetId),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(targetQuery.eq).toHaveBeenCalledWith("user_id", "user_b");
  });

  it("rejects Advanced overrides when the merged PATCH mode remains Simple", async () => {
    const existingQuery = query({
      data: row({ setup_mode: "simple", config: {} }),
      error: null,
    });
    mockFrom.mockReturnValueOnce(existingQuery);

    await expect(
      updateInfrastructureConnection("user_a", connectionId, {
        configuration: { bridge: "vmbr0" },
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(existingQuery.eq).toHaveBeenCalledWith("user_id", "user_a");
    expect(mockFrom).toHaveBeenCalledTimes(1);
  });

  it("clears stale Advanced config when PATCH switches to Simple", async () => {
    const existingQuery = query({ data: row(), error: null });
    const updatedQuery = query({
      data: row({ setup_mode: "simple", config: {} }),
      error: null,
    });
    const secretPresenceQuery = query({ data: { connection_id: connectionId }, error: null });
    mockFrom.mockReturnValueOnce(existingQuery).mockReturnValueOnce(secretPresenceQuery);
    mockRpc.mockReturnValueOnce(updatedQuery);

    const result = await updateInfrastructureConnection("user_a", connectionId, {
      setupMode: "simple",
    });

    expect(mockRpc).toHaveBeenCalledWith(
      "update_infrastructure_connection",
      expect.objectContaining({
        p_user_id: "user_a",
        p_expected_revision: 1,
        p_patch: expect.objectContaining({ setup_mode: "simple", config: {} }),
        p_operational_change: true,
      }),
    );
    expect(result.setupMode).toBe("simple");
    expect(result.configuration).toBeNull();
  });

  it("revises only capacity policy through the binding-preserving RPC", async () => {
    const currentPolicy = {
      mode: "observe" as const,
      hostMemoryReserveMb: 2048,
      cpuCeilingDensity: 1,
      memoryCeilingDensity: 1,
    };
    const requestedPolicy = {
      ...currentPolicy,
      mode: "enforce" as const,
      cpuCeilingDensity: 2,
    };
    const existingQuery = query({
      data: row({
        status: "ready",
        revision: 7,
        config: { storage: "local-lvm", capacityPolicy: currentPolicy, bridge: "vmbr0" },
      }),
      error: null,
    });
    const secretPresenceQuery = query({ data: { connection_id: connectionId }, error: null });
    const updatedQuery = query({
      data: row({
        status: "pending",
        revision: 8,
        pending_binding_rebind_from_revision: 7,
        config: { bridge: "vmbr0", storage: "local-lvm", capacityPolicy: requestedPolicy },
      }),
      error: null,
    });
    mockFrom.mockReturnValueOnce(existingQuery).mockReturnValueOnce(secretPresenceQuery);
    mockRpc.mockReturnValueOnce(updatedQuery);

    const result = await updateInfrastructureConnection("user_a", connectionId, {
      configuration: {
        bridge: "vmbr0",
        storage: "local-lvm",
        capacityPolicy: requestedPolicy,
      },
    });

    expect(mockRpc).toHaveBeenCalledWith("update_infrastructure_capacity_policy", {
      p_user_id: "user_a",
      p_connection_id: connectionId,
      p_expected_revision: 7,
      p_capacity_policy: requestedPolicy,
    });
    expect(result).toMatchObject({
      status: "pending",
      configuration: { capacityPolicy: requestedPolicy },
    });
  });

  it("keeps placement changes on the endpoint-guarded operational update path", async () => {
    const policy = {
      mode: "enforce" as const,
      hostMemoryReserveMb: 2048,
      cpuCeilingDensity: 2,
      memoryCeilingDensity: 1,
    };
    mockFrom
      .mockReturnValueOnce(query({ data: row({ config: { bridge: "vmbr0" } }), error: null }))
      .mockReturnValueOnce(query({ data: { connection_id: connectionId }, error: null }));
    mockRpc.mockReturnValueOnce(query({
      data: row({ config: { bridge: "vmbr1", capacityPolicy: policy }, revision: 2 }),
      error: null,
    }));

    await updateInfrastructureConnection("user_a", connectionId, {
      configuration: { bridge: "vmbr1", capacityPolicy: policy },
    });

    expect(mockRpc).toHaveBeenCalledWith(
      "update_infrastructure_connection",
      expect.objectContaining({
        p_operational_change: true,
        p_patch: { config: { bridge: "vmbr1", capacityPolicy: policy } },
      }),
    );
  });

  it("does not commit a PATCH when credential-presence lookup fails", async () => {
    const existingQuery = query({ data: row(), error: null });
    const failedPresenceQuery = query({ data: null, error: { code: "XX000" } });
    mockFrom.mockReturnValueOnce(existingQuery).mockReturnValueOnce(failedPresenceQuery);

    await expect(
      updateInfrastructureConnection("user_a", connectionId, { name: "Renamed" }),
    ).rejects.toMatchObject({ code: "database_error" });

    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("validates metadata before rotating a credential and scopes both updates", async () => {
    const existingQuery = query({ data: row(), error: null });
    const updatedQuery = query({ data: row({ name: "Renamed" }), error: null });
    mockFrom.mockReturnValueOnce(existingQuery);
    mockRpc.mockReturnValueOnce(updatedQuery);

    await updateInfrastructureConnection("user_a", connectionId, {
      name: "Renamed",
      credentials: { sshPrivateKey: privateKey },
    });

    expect(mockFrom.mock.calls.map((call) => call[0])).toEqual([
      "infrastructure_connections",
    ]);
    expect(mockRpc).toHaveBeenCalledWith(
      "update_infrastructure_connection",
      expect.objectContaining({
        p_expected_revision: 1,
        p_rotate_credentials: true,
        p_encrypted_bundle: "sealed-bundle",
      }),
    );
  });

  it("preserves readiness and the configuration revision for a name-only atomic PATCH", async () => {
    const existingQuery = query({
      data: row({ status: "ready", revision: 7, last_checked_at: now }),
      error: null,
    });
    const updatedQuery = query({
      data: row({ name: "Renamed", status: "ready", revision: 7, last_checked_at: now }),
      error: null,
    });
    const secretPresenceQuery = query({ data: { connection_id: connectionId }, error: null });
    mockFrom.mockReturnValueOnce(existingQuery).mockReturnValueOnce(secretPresenceQuery);
    mockRpc.mockReturnValueOnce(updatedQuery);

    const result = await updateInfrastructureConnection("user_a", connectionId, {
      name: "Renamed",
    });

    expect(mockRpc).toHaveBeenCalledWith(
      "update_infrastructure_connection",
      expect.objectContaining({
        p_expected_revision: 7,
        p_patch: { name: "Renamed" },
        p_operational_change: false,
        p_rotate_credentials: false,
      }),
    );
    expect(result).toMatchObject({ name: "Renamed", status: "ready", lastCheckedAt: now });
  });

  it("recovers an exact expired preparation lease before updating", async () => {
    const expiredRunId = "22222222-2222-4222-8222-222222222222";
    const existingQuery = query({
      data: row({
        revision: 7,
        preflight_run_id: expiredRunId,
        preflight_lease_expires_at: "2020-01-01T00:00:00.000Z",
      }),
      error: null,
    });
    const secretPresenceQuery = query({ data: { connection_id: connectionId }, error: null });
    const updatedQuery = query({ data: row({ revision: 7, name: "Recovered" }), error: null });
    mockFrom.mockReturnValueOnce(existingQuery).mockReturnValueOnce(secretPresenceQuery);
    mockRpc
      .mockResolvedValueOnce({ data: true, error: null })
      .mockReturnValueOnce(updatedQuery);

    await expect(
      updateInfrastructureConnection("user_a", connectionId, { name: "Recovered" }),
    ).resolves.toMatchObject({ name: "Recovered" });
    expect(mockRpc.mock.calls).toEqual([
      ["recover_expired_infrastructure_connection_run", expect.objectContaining({
        p_expected_revision: 7,
        p_expected_run_id: expiredRunId,
      })],
      ["update_infrastructure_connection", expect.objectContaining({
        p_expected_revision: 7,
        p_operational_change: false,
      })],
    ]);
  });

  it("does not rotate the credential when the metadata update conflicts", async () => {
    const existingQuery = query({ data: row(), error: null });
    const conflictingUpdateQuery = query({ data: null, error: { code: "23505" } });
    mockFrom.mockReturnValueOnce(existingQuery);
    mockRpc.mockReturnValueOnce(conflictingUpdateQuery);

    await expect(
      updateInfrastructureConnection("user_a", connectionId, {
        name: "Duplicate name",
        credentials: { sshPrivateKey: privateKey },
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    expect(mockFrom.mock.calls.map((call) => call[0])).toEqual([
      "infrastructure_connections",
    ]);
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });

  it("reports a missing credential invariant as credential_error rather than target conflict", async () => {
    const existingQuery = query({ data: row(), error: null });
    const missingSecretQuery = query({ data: null, error: { code: "P0002" } });
    mockFrom.mockReturnValueOnce(existingQuery);
    mockRpc.mockReturnValueOnce(missingSecretQuery);

    await expect(
      updateInfrastructureConnection("user_a", connectionId, {
        credentials: { sshPrivateKey: privateKey },
      }),
    ).rejects.toMatchObject({ code: "credential_error" });
  });

  it("uses the credential-only recovery RPC without changing endpoint identity", async () => {
    const existingQuery = query({ data: row({ status: "error", revision: 7 }), error: null });
    const recoveredQuery = query({ data: row({ status: "pending", revision: 8 }), error: null });
    mockFrom.mockReturnValueOnce(existingQuery);
    mockRpc.mockReturnValueOnce(recoveredQuery);

    const result = await updateInfrastructureConnection("user_a", connectionId, {
      credentials: { sshPrivateKey: privateKey },
    });

    expect(mockRpc).toHaveBeenCalledWith(
      "recover_infrastructure_connection_credentials",
      expect.objectContaining({
        p_user_id: "user_a",
        p_connection_id: connectionId,
        p_expected_revision: 7,
        p_encrypted_bundle: "sealed-bundle",
      }),
    );
    expect(result).toMatchObject({ status: "pending", credentialsConfigured: true });
  });

  it("deletes a connection through the lease-serializing RPC", async () => {
    mockFrom.mockReturnValueOnce(query({ data: row(), error: null }));
    mockRpc.mockResolvedValueOnce({ data: "deleted", error: null });

    await expect(
      deleteInfrastructureConnection("user_a", connectionId),
    ).resolves.toBeUndefined();
    expect(mockRpc).toHaveBeenCalledWith("delete_infrastructure_connection", {
      p_user_id: "user_a",
      p_connection_id: connectionId,
    });
  });

  it("maps an active preparation lease on delete to conflict", async () => {
    mockFrom.mockReturnValueOnce(query({
      data: row({
        preflight_run_id: "22222222-2222-4222-8222-222222222222",
        preflight_lease_expires_at: "2999-08-25T12:10:00.000Z",
      }),
      error: null,
    }));
    mockRpc.mockResolvedValueOnce({ data: "blocked", error: null });
    await expect(deleteInfrastructureConnection("user_a", connectionId)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("maps an in-flight Hetzner capacity deletion lock to a stable busy code", async () => {
    mockFrom.mockReturnValueOnce(query({ data: row(), error: null }));
    mockRpc.mockResolvedValueOnce({ data: "capacity_busy", error: null });

    await expect(deleteInfrastructureConnection("user_a", connectionId)).rejects.toMatchObject({
      code: "capacity_busy",
    });
    expect(mockRpc).toHaveBeenCalledWith("delete_infrastructure_connection", {
      p_user_id: "user_a",
      p_connection_id: connectionId,
    });
  });

  it("distinguishes idle ambiguity that requires explicit force-forget", async () => {
    mockFrom.mockReturnValueOnce(query({ data: row(), error: null }));
    mockRpc.mockResolvedValueOnce({
      data: "capacity_force_forget_required",
      error: null,
    });

    await expect(deleteInfrastructureConnection("user_a", connectionId)).rejects.toMatchObject({
      code: "capacity_force_forget_required",
    });
  });

  it("force-forgets only through the dedicated owner-scoped RPC", async () => {
    mockRpc.mockResolvedValueOnce({ data: "forgotten", error: null });

    await expect(
      forceForgetHetznerCloudConnection("user_a", connectionId),
    ).resolves.toBeUndefined();
    expect(mockRpc).toHaveBeenCalledWith(
      "force_forget_hetzner_cloud_connection",
      { p_user_id: "user_a", p_connection_id: connectionId },
    );
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it.each([
    ["capacity_busy", "capacity_busy"],
    ["not_ambiguous", "force_forget_not_available"],
  ] as const)("maps force-forget disposition %s without deleting optimistically", async (
    disposition,
    expectedCode,
  ) => {
    mockRpc.mockResolvedValueOnce({ data: disposition, error: null });

    await expect(
      forceForgetHetznerCloudConnection("user_a", connectionId),
    ).rejects.toMatchObject({ code: expectedCode });
  });

  it("recovers an exact expired preparation lease before deleting", async () => {
    const expiredRunId = "22222222-2222-4222-8222-222222222222";
    mockFrom.mockReturnValueOnce(query({
      data: row({
        revision: 7,
        preflight_run_id: expiredRunId,
        preflight_lease_expires_at: "2020-01-01T00:00:00.000Z",
      }),
      error: null,
    }));
    mockRpc
      .mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({ data: "deleted", error: null });

    await expect(deleteInfrastructureConnection("user_a", connectionId)).resolves.toBeUndefined();
    expect(mockRpc.mock.calls).toEqual([
      ["recover_expired_infrastructure_connection_run", expect.objectContaining({
        p_expected_revision: 7,
        p_expected_run_id: expiredRunId,
      })],
      ["delete_infrastructure_connection", {
        p_user_id: "user_a",
        p_connection_id: connectionId,
      }],
    ]);
  });

  it("loads and validates a decrypted bundle only through the server-only owner path", async () => {
    const existingQuery = query({ data: row(), error: null });
    const secretQuery = query({
      data: {
        connection_id: connectionId,
        encrypted_bundle: "sealed-bundle",
        key_version: 1,
      },
      error: null,
    });
    mockFrom.mockReturnValueOnce(existingQuery).mockReturnValueOnce(secretQuery);
    mockDecryptSecret.mockReturnValueOnce(JSON.stringify({ version: 1, sshPrivateKey: privateKey }));

    const loaded = await loadInfrastructureConnectionSecret("user_a", connectionId);

    expect(secretQuery.eq).toHaveBeenCalledWith("connection_id", connectionId);
    expect(secretQuery.eq).toHaveBeenCalledWith("user_id", "user_a");
    expect(loaded.credentials.sshPrivateKey).toBe(privateKey);
    expect(loaded.revision).toBe(1);
  });

  it("uses owner, revision, and run leases for atomic preflight persistence", async () => {
    mockFrom.mockReturnValueOnce(query({ data: row({ revision: 4 }), error: null }));
    mockRpc
      .mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({ data: true, error: null });

    await expect(
      beginInfrastructureConnectionPreflight("user_a", connectionId, 4, "run-1", now),
    ).resolves.toBe(true);
    await expect(
      completeInfrastructureConnectionPreflight("user_a", connectionId, 4, "run-1", {
        connectionStatus: "ready",
        checkedAt: now,
        lastErrorCode: null,
        target: null,
      }),
    ).resolves.toBe(true);
    await expect(
      invalidateInfrastructureConnectionPreflight(
        "user_a",
        connectionId,
        4,
        now,
        "INVALID_CONNECTION",
      ),
    ).resolves.toBe(true);

    expect(mockRpc.mock.calls).toEqual([
      [
        "begin_infrastructure_connection_preflight",
        expect.objectContaining({
          p_user_id: "user_a",
          p_connection_id: connectionId,
          p_expected_revision: 4,
          p_run_id: "run-1",
        }),
      ],
      [
        "complete_infrastructure_connection_preflight",
        expect.objectContaining({
          p_user_id: "user_a",
          p_expected_revision: 4,
          p_run_id: "run-1",
        }),
      ],
      [
        "invalidate_infrastructure_connection_preflight",
        expect.objectContaining({
          p_user_id: "user_a",
          p_expected_revision: 4,
          p_last_error_code: "INVALID_CONNECTION",
        }),
      ],
    ]);
  });

  it("claims preparation and recovers only an exact expired run lease", async () => {
    mockFrom.mockReturnValueOnce(query({ data: row({ revision: 4 }), error: null }));
    mockRpc
      .mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({ data: true, error: null });

    await expect(
      beginInfrastructureConnectionPreparation("user_a", connectionId, 4, "run-1", now),
    ).resolves.toBe(true);
    await expect(recoverExpiredInfrastructureConnectionRun({
      userId: "user_a",
      connectionId,
      expectedRevision: 4,
      expectedRunId: "run-1",
      recoveredAt: "2026-08-25T12:11:00.000Z",
    })).resolves.toBe(true);

    expect(mockRpc.mock.calls).toEqual([
      ["begin_infrastructure_connection_preparation", expect.objectContaining({ p_run_id: "run-1" })],
      ["recover_expired_infrastructure_connection_run", expect.objectContaining({
        p_expected_revision: 4,
        p_expected_run_id: "run-1",
      })],
    ]);
  });

  it.each([
    ["preflight", beginInfrastructureConnectionPreflight, "begin_infrastructure_connection_preflight"],
    ["preparation", beginInfrastructureConnectionPreparation, "begin_infrastructure_connection_preparation"],
  ] as const)(
    "recovers an exactly observed expired foreign %s lease before acquiring a new one",
    async (_kind, begin, beginRpcName) => {
      const foreignRunId = "22222222-2222-4222-8222-222222222222";
      const newRunId = "33333333-3333-4333-8333-333333333333";
      mockFrom.mockReturnValueOnce(query({
        data: row({
          revision: 4,
          preflight_run_id: foreignRunId,
          preflight_lease_expires_at: "2026-08-25T11:59:59.000Z",
        }),
        error: null,
      }));
      mockRpc
        .mockResolvedValueOnce({ data: true, error: null })
        .mockResolvedValueOnce({ data: true, error: null });

      await expect(
        begin("user_a", connectionId, 4, newRunId, now),
      ).resolves.toBe(true);

      expect(mockRpc.mock.calls).toEqual([
        ["recover_expired_infrastructure_connection_run", expect.objectContaining({
          p_expected_revision: 4,
          p_expected_run_id: foreignRunId,
          p_recovered_at: now,
        })],
        [beginRpcName, expect.objectContaining({ p_run_id: newRunId })],
      ]);
    },
  );

  it("does not time-take-over a live foreign preparation lease", async () => {
    mockFrom.mockReturnValueOnce(query({
      data: row({
        revision: 4,
        preflight_run_id: "22222222-2222-4222-8222-222222222222",
        preflight_lease_expires_at: "2026-08-25T12:00:01.000Z",
      }),
      error: null,
    }));

    await expect(
      beginInfrastructureConnectionPreparation(
        "user_a",
        connectionId,
        4,
        "33333333-3333-4333-8333-333333333333",
        now,
      ),
    ).resolves.toBe(false);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("does not acquire after exact expired-run recovery loses its CAS", async () => {
    mockFrom.mockReturnValueOnce(query({
      data: row({
        revision: 4,
        preflight_run_id: "22222222-2222-4222-8222-222222222222",
        preflight_lease_expires_at: "2026-08-25T11:59:59.000Z",
      }),
      error: null,
    }));
    mockRpc.mockResolvedValueOnce({ data: false, error: null });

    await expect(
      beginInfrastructureConnectionPreflight(
        "user_a",
        connectionId,
        4,
        "33333333-3333-4333-8333-333333333333",
        now,
      ),
    ).resolves.toBe(false);
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith(
      "recover_expired_infrastructure_connection_run",
      expect.any(Object),
    );
  });

  it("uses not-found for a cross-owner connection lookup", async () => {
    const existingQuery = query({ data: null, error: null });
    mockFrom.mockReturnValueOnce(existingQuery);

    await expect(
      loadInfrastructureConnectionSecret("user_b", connectionId),
    ).rejects.toBeInstanceOf(InfrastructureConnectionStoreError);
    expect(existingQuery.eq).toHaveBeenCalledWith("user_id", "user_b");
    expect(mockFrom).toHaveBeenCalledTimes(1);
  });
});
