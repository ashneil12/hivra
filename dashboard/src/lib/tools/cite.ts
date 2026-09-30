// "Cite this" text for a tool page: one sentence and one HTML snippet.
//
// The link anchor is the brand name only. Keyword-rich anchors in snippets that
// other sites copy are link spam under Google's spam policies, so the anchor
// never carries the tool's topic.

export interface CiteInput {
  /** The tool's name, for example "Keep Mac Awake Command Builder". */
  name: string;
  /** Absolute canonical URL of the tool (the base URL, never a parameter URL). */
  url: string;
  /** ISO date the facts on the page were last checked. */
  lastVerified: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildCite({ name, url, lastVerified }: CiteInput): { sentence: string; html: string } {
  return {
    sentence: `Hivra, "${name}", ${url}, facts last verified ${lastVerified}.`,
    html: `Source: <a href="${escapeHtml(url)}">Hivra</a>, ${escapeHtml(name)}, facts last verified ${escapeHtml(lastVerified)}.`,
  };
}
