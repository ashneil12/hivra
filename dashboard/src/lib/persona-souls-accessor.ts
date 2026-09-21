// Persona souls accessor — typed, build-time-bundled access to the full
// OperatorOS-caliber soul prompts authored per persona.
//
// The prompt bodies live in `persona-souls.json` (a JSON module so any
// backticks / ${} / quotes in the prompt content are stored verbatim with zero
// escaping risk). This module is the ONLY typed entry point: both the client
// persona catalog and the server-side Hivra bootstrap import `getPersonaSoul`.
//
// Why JSON-import (not fs.readFile): the JSON is bundled at build time, so there
// is zero runtime I/O and it is Vercel-safe (no filesystem reads in a serverless
// function). Webpack/Turbopack tree-shakes nothing away (it's a single object),
// but it is parsed once and cached by the module system.
//
// ZERO-REGRESSION CONTRACT: this is purely additive. A persona without a
// `soulPromptId`, the "Build your own" custom persona, and the no-persona path
// all resolve to `null` here, and every consumer falls back to its existing
// generic template unchanged.

import PERSONA_SOULS_DATA from "@/lib/persona-souls.json";

/** Stable persona-soul ids. Keep in lockstep with the keys in persona-souls.json
 *  and the `soulPromptId` values referenced by WELCOME_PERSONAS. */
export type PersonaSoulId = "bea" | "sloane" | "pike" | "marlo" | "sable" | "lane";

export interface PersonaSoulDef {
  /** Display name baked into the soul prompt (e.g. "Bea"). */
  name: string;
  /** Short role label (e.g. "Assistant", "Engineer"). */
  role: string;
  /** The full multi-hundred-line soul prompt that seeds the agent's SOUL.md. */
  soulPrompt: string;
}

const PERSONA_SOULS = PERSONA_SOULS_DATA as Record<string, PersonaSoulDef | undefined>;

/**
 * Resolve the full soul prompt for a persona-soul id.
 * Returns null for any unknown / empty id (custom persona, no-persona path, or a
 * stale id), so every caller can fall through to its existing generic behavior.
 */
export function getPersonaSoul(id: string | null | undefined): PersonaSoulDef | null {
  if (!id) return null;
  const soul = PERSONA_SOULS[id];
  if (!soul || typeof soul.soulPrompt !== "string" || !soul.soulPrompt.trim()) return null;
  return soul;
}

/** Convenience: just the prompt text, or "" when there is no matching soul. */
export function getPersonaSoulPrompt(id: string | null | undefined): string {
  return getPersonaSoul(id)?.soulPrompt ?? "";
}

/**
 * Recognize which authored persona soul (if any) a stored Hermes system prompt
 * was built from.
 *
 * buildHermesWelcomeSystemPrompt composes `soulPrompt.trim()` as the BASE of
 * config.agentSettings.systemPrompt (followed by a first-run block), and the
 * welcome flow does not thread a separate soulPromptId through the Hermes
 * create path — the stored prompt itself is the only durable persona signal.
 * Prefix-matching here lets the provisioning layer seed the authored soul into
 * the box's SOUL.md from nothing but the instance's stored config, which also
 * covers provision-mode recovery redrives for free.
 *
 * Returns null for a personalization-only prompt (custom persona / firstRun
 * block with no soul base), an empty prompt, or anything else — every caller
 * falls through to existing behavior (the who-am-I onboarding ritual).
 */
export function resolvePersonaSoulFromSystemPrompt(
  systemPrompt: string | null | undefined
): { id: PersonaSoulId; soulPrompt: string } | null {
  if (typeof systemPrompt !== "string") return null;
  const stored = systemPrompt.trim();
  if (!stored) return null;
  for (const id of Object.keys(PERSONA_SOULS) as PersonaSoulId[]) {
    const soul = PERSONA_SOULS[id];
    const soulPrompt = soul?.soulPrompt?.trim();
    // Souls are multi-KB documents with distinct openings — a prefix match
    // cannot false-positive on short/generic prompts. Skip degenerate entries
    // defensively so a corrupted souls file can never match everything.
    if (!soulPrompt || soulPrompt.length < 500) continue;
    if (stored.startsWith(soulPrompt)) return { id, soulPrompt: soul!.soulPrompt };
  }
  return null;
}
