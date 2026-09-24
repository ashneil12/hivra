// Add an agent to a computer its owner already has (design 5.5 to 5.8). GET
// reads the access gate; POST makes one claim and returns 202 with its
// operation id. The minute worker installs and starts Codex; this route never
// runs a guest step. Canary only.
export const runtime = "nodejs";
export const maxDuration = 20;
export const dynamic = "force-dynamic";

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import { apiError, apiSuccess } from "@/lib/api-response";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { isHivraApiAllowed } from "@/lib/hivra/hivra-flag";
import { isAgentAttachEnabled } from "@/lib/agent-computers/attach-flag";
import { attachDependencies, claimAttach, readAttachGate } from "@/lib/agent-computers/attach-routes";
import { hasStrictJsonContentType, isSameOriginMutationRequest, readBoundedJson } from "@/app/api/infrastructure/connections/request-security";

const noStore = <T extends Response>(response: T): T => { response.headers.set("Cache-Control", "no-store"); return response; };
const Uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const Body = z.object({ grants: z.object({ workspace: z.boolean() }).strict(), reviewSha256: z.string().regex(/^[0-9a-f]{64}$/),
  requestId: Uuid }).strict();
const failure = (method: string, failureType: string) => ({ route: "/api/hivra/computers/[id]/agents", method, failureType });

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!isHivraApiAllowed(req.headers.get("host")) || !isAgentAttachEnabled()) return noStore(apiError("Not found", 404));
    const { userId } = await auth();
    if (!userId) return noStore(apiError("Unauthorized", 401));
    const limited = enforceAuthenticatedRouteRateLimit(req, { routeKey: "hivra:attach:read", userId, limit: 60, windowMs: 60_000 });
    if (limited) return noStore(limited);
    const { id } = await params;
    if (!Uuid.safeParse(id).success) return noStore(apiError("Computer not found.", 404));
    const gate = await readAttachGate(userId, id, attachDependencies());
    if (!gate) return noStore(apiError("Computer not found.", 404));
    return noStore(apiSuccess(gate));
  } catch {
    return noStore(apiError("Couldn't check what this computer can take. Nothing was changed.", 503, undefined, undefined,
      failure("GET", "attach_gate_unavailable")));
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!isHivraApiAllowed(req.headers.get("host")) || !isAgentAttachEnabled()) return noStore(apiError("Not found", 404));
    const { userId } = await auth();
    if (!userId) return noStore(apiError("Unauthorized", 401));
    if (!isSameOriginMutationRequest(req) || !hasStrictJsonContentType(req)) return noStore(apiError("Forbidden", 403));
    const limited = enforceAuthenticatedRouteRateLimit(req, { routeKey: "hivra:attach:add", userId, limit: 6, windowMs: 60_000 });
    if (limited) return noStore(limited);
    const { id } = await params;
    if (!Uuid.safeParse(id).success) return noStore(apiError("Computer not found.", 404));
    const read = await readBoundedJson(req, 4_096, 5_000);
    const body = read.ok ? Body.safeParse(read.body) : null;
    if (!body?.success) return noStore(apiError("The request could not be read.", 400));
    const result = await claimAttach(userId, id, body.data, attachDependencies());
    if (!result.ok) return noStore(apiError(result.message, result.status, undefined, result.reason ? { reason: result.reason } : undefined));
    return noStore(apiSuccess({ operationId: result.operationId, resumed: result.resumed }, 202));
  } catch {
    return noStore(apiError("Codex could not be added right now. Nothing was installed.", 503, undefined, undefined,
      failure("POST", "attach_claim_unavailable")));
  }
}
