/**
 * The inline markup the comparison copy uses: `**bold**`, `` `code` `` and
 * `[label](href)`. Kept to these three so the data files stay plain strings (no JSX
 * in lib/) and the same string can be read as text by a test or by JSON-LD.
 */

export type InlineToken =
  | { kind: "text"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; href: string };

const INLINE = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;

export function parseInline(source: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let cursor = 0;
  for (const match of source.matchAll(INLINE)) {
    const start = match.index ?? 0;
    if (start > cursor) tokens.push({ kind: "text", text: source.slice(cursor, start) });
    if (match[1] !== undefined) tokens.push({ kind: "strong", text: match[1] });
    else if (match[2] !== undefined) tokens.push({ kind: "code", text: match[2] });
    else tokens.push({ kind: "link", text: match[3], href: match[4] });
    cursor = start + match[0].length;
  }
  if (cursor < source.length) tokens.push({ kind: "text", text: source.slice(cursor) });
  return tokens;
}

/** The copy as a reader reads it: markup removed, link labels kept. */
export function inlineToPlain(source: string): string {
  return parseInline(source)
    .map((token) => token.text)
    .join("");
}

/** Every link destination in a piece of copy. */
export function inlineHrefs(source: string): string[] {
  return parseInline(source).flatMap((token) => (token.kind === "link" ? [token.href] : []));
}
