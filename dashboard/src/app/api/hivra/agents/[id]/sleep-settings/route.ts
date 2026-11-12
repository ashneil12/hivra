// The owner's two sleep settings for one agent: "Sleep when idle" (sleep_policy
// full or off) and "Keep awake" (always_on). Nothing here puts an agent to sleep.

export const runtime = "nodejs";

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { isSameOriginMutationRequest } from "@/app/api/infrastructure/connections/request-security";
import { supabaseAdmin } from "@/lib/supabase";
import { apiSuccess, apiError, handleApiError } from "@/lib/api-response";

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
    const response = apiSuccess({ always_on: data.always_on, sleep_policy: data.sleep_policy });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    return handleApiError(error);
  }
}
