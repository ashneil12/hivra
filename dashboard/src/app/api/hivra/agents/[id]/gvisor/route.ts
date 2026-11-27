export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 120;

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { apiError, apiSuccess } from "@/lib/api-response";
import { GvisorComputerError, observeGvisorComputer, sleepManagedGvisorTier } from "@/lib/hivra/gvisor-computer-service";
import { hasStrictJsonContentType, isSameOriginMutationRequest, readBoundedJson } from "@/app/api/infrastructure/connections/request-security";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";

function failure(error: unknown) {
  if (error instanceof GvisorComputerError) return apiError(error.message,
    error.code === "not_found" ? 404 : error.code === "plan_required" ? 402
      : error.code === "conflict" || error.code === "not_ready" ? 409 : 503,
    undefined, { code: error.code });
  return apiError("The gVisor computer operation could not be confirmed.", 500);
}

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { userId } = await auth(); if (!userId) return apiError("Unauthorized", 401);
  try { return apiSuccess({ observation: await observeGvisorComputer(userId, (await context.params).id) }); }
  catch (error) { return failure(error); }
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { userId } = await auth(); if (!userId) return apiError("Unauthorized", 401);
  const rateLimit = enforceAuthenticatedRouteRateLimit(request, { routeKey: "hivra_gvisor_tier_sleep", userId, limit: 4, windowMs: 60_000 });
  if (rateLimit) return rateLimit;
  if (request.nextUrl.search || !isSameOriginMutationRequest(request)) return apiError("Open this Computer from Hivra.", 403);
  if (!hasStrictJsonContentType(request)) return apiError("Send the storage operation as JSON.", 415);
  const body = await readBoundedJson(request, 128, 5_000);
  if (!body.ok || JSON.stringify(body.body) !== '{"action":"sleep"}') return apiError("Choose a valid storage operation.", 400);
  try {
    await sleepManagedGvisorTier(userId, (await context.params).id);
    return apiSuccess({ sleeping: true });
  } catch (error) { return failure(error); }
}
