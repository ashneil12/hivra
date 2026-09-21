export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";

import { apiError, apiSuccess } from "@/lib/api-response";
import {
  enforceAuthenticatedRouteRateLimit,
  RATE_LIMIT_PRESETS,
} from "@/lib/authenticated-rate-limit";
import { ProxmoxConnectionUpdateSchema } from "@/lib/infrastructure/contracts";
import {
  deleteInfrastructureConnection,
  getInfrastructureConnection,
  InfrastructureConnectionStoreError,
  updateInfrastructureConnection,
} from "@/lib/infrastructure/connection-store";
import {
  hasStrictJsonContentType,
  isSameOriginMutationRequest,
  MAX_CONNECTION_REQUEST_BODY_BYTES,
  readBoundedJson,
} from "../request-security";

const ConnectionIdSchema = z.string().uuid();
type RouteContext = { params: Promise<{ id: string }> };

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function storeFailure(error: unknown, method: "GET" | "PATCH" | "DELETE"): Response {
  if (error instanceof InfrastructureConnectionStoreError) {
    if (error.code === "not_found") {
      return noStore(apiError("Infrastructure connection not found.", 404));
    }
    if (error.code === "conflict") {
      return noStore(
        apiError(
          method === "PATCH"
            ? "The connection changed or its name is already in use. Refresh and retry."
            : "The infrastructure connection could not be deleted because it changed.",
          409,
        ),
      );
    }
    if (method === "DELETE" && error.code === "capacity_busy") {
      return noStore(apiError(
        "A Hetzner provider mutation is still creating, pending, or inside its reconciliation lease.",
        409,
        undefined,
        { code: "capacity_busy" },
      ));
    }
    if (
      method === "DELETE"
      && error.code === "capacity_force_forget_required"
    ) {
      return noStore(apiError(
        "This Hetzner operation is ambiguous. Use the explicit force-forget flow if you accept that provider resources and billing may remain.",
        409,
        undefined,
        { code: "capacity_force_forget_required" },
      ));
    }
    if (error.code === "invalid_request") {
      return noStore(apiError("Invalid infrastructure connection update.", 400));
    }
    if (error.code === "database_unavailable") {
      return noStore(apiError("Database not configured", 500));
    }
  }

  return noStore(
    apiError(
      `Failed to ${method === "GET" ? "load" : method === "PATCH" ? "update" : "delete"} infrastructure connection.`,
      500,
      {
        failureType: `infrastructure_connection_${method.toLowerCase()}_failed`,
        errorName: error instanceof Error ? error.name : typeof error,
      },
      undefined,
      {
        source: "infrastructure/connections/[id]",
        route: "/api/infrastructure/connections/[id]",
        method,
        failureType: `infrastructure_connection_${method.toLowerCase()}_failed`,
        cause: error,
      },
    ),
  );
}

async function connectionId(context: RouteContext): Promise<string | null> {
  const parsed = ConnectionIdSchema.safeParse((await context.params).id);
  return parsed.success ? parsed.data : null;
}

export async function GET(_request: NextRequest, context: RouteContext) {
  try {
    const { userId } = await auth();
    if (!userId) return noStore(apiError("Unauthorized", 401));
    const id = await connectionId(context);
    if (!id) return noStore(apiError("Infrastructure connection not found.", 404));

    const connection = await getInfrastructureConnection(userId, id);
    return noStore(apiSuccess({ connection }));
  } catch (error) {
    return storeFailure(error, "GET");
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const { userId } = await auth();
    if (!userId) return noStore(apiError("Unauthorized", 401));
    if (!isSameOriginMutationRequest(request)) {
      return noStore(apiError("Same-origin request required.", 403));
    }
    if (!hasStrictJsonContentType(request)) {
      return noStore(apiError("Content-Type must be application/json.", 415));
    }

    const rateLimitError = enforceAuthenticatedRouteRateLimit(request, {
      routeKey: "infrastructure_connections_patch",
      userId,
      ...RATE_LIMIT_PRESETS.secretWrite,
    });
    if (rateLimitError) return noStore(rateLimitError);

    const id = await connectionId(context);
    if (!id) return noStore(apiError("Infrastructure connection not found.", 404));

    const boundedBody = await readBoundedJson(
      request,
      MAX_CONNECTION_REQUEST_BODY_BYTES,
    );
    if (!boundedBody.ok) {
      if (boundedBody.reason === "too_large") {
        return noStore(apiError("Infrastructure connection update is too large.", 413));
      }
      return noStore(apiError("Invalid JSON request body.", 400));
    }
    const parsed = ProxmoxConnectionUpdateSchema.safeParse(boundedBody.body);
    if (!parsed.success) {
      return noStore(
        apiError("Invalid infrastructure connection update.", 400, {
          failureType: "infrastructure_connection_invalid_update_request",
          issueCount: parsed.error.issues.length,
        }),
      );
    }

    const connection = await updateInfrastructureConnection(userId, id, parsed.data);
    return noStore(apiSuccess({ connection }));
  } catch (error) {
    return storeFailure(error, "PATCH");
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const { userId } = await auth();
    if (!userId) return noStore(apiError("Unauthorized", 401));
    if (!isSameOriginMutationRequest(request)) {
      return noStore(apiError("Same-origin request required.", 403));
    }

    const rateLimitError = enforceAuthenticatedRouteRateLimit(request, {
      routeKey: "infrastructure_connections_delete",
      userId,
      ...RATE_LIMIT_PRESETS.secretWrite,
    });
    if (rateLimitError) return noStore(rateLimitError);

    const id = await connectionId(context);
    if (!id) return noStore(apiError("Infrastructure connection not found.", 404));

    await deleteInfrastructureConnection(userId, id);
    return noStore(apiSuccess({ deleted: true }));
  } catch (error) {
    return storeFailure(error, "DELETE");
  }
}
