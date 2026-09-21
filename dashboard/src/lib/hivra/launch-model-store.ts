import "server-only";

import { createHmac } from "node:crypto";
import { z } from "zod";
import { getLaunchFingerprintKeyCandidates, encryptSecret } from "@/lib/crypto";
import { supabaseAdmin } from "@/lib/supabase";
import { MAX_CONTEXT_LEN } from "./agent-limits";
import { ModelKeySelectionSchema } from "./model-key-selection";
import { ModelKeyStoreError } from "./model-key-store";

const Id = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Model = z.string().regex(/^[A-Za-z0-9._:\/\[\]-]{1,64}$/);
const PublicSelection = z.discriminatedUnion("mode", [
  z.object({ provider: z.literal("venice"), mode: z.literal("byok"), model: Model }).strict(),
  z.object({ provider: z.literal("venice"), mode: z.literal("managed"), model: Model,
    walletType: z.enum(["card", "hermesos"]) }).strict(),
]);
const Fingerprint = z.object({ version: z.union([z.literal(1), z.literal(2)]), keyTag: Digest, digest: Digest }).strict();
export type LaunchModelFingerprint = z.infer<typeof Fingerprint>;

/** Canonical user intent only, not selected host, generated allocation IDs or
 * randomized ciphertext. Resubmitting the same request after an uncertain
 * response must locate the original allocation, not choose another computer. */
export const LaunchModelIntentSchema = z.object({
  type: z.literal("codex"), name: z.string().trim().min(1).max(256),
  cpu: z.number().min(0.5).max(9999).multipleOf(0.5), ram: z.number().int().positive().max(9999), browser: z.boolean(),
  maximumCpu: z.number().min(0.5).max(9999).multipleOf(0.5).optional(),
  maximumRam: z.number().int().positive().max(9999).optional(),
  goal: z.string().max(32).nullable(), context: z.string().max(MAX_CONTEXT_LEN).nullable(),
  personality: z.string().max(48).nullable(), emoji: z.string().max(16).nullable(),
  templateSkills: z.array(z.string().max(128)).max(100),
  deployment: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("hivra-managed") }).strict(),
    z.object({ mode: z.literal("self-managed"), connectionId: Id, targetId: Id,
      expectedConnectionRevision: z.number().int().positive().safe() }).strict(),
  ]),
  llm: ModelKeySelectionSchema.unwrap(),
}).strict();
export type LaunchModelIntent = z.infer<typeof LaunchModelIntentSchema>;

export class LaunchModelRequestError extends Error {
  constructor(readonly code: "invalid_request" | "request_conflict") {
    super(code === "invalid_request"
      ? "Include the complete launch settings and a stable launch request ID."
      : "That launch request already belongs to another selection. Open the original computer before starting a new launch.");
  }
}

export function launchModelFingerprints(userId: string, requestId: string, raw: unknown,
  explicitLegacyKeys?: readonly Buffer[]) {
  const parsed = LaunchModelIntentSchema.safeParse(raw);
  if (!userId.trim() || userId.length > 256 || !Id.safeParse(requestId).success || !parsed.success) {
    throw new LaunchModelRequestError("invalid_request");
  }
  const keys = explicitLegacyKeys
    ? explicitLegacyKeys.map(key => ({ key, version: 1 as const }))
    : getLaunchFingerprintKeyCandidates().map(({ key, version }) => ({ key, version }));
  if (!keys.length || keys.length > 2 || keys.some(({key}) => key.length !== 32)) throw new ModelKeyStoreError();
  // Parsing fixes field order and model defaults before hashing. Domain
  // separation keeps these HMACs independent of AES key use and guest receipts.
  return keys.map(({key,version}) => ({ version,
    keyTag: createHmac("sha256", key).update(`hivra-launch-model-key-tag-v${version}`).digest("hex"),
    digest: createHmac("sha256", key)
      .update(JSON.stringify([`hivra-launch-model-request-v${version}`, userId, requestId, parsed.data]))
      .digest("hex"),
  }));
}

const LaunchModelRequestSchema = z.object({
  user_id: z.string().min(1).max(256), request_id: Id, agent_id: Id, provision_operation_id: Id, model_operation_id: Id,
  fingerprint_version: z.union([z.literal(1), z.literal(2)]), fingerprint_key_tag: Digest, request_digest: Digest,
  binding: z.record(z.string(), z.unknown()), selection: PublicSelection, encrypted_key: z.string().nullable(),
  phase: z.enum(["waiting", "admitting", "promoted", "cancelled", "deleted"]),
  attempted_at: z.string().nullable(), attempt_id: Id.nullable(), attempt_expires_at: z.string().nullable(),
  created_at: z.string(), promoted_at: z.string().nullable(), closed_at: z.string().nullable(),
});
export type LaunchModelRequest = z.infer<typeof LaunchModelRequestSchema>;

