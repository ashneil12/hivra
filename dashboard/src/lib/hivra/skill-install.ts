import "server-only";

// In-app skill installer (Wave 3). Browse the curated catalog, one-click install
// a skill onto a running Hivra CLI box. The box's server.js exposes only
// GET/DELETE on /api/skills (no write endpoint), so — exactly like the Bankr
// seed — we write the SKILL.md straight into the box's per-CLI skills dir over
// SSH (host->guest, base64-wrapped). This reuses bankr-skills-seed's proven SSH
// plumbing (`seedSkillFilesOntoBox`) rather than duplicating it; the only new
// logic here is resolving catalog ids → {slug, content} files and the per-call
// gating/result shape.
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
import type { runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";

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
 * the ids that couldn't be resolved (unknown / contentless). Slugs are unique
 * per call so two requested skills never collide on disk — same scheme the Bankr
 * suite uses (slug from the identifier, deduped with a numeric suffix).
 */
export function collectSkillFilesForIds(skillIds: string[]): {
  files: (BankrSkillFile & { id: string })[];
  skipped: string[];
} {
  const files: (BankrSkillFile & { id: string })[] = [];
  const skipped: string[] = [];
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
    let slug = base;
    let n = 2;
    while (seenSlugs.has(slug)) slug = `${base}-${n++}`;
    seenSlugs.add(slug);
    files.push({ id, slug, content: entry.content });
  }
  return { files, skipped };
}

/**
 * Install the given curated skills onto a running box over SSH. Returns the ids
 * that were written and the ids that were skipped (unknown / contentless). On an
 * SSH/transport failure NOTHING is reported installed (the write is one atomic
 * guest script — partial success isn't observable), and `error` is set.
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

  const { files, skipped } = collectSkillFilesForIds(skillIds);
  if (files.length === 0) {
    // Nothing installable — succeed iff there was genuinely nothing to do.
    return { ok: skipped.length === 0, installed: [], skipped };
  }

  const res = await seedSkillFilesOntoBox(dir, ip, files, env);
  if (!res.ok) return { ok: false, installed: [], skipped, error: res.error };
  return { ok: true, installed: files.map((f) => f.id), skipped };
}
