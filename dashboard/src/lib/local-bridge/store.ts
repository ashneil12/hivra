import "server-only";

// Reads and writes for the local bridge. Every read is scoped to the owner, so a
// row of another owner reads as missing. State changes are conditional updates
// on the current status, so a request can be decided or dispatched only once.

import { supabaseAdmin } from "@/lib/supabase";

export type BridgeStatus = "pending" | "approved" | "running" | "done" | "denied" | "expired" | "failed";

export interface BridgeComputer { bridge_key_encrypted: string | null; id: string; user_id: string; label: string; generation: number; revoked_at: string | null; created_at: string }

export interface BridgeRequest {
  id: string; user_id: string; agent_id: string; computer_id: string; argv: string[]; argv_sha256: string; cwd: string | null;
  timeout_seconds: number; max_output_bytes: number; status: BridgeStatus; decision: string | null; decided_at: string | null;
  result: Record<string, unknown> | null; error_code: string | null; created_at: string; expires_at: string;
  dispatched_at: string | null; finished_at: string | null;
}

export interface BridgeAllowance { id: string; user_id: string; agent_id: string; computer_id: string; granted_at: string; expires_at: string }

const db = () => {
  if (!supabaseAdmin) throw new Error("database_unavailable");
  return supabaseAdmin;
};
const REQUEST_COLUMNS = "id,user_id,agent_id,computer_id,argv,argv_sha256,cwd,timeout_seconds,max_output_bytes,status,decision,decided_at,result,error_code,created_at,expires_at,dispatched_at,finished_at";
const COMPUTER_COLUMNS = "bridge_key_encrypted,id,user_id,label,generation,revoked_at,created_at";

function check<T>(result: { data: T | null; error: unknown }): T | null {
  if (result.error) throw new Error("database_unavailable");
  return result.data ?? null;
}

export async function loadComputers(userId: string): Promise<BridgeComputer[]> {
  return check(await db().from("hivra_bridge_computers").select(COMPUTER_COLUMNS).eq("user_id", userId).order("created_at")) as unknown as BridgeComputer[] ?? [];
}

export async function loadComputer(userId: string, id: string): Promise<BridgeComputer | null> {
  return check(await db().from("hivra_bridge_computers").select(COMPUTER_COLUMNS).eq("id", id).eq("user_id", userId).maybeSingle()) as unknown as BridgeComputer | null;
}

export async function insertComputer(userId: string, label: string, bridgeKeyEncrypted: string): Promise<BridgeComputer> {
  const row = check(await db().from("hivra_bridge_computers").insert({ user_id: userId, label, bridge_key_encrypted: bridgeKeyEncrypted }).select(COMPUTER_COLUMNS).single());
  if (!row) throw new Error("database_unavailable");
  return row as unknown as BridgeComputer;
}

/** Re-enroll: stores the new (rotated) key and clears the revoked mark; the generation was already raised. */
export async function markComputerEnrolled(userId: string, id: string, bridgeKeyEncrypted: string): Promise<void> {
  check(await db().from("hivra_bridge_computers").update({ revoked_at: null, bridge_key_encrypted: bridgeKeyEncrypted }).eq("id", id).eq("user_id", userId));
}

/** Raises the generation by one and marks the computer revoked; returns the new generation. */
export async function bumpGeneration(userId: string, computer: BridgeComputer, bridgeKeyEncrypted: string): Promise<number> {
  const next = computer.generation + 1;
  const row = check(await db().from("hivra_bridge_computers").update({ generation: next, revoked_at: new Date().toISOString(), bridge_key_encrypted: bridgeKeyEncrypted })
    .eq("id", computer.id).eq("user_id", userId).eq("generation", computer.generation).select("generation").maybeSingle());
  if (!row) throw new Error("conflict");
  return next;
}

export async function insertRequest(row: {
  userId: string; agentId: string; computerId: string; argv: string[]; argvSha256: string; cwd: string | null;
  timeoutSeconds: number; maxOutputBytes: number; expiresAt: string;
}): Promise<BridgeRequest> {
  const data = check(await db().from("hivra_bridge_requests").insert({
    user_id: row.userId, agent_id: row.agentId, computer_id: row.computerId, argv: row.argv, argv_sha256: row.argvSha256, cwd: row.cwd,
    timeout_seconds: row.timeoutSeconds, max_output_bytes: row.maxOutputBytes, expires_at: row.expiresAt,
  }).select(REQUEST_COLUMNS).single());
  if (!data) throw new Error("database_unavailable");
  return data as unknown as BridgeRequest;
}

export async function loadRequest(userId: string, id: string): Promise<BridgeRequest | null> {
  return check(await db().from("hivra_bridge_requests").select(REQUEST_COLUMNS).eq("id", id).eq("user_id", userId).maybeSingle()) as unknown as BridgeRequest | null;
}

export async function loadRequestForAgent(userId: string, agentId: string, id: string): Promise<BridgeRequest | null> {
  const row = await loadRequest(userId, id);
  return row && row.agent_id === agentId ? row : null;
}

export async function listRequests(userId: string, limit = 30): Promise<BridgeRequest[]> {
  return check(await db().from("hivra_bridge_requests").select(REQUEST_COLUMNS).eq("user_id", userId)
    .order("created_at", { ascending: false }).limit(limit)) as unknown as BridgeRequest[] ?? [];
}

export async function countPending(agentId: string): Promise<number> {
  const result = await db().from("hivra_bridge_requests").select("id", { count: "exact", head: true }).eq("agent_id", agentId).eq("status", "pending");
  if (result.error) throw new Error("database_unavailable");
  return result.count ?? 0;
}

/** Moves a request from one status to another only if it is still in `from`. Returns whether this call did it. */
export async function transition(id: string, from: BridgeStatus, patch: Record<string, unknown> & { status: BridgeStatus }): Promise<boolean> {
  const row = check(await db().from("hivra_bridge_requests").update(patch).eq("id", id).eq("status", from).select("id").maybeSingle());
  return Boolean(row);
}

export async function findAllowance(userId: string, agentId: string, computerId: string): Promise<BridgeAllowance | null> {
  return check(await db().from("hivra_bridge_allowances").select("id,user_id,agent_id,computer_id,granted_at,expires_at")
    .eq("user_id", userId).eq("agent_id", agentId).eq("computer_id", computerId).maybeSingle()) as unknown as BridgeAllowance | null;
}

export async function listAllowances(userId: string): Promise<BridgeAllowance[]> {
  return check(await db().from("hivra_bridge_allowances").select("id,user_id,agent_id,computer_id,granted_at,expires_at").eq("user_id", userId)) as unknown as BridgeAllowance[] ?? [];
}

export async function upsertAllowance(userId: string, agentId: string, computerId: string, grantedAt: string, expiresAt: string): Promise<void> {
  check(await db().from("hivra_bridge_allowances").upsert(
    { user_id: userId, agent_id: agentId, computer_id: computerId, granted_at: grantedAt, expires_at: expiresAt },
    { onConflict: "agent_id,computer_id" },
  ));
}

export async function deleteAllowance(userId: string, agentId: string, computerId: string): Promise<void> {
  check(await db().from("hivra_bridge_allowances").delete().eq("user_id", userId).eq("agent_id", agentId).eq("computer_id", computerId));
}

export const RESULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Nulls the stored output of this owner's requests that finished more than 7 days ago. */
export async function purgeOldResults(userId: string, now: number = Date.now()): Promise<void> {
  check(await db().from("hivra_bridge_requests").update({ result: null })
    .eq("user_id", userId).not("result", "is", null).lt("finished_at", new Date(now - RESULT_RETENTION_MS).toISOString()));
}
