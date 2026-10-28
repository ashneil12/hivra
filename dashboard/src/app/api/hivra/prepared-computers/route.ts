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
import { HOSTED_COMPUTE_REQUIRES_PLAN_MESSAGE } from "@/lib/billing/hosted-compute";
import { claimPreparedCanaryComputer } from "@/lib/hivra/prepared-canary-computers";
import { log } from "@/lib/logger";

const Body = z.object({ profile: z.literal("omarchy"), name: z.string().trim().min(1).max(80) }).strict();

// The claim throws snake_case codes the client may see. Anything else is internal text (database or
// host detail): it is logged server-side and replaced with the fallback code.
const CLAIM_CODE_PATTERN = /^[a-z][a-z_]{2,63}$/;
const FALLBACK_CLAIM_CODE = "prepared_guest_unavailable";

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
      const raw = error instanceof Error ? error.message : FALLBACK_CLAIM_CODE;
      const code = CLAIM_CODE_PATTERN.test(raw) ? raw : FALLBACK_CLAIM_CODE;
      if (code !== raw) {
        log.error("prepared computer claim failed", error, { source: "prepared-computers", userId, verboseErrors: true });
      }
      if (["profile_already_claimed", "prepared_slot_claimed"].includes(code)) {
        return apiError("This prepared computer is already claimed.", 409, undefined, { code });
      }
      if (code === "plan_agent_limit" || code === "plan_access_required") {
        return apiError(code === "plan_agent_limit"
          ? "Your plan's agent limit is reached. Upgrade for more slots, or remove an agent first."
          : "Plan access is required before claiming a computer.", 403, undefined, { code });
      }
      if (code === "hosted_compute_requires_plan") {
        return apiError(HOSTED_COMPUTE_REQUIRES_PLAN_MESSAGE, 403, undefined, { code });
      }
      if (code === "prepared_profile_unavailable") {
        return apiError("This prepared computer is not configured on this site.", 503, undefined, { code });
      }
      return apiError("The prepared computer could not be verified and was not claimed.", 503, undefined, { code });
    }
  } catch (error) {
    return handleApiError(error);
  }
}
