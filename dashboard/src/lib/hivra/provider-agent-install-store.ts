import "server-only";

import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase";
import { loadFirstBootRecipeVersion } from "@/lib/infrastructure/first-boot-store";
import { parseFirstBootOperationScope } from "@/lib/infrastructure/first-boot-operations";
import { parseProviderGuestWorkerReceipt, type ProviderGuestWorkerIdentity, type ProviderGuestWorkerReceipt } from "@/lib/infrastructure/provider-guest-worker";
import { readAgentProviderDirectAccess } from "./provider-direct-access";

const Uuid = z.string().uuid();
const Operation = z.object({ userId: z.string().min(1).max(256), agentId: Uuid, operationId: Uuid }).strict();
export type ProviderAgentInstallOperation = z.infer<typeof Operation>;
const Row = z.object({
  id: Uuid, user_id: z.string(), operation_id: Uuid, operation_kind: z.literal("provision"),
  allocation_operation_id: Uuid, status: z.literal("provisioning"), desired_state: z.enum(["running", "deleted"]),
  computer_substrate: z.literal("provider-vm"), deployment_mode: z.literal("self-managed"), vmid: z.null(),
  type: z.enum(["claude-code", "codex", "aeon", "openclaw", "agent-zero", "deepseek-harness", "linux-desktop"]),
  computer_profile: z.unknown().optional(),
  infrastructure_connection_id: Uuid, infrastructure_connection_revision: z.number().int().positive().safe(),
  deployment_target_id: Uuid, provider_capacity_order_id: Uuid, provider_enrollment_attempt_id: Uuid,
  provider_server_id: z.string(), cf_tunnel_id: Uuid.nullable(), cf_hostname: z.string().min(1).max(253).nullable(),
  chat_url: z.string().max(2048).nullable(), ip: z.string().max(64).nullable(),
  provider_install_identity: z.unknown(), provider_install_not_after: z.string().nullable(),
  provider_install_stopped_at: z.string().nullable(),
  provider_install_outcome: z.enum(["cancelled", "failed", "succeeded"]).nullable(),
});
const SELECT = Object.keys(Row.shape).join(",");

export class ProviderAgentInstallStoreError extends Error {
  constructor() { super("Provider agent install operation could not be verified"); this.name = "ProviderAgentInstallStoreError"; }
}
function database() {
  if (!supabaseAdmin) throw new ProviderAgentInstallStoreError();
  return supabaseAdmin;
}

/** Only original operation identity and non-secret evidence. No target chosen
 * by a browser, ambient fleet authority, private key or first-boot lease.
 */
async function loadInstallOperation(input: ProviderAgentInstallOperation, contract: "legacy" | "native" | "desktop") {
  try {
    const current = Operation.parse(input), db = database();
    const { data, error } = await db.from("hivra_agents").select(SELECT)
      .eq("user_id", current.userId).eq("id", current.agentId).eq("operation_id", current.operationId)
      .eq("computer_substrate", "provider-vm").eq("operation_kind", "provision")
      .eq("status", "provisioning").maybeSingle();
    if (error || !data) throw new Error();
    const row = Row.parse(data);
    if ((contract === "legacy" && (row.type === "deepseek-harness" || row.type === "linux-desktop"))
      || (contract === "native" && row.type !== "deepseek-harness")
      || (contract === "desktop" && (row.type !== "linux-desktop" || row.computer_profile !== "ubuntu-desktop"))) throw new Error();
    if (row.id !== current.agentId || row.user_id !== current.userId || row.operation_id !== current.operationId
      || row.allocation_operation_id !== current.operationId) throw new Error();
    const { data: order, error: orderError } = await db.from("infrastructure_capacity_orders")
      .select("quote_fingerprint_sha256")
      .eq("user_id", current.userId).eq("id", row.provider_capacity_order_id)
      .eq("connection_id", row.infrastructure_connection_id).eq("active_connection_id", row.infrastructure_connection_id)
      .eq("connection_revision", row.infrastructure_connection_revision).eq("provider_resource_id", row.provider_server_id)
      .eq("status", "created_off").maybeSingle();
    if (orderError || !order) throw new Error();
    const attempt = { userId: current.userId, connectionId: row.infrastructure_connection_id,
      connectionRevision: row.infrastructure_connection_revision, orderId: row.provider_capacity_order_id,
      attemptId: row.provider_enrollment_attempt_id, quoteFingerprint: order.quote_fingerprint_sha256 };
    // The attempt's own recipe, never the current one: it is part of the scope digest.
    const scope = parseFirstBootOperationScope({ binding: { ...attempt,
      recipeVersion: await loadFirstBootRecipeVersion(attempt) }, providerServerId: row.provider_server_id });
    // Preserve the public catalog ID; only the shared installer uses "claude".
    const runtime = row.type === "claude-code" ? "claude" as const : row.type;
    const direct = readAgentProviderDirectAccess(row);
    const access = direct ?? (row.cf_tunnel_id && row.cf_hostname
      ? { mode: "cloudflare-named" as const, hostname: row.cf_hostname, tunnelId: row.cf_tunnel_id }
      : null);
    // A reservation can fail before access is journaled. It must remain
    // observable/cancellable by its original owner; access admission belongs
    // to start/readiness, not to loading the durable operation for recovery.
    return { operation: current, scope, targetId: row.deployment_target_id, runtime,
      desiredState: row.desired_state, accessMode: access?.mode ?? null, hostname: access?.hostname ?? row.cf_hostname,
      tunnelId: row.cf_tunnel_id, identity: row.provider_install_identity,
      stoppedAt: row.provider_install_stopped_at, outcome: row.provider_install_outcome };
  } catch { throw new ProviderAgentInstallStoreError(); }
}
/** Existing public lifecycle adapter stays v1-only. Native recovery uses an
 * explicit private entrypoint, not a widening of the public runtime contract. */
