import type { SupabaseClient } from "@supabase/supabase-js";

export type HetznerServerTenantCount =
  | { ok: true; otherLiveRows: number }
  | { ok: false; message: string };

/**
 * Counts the non-deleted hermes_instances rows, other than `instanceId`, that
 * still run on this Hetzner server. Call it before any server-level delete:
 * an agent placed on an existing host shares that host's server, so deleting
 * the server would take the other agents down too.
 *
 * Fails closed. A failed or unreadable count comes back as `ok: false`, never
 * as zero, so callers refuse the server-level action.
 */
export async function countOtherLiveRowsOnHetznerServer(
  supabase: SupabaseClient,
  params: { instanceId: string; hetznerServerId: number },
): Promise<HetznerServerTenantCount> {
  const { count, error } = await supabase
    .from("hermes_instances")
    .select("id", { count: "exact", head: true })
    .eq("hetzner_server_id", params.hetznerServerId)
    .neq("id", params.instanceId)
    .neq("status", "deleted");
  if (error) return { ok: false, message: error.message };
  if (count == null) return { ok: false, message: "live-row count was not returned" };
  return { ok: true, otherLiveRows: count };
}
