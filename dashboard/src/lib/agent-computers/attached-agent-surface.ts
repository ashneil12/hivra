// Where an agent added to a computer shows up (design 5.8): the computer's own
// page gains a Chat tab for it, reached through the computer's gateway. Kept
// apart from agent-surfaces.ts, which decides a row's own surfaces. Client-safe.

import type { AgentSurfaceId } from "./agent-surfaces";

/** Sent on window when an agent on a computer was added, changed or removed, so the page's tabs follow. */
export const ATTACHED_AGENTS_CHANGED_EVENT = "hivra:attached-agents-changed";

export interface AttachedAgentChatTarget {
  computerId: string;
  installationId: string;
  agentName: string;
}

/**
 * The computer's surfaces with the attached agent's Chat tab first, only when
 * that agent is ready and the computer's own workspace is up (its Files tab
 * shows the gateway answers). Chat is first in every page's display order.
 */
export function withAttachedAgentChat(surfaces: readonly AgentSurfaceId[], attached: AttachedAgentChatTarget | null): AgentSurfaceId[] {
  if (!attached || !surfaces.includes("files") || surfaces.includes("chat")) return [...surfaces];
  return ["chat", ...surfaces];
}

export function announceAttachedAgentsChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(ATTACHED_AGENTS_CHANGED_EVENT));
}
