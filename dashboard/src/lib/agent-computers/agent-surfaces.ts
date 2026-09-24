// What an agent's page shows, where its computer runs, and how the two are
// described. Pure and client-safe.
//
// One decision feeds three readers: the agent page tabs, the launch Review's
// "Your agent can use" row, and the Computer Contract Hivra gives the agent
// (computer-contract-input.ts). A parity test pins them together, so the tabs a
// user sees and what the agent is told cannot drift apart.

import { getAgent as catalogAgent, type AgentDef } from "@/lib/hivra/agent-catalog";

/** Every surface an agent or computer page can show, in display order. */
export const AGENT_SURFACE_IDS = [
  "chat", "aeon", "desktop", "terminal", "browser", "box", "files", "git", "skills", "telegram", "tasks", "manage",
] as const;
export type AgentSurfaceId = (typeof AGENT_SURFACE_IDS)[number];

/** Surfaces that look at the agent's computer rather than at the agent. */
export const COMPUTER_SURFACE_IDS = ["box", "files", "browser", "git"] as const satisfies readonly AgentSurfaceId[];

/** The fields of a stored agent row this decision reads. */
export interface AgentSurfaceSubject {
  type: string;
  status?: string | null;
  computer_profile?: string | null;
  computer_substrate?: string | null;
  chat_url?: string | null;
}

// Tabs shown for dashboard-surface agents (Aeon, OpenClaw, Agent Zero): the
// embedded dashboard, the computer's shell and files, and Manage. Desktop
// belongs to computers only: the desktop service refuses agent resources.
const DASHBOARD_SURFACES: readonly AgentSurfaceId[] = ["aeon", "box", "files", "manage"];
const COMPUTER_BASE_SURFACES: readonly AgentSurfaceId[] = ["desktop", "manage"];
const COMPUTER_WORKSPACE_SURFACES: readonly AgentSurfaceId[] = ["box", "files"];

function ordered(ids: Iterable<AgentSurfaceId>): AgentSurfaceId[] {
  const wanted = new Set(ids);
  return AGENT_SURFACE_IDS.filter((id) => wanted.has(id));
}

/**
 * The surfaces the agent page shows for this row, in display order.
 *
 * Browser-capable agents keep the Browser tab even while browser automation is
 * toggled off, so the owner can find the switch; the tab itself explains that
 * it is off. A DigitalOcean session has its own workspace with Chat and a
 * read-only Files view.
 */
export function agentSurfacesFor(subject: AgentSurfaceSubject): AgentSurfaceId[] {
  const def = catalogAgent(subject.type);
  if (subject.computer_substrate === "do-managed-session") return ["chat", "files"];
  if (def?.surface === "computer") {
    if (subject.computer_substrate === "gvisor") return ["manage"];
    const hasWorkspace = subject.status === "running"
      && subject.computer_profile !== "windows"
      && Boolean(subject.chat_url?.trim());
    return ordered(hasWorkspace ? [...COMPUTER_BASE_SURFACES, ...COMPUTER_WORKSPACE_SURFACES] : COMPUTER_BASE_SURFACES);
  }
  if (def?.surface === "dashboard") {
    return ordered([...DASHBOARD_SURFACES, ...(def.browser ? ["browser" as const] : [])]);
  }
  return AGENT_SURFACE_IDS.filter((id) => id !== "aeon" && id !== "desktop" && (id !== "browser" || Boolean(def?.browser)));
}

/** The one user-facing name for each surface. The shell is "Terminal"
 * everywhere; an agent's own command line is "<agent> session". */
export function agentSurfaceLabel(id: AgentSurfaceId, def?: Pick<AgentDef, "name"> | null): string {
  switch (id) {
    case "chat": return "Chat";
    case "aeon": return "Dashboard";
    case "desktop": return "Desktop";
    case "terminal": return `${def?.name || "Agent"} session`;
    case "browser": return "Browser";
    case "box": return "Terminal";
    case "files": return "Files";
    case "git": return "Git";
    case "skills": return "Skills";
    case "telegram": return "Telegram";
    case "tasks": return "Tasks";
    case "manage": return "Manage";
  }
}

export type AgentSurfaceGroupId = "work" | "computer" | "manage";
export interface AgentSurfaceGroup {
  id: AgentSurfaceGroupId;
  label: string;
  surfaces: AgentSurfaceId[];
}

const GROUP_OF: Record<AgentSurfaceId, AgentSurfaceGroupId> = {
  chat: "work", terminal: "work", aeon: "work", desktop: "work",
  box: "computer", files: "computer", browser: "computer", git: "computer",
  manage: "manage", skills: "manage", tasks: "manage", telegram: "manage",
};
// Inside a group the order is the one the owner reads, not the storage order.
const GROUP_ORDER: Record<AgentSurfaceGroupId, readonly AgentSurfaceId[]> = {
  work: ["chat", "aeon", "desktop", "terminal"],
  computer: ["box", "files", "browser", "git"],
  manage: ["manage", "skills", "tasks", "telegram"],
};

