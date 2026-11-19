import "server-only";

import { log } from "@/lib/logger";
import type { supabaseAdmin } from "@/lib/supabase";

/**
 * The two things the wake path needs to know about storage (see
 * sleep-storage.ts), kept apart so the wake code does not pull in the backup
 * tooling.
 */

const LOG_SOURCE = "sleep-storage";
type Db = NonNullable<typeof supabaseAdmin>;
type AgentRow = Record<string, unknown>;

/** Whether this agent's disks are in the storage box right now. */
export function isAgentStored(row: AgentRow | null | undefined): boolean {
  return !!row && row.sleep_state !== "awake" && typeof row.sleep_stored_at === "string" && row.sleep_stored_at.length > 0;
}

/**
 * Notes that someone wants a stored agent back. It does not ask whether the
 * record already says stored: the host may have finished packing a moment
 * before the record caught up, and the sweep drops a request with nothing to
 * do. The sleep sweep starts the work within a minute. Safe to call many times:
 * the first request stands.
 */
export async function requestAgentUnstore(db: Db, agentId: string, nowMs: number = Date.now()): Promise<boolean> {
  const { error } = await db
    .from("hivra_agents")
    .update({ sleep_unstore_requested_at: new Date(nowMs).toISOString() })
    .eq("id", agentId)
    .neq("sleep_state", "awake")
    .is("sleep_unstore_requested_at", null);
  if (error) {
    log.error("failed to note a request to bring a stored agent back", new Error(JSON.stringify(error)), {
      source: LOG_SOURCE,
      failureType: "sleep_unstore_request_failed",
      instanceId: agentId,
    });
    return false;
  }
  return true;
}
