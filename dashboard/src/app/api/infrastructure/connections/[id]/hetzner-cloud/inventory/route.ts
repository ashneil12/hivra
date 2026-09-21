export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";

import { apiError, apiSuccess } from "@/lib/api-response";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { InfrastructureConnectionStoreError } from "@/lib/infrastructure/connection-store";
import {
  getHetznerCloudInventory,
  HetznerCloudConnectionError,
  refreshHetznerCloudInventory,
} from "@/lib/infrastructure/hetzner-cloud";
import { isSameOriginMutationRequest } from "../../../request-security";

const ConnectionIdSchema = z.string().uuid();
type RouteContext = { params: Promise<{ id: string }> };

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

async function connectionId(context: RouteContext): Promise<string | null> {
  const parsed = ConnectionIdSchema.safeParse((await context.params).id);
  return parsed.success ? parsed.data : null;
}

function failure(error: unknown): Response {
  if (error instanceof InfrastructureConnectionStoreError) {
    if (error.code === "not_found") {
      return noStore(apiError("Infrastructure connection not found.", 404));
    }
    if (error.code === "invalid_request") {
      return noStore(apiError("This is not a Hetzner Cloud connection.", 422));
    }
    if (error.code === "credential_error") {
      return noStore(apiError("Hetzner Cloud credentials are unavailable.", 422));
    }
    if (error.code === "conflict") {
      return noStore(apiError("The connection changed. Refresh and retry.", 409));
    }
  }
  if (error instanceof HetznerCloudConnectionError) {
    if (error.code === "invalid_credentials") {
      return noStore(apiError(
        "Hetzner Cloud rejected this project API token.",
        422,
        undefined,
        { code: error.code },
      ));
    }
    return noStore(apiError(
      "Hetzner Cloud inventory could not be refreshed.",
      502,
      undefined,
      { code: error.code },
    ));
  }
  return noStore(
    apiError("Hetzner Cloud inventory could not be loaded.", 500, {
      failureType: "hetzner_cloud_inventory_failed",
      errorName: error instanceof Error ? error.name : typeof error,
    }),
  );
}

export async function GET(_request: NextRequest, context: RouteContext) {
  try {
    const { userId } = await auth();
    if (!userId) return noStore(apiError("Unauthorized", 401));
    const id = await connectionId(context);
    if (!id) return noStore(apiError("Infrastructure connection not found.", 404));
    const inventory = await getHetznerCloudInventory(userId, id);
    return noStore(apiSuccess({ inventory }));
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { userId } = await auth();
    if (!userId) return noStore(apiError("Unauthorized", 401));
    if (!isSameOriginMutationRequest(request)) {
      return noStore(apiError("Same-origin request required.", 403));
    }
    const rateLimitError = enforceAuthenticatedRouteRateLimit(request, {
      routeKey: "hetzner_cloud_inventory_refresh",
      userId,
      limit: 10,
      windowMs: 60_000,
    });
    if (rateLimitError) return noStore(rateLimitError);
    const id = await connectionId(context);
    if (!id) return noStore(apiError("Infrastructure connection not found.", 404));
    const inventory = await refreshHetznerCloudInventory(userId, id);
    return noStore(apiSuccess({ inventory }));
  } catch (error) {
    return failure(error);
  }
}
