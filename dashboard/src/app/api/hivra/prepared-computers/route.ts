export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { apiError, apiSuccess, handleApiError } from "@/lib/api-response";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { hasStrictJsonContentType, isSameOriginMutationRequest, readBoundedJson } from "@/app/api/infrastructure/connections/request-security";
import { sanitizeHivraAgentRow } from "@/lib/hivra/agent-llm";
import { isHivraApiAllowed } from "@/lib/hivra/hivra-flag";
import { claimPreparedCanaryComputer } from "@/lib/hivra/prepared-canary-computers";

const Body = z.object({ profile: z.literal("omarchy"), name: z.string().trim().min(1).max(80) }).strict();

export async function POST(request: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    if (!isHivraApiAllowed(request.headers.get("host"))) return apiError("Not found", 404);
    if (request.nextUrl.search || !isSameOriginMutationRequest(request)) return apiError("Request denied", 403);
    if (!hasStrictJsonContentType(request) || request.headers.has("content-encoding")) return apiError("JSON required", 415);
    const limited = enforceAuthenticatedRouteRateLimit(request, {
      routeKey: "prepared_computer_claim", userId, limit: 4, windowMs: 15 * 60_000,
    });
    if (limited) return limited;
    const body = await readBoundedJson(request, 1_024, 5_000);
    if (!body.ok) return apiError("Invalid request", body.reason === "too_large" ? 413 : 400);
    const parsed = Body.safeParse(body.body);
    if (!parsed.success) return apiError("Invalid request", 400);
    try {
      const agent = await claimPreparedCanaryComputer({ userId, ...parsed.data });
      return apiSuccess({ agent: sanitizeHivraAgentRow(agent) }, 201);
    } catch (error) {
      const code = error instanceof Error ? error.message : "prepared_guest_unavailable";
      if (["profile_already_claimed", "prepared_slot_claimed"].includes(code)) {
        return apiError("This prepared Canary computer is already claimed.", 409, undefined, { code });
      }
      if (code === "prepared_profile_unavailable") {
        return apiError("This prepared computer is not configured on Canary.", 503, undefined, { code });
      }
      return apiError("The prepared computer could not be verified and was not claimed.", 503, undefined, { code });
    }
  } catch (error) {
    return handleApiError(error);
  }
}
