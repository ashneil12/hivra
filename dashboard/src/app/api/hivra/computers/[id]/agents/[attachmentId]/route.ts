// Change what an attached agent may use (PATCH) or remove it (DELETE), each
// its own reviewed operation on the computer (design 5.5, 5.8). The route only
// starts the step; the minute worker runs it and records what it observed.
// Remove never deletes a file in ~/Hivra. Canary only.
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
import { attachDependencies, beginAttachmentOperation } from "@/lib/agent-computers/attach-routes";
import { hasStrictJsonContentType, isSameOriginMutationRequest, readBoundedJson } from "@/app/api/infrastructure/connections/request-security";

const noStore = <T extends Response>(response: T): T => { response.headers.set("Cache-Control", "no-store"); return response; };
const Uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const Review = z.string().regex(/^[0-9a-f]{64}$/);
const AccessBody = z.object({ grants: z.object({ workspace: z.boolean() }).strict(), reviewSha256: Review, requestId: Uuid }).strict();
const RemoveBody = z.object({ reviewSha256: Review, requestId: Uuid }).strict();

async function handle(req: NextRequest, params: Promise<{ id: string; attachmentId: string }>, kind: "access_change" | "detach") {
  const method = kind === "detach" ? "DELETE" : "PATCH";
  try {
    if (!isHivraApiAllowed(req.headers.get("host")) || !isAgentAttachEnabled()) return noStore(apiError("Not found", 404));
    const { userId } = await auth();
    if (!userId) return noStore(apiError("Unauthorized", 401));
    if (!isSameOriginMutationRequest(req) || !hasStrictJsonContentType(req)) return noStore(apiError("Forbidden", 403));
    const limited = enforceAuthenticatedRouteRateLimit(req, { routeKey: `hivra:attach:${kind}`, userId, limit: 6, windowMs: 60_000 });
    if (limited) return noStore(limited);
    const { id, attachmentId } = await params;
    if (!Uuid.safeParse(id).success || !Uuid.safeParse(attachmentId).success) return noStore(apiError("Codex is not on this computer.", 404));
    const read = await readBoundedJson(req, 4_096, 5_000);
    const body = read.ok ? (kind === "detach" ? RemoveBody : AccessBody).safeParse(read.body) : null;
    if (!body?.success) return noStore(apiError("The request could not be read.", 400));
    const result = await beginAttachmentOperation(userId, id, attachmentId, { kind, ...body.data }, attachDependencies());
    if (!result.ok) return noStore(apiError(result.message, result.status, undefined, result.reason ? { reason: result.reason } : undefined));
    return noStore(apiSuccess({ operationId: result.operationId, resumed: result.resumed }, 202));
  } catch {
    return noStore(apiError("This step could not be started right now. Nothing was changed.", 503, undefined, undefined,
      { route: "/api/hivra/computers/[id]/agents/[attachmentId]", method, failureType: "attach_operation_unavailable" }));
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string; attachmentId: string }> }) {
  return handle(req, params, "access_change");
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string; attachmentId: string }> }) {
  return handle(req, params, "detach");
}
