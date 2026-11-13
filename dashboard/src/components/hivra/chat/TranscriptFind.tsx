"use client";

// Adapted from MonoCode (MIT License, Copyright (c) 2026 Nick); see THIRD_PARTY_LICENSES/monocode.txt.
//
// Find in the conversation: Cmd/Ctrl+F while the chat has focus opens a small
// bar over the transcript. Enter and Shift+Enter (or F3, Cmd/Ctrl+G) step
// through the messages that match, the matches are highlighted in the text,
// and Escape closes. MonoCode also searches its archive of older turns; Hivra's
// open conversation is all in the page, so only that is searched.

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { clearTranscriptHighlights, paintTranscriptHighlights, transcriptWordRanges } from "./transcriptHighlights";
import type { ChatMessage } from "./types";
import styles from "./chat.module.css";

/** The messages (by position) whose text holds the query, case-insensitively. */
export function findTranscriptMessages(messages: readonly ChatMessage[], query: string): number[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const hits: number[] = [];
  messages.forEach((message, index) => {
    if (message.text.toLowerCase().includes(needle)) hits.push(index);
  });
  return hits;
}

export function TranscriptFind({ messages, scrollRef, rootRef }: {
  messages: readonly ChatMessage[];
  /** The transcript's scroller, where the messages are and where a match scrolls to. */
  scrollRef: RefObject<HTMLElement | null>;
  /** The chat's root: Find only answers a key pressed inside it. */
  rootRef: RefObject<HTMLElement | null>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const owner = useRef(Symbol("hivra-chat-find"));
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const matches = useMemo(() => findTranscriptMessages(messages, query), [messages, query]);
  const selected = matches.length ? matches[Math.min(active, matches.length - 1)] : null;

  const openFind = useCallback(() => {
    setOpen(true);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.select();
    });
  }, []);
  const closeFind = useCallback(() => {
    setOpen(false);
    const pane = scrollRef.current;
    pane?.querySelectorAll("[data-transcript-search-current]").forEach((el) => el.removeAttribute("data-transcript-search-current"));
    clearTranscriptHighlights(owner.current);
  }, [scrollRef]);
  const step = useCallback((direction: number) => {
    if (!matches.length) return;
    setActive((index) => (index + direction + matches.length) % matches.length);
  }, [matches.length]);

  // Scroll the current match into view and paint every match, again whenever
  // the messages change (a reply that is still streaming).
  useEffect(() => {
    const pane = scrollRef.current;
    if (!open || !pane) return;
    const frame = requestAnimationFrame(() => {
      pane.querySelectorAll("[data-transcript-search-current]").forEach((el) => el.removeAttribute("data-transcript-search-current"));
      const item = selected === null ? null : pane.querySelector<HTMLElement>(`[data-chat-message="${selected}"]`);
      if (item) {
        item.setAttribute("data-transcript-search-current", "true");
        item.scrollIntoView?.({ block: "center", behavior: "auto" });
      }
      const { matches: ranges, current } = transcriptWordRanges(pane, query);
      paintTranscriptHighlights(owner.current, ranges, current);
    });
    return () => cancelAnimationFrame(frame);
  }, [open, selected, query, messages, scrollRef]);
  useEffect(() => {
    const id = owner.current;
    return () => clearTranscriptHighlights(id);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      const root = rootRef.current;
      const target = event.target instanceof Node ? event.target : null;
      if (!root || !target || !root.contains(target)) return;
      const mod = event.metaKey || event.ctrlKey;
      if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        event.stopPropagation();
        openFind();
      } else if (open && (event.key === "F3" || (mod && !event.altKey && event.key.toLowerCase() === "g"))) {
        event.preventDefault();
        event.stopPropagation();
        step(event.shiftKey ? -1 : 1);
      } else if (open && event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeFind();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, openFind, closeFind, step, rootRef]);

  if (!open) return null;

  const status = query.trim() ? (matches.length ? `${Math.min(active, matches.length - 1) + 1} of ${matches.length}` : "No results") : "";
  return (
    <div className={styles.find}>
      <div role="search" aria-label="Find in conversation" className={styles.findBar}>
        <Search size={14} strokeWidth={1.75} aria-hidden className={styles.findIcon} />
        <input
          ref={input}
          type="text"
          value={query}
          aria-label="Find in conversation"
          placeholder="Find in conversation"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event: ReactKeyboardEvent<HTMLInputElement>) => {
            if (event.key === "Enter") {
              event.preventDefault();
              step(event.shiftKey ? -1 : 1);
            }
          }}
          className={styles.findInput}
        />
        <span aria-live="polite" className={styles.findCount}>{status}</span>
        <FindButton label="Previous match" onClick={() => step(-1)} disabled={!matches.length}><ChevronUp size={14} strokeWidth={1.75} aria-hidden /></FindButton>
        <FindButton label="Next match" onClick={() => step(1)} disabled={!matches.length}><ChevronDown size={14} strokeWidth={1.75} aria-hidden /></FindButton>
        <FindButton label="Close find" onClick={closeFind}><X size={14} strokeWidth={1.75} aria-hidden /></FindButton>
      </div>
    </div>
  );
}

function FindButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button type="button" title={label} aria-label={label} disabled={disabled} onClick={onClick} className={styles.findButton}>
      {children}
    </button>
  );
}
