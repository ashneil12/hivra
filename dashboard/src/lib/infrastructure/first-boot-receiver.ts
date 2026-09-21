import "server-only";

import { z } from "zod";
import { createHetznerCloudProjectClient, type HetznerServer } from "@/lib/hetzner/client";
import { enforceRateLimit } from "@/lib/rate-limit";
import { supabaseAdmin } from "@/lib/supabase";
import { HetznerCloudCapacityQuoteDtoSchema } from "./contracts";
import { InfrastructureConnectionStoreError } from "./connection-store";
import { assertServerIdentityMatchesQuote } from "./hetzner-cloud";
import { loadHetznerCloudConnectionSecret } from "./hetzner-cloud-store";
import { HetznerCreationReceiptSchema, isExactHetznerCreateActionResources } from "./hetzner-creation-receipt";
import { HetznerCurrentServerShapeSchema, parseHetznerCurrentServerShapeEvidence } from "./hetzner-current-server-shape";
import {
  FirstBootEnrollmentError, FirstBootRegistrationSchema, inspectFirstBootEnrollmentProof,
  type FirstBootBinding,
} from "./first-boot-enrollment";
import { consumeFirstBootEnrollment, FirstBootStoreError, loadFirstBootEnrollment } from "./first-boot-store";

export class FirstBootReceiverError extends Error {
  constructor(readonly code: "rejected" | "unavailable" | "rate_limited") {
    super("First-boot enrollment " + code);
    this.name = "FirstBootReceiverError";
  }
}
const EvidenceSchema = z.object({
  id: z.string().uuid(), user_id: z.string(), connection_id: z.string().uuid(),
  active_connection_id: z.string().uuid(), connection_revision: z.number().int().positive(),
  provider: z.literal("hetzner-cloud"), status: z.literal("created_off"),
  quote_fingerprint_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  quote_snapshot: HetznerCloudCapacityQuoteDtoSchema,
  provider_labels: z.object({
    "hivra-operation": z.string().uuid(), "hivra-quote": z.string().regex(/^[0-9a-f]{32}$/),
    "hivra-managed": z.literal("true"),
  }).strict(),
  provider_resource_id: z.string(), provider_action_id: z.string(),
  provider_server_status: z.literal("accepted"),
  provider_creation_receipt: HetznerCreationReceiptSchema,
  current_server_shape: HetznerCurrentServerShapeSchema.nullable().optional(),
  current_server_shape_fingerprint_sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(),
});
export type FirstBootCapacityEvidence = z.infer<typeof EvidenceSchema>;

/** Proof-gated private metadata read. Excludes every encrypted bundle/key;
 * authoritative row locks and revocation are rechecked by consume at commit.
 */
export async function loadFirstBootCapacityEvidence(binding: FirstBootBinding): Promise<FirstBootCapacityEvidence | null> {
  if (!supabaseAdmin) throw new FirstBootStoreError("database_unavailable");
  const {data,error} = await supabaseAdmin.from("infrastructure_capacity_orders")
    .select(Object.keys(EvidenceSchema.shape).join(","))
    .eq("id",binding.orderId).eq("user_id",binding.userId).eq("connection_id",binding.connectionId)
    .eq("active_connection_id",binding.connectionId).eq("connection_revision",binding.connectionRevision)
    .maybeSingle();
  if (error) throw new FirstBootStoreError("database_error");
  if (!data) return null;
  const parsed = EvidenceSchema.safeParse(data);
  if (!parsed.success) throw new FirstBootStoreError("invalid_record");
  return parsed.data;
}

type Dependencies = {
  load: typeof loadFirstBootEnrollment;
  evidence: typeof loadFirstBootCapacityEvidence;
  secret: typeof loadHetznerCloudConnectionSecret;
  client: (token: string) => Pick<ReturnType<typeof createHetznerCloudProjectClient>, "getServer" | "getAction">;
  consume: typeof consumeFirstBootEnrollment;
  admit: (binding: FirstBootBinding) => boolean;
  now: () => Date;
};
const defaults: Dependencies = {
  load:loadFirstBootEnrollment,evidence:loadFirstBootCapacityEvidence,
  secret:loadHetznerCloudConnectionSecret,client:createHetznerCloudProjectClient,
  consume:consumeFirstBootEnrollment,now:()=>new Date(),
  admit:binding=>enforceRateLimit("first_boot_proved:"+binding.orderId,{limit:12,windowMs:60_000}).success,
};
const reject = (): never => { throw new FirstBootReceiverError("rejected"); };

export function assertFirstBootCapacityEvidence(evidence: FirstBootCapacityEvidence | null, binding: FirstBootBinding, serverId: string) {
  const parsed = EvidenceSchema.safeParse(evidence);
  if (!parsed.success) return reject();
  const e = parsed.data;
  const receipt = e.provider_creation_receipt;
  if (e.id !== binding.orderId || e.user_id !== binding.userId || e.connection_id !== binding.connectionId
    || e.active_connection_id !== binding.connectionId || e.connection_revision !== binding.connectionRevision
    || e.quote_fingerprint_sha256 !== binding.quoteFingerprint || e.quote_snapshot.id !== binding.orderId
    || e.quote_snapshot.connectionRevision !== binding.connectionRevision
    || e.quote_snapshot.connectionId !== binding.connectionId || e.provider_resource_id !== serverId
    || receipt.serverId !== serverId || e.provider_action_id !== receipt.action.id
    || e.provider_labels["hivra-operation"] !== binding.orderId
    || e.provider_labels["hivra-quote"] !== binding.quoteFingerprint.slice(0,32)) reject();
  try {
    parseHetznerCurrentServerShapeEvidence({
      shape: e.current_server_shape,
      fingerprintSha256: e.current_server_shape_fingerprint_sha256,
      capacityOrderId: e.id,
      connectionId: e.connection_id,
      connectionRevision: e.connection_revision,
      providerServerId: e.provider_resource_id,
    });
  } catch { reject(); }
  return e;
}

