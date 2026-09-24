// SKILL.md files we write onto agent computers: the one check every file must
// pass, the repair for the broken shapes seen upstream, and the folder each
// catalog skill is written to. Pure (no server-only import) so the vendoring
// script shares it with the seed and install paths.
//
// Codex and Claude Code read a skill's name and description from a YAML block
// fenced by `---` lines at the top of its SKILL.md. Claude Code is lenient.
// Codex refuses a file it can't read and logs "failed to load skill ..." on
// every run, which surfaced in chat on 2026-09-24: upstream BankrBot/skills
// ships `trails` with an opening `---` that is never closed, and v2 of
// twitter-agent at `skills/bankr-twitter-agent` with no block at all. We had
// vendored both verbatim and written them onto every Codex computer.
//
// skillFrontmatterProblem encodes the strictest Codex reader. The rules come
// from codex-rs core-skills/src/loader.rs (extract_frontmatter and
// parse_skill_frontmatter_metadata_inner, as merged from upstream in July 2026)
// and from its January 2026 form in core/src/skills/loader.rs, which older
// installed CLIs still run:
//   - the first line is `---` (spaces around it are fine), so no blank line or
//     byte-order mark comes before it;
//   - a later line is `---`, with at least one line in between;
//   - the lines in between are YAML that parses to key: value fields. We parse
//     strictly: newer Codex quietly quotes `key: text: more` values, older
//     releases refuse them;
//   - `name` is non-empty text of at most 64 characters. Newer Codex falls back
//     to the folder name; older releases and the box's skills list need it;
//   - `description` is non-empty text of at most 1024 characters. Codex dropped
//     that cap in June 2026; earlier releases refuse longer descriptions;
//   - `metadata`, when present, is key: value fields, and its
//     `short-description` is text of at most 1024 characters.
// Lengths count characters after collapsing runs of whitespace, as Codex does.

import { CORE_SCHEMA, YAMLException, dump, load } from "js-yaml";

import type { CuratedSkillEntry } from "@/data/curated-skills";

export const SKILL_NAME_MAX_CHARS = 64;
export const SKILL_DESCRIPTION_MAX_CHARS = 1024;

const FENCE = "---";

