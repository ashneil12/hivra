import "server-only";

// Reads and writes for agent ↔ computer links. Every read is scoped to the
// owner; a row of another owner is never returned, so a foreign id reads as
// missing (the routes answer 404).

import { createHash } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase";
import { computerKindLabel, isComputerRow, linkLabel, linkSource, linkTarget, targetBusyReason, type LinkRow } from "./eligibility";

/** Columns every link decision reads, plus what the lanes need. */
export const LINK_ROW_COLUMNS = [
  "id", "user_id", "name", "type", "status", "desired_state", "computer_profile", "computer_substrate", "ip", "vmid",
  "bootstrapped_at", "operation_id", "deployment_mode", "proxmox_host", "infrastructure_connection_id",
  "deployment_target_id", "infrastructure_connection_revision", "infrastructure_binding_token_hash",
  "infrastructure_binding_token_enforced", "managed_provisioner_channel", "provider_capacity_order_id",
  "provider_enrollment_attempt_id", "provider_server_id",
].join(", ");

export type OwnedRow = LinkRow & Record<string, unknown> & { id: string; user_id: string };

export interface LinkView {
  id: string;
  agentId: string;
  agentName: string;
  computerId: string;
  computerName: string;
  computerKind: string;
  createdAt: string;
  lastUsedAt: string | null;
}

interface LinkRecord {
  id: string;
  agent_id: string;
  computer_id: string;
  created_at: string;
  last_used_at: string | null;
}

export function db() {
  if (!supabaseAdmin) throw new Error("database_unavailable");
  return supabaseAdmin;
}

export const sha256Hex = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

/** Every live row the owner has (agents and computers). */
export async function loadOwnedRows(userId: string): Promise<OwnedRow[]> {
  const { data, error } = await db().from("hivra_agents").select(LINK_ROW_COLUMNS)
    .eq("user_id", userId).neq("status", "deleted").order("created_at", { ascending: true });
  if (error) throw new Error("database_unavailable");
  return (data ?? []) as unknown as OwnedRow[];
}

export async function loadOwnedRow(userId: string, id: string): Promise<OwnedRow | null> {
  const { data, error } = await db().from("hivra_agents").select(LINK_ROW_COLUMNS)
    .eq("id", id).eq("user_id", userId).neq("status", "deleted").maybeSingle();
  if (error) throw new Error("database_unavailable");
  return (data ?? null) as unknown as OwnedRow | null;
}

export async function loadLinks(userId: string, filter: { agentId?: string; computerId?: string } = {}): Promise<LinkRecord[]> {
  let query = db().from("hivra_agent_computer_links").select("id, agent_id, computer_id, created_at, last_used_at").eq("user_id", userId);
  if (filter.agentId) query = query.eq("agent_id", filter.agentId);
  if (filter.computerId) query = query.eq("computer_id", filter.computerId);
  const { data, error } = await query.order("created_at", { ascending: true });
  if (error) throw new Error("database_unavailable");
  return (data ?? []) as LinkRecord[];
}

export function linkViews(links: LinkRecord[], rows: OwnedRow[]): LinkView[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return links.flatMap((link) => {
    const agent = byId.get(link.agent_id), computer = byId.get(link.computer_id);
    if (!agent || !computer) return [];
    return [{
      id: link.id, agentId: agent.id, agentName: linkLabel(agent.name, "Agent"), computerId: computer.id,
      computerName: linkLabel(computer.name), computerKind: computerKindLabel(computer), createdAt: link.created_at,
      lastUsedAt: link.last_used_at,
    }];
  });
}

export interface LinkCandidate {
  id: string;
  name: string;
  kind: string;
  linked: boolean;
  available: boolean;
  reason?: string;
}

/** The other end's choices: computers for an agent, agents for a computer. */
export function candidatesFor(subject: OwnedRow, rows: OwnedRow[], linkedIds: Set<string>): LinkCandidate[] {
  const subjectIsComputer = isComputerRow(subject);
  return rows.filter((row) => row.id !== subject.id && isComputerRow(row) !== subjectIsComputer).map((row) => {
    const side = subjectIsComputer ? linkSource(row) : linkTarget(row);
    return {
      id: row.id, name: linkLabel(row.name, subjectIsComputer ? "Agent" : "Computer"),
      kind: subjectIsComputer ? String(row.type ?? "agent") : computerKindLabel(row),
      linked: linkedIds.has(row.id), available: side.ok, ...(side.ok ? {} : { reason: side.reason }),
    };
  });
}

