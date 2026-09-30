// The Claude plan facts, in one place. The plan calculator
// (/tools/claude-code-plan-calculator), its page copy in tool-catalog.ts, the
// limit-reset calculator and the blog post /blog/claude-max-vs-pro-for-claude-code
// all read these constants, so a price or a date cannot differ between them.
//
// Pure data, no imports: the calculator component, the catalog, the blog and the
// tests can all load it. claude-plan-facts.test.ts pins every value below to a
// literal, so changing one here fails a test until the pin is changed with it,
// and the pin is only changed after the page it came from is read again.
//
// Every value was read on 2026-09-30 on Anthropic's own pages (the URLs in
// `sources`) and confirmed by two independent readers that day. Update
// `lastVerified` only when every value and every changelog row is re-checked.
//
// What Anthropic does NOT publish is deliberately absent: message or token
// counts per window, Pro's absolute allowance, any weekly multiple for Max, how
// much faster Opus drains a quota than Sonnet, and what opens the five-hour
// window. Nothing in this file is an estimate except the block named
// `estimate`, which is Hivra's and says so.
//
// Plan names follow Anthropic's pricing page: Free, Pro, Max 5x, Max 20x. The
// public tools copy does not say "free plan" (lib/tools/copy-rules.ts), so the
// Free level is not modelled here.

export type ClaudePlanKey = "pro" | "max5x" | "max20x";
export type ClaudeModelKey = "fable" | "opus" | "sonnet" | "haiku";

export interface ClaudeSource {
  label: string;
  url: string;
}

