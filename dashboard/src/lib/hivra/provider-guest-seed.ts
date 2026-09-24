import "server-only";

// Guest seeds for Claude Code and Codex on computers in the owner's own cloud
// (provider VMs). This is the provider twin of the Proxmox host-to-guest seed
// lane: the same fixed, server-built guest scripts (identity files, skill
// files, the Computer Contract) reach the computer over the original enrolled
// SSH pin with the administrator key Hivra generated for it (ATT-05).
//
// Only a stable running computer is used: running, desired running, no
// lifecycle operation, its installer recorded as succeeded. The provider
// confirms the server is still the one Hivra enrolled at the address the row
// records, and the row is read again afterwards. Nothing here creates a
// lifecycle operation, a credential or a target.

import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase";
import { loadFirstBootRecipeVersion } from "@/lib/infrastructure/first-boot-store";
import { loadFirstBootOperation, parseFirstBootOperationScope } from "@/lib/infrastructure/first-boot-operations";
import { loadHetznerCloudCapacityBootstrap } from "@/lib/infrastructure/hetzner-cloud-store";
import { verifyEnrolledProviderReceipt } from "@/lib/infrastructure/enrolled-provider-receipt";
import { runProviderGuestSeed } from "@/lib/infrastructure/first-boot-ssh";
import { parseProviderGuestWorkerIdentity } from "@/lib/infrastructure/provider-guest-worker";
import { providerGuestBundleScopeSha256 } from "@/lib/infrastructure/provider-guest-bundle";
import { SELF_MANAGED_HIVRA_PROXMOX_HOST_SENTINEL } from "./agent-authority";
import { readAgentProviderDirectAccess } from "./provider-direct-access";

const Uuid = z.string().uuid();
const Ref = z.object({ userId: z.string().min(1).max(256), agentId: Uuid }).strict();
export type ProviderGuestSeedRef = z.infer<typeof Ref>;

const Row = z.object({
  id: Uuid, user_id: z.string(), type: z.enum(["claude-code", "codex"]),
  status: z.literal("running"), desired_state: z.literal("running"), operation_id: z.null(), operation_kind: z.null(),
  allocation_operation_id: Uuid, computer_substrate: z.literal("provider-vm"), deployment_mode: z.literal("self-managed"),
  proxmox_host: z.literal(SELF_MANAGED_HIVRA_PROXMOX_HOST_SENTINEL), vmid: z.null(),
  infrastructure_connection_id: Uuid, infrastructure_connection_revision: z.number().int().positive().safe(),
  deployment_target_id: Uuid, provider_capacity_order_id: Uuid, provider_enrollment_attempt_id: Uuid, provider_server_id: z.string(),
  provider_install_identity: z.unknown(), provider_install_outcome: z.literal("succeeded"),
  provider_install_stopped_at: z.string().refine(value => Number.isFinite(Date.parse(value))),
  cf_tunnel_id: Uuid.nullable(), cf_hostname: z.string().nullable(), chat_url: z.string().max(2048).nullable(),
  ip: z.string().min(7).max(15),
});

export type ProviderGuestSeedOutcome =
  | { ok: true; stdout: string }
  /** Not a stable running agent on a provider computer: nothing was sent. */
  | { ok: false; error: "not_eligible" }
  /** The provider, the pin or the computer could not be verified, or the
   * script failed. The computer may or may not have run it; seeds are
   * idempotent, so the caller retries later. */
  | { ok: false; error: "unreachable" };

function unavailable() { return new Error("Provider guest seed could not be verified"); }
function database() { if (!supabaseAdmin) throw unavailable(); return supabaseAdmin; }