function assertServer(server: HetznerServer, e: FirstBootCapacityEvidence) {
  const receipt = e.provider_creation_receipt;
  if (String(server.id) !== receipt.serverId || typeof server.locked !== "boolean"
    || String(server.public_net?.ipv4?.id) !== receipt.primaryIpv4.id
    || server.public_net?.ipv4?.ip !== receipt.primaryIpv4.ip
    || String(server.public_net?.ipv6?.id) !== receipt.primaryIpv6.id
    || server.public_net?.ipv6?.ip !== receipt.primaryIpv6.ip) reject();
  // Validate immutable/configuration identity separately from operational
  // locking. A matching server still starting is retryable, never enrollable;
  // a changed disk/image/attachment must remain a hard refusal even if locked.
  try { assertServerIdentityMatchesQuote({...server,locked:false},e.quote_snapshot,e.provider_labels); }
  catch { reject(); }
  if (!["running","starting","initializing"].includes(server.status)) reject();
  if (server.locked || server.status === "starting" || server.status === "initializing") {
    throw new FirstBootReceiverError("unavailable");
  }
}

/** Machine-only one-purpose callback. No Clerk session, SSH, provider mutation,
 * target creation, preparation completion or readiness side effects.
 */
export async function receiveFirstBootEnrollment(input: {token:string;registration:unknown}, dependencies: Partial<Dependencies> = {}) {
  const deps = {...defaults,...dependencies};
  try {
    const parsed = FirstBootRegistrationSchema.safeParse(input.registration);
    if (!parsed.success || !/^hbe1_[A-Za-z0-9_-]{43}$/.test(input.token)) return reject();
    const stored = await deps.load(parsed.data.orderId,parsed.data.attemptId);
    if (!stored || stored.phase === "staged" || !stored.providerServerId) return reject();
    // Authenticate before reading a project token or making provider requests.
    const binding = stored.challenge.binding;
    const proof = inspectFirstBootEnrollmentProof({record:{...stored,phase:stored.phase},
      currentBinding:binding,expectedProviderServerId:stored.providerServerId,
      token:input.token,registration:parsed.data,now:deps.now()});
    if (!deps.admit(binding)) throw new FirstBootReceiverError("rate_limited");
    const e = assertFirstBootCapacityEvidence(await deps.evidence(binding),binding,stored.providerServerId);
    const current = await deps.secret(binding.userId,binding.connectionId,{requireBoundToken:true});
    if (current.connection.id !== binding.connectionId || current.connection.status !== "ready"
      || current.revision !== binding.connectionRevision) return reject();
    const client = deps.client(current.apiToken);
    // Start time, not completion time: delayed provider reads must not acquire
    // artificially fresh evidence. The database enforces the 30-second bound.
    const providerObservedAt = deps.now();
    const [server,action] = await Promise.all([
      client.getServer(Number(stored.providerServerId)),
      client.getAction(Number(e.provider_creation_receipt.action.id)),
    ]);
    // Recheck expiry after network I/O, before any retryable classification.
    // Hard identity/action failures must also dominate transient boot state.
    inspectFirstBootEnrollmentProof({record:{...stored,phase:stored.phase},currentBinding:binding,
      expectedProviderServerId:stored.providerServerId,token:input.token,registration:parsed.data,now:deps.now()});
    if (String(action.id) !== e.provider_action_id || action.command !== "create_server"
      || !isExactHetznerCreateActionResources(action, Number(stored.providerServerId), e.quote_snapshot.image.id)
      || !["running","success"].includes(action.status)) return reject();
    assertServer(server,e);
    if (action.status === "running") throw new FirstBootReceiverError("unavailable");
    // The SQL transaction serializes consumption against revocation and a
    // competing different key; observation alone cannot bypass that decision.
    const result = await deps.consume({binding,providerServerId:stored.providerServerId,
      verifierSha256:stored.challenge.verifierSha256,hostPublicKey:proof.hostPublicKey,
      hostFingerprintSha256:proof.hostFingerprintSha256,providerObservedAt});
    if (result !== "enrolled" && result !== "acknowledgement_replay") return reject();
    // Exact wire contract accepted by the vendored helper. No private record
    // or synthetic ready/completed state is returned to the guest.
    return {version:1 as const,accepted:true as const,orderId:binding.orderId,
      attemptId:binding.attemptId,hostFingerprintSha256:proof.hostFingerprintSha256};
  } catch (error) {
    if (error instanceof FirstBootReceiverError) throw error;
    if (error instanceof FirstBootEnrollmentError
      || (error instanceof InfrastructureConnectionStoreError
        && !["database_error","database_unavailable"].includes(error.code))) return reject();
    throw new FirstBootReceiverError("unavailable");
  }
}
