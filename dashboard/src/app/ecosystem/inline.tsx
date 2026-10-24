import { Fragment, type ReactNode } from "react";

import { glossify } from "@/components/gloss/glossify";

const BOLD_RUN = /\*\*(.+?)\*\*/g;

export interface InlineOptions {
  /**
   * An address for a bold run (for example a product name that has a section on the page),
   * or undefined to leave it as plain bold text. A bold run with an address is a link, so it
   * gets no glossary tooltip.
   */
  hrefForBold?: (boldText: string) => string | undefined;
}

/** The text without its `**` markers: what a screen reader and a search snippet read. */
export function plainInline(text: string): string {
  return text.replace(BOLD_RUN, "$1");
}

/**
 * Copy strings keep Ash's `**bold**` runs. This draws each run as <strong> and gives the first
 * use of each glossary term in a run of plain text its tooltip (glossify never runs inside a link
 * or a heading). Text with no bold run is returned exactly as glossify returns it.
 */
export function renderInline(text: string, options: InlineOptions = {}): ReactNode {
  const parts: ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  for (const match of text.matchAll(BOLD_RUN)) {
    const start = match.index ?? 0;
    if (start > cursor) parts.push(<Fragment key={key++}>{glossify(text.slice(cursor, start))}</Fragment>);
    const bold = match[1];
    const href = options.hrefForBold?.(bold);
    parts.push(
      <strong key={key++}>
        {href ? <a href={href}>{bold}</a> : glossify(bold)}
      </strong>,
    );
    cursor = start + match[0].length;
  }
  if (!parts.length) return glossify(text);
  if (cursor < text.length) parts.push(<Fragment key={key++}>{glossify(text.slice(cursor))}</Fragment>);
  return parts;
}
