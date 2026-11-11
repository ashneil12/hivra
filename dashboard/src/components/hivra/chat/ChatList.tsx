"use client";

// Adapted from MonoCode (MIT License, Copyright (c) 2026 Nick); see THIRD_PARTY_LICENSES/monocode.txt.
//
// The agent's chats as sidebar rows, after MonoCode's sidebar: a "New chat"
// row first, then one row per chat, the open one filled, a working orb on a
// chat that is running, and a delete that shows on hover and asks twice.
// The same list renders into the agent sidebar's slot, or inline when a chat
// is shown somewhere with no sidebar.

import { Plus, Trash2, X } from "lucide-react";
import { ThinkingOrb } from "@/components/ui/ThinkingOrb";
import type { Session } from "./types";
import styles from "./chat.module.css";

interface ChatListProps {
  sessions: Session[];
  activeId: string;
  busyIds: ReadonlySet<string>;
  /** The chat whose delete has been tapped once and waits for the second tap. */
  armedId: string | null;
  onSelect: (session: Session) => void;
  onNewChat: () => void;
  onDelete: (id: string) => void;
  /** Only the phone drawer has one: it closes the drawer. */
  onClose?: () => void;
}

export function ChatList({ sessions, activeId, busyIds, armedId, onSelect, onNewChat, onDelete, onClose }: ChatListProps) {
  return (
    <div className={styles.list}>
      <div className={styles.listHead}>
        <button type="button" onClick={onNewChat} className={styles.newRow}>
          <Plus size={15} aria-hidden className={styles.rowIcon} />
          <span>New chat</span>
        </button>
        {onClose ? (
          <button type="button" aria-label="Close chats" onClick={onClose} className={styles.closeButton}>
            <X size={15} aria-hidden />
          </button>
        ) : null}
      </div>
      <div className={styles.rows}>
        {sessions.map((s) => {
          const isActive = s.id === activeId;
          const armed = armedId === s.id;
          const running = busyIds.has(s.id);
          return (
            <div key={s.id} className={`${styles.row} ${isActive ? styles.rowActive : ""}`}>
              <button type="button" aria-current={isActive ? "true" : undefined} onClick={() => onSelect(s)} className={styles.rowMain}>
                <span className={styles.rowLead} aria-hidden={!running}>
                  {running ? <ThinkingOrb size={20} state="working" label="Working" /> : <span className={styles.rowDot} />}
                </span>
                <span className={styles.rowTitle}>{s.title || "New chat"}</span>
              </button>
              {sessions.length > 1 ? (
                armed ? (
                  <button type="button" aria-label="Confirm delete chat" onClick={() => onDelete(s.id)} className={styles.rowConfirm}>
                    Delete?
                  </button>
                ) : (
                  <button type="button" aria-label={running ? "Stop and delete chat" : "Delete chat"} onClick={() => onDelete(s.id)} className={styles.rowDelete}>
                    <Trash2 size={13} aria-hidden />
                  </button>
                )
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
