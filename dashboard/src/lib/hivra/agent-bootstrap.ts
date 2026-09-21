// Hivra agent bootstrap — turn a launch's onboarding (goal + context) into the
// identity files a fresh box wakes up with, and seed them onto the box.
//
// WHAT GETS WRITTEN (on the box, $HOME = /home/bux):
//   ~/SOUL.md          — the agent's identity (name, emoji, personality, role,
//                        operating principle). Canonical + user-editable.
//   ~/USER.md          — the evolving model of the user (goal, onboarding
//                        context, starter offers, preferences). The agent keeps
//                        this current as it learns — this is the continuity loop.
//   ~/system-prompt.md — a delimited bootstrap block APPENDED (idempotently)
//                        between markers. This is the file the CLI always reads
//                        (~/CLAUDE.md and ~/AGENTS.md symlink to it), so the
//                        identity + first-conversation rules are guaranteed to be
//                        in context every session — the read-back path. The base
//                        Hivra persona above the block is preserved untouched.
//
// DELIVERY: we reuse the selected Proxmox host's SSH machinery
// (runProxmoxHostScript). The host root user SSHes into the guest (key
// /etc/hivra/keys/vm-orchestrator, the same key the provisioner uses) and
// writes the files. Everything is double base64-encoded so no markdown/quoting
// ever reaches a shell. Idempotent: safe to re-run (re-seed on identity change
// just replaces the marked block).

import { runProxmoxHostScript, type HostScriptResult } from "@/lib/services/proxmox-instance-service";
import { getGoal, deriveIdentity, type Identity, type GoalDef } from "./agent-identity";
import { MAX_CONTEXT_LEN } from "./agent-limits";
import type { BoxLlmPayload } from "./agent-llm";
import { getPersonaSoul } from "@/lib/persona-souls-accessor";
// TODO(paioclaw-riplist): the operatoros-kb skill is the follow-up to make
// Sloane (OperatorOS) KB-retrieval sections fully functional on the box — the
// full soul prompt references a knowledge base the box doesn't ship yet.

export const BOOTSTRAP_START = "<!-- HIVRA:BOOTSTRAP:START -->";
export const BOOTSTRAP_END = "<!-- HIVRA:BOOTSTRAP:END -->";

// Defensive cap on the shared-memory fold. The account-memory lib already clamps
// on write (MAX_ACCOUNT_MEMORY_LEN); we clamp again here so a stale/oversized
// blob can never bloat a box's USER.md regardless of how it reached this seed.
export const MAX_SHARED_MEMORY_FOLD_LEN = 4000;

export interface BootstrapAgent {
  id: string;
  name?: string | null;
  type?: string | null;
  ip?: string | null;
  goal?: string | null;
  context?: string | null;
  personality?: string | null;
  emoji?: string | null;
  /** Deploy-time LLM provider choice — written to ~/.hivra/llm-provider.json. */
  llm?: BoxLlmPayload | null;
  /**
   * Account-level shared memory (Wave 5.1) — the user-controlled blob that is
   * folded read-only into this box's USER.md as a `## Shared account memory`
   * section. Fetched at the seed call site (the agent GET-poll route) and passed
   * in here; "" / null / undefined → no section added. The box's USER.md still
   * evolves independently afterwards (no write-back), so per-box isolation holds.
   */
  sharedMemory?: string | null;
  /**
   * (Persona-souls upgrade) When set to a known persona-soul id (see
   * persona-souls.json / getPersonaSoul), the agent's SOUL.md is seeded with the
   * FULL authored soul prompt instead of the generic identity template. Unknown /
   * null / undefined → the generic template is used unchanged (custom "Build your
   * own" personas and the no-persona path all land here). USER.md and the
   * system-prompt.md bootstrap block are unaffected and continue to use the
   * derived identity + goal as before.
   */
  soulPromptId?: string | null;
}

export interface BootstrapContent {
  soul: string;
  user: string;
  /** The full marked block to append to system-prompt.md (includes markers). */
  promptBlock: string;
}

interface Resolved {
  identity: Identity;
  goal: GoalDef;
  context: string;
  /** Plain-language capability line, tailored to the underlying agent/CLI. */
  capabilities: string;
  /** Trimmed + clamped account-level shared memory ("" when none). */
  sharedMemory: string;
  /** Resolved persona-soul id to use for SOUL.md ("" when none/unknown). */
  soulPromptId: string;
}

// Each agent type ships different tools — the identity should say so honestly
// (Claude Code has a live browser; Codex doesn't). Mirrors the per-kind base
// persona the provisioner installs (system-prompt.md vs system-prompt-codex.md).
function capabilitiesFor(type?: string | null): string {
  if (type === "codex") return "write and run code, and use a full terminal";
  // claude-code (and any future claude-CLI agent)
  return "drive a real browser, write and run code, and use a full terminal";
}

