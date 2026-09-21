import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase";
import { loadHetznerCloudCleanupOrder } from "@/lib/infrastructure/hetzner-cloud-store";
import { loadFirstBootOperationForOrder } from "@/lib/infrastructure/first-boot-operations";
import { FIRST_BOOT_RECIPE_VERSION } from "@/lib/infrastructure/first-boot-enrollment";
import { advanceHetznerCleanup } from "@/lib/infrastructure/hetzner-cleanup";
import { hetznerCleanupManifest } from "@/lib/infrastructure/hetzner-cleanup-policy";
import { HETZNER_FIRST_BOOT_CLEANUP_CONFIRMATION } from "@/lib/infrastructure/hetzner-cleanup-contracts";
import { advanceProviderAgentInstaller } from "./provider-agent-installer";
import { advanceProviderNativeInstaller } from "./provider-native-installer";
import { advanceProviderDesktopInstaller } from "./provider-desktop-installer";
import { reconcileAbsentProviderDesktopProvision } from "./provider-provision-absence";
import { advanceProviderAgentPower } from "./provider-agent-power";
import { advanceProviderResize, reconcileAbsentProviderResizeForDelete } from "./provider-agent-resize";
import { completeHivraAgentDelete, recordHivraAgentOperationFailure, releaseHivraAgentOperation,
  requestHivraAgentDelete } from "./agent-operation-store";
import { SELF_MANAGED_HIVRA_PROXMOX_HOST_SENTINEL } from "./agent-authority";

const Uuid = z.string().uuid();
const Owner = z.object({ userId: z.string().min(1).max(256), agentId: Uuid }).strict();
const Active = z.object({
  id: Uuid, user_id: z.string(), computer_substrate: z.literal("provider-vm"),
  type: z.string().min(1).max(80),
  computer_profile: z.unknown().optional(),
  deployment_mode: z.literal("self-managed"), proxmox_host: z.literal(SELF_MANAGED_HIVRA_PROXMOX_HOST_SENTINEL),
  vmid: z.null(), status: z.enum(["provisioning", "running", "stopped", "error"]),
  desired_state: z.enum(["running", "stopped", "deleted"]),
  operation_id: Uuid.nullable(), operation_kind: z.enum(["provision", "delete", "start", "stop", "restart", "resize"]).nullable(),
  allocation_operation_id: Uuid, infrastructure_connection_id: Uuid,
  infrastructure_connection_revision: z.number().int().positive().safe(), deployment_target_id: Uuid,
  provider_capacity_order_id: Uuid, provider_enrollment_attempt_id: Uuid,
  provider_server_id: z.string().regex(/^[1-9][0-9]*$/),
});
const SELECT = Object.keys(Active.shape).join(",");
type ActiveAgent = z.infer<typeof Active>;
type OwnerInput = z.infer<typeof Owner>;
type DeleteOperation = OwnerInput & { operationId: string };

export class ProviderAgentDeleteError extends Error {
  constructor(readonly code: "authority_changed" | "receipts_unavailable" | "cleanup_needs_attention" | "operation_unconfirmed") {
    super("Provider computer removal could not continue: " + code);
    this.name = "ProviderAgentDeleteError";
  }
}

/** Read only the existing owner-bound agent identity. Never infer a provider
 * server from a VMID, name, browser field, or a managed fleet credential. */
export async function loadProviderAgentDeleteContext(input: OwnerInput): Promise<ActiveAgent | { status: "deleted" }> {
  try {
    const owner = Owner.parse(input);
    if (!supabaseAdmin) throw new Error();
    const { data, error } = await supabaseAdmin.from("hivra_agents").select(SELECT)
      .eq("user_id", owner.userId).eq("id", owner.agentId).eq("computer_substrate", "provider-vm").maybeSingle();
    if (error || !data) throw new Error();
    const identity = z.object({ id: Uuid, user_id: z.string(), computer_substrate: z.literal("provider-vm"), status: z.string() }).parse(data);
    if (identity.id !== owner.agentId || identity.user_id !== owner.userId) throw new Error();
    if (identity.status === "deleted") return { status: "deleted" };
    return Active.parse(data);
  } catch { throw new ProviderAgentDeleteError("authority_changed"); }
}

async function retire(op: DeleteOperation, agent: ActiveAgent) {
  if (!supabaseAdmin) throw new ProviderAgentDeleteError("authority_changed");
  const { data, error } = await supabaseAdmin.rpc("retire_hivra_provider_target", {
    p_user_id: op.userId, p_agent_id: op.agentId, p_operation_id: op.operationId,
    p_connection_id: agent.infrastructure_connection_id, p_revision: agent.infrastructure_connection_revision,
    p_target_id: agent.deployment_target_id, p_order_id: agent.provider_capacity_order_id,
    p_server_id: agent.provider_server_id,
  });
  if (error) throw new ProviderAgentDeleteError("authority_changed");
  return data === true;
}

