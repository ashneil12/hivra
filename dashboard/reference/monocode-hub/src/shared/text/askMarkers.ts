/**
 * r99 (Critiquito 1): the app reads "Needs Ash:" / "Needs the user:" and "My pick:" lines off a reply to build the ask
 * card (chatQuestions.ts parses the saved text, so the text itself stays as written). Where the reply renders, Ash
 * reads no markers and no third person about himself in his own chat: the label goes, the question and the pick stay,
 * spoken to him. Code fences are left alone.
 */
const NEEDS = /^(?<lead>[\s>*_\-•]*)needs\s+(?:ash|the\s+user|you)\s*(?:\([^)]*\))?\s*[*_]*\s*[:\-—]\s*[*_]*\s*(?<rest>.+)$/i;
const PICK = /^(?<lead>[\s>*_\-•]*)my\s+(?:pick|recommendation)\s*[*_]*\s*[:\-—]\s*[*_]*\s*(?<rest>.+)$/i;
const INLINE_PICK = /([?.!]\s+|:\s+)my\s+(?:pick|recommendation)\s*[*_]*\s*:\s*[*_]*\s*/gi;
const FENCE = /^[ \t]*(`{3,}|~{3,})/;

/** "the user" / "Ash" / "Ash's" in a line spoken to Ash become "you" / "your". */
export function toSecondPerson(text: string): string {
  return text
    .replace(/\b(?:the user|Ash)['’]s\b/g, "your")
    .replace(/\b(?:the user|Ash)\b/g, "you")
    .replace(/^you\b/, "You");
}

function lowerFirst(text: string): string {
  return /^[A-Z][a-z]/.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

function askKey(question: string): string {
  return question.replace(/^[*_]+|[*_]+$/g, "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** The questions each reply's markers ask, in order. */
export function askedQuestions(text: string): string[] {
  if (!text || !/\bneeds\b/i.test(text)) return [];
  let inFence = false;
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (FENCE.test(line)) inFence = !inFence;
    else if (!inFence) {
      const needs = NEEDS.exec(line);
      if (needs?.groups) out.push(askKey(needs.groups.rest!));
    }
  }
  return out;
}

/**
 * r99 (B5 7879: "the same three questions are pasted onto almost every later bubble"): for each reply, the questions an
 * earlier reply in the chat already asked. The Lead re-states open asks so the card stays up; Ash reads each once.
 */
export function repeatedAsks(blocks: readonly { id: string; role: string; text?: string }[]): Map<string, Set<string>> {
  const seen = new Set<string>();
  const out = new Map<string, Set<string>>();
  for (const block of blocks) {
    if (block.role !== "assistant" || !block.text) continue;
    const asked = askedQuestions(block.text);
    const repeats = new Set(asked.filter((q) => seen.has(q)));
    if (repeats.size) out.set(block.id, repeats);
    for (const q of asked) seen.add(q);
  }
  return out;
}

export function withoutAskMarkers(text: string, askedBefore?: ReadonlySet<string>): string {
  if (!text || !/\b(?:needs|my\s+(?:pick|recommendation))\b/i.test(text)) return text;
  let inFence = false;
  let dropping = false;
  let dropped = false;
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      dropping = false;
      lines.push(line);
      continue;
    }
    if (inFence) {
      lines.push(line);
      continue;
    }
    const needs = NEEDS.exec(line);
    if (needs?.groups) {
      dropping = !!askedBefore?.has(askKey(needs.groups.rest!));
      dropped ||= dropping;
      if (!dropping) lines.push(`${needs.groups.lead}${toSecondPerson(needs.groups.rest!.replace(/^[*_]+|[*_]+$/g, "").trim())}`);
      continue;
    }
    const pick = PICK.exec(line);
    if (pick?.groups) {
      if (!dropping) lines.push(`${pick.groups.lead}I'd go with ${lowerFirst(toSecondPerson(pick.groups.rest!.replace(/^[*_]+|[*_]+$/g, "").trim()))}`);
      dropping = false;
      continue;
    }
    if (dropping && !line.trim()) continue;
    dropping = false;
    // r100 (B5 fc68): "Undo after archive: a toast, or a longer window? My pick: a toast." mid-line, in a list.
    lines.push(line.replace(INLINE_PICK, (_m, pre: string) => `${pre}I'd go with `));
  }
  // A reply that was only repeats reads as nothing new rather than an empty bubble.
  if (!dropped) return lines.join("\n");
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() || "Still waiting on your answers on the card.";
}
