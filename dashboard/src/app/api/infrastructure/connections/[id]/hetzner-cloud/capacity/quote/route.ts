export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";

import { apiError, apiSuccess } from "@/lib/api-response";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { InfrastructureConnectionStoreError } from "@/lib/infrastructure/connection-store";
import { HetznerCloudCapacityQuoteRequestSchema } from "@/lib/infrastructure/contracts";
import {
  HetznerCloudCapacityError,
  quoteHetznerCloudCapacity,
} from "@/lib/infrastructure/hetzner-cloud";
import {
  hasStrictJsonContentType,
  isSameOriginMutationRequest,
  MAX_CAPACITY_REQUEST_BODY_BYTES,
  readBoundedJson,
} from "../../../../request-security";

const ConnectionIdSchema = z.string().uuid();
type RouteContext = { params: Promise<{ id: string }> };

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  return response;
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
      return noStore(apiError("The connection changed. Refresh and request a new quote.", 409));
    }
  }
  if (error instanceof HetznerCloudCapacityError) {
    const status = error.code === "provider_rate_limited"
      || error.code === "quote_rate_limited"
      ? 429
      : error.code === "provider_unavailable" || error.code === "provider_maintenance"
        ? 503
        : error.code === "provider_response_invalid"
          ? 502
          : error.code === "invalid_credentials"
              || error.code === "token_read_only"
              || error.code === "credential_reconnect_required"
            ? 422
            : 409;
    const message = error.code === "quote_rate_limited"
      ? "You already have five active capacity quotes. Wait for one to expire before requesting another."
      : error.code === "credential_reconnect_required"
      ? "Disconnect and reconnect this Hetzner project before using in-app capacity creation."
      : error.code === "token_read_only"
      ? "Reconnect this project with a Hetzner Cloud Read & Write token."
      : error.code === "selection_invalid"
        ? "That server type, location, or image is not available in Canary simple mode."
        : "A safe Hetzner Cloud capacity quote could not be created.";
    return noStore(apiError(message, status, undefined, { code: error.code }));
  }
  return noStore(apiError("A safe Hetzner Cloud capacity quote could not be created.", 500));
}

export async function POST(request: NextRequest, context: RouteContext) {
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
      routeKey: "hetzner_cloud_capacity_quote",
      userId,
      limit: 10,
      windowMs: 60_000,
    });
    if (rateLimitError) return noStore(rateLimitError);
    const id = ConnectionIdSchema.safeParse((await context.params).id);
    if (!id.success) return noStore(apiError("Infrastructure connection not found.", 404));
    const boundedBody = await readBoundedJson(
      request,
      MAX_CAPACITY_REQUEST_BODY_BYTES,
    );
    if (!boundedBody.ok) {
      if (boundedBody.reason === "too_large") {
        return noStore(apiError("Capacity quote request is too large.", 413));
      }
      return noStore(apiError("Invalid JSON request body.", 400));
    }
    const parsed = HetznerCloudCapacityQuoteRequestSchema.safeParse(boundedBody.body);
    if (!parsed.success) return noStore(apiError("Invalid capacity quote request.", 400));
    const quote = await quoteHetznerCloudCapacity(userId, id.data, parsed.data);
    return noStore(apiSuccess({ quote }, 201));
  } catch (error) {
    return failure(error);
  }
}
