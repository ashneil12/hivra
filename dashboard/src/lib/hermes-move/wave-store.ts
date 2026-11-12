// Supabase-backed WaveStore for the automatic Hermes move (service role only).

import { supabaseAdmin } from "@/lib/supabase";
import type { MoveRow } from "@/lib/hermes-move/orchestrator";
import type { WaveCandidate, WaveSettings, WaveStore } from "@/lib/hermes-move/wave";

const ENDED_BADLY = ["failed", "needs_attention"];

function db() {
  if (!supabaseAdmin) throw new Error("Database not configured");
  return supabaseAdmin;
}

function check<T>(res: { data: T; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data;
}

export function createSupabaseWaveStore(): WaveStore {
  return {
    async getSettings() {
      const res = await db().from("hermes_move_wave").select("enabled, per_day, paused_at, paused_reason, resumed_at").eq("id", true).maybeSingle();
      return check(res, "read move wave") as unknown as WaveSettings | null;
    },
    async pause(reason, atIso) {
      check(await db().from("hermes_move_wave").update({ paused_at: atIso, paused_reason: reason.slice(0, 500), updated_at: atIso }).eq("id", true).select("id"), "pause move wave");
    },
    async failedAutoMovesSince(sinceIso) {
      let q = db().from("hermes_computer_moves").select("*").eq("initiated_by", "auto").in("state", ENDED_BADLY).order("finished_at", { ascending: true }).limit(20);
      if (sinceIso) q = q.gt("finished_at", sinceIso);
      return check(await q, "list failed automatic moves") as unknown as MoveRow[];
    },
    async countAutoMovesSince(sinceIso) {
      const res = await db().from("hermes_computer_moves").select("id", { count: "exact", head: true }).eq("initiated_by", "auto").gte("started_at", sinceIso);
      if (res.error) throw new Error(`count automatic moves: ${res.error.message}`);
      return res.count ?? 0;
    },
    async countNoticesSince(sinceIso) {
      const res = await db().from("hermes_instances").select("id", { count: "exact", head: true }).gte("config->>moveNoticeAt", sinceIso);
      if (res.error) throw new Error(`count move notices: ${res.error.message}`);
      return res.count ?? 0;
    },
    async undoneInstanceIds() {
      const res = await db().from("hermes_computer_moves").select("instance_id").eq("state", "undone").limit(5000);
      return new Set((check(res, "list undone moves") as Array<{ instance_id: string }>).map((r) => r.instance_id));
    },
    async listCandidates(limit) {
      const res = await db()
        .from("hermes_instances")
        .select("id, user_id, name, status, backend, deleted_at, config, created_at, last_agent_activity_at")
        .eq("status", "running")
        .in("backend", ["webui", "gateway"])
        .is("deleted_at", null)
        .is("config->movedTo", null)
        .order("created_at", { ascending: true })
        .limit(limit);
      return check(res, "list move candidates") as unknown as WaveCandidate[];
    },
    async setNotice(instance, atIso) {
      // Read-merge-write on config: the column is jsonb and other writers own other keys.
      const cur = check(await db().from("hermes_instances").select("config").eq("id", instance.id).maybeSingle(), "read instance config") as { config: Record<string, unknown> | null } | null;
      const config = { ...(cur?.config ?? instance.config ?? {}), moveNoticeAt: atIso };
      check(await db().from("hermes_instances").update({ config }).eq("id", instance.id).select("id"), "record move notice");
    },
  };
}