export const CLAUDE_PLAN_FACTS = {
  lastVerified: "2026-09-30",
  /** The session limit resets on a rolling window of this many hours. */
  windowHours: 5,
  // Days Anthropic changed Claude Code's limits (each is a row in the changelog
  // below). A reading of your own limit taken before the newest one is out of date.
  limitChanges: {
    fiveHourDoubled: "2026-05-06",
    weeklyPromotionStart: "2026-05-13",
    weeklyPromotionEnd: "2026-09-13",
    weeklyRaised: "2026-09-14",
    fiveHourRaised: "2026-09-22",
  },
  plans: {
    // Pro: $20 billed monthly, or $17 a month on the annual plan ($200 billed up
    // front). Max: monthly only. The multiple is per five-hour session; Anthropic
    // publishes no weekly multiple.
    pro: { label: "Pro", priceUsd: 20, annualMonthlyUsd: 17, annualUpfrontUsd: 200, multiplier: 1 },
    max5x: { label: "Max 5x", priceUsd: 100, multiplier: 5 },
    max20x: { label: "Max 20x", priceUsd: 200, multiplier: 20 },
  },
  // Team seats (2 to 150 members). Multiples are of Pro's per-session allowance.
  team: {
    standardMonthlyUsd: 25,
    standardAnnualUsd: 20,
    premiumMonthlyUsd: 125,
    premiumAnnualUsd: 100,
    standardMultiplier: 1.25,
    premiumMultiplier: 6.25,
    minSeats: 2,
    maxSeats: 150,
  },
  /** Enterprise: per seat a month, billed annually, plus usage at API rates. */
  enterpriseSeatUsd: 20,
  /** Claude Code's default model on Pro, Max, Team and Enterprise since this day (v2.1.280). */
  defaultModel: { label: "Opus 5.5", since: "2026-09-22" },
  /** USD per million tokens at API list price. Cache write is the 5-minute rate. */
  api: {
    fable: { label: "Fable 5.1", input: 10, output: 50, cacheRead: 0.25, cacheWrite5m: 12.5 },
    opus: { label: "Opus 5.5", input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5 },
    sonnet: { label: "Sonnet 5.5", input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5 },
    haiku: { label: "Haiku 4.5", input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25 },
  },
  // Anthropic's own planning figures for API-billed Claude Code. "Active day" is
  // a day the developer used it. The $13 and the $150 to $250 are averages across
  // enterprise deployments; $30 is the line 90% of users stay below.
  anthropicCost: {
    perActiveDayUsd: 13,
    p90PerActiveDayUsd: 30,
    perMonthLowUsd: 150,
    perMonthHighUsd: 250,
    // Input tokens per output token in Anthropic's aggregate Claude Code data,
    // March to September 2026 (189:1 six months earlier). It counts cache reads.
    inputToOutputRatio: 324,
  },
  // HIVRA'S ESTIMATE, not Anthropic's. Anthropic publishes neither an hourly
  // token volume nor how much of the input is cache reads. These two numbers are
  // set so that a normal three-hour Sonnet day lands within about 5% of
  // Anthropic's $13 average, and a heavy Opus day lands above its $30 line
  // (both held by claude-plan-calc.test.ts).
  estimate: {
    outputMPerHour: { normal: 0.05, heavy: 0.1 },
    cacheReadShare: 0.98,
    weeksPerMonth: 4.33,
  },
  sources: {
    pricing: { label: "Claude pricing", url: "https://claude.com/pricing" },
    maxPlan: { label: "What is the Max plan?", url: "https://support.claude.com/en/articles/11049741-what-is-the-max-plan" },
    proPlan: { label: "What is the Pro plan?", url: "https://support.claude.com/en/articles/8325606-what-is-the-pro-plan" },
    teamPlan: { label: "What is the Team plan?", url: "https://support.claude.com/en/articles/9266767-what-is-the-team-plan" },
    claudeCodeTeam: {
      label: "Use Claude Code with your Team or Enterprise plan",
      url: "https://support.claude.com/en/articles/11845131-use-claude-code-with-your-team-or-enterprise-plan",
    },
    claudeCodeProMax: {
      label: "Use Claude Code with your Pro or Max plan",
      url: "https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan",
    },
    usageCredits: {
      label: "Manage usage credits for paid Claude plans",
      url: "https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans",
    },
    limitReset: { label: "What is a limit reset?", url: "https://support.claude.com/en/articles/17007452-what-is-a-limit-reset" },
    usageLimitTips: {
      label: "Usage limit best practices",
      url: "https://support.claude.com/en/articles/9797557-usage-limit-best-practices",
    },
    fable: {
      label: "Claude Fable models on your plan",
      url: "https://support.claude.com/en/articles/15424964-claude-fable-models-on-your-plan",
    },
    modelGuide: {
      label: "Models, usage and limits in Claude Code",
      url: "https://support.claude.com/en/articles/14552983-models-usage-and-limits-in-claude-code",
    },
    weeklyPromotion: {
      label: "Claude Code May to August 2026 weekly limits promotion",
      url: "https://support.claude.com/en/articles/15910845-claude-code-may-august-2026-weekly-limits-promotion",
    },
    agentSdk: {
      label: "Use the Claude Agent SDK with your Claude plan",
      url: "https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan",
    },
    releaseNotes: { label: "Claude release notes", url: "https://support.claude.com/en/articles/12138966-release-notes" },
    costs: { label: "Manage costs effectively (Claude Code docs)", url: "https://code.claude.com/docs/en/costs" },
    errors: { label: "Error reference (Claude Code docs)", url: "https://code.claude.com/docs/en/errors" },
    interactiveMode: { label: "Interactive mode (Claude Code docs)", url: "https://code.claude.com/docs/en/interactive-mode" },
    modelConfig: { label: "Model configuration (Claude Code docs)", url: "https://code.claude.com/docs/en/model-config" },
    fastMode: { label: "Fast mode (Claude Code docs)", url: "https://code.claude.com/docs/en/fast-mode" },
    changelog: { label: "Claude Code changelog", url: "https://code.claude.com/docs/en/changelog" },
    cloudSessions: { label: "Use Claude Code in the cloud (Claude Code docs)", url: "https://code.claude.com/docs/en/claude-code-on-the-web" },
    remoteControl: { label: "Remote Control (Claude Code docs)", url: "https://code.claude.com/docs/en/remote-control" },
    authentication: { label: "Authentication (Claude Code docs)", url: "https://code.claude.com/docs/en/authentication" },
    legal: { label: "Legal and compliance (Claude Code docs)", url: "https://code.claude.com/docs/en/legal-and-compliance" },
    apiPricing: { label: "Claude API pricing", url: "https://platform.claude.com/docs/en/about-claude/pricing" },
    opus55: { label: "Claude Opus 5.5 announcement", url: "https://www.anthropic.com/claude-opus-5-5" },
    sonnet55: { label: "Claude Sonnet 5.5 announcement", url: "https://www.anthropic.com/claude-sonnet-5-5" },
    spacex: { label: "Higher Claude Code limits announcement", url: "https://www.anthropic.com/news/higher-limits-spacex" },
    sessionsBlog: {
      label: "Claude Opus 5.5 and sessions that use more context",
      url: "https://claude.com/blog/claude-opus-5-5-built-for-coding-sessions-that-use-more-context",
    },
    teamBlog: { label: "Claude Team updates", url: "https://claude.com/blog/claude-team-updates" },
    maxLaunchArchived: {
      label: "Max plan announcement, archived copy",
      url: "https://web.archive.org/web/2025id_/https://www.anthropic.com/news/max-plan",
    },
  } satisfies Record<string, ClaudeSource>,
} as const;

/** Hosts whose pages count as an official Anthropic source for a changelog row. */
export const OFFICIAL_SOURCE_HOSTS = [
  "claude.com",
  "support.claude.com",
  "code.claude.com",
  "platform.claude.com",
  "www.anthropic.com",
  // The live Max launch post is gone; the archived copy of it is the source.
  "web.archive.org",
] as const;

