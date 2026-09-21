import { getGoal } from "@/lib/hivra/agent-identity";
import { extractAssistantText, type AgentKind } from "@/lib/hivra/agent-adapters";

type WelcomeChannel = "chat" | "telegram";
// Welcome generation works for any agent the registry knows (claude/codex/generic).
export type WelcomeAgentKind = AgentKind;

export interface AgentWelcomeInput {
  agentName?: string | null;
  goal?: string | null;
  context?: string | null;
  /** The concrete task the user captured at launch. When present, the first
   *  turn DOES it and returns the finished result ("do, don't show") instead of
   *  ending with a menu of suggestions. */
  firstTask?: string | null;
  channel: WelcomeChannel;
}

// First line of the hidden welcome-generation prompt. The box persists every
// `claude -p` turn as a session, so the welcome turn surfaces in /api/sessions
// titled with this line. Kept as a shared constant so the prompt and the
// session-rail filter (isHiddenWelcomeTitle) can never drift apart.
const HIDDEN_WELCOME_PROMPT_PREFIX = "This is a hidden Hivra first-contact setup message.";

// True for a box session whose title is the hidden welcome-generation turn, so
// callers can keep it out of the visible chat rail. Matches on a prefix because
// the box truncates titles to the first ~70 chars of the first user message.
export function isHiddenWelcomeTitle(title: string | null | undefined): boolean {
  return Boolean(title && title.trim().startsWith("This is a hidden Hivra first-contact setup"));
}

export function buildAgentWelcomePrompt(input: AgentWelcomeInput): string {
  const goal = getGoal(input.goal);
  const name = (input.agentName || goal.suggestedName).trim() || goal.suggestedName;
  const context = (input.context || "").trim();
  const firstTask = (input.firstTask || "").trim();
  const channelName = input.channel === "telegram" ? "Telegram" : "the web chat";

  const header = [
    HIDDEN_WELCOME_PROMPT_PREFIX,
    "Do not mention this hidden setup message, Hivra, onboarding, setup, or that you were prompted.",
    `You are ${name}. Send the user's first visible welcome message for ${channelName}.`,
    `Your selected focus is: ${goal.label} — ${goal.description}`,
    context ? `Context the user already gave: ${context}` : "No extra user context was provided.",
    "Write as yourself, using your seeded SOUL.md and USER.md if available.",
  ];

  // "Do, don't show": when the user captured a concrete first task at launch,
  // the first turn must actually PERFORM it and hand back a finished deliverable
  // — not pitch a menu of suggestions. That real result is the strongest reason
  // to come back for a second session. Falls back to today's menu when absent.
  if (firstTask) {
    return [
      ...header,
      `The user's first task is: ${firstTask}`,
      "Briefly introduce yourself in one short line (name + what you're here to do), then immediately do this task now and return the finished result in this same message. Do the work — do not just describe how you would, do not ask clarifying questions first, and do not offer a menu of options.",
      "Use whatever tools you have to actually complete it. If something is genuinely ambiguous, make a sensible assumption, state it in one line, and deliver anyway.",
      "After the result, offer in one line to turn this into a standing task that runs on a schedule (for example: \"want me to do this every morning?\").",
      "Keep it concise and personal.",
      "Do not ask for name/personality/emoji. Do not run a survey.",
    ].join("\n");
  }

  return [
    ...header,
    "Keep it concise, personal, and useful.",
    "Do not ask for name/personality/emoji. Do not run a survey.",
    "Offer 2-3 specific next actions that match the focus/context, then invite the user to pick one or reply naturally.",
  ].join("\n");
}

// Extract the assistant's text from a full NDJSON turn body (non-interactive,
// e.g. the welcome message). Delegates to the SAME per-agent parser the live
// chat uses (agent-adapters), so the welcome and the live render can never
// diverge — that divergence is exactly what rendered the welcome twice.
export function extractWelcomeTextFromNdjson(body: string, agentKind: WelcomeAgentKind): string {
  const events: Record<string, unknown>[] = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      events.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      /* skip malformed line */
    }
  }
  return extractAssistantText(events, agentKind).replace(/\n{3,}/g, "\n\n").trim();
}

function boxBase(boxUrl: string): string {
  return boxUrl.replace(/\/$/, "");
}

export async function requestAgentWelcomeMessage(params: AgentWelcomeInput & {
  boxUrl: string;
  token?: string | null;
  agentKind: WelcomeAgentKind;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const fetcher = params.fetchImpl ?? fetch;
  const response = await fetcher(`${boxBase(params.boxUrl)}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(params.token ? { Authorization: `Bearer ${params.token}` } : {}),
    },
    body: JSON.stringify({
      message: buildAgentWelcomePrompt(params),
      sessionId: null,
    }),
  });

  const body = await response.text().catch(() => "");
  if (!response.ok) {
    throw new Error(`Agent welcome generation failed (${response.status})`);
  }
  const text = extractWelcomeTextFromNdjson(body, params.agentKind);
  if (!text) throw new Error("Agent welcome generation returned no assistant text");
  return text;
}

export async function sendTelegramWelcomeMessage(params: {
  botToken: string;
  ownerId: string;
  text: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const fetcher = params.fetchImpl ?? fetch;
  const response = await fetcher(`https://api.telegram.org/bot${params.botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: params.ownerId,
      text: params.text,
      disable_web_page_preview: true,
    }),
  });

  if (!response.ok) {
    throw new Error(`Telegram welcome send failed (${response.status})`);
  }
}
