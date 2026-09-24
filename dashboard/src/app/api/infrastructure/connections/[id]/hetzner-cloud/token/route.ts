export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
// Two provider lists, the write check (add + remove one key), one database
// swap and one inventory write, each bounded by the 15-second client timeout.
export const maxDuration = 60;

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";

import { apiError, apiSuccess } from "@/lib/api-response";
import {
  enforceAuthenticatedRouteRateLimit,
  RATE_LIMIT_PRESETS,
} from "@/lib/authenticated-rate-limit";
import { InfrastructureConnectionStoreError } from "@/lib/infrastructure/connection-store";
import {
  HetznerCloudConnectionError,
  HetznerCloudTokenCheckError,
  HetznerCloudTokenReplaceError,
  replaceHetznerCloudToken,
} from "@/lib/infrastructure/hetzner-cloud";
import { HetznerCloudTokenReplaceRequestSchema } from "@/lib/infrastructure/hetzner-cloud-token-contracts";
import {
  hasStrictJsonContentType,
  isSameOriginMutationRequest,
  MAX_CAPACITY_REQUEST_BODY_BYTES,
  readBoundedJson,
} from "../../../request-security";

type RouteContext = { params: Promise<{ id: string }> };

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function failure(error: unknown): Response {
  if (error instanceof HetznerCloudTokenCheckError) {
    return noStore(apiError(error.message, 422, undefined, { code: error.code }));
  }
  if (error instanceof HetznerCloudTokenReplaceError) {
    // replaced_unconfirmed: the swap happened; the message says so.
    return noStore(apiError(error.message, 409, undefined, { code: error.code }));
  }
  if (error instanceof HetznerCloudConnectionError) {
    if (error.code === "invalid_credentials") {
      return noStore(apiError("Hetzner rejected this token. Check that you copied the whole token.", 422, undefined, { code: error.code }));
    }
    return noStore(apiError("Hetzner could not be reached to check this token. Try again shortly.", 502, undefined, { code: error.code }));
  }
  if (error instanceof InfrastructureConnectionStoreError) {
    if (error.code === "not_found") return noStore(apiError("Infrastructure connection not found.", 404));
    if (error.code === "invalid_request") return noStore(apiError("This is not a Hetzner Cloud connection.", 422));
    if (error.code === "conflict") {
      return noStore(apiError("This connection changed while the token was checked. Nothing was replaced; try again.", 409, undefined, { code: "connection_changed" }));
    }
    if (error.code === "credential_error") {
      return noStore(apiError("This connection has no stored token to replace. Disconnect it and connect the project again.", 422, undefined, { code: "credential_error" }));
    }
  }
  return noStore(apiError(
    "Hetzner token replacement failed.",
    500,
    { failureType: "hetzner_cloud_token_replace_failed", errorName: error instanceof Error ? error.name : typeof error },
    undefined,
    {
      source: "infrastructure/hetzner-cloud/token",
      route: "/api/infrastructure/connections/[id]/hetzner-cloud/token",
      method: "POST",
      failureType: "hetzner_cloud_token_replace_failed",
      cause: error,
    },
  ));
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { userId } = await auth();
    if (!userId) return noStore(apiError("Unauthorized", 401));
    if (!isSameOriginMutationRequest(request)) return noStore(apiError("Same-origin request required.", 403));
    if (!hasStrictJsonContentType(request)) return noStore(apiError("Content-Type must be application/json.", 415));
    const rateLimit = enforceAuthenticatedRouteRateLimit(request, {
      routeKey: "hetzner_cloud_token_replace",
      userId,
      ...RATE_LIMIT_PRESETS.secretWrite,
    });
    if (rateLimit) return noStore(rateLimit);
    const id = z.string().uuid().safeParse((await context.params).id);
    if (!id.success) return noStore(apiError("Infrastructure connection not found.", 404));
    const body = await readBoundedJson(request, MAX_CAPACITY_REQUEST_BODY_BYTES);
    if (!body.ok) {
      return noStore(apiError(body.reason === "too_large" ? "Token request is too large." : "Invalid JSON request body.", body.reason === "too_large" ? 413 : 400));
    }
    const parsed = HetznerCloudTokenReplaceRequestSchema.safeParse(body.body);
    if (!parsed.success) {
      return noStore(apiError(parsed.error.issues[0]?.message ?? "Paste a Hetzner Read & Write token.", 400));
    }
    return noStore(apiSuccess(await replaceHetznerCloudToken({
      userId,
      connectionId: id.data.toLowerCase(),
      apiToken: parsed.data.apiToken,
    })));
  } catch (error) {
    return failure(error);
  }
}
