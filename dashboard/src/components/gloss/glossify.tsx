import type { ReactNode } from "react";
import glossary from "@/lib/glossary.json";
import Gloss from "./Gloss";

interface Entry {
  key: string;
  pattern: string;
  tip: string;
  caseSensitive?: boolean;
  token?: boolean;
}

const ENTRIES = (glossary as Entry[]).map((entry) => ({
  ...entry,
  regex: new RegExp(`\\b(?:${entry.pattern})\\b`, entry.caseSensitive ? "" : "i"),
}));

/**
 * Text with the first use of each glossary term wrapped in a hover tooltip.
 * Plain strings stay plain in the data (structured data, tests, the litepaper
 * quotes); only what the reader sees gains the tooltips. Do not use it inside a
 * link or a heading. Token terms are off unless a token-reviewed page asks.
 */
export function glossify(text: string, options: { token?: boolean } = {}): ReactNode {
  const hits: { start: number; end: number; entry: (typeof ENTRIES)[number] }[] = [];
  for (const entry of ENTRIES) {
    if (entry.token && !options.token) continue;
    const match = entry.regex.exec(text);
    if (!match) continue;
    const start = match.index;
    const end = start + match[0].length;
    if (hits.some((hit) => start < hit.end && hit.start < end)) continue;
    hits.push({ start, end, entry });
  }
  if (!hits.length) return text;
  hits.sort((a, b) => a.start - b.start);
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const { start, end, entry } of hits) {
    if (start > cursor) nodes.push(text.slice(cursor, start));
    nodes.push(
      <Gloss key={entry.key} tip={entry.tip}>
        {text.slice(start, end)}
      </Gloss>,
    );
    cursor = end;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}
