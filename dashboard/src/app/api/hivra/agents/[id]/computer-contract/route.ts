// Hivra agent — Computer Contract status (GET) and owner actions (POST).
//
// GET says what Manage may show about the note Hivra gives the agent about its
// computer. It never contacts the computer. POST runs one explicit step:
//   deliver  Try again now (Hivra Cloud, My server and My cloud)
//   check    Read the computer's copy without writing
//   restore  Replace a copy someone edited on the computer
//   send     DigitalOcean: send the current note as one visible message

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";

import { supabaseAdmin } from "@/lib/supabase";
import { apiError, apiSuccess, handleApiError } from "@/lib/api-response";
import { isHivraApiAllowed } from "@/lib/hivra/hivra-flag";
import { RATE_LIMIT_PRESETS, enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { computerContractPlanFor } from "@/lib/agent-computers/computer-contract-input";
import {
  advanceProviderComputerContract,
  advanceProxmoxComputerContract,
  computerContractStatusFor,
  prepareDigitalOceanComputerContract,
} from "@/lib/hivra/computer-contract-delivery";
import { sendManagedSessionSetupNote } from "@/lib/hivra/do-managed-sessions";
import {
  describeHivraAgentExecutionContextError,
  resolveHivraAgentExecutionContext,
} from "@/lib/hivra/agent-execution-context";
import { managedSessionFailure, readMutationBody } from "@/app/api/hivra/managed-sessions/route-support";

const ActionSchema = z.object({ action: z.enum(["deliver", "check", "restore", "send"]) }).strict();

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

async function loadOwnedAgent(id: string, userId: string): Promise<Record<string, unknown> | null> {
  const { data } = await supabaseAdmin!
    .from("hivra_agents")
    .select("*")
    .eq("id", id)
    .eq("user_id", userId)
    .neq("status", "deleted")
    .maybeSingle();
  return (data as Record<string, unknown> | null) ?? null;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!isHivraApiAllowed(req.headers.get("host"))) return noStore(apiError("Not found", 404));
    const { id } = await params;
    const { userId } = await auth();
    if (!userId) return noStore(apiError("Unauthorized", 401));
    if (!supabaseAdmin) return noStore(apiError("Database not configured", 500));
    const agent = await loadOwnedAgent(id, userId);
    if (!agent) return noStore(apiError("Agent not found", 404));
    // A DigitalOcean note is sent only when the owner or launch sends it, so
    // Manage needs the current revision to offer "Send update". Minting it
    // sends nothing.
    const plan = computerContractPlanFor(agent as unknown as Parameters<typeof computerContractPlanFor>[0]);
    if (plan.status === "deliverable" && plan.channel === "do-setup-message") {
      await prepareDigitalOceanComputerContract(userId, agent);
    }
    return noStore(apiSuccess({ contract: await computerContractStatusFor(userId, agent) }));
  } catch (error) {
    return noStore(handleApiError(error));
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!isHivraApiAllowed(req.headers.get("host"))) return noStore(apiError("Not found", 404));
    const { id } = await params;
    const { userId } = await auth();
    if (!userId) return noStore(apiError("Unauthorized", 401));
    if (!supabaseAdmin) return noStore(apiError("Database not configured", 500));
    // Each step is one bounded round trip to the computer or to DigitalOcean.
    const limited = enforceAuthenticatedRouteRateLimit(req, { routeKey: "hivra_computer_contract_post", userId, ...RATE_LIMIT_PRESETS.settingsWrite });
    if (limited) return noStore(limited);
    const body = await readMutationBody(req, 1024);
    if (!body.ok) return body.response;
    const parsed = ActionSchema.safeParse(body.body);
    if (!parsed.success) return noStore(apiError("Unknown action.", 400));
    const { action } = parsed.data;

    const agent = await loadOwnedAgent(id, userId);
    if (!agent) return noStore(apiError("Agent not found", 404));
    const plan = computerContractPlanFor(agent as unknown as Parameters<typeof computerContractPlanFor>[0]);
    if (plan.status !== "deliverable") {
      return noStore(apiError("Hivra can't send this agent a note about its computer yet.", 409));
    }

    if (plan.channel === "do-setup-message") {
      if (action !== "send") return noStore(apiError("Unknown action.", 400));
      try {
        await sendManagedSessionSetupNote(userId, String(agent.id));
      } catch (error) {
        return managedSessionFailure(error, "/api/hivra/agents/[id]/computer-contract");
      }
      return noStore(apiSuccess({ contract: await computerContractStatusFor(userId, agent) }));
    }

    if (action === "send") return noStore(apiError("Unknown action.", 400));
    if (agent.status !== "running" || !agent.ip) {
      return noStore(apiError("The computer must be running before Hivra can update it.", 409));
    }
    if (plan.channel === "provider-seed") {
      // My cloud: the enrolled provider pin, bound to this owner and agent.
      return noStore(apiSuccess({ contract: await advanceProviderComputerContract(userId, agent, action) }));
    }
    let context;
    try {
      context = await resolveHivraAgentExecutionContext(userId, agent);
    } catch (contextError) {
      const safeError = describeHivraAgentExecutionContextError(contextError);
      if (safeError) return noStore(apiError(safeError.message, safeError.status));
      throw contextError;
    }
    const contract = await advanceProxmoxComputerContract(userId, agent, context.env, action);
    return noStore(apiSuccess({ contract }));
  } catch (error) {
    return noStore(handleApiError(error));
  }
}
