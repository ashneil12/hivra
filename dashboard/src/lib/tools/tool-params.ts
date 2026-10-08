// URL parameters for the free tools: parse and serialize each tool's inputs.
//
// Rules (docs: free-tools pipeline, section 3.2):
// - Only the structured answers travel in a link. Free text a visitor types
//   (a command, a session name) stays in their own browser: it may be personal,
//   and a link that carried it could put someone else's text in front of a
//   reader who then pastes it into a shell.
// - Values are checked against an allow-list or clamped, and unknown values
//   fall back to the default, so a hand-edited link never breaks the page.
// - Defaults are left out, so the default state has no query string, and the
//   canonical URL stays the tool's base URL.
// - The page renders its defaults on the server. Components read the link on
//   mount and write it back with history.replaceState; nothing here touches
//   the router, so the tool pages stay static.

import {
  KEEP_AWAKE_DEFAULTS,
  KEEP_AWAKE_DURATIONS,
  KEEP_AWAKE_LID,
  KEEP_AWAKE_OS,
  KEEP_AWAKE_POWER,
  KEEP_AWAKE_PRESET_COMMANDS,
  clampHours,
  type KeepAwakeInput,
} from "./keep-awake";
import {
  TMUX_BUILDER_DEFAULTS,
  TMUX_LINK_AGENTS,
  type TmuxAgent,
  type TmuxBuilderInput,
} from "./tmux-sheet";

/** The query keys each tool owns. Every other key (utm_source, ref...) is left alone. */
export const KEEP_AWAKE_PARAM_KEYS = ["os", "duration", "hours", "power", "lid", "cmd"] as const;
export const TMUX_PARAM_KEYS = ["agent", "log"] as const;

/** The value if it is one of the allowed strings, else the fallback. */
export function pickOne<T extends string>(value: string | null | undefined, allowed: readonly T[], fallback: T): T {
  return allowed.find((candidate) => candidate === value) ?? fallback;
}

// ---- Keep-awake -----------------------------------------------------------

/** Parse a query string ("?os=linux&hours=12" or without the "?") into the inputs. */
export function parseKeepAwakeParams(search: string): KeepAwakeInput {
  const params = new URLSearchParams(search);
  const duration = pickOne(params.get("duration"), KEEP_AWAKE_DURATIONS, KEEP_AWAKE_DEFAULTS.duration);
  const rawHours = Number.parseInt(params.get("hours") ?? "", 10);
  return {
    os: pickOne(params.get("os"), KEEP_AWAKE_OS, KEEP_AWAKE_DEFAULTS.os),
    duration,
    hours: duration === "hours" && Number.isFinite(rawHours) ? clampHours(rawHours) : KEEP_AWAKE_DEFAULTS.hours,
    power: pickOne(params.get("power"), KEEP_AWAKE_POWER, KEEP_AWAKE_DEFAULTS.power),
    lid: pickOne(params.get("lid"), KEEP_AWAKE_LID, KEEP_AWAKE_DEFAULTS.lid),
    command: pickOne(params.get("cmd"), KEEP_AWAKE_PRESET_COMMANDS, KEEP_AWAKE_DEFAULTS.command),
  };
}

/** The query string (no leading "?") for the inputs: only non-default, link-safe values. */
export function serializeKeepAwakeParams(input: KeepAwakeInput): string {
  const params = new URLSearchParams();
  if (input.os !== KEEP_AWAKE_DEFAULTS.os) params.set("os", input.os);
  if (input.duration !== KEEP_AWAKE_DEFAULTS.duration) {
    params.set("duration", input.duration);
    if (clampHours(input.hours) !== KEEP_AWAKE_DEFAULTS.hours) params.set("hours", String(clampHours(input.hours)));
  }
  if (input.power !== KEEP_AWAKE_DEFAULTS.power) params.set("power", input.power);
  if (input.lid !== KEEP_AWAKE_DEFAULTS.lid) params.set("lid", input.lid);
  // Only a preset command travels; a typed one does not.
  const preset = KEEP_AWAKE_PRESET_COMMANDS.find((candidate) => candidate === input.command.trim());
  if (preset && preset !== KEEP_AWAKE_DEFAULTS.command) params.set("cmd", preset);
  return params.toString();
}

// ---- tmux builder ---------------------------------------------------------

export function parseTmuxParams(search: string): TmuxBuilderInput {
  const params = new URLSearchParams(search);
  const agent: TmuxAgent = pickOne(params.get("agent"), TMUX_LINK_AGENTS, "claude");
  return {
    ...TMUX_BUILDER_DEFAULTS,
    agent,
    logging: params.get("log") === "on",
  };
}

export function serializeTmuxParams(input: TmuxBuilderInput): string {
  const params = new URLSearchParams();
  if (input.agent === "codex") params.set("agent", "codex");
  if (input.logging) params.set("log", "on");
  return params.toString();
}

// ---- Browser glue ---------------------------------------------------------

/** The current query string, or "" where there is no window (server render, tests without a DOM). */
export function currentSearch(): string {
  try {
    return typeof window === "undefined" ? "" : window.location.search;
  } catch {
    return "";
  }
}

/**
 * The current query string with this tool's own keys replaced by `next` (a query
 * string without the leading "?"). Keys the tool does not own, such as utm tags
 * or a referral code, are kept in place.
 */
export function mergeSearch(current: string, ownKeys: readonly string[], next: string): string {
  const merged = new URLSearchParams(current);
  for (const key of ownKeys) merged.delete(key);
  for (const [key, value] of new URLSearchParams(next)) merged.append(key, value);
  return merged.toString();
}

/** The page's own address with this query string, hash kept. */
export function urlWithSearch(search: string): string {
  const query = search.replace(/^\?/, "");
  const { pathname, hash } = window.location;
  return `${pathname}${query ? `?${query}` : ""}${hash}`;
}

/**
 * Write the tool's answers into the address bar without adding a history entry
 * or re-rendering the route. Other query keys are kept, and nothing is written
 * when the address would not change.
 */
export function replaceToolSearch(next: string, ownKeys: readonly string[]): void {
  try {
    const merged = mergeSearch(window.location.search, ownKeys, next);
    if (merged === window.location.search.replace(/^\?/, "")) return;
    window.history.replaceState(null, "", urlWithSearch(merged));
  } catch {
    // History can be blocked (sandboxed frames, some previews). The tool still works.
  }
}

/** Absolute link to the current setup, for the "copy link" button: only the tool's own answers. */
export function absoluteLinkFor(search: string): string {
  const query = search.replace(/^\?/, "");
  const { origin, pathname } = window.location;
  return `${origin}${pathname}${query ? `?${query}` : ""}`;
}
