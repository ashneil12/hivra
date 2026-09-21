import "server-only";

import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase";
import { parseAttachmentExecutionSnapshot, attachmentExecutionExpectation,
  type AttachmentExecutionSnapshot } from "./attachment-execution-snapshot";
import { parseAttachmentGuestResult } from "./attachment-guest-result";
import { buildAttachedCodexServiceDefinition } from "./attachment-native-service";

// Immutable reviewed service-builder source. A new policy needs a new DB gate;
// do not silently change the bytes allowed by an already-issued activation.
export const ATTACHED_CODEX_SERVICE_POLICY_SHA256 = "66f89162530b682aa66d8a59250f385530726a162def8902ffb7bc953eee9428";
const Id = z.string().length(36).regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const RecordSchema = z.object({ version: z.literal(1), operationId: Id, activationId: Id,
  generation: z.string(), servicePolicySha256: z.literal(ATTACHED_CODEX_SERVICE_POLICY_SHA256),
  serviceDefinitionSha256: z.string().length(64).regex(/^[0-9a-f]{64}$/), staged: z.unknown(),
}).strict();
interface Database { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> }
class AttachmentActivationStoreError extends Error {
  constructor() { super("Attachment activation is unconfirmed; preserve the operation and do not restart it."); }
}

function snapshot(input: AttachmentExecutionSnapshot) {
  const s = parseAttachmentExecutionSnapshot(input, input?.ownerId, input?.operationId);
  if (!s || s.phase !== "dispatched" || !s.staged) throw new AttachmentActivationStoreError();
  return s;
}
function definition(s: AttachmentExecutionSnapshot) {
  const expected = attachmentExecutionExpectation(s);
  if (!expected) throw new AttachmentActivationStoreError();
  return buildAttachedCodexServiceDefinition(JSON.stringify(s.staged), expected);
}

/** Pure request construction, NOT a grant or a guest command. */
export function buildAttachmentActivationRequest(input: AttachmentExecutionSnapshot, activationId: string) {
  const s = snapshot(input);
  if (s.desiredState !== "running" || !Id.safeParse(activationId).success) throw new AttachmentActivationStoreError();
  const staged = parseAttachmentGuestResult(JSON.stringify(s.staged), attachmentExecutionExpectation(s)!)!;
  return { version: 1 as const, operationId: s.operationId, activationId, generation: s.generation,
    servicePolicySha256: ATTACHED_CODEX_SERVICE_POLICY_SHA256,
    serviceDefinitionSha256: definition(s).sha256, staged };
}
export type AttachmentActivationRecord = ReturnType<typeof buildAttachmentActivationRequest>;

/** A saved record is historical dispatch evidence, never permission to start.
 * Pending deletion may read it so a future reconciler can stop the exact unit.
 */
export function parseAttachmentActivationRecord(value: unknown, input: AttachmentExecutionSnapshot): AttachmentActivationRecord | null {
  try {
    const s = snapshot(input), parsed = RecordSchema.safeParse(value);
    if (!parsed.success) return null;
    const r = parsed.data, expected = attachmentExecutionExpectation(s)!;
    const staged = parseAttachmentGuestResult(JSON.stringify(r.staged), expected);
    if (!staged || JSON.stringify(staged) !== JSON.stringify(s.staged)
      || r.operationId !== s.operationId || r.generation !== s.generation
      || r.serviceDefinitionSha256 !== definition(s).sha256) return null;
    return { ...r, staged };
  } catch { return null; }
}

/** Internal only. All write RPC permissions remain revoked. No caller starts a
 * service from this adapter, and a true response does not establish readiness.
 */
export function createAttachmentActivationStore(db: Database | null = supabaseAdmin) {
  async function rpc(name: string, args: Record<string, unknown>) {
    if (!db) throw new AttachmentActivationStoreError();
    let response;
    try { response = await db.rpc(name, args); } catch { throw new AttachmentActivationStoreError(); }
    if (!response || typeof response !== "object" || Array.isArray(response)
      || !Object.hasOwn(response, "data") || !Object.hasOwn(response, "error") || response.error !== null) {
      throw new AttachmentActivationStoreError();
    }
    return response.data;
  }
  return {
    async dispatch(input: AttachmentExecutionSnapshot, activationId: string): Promise<boolean> {
      const s = snapshot(input), request = buildAttachmentActivationRequest(s, activationId);
      const result = await rpc("dispatch_hivra_attachment_activation", { p_owner: s.ownerId,
        p_operation_id: s.operationId, p_activation_id: request.activationId,
        p_expected_generation: s.generation, p_expected_authority: s.guestAuthority,
        p_observed_boot_id: s.observation!.bootId, p_expected_staged: request.staged,
        p_service_policy_sha256: request.servicePolicySha256, p_service_definition_sha256: request.serviceDefinitionSha256 });
      if (typeof result !== "boolean") throw new AttachmentActivationStoreError();
      return result;
    },
    async read(input: AttachmentExecutionSnapshot): Promise<AttachmentActivationRecord | null> {
      const s = snapshot(input);
      const data = await rpc("read_hivra_attachment_activation", { p_owner: s.ownerId, p_operation_id: s.operationId });
      if (data === null) return null;
      const parsed = parseAttachmentActivationRecord(data, s);
      if (!parsed) throw new AttachmentActivationStoreError();
      return parsed;
    },
  };
}
