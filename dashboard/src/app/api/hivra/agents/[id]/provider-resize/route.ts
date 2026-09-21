// Owner-only review and reconciliation for one allocated Hetzner computer.
// The POST never accepts raw resources: it either saves a fresh live quote or
// confirms the exact saved quote and one durable operation identity.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 60;

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import {
  hasStrictJsonContentType,
  isSameOriginMutationRequest,
  readBoundedJson,
} from "@/app/api/infrastructure/connections/request-security";
import { apiError, apiSuccess } from "@/lib/api-response";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { isHivraApiAllowed } from "@/lib/hivra/hivra-flag";
import {
  ProviderResizeMutationRequestSchema,
} from "@/lib/hivra/provider-agent-resize-contract";
import {
  applyProviderResize,
  getProviderResizeView,
  ProviderAgentResizeError,
  quoteProviderResize,
  type ProviderResizeErrorCode,
} from "@/lib/hivra/provider-agent-resize";
import { ProviderAgentResizeStoreError } from "@/lib/hivra/provider-agent-resize-store";

const BODY_LIMIT = 2_048;
const AgentId = z.string().uuid();

const problems: Record<ProviderResizeErrorCode, { status: number; message: string }> = {
  not_found: { status: 404, message: "Computer not found." },
  not_supported: { status: 409, message: "This computer does not have a verified Hetzner resize capability." },
  computer_busy: { status: 409, message: "This computer already has an operation in progress. Check that operation before resizing." },
  computer_must_be_stopped: { status: 409, message: "Stop this computer first. Hetzner requires it to stay powered off during this resize." },
  selection_invalid: { status: 400, message: "Choose a compatible server type from the fresh Hetzner list." },
  quote_expired: { status: 409, message: "That price review expired. Refresh Hetzner pricing before resizing." },
  quote_changed: { status: 409, message: "Hetzner pricing, availability, or server state changed. Review a fresh resize quote." },
  operation_conflict: { status: 409, message: "The saved resize no longer matches this computer. Refresh before taking another action." },
  provider_unavailable: { status: 503, message: "Hetzner could not be checked. The original computer and any saved operation are unchanged." },
  provider_response_invalid: { status: 502, message: "Hetzner returned an unverified resize response. No replacement request was sent." },
  operation_unverified: { status: 503, message: "The original resize is saved but its result is not verified. Check this operation instead of starting another resize." },
};

function noStore<T extends Response>(response: T): T {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function failure(cause: unknown): Response {
  const code: ProviderResizeErrorCode = cause instanceof ProviderAgentResizeError
    ? cause.code
    : cause instanceof ProviderAgentResizeStoreError && cause.code === "not_found"
      ? "not_found"
      : "operation_unverified";
  const problem = problems[code];
  return noStore(apiError(problem.message, problem.status, undefined, { code }, {
    source: "hivra/agents/provider-resize",
    failureType: code,
    cause,
  }));
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!isHivraApiAllowed(request.headers.get("host"))) return noStore(apiError("Not found", 404));
    const { userId } = await auth();
    if (!userId) return noStore(apiError("Unauthorized", 401));
    const { id: rawId } = await params;
    const parsedId = AgentId.safeParse(rawId);
    if (!parsedId.success) return noStore(apiError("Computer not found.", 404));
    const limited = enforceAuthenticatedRouteRateLimit(request, {
      routeKey: "hivra_provider_resize_read", userId, limit: 120, windowMs: 5 * 60_000,
    });
    if (limited) return noStore(limited);
    return noStore(apiSuccess(await getProviderResizeView(userId, parsedId.data)));
  } catch (cause) {
    return failure(cause);
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!isHivraApiAllowed(request.headers.get("host"))) return noStore(apiError("Not found", 404));
    const { userId } = await auth();
    if (!userId) return noStore(apiError("Unauthorized", 401));
    if (request.nextUrl.search || !isSameOriginMutationRequest(request)) {
      return noStore(apiError("Open this computer in Hivra to review its resize.", 403));
    }
    if (!hasStrictJsonContentType(request) || request.headers.has("content-encoding")) {
      return noStore(apiError("Send the resize request as JSON.", 415));
    }
    const body = await readBoundedJson(request, BODY_LIMIT, 5_000);
    if (!body.ok) {
      return noStore(apiError("Send one complete resize request of at most 2 KB.",
        body.reason === "too_large" ? 413 : body.reason === "timeout" ? 408 : 400));
    }
    const parsed = ProviderResizeMutationRequestSchema.safeParse(body.body);
    if (!parsed.success) return noStore(apiError("Review a server type or confirm the exact saved quote.", 400));
    const { id: rawId } = await params;
    const parsedId = AgentId.safeParse(rawId);
    if (!parsedId.success) return noStore(apiError("Computer not found.", 404));
    const limited = enforceAuthenticatedRouteRateLimit(request, {
      routeKey: parsed.data.mode === "quote" ? "hivra_provider_resize_quote" : "hivra_provider_resize_apply",
      userId,
      limit: parsed.data.mode === "quote" ? 20 : 10,
      windowMs: parsed.data.mode === "quote" ? 5 * 60_000 : 10 * 60_000,
    });
    if (limited) return noStore(limited);
    if (parsed.data.mode === "quote") {
      const { operationId, targetServerType } = parsed.data;
      const quote = await quoteProviderResize({
        userId,
        agentId: parsedId.data,
        operationId,
        targetServerType,
      });
      return noStore(apiSuccess({ quote }));
    }
    const { operationId, quoteFingerprint, billingConfirmation } = parsed.data;
    const operation = await applyProviderResize({
      userId,
      agentId: parsedId.data,
      operationId,
      quoteFingerprint,
      billingConfirmation,
    });
    const terminal = ["succeeded", "failed", "cancelled", "removed"].includes(operation.stage);
    return noStore(apiSuccess({ operation }, terminal ? 200 : 202));
  } catch (cause) {
    return failure(cause);
  }
}
