// Adapted from MonoCode (MIT License, Copyright (c) 2026 Nick); see THIRD_PARTY_LICENSES/monocode.txt.
//
// The maths behind the prompt outline: which prompts get a bar, which one the
// reader is on, how far the bars near the pointer lift, and what the preview
// card says. MonoCode's own model file is not part of the reference slice, so
// these are written for Hivra's messages and keep MonoCode's constants.

import type { ChatMessage } from "./types";

/** At the end of the transcript the last prompt wins, whatever the anchors say. */
export const NEAR_END_PX = 24;
/** How many bars either side of the pointer feel it. */
export const RIPPLE_SPAN = 4;

export interface OutlinePrompt {
  /** The message's position in the conversation. */
  id: string;
  text: string;
  reply: string;
}
export interface OutlineBand {
  top: number;
  bottom: number;
}
export interface OutlineAnchor extends OutlineBand {
  id: string;
}

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Every message the owner wrote, with the first words of the reply that followed. */
export function promptMessages(messages: readonly ChatMessage[]): OutlinePrompt[] {
  const out: OutlinePrompt[] = [];
  messages.forEach((message, index) => {
    if (message.role !== "user" || !message.text.trim()) return;
    const next = messages[index + 1];
    out.push({ id: String(index), text: message.text, reply: next?.role === "assistant" ? next.text : "" });
  });
  return out;
}

export function promptLabel(prompt: OutlinePrompt): string {
  return `Prompt: ${oneLine(prompt.text, 80)}`;
}

export function promptPreview(prompt: OutlinePrompt): { title: string; reply: string } {
  return { title: oneLine(prompt.text, 140), reply: oneLine(prompt.reply, 140) };
}

/**
 * The prompt the reader is on: the last one that has started by the top of the
 * viewport (or the first, above all of them). Near the end of the transcript
 * the last prompt wins.
 */
export function activePromptId(viewport: OutlineBand, anchors: readonly OutlineAnchor[], distanceToEnd: number): string | null {
  if (anchors.length === 0) return null;
  if (distanceToEnd <= NEAR_END_PX) return anchors[anchors.length - 1].id;
  let active = anchors[0].id;
  for (const anchor of anchors) {
    // A prompt counts as current once it is within a third of the viewport of the top.
    if (anchor.top <= viewport.top + (viewport.bottom - viewport.top) / 3) active = anchor.id;
    else break;
  }
  return active;
}

/** How far a bar lifts toward the pointer: 1 under it, fading to 0 at the ripple's edge. */
export function barLift(index: number, hoverIndex: number): number {
  if (hoverIndex < 0) return 0;
  return Math.max(0, 1 - Math.abs(index - hoverIndex) / (RIPPLE_SPAN + 1));
}

/** The slice of `count` bars that fit: all of them, or a window that follows the active one. */
export function barWindow(count: number, activeIndex: number | null, fit: number): { start: number; end: number } {
  if (count <= fit) return { start: 0, end: count };
  const centre = activeIndex ?? count - 1;
  const start = Math.min(Math.max(0, centre - Math.floor(fit / 2)), count - fit);
  return { start, end: start + fit };
}
