// The models a computer's agent CLI can be switched between, and the effort
// levels the chat can ask for. One list for both places that offer them: the
// computer's Settings and the chat's model picker, so they never disagree.

export interface BoxModelOption {
  value: string;
  label: string;
}

// Curated model choices per CLI. "Default" = clear the override (the CLI's own
// default / whatever the user's plan resolves). The claude values are CLI
// ALIASES — the CLI resolves them to the newest build, so this list doesn't go
// stale when Anthropic ships new versions. Codex ids are the ChatGPT-account
// allowlist; both CLIs also accept a custom id typed in the free-text field.
export const BOX_MODEL_OPTIONS: Record<string, BoxModelOption[]> = {
  claude: [
    { value: "", label: "Default" },
    { value: "fable", label: "Fable" },
    { value: "opus", label: "Opus" },
    { value: "sonnet", label: "Sonnet" },
    { value: "haiku", label: "Haiku" },
  ],
  codex: [
    { value: "", label: "Default" },
    { value: "gpt-5.5", label: "GPT-5.5" },
    { value: "gpt-5.1-codex-max", label: "Codex Max" },
    { value: "gpt-5.1-codex", label: "Codex" },
    { value: "gpt-5-codex", label: "Codex (5)" },
  ],
};

/** The effort levels the chat knows how to word, in order. A computer offers some of them. */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

const EFFORT_LABELS: Record<EffortLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value);
}

export function effortLabel(level: string): string {
  return isEffortLevel(level) ? EFFORT_LABELS[level] : level;
}

/**
 * The levels a computer's `GET /api/meta` offers as `chatEffort`: only the
 * levels the chat knows, once each, in the chat's order. Anything else (no
 * field, a non-list, unknown words) is "this computer takes no effort".
 */
export function parseChatEffort(value: unknown): EffortLevel[] {
  if (!Array.isArray(value)) return [];
  const offered = new Set(value.filter(isEffortLevel));
  return EFFORT_LEVELS.filter((level) => offered.has(level));
}

/** The label of a model id in a CLI's list, or the id itself when it is a custom one. */
export function modelLabelFor(cliKind: string, model: string | null | undefined): string {
  const options = BOX_MODEL_OPTIONS[cliKind] || [];
  const id = (model || "").trim();
  return options.find((option) => option.value === id)?.label || id;
}
