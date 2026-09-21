import "server-only";

// Cross-lane tool TARGETS (Tools v2) — the one list of "agents I can install a
// tool onto", spanning both families:
//
//   * CLI lane   (hivra_agents, type claude-code|codex) -> box MCP config over
//     SSH (tool-mcp-seed.ts)
//   * Hermes lane (hermes_instances)                    -> agent config.yaml
//     mcp_servers (hermes-tool-apply.ts)
//
// The Tools page needs this to show "installed on N of your agents" and to fan an
// install out over a chosen set. Pure inventory: no installing happens here.

import { supabaseAdmin } from "@/lib/supabase";
import { toolMcpKindForType } from "@/lib/hivra/tool-mcp-seed";

type ToolTargetLane = "cli" | "hermes";

export interface ToolTarget {
  /** Unique across lanes (lane-prefixed) — safe as a React key / request id. */
  uid: string;
  lane: ToolTargetLane;
  /** Underlying row id (hivra_agents.id | hermes_instances.id). */
  id: string;
  name: string;
  /** Raw agent type (CLI lane) or "hermes". */
  type: string;
  status: string;
  /** True when a tool can actually be written right now. */
  installable: boolean;
  /** Why not, when installable is false. */
  blockedReason?: "not_running" | "unsupported_type" | "no_ip";
  /** Bare MCP server names currently installed on this target. */
  installedTools?: string[];
}

import { readInstalledHermesToolNames } from "@/lib/hivra/hermes-tool-config";

const CLI_SELECT = "id,name,type,status,ip";
const HERMES_SELECT = "id,name,status,lifecycle_state,backend,gateway_url,config";

/**
 * Every agent the user owns, across both lanes, annotated with whether a tool can
 * be installed on it right now. Never throws — a lane that fails to query is
 * simply omitted, so the Tools page still renders the other one.
 */
export async function listToolTargets(userId: string): Promise<ToolTarget[]> {
  if (!supabaseAdmin) return [];
  const out: ToolTarget[] = [];

  // --- CLI lane -----------------------------------------------------------
  try {
    const { data } = await supabaseAdmin
      .from("hivra_agents")
      .select(CLI_SELECT)
      .eq("user_id", userId)
      .neq("status", "deleted")
      .order("created_at", { ascending: true });
    for (const r of data || []) {
      const row = r as Record<string, unknown>;
      const type = String(row.type || "");
      const status = String(row.status || "");
      const supported = Boolean(toolMcpKindForType(type));
      const hasIp = Boolean(String(row.ip || "").trim());
      out.push({
        uid: `cli-${row.id}`,
        lane: "cli",
        id: String(row.id),
        name: String(row.name || "Agent"),
        type,
        status,
        installable: supported && status === "running" && hasIp,
        blockedReason: !supported
          ? "unsupported_type"
          : status !== "running"
            ? "not_running"
            : !hasIp
              ? "no_ip"
              : undefined,
        installedTools: [],
      });
    }
  } catch {
    /* lane unavailable — omit rather than fail the whole listing */
  }

  // --- Hermes lane --------------------------------------------------------
  try {
    const { data } = await supabaseAdmin
      .from("hermes_instances")
      .select(HERMES_SELECT)
      .eq("user_id", userId)
      .neq("status", "deleted")
      .neq("lifecycle_state", "deleted")
      .order("created_at", { ascending: true });
    for (const r of data || []) {
      const row = r as Record<string, unknown>;
      const status = String(row.status || "");
      const config = (row.config as Record<string, unknown>) || {};
      const installedTools = readInstalledHermesToolNames(config);
      out.push({
        uid: `hermes-${row.id}`,
        lane: "hermes",
        id: String(row.id),
        name: String(row.name || "Hermes agent"),
        type: "hermes",
        status,
        installable: status === "running",
        blockedReason: status !== "running" ? "not_running" : undefined,
        installedTools,
      });
    }
  } catch {
    /* lane unavailable */
  }

  return out;
}
