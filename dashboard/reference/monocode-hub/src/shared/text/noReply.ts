/**
 * NO_REPLY is the word a Mono answers with to say nothing (room turns, Mono messages). It is an internal signal, never
 * words for Ash: Alfred's r50 blind run (e02) showed frank's room message ending "...as a decision.\n\nNO_REPLY".
 * withoutNoReply drops it wherever it sits on a line of its own, opens the text, or closes it, and returns what's left
 * (often ""). Used where messages are saved (room posts and live drafts) and where they render (chat bubbles,
 * room messages and previews), so it can't show anywhere.
 */
const LINE = /^[ \t]*[`*_"'([{<]*NO_REPLY[`*_"')\]}>.!]*[ \t]*$/gim;
const LEAD = /^\s*[`*_"']*NO_REPLY\b[\s`*_"'.!:,;\-\u2013]*/i;
const TAIL = /\s*[`*_"'(]*\bNO_REPLY[`*_"').!]*\s*$/i;

export function withoutNoReply(text: string): string {
  if (!text || !/NO_REPLY/i.test(text)) return text;
  return text.replace(LINE, "").replace(LEAD, "").replace(TAIL, "").replace(/\n{3,}/g, "\n\n").trim();
}

/** Streaming text that may still become NO_REPLY ("NO_RE"): hold it back rather than flash it. */
export function isNoReplyPrefix(text: string): boolean {
  const t = text.trim().toUpperCase();
  return t.length >= 2 && "NO_REPLY".startsWith(t);
}
