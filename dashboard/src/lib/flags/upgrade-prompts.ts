// Free→paid upgrade-moment flags.
//
// Both moments ship DARK: the flags default OFF so the customer-facing pricing
// copy never renders in production until Ash has reviewed it and flipped the
// build-env var on. Mirrors the isHivraEnabled() shape (a NEXT_PUBLIC_ build-env
// switch) and adds a `?upsellPreview=1` escape hatch so Ash can eyeball either
// pitch on canary or a Vercel preview without touching the real flags.
//
// The hatch is OPT-IN per environment and fails CLOSED: the URL param only
// works when the build sets NEXT_PUBLIC_HERMES_UPSELL_PREVIEW (canary/preview
// builds). An unset var can never open the hatch, so on prod (which leaves it
// unset) the param is inert and only the real flags can enable a surface.
//
// NEXT_PUBLIC_* vars are inlined at build time by Next.js (no next.config
// registration needed); when unset they resolve to `undefined`, i.e. OFF.

function envOn(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "on";
}

function previewParamOn(param: string): boolean {
  if (typeof window === "undefined") return false;
  if (!envOn(process.env.NEXT_PUBLIC_HERMES_UPSELL_PREVIEW)) return false;
  try {
    return new URLSearchParams(window.location.search).get(param) === "1";
  } catch {
    return false;
  }
}

/** Moment #1 — the sleep→wake "always-on" pitch on the instance page. */
export function isSleepUpgradePromptEnabled(): boolean {
  if (envOn(process.env.NEXT_PUBLIC_HERMES_SLEEP_UPGRADE_PROMPT_ENABLED)) return true;
  return previewParamOn("upsellPreview");
}

/** Moment #2 — the "your agent did X → go Pro" footer on the usage page. */
export function isUsageUpgradeCtaEnabled(): boolean {
  if (envOn(process.env.NEXT_PUBLIC_HERMES_USAGE_UPGRADE_CTA_ENABLED)) return true;
  return previewParamOn("upsellPreview");
}

/**
 * Moment #3 — the archive/preservation wall on the instance page. Shown to a
 * FREE agent that has been inactivity-paused and is counting down toward the
 * dormant-reclaim archive (its SOUL/memory/workspace about to be packed away).
 * Ships DARK: never renders in production until Ash reviews the loss-aversion
 * copy and flips the build-env var on.
 */
export function isArchiveUpgradeWallEnabled(): boolean {
  if (envOn(process.env.NEXT_PUBLIC_HERMES_ARCHIVE_UPGRADE_WALL_ENABLED)) return true;
  return previewParamOn("upsellPreview");
}

/**
 * Moment #4 — the second-agent upgrade wall. When a FREE user (1 base-agent cap)
 * tries to launch a 2nd agent and hits FREE_INSTANCE_LIMIT_REACHED, the welcome
 * flow's "Upgrade plan" CTA opens the shared UpgradePaywallModal instead of a
 * bare billing redirect. Default OFF so the copy stays under review; the #520
 * "Open/Restore your agent" primary CTA is unaffected either way.
 */
export function isSecondAgentUpgradeEnabled(): boolean {
  if (envOn(process.env.NEXT_PUBLIC_HERMES_SECOND_AGENT_UPGRADE_ENABLED)) return true;
  return previewParamOn("upsellPreview");
}
