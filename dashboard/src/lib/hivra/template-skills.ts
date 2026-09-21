import "server-only";

// Template skills (Wave 5.2 follow-up) — snapshot the curated skills an agent has
// installed, and coerce a stored snapshot back into a clean id list.
//
// A box's installed skills live as files; the box reports them via GET /api/skills
// (name + description, no body). We map those reported names back to CURATED_SKILLS
// ids with the same matcher the install picker uses (isCuratedSkillInstalled), and
// store just the ids on the template. Re-seeding a fork pulls each SKILL.md from
// the catalog, so no skill markdown ever lands in the DB. See the migration
// (20260613193000_agent_template_skills.sql) for the full design + rationale.
//
// WHY ONLY CURATED, NON-BANKR, CONTENT-BEARING SKILLS:
//   * curated     — a non-catalog (user-authored) skill has no catalog id and its
//                   body is user-typed/sensitive (can't survive a public share);
//                   carrying those is a later iteration.
//   * non-bankr   — the Bankr suite is auto-seeded onto every CLI box, so a
//                   template recording it would just be redundant noise.
//   * content     — only entries with an inline SKILL.md body are re-seedable;
//                   recording an id we can't reproduce would be misleading.

import { CURATED_SKILLS } from "@/data/curated-skills";
import { isCuratedSkillInstalled, type InstalledBoxSkill } from "@/lib/hivra/curated-skill-match";

interface BoxSkillsResponse {
  skills?: Array<{ name?: unknown }>;
}

/**
 * Map a box's reported skills to the curated-catalog ids worth carrying in a
 * template: installed AND non-Bankr AND content-bearing (re-seedable). Pure.
 */
export function resolveTemplateSkillIds(boxSkills: InstalledBoxSkill[]): string[] {
  const ids: string[] = [];
  for (const entry of CURATED_SKILLS) {
    if (entry.category === "bankr") continue; // auto-seeded on every box
    if (typeof entry.content !== "string" || !entry.content.trim()) continue; // not re-seedable
    if (isCuratedSkillInstalled(entry, boxSkills)) ids.push(entry.id);
  }
  return ids;
}

/**
 * Coerce a stored jsonb skills value into a clean, de-duped string[] of ids.
 * Tolerates null / non-array / non-string members so a malformed snapshot
 * degrades to [] rather than throwing.
 */
export function coerceSkillIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of value) {
    if (typeof x !== "string") continue;
    const id = x.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Best-effort: read a running box's installed skills over its token-gated
 * GET /api/skills and resolve them to curated ids. NEVER throws — any failure
 * (no url, box down, timeout, bad json) returns [] so a template still saves,
 * just without skills. Self-contained fetch (no dependency on the "use client"
 * box-API module) with a short timeout so it can't stall a template-create.
 */
export async function snapshotInstalledTemplateSkillIds(
  boxUrl: string | null | undefined,
  token: string | null | undefined,
): Promise<string[]> {
  const base = (boxUrl || "").trim().replace(/\/$/, "");
  if (!base) return [];
  try {
    const headers: Record<string, string> = {};
    const t = (token || "").trim();
    if (t) headers.Authorization = `Bearer ${t}`;
    const r = await fetch(`${base}/api/skills`, {
      cache: "no-store",
      headers,
      signal: AbortSignal.timeout(8_000),
    });
    if (!r.ok) return [];
    const j = (await r.json().catch(() => ({}))) as BoxSkillsResponse;
    const reported: InstalledBoxSkill[] = (Array.isArray(j.skills) ? j.skills : [])
      .map((s) => ({ name: typeof s?.name === "string" ? s.name : "" }))
      .filter((s) => s.name);
    return resolveTemplateSkillIds(reported);
  } catch {
    return [];
  }
}
