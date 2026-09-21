import "server-only";

import { z } from "zod";
import { encryptSecret, decryptSecret } from "@/lib/crypto";
import { supabaseAdmin } from "@/lib/supabase";
import {
  canonicalFirstBootHostKey, FIRST_BOOT_RECIPE_VERSION, verifyFirstBootChallengeSecret,
  type FirstBootBinding, type FirstBootChallenge,
} from "./first-boot-enrollment";
import { HetznerCreationReceiptSchema, type HetznerCreationReceipt } from "./hetzner-creation-receipt";
import { FIRST_BOOT_PREPARATION_CONFIRMATION } from "./provider-computer-setup-contracts";

export { FIRST_BOOT_PREPARATION_CONFIRMATION } from "./provider-computer-setup-contracts";
const PURPOSE = "hivra/first-boot-delivery/v1";
const UUID = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const DIGEST = z.string().regex(/^[0-9a-f]{64}$/);
const DATE = z.string().datetime({ offset: true }).transform(value => new Date(value).toISOString());
const SERVER = z.string().regex(/^[1-9][0-9]{0,15}$/).refine(value => Number.isSafeInteger(Number(value)));
const OrderScopeSchema = z.object({
  binding: z.object({userId:z.string().min(1).max(256),connectionId:UUID,
    connectionRevision:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),orderId:UUID,
    quoteFingerprint:DIGEST,recipeVersion:z.literal(FIRST_BOOT_RECIPE_VERSION)}).strict(),
  capacityIdempotencyKey:UUID,
}).strict();
export type FirstBootCreationScope = z.infer<typeof OrderScopeSchema>;
export const FirstBootRecipeExpectationSchema = z.object({
  attemptId:UUID,verifierSha256:DIGEST,recipeVersion:z.literal(FIRST_BOOT_RECIPE_VERSION),
}).strict();
export type FirstBootRecipeExpectation = z.infer<typeof FirstBootRecipeExpectationSchema>;
const RowSchema = z.object({
  order_id: UUID, user_id: z.string().min(1).max(256), connection_id: UUID,
  connection_revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  quote_fingerprint_sha256: DIGEST, attempt_id: UUID, capacity_idempotency_key: UUID,
  recipe_version: z.literal(FIRST_BOOT_RECIPE_VERSION),
  phase: z.enum(["staged","awaiting_identity","enrolled","revoked","failed"]),
  issued_at: DATE, expires_at: DATE, verifier_sha256: DIGEST,
  provider_server_id: SERVER.nullable(), host_public_key: z.string().max(256).nullable(),
  host_fingerprint_sha256: z.string().max(64).nullable(),
});
// Explicit private projection. Even enrollment reads do not select the token
// ciphertext, the project's API token or the administrative SSH private key.
const SELECT = Object.keys(RowSchema.shape).join(",");
export type StoredFirstBootEnrollment = {
  challenge: FirstBootChallenge;
  phase: z.infer<typeof RowSchema>["phase"];
  capacityIdempotencyKey: string;
  providerServerId: string | null;
  enrolledHostPublicKey: string | null;
  hostFingerprintSha256: string | null;
};

export class FirstBootStoreError extends Error {
  constructor(public readonly code:
    "database_unavailable" | "database_error" | "invalid_record" | "invalid_delivery" | "not_active") {
    super("First-boot storage failed: " + code);
    this.name = "FirstBootStoreError";
  }
}
function database() {
  if (!supabaseAdmin) throw new FirstBootStoreError("database_unavailable");
  return supabaseAdmin;
}
function record(value: unknown): StoredFirstBootEnrollment {
  const parsed = RowSchema.safeParse(value);
  if (!parsed.success) throw new FirstBootStoreError("invalid_record");
  const row = parsed.data;
  if (Date.parse(row.expires_at) - Date.parse(row.issued_at) !== 900_000) throw new FirstBootStoreError("invalid_record");
  if (row.host_public_key !== null) {
    const key = canonicalFirstBootHostKey(row.host_public_key);
    if (key.publicKey !== row.host_public_key || key.fingerprintSha256 !== row.host_fingerprint_sha256) {
      throw new FirstBootStoreError("invalid_record");
    }
  } else if (row.host_fingerprint_sha256 !== null) throw new FirstBootStoreError("invalid_record");
  if ((row.phase === "staged" && row.provider_server_id !== null)
    || (["awaiting_identity","enrolled"].includes(row.phase) && row.provider_server_id === null)
    || (row.phase === "enrolled" && row.host_public_key === null)
    || (["staged","awaiting_identity"].includes(row.phase) && row.host_public_key !== null)) {
    throw new FirstBootStoreError("invalid_record");
  }
  return {
    challenge: {version:1, binding:{userId:row.user_id,connectionId:row.connection_id,
      connectionRevision:row.connection_revision,orderId:row.order_id,attemptId:row.attempt_id,
      quoteFingerprint:row.quote_fingerprint_sha256,recipeVersion:row.recipe_version},
    issuedAt:row.issued_at,expiresAt:row.expires_at,verifierSha256:row.verifier_sha256},
    phase:row.phase,capacityIdempotencyKey:row.capacity_idempotency_key,
    providerServerId:row.provider_server_id,enrolledHostPublicKey:row.host_public_key,
    hostFingerprintSha256:row.host_fingerprint_sha256,
  };
}

