// A quiet Prism theme for replies. Plain text, punctuation and comments follow
// the Hivra Glass ink tokens, so they track light and dark on their own. The
// few colours that mark keywords, strings and the like are CSS variables
// (--hg-syn-*) set per theme in chat.module.css, which is the one place raw
// colours live.

import type { CSSProperties } from "react";

const ink = "var(--hg-text)";
const quiet = "var(--hg-text-2)";
const faint = "var(--hg-text-3)";

const token = (color: string, extra: CSSProperties = {}): CSSProperties => ({ color, ...extra });

export const chatSyntaxTheme: Record<string, CSSProperties> = {
  'code[class*="language-"]': { color: ink, background: "transparent", textShadow: "none", fontFamily: "var(--font-mono), monospace", textAlign: "left", whiteSpace: "pre", wordSpacing: "normal", wordBreak: "normal", tabSize: 2 },
  'pre[class*="language-"]': { color: ink, background: "transparent", textShadow: "none", margin: 0, overflow: "auto" },
  comment: token(faint, { fontStyle: "italic" }),
  prolog: token(faint),
  doctype: token(faint),
  cdata: token(faint),
  punctuation: token(quiet),
  operator: token(quiet),
  entity: token(quiet),
  url: token("var(--hg-syn-function)"),
  keyword: token("var(--hg-syn-keyword)"),
  atrule: token("var(--hg-syn-keyword)"),
  important: token("var(--hg-syn-keyword)", { fontWeight: 600 }),
  selector: token("var(--hg-syn-keyword)"),
  tag: token("var(--hg-syn-keyword)"),
  boolean: token("var(--hg-syn-number)"),
  number: token("var(--hg-syn-number)"),
  constant: token("var(--hg-syn-number)"),
  symbol: token("var(--hg-syn-number)"),
  property: token("var(--hg-syn-function)"),
  "attr-name": token("var(--hg-syn-type)"),
  "attr-value": token("var(--hg-syn-string)"),
  string: token("var(--hg-syn-string)"),
  char: token("var(--hg-syn-string)"),
  regex: token("var(--hg-syn-string)"),
  variable: token(ink),
  function: token("var(--hg-syn-function)"),
  "class-name": token("var(--hg-syn-type)"),
  builtin: token("var(--hg-syn-type)"),
  inserted: token("var(--hg-ok)"),
  deleted: token("var(--hg-bad)"),
  bold: { fontWeight: 600 },
  italic: { fontStyle: "italic" },
};
