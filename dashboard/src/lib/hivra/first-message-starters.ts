import type { AgentKind } from "@/lib/hivra/agent-adapters";

/**
 * One-tap first messages for an empty Hivra chat. Tapping one fills the
 * composer; it never sends. Only agents whose chat is the Hivra composer
 * (Claude Code and Codex) appear here: Hermes, OpenClaw, Agent Zero and
 * DeepSeek Harness open their own web UI, and Hivra does not type into it.
 */
export type FirstMessageStarters = readonly [string, string, string];

const CLAUDE_CODE: FirstMessageStarters = [
  "Clone a GitHub repo and give me a tour of it",
  "Build a small web app and show me it running",
  "What can you do on this computer?",
];

const CODEX: FirstMessageStarters = [
  "Clone a GitHub repo and show me where to start reading",
  "Write a small script that tidies a folder, and run it",
  "What can you do on this computer?",
];

/** Starters for the chat's agent, or null when it has no first-message list. */
export function firstMessageStarters(agentKind: AgentKind | undefined): FirstMessageStarters | null {
  if (agentKind === "claude") return CLAUDE_CODE;
  if (agentKind === "codex") return CODEX;
  return null;
}
