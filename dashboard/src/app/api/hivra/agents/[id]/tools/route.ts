// Hivra agent — in-app TOOL installer (Wave 6). A tool bundles an MCP server (+
// its credentials) with optional teaching skills. GET returns the installable
// catalog for this box; POST { tools: [{id, env}] } installs them over SSH via
// the box's own MCP config + the skills seeder. Codex / claude-code boxes on a
// Proxmox host only — other agent types and substrates have no MCP config path
// and are rejected with a plain reason.

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { supabaseAdmin } from "@/lib/supabase";
import { apiSuccess, apiError, handleApiError } from "@/lib/api-response";
import { isHivraApiAllowed } from "@/lib/hivra/hivra-flag";
import { toolMcpKindForType } from "@/lib/hivra/tool-mcp-seed";
import { catalogToolsUnavailableReason } from "@/lib/hivra/catalog-tool-availability";
import { installToolsOnBox, listInstallableToolMeta, type ToolInstallRequest } from "@/lib/hivra/tool-install";
import { logHivraAgentEvent } from "@/lib/hivra/agent-events";
import { RATE_LIMIT_PRESETS, enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import {
  describeHivraAgentExecutionContextError,
  resolveHivraAgentExecutionContext,
} from "@/lib/hivra/agent-execution-context";

// The installable tool catalog (content-light) for this agent's picker. Auth +
// flag + ownership gated like the POST, so the catalog never leaks past the
// dashboard.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!isHivraApiAllowed(req.headers.get("host"))) return apiError("Not found", 404);
    const { id } = await params;
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    if (!supabaseAdmin) return apiError("Database not configured", 500);

    const { data: agent } = await supabaseAdmin
      .from("hivra_agents")
      .select("type,status,computer_substrate")
      .eq("id", id)
      .eq("user_id", userId)
      .neq("status", "deleted")
      .single();
    if (!agent) return apiError("Agent not found", 404);

    const kind = toolMcpKindForType(agent.type as string | null);
    if (!kind) {
      return apiSuccess({ supported: false, reason: "This agent type doesn't support catalog tools.", tools: [] });
    }
    // Report the substrate gate here too, so the picker never lists tools that
    // the POST below would refuse.
    const blocked = catalogToolsUnavailableReason(agent.computer_substrate);
    if (blocked) return apiSuccess({ supported: false, reason: blocked, tools: [] });
    return apiSuccess({ supported: true, tools: listInstallableToolMeta(kind) });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!isHivraApiAllowed(req.headers.get("host"))) return apiError("Not found", 404);
    const { id } = await params;
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    if (!supabaseAdmin) return apiError("Database not configured", 500);

    // Each install is a real SSH round-trip to the box — keep it on the modest
    // settings-write budget so the picker can't be used to hammer the host.
    const rateLimitError = enforceAuthenticatedRouteRateLimit(req, {
      routeKey: "hivra_tool_install_post",
      userId,
      ...RATE_LIMIT_PRESETS.settingsWrite,
    });
    if (rateLimitError) return rateLimitError;

    const { data: agent } = await supabaseAdmin
      .from("hivra_agents")
      .select("*")
      .eq("id", id)
      .eq("user_id", userId)
      .neq("status", "deleted")
      .single();
    if (!agent) return apiError("Agent not found", 404);

    // Box-type gate: only CLI boxes with an MCP config path can carry tools.
    if (!toolMcpKindForType(agent.type as string | null)) {
      return apiError("This agent type doesn't support installable tools", 400);
    }
    // Substrate gate: only Proxmox boxes have the host path below. Answer
    // plainly instead of letting the execution context report a bad binding.
    const blocked = catalogToolsUnavailableReason(agent.computer_substrate);
    if (blocked) return apiError(blocked, 400);
    if (agent.status !== "running" || !agent.ip) {
      return apiError("Agent isn't running yet", 409);
    }

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const raw = body.tools;
    if (!Array.isArray(raw) || raw.length === 0) {
      return apiError("tools must be a non-empty array", 400);
    }
    if (raw.length > 25) return apiError("Too many tools in one install", 400);

    // Coerce each entry to { id, env } — ids must be non-empty strings; env is an
    // optional flat string map (only the tool's declared keys are used downstream).
    const requests: ToolInstallRequest[] = [];
    for (const entry of raw) {
      const rec = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
      const tid = typeof rec.id === "string" ? rec.id.trim() : "";
      if (!tid) continue;
      const env: Record<string, string> = {};
      if (rec.env && typeof rec.env === "object") {
        for (const [k, v] of Object.entries(rec.env as Record<string, unknown>)) {
          if (typeof v === "string") env[k] = v;
        }
      }
      requests.push({ id: tid, env });
    }
    if (requests.length === 0) return apiError("tools must contain at least one valid id", 400);

    let env: Record<string, string | undefined>;
    try {
      env = (await resolveHivraAgentExecutionContext(userId, agent)).env;
    } catch (contextError) {
      const safeError = describeHivraAgentExecutionContextError(contextError);
      if (safeError) return apiError(safeError.message, safeError.status);
      throw contextError;
    }

    const result = await installToolsOnBox(
      {
        id: String(agent.id),
        type: (agent.type as string | null) ?? null,
        ip: (agent.ip as string | null) ?? null,
      },
      requests,
      env,
    );

    if (!result.ok) {
      return apiError(result.error || "Tool install failed", 502, undefined, {
        installed: result.installed,
        skipped: result.skipped,
      });
    }

    await logHivraAgentEvent({
      userId,
      event: "tools_installed",
      agentId: String(agent.id),
      agentType: agent.type as string,
      detail: {
        count: result.installed.length,
        ids: result.installed,
        skipped: result.skipped,
        skillsFailed: result.skillsFailed ?? [],
      },
    });

    return apiSuccess({
      installed: result.installed,
      skipped: result.skipped,
      skillsFailed: result.skillsFailed ?? [],
    });
  } catch (err) {
    return handleApiError(err);
  }
}
