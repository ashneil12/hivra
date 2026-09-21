// Tools v2 — the CROSS-AGENT tools surface API.
//
// GET  /api/tools  -> the full catalog + every agent the user can install onto
//                     (both lanes) + which tools each CLI agent already carries.
// POST /api/tools  -> { toolId, env?, targets: string[] (target uids), op? }
//                     fan an install/uninstall out over the chosen agents.
//
// This is the surface behind /dashboard/tools. Per-agent routes
// (/api/hivra/agents/[id]/tools) stay as-is for the in-agent picker.

export const runtime = "nodejs";
export const maxDuration = 120;
export const dynamic = "force-dynamic";

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { supabaseAdmin } from "@/lib/supabase";
import { apiSuccess, apiError, handleApiError } from "@/lib/api-response";
import { resolveProxmoxTargetConfiguration } from "@/lib/services/proxmox-instance-service";
import { resolveHivraProxmoxHost } from "@/lib/hivra/proxmox-target";
import {
  installToolsOnBox,
  uninstallToolFromBox,
  listInstallableToolMeta,
  resolveToolMcpSpec,
} from "@/lib/hivra/tool-install";
import { listToolTargets, type ToolTarget } from "@/lib/hivra/tool-targets";
import { applyToolsToHermesInstance } from "@/lib/hivra/hermes-tool-apply";
import { readInstalledHermesToolNames, type HermesToolServerEntry } from "@/lib/hivra/hermes-tool-config";
import { getToolById } from "@/data/curated-tools";
import { logHivraAgentEvent } from "@/lib/hivra/agent-events";
import { RATE_LIMIT_PRESETS, enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";

export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    if (!supabaseAdmin) return apiError("Database not configured", 500);

    const targets = await listToolTargets(userId);
    // The union catalog: claude sees everything (incl. hosted http tools), so use
    // it as the superset and let each target's lane decide installability.
    const tools = listInstallableToolMeta("claude");
    return apiSuccess({ tools, targets });
  } catch (err) {
    return handleApiError(err);
  }
}

/** Desired Hermes entry set = what's installed now, plus/minus this tool. */
async function reconcileHermesTarget(params: {
  userId: string;
  target: ToolTarget;
  toolId: string;
  env: Record<string, string>;
  remove: boolean;
}): Promise<{ ok: boolean; error?: string }> {
  if (!supabaseAdmin) return { ok: false, error: "Database not configured" };
  const { data: instance } = await supabaseAdmin
    .from("hermes_instances")
    .select("*")
    .eq("id", params.target.id)
    .eq("user_id", params.userId)
    .single();
  if (!instance) return { ok: false, error: "Instance not found" };

  // Current desired set: read the live config's hivra_ entries, then rebuild each
  // from the catalog (so we never have to store install state ourselves).
  const cfgNames = readInstalledHermesToolNames(
    (instance.config as Record<string, unknown>) || {},
  );
  const keep = new Set(cfgNames);
  const tool = getToolById(params.toolId);
  if (!tool) return { ok: false, error: "Unknown tool" };
  if (params.remove) keep.delete(tool.mcp.name);
  else keep.add(tool.mcp.name);

  const entries: HermesToolServerEntry[] = [];
  for (const t of [tool]) {
    if (!keep.has(t.mcp.name)) continue;
    const resolved = resolveToolMcpSpec({ id: t.id, env: params.env }, "claude");
    if ("skip" in resolved) return { ok: false, error: `cannot resolve tool: ${resolved.skip}` };
    entries.push({
      name: resolved.spec.name,
      url: resolved.spec.url,
      headers: resolved.spec.headers,
      command: resolved.spec.command,
      args: resolved.spec.args,
      env: resolved.spec.env,
    });
  }

  try {
    const res = await applyToolsToHermesInstance({
      instanceId: params.target.id,
      userId: params.userId,
      instance: instance as never,
      entries,
    });
    if (!res.applied) return { ok: false, error: res.reason || "not applied" };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message.slice(0, 200) };
  }
}

export async function POST(req: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    if (!supabaseAdmin) return apiError("Database not configured", 500);

    const rateLimitError = enforceAuthenticatedRouteRateLimit(req, {
      routeKey: "tools_fanout_post",
      userId,
      ...RATE_LIMIT_PRESETS.settingsWrite,
    });
    if (rateLimitError) return rateLimitError;

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const toolId = typeof body.toolId === "string" ? body.toolId.trim() : "";
    if (!toolId) return apiError("toolId is required", 400);
    if (!getToolById(toolId)) return apiError("Unknown tool", 404);
    const remove = body.op === "uninstall";

    const rawTargets = Array.isArray(body.targets) ? body.targets : [];
    const wanted = rawTargets.filter((t): t is string => typeof t === "string" && t.trim().length > 0);
    if (wanted.length === 0) return apiError("targets must be a non-empty array", 400);
    if (wanted.length > 25) return apiError("Too many targets in one call", 400);

    const env: Record<string, string> = {};
    if (body.env && typeof body.env === "object") {
      for (const [k, v] of Object.entries(body.env as Record<string, unknown>)) {
        if (typeof v === "string") env[k] = v;
      }
    }

    const all = await listToolTargets(userId);
    const byUid = new Map(all.map((t) => [t.uid, t]));

    const results: { uid: string; ok: boolean; error?: string }[] = [];
    for (const uid of wanted) {
      const target = byUid.get(uid);
      if (!target) {
        results.push({ uid, ok: false, error: "not found" });
        continue;
      }
      if (!target.installable) {
        results.push({ uid, ok: false, error: target.blockedReason || "not installable" });
        continue;
      }

      if (target.lane === "hermes") {
        const r = await reconcileHermesTarget({ userId, target, toolId, env, remove });
        results.push({ uid, ...r });
        continue;
      }

      // CLI lane — reuse the proven per-box installer.
      const { data: agent } = await supabaseAdmin
        .from("hivra_agents")
        .select("*")
        .eq("id", target.id)
        .eq("user_id", userId)
        .single();
      if (!agent) {
        results.push({ uid, ok: false, error: "agent not found" });
        continue;
      }
      const pxEnv = resolveProxmoxTargetConfiguration(
        process.env,
        resolveHivraProxmoxHost(agent.proxmox_host as string | null),
      ).env;
      const box = {
        id: String(agent.id),
        type: (agent.type as string | null) ?? null,
        ip: (agent.ip as string | null) ?? null,
      };
      if (remove) {
        const r = await uninstallToolFromBox(box, toolId, pxEnv);
        results.push({ uid, ok: r.ok, error: r.error });
      } else {
        const r = await installToolsOnBox(box, [{ id: toolId, env }], pxEnv);
        const skipped = r.skipped.find((s) => s.id === toolId);
        results.push({
          uid,
          ok: r.ok && r.installed.includes(toolId),
          error: r.error || (skipped ? skipped.reason : undefined),
        });
      }
    }

    const okCount = results.filter((r) => r.ok).length;
    await logHivraAgentEvent({
      userId,
      event: remove ? "tools_uninstalled" : "tools_installed",
      detail: { id: toolId, targets: wanted.length, ok: okCount, results },
    });

    return apiSuccess({ toolId, op: remove ? "uninstall" : "install", results, ok: okCount });
  } catch (err) {
    return handleApiError(err);
  }
}
