// Who has connected into this agent's computer (Manage › Advanced › Privacy):
// the last 30 days of connections recorded on its server, counted per hour by
// who (Hivra's automatic systems or a person at Hivra) and how (a command, a
// console, an SSH session, a file copy). Owner-scoped: another owner's agent,
// a deleted one or a malformed id is a 404. While NEXT_PUBLIC_HIVRA_ACCESS_LOG
// is off the route answers 404 so the dashboard hides it.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { apiError, apiSuccess, handleApiError } from "@/lib/api-response";
import { supabaseAdmin } from "@/lib/supabase";
import { accessLogViewEnabled, readAccessLog } from "@/lib/hivra/computer-access-log";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function noStore(response: Response) {
  response.headers.set("Cache-Control", "no-store, private");
  return response;
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!accessLogViewEnabled()) return noStore(apiError("Not found", 404, undefined, { code: "feature_disabled" }));
    const { userId } = await auth();
    if (!userId) return noStore(apiError("Unauthorized", 401));
    if (!supabaseAdmin) return noStore(apiError("Database not configured", 500));
    const { id } = await params;
    if (!UUID.test(id)) return noStore(apiError("Agent not found", 404));
    const { data, error } = await supabaseAdmin
      .from("hivra_agents")
      .select("id, status, proxmox_host")
      .eq("id", id)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) return noStore(apiError("Could not load this agent", 500));
    const row = data as { id: string; status?: string; proxmox_host?: string | null } | null;
    if (!row || row.status === "deleted") return noStore(apiError("Agent not found", 404));
    return noStore(apiSuccess(await readAccessLog(supabaseAdmin, { agentId: row.id, proxmoxHost: row.proxmox_host ?? null })));
  } catch (err) {
    return noStore(handleApiError(err));
  }
}
