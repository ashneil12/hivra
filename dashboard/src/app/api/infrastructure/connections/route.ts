export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import {
  enforceAuthenticatedRouteRateLimit,
  RATE_LIMIT_PRESETS,
} from "@/lib/authenticated-rate-limit";
import { InfrastructureConnectionCreateSchema } from "@/lib/infrastructure/contracts";
import {
  connectHetznerCloudProject,
  HetznerCloudConnectionError,
} from "@/lib/infrastructure/hetzner-cloud";
import {
  createInfrastructureConnection,
  InfrastructureConnectionStoreError,
  listInfrastructureConnections,
} from "@/lib/infrastructure/connection-store";
import {
  hasStrictJsonContentType,
  isSameOriginMutationRequest,
  MAX_CONNECTION_REQUEST_BODY_BYTES,
  readBoundedJson,
} from "./request-security";

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function storeFailure(error: unknown, method: "GET" | "POST"): Response {
  if (error instanceof HetznerCloudConnectionError) {
    if (error.code === "invalid_credentials") {
      return noStore(apiError("Hetzner Cloud rejected this project API token.", 422));
    }
    return noStore(apiError("Hetzner Cloud could not be reached safely.", 502));
  }
  if (error instanceof InfrastructureConnectionStoreError) {
    if (error.code === "conflict") {
      return noStore(apiError("An infrastructure connection with this name already exists.", 409));
    }
    if (error.code === "invalid_request") {
      return noStore(apiError("Invalid infrastructure connection.", 400));
    }
    if (error.code === "database_unavailable") {
      return noStore(apiError("Database not configured", 500));
    }
  }

  return noStore(
    apiError(
      method === "GET"
        ? "Failed to list infrastructure connections."
        : "Failed to create infrastructure connection.",
      500,
      {
        failureType: `infrastructure_connections_${method.toLowerCase()}_failed`,
        errorName: error instanceof Error ? error.name : typeof error,
      },
      undefined,
      {
        source: "infrastructure/connections",
        route: "/api/infrastructure/connections",
        method,
        failureType: `infrastructure_connections_${method.toLowerCase()}_failed`,
        cause: error,
      },
    ),
  );
}

export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) return noStore(apiError("Unauthorized", 401));

    const connections = await listInfrastructureConnections(userId);
    return noStore(apiSuccess({ connections }));
  } catch (error) {
    return storeFailure(error, "GET");
  }
}

export async function POST(request: NextRequest) {
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
      routeKey: "infrastructure_connections_post",
      userId,
      ...RATE_LIMIT_PRESETS.secretWrite,
    });
    if (rateLimitError) return noStore(rateLimitError);

    const boundedBody = await readBoundedJson(
      request,
      MAX_CONNECTION_REQUEST_BODY_BYTES,
    );
    if (!boundedBody.ok) {
      if (boundedBody.reason === "too_large") {
        return noStore(apiError("Infrastructure connection request is too large.", 413));
      }
      return noStore(apiError("Invalid JSON request body.", 400));
    }

    const parsed = InfrastructureConnectionCreateSchema.safeParse(boundedBody.body);
    if (!parsed.success) {
      return noStore(
        apiError("Invalid infrastructure connection.", 400, {
          failureType: "infrastructure_connection_invalid_create_request",
          issueCount: parsed.error.issues.length,
        }),
      );
    }

    if (parsed.data.provider === "hetzner-cloud") {
      const result = await connectHetznerCloudProject({
        userId,
        name: parsed.data.name,
        apiToken: parsed.data.credentials.apiToken,
      });
      return noStore(apiSuccess(result, 201));
    }

    const connection = await createInfrastructureConnection(userId, parsed.data);
    return noStore(apiSuccess({ connection }, 201));
  } catch (error) {
    return storeFailure(error, "POST");
  }
}
