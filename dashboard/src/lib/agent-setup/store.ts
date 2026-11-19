// Setup requests in Supabase (service role only; the table has no policies).

import { supabaseAdmin } from "@/lib/supabase";
import {
  SETUP_LAUNCH_MINUTES,
  setupClaimUsable,
  SETUP_OPEN_MINUTES,
  hashPollSecret,
  newPollSecret,
  newSetupCode,
  type LaunchedAgentRow,
  type SetupRequestInput,
  type SetupRow,
} from "./core";

const TABLE = "hivra_agent_setup_requests";
const COLUMNS = "id, code, agent, inference, client, user_id, claimed_at, agent_id, created_at, expires_at";

export class SetupStoreUnavailable extends Error {}

function db() {
  if (!supabaseAdmin) throw new SetupStoreUnavailable("Supabase is not configured");
  return supabaseAdmin;
}

export async function createSetupRequest(input: SetupRequestInput, now = Date.now()): Promise<{ row: SetupRow; secret: string }> {
  const secret = newPollSecret();
  const expiresAt = new Date(now + SETUP_OPEN_MINUTES * 60_000).toISOString();
  // A code collision is rare (32^8); try a few before giving up.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const { data, error } = await db().from(TABLE).insert({
      code: newSetupCode(),
      token_hash: hashPollSecret(secret),
      agent: input.agent ?? null,
      inference: input.inference ?? null,
      client: input.client ?? null,
      expires_at: expiresAt,
    }).select(COLUMNS).single();
    if (!error && data) return { row: data as SetupRow, secret };
    if (error?.code !== "23505") throw new Error(`setup request insert failed: ${error?.message ?? "no row"}`);
  }
  throw new Error("setup request insert failed: code collisions");
}

/** The request a poll secret belongs to, or null. */
export async function findSetupBySecret(id: string, secret: string): Promise<SetupRow | null> {
  const { data, error } = await db().from(TABLE).select(COLUMNS)
    .eq("id", id).eq("token_hash", hashPollSecret(secret)).maybeSingle();
  if (error) throw new Error(`setup request read failed: ${error.message}`);
  return (data as SetupRow | null) ?? null;
}

export async function findSetupByCode(code: string): Promise<SetupRow | null> {
  const { data, error } = await db().from(TABLE).select(COLUMNS).eq("code", code).maybeSingle();
  if (error) throw new Error(`setup request read failed: ${error.message}`);
  return (data as SetupRow | null) ?? null;
}

/**
 * Ties an open request to the signed-in person. First person wins: a request
 * someone else already claimed is not moved, an expired one is not claimed, and
 * the person's own claim stops working once its launch window has passed.
 * Returns the row as it now stands, or null when this person may not use it.
 */
export async function claimSetupRequest(code: string, userId: string, now = Date.now()): Promise<SetupRow | null> {
  const nowIso = new Date(now).toISOString();
  const { data, error } = await db().from(TABLE)
    .update({ user_id: userId, claimed_at: nowIso })
    .eq("code", code).is("user_id", null).gt("expires_at", nowIso)
    .select(COLUMNS).maybeSingle();
  if (error) throw new Error(`setup request claim failed: ${error.message}`);
  if (data) return data as SetupRow;
  const existing = await findSetupByCode(code);
  return existing && setupClaimUsable(existing, userId, now) ? existing : null;
}

/**
 * The agent this setup produced: the one already recorded, else the person's
 * first agent of the asked-for type created after they opened the link (any
 * type when none was asked for), within the launch window.
 */
export async function findLaunchedAgent(row: SetupRow): Promise<LaunchedAgentRow | null> {
  if (!row.user_id || !row.claimed_at) return null;
  const columns = "id, name, type, status, error";
  if (row.agent_id) {
    const { data, error } = await db().from("hivra_agents").select(columns)
      .eq("id", row.agent_id).eq("user_id", row.user_id).neq("status", "deleted").maybeSingle();
    if (error) throw new Error(`setup agent read failed: ${error.message}`);
    return (data as LaunchedAgentRow | null) ?? null;
  }
  const until = new Date(Date.parse(row.claimed_at) + SETUP_LAUNCH_MINUTES * 60_000).toISOString();
  let query = db().from("hivra_agents").select(columns)
    .eq("user_id", row.user_id).neq("status", "deleted")
    .gte("created_at", row.claimed_at).lte("created_at", until);
  if (row.agent) query = query.eq("type", row.agent);
  const { data, error } = await query.order("created_at", { ascending: true }).limit(1);
  if (error) throw new Error(`setup agent read failed: ${error.message}`);
  const agent = (data as LaunchedAgentRow[] | null)?.[0] ?? null;
  if (agent) {
    // Remember it, so a second launch later never changes the answer.
    await db().from(TABLE).update({ agent_id: agent.id }).eq("id", row.id).is("agent_id", null);
  }
  return agent;
}
