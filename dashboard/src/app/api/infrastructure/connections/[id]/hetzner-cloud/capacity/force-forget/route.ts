export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";

import { apiError, apiSuccess } from "@/lib/api-response";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import {
  forceForgetHetznerCloudConnection,
  InfrastructureConnectionStoreError,
} from "@/lib/infrastructure/connection-store";
import { HetznerCloudForceForgetRequestSchema } from "@/lib/infrastructure/contracts";
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
    if (error.code === "capacity_busy") {
      return noStore(apiError(
        "A provider mutation is still pending or creating. Reconcile it before forgetting this connection.",
        409,
        undefined,
        { code: "capacity_busy" },
      ));
    }
    if (error.code === "force_forget_not_available") {
      return noStore(apiError(
        "Force-forget is available only for an idle ambiguous Hetzner capacity operation.",
        409,
        undefined,
        { code: "force_forget_not_available" },
      ));
    }
  }
  return noStore(apiError("The Hetzner connection could not be forgotten safely.", 500));
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
      routeKey: "hetzner_cloud_capacity_force_forget",
      userId,
      limit: 2,
      windowMs: 10 * 60_000,
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
        return noStore(apiError("Force-forget request is too large.", 413));
      }
      return noStore(apiError("Invalid JSON request body.", 400));
    }
    const parsed = HetznerCloudForceForgetRequestSchema.safeParse(boundedBody.body);
    if (!parsed.success) {
      return noStore(apiError("Type the exact force-forget confirmation.", 400));
    }
    await forceForgetHetznerCloudConnection(userId, id.data);
    return noStore(apiSuccess({
      connectionDeleted: true as const,
      localCredentialsWiped: true as const,
      providerCleanupPerformed: false as const,
      canarySlotHeld: true as const,
    }));
  } catch (error) {
    return failure(error);
  }
}
