export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { resolveManagedSessionApproval } from "@/lib/hivra/do-managed-sessions";
import { ManagedSessionApprovalSchema } from "@/lib/hivra/managed-session-contracts";
import { managedSessionFailure, noStore, readMutationBody, UUID, hivraApiUnavailable } from "../../../route-support";

const REQUEST_ID = /^[A-Za-z0-9_.:-]{1,200}$/;

export async function POST(request: NextRequest, context: { params: Promise<{ id: string; requestId: string }> }) {
  const unavailable = hivraApiUnavailable(request);
  if (unavailable) return unavailable;
  const { userId } = await auth();
  if (!userId) return noStore(apiError("Unauthorized", 401));
  const { id, requestId } = await context.params;
  if (!UUID.test(id) || !REQUEST_ID.test(requestId)) return noStore(apiError("Approval not found.", 404));
  const rateLimit = enforceAuthenticatedRouteRateLimit(request, { routeKey: "hivra_managed_session_approval", userId, limit: 60, windowMs: 60_000 });
  if (rateLimit) return noStore(rateLimit);
  const body = await readMutationBody(request, 1024);
  if (!body.ok) return body.response;
  const parsed = ManagedSessionApprovalSchema.safeParse(body.body);
  if (!parsed.success) return noStore(apiError("Choose approve or reject.", 400));
  try {
    await resolveManagedSessionApproval(userId, id.toLowerCase(), requestId, parsed.data.outcome);
    // DigitalOcean confirms the decision on the event stream; this only
    // reports that the request was accepted.
    return noStore(apiSuccess({ submitted: true }, 202));
  } catch (error) {
    return managedSessionFailure(error, "/api/hivra/managed-sessions/[id]/approvals/[requestId]");
  }
}
