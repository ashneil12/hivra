import type { NextRequest } from "next/server";

import { apiError } from "@/lib/api-response";
import { RATE_LIMIT_PRESETS, enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { BuzzCoordinatorError } from "@/lib/hivra/buzz-coordinator";
import {
  hasStrictJsonContentType,
  isSameOriginMutationRequest,
  readBoundedJson,
} from "@/app/api/infrastructure/connections/request-security";

export const MAX_BUZZ_BODY_BYTES = 4_096;
export const MAX_BUZZ_RUNTIME_BODY_BYTES = 12_288;

export function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function readBuzzMutation(
  request: NextRequest,
  userId: string,
  routeKey: string,
  maxBodyBytes = MAX_BUZZ_BODY_BYTES,
): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  if (!isSameOriginMutationRequest(request)) {
    return { ok: false, response: noStore(apiError("Same-origin request required.", 403)) };
  }
  if (!hasStrictJsonContentType(request)) {
    return { ok: false, response: noStore(apiError("Content-Type must be application/json.", 415)) };
  }
  const limited = enforceAuthenticatedRouteRateLimit(request, {
    routeKey,
    userId,
    ...RATE_LIMIT_PRESETS.secretWrite,
  });
  if (limited) return { ok: false, response: noStore(limited) };
  const result = await readBoundedJson(request, maxBodyBytes, 5_000);
  if (!result.ok) {
    const status = result.reason === "too_large" ? 413 : result.reason === "timeout" ? 408 : 400;
    const message = result.reason === "too_large" ? "Buzz request is too large."
      : result.reason === "timeout" ? "Buzz request timed out." : "Invalid JSON request body.";
    return { ok: false, response: noStore(apiError(message, status)) };
  }
  return { ok: true, body: result.body };
}

export function buzzFailure(error: unknown): Response {
  if (error instanceof BuzzCoordinatorError) {
    const status = error.code === "invalid_request" || error.code === "invalid_relay" ? 400
      : error.code === "not_found" ? 404
      : error.code === "already_bound" || error.code === "operation_conflict" ? 409
      : error.code === "relay_unavailable" ? 502
      : error.code === "storage_unavailable" || error.code === "configuration_unavailable" ? 503
      : error.code === "runtime_unsupported" ? 422
      : error.code === "runtime_unavailable" ? 502
      : error.code === "runtime_credential_unavailable" ? 422
      : error.code === "unsafe_relay" || error.code === "relay_incompatible" ? 422
      : error.code.startsWith("invite_") || error.code === "invalid_invite"
        || error.code === "join_policy_required" ? 422 : 502;
    return noStore(apiError(error.message, status, { failureType: `buzz_${error.code}` }, undefined, {
      source: "hivra/buzz",
      failureType: `buzz_${error.code}`,
      cause: error,
    }));
  }
  return noStore(apiError("Buzz connection is temporarily unavailable.", 500, {
    failureType: "buzz_unexpected_failure",
    errorName: error instanceof Error ? error.name : typeof error,
  }, undefined, {
    source: "hivra/buzz",
    failureType: "buzz_unexpected_failure",
    cause: error,
  }));
}
