// Adapted from MonoCode (MIT License, Copyright (c) 2026 Nick); see THIRD_PARTY_LICENSES/monocode.txt.
/**
 * How much of the model context window the session is currently occupying.
 *
 * This is a level, not a running total: every harness reports the size of the
 * prompt it just sent, so the newest reading replaces the previous one. That
 * keeps compaction free — once the harness compacts, its next report is simply
 * smaller.
 */
export type ContextUsage = {
  /** Tokens in the context window as of the last request. */
  used: number;
  /** Context window for the active model, when the harness reports one. */
  window?: number;
};

/**
 * Fraction of the window in use, or null when the window is unknown.
 *
 * Not clamped: a reading above 1 means the level passed the window we were
 * told about, which is a wrong window (or a route reporting a whole-turn
 * total) — worth showing as itself rather than as a full ring. Callers that
 * draw something clamp the geometry; the number stays honest.
 */
export function contextRatio(usage: ContextUsage | undefined): number | null {
  if (!usage || !usage.window || usage.window <= 0) return null;
  if (!Number.isFinite(usage.used) || usage.used < 0) return null;
  return usage.used / usage.window;
}

/** Whole-percent context used, or null when the window is unknown. */
export function contextPercent(usage: ContextUsage | undefined): number | null {
  const ratio = contextRatio(usage);
  if (ratio === null) return null;
  return Math.round(ratio * 100);
}

/** Compact token count for chrome: 980, 176K, 1.2M. */
export function formatTokens(count: number): string {
  if (!Number.isFinite(count) || count < 0) return "0";
  if (count < 1000) return String(Math.round(count));
  if (count < 1_000_000) {
    const thousands = count / 1000;
    return `${thousands < 10 ? thousands.toFixed(1).replace(/\.0$/, "") : Math.round(thousands)}K`;
  }
  const millions = count / 1_000_000;
  return `${millions < 10 ? millions.toFixed(1).replace(/\.0$/, "") : Math.round(millions)}M`;
}

/**
 * Two-line hover text: "69% context used" over "176K / 256K tokens".
 *
 * Over the window adds a third line, because an over-full reading means the
 * window we were told about is wrong rather than the session really being past
 * it — worth saying out loud instead of leaving a ring pinned at 100%.
 */
export function contextTooltip(usage: ContextUsage): {
  headline: string;
  detail: string;
  note?: string;
} {
  const percent = contextPercent(usage);
  const over = isOverWindow(usage);
  return {
    headline:
      percent === null ? "Context used" : `${percent}% context used`,
    detail: usage.window
      ? `${formatTokens(usage.used)} / ${formatTokens(usage.window)} tokens`
      : `${formatTokens(usage.used)} tokens`,
    ...(over
      ? { note: "More than this model's reported window; auto-compact uses that window." }
      : {}),
  };
}

/** True when the last reading is larger than the window we were given. */
export function isOverWindow(usage: ContextUsage | undefined): boolean {
  const ratio = contextRatio(usage);
  return ratio !== null && ratio > 1;
}

/**
 * Merge a fresh reading into what we already know.
 *
 * Harnesses split the two halves across different messages — Claude reports the
 * window only on the turn `result`, well after the first usage arrives — so a
 * reading without a window keeps the last known one.
 */
export function mergeContextUsage(
  previous: ContextUsage | undefined,
  next: { used?: number; window?: number },
): ContextUsage {
  const used = next.used ?? previous?.used ?? 0;
  const window = next.window ?? previous?.window;
  return window ? { used, window } : { used };
}

/**
 * What the open chat's context holds, from its replies: the newest reading of
 * how much the prompt used, with the window the newest reply that named one
 * gave. Undefined until a reply has reported usage.
 */
export function contextUsageOf(replies: ReadonlyArray<{ usage?: ContextUsage } | undefined>): ContextUsage | undefined {
  let usage: ContextUsage | undefined;
  for (const reply of replies) {
    if (reply?.usage) usage = mergeContextUsage(usage, reply.usage);
  }
  return usage;
}

/**
 * Forget the window while keeping the level.
 *
 * The window is a property of the model, so switching models invalidates it.
 * The level still roughly holds — it describes the transcript, not the model —
 * and the next turn re-reports both.
 */
export function dropContextWindow(
  usage: ContextUsage | undefined,
): ContextUsage | undefined {
  if (!usage) return undefined;
  return { used: usage.used };
}