/** Private capability lookup before proof validation. Never return this record
 * as an unauthenticated HTTP response; even its verifier is private evidence.
 */
export async function loadFirstBootEnrollment(orderId: string, attemptId: string): Promise<StoredFirstBootEnrollment | null> {
  if (!UUID.safeParse(orderId).success || !UUID.safeParse(attemptId).success) return null;
  const {data,error} = await database().from("infrastructure_first_boot_enrollments")
    .select(SELECT).eq("order_id",orderId).eq("attempt_id",attemptId).maybeSingle();
  if (error) throw new FirstBootStoreError("database_error");
  return data ? record(data) : null;
}

/** Discover the one original preparation attempt without loading any secret.
 * The browser cannot supply an attempt or swap the confirmed order binding.
 */
export async function loadFirstBootEnrollmentForOrder(input:FirstBootCreationScope):Promise<StoredFirstBootEnrollment|null> {
  const parsed=OrderScopeSchema.safeParse(input);
  if(!parsed.success) throw new FirstBootStoreError("invalid_record");
  const current=parsed.data,b=current.binding;
  const {data,error}=await database().from("infrastructure_first_boot_enrollments").select(SELECT)
    .eq("user_id",b.userId).eq("connection_id",b.connectionId).eq("connection_revision",b.connectionRevision)
    .eq("order_id",b.orderId).eq("quote_fingerprint_sha256",b.quoteFingerprint)
    .eq("recipe_version",b.recipeVersion).eq("capacity_idempotency_key",current.capacityIdempotencyKey).maybeSingle();
  if(error) throw new FirstBootStoreError("database_error");
  if(data===null) return null;
  const stored=record(data);
  if(stored.capacityIdempotencyKey!==current.capacityIdempotencyKey
    || Object.entries(b).some(([key,value])=>stored.challenge.binding[key as keyof FirstBootBinding]!==value)) {
    throw new FirstBootStoreError("invalid_record");
  }
  return stored;
}

/** Admission must atomically agree with the recipe that was rendered. Null
 * is handled by the legacy RPC; this adapter only admits a staged first boot.
 */
export async function markFirstBootServerPostAttempted(input:{
  userId:string;connectionId:string;expectedRevision:number;orderId:string;idempotencyKey:string;
  providerSshKeyId:string;attemptedAt:string;expectedEnrollment:FirstBootRecipeExpectation;
}):Promise<boolean> {
  const expected=FirstBootRecipeExpectationSchema.safeParse(input.expectedEnrollment);
  if(!expected.success) throw new FirstBootStoreError("invalid_record");
  const {data,error}=await database().rpc("mark_hetzner_server_post_for_recipe",{
    p_user_id:input.userId,p_connection_id:input.connectionId,p_expected_revision:input.expectedRevision,
    p_order_id:input.orderId,p_idempotency_key:input.idempotencyKey,p_provider_ssh_key_id:input.providerSshKeyId,
    p_attempted_at:input.attemptedAt,p_expected_enrollment:expected.data,
  });
  if(error || typeof data!=="boolean") throw new FirstBootStoreError("database_error");
  return data;
}

function openDelivery(ciphertext: unknown, stored: StoredFirstBootEnrollment, binding: FirstBootBinding, now: Date) {
  try {
    if (stored.phase !== "staged" || typeof ciphertext !== "string" || ciphertext.length > 16_384) throw new Error();
    const payload = z.object({version:z.literal(1),purpose:z.literal(PURPOSE),
      token:z.string().regex(/^hbe1_[A-Za-z0-9_-]{43}$/),verifierSha256:DIGEST}).strict()
      .parse(JSON.parse(decryptSecret(ciphertext)));
    if (payload.verifierSha256 !== stored.challenge.verifierSha256) throw new Error();
    verifyFirstBootChallengeSecret({challenge:stored.challenge,currentBinding:binding,token:payload.token,now});
    return {token:payload.token,challenge:stored.challenge};
  } catch {
    throw new FirstBootStoreError("invalid_delivery");
  }
}

/** Called only by the explicitly confirmed, authenticated preparation flow
 * before the server POST. Replays reuse the original sealed token; no fresh
 * capability is substituted into a previously recorded create attempt.
 */
