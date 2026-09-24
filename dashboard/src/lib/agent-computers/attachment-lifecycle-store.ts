import "server-only";

import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase";

// The attach lifecycle's database calls (migration 20260925000000), each
// owner-bound and parsed strictly. Every write is one compare-and-swap in the
// database; a lost answer is read back, never replayed as a new step.

interface Database { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> }
export class AttachmentLifecycleStoreError extends Error {
  constructor(readonly rpcName: string) { super("Attachment state could not be confirmed; nothing was changed by Hivra."); }
}

const Id = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const Grants = z.object({ workspace: z.boolean() }).strict();
const Stamp = z.string().nullable();
/** Why a step sent to the computer let the computer go (migration 20260925000300). */
const InterruptReason = z.enum(["computer_not_running", "pending_delete"]);
export type AttachmentInterruptReason = z.infer<typeof InterruptReason>;
// Absent from a read before 20260925000300: never interrupted.
const Interruption = { leaseReleased: z.boolean().optional(), interruptReason: InterruptReason.nullable().optional() };

const Target = z.object({
  version: z.literal(1), sourceId: Id, computerId: Id.nullable(), deploymentMode: z.string().nullable(),
  ramGb: z.number().nullable(), cpu: z.number().nullable(), authority: z.record(z.string(), z.unknown()),
  writeAuthority: z.enum(["legacy", "canonical"]).nullable(), eligible: z.boolean(),
  reason: z.enum(["unsupported_computer", "agent_present", "computer_not_running", "computer_busy", "computer_not_ready"]).nullable(),
  liveAttachmentId: Id.nullable(),
});
export type AttachTarget = z.infer<typeof Target>;

const ContractView = z.object({
  revision: z.number().int().positive(), content: z.string(), grants: Grants, renderedAt: z.string(),
  deliveredAt: Stamp, lastDelivered: z.object({ revision: z.number().int().positive(), deliveredAt: z.string() }).nullable(),
});
const OperationView = z.object({
  id: Id, kind: z.enum(["access_change", "detach"]), phase: z.enum(["claimed", "dispatched", "completed", "failed", "cancelled"]),
  grants: Grants, createdAt: z.string(), dispatchedAt: Stamp, completedAt: Stamp, failureCode: z.string().nullable(),
  ...Interruption, interruptedAt: Stamp.optional(),
});
const AttachmentView = z.object({
  id: Id, phase: z.enum(["claimed", "dispatched", "cancelled", "attached", "failed", "detached"]),
  agentName: z.string().nullable(), runtimeId: z.string().nullable(), agentIdentityId: Id, grants: Grants.nullable(),
  endReason: z.string().nullable(), createdAt: z.string(), dispatchedAt: Stamp, completedAt: Stamp, endedAt: Stamp,
  deploymentMode: z.string().nullable(), installationId: Id.nullable(),
  ...Interruption, interruptedAt: Stamp.optional(),
  receipts: z.object({ accepted: Stamp, staged: Stamp, started: Stamp, chatReady: Stamp }),
  contract: ContractView.nullable(), operation: OperationView.nullable(),
});
export type AttachmentView = z.infer<typeof AttachmentView>;

const OwnerAttached = z.object({
  id: Id, phase: z.enum(["claimed", "dispatched", "attached"]), agentName: z.string().nullable(), runtimeId: z.string().nullable(),
  sourceId: Id, computerName: z.string(), computerStatus: z.string().nullable(), deploymentMode: z.string().nullable(),
  installationId: Id.nullable(), createdAt: z.string(), completedAt: Stamp,
  interruptReason: InterruptReason.nullable().optional(),
});
export type OwnerAttachedAgent = z.infer<typeof OwnerAttached>;

const WorkItem = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("attach"), ownerId: z.string().min(1), id: Id }),
  z.object({ kind: z.enum(["access_change", "detach"]), ownerId: z.string().min(1), id: Id, attachmentId: Id }),
]);
export type AttachmentWorkItem = z.infer<typeof WorkItem>;

const State = z.object({
  version: z.literal(1), id: Id, ownerId: z.string().min(1),
  phase: z.enum(["claimed", "dispatched", "cancelled", "attached", "failed", "detached"]), sourceId: Id, computerId: Id,
  generation: z.string(), guestAuthority: z.record(z.string(), z.unknown()), agentName: z.string(), grants: Grants.nullable(),
  reviewSha256: z.string().nullable(), dispatchId: Id.nullable(),
  installation: z.object({ installationId: Id, bindingId: Id, architecture: z.enum(["x86_64", "aarch64"]) }).nullable(),
  bootId: Id.nullable(), staged: z.unknown().nullable(), activation: z.record(z.string(), z.unknown()).nullable(),
  readyObservationId: Id.nullable(), contractRevision: z.number().int().nullable(),
  desiredState: z.string().nullable(), computerStatus: z.string().nullable(),
  /** When the claim was made (migration 20260925000200); absent from an older read. */
  createdAt: z.string().optional(),
  /** Whether another step holds the computer (20260925000300). */
  computerOperationId: Id.nullable().optional(),
  ...Interruption,
});
export type AttachmentState = z.infer<typeof State>;

