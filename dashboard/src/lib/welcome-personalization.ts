import { DEFAULT_GOAL_ID, getGoal, type GoalId } from "@/lib/hivra/agent-identity";
import { MAX_CONTEXT_LEN } from "@/lib/hivra/agent-limits";
import { getPersonaSoulPrompt } from "@/lib/persona-souls-accessor";

export interface WelcomePersonalizationDraft {
  goal?: string | null;
  context?: string | null;
  firstTask?: string | null;
  // ── Persona-first onboarding (paioclaw-riplist wave) ──────────────────────
  // Additive identity + audience fields captured on the persona/personalization
  // step. All optional so every existing caller (which only reads
  // goal/context/firstTask) keeps working unchanged. personality/emoji are
  // derived from the chosen persona and sent to the box; agentName/who/business/
  // goals enrich the seeded system prompt.
  personality?: string | null;
  emoji?: string | null;
  /** The user's display name for the agent (mirrors the launch name input). */
  agentName?: string | null;
  /** "Who are you?" single-select chip (Founder/Developer/Marketer/...). */
  who?: string | null;
  /** One-line description of the user's business/product. */
  business?: string | null;
  /** Multi-select goal labels the user wants help with. */
  goals?: string[] | null;
  /**
   * (Persona-souls upgrade) The chosen persona's authored-soul id
   * (persona-souls.json key). When set + resolvable, the FULL soul prompt becomes
   * the base of the Hermes system prompt. Absent / unknown → the agent-type's
   * basePrompt is used exactly as before (zero-regression).
   */
  soulPromptId?: string | null;
}

export interface NormalizedWelcomePersonalization {
  goal: GoalId;
  context: string;
  firstTask: string;
}

export interface ParsedWelcomePersonalizationContext {
  context: string;
  firstTask: string;
  who: string;
  business: string;
  goals: string[];
}

function clamp(value: string | null | undefined, max: number): string {
  return (value || "").trim().slice(0, max);
}

export function normalizeWelcomePersonalizationDraft(
  draft: WelcomePersonalizationDraft | null | undefined,
): NormalizedWelcomePersonalization {
  const goal = getGoal(draft?.goal).id;
  return {
    goal,
    context: clamp(draft?.context, MAX_CONTEXT_LEN),
    firstTask: clamp(draft?.firstTask, 700),
  };
}

export function hasWelcomePersonalization(draft: WelcomePersonalizationDraft | null | undefined): boolean {
  const normalized = normalizeWelcomePersonalizationDraft(draft);
  const goals = Array.isArray(draft?.goals) ? draft!.goals!.filter((g) => (g || "").trim()) : [];
  return Boolean(
    normalized.goal !== DEFAULT_GOAL_ID ||
      normalized.context ||
      normalized.firstTask ||
      // Persona-first onboarding: a chosen persona/identity or audience answer
      // should also count as "personalized" even when the goal stays default.
      (draft?.personality || "").trim() ||
      (draft?.emoji || "").trim() ||
      (draft?.who || "").trim() ||
      (draft?.business || "").trim() ||
      goals.length
  );
}

/**
 * Clamp a raw launch-capture payload to the lengths persisted on the
 * hermes_instances goal/first_task/context columns (Wave 1.2). Unlike
 * normalizeWelcomePersonalizationDraft this does NOT coerce the goal to the
 * default — an absent/blank goal stays absent so the lifecycle email can fall
 * back to generic copy rather than mailing about "a bit of everything" when the
 * user never picked. Returns trimmed values; empty strings collapse to null so
 * the column is written as NULL rather than "".
 */
export function normalizeWelcomeLaunchCapture(
  input: {
    goal?: string | null;
    firstTask?: string | null;
    context?: string | null;
  } | null | undefined,
): { goal: string | null; firstTask: string | null; context: string | null } {
  const goal = clamp(input?.goal, 64);
  const firstTask = clamp(input?.firstTask, 700);
  const context = clamp(input?.context, MAX_CONTEXT_LEN);
  return {
    goal: goal || null,
    firstTask: firstTask || null,
    context: context || null,
  };
}

export function buildWelcomePersonalizationContext(
  draft: WelcomePersonalizationDraft | null | undefined,
): string {
  const normalized = normalizeWelcomePersonalizationDraft(draft);
  const who = (draft?.who || "").trim();
  const business = (draft?.business || "").trim();
  const goals = Array.isArray(draft?.goals)
    ? draft!.goals!.map((g) => (g || "").trim()).filter(Boolean)
    : [];
  const audienceLines = [
    who ? `- Who they are: ${who}` : null,
    business ? `- Their business / product: ${business}` : null,
    goals.length ? `- What they want help with: ${goals.join(", ")}` : null,
  ].filter((line): line is string => line !== null);
  const lines = [
    ...(audienceLines.length ? ["## About the user", ...audienceLines, ""] : []),
    "## Context from launch setup",
    normalized.context || "_No extra context provided yet._",
    "",
    "## First task to demonstrate value",
    normalized.firstTask || "_Ask one orienting question, then suggest a concrete first task._",
  ];
  return lines.join("\n").slice(0, MAX_CONTEXT_LEN);
}

