// The owner's agents that were added to one of their computers, for the
// Agents list ("Codex on MY_UBUNTU_DESKTOP" opens that computer's Chat tab).
// Read only. Canary only; elsewhere the list is empty.
export const runtime = "nodejs";
export const maxDuration = 15;
export const dynamic = "force-dynamic";

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { apiError, apiSuccess } from "@/lib/api-response";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { isHivraApiAllowed } from "@/lib/hivra/hivra-flag";
import { isAgentAttachEnabled } from "@/lib/agent-computers/attach-flag";
import { createAttachmentLifecycleStore } from "@/lib/agent-computers/attachment-lifecycle-store";

const noStore = <T extends Response>(response: T): T => { response.headers.set("Cache-Control", "no-store"); return response; };

export async function GET(req: NextRequest) {
  try {
    if (!isHivraApiAllowed(req.headers.get("host"))) return noStore(apiError("Not found", 404));
    const { userId } = await auth();
    if (!userId) return noStore(apiError("Unauthorized", 401));
    if (!isAgentAttachEnabled()) return noStore(apiSuccess({ enabled: false, agents: [] }));
    const limited = enforceAuthenticatedRouteRateLimit(req, { routeKey: "hivra:attached-agents:read", userId, limit: 60, windowMs: 60_000 });
    if (limited) return noStore(limited);
    const agents = await createAttachmentLifecycleStore().readOwnerAttached(userId);
    return noStore(apiSuccess({ enabled: true, agents: agents.map((agent) => ({ id: agent.id, phase: agent.phase, agentName: agent.agentName ?? "Codex",
      runtimeId: agent.runtimeId, computerId: agent.sourceId, computerName: agent.computerName, computerStatus: agent.computerStatus,
      deploymentMode: agent.deploymentMode, createdAt: agent.createdAt, completedAt: agent.completedAt })) }));
  } catch {
    return noStore(apiError("Agents added to your computers couldn't be loaded.", 503, undefined, undefined,
      { route: "/api/hivra/attached-agents", method: "GET", failureType: "attached_agents_unavailable" }));
  }
}
