// Wake a sleeping agent. The owner's agent page calls this when it opens a
// computer that is napping or hibernated, and the chat calls it again if a
// send fails. It waits up to 45 seconds for the wake: 200 when the agent is up,
// 202 while it is still waking (ask again), 409 when the computer is switched off
// (it has to be started, not woken), and an error when it cannot be woken.

export const runtime = "nodejs";
// The invocation also covers the hibernate slot wait, restore and health check in after().
export const maxDuration = 350;

import { after, type NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { isSameOriginMutationRequest } from "@/app/api/infrastructure/connections/request-security";
import { supabaseAdmin } from "@/lib/supabase";
import { apiSuccess, apiError, handleApiError } from "@/lib/api-response";
import { ensureHivraAgentAwake, MANAGED_WAKE_WORK_BUDGET_MS } from "@/lib/hivra/agent-wake";
import { HOSTED_COMPUTE_REQUIRES_PLAN_MESSAGE } from "@/lib/billing/hosted-compute";
import { allowsOwnerChatPrewake } from "@/lib/hivra/owner-chat-prewake";

const WAKE_WAIT_MS = 45_000;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const workDeadlineMs = Date.now() + MANAGED_WAKE_WORK_BUDGET_MS;
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

    const source = (await req.json().catch(() => null))?.source;
    // Owner scope first: ensureHivraAgentAwake reads by id alone.
    const { data: agent, error } = await supabaseAdmin
      .from("hivra_agents")
      .select("id,status,deployment_mode,computer_substrate,seat_funding,sleep_stored_at,type")
      .eq("id", id)
      .eq("user_id", userId)
      .maybeSingle();
    if (error && !["PGRST116", "22P02"].includes(error.code)) {
      return apiError("Could not load this computer.", 503);
    }
    if (!agent) return apiError("Agent not found", 404);

    if (source === "chat-typing" && !allowsOwnerChatPrewake(agent)) return apiError("Typing wake is unavailable for this computer.", 403);
    const result = await ensureHivraAgentAwake(String(agent.id), {
      trigger: source === "chat" || source === "chat-typing" ? "action" : "open",
      portableOwnerId: userId,
      waitMs: WAKE_WAIT_MS,
      workDeadlineMs,
      onBackground: (work) => after(() => work),
    });

    if (result.state === "cold") {
      // The computer is off with nothing saved, so there is nothing to wake. Saying "awake"
      // here would send the page to a tunnel that is down; the normal Start action owns this.
      return apiError("Your computer is switched off. Start it from its power controls.", 409, undefined, {
        code: "not_running",
        state: "cold",
      });
    }
    if (result.state === "awake") {
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
