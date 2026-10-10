export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { listDigitalOceanModelsForConnection } from "@/lib/hivra/do-managed-sessions";
import { hivraApiUnavailable, managedSessionFailure, noStore, UUID } from "@/app/api/hivra/managed-sessions/route-support";

/** DigitalOcean Serverless Inference model ids for this connection's team. */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const unavailable = hivraApiUnavailable(request);
  if (unavailable) return unavailable;
  const { userId } = await auth();
  if (!userId) return noStore(apiError("Unauthorized", 401));
  const { id } = await context.params;
  if (!UUID.test(id)) return noStore(apiError("Connection not found.", 404));
  const rateLimit = enforceAuthenticatedRouteRateLimit(request, { routeKey: "digitalocean_inference_models", userId, limit: 30, windowMs: 60_000 });
  if (rateLimit) return noStore(rateLimit);
  try {
    return noStore(apiSuccess({ models: await listDigitalOceanModelsForConnection(userId, id.toLowerCase()) }));
  } catch (error) {
    return managedSessionFailure(error, "/api/infrastructure/connections/[id]/digitalocean/models");
  }
}
