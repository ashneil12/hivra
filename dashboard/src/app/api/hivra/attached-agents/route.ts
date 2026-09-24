// The owner's agents that were added to one of their computers, for the
// Agents list ("Codex on MY_UBUNTU_DESKTOP" opens that computer's Chat tab),
// and which of their computers can take one, decided here with the private
// binding column the browser never sees and each computer's live gate answer
// (running, ready, free, the plan's agent limit). A computer the first pair
// supports but that cannot take Codex now comes with the gate's own reason.
// Read only. Canary only; elsewhere the list is empty.
export const runtime = "nodejs";
export const maxDuration = 15;
export const dynamic = "force-dynamic";

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { apiError, apiSuccess } from "@/lib/api-response";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { isHivraApiAllowed } from "@/lib/hivra/hivra-flag";
import { isAgentAttachEnabled } from "@/lib/agent-computers/attach-flag";
import { createAttachmentLifecycleStore } from "@/lib/agent-computers/attachment-lifecycle-store";
import { attachSupported } from "@/lib/agent-computers/attach-plan";
import { attachDependencies, readAttachChoices, type AttachChoice } from "@/lib/agent-computers/attach-routes";
import { supabaseAdmin } from "@/lib/supabase";

/** The owner's computers the first pair supports; an unreadable list offers none. */
async function supportedComputers(userId: string): Promise<Array<{ id: string; deploymentMode: string | null }>> {
  if (!supabaseAdmin) return [];
  let rows: unknown;
  try {
    const { data, error } = await supabaseAdmin.from("hivra_agents")
      .select("id, type, computer_profile, computer_substrate, infrastructure_binding_token_enforced, deployment_mode")
      .eq("user_id", userId).neq("status", "deleted").limit(200);
    rows = error ? null : data;
  } catch { rows = null; }
  if (!Array.isArray(rows)) return [];
  const data = rows;
  return (data as Array<Record<string, unknown>>).filter((row) => attachSupported({ type: String(row.type ?? ""),
    computer_profile: row.computer_profile as string | null, computer_substrate: row.computer_substrate as string | null,
    infrastructure_binding_token_enforced: row.infrastructure_binding_token_enforced as boolean | null,
    deployment_mode: row.deployment_mode as string | null }))
    .map((row) => ({ id: String(row.id), deploymentMode: (row.deployment_mode as string | null) ?? null }));
}

const UNCHECKED = "Hivra couldn't check this computer right now. Open it to try again.";

const noStore = <T extends Response>(response: T): T => { response.headers.set("Cache-Control", "no-store"); return response; };

export async function GET(req: NextRequest) {
  try {
    if (!isHivraApiAllowed(req.headers.get("host"))) return noStore(apiError("Not found", 404));
    const { userId } = await auth();
    if (!userId) return noStore(apiError("Unauthorized", 401));
    if (!isAgentAttachEnabled()) return noStore(apiSuccess({ enabled: false, agents: [], eligibleComputerIds: [], computerReasons: {} }));
    const limited = enforceAuthenticatedRouteRateLimit(req, { routeKey: "hivra:attached-agents:read", userId, limit: 60, windowMs: 60_000 });
    if (limited) return noStore(limited);
    const store = createAttachmentLifecycleStore();
    const [agents, supported] = await Promise.all([store.readOwnerAttached(userId), supportedComputers(userId)]);
    let choices: Map<string, AttachChoice> | null;
    try { choices = await readAttachChoices(userId, supported, attachDependencies({ store })); } catch { choices = null; }
    const eligible: string[] = [];
    const computerReasons: Record<string, string> = {};
    for (const computer of supported) {
      const choice = choices?.get(computer.id);
      if (choice && choice.reason === null) eligible.push(computer.id);
      else computerReasons[computer.id] = choice?.message ?? UNCHECKED;
    }
    return noStore(apiSuccess({ enabled: true, eligibleComputerIds: eligible, computerReasons, agents: agents.map((agent) => ({ id: agent.id, phase: agent.phase, agentName: agent.agentName ?? "Codex",
      runtimeId: agent.runtimeId, computerId: agent.sourceId, computerName: agent.computerName, computerStatus: agent.computerStatus,
      deploymentMode: agent.deploymentMode, createdAt: agent.createdAt, completedAt: agent.completedAt })) }));
  } catch {
    return noStore(apiError("Agents added to your computers couldn't be loaded.", 503, undefined, undefined,
      { route: "/api/hivra/attached-agents", method: "GET", failureType: "attached_agents_unavailable" }));
  }
}