export function matchesLaunchModelRequest(row: LaunchModelRequest, fingerprints: LaunchModelFingerprint[]) {
  return fingerprints.some(f => f.version === row.fingerprint_version && f.keyTag === row.fingerprint_key_tag && f.digest === row.request_digest);
}

/** Whitelist mirrors the private reservation RPC. No launch plaintext, active
 * credential, arbitrary command, readiness or guest identity can be inserted. */
const Reservation = z.object({
  id: Id, type: z.literal("codex"), name: z.string().min(1).max(256), cpu: z.number().min(0.5).max(9999).multipleOf(0.5), ram: z.number().int().positive(),
  cpu_max: z.number().min(0.5).max(9999).multipleOf(0.5).optional(), ram_max: z.number().int().positive().max(9999).optional(),
  proxmox_host: z.string().min(1).max(256), deployment_mode: z.enum(["hivra-managed", "self-managed"]),
  computer_substrate: z.enum(["proxmox-kvm", "provider-vm"]), operation_id: Id, infrastructure_binding_token_hash: Digest,
  managed_provisioner_channel: z.enum(["default", "canary"]),
  pool_id: Id.nullable().optional(), goal: z.string().max(32).nullable().optional(),
  context: z.string().max(MAX_CONTEXT_LEN).nullable().optional(), personality: z.string().max(48).nullable().optional(),
  emoji: z.string().max(16).nullable().optional(), template_skills: z.array(z.string().max(128)).max(100).nullable().optional(),
  infrastructure_connection_id: Id.nullable().optional(), deployment_target_id: Id.nullable().optional(),
  infrastructure_connection_revision: z.number().int().positive().safe().nullable().optional(),
  provider_capacity_order_id: Id.nullable().optional(), provider_enrollment_attempt_id: Id.nullable().optional(),
  provider_server_id: z.string().regex(/^[1-9][0-9]{0,15}$/).nullable().optional(),
}).strict().superRefine((row, context) => {
  if (
    row.managed_provisioner_channel === "canary" &&
    (row.deployment_mode !== "hivra-managed" || row.computer_substrate !== "proxmox-kvm")
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Canary provisioner delivery requires managed Proxmox.",
    });
  }
});
export type LaunchModelReservation = z.infer<typeof Reservation>;

/** Service-only custody. All callers supply the authenticated owner, and every
 * result is checked against that owner plus its original request or agent ID. */
