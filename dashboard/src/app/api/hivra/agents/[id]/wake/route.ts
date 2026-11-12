// Wake a sleeping agent. The owner's agent page calls this when it opens a
// computer that is napping or hibernated, and the chat calls it again if a
// send fails. It waits up to 45 seconds for the wake: 200 when the agent is up,
// 202 while it is still waking (ask again), and an error when it cannot be woken.

export const runtime = "nodejs";
// The wake itself can take a restore (up to 120 s) plus the public health check (30 s), and
// the work that outlives the 45 s answer runs through after(), which the limit also covers.
export const maxDuration = 180;

import { after, type NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { isSameOriginMutationRequest } from "@/app/api/infrastructure/connections/request-security";
import { supabaseAdmin } from "@/lib/supabase";
import { apiSuccess, apiError, handleApiError } from "@/lib/api-response";
import { ensureHivraAgentAwake } from "@/lib/hivra/agent-wake";
import { HOSTED_COMPUTE_REQUIRES_PLAN_MESSAGE } from "@/lib/billing/hosted-compute";

const WAKE_WAIT_MS = 45_000;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    if (!supabaseAdmin) return apiError("Database not configured", 500);
    if (!isSameOriginMutationRequest(req)) return apiError("Same-origin request required.", 403);
    const limited = enforceAuthenticatedRouteRateLimit(req, {
      routeKey: "hivra_agent_wake",
      userId,
      limit: 30,
      windowMs: 5 * 60_000,
    });
    if (limited) return limited;

    // Owner scope first: ensureHivraAgentAwake reads by id alone.
    const { data: agent, error } = await supabaseAdmin
      .from("hivra_agents")
      .select("id")
      .eq("id", id)
      .eq("user_id", userId)
      .maybeSingle();
    if (error && !["PGRST116", "22P02"].includes(error.code)) {
      return apiError("Could not load this computer.", 503);
    }
    if (!agent) return apiError("Agent not found", 404);

    const result = await ensureHivraAgentAwake(String(agent.id), {
      trigger: "open",
      waitMs: WAKE_WAIT_MS,
      onBackground: (work) => after(() => work),
    });

    if (result.state === "awake" || result.state === "cold") {
      const response = apiSuccess({ state: result.state, ...(result.wakeMs !== undefined ? { wakeMs: result.wakeMs } : {}) });
      response.headers.set("Cache-Control", "no-store");
      return response;
    }
    if (result.state === "waking") {
      const response = apiSuccess({ state: "waking" }, 202);
      response.headers.set("Cache-Control", "no-store");
      return response;
    }
    if (result.reason === "lapsed") {
      return apiError(
        `${HOSTED_COMPUTE_REQUIRES_PLAN_MESSAGE} This computer's files are kept.`,
        402,
        undefined,
        { code: "instance_entitlement_suspended", state: "failed" },
      );
    }
    if (result.reason === "not_found") return apiError("Agent not found", 404);
    return apiError("Your agent could not be woken up. Try again in a moment.", 503, undefined, {
      state: "failed",
      reason: result.reason ?? "wake_failed",
    });
  } catch (error) {
    return handleApiError(error);
  }
}
