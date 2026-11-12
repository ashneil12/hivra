// What the command panel can offer beside one agent's own web UI.
//
// Everything is derived from the catalog entry (`surface: "dashboard"`, never a
// hard-coded agent list) and from what the agent's row says its computer
// supports today (the server's Manage capability map, the tabs the page draws).
// An action the agent or its computer cannot do is not in the list at all, and
// every action names the existing flow it runs; nothing here talks to a server.
// Pure and client-safe.

import type { HivraAgent } from "@/lib/hivra/agent-api";
import { getAgent as catalogAgent } from "@/lib/hivra/agent-catalog";
import { veniceModelName } from "@/lib/venice/model-catalog";
import { agentSoftwareSubject } from "@/lib/hivra/agent-cli-status";
import { agentSoftwareDisplayName } from "@/lib/hivra/agent-software-names";
import type { ManageSectionId } from "@/lib/hivra/manage-sections";
import type { AgentSurfaceId } from "@/lib/agent-computers/agent-surfaces";

export const PANEL_ACTION_IDS = ["update", "restart", "terminal", "browser", "files", "model", "size", "channels"] as const;
export type PanelActionId = (typeof PANEL_ACTION_IDS)[number];

/** Where an action goes: the existing flow it runs. */
export type PanelActionTarget =
  /** The agent-software update (`update_runtime`), the one Manage › Updates runs. */
  | { kind: "update" }
  /** The computer's restart (`restart`), the one Manage › Overview runs. */
  | { kind: "restart" }
  /** Another surface of the agent page (Terminal, Files, Browser, the agent's own UI). */
  | { kind: "surface"; surface: AgentSurfaceId; opening: string }
  /** A section of Manage (Model & tools, Resources). */
  | { kind: "manage"; section: ManageSectionId; opening: string };

export interface PanelAction {
  id: PanelActionId;
  label: string;
  /** One plain line under the label. */
  description: string;
  /** Visible before the owner customizes anything. */
  defaultShown: boolean;
  target: PanelActionTarget;
}

export const PANEL_SUGGESTION_IDS = ["channels"] as const;
export type PanelSuggestionId = (typeof PANEL_SUGGESTION_IDS)[number];

export interface PanelSuggestion {
  id: PanelSuggestionId;
  title: string;
  body: string;
  /** Where "Set up" goes. A suggestion with no destination is never listed. */
  target: Extract<PanelActionTarget, { kind: "surface" }>;
  /** What the status line says once it has opened. */
  opened: string;
}

export interface PanelCapabilities {
  /** The agent's name as owners see it ("OpenClaw"). */
  name: string;
  actions: PanelAction[];
  suggestions: PanelSuggestion[];
}

function isAvailableOrBlocked(cap: { state: string } | null | undefined): boolean {
  return Boolean(cap) && cap?.state !== "unavailable";
}

/**
 * The command panel's content for this agent, or null when the agent's main
 * screen is not its own web UI (a chat agent or a computer has none).
 * `surfaces` is the list of tabs the agent page actually shows.
 */
export function commandPanelCapabilities(agent: HivraAgent, surfaces: readonly string[]): PanelCapabilities | null {
  const def = catalogAgent(agent.type);
  if (def?.surface !== "dashboard") return null;
  const name = def.name;
  const manage = agent.manage;
  const hasSurface = (id: AgentSurfaceId) => surfaces.includes(id);
  const actions: PanelAction[] = [];

  // The same gate as Manage › Updates: an agent Hivra can check, on a computer
  // whose connection service Manage can update.
  const subject = agentSoftwareSubject(agent);
  if (subject && isAvailableOrBlocked(manage?.connectionServiceUpdate)) {
    actions.push({
      id: "update",
      label: `Update ${agentSoftwareDisplayName(subject.app, name)}`,
      // Hermes has no Hivra-tested version: the button runs its own `hermes update`.
      description: subject.app === "hermes" ? "Runs hermes update for the newest release" : "Move it to the version Hivra has tested",
      defaultShown: true,
      target: { kind: "update" },
    });
  }
  if (isAvailableOrBlocked(manage?.power.restart)) {
    actions.push({
      id: "restart",
      label: "Restart",
      description: "Restarts its computer",
      defaultShown: true,
      target: { kind: "restart" },
    });
  }
  if (hasSurface("box")) {
    actions.push({
      id: "terminal",
      label: "Terminal",
      description: "A command line on its computer",
      defaultShown: true,
      target: { kind: "surface", surface: "box", opening: "Opening Terminal" },
    });
  }
  if (hasSurface("browser")) {
    actions.push({
      id: "browser",
      label: "Browser",
      description: "See what it is browsing",
      defaultShown: true,
      target: { kind: "surface", surface: "browser", opening: "Opening Browser" },
    });
  }
  if (hasSurface("files")) {
    actions.push({
      id: "files",
      label: "Files",
      description: "Browse its files",
      defaultShown: true,
      target: { kind: "surface", surface: "files", opening: "Opening Files" },
    });
  }
  // The model is changed in Manage › Model & tools, for agents that can bill a
  // model to Hivra credits or take another provider (the server decides whether
  // this computer has the section).
  if ((def.llm || def.managedVenice) && manage?.sections.includes("model")) {
    actions.push({
      id: "model",
      label: "Model",
      description: agent.type !== "hermes" && agent.llm_config?.model ? veniceModelName(agent.llm_config.model) : "Choose which model it uses",
      defaultShown: true,
      target: { kind: "manage", section: "model", opening: "Opening model settings" },
    });
  }
  if (manage?.sections.includes("resources") && isAvailableOrBlocked(manage.resize.cap)) {
    actions.push({
      id: "size",
      label: "Computer size",
      description: "Change CPU and memory",
      defaultShown: true,
      target: { kind: "manage", section: "resources", opening: "Opening computer size" },
    });
  }

  // OpenClaw is the agent you reach from messaging apps, and it links them in
  // its own screen. Nothing else in the catalog has a place to set chat apps up.
  const suggestions: PanelSuggestion[] = [];
  if (def.id === "openclaw" && hasSurface("aeon")) {
    const channels: PanelSuggestion["target"] = { kind: "surface", surface: "aeon", opening: `Opening ${name}` };
    actions.push({
      id: "channels",
      label: "Chat apps",
      description: "Telegram, WhatsApp and Signal",
      defaultShown: false,
      target: channels,
    });
    suggestions.push({
      id: "channels",
      title: "Chat from your phone",
      body: `Reach ${name} on Telegram, WhatsApp, Signal and other chat apps. You link them in ${name} itself. Optional, and it won't ask twice.`,
      target: channels,
      opened: `Opened ${name}. Look for Channels in its menu.`,
    });
  }

  return { name, actions, suggestions };
}