/**
 * Agent pages group their surfaces as the agent, its computer, and Manage:
 * Agent · Computer (Terminal, Files, Browser, Git) · Manage. Groups with no
 * surface are dropped. Computers keep their short flat list and never call this.
 */
export function agentSurfaceGroups(surfaces: readonly AgentSurfaceId[], def?: Pick<AgentDef, "surface"> | null): AgentSurfaceGroup[] {
  const present = new Set(surfaces);
  const groups: AgentSurfaceGroup[] = (["work", "computer", "manage"] as const).map((id) => ({
    id,
    label: id === "work" ? (def?.surface === "dashboard" ? "Dashboard" : "Agent") : id === "computer" ? "Computer" : "Manage",
    surfaces: GROUP_ORDER[id].filter((surface) => present.has(surface)),
  }));
  return groups.filter((group) => group.surfaces.length > 0);
}

export function agentSurfaceGroupOf(id: AgentSurfaceId): AgentSurfaceGroupId {
  return GROUP_OF[id];
}

// ── Where the computer runs ────────────────────────────────────────────────

export type ComputerPlacement = "hivra-cloud" | "my-server" | "my-cloud" | "digitalocean";

export interface ComputerPlacementSubject {
  deployment_mode?: string | null;
  computer_substrate?: string | null;
}

/** Placement from the stored lifecycle binding, never from a live probe. */
export function computerPlacementFor(subject: ComputerPlacementSubject): ComputerPlacement {
  if (subject.computer_substrate === "do-managed-session") return "digitalocean";
  if (subject.computer_substrate === "provider-vm") return "my-cloud";
  // gVisor sandboxes run on a server the owner connected; Proxmox rows are
  // Hivra Cloud unless the owner's own host holds them.
  if (subject.computer_substrate === "gvisor") return "my-server";
  return subject.deployment_mode === "self-managed" ? "my-server" : "hivra-cloud";
}

export const COMPUTER_PLACEMENT_LABEL: Record<ComputerPlacement, string> = {
  "hivra-cloud": "Hivra Cloud",
  "my-server": "My server",
  "my-cloud": "My cloud",
  digitalocean: "My cloud · DigitalOcean",
};

function formatAmount(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

/** "1.5 CPU / 3 GB" from the reserved size, or null when the row has none. */
export function computerSizeLabel(subject: { cpu?: number | null; ram?: number | null }): string | null {
  const cpu = Number(subject.cpu), ram = Number(subject.ram);
  if (!Number.isFinite(cpu) || !Number.isFinite(ram) || cpu <= 0 || ram <= 0) return null;
  return `${formatAmount(cpu)} CPU / ${formatAmount(ram)} GB`;
}

/** Where an agent's computer runs and how big it is, for list cards. */
export interface AgentComputerPair {
  /** Fixed until attach exists: every agent has its own computer. */
  relation: "On its own computer";
  /** Null when the row carries no placement at all: nothing is guessed. */
  placement: string | null;
  size: string | null;
}

export function agentComputerPair(subject: ComputerPlacementSubject & { cpu?: number | null; ram?: number | null }): AgentComputerPair {
  const placed = Boolean(subject.deployment_mode || subject.computer_substrate);
  return {
    relation: "On its own computer",
    placement: placed ? COMPUTER_PLACEMENT_LABEL[computerPlacementFor(subject)] : null,
    size: computerSizeLabel(subject),
  };
}

/** "Hivra Cloud · 1.5 CPU / 3 GB", or whichever parts the row has. */
export function agentComputerPairDetail(pair: Pick<AgentComputerPair, "placement" | "size">): string {
  return [pair.placement, pair.size].filter(Boolean).join(" · ");
}

/**
 * The linked pair, told from the agent's side: "on its own computer (Hivra
 * Cloud · 1.5 CPU / 3 GB)". Every agent has its own computer until attach
 * exists, so the relation is fixed; placement and size come from the row.
 */
export function agentComputerPairLabel(subject: ComputerPlacementSubject & { cpu?: number | null; ram?: number | null }): string {
  const detail = agentComputerPairDetail(agentComputerPair(subject));
  return detail ? `on its own computer (${detail})` : "on its own computer";
}

// ── Launch Review ──────────────────────────────────────────────────────────

/** Surfaces the owner watches the agent through, in the order Review lists them. */
const WATCH_ORDER: readonly AgentSurfaceId[] = ["chat", "aeon", "terminal", "box", "files", "browser", "git"];

function listPhrase(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * The launch Review's "You can see its work in" row, built from the same
 * surfaces the agent page will show (ATT-15). `browser` is the owner's launch
 * choice for browser-capable agents: with it off the Browser tab only explains
 * how to turn it on, so Review doesn't offer it as a place to watch.
 */
export function agentLaunchWatchRow(
  subject: AgentSurfaceSubject & ComputerPlacementSubject,
  options: { browser: boolean },
): string {
  const def = catalogAgent(subject.type);
  const surfaces = agentSurfacesFor(subject);
  return listPhrase(WATCH_ORDER.filter((id) => surfaces.includes(id) && (id !== "browser" || options.browser))
    .map((id) => id === "browser" ? "Browser (view-only)" : agentSurfaceLabel(id, def)));
}
