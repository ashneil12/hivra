import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { getUserAgentActivity } from "@/lib/billing/agent-activity";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function activitySuccess<T>(data: T) {
  const response = apiSuccess(data);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

/**
 * GET /api/billing/agent-activity?days=30
 *
 * Returns the signed-in user's own agent activity over the last `days` (default
 * 30, clamped to 1..90), across both agent families:
 *
 *   - Hermes lane: metered usage (sessions, tokens, est. cost, top models +
 *     skills, daily trend) from `instance_usage_snapshots`.
 *   - Hivra lane: recorded lifecycle activity and desktop sessions from
 *     `hivra_agent_events` / `hivra_remote_desktop_sessions`.
 *
 * The payload carries `coverage` ('usage' | 'activity' | 'none') so the panel
 * chooses honest empty-state copy. Read-only. Powers the "Your agent at work"
 * dashboard panel.
 */
export async function GET(req: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);

    const daysParam = new URL(req.url).searchParams.get("days");
    const days = daysParam != null ? Number.parseInt(daysParam, 10) : undefined;

    const activity = await getUserAgentActivity(userId, {
      days: Number.isFinite(days) ? days : undefined,
    });

    return activitySuccess(activity);
  } catch (error) {
    log.error(
      "agent activity fetch failed",
      error instanceof Error ? error : new Error(String(error)),
      { source: "billing/agent-activity" }
    );
    return apiError("Failed to fetch agent activity", 500, {
      failureType: "agent_activity_unexpected_error",
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}