export interface ClaudePlanChange {
  /** ISO day the change took effect or was announced. */
  date: string;
  text: string;
  source: ClaudeSource;
}

const S = CLAUDE_PLAN_FACTS.sources;

/**
 * Dated changes to Claude plans and Claude Code limits, newest first. A row is
 * here only when an Anthropic-owned page states it and the date is on that page
 * or in the text it links. Changes reported only by news sites or posts on X are
 * left out. Read on 2026-09-30.
 */
export const CLAUDE_PLAN_CHANGELOG: readonly ClaudePlanChange[] = [
  { date: "2026-09-28", text: "Sonnet 5.5 launched at $2 and $10 per million tokens, the same price as Sonnet 5.", source: S.sonnet55 },
  {
    date: "2026-09-22",
    text: "Claude Code made Opus 5.5 the default model, including on Pro and Team Standard plans, where Sonnet had been the default (v2.1.280).",
    source: S.changelog,
  },
  {
    date: "2026-09-22",
    text: "Opus 5.5 launched at $4 and $20 per million tokens. Anthropic raised five-hour usage limits on Pro, Max, Team and seat-based Enterprise plans and gave subscribers a rate limit reset they can save and use when they choose. It did not publish the size of the increase.",
    source: S.opus55,
  },
  {
    date: "2026-09-14",
    text: "Weekly limits in Claude Code became 25% higher than they were before the May to September promotion, on Pro, Max, Team and seat-based Enterprise plans. Claude Code only.",
    source: S.weeklyPromotion,
  },
  {
    date: "2026-09-01",
    text: "Fable 5.1 launched.",
    source: S.releaseNotes,
  },
  {
    date: "2026-08-17",
    text: "Claude Code v2.1.234 added waiting out a usage limit in the open session and continuing after the reset.",
    source: S.changelog,
  },
  { date: "2026-07-24", text: "Opus 5 launched.", source: S.releaseNotes },
  {
    date: "2026-07-19",
    text: "The Fable 5 promotion ended at 11:59:59 PM PT. Since then Max plans and premium seats include Fable up to 50% of their weekly limits, and Pro and Team Standard plans use it on usage credits.",
    source: S.fable,
  },
  { date: "2026-06-30", text: "Sonnet 5 launched and became Claude Code's default model (v2.1.197).", source: S.changelog },
  {
    date: "2026-06-15",
    text: "Anthropic paused a planned separate monthly credit for Agent SDK and claude -p usage. That usage still draws from your plan's limits, and Anthropic says it will announce any change before it takes effect.",
    source: S.agentSdk,
  },
  {
    date: "2026-05-19",
    text: "Claude Code renamed extra usage to usage credits, and the /extra-usage command became /usage-credits (v2.1.144).",
    source: S.changelog,
  },
  {
    date: "2026-05-13",
    text: "A temporary 50% increase to weekly limits in Claude Code began on Pro, Max, Team and seat-based Enterprise plans. It ran through 2026-09-13.",
    source: S.weeklyPromotion,
  },
  {
    date: "2026-05-06",
    text: "Claude Code's five-hour limits doubled on Pro, Max, Team and seat-based Enterprise plans, and the peak-hours limit reduction on Claude Code was removed for Pro and Max.",
    source: S.spacex,
  },
  { date: "2026-02-12", text: "Self-serve Enterprise plans launched with one seat type covering Claude and Claude Code.", source: S.releaseNotes },
  {
    date: "2026-01-28",
    text: "Team prices were lowered to $20 (annual) or $25 (monthly) for a Standard seat and $100 (annual) or $125 (monthly) for a Premium seat, with Claude Code in every seat.",
    source: S.teamBlog,
  },
  { date: "2026-01-16", text: "Claude Code was added to Team Standard seats.", source: S.releaseNotes },
  {
    date: "2025-12-03",
    text: "Pro users got Opus 4.5 in Claude Code as part of their subscription (v2.0.58).",
    source: S.changelog,
  },
  { date: "2025-04-09", text: "Max launched at $100 a month for 5x Pro's usage and $200 a month for 20x.", source: S.maxLaunchArchived },
];

/** "$20", "$0.20", "$12.50": whole dollars without cents, anything else with two decimals. */
export function usd(value: number): string {
  return Number.isInteger(value) ? `$${value}` : `$${value.toFixed(2)}`;
}

/**
 * Active days a month at which a plan costs the same as paying for the same
 * usage at API list price: plan price divided by the API cost of one active
 * day. Above this many days a month the plan is the cheaper way to pay.
 */
export function breakEvenDays(planPriceUsd: number, apiCostPerActiveDayUsd: number): number {
  return planPriceUsd / apiCostPerActiveDayUsd;
}

/** One decimal place: 1.5, 7.7, 15.4. */
export function formatDays(days: number): string {
  return days.toFixed(1);
}
