export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 30;

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { forgetManagedSession } from "@/lib/hivra/do-managed-sessions";
import { ManagedSessionForgetSchema } from "@/lib/hivra/managed-session-contracts";
import { hivraApiUnavailable, managedSessionFailure, noStore, readMutationBody, UUID } from "../../route-support";

/**
 * Remove a DigitalOcean agent from Hivra when its saved token can no longer
 * reach the session. Nothing is deleted at DigitalOcean; the owner must
 * acknowledge that the session may remain there.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const unavailable = hivraApiUnavailable(request);
  if (unavailable) return unavailable;
  const { userId } = await auth();
  if (!userId) return noStore(apiError("Unauthorized", 401));
  const { id } = await context.params;
  if (!UUID.test(id)) return noStore(apiError("Agent not found.", 404));
  const rateLimit = enforceAuthenticatedRouteRateLimit(request, { routeKey: "hivra_managed_session_forget", userId, limit: 10, windowMs: 60_000 });
  if (rateLimit) return noStore(rateLimit);
  const body = await readMutationBody(request, 1024);
  if (!body.ok) return body.response;
  if (!ManagedSessionForgetSchema.safeParse(body.body).success) {
    return noStore(apiError("Confirm that the session may remain at DigitalOcean.", 400));
  }
  try {
    return noStore(apiSuccess({ session: await forgetManagedSession(userId, id.toLowerCase()) }));
  } catch (error) {
    return managedSessionFailure(error, "/api/hivra/managed-sessions/[id]/forget");
  }
}
