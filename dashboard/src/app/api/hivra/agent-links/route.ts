// Agent ↔ computer links, from either end (design:
// docs/superpowers/specs/2026-10-19-agent-computer-links.md). GET ?id=<agent or
// computer> reads that row's links and the choices on the other end; POST adds
// links, or with `sync` sends an agent its kit now. Canary only.
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
import { addLinks, readLinksView } from "@/lib/agent-links/routes";
import { hasStrictJsonContentType, isSameOriginMutationRequest, readBoundedJson } from "@/app/api/infrastructure/connections/request-security";

const noStore = <T extends Response>(response: T): T => { response.headers.set("Cache-Control", "no-store"); return response; };
const Uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const Body = z.union([
  z.object({ agentId: Uuid.optional(), computerId: Uuid.optional(), all: z.boolean().optional(),
    from: z.enum(["agent", "computer"]).optional() }).strict(),
  z.object({ sync: z.literal(true), agentId: Uuid }).strict(),
]);
const failure = (method: string, failureType: string) => ({ route: "/api/hivra/agent-links", method, failureType });

export async function GET(req: NextRequest) {
  try {
    if (!isHivraApiAllowed(req.headers.get("host")) || !isAgentLinksEnabled()) return noStore(apiError("Not found", 404));
    const { userId } = await auth();
    if (!userId) return noStore(apiError("Unauthorized", 401));
    const limited = enforceAuthenticatedRouteRateLimit(req, { routeKey: "hivra:agent-links:read", userId, limit: 60, windowMs: 60_000 });
    if (limited) return noStore(limited);
    const id = req.nextUrl.searchParams.get("id") ?? "";
    if (!Uuid.safeParse(id).success) return noStore(apiError("Not found.", 404));
    const endpoint = agentLinkEndpoint(req.nextUrl.origin);
    const view = await readLinksView(userId, id, endpoint);
    if (!view.ok) return noStore(apiError(view.message, view.status));
    // An agent whose kit is behind gets it now, after this answer.
    const kit = view.value.kit;
    if (kit && (kit.state === "pending" || kit.state === "failed")) {
      runAfterResponse(() => syncAgentLinkKit(userId, id, endpoint),
        { source: "api/hivra/agent-links", failureType: "agent_link_kit_sync_skipped", userId, agentId: id });
    }
    return noStore(apiSuccess(view.value));
  } catch {
    return noStore(apiError("Couldn't load which computers and agents are linked.", 503, undefined, undefined, failure("GET", "agent_links_unavailable")));
  }
}

export async function POST(req: NextRequest) {
  try {
    if (!isHivraApiAllowed(req.headers.get("host")) || !isAgentLinksEnabled()) return noStore(apiError("Not found", 404));
    const { userId } = await auth();
    if (!userId) return noStore(apiError("Unauthorized", 401));
    if (!isSameOriginMutationRequest(req) || !hasStrictJsonContentType(req)) return noStore(apiError("Forbidden", 403));
    const limited = enforceAuthenticatedRouteRateLimit(req, { routeKey: "hivra:agent-links:write", userId, limit: 20, windowMs: 60_000 });
    if (limited) return noStore(limited);
    const read = await readBoundedJson(req, 2_048, 5_000);
    const body = read.ok ? Body.safeParse(read.body) : null;
    if (!body?.success) return noStore(apiError("The request could not be read.", 400));
    const endpoint = agentLinkEndpoint(req.nextUrl.origin);
    if ("sync" in body.data) {
      const result = await syncAgentLinkKit(userId, body.data.agentId, endpoint, { force: true });
      return noStore(apiSuccess({ kit: result }));
    }
    const added = await addLinks(userId, body.data);
    if (!added.ok) return noStore(apiError(added.message, added.status));
    for (const agentId of added.value.agentIds) {
      runAfterResponse(() => syncAgentLinkKit(userId, agentId, endpoint),
        { source: "api/hivra/agent-links", failureType: "agent_link_kit_sync_skipped", userId, agentId });
    }
    return noStore(apiSuccess({ added: added.value.added }, 201));
  } catch {
    return noStore(apiError("Couldn't link them right now. Nothing was changed.", 503, undefined, undefined, failure("POST", "agent_links_write_unavailable")));
  }
}
