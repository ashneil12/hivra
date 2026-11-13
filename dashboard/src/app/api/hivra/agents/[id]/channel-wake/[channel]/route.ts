// The owner's "Wake on <channel> messages" switch for one agent, for the
// channels with a generic wake (only matrix today; Telegram keeps its own
// route). GET says whether it applies to this agent and whether it is on;
// PATCH turns it on or off. Turning Matrix on adds a pusher on the agent's
// homeserver from inside its own computer: the access token never leaves it
// and is never stored. Turning it off wakes an agent that was asleep counting
// on it. Dark unless the HIVRA_CHANNEL_WAKE switches are configured.

export const runtime = "nodejs";
// The pusher is set up through the agent's computer, and a wake after opting out runs after the answer.
export const maxDuration = 180;

import { after, type NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { isSameOriginMutationRequest } from "@/app/api/infrastructure/connections/request-security";
import { supabaseAdmin } from "@/lib/supabase";
import { apiSuccess, apiError, handleApiError } from "@/lib/api-response";
import { ensureHivraAgentAwake } from "@/lib/hivra/agent-wake";
import {
  disableChannelWake,
  enableChannelWake,
  isOwnerSwitchChannel,
  readChannelWakeView,
} from "@/lib/hivra/channel-wake/owner";

type Params = { params: Promise<{ id: string; channel: string }> };

/** The owner's agent row, or a response to send instead. */
async function ownAgent(id: string, userId: string) {
  const { data, error } = await supabaseAdmin!
    .from("hivra_agents")
    .select("*")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (error && !["PGRST116", "22P02"].includes(error.code)) return { response: apiError("Could not load this computer.", 503) };
  if (!data) return { response: apiError("Agent not found", 404) };
  return { agent: data as Record<string, unknown> };
}

function noStore<T extends Response>(response: T): T {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const { id, channel } = await params;
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    if (!isOwnerSwitchChannel(channel)) return apiError("Not found", 404);
    if (!supabaseAdmin) return apiError("Database not configured", 500);
    const owned = await ownAgent(id, userId);
    if (owned.response) return owned.response;
    return noStore(apiSuccess(await readChannelWakeView(owned.agent, channel)));
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const { id, channel } = await params;
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    if (!isOwnerSwitchChannel(channel)) return apiError("Not found", 404);
    if (!supabaseAdmin) return apiError("Database not configured", 500);
    if (!isSameOriginMutationRequest(req)) return apiError("Same-origin request required.", 403);
    const limited = enforceAuthenticatedRouteRateLimit(req, {
      routeKey: "hivra_agent_channel_wake",
      userId,
      limit: 10,
      windowMs: 5 * 60_000,
    });
    if (limited) return limited;

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.enabled !== "boolean") {
      return apiError("This setting must be on or off.", 400);
    }
    const owned = await ownAgent(id, userId);
    if (owned.response) return owned.response;

    const change = body.enabled
      ? await enableChannelWake(owned.agent, channel)
      : await disableChannelWake(owned.agent, channel);
    if (!change.ok) return apiError(change.message, change.status, undefined, { code: change.code });
    if (change.wake) {
      // Asleep and counting on a channel that can no longer wake it: wake it now. A no-op when awake.
      try {
        await ensureHivraAgentAwake(id, { trigger: "action", waitMs: 0, onBackground: (work) => after(() => work) });
      } catch {
        // The setting is saved; the agent wakes on its next use.
      }
    }
    return noStore(apiSuccess(change.view));
  } catch (error) {
    return handleApiError(error);
  }
}
