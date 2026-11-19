// An agent's software, for its owner: which version of its CLI or app its
// computer runs, any update in progress and what the last one did. Hivra pins
// no version and never updates by itself: the owner presses Update.
//
// GET ?live=1 reads the computer now (so does a stored reading older than 10
// minutes); otherwise the stored reading answers. Owner-scoped: another owner's agent, a deleted one
// or a malformed id is a 404. The computer is read on the server with its
// bearer; the answer never carries the computer's address or bearer.

export const runtime = "nodejs";

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { apiError, apiSuccess, handleApiError } from "@/lib/api-response";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { supabaseAdmin } from "@/lib/supabase";
import { agentSoftwareSubject } from "@/lib/hivra/agent-cli-status";
import { readAgentSoftwareRecord } from "@/lib/hivra/agent-cli-store";
import {
  agentSoftwareResponse,
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
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    if (!supabaseAdmin) return apiError("Database not configured", 500);
    const { id } = await params;
    const limited = enforceAuthenticatedRouteRateLimit(req, { routeKey: "hivra_agent_software_read", userId, limit: 60, windowMs: 5 * 60_000 });
    if (limited) return limited;

    const { agent, failed } = await ownerAgent(id, userId);
    if (failed) return apiError("Could not load this agent.", 503);
    if (!agent) return apiError("Agent not found", 404);
    const subject = agentSoftwareSubject(agent);
    if (!subject) return noStore(apiSuccess(agentSoftwareResponse(agent, null, Date.now())));

    let record = await readAgentSoftwareRecord(agent.id, userId);
    const live = new URL(req.url).searchParams.get("live") === "1";
    // Only a running agent's computer is read; a stopped one answers from what is stored.
    if (agent.status === "running" && (live || isAgentSoftwareStale(record, Date.now()))) {
      record = await observeAgentSoftware(agent, subject, record);
    }
    return noStore(apiSuccess(agentSoftwareResponse(agent, record, Date.now())));
  } catch (error) {
    return handleApiError(error);
  }
}
