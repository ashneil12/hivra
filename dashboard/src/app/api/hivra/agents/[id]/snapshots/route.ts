export const runtime = "nodejs";

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { apiError, apiSuccess, handleApiError } from "@/lib/api-response";
import { isHivraApiAllowed } from "@/lib/hivra/hivra-flag";
import { supabaseAdmin } from "@/lib/supabase";

function publicSnapshot(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    status: String(row.status),
    retentionPolicy: String(row.retention_policy),
    createdAt: String(row.created_at),
    readyAt: typeof row.ready_at === "string" ? row.ready_at : null,
    lastRestoredAt: typeof row.last_restored_at === "string" ? row.last_restored_at : null,
    restoreCount: Number(row.restore_count) || 0,
    error: typeof row.last_error === "string" && row.last_error.trim()
      ? row.last_error.trim()
      : null,
  };
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    if (!isHivraApiAllowed(req.headers.get("host"))) return apiError("Not found", 404);
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    if (!supabaseAdmin) return apiError("Database not configured", 500);
    const { id } = await params;

    const { data: agent, error: agentError } = await supabaseAdmin
      .from("hivra_agents")
      .select("id, computer_substrate")
      .eq("id", id)
      .eq("user_id", userId)
      .neq("status", "deleted")
      .maybeSingle();
    if (agentError) return apiError("Could not load this computer.", 503);
    if (!agent) return apiError("Agent not found", 404);
    if (agent.computer_substrate !== "proxmox-kvm") {
      return apiSuccess({ snapshots: [], supported: false });
    }

    const { data, error } = await supabaseAdmin
      .from("hivra_agent_snapshots")
      .select("id, status, retention_policy, created_at, ready_at, last_restored_at, restore_count, last_error")
      .eq("agent_id", id)
      .eq("user_id", userId)
      .neq("status", "deleted")
      .order("created_at", { ascending: false });
    if (error) return apiError("Could not load restore points.", 503);

    const response = apiSuccess({
      snapshots: (Array.isArray(data) ? data : []).map((row) => publicSnapshot(row)),
      supported: true,
      maximum: 5,
    });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    return handleApiError(error);
  }
}
