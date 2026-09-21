export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 60;

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import { apiError, apiSuccess } from "@/lib/api-response";
import { isSameOriginMutationRequest } from "@/app/api/infrastructure/connections/request-security";
import { GvisorTargetError, preflightGvisorTarget } from "@/lib/infrastructure/gvisor-target";
import { HIVRA_GVISOR_BUNDLE_SHA256 } from "@/lib/hivra/gvisor-computer-contract";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) return apiError("Unauthorized", 401);
  if (request.nextUrl.search || !isSameOriginMutationRequest(request)) return apiError("Open host checks from this dashboard.", 403);
  const id = z.string().uuid().safeParse((await context.params).id);
  if (!id.success) return apiError("Infrastructure connection not found.", 404);
  const rateLimit = enforceAuthenticatedRouteRateLimit(request, { routeKey: `infrastructure_gvisor_preflight:${id.data}`, userId, limit: 6, windowMs: 60_000 });
  if (rateLimit) return rateLimit;
  try { return apiSuccess({ target: await preflightGvisorTarget(userId, id.data, HIVRA_GVISOR_BUNDLE_SHA256) }); }
  catch (error) {
    if (error instanceof GvisorTargetError) return apiError(error.message,
      error.code === "not_found" ? 404 : error.code === "database_failed" ? 500 : error.code === "remote_failed" ? 502 : 409,
      undefined, { code: error.code });
    return apiError("The gVisor host check failed.", 500);
  }
}
