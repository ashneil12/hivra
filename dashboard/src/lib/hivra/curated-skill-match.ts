// Curated-skill ↔ installed-skill matching. Pure, isomorphic (no server/client
// imports) so both the install route and the picker UI can share one diff.
//
// A box reports its installed skills via GET /api/skills, reading the `name:`
// from each SKILL.md frontmatter. The catalog's display `name` usually equals
// that frontmatter name, but a handful of upstream skills ship a different
// frontmatter name from their dir/display name (e.g. dir `quotient` →
// `name: quotient-api`) — those carry an `installedAs` override. We treat a
// curated entry as installed when EITHER its `name` or its `installedAs`
// normalizes to the same token as any installed skill's name.

/** A skill as the box reports it (just the name matters for the diff). */
export interface InstalledBoxSkill {
  name: string;
}

/** The minimal curated shape the diff needs (catalog entry OR content-free meta). */
export interface CuratedSkillMatchable {
  name: string;
  installedAs?: string | null;
}

/**
 * Canonicalize a skill name for matching: lowercase, then drop everything that
 * isn't a letter or digit. This absorbs the common drift between a SKILL.md
 * frontmatter name and the catalog display name — spaces, hyphens, underscores,
 * casing ("Claude Code" ↔ "claude-code" ↔ "claudecode").
 */
export function normalizeSavedName(name: string | null | undefined): string {
  return (name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Is this curated entry already present in the box's installed-skill list?
 * Matches the entry's `name` OR its `installedAs` override against every
 * installed skill's normalized name. Empty/whitespace tokens never match.
 */
export function isCuratedSkillInstalled(
  entry: CuratedSkillMatchable,
  boxSkills: InstalledBoxSkill[],
): boolean {
  const candidates = new Set<string>();
  const primary = normalizeSavedName(entry.name);
  if (primary) candidates.add(primary);
  const alias = normalizeSavedName(entry.installedAs);
  if (alias) candidates.add(alias);
  if (candidates.size === 0) return false;
  return boxSkills.some((s) => {
    const token = normalizeSavedName(s.name);
    return token.length > 0 && candidates.has(token);
  });
}
