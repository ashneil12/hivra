// Catalog-derived marketing copy helpers.
//
// Single source for "which agents can I launch right now" phrasing, so every
// surface that lists the roster (landing cards, hero rotation, FAQ, dashboard
// empty state) reflects agent-catalog.ts the moment an agent's `available` flag
// flips. No hand-typed lists to drift, over-promise, or go stale when a new
// agent ships.

import { AGENTS } from "@/lib/hivra/agent-catalog";

/** Display names of every currently-launchable agent, in catalog order. */
function availableAgentNames(): string[] {
  return AGENTS.map((agent) => agent.name);
}

/**
 * Human-readable list of launchable agents, e.g. "Hermes, Claude Code, Codex,
 * or Aeon". Conjunction defaults to "or".
 */
export function listAvailableAgents(conjunction: "or" | "and" = "or"): string {
  const names = availableAgentNames();
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")}, ${conjunction} ${names[names.length - 1]}`;
}
