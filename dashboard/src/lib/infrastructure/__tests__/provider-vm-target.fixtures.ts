import type { ProviderVmDeploymentTargetDto } from "../contracts";
import { PORTABLE_HIVRA_PROVIDER_VM_PROVISIONER_VERSION } from "../portable-provisioner-contract";

export function providerVmTarget(): ProviderVmDeploymentTargetDto {
  const now = "2026-08-27T12:00:00.000Z";
  return {
    id: "22222222-2222-4222-8222-222222222222",
    connectionId: "11111111-1111-4111-8111-111111111111",
    evidenceConnectionRevision: 4,
    externalId: "42",
    displayName: "My cloud computer",
    status: "unavailable",
    capacity: {
      cpu: { totalCores: 2, utilizationRatio: null },
      memoryBytes: { total: 4_000_000_000, available: 3_500_000_000 },
      storageBytes: { total: 40_000_000_000, available: 35_000_000_000 },
    },
    capabilities: {
      kind: "provider-vm",
      provider: "hetzner-cloud",
      capacityOrderId: "33333333-3333-4333-8333-333333333333",
      enrollmentAttemptId: "44444444-4444-4444-8444-444444444444",
      hostIdentityDigest: "a".repeat(64),
      allocation: "exclusive-computer",
      launchReady: false,
      provisioner: {
        configured: true, ready: false, version: PORTABLE_HIVRA_PROVIDER_VM_PROVISIONER_VERSION,
        bundleSha256: "b".repeat(64), scopeSha256: "c".repeat(64),
      },
      runtimeCompatibility: null,
    },
    supportedIsolationDrivers: ["provider-vm"],
    isolationClass: "provider-vm",
    lastPreflightAt: now,
    lastErrorCode: "PROVIDER_ADAPTER_UNAVAILABLE",
    createdAt: now,
    updatedAt: now,
  };
}
