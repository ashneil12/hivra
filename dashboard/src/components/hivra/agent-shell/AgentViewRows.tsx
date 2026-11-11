"use client";

// Adapted from MonoCode (MIT License, Copyright (c) 2026 Nick); see THIRD_PARTY_LICENSES/monocode.txt.

import type { AgentShellGroup } from "./useAgentSurfaceNav";
import styles from "./AgentViewRows.module.css";

/**
 * The open agent's or computer's views, one sidebar row each. The chat's own
 * list (its sessions and a new-chat button) sits indented under the Chat row,
 * in a slot the chat fills (see AgentChatListSlot).
 *
 * It owns no state: the page decides which surface is open, this draws the
 * rows and reports the choice.
 */
export function AgentViewRows<T extends string>({
  rows, activeRowId, onOpenRow, onChoose, hasChat, chatSlotRef,
}: {
  rows: AgentShellGroup<T>[];
  activeRowId: string | null;
  onOpenRow: (row: AgentShellGroup<T>) => void;
  /** Called after a row is chosen, so a phone drawer can close behind it. */
  onChoose: () => void;
  /** Whether the agent has a chat to list. */
  hasChat: boolean;
  chatSlotRef: (element: HTMLElement | null) => void;
}) {
  return (
    <nav aria-label="Views" className={styles.rows}>
      {rows.map((row) => (
        <div key={row.id} className={styles.group}>
          <button type="button" data-view-row={row.id} className={styles.row} aria-label={row.label}
            aria-current={row.id === activeRowId ? "page" : undefined}
            onClick={() => { onOpenRow(row); onChoose(); }}>
            {row.icon}<span>{row.label}</span>
          </button>
          {row.id === "chat" && hasChat ? <div ref={chatSlotRef} className={styles.chatList} data-agent-chat-list="" /> : null}
        </div>
      ))}
    </nav>
  );
}
