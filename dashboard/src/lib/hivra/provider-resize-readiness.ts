import "server-only";

import { z } from "zod";
import { createHetznerCloudProjectClient } from "@/lib/hetzner/client";
import { canonicalFirstBootHostKey } from "@/lib/infrastructure/first-boot-enrollment";
import { parseFirstBootOperationScope } from "@/lib/infrastructure/first-boot-operations";
import { loadFirstBootEnrollment } from "@/lib/infrastructure/first-boot-store";
import { inspectProviderShutdownReadiness } from "@/lib/infrastructure/first-boot-ssh";
import { parseProviderShutdownReadiness } from "@/lib/infrastructure/provider-shutdown-readiness";
import { assertServerIdentityMatchesShape } from "@/lib/infrastructure/hetzner-cloud";
import { loadHetznerCloudCapacityBootstrap, loadHetznerCloudConnectionSecret } from "@/lib/infrastructure/hetzner-cloud-store";
import { loadProviderResizeOperation, type ProviderResizeOperationInput, type StoredProviderResizeOperation } from "./provider-agent-resize-store";

type Dependencies = {
  load: typeof loadProviderResizeOperation;
  enrollment: typeof loadFirstBootEnrollment;
  secret: typeof loadHetznerCloudConnectionSecret;
  bootstrap: typeof loadHetznerCloudCapacityBootstrap;
  client: typeof createHetznerCloudProjectClient;
  inspect: typeof inspectProviderShutdownReadiness;
  now(): Date;
  monotonicNow(): number;
};
const defaults: Dependencies = {
  load: loadProviderResizeOperation, enrollment: loadFirstBootEnrollment,
  secret: loadHetznerCloudConnectionSecret, bootstrap: loadHetznerCloudCapacityBootstrap,
  client: createHetznerCloudProjectClient, inspect: inspectProviderShutdownReadiness,
  now: () => new Date(), monotonicNow: () => performance.now(),
};
class ProviderResizeReadinessError extends Error {
  constructor(readonly code: "rejected" | "deadline_expired" | "verification_failed") {
    super("Provider resize readiness failed: " + code);
    this.name = "ProviderResizeReadinessError";
  }
}

function retainedScope(operation: StoredProviderResizeOperation, input: ProviderResizeOperationInput) {
  const { agent, order, target } = operation.authority;
  const action = operation.action;
  if (operation.input.userId !== input.userId || operation.input.agentId !== input.agentId
    || operation.input.operationId !== input.operationId || operation.stage !== "provider_pending"
    || operation.providerPostAttemptedAt === null || operation.shutdownAttemptedAt !== null
    || agent.user_id !== input.userId || agent.id !== input.agentId
    || agent.operation_id !== input.operationId || agent.operation_kind !== "resize"
    || agent.status !== "provisioning" || agent.desired_state !== "stopped"
    || operation.quote.operationId !== input.operationId || operation.quote.agentId !== input.agentId
    || operation.quote.providerServerId !== agent.provider_server_id
    || order.id !== agent.provider_capacity_order_id || target.id !== agent.deployment_target_id
    || !action || action.command !== "change_server_type" || action.status !== "success"
    || action.resources.length !== 1 || action.resources[0].type !== "server"
    || String(action.resources[0].id) !== agent.provider_server_id) {
    throw new ProviderResizeReadinessError("rejected");
  }
  // Only immutable meaning, not another observer's timestamp or progress read.
  return JSON.stringify([input, agent.infrastructure_connection_id, agent.infrastructure_connection_revision,
    agent.provider_capacity_order_id, agent.provider_enrollment_attempt_id, agent.provider_server_id,
    agent.allocation_operation_id, target.id, order.quote_fingerprint_sha256,
    order.server_name, order.provider_labels, order.provider_creation_receipt,
    operation.sourceShapeFingerprint, operation.quote, action.id]);
}

/** Read-only adapter for the retained resize lease. Never accepts an address,
 * key, expected shape or command from a route. The target shape comes from the
 * original resize journal; ordinary enrollment checks still require the current
 * recorded shape and are deliberately not weakened for an in-progress resize.
 * A receipt does not grant shutdown permission or release the lifecycle lease.
 */
