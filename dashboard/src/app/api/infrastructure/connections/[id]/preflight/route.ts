export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 90;

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";

import { apiError, apiSuccess } from "@/lib/api-response";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { preflightInfrastructureConnection } from "@/lib/infrastructure/connection-preflight";

const ConnectionIdSchema = z.string().uuid();
type RouteContext = { params: Promise<{ id: string }> };

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { userId } = await auth();
    if (!userId) return noStore(apiError("Unauthorized", 401));

    const rateLimitError = enforceAuthenticatedRouteRateLimit(request, {
      routeKey: "infrastructure_connection_preflight",
      userId,
      limit: 5,
      windowMs: 60_000,
    });
    if (rateLimitError) return noStore(rateLimitError);

    const parsedId = ConnectionIdSchema.safeParse((await context.params).id);
    if (!parsedId.success) {
      return noStore(apiError("Infrastructure connection not found.", 404));
    }

    const preflight = await preflightInfrastructureConnection(userId, parsedId.data);
    if (!preflight.ok && preflight.error.code === "CONNECTION_NOT_FOUND") {
      return noStore(apiError("Infrastructure connection not found.", 404));
    }
    if (!preflight.ok && preflight.error.code === "PREFLIGHT_INTERNAL_ERROR") {
      return noStore(
        apiError(
          "Infrastructure preflight failed.",
          500,
          { failureType: "infrastructure_preflight_internal_error" },
          undefined,
          {
            source: "infrastructure/connections/[id]/preflight",
            route: "/api/infrastructure/connections/[id]/preflight",
            method: "POST",
            userId,
            failureType: "infrastructure_preflight_internal_error",
          },
        ),
      );
    }

    // A completed preflight can validly report unmet requirements. That is
    // workflow evidence, not an HTTP transport failure, so return it as data.
    return noStore(apiSuccess({ preflight }));
  } catch (error) {
    return noStore(
      apiError(
        "Infrastructure preflight failed.",
        500,
        {
          failureType: "infrastructure_preflight_unexpected_error",
          errorName: error instanceof Error ? error.name : typeof error,
        },
        undefined,
        {
          source: "infrastructure/connections/[id]/preflight",
          route: "/api/infrastructure/connections/[id]/preflight",
          method: "POST",
          failureType: "infrastructure_preflight_unexpected_error",
          cause: error,
        },
      ),
    );
  }
}
