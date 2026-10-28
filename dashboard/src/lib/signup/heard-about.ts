// "How did you hear about Hivra?" on /sign-up (R8, 28 Oct 2026).
//
// The answer rides into Clerk as unsafe metadata (the only bucket the client
// SDK can write at sign-up, and it reaches OAuth sign-ups too), so every new
// account keeps it whether or not the visitor accepted analytics cookies. With
// consent, PostHogIdentify also folds it into signup_completed and onto the
// PostHog person, next to the first-touch UTM and referrer stash.
//
// The answer is optional and self-reported: treat it as a hint, never as proof.

export const HEARD_ABOUT_OPTIONS = [
  { value: "search", label: "Search engine (Google, Bing)" },
  { value: "ai_assistant", label: "AI assistant (ChatGPT, Claude, Perplexity)" },
  { value: "x", label: "X (Twitter)" },
  { value: "youtube", label: "YouTube" },
  { value: "reddit", label: "Reddit" },
  { value: "hacker_news", label: "Hacker News" },
  { value: "github", label: "GitHub" },
  { value: "friend", label: "A friend or colleague" },
  { value: "blog_or_newsletter", label: "A blog, newsletter or podcast" },
  { value: "other", label: "Somewhere else" },
] as const;

export type HeardAboutValue = (typeof HEARD_ABOUT_OPTIONS)[number]["value"];

export const HEARD_ABOUT_OTHER_MAX_LENGTH = 100;

const HEARD_ABOUT_VALUES = new Set<string>(HEARD_ABOUT_OPTIONS.map((option) => option.value));

// Same first-touch keys the PostHog provider stashes in hermes:signup_attribution.
export const SIGNUP_ATTRIBUTION_STORAGE_KEY = "hermes:signup_attribution";
const ATTRIBUTION_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "referrer",
  "landing_page",
] as const;
const ATTRIBUTION_VALUE_MAX_LENGTH = 256;

export type HeardAboutAnswer = {
  heard_about: HeardAboutValue;
  heard_about_other?: string;
};

export function isHeardAboutValue(value: unknown): value is HeardAboutValue {
  return typeof value === "string" && HEARD_ABOUT_VALUES.has(value);
}

function cleanOther(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim().slice(0, HEARD_ABOUT_OTHER_MAX_LENGTH);
  return trimmed || undefined;
}

/** A clean answer from the form state, or null when the visitor skipped it. */
export function buildHeardAboutAnswer(value: string, other?: string): HeardAboutAnswer | null {
  if (!isHeardAboutValue(value)) return null;
  const detail = value === "other" ? cleanOther(other) : undefined;
  return detail ? { heard_about: value, heard_about_other: detail } : { heard_about: value };
}

/**
 * Reads the answer back from a Clerk user's unsafe metadata. Anyone can write
 * unsafe metadata from the browser, so only known values pass.
 */
export function readHeardAboutAnswer(metadata: unknown): HeardAboutAnswer | null {
  if (!metadata || typeof metadata !== "object") return null;
  const record = metadata as Record<string, unknown>;
  if (!isHeardAboutValue(record.heard_about)) return null;
  return buildHeardAboutAnswer(record.heard_about, typeof record.heard_about_other === "string" ? record.heard_about_other : undefined);
}

/** Only the known first-touch keys, as non-empty strings of bounded length. */
export function cleanSignupAttribution(value: unknown): Record<string, string> {
  const attribution: Record<string, string> = {};
  if (!value || typeof value !== "object") return attribution;
  const record = value as Record<string, unknown>;
  for (const key of ATTRIBUTION_KEYS) {
    const entry = record[key];
    if (typeof entry === "string" && entry) attribution[key] = entry.slice(0, ATTRIBUTION_VALUE_MAX_LENGTH);
  }
  return attribution;
}

/** The first-touch stash (UTM set, external referrer, landing page), cleaned. */
export function readStoredSignupAttribution(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(SIGNUP_ATTRIBUTION_STORAGE_KEY);
    return raw ? cleanSignupAttribution(JSON.parse(raw)) : {};
  } catch {
    // localStorage unavailable or the stash unparseable: attribution is best-effort.
    return {};
  }
}

/** What /sign-up hands Clerk as unsafeMetadata for the new user. */
export function buildSignupUnsafeMetadata(
  answer: HeardAboutAnswer | null,
  attribution: Record<string, string>,
): Record<string, unknown> {
  return {
    ...(answer ?? {}),
    ...(Object.keys(attribution).length > 0 ? { signup_attribution: attribution } : {}),
  };
}
