// An agent's software, for its owner: which Claude Code or Codex version its
// computer runs next to the version Hivra has tested, any update in progress
// and what the last one did, and the owner's automatic-update choice. For the
// other agents Hivra updates in place, whether their connection service is
// older than Hivra's current one.
//
// GET ?live=1 reads the computer now (so does a stored reading older than 10
// minutes); otherwise the stored reading answers. PATCH {autoUpdate: boolean}
// saves the owner's choice. Owner-scoped: another owner's agent, a deleted one
// or a malformed id is a 404. The computer is read on the server with its
// bearer; the answer never carries the computer's address or bearer.

export const runtime = "nodejs";

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { apiError, apiSuccess, handleApiError } from "@/lib/api-response";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { isSameOriginMutationRequest } from "@/app/api/infrastructure/connections/request-security";
import { isHivraApiAllowed } from "@/lib/hivra/hivra-flag";
import { supabaseAdmin } from "@/lib/supabase";
import { logHivraAgentEvent } from "@/lib/hivra/agent-events";
import { agentSoftwareSubject } from "@/lib/hivra/agent-cli-status";
import { readAgentSoftwareRecord, saveAgentSoftwareAutoUpdate } from "@/lib/hivra/agent-cli-store";
import {
  agentSoftwareResponse,
  configuredAgentCliAutoUpdateMode,
  isAgentSoftwareStale,
  observeAgentSoftware,
  type AgentSoftwareAgentRow,
} from "@/lib/hivra/agent-software-service";
import { noStore, UUID_V1_TO_8 } from "@/app/api/hivra/managed-sessions/route-support";

const AGENT_COLUMNS = "id, user_id, type, status, deployment_mode, computer_profile, computer_substrate, chat_url, cf_hostname, api_token";

async function ownerAgent(id: string, userId: string): Promise<{ agent: AgentSoftwareAgentRow | null; failed: boolean }> {
  if (!supabaseAdmin || !UUID_V1_TO_8.test(id)) return { agent: null, failed: false };
  const { data, error } = await supabaseAdmin
    .from("hivra_agents")
    .select(AGENT_COLUMNS)
    .eq("id", id)
    .eq("user_id", userId)
    .neq("status", "deleted")
    .maybeSingle();
  if (error) return { agent: null, failed: true };
  return { agent: (data as AgentSoftwareAgentRow | null) ?? null, failed: false };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!isHivraApiAllowed(req.headers.get("host"))) return apiError("Not found", 404);
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    if (!supabaseAdmin) return apiError("Database not configured", 500);
    const { id } = await params;
    const limited = enforceAuthenticatedRouteRateLimit(req, { routeKey: "hivra_agent_software_read", userId, limit: 60, windowMs: 5 * 60_000 });
    if (limited) return limited;

    const { agent, failed } = await ownerAgent(id, userId);
    if (failed) return apiError("Could not load this agent.", 503);
    if (!agent) return apiError("Agent not found", 404);
    const mode = configuredAgentCliAutoUpdateMode();
    const subject = agentSoftwareSubject(agent);
    if (!subject) return noStore(apiSuccess(agentSoftwareResponse(agent, null, mode, Date.now())));

    let record = await readAgentSoftwareRecord(agent.id, userId);
    const live = new URL(req.url).searchParams.get("live") === "1";
    // Only a running agent's computer is read; a stopped one answers from what is stored.
    if (agent.status === "running" && (live || isAgentSoftwareStale(record, Date.now()))) {
      record = await observeAgentSoftware(agent, subject, record);
    }
    return noStore(apiSuccess(agentSoftwareResponse(agent, record, mode, Date.now())));
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!isHivraApiAllowed(req.headers.get("host"))) return apiError("Not found", 404);
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    if (!supabaseAdmin) return apiError("Database not configured", 500);
    if (!isSameOriginMutationRequest(req)) return apiError("Same-origin request required.", 403);
    const { id } = await params;
    const limited = enforceAuthenticatedRouteRateLimit(req, { routeKey: "hivra_agent_software_write", userId, limit: 20, windowMs: 10 * 60_000 });
    if (limited) return limited;

    const body = (await req.json().catch(() => null)) as { autoUpdate?: unknown } | null;
    if (!body || typeof body.autoUpdate !== "boolean" || Object.keys(body).length !== 1) {
      return apiError("Send {\"autoUpdate\": true} or {\"autoUpdate\": false}.", 400);
    }
    const { agent, failed } = await ownerAgent(id, userId);
    if (failed) return apiError("Could not load this agent.", 503);
    if (!agent) return apiError("Agent not found", 404);
    const subject = agentSoftwareSubject(agent);
    if (!subject?.cli) return apiError("Hivra doesn't update this agent's software automatically.", 400);

    const saved = await saveAgentSoftwareAutoUpdate({ id: agent.id, user_id: userId, type: agent.type }, subject, body.autoUpdate);
    if (!saved) return apiError("Your choice couldn't be saved. Try again.", 503);
    await logHivraAgentEvent({
      userId,
      event: "agent_cli_auto_update_changed",
      agentId: agent.id,
      agentType: agent.type,
      detail: { enabled: body.autoUpdate },
    });
    const record = await readAgentSoftwareRecord(agent.id, userId);
    return noStore(apiSuccess(agentSoftwareResponse(agent, record, configuredAgentCliAutoUpdateMode(), Date.now())));
  } catch (error) {
    return handleApiError(error);
  }
}
