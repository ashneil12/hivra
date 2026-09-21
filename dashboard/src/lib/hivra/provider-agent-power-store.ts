import "server-only";

import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase";
import { HetznerPowerKind, parseHetznerPowerAction, type HetznerPowerAction } from "@/lib/hetzner/power-action";
import { FIRST_BOOT_RECIPE_VERSION } from "@/lib/infrastructure/first-boot-enrollment";
import { parseFirstBootOperationScope } from "@/lib/infrastructure/first-boot-operations";
import { buildProviderGuestRuntimeProbe } from "@/lib/infrastructure/provider-guest-runtime";
import { parseProviderGuestWorkerReceipt, type ProviderGuestWorkerIdentity } from "@/lib/infrastructure/provider-guest-worker";
import { SELF_MANAGED_HIVRA_PROXMOX_HOST_SENTINEL } from "./agent-authority";
import { readAgentProviderDirectAccess } from "./provider-direct-access";
import { parseProviderDesktopWorkerIdentity } from "@/lib/infrastructure/provider-desktop-worker";
import { parseProviderDesktopAccess } from "@/lib/infrastructure/provider-desktop-launch-contract";
import { providerGuestBundleScopeSha256 } from "@/lib/infrastructure/provider-guest-bundle";

const Uuid = z.string().uuid();
const Time = z.string().refine(value => Number.isFinite(Date.parse(value)));
const ServerId = z.string().regex(/^[1-9][0-9]{0,15}$/).refine(value => Number.isSafeInteger(Number(value)));
const Operation = z.object({ userId: z.string().min(1).max(256), agentId: Uuid, operationId: Uuid }).strict();
export type ProviderAgentPowerOperation = z.infer<typeof Operation>;
const Row = z.object({
  id: Uuid, user_id: z.string(), operation_id: Uuid, operation_kind: HetznerPowerKind,
  operation_started_at: Time, allocation_operation_id: Uuid,
  status: z.literal("provisioning"), desired_state: z.enum(["running", "stopped", "deleted"]),
  computer_substrate: z.literal("provider-vm"), deployment_mode: z.literal("self-managed"), vmid: z.null(),
  proxmox_host: z.literal(SELF_MANAGED_HIVRA_PROXMOX_HOST_SENTINEL),
  type: z.enum(["claude-code", "codex", "aeon", "openclaw", "agent-zero", "linux-desktop"]),
  computer_profile: z.unknown().optional(), provider_install_desktop_access: z.unknown().optional(),
  infrastructure_connection_id: Uuid, infrastructure_connection_revision: z.number().int().positive().safe(),
  deployment_target_id: Uuid, provider_capacity_order_id: Uuid, provider_enrollment_attempt_id: Uuid,
  provider_server_id: ServerId, cf_tunnel_id: Uuid.nullable(), cf_hostname: z.string().min(1).max(253).nullable(),
  chat_url: z.string().max(2048).nullable(), ip: z.string().max(64).nullable(),
  provider_install_identity: z.unknown(), provider_install_stopped_at: Time, provider_install_outcome: z.literal("succeeded"),
});
const Journal = z.object({
  agent_id: Uuid, operation_id: Uuid, user_id: z.string(), operation_kind: HetznerPowerKind,
  connection_id: Uuid, connection_revision: z.number().int().positive().safe(), capacity_order_id: Uuid,
  provider_server_id: ServerId, allocation_operation_id: Uuid, original_status: z.enum(["running", "stopped"]),
  created_at: Time, dispatch_not_after: Time, dispatch_intent_at: Time.nullable(), before_boot_id: Uuid.nullable(),
  action_receipt: z.unknown(), verified_at: Time.nullable(), verified_status: z.enum(["running", "off"]).nullable(),
  verified_boot_id: Uuid.nullable(), cancelled_at: Time.nullable(),
});

class ProviderAgentPowerStoreError extends Error {
  constructor() { super("Provider power operation could not be verified"); this.name = "ProviderAgentPowerStoreError"; }
}
function database() {
  if (!supabaseAdmin) throw new ProviderAgentPowerStoreError();
  return supabaseAdmin;
}

/** Only original owner/computer/operation evidence. Provider credentials and
 * administrator keys stay outside this store. Power never adopts an installer
 * operation, another computer, an ambient Proxmox host or a browser target. */
