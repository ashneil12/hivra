import { readFileSync } from "node:fs";
import path from "node:path";

export interface ChangelogEntry {
  /** ISO date string, e.g. "2026-05-29". Also used as the anchor id. */
  date: string;
  /** Heading text after the bracketed date. */
  title: string;
  /** Raw markdown body for this entry, ready to feed into ReactMarkdown. */
  body: string;
}

export interface ParsedChangelog {
  /** Optional top-of-file "Last updated: YYYY-MM-DD" marker if present. */
  lastUpdated: string | null;
  entries: ChangelogEntry[];
}

const HEADING_RE = /^##\s*\[(\d{4}-\d{2}-\d{2})\]\s*(.+?)\s*$/;
const LAST_UPDATED_RE = /^>\s*Last updated:\s*(\d{4}-\d{2}-\d{2})\s*$/;

// `outputFileTracingIncludes` in next.config.ts pulls hermes_changelog.md into
// the /changelog server function bundle so this read resolves in production.
const CHANGELOG_PATH = path.join(process.cwd(), "hermes_changelog.md");

let cachedParsed: ParsedChangelog | null = null;

export function parseChangelog(source: string): ParsedChangelog {
  const lines = source.split(/\r?\n/);
  const entries: ChangelogEntry[] = [];
  let lastUpdated: string | null = null;
  let current: { date: string; title: string; body: string[] } | null = null;

  for (const line of lines) {
    if (lastUpdated === null) {
      const lu = line.match(LAST_UPDATED_RE);
      if (lu) {
        lastUpdated = lu[1];
        continue;
      }
    }

    const heading = line.match(HEADING_RE);
    if (heading) {
      if (current) entries.push(finalize(current));
      current = { date: heading[1], title: heading[2], body: [] };
      continue;
    }

    if (current) {
      current.body.push(line);
    }
  }

  if (current) entries.push(finalize(current));

  return { lastUpdated, entries };
}

function finalize(raw: { date: string; title: string; body: string[] }): ChangelogEntry {
  let body = raw.body.join("\n");
  body = body.replace(/^\s*\n/, "");
  body = body.replace(/\n+---\s*$/, "");
  return { date: raw.date, title: raw.title, body: body.trimEnd() };
}

/**
 * Release-note sections that name the Bankr wallet. Bankr is token-surface wording (the public
 * launch rule: a sentence about Bankr renders only while HIVRA_NEW_TOKEN_SURFACES is on and the
 * viewer is not in a listed country), so with the surfaces hidden the section keeps what is not
 * about Bankr: the skills half of the 13 June note. The source file keeps the full note.
 * `heading` is the section's H3 text in hermes_changelog.md; changelog-data.test.ts fails if
 * the file stops carrying it, so a rename cannot silently leave the Bankr wording visible.
 */
export const TOKEN_SURFACE_SECTIONS: ReadonlyArray<{ heading: string; plain: string }> = [
  {
    heading: "Bankr wallet and skills for CLI agents",
    plain:
      "### Skills for CLI agents\nCLI agents (Codex, Claude Code) now have the ability to install skills from the catalogue.",
  },
];

/**
 * Entries as one viewer may read them. With `tokenSurfacesVisible` false (the switch off, a viewer
 * in a listed country, and always the static RSS feed) every section in TOKEN_SURFACE_SECTIONS is
 * swapped for its plain wording; true returns the entries as written.
 */
export function resolveChangelogEntries(entries: ChangelogEntry[], tokenSurfacesVisible: boolean): ChangelogEntry[] {
  if (tokenSurfacesVisible) return entries;
  return entries.map((entry) => {
    const body = entry.body
      .split(/^(?=### )/m)
      .map((section) => {
        const gated = TOKEN_SURFACE_SECTIONS.find(({ heading }) => section.startsWith(`### ${heading}\n`));
        return gated ? gated.plain + (section.match(/\s*$/)?.[0] ?? "") : section;
      })
      .join("");
    return body === entry.body ? entry : { ...entry, body };
  });
}

/**
 * Reads dashboard/hermes_changelog.md from disk and returns the parsed structure.
 * Cached after first read: the file ships in the bundle and does not change at runtime.
 */
export function readChangelog(): ParsedChangelog {
  if (cachedParsed) return cachedParsed;
  const source = readFileSync(CHANGELOG_PATH, "utf8");
  cachedParsed = parseChangelog(source);
  return cachedParsed;
}
