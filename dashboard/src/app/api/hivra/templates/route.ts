// Hivra agent templates — create (POST) + list owner's (GET).
//
// Wave 5.2: save a configured agent as a named, reusable template (the
// network-effect + creator-economy lever). The snapshot copies only the
// portable identity of a hivra_agents row — never the encrypted LLM key — and
// starts private; sharing is a separate visibility change (PATCH on [id]).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// createTemplateFromAgent does a short, best-effort box round-trip (GET /api/skills,
// ~8s cap) to snapshot installed skills; give the function comfortable headroom.
export const maxDuration = 30;

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { apiSuccess, apiError, handleApiError } from "@/lib/api-response";
import { isHivraApiAllowed } from "@/lib/hivra/hivra-flag";
import { createTemplateFromAgent, listUserTemplates } from "@/lib/hivra/agent-templates";

// POST /api/hivra/templates { agentId } — snapshot an owned agent into a new
// private template.
export async function POST(request: NextRequest) {
  try {
    if (!isHivraApiAllowed(request.headers.get("host"))) return apiError("Not found", 404);
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const agentId = typeof body.agentId === "string" ? body.agentId.trim() : "";
    if (!agentId) return apiError("agentId is required", 400);

    const template = await createTemplateFromAgent(userId, agentId);
    if (!template) return apiError("Could not save that agent as a template", 404);
    return apiSuccess({ template }, 201);
  } catch (err) {
    return handleApiError(err);
  }
}

// GET /api/hivra/templates — the requesting user's own templates (full view,
// including private context).
export async function GET(request: NextRequest) {
  try {
    if (!isHivraApiAllowed(request.headers.get("host"))) return apiError("Not found", 404);
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);

    const templates = await listUserTemplates(userId);
    return apiSuccess({ templates });
  } catch (err) {
    return handleApiError(err);
  }
}
