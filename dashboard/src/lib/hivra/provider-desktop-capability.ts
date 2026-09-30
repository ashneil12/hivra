import "server-only";

import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase";
import { loadFirstBootRecipeVersion } from "@/lib/infrastructure/first-boot-store";
import { loadFirstBootOperation, parseFirstBootOperationScope } from "@/lib/infrastructure/first-boot-operations";
import { loadHetznerCloudCapacityBootstrap } from "@/lib/infrastructure/hetzner-cloud-store";
import { verifyEnrolledProviderReceipt } from "@/lib/infrastructure/enrolled-provider-receipt";
import { inspectProviderDesktopRuntime } from "@/lib/infrastructure/first-boot-ssh";
import { parseProviderDesktopWorkerIdentity } from "@/lib/infrastructure/provider-desktop-worker";
import { parseProviderDesktopAccess } from "@/lib/infrastructure/provider-desktop-launch-contract";
import { parseProviderDesktopRuntimeReceipt } from "@/lib/infrastructure/provider-desktop-runtime";
import { providerGuestBundleScopeSha256 } from "@/lib/infrastructure/provider-guest-bundle";
import type { RemoteDesktopCapabilityReceipt } from "@/lib/remote-computers/session-broker";
import {
  REMOTE_DESKTOP_CAPABILITY_TTL_MS,
  type RemoteDesktopCapabilityInspectionResult,
} from "@/lib/remote-computers/capability-inspection";
import { SELF_MANAGED_HIVRA_PROXMOX_HOST_SENTINEL } from "./agent-authority";
import { readAgentProviderDirectAccess } from "./provider-direct-access";
import { verifyProviderDesktopPublicRuntime } from "./provider-desktop-public-readiness";

const Uuid = z.string().uuid();
const Ref = z.object({ userId: z.string().min(1).max(256), agentId: Uuid }).strict();
type Ref = z.infer<typeof Ref>;
const Row = z.object({
  id: Uuid, user_id: z.string(), type: z.literal("linux-desktop"), computer_profile: z.literal("ubuntu-desktop"),
  status: z.literal("running"), desired_state: z.literal("running"), operation_id: z.null(), operation_kind: z.null(),
  allocation_operation_id: Uuid, computer_substrate: z.literal("provider-vm"), deployment_mode: z.literal("self-managed"),
  proxmox_host: z.literal(SELF_MANAGED_HIVRA_PROXMOX_HOST_SENTINEL), vmid: z.null(),
  infrastructure_connection_id: Uuid, infrastructure_connection_revision: z.number().int().positive().safe(),
  deployment_target_id: Uuid, provider_capacity_order_id: Uuid, provider_enrollment_attempt_id: Uuid, provider_server_id: z.string(),
  provider_install_identity: z.unknown(), provider_install_desktop_access: z.unknown(),
  provider_install_outcome: z.literal("succeeded"), provider_install_stopped_at: z.string().refine(value => Number.isFinite(Date.parse(value))),
  cf_tunnel_id: Uuid.nullable(), cf_hostname: z.string().nullable(), chat_url: z.string(), ip: z.string(), api_token: z.null(),
});
function unavailable() { return new Error("Provider desktop capability could not be verified"); }
function database() { if (!supabaseAdmin) throw unavailable(); return supabaseAdmin; }

/** Stable running state only, retaining the allocation's original installer
 * identity. No new lifecycle operation, credential, target or VM ID is made. */
export async function loadProviderDesktopCapabilityContext(raw: Ref) {
  try {
    const input = Ref.parse(raw), db = database();
    const { data, error } = await db.from("hivra_agents").select(Object.keys(Row.shape).join(","))
      .eq("id", input.agentId).eq("user_id", input.userId).eq("computer_substrate", "provider-vm")
      .eq("status", "running").eq("desired_state", "running").is("operation_id", null).is("operation_kind", null).maybeSingle();
    if (error) throw unavailable();
    const row = Row.parse(data), identity = parseProviderDesktopWorkerIdentity(row.provider_install_identity);
    const access = parseProviderDesktopAccess(row.provider_install_desktop_access);
    if (row.id !== input.agentId || row.user_id !== input.userId || identity.agentId !== row.id
      || identity.operationId !== row.allocation_operation_id || row.chat_url !== `https://${access.hostname}`) throw unavailable();
    if (access.mode === "direct-https") {
      if (readAgentProviderDirectAccess(row)?.hostname !== access.hostname) throw unavailable();
    } else if (row.cf_tunnel_id !== access.tunnelId || row.cf_hostname !== access.hostname) throw unavailable();
    const { data: order, error: orderError } = await db.from("infrastructure_capacity_orders").select("quote_fingerprint_sha256")
      .eq("user_id", input.userId).eq("id", row.provider_capacity_order_id).eq("connection_id", row.infrastructure_connection_id)
      .eq("active_connection_id", row.infrastructure_connection_id).eq("connection_revision", row.infrastructure_connection_revision)
      .eq("provider_resource_id", row.provider_server_id).eq("status", "created_off").maybeSingle();
    if (orderError || !order) throw unavailable();
    const attempt = { userId: input.userId, connectionId: row.infrastructure_connection_id,
      connectionRevision: row.infrastructure_connection_revision, orderId: row.provider_capacity_order_id,
      attemptId: row.provider_enrollment_attempt_id, quoteFingerprint: order.quote_fingerprint_sha256 };
    // The attempt's own recipe, never the current one: it is part of the scope digest.
    const scope = parseFirstBootOperationScope({ binding: { ...attempt, recipeVersion: await loadFirstBootRecipeVersion(attempt) },
      providerServerId: row.provider_server_id });
    if (identity.bundle.scopeSha256 !== providerGuestBundleScopeSha256(scope)) throw unavailable();
    return { input, identity, access, scope, targetId: row.deployment_target_id, ip: row.ip };
  } catch { throw unavailable(); }
}
type Context = Awaited<ReturnType<typeof loadProviderDesktopCapabilityContext>>;

