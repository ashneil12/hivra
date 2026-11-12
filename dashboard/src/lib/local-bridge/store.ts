import "server-only";

// Reads and writes for the local bridge. Every read is scoped to the owner, so a
// row of another owner reads as missing. State changes are conditional updates
// on the current status, so a request can be decided or dispatched only once.

import { supabaseAdmin } from "@/lib/supabase";

import { canMoveBridgeRequest, RUNNING_GRACE_MS, type BridgeStatus } from "@/lib/local-bridge/states";

export type { BridgeStatus };

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

/**
 * Raises the generation by one and stores the rotated key, only if the generation is still
 * the one the caller read. `revoked` marks the computer revoked (a revoke) or live (an enroll).
 * Returns the new generation.
 */
export async function bumpGeneration(userId: string, computer: BridgeComputer, bridgeKeyEncrypted: string, revoked: boolean): Promise<number> {
  const next = computer.generation + 1;
  // A revoke also voids any setup code still waiting to be used.
  const patch = { generation: next, revoked_at: revoked ? new Date().toISOString() : null, bridge_key_encrypted: bridgeKeyEncrypted, ...(revoked ? { enrol_token_hash: null, enrol_expires_at: null } : {}) };
  const row = check(await db().from("hivra_bridge_computers").update(patch)
    .eq("id", computer.id).eq("user_id", userId).eq("generation", computer.generation).select("generation").maybeSingle());
  if (!row) throw new Error("conflict");
  return next;
}

/** Keeps only the hash of this computer's one-time setup code (a new code replaces any older one). */
export async function setEnrolCode(userId: string, computerId: string, tokenHash: string, expiresAt: string): Promise<void> {
  const row = check(await db().from("hivra_bridge_computers").update({ enrol_token_hash: tokenHash, enrol_expires_at: expiresAt })
    .eq("id", computerId).eq("user_id", userId).select("id").maybeSingle());
  if (!row) throw new Error("database_unavailable");
}

/**
 * Redeems a setup code: one conditional update that clears it, so it works once, only before
 * it expires and never for a revoked computer. Returns the computer, or null when the code is
 * unknown, used, expired or revoked.
 */
export async function consumeEnrolCode(tokenHash: string, nowIso: string): Promise<BridgeComputer | null> {
  return check(await db().from("hivra_bridge_computers").update({ enrol_token_hash: null, enrol_expires_at: null })
    .eq("enrol_token_hash", tokenHash).gt("enrol_expires_at", nowIso).is("revoked_at", null).select(COMPUTER_COLUMNS).maybeSingle()) as unknown as BridgeComputer | null;
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

/**
 * Moves a request from one status to another only if it is still in `from`. Returns whether this call did it.
 * The move must be in BRIDGE_TRANSITIONS; the database refuses any other.
 */
export async function transition(id: string, from: BridgeStatus, patch: Record<string, unknown> & { status: BridgeStatus }): Promise<boolean> {
  if (!canMoveBridgeRequest(from, patch.status)) throw new Error(`bridge request cannot move ${from} -> ${patch.status}`);
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

export async function deleteAllowancesForComputer(userId: string, computerId: string): Promise<void> {
  check(await db().from("hivra_bridge_allowances").delete().eq("user_id", userId).eq("computer_id", computerId));
}

/** A revoked computer's waiting and approved-but-not-started requests can no longer run. */
export async function expireOpenRequests(userId: string, computerId: string, now: number = Date.now()): Promise<void> {
  check(await db().from("hivra_bridge_requests").update({ status: "expired", finished_at: new Date(now).toISOString() })
    .eq("user_id", userId).eq("computer_id", computerId).in("status", ["pending", "approved"]));
}

/** Pending requests past their time become expired (all owners; the daily cleanup). */
export async function expireStalePending(now: number = Date.now()): Promise<void> {
  check(await db().from("hivra_bridge_requests").update({ status: "expired", finished_at: new Date(now).toISOString() })
    .eq("status", "pending").lt("expires_at", new Date(now).toISOString()));
}

/**
 * Requests that can no longer finish on their own (the daily cleanup):
 *  - approved but never dispatched, past their time -> expired;
 *  - running past their own timeout plus a grace (the dispatcher died mid-run) -> failed.
 */
export async function closeStuckRequests(now: number = Date.now()): Promise<void> {
  const nowIso = new Date(now).toISOString();
  check(await db().from("hivra_bridge_requests").update({ status: "expired", finished_at: nowIso })
    .eq("status", "approved").lt("expires_at", nowIso));
  // timeout_seconds is at most 120, so anything dispatched before this cutoff is past its own timeout.
  const cutoff = new Date(now - 120_000 - RUNNING_GRACE_MS).toISOString();
  check(await db().from("hivra_bridge_requests").update({ status: "failed", error_code: "lost", finished_at: nowIso })
    .eq("status", "running").lt("dispatched_at", cutoff));
}

/** Nulls stored output older than 7 days for every owner (the daily cleanup). */
export async function purgeAllOldResults(now: number = Date.now()): Promise<void> {
  check(await db().from("hivra_bridge_requests").update({ result: null })
    .not("result", "is", null).lt("finished_at", new Date(now - RESULT_RETENTION_MS).toISOString()));
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
