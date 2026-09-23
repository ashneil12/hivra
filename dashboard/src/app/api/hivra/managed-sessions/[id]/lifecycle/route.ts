export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 60;

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { managedSessionAction } from "@/lib/hivra/do-managed-sessions";
import { ManagedSessionActionSchema } from "@/lib/hivra/managed-session-contracts";
import { managedSessionFailure, noStore, readMutationBody, UUID, hivraApiUnavailable } from "../../route-support";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const unavailable = hivraApiUnavailable(request);
  if (unavailable) return unavailable;
  const { userId } = await auth();
  if (!userId) return noStore(apiError("Unauthorized", 401));
  const { id } = await context.params;
  if (!UUID.test(id)) return noStore(apiError("Agent not found.", 404));
  const rateLimit = enforceAuthenticatedRouteRateLimit(request, { routeKey: "hivra_managed_session_lifecycle", userId, limit: 20, windowMs: 60_000 });
  if (rateLimit) return noStore(rateLimit);
  const body = await readMutationBody(request, 1024);
  if (!body.ok) return body.response;
  const parsed = ManagedSessionActionSchema.safeParse(body.body);
  if (!parsed.success) return noStore(apiError("Choose pause, resume, or delete.", 400));
  try {
    return noStore(apiSuccess({ session: await managedSessionAction(userId, id.toLowerCase(), parsed.data.action) }));
  } catch (error) {
    return managedSessionFailure(error, "/api/hivra/managed-sessions/[id]/lifecycle");
  }
}
