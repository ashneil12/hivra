import "server-only";

// In-app skill installer (Wave 3). Browse the curated catalog, one-click install
// a skill onto a running Hivra CLI box. The box's server.js exposes only
// GET/DELETE on /api/skills (no write endpoint), so — exactly like the Bankr
// seed — we write the SKILL.md straight into the box's per-CLI skills dir over
// SSH (host->guest, base64-wrapped). This reuses bankr-skills-seed's proven SSH
// plumbing (`seedSkillFilesOntoBox`) rather than duplicating it; the only new
// logic here is resolving catalog ids → {slug, content} files and the per-call
// gating/result shape. Every file written is one Codex can load (repaired if
// needed, see skill-file.ts); a requested skill that can't be made loadable
// fails the whole install with a clear error instead of vanishing.
//
// Each install is an on-demand SSH round-trip to the box via the orchestrator
// key. Only CLI box types with a skills dir (codex / claude-code) are eligible;
// everything else is rejected up front without touching SSH. Idempotent:
// re-installing an already-present skill simply overwrites its SKILL.md.

import { CURATED_SKILLS, type CuratedSkillEntry } from "@/data/curated-skills";
import {
  bankrSkillSlug,
  bankrSkillsDirForType,
  seedSkillFilesOntoBox,
  type BankrSkillFile,
} from "@/lib/hivra/bankr-skills-seed";
import { loadableSkillContent, SkillContentError } from "@/lib/hivra/skill-file";
import { log } from "@/lib/logger";
import type { runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";

const LOG_SOURCE = "hivra/skill-install";

export interface SkillInstallAgent {
  id: string;
  type?: string | null;
  ip?: string | null;
}

export interface SkillInstallResult {
  ok: boolean;
  /** Catalog ids actually written to the box. */
  installed: string[];
  /** Catalog ids that were requested but not installable (unknown id / no content). */
  skipped: string[];
  /** Catalog ids whose SKILL.md Codex couldn't load, even repaired. Never written. */
  unloadable?: string[];
  error?: string;
}

const CURATED_BY_ID = new Map<string, CuratedSkillEntry>(
  CURATED_SKILLS.map((s) => [s.id, s]),
);

/** Only catalog entries with non-empty inline SKILL.md content are installable. */
export function isInstallableCuratedId(id: string): boolean {
  const entry = CURATED_BY_ID.get(id);
  return Boolean(entry && typeof entry.content === "string" && entry.content.trim());
}

/** Content-free catalog entry for the picker (the 480K of SKILL.md bodies stay
 *  server-side; the client only needs metadata + the matching aliases). */
export interface InstallableSkillMeta {
  id: string;
  name: string;
  description: string;
  category: string | null;
  /** Frontmatter-name override for the installed-vs-available diff. */
  installedAs: string | null;
}

/** The installable slice of the catalog (entries with content), content stripped. */
export function listInstallableSkillMeta(): InstallableSkillMeta[] {
  return CURATED_SKILLS.filter(
    (s) => typeof s.content === "string" && s.content.trim().length > 0,
  ).map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    category: s.category ?? null,
    installedAs: s.installedAs ?? null,
  }));
}

/**
 * Resolve requested catalog ids into the {slug, content} files to write, plus
 * the ids that couldn't be resolved (unknown / contentless) and the ids whose
 * SKILL.md can't be made loadable. Slugs are unique per call so two requested
 * skills never collide on disk — same scheme the Bankr suite uses (slug from
 * the identifier, deduped with a numeric suffix).
 */
export function collectSkillFilesForIds(skillIds: string[]): {
  files: (BankrSkillFile & { id: string })[];
  skipped: string[];
  unloadable: string[];
} {
  const files: (BankrSkillFile & { id: string })[] = [];
  const skipped: string[] = [];
  const unloadable: string[] = [];
  const seenIds = new Set<string>();
  const seenSlugs = new Set<string>();
  for (const id of skillIds) {
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    const entry = CURATED_BY_ID.get(id);
    if (!entry || typeof entry.content !== "string" || !entry.content.trim()) {
      skipped.push(id);
      continue;
    }
    const base = bankrSkillSlug(entry.identifier);
    if (!base) {
      skipped.push(id);
      continue;
    }
    let content: string;
    try {
      content = loadableSkillContent(entry);
    } catch (err) {
      if (!(err instanceof SkillContentError)) throw err;
      log.warn("curated skill not installed: its SKILL.md can't be loaded", {
        source: LOG_SOURCE,
        failureType: "skill_file_unloadable",
        skillId: id,
        problem: err.problem,
      });
      unloadable.push(id);
      continue;
    }
    let slug = base;
    let n = 2;
    while (seenSlugs.has(slug)) slug = `${base}-${n++}`;
    seenSlugs.add(slug);
    files.push({ id, slug, content });
  }
  return { files, skipped, unloadable };
}

function unloadableSkillsError(ids: string[]): string {
  const names = ids.map((id) => CURATED_BY_ID.get(id)?.name ?? id);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const one = names.length === 1;
  return `Couldn't install ${list}: ${one ? "its skill file is" : "their skill files are"} broken, so your agent couldn't use ${one ? "it" : "them"}. Nothing was installed.`;
}

/**
 * Install the given curated skills onto a running box over SSH. Returns the ids
 * that were written and the ids that were skipped (unknown / contentless). On an
 * SSH/transport failure NOTHING is reported installed (the write is one atomic
 * guest script — partial success isn't observable), and `error` is set. A
 * requested skill whose SKILL.md can't be made loadable refuses the whole
 * install before SSH, naming the skill in `error`.
 */
export async function installCuratedSkillsOnBox(
  agent: SkillInstallAgent,
  skillIds: string[],
  env: Parameters<typeof runProxmoxHostScript>[1],
): Promise<SkillInstallResult> {
  const dir = bankrSkillsDirForType(agent.type);
  if (!dir) return { ok: false, installed: [], skipped: skillIds, error: "unsupported agent type" };

  const ip = (agent.ip || "").trim();
  if (!/^[0-9.]+$/.test(ip)) {
    return { ok: false, installed: [], skipped: skillIds, error: "missing or invalid box ip" };
  }

  const { files, skipped, unloadable } = collectSkillFilesForIds(skillIds);
  if (unloadable.length > 0) {
    return { ok: false, installed: [], skipped, unloadable, error: unloadableSkillsError(unloadable) };
  }
  if (files.length === 0) {
    // Nothing installable — succeed iff there was genuinely nothing to do.
    return { ok: skipped.length === 0, installed: [], skipped };
  }

  const res = await seedSkillFilesOntoBox(dir, ip, files, env);
  if (!res.ok) return { ok: false, installed: [], skipped, error: res.error };
  return { ok: true, installed: files.map((f) => f.id), skipped };
}
