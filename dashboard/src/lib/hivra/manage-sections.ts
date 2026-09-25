// Manage's sections: their ids (the ?section= value), labels and order, and
// the public shape of the capability map the server sends with every agent
// (manage-capabilities.ts computes it). Pure and client-safe.

import type { ComputerPlacement } from "@/lib/agent-computers/agent-surfaces";

export const MANAGE_SECTION_IDS = [
  "overview", "agents", "model", "resources", "recovery", "network", "updates", "command", "advanced",
] as const;
export type ManageSectionId = (typeof MANAGE_SECTION_IDS)[number];

/** Section names never repeat a word from the page's own navigation. */
export const MANAGE_SECTION_LABEL: Record<ManageSectionId, string> = {
  overview: "Overview",
  agents: "Agents",
  model: "Model & tools",
  resources: "Resources",
  recovery: "Recovery",
  network: "Private network",
  updates: "Updates",
  command: "Run a command",
  advanced: "Advanced",
};

export function isManageSectionId(value: unknown): value is ManageSectionId {
  return typeof value === "string" && (MANAGE_SECTION_IDS as readonly string[]).includes(value);
}

/**
 * One capability. "blocked" means this computer supports it but not right now
 * (say, while it is stopped); "unavailable" means it doesn't support it at all.
 * Both carry a stable code and a plain-English reason to show the owner.
 */
export type ManageCap =
  | { state: "available" }
  | { state: "blocked"; code: string; reason: string }
  | { state: "unavailable"; code: string; reason: string };

export type ManageVariant =
  | "ubuntu-proxmox"
  | "prepared"
  | "windows-my-server"
  | "my-cloud"
  | "linux-sandbox"
  | "digitalocean"
  | "chat-agent"
  | "dashboard-agent"
  | "my-cloud-agent";

export type ManageResizeKind = "proxmox-envelope" | "hetzner-server-type" | "gvisor-limits" | "fixed";

export interface ManageDetail {
  id: string;
  label: string;
  value: string;
  /** Offer a Copy button next to it. */
  copy?: boolean;
  /** The value is an ISO timestamp for the viewer's own locale. */
  format?: "date";
}

export interface ManageCapabilities {
  version: 1;
  kind: "agent" | "computer";
  variant: ManageVariant;
  placement: { id: ComputerPlacement; label: string };
  /** The sections Manage shows for this computer, in nav order. */
  sections: ManageSectionId[];
  rename: ManageCap;
  power: {
    start: ManageCap;
    stop: ManageCap;
    /** null: this kind of computer has no restart control. */
    restart: ManageCap | null;
    /**
     * Force off and Force restart (Advanced): switch the computer off at once
     * instead of asking it to shut down. null: this kind of computer has no
     * such control (a Linux Sandbox or a DigitalOcean session).
     */
    forceStop: ManageCap | null;
    forceRestart: ManageCap | null;
    /** DigitalOcean sessions pause and resume rather than stop and start. */
    labels?: { start: "Resume"; stop: "Pause" };
  };
  resize: { kind: ManageResizeKind; cap: ManageCap };
  /**
   * Live usage and uptime (Overview), read from the computer's host by
   * GET /api/hivra/agents/[id]/usage. Unavailable where Hivra has no way to
   * read it; the reason says what the owner can use instead.
   */
  usage: ManageCap | null;
  restorePoints: (ManageCap & { maximum?: number }) | null;
  folderRecovery: ManageCap | null;
  /** Static eligibility; the panel still reports the live connection. */
  privateNetwork: ManageCap | null;
  connectionServiceUpdate: ManageCap | null;
  /** Claude Code or Codex and the version Hivra has tested, for the Updates section. */
  agentCli: { name: "claude-code" | "codex"; vetted: string } | null;
  /** The Agents section (adding an agent to this computer). */
  attachAgents: boolean;
  /** What the agent is told about its computer (Computer Contract). */
  contract: boolean;
  export: ManageCap | null;
  destroy: { cap: ManageCap; extraWarning: "provider-resources" | null };
  /** Read-only, public facts for Advanced. Never host names or private addresses. */
  details: ManageDetail[];
  /** Everything this computer can't do, with why, listed under Advanced. */
  notAvailable: Array<{ capability: string; reason: string }>;
}

/** A Cap the owner can act on now. */
export function capAvailable(cap: ManageCap | null | undefined): boolean {
  return cap?.state === "available";
}

/** A Cap whose section should be shown (available now, or supported later). */
export function capShown(cap: ManageCap | null | undefined): boolean {
  return cap?.state === "available" || cap?.state === "blocked";
}

/** The reason to show beside a control that can't be used, or null. */
export function capReason(cap: ManageCap | null | undefined): string | null {
  return cap && cap.state !== "available" ? cap.reason : null;
}

/**
 * The map says another operation holds this computer (one the page didn't
 * start, such as a desktop preparation), so the controls it blocks come back
 * only when the computer is read again after that operation ends.
 */
export function manageAwaitsOperation(map: ManageCapabilities | null | undefined): boolean {
  if (!map) return false;
  const caps: Array<ManageCap | null | undefined> = [
    map.power.start, map.power.stop, map.power.restart, map.power.forceStop, map.power.forceRestart,
    map.resize.cap, map.restorePoints,
    map.folderRecovery, map.privateNetwork, map.connectionServiceUpdate, map.export, map.destroy.cap,
  ];
  return caps.some((cap) => cap?.state === "blocked" && cap.code === "operation_in_progress");
}
