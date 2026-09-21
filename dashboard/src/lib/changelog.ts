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
 * Reads dashboard/hermes_changelog.md from disk and returns the parsed structure.
 * Cached after first read — the file ships in the bundle and does not change at runtime.
 */
export function readChangelog(): ParsedChangelog {
  if (cachedParsed) return cachedParsed;
  const source = readFileSync(CHANGELOG_PATH, "utf8");
  cachedParsed = parseChangelog(source);
  return cachedParsed;
}
