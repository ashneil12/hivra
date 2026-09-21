import "server-only";

import { z } from "zod";

import { supabaseAdmin } from "@/lib/supabase";

const Id = z.string().uuid();
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Text = z.string().min(1);
const NullableText = z.string().nullable();

const BuzzConnectionRowSchema = z.object({
  id: Id,
  user_id: Text,
  relay_url: Text,
  http_origin: Text,
  relay_public_key: Digest,
  display_name: Text,
  software: NullableText,
  relay_version: NullableText,
  requires_membership: z.boolean(),
  revision: z.number().int().positive(),
  status: z.enum(["ready", "disconnected"]),
  observed_at: Text,
  created_at: Text,
  updated_at: Text,
});
export type BuzzConnectionRow = z.infer<typeof BuzzConnectionRowSchema>;

const BuzzBindingRowSchema = z.object({
  id: Id,
  user_id: Text,
  connection_id: Id,
  connection_revision: z.number().int().positive(),
  relay_public_key: Digest,
  agent_id: Id,
  operation_id: Id,
  request_digest: Digest,
  public_key: Digest,
  encrypted_private_key: NullableText,
  encrypted_invite_code: NullableText,
  status: z.enum(["claim_pending", "joined", "leave_pending", "revoked"]),
  claim_receipt: z.unknown().nullable(),
  leave_receipt: z.unknown().nullable(),
  health_receipt: z.unknown().nullable(),
  last_health_at: NullableText,
  last_error_code: NullableText,
  lease_id: Id.nullable(),
  lease_expires_at: NullableText,
  joined_at: NullableText,
  revoked_at: NullableText,
  runtime_status: z.enum(["not_installed", "install_pending", "active", "remove_pending", "removed"]),
  runtime_operation_id: Id.nullable(),
  runtime_request_digest: Digest.nullable(),
  runtime_provider: z.enum(["openai", "anthropic", "venice"]).nullable(),
  runtime_model: NullableText,
  runtime_owner_public_key: Digest.nullable(),
  encrypted_runtime_api_key: NullableText,
  runtime_install_receipt: z.unknown().nullable(),
  runtime_remove_receipt: z.unknown().nullable(),
  runtime_last_observed_at: NullableText,
  runtime_last_error_code: NullableText,
  runtime_lease_id: Id.nullable(),
  runtime_lease_expires_at: NullableText,
  created_at: Text,
  updated_at: Text,
});
export type BuzzBindingRow = z.infer<typeof BuzzBindingRowSchema>;

const AgentRowSchema = z.object({
  id: Id,
  name: Text,
  type: Text,
  status: Text,
  desired_state: Text,
});
export type BuzzAgentRow = z.infer<typeof AgentRowSchema>;

const BuzzRuntimeAgentRowSchema = z.object({
  id: Id,
  user_id: Text,
  name: Text,
  type: Text,
  status: Text,
  desired_state: Text,
  ip: NullableText,
  vmid: z.number().int().positive().nullable(),
  operation_id: Id.nullable(),
  operation_kind: NullableText,
  computer_substrate: NullableText,
  provider_capacity_order_id: NullableText,
  provider_enrollment_attempt_id: NullableText,
  provider_server_id: NullableText,
  deployment_mode: NullableText,
  proxmox_host: NullableText,
  infrastructure_connection_id: NullableText,
  deployment_target_id: NullableText,
  infrastructure_connection_revision: z.number().int().positive().nullable(),
  infrastructure_binding_token_hash: NullableText,
  infrastructure_binding_token_enforced: z.boolean().nullable(),
});
export type BuzzRuntimeAgentRow = z.infer<typeof BuzzRuntimeAgentRowSchema>;

const CONNECTION_COLUMNS = Object.keys(BuzzConnectionRowSchema.shape).join(",");
const BINDING_COLUMNS = Object.keys(BuzzBindingRowSchema.shape).join(",");
const AGENT_COLUMNS = Object.keys(AgentRowSchema.shape).join(",");
const RUNTIME_AGENT_COLUMNS = Object.keys(BuzzRuntimeAgentRowSchema.shape).join(",");