function resolve(agent: BootstrapAgent): Resolved {
  const goal = getGoal(agent.goal);
  const identity = deriveIdentity(agent.goal, {
    name: agent.name ?? undefined,
    emoji: agent.emoji ?? undefined,
    personality: agent.personality ?? undefined,
  });
  const context = (agent.context || "").trim().slice(0, MAX_CONTEXT_LEN);
  const sharedMemory = (agent.sharedMemory || "").trim().slice(0, MAX_SHARED_MEMORY_FOLD_LEN);
  // Only persist a soulPromptId that actually resolves to an authored soul; an
  // unknown/stale id collapses to "" so buildSoul falls back to the generic
  // template (zero-regression).
  const soulPromptId = getPersonaSoul(agent.soulPromptId) ? String(agent.soulPromptId) : "";
  return { identity, goal, context, capabilities: capabilitiesFor(agent.type), sharedMemory, soulPromptId };
}

function buildSoul({ identity, goal, capabilities, soulPromptId }: Resolved): string {
  // Persona-souls upgrade: when a persona with an authored soul was chosen, seed
  // SOUL.md with that FULL prompt verbatim — the persona owns its complete
  // identity. The custom "Build your own" persona and the no-persona path have no
  // soulPromptId, so they fall through to the generic template below unchanged.
  const personaSoul = getPersonaSoul(soulPromptId);
  if (personaSoul) return personaSoul.soulPrompt;

  return `# SOUL.md — ${identity.emoji} ${identity.name}

You are **${identity.name}** ${identity.emoji}.

- **Personality:** ${identity.personality}
- **Purpose:** ${goal.label} — ${goal.description}
- **You can:** ${capabilities}.
- **Signature:** ${identity.emoji} (use it sparingly, as yourself)

## Core operating principle
Understand first, plan second, execute third. Never jump straight to execution —
get the objective clear before you try to solve it.

## Directives
- You are a persistent worker, not a disposable chat. Build continuity across
  conversations; you become more useful over time.
- Be useful before being thorough — the first useful outcome matters more than
  perfect setup.
- Keep \`~/USER.md\` current as you learn what matters to your user.
- Default to reversible actions; confirm before anything destructive or hard to undo.

*This file is your identity. You may refine it over time, but keep it true to who you are.*
`;
}

function buildUser({ goal, context, sharedMemory }: Resolved): string {
  const starters = goal.starters.map((s) => `- ${s}`).join("\n");
  const contextSection = context
    ? context
    : "_(none provided at onboarding — learn this as you go)_";
  // Account-level shared memory (Wave 5.1): folded in read-only so a brand-new
  // box starts "warm" with what the account has taught. Only added when the user
  // has actually set something — an empty account memory leaves USER.md untouched.
  const sharedSection = sharedMemory
    ? `\n## Shared account memory
_(Set by your user at the account level — applies to all of their agents. This is
read-only context to start from; keep your own per-conversation learnings below.)_

${sharedMemory}
`
    : "";
  return `# USER.md — what I know about my user

## Goal
${goal.label} — ${goal.description}

## Context from onboarding
${contextSection}
${sharedSection}
## What I can help with right now
${starters}

## Preferences discovered so far
_(empty — fill this in as you learn how your user likes to work)_

---
*Keep this file current. When you learn something durable about your user — their
goals, preferences, projects, or how they like to work — write it here. This is
how you remember what matters across conversations.*
`;
}

function buildPromptBlock({ identity, goal, context, capabilities }: Resolved): string {
  const goalLower = goal.label.toLowerCase();
  const contextClause = context ? " and the context they gave you" : "";
  const body = `## Your identity (${identity.name} ${identity.emoji})

You are **${identity.name}** ${identity.emoji} — ${identity.personality}. Your purpose: ${goal.label}.
You can ${capabilities}.
Your canonical identity is in \`~/SOUL.md\` and your evolving model of your user is in
\`~/USER.md\`. Read both at the start of every session, and keep \`~/USER.md\` updated as
you learn what matters.

### Your first conversation
If this is your first conversation (no earlier sessions), this is the moment you come
online. You have no memories yet — that's normal. Do this, and nothing more ceremonial:

1. Open with one line: who you are ("${identity.name} ${identity.emoji}, here to help with
   ${goalLower}") and that they can rename or retune you anytime. Don't interrogate. Don't
   run a survey. Don't ask for a name/personality/emoji — you already have them.
2. You already know their goal${contextClause} (see \`~/USER.md\`). Don't re-ask what
   onboarding already answered.
3. Immediately offer a few specific, relevant things you can do right now — drawn from
   their actual goal and context, not a generic menu — and get to work on whatever they pick.

The first useful outcome matters more than perfect onboarding. Once your identity is set
and you have enough to help, start helping.

If you somehow have no goal or context at all, ask ONE orienting question, then proceed.

### How you work
Understand → plan → execute. Actively look for ways to be more useful over time. Remember
what matters. Behave like a trusted operator, not a disposable chat session.`;
  return `\n${BOOTSTRAP_START}\n${body}\n${BOOTSTRAP_END}\n`;
}

