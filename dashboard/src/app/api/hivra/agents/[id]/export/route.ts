// Hivra agent — one-click data export (GET). Streams a portable JSON document
// of the agent's chats + memory as a file download (Wave 4.2). Same auth + host
// gate as every other Hivra agent route; scoped to the caller's own row.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { supabaseAdmin } from "@/lib/supabase";
import { apiError, handleApiError } from "@/lib/api-response";
import { isHivraApiAllowed } from "@/lib/hivra/hivra-flag";
import {
  RATE_LIMIT_PRESETS,
  enforceAuthenticatedRouteRateLimit,
} from "@/lib/authenticated-rate-limit";
import { buildAgentExport, exportFileName } from "@/lib/hivra/agent-export";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!isHivraApiAllowed(req.headers.get("host"))) return apiError("Not found", 404);
    const { id } = await params;
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    if (!supabaseAdmin) return apiError("Database not configured", 500);

    const rateLimitError = enforceAuthenticatedRouteRateLimit(req, {
      routeKey: "hivra-agent-export",
      userId,
      ...RATE_LIMIT_PRESETS.settingsWrite,
    });
    if (rateLimitError) return rateLimitError;

    const { data: agent, error } = await supabaseAdmin
      .from("hivra_agents")
      .select("*")
      .eq("id", id)
      .eq("user_id", userId)
      .neq("status", "deleted")
      .single();
    if (error || !agent) return apiError("Agent not found", 404);

    const data = await buildAgentExport({
      id: String(agent.id),
      name: (agent.name as string | null) ?? null,
      type: (agent.type as string | null) ?? null,
      chat_url: (agent.chat_url as string | null) ?? null,
      api_token: (agent.api_token as string | null) ?? null,
    });

    const filename = exportFileName({ name: agent.name as string | null, id: String(agent.id) });
    return new Response(JSON.stringify(data, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return handleApiError(err);
  }
}