/** SQL locks the stable original row and rechecks identity/access before using
 * the shared capability ledger. No parallel session or grant format. */
export async function recordProviderDesktopCapability(context: Context, receipt: RemoteDesktopCapabilityReceipt, expiresAt: string) {
  try {
    const input = Ref.parse(context.input), identity = parseProviderDesktopWorkerIdentity(context.identity);
    const access = parseProviderDesktopAccess(context.access);
    const checked = parseProviderDesktopRuntimeReceipt(`HIVRA_REMOTE_DESKTOP_CAPABILITY_V1 ${JSON.stringify(receipt)}\n`, { identity, access });
    const { data, error } = await database().rpc("record_hivra_provider_desktop_capability", {
      p_user_id: input.userId, p_agent_id: input.agentId, p_identity: identity, p_access: access,
      p_ip: context.ip, p_target_id: context.targetId, p_receipt: checked, p_expires_at: z.string().datetime({ offset: true }).parse(expiresAt),
    });
    if (error) throw unavailable();
    return data?.status === "ready";
  } catch { throw unavailable(); }
}

type Dependencies = {
  load: typeof loadProviderDesktopCapabilityContext; record: typeof recordProviderDesktopCapability;
  boot: typeof loadFirstBootOperation; verify: typeof verifyEnrolledProviderReceipt;
  bootstrap: typeof loadHetznerCloudCapacityBootstrap; inspect: typeof inspectProviderDesktopRuntime;
  publicReady: typeof verifyProviderDesktopPublicRuntime; monotonicNow: () => number; now: () => Date; controlOrigin: () => string;
};
const defaults: Dependencies = { load: loadProviderDesktopCapabilityContext, record: recordProviderDesktopCapability,
  boot: loadFirstBootOperation, verify: verifyEnrolledProviderReceipt, bootstrap: loadHetznerCloudCapacityBootstrap,
  inspect: inspectProviderDesktopRuntime, publicReady: verifyProviderDesktopPublicRuntime,
  monotonicNow: () => performance.now(), now: () => new Date(),
  controlOrigin: () => { const key = "NEXT_PUBLIC_APP_URL"; return process.env[key] ?? ""; },
};

export async function inspectProviderDesktopCapability(raw: Ref, dependencies: Partial<Dependencies> = {}): Promise<RemoteDesktopCapabilityInspectionResult> {
  const deps = { ...defaults, ...dependencies }, deadline = deps.monotonicNow() + 30_000;
  const fence = () => { if (!Number.isFinite(deadline) || deps.monotonicNow() >= deadline) throw unavailable(); };
  let targetId: string | null = null;
  try {
    const input = Ref.parse(structuredClone(raw)); fence();
    const context = await deps.load(input); fence(); targetId = context.targetId;
    if (context.input.agentId !== input.agentId || context.input.userId !== input.userId) throw unavailable();
    const boot = await deps.boot(context.scope); fence(); if (!boot) throw unavailable();
    const verified = await deps.verify({ scope: context.scope, operation: boot, dispatchDeadlineMs: deadline,
      ...(context.access.mode === "direct-https" ? { requireDirectHttps: true } : {}) }, { monotonicNow: deps.monotonicNow }); fence();
    if (verified.stage !== "provider_verified" || verified.address !== context.ip
      || JSON.stringify(verified.scope) !== JSON.stringify(context.scope)) throw unavailable();
    const binding = context.scope.binding;
    const bootstrap = await deps.bootstrap({ userId: binding.userId, connectionId: binding.connectionId, expectedRevision: binding.connectionRevision,
      orderId: binding.orderId, idempotencyKey: verified.capacityIdempotencyKey, quoteFingerprintSha256: binding.quoteFingerprint }); fence();
    const observed = await deps.inspect({ identity: context.identity, access: context.access, address: verified.address,
      hostPublicKey: verified.hostPublicKey, administratorPublicKey: bootstrap.publicKeyOpenSsh,
      administratorPrivateKey: bootstrap.privateKeyOpenSsh, dispatchDeadlineMs: deadline }, { monotonicNow: deps.monotonicNow }); fence();
    if (observed.hostVerified !== true || observed.administratorAuthenticated !== true
      || observed.hostFingerprintSha256 !== verified.hostFingerprintSha256) throw unavailable();
    const receipt = parseProviderDesktopRuntimeReceipt(`HIVRA_REMOTE_DESKTOP_CAPABILITY_V1 ${JSON.stringify(observed.receipt)}\n`, context);
    if (!await deps.publicReady({ access: context.access, controlOrigin: deps.controlOrigin() })) throw unavailable(); fence();
    const current = await deps.load(input); fence();
    if (JSON.stringify(current) !== JSON.stringify(context)) throw unavailable();
    if (!await deps.record(context, receipt, new Date(deps.now().getTime() + REMOTE_DESKTOP_CAPABILITY_TTL_MS).toISOString())) throw unavailable();
    return { ok: true, agentId: input.agentId, targetId, vmid: null, receipt };
  } catch { return { ok: false, agentId: raw.agentId, targetId, vmid: null, error: "Provider desktop capability could not be verified. The original computer is unchanged." }; }
}
