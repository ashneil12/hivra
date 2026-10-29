import { Fragment, type ReactNode } from "react";

import { glossify } from "@/components/gloss/glossify";
import { parseInline, type InlineToken } from "@/lib/inline-copy";

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

/** A token as the copy wrote it. Only bold runs are drawn; every other mark stays as written. */
function asWritten(token: InlineToken): string {
  if (token.kind === "code") return `\`${token.text}\``;
  if (token.kind === "link") return `[${token.label}](${token.href})`;
  return token.text;
}

/**
 * Copy strings keep Ash's `**bold**` runs. This draws each run as <strong> and gives the first
 * use of each glossary term in a run of plain text its tooltip (glossify never runs inside a link
 * or a heading). Text with no bold run is returned exactly as glossify returns it.
 */
export function renderInline(text: string, options: InlineOptions = {}): ReactNode {
  const parts: ReactNode[] = [];
  let plain = "";
  let key = 0;
  const flushPlain = () => {
    if (plain) parts.push(<Fragment key={key++}>{glossify(plain)}</Fragment>);
    plain = "";
  };
  for (const token of parseInline(text)) {
    if (token.kind !== "strong") {
      plain += asWritten(token);
      continue;
    }
    flushPlain();
    const bold = token.text;
    const href = options.hrefForBold?.(bold);
    parts.push(
      <strong key={key++}>
        {href ? <a href={href}>{bold}</a> : glossify(bold)}
      </strong>,
    );
  }
  if (!parts.length) return glossify(text);
  flushPlain();
  return parts;
}
