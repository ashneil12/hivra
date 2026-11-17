export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * GET/PUT /api/hivra/agents/[id]/ask-first — Claude Code's "Ask me first"
 * (Manage › Permissions). With it on, Claude Code waits for the owner's answer
 * in Needs you before shell commands and file changes.
 *
 * GET  → { available, enabled }
 * PUT  { "enabled": boolean } → { available, enabled }
 *
 * Owner-scoped: another owner's agent, a deleted one or a malformed id is a 404.
 */

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";

import { apiError, apiSuccess, handleApiError } from "@/lib/api-response";
import { readAskFirst, setAskFirst } from "@/lib/agent-inbox/ask-first";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { hasStrictJsonContentType, isSameOriginMutationRequest, readBoundedJson } from "@/app/api/infrastructure/connections/request-security";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const Body = z.object({ enabled: z.boolean() }).strict();

function noStore(response: Response) {
  response.headers.set("Cache-Control", "no-store, private");
  return response;
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await auth();
    if (!userId) return noStore(apiError("Unauthorized", 401));
    const { id } = await params;
    if (!UUID.test(id)) return noStore(apiError("Agent not found", 404));
    const state = await readAskFirst(userId, id.toLowerCase());
    if (!state) return noStore(apiError("Agent not found", 404));
    return noStore(apiSuccess(state));
  } catch (error) {
    return noStore(handleApiError(error));
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await auth();
    if (!userId) return noStore(apiError("Unauthorized", 401));
    if (!isSameOriginMutationRequest(req)) return noStore(apiError("Change this from the Hivra dashboard.", 403));
    if (!hasStrictJsonContentType(req)) return noStore(apiError("Send the setting as JSON.", 415));
    const limited = enforceAuthenticatedRouteRateLimit(req, { routeKey: "hivra_agent_ask_first", userId, limit: 10, windowMs: 60_000 });
    if (limited) return noStore(limited);
    const body = await readBoundedJson(req, 256, 5000);
    if (!body.ok) return noStore(apiError("Send { enabled: true | false }.", body.reason === "too_large" ? 413 : 400));
    const parsed = Body.safeParse(body.body);
    if (!parsed.success) return noStore(apiError("Send { enabled: true | false }.", 400));
    const { id } = await params;
    if (!UUID.test(id)) return noStore(apiError("Agent not found", 404));
    const result = await setAskFirst(userId, id.toLowerCase(), parsed.data.enabled);
    if (!result.ok) return noStore(apiError(result.message, result.status));
    return noStore(apiSuccess(result.state));
  } catch (error) {
    return noStore(handleApiError(error));
  }
}
