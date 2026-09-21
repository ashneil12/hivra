import "server-only";

import { supabaseAdmin } from "@/lib/supabase";
import { ProviderVmDeploymentTargetDtoSchema, type ProviderVmDeploymentTargetDto } from "./contracts";
import { parseFirstBootOperationScope, type FirstBootOperationLease } from "./first-boot-operations";
import { ProviderGuestDiscoverySnapshotSchema, type ProviderGuestDiscoverySnapshot } from "./host-discovery-contracts";
import { providerGuestBundleScopeSha256, type ProviderGuestBundleReceipt } from "./provider-guest-bundle";
import { PORTABLE_HIVRA_PROVISIONER_VERSION } from "./portable-provisioner-contract";
import { firstBootPowerOnAction } from "@/lib/hetzner/first-boot-firewall";
import { getInfrastructureDeploymentTarget } from "./connection-store";

class ProviderComputerPreparationError extends Error {
  constructor(readonly code: "unsupported_environment" | "invalid_evidence" | "checkpoint_failed") {
    super("Provider computer preparation failed: " + code);
    this.name = "ProviderComputerPreparationError";
  }
}

/** Called only after the owner's exact cleanup confirmation. Retirement never
 * deletes a resource and SQL refuses it while an agent or setup lease owns it. */
export async function retireUnusedPreparedProviderComputer(input: {
  userId: string; connectionId: string; expectedRevision: number; orderId: string; providerServerId: string;
}): Promise<boolean> {
  if (!supabaseAdmin) throw new ProviderComputerPreparationError("checkpoint_failed");
  const { data: target, error } = await supabaseAdmin.from("deployment_targets").select("id")
    .eq("user_id", input.userId).eq("connection_id", input.connectionId)
    .eq("evidence_connection_revision", input.expectedRevision).eq("provider_capacity_order_id", input.orderId)
    .eq("external_id", input.providerServerId).maybeSingle();
  if (error) throw new ProviderComputerPreparationError("checkpoint_failed");
  if (!target) return true; // Normal cleanup's own SQL still fences target races.
  const result = await supabaseAdmin.rpc("retire_hivra_provider_target", {
    p_user_id: input.userId, p_connection_id: input.connectionId, p_revision: input.expectedRevision,
    p_target_id: target.id, p_order_id: input.orderId, p_server_id: input.providerServerId,
    p_agent_id: null, p_operation_id: null,
  });
  if (result.error) throw new ProviderComputerPreparationError("checkpoint_failed");
  return result.data === true;
}

/** The provider VM is already the isolation boundary. Never install a nested
 * hypervisor, infer KVM support, or turn a container into a computer implicitly.
 * These are installer prerequisites, not proof of an installed agent. */
export function assertProviderComputerEnvironment(snapshot: ProviderGuestDiscoverySnapshot) {
  const { host } = ProviderGuestDiscoverySnapshotSchema.parse(snapshot);
  const { os, kernel, environment, capacity } = host;
  if (os.family !== "linux" || os.id !== "ubuntu" || os.versionId !== "22.04"
    || kernel.architecture !== "amd64" || environment.effectivePrivilege !== "root"
    || environment.virtualization !== "virtual-machine" || !environment.packageManagers.includes("apt")
    || !capacity.cpu.logicalCores || !capacity.memoryBytes.total || !capacity.memoryBytes.available
    || !capacity.rootStorageBytes.total || !capacity.rootStorageBytes.available) {
    throw new ProviderComputerPreparationError("unsupported_environment");
  }
}

/** Publish installed-bundle evidence, then separately admit the reviewed
 * provider adapter under the SAME first-boot lease. Read back the actual ready
 * row; bundle upload or a provider power acknowledgement alone is insufficient. */
