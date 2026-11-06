import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The columns that decide whether a row's Hetzner server id is a live link.
 * Callers pass the whole row (or a select that includes all three columns).
 */
export interface HetznerServerLinkRow {
  hetzner_server_id?: number | null;
  status?: string | null;
  gateway_url?: string | null;
}

/**
 * A creation receipt is the server id written right after createServer returns,
 * while the row is still 'provisioning' and the provisioning metadata (gateway_url)
 * has not landed yet. The server exists but is not this instance's live server, so
 * status sync, live updates, power actions, add-ons and gateway resolution must not
 * act on it (F090). Every other row keeps its server id as before.
 */
export function isHetznerCreationReceipt(row: HetznerServerLinkRow): boolean {
  return Boolean(row.hetzner_server_id) && row.status === "provisioning" && !row.gateway_url;
}

/** The row's Hetzner server id when that server is the instance's live server, otherwise null. */
export function provisionedHetznerServerId(row: HetznerServerLinkRow): number | null {
  if (!row.hetzner_server_id) return null;
  if (isHetznerCreationReceipt(row)) return null;
  return row.hetzner_server_id;
}

/**
 * Persist the creation receipt. Throws on a failed write: the caller must treat
 * that as a provisioning failure and delete the just-created server, so no
 * billable server is left without a row that points at it.
 */
export async function recordHetznerCreationReceipt(
  db: SupabaseClient,
  input: { instanceId: string; serverId: number },
): Promise<void> {
  const { error } = await db
    .from("hermes_instances")
    .update({
      hetzner_server_id: input.serverId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.instanceId);
  if (error) {
    throw new Error(`hetzner creation receipt write failed: ${error.message}`);
  }
}
