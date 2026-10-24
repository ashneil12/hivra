// Sitemap <lastmod> dates: the day each page's visible content or structured
// data last changed in a way a reader or crawler would notice.
//
// Google uses lastmod only when it is consistently and verifiably accurate, and
// names faked freshness as a red flag, so these are never bumped for a release
// and never set to a day nothing changed. Each entry below is the last content
// change, checked against the git author dates of the page's own source files on
// 2026-09-30. The public repository's history starts on 2026-09-21 (the source
// release), so a page untouched since then keeps the last date recorded before
// it.
//
// 2026-10-20 is the one day the copy of the whole public site was rewritten
// (the website copy overhaul: new text on every page below). Each entry that
// moved to it notes the date it held before, so a page that does not ship the
// new text can go back to that date.
//
// Keep it true:
//  - Change a page's visible text, prices or JSON-LD: set its entry to that day.
//  - Metadata-only, refactor or styling changes do NOT move the date
//    (/terms got its own title and canonical on 2026-09-24; its text is older).
//  - A blog post carries its own lastModified in its article module; the blog
//    index follows the newest of them.
//  - The agent pages carry theirs in AGENT_PAGES_LAST_MODIFIED (lib/hivra).
//  - The four host comparisons carry the later of COMPETITOR_FACTS_CHECKED
//    (lib/compare) and the compareDetail entry below.
//
// seo-urls.ts applies CUTOVER_LAST_MODIFIED as a floor to the pages the cutover
// rewrote; everything else keeps the date below.

export const PAGE_LAST_MODIFIED = {
  // New hero, sections, FAQ and identity markup in the copy overhaul, 2026-10-20
  // (before: 2026-09-30).
  home: "2026-10-20",
  // New text, sizes and FAQ in the copy overhaul, 2026-10-20 (before: 2026-09-30).
  // Its prices were last checked on PRICES_AS_OF (app/pricing/pricing-content.ts).
  pricing: "2026-10-20",
  // Hubs were rewritten for the copy overhaul, 2026-10-20 (before: 2026-09-30).
  featuresHub: "2026-10-20",
  // The /compare price table changed on 2026-10-21 (Hostinger, Agent 37 and Nous
  // figures re-read; lib/compare/competitor-facts.ts). Before: 2026-10-20.
  compareHub: "2026-10-21",
  // The detail pages share one template and were rewritten in the copy overhaul,
  // 2026-10-20 (before: 2026-09-24, the truth pass that removed speed, backup,
  // import and price claims).
  featureDetail: "2026-10-20",
  compareDetail: "2026-10-20",
  // The /tools hub lists every tool; it and each tool page were rewritten in the
  // copy overhaul, 2026-10-20 (before: 2026-09-30). Each tool page has its own
  // date in TOOL_PAGE_LAST_MODIFIED below.
  tools: "2026-10-20",
  // Phase-aware token copy and official accounts, 2026-09-24.
  token: "2026-09-24",
  // The founder note was rewritten in the copy overhaul, 2026-10-20 (before:
  // 2026-09-30).
  whyHivra: "2026-10-20",
  // New page: the ecosystem map (what is available now, next, later and still
  // research), rewritten in the copy overhaul, 2026-10-20. It joined the sitemap
  // that day.
  ecosystem: "2026-10-20",
  // Retitled and labelled as the April 2026 plan, then rewritten in the copy
  // overhaul, 2026-10-20 (before: 2026-09-30).
  roadmap: "2026-10-20",
  // Rewritten in the copy overhaul, 2026-10-20 (before: 2026-06-21, the date of
  // the newest entry in hermes_changelog.md).
  changelog: "2026-10-20",
  // Public /week page added 2026-10-21. It reads GitHub at request time; the
  // page copy itself dates from this day.
  week: "2026-10-21",
  // Rewritten in the copy overhaul, 2026-10-20 (before: 2026-06-22; 2026-09-23
  // only removed a dash from its title).
  status: "2026-10-20",
  // Rewritten in the copy overhaul, 2026-10-20 (before: 2026-09-30, when the
  // call to action stopped advertising a hosted free tier).
  stats: "2026-10-20",
  // Rewritten in the copy overhaul, 2026-10-20 (before: 2026-09-24, when Google
  // Analytics was named as a processor and the consent wording was added).
  privacy: "2026-10-20",
  // /about replaced a 308 to the founder note on 2026-09-30; rewritten in the
  // copy overhaul, 2026-10-20.
  about: "2026-10-20",
  // New page written 2026-09-30; rewritten in the copy overhaul, 2026-10-20.
  security: "2026-10-20",
  // Rewritten in the copy overhaul, 2026-10-20 (before: 2026-03-01, the date of
  // the old text; 2026-09-24 only added its own title and canonical).
  terms: "2026-10-20",
} as const;

export type PageLastModifiedKey = keyof typeof PAGE_LAST_MODIFIED;

/**
 * Each tool page's last change to its own content, by slug. The block of related
 * tools every tool page shares is boilerplate and does not move a page's date.
 * The /tools hub follows PAGE_LAST_MODIFIED.tools. Adding a tool means adding its
 * slug here: seo-urls.test.ts fails on a missing or stale slug.
 */
export const TOOL_PAGE_LAST_MODIFIED: Record<string, string> = {
  // All six tool pages were rewritten in the copy overhaul, 2026-10-20. Before:
  // the plan calculator 2026-09-30 (new copy, a method section with linked
  // sources, worked examples and re-read figures), the keep-awake command builder
  // and the tmux cheat sheet 2026-09-30 (added that day), and the three older
  // tools 2026-09-24 (restored and truth-checked).
  "claude-code-plan-calculator": "2026-10-20",
  "agent-survival-check": "2026-10-20",
  "ai-agent-hosting-cost-calculator": "2026-10-20",
  "claude-code-limit-reset-calculator": "2026-10-20",
  "keep-mac-awake": "2026-10-20",
  "tmux-cheat-sheet": "2026-10-20",
};

/** An ISO day as a Date at 00:00 UTC, for the sitemap. */
export function dayToDate(day: string): Date {
  return new Date(`${day}T00:00:00Z`);
}
