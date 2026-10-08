import "server-only";

import { supabaseAdmin } from "@/lib/supabase";
import { ATTACHED_CODEX_STAGER_SHA256 } from "./attachment-staging-receipt";
import { ATTACHMENT_GUEST_WORKER_SHA256, type AttachmentGuestResult } from "./attachment-guest-result";
import { parseAttachmentExecutionSnapshot, type AttachmentExecutionSnapshot } from "./attachment-execution-snapshot";

interface Database { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> }
const Id = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export class AttachmentExecutionStoreError extends Error {
  constructor() { super("Attachment state could not be confirmed; preserve the operation."); }
}

/** The staging chain's database calls, driven only by the attach worker. Each
 * mutation is one owner-bound compare-and-swap in the database.
 */
export function createAttachmentExecutionStore(db: Database | null = supabaseAdmin) {
  async function rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!db) throw new AttachmentExecutionStoreError();
    let response;
    try { response = await db.rpc(name, args); } catch { throw new AttachmentExecutionStoreError(); }
    if (!response || typeof response !== "object" || Array.isArray(response)
      || !Object.hasOwn(response, "data") || !Object.hasOwn(response, "error") || response.error !== null) {
      throw new AttachmentExecutionStoreError();
    }
    return response.data;
  }
  async function mutation(name: string, args: Record<string, unknown>): Promise<boolean> {
    const data = await rpc(name, args);
    if (typeof data !== "boolean") throw new AttachmentExecutionStoreError();
    return data;
  }
  const authority = (s: AttachmentExecutionSnapshot) => ({ p_owner: s.ownerId, p_operation_id: s.operationId,
    p_expected_generation: s.generation, p_expected_authority: s.guestAuthority });
  return {
    async read(ownerId: string, operationId: string): Promise<AttachmentExecutionSnapshot | null> {
      if (typeof ownerId !== "string" || !ownerId || ownerId.length > 256
        || typeof operationId !== "string" || operationId.length !== 36 || !Id.test(operationId)) throw new AttachmentExecutionStoreError();
      const data = await rpc("read_hivra_attachment_execution", { p_owner: ownerId, p_operation_id: operationId });
      if (data === null) return null;
      const result = parseAttachmentExecutionSnapshot(data, ownerId, operationId);
      if (!result) throw new AttachmentExecutionStoreError();
      return result;
    },
    reserve(s: AttachmentExecutionSnapshot, installationId: string, bindingId: string, architecture: "x86_64" | "aarch64") {
      return mutation("reserve_hivra_attachment_installation", { p_owner: s.ownerId, p_operation_id: s.operationId,
        p_expected_generation: s.generation, p_installation_id: installationId, p_binding_id: bindingId, p_architecture: architecture });
    },
    recordBoot(s: AttachmentExecutionSnapshot, bootId: string) {
      return mutation("observe_hivra_attachment_guest", { ...authority(s), p_boot_id: bootId, p_worker_sha256: ATTACHMENT_GUEST_WORKER_SHA256 });
    },
    // The v2 dispatch counts the owner's plan slots under their lock again and
    // cancels a claim that went over the limit (design 5.1, T35).
    dispatch(s: AttachmentExecutionSnapshot, dispatchId: string) {
      return mutation("dispatch_hivra_agent_attachment_v2", { ...authority(s), p_dispatch_id: dispatchId,
        p_installer_sha256: ATTACHED_CODEX_STAGER_SHA256 });
    },
    recordStaged(s: AttachmentExecutionSnapshot, result: AttachmentGuestResult) {
      return mutation("record_hivra_attachment_staging_result", { ...authority(s),
        p_observed_boot_id: s.observation?.bootId, p_result: result });
    },
  };
}
export type AttachmentExecutionStore = ReturnType<typeof createAttachmentExecutionStore>;
