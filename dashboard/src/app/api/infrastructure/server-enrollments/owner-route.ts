import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { apiError } from "@/lib/api-response";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { InfrastructureConnectionStoreError } from "@/lib/infrastructure/connection-store";
import { ServerEnrollmentError, type ServerEnrollmentErrorCode } from "@/lib/infrastructure/server-enrollment-service";
import { ServerEnrollmentStoreError } from "@/lib/infrastructure/server-enrollment-store";
import {
  hasStrictJsonContentType,
  isSameOriginMutationRequest,
  readBoundedJson,
} from "../connections/request-security";

export function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

/** The signed-in owner, or the refusal to send. Every mutation is a
 * same-origin, strict-JSON request from this dashboard. */
export async function ownerRequest(
  request: NextRequest,
  options: { routeKey: string; limit: number; mutation: boolean },
): Promise<{ userId: string; body: unknown } | { response: Response }> {
  const { userId } = await auth();
  if (!userId) return { response: noStore(apiError("Unauthorized", 401)) };
  if (options.mutation) {
    if (request.nextUrl.search || !isSameOriginMutationRequest(request)) {
      return { response: noStore(apiError("Same-origin request required.", 403)) };
    }
    if (!hasStrictJsonContentType(request)) {
      return { response: noStore(apiError("Content-Type must be application/json.", 415)) };
    }
  }
  const limited = enforceAuthenticatedRouteRateLimit(request, {
    routeKey: options.routeKey, userId, limit: options.limit, windowMs: 60_000,
  });
  if (limited) return { response: noStore(limited) };
  if (!options.mutation) return { userId, body: undefined };
  const body = await readBoundedJson(request, 1_024);
  if (!body.ok) {
    return { response: noStore(apiError(body.reason === "too_large" ? "Request is too large." : "Invalid JSON request body.",
      body.reason === "too_large" ? 413 : 400)) };
  }
  return { userId, body: body.body };
}

const COPY: Record<ServerEnrollmentErrorCode, { status: number; message: string }> = {
  unavailable: { status: 503, message: "Setup commands aren't available on this deployment." },
  active_limit: { status: 409, message: "You already have 3 setup commands waiting. Cancel one, or wait for it to expire." },
  daily_limit: { status: 429, message: "You've made 30 setup commands in the last day, which is Hivra's limit. Try again tomorrow." },
  not_found: { status: 404, message: "Setup command not found." },
  not_pending: { status: 409, message: "This setup command isn't waiting for an answer any more." },
  known_identity: { status: 409, message: "This server is already connected, so Hivra won't connect it twice. Replace its access instead." },
  address_required: { status: 422, message: "Hivra couldn't see this server's address. Enter it to continue." },
  address_invalid: { status: 422, message: "Enter a hostname or IPv4 address, without a URL or port." },
  address_blocked: { status: 422, message: "Hivra can't connect to that address." },
  replace_not_offered: { status: 409, message: "Hivra can't replace this server's access." },
  busy: { status: 409, message: "Hivra is already checking this server. Wait a moment, then try again." },
  attempts_exhausted: { status: 429, message: "Hivra has tried to replace this server's access 5 times. Run a new setup command to try again." },
  connection_changed: { status: 409, message: "This connection changed while you were deciding. Refresh, then try again." },
  operation_running: { status: 409, message: "An agent operation is running on this server. Try again in a few minutes." },
  agents_bound: { status: 409, message: "Agents use this connection, so Hivra won't change it." },
  verification_failed: { status: 422, message: "The server didn't accept the new key, so Hivra changed nothing." },
};

export function serverEnrollmentFailure(error: unknown, route: string, method: string): Response {
  if (error instanceof ServerEnrollmentError) {
    const copy = COPY[error.code];
    return noStore(apiError(copy.message, copy.status, undefined, {
      code: error.code, ...(error.failure ? { cause: error.failure } : {}),
    }));
  }
  if (error instanceof InfrastructureConnectionStoreError && error.code === "not_found") {
    return noStore(apiError("Infrastructure connection not found.", 404));
  }
  const storeFailure = error instanceof ServerEnrollmentStoreError || error instanceof InfrastructureConnectionStoreError;
  return noStore(apiError("The setup command request failed.", 500, {
    failureType: storeFailure ? "server_enrollment_store_failed" : "server_enrollment_unexpected_error",
    errorName: error instanceof Error ? error.name : typeof error,
  }, undefined, {
    source: "infrastructure/server-enrollments", route, method,
    failureType: storeFailure ? "server_enrollment_store_failed" : "server_enrollment_unexpected_error",
    cause: error,
  }));
}
