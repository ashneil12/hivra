import "server-only";
import { supabaseAdmin } from "@/lib/supabase";
import { parseAttachmentExecutionSnapshot, type AttachmentExecutionSnapshot } from "./attachment-execution-snapshot";
import { parseAttachmentActivationRecord } from "./attachment-activation-store";
import { parseAttachmentActivationResult } from "./attachment-activation-result";
import { parseAttachmentNativeProbeResult } from "./attachment-native-probe-bundle";

interface Database { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> }
const Id = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const failure = () => new Error("Activation observation is unconfirmed; retain the operation.");

/** Private evidence persistence only. It cannot publish a binding or release. */
export function createAttachmentActivationObservationStore(db: Database | null = supabaseAdmin) {
  return {
    async record(input: AttachmentExecutionSnapshot, activation: unknown, observationId: string, value: unknown): Promise<boolean> {
      const snapshot = parseAttachmentExecutionSnapshot(input, input?.ownerId, input?.operationId);
      const request = snapshot && parseAttachmentActivationRecord(activation, snapshot);
      if (!db || !snapshot || !request || typeof observationId !== "string" || observationId.length !== 36 || !Id.test(observationId)) throw failure();
      let result;
      try {
        const encoded = JSON.stringify(value);
        result = parseAttachmentNativeProbeResult(encoded, request, snapshot)
          ?? parseAttachmentActivationResult("observe", encoded, request, snapshot);
      } catch { throw failure(); }
      if (!result) throw failure();
      let response;
      try {
        response = await db.rpc("record_hivra_attachment_activation_observation", { p_owner: snapshot.ownerId,
          p_operation_id: snapshot.operationId, p_expected_generation: snapshot.generation,
          p_expected_authority: snapshot.guestAuthority, p_expected_request: request,
          p_observation_id: observationId, p_result: result });
      } catch { throw failure(); }
      if (!response || typeof response !== "object" || Array.isArray(response)
        || !Object.hasOwn(response, "data") || !Object.hasOwn(response, "error")
        || response.error !== null || typeof response.data !== "boolean") throw failure();
      return response.data;
    },
  };
}
