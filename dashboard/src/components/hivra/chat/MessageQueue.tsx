"use client";

// Adapted from MonoCode (MIT License, Copyright (c) 2026 Nick); see THIRD_PARTY_LICENSES/monocode.txt.
//
// What the owner sent while the agent was still working: a card above the
// composer, one row per message, each with edit and remove. The messages go
// out in order as soon as the reply ends. A stopped reply pauses the queue
// ("Queue paused because you stopped") until Resume. MonoCode's Steer is left
// out: the agent's CLI takes no message in the middle of a turn.

import { useEffect, useRef, useState } from "react";
import { Check, ListEnd, Pause, Pencil, Play, Trash2, X } from "lucide-react";
import styles from "./chat.module.css";

export interface QueuedMessage {
  id: string;
  text: string;
  /** Files already uploaded to the computer, sent with the message. */
  attachments: { name: string; path: string }[];
}

export function MessageQueue({ messages, paused, onDelete, onEdit, onResume }: {
  messages: readonly QueuedMessage[];
  paused?: boolean;
  onDelete: (id: string) => void;
  onEdit: (id: string, text: string) => void;
  onResume: () => void;
}) {
  const [pickedId, setEditingId] = useState<string>();
  const [draft, setDraft] = useState("");
  const editing = useRef<HTMLTextAreaElement>(null);
  // A row that went away (sent, or removed) cannot stay in edit mode.
  const editingId = pickedId && messages.some((message) => message.id === pickedId) ? pickedId : undefined;
  useEffect(() => {
    if (editingId) editing.current?.focus();
  }, [editingId]);
  if (messages.length === 0) return null;

  const startEdit = (message: QueuedMessage) => {
    setEditingId(message.id);
    setDraft(message.text);
  };
  const cancelEdit = () => {
    setEditingId(undefined);
    setDraft("");
  };
  const saveEdit = (message: QueuedMessage) => {
    if (!draft.trim() && message.attachments.length === 0) return;
    onEdit(message.id, draft);
    cancelEdit();
  };

  return (
    <div className={styles.queue} data-message-queue>
      <div className={styles.queueCard} data-message-queue-card>
        {paused ? (
          <div className={styles.queuePaused}>
            <Pause size={14} aria-hidden />
            <span className={styles.queuePausedText}>Queue paused because you stopped the reply</span>
            <button type="button" onClick={onResume} className={styles.queueButton}>
              <Play size={14} aria-hidden /> Resume
            </button>
          </div>
        ) : null}
        {messages.map((message, index) => {
          const isEditing = editingId === message.id;
          const label = message.text.trim() || `${message.attachments.length} attachment${message.attachments.length === 1 ? "" : "s"}`;
          return (
            <div key={message.id} className={`${styles.queueRow} ${index > 0 ? styles.queueRowRule : ""}`}>
              <ListEnd size={14} aria-hidden className={styles.queueLead} />
              {isEditing ? (
                <>
                  <textarea
                    ref={editing}
                    aria-label="Edit queued message"
                    value={draft}
                    rows={1}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing) return;
                      if (event.key === "Escape") {
                        event.preventDefault();
                        cancelEdit();
                      } else if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        saveEdit(message);
                      }
                    }}
                    className={styles.queueEdit}
                  />
                  <button type="button" title="Save queued message" aria-label="Save queued message" disabled={!draft.trim() && message.attachments.length === 0} onClick={() => saveEdit(message)} className={styles.queueIcon}>
                    <Check size={14} aria-hidden />
                  </button>
                  <button type="button" title="Cancel queued message edit" aria-label="Cancel queued message edit" onClick={cancelEdit} className={styles.queueIcon}>
                    <X size={14} aria-hidden />
                  </button>
                </>
              ) : (
                <>
                  <div className={styles.queueText} title={label}>{label}</div>
                  <button type="button" title="Edit queued message" aria-label="Edit queued message" onClick={() => startEdit(message)} className={styles.queueIcon}>
                    <Pencil size={14} aria-hidden />
                  </button>
                  <button type="button" title="Remove queued message" aria-label="Remove queued message" onClick={() => onDelete(message.id)} className={styles.queueIcon}>
                    <Trash2 size={14} aria-hidden />
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
