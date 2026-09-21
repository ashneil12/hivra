jest.mock("server-only", () => ({}));

const mockRpc = jest.fn();

jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: (...args: unknown[]) => mockRpc(...args) },
}));

import {
  beginInfrastructureHostDiscovery,
  completeInfrastructureHostDiscovery,
  HostDiscoveryStoreError,
  releaseInfrastructureHostDiscovery,
} from "../host-discovery-store";
import { HOST_ISOLATION_ENGINE_IDS, type HostDiscoverySnapshot } from "../host-discovery-contracts";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const CONNECTION_ID = "22222222-2222-4222-8222-222222222222";
const OBSERVED_AT = "2026-08-26T12:00:00.000Z";

function snapshot(): HostDiscoverySnapshot {
  return {
    discoveryId: RUN_ID,
    connectionId: CONNECTION_ID,
    connectionRevision: 4,
    connectionProvider: "host",
    contractVersion: 1,
    observedAt: OBSERVED_AT,
    expiresAt: "2026-08-26T12:15:00.000Z",
    hostIdentityDigest: "a".repeat(64),
    host: {
      os: { family: "linux", id: "debian", versionId: "12" },
      kernel: { release: "6.8.0", architecture: "amd64" },
      environment: {
        effectivePrivilege: "root",
        virtualization: "bare-metal",
        cgroupVersion: 2,
        packageManagers: ["apt"],
      },
      capacity: {
        cpu: { logicalCores: 8 },
        memoryBytes: { total: 32_000, available: 24_000 },
        rootStorageBytes: { total: 100_000, available: 70_000 },
      },
      kvm: { devicePresent: true, cpuVirtualization: true },
    },
    engines: HOST_ISOLATION_ENGINE_IDS.map((id) => ({
      id,
      availability: "unavailable" as const,
      supported: false,
      detectedVersion: null,
      unmetRequirements: ["ENGINE_NOT_INSTALLED" as const],
    })),
  };
}

describe("host discovery store", () => {
  beforeEach(() => jest.clearAllMocks());

  it("claims an exact owner, revision, and run through the service RPC", async () => {
    mockRpc.mockResolvedValue({ data: true, error: null });

    await expect(beginInfrastructureHostDiscovery({
      userId: "user_1",
      connectionId: CONNECTION_ID,
      expectedRevision: 4,
      runId: RUN_ID,
    })).resolves.toBe(true);

    expect(mockRpc).toHaveBeenCalledWith("begin_infrastructure_host_discovery", {
      p_user_id: "user_1",
      p_connection_id: CONNECTION_ID,
      p_expected_revision: 4,
      p_run_id: RUN_ID,
    });
  });

  it("persists only a schema-valid snapshot bound to the claimed CAS identity", async () => {
    mockRpc.mockResolvedValue({ data: true, error: null });
    const evidence = snapshot();

    await expect(completeInfrastructureHostDiscovery({
      userId: "user_1",
      connectionId: CONNECTION_ID,
      expectedRevision: 4,
      runId: RUN_ID,
      snapshot: evidence,
    })).resolves.toBe(true);

    expect(mockRpc).toHaveBeenCalledWith("complete_infrastructure_host_discovery", {
      p_user_id: "user_1",
      p_connection_id: CONNECTION_ID,
      p_expected_revision: 4,
      p_run_id: RUN_ID,
      p_observed_at: OBSERVED_AT,
      p_expires_at: "2026-08-26T12:15:00.000Z",
      p_host_identity_digest: "a".repeat(64),
      p_snapshot: evidence,
    });
  });

  it("rejects a mismatched snapshot before any database call", async () => {
    const evidence = snapshot();
    evidence.connectionRevision = 5;

    await expect(completeInfrastructureHostDiscovery({
      userId: "user_1",
      connectionId: CONNECTION_ID,
      expectedRevision: 4,
      runId: RUN_ID,
      snapshot: evidence,
    })).rejects.toEqual(expect.objectContaining({
      name: "HostDiscoveryStoreError",
      code: "invalid_snapshot",
    }));
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("releases only the exact owner, revision, and run", async () => {
    mockRpc.mockResolvedValue({ data: false, error: null });

    await expect(releaseInfrastructureHostDiscovery({
      userId: "user_1",
      connectionId: CONNECTION_ID,
      expectedRevision: 4,
      runId: RUN_ID,
    })).resolves.toBe(false);
    expect(mockRpc).toHaveBeenCalledWith("release_infrastructure_host_discovery", {
      p_user_id: "user_1",
      p_connection_id: CONNECTION_ID,
      p_expected_revision: 4,
      p_run_id: RUN_ID,
    });
  });

  it("maps constraint failures without exposing database messages", async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: "55006", message: "raw database detail" },
    });

    await expect(beginInfrastructureHostDiscovery({
      userId: "user_1",
      connectionId: CONNECTION_ID,
      expectedRevision: 4,
      runId: RUN_ID,
    })).rejects.toEqual(new HostDiscoveryStoreError("database_conflict"));
  });
});