/** The stable running agent row and its original enrollment scope. */
export async function loadProviderAgentSeedContext(raw: ProviderGuestSeedRef) {
  try {
    const input = Ref.parse(raw), db = database();
    const { data, error } = await db.from("hivra_agents").select(Object.keys(Row.shape).join(","))
      .eq("id", input.agentId).eq("user_id", input.userId).eq("computer_substrate", "provider-vm")
      .eq("status", "running").eq("desired_state", "running").is("operation_id", null).is("operation_kind", null).maybeSingle();
    if (error) throw unavailable();
    const row = Row.parse(data), identity = parseProviderGuestWorkerIdentity(row.provider_install_identity);
    if (row.id !== input.agentId || row.user_id !== input.userId || identity.agentId !== row.id
      || identity.operationId !== row.allocation_operation_id) throw unavailable();
    const direct = readAgentProviderDirectAccess(row);
    const accessMode = direct ? "direct-https" as const : row.cf_tunnel_id && row.cf_hostname ? "cloudflare-named" as const : null;
    if (!accessMode) throw unavailable();
    const { data: order, error: orderError } = await db.from("infrastructure_capacity_orders").select("quote_fingerprint_sha256")
      .eq("user_id", input.userId).eq("id", row.provider_capacity_order_id).eq("connection_id", row.infrastructure_connection_id)
      .eq("active_connection_id", row.infrastructure_connection_id).eq("connection_revision", row.infrastructure_connection_revision)
      .eq("provider_resource_id", row.provider_server_id).eq("status", "created_off").maybeSingle();
    if (orderError || !order) throw unavailable();
    const attempt = { userId: input.userId, connectionId: row.infrastructure_connection_id,
      connectionRevision: row.infrastructure_connection_revision, orderId: row.provider_capacity_order_id,
      attemptId: row.provider_enrollment_attempt_id, quoteFingerprint: order.quote_fingerprint_sha256 };
    // The attempt's own first-boot recipe, never the current one: it is part
    // of the scope digest, and servers keep the recipe they were created with.
    const scope = parseFirstBootOperationScope({ binding: { ...attempt, recipeVersion: await loadFirstBootRecipeVersion(attempt) },
      providerServerId: row.provider_server_id });
    if (identity.bundle.scopeSha256 !== providerGuestBundleScopeSha256(scope)) throw unavailable();
    return { input, identity, scope, accessMode, targetId: row.deployment_target_id, ip: row.ip };
  } catch { throw unavailable(); }
}

type Dependencies = {
  load: typeof loadProviderAgentSeedContext; boot: typeof loadFirstBootOperation;
  verify: typeof verifyEnrolledProviderReceipt; bootstrap: typeof loadHetznerCloudCapacityBootstrap;
  run: typeof runProviderGuestSeed; monotonicNow: () => number;
};
const defaults: Dependencies = {
  load: loadProviderAgentSeedContext, boot: loadFirstBootOperation, verify: verifyEnrolledProviderReceipt,
  bootstrap: loadHetznerCloudCapacityBootstrap, run: runProviderGuestSeed, monotonicNow: () => performance.now(),
};

/**
 * Run one server-built guest script on the agent's provider computer as root.
 * The script must be the same fixed builder output the Proxmox lane runs; no
 * caller-selected command, path or host reaches the guest.
 */
export async function runProviderAgentGuestScript(raw: ProviderGuestSeedRef, script: string,
  dependencies: Partial<Dependencies> = {}): Promise<ProviderGuestSeedOutcome> {
  const deps = { ...defaults, ...dependencies }, deadline = deps.monotonicNow() + 30_000;
  const fence = () => { if (!Number.isFinite(deadline) || deps.monotonicNow() >= deadline) throw unavailable(); };
  let input: ProviderGuestSeedRef, context: Awaited<ReturnType<typeof loadProviderAgentSeedContext>>;
  try {
    input = Ref.parse(structuredClone(raw));
    context = await deps.load(input);
    if (context.input.agentId !== input.agentId || context.input.userId !== input.userId) throw unavailable();
  } catch { return { ok: false, error: "not_eligible" }; }
  try {
    fence();
    const boot = await deps.boot(context.scope); fence();
    if (!boot) throw unavailable();
    const verified = await deps.verify({ scope: context.scope, operation: boot, dispatchDeadlineMs: deadline,
      ...(context.accessMode === "direct-https" ? { requireDirectHttps: true } : {}) }, { monotonicNow: deps.monotonicNow }); fence();
    if (verified.stage !== "provider_verified" || verified.address !== context.ip
      || JSON.stringify(verified.scope) !== JSON.stringify(context.scope)) throw unavailable();
    const binding = context.scope.binding;
    const bootstrap = await deps.bootstrap({ userId: binding.userId, connectionId: binding.connectionId, expectedRevision: binding.connectionRevision,
      orderId: binding.orderId, idempotencyKey: verified.capacityIdempotencyKey, quoteFingerprintSha256: binding.quoteFingerprint }); fence();
    // A deletion or lifecycle operation that started meanwhile wins: the
    // computer is not written once it is no longer stable and running.
    if (JSON.stringify(await deps.load(input)) !== JSON.stringify(context)) throw unavailable(); fence();
    const result = await deps.run({ script, address: verified.address, hostPublicKey: verified.hostPublicKey,
      administratorPublicKey: bootstrap.publicKeyOpenSsh, administratorPrivateKey: bootstrap.privateKeyOpenSsh, dispatchDeadlineMs: deadline },
    { monotonicNow: deps.monotonicNow });
    if (result.hostVerified !== true || result.administratorAuthenticated !== true
      || result.hostFingerprintSha256 !== verified.hostFingerprintSha256) throw unavailable();
    return { ok: true, stdout: result.output };
  } catch {
    return { ok: false, error: "unreachable" };
  }
}
