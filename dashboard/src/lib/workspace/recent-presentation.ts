import {
  AGENT_SURFACE_IDS,
  agentSurfaceGroupOf,
  agentSurfaceGroups,
  agentSurfaceLabel,
  type AgentSurfaceId,
} from "@/lib/agent-computers/agent-surfaces";
import { getAgent as catalogAgent } from "@/lib/hivra/agent-catalog";
import { isSandboxComputer } from "@/lib/hivra/fleet-sections";
import type { UnifiedAgent } from "@/lib/hivra/unified-agent";

/** The fields of a listed resource that decide how its surfaces are named. */
export type RecentSubject = Pick<UnifiedAgent, "kind" | "resourceKind" | "agentType" | "computerProfile" | "surfaceKind">;

const COMPUTER_SURFACES: readonly AgentSurfaceId[] = ["desktop", "box", "files", "manage"];
const DASHBOARD_SURFACES: readonly AgentSurfaceId[] = ["aeon", "box", "files", "browser", "manage"];
const CHAT_SURFACES: readonly AgentSurfaceId[] = AGENT_SURFACE_IDS.filter((id) => id !== "aeon" && id !== "desktop");

/**
 * Where a resource will open for a remembered tab, named the way its page
 * names it: "Chat", "Codex session", "Computer › Terminal", "Desktop".
 *
 * A tab the resource cannot show (a stale or carried-over one) is named as the
 * view its page falls back to, so the label never promises a surface the link
 * will not open. A Hermes agent has one surface, its chat.
 */
export function recentSurfaceLabel(tab: AgentSurfaceId, resource: RecentSubject): string {
  if (resource.kind === "hermes") return "Chat";
  const def = resource.agentType ? catalogAgent(resource.agentType) : undefined;
  if (resource.resourceKind === "computer") {
    // A computer's surfaces are one flat list, named without a group.
    const surfaces = isSandboxComputer(resource) ? ["manage" as const] : COMPUTER_SURFACES;
    return agentSurfaceLabel(surfaces.includes(tab) ? tab : surfaces[0], def);
  }
  const dashboard = resource.surfaceKind === "dashboard";
  const surfaces = dashboard ? DASHBOARD_SURFACES : CHAT_SURFACES;
  const shown = surfaces.includes(tab) ? tab : dashboard ? "aeon" : "chat";
  // A dashboard agent's Manage group holds only Manage, so its page shows no
  // second row. A chat agent's Manage row names its own tab "Settings"
  // (ResourceSurfaceNavigation GROUPED_LABEL), and Home names it the same way.
  if (shown === "manage") return dashboard ? "Manage" : "Manage › Settings";
  const label = agentSurfaceLabel(shown, def);
  // The agent's own views stand alone; its computer's and its settings say
  // which group they sit in, as the page's two rows do.
  if (agentSurfaceGroupOf(shown) === "work") return label;
  const group = agentSurfaceGroups([shown], def)[0]?.label;
  return group && group !== label ? `${group} › ${label}` : label;
}

/**
 * "used 5 min ago": when the resource was last on screen here, which is what
 * Recent is ordered by. Null when the time is not known (a visit carried over
 * from before times were kept). A clock that moved backwards reads as just now.
 */
export function usedAgoLabel(usedAt: number, now: number): string | null {
  if (!usedAt) return null;
  const minutes = Math.floor(Math.max(0, now - usedAt) / 60_000);
  if (minutes < 1) return "used just now";
  if (minutes < 60) return `used ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `used ${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `used ${days} ${days === 1 ? "day" : "days"} ago`;
  return "used over a month ago";
}
