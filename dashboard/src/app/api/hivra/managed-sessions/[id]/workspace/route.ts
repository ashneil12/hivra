export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 30;

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { listManagedSessionWorkspace } from "@/lib/hivra/do-managed-sessions";
import { hivraApiUnavailable, managedSessionFailure, noStore, UUID } from "../../route-support";

/** One folder of the session's DigitalOcean /workspace (read-only). */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const unavailable = hivraApiUnavailable(request);
  if (unavailable) return unavailable;
  const { userId } = await auth();
  if (!userId) return noStore(apiError("Unauthorized", 401));
  const { id } = await context.params;
  if (!UUID.test(id)) return noStore(apiError("Agent not found.", 404));
  const rateLimit = enforceAuthenticatedRouteRateLimit(request, { routeKey: "hivra_managed_session_workspace", userId, limit: 60, windowMs: 60_000 });
  if (rateLimit) return noStore(rateLimit);
  try {
    const path = request.nextUrl.searchParams.get("path") ?? "";
    return noStore(apiSuccess({ listing: await listManagedSessionWorkspace(userId, id.toLowerCase(), path) }));
  } catch (error) {
    return managedSessionFailure(error, "/api/hivra/managed-sessions/[id]/workspace");
  }
}
