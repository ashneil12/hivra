// Per-agent calls to action for the free tools. One place decides which
// sign-up link and which sentence each agent gets, so a tool cannot promise
// for Codex what is only verified for Claude Code.
//
// What is true today (lib/blog/runtime-facts.ts): a Claude Code or Codex run
// started inside tmux in the computer's Terminal tab keeps going after the
// laptop closes, and on Claude Code so does work sent from Telegram. Nothing is
// promised either way about browser-chat runs, and Telegram is never promised
// for Codex.

import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE } from "@/lib/blog/plan-facts";
import { TOOLS_CTA } from "@/lib/tools/tool-catalog";

export type CtaAgent = "claude" | "codex" | "other";

/** Which agent a command line starts: the first word decides. */
export function ctaAgentFor(command: string): CtaAgent {
  const program = command.trim().split(/\s+/)[0]?.split("/").pop()?.toLowerCase() ?? "";
  if (program === "claude") return "claude";
  if (program === "codex") return "codex";
  return "other";
}

export function agentButton(agent: CtaAgent): { label: string; href: string } {
  if (agent === "claude") return { label: "Run Claude Code on Hivra", href: TOOLS_CTA.claudeCodeHref };
  if (agent === "codex") return { label: "Run Codex on Hivra", href: TOOLS_CTA.codexHref };
  return { label: "Get started on Hivra", href: TOOLS_CTA.primaryHref };
}

/** How a run is kept going on a Hivra computer, for this agent. */
export function tmuxOnHivraSentence(agent: CtaAgent): string {
  if (agent === "claude") {
    return "Start it inside tmux in a Hivra computer's Terminal tab, or send it from Telegram, and it keeps going after you close the laptop.";
  }
  if (agent === "codex") {
    return "Start it inside tmux in a Hivra computer's Terminal tab, and it keeps going after you close the laptop.";
  }
  return "Hivra runs Claude Code and Codex on a computer of their own: start a run inside tmux in its Terminal tab, and it keeps going after you close the laptop.";
}

/** The plan, by price and size, from the billing source of truth. */
export const PLAN_LINE = `Plans start at ${ENTRY_PLAN_PRICE} a month for ${ENTRY_PLAN_SIZE}, and paid plans are not paused for inactivity.`;
