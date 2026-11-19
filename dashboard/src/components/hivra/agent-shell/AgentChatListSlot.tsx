"use client";

import { createContext, useContext } from "react";

/**
 * Where an agent's chat list renders.
 *
 * The agent view's sidebar owns the place on screen; the chat owns the list
 * (its sessions, which one is open, which are working). The sidebar provides an
 * empty element through this context and the chat portals its list into it, so
 * the list's state stays with the chat and nothing has to be lifted out of it.
 *
 * Without a provider (or before the element mounts) the chat keeps its own
 * inline list, so other places that render a chat are unchanged.
 */
export interface AgentChatListSlot {
  /** The element the chat list renders into, or null until it has mounted. */
  element: HTMLElement | null;
  /** Called when the owner opens or starts a chat from the list, so the view can show the chat. */
  onChatOpened: () => void;
}

export const AgentChatListSlotContext = createContext<AgentChatListSlot | null>(null);

export function useAgentChatListSlot(): AgentChatListSlot | null {
  return useContext(AgentChatListSlotContext);
}
