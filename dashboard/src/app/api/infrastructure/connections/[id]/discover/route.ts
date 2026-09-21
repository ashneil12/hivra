export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 60;

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";

import { apiError, apiSuccess } from "@/lib/api-response";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { discoverInfrastructureHost } from "@/lib/infrastructure/host-discovery";
import type { HostDiscoveryErrorCode } from "@/lib/infrastructure/host-discovery-contracts";

const ConnectionIdSchema = z.string().uuid();
type RouteContext = { params: Promise<{ id: string }> };

const ERROR_HTTP_STATUS: Record<HostDiscoveryErrorCode, number> = {
  CONNECTION_NOT_FOUND: 404,
  INVALID_CONNECTION: 422,
  HOST_RESOLUTION_FAILED: 422,
  HOST_ADDRESS_BLOCKED: 422,
  SSH_HOST_KEY_MISMATCH: 502,
  SSH_AUTHENTICATION_FAILED: 502,
  SSH_CONNECTION_FAILED: 502,
  SSH_COMMAND_FAILED: 502,
  DISCOVERY_OUTPUT_INVALID: 502,
  DISCOVERY_SUPERSEDED: 409,
  DISCOVERY_INTERNAL_ERROR: 500,
};

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { userId } = await auth();
    if (!userId) return noStore(apiError("Unauthorized", 401));

    const rateLimitError = enforceAuthenticatedRouteRateLimit(request, {
      routeKey: "infrastructure_host_discovery",
      userId,
      limit: 5,
      windowMs: 60_000,
    });
    if (rateLimitError) return noStore(rateLimitError);

    const parsedId = ConnectionIdSchema.safeParse((await context.params).id);
    if (!parsedId.success) {
      return noStore(apiError("Infrastructure connection not found.", 404));
    }

    const discovery = await discoverInfrastructureHost(userId, parsedId.data);
    if (!discovery.ok) {
      const status = ERROR_HTTP_STATUS[discovery.error.code];
      return noStore(
        apiError(
          discovery.error.message,
          status,
          {
            failureType: `host_discovery_${discovery.error.code.toLowerCase()}`,
          },
          { discovery },
          {
            source: "infrastructure/connections/[id]/discover",
            route: "/api/infrastructure/connections/[id]/discover",
            method: "POST",
            userId,
            failureType: `host_discovery_${discovery.error.code.toLowerCase()}`,
          },
        ),
      );
    }

    return noStore(apiSuccess({ discovery }));
  } catch (error) {
    return noStore(
      apiError(
        "Host discovery failed.",
        500,
        {
          failureType: "host_discovery_unexpected_error",
          errorName: error instanceof Error ? error.name : typeof error,
        },
        undefined,
        {
          source: "infrastructure/connections/[id]/discover",
          route: "/api/infrastructure/connections/[id]/discover",
          method: "POST",
          failureType: "host_discovery_unexpected_error",
          cause: error,
        },
      ),
    );
  }
}
