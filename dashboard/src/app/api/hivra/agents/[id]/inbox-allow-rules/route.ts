export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET/DELETE /api/hivra/agents/[id]/inbox-allow-rules — the "Always allow"
 * rules an owner created from Needs you for a Claude Code agent.
 *
 * GET                  → { rules: [{ id, tool, command, createdAt }] }
 * DELETE ?rule=<uuid>  → { revoked: true }
 *
 * Owner-scoped: another owner's agent or a malformed id is a 404.
 */

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { apiError, apiSuccess, handleApiError } from "@/lib/api-response";
import { listRules, revokeRule } from "@/lib/agent-inbox/allow-rules";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { isSameOriginMutationRequest } from "@/app/api/infrastructure/connections/request-security";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    const rules = await listRules(userId, id.toLowerCase());
    if (!rules) return noStore(apiError("Agent not found", 404));
    return noStore(apiSuccess({ rules }));
  } catch (error) {
    return noStore(handleApiError(error));
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await auth();
    if (!userId) return noStore(apiError("Unauthorized", 401));
    if (!isSameOriginMutationRequest(req)) return noStore(apiError("Change this from the Hivra dashboard.", 403));
    const limited = enforceAuthenticatedRouteRateLimit(req, { routeKey: "hivra_agent_inbox_allow_rules", userId, limit: 30, windowMs: 60_000 });
    if (limited) return noStore(limited);
    const { id } = await params;
    const rule = req.nextUrl.searchParams.get("rule") ?? "";
    if (!UUID.test(id) || !UUID.test(rule)) return noStore(apiError("Rule not found", 404));
    const revoked = await revokeRule(userId, id.toLowerCase(), rule.toLowerCase());
    if (!revoked) return noStore(apiError("Rule not found", 404));
    return noStore(apiSuccess({ revoked: true }));
  } catch (error) {
    return noStore(handleApiError(error));
  }
}
