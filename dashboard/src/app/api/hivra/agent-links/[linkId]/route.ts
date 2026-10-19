// Remove one agent ↔ computer link. The agent loses that computer at its next
// request (the agent API reads the link every time); its kit is updated after
// this answer. Canary only.
export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import { apiError, apiSuccess } from "@/lib/api-response";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { isHivraApiAllowed } from "@/lib/hivra/hivra-flag";
import { runAfterResponse } from "@/lib/hivra/after-response";
import { isAgentLinksEnabled } from "@/lib/agent-links/flag";
import { agentLinkEndpoint, syncAgentLinkKit } from "@/lib/agent-links/kit-delivery";
import { removeLink } from "@/lib/agent-links/routes";
import { isSameOriginMutationRequest } from "@/app/api/infrastructure/connections/request-security";

const noStore = <T extends Response>(response: T): T => { response.headers.set("Cache-Control", "no-store"); return response; };
const Uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ linkId: string }> }) {
  try {
    if (!isHivraApiAllowed(req.headers.get("host")) || !isAgentLinksEnabled()) return noStore(apiError("Not found", 404));
    const { userId } = await auth();
    if (!userId) return noStore(apiError("Unauthorized", 401));
    if (!isSameOriginMutationRequest(req)) return noStore(apiError("Forbidden", 403));
    const limited = enforceAuthenticatedRouteRateLimit(req, { routeKey: "hivra:agent-links:write", userId, limit: 20, windowMs: 60_000 });
    if (limited) return noStore(limited);
    const { linkId } = await params;
    if (!Uuid.safeParse(linkId).success) return noStore(apiError("Not found.", 404));
    const removed = await removeLink(userId, linkId);
    if (!removed.ok) return noStore(apiError(removed.message, removed.status));
    const endpoint = agentLinkEndpoint(req.nextUrl.origin), agentId = removed.value.agentId;
    runAfterResponse(() => syncAgentLinkKit(userId, agentId, endpoint),
      { source: "api/hivra/agent-links/[linkId]", failureType: "agent_link_kit_sync_skipped", userId, agentId });
    return noStore(apiSuccess({ removed: true }));
  } catch {
    return noStore(apiError("Couldn't remove the link right now. Nothing was changed.", 503, undefined, undefined,
      { route: "/api/hivra/agent-links/[linkId]", method: "DELETE", failureType: "agent_link_remove_unavailable" }));
  }
}