type Dependencies = {
  load: typeof loadProviderAgentDeleteContext; request: typeof requestHivraAgentDelete;
  installer: typeof advanceProviderAgentInstaller; release: typeof releaseHivraAgentOperation;
  nativeInstaller: typeof advanceProviderNativeInstaller;
  desktopInstaller: typeof advanceProviderDesktopInstaller;
  absentDesktop: typeof reconcileAbsentProviderDesktopProvision;
  power: typeof advanceProviderAgentPower;
  resize: typeof advanceProviderResize;
  absentResize: typeof reconcileAbsentProviderResizeForDelete;
  order: typeof loadHetznerCloudCleanupOrder; boot: typeof loadFirstBootOperationForOrder;
  retire: typeof retire; cleanup: typeof advanceHetznerCleanup; complete: typeof completeHivraAgentDelete;
  failure: typeof recordHivraAgentOperationFailure; newId: () => string;
};
const defaults: Dependencies = { load: loadProviderAgentDeleteContext, request: requestHivraAgentDelete,
  installer: advanceProviderAgentInstaller, nativeInstaller: advanceProviderNativeInstaller,
  desktopInstaller: advanceProviderDesktopInstaller,
  absentDesktop: reconcileAbsentProviderDesktopProvision,
  power: advanceProviderAgentPower, resize: advanceProviderResize, absentResize: reconcileAbsentProviderResizeForDelete,
  release: releaseHivraAgentOperation, order: loadHetznerCloudCleanupOrder,
  boot: loadFirstBootOperationForOrder, retire, cleanup: advanceHetznerCleanup, complete: completeHivraAgentDelete,
  failure: recordHivraAgentOperationFailure, newId: randomUUID };

export type ProviderAgentDeleteResult =
  | { ok: true }
  | { ok: false; pending: true; stage: "installer_stopping" | "operation_finishing" | "provider_cleanup" | "access_cleanup" };

/** Adapter for an explicit DELETE on the existing agent endpoint. One call
 * requests cancellation, observes one worker, or advances one original cleanup
 * step. It never launches a replacement, broadens the resource manifest, or
 * treats an HTTP acknowledgement/null VMID as provider absence.
 *
 * The original agent delete operation remains held across partial results.
 * Its existing order cleanup lease serializes each provider mutation. Access
 * cleanup and terminal deletion use the shared finalizer only after all five
 * resource absences are persisted and independently checked again by SQL. */
