// One computer's recent history for Manage › Advanced (GET, read-only).
//
// Owner-scoped: another owner's computer, a deleted one, or a malformed id is
// a 404. Returns the last 20 lifecycle events as {event, createdAt, label}
// only. The stored detail is never returned: failure details can carry host
// names and raw error text. Agent-run telemetry shares the table and is left
// out; it has its own Activity page.

export const runtime = "nodejs";

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { apiError, apiSuccess, handleApiError } from "@/lib/api-response";
import { isHivraApiAllowed } from "@/lib/hivra/hivra-flag";
import { supabaseAdmin } from "@/lib/supabase";
import { COMPUTER_HISTORY_LABELS, COMPUTER_HISTORY_LIMIT } from "@/lib/hivra/computer-history";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!isHivraApiAllowed(req.headers.get("host"))) return apiError("Not found", 404);
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    if (!supabaseAdmin) return apiError("Database not configured", 500);
    const { id } = await params;
    if (!UUID.test(id)) return apiError("Agent not found", 404);

    const { data: agent, error: agentError } = await supabaseAdmin
      .from("hivra_agents")
      .select("id")
      .eq("id", id)
      .eq("user_id", userId)
      .neq("status", "deleted")
      .maybeSingle();
    if (agentError) return apiError("Could not load this computer.", 503);
    if (!agent) return apiError("Agent not found", 404);

    // Served by the (agent_id, created_at DESC) index.
    const { data, error } = await supabaseAdmin
      .from("hivra_agent_events")
      .select("event, created_at")
      .eq("agent_id", id)
      .eq("user_id", userId)
      .in("event", Object.keys(COMPUTER_HISTORY_LABELS))
      .order("created_at", { ascending: false })
      .limit(COMPUTER_HISTORY_LIMIT);
    if (error) return apiError("Could not load this computer's history.", 503);

    const events = (Array.isArray(data) ? data : []).flatMap((row: { event?: unknown; created_at?: unknown }) => {
      const event = typeof row.event === "string" ? row.event : "";
      const label = COMPUTER_HISTORY_LABELS[event];
      if (!label || typeof row.created_at !== "string") return [];
      return [{ event, createdAt: row.created_at, label }];
    }).slice(0, COMPUTER_HISTORY_LIMIT);

    const response = apiSuccess({ events });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    return handleApiError(error);
  }
}
