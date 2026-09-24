export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 300;

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import { apiError, apiSuccess } from "@/lib/api-response";
import { isSameOriginMutationRequest } from "@/app/api/infrastructure/connections/request-security";
import { prepareGvisorHost, GvisorComputerError, GvisorPreparationError } from "@/lib/hivra/gvisor-computer-service";
import { GvisorTargetError, preflightGvisorTarget } from "@/lib/infrastructure/gvisor-target";
import { HIVRA_GVISOR_BUNDLE_SHA256 } from "@/lib/hivra/gvisor-computer-contract";
import {
  hostOperationLimitedResponse,
  reserveAuthenticatedRouteRateLimit,
} from "@/lib/authenticated-rate-limit";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) return apiError("Unauthorized", 401);
  if (request.nextUrl.search || !isSameOriginMutationRequest(request)) return apiError("Open host preparation from this dashboard.", 403);
  const id = z.string().uuid().safeParse((await context.params).id);
  if (!id.success) return apiError("Infrastructure connection not found.", 404);
  // One run per host at a time, and one successful run per 15 minutes. A
  // failed run gives its slot back so a fixed cause can be retried at once.
  const reservation = reserveAuthenticatedRouteRateLimit(request, { routeKey: `infrastructure_gvisor_prepare:${id.data}`, userId, limit: 1, windowMs: 15 * 60_000 });
  if (reservation.limited) {
    return hostOperationLimitedResponse(reservation.limited, {
      inFlight: "Linux Sandbox setup is already running on this server. Wait for it to finish, then check the result.",
      recent: "Linux Sandbox was set up on this server in the last 15 minutes.",
    });
  }
  try {
    const preparation = await prepareGvisorHost(userId, id.data);
    const target = await preflightGvisorTarget(userId, id.data, HIVRA_GVISOR_BUNDLE_SHA256,
      { runId: preparation.runId, connectionRevision: preparation.connectionRevision });
    reservation.settle("succeeded");
    const { runId: _runId, connectionRevision: _connectionRevision, ...publicPreparation } = preparation;
    return apiSuccess({ preparation: publicPreparation, target });
  } catch (error) {
    reservation.settle("failed");
    if (error instanceof GvisorPreparationError) {
      return apiError(error.message, 502, undefined, { code: error.code, ...(error.stage ? { stage: error.stage } : {}) });
    }
    if (error instanceof GvisorComputerError) return apiError(error.message, error.code === "remote_failed" ? 502 : 409, undefined, { code: error.code });
    // The runtime installed but its strict check did not pass: the failure
    // belongs to the final readiness step, not an install stage.
    if (error instanceof GvisorTargetError) return apiError(error.message,
      error.code === "database_failed" ? 500 : error.code === "remote_failed" ? 502 : 409, undefined,
      { code: error.code, stage: "readiness-check" });
    return apiError("The gVisor host preparation failed.", 500);
  }
}
