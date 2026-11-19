// Supabase-backed MoveStore for the Hermes move (service role only).

import { supabaseAdmin } from "@/lib/supabase";
import {
  ACTIVE_STATES,
  type AgentRow,
  type InstanceRow,
  type MovePatch,
  type MoveRow,
  type MoveState,
  type MoveStore,
} from "@/lib/hermes-move/orchestrator";

function db() {
  if (!supabaseAdmin) throw new Error("Database not configured");
  return supabaseAdmin;
}

function check<T>(res: { data: T; error: { message: string; code?: string } | null }, what: string): T {
  if (res.error) {
    const err = new Error(`${what}: ${res.error.message}`) as Error & { code?: string };
    err.code = res.error.code;
    throw err;
  }
  return res.data;
}

export function createSupabaseMoveStore(): MoveStore {
  return {
    async insertMove(row) {
      const res = await db().from("hermes_computer_moves").insert(row).select("*").single();
      return check(res, "insert move") as unknown as MoveRow;
    },
    async getMove(id) {
      const res = await db().from("hermes_computer_moves").select("*").eq("id", id).maybeSingle();
      return check(res, "read move") as unknown as MoveRow | null;
    },
    async claimLease(id, leaseUntil, nowIso) {
      const res = await db()
        .from("hermes_computer_moves")
        .update({ lease_until: leaseUntil })
        .eq("id", id)
        .in("state", [...ACTIVE_STATES])
        .or(`lease_until.is.null,lease_until.lt.${nowIso}`)
        .select("*")
        .maybeSingle();
      return check(res, "claim move lease") as unknown as MoveRow | null;
    },
    async patchMove(id, patch: MovePatch) {
      check(await db().from("hermes_computer_moves").update(patch).eq("id", id).select("id"), "update move");
    },
    async transitionMove(id, fromState: MoveState, patch: MovePatch) {
      const res = await db().from("hermes_computer_moves").update(patch).eq("id", id).eq("state", fromState).select("*").maybeSingle();
      return check(res, "transition move") as unknown as MoveRow | null;
    },
    async activeMoveForInstance(instanceId) {
      const res = await db().from("hermes_computer_moves").select("*").eq("instance_id", instanceId).in("state", [...ACTIVE_STATES]).maybeSingle();
      return check(res, "read active move") as unknown as MoveRow | null;
    },
    async latestMoveForInstance(instanceId) {
      const res = await db().from("hermes_computer_moves").select("*").eq("instance_id", instanceId).order("started_at", { ascending: false }).limit(1);
      return (check(res, "read latest move") as unknown as MoveRow[])[0] ?? null;
    },
    async moveForAgent(agentId) {
      const res = await db().from("hermes_computer_moves").select("*").eq("agent_id", agentId).order("started_at", { ascending: false }).limit(1);
      return (check(res, "read move for agent") as unknown as MoveRow[])[0] ?? null;
    },
    async listActiveMoves() {
      const res = await db().from("hermes_computer_moves").select("*").in("state", [...ACTIVE_STATES]);
      return check(res, "list active moves") as unknown as MoveRow[];
    },
    async listMoves(limit) {
      const res = await db().from("hermes_computer_moves").select("*").order("started_at", { ascending: false }).limit(limit);
      return check(res, "list moves") as unknown as MoveRow[];
    },
    async getInstance(id) {
      const res = await db().from("hermes_instances").select("*").eq("id", id).maybeSingle();
      return check(res, "read instance") as unknown as InstanceRow | null;
    },
    async patchInstance(id, patch) {
      check(await db().from("hermes_instances").update(patch).eq("id", id).select("id"), "update instance");
    },
    async getAgent(id) {
      const real = await db().from("hivra_agents").select("*").eq("id", id).maybeSingle();
      return check(real, "read agent") as unknown as AgentRow | null;
    },
    async findLaunchedAgent({ userId, name, since, excludeIds }) {
      const res = await db()
        .from("hivra_agents")
        .select("*")
        .eq("user_id", userId)
        .eq("type", "hermes")
        .eq("name", name)
        .neq("status", "deleted")
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(5);
      const rows = check(res, "find launched agent") as unknown as AgentRow[];
      return rows.find((r) => !excludeIds.includes(r.id)) ?? null;
    },
    async relinkWalletToAgent(instanceId, agentId) {
      // One owner at a time (instance_bankr_wallets_one_owner): both columns change in one update.
      check(await db().from("instance_bankr_wallets").update({ instance_id: null, hivra_agent_id: agentId }).eq("instance_id", instanceId).select("id"), "relink wallet to agent");
    },
    async relinkWalletToInstance(agentId, instanceId) {
      check(await db().from("instance_bankr_wallets").update({ hivra_agent_id: null, instance_id: instanceId }).eq("hivra_agent_id", agentId).select("id"), "relink wallet to instance");
    },
  };
}