export async function loadProviderAgentPowerOperation(input: ProviderAgentPowerOperation) {
  try {
    const operation = Operation.parse(input), db = database();
    const { data, error } = await db.from("hivra_agents").select(Object.keys(Row.shape).join(","))
      .eq("user_id", operation.userId).eq("id", operation.agentId).eq("operation_id", operation.operationId)
      .eq("computer_substrate", "provider-vm").eq("status", "provisioning").maybeSingle();
    if (error) throw new Error();
    const row = Row.parse(data);
    if (row.id !== operation.agentId || row.user_id !== operation.userId || row.operation_id !== operation.operationId
      || row.allocation_operation_id === operation.operationId
      || (row.desired_state !== "deleted" && row.desired_state !== (row.operation_kind === "stop" ? "stopped" : "running"))) throw new Error();
    const { data: power, error: powerError } = await db.from("hivra_provider_power_operations")
      .select(Object.keys(Journal.shape).join(",")).eq("user_id", operation.userId)
      .eq("agent_id", operation.agentId).eq("operation_id", operation.operationId).maybeSingle();
    if (powerError) throw new Error();
    const journal = Journal.parse(power);
    if (journal.agent_id !== row.id || journal.user_id !== row.user_id || journal.operation_id !== row.operation_id
      || journal.operation_kind !== row.operation_kind || journal.connection_id !== row.infrastructure_connection_id
      || journal.connection_revision !== row.infrastructure_connection_revision || journal.capacity_order_id !== row.provider_capacity_order_id
      || journal.provider_server_id !== row.provider_server_id || journal.allocation_operation_id !== row.allocation_operation_id
      || journal.original_status !== (row.operation_kind === "start" ? "stopped" : "running")
      || Date.parse(journal.created_at) !== Date.parse(row.operation_started_at)
      || Date.parse(journal.dispatch_not_after) - Date.parse(journal.created_at) !== 45_000
      || (journal.dispatch_intent_at !== null && (row.operation_kind === "restart") !== (journal.before_boot_id !== null))
      || (journal.dispatch_intent_at === null && (journal.before_boot_id !== null || journal.action_receipt !== null))) throw new Error();
    const action = journal.action_receipt === null ? null : parseHetznerPowerAction(journal.action_receipt,
      { serverId: Number(row.provider_server_id), kind: row.operation_kind });
    const { data: order, error: orderError } = await db.from("infrastructure_capacity_orders").select("quote_fingerprint_sha256")
      .eq("user_id", operation.userId).eq("id", row.provider_capacity_order_id)
      .eq("connection_id", row.infrastructure_connection_id).eq("active_connection_id", row.infrastructure_connection_id)
      .eq("connection_revision", row.infrastructure_connection_revision).eq("provider_resource_id", row.provider_server_id)
      .eq("status", "created_off").maybeSingle();
    if (orderError || !order) throw new Error();
    const scope = parseFirstBootOperationScope({ binding: {
      userId: operation.userId, connectionId: row.infrastructure_connection_id, connectionRevision: row.infrastructure_connection_revision,
      orderId: row.provider_capacity_order_id, attemptId: row.provider_enrollment_attempt_id,
      quoteFingerprint: order.quote_fingerprint_sha256, recipeVersion: FIRST_BOOT_RECIPE_VERSION,
    }, providerServerId: row.provider_server_id });
    const direct = readAgentProviderDirectAccess(row);
    const access = direct ?? (row.cf_tunnel_id && row.cf_hostname
      ? { mode: "cloudflare-named" as const, hostname: row.cf_hostname, tunnelId: row.cf_tunnel_id }
      : null);
    if (!access) throw new Error();
    const common = { operation, kind: row.operation_kind, scope, targetId: row.deployment_target_id,
      desiredState: row.desired_state, accessMode: access.mode, hostname: access.hostname, tunnelId: access.tunnelId,
      originalStatus: journal.original_status, createdAt: journal.created_at, dispatchNotAfter: journal.dispatch_not_after,
      dispatchIntentAt: journal.dispatch_intent_at, beforeBootId: journal.before_boot_id, action,
      verifiedAt: journal.verified_at, verifiedStatus: journal.verified_status, verifiedBootId: journal.verified_boot_id,
      cancelledAt: journal.cancelled_at };
    if (row.type === "linux-desktop") {
      const identity = parseProviderDesktopWorkerIdentity(row.provider_install_identity);
      const desktopAccess = parseProviderDesktopAccess(row.provider_install_desktop_access);
      if (row.computer_profile !== "ubuntu-desktop" || identity.agentId !== row.id
        || identity.operationId !== row.allocation_operation_id || identity.bundle.scopeSha256 !== providerGuestBundleScopeSha256(scope)
        || desktopAccess.mode !== access.mode || desktopAccess.hostname !== access.hostname || desktopAccess.tunnelId !== access.tunnelId
        || row.chat_url !== `https://${desktopAccess.hostname}`) throw new Error();
      return { ...common, runtime: "linux-desktop" as const, identity, desktopAccess };
    }
    const identity = parseProviderGuestWorkerReceipt(`HIVRA_PROVIDER_WORKER_V1 ${JSON.stringify({
      version: 1, identity: row.provider_install_identity, state: "succeeded", stopped: true,
    })}\n`, row.provider_install_identity as ProviderGuestWorkerIdentity).identity;
    if (identity.agentId !== row.id || identity.operationId !== row.allocation_operation_id) throw new Error();
    const runtime = row.type === "claude-code" ? "claude" as const : row.type;
    buildProviderGuestRuntimeProbe({ scope, identity, runtime, accessMode: access.mode });
    return { ...common, runtime, identity };
  } catch { throw new ProviderAgentPowerStoreError(); }
}
export type ProviderAgentPowerContext = Awaited<ReturnType<typeof loadProviderAgentPowerOperation>>;

