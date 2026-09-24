export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 300;

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";

import { apiError, apiSuccess } from "@/lib/api-response";
import {
  hostOperationLimitedResponse,
  reserveAuthenticatedRouteRateLimit,
} from "@/lib/authenticated-rate-limit";
import {
  prepareSimpleProxmoxConnection,
  type InfrastructurePreparationErrorCode,
} from "@/lib/infrastructure/connection-preparation";

const ConnectionIdSchema = z.string().uuid();
type RouteContext = { params: Promise<{ id: string }> };

const ERROR_STATUS: Record<InfrastructurePreparationErrorCode, number> = {
  CONNECTION_NOT_FOUND: 404,
  INVALID_CONNECTION: 422,
  SIMPLE_MODE_REQUIRED: 409,
  HOST_RESOLUTION_FAILED: 422,
  HOST_ADDRESS_BLOCKED: 422,
  SSH_HOST_KEY_MISMATCH: 502,
  SSH_AUTHENTICATION_FAILED: 502,
  SSH_CONNECTION_FAILED: 502,
  PREPARATION_FAILED: 502,
  PREPARATION_SUPERSEDED: 409,
  PREPARATION_INTERNAL_ERROR: 500,
};

/** Failed setups allowed per host in 15 minutes before the next must wait. */
const SETUP_FAILURE_LIMIT = 5;

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { userId } = await auth();
    if (!userId) return noStore(apiError("Unauthorized", 401));

    const parsedId = ConnectionIdSchema.safeParse((await context.params).id);
    if (!parsedId.success) {
      return noStore(apiError("Infrastructure connection not found.", 404));
    }

    // Host preparation mutates a Proxmox server and may download a large base
    // image. Keep this considerably tighter than ordinary settings writes, but
    // count only a run that is still going or that succeeded: a person who
    // fixes a failure's cause can try again at once. Failures still open an
    // SSH connection to the server, so they have their own cap.
    const reservation = reserveAuthenticatedRouteRateLimit(request, {
      routeKey: `infrastructure_connection_prepare:${parsedId.data}`,
      userId,
      limit: 1,
      windowMs: 15 * 60_000,
      failureLimit: SETUP_FAILURE_LIMIT,
    });
    if (reservation.limited) {
      return noStore(hostOperationLimitedResponse(reservation.limited, {
        inFlight: "Setup is already running on this server. Wait for it to finish, then check the result.",
        recent: "This server was set up in the last 15 minutes.",
        failures: `Setup failed on this server ${SETUP_FAILURE_LIMIT} times in the last 15 minutes.`,
      }));
    }

    let preparation: Awaited<ReturnType<typeof prepareSimpleProxmoxConnection>>;
    try {
      preparation = await prepareSimpleProxmoxConnection(userId, parsedId.data);
    } catch (error) {
      reservation.settle("failed");
      throw error;
    }
    reservation.settle(preparation.ok ? "succeeded" : "failed");
    if (!preparation.ok) {
      const status = ERROR_STATUS[preparation.error.code];
      return noStore(
        apiError(
          preparation.error.message,
          status,
          { failureType: preparation.error.code.toLowerCase() },
          {
            code: preparation.error.code,
            ...(preparation.error.cause ? { cause: preparation.error.cause } : {}),
          },
          {
            source: "infrastructure/connections/[id]/prepare",
            route: "/api/infrastructure/connections/[id]/prepare",
            method: "POST",
            userId,
            failureType: preparation.error.code.toLowerCase(),
          },
        ),
      );
    }

    return noStore(apiSuccess({ preparation }));
  } catch (error) {
    return noStore(
      apiError(
        "Infrastructure host preparation failed.",
        500,
        {
          failureType: "infrastructure_preparation_unexpected_error",
          errorName: error instanceof Error ? error.name : typeof error,
        },
        { code: "PREPARATION_INTERNAL_ERROR" },
        {
          source: "infrastructure/connections/[id]/prepare",
          route: "/api/infrastructure/connections/[id]/prepare",
          method: "POST",
          failureType: "infrastructure_preparation_unexpected_error",
          cause: error,
        },
      ),
    );
  }
}
