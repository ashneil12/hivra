// Hivra agents — provision (POST) + list (GET).
// Reuses the existing Proxmox SSH machinery (runProxmoxHostScript) to kick the
// host-side orchestrator (hivra-provision-on-host.sh) on the selected Proxmox
// host in the background, and tracks each agent in the hivra_agents table.

export const runtime = "nodejs";
// Allocation may wait behind the 60-second host lock and then wait up to 60
// seconds for the exact provider identity receipt. Keep headroom so the control
// plane cannot terminate between durable intent and DB identity persistence.
// Linux Sandbox launches wait for the host's create inline, which may take up
// to 360 seconds (gvisor-computer-service); leave room for the work around it.
export const maxDuration = 420;

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { supabaseAdmin } from "@/lib/supabase";
import { apiSuccess, apiError, handleApiError } from "@/lib/api-response";
import { openPromptsFor } from "@/lib/agent-inbox/prompts";
import { isActiveComputeStatus } from "@/lib/hivra/resource-gate";
import { sanitizeHivraAgentRow } from "@/lib/hivra/agent-llm";
import { agentSoftwareSubject } from "@/lib/hivra/agent-cli-status";
import { isComputerMissingOnHostRow } from "@/lib/hivra/computer-usage-contract";
import { readAgentSoftwareRecords } from "@/lib/hivra/agent-cli-store";
import { agentSoftwareSummaryFor, type AgentSoftwareAgentRow } from "@/lib/hivra/agent-software-service";
import { hasStrictJsonContentType, isSameOriginMutationRequest, readBoundedJson } from "@/app/api/infrastructure/connections/request-security";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { launchHivraAgentForUser } from "@/lib/hivra/launch-agent";

export async function POST(request: NextRequest) {
  const response = await launchAgent(request);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

async function launchAgent(request: NextRequest) {
  try {
    // Canary/prod gate: Hivra boxes only launch where the feature is explicitly
    // enabled. Host selection is separate and uses the Proxmox allocator unless
    // ops deliberately pins a dedicated lane.
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    if (!supabaseAdmin) return apiError("Database not configured", 500);

    // Every destination can carry model credentials or reserve resources.
    // Gate the actual launch endpoint before reading a potentially secret body,
    // not just the provider adapter after parsing and target discovery.
    if (!isSameOriginMutationRequest(request)) return apiError("Open launch from this dashboard to create a computer.", 403);
    if (!hasStrictJsonContentType(request)) return apiError("Send launch settings as JSON.", 415);
    const limited = enforceAuthenticatedRouteRateLimit(request, { routeKey: "hivra_agent_launch", userId, limit: 10, windowMs: 5 * 60_000 });
    if (limited) return limited;
    const parsedBody = await readBoundedJson(request, 32 * 1024, 5000);
    if (!parsedBody.ok) return apiError("Send complete launch settings of at most 32 KB.", parsedBody.reason === "too_large" ? 413 : 400);
    if (!parsedBody.body || typeof parsedBody.body !== "object" || Array.isArray(parsedBody.body)) return apiError("Launch settings must be a JSON object.", 400);
    const body = parsedBody.body as Record<string, unknown>;
    return await launchHivraAgentForUser(userId, body);
  } catch (err) {
    return handleApiError(err);
  }
}


// A failed launch stays listed this long so the person can read why it failed
// and delete it (it may still hold a VM). It is display-only: `error` rows are
// not active compute, so slots, the pool and billing usage never count them.
const FAILED_LAUNCH_LIST_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function isRecentFailedLaunch(row: Record<string, unknown>, now: number): boolean {
  if (row.status !== "error") return false;
  // A computer its host reported gone stays listed, whatever its age, so its
  // owner can open Manage and remove the record.
  if (isComputerMissingOnHostRow(row)) return true;
  // hivra_agents has no updated_at column today; honour one if it appears.
  const stamp = [row.updated_at, row.created_at].find((v): v is string => typeof v === "string");
  const at = stamp ? Date.parse(stamp) : NaN;
  return Number.isFinite(at) && now - at <= FAILED_LAUNCH_LIST_WINDOW_MS;
}

export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    if (!supabaseAdmin) return apiError("Database not configured", 500);

    const { data, error } = await supabaseAdmin
      .from("hivra_agents")
      .select("*")
      .eq("user_id", userId)
      .neq("status", "deleted")
      .order("created_at", { ascending: false });
    if (error) return apiError("Failed to list agents", 500);
    const rows = (Array.isArray(data) ? data : [])
      .filter((row) => {
        const status = (row as { status?: unknown }).status;
        return isActiveComputeStatus(status) || isRecentFailedLaunch(row as Record<string, unknown>, Date.now());
      }) as Record<string, unknown>[];
    // One read of the stored software observations, never the computers
    // themselves: the list tags agents whose Claude Code / Codex is behind.
    const covered = new Set(rows.filter((row) => agentSoftwareSubject(row) !== null).map((row) => String(row.id)));
    const software = await readAgentSoftwareRecords(userId, [...covered]);
    const now = Date.now();
    // What each agent is waiting on its owner for (empty while the inbox switch is off).
    const prompts = await openPromptsFor(rows.map((row) => String(row.id)));
    const agents = rows.map((row) => {
      const prompt = prompts[String(row.id)];
      const agent = prompt ? { ...sanitizeHivraAgentRow(row), inbox_prompt: prompt } : sanitizeHivraAgentRow(row);
      // Only what Hivra has read: an agent never read yet gets no summary.
      const record = covered.has(String(row.id)) ? software.get(String(row.id)) : undefined;
      if (!record) return agent;
      const summary = agentSoftwareSummaryFor(row as unknown as AgentSoftwareAgentRow, record, now);
      return summary ? { ...agent, agent_software: summary } : agent;
    });
    return apiSuccess({ agents });
  } catch (err) {
    return handleApiError(err);
  }
}
