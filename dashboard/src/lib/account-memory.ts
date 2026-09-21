import "server-only";

// Account-level shared memory — the "shared per-account memory v0" (Wave 5.1).
//
// One row per Clerk user in public.user_memory: a plain-text blob the user
// controls ("what should all my agents know about me"). It is read-only fanned
// out into every NEW Hivra box's USER.md at bootstrap (see agent-bootstrap.ts +
// the agent GET-poll route). There is NO box→account write-back in v0, so a
// box's own evolving USER.md is never clobbered — per-box isolation is preserved.
//
// Server-only: everything goes through supabaseAdmin (service role), mirroring
// hivra_agents. Reads never throw — a missing row, a missing client, or a query
// error all degrade to "" so a bootstrap fold can never break box seeding.

import { supabaseAdmin } from "@/lib/supabase";

/** Hard cap on the stored blob so one account can't bloat every box's USER.md. */
export const MAX_ACCOUNT_MEMORY_LEN = 4000;

/**
 * The user's account-level shared memory, or "" if there is no row, no DB
 * client, or the read fails. Never throws — the caller (bootstrap fold) treats
 * "" as "no shared memory" and seeds the box exactly as before.
 */
export async function getAccountMemory(userId: string): Promise<string> {
  if (!supabaseAdmin || !userId) return "";
  try {
    const { data, error } = await supabaseAdmin
      .from("user_memory")
      .select("content")
      .eq("user_id", userId)
      .maybeSingle();
    if (error || !data) return "";
    return typeof data.content === "string" ? data.content : "";
  } catch {
    return "";
  }
}

/**
 * Upsert the user's account-level shared memory. Trims and clamps to
 * MAX_ACCOUNT_MEMORY_LEN before storing. Idempotent on (user_id) via the unique
 * constraint. Throws if the DB client is missing or the upsert errors — the
 * route maps that to a 500/4xx (unlike reads, a failed save must surface).
 */
export async function setAccountMemory(userId: string, content: string): Promise<void> {
  if (!supabaseAdmin) throw new Error("Database not configured");
  if (!userId) throw new Error("Missing userId");
  const clamped = (content || "").trim().slice(0, MAX_ACCOUNT_MEMORY_LEN);
  const { error } = await supabaseAdmin
    .from("user_memory")
    .upsert(
      { user_id: userId, content: clamped, updated_at: new Date().toISOString() },
      { onConflict: "user_id" },
    );
  if (error) throw new Error(error.message);
}