export function createLaunchModelStore(db = supabaseAdmin) {
  if (!db) throw new ModelKeyStoreError();
  const client = db, columns = Object.keys(LaunchModelRequestSchema.shape).join(",");
  async function rpc(name: string, args: Record<string, unknown>) {
    try {
      const { data, error } = await client.rpc(name, args);
      if (error) throw new ModelKeyStoreError();
      return data;
    } catch { throw new ModelKeyStoreError(); }
  }
  async function find(userId: string, id: string, column: "request_id" | "agent_id") {
    let data: unknown;
    try {
      const result = await client.from("hivra_launch_model_requests").select(columns).eq("user_id", userId).eq(column, id).maybeSingle();
      if (result.error) throw new ModelKeyStoreError();
      data = result.data;
    } catch { throw new ModelKeyStoreError(); }
    if (data === null) return null;
    const parsed = LaunchModelRequestSchema.safeParse(data);
    if (!parsed.success || parsed.data.user_id !== userId || parsed.data[column] !== id) throw new ModelKeyStoreError();
    return parsed.data;
  }
  return {
    byAgent: (userId: string, agentId: string) => find(userId, agentId, "agent_id"),
    byRequest: (userId: string, requestId: string) => find(userId, requestId, "request_id"),
    async existing(userId: string, requestId: string, fingerprints: LaunchModelFingerprint[]) {
      const row = await find(userId, requestId, "request_id");
      if (row && !matchesLaunchModelRequest(row, fingerprints)) throw new LaunchModelRequestError("request_conflict");
      return row;
    },
    async reserve(input: { userId: string; requestId: string; modelOperationId: string; fingerprints: LaunchModelFingerprint[];
      agent: LaunchModelReservation; llm: unknown }, encrypt = encryptSecret) {
      const selected = ModelKeySelectionSchema.safeParse(input.llm), row = Reservation.safeParse(input.agent);
      if (!selected.success || !selected.data || !row.success || !Id.safeParse(input.requestId).success
        || !Id.safeParse(input.modelOperationId).success || !z.array(Fingerprint).min(1).max(2).safeParse(input.fingerprints).success) {
        throw new LaunchModelRequestError("invalid_request");
      }
      const selection = selected.data;
      let encryptedKey: string | null = null;
      try { encryptedKey = selection.mode === "byok" ? encrypt(selection.apiKey) : null; }
      catch { throw new ModelKeyStoreError(); }
      let result: unknown;
      try {
        result = await rpc("reserve_hivra_launch_model_request_v2", { p_user_id: input.userId, p_request_id: input.requestId,
          p_fingerprints: input.fingerprints, p_model_operation_id: input.modelOperationId, p_agent: row.data,
          p_selection: { provider: selection.provider, mode: selection.mode, model: selection.model,
            ...(selection.mode === "managed" ? { walletType: selection.walletType } : {}) }, p_encrypted_key: encryptedKey });
      } catch {
        // Lost acknowledgement is not permission for another insert or guest
        // dispatch. Read the stable original request, or retain uncertainty.
        const saved = await find(input.userId, input.requestId, "request_id");
        if (!saved) throw new ModelKeyStoreError();
        if (!matchesLaunchModelRequest(saved, input.fingerprints)) throw new LaunchModelRequestError("request_conflict");
        return { created: false, agentId: saved.agent_id, phase: saved.phase };
      }
      const parsed = z.discriminatedUnion("status", [
        z.object({ status: z.literal("reserved"), agentId: Id, phase: z.literal("waiting") }).strict(),
        z.object({ status: z.literal("existing"), agentId: Id, phase: LaunchModelRequestSchema.shape.phase }).strict(),
        z.object({ status: z.literal("request_conflict") }).strict(),
        z.object({ status: z.literal("invalid_request") }).strict(),
      ]).safeParse(result);
      if (!parsed.success) throw new ModelKeyStoreError();
      if (parsed.data.status === "invalid_request" || parsed.data.status === "request_conflict") throw new LaunchModelRequestError(parsed.data.status);
      if (parsed.data.status === "reserved") {
        if (parsed.data.agentId !== row.data.id) throw new ModelKeyStoreError();
        return { created: true, agentId: parsed.data.agentId, phase: parsed.data.phase };
      }
      const saved = await find(input.userId, input.requestId, "request_id");
      if (!saved || !matchesLaunchModelRequest(saved, input.fingerprints) || saved.agent_id !== parsed.data.agentId) throw new ModelKeyStoreError();
      return { created: false, agentId: saved.agent_id, phase: saved.phase };
    },
    async claim(userId: string, agentId: string, requestId: string, automatic: boolean) {
      const data = await rpc("claim_hivra_launch_model_attempt", {
        p_user_id: userId, p_agent_id: agentId, p_request_id: requestId, p_automatic: automatic,
      });
      if (data === null) return null;
      const parsed = LaunchModelRequestSchema.safeParse(data);
      if (!parsed.success || parsed.data.user_id !== userId || parsed.data.agent_id !== agentId || parsed.data.request_id !== requestId
        || parsed.data.phase !== "waiting" || !parsed.data.attempt_id || !parsed.data.attempt_expires_at
        || !Number.isFinite(Date.parse(parsed.data.attempt_expires_at))) throw new ModelKeyStoreError();
      return parsed.data;
    },
    async promote(userId: string, agentId: string, requestId: string, attemptId: string, binding: Record<string, unknown>, request: Record<string, unknown>) {
      const data = await rpc("promote_hivra_launch_model_request", { p_user_id: userId, p_agent_id: agentId,
        p_request_id: requestId, p_attempt_id: attemptId, p_binding: binding, p_request: request });
      if (typeof data !== "string") throw new ModelKeyStoreError();
      return data;
    },
    async cancel(userId: string, agentId: string, requestId: string) {
      const data = await rpc("cancel_hivra_launch_model_request", { p_user_id: userId, p_agent_id: agentId, p_request_id: requestId });
      if (typeof data !== "boolean") throw new ModelKeyStoreError();
      return data;
    },
  };
}
export type LaunchModelStore = ReturnType<typeof createLaunchModelStore>;
