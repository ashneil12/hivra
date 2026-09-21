import "server-only";

import { z } from "zod";
import { createHetznerCloudCleanupClient } from "@/lib/hetzner/client";
import { loadHetznerCloudCleanupOrder, loadHetznerCloudConnectionSecret } from "@/lib/infrastructure/hetzner-cloud-store";
import { loadFirstBootOperationForOrder } from "@/lib/infrastructure/first-boot-operations";
import { FIRST_BOOT_RECIPE_VERSION } from "@/lib/infrastructure/first-boot-enrollment";
import { hetznerCleanupManifest } from "@/lib/infrastructure/hetzner-cleanup-policy";
import { loadProviderAgentDeleteContext } from "./provider-agent-delete";
import { supabaseAdmin } from "@/lib/supabase";

const Input = z.object({ userId: z.string().min(1).max(256), agentId: z.string().uuid(), operationId: z.string().uuid() }).strict();
const defaults = {
  load: (...args: Parameters<typeof loadProviderAgentDeleteContext>) => loadProviderAgentDeleteContext(...args),
  order: loadHetznerCloudCleanupOrder,
  boot: loadFirstBootOperationForOrder, secret: loadHetznerCloudConnectionSecret,
  client: createHetznerCloudCleanupClient, now: () => new Date(), monotonicNow: () => performance.now(),
};

/** Read-only prerequisite for recovery of an explicitly deleted, interrupted
 * provider desktop install. Not a desktop cleanup receipt and NOT authority to
 * release an allocation or mark deletion complete. The eventual atomic handoff
 * must recheck this binding and freshness; remaining resources stay separate.
 */
export async function observeAbsentProviderDesktopProvision(
  raw: z.infer<typeof Input>, overrides: Partial<typeof defaults> = {},
) {
  const input = Input.parse(structuredClone(raw)), deps = { ...defaults, ...overrides };
  const owner = { userId: input.userId, agentId: input.agentId };
  const started = deps.monotonicNow();
  const fence = () => {
    const elapsed = deps.monotonicNow() - started;
    if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= 25_000) throw new Error("Provider absence observation expired");
  };
  const agent = await deps.load(owner); fence();
  if (agent.status === "deleted") return null;
  if (agent.id !== input.agentId || agent.user_id !== input.userId || agent.type !== "linux-desktop"
    || agent.computer_profile !== "ubuntu-desktop" || agent.status !== "provisioning"
    || agent.desired_state !== "deleted" || agent.operation_kind !== "provision"
    || agent.operation_id !== input.operationId || agent.allocation_operation_id !== input.operationId) {
    throw new Error("Provider absence authority changed");
  }
  const order = await deps.order(input.userId, agent.infrastructure_connection_id, agent.provider_capacity_order_id); fence();
  if (order.operation.id !== agent.provider_capacity_order_id || order.operation.connectionId !== agent.infrastructure_connection_id
    || order.connectionRevision !== agent.infrastructure_connection_revision || order.operation.providerServerId !== agent.provider_server_id) {
    throw new Error("Provider absence order changed");
  }
  const scope = { binding: { userId: input.userId, connectionId: agent.infrastructure_connection_id,
    connectionRevision: agent.infrastructure_connection_revision, orderId: agent.provider_capacity_order_id,
    quoteFingerprint: order.quoteFingerprintSha256, recipeVersion: FIRST_BOOT_RECIPE_VERSION }, providerServerId: agent.provider_server_id };
  const boot = await deps.boot(scope); fence();
  if (!boot || boot.binding.attemptId !== agent.provider_enrollment_attempt_id) throw new Error("Provider absence enrollment changed");
  const manifest = hetznerCleanupManifest(order, boot);
  const secret = await deps.secret(input.userId, agent.infrastructure_connection_id, { requireBoundToken: true }); fence();
  if (secret.connection.id !== agent.infrastructure_connection_id || secret.connection.status !== "ready"
    || secret.revision !== agent.infrastructure_connection_revision) throw new Error("Provider absence connection changed");
  // Only this client's structured provider not_found result counts. Network,
  // authentication, rate-limit and proxy HTML errors must propagate, not become
  // absence. No delete, guest SSH, bootstrap key or worker restart is performed.
  const server = await deps.client(secret.apiToken).getServer(Number(manifest.resources.server)); fence();
  if (server !== null) return null;
  const observedAt = deps.now().toISOString();
  const current = await deps.load(owner); fence();
  if (JSON.stringify(current) !== JSON.stringify(agent)) throw new Error("Provider absence authority changed");
  const currentSecret = await deps.secret(input.userId, agent.infrastructure_connection_id, { requireBoundToken: true }); fence();
  if (currentSecret.connection.id !== secret.connection.id || currentSecret.connection.status !== "ready"
    || currentSecret.revision !== secret.revision) throw new Error("Provider absence connection changed");
  return { ...input, connectionId: agent.infrastructure_connection_id, connectionRevision: agent.infrastructure_connection_revision,
    targetId: agent.deployment_target_id, orderId: agent.provider_capacity_order_id,
    enrollmentAttemptId: agent.provider_enrollment_attempt_id, serverId: agent.provider_server_id,
    resourceFingerprint: manifest.fingerprint, observedAt };
}

async function recordAbsent(observation: NonNullable<Awaited<ReturnType<typeof observeAbsentProviderDesktopProvision>>>) {
  if (!supabaseAdmin) throw new Error("Provider absence handoff unavailable");
  const { data, error } = await supabaseAdmin.rpc("handoff_hivra_absent_desktop_provision", {
    p_user_id: observation.userId, p_agent_id: observation.agentId, p_operation_id: observation.operationId,
    p_connection_id: observation.connectionId, p_revision: observation.connectionRevision,
    p_target_id: observation.targetId, p_order_id: observation.orderId, p_attempt_id: observation.enrollmentAttemptId,
    p_server_id: observation.serverId, p_observed_at: observation.observedAt,
  });
  if (error || data !== true) throw new Error("Provider absence handoff unverified");
}

/** Re-observe on every explicit continuation; never accept an old browser or
 * caller-supplied observation. SQL commits the original provision handoff only.
 * The normal delete coordinator still removes/verifies remaining resources.
 */
export async function reconcileAbsentProviderDesktopProvision(
  input: z.infer<typeof Input>,
  overrides: Partial<{ observe: typeof observeAbsentProviderDesktopProvision; record: typeof recordAbsent }> = {},
) {
  const deps = { observe: observeAbsentProviderDesktopProvision, record: recordAbsent, ...overrides };
  const observation = await deps.observe(Input.parse(input));
  if (!observation) return false;
  await deps.record(observation);
  return true;
}
