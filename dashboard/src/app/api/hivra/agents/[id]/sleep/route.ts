// Manual sleep, for testing a computer's nap and hibernate by hand. Owner only,
// and only where the sleep screens are switched on (NEXT_PUBLIC_HIVRA_AGENT_SLEEP=1)
// and the server's sleep mode (HIVRA_SLEEP_MODE) is not off. The same eligibility
// and idle checks as the automatic sweep apply, except that the open page's own
// connections do not count as use.

export const runtime = "nodejs";
export const maxDuration = 300;

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { isSameOriginMutationRequest } from "@/app/api/infrastructure/connections/request-security";
import { supabaseAdmin } from "@/lib/supabase";
import { apiSuccess, apiError, handleApiError } from "@/lib/api-response";
import { parseSleepMode } from "@/lib/hivra/agent-sleep-policy";
import { sleepHivraAgent } from "@/lib/hivra/agent-sleep";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    if (!supabaseAdmin) return apiError("Database not configured", 500);
    if (process.env.NEXT_PUBLIC_HIVRA_AGENT_SLEEP !== "1" || parseSleepMode(process.env.HIVRA_SLEEP_MODE) === "off") {
      return apiError("Sleep is not available yet.", 404);
    }
    if (!isSameOriginMutationRequest(req)) return apiError("Same-origin request required.", 403);
    const limited = enforceAuthenticatedRouteRateLimit(req, {
      routeKey: "hivra_agent_sleep",
      userId,
      limit: 12,
      windowMs: 10 * 60_000,
    });
    if (limited) return limited;

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const tier = body.tier;
    if (tier !== "nap" && tier !== "hibernate") return apiError("Choose nap or hibernate.", 400);

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

    const outcome = await sleepHivraAgent(String(agent.id), { tier, trigger: "manual", manual: true });
    if (outcome.outcome === "failed") {
      return apiError("Your agent could not be put to sleep. It was left as it was.", 502, undefined, {
        outcome: outcome.outcome,
        reason: outcome.reason ?? "failed",
        ...(outcome.state ? { state: outcome.state } : {}),
      });
    }
    const response = apiSuccess({
      outcome: outcome.outcome,
      ...(outcome.state ? { state: outcome.state } : {}),
      ...(outcome.reason ? { reason: outcome.reason } : {}),
      ...(outcome.reasons ? { reasons: outcome.reasons } : {}),
    });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    return handleApiError(error);
  }
}
