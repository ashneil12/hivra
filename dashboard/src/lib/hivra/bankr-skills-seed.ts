// Hivra Bankr skills seeding — push the curated Bankr skill suite onto a Hivra
// CLI box (codex / claude-code) once it's running.
//
// WHY THIS EXISTS SEPARATELY FROM THE HERMES LANE: the Hermes lane preinstalls
// the same suite at launch by POSTing each skill to the agent web API
// (instance-service.ts → `/api/skills/save`). A Hivra box's `server.js` exposes
// only GET/DELETE on `/api/skills` — there is no write endpoint — so we write the
// skill files straight into the box's per-CLI skills dir, which its skills lister
// already reads from. Delivery reuses agent-bootstrap.ts's machinery exactly:
// host->guest SSH via runProxmoxHostScript, base64-wrapped so no skill markdown
// ever touches a shell. Idempotent — overwrites the files on every attempt; the
// caller guards on `hivra_agents.bankr_skills_seeded_at`.
//
// Skills are static curated content and DON'T need a wallet to be installed
// (deliberate — see the 2026-05-12 decoupling note in instance-service.ts). The
// per-box Bankr wallet is a separate, later concern.

import { CURATED_SKILLS } from "@/data/curated-skills";
import { runProxmoxHostScript, type HostScriptResult } from "@/lib/services/proxmox-instance-service";

// Per-CLI skills dir, relative to the box user's $HOME (/home/bux). Claude reads
// ~/.claude/skills; codex reads ~/.agents/skills (the OpenAI skills spec dir —
// NOT ~/.codex/skills; see the hivra-add-agent gotchas). Any agent type absent
// here is out of scope and never seeded.
const SKILLS_DIR_BY_TYPE: Record<string, string> = {
  "claude-code": ".claude/skills",
  codex: ".agents/skills",
};

/** The box-relative skills dir for an agent type, or null if it gets no Bankr skills. */
export function bankrSkillsDirForType(type?: string | null): string | null {
  if (!type) return null;
  return SKILLS_DIR_BY_TYPE[type] ?? null;
}

export interface BankrSkillFile {
  /** Unique, filesystem-safe directory slug derived from the catalog identifier. */
  slug: string;
  /** SKILL.md content. */
  content: string;
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

/** The Bankr skills with non-empty vendored content, each given a unique slug. */
export function collectBankrSkillFiles(): BankrSkillFile[] {
  const files: BankrSkillFile[] = [];
  const seen = new Set<string>();
  for (const skill of CURATED_SKILLS) {
    if (skill.category !== "bankr") continue;
    if (typeof skill.content !== "string" || !skill.content.trim()) continue;
    const base = bankrSkillSlug(skill.identifier);
    if (!base) continue;
    let slug = base;
    let n = 2;
    while (seen.has(slug)) slug = `${base}-${n++}`;
    seen.add(slug);
    files.push({ slug, content: skill.content });
  }
  return files;
}

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");

// The script that runs ON the guest (as root via sudo). Writes each skill to
// $HOME/<dir>/<slug>/SKILL.md. base64 contains no quotes, so each payload is safe
// inside single quotes. Self-contained + idempotent (overwrites on re-run).
export function buildBankrSkillsGuestScript(dir: string, files: BankrSkillFile[]): string {
  const writes = files
    .map(
      (f) =>
        `mkdir -p "$ROOT/${f.slug}"\nprintf '%s' '${b64(f.content)}' | base64 -d > "$ROOT/${f.slug}/SKILL.md"`
    )
    .join("\n");
  return `set -e
BUX=/home/bux
[ -d "$BUX" ] || { echo "no box home" >&2; exit 1; }
umask 022
ROOT="$BUX/${dir}"
mkdir -p "$ROOT"
${writes}
chown -R bux:bux "$ROOT" 2>/dev/null || true
echo HIVRA_BANKR_SKILLS_OK
`;
}

// The script that runs ON the selected Proxmox host (as root). STREAMS the
// base64-wrapped guest script to the guest over STDIN — the suite is large
// (dozens of skills), so the inline `ssh host "echo '$OUTER' | base64 -d | ..."`
// form used by agent-bootstrap would blow the inner command-line length limit.
// Same host->guest key + ssh options the provisioner uses.
export function buildBankrSkillsHostScript(ip: string, guestScript: string): string {
  const outer = b64(guestScript);
  return `#!/usr/bin/env bash
set -euo pipefail
KEY=/etc/hivra/keys/vm-orchestrator
[ -f "$KEY" ] || { echo "vm key $KEY missing" >&2; exit 1; }
printf '%s' '${outer}' | ssh -i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15 -o BatchMode=yes "ubuntu@${ip}" "base64 -d | sudo bash"
`;
}

export interface BankrSkillsSeedAgent {
  id: string;
  type?: string | null;
  ip?: string | null;
}

export interface BankrSkillsSeedResult {
  ok: boolean;
  count: number;
  skipped?: "unsupported_type" | "no_skills";
  error?: string;
}

// Seed the curated Bankr skills onto a running box. Best-effort and idempotent —
// the caller guards on a one-time `bankr_skills_seeded_at` and retries on the
// next poll if this returns ok:false.
export async function seedBankrSkillsOntoBox(
  agent: BankrSkillsSeedAgent,
  env: Parameters<typeof runProxmoxHostScript>[1],
): Promise<BankrSkillsSeedResult> {
  const dir = bankrSkillsDirForType(agent.type);
  if (!dir) return { ok: false, count: 0, skipped: "unsupported_type" };
  const ip = (agent.ip || "").trim();
  if (!/^[0-9.]+$/.test(ip)) return { ok: false, count: 0, error: "missing or invalid box ip" };
  const files = collectBankrSkillFiles();
  if (files.length === 0) return { ok: false, count: 0, skipped: "no_skills" };

  const result = await seedSkillFilesOntoBox(dir, ip, files, env);
  if (result.ok) return { ok: true, count: files.length };
  return { ok: false, count: 0, error: result.error };
}

// Generic skill-file delivery: write an arbitrary set of {slug, content} SKILL.md
// files into a box's per-CLI skills dir, reusing the exact host->guest SSH
// plumbing the Bankr seed uses (base64-wrapped, streamed over stdin, gated on
// the HIVRA_BANKR_SKILLS_OK marker). The in-app skill installer
// (skill-install.ts) builds on this so there is ONE SSH path to the box, not two.
export async function seedSkillFilesOntoBox(
  dir: string,
  ip: string,
  files: BankrSkillFile[],
  env: Parameters<typeof runProxmoxHostScript>[1],
): Promise<{ ok: boolean; error: string }> {
  const script = buildBankrSkillsHostScript(ip, buildBankrSkillsGuestScript(dir, files));
  let res: HostScriptResult;
  try {
    // Cap under the poll route's 60s maxDuration. SSH connect is ~15s; writing a
    // few dozen small files is instant, so a hang can't starve the request budget.
    res = await runProxmoxHostScript(script, env, 30_000);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  if (res.ok && /HIVRA_BANKR_SKILLS_OK/.test(res.stdout || "")) return { ok: true, error: "" };
  return { ok: false, error: (res.error || res.stderr || "seed failed").slice(0, 200) };
}
