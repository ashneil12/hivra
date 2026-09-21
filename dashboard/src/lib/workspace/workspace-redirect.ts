import type { WorkspaceSurface } from "./workspace-contracts";

/**
 * The one-way bridge from the workspace route's vocabulary to the agent route's.
 *
 * `/dashboard/workspace?agent=x-<id>&surface=<token>` and
 * `/dashboard/agent/<id>?tab=<token>` name the same resource in two different
 * vocabularies, and the agent route is the canonical one: ~15 href producers
 * already target it, it owns all twelve surfaces, and it is the route that
 * renders in production (the workspace shell is behind a flag that is off
 * there). So the workspace route redirects into it, and this module is what
 * makes that redirect lossless.
 *
 * Two things have to be translated, and getting either wrong strands a link:
 *
 * 1. The SURFACE TOKEN. The vocabularies overlap on files/git/terminal/browser/
 *    desktop and diverge on the rest — the workspace's "conversation" is the
 *    agent route's "chat", its "workspace" is that route's "aeon" (a
 *    dashboard-surface runtime), and its "native" is a Hermes-only token with no
 *    agent-route equivalent.
 *
 * 2. The IDENTITY NAMESPACE. The workspace addresses resources with a
 *    source-qualified uid (`x-` for a Hivra agent, `h-` for a Hermes instance)
 *    because its list merges two families; the agent route takes the raw backing
 *    id in its path. Passing the prefixed uid through would 404.
 */

/** The agent route's tab vocabulary (src/app/dashboard/agent/[id]/page.tsx). */
export type AgentRouteTab =
  | "chat"
  | "aeon"
  | "desktop"
  | "terminal"
  | "browser"
  | "box"
  | "files"
  | "git"
  | "skills"
  | "telegram"
  | "tasks"
  | "manage";

/**
 * Workspace surface -> agent route tab.
 *
 * Every mapping here is either an identity (the token is already shared) or a
 * rename. There is no drop: a surface the agent route genuinely lacks would need
 * a decision, and today every workspace surface has a destination.
 */
const SURFACE_TO_TAB: Record<WorkspaceSurface, AgentRouteTab> = {
  conversation: "chat",
  // The workspace names a dashboard-surface runtime's embedded UI "workspace"
  // and the agent route names that same tab "aeon" (it hosts Aeon, Agent Zero,
  // OpenClaw and DeepSeek Harness alike — the id is historical, not Aeon-only).
  workspace: "aeon",
  desktop: "desktop",
  files: "files",
  git: "git",
  terminal: "terminal",
  browser: "browser",
  // Hermes-only in the workspace; the agent route's nearest equivalent is the
  // chat-CLI terminal. Only reached for a Hermes uid, which this route does not
  // serve — see resolveWorkspaceRedirect.
  native: "terminal",
};

export interface WorkspaceRedirectInput {
  /** Source-qualified uid from the workspace URL, or null. */
  agent: string | null;
  surface: WorkspaceSurface;
}

export interface WorkspaceRedirectTarget {
  /** Raw backing id for the agent route's path segment. */
  id: string;
  tab: AgentRouteTab;
}

/**
 * Translate a workspace route into an agent-route target.
 *
 * Returns null when there is nothing to redirect to — no agent selected, or a
 * Hermes uid. A Hermes instance is served by /dashboard/instances/<id>, a
 * different route with a different shell; silently sending it to the Hivra
 * agent page would show the wrong surface for the wrong family. The caller
 * decides where a null goes.
 */
export function resolveWorkspaceRedirect(
  input: WorkspaceRedirectInput,
): WorkspaceRedirectTarget | null {
  const uid = input.agent;
  if (!uid) return null;

  // The workspace's own uid contract is `[hx]-<backing id>`; anything else is
  // not a uid this route ever produced, so there is no safe translation.
  if (!/^[hx]-/.test(uid)) return null;

  const kind = uid[0];
  // A Hermes instance belongs to the instance route, not the agent route.
  if (kind === "h") return null;

  const id = uid.slice(2);
  if (!id) return null;

  return { id, tab: SURFACE_TO_TAB[input.surface] ?? "chat" };
}