async function rpc(input: ProviderAgentPowerOperation, name: string, args: Record<string, unknown>) {
  const operation = Operation.parse(input);
  const { data, error } = await database().rpc(name, { p_user_id: operation.userId,
    p_agent_id: operation.agentId, p_operation_id: operation.operationId, ...args });
  if (error) throw new ProviderAgentPowerStoreError();
  return data;
}
export async function claimProviderAgentPowerOperation(input: ProviderAgentPowerOperation, kind: z.infer<typeof HetznerPowerKind>) {
  try { return z.boolean().parse(await rpc(input, "claim_hivra_provider_power_operation", { p_kind: HetznerPowerKind.parse(kind) })); }
  catch { throw new ProviderAgentPowerStoreError(); }
}
/** The caller's monotonic deadline starts before this RPC; a lost response or
 * observe outcome is never a second dispatch grant. */
export async function beginProviderAgentPowerDispatch(input: ProviderAgentPowerOperation, beforeBootId: string | null) {
  try { return z.enum(["dispatch", "observe", "rejected"]).parse(await rpc(input, "begin_hivra_provider_power_dispatch",
    { p_before_boot_id: Uuid.nullable().parse(beforeBootId) })); }
  catch { throw new ProviderAgentPowerStoreError(); }
}
export async function recordProviderAgentPowerAction(input: ProviderAgentPowerOperation,
  expected: { serverId: number; kind: z.infer<typeof HetznerPowerKind>; actionId?: number }, action: HetznerPowerAction) {
  try { return z.boolean().parse(await rpc(input, "record_hivra_provider_power_action",
    { p_action: parseHetznerPowerAction(action, expected) })); }
  catch { throw new ProviderAgentPowerStoreError(); }
}
const Result = z.object({ observedAt: Time, status: z.enum(["running", "off"]), bootId: Uuid.nullable(),
  runtimeReady: z.boolean(), publicReady: z.boolean() }).strict();
export async function verifyProviderAgentPowerResult(input: ProviderAgentPowerOperation, result: z.infer<typeof Result>) {
  try {
    const checked = Result.parse(result);
    return z.boolean().parse(await rpc(input, "verify_hivra_provider_power_result", { p_observed_at: checked.observedAt,
      p_status: checked.status, p_boot_id: checked.bootId, p_runtime_ready: checked.runtimeReady, p_public_ready: checked.publicReady }));
  } catch { throw new ProviderAgentPowerStoreError(); }
}
export async function cancelProviderAgentPowerBeforeDispatch(input: ProviderAgentPowerOperation) {
  try { return z.boolean().parse(await rpc(input, "cancel_hivra_provider_power_before_dispatch", {})); }
  catch { throw new ProviderAgentPowerStoreError(); }
}
export async function completeProviderDesktopPower(input: ProviderAgentPowerOperation & {
  operationKind: "start" | "restart"; chatUrl: string; ip: string;
}) {
  try {
    return z.boolean().parse(await rpc({ userId: input.userId, agentId: input.agentId, operationId: input.operationId },
      "complete_hivra_provider_desktop_power", { p_kind: z.enum(["start", "restart"]).parse(input.operationKind),
        p_chat_url: z.string().max(2048).parse(input.chatUrl), p_ip: z.string().max(64).parse(input.ip) }));
  } catch { throw new ProviderAgentPowerStoreError(); }
}
