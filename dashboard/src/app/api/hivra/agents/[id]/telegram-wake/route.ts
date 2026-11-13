// The owner's "Wake on Telegram messages" switch for one agent. GET says
// whether it applies to this agent and whether it is on; PATCH turns it on or
// off. Turning it on reads the agent's bot token from its own computer once and
// keeps it encrypted; the token is never sent back. Turning it off takes the
// wake webhook down first, and wakes an agent that was asleep waiting for one.
// Dark unless HIVRA_TELEGRAM_WAKE and its settings are configured.

export const runtime = "nodejs";
// Reading the token goes through the agent's computer, and a wake after opting out runs after the answer.
export const maxDuration = 180;

import { after, type NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { isSameOriginMutationRequest } from "@/app/api/infrastructure/connections/request-security";
import { supabaseAdmin } from "@/lib/supabase";
import { apiSuccess, apiError, handleApiError } from "@/lib/api-response";
import { ensureHivraAgentAwake } from "@/lib/hivra/agent-wake";
import { disableTelegramWake, enableTelegramWake, readTelegramWakeView } from "@/lib/hivra/telegram-wake/owner";

type Params = { params: Promise<{ id: string }> };

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
    const { id } = await params;
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    if (!supabaseAdmin) return apiError("Database not configured", 500);
    const owned = await ownAgent(id, userId);
    if (owned.response) return owned.response;
    return noStore(apiSuccess(await readTelegramWakeView(owned.agent, userId)));
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    if (!supabaseAdmin) return apiError("Database not configured", 500);
    if (!isSameOriginMutationRequest(req)) return apiError("Same-origin request required.", 403);
    const limited = enforceAuthenticatedRouteRateLimit(req, {
      routeKey: "hivra_agent_telegram_wake",
      userId,
      limit: 10,
      windowMs: 5 * 60_000,
    });
    if (limited) return limited;

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.enabled !== "boolean") {
      return apiError("Wake on Telegram messages must be on or off.", 400);
    }
    const owned = await ownAgent(id, userId);
    if (owned.response) return owned.response;

    const change = body.enabled
      ? await enableTelegramWake(owned.agent, userId)
      : await disableTelegramWake(owned.agent);
    if (!change.ok) return apiError(change.message, change.status, undefined, { code: change.code });
    if (change.wake) {
      // Asleep and waiting for a message that can no longer wake it: wake it now. A no-op when awake.
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