const OperationState = z.object({
  version: z.literal(1), operationId: Id, attachmentId: Id, ownerId: z.string().min(1), kind: z.enum(["access_change", "detach"]),
  phase: z.enum(["claimed", "dispatched", "completed", "failed", "cancelled"]), grants: Grants, previousGrants: Grants,
  guestAuthority: z.record(z.string(), z.unknown()), reviewSha256: z.string(), installationId: Id, agentName: z.string(),
  desiredState: z.string().nullable(), computerStatus: z.string().nullable(), createdAt: z.string(),
  computerOperationId: Id.nullable().optional(), ...Interruption,
});
export type AttachmentOperationState = z.infer<typeof OperationState>;

export const ClaimStatus = z.enum(["claimed", "invalid_request", "conflict", "not_found", "review_changed", "not_eligible",
  "agent_present", "computer_not_running", "computer_busy", "plan_agent_limit"]);
const ClaimResult = z.object({ status: ClaimStatus, operationId: Id.optional(), phase: z.string().optional(),
  computerId: Id.optional(), resumed: z.boolean().optional(), activeCount: z.number().optional(), limit: z.number().optional() });
export type ClaimResult = z.infer<typeof ClaimResult>;
const OperationBegin = z.object({ status: z.enum(["claimed", "invalid_request", "conflict", "not_found", "not_attached",
  "review_changed", "computer_not_running", "computer_busy", "unchanged"]), operationId: Id.optional(), phase: z.string().optional(),
resumed: z.boolean().optional() });
export type OperationBeginResult = z.infer<typeof OperationBegin>;