export async function publishPreparedProviderComputer(input: {
  lease: FirstBootOperationLease;
  snapshot: ProviderGuestDiscoverySnapshot;
  receipt: ProviderGuestBundleReceipt;
  powerOnAction: ReturnType<typeof firstBootPowerOnAction>;
}): Promise<ProviderVmDeploymentTargetDto> {
  const { lease, receipt } = structuredClone(input);
  const scope = parseFirstBootOperationScope({ binding: lease.binding, providerServerId: lease.providerServerId });
  const snapshot = ProviderGuestDiscoverySnapshotSchema.parse(input.snapshot);
  const b = scope.binding;
  assertProviderComputerEnvironment(snapshot);
  const power = firstBootPowerOnAction(Number(scope.providerServerId), input.powerOnAction);
  if (power.status !== "success") throw new ProviderComputerPreparationError("invalid_evidence");
  if (snapshot.discoveryId !== lease.leaseId || snapshot.connectionId !== b.connectionId
    || snapshot.connectionRevision !== b.connectionRevision || snapshot.capacityOrderId !== b.orderId
    || snapshot.enrollmentAttemptId !== b.attemptId || snapshot.providerServerId !== scope.providerServerId
    || receipt.version !== 1 || receipt.state !== "bundle_installed"
    || receipt.provisionerVersion !== PORTABLE_HIVRA_PROVISIONER_VERSION
    || receipt.scopeSha256 !== providerGuestBundleScopeSha256(scope)
    || !/^[0-9a-f]{64}$/.test(receipt.bundleSha256)) {
    throw new ProviderComputerPreparationError("invalid_evidence");
  }
  if (!supabaseAdmin) throw new ProviderComputerPreparationError("checkpoint_failed");
  try {
    const { data, error } = await supabaseAdmin.rpc("publish_prepared_provider_computer", {
      p_user_id: b.userId, p_connection_id: b.connectionId, p_revision: b.connectionRevision,
      p_order_id: b.orderId, p_attempt_id: b.attemptId, p_quote: b.quoteFingerprint,
      p_server: scope.providerServerId, p_lease_id: lease.leaseId,
      p_snapshot: snapshot, p_receipt: receipt, p_power_action: power,
    });
    if (error || !data) throw new Error();
    const target = ProviderVmDeploymentTargetDtoSchema.parse(data);
    // Do not accept an unrelated row returned by a stale/mismatched RPC.
    if (target.connectionId !== b.connectionId || target.evidenceConnectionRevision !== b.connectionRevision
      || target.externalId !== scope.providerServerId || target.capabilities.capacityOrderId !== b.orderId
      || target.capabilities.enrollmentAttemptId !== b.attemptId
      || target.capabilities.hostIdentityDigest !== snapshot.hostIdentityDigest
      || target.capabilities.provisioner.bundleSha256 !== receipt.bundleSha256
      || target.capabilities.provisioner.scopeSha256 !== receipt.scopeSha256) throw new Error();
    const admitted = await supabaseAdmin.rpc("admit_prepared_provider_computer", {
      p_user_id: b.userId, p_connection_id: b.connectionId, p_revision: b.connectionRevision,
      p_order_id: b.orderId, p_attempt_id: b.attemptId, p_server: scope.providerServerId,
      p_lease_id: lease.leaseId, p_target_id: target.id, p_receipt: receipt,
    });
    if (admitted.error || admitted.data !== true) throw new Error();
    const ready = ProviderVmDeploymentTargetDtoSchema.parse(await getInfrastructureDeploymentTarget(b.userId, target.id));
    const { launchReady: publishedLaunch, ...publishedCaps } = target.capabilities;
    const { launchReady: admittedLaunch, ...admittedCaps } = ready.capabilities;
    if (publishedLaunch || !admittedLaunch || ready.status !== "ready"
      || ready.id !== target.id || ready.connectionId !== target.connectionId
      || ready.evidenceConnectionRevision !== target.evidenceConnectionRevision || ready.externalId !== target.externalId
      || JSON.stringify(admittedCaps) !== JSON.stringify(publishedCaps)) throw new Error();
    return ready;
  } catch { throw new ProviderComputerPreparationError("checkpoint_failed"); }
}
