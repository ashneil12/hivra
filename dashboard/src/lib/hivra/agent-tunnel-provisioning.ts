import "server-only";

import { supabaseAdmin } from "@/lib/supabase";
import { createBoxTunnel, type BoxTunnelJournal } from "@/lib/services/cloudflare-tunnel";

/**
 * The hostname is a durable intent before any provider mutation. A hostname
 * without an ID is deliberately incomplete evidence: deletion must retain it
 * for reconciliation, not assume that no external resource was created.
 */
export function hivraAgentTunnelJournal(input: {
  userId: string;
  agentId: string;
  operationId: string;
}): BoxTunnelJournal {
  function update(patch: Record<string, string | null>) {
    if (!supabaseAdmin) throw new Error("Tunnel journal database is unavailable");
    return supabaseAdmin.from("hivra_agents").update(patch)
      .eq("id", input.agentId).eq("user_id", input.userId)
      .eq("operation_id", input.operationId).eq("operation_kind", "provision")
      .neq("status", "deleted");
  }
  return {
    async beforeCreate({ hostname }) {
      const { data, error } = await update({ cf_hostname: hostname })
        .eq("desired_state", "running").is("cf_tunnel_id", null).is("cf_hostname", null)
        .select("id").maybeSingle();
      if (error || !data) throw new Error("Tunnel intent could not be recorded");
    },
    async cancelBeforeCreate({ hostname }) {
      const { data, error } = await update({ cf_hostname: null })
        .is("cf_tunnel_id", null)
        .or(`cf_hostname.is.null,cf_hostname.eq.${hostname}`)
        .select("id").maybeSingle();
      if (error || !data) throw new Error("Unstarted tunnel intent could not be cleared");
    },
    async created({ tunnelId, hostname }) {
      const { data, error } = await update({ cf_tunnel_id: tunnelId })
        .eq("cf_hostname", hostname).is("cf_tunnel_id", null)
        .in("desired_state", ["running", "deleted"])
        .select("id, desired_state").maybeSingle();
      if (error || !data) throw new Error("Tunnel identity could not be recorded");
      // DELETE retains the provision lease. Journal the new ID first, then
      // compensate it instead of publishing DNS or starting a canceled VM.
      if (data.desired_state === "deleted") throw new Error("Tunnel creation was canceled");
    },
    async cleanupConfirmed({ tunnelId, hostname }) {
      const { data, error } = await update({ cf_tunnel_id: null, cf_hostname: null })
        .eq("cf_hostname", hostname)
        .or(`cf_tunnel_id.is.null,cf_tunnel_id.eq.${tunnelId}`)
        .select("id").maybeSingle();
      if (error || !data) throw new Error("Verified tunnel cleanup could not be recorded");
    },
  };
}

export async function provisionHivraAgentTunnel(input: {
  userId: string;
  agentId: string;
  operationId: string;
}) {
  const slug = "box-" + input.agentId.replace(/-/g, "").slice(0, 12);
  return createBoxTunnel(slug, { journal: hivraAgentTunnelJournal(input) });
}
