/**
 * Mobile persona catalog — the consumer-language projection of
 * WELCOME_PERSONAS served by GET /api/mobile/personas (iOS Phase 2).
 *
 * The app renders quiz cards straight from this shape, so it must contain
 * ZERO engine jargon: no agentTypeKey ("Runs on Hermes Agent" chips stay
 * web-only), no soulPromptId, no personality prompt-clause, no icon keys.
 * The server keeps owning the persona → soul/personality mapping inside
 * POST /api/mobile/launch; the phone only ever sees ids + display copy.
 *
 * `suggestedFirstTasks` are authored here (2–3 per persona, derived from each
 * persona's soul/pitch — the first-deliverable convention: lead with what the
 * specialist produces, in words a non-technical person would say). They feed
 * the "What's the first thing {name} should do?" chips collected during the
 * provisioning wait. The unit test enforces that every catalog persona has
 * authored tasks, so adding a persona without consumer copy fails CI instead
 * of silently shipping an empty quiz step.
 */

import {
  WELCOME_PERSONAS,
  type WelcomePersonaDefinition,
} from "@/lib/welcome-persona-catalog";

export interface MobilePersona {
  /** Stable persona id — echoed back to POST /api/mobile/launch. */
  id: string;
  /** Specialist display name (e.g. "Bea"); the custom card's CTA label. */
  displayName: string;
  role: string;
  pitch: string;
  emoji: string;
  /** Preset goal id (consumer copy for goals lives app-side). */
  goal: string;
  /** True for the "Build your own" card (app reveals name/emoji/expertise inputs). */
  isCustom: boolean;
  /** 2–3 consumer-language starter tasks for the first-task chips. */
  suggestedFirstTasks: string[];
}

/**
 * Authored per-persona starter tasks. Keyed by persona id (the LOCKED legacy
 * ids — atlas/dev/margo/scout/quill — not display names; see the catalog's
 * never-rename rule).
 */
const SUGGESTED_FIRST_TASKS: Record<string, string[]> = {
  // Bea — Assistant ("clears your inbox and hands you a today plan")
  atlas: [
    "Sort out my inbox and give me a plan for today",
    "Plan my week and flag anything I'm about to drop",
    "Draft replies to the messages waiting on me",
  ],
  // Sloane — Founder mate ("interviews you, drafts your week-one plan")
  sloane: [
    "Interview me about my business, then draft a week-one plan",
    "Tell me the three numbers I should be watching",
    "Turn my to-do pile into this week's priorities",
  ],
  // Pike — Engineer ("reads the code, ships the first fix")
  dev: [
    "Look at my project and fix the first thing you find",
    "Build me a simple tool I'll describe in one sentence",
    "Set up a website for my idea",
  ],
  // Marlo — Marketer ("campaign plan and three ready-to-post pieces")
  margo: [
    "Turn my product into a simple campaign plan",
    "Write three ready-to-post pieces about what I sell",
    "Draft a launch announcement people will actually read",
  ],
  // Sable — Researcher ("a sourced brief, bottom line up top")
  scout: [
    "Answer a hard question and show me your sources",
    "Compare my top options and recommend one",
    "Dig into a market and give me the bottom line",
  ],
  // Lane — Writer ("a publishable draft in your voice")
  quill: [
    "Turn my rough idea into a finished draft",
    "Rewrite something I wrote so it sounds like me on a good day",
    "Draft next week's newsletter from my bullet points",
  ],
  // Build your own — generic, since the expertise is user-authored.
  custom: [
    "Introduce yourself and ask what I need most",
    "Take one job off my plate today",
  ],
};

function toMobilePersona(persona: WelcomePersonaDefinition): MobilePersona {
  return {
    id: persona.id,
    displayName: persona.name,
    role: persona.role,
    pitch: persona.pitch,
    emoji: persona.emoji,
    goal: persona.goal,
    isCustom: Boolean(persona.isCustom),
    suggestedFirstTasks: SUGGESTED_FIRST_TASKS[persona.id] ?? [],
  };
}

/** The full catalog, in display order (Bea first, "Build your own" last). */
export function buildMobilePersonaCatalog(): MobilePersona[] {
  return WELCOME_PERSONAS.map(toMobilePersona);
}
