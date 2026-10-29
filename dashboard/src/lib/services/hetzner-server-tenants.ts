import type { SupabaseClient } from "@supabase/supabase-js";

export type HetznerServerTenantCount =
  | { ok: true; otherLiveRows: number }
  | { ok: false; message: string };

async function countOtherLiveRows(
  supabase: SupabaseClient,
  params: {
    instanceId: string;
    column: "hetzner_server_id" | "host_id";
    value: number | string;
    excludeInstanceIds: readonly string[];
  },
): Promise<HetznerServerTenantCount> {
  let query = supabase
    .from("hermes_instances")
    .select("id", { count: "exact", head: true })
    .eq(params.column, params.value)
    .neq("id", params.instanceId);
  for (const excludedId of params.excludeInstanceIds) {
    query = query.neq("id", excludedId);
  }
  const { count, error } = await query.neq("status", "deleted");
  if (error) return { ok: false, message: error.message };
  if (count == null) return { ok: false, message: "live-row count was not returned" };
  return { ok: true, otherLiveRows: count };
}

/**
 * Counts the non-deleted hermes_instances rows, other than `instanceId`, that
 * still run on this Hetzner server. Call it before any server-level delete or
 * before soft-deleting an agent that shares a server:
 * an agent placed on an existing host shares that host's server, so deleting
 * the server would take the other agents down too.
 *
 * A row counts when it is linked to the server by `hetzner_server_id`, or,
 * when `hostId` is given, to the host by `host_id`. Each key is counted on its
 * own and the larger count is returned, so any sibling on either key makes the
 * result non-zero. The two keys overlap on shared rows, so the counts are not
 * added.
 *
 * `excludeInstanceIds` leaves out rows that the caller removes in the same
 * operation, the account sweep's own agents. Any other live row still counts.
 *
 * Fails closed. A failed or unreadable count on either key comes back as
 * `ok: false`, never as zero, so callers refuse the server-level action.
 */
export async function countOtherLiveRowsOnHetznerServer(
  supabase: SupabaseClient,
  params: {
    instanceId: string;
    hetznerServerId: number;
    hostId?: string | null;
    excludeInstanceIds?: readonly string[];
  },
): Promise<HetznerServerTenantCount> {
  const excludeInstanceIds = params.excludeInstanceIds ?? [];
  const byServer = await countOtherLiveRows(supabase, {
    instanceId: params.instanceId,
    column: "hetzner_server_id",
    value: params.hetznerServerId,
    excludeInstanceIds,
  });
  if (!byServer.ok) return byServer;
  if (!params.hostId) return byServer;

  const byHost = await countOtherLiveRows(supabase, {
    instanceId: params.instanceId,
    column: "host_id",
    value: params.hostId,
    excludeInstanceIds,
  });
  if (!byHost.ok) return byHost;
  return { ok: true, otherLiveRows: Math.max(byServer.otherLiveRows, byHost.otherLiveRows) };
}
