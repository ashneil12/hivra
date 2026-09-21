import "server-only";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase";
import { createHetznerExternalCleanupReader } from "@/lib/hetzner/client";
import { loadHetznerCloudConnectionSecret } from "./hetzner-cloud-store";
import { HetznerExternalCleanupRequestSchema, HetznerExternalCleanupResultSchema,
  type HetznerExternalCleanupRequest } from "./hetzner-external-cleanup-contracts";

const resourceId = z.string().regex(/^[1-9]\d*$/).refine(value => Number.isSafeInteger(Number(value)));
const ScopeSchema = z.object({
  orderId: z.string().uuid(), connectionId: z.string().uuid(), revision: z.number().int().positive(),
  serverId: resourceId.nullable(), sshKeyId: resourceId.nullable(), serverName: z.string(),
  stateSha256: z.string().regex(/^[0-9a-f]{64}$/), resolutionId: z.string().uuid().nullable(), eligible: z.boolean(),
}).strict();
type Scope = z.infer<typeof ScopeSchema>;
type Evidence = { version: 1; serverId: string; sshKeyId: string; observedAt: string;
  serverAbsent: true; sshKeyAbsent: true; projectServers: 0; projectPrimaryIps: 0 };
type Binding = { userId: string; connectionId: string; request: HetznerExternalCleanupRequest };
export class HetznerExternalCleanupError extends Error {
  constructor(readonly code: "not_found" | "not_eligible" | "confirmation_changed" | "connection_changed"
    | "state_changed" | "evidence_expired" | "resources_remain" | "verification_unavailable") {
    super(code); this.name = "HetznerExternalCleanupError";
  }
}
async function rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (!supabaseAdmin) throw new HetznerExternalCleanupError("verification_unavailable");
  const { data, error } = await supabaseAdmin.rpc(name, args);
  if (error) throw new HetznerExternalCleanupError("verification_unavailable");
  return data;
}
async function loadScope({ userId, connectionId, request }: Binding): Promise<Scope> {
  const data = await rpc("hetzner_external_cleanup_scope", {
    p_user_id: userId, p_connection_id: connectionId, p_order_id: request.orderId,
  });
  if (data === null) throw new HetznerExternalCleanupError("not_found");
  return ScopeSchema.parse(data);
}
async function resolve(binding: Binding, scope: Scope, evidence: Evidence | null) {
  const value = await rpc("resolve_hetzner_external_cleanup", {
    p_user_id: binding.userId, p_connection_id: binding.connectionId, p_revision: scope.revision,
    p_order_id: binding.request.orderId, p_idempotency_key: binding.request.idempotencyKey,
    p_server_name: binding.request.serverName, p_state_sha256: scope.stateSha256, p_evidence: evidence,
  }) as { outcome?: string; resolutionId?: string; resolvedAt?: string } | null;
  if (value?.outcome !== "resolved") {
    const code = value?.outcome;
    if (code === "not_found" || code === "not_eligible" || code === "confirmation_changed"
      || code === "connection_changed" || code === "state_changed" || code === "evidence_expired") {
      throw new HetznerExternalCleanupError(code);
    }
    throw new HetznerExternalCleanupError("verification_unavailable");
  }
  return HetznerExternalCleanupResultSchema.parse({ resolutionId: value.resolutionId, resolvedAt: value.resolvedAt });
}
const defaults = { loadScope, resolve, loadSecret: loadHetznerCloudConnectionSecret,
  reader: createHetznerExternalCleanupReader, now: () => new Date(), monotonicNow: () => performance.now() };

export async function verifyHetznerExternalCleanup(
  userId: string, connectionId: string, rawRequest: HetznerExternalCleanupRequest,
  overrides: Partial<typeof defaults> = {},
) {
  const deps = { ...defaults, ...overrides };
  const request = HetznerExternalCleanupRequestSchema.parse(rawRequest);
  const binding = { userId, connectionId, request };
  const scope = ScopeSchema.parse(await deps.loadScope(binding));
  if (scope.orderId !== request.orderId || scope.connectionId !== connectionId) throw new HetznerExternalCleanupError("not_found");
  if (scope.serverName !== request.serverName) throw new HetznerExternalCleanupError("confirmation_changed");
  // Idempotent resolution replay is local only, and never opens credentials.
  if (scope.resolutionId) return deps.resolve(binding, scope, null);
  if (!scope.eligible || !scope.serverId || !scope.sshKeyId) throw new HetznerExternalCleanupError("not_eligible");
  const secret = await deps.loadSecret(userId, connectionId, { requireBoundToken: true });
  if (secret.revision !== scope.revision || secret.connection.status !== "ready") throw new HetznerExternalCleanupError("connection_changed");
  const started = deps.monotonicNow(), observedAt = deps.now().toISOString();
  let absent: boolean;
  try { absent = await deps.reader(secret.apiToken).verify(Number(scope.serverId), Number(scope.sshKeyId)); }
  catch { throw new HetznerExternalCleanupError("verification_unavailable"); }
  if (deps.monotonicNow() - started > 25_000) throw new HetznerExternalCleanupError("evidence_expired");
  if (!absent) throw new HetznerExternalCleanupError("resources_remain");
  return deps.resolve(binding, scope, { version: 1, serverId: scope.serverId, sshKeyId: scope.sshKeyId,
    observedAt, serverAbsent: true, sshKeyAbsent: true, projectServers: 0, projectPrimaryIps: 0 });
}
