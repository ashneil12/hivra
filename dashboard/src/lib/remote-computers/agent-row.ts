import "server-only";

import type { RemoteDesktopAgentRow } from "@/lib/remote-computers/guest-installation";
import { supabaseAdmin } from "@/lib/supabase";

/** The hivra_agents columns the native Omarchy and Windows desktop lanes read. */
export const REMOTE_DESKTOP_AGENT_FIELDS = [
  "id", "user_id", "type", "computer_profile", "status", "desired_state", "operation_id", "operation_kind",
  "vmid", "ip", "chat_url", "computer_substrate", "provider_capacity_order_id",
  "provider_enrollment_attempt_id", "provider_server_id", "deployment_mode", "proxmox_host",
  "infrastructure_connection_id", "deployment_target_id", "infrastructure_connection_revision",
  "infrastructure_binding_token_hash", "infrastructure_binding_token_enforced", "managed_provisioner_channel",
].join(",");

/** Load one computer that belongs to the user, or null when there is none. */
export async function loadRemoteDesktopAgentForUser(
  userId: string,
  computerId: string,
): Promise<RemoteDesktopAgentRow | null> {
  if (!supabaseAdmin) throw new Error("Native desktop database is unavailable.");
  const { data, error } = await supabaseAdmin.from("hivra_agents").select(REMOTE_DESKTOP_AGENT_FIELDS)
    .eq("id", computerId).eq("user_id", userId).maybeSingle();
  if (error) throw new Error("Native desktop lookup failed.");
  return data as unknown as RemoteDesktopAgentRow | null;
}

/** Default pause between observe attempts. */
export function waitForMilliseconds(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