/** Pure: build the three identity artifacts from an agent row. Exported for tests. */
export function buildBootstrapContent(agent: BootstrapAgent): BootstrapContent {
  const r = resolve(agent);
  return { soul: buildSoul(r), user: buildUser(r), promptBlock: buildPromptBlock(r) };
}

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");

// The script that runs ON the guest (as root via sudo). Writes SOUL.md + USER.md
// and idempotently replaces the marked block in system-prompt.md. All file
// contents arrive base64-encoded so nothing in them touches the shell. When the
// launch picked an alternative LLM provider, also writes ~/.hivra/llm-provider.json
// (0600 — it holds the API key; the chat server reads it per spawn).
export function buildGuestScript(content: BootstrapContent, llm?: BoxLlmPayload | null): string {
  const soulB64 = b64(content.soul);
  const userB64 = b64(content.user);
  const blockB64 = b64(content.promptBlock);
  const llmSection = llm
    ? `mkdir -p "$BUX/.hivra"
printf '%s' '${b64(JSON.stringify(llm) + "\n")}' | base64 -d > "$BUX/.hivra/llm-provider.json"
chown -R bux:bux "$BUX/.hivra" 2>/dev/null || true
chmod 0600 "$BUX/.hivra/llm-provider.json" 2>/dev/null || true
`
    : "";
  return `set -e
BUX=/home/bux
[ -d "$BUX" ] || { echo "no box home" >&2; exit 1; }
umask 022
printf '%s' '${soulB64}' | base64 -d > "$BUX/SOUL.md"
printf '%s' '${userB64}' | base64 -d > "$BUX/USER.md"
chown bux:bux "$BUX/SOUL.md" "$BUX/USER.md" 2>/dev/null || true
chmod 0644 "$BUX/SOUL.md" "$BUX/USER.md" 2>/dev/null || true
${llmSection}SP="$BUX/system-prompt.md"
if [ -f "$SP" ]; then
  awk '
/${BOOTSTRAP_START}/{skip=1}
!skip{print}
/${BOOTSTRAP_END}/{skip=0}
' "$SP" > "$SP.hivratmp" 2>/dev/null || cp "$SP" "$SP.hivratmp"
  printf '%s' '${blockB64}' | base64 -d >> "$SP.hivratmp"
  mv "$SP.hivratmp" "$SP"
  chown bux:bux "$SP" 2>/dev/null || true
fi
echo HIVRA_SEED_OK
`;
}

// The script that runs ON the selected Proxmox host (as root). SSHes into the
// guest with the same host->guest key the provisioner uses and feeds it the
// (base64-wrapped) guest script over stdin.
function buildHostScript(ip: string, guestScript: string): string {
  const outer = b64(guestScript);
  return `#!/usr/bin/env bash
set -euo pipefail
KEY=/etc/hivra/keys/vm-orchestrator
[ -f "$KEY" ] || { echo "vm key $KEY missing" >&2; exit 1; }
OUTER='${outer}'
ssh -i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15 -o BatchMode=yes "ubuntu@${ip}" "echo '$OUTER' | base64 -d | sudo bash"
`;
}

export interface SeedResult {
  ok: boolean;
  error?: string;
}

// Seed the identity files onto a running box. Best-effort and idempotent — the
// caller guards on a one-time `bootstrapped_at` and simply retries on the next
// poll if this returns ok:false.
export async function seedAgentBox(
  agent: BootstrapAgent,
  env: Parameters<typeof runProxmoxHostScript>[1],
): Promise<SeedResult> {
  const ip = (agent.ip || "").trim();
  if (!/^[0-9.]+$/.test(ip)) return { ok: false, error: "missing or invalid box ip" };
  const content = buildBootstrapContent(agent);
  const script = buildHostScript(ip, buildGuestScript(content, agent.llm));
  let res: HostScriptResult;
  try {
    // Cap well under the poll route's 60s maxDuration — the SSH connect is 15s
    // and the write is instant, so a hang can't starve the request budget.
    res = await runProxmoxHostScript(script, env, 25_000);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  if (res.ok && /HIVRA_SEED_OK/.test(res.stdout || "")) return { ok: true };
  return { ok: false, error: (res.error || res.stderr || "seed failed").slice(0, 200) };
}
