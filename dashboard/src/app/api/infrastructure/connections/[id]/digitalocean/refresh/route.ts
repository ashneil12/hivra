export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { refreshDigitalOceanConnection } from "@/lib/hivra/do-managed-sessions";
import { isSameOriginMutationRequest } from "../../../request-security";
import { managedSessionFailure, noStore, UUID, hivraApiUnavailable } from "@/app/api/hivra/managed-sessions/route-support";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const unavailable = hivraApiUnavailable(request);
  if (unavailable) return unavailable;
  const { userId } = await auth();
  if (!userId) return noStore(apiError("Unauthorized", 401));
  if (request.nextUrl.search || !isSameOriginMutationRequest(request)) return noStore(apiError("Same-origin request required.", 403));
  const { id } = await context.params;
  if (!UUID.test(id)) return noStore(apiError("Connection not found.", 404));
  const rateLimit = enforceAuthenticatedRouteRateLimit(request, { routeKey: "digitalocean_connection_refresh", userId, limit: 10, windowMs: 60_000 });
  if (rateLimit) return noStore(rateLimit);
  try {
    return noStore(apiSuccess(await refreshDigitalOceanConnection(userId, id.toLowerCase())));
  } catch (error) {
    return managedSessionFailure(error, "/api/infrastructure/connections/[id]/digitalocean/refresh");
  }
}
