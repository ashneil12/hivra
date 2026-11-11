"use client";

// Adapted from MonoCode (MIT License, Copyright (c) 2026 Nick); see THIRD_PARTY_LICENSES/monocode.txt.
//
// One message in the transcript, laid out the way MonoCode's AgentTranscript
// lays out a turn. The owner's message is a right-aligned bubble with no
// avatar. The agent's turn opens with a small chip (its emoji or initial and
// its name), then the work trail, then the reply, then calm outcome lines and
// icon-only copy and feedback buttons that appear on hover or focus.

import { memo, useEffect, useState } from "react";
import { Check, Copy, MessageSquare, ThumbsDown, ThumbsUp } from "lucide-react";
import { copyTextToClipboard } from "@/lib/client/clipboard";
import { AssistantMarkdown } from "./AgentMarkdown";
import { WorkTrail } from "./WorkTrail";
import type { ChatMessage } from "./types";
import styles from "./chat.module.css";

/** A reply as it reads: the agent's text, then the warnings it raised. */
export function replyMarkdown(m: ChatMessage): string {
  return [m.text, ...(m.warnings || []).map((w) => "⚠ " + w)].filter(Boolean).join("\n\n");
}

// Copy the whole reply. Icon-only; the check shows for a moment once copied.
function MessageCopy({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  // The "Copied" flash clears on its own timer, and that timer is cleared on unmount.
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      aria-label="Copy message"
      title={copied ? "Copied" : "Copy message"}
      className={`${styles.ghostButton} ${copied ? styles.ghostOk : ""}`}
      onClick={() => {
        void copyTextToClipboard(text).then((ok) => {
          if (ok) setCopied(true);
        });
      }}
    >
      {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
    </button>
  );
}

// Thumbs up / down on an assistant reply; the selected thumb stays filled.
// Firing the analytics event is the caller's job (so it can attach
// instance/message context).
function MessageFeedback({ rating, onRate }: { rating?: "up" | "down"; onRate: (r: "up" | "down") => void }) {
  return (
    <>
      <button
        type="button"
        aria-label="Good response"
        aria-pressed={rating === "up"}
        title="Good response"
        onClick={() => onRate("up")}
        className={`${styles.ghostButton} ${rating === "up" ? styles.ghostOn : ""}`}
      >
        <ThumbsUp size={14} aria-hidden fill={rating === "up" ? "currentColor" : "none"} />
      </button>
      <button
        type="button"
        aria-label="Bad response"
        aria-pressed={rating === "down"}
        title="Bad response"
        onClick={() => onRate("down")}
        className={`${styles.ghostButton} ${rating === "down" ? styles.ghostOn : ""}`}
      >
        <ThumbsDown size={14} aria-hidden fill={rating === "down" ? "currentColor" : "none"} />
      </button>
    </>
  );
}

/** One message in the transcript. Memoized on its message object: a streamed token
 *  replaces only the streaming reply, so every other row skips re-rendering. */
interface AgentTurnProps {
  m: ChatMessage;
  index: number;
  agentName: string;
  emoji?: string | null;
  historySessionId: string | null;
  rating?: "up" | "down";
  onRate: (index: number, rating: "up" | "down") => void;
  onOpenHistory: (sessionId: string) => void;
}

export const AgentTurn = memo(function AgentTurn({ m, index: i, agentName, emoji, historySessionId, rating, onRate, onOpenHistory }: AgentTurnProps) {
  if (m.role === "user") {
    return (
      <div className={`hivra-chat-message ${styles.turn} ${styles.turnUser}`}>
        <div className={styles.userBubble}>{m.text}</div>
      </div>
    );
  }
  const reply = replyMarkdown(m);
  const mark = (emoji || "").trim() || agentName.trim().charAt(0).toUpperCase() || "A";
  return (
    <div className={`hivra-chat-message ${styles.turn} ${styles.turnAssistant}`}>
      <div className={styles.chip}>
        <span className={styles.chipMark} aria-hidden>{mark}</span>
        <span className={styles.chipName}>{agentName}</span>
      </div>
      <WorkTrail tools={m.tools} streaming={m.streaming} outcome={m.outcome} hasText={Boolean(m.text.trim())} />
      {reply ? <AssistantMarkdown text={reply} streaming={m.streaming} /> : null}
      {m.streaming && m.pending ? (
        <div className={styles.turnState} role="status" aria-label="Waiting for the agent update">{m.pending}</div>
      ) : null}
      {!m.streaming && m.outcome === "unknown" ? (
        <div className={styles.turnState} role="status" aria-label="Finished while you were away">
          {historySessionId ? "Finished while you were away — open the history to see the full reply" : "Finished while you were away"}
        </div>
      ) : null}
      {!m.streaming && m.outcome === "unknown" && historySessionId ? (
        <button type="button" onClick={() => onOpenHistory(historySessionId)} className={styles.softButton}>
          <MessageSquare size={12} aria-hidden /> Open the history
        </button>
      ) : null}
      {!m.streaming && (m.outcome === "stopped" || m.outcome === "error" || m.outcome === "disconnected") ? (
        <div className={styles.turnState} role="status" aria-label={m.outcome === "stopped" ? "Response stopped" : m.outcome === "disconnected" ? "Reconnecting to the agent" : "Response failed"}>
          {m.outcome === "stopped" ? "Stopped" : m.outcome === "disconnected" ? "Connection lost. Your agent keeps working; this reply fills in when it reconnects." : "Could not complete response"}
        </div>
      ) : null}
      {m.text && !m.streaming ? (
        <div className={styles.actions}>
          <MessageCopy text={m.text} />
          <MessageFeedback rating={rating} onRate={(r) => onRate(i, r)} />
        </div>
      ) : null}
    </div>
  );
});