export function createAttachmentLifecycleStore(db: Database | null = supabaseAdmin) {
  async function rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!db) throw new AttachmentLifecycleStoreError(name);
    let response;
    try { response = await db.rpc(name, args); } catch { throw new AttachmentLifecycleStoreError(name); }
    if (!response || typeof response !== "object" || Array.isArray(response)
      || !Object.hasOwn(response, "data") || !Object.hasOwn(response, "error") || response.error !== null) {
      throw new AttachmentLifecycleStoreError(name);
    }
    return response.data;
  }
  async function parsed<T>(name: string, args: Record<string, unknown>, schema: z.ZodType<T>, nullable = false): Promise<T | null> {
    const data = await rpc(name, args);
    if (data === null && nullable) return null;
    const result = schema.safeParse(data);
    if (!result.success) throw new AttachmentLifecycleStoreError(name);
    return result.data;
  }
  async function boolean(name: string, args: Record<string, unknown>): Promise<boolean> {
    const data = await rpc(name, args);
    if (typeof data !== "boolean") throw new AttachmentLifecycleStoreError(name);
    return data;
  }
  return {
    readTarget: (ownerId: string, sourceId: string) =>
      parsed("read_hivra_agent_attach_target", { p_owner: ownerId, p_source_id: sourceId }, Target, true),
    readAttachments: async (ownerId: string, sourceId: string) =>
      (await parsed("read_hivra_agent_attachments", { p_owner: ownerId, p_source_id: sourceId }, z.array(AttachmentView))) ?? [],
    readOwnerAttached: async (ownerId: string) =>
      (await parsed("read_hivra_owner_attached_agents", { p_owner: ownerId }, z.array(OwnerAttached))) ?? [],
    claim: (input: { ownerId: string; sourceId: string; operationId: string; authorityCommandId: string;
      authority: Record<string, unknown>; intent: Record<string, unknown>; agentLimit: number }) =>
      parsed("claim_hivra_agent_attachment", { p_owner: input.ownerId, p_source_id: input.sourceId, p_operation_id: input.operationId,
        p_authority_command_id: input.authorityCommandId, p_expected_authority: input.authority, p_intent: input.intent,
        p_agent_limit: input.agentLimit }, ClaimResult) as Promise<ClaimResult>,
    cancel: (ownerId: string, operationId: string, reason: "cancelled" | "computer_not_running" | "pending_delete") =>
      boolean("cancel_hivra_agent_attachment", { p_owner: ownerId, p_operation_id: operationId, p_reason: reason }),
    /** Before any dispatch: ends the claim as failed with a precondition reason, never held (20260925000200). */
    refuse: (ownerId: string, operationId: string, reason: "computer_not_running" | "computer_not_ready") =>
      boolean("refuse_hivra_agent_attachment", { p_owner: ownerId, p_operation_id: operationId, p_reason: reason }),
    /** A step sent to the computer lets the computer go: the host saw the VM not
     * running, or a delete is pending. The step stays open (20260925000300). */
    interrupt: (ownerId: string, kind: AttachmentWorkItem["kind"], stepId: string, reason: AttachmentInterruptReason) =>
      boolean("interrupt_hivra_agent_attachment_step", { p_owner: ownerId, p_kind: kind, p_step_id: stepId, p_reason: reason }),
    /** Takes the computer back for an interrupted step once it runs again, free and unchanged. */
    resume: (ownerId: string, kind: AttachmentWorkItem["kind"], stepId: string) =>
      boolean("resume_hivra_agent_attachment_step", { p_owner: ownerId, p_kind: kind, p_step_id: stepId }),
    listWork: async (limit: number) => (await parsed("list_open_hivra_agent_attachment_work", { p_limit: limit }, z.array(WorkItem))) ?? [],
    readState: (ownerId: string, attachmentId: string) =>
      parsed("read_hivra_agent_attachment_state", { p_owner: ownerId, p_attachment_id: attachmentId }, State, true),
    readOperation: (ownerId: string, operationId: string) =>
      parsed("read_hivra_agent_attachment_operation", { p_owner: ownerId, p_operation_id: operationId }, OperationState, true),
    readInstanceToken: async (ownerId: string, attachmentId: string) => {
      const data = await rpc("read_hivra_attachment_instance_token", { p_owner: ownerId, p_operation_id: attachmentId });
      if (data === null) return null;
      if (typeof data !== "string" || !/^[0-9a-f]{64}$/.test(data)) throw new AttachmentLifecycleStoreError("read_hivra_attachment_instance_token");
      return data;
    },
    dispatchActivation: (input: { ownerId: string; operationId: string; activationId: string; generation: string;
      authority: Record<string, unknown>; bootId: string; staged: unknown; servicePolicySha256: string; programSha256: string;
      serviceDefinitionSha256: string; instanceToken: string }) =>
      boolean("dispatch_hivra_attachment_activation_v2", { p_owner: input.ownerId, p_operation_id: input.operationId,
        p_activation_id: input.activationId, p_expected_generation: input.generation, p_expected_authority: input.authority,
        p_observed_boot_id: input.bootId, p_expected_staged: input.staged, p_service_policy_sha256: input.servicePolicySha256,
        p_program_sha256: input.programSha256, p_service_definition_sha256: input.serviceDefinitionSha256,
        p_instance_token: input.instanceToken }),
    recordObservation: (input: { ownerId: string; operationId: string; generation: string; authority: Record<string, unknown>;
      request: unknown; observationId: string; result: unknown }) =>
      boolean("record_hivra_attachment_activation_observation", { p_owner: input.ownerId, p_operation_id: input.operationId,
        p_expected_generation: input.generation, p_expected_authority: input.authority, p_expected_request: input.request,
        p_observation_id: input.observationId, p_result: input.result }),
    complete: (input: { ownerId: string; operationId: string; generation: string; authority: Record<string, unknown>; observationId: string }) =>
      boolean("complete_hivra_agent_attachment", { p_owner: input.ownerId, p_operation_id: input.operationId,
        p_expected_generation: input.generation, p_expected_authority: input.authority, p_observation_id: input.observationId }),
    fail: (input: { ownerId: string; operationId: string; generation: string; authority: Record<string, unknown>;
      cleanup: Record<string, unknown>; failureCode: string }) =>
      boolean("fail_hivra_agent_attachment", { p_owner: input.ownerId, p_operation_id: input.operationId,
        p_expected_generation: input.generation, p_expected_authority: input.authority, p_cleanup: input.cleanup,
        p_failure_code: input.failureCode }),
    recordContract: (input: { ownerId: string; attachmentId: string; revision: number; content: string; contentSha256: string;
      fileSha256: string; grants: { workspace: boolean }; readback: { sha256: string; checked: boolean } | null }) =>
      boolean("record_hivra_attachment_contract", { p_owner: input.ownerId, p_attachment_id: input.attachmentId,
        p_revision: input.revision, p_content: input.content, p_content_sha256: input.contentSha256, p_file_sha256: input.fileSha256,
        p_grants: input.grants, p_readback: input.readback }),
    beginOperation: (input: { ownerId: string; attachmentId: string; operationId: string; kind: "access_change" | "detach";
      authority: Record<string, unknown>; grants: { workspace: boolean }; reviewSha256: string }) =>
      parsed("begin_hivra_agent_attachment_operation", { p_owner: input.ownerId, p_attachment_id: input.attachmentId,
        p_operation_id: input.operationId, p_kind: input.kind, p_expected_authority: input.authority, p_grants: input.grants,
        p_review_sha256: input.reviewSha256 }, OperationBegin) as Promise<OperationBeginResult>,
    dispatchOperation: (ownerId: string, operationId: string) =>
      boolean("dispatch_hivra_agent_attachment_operation", { p_owner: ownerId, p_operation_id: operationId }),
    cancelOperation: (ownerId: string, operationId: string) =>
      boolean("cancel_hivra_agent_attachment_operation", { p_owner: ownerId, p_operation_id: operationId }),
    completeOperation: (ownerId: string, operationId: string, receipt: Record<string, unknown>) =>
      boolean("complete_hivra_agent_attachment_operation", { p_owner: ownerId, p_operation_id: operationId, p_receipt: receipt }),
    failOperation: (ownerId: string, operationId: string, failureCode: string, receipt: Record<string, unknown>) =>
      boolean("fail_hivra_agent_attachment_operation", { p_owner: ownerId, p_operation_id: operationId, p_failure_code: failureCode,
        p_receipt: receipt }),
  };
}
export type AttachmentLifecycleStore = ReturnType<typeof createAttachmentLifecycleStore>;
