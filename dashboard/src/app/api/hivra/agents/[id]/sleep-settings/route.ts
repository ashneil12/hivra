// The owner's two sleep settings for one agent: "Sleep when idle" (sleep_policy
// full or off) and "Keep awake" (always_on). Nothing here puts an agent to sleep.
// Opting out of sleep (Keep awake on, or Sleep when idle off) does wake an agent
// that is asleep right now: the sweep leaves an opted-out agent alone, so nothing
// else would, and its channels and scheduled jobs would stay stopped.

export const runtime = "nodejs";
// Turning a sleeping agent's settings off wakes it, and that work runs after the answer.
export const maxDuration = 180;

import { after, type NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { isSameOriginMutationRequest } from "@/app/api/infrastructure/connections/request-security";
import { supabaseAdmin } from "@/lib/supabase";
import { apiSuccess, apiError, handleApiError } from "@/lib/api-response";
import { ensureHivraAgentAwake } from "@/lib/hivra/agent-wake";
import { parseSleepMode } from "@/lib/hivra/agent-sleep-policy";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    if (!supabaseAdmin) return apiError("Database not configured", 500);
    if (!isSameOriginMutationRequest(req)) return apiError("Same-origin request required.", 403);
    const limited = enforceAuthenticatedRouteRateLimit(req, {
      routeKey: "hivra_agent_sleep_settings",
      userId,
      limit: 30,
      windowMs: 5 * 60_000,
    });
    if (limited) return limited;

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) return apiError("Send the settings to change.", 400);

    const patch: { always_on?: boolean; sleep_policy?: "off" | "full" } = {};
    if ("always_on" in body) {
      if (typeof body.always_on !== "boolean") return apiError("Keep awake must be on or off.", 400);
      patch.always_on = body.always_on;
    }
    if ("sleep_policy" in body) {
      if (body.sleep_policy !== "off" && body.sleep_policy !== "full") return apiError("Sleep when idle must be on or off.", 400);
      patch.sleep_policy = body.sleep_policy;
    }
    if (Object.keys(patch).length === 0) return apiError("Send the settings to change.", 400);

    const { data, error } = await supabaseAdmin
      .from("hivra_agents")
      .update(patch)
      .eq("id", id)
      .eq("user_id", userId)
      .select("id, always_on, sleep_policy")
      .maybeSingle();
    if (error) {
      if (["PGRST116", "22P02"].includes(error.code)) return apiError("Agent not found", 404);
      return apiError("Could not save this setting.", 503);
    }
    if (!data) return apiError("Agent not found", 404);
    // In `on` mode the policy column does not decide who sleeps (every agent that is not kept
    // awake does), so turning "Sleep when idle" off there would only wake an agent the next
    // sweep puts back to sleep. Keep awake always counts.
    const policyOptsOut = data.sleep_policy === "off" && parseSleepMode(process.env.HIVRA_SLEEP_MODE) !== "on";
    if (data.always_on === true || policyOptsOut) {
      // A no-op for an awake agent (one read). The wake itself carries on after the answer.
      try {
        await ensureHivraAgentAwake(String(data.id), {
          trigger: "action",
          waitMs: 0,
          onBackground: (work) => after(() => work),
        });
      } catch {
        // The setting is saved; the agent wakes on its next use.
      }
    }
    const response = apiSuccess({ always_on: data.always_on, sleep_policy: data.sleep_policy });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    return handleApiError(error);
  }
}
