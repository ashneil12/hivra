// Sitemap <lastmod> dates: the day each page's visible content or structured
// data last changed in a way a reader or crawler would notice.
//
// Google uses lastmod only when it is consistently and verifiably accurate, and
// names faked freshness as a red flag, so these are never bumped site-wide and
// never set to a release date. Each entry below is the last content change,
// checked against the git author dates of the page's own source files on
// 2026-09-30. The public repository's history starts on 2026-09-21 (the source
// release), so a page untouched since then keeps the last date recorded before
// it.
//
// Keep it true:
//  - Change a page's visible text, prices or JSON-LD: set its entry to that day.
//  - Metadata-only, refactor or styling changes do NOT move the date
//    (/terms got its own title and canonical on 2026-09-24; its text is older).
//  - A blog post carries its own lastModified in its article module; the blog
//    index follows the newest of them.
//  - The agent pages carry theirs in AGENT_PAGES_LAST_MODIFIED (lib/hivra).
//
// seo-urls.ts applies CUTOVER_LAST_MODIFIED as a floor to the pages the cutover
// rewrote; everything else keeps the date below.

export const PAGE_LAST_MODIFIED = {
  // Content and JSON-LD changed again on 2026-09-30 (hero, pricing section, FAQ,
  // identity markup).
  home: "2026-09-30",
  // /pricing gained its table, Offer JSON-LD and "Prices as of" line on
  // 2026-09-30; its prices were last checked that day (PRICES_AS_OF).
  pricing: "2026-09-30",
  // Hubs were rewritten in plain English on 2026-09-30.
  featuresHub: "2026-09-30",
  compareHub: "2026-09-30",
  // The detail pages share one template that last changed in the 2026-09-24
  // truth pass (speed, backup, import and price claims removed, FAQs changed).
  featureDetail: "2026-09-24",
  compareDetail: "2026-09-24",
  // The /tools hub lists every tool, and gained two on 2026-09-30 (the keep-awake
  // command builder and the tmux cheat sheet). Each tool page has its own date in
  // TOOL_PAGE_LAST_MODIFIED below.
  tools: "2026-09-30",
  // Phase-aware token copy and official accounts, 2026-09-24.
  token: "2026-09-24",
  // The founder note was reworded on 2026-09-30 (open source, no preview label).
  whyHivra: "2026-09-30",
  // Retitled and labelled as the April 2026 plan, then given its "not the Hermes
  // Agent roadmap" line, 2026-09-30.
  roadmap: "2026-09-30",
  // The newest entry in hermes_changelog.md is dated 2026-06-21.
  changelog: "2026-06-21",
  // The status page's content is from June; 2026-09-23 only removed a dash from
  // its title.
  status: "2026-06-22",
  // The /stats call to action stopped advertising a hosted free tier on
  // 2026-09-30.
  stats: "2026-09-30",
  // Google Analytics named as a processor and consent wording, 2026-09-24.
  privacy: "2026-09-24",
  // New pages, written 2026-09-30. /about replaced a 308 to the founder note.
  about: "2026-09-30",
  security: "2026-09-30",
  // The terms text is from 2026-03-01; 2026-09-24 only added its own title and
  // canonical.
  terms: "2026-03-01",
} as const;

export type PageLastModifiedKey = keyof typeof PAGE_LAST_MODIFIED;

/**
 * Each tool page's last change to its own content, by slug. The block of related
 * tools every tool page shares is boilerplate and does not move a page's date,
 * so the three older tools keep the day they were restored and truth-checked.
 * The /tools hub follows PAGE_LAST_MODIFIED.tools. Adding a tool means adding its
 * slug here: seo-urls.test.ts fails on a missing or stale slug.
 */
export const TOOL_PAGE_LAST_MODIFIED: Record<string, string> = {
  // New copy, a method section with linked sources, worked examples and re-read
  // figures, 2026-09-30.
  "claude-code-plan-calculator": "2026-09-30",
  // Restored and truth-checked on 2026-09-24, unchanged since. The plan facts
  // the limit-reset tool now imports change none of its output.
  "agent-survival-check": "2026-09-24",
  "ai-agent-hosting-cost-calculator": "2026-09-24",
  "claude-code-limit-reset-calculator": "2026-09-24",
  // Added on 2026-09-30.
  "keep-mac-awake": "2026-09-30",
  "tmux-cheat-sheet": "2026-09-30",
};

/** An ISO day as a Date at 00:00 UTC, for the sitemap. */
export function dayToDate(day: string): Date {
  return new Date(`${day}T00:00:00Z`);
}
