"use client";

// Adapted from MonoCode (MIT License, Copyright (c) 2026 Nick); see THIRD_PARTY_LICENSES/monocode.txt.
//
// An empty chat, after MonoCode's EmptySession: one quiet line asking what to
// work on, then the starters as plain rows. The agent's mark is a small
// emoji or initial, not a coloured medallion.

import { ArrowRight } from "lucide-react";
import styles from "./chat.module.css";

interface ChatEmptyProps {
  agentName: string;
  emoji?: string | null;
  /** The sentence under the greeting. */
  intro: string;
  starters: readonly string[];
  disabled?: boolean;
  onPick: (starter: string) => void;
}

export function ChatEmpty({ agentName, emoji, intro, starters, disabled, onPick }: ChatEmptyProps) {
  const mark = (emoji || "").trim() || agentName.trim().charAt(0).toUpperCase() || "A";
  return (
    <div className={styles.empty}>
      <div className={styles.emptyInner}>
        <div className={styles.emptyMark} aria-hidden>{mark}</div>
        <div className={styles.emptyTitle}>Hi, I&apos;m {agentName}.</div>
        <p className={styles.emptyIntro}>{intro}</p>
        <div className={styles.starters}>
          {starters.map((starter, i) => (
            <button key={i} type="button" disabled={disabled} onClick={() => onPick(starter)} className={styles.starter}>
              <ArrowRight size={13} aria-hidden className={styles.starterArrow} />
              <span>{starter}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** The starters on their own, under the agent's welcome reply: the owner's
 * first message is still to come, so the same suggestions stay one tap away. */
export function ChatStarters({ starters, disabled, onPick }: Pick<ChatEmptyProps, "starters" | "disabled" | "onPick">) {
  return (
    <div className={styles.starters} data-testid="chat-welcome-starters" aria-label="Suggested first messages" role="group">
      {starters.map((starter, i) => (
        <button key={i} type="button" disabled={disabled} onClick={() => onPick(starter)} className={styles.starter}>
          <ArrowRight size={13} aria-hidden className={styles.starterArrow} />
          <span>{starter}</span>
        </button>
      ))}
    </div>
  );
}