/** Adds each pair once; a pair that already exists is left as it is. */
export async function insertLinks(userId: string, pairs: { agentId: string; computerId: string }[], from: "agent" | "computer"): Promise<number> {
  if (pairs.length === 0) return 0;
  const { data, error } = await db().from("hivra_agent_computer_links")
    .upsert(pairs.map((pair) => ({ user_id: userId, agent_id: pair.agentId, computer_id: pair.computerId, created_from: from })),
      { onConflict: "agent_id,computer_id", ignoreDuplicates: true })
    .select("id");
  if (error) throw new Error("database_unavailable");
  return (data ?? []).length;
}

/** Removes one link of this owner; returns the agent it belonged to, or null when there was none. */
export async function deleteLink(userId: string, linkId: string): Promise<{ agentId: string } | null> {
  const { data, error } = await db().from("hivra_agent_computer_links").delete()
    .eq("id", linkId).eq("user_id", userId).select("agent_id").maybeSingle();
  if (error) throw new Error("database_unavailable");
  return data ? { agentId: String((data as { agent_id: string }).agent_id) } : null;
}

export interface KeyRecord {
  agent_id: string;
  user_id: string;
  key_sha256: string | null;
  pending_key_sha256: string | null;
  kit_sha256: string | null;
  delivered_at: string | null;
  delivery_claimed_at: string | null;
  last_error: string | null;
  updated_at: string;
}

/**
 * After a link changes: the agent's kit is out of date. Clearing the digest is
 * what the agent's poll looks for, so a kit for an agent that was stopped then
 * still goes out once it runs again.
 */
export async function markKitDirty(userId: string, agentIds: string[]): Promise<void> {
  const ids = [...new Set(agentIds)];
  if (ids.length === 0) return;
  // Seeding missing key rows is best effort, as before; the dirty flag below is what must land.
  await db().from("hivra_agent_link_keys")
    .upsert(ids.map((agentId) => ({ agent_id: agentId, user_id: userId })), { onConflict: "agent_id", ignoreDuplicates: true });
  const { error } = await db().from("hivra_agent_link_keys").update({ kit_sha256: null, updated_at: new Date().toISOString() })
    .in("agent_id", ids).eq("user_id", userId);
  if (error) throw new Error("database_unavailable");
}

export async function loadKeyRecord(agentId: string): Promise<KeyRecord | null> {
  const { data, error } = await db().from("hivra_agent_link_keys").select("*").eq("agent_id", agentId).maybeSingle();
  if (error) throw new Error("database_unavailable");
  return (data ?? null) as KeyRecord | null;
}

/** The agent a presented key belongs to: the confirmed key, or the one being delivered now. */
export async function findAgentByKey(key: string): Promise<{ agentId: string; userId: string } | null> {
  if (!/^hvl_[0-9a-f]{64}$/.test(key)) return null;
  const hash = sha256Hex(key);
  const { data, error } = await db().from("hivra_agent_link_keys").select("agent_id, user_id")
    .or(`key_sha256.eq.${hash},pending_key_sha256.eq.${hash}`).limit(2);
  if (error) throw new Error("database_unavailable");
  const rows = (data ?? []) as { agent_id: string; user_id: string }[];
  return rows.length === 1 ? { agentId: rows[0].agent_id, userId: rows[0].user_id } : null;
}

export async function touchLink(linkId: string): Promise<void> {
  await db().from("hivra_agent_computer_links").update({ last_used_at: new Date().toISOString() }).eq("id", linkId);
}

export function targetState(row: OwnedRow): { ready: boolean; reason?: string } {
  const side = linkTarget(row);
  if (!side.ok) return { ready: false, reason: side.reason };
  const busy = targetBusyReason(row);
  return busy ? { ready: false, reason: busy } : { ready: true };
}
