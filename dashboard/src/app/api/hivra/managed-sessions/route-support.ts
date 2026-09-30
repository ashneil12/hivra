import type { NextRequest } from "next/server";

import { apiError } from "@/lib/api-response";
import { hasStrictJsonContentType, isSameOriginMutationRequest, readBoundedJson } from "@/app/api/infrastructure/connections/request-security";
import { ManagedSessionError, type ManagedSessionErrorCode } from "@/lib/hivra/do-managed-sessions";
import { isHivraApiAllowed } from "@/lib/hivra/hivra-flag";

const STATUS: Record<ManagedSessionErrorCode, number> = {
  not_found: 404,
  invalid_request: 400,
  not_ready: 409,
  session_paused: 409,
  connection_changed: 409,
  conflict: 409,
  invalid_credentials: 422,
  provider_forbidden: 422,
  payment_required: 402,
  model_key_rejected: 422,
  provider_rejected: 422,
  provider_unavailable: 502,
  database_failed: 500,
};

/** Hivra agent APIs are canary-only (see isHivraApiAllowed); so are these. */
export function hivraApiUnavailable(request: Request): Response | null {
  return isHivraApiAllowed(request.headers.get("host")) ? null : noStore(apiError("Not found", 404));
}

export function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export function managedSessionFailure(error: unknown, route: string): Response {
  if (error instanceof ManagedSessionError) {
    return noStore(apiError(error.message, STATUS[error.code], undefined, {
      code: error.code,
      ...(error.agentId ? { agentId: error.agentId } : {}),
    }));
  }
  return noStore(apiError("The DigitalOcean request could not be completed.", 500, {
    failureType: "managed_session_route_failed",
    errorName: error instanceof Error ? error.name : typeof error,
  }, undefined, { source: "hivra/managed-sessions", route, failureType: "managed_session_route_failed", cause: error }));
}

/** Same-origin JSON mutation with a bounded body; returns the parsed body or a response. */
export async function readMutationBody(request: NextRequest, maxBytes: number): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  if (request.nextUrl.search || !isSameOriginMutationRequest(request)) {
    return { ok: false, response: noStore(apiError("Open this agent from Hivra.", 403)) };
  }
  if (!hasStrictJsonContentType(request)) {
    return { ok: false, response: noStore(apiError("Content-Type must be application/json.", 415)) };
  }
  const body = await readBoundedJson(request, maxBytes, 5_000);
  if (!body.ok) {
    return { ok: false, response: noStore(apiError(body.reason === "too_large" ? "The request is too large." : "Invalid JSON request body.", body.reason === "too_large" ? 413 : 400)) };
  }
  return { ok: true, body: body.body };
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