class BuzzStoreError extends Error {
  constructor() {
    super("Buzz connection storage is unavailable.");
    this.name = "BuzzStoreError";
  }
}

export type BuzzAdmitResult = {
  status: "invalid_request" | "not_found" | "agent_not_found" | "operation_conflict"
    | "already_bound" | "claim_pending" | "joined" | "leave_pending" | "revoked";
  bindingId?: string;
};

export type BuzzRuntimeBeginResult = {
  status: "invalid_request" | "not_found" | "agent_not_ready" | "operation_conflict" | "install_pending" | "active";
  bindingId?: string;
};

export function createBuzzStore(db = supabaseAdmin) {
  if (!db) throw new BuzzStoreError();
  const client = db;
  async function safely<T>(call: () => PromiseLike<T>): Promise<T> {
    try { return await call(); } catch { throw new BuzzStoreError(); }
  }
  async function rpc(name: string, args: Record<string, unknown>) {
    const { data, error } = await safely(() => client.rpc(name, args));
    if (error) throw new BuzzStoreError();
    return data;
  }
  return {
    async list(userId: string): Promise<{ connections: BuzzConnectionRow[]; bindings: BuzzBindingRow[]; agents: BuzzAgentRow[] }> {
      const [connections, bindings, agents] = await Promise.all([
        safely(() => client.from("hivra_buzz_connections").select(CONNECTION_COLUMNS)
          .eq("user_id", userId).order("created_at", { ascending: true })),
        safely(() => client.from("hivra_buzz_agent_bindings").select(BINDING_COLUMNS)
          .eq("user_id", userId).order("created_at", { ascending: true })),
        safely(() => client.from("hivra_agents").select(AGENT_COLUMNS)
          .eq("user_id", userId).neq("status", "deleted").neq("desired_state", "deleted")
          .order("created_at", { ascending: true })),
      ]);
      if (connections.error || bindings.error || agents.error) throw new BuzzStoreError();
      const parsedConnections = z.array(BuzzConnectionRowSchema).safeParse(connections.data ?? []);
      const parsedBindings = z.array(BuzzBindingRowSchema).safeParse(bindings.data ?? []);
      const parsedAgents = z.array(AgentRowSchema).safeParse(agents.data ?? []);
      if (!parsedConnections.success || !parsedBindings.success || !parsedAgents.success) throw new BuzzStoreError();
      return { connections: parsedConnections.data, bindings: parsedBindings.data, agents: parsedAgents.data };
    },
    async connection(userId: string, id: string): Promise<BuzzConnectionRow | null> {
      const { data, error } = await safely(() => client.from("hivra_buzz_connections")
        .select(CONNECTION_COLUMNS).eq("id", id).eq("user_id", userId).maybeSingle());
      if (error) throw new BuzzStoreError();
      if (!data) return null;
      const parsed = BuzzConnectionRowSchema.safeParse(data);
      if (!parsed.success) throw new BuzzStoreError();
      return parsed.data;
    },
    async binding(userId: string, id: string): Promise<BuzzBindingRow | null> {
      const { data, error } = await safely(() => client.from("hivra_buzz_agent_bindings")
        .select(BINDING_COLUMNS).eq("id", id).eq("user_id", userId).maybeSingle());
      if (error) throw new BuzzStoreError();
      if (!data) return null;
      const parsed = BuzzBindingRowSchema.safeParse(data);
      if (!parsed.success) throw new BuzzStoreError();
      return parsed.data;
    },
    async runtimeAgent(userId: string, id: string): Promise<BuzzRuntimeAgentRow | null> {
      const { data, error } = await safely(() => client.from("hivra_agents")
        .select(RUNTIME_AGENT_COLUMNS).eq("id", id).eq("user_id", userId).maybeSingle());
      if (error) throw new BuzzStoreError();
      if (!data) return null;
      const parsed = BuzzRuntimeAgentRowSchema.safeParse(data);
      if (!parsed.success) throw new BuzzStoreError();
      return parsed.data;
    },
    async operation(userId: string, operationId: string): Promise<BuzzBindingRow | null> {
      const { data, error } = await safely(() => client.from("hivra_buzz_agent_bindings")
        .select(BINDING_COLUMNS).eq("operation_id", operationId).eq("user_id", userId).maybeSingle());
      if (error) throw new BuzzStoreError();
      if (!data) return null;
      const parsed = BuzzBindingRowSchema.safeParse(data);
      if (!parsed.success) throw new BuzzStoreError();
      return parsed.data;
    },
    async upsertConnection(userId: string, id: string, input: {
      relayUrl: string; httpOrigin: string; relayPublicKey: string; displayName: string;
      software: string | null; version: string | null; requiresMembership: boolean;
    }): Promise<string> {
      const data = await rpc("upsert_hivra_buzz_connection", {
        p_user_id: userId, p_id: id, p_relay_url: input.relayUrl, p_http_origin: input.httpOrigin,
        p_relay_public_key: input.relayPublicKey, p_display_name: input.displayName,
        p_software: input.software, p_relay_version: input.version,
        p_requires_membership: input.requiresMembership,
      });
      if (typeof data !== "string" || !Id.safeParse(data).success) throw new BuzzStoreError();
      return data;
    },
    async admit(userId: string, input: {
      bindingId: string; connectionId: string; agentId: string; operationId: string;
      requestDigest: string; publicKey: string; encryptedPrivateKey: string; encryptedInviteCode: string;
    }): Promise<BuzzAdmitResult> {
      const data = await rpc("admit_hivra_buzz_binding", {
        p_user_id: userId, p_binding_id: input.bindingId, p_connection_id: input.connectionId,
        p_agent_id: input.agentId, p_operation_id: input.operationId, p_request_digest: input.requestDigest,
        p_public_key: input.publicKey, p_encrypted_private_key: input.encryptedPrivateKey,
        p_encrypted_invite_code: input.encryptedInviteCode,
      });
      const parsed = z.object({
        status: z.enum(["invalid_request", "not_found", "agent_not_found", "operation_conflict",
          "already_bound", "claim_pending", "joined", "leave_pending", "revoked"]),
        bindingId: Id.optional(),
      }).strict().safeParse(data);
      if (!parsed.success) throw new BuzzStoreError();
      return parsed.data;
    },
    async claimMembership(userId: string, bindingId: string): Promise<BuzzBindingRow | null> {
      const data = await rpc("claim_hivra_buzz_membership", { p_user_id: userId, p_binding_id: bindingId });
      if (data === null) return null;
      const parsed = BuzzBindingRowSchema.safeParse(data);
      if (!parsed.success || parsed.data.id !== bindingId || parsed.data.status !== "claim_pending"
        || !parsed.data.lease_id || !parsed.data.lease_expires_at) throw new BuzzStoreError();
      return parsed.data;
    },
    async settleMembership(userId: string, bindingId: string, leaseId: string, receipt: unknown): Promise<boolean> {
      const data = await rpc("settle_hivra_buzz_membership", {
        p_user_id: userId, p_binding_id: bindingId, p_lease_id: leaseId, p_receipt: receipt,
      });
      if (typeof data !== "boolean") throw new BuzzStoreError();
      return data;
    },
    async abandonMembership(userId: string, bindingId: string, leaseId: string, errorCode: string): Promise<boolean> {
      const data = await rpc("abandon_hivra_buzz_membership", {
        p_user_id: userId, p_binding_id: bindingId, p_lease_id: leaseId, p_error_code: errorCode,
      });
      if (typeof data !== "boolean") throw new BuzzStoreError();
      return data;
    },
    async claimLeave(userId: string, bindingId: string): Promise<BuzzBindingRow | null> {
      const data = await rpc("claim_hivra_buzz_leave", { p_user_id: userId, p_binding_id: bindingId });
      if (data === null) return null;
      const parsed = BuzzBindingRowSchema.safeParse(data);
      if (!parsed.success || parsed.data.id !== bindingId || parsed.data.status !== "leave_pending"
        || !parsed.data.lease_id || !parsed.data.lease_expires_at) throw new BuzzStoreError();
      return parsed.data;
    },
    async settleLeave(userId: string, bindingId: string, leaseId: string, receipt: unknown): Promise<boolean> {
      const data = await rpc("settle_hivra_buzz_leave", {
        p_user_id: userId, p_binding_id: bindingId, p_lease_id: leaseId, p_receipt: receipt,
      });
      if (typeof data !== "boolean") throw new BuzzStoreError();
      return data;
    },
    async confirmHealth(userId: string, bindingId: string, receipt: unknown): Promise<boolean> {
      const data = await rpc("confirm_hivra_buzz_health", {
        p_user_id: userId, p_binding_id: bindingId, p_receipt: receipt,
      });
      if (typeof data !== "boolean") throw new BuzzStoreError();
      return data;
    },
    async beginRuntimeInstall(userId: string, input: {
      bindingId: string; operationId: string; requestDigest: string; provider: "openai" | "anthropic" | "venice";
      model: string; ownerPublicKey: string; encryptedApiKey: string;
    }): Promise<BuzzRuntimeBeginResult> {
      const data = await rpc("begin_hivra_buzz_runtime_install", {
        p_user_id: userId, p_binding_id: input.bindingId, p_operation_id: input.operationId,
        p_request_digest: input.requestDigest, p_provider: input.provider, p_model: input.model,
        p_owner_public_key: input.ownerPublicKey, p_encrypted_api_key: input.encryptedApiKey,
      });
      const parsed = z.object({
        status: z.enum(["invalid_request", "not_found", "agent_not_ready", "operation_conflict", "install_pending", "active"]),
        bindingId: Id.optional(),
      }).strict().safeParse(data);
      if (!parsed.success) throw new BuzzStoreError();
      return parsed.data;
    },
    async claimRuntimeInstall(userId: string, bindingId: string): Promise<BuzzBindingRow | null> {
      const data = await rpc("claim_hivra_buzz_runtime_install", { p_user_id: userId, p_binding_id: bindingId });
      if (data === null) return null;
      const parsed = BuzzBindingRowSchema.safeParse(data);
      if (!parsed.success || parsed.data.id !== bindingId || parsed.data.runtime_status !== "install_pending"
        || !parsed.data.runtime_lease_id || !parsed.data.runtime_lease_expires_at) throw new BuzzStoreError();
      return parsed.data;
    },
    async settleRuntimeInstall(userId: string, bindingId: string, leaseId: string, receipt: unknown): Promise<boolean> {
      const data = await rpc("settle_hivra_buzz_runtime_install", {
        p_user_id: userId, p_binding_id: bindingId, p_lease_id: leaseId, p_receipt: receipt,
      });
      if (typeof data !== "boolean") throw new BuzzStoreError();
      return data;
    },
    async claimRuntimeRemove(userId: string, bindingId: string): Promise<BuzzBindingRow | null> {
      const data = await rpc("claim_hivra_buzz_runtime_remove", { p_user_id: userId, p_binding_id: bindingId });
      if (data === null) return null;
      const parsed = BuzzBindingRowSchema.safeParse(data);
      if (!parsed.success || parsed.data.id !== bindingId || parsed.data.runtime_status !== "remove_pending"
        || !parsed.data.runtime_lease_id || !parsed.data.runtime_lease_expires_at) throw new BuzzStoreError();
      return parsed.data;
    },
    async settleRuntimeRemove(userId: string, bindingId: string, leaseId: string, receipt: unknown): Promise<boolean> {
      const data = await rpc("settle_hivra_buzz_runtime_remove", {
        p_user_id: userId, p_binding_id: bindingId, p_lease_id: leaseId, p_receipt: receipt,
      });
      if (typeof data !== "boolean") throw new BuzzStoreError();
      return data;
    },
    async confirmRuntimeHealth(userId: string, bindingId: string, receipt: unknown): Promise<boolean> {
      const data = await rpc("confirm_hivra_buzz_runtime_health", {
        p_user_id: userId, p_binding_id: bindingId, p_receipt: receipt,
      });
      if (typeof data !== "boolean") throw new BuzzStoreError();
      return data;
    },
  };
}

export type BuzzStore = ReturnType<typeof createBuzzStore>;
