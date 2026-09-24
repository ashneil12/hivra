import "server-only";

// The launch seeds for Claude Code and Codex on a computer in the owner's own
// cloud (ATT-05). On Hivra Cloud and My server the agent poll writes, once
// each: the identity files (SOUL.md, USER.md and the block in
// system-prompt.md), the curated Bankr skills, and a template's skills. On a
// provider VM they were skipped without a word. This sends the same guest
// scripts over the provider seed lane, all pending parts in one connection,
// and reports which parts the computer confirmed so each is stamped once.
//
// Model settings are not part of it: a provider launch already delivered them
// in the installer's launch document.

import { gzipSync } from "node:zlib";

import { getAccountMemory } from "@/lib/account-memory";
import { buildBootstrapContent, buildGuestScript, type BootstrapAgent } from "./agent-bootstrap";
import { bankrSkillsDirForType, buildBankrSkillsGuestScript, collectBankrSkillFiles } from "./bankr-skills-seed";
import { collectSkillFilesForIds } from "./skill-install";
import { coerceSkillIds } from "./template-skills";
import { runProviderAgentGuestScript } from "./provider-guest-seed";

export type ProviderAgentSeedPart = "bootstrap" | "bankr-skills" | "template-skills";

/** The row fields that decide which seeds are still due. */
export interface ProviderAgentSeedRow {
  id: string;
  user_id?: string | null;
  type?: string | null;
  name?: string | null;
  status?: string | null;
  computer_substrate?: string | null;
  goal?: string | null;
  context?: string | null;
  personality?: string | null;
  emoji?: string | null;
  soul_prompt_id?: string | null;
  template_skills?: unknown;
  bootstrapped_at?: string | null;
  bankr_skills_seeded_at?: string | null;
  template_skills_seeded_at?: string | null;
}

/** Seeds still due for a running Claude Code or Codex agent on a provider VM. */
export function providerAgentSeedsDue(row: ProviderAgentSeedRow): ProviderAgentSeedPart[] {
  if (row.computer_substrate !== "provider-vm" || row.status !== "running") return [];
  if (row.type !== "claude-code" && row.type !== "codex") return [];
  const due: ProviderAgentSeedPart[] = [];
  if (!row.bootstrapped_at) due.push("bootstrap");
  if (bankrSkillsDirForType(row.type)) {
    if (!row.bankr_skills_seeded_at && collectBankrSkillFiles().length > 0) due.push("bankr-skills");
    if (!row.template_skills_seeded_at && coerceSkillIds(row.template_skills).length > 0) due.push("template-skills");
  }
  return due;
}

const PART_MARKER = "HIVRA_PROVIDER_SEED_PART";
const PART_OK: Record<ProviderAgentSeedPart, string> = {
  bootstrap: "HIVRA_SEED_OK",
  "bankr-skills": "HIVRA_BANKR_SKILLS_OK",
  "template-skills": "HIVRA_BANKR_SKILLS_OK",
};

// The part scripts already carry their files as base64; compressing before
// the outer encoding keeps the Bankr suite well inside the lane's size bound.
const packed = (value: string) => gzipSync(Buffer.from(value, "utf8"), { level: 9 }).toString("base64");

/**
 * One guest script that runs each part's own script on its own, so a failed
 * part never hides another's success. A part counts only when its script
 * printed its success marker; the combined script then names it on a line of
 * its own. Every payload is gzip and base64 inside single quotes.
 */
export function buildProviderAgentSeedScript(parts: ReadonlyArray<{ part: ProviderAgentSeedPart; script: string }>): string {
  const runs = parts.map(({ part, script }) => `out=$(printf '%s' '${packed(script)}' | base64 -d | gzip -dc | /bin/bash 2>/dev/null) || true
case "$out" in *${PART_OK[part]}*) echo "${PART_MARKER} ${part}" ;; esac`);
  return `set -e
${runs.join("\n")}
echo HIVRA_PROVIDER_SEED_DONE
`;
}

/** The parts the computer confirmed, from the combined script's output. */
export function parseProviderAgentSeedOutput(stdout: string, requested: readonly ProviderAgentSeedPart[]): ProviderAgentSeedPart[] {
  if (!stdout.split("\n").includes("HIVRA_PROVIDER_SEED_DONE")) return [];
  const confirmed = new Set(stdout.split("\n").filter((line) => line.startsWith(`${PART_MARKER} `)).map((line) => line.slice(PART_MARKER.length + 1)));
  return requested.filter((part) => confirmed.has(part));
}

type Dependencies = { run: typeof runProviderAgentGuestScript; sharedMemory: typeof getAccountMemory };
const defaults: Dependencies = { run: runProviderAgentGuestScript, sharedMemory: getAccountMemory };

/**
 * Deliver the due seeds in one connection. Returns the parts the computer
 * confirmed; the caller stamps exactly those. Nothing is confirmed when the
 * computer can't be reached, so the next poll tries again.
 */
export async function seedProviderAgent(
  userId: string,
  row: ProviderAgentSeedRow,
  dependencies: Partial<Dependencies> = {},
): Promise<{ attempted: ProviderAgentSeedPart[]; confirmed: ProviderAgentSeedPart[] }> {
  const deps = { ...defaults, ...dependencies };
  const due = providerAgentSeedsDue(row);
  if (due.length === 0) return { attempted: [], confirmed: [] };
  const dir = bankrSkillsDirForType(row.type) ?? "";
  const parts: Array<{ part: ProviderAgentSeedPart; script: string }> = [];
  for (const part of due) {
    if (part === "bootstrap") {
      const agent: BootstrapAgent = {
        id: row.id, name: row.name ?? null, type: row.type ?? null, goal: row.goal ?? null, context: row.context ?? null,
        personality: row.personality ?? null, emoji: row.emoji ?? null, soulPromptId: row.soul_prompt_id ?? null,
        sharedMemory: await deps.sharedMemory(userId),
      };
      parts.push({ part, script: buildGuestScript(buildBootstrapContent(agent), null) });
    } else if (part === "bankr-skills") {
      parts.push({ part, script: buildBankrSkillsGuestScript(dir, collectBankrSkillFiles()) });
    } else {
      const { files } = collectSkillFilesForIds(coerceSkillIds(row.template_skills));
      if (files.length > 0) parts.push({ part, script: buildBankrSkillsGuestScript(dir, files) });
    }
  }
  if (parts.length === 0) return { attempted: [], confirmed: [] };
  const attempted = parts.map(({ part }) => part);
  const outcome = await deps.run({ userId, agentId: row.id }, buildProviderAgentSeedScript(parts));
  return { attempted, confirmed: outcome.ok ? parseProviderAgentSeedOutput(outcome.stdout, attempted) : [] };
}
