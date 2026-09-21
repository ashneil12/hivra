import {
  HOST_DISCOVERY_SNAPSHOT_TTL_MS,
  HOST_ISOLATION_ENGINE_IDS,
  HostDiscoverySnapshotSchema,
  type HostDiscoverySnapshot,
} from "../host-discovery-contracts";

const observedAt = new Date("2026-08-26T12:00:00.000Z");

function snapshot(overrides: Partial<HostDiscoverySnapshot> = {}): HostDiscoverySnapshot {
  return {
    discoveryId: "11111111-1111-4111-8111-111111111111",
    connectionId: "22222222-2222-4222-8222-222222222222",
    connectionRevision: 3,
    connectionProvider: "host",
    contractVersion: 1,
    observedAt: observedAt.toISOString(),
    expiresAt: new Date(observedAt.getTime() + HOST_DISCOVERY_SNAPSHOT_TTL_MS).toISOString(),
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
      availability: id === "proxmox-kvm" ? "installed" : "installable",
      supported: id === "proxmox-kvm",
      detectedVersion: id === "proxmox-kvm" ? "pve-manager/8.4.1" : null,
      unmetRequirements: id === "proxmox-kvm" ? [] : ["RUNTIME_ADAPTER_UNAVAILABLE"],
    })),
    ...overrides,
  };
}

describe("host discovery contracts", () => {
  it("accepts bounded informational capability evidence without a launch-ready field", () => {
    const parsed = HostDiscoverySnapshotSchema.parse(snapshot());

    expect(parsed.engines.find((engine) => engine.id === "proxmox-kvm")).toMatchObject({
      availability: "installed",
      supported: true,
    });
    expect(JSON.stringify(parsed)).not.toContain("launchReady");
    expect(JSON.stringify(parsed)).not.toContain("deploymentTarget");
  });

  it("rejects an unbounded TTL and impossible capacity evidence", () => {
    const invalidTtl = snapshot({ expiresAt: new Date(observedAt.getTime() + 60_000).toISOString() });
    expect(HostDiscoverySnapshotSchema.safeParse(invalidTtl).success).toBe(false);

    const invalidCapacity = snapshot({
      host: {
        ...snapshot().host,
        capacity: {
          ...snapshot().host.capacity,
          memoryBytes: { total: 10, available: 11 },
        },
      },
    });
    expect(HostDiscoverySnapshotSchema.safeParse(invalidCapacity).success).toBe(false);
  });

  it("rejects duplicate engines and requirements", () => {
    const duplicatedEngine = snapshot();
    duplicatedEngine.engines[1] = { ...duplicatedEngine.engines[0] };
    expect(HostDiscoverySnapshotSchema.safeParse(duplicatedEngine).success).toBe(false);

    const duplicatedRequirement = snapshot();
    duplicatedRequirement.engines[1].unmetRequirements = [
      "RUNTIME_ADAPTER_UNAVAILABLE",
      "RUNTIME_ADAPTER_UNAVAILABLE",
    ];
    expect(HostDiscoverySnapshotSchema.safeParse(duplicatedRequirement).success).toBe(false);
  });
});