export async function stageFirstBootEnrollment(input: {
  binding: FirstBootBinding; capacityIdempotencyKey: string;
  challenge: FirstBootChallenge; token: string;
  confirmation: typeof FIRST_BOOT_PREPARATION_CONFIRMATION; now?: Date;
}): Promise<{record:StoredFirstBootEnrollment;delivery:{token:string;challenge:FirstBootChallenge}} | null> {
  const now = input.now ?? new Date();
  const challenge = verifyFirstBootChallengeSecret({...input,currentBinding:input.binding,now});
  if (input.confirmation !== FIRST_BOOT_PREPARATION_CONFIRMATION || !UUID.safeParse(input.capacityIdempotencyKey).success) {
    throw new FirstBootStoreError("invalid_delivery");
  }
  let sealed: string;
  try {
    sealed = encryptSecret(JSON.stringify({version:1,purpose:PURPOSE,token:input.token,verifierSha256:challenge.verifierSha256}));
  } catch { throw new FirstBootStoreError("invalid_delivery"); }
  const b = input.binding;
  const {data,error} = await database().rpc("stage_hetzner_first_boot",{
    p_user_id:b.userId,p_connection_id:b.connectionId,p_revision:b.connectionRevision,p_order_id:b.orderId,
    p_capacity_key:input.capacityIdempotencyKey,p_attempt_id:b.attemptId,p_quote_fingerprint:b.quoteFingerprint,
    p_recipe_version:b.recipeVersion,p_issued_at:challenge.issuedAt,p_expires_at:challenge.expiresAt,
    p_verifier:challenge.verifierSha256,p_encrypted_token:sealed,p_confirmation:input.confirmation,
  });
  if (error || !data || typeof data !== "object") throw new FirstBootStoreError("database_error");
  if (data.outcome === "rejected") return null;
  if (data.outcome !== "staged") throw new FirstBootStoreError("database_error");
  const stored = record(data.record);
  if (stored.capacityIdempotencyKey !== input.capacityIdempotencyKey) throw new FirstBootStoreError("invalid_record");
  return {record:stored,delivery:openDelivery(data.record?.encrypted_token,stored,b,now)};
}

/** Private recovery of an already-staged delivery; not a new challenge. */
export async function loadStagedFirstBootDelivery(input: {
  binding:FirstBootBinding;capacityIdempotencyKey:string;now?:Date;
}) {
  const b = input.binding;
  const {data,error} = await database().from("infrastructure_first_boot_enrollments")
    .select(SELECT+",encrypted_token").eq("order_id",b.orderId).eq("attempt_id",b.attemptId)
    .eq("user_id",b.userId).eq("connection_id",b.connectionId).eq("connection_revision",b.connectionRevision)
    .eq("capacity_idempotency_key",input.capacityIdempotencyKey).maybeSingle();
  if (error) throw new FirstBootStoreError("database_error");
  if (!data) throw new FirstBootStoreError("not_active");
  const stored = record(data);
  if (stored.capacityIdempotencyKey !== input.capacityIdempotencyKey) throw new FirstBootStoreError("invalid_record");
  const secret = z.object({encrypted_token:z.string().max(16_384).nullable()}).safeParse(data);
  if (!secret.success) throw new FirstBootStoreError("invalid_record");
  return openDelivery(secret.data.encrypted_token,stored,b,input.now??new Date());
}

/** The caller must verify/receipt the firewall and separately own power-on.
 * This operation only makes a completed original server eligible to enroll.
 */
export async function armFirstBootEnrollment(input: {
  binding:FirstBootBinding;capacityIdempotencyKey:string;creationReceipt:HetznerCreationReceipt;
}):Promise<boolean> {
  const parsed = HetznerCreationReceiptSchema.safeParse(input.creationReceipt);
  if (!parsed.success) throw new FirstBootStoreError("invalid_record");
  const b = input.binding;
  const {data,error} = await database().rpc("arm_hetzner_first_boot",{
    p_user_id:b.userId,p_connection_id:b.connectionId,p_revision:b.connectionRevision,p_order_id:b.orderId,
    p_attempt_id:b.attemptId,p_capacity_key:input.capacityIdempotencyKey,
    p_server_id:parsed.data.serverId,p_creation_receipt:parsed.data,
  });
  if (error || typeof data !== "boolean") throw new FirstBootStoreError("database_error");
  return data;
}

/** Call only after verifying the scoped proof and fresh exact provider
 * identity. Database locks recheck current authority and expiry at commit.
 */
export async function consumeFirstBootEnrollment(input: {
  binding:FirstBootBinding;providerServerId:string;verifierSha256:string;
  hostPublicKey:string;hostFingerprintSha256:string;providerObservedAt:Date;
}):Promise<"enrolled"|"acknowledgement_replay"|"identity_changed"|"rejected"> {
  const b = input.binding;
  const host = canonicalFirstBootHostKey(input.hostPublicKey);
  if (host.publicKey !== input.hostPublicKey || host.fingerprintSha256 !== input.hostFingerprintSha256
    || !Number.isFinite(input.providerObservedAt.getTime())) throw new FirstBootStoreError("invalid_record");
  const {data,error} = await database().rpc("consume_hetzner_first_boot",{
    p_user_id:b.userId,p_connection_id:b.connectionId,p_revision:b.connectionRevision,p_order_id:b.orderId,
    p_attempt_id:b.attemptId,p_server_id:input.providerServerId,p_verifier:input.verifierSha256,
    p_host_key:host.publicKey,p_host_fingerprint:host.fingerprintSha256,
    p_provider_observed_at:input.providerObservedAt.toISOString(),
  });
  if (error || !["enrolled","acknowledgement_replay","identity_changed","rejected"].includes(data)) {
    throw new FirstBootStoreError("database_error");
  }
  return data;
}
