// The small inline markup the tools catalog uses in its page copy: **bold**,
// *italic* and `code`. The catalog is pure data (no React), so copy that needs
// an emphasised word or a command carries these marks and the page turns them
// into elements (components/tools/Markup.tsx). stripMarkup gives the plain text a
// reader sees, which is what the copy scanners and structured data read.

export type MarkupKind = "text" | "strong" | "em" | "code";

export interface MarkupToken {
  kind: MarkupKind;
  text: string;
}

const MARKS = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s](?:[^*]*[^*\s])?\*)/g;

export function parseMarkup(source: string): MarkupToken[] {
  const tokens: MarkupToken[] = [];
  let last = 0;
  for (const match of source.matchAll(MARKS)) {
    const start = match.index ?? 0;
    if (start > last) tokens.push({ kind: "text", text: source.slice(last, start) });
    const mark = match[0];
    if (mark.startsWith("`")) tokens.push({ kind: "code", text: mark.slice(1, -1) });
    else if (mark.startsWith("**")) tokens.push({ kind: "strong", text: mark.slice(2, -2) });
    else tokens.push({ kind: "em", text: mark.slice(1, -1) });
    last = start + mark.length;
  }
  if (last < source.length) tokens.push({ kind: "text", text: source.slice(last) });
  return tokens;
}

/** The text a reader sees: the marks removed, the words kept. */
export function stripMarkup(source: string): string {
  return parseMarkup(source)
    .map((token) => token.text)
    .join("");
}
