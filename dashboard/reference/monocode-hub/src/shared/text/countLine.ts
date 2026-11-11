/**
 * r102 (3, 05bc: "Of 40: 11 done, 1 already there, 1 blocked by your answer, 27 parked." over 10 Done and 28 Parked
 * bullets; 9: "already there" is done, and the count line opens the reply). A status answer's count line is checked
 * against the groups it sums up and corrected before Ash reads it.
 */
const COUNT_LINE = /^[*_]*Of (\d+):\s*([^\n]+?)[.*_\s]*$/m;
const BUCKET = /^(\d+)\s+(.+)$/;
const ITEM = /^\s*(?:[-*•]|\d+[.)])\s+\S/;

type Bucket = { n: number; label: string };

const key = (label: string) => {
  const l = label.toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
  if (/^already (?:there|done|in)/.test(l)) return "done";
  if (/^blocked/.test(l)) return "blocked";
  if (/^waiting/.test(l)) return "waiting";
  return l.split(" ")[0]!;
};

/** The groups under the count line: a heading line ("Done.", "Parked:", "Blocked by your answers") and its list items. */
function groups(lines: readonly string[]): Map<string, number> | null {
  const out = new Map<string, number>();
  let current: string | undefined;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (ITEM.test(line)) {
      if (!current) return null;
      out.set(current, (out.get(current) ?? 0) + 1);
      continue;
    }
    const head = /^[*_#\s]*(done|already there|running|waiting on you|blocked by your answers?|parked)\b/i.exec(line);
    current = head ? key(head[1]!) : undefined;
  }
  return out;
}

export function withCountLineChecked(text: string): string {
  const m = COUNT_LINE.exec(text);
  if (!m) return text;
  const buckets: Bucket[] = m[2]!
    .split(/,\s*(?:and\s+)?|\s+and\s+/)
    .map((part) => BUCKET.exec(part.trim()))
    .filter((b): b is RegExpExecArray => !!b)
    .map((b) => ({ n: Number(b[1]), label: b[2]!.trim() }));
  if (!buckets.length) return text;
  // "already there" folds into done; r103 (5, B5 0255: the reply said "14 done, 2 already there" and the screen "16
  // done") the done bucket still says how many of them were already there.
  const already = buckets.filter((b) => /^already/i.test(b.label.trim())).reduce((sum, b) => sum + b.n, 0);
  const merged: Bucket[] = [];
  for (const b of buckets) {
    const k = key(b.label);
    const same = merged.find((x) => key(x.label) === k);
    if (same) same.n += b.n;
    else merged.push({ n: b.n, label: k === "done" ? "done" : b.label });
  }
  // Recount from the groups below when every bucket has its own listed group.
  const rest = text.slice(m.index + m[0].length).split("\n");
  const listed = groups(rest);
  if (listed && merged.every((b) => listed.has(key(b.label))) && [...listed.keys()].every((k) => merged.some((b) => key(b.label) === k)))
    for (const b of merged) b.n = listed.get(key(b.label))!;
  const total = merged.reduce((sum, b) => sum + b.n, 0);
  const of = listed && merged.every((b) => listed.has(key(b.label))) ? total : Math.max(Number(m[1]), total);
  const recounted = !!listed && merged.every((b) => listed.has(key(b.label)));
  const label = (b: Bucket) => (key(b.label) === "done" && already > 0 && !recounted && already < b.n ? `done (${already} already there)` : b.label);
  const line = `Of ${of}: ${merged.map((b) => `${b.n} ${label(b)}`).join(", ")}.`;
  // The count line opens the reply.
  const before = text.slice(0, m.index).trim();
  // Each status line is its own paragraph (run d71c: single newlines rendered as one long paragraph); list items stay.
  const after = text
    .slice(m.index + m[0].length)
    .replace(/^\n+/, "")
    .replace(/([^\n])\n(?![ \t]*(?:[-*•]|\d+[.)])[ \t])(?=[ \t]*\S)/g, "$1\n\n");
  // r103 (Critiquito c, B5 82ea: "Of 40: 13 done, 5 waiting on you" with "Nothing from me is in your Inbox"): with asks
  // waiting on him, a sentence saying his Inbox is empty is untrue, so it goes.
  const held = merged.some((b) => (key(b.label) === "waiting" || key(b.label) === "blocked") && b.n > 0);
  const said = (part: string) => (held ? withoutEmptyInbox(part) : part);
  return [line, said(before), said(after)].filter(Boolean).join("\n\n");
}

const EMPTY_INBOX = /[^.!?\n]*\b(?:nothing|no asks?|none)\b[^.!?\n]*\b(?:in|on) (?:your|his) inbox\b[^.!?\n]*[.!?]?/gi;
/** The text without any sentence saying his Inbox has nothing (a paragraph left empty goes too). */
export function withoutEmptyInbox(text: string): string {
  return text
    .replace(EMPTY_INBOX, "")
    .split(/\n{2,}/)
    .map((p) => p.replace(/[ \t]{2,}/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");
}
