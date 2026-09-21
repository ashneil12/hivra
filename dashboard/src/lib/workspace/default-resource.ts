import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Which resource a bare visit to Chat should open.
 *
 * The workspace shell used to answer this on the client: `openDefaultAgent()`
 * picked the most recently active agent, running first, precisely so that
 * arriving at Chat with nothing selected never showed an empty pane. Merging the
 * routes retired that shell and left the bare `/dashboard/workspace` URL with no
 * resource to resolve, so it fell through to `/dashboard/chat` — a page that
 * only ever looks at `hermes_instances` and therefore cannot serve an owner
 * whose resources are all Hivra agents. Clicking "Chat" produced
 * "Chat needs an agent workspace first."
 *
 * The fix restores the same decision on the server, where the redirect can act
 * on it. The preference is deliberately identical to the client's: a RUNNING
 * resource wins, then the most recently created, because landing on a stopped
 * box is a worse first impression than landing on a live one.
 *
 * This is only ever consulted when the URL carries no resource of its own. An
 * addressable URL is always honoured exactly.
 */

/** Hivra statuses that mean "there is something here worth opening". */
const OPENABLE_STATUSES = ["running", "provisioning", "stopped", "error"] as const;

export interface DefaultResourceQuery {
  userId: string;
  supabase: SupabaseClient;
}

/**
 * The Hivra agent to open for this user, or null when they have none.
 *
 * Returns the raw backing id — the caller builds the route, and the canonical
 * route's path segment is the raw id, not the source-qualified uid.
 */
export async function resolveDefaultHivraResource({
  userId,
  supabase,
}: DefaultResourceQuery): Promise<string | null> {
  const { data, error } = await supabase
    .from("hivra_agents")
    .select("id, status, created_at")
    .eq("user_id", userId)
    .in("status", OPENABLE_STATUSES as unknown as string[])
    .order("created_at", { ascending: false })
    .limit(20);

  if (error || !Array.isArray(data) || data.length === 0) return null;

  // Running first, exactly as the client did. A provisioning box is next best
  // (it is on its way up), then the most recent of whatever remains — so the
  // user lands somewhere real rather than on an error page.
  const rank = (status: unknown): number => {
    if (status === "running") return 0;
    if (status === "provisioning") return 1;
    return 2;
  };

  const best = [...data].sort((a, b) => {
    const byRank = rank(a.status) - rank(b.status);
    if (byRank !== 0) return byRank;
    // Both queries order by created_at desc, so ties keep newest-first.
    return String(b.created_at ?? "").localeCompare(String(a.created_at ?? ""));
  })[0];

  const id = best?.id;
  return typeof id === "string" && id.trim() ? id : null;
}
