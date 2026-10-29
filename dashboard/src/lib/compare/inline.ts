/**
 * The inline markup the comparison copy uses: `**bold**`, `` `code` `` and
 * `[label](href)`. The parser is the shared one in lib/inline-copy.tsx; this module
 * keeps the plain-text reader the comparison tests use.
 */
import { parseInline } from "@/lib/inline-copy";

export { inlineHrefs, parseInline, type InlineToken } from "@/lib/inline-copy";

/** The copy as a reader reads it: markup removed, link labels kept. */
export function inlineToPlain(source: string): string {
  return parseInline(source)
    .map((token) => (token.kind === "link" ? token.label : token.text))
    .join("");
}