// Rust's str::trim keeps a byte-order mark; JavaScript's trim drops it.
const isFence = (line: string): boolean => line.trim() === FENCE && !line.includes("\uFEFF");
const isBlank = (line: string): boolean => line.trim() === "";
const isHeading = (line: string): boolean => /^#{1,6}\s/.test(line);
const collapse = (text: string): string => text.split(/\s+/).filter(Boolean).join(" ");
const charCount = (text: string): number => Array.from(text).length;
const isFieldMap = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const hasField = (fields: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(fields, key);

function textFieldProblem(fields: Record<string, unknown>, key: string, max: number): string | null {
  const value = fields[key];
  if (value === undefined || value === null) return `it has no ${key}`;
  if (typeof value !== "string") return `its ${key} isn't text`;
  const text = collapse(value);
  if (!text) return `its ${key} is empty`;
  if (charCount(text) > max) return `its ${key} is longer than ${max} characters`;
  return null;
}

/**
 * Why Codex would refuse this SKILL.md, as a short phrase, or null when every
 * agent CLI we seed can load it.
 */
export function skillFrontmatterProblem(content: string): string | null {
  const lines = content.split(/\r?\n/);
  if (!isFence(lines[0])) return "it doesn't start with a --- line";
  const close = lines.findIndex((line, index) => index > 0 && isFence(line));
  if (close === -1) return "the --- block at the top is never closed";
  if (close === 1) return "the --- block at the top is empty";

  let fields: unknown;
  try {
    fields = load(lines.slice(1, close).join("\n"), { schema: CORE_SCHEMA });
  } catch (err) {
    const reason = err instanceof YAMLException ? err.reason : String(err);
    return `the --- block at the top isn't valid YAML (${reason})`;
  }
  if (!isFieldMap(fields)) return "the --- block at the top isn't key: value fields";

  const fieldProblem =
    textFieldProblem(fields, "name", SKILL_NAME_MAX_CHARS) ??
    textFieldProblem(fields, "description", SKILL_DESCRIPTION_MAX_CHARS);
  if (fieldProblem) return fieldProblem;

  if (hasField(fields, "metadata")) {
    const metadata = fields.metadata;
    if (!isFieldMap(metadata)) return "its metadata isn't key: value fields";
    const short = metadata["short-description"];
    if (short !== undefined && short !== null) {
      if (typeof short !== "string") return "its metadata short-description isn't text";
      if (charCount(collapse(short)) > SKILL_DESCRIPTION_MAX_CHARS) {
        return `its metadata short-description is longer than ${SKILL_DESCRIPTION_MAX_CHARS} characters`;
      }
    }
  }
  return null;
}

/** What a repair may write into a SKILL.md that has no frontmatter. */
export interface SkillRepairMetadata {
  name: string;
  description: string;
}

/** A SKILL.md that Codex can't load and that no repair fixes. */
export class SkillContentError extends Error {
  constructor(readonly problem: string) {
    super(`SKILL.md can't be loaded: ${problem}`);
    this.name = "SkillContentError";
  }
}

// The shapes seen upstream, repaired in order: blank lines (or a byte-order
// mark) above the opening ---, an opening --- that is never closed, and no
// frontmatter at all. Returns null when there is nothing to work with.
function repairSkillContent(content: string, meta: SkillRepairMetadata): string | null {
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/);
  const first = lines.findIndex((line) => !isBlank(line));
  if (first === -1) return null;
  const rest = lines.slice(first);

  if (!isFence(rest[0])) {
    const fields = dump({ name: meta.name, description: meta.description }, { schema: CORE_SCHEMA, lineWidth: -1 });
    return [FENCE, fields.trimEnd(), FENCE, "", ...rest].join("\n");
  }
  if (rest.some((line, index) => index > 0 && isFence(line))) return rest.join("\n");

  // Never closed: close it at the first blank line or heading after the fields
  // that leaves a loadable block, dropping blank lines under the opening ---.
  let start = 1;
  while (start < rest.length && isBlank(rest[start])) start += 1;
  for (let end = start + 1; end <= rest.length; end += 1) {
    if (end < rest.length && !isBlank(rest[end]) && !isHeading(rest[end])) continue;
    const candidate = [FENCE, ...rest.slice(start, end), FENCE, ...rest.slice(end)].join("\n");
    if (skillFrontmatterProblem(candidate) === null) return candidate;
  }
  return null;
}

/**
 * The SKILL.md to write: `content` unchanged when every agent CLI can load it,
 * otherwise repaired from `meta`. Throws SkillContentError, naming the original
 * problem, when no repair makes it loadable.
 */
export function normalizeSkillContent(content: string, meta: SkillRepairMetadata): string {
  const problem = skillFrontmatterProblem(content);
  if (problem === null) return content;
  const repaired = repairSkillContent(content, meta);
  if (repaired !== null && skillFrontmatterProblem(repaired) === null) return repaired;
  throw new SkillContentError(problem);
}

// Slug from the catalog identifier (not the leaf name) so two skills sharing a
// leaf — e.g. `BankrBot/skills/bankr-twitter-agent` and
// `BankrBot/skills/skills/bankr-twitter-agent` — never collide on disk. The CLI
// reads the real skill name from each file's frontmatter, so the directory name
// only needs to be unique + filesystem-safe.
export function bankrSkillSlug(identifier: string): string {
  return identifier
    .replace(/^BankrBot\/skills\//, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

type CuratedSkillSource = Pick<CuratedSkillEntry, "identifier" | "installedAs" | "description" | "content">;

/**
 * The SKILL.md to write for a catalog entry. A repair names the skill after its
 * `installedAs` alias or else its folder (Codex's own fallback) and uses the
 * catalog description. Throws SkillContentError when it can't be made loadable.
 */
export function loadableSkillContent(entry: CuratedSkillSource): string {
  return normalizeSkillContent(entry.content ?? "", {
    name: entry.installedAs || bankrSkillSlug(entry.identifier),
    description: entry.description,
  });
}