export async function advanceProviderAgentDelete(input: OwnerInput, dependencies: Partial<Dependencies> = {}): Promise<ProviderAgentDeleteResult> {
  const owner = Owner.parse(structuredClone(input)), deps = { ...defaults, ...dependencies };
  let operation: DeleteOperation | null = null;
  try {
    // Validate provider ownership before changing desired state.
    const initial = await deps.load(owner);
    if (initial.status === "deleted") return { ok: true };
    if (initial.type === "linux-desktop" && initial.operation_kind === "provision" && initial.computer_profile !== "ubuntu-desktop") {
      throw new ProviderAgentDeleteError("authority_changed");
    }
    const proposed = Uuid.parse(deps.newId());
    const disposition = await deps.request({ ...owner, operationId: proposed });
    if (disposition === "deleted") return { ok: true };
    if (disposition === "not_found") throw new ProviderAgentDeleteError("authority_changed");
    let agent = await deps.load(owner);
    if (agent.status === "deleted") return { ok: true };
    if (agent.id !== initial.id || agent.user_id !== owner.userId || agent.type !== initial.type || agent.computer_profile !== initial.computer_profile
      || agent.allocation_operation_id !== initial.allocation_operation_id || agent.provider_capacity_order_id !== initial.provider_capacity_order_id
      || agent.deployment_target_id !== initial.deployment_target_id || agent.provider_server_id !== initial.provider_server_id
      || agent.provider_enrollment_attempt_id !== initial.provider_enrollment_attempt_id
      || agent.infrastructure_connection_id !== initial.infrastructure_connection_id
      || agent.infrastructure_connection_revision !== initial.infrastructure_connection_revision
      || agent.desired_state !== "deleted" || (disposition === "claimed" && agent.operation_id !== proposed)) {
      throw new ProviderAgentDeleteError("authority_changed");
    }
    if (!agent.operation_id) return { ok: false, pending: true, stage: "operation_finishing" };
    operation = { ...owner, operationId: agent.operation_id };
    let retainedDesktopProvision = false;
    if (agent.operation_kind === "provision") {
      if (agent.allocation_operation_id !== agent.operation_id || agent.status !== "provisioning") {
        throw new ProviderAgentDeleteError("authority_changed");
      }
      let canRelease: boolean;
      if (agent.type === "linux-desktop") {
        if (await deps.absentDesktop(operation)) {
          return { ok: false, pending: true, stage: "operation_finishing" };
        }
        const installer = await deps.desktopInstaller({ ...operation, action: "cancel" });
        canRelease = installer.stage === "not_dispatched" || (installer.stage === "worker_observed"
          && installer.stopped && installer.cleanupRecorded && installer.cancellationRequested
          && ["verified_stopped", "not_started"].includes(installer.desktopCleanup));
        // Explicit whole-VM deletion does not require inventing a desktop
        // ownership journal that an interrupted preparation never published.
        // SQL independently checks terminal worker + original cancellation,
        // and keeps this provision held throughout exact provider teardown.
        retainedDesktopProvision = installer.stage === "worker_observed" && installer.stopped
          && installer.cancellationRequested && installer.desktopCleanup === "pending" && !installer.cleanupRecorded;
      } else if (agent.type === "deepseek-harness") {
        const installer = await deps.nativeInstaller({ ...operation, action: "cancel" });
        canRelease = installer.stage === "not_dispatched" || (installer.stage === "worker_observed"
          && installer.stopped && installer.cleanupRecorded && installer.cancellationRequested
          && ["verified_stopped", "not_started"].includes(installer.nativeCleanup));
      } else {
        const installer = await deps.installer({ ...operation, action: "cancel" });
        canRelease = installer.stage === "not_dispatched" || (installer.stage === "worker_observed" && installer.stopped);
      }
      if (canRelease) {
        // Desired=deleted was durably set before the observation. If a prior
        // dispatch appeared concurrently, SQL refuses release until stopped.
        // Native/desktop release additionally requires this cancel's separate cleanup
        // grant/receipt; SQL checks its freshness again at the atomic handoff.
        if (!await deps.release(operation)) throw new ProviderAgentDeleteError("authority_changed");
      }
      if (!retainedDesktopProvision) return { ok: false, pending: true, stage: "installer_stopping" };
    }
    if (["start", "stop", "restart"].includes(String(agent.operation_kind))) {
      await deps.power(operation, "observe");
      return { ok: false, pending: true, stage: "operation_finishing" };
    }
    if (agent.operation_kind === "resize") {
      // Delete intent was persisted above. This mode may cancel only a resize
      // whose provider POST marker is still absent; it can never dispatch the
      // resize or retry an ambiguous provider request.
      const absent = await deps.absentResize(operation);
      if (!absent) {
        const resize = await deps.resize(operation, "cancel_if_undispatched");
        if (!["succeeded", "failed", "cancelled", "removed"].includes(resize.stage)) {
          return { ok: false, pending: true, stage: "operation_finishing" };
        }
      }
      const settled = await deps.load(owner);
      if (settled.status === "deleted") return { ok: true };
      if (settled.id !== initial.id || settled.user_id !== owner.userId || settled.type !== initial.type || settled.computer_profile !== initial.computer_profile
        || settled.provider_capacity_order_id !== initial.provider_capacity_order_id
        || settled.deployment_target_id !== initial.deployment_target_id
        || settled.provider_server_id !== initial.provider_server_id
        || settled.provider_enrollment_attempt_id !== initial.provider_enrollment_attempt_id
        || settled.infrastructure_connection_id !== initial.infrastructure_connection_id
        || settled.infrastructure_connection_revision !== initial.infrastructure_connection_revision
        || settled.allocation_operation_id !== initial.allocation_operation_id
        || settled.desired_state !== "deleted") {
        throw new ProviderAgentDeleteError("authority_changed");
      }
      // A terminal resize releases its operation while preserving delete
      // intent. Re-read that release, then claim deletion with the same ID
      // proposed at the start of this request. No resize mutation is retried.
      if (settled.operation_id !== null) {
        return { ok: false, pending: true, stage: "operation_finishing" };
      }
      const takeover = await deps.request({ ...owner, operationId: proposed });
      if (takeover === "deleted") return { ok: true };
      if (takeover === "not_found") throw new ProviderAgentDeleteError("authority_changed");
      agent = await deps.load(owner);
      if (agent.status === "deleted") return { ok: true };
      if (agent.id !== initial.id || agent.user_id !== owner.userId || agent.type !== initial.type || agent.computer_profile !== initial.computer_profile
        || agent.provider_capacity_order_id !== initial.provider_capacity_order_id
        || agent.deployment_target_id !== initial.deployment_target_id
        || agent.provider_server_id !== initial.provider_server_id
        || agent.provider_enrollment_attempt_id !== initial.provider_enrollment_attempt_id
        || agent.infrastructure_connection_id !== initial.infrastructure_connection_id
        || agent.infrastructure_connection_revision !== initial.infrastructure_connection_revision
        || agent.allocation_operation_id !== initial.allocation_operation_id
        || agent.desired_state !== "deleted"
        || (takeover === "claimed" && agent.operation_id !== proposed)) {
        throw new ProviderAgentDeleteError("authority_changed");
      }
      if (!agent.operation_id) return { ok: false, pending: true, stage: "operation_finishing" };
      operation = { ...owner, operationId: agent.operation_id };
    }
    if (agent.operation_kind !== "delete" && !retainedDesktopProvision) return { ok: false, pending: true, stage: "operation_finishing" };
    const order = await deps.order(owner.userId, agent.infrastructure_connection_id, agent.provider_capacity_order_id);
    if (order.operation.id !== agent.provider_capacity_order_id || order.operation.connectionId !== agent.infrastructure_connection_id
      || order.connectionRevision !== agent.infrastructure_connection_revision || order.operation.providerServerId !== agent.provider_server_id) {
      throw new ProviderAgentDeleteError("receipts_unavailable");
    }
    const scope = { binding: { userId: owner.userId, connectionId: agent.infrastructure_connection_id,
      connectionRevision: agent.infrastructure_connection_revision, orderId: agent.provider_capacity_order_id,
      quoteFingerprint: order.quoteFingerprintSha256, recipeVersion: FIRST_BOOT_RECIPE_VERSION }, providerServerId: agent.provider_server_id };
    const boot = await deps.boot(scope);
    if (!boot || boot.binding.attemptId !== agent.provider_enrollment_attempt_id) throw new ProviderAgentDeleteError("receipts_unavailable");
    const manifest = hetznerCleanupManifest(order, boot);
    if (!manifest.resources.firewall || order.cleanup?.abandonedAt) throw new ProviderAgentDeleteError("receipts_unavailable");
    const op = operation;
    const result = await deps.cleanup(owner.userId, agent.infrastructure_connection_id, {
      orderId: order.operation.id, idempotencyKey: order.cleanup?.idempotencyKey ?? agent.id,
      fingerprint: manifest.fingerprint, serverName: manifest.serverName, confirmation: HETZNER_FIRST_BOOT_CLEANUP_CONFIRMATION,
    }, { retireUnused: async requested => {
      if (requested.userId !== owner.userId || requested.connectionId !== agent.infrastructure_connection_id
        || requested.expectedRevision !== agent.infrastructure_connection_revision || requested.orderId !== agent.provider_capacity_order_id
        || requested.providerServerId !== agent.provider_server_id) throw new ProviderAgentDeleteError("authority_changed");
      return deps.retire(op, agent);
    } });
    if (result.orderId !== agent.provider_capacity_order_id || result.connectionId !== agent.infrastructure_connection_id
      || result.fingerprint !== manifest.fingerprint) throw new ProviderAgentDeleteError("authority_changed");
    // A fresh provider read can observe an acknowledged deletion or firewall
    // detach still in progress. Keep the existing bounded 202 continuation;
    // unknown outcomes and changed ownership still require explicit attention.
    if (result.status === "cleaning" && result.cleanup?.error === "resource_busy") {
      return { ok: false, pending: true, stage: "provider_cleanup" };
    }
    if (result.cleanup?.error) throw new ProviderAgentDeleteError("cleanup_needs_attention");
    if (result.status !== "deleted") return { ok: false, pending: true, stage: "provider_cleanup" };
    const absence = result.cleanup?.absence;
    if (!result.cleanup?.finishedAt || !absence || Object.keys(absence).length !== 5
      || ![absence.server, absence.ipv4, absence.ipv6, absence.sshKey, absence.firewall].every(value => value === true)) {
      throw new ProviderAgentDeleteError("receipts_unavailable");
    }
    if (retainedDesktopProvision) {
      // Next continuation must freshly observe original-server absence and
      // perform the separate atomic handoff before the normal delete finalizer.
      return { ok: false, pending: true, stage: "operation_finishing" };
    }
    // The shared finalizer performs its own fresh SQL proof before revoking
    // tunnel/DNS/model access. It is not authorized by the response above alone.
    if (!await deps.complete(op)) throw new ProviderAgentDeleteError("authority_changed");
    return { ok: true };
  } catch (error) {
    if (operation) await deps.failure({ ...operation,
      error: "Provider computer removal is incomplete. Original resources and operation are retained; inspect before resuming.",
    }).catch(() => false);
    if (error instanceof ProviderAgentDeleteError) throw error;
    throw new ProviderAgentDeleteError("operation_unconfirmed");
  }
}
