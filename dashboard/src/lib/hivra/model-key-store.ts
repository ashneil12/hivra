import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase";
import { readAgentProviderDirectAccess } from "./provider-direct-access";

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Id = z.string().uuid();
const NullableText = z.string().nullable();

const ModelKeyAgentSchema = z.object({
  id: Id, user_id: z.string().min(1), type: z.string(), status: z.string(), desired_state: z.string(),
  operation_id: Id.nullable(), deployment_mode: z.string(), computer_substrate: z.string(),
  allocation_operation_id: Id.nullable(), proxmox_host: z.string(), vmid: z.number().int().nullable(),
  infrastructure_connection_id: Id.nullable(), infrastructure_connection_revision: z.number().int().nullable(),
  deployment_target_id: Id.nullable(), provider_capacity_order_id: Id.nullable(), provider_enrollment_attempt_id: Id.nullable(),
  provider_server_id: NullableText, cf_hostname: NullableText, cf_tunnel_id: NullableText, chat_url: NullableText,
  ip: NullableText,
  api_token: NullableText, llm_config: z.unknown(), llm_api_key_encrypted: NullableText,
});
export type ModelKeyAgent = z.infer<typeof ModelKeyAgentSchema>;

const Model = z.string().regex(/^[A-Za-z0-9._:\/\[\]-]{1,64}$/).nullable();
const Receipt = z.object({ protocol: z.literal("hivra-llm-apply-v1"), operationId: Id,
  stateDigest: Digest, payloadDigest: Digest, provider: z.literal("venice").nullable(), model: Model }).strict();
const ModelKeyOperationSchema = z.object({
  operation_id: Id, agent_id: Id, user_id: z.string().min(1), request_digest: Digest,
  binding: z.record(z.string(), z.unknown()), admission_connection_revision: z.number().int().nullable(),
  config: z.unknown(), payload: z.object({ provider: z.literal("venice"), baseUrl: z.string(), model: Model }).strict().nullable(),
  encrypted_key: NullableText, cipher_digest: Digest.nullable(), expected_state_digest: Digest, expected_receipt: Receipt,
  managed_key_id: Id.nullable(), phase: z.enum(["pending", "applied", "deleted"]), is_current: z.boolean(),
  lease_id: Id.nullable(), lease_expires_at: NullableText, dispatch_intent_at: NullableText,
  created_at: z.string(), applied_at: NullableText, deleted_at: NullableText,
});
export type ModelKeyOperation = z.infer<typeof ModelKeyOperationSchema>;

/** Same recipient identity as the SQL helper. Provider credential revision is
 * audit-only: supported same-computer SSH repair cannot retarget this bearer. */
export function modelKeyBinding(a: ModelKeyAgent): Record<string, unknown> {
  const direct = readAgentProviderDirectAccess(a);
  return {
    agentId: a.id, userId: a.user_id, runtime: a.type, deploymentMode: a.deployment_mode, substrate: a.computer_substrate,
    allocationId: a.allocation_operation_id, host: a.proxmox_host, vmid: a.vmid,
    connectionId: a.infrastructure_connection_id, targetId: a.deployment_target_id,
    orderId: a.provider_capacity_order_id, enrollmentId: a.provider_enrollment_attempt_id, serverId: a.provider_server_id,
    hostname: direct?.hostname ?? a.cf_hostname, tunnelId: a.cf_tunnel_id, chatUrl: a.chat_url,
    tokenDigest: a.api_token === null ? null : createHash("sha256").update(a.api_token).digest("hex"),
  };
}

export class ModelKeyStoreError extends Error {
  constructor() { super("Model settings storage is unavailable. Refresh the saved state before trying again."); }
}

/** Private store only. Routes must derive userId from authentication, never a
 * request body. Mutation is exclusively through the owner/agent-locking RPCs. */
export function createModelKeyStore(db = supabaseAdmin) {
  if (!db) throw new ModelKeyStoreError();
  const client = db;
  const agentColumns = Object.keys(ModelKeyAgentSchema.shape).join(",");
  const operationColumns = Object.keys(ModelKeyOperationSchema.shape).join(",");
  async function safely<T>(read: () => PromiseLike<T>): Promise<T> {
    try { return await read(); } catch { throw new ModelKeyStoreError(); }
  }
  async function rpc(name: string, args: Record<string, unknown>) {
    const { data, error } = await safely(() => client.rpc(name, args));
    // Do not forward database details: rejected writes can contain custody
    // values in their diagnostic context, including encrypted input.
    if (error) throw new ModelKeyStoreError();
    return data;
  }
  return {
    async agent(userId: string, agentId: string): Promise<ModelKeyAgent | null> {
      const { data, error } = await safely(() => client.from("hivra_agents").select(agentColumns)
        .eq("id", agentId).eq("user_id", userId).maybeSingle());
      if (error) throw new ModelKeyStoreError();
      if (!data) return null;
      const parsed = ModelKeyAgentSchema.safeParse(data);
      if (!parsed.success || parsed.data.id !== agentId || parsed.data.user_id !== userId) throw new ModelKeyStoreError();
      return parsed.data;
    },
    async operation(userId: string, agentId: string, operationId?: string): Promise<ModelKeyOperation | null> {
      let query = client.from("hivra_model_key_operations").select(operationColumns)
        .eq("agent_id", agentId).eq("user_id", userId);
      query = operationId ? query.eq("operation_id", operationId) : query.eq("phase", "pending");
      const { data, error } = await safely(() => query.maybeSingle());
      if (error) throw new ModelKeyStoreError();
      if (!data) return null;
      const parsed = ModelKeyOperationSchema.safeParse(data);
      if (!parsed.success || parsed.data.agent_id !== agentId || parsed.data.user_id !== userId
        || (operationId ? parsed.data.operation_id !== operationId : parsed.data.phase !== "pending")) throw new ModelKeyStoreError();
      return parsed.data;
    },
    async admit(userId: string, agentId: string, operationId: string, binding: Record<string, unknown>, request: Record<string, unknown>) {
      const data = await rpc("admit_hivra_model_key_operation", {
        p_user_id: userId, p_agent_id: agentId, p_operation_id: operationId, p_binding: binding, p_request: request,
      });
      if (typeof data !== "string") throw new ModelKeyStoreError();
      return data;
    },
    async claim(userId: string, agentId: string, operationId: string): Promise<ModelKeyOperation | null> {
      const data = await rpc("claim_hivra_model_key_delivery", { p_user_id: userId, p_agent_id: agentId, p_operation_id: operationId });
      if (data === null) return null;
      const parsed = ModelKeyOperationSchema.safeParse(data);
      if (!parsed.success || parsed.data.user_id !== userId || parsed.data.agent_id !== agentId
        || parsed.data.operation_id !== operationId || parsed.data.phase !== "pending"
        || !parsed.data.lease_id || !parsed.data.lease_expires_at) throw new ModelKeyStoreError();
      return parsed.data;
    },
    async settle(userId: string, agentId: string, operationId: string, leaseId: string, receipt: unknown): Promise<boolean> {
      const data = await rpc("settle_hivra_model_key_operation", {
        p_user_id: userId, p_agent_id: agentId, p_operation_id: operationId, p_lease_id: leaseId, p_receipt: receipt,
      });
      if (typeof data !== "boolean") throw new ModelKeyStoreError();
      return data;
    },
  };
}
export type ModelKeyStore = ReturnType<typeof createModelKeyStore>;
