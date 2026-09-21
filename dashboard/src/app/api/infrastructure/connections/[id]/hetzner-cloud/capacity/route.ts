export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
// Provider POST (15s) plus one exact-name reconciliation GET (15s) and the
// final ledger write must finish before the 60-second database detach grace.
export const maxDuration = 45;

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";

import { apiError, apiSuccess } from "@/lib/api-response";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { InfrastructureConnectionStoreError } from "@/lib/infrastructure/connection-store";
import { PreparedCapacityCreateRequestSchema } from "@/lib/infrastructure/provider-computer-setup-contracts";
import { firstBootCallbackUrl } from "@/lib/infrastructure/first-boot-cloud-init";
import { isFirstBootCallbackReachable } from "@/lib/infrastructure/first-boot-callback-readiness";
import { hasDispatchedHetznerCapacityRequest } from "@/lib/infrastructure/hetzner-cloud-store";
import {
  createHetznerCloudCapacity,
  createPreparedHetznerCloudCapacity,
  HetznerCloudCapacityError,
} from "@/lib/infrastructure/hetzner-cloud";
import {
  hasStrictJsonContentType,
  isSameOriginMutationRequest,
  MAX_CAPACITY_REQUEST_BODY_BYTES,
  readBoundedJson,
} from "../../../request-security";

const ConnectionIdSchema = z.string().uuid();
type RouteContext = { params: Promise<{ id: string }> };

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function capacityMessage(code: string): string {
  switch (code) {
    case "token_read_only":
      return "Reconnect this project with a Hetzner Cloud Read & Write token.";
    case "quote_expired":
    case "quote_changed":
      return "This price quote is no longer current. Review a new quote before creating a server.";
    case "connection_changed":
      return "This connection changed. Review a new quote before creating a server.";
    case "idempotency_conflict":
      return "That submission key is already bound to a different capacity request.";
    case "canary_capacity_limit":
      return "Canary currently allows one non-rejected Hivra-created server per account.";
    case "credential_reconnect_required":
      return "Disconnect and reconnect this Hetzner project before using in-app capacity creation.";
    case "provider_resource_limit":
      return "Hetzner Cloud rejected the request because this project has reached a resource limit.";
    default:
      return "Hetzner Cloud capacity could not be created safely.";
  }
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
      return noStore(apiError("The capacity operation changed. Refresh before retrying.", 409));
    }
  }
  if (error instanceof HetznerCloudCapacityError) {
    const status = error.code === "provider_rate_limited"
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
    return noStore(apiError(
      capacityMessage(error.code),
      status,
      undefined,
      { code: error.code },
    ));
  }
  return noStore(apiError("Hetzner Cloud capacity could not be created safely.", 500));
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
      routeKey: "hetzner_cloud_capacity_request",
      userId,
      limit: 60,
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
        return noStore(apiError("Capacity creation request is too large.", 413));
      }
      return noStore(apiError("Invalid JSON request body.", 400));
    }
    const parsed = PreparedCapacityCreateRequestSchema.safeParse(boundedBody.body);
    if (!parsed.success) return noStore(apiError("Invalid capacity creation request.", 400));
    const { preparationConfirmation, ...capacityRequest } = parsed.data;
    // Status/recovery buttons reuse this endpoint. Only an owner-bound durable
    // server POST marker permits the reconciliation budget. The service's
    // immutable-marker branch cannot purchase another server, even if the
    // original POST is still running or its acknowledgement was lost.
    const dispatched = await hasDispatchedHetznerCapacityRequest(
      userId, id.data, capacityRequest.quoteId, capacityRequest.idempotencyKey,
    );
    const operationLimit = enforceAuthenticatedRouteRateLimit(request, dispatched
      ? { routeKey: "hetzner_cloud_capacity_reconcile", userId, limit: 30, windowMs: 60_000 }
      : { routeKey: "hetzner_cloud_capacity_create", userId, limit: 2, windowMs: 10 * 60_000 });
    if (operationLimit) return noStore(operationLimit);
    // Server-owned deployment configuration only. Never redirect a bootstrap
    // token to an origin chosen by the request, forwarded headers or browser.
    const originKey = "NEXT_PUBLIC_APP_URL";
    const callbackOrigin = process.env[originKey];
    if (preparationConfirmation && !callbackOrigin) {
      return noStore(apiError("This deployment needs its public HTTPS app URL configured before automatic computer setup.", 503));
    }
    if (preparationConfirmation) {
      try { firstBootCallbackUrl(callbackOrigin!); }
      catch { return noStore(apiError("Automatic setup requires a valid public HTTPS app origin in the deployment configuration.", 503)); }
      // Never strand reconciliation of an already-billable request behind a
      // new readiness check. This gate prevents only a new guided purchase.
      if (!dispatched && !await isFirstBootCallbackReachable(callbackOrigin!)) {
        return noStore(apiError(
          "This attempt did not request a new server. Automatic setup cannot reach this deployment's machine connection endpoint. The Hivra operator needs to check its public callback routing and deployment protection before you try again.",
          503, undefined, { code: "first_boot_callback_unreachable" },
        ));
      }
    }
    const result = preparationConfirmation
      ? await createPreparedHetznerCloudCapacity(userId, id.data, capacityRequest,
        { confirmation: preparationConfirmation, callbackOrigin: callbackOrigin! })
      : await createHetznerCloudCapacity(userId, id.data, capacityRequest);
    return noStore(apiSuccess(
      result,
      result.operation.status === "created_off" ? 201 : 202,
    ));
  } catch (error) {
    return failure(error);
  }
}