export async function inspectProviderResizeReadiness(raw: ProviderResizeOperationInput & { dispatchDeadlineMs: number },
  dependencies: Partial<Dependencies> = {}) {
  const deps = { ...defaults, ...dependencies };
  const request = z.object({ userId: z.string().min(1).max(256), agentId: z.string().uuid(),
    operationId: z.string().uuid(), dispatchDeadlineMs: z.number().finite() }).strict().parse(structuredClone(raw));
  const { dispatchDeadlineMs: deadline, ...input } = request;
  const remaining = deadline - deps.monotonicNow();
  const fence = () => {
    if (deps.monotonicNow() >= deadline) throw new ProviderResizeReadinessError("deadline_expired");
  };
  if (remaining <= 0 || remaining > 30_000) throw new ProviderResizeReadinessError("deadline_expired");
  const operation = structuredClone(await deps.load(input));
  fence();
  const identity = retainedScope(operation, input);
  const { agent, order } = operation.authority;
  const enrollment = await deps.enrollment(order.id, agent.provider_enrollment_attempt_id);
  fence();
  if (!enrollment || enrollment.phase !== "enrolled" || enrollment.providerServerId !== agent.provider_server_id
    || !enrollment.enrolledHostPublicKey || !enrollment.hostFingerprintSha256) {
    throw new ProviderResizeReadinessError("rejected");
  }
  const binding = parseFirstBootOperationScope({ binding: enrollment.challenge.binding,
    providerServerId: enrollment.providerServerId }).binding;
  if (binding.userId !== input.userId || binding.connectionId !== agent.infrastructure_connection_id
    || binding.connectionRevision !== agent.infrastructure_connection_revision || binding.orderId !== order.id
    || binding.attemptId !== agent.provider_enrollment_attempt_id || binding.quoteFingerprint !== order.quote_fingerprint_sha256) {
    throw new ProviderResizeReadinessError("rejected");
  }
  const pin = canonicalFirstBootHostKey(enrollment.enrolledHostPublicKey);
  if (pin.fingerprintSha256 !== enrollment.hostFingerprintSha256) throw new ProviderResizeReadinessError("rejected");
  const connection = await deps.secret(input.userId, binding.connectionId, { requireBoundToken: true });
  fence();
  if (connection.connection.id !== binding.connectionId || connection.connection.status !== "ready"
    || connection.revision !== binding.connectionRevision) throw new ProviderResizeReadinessError("rejected");
  // Start freshness before I/O, never refresh old evidence on return.
  const observedAt = deps.now().toISOString();
  const server = await deps.client(connection.apiToken).getServer(Number(agent.provider_server_id));
  fence();
  const original = order.provider_creation_receipt, target = operation.quote.target;
  if (target.cpuType === null || server.id !== Number(agent.provider_server_id) || server.name !== order.server_name
    || original.serverId !== agent.provider_server_id || server.status !== "running" || server.locked !== false
    || String(server.public_net?.ipv4?.id) !== original.primaryIpv4.id || server.public_net?.ipv4?.ip !== original.primaryIpv4.ip
    || String(server.public_net?.ipv6?.id) !== original.primaryIpv6.id || server.public_net?.ipv6?.ip !== original.primaryIpv6.ip) {
    throw new ProviderResizeReadinessError("rejected");
  }
  try {
    assertServerIdentityMatchesShape(server, order.quote_snapshot, order.provider_labels, {
      serverType: { id: target.serverTypeId, name: target.serverType, architecture: target.architecture,
        cores: target.cores, memoryGb: target.memoryGb, advertisedDiskGb: target.advertisedDiskGb, cpuType: target.cpuType },
      primaryDiskGb: operation.quote.existingDiskGb,
    });
  } catch { throw new ProviderResizeReadinessError("rejected"); }
  const bootstrap = await deps.bootstrap({ userId: binding.userId, connectionId: binding.connectionId,
    expectedRevision: binding.connectionRevision, orderId: binding.orderId,
    idempotencyKey: enrollment.capacityIdempotencyKey, quoteFingerprintSha256: binding.quoteFingerprint });
  fence();
  if (retainedScope(await deps.load(input), input) !== identity) throw new ProviderResizeReadinessError("rejected");
  fence();
  const result = await deps.inspect({ address: original.primaryIpv4.ip, hostPublicKey: pin.publicKey,
    administratorPublicKey: bootstrap.publicKeyOpenSsh, administratorPrivateKey: bootstrap.privateKeyOpenSsh,
    dispatchDeadlineMs: deadline }, { monotonicNow: deps.monotonicNow });
  fence();
  if (result.hostVerified !== true || result.administratorAuthenticated !== true
    || result.hostFingerprintSha256 !== pin.fingerprintSha256) throw new ProviderResizeReadinessError("verification_failed");
  const receipt = parseProviderShutdownReadiness(`HIVRA_SHUTDOWN_READY_V1 ${JSON.stringify(result.receipt)}`);
  if (retainedScope(await deps.load(input), input) !== identity) throw new ProviderResizeReadinessError("rejected");
  fence();
  return { observedAt, hostFingerprintSha256: pin.fingerprintSha256, receipt };
}