export async function loadProviderAgentInstallOperation(input: ProviderAgentInstallOperation) {
  const context = await loadInstallOperation(input, "legacy");
  if (context.runtime === "deepseek-harness" || context.runtime === "linux-desktop") throw new ProviderAgentInstallStoreError();
  return { ...context, runtime: context.runtime };
}
export async function loadProviderNativeInstallBinding(input: ProviderAgentInstallOperation) {
  const context = await loadInstallOperation(input, "native");
  if (context.runtime !== "deepseek-harness") throw new ProviderAgentInstallStoreError();
  return { ...context, runtime: context.runtime };
}
/** Private v3 binding, not dispatch or readiness authority. Never reinterpret
 * Omarchy/Windows or an unspecified profile as the Ubuntu worker contract. */
export async function loadProviderDesktopInstallBinding(input: ProviderAgentInstallOperation) {
  const context = await loadInstallOperation(input, "desktop");
  if (context.runtime !== "linux-desktop") throw new ProviderAgentInstallStoreError();
  return { ...context, runtime: context.runtime, computerProfile: "ubuntu-desktop" as const };
}
export type ProviderAgentInstallContext = Awaited<ReturnType<typeof loadProviderAgentInstallOperation>>;

export async function expireUnstartedProviderAgent(input: ProviderAgentInstallOperation): Promise<boolean> {
  try {
    const current = Operation.parse(input);
    const { data, error } = await database().rpc("expire_unstarted_provider_agent", {
      p_user_id: current.userId, p_agent_id: current.agentId, p_operation_id: current.operationId,
    });
    if (error || typeof data !== "boolean") throw new Error();
    return data;
  } catch { throw new ProviderAgentInstallStoreError(); }
}

function checkedReceipt(input: ProviderAgentInstallOperation, receipt: ProviderGuestWorkerReceipt) {
  const current = Operation.parse(input);
  const checked = parseProviderGuestWorkerReceipt(`HIVRA_PROVIDER_WORKER_V1 ${JSON.stringify(receipt)}\n`, receipt.identity);
  if (checked.identity.agentId !== current.agentId || checked.identity.operationId !== current.operationId) throw new Error();
  return { current, checked };
}

/** Caller starts its monotonic deadline before this RPC, not upon receiving
 * the grant. An observe result must never cause a second start dispatch.
 */
export async function beginProviderAgentInstall(input: ProviderAgentInstallOperation, identity: ProviderGuestWorkerIdentity): Promise<
  { outcome: "dispatch"; dispatchBudgetMs: 30000 } | { outcome: "observe" | "rejected" }
> {
  try {
    const { current, checked } = checkedReceipt(input, { version: 1, identity, state: "unknown", stopped: false });
    const { data, error } = await database().rpc("begin_hivra_provider_install", {
      p_user_id: current.userId, p_agent_id: current.agentId, p_operation_id: current.operationId, p_identity: checked.identity,
    });
    if (error) throw new Error();
    return z.union([
      z.object({ outcome: z.literal("dispatch"), dispatchBudgetMs: z.literal(30000) }).strict(),
      z.object({ outcome: z.enum(["observe", "rejected"]) }).strict(),
    ]).parse(data);
  } catch { throw new ProviderAgentInstallStoreError(); }
}

export async function recordProviderAgentInstallStopped(input: ProviderAgentInstallOperation, receipt: ProviderGuestWorkerReceipt) {
  try {
    const { current, checked } = checkedReceipt(input, receipt);
    if (!checked.stopped) throw new Error();
    const { data, error } = await database().rpc("record_hivra_provider_install_stopped", {
      p_user_id: current.userId, p_agent_id: current.agentId, p_operation_id: current.operationId, p_receipt: checked,
    });
    if (error || typeof data !== "boolean") throw new Error();
    return data;
  } catch { throw new ProviderAgentInstallStoreError(); }
}