/**
 * Recover the editable answers from the markdown document stored for a Hivra
 * launch. The provisioning page receives the composed document, but its form
 * must edit the original values instead of nesting the document inside itself
 * every time the page mounts.
 */
export function parseWelcomePersonalizationContext(
  value: string | null | undefined,
): ParsedWelcomePersonalizationContext {
  const text = clamp(value, MAX_CONTEXT_LEN);
  const emptyAudience = { who: "", business: "", goals: [] as string[] };
  const aboutHeading = "## About the user";
  const contextHeading = "## Context from launch setup";
  const firstTaskHeading = "## First task to demonstrate value";
  const contextHeadingIndex = text.lastIndexOf(contextHeading);
  if (contextHeadingIndex < 0) {
    return { context: text, firstTask: "", ...emptyAudience };
  }

  const aboutHeadingIndex = text.lastIndexOf(aboutHeading, contextHeadingIndex);
  const audienceBlock = aboutHeadingIndex < 0
    ? ""
    : text.slice(aboutHeadingIndex + aboutHeading.length, contextHeadingIndex);
  const audienceValue = (prefix: string): string => {
    const line = audienceBlock
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .find((entry) => entry.startsWith(prefix));
    return line ? line.slice(prefix.length).trim() : "";
  };
  const audience = {
    who: audienceValue("- Who they are:"),
    business: audienceValue("- Their business / product:"),
    goals: audienceValue("- What they want help with:")
      .split(",")
      .map((goal) => goal.trim())
      .filter(Boolean),
  };

  const contextStart = contextHeadingIndex + contextHeading.length;
  const firstTaskHeadingIndex = text.indexOf(firstTaskHeading, contextStart);
  if (firstTaskHeadingIndex < 0) {
    return { context: text.slice(contextStart).trim(), firstTask: "", ...audience };
  }

  const context = text.slice(contextStart, firstTaskHeadingIndex).trim();
  const firstTaskStart = firstTaskHeadingIndex + firstTaskHeading.length;
  const nextHeadingIndex = text.indexOf("\n\n## ", firstTaskStart);
  const firstTask = text
    .slice(firstTaskStart, nextHeadingIndex < 0 ? undefined : nextHeadingIndex)
    .trim();
  return {
    context: context === "_No extra context provided yet._" ? "" : context,
    firstTask:
      firstTask === "_Ask one orienting question, then suggest a concrete first task._"
        ? ""
        : firstTask,
    ...audience,
  };
}

export function buildHermesWelcomeSystemPrompt(input: {
  agentName?: string | null;
  draft?: WelcomePersonalizationDraft | null;
  basePrompt?: string | null;
}): string {
  const normalized = normalizeWelcomePersonalizationDraft(input.draft);
  const goal = getGoal(normalized.goal);
  const name = (input.agentName || goal.suggestedName).trim() || goal.suggestedName;
  // Persona-souls upgrade: when the chosen persona has an authored soul, that FULL
  // prompt becomes the base — the persona owns its complete identity. When there
  // is no soul (custom persona / no persona), fall back to the agent-type's
  // basePrompt exactly as before. The firstRun launch block is still appended in
  // both cases so the agent always knows the captured goal/context/first task.
  const soulPrompt = getPersonaSoulPrompt(input.draft?.soulPromptId).trim();
  const base = (soulPrompt || input.basePrompt || "").trim();

  // Persona identity + audience (additive; absent → prompt is unchanged).
  const personality = (input.draft?.personality || goal.personality).trim();
  const who = (input.draft?.who || "").trim();
  const business = (input.draft?.business || "").trim();
  const goalsList = Array.isArray(input.draft?.goals)
    ? input.draft!.goals!.map((g) => (g || "").trim()).filter(Boolean)
    : [];

  const firstRun = [
    `You are ${name}.`,
    personality ? `Your personality: ${personality}.` : null,
    `Primary launch focus: ${goal.label} - ${goal.description}`,
    who ? `The user describes themselves as: ${who}.` : null,
    business ? `Their business / product: ${business}.` : null,
    goalsList.length ? `What they want help with: ${goalsList.join(", ")}.` : null,
    normalized.context ? `Launch context from the user: ${normalized.context}` : "No extra launch context was provided yet.",
    normalized.firstTask
      ? `The first task the user wants demonstrated: ${normalized.firstTask}`
      : "No first task was provided yet.",
    "",
    "When the user first messages you in web chat or Telegram:",
    "1. Briefly acknowledge the launch focus and any context above.",
    "2. If the first task is present, start helping with that task immediately.",
    "3. If the first task is missing, ask one orienting question and offer two concrete starter tasks from the launch focus.",
    "4. Keep learning durable preferences and update USER.md or memory when the runtime supports it.",
    "5. Do not ask the user to redo answers already captured during launch.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  return [base, firstRun].filter(Boolean).join("\n\n---\n\n");
}
