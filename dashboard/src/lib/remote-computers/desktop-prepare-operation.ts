import "server-only";

import { supabaseAdmin } from "@/lib/supabase";
import type { RemoteDesktopAgentRow } from "./guest-installation";

export const DESKTOP_PREPARE_KIND = "desktop_prepare";
export const DESKTOP_PREPARE_PENDING = "Desktop preparation is still unconfirmed. Conflicting changes remain paused; prepare again to inspect this same operation.";

const AUTHORITY_FIELDS = ["id", "user_id", "type", "computer_profile", "computer_substrate", "deployment_mode",
  "proxmox_host", "infrastructure_connection_id", "deployment_target_id", "infrastructure_connection_revision",
  "infrastructure_binding_token_hash", "infrastructure_binding_token_enforced", "vmid", "ip", "chat_url"] as const;

export function desktopPrepareAuthority(agent: RemoteDesktopAgentRow): Record<string, unknown> {
  return { ...Object.fromEntries(AUTHORITY_FIELDS.map(key => [key, agent[key] ?? null])),
    managed_provisioner_channel: agent.managed_provisioner_channel ?? "default" };
}

export type DesktopPrepareClaim = { operationId: string; phase: "claimed" | "dispatched"; resumed: boolean };
export type DesktopPrepareReceipt = {
  version: 1; operationId: string; computerId: string; vmid: number; guestIp: string;
  bindingTag: string; bootId: string; exitCode: number;
};

async function rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (!supabaseAdmin) throw new Error("Desktop preparation database is unavailable.");
  const { data, error } = await supabaseAdmin.rpc(name, args);
  if (error) throw new Error("Desktop preparation operation could not be confirmed.");
  return data;
}

export async function beginDesktopPrepare(agent: RemoteDesktopAgentRow, operationId: string): Promise<DesktopPrepareClaim | null> {
  const data = await rpc("begin_hivra_desktop_prepare", { p_user_id: agent.user_id, p_agent_id: agent.id,
    p_operation_id: operationId, p_expected_authority: desktopPrepareAuthority(agent) });
  if (!data || typeof data !== "object") return null;
  const value = data as Record<string, unknown>;
  if (typeof value.operationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.operationId)
    || !["claimed", "dispatched"].includes(String(value.phase)) || typeof value.resumed !== "boolean") return null;
  return value as DesktopPrepareClaim;
}

export async function dispatchDesktopPrepare(userId: string, operationId: string): Promise<boolean> {
  return await rpc("dispatch_hivra_desktop_prepare", { p_user_id: userId, p_operation_id: operationId }) === true;
}

export async function cancelUndispatchedDesktopPrepare(userId: string, operationId: string): Promise<boolean> {
  return await rpc("cancel_undispatched_hivra_desktop_prepare", { p_user_id: userId, p_operation_id: operationId }) === true;
}

export async function completeDesktopPrepare(userId: string, receipt: DesktopPrepareReceipt): Promise<boolean> {
  return await rpc("complete_hivra_desktop_prepare", { p_user_id: userId, p_operation_id: receipt.operationId, p_receipt: receipt }) === true;
}
