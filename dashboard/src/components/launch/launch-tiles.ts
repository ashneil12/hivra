// The tiles Launch offers: one per agent or computer that can start today.
// Shared so other pages (Home's "Try next") name and describe a thing in the
// same words Launch does.

import {
  AppWindow,
  Bot,
  Boxes,
  Code2,
  Cpu,
  Monitor,
  Orbit,
  Terminal,
  TerminalSquare,
  Triangle,
  Users,
  Waves,
  type LucideIcon,
} from "lucide-react";

import { getAgent } from "@/lib/hivra/agent-catalog";
import { HERMES_LAUNCH_PROFILE } from "@/lib/hermes-computer/launch-lane";
import { PROFILE_DETAILS, type LaunchProfileId } from "@/lib/launch/contracts";

export type ChooseTile = { id: LaunchProfileId; name: string; description: string; icon: LucideIcon | null };

export const AGENT_TILES: readonly ChooseTile[] = ([
  { id: "claude-code", name: "Claude Code", description: "Anthropic's coding agent. Sign in with your Claude account, or run it on Hivra credits.", icon: Code2 },
  { id: "codex", name: "Codex", description: "OpenAI's coding agent. Sign in with ChatGPT after it opens.", icon: Boxes },
  { id: "hermes", name: "Hermes", description: "A general-purpose agent for research and automation.", icon: Bot },
  // Hermes as a Hivra computer, where that lane is on: it takes the Hermes tile's place.
  { id: "hermes-computer", name: "Hermes", description: "The official Hermes Agent, in its own web UI, on its own computer.", icon: Bot },
  { id: "openclaw", name: "OpenClaw", description: "An agent you reach from your messaging apps, on a computer that stays on.", icon: Cpu },
  { id: "agent-zero", name: "Agent Zero", description: "An autonomous agent with its own dashboard and browser.", icon: Orbit },
  { id: "openbot", name: "OpenBot", description: "CopilotKit's open-source AI coworkers, in OpenBot's own workspace.", icon: Users },
  { id: "nuphos", name: "Nuphos", description: "Claude Code your team chats with from the Nuphos app, on its own computer.", icon: Users },
  { id: "aeon", name: "Aeon", description: "An agent framework that runs its work on your GitHub.", icon: Triangle },
  { id: "deepseek-harness", name: "DeepSeek Harness", description: "DeepSeek's coding agent, in its own interface. Runs on DeepSeek V4.1 Flash.", icon: Waves },
] satisfies ChooseTile[]).filter(tile => getAgent(PROFILE_DETAILS[tile.id].runtimeId)?.available === true);

export const COMPUTER_TILES: readonly ChooseTile[] = [
  { id: "ubuntu-server", name: "Linux computer", description: "A light Linux computer with a terminal and files. No desktop.", icon: Terminal },
  { id: "ubuntu-desktop", name: "Ubuntu Desktop", description: "A desktop, terminal and files you open in your browser.", icon: Monitor },
  { id: "linux-terminal", name: "Linux Sandbox", description: "A locked-down Linux terminal on a server you've connected.", icon: TerminalSquare },
  { id: "omarchy", name: "Omarchy", description: "A ready-made Omarchy desktop you open in your browser.", icon: null },
  { id: "windows", name: "Windows (your ISO)", description: "Install Windows from your own ISO on a server you connected.", icon: AppWindow },
];

/** The agent tiles Launch shows. Hermes has one tile, for the lane in use, and
 * a self-hosted installation has no Hivra Cloud, so an agent that runs only
 * there isn't offered. */
export function offeredAgentTiles({ selfHosted, hermesProfile = HERMES_LAUNCH_PROFILE }: {
  selfHosted: boolean;
  hermesProfile?: LaunchProfileId;
}): ChooseTile[] {
  return AGENT_TILES
    .filter(tile => (tile.id !== "hermes" && tile.id !== "hermes-computer") || tile.id === hermesProfile)
    .filter(tile => !selfHosted || PROFILE_DETAILS[tile.id].ownServer);
}
