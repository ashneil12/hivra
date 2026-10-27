// Free-tools catalog: copy and structured-data source for the public /tools
// pages. Ported from the retired private site and corrected on 2026-09-24.
//
// Pure data (no React) so the pages, the sitemap and the tests can all import
// it. Hivra product facts here trace back to code: the $9.99 checkout plan is
// 2 vCPU and 4 GB (lib/subscription/plans.ts), paid plans are not paused for
// inactivity, and Claude Code and Codex run on your own login
// (lib/hivra/agent-catalog.ts). What keeps running after the laptop closes is
// stated only as lib/blog/runtime-facts.ts allows: tmux in the computer's
// Terminal tab, or Telegram on Claude Code. Plans are described by price and size, never by
// plan name, because the public ladder and checkout still use different names.
//
// External facts (Anthropic plan prices and limits, API rates, VPS prices) live
// in ONE const table per tool, with a lastVerified date that the page renders.
// The Claude plan facts are in lib/tools/claude-plan-facts.ts, shared with the
// plan calculator and the blog post it backs, and were read on 2026-09-30. Every
// other figure in this file was checked against the vendor's own page on
// 2026-09-24.
//
// Copy rules (CI-tested in __tests__/tool-catalog.test.ts): no em dashes or en
// dashes, no trial or card claims, no unmeasured speed claims, short sentences,
// real numbers, honest tradeoffs including when DIY wins.

import { MONEY_BACK_GUARANTEE, PLAN_DISPLAY, formatPlanSize } from "@/lib/blog/plan-facts";
import { CLI_RUN_LIFETIME } from "@/lib/blog/runtime-facts";
import { PUBLIC_START_HREF } from "@/lib/public-start";
import { apiCostPerActiveHour, formatUsd } from "./claude-plan-calc";
import { CLAUDE_PLAN_FACTS, usd } from "./claude-plan-facts";
import { KEEP_AWAKE_FACTS } from "./keep-awake";
import { TMUX_FACTS, TMUX_KEYS_NOTE } from "./tmux-sheet";
import { monthYear } from "@/lib/tools/month-year";

export type ToolComponentKey =
  | "plan-calculator"
  | "agent-survival-check"
  | "hosting-cost-calculator"
  | "limit-reset-calculator"
  | "keep-mac-awake"
  | "tmux-cheat-sheet";

export interface ToolFaq {
  q: string;
  a: string;
}

export interface ToolRelatedLink {
  href: string;
  label: string;
}

/** A page the method or an example rests on. Rendered as an https link. */
export interface ToolSource {
  label: string;
  url: string;
}

export interface ToolMethodParagraph {
  text: string;
  sources?: ToolSource[];
}

/**
 * The page-level method section, rendered on the server under the tool: what
 * the answer rests on, each source linked, and the date the facts were last
 * checked against them (ISO, YYYY-MM-DD).
 */
export interface ToolMethod {
  heading: string;
  lastVerified: string;
  paragraphs: ToolMethodParagraph[];
}

/** A worked example: stated inputs, the exact output and what it means. */
export interface ToolExample {
  title: string;
  inputs: string;
  /** What the tool prints for those inputs. A test holds it equal to the builder's output. */
  command: string;
  result: string;
}

/**
 * The words above a tool, from the copy overhaul (2026-10-20). Inline marks
 * (**bold**, *italic*, `code`) are read by lib/tools/markup.ts.
 */
export interface ToolIntro {
  /** The first paragraph, set large under the H1. */
  lede: string;
  /** The paragraphs that follow, in a reading column. */
  body: string[];
  /** A closing paragraph set apart as a callout: a caveat, or how to read the keys. */
  note?: string;
}

export interface ToolEntry {
  slug: string;
  name: string;
  h1: string;
  /** One line for the card on /tools. It is not shown on the tool's own page. */
  subhead: string;
  /** Page title before the root " | Hivra" suffix. At most 55 characters. */
  metaTitle: string;
  /**
   * The finished browser title, brand included, exactly as the copy gives it. Pages use it
   * as an absolute title, so the root layout does not add " | Hivra" a second time. It is
   * also the Open Graph and Twitter title.
   */
  browserTitle: string;
  /** 120 to 155 characters. */
  metaDescription: string;
  /** What is said above the tool. */
  intro: ToolIntro;
  /** At least 4 real questions from the keyword cluster. */
  faqs: ToolFaq[];
  /**
   * Commands, keys and flags quoted in the answers, as exact phrases. The page sets them in code; the
   * answers themselves stay plain text, which is what the structured data carries. Each phrase must
   * occur in an answer (the catalog test checks it).
   */
  faqCode?: readonly string[];
  /** Site links beyond the other tools, which the page adds on its own. */
  relatedLinks: ToolRelatedLink[];
  componentKey: ToolComponentKey;
  primaryKeyword: string;
  /** Vendors the page discusses, named in its non-affiliation line. */
  vendors: string[];
  /** Optional page-level method section (server-rendered under the tool). */
  method?: ToolMethod;
  /** Optional worked examples, rendered with the method. */
  examples?: ToolExample[];
}

export const TOOLS_HUB = {
  path: "/tools",
  /** Page title before the root " | Hivra" suffix. */
  metaTitle: "Free Tools for Running AI Agents",
  /** The finished browser title, brand included (see ToolEntry.browserTitle). */
  browserTitle: "Free Tools for Running AI Agents | Hivra",
  metaDescription:
    "Free tools for people who run AI agents: keep-awake commands, a tmux cheat sheet, Claude plan and limit calculators, a survival check and hosting costs.",
  eyebrow: "Free. No signup.",
  h1: "Free tools for people building with AI agents",
  /** Two paragraphs under the H1, set in two columns. Inline marks as in ToolIntro. */
  intro: [
    "Running an agent often means solving problems that have little to do with AI. Your laptop sleeps halfway through a task. Your Claude usage limit arrives sooner than expected. A cheap server turns into a maintenance chore. Or you simply forget which tmux command gets you back into yesterday's session.",
    "We built these free tools to make those decisions easier. They are practical, independent checks you can use without creating an account. Each calculator tells you what it assumes, and each command builder tells you what it *cannot* fix. Sometimes the sensible answer is to keep using the machine you already have. That is fine by us.",
  ],
  directoryHeading: "Pick the problem you are trying to solve",
  vendors: ["Anthropic", "OpenAI"],
} as const;

/**
 * The calls to action on every tools page. primaryHref is the public start
 * link (sign-up, then Launch). claudeCodeHref is for buttons that promise
 * Claude Code: it opens Launch on Claude Code, and equals agentDeployHref for
 * the claude-code entry in lib/hivra/agent-seo-catalog (the catalog test pins
 * the two together).
 */
export const TOOLS_CTA = {
  primaryHref: PUBLIC_START_HREF,
  claudeCodeHref: `${PUBLIC_START_HREF}?agentType=claude-code`,
  /** For buttons that promise Codex; equals agentDeployHref for the codex entry (the catalog test pins it). */
  codexHref: `${PUBLIC_START_HREF}?agentType=codex`,
  /** A button that names the $9.99 plan carries that plan into checkout. */
  entryPlanHref: "/get-started?plan=operator",
  secondaryHref: "/pricing",
} as const;

/**
 * The closing block under every tools page, the same words on all seven (copy overhaul,
 * 2026-10-20). The price and size come from lib/blog/plan-facts, the stays-on sentence is the
 * approved one, the AI-usage sentences are the owner's, and the guarantee is the shared
 * phrase, linked to the terms. The copy's own wording said the agent "keeps running" and
 * named the plan only as "(2 vCPU, 4 GB)"; both are rewritten to the repo's wording. The
 * offer sentence now says the computer stays on after you leave your desk (owner's
 * wording, 2026-10-21), a claim about the computer, not about a run. The AI-usage sentence is
 * the owner's approved one and stays word for word; the sentence after it says the one case where its
 * "or pay with Hivra credits" does not hold, because every page here can end in a Run Claude Code on
 * Hivra button and Claude Code takes only the owner's own sign-in (lib/launch/model-access.ts).
 */
export const TOOLS_CLOSING = {
  offer: `If you want the computer to stay on after you leave your desk, Hivra offers a managed computer starting at ${formatPlanSize("entry")}.`,
  staysOn: `A paid ${PLAN_DISPLAY.entry} computer stays on and is not paused for inactivity.`,
  aiUsage:
    "The plan does not include AI usage. Bring your own account or key where the agent supports it, or pay with Hivra credits.",
  claudeCodeSignIn: "Claude Code uses your own Anthropic sign-in, not Hivra credits.",
  guaranteeLead: "There is a",
  guarantee: MONEY_BACK_GUARANTEE,
  guaranteeHref: "/terms",
} as const;

// The Claude Code plan calculator. Its figures are the shared Claude plan facts
// (claude-plan-facts.ts, read 2026-09-30), so the page copy, the calculator and
// the blog post it backs cannot disagree. Anything Anthropic does not publish is
// labelled an estimate here, with the assumption stated.
const PLAN_FACTS = CLAUDE_PLAN_FACTS;
const PLAN_SOURCES = PLAN_FACTS.sources;
const PRO = PLAN_FACTS.plans.pro;
const MAX5 = PLAN_FACTS.plans.max5x;
const MAX20 = PLAN_FACTS.plans.max20x;
const API = PLAN_FACTS.api;
const ANTHROPIC_COST = PLAN_FACTS.anthropicCost;
const LIMIT_CHANGES = PLAN_FACTS.limitChanges;
const PLAN_DAY = usd(ANTHROPIC_COST.perActiveDayUsd);
/** What the estimate gives for a normal three-hour day on each model, beside Anthropic's average. */
const NORMAL_SONNET_DAY = formatUsd(apiCostPerActiveHour("sonnet", false) * 3);
const NORMAL_OPUS_DAY = formatUsd(apiCostPerActiveHour("opus", false) * 3);
/** Haiku 5.5's two price tiers, as one phrase: "$0.10 and $0.50 for prompts up to 100,000 tokens, $0.50 and $2.50 above that". */
const HAIKU_PRICES = `${usd(API.haiku.input)} and ${usd(API.haiku.output)} for prompts up to ${API.haiku.longPrompt.overTokens.toLocaleString("en-US")} tokens, ${usd(API.haiku.longPrompt.input)} and ${usd(API.haiku.longPrompt.output)} above that`;

/**
 * Hetzner's cost-optimised page says the number of available servers in that range is limited, and its CX23
 * row showed as not available when the audit read it on 2026-10-20. The wording claims only what Hetzner says.
 * Shown under the calculator's CX23 preset and in the hosting FAQ answer, so both read the same.
 */
export const HETZNER_LIMITED_NOTE =
  "Hetzner says the number of servers in this range is limited, so you may not be able to order one when you look.";

const PLAN_CALCULATOR_ENTRY: ToolEntry = {
  slug: "claude-code-plan-calculator",
  name: "Claude Code Plan Calculator",
  h1: "Which Claude Code plan makes sense for your work?",
  subhead:
    "Tell it how much you code with Claude and where Pro's limit stops you today. It names the cheapest plan that fits and prices the same usage at API rates.",
  metaTitle: "Claude Code Plan Calculator: Pro vs Max",
  browserTitle: "Claude Code Plan Calculator: Pro vs Max | Hivra",
  // Built from the plan facts like the rest of the page, so a price change cannot
  // leave the title, og tags and WebApplication JSON-LD description stale.
  metaDescription: `Estimate your Claude Code usage and see which Anthropic plan fits: Pro at ${usd(PRO.priceUsd)}, Max 5x at ${usd(MAX5.priceUsd)}, or Max 20x at ${usd(MAX20.priceUsd)} a month. With an API cost comparison.`,
  intro: {
    lede: "If you use Claude Code every day, it is tempting to move straight from Pro to the most expensive Max plan. But paying for more headroom only makes sense if the allowance is the thing slowing you down.",
    body: [
      "Tell the calculator how often you work, which models you use and, most importantly, roughly when Pro stops you during a five-hour session. It will compare Pro, Max 5x and Max 20x using the published session multipliers, then show an indicative API cost for the same workload.",
    ],
    note: "There is an important limit to the result: Anthropic does not publish a universal message or token allowance that makes the exact fit predictable. The plan verdicts are estimates based on your own experience, not promises that you will stay under a particular limit. Weekly limits are a separate problem and are not given a made-up multiplier.",
  },
  // Tool questions only. Plan and price questions (what Max is, whether Pro is
  // enough, what API billing costs, what to do at a limit) belong to the post this
  // page links to, so the two FAQPage blocks do not repeat each other.
  faqs: [
    {
      q: "How does the calculator rate each plan?",
      a: `It takes the hours into a five-hour window where Pro stops you and multiplies them by the plan's published multiple (1, 5 or 20). Then it compares that with the hours you work in your busiest five-hour window. "Fits with headroom" means that window uses 60% of the capacity or less. "Tight" means up to 100%, and "Would hit limits" means more. The multiples come from Anthropic and the 60% line is ours. The rest is arithmetic, and the ratings promise nothing.`,
    },
    {
      q: "Why does the calculator never rate the weekly limit?",
      a: `As of ${monthYear(PLAN_FACTS.lastVerified)}, no Anthropic page states a weekly multiple for Max 5x or Max 20x, so any weekly rating would be made up. If Pro's weekly limit is what stops you, tell the calculator. It adds a note that the ratings cover your five-hour windows only, and sends you to /usage after your first full week on a Max plan.`,
    },
    {
      q: "Why does it ask where Pro stops me?",
      a: `Anthropic doesn't publish how many hours or messages Pro covers, so there's no published baseline. Your own reading is the one real number in the calculation, and the published multiples scale it up to Max. Until you pick one, the plans show as not rated and only the API estimate appears. Use a reading from after ${LIMIT_CHANGES.fiveHourRaised}, when Anthropic raised five-hour limits. An older one is out of date.`,
    },
    {
      q: "Where does the dollar estimate come from, and how far should I trust it?",
      a: `It's your active hours times a cost per hour at API list price. Don't read it as a plan price or a quote. The cost per hour uses Anthropic's published rates and its published ${ANTHROPIC_COST.inputToOutputRatio} input tokens per output token. Two assumptions are ours: about ${Math.round(PLAN_FACTS.estimate.outputMPerHour.normal * 1000)}K output tokens in a normal hour (${Math.round(PLAN_FACTS.estimate.outputMPerHour.heavy * 1000)}K in a heavy one) and ${Math.round(PLAN_FACTS.estimate.cacheReadShare * 100)}% of input read from the prompt cache. Anthropic publishes neither. A normal three-hour day comes to about ${NORMAL_SONNET_DAY} on ${API.sonnet.label} and ${NORMAL_OPUS_DAY} on ${API.opus.label}, either side of Anthropic's ${PLAN_DAY} enterprise average. Take it as a rough guide. It isn't a forecast for you.`,
    },
    {
      q: "Why does the model mix start at 100% Opus?",
      a: `${PLAN_FACTS.defaultModel.label} has been Claude Code's default model on Pro and Max since ${PLAN_FACTS.defaultModel.since}, so anyone who never runs /model is on Opus. If you switch, move the slider toward ${API.sonnet.label}. At list price it costs ${usd(API.sonnet.input)} against ${usd(API.opus.input)} per million input tokens and ${usd(API.sonnet.output)} against ${usd(API.opus.output)} per million output tokens. The calculator leaves the Fable models out.`,
    },
    {
      q: "What does the calculator leave out?",
      a: "It doesn't model Team and Enterprise seats, usage credits, fast mode, the Fable models or Haiku, or anything Anthropic hasn't published. What it covers is the three individual plans and API list price. For what each plan includes, what to do at a limit and when API billing is cheaper, read the plan pricing post linked below.",
    },
    {
      q: "Does the calculator replace /usage in Claude Code?",
      a: "No. /usage shows your real plan usage and when it resets. Settings, then Usage, on your Claude account shows the session and weekly limits. The calculator estimates before you pay, from your own reading of where Pro stops you. Once you're on a plan, trust /usage over any estimate.",
    },
  ],
  relatedLinks: [
    { href: "/blog/claude-max-vs-pro-for-claude-code", label: "Claude Code pricing: Pro vs Max, and when API billing is cheaper" },
    { href: "/agents/claude-code", label: "Run Claude Code on Hivra" },
    { href: "/pricing", label: "Hivra pricing" },
  ],
  componentKey: "plan-calculator",
  primaryKeyword: "claude code plan calculator",
  vendors: ["Anthropic"],
  method: {
    heading: "Where these numbers come from",
    lastVerified: PLAN_FACTS.lastVerified,
    paragraphs: [
      {
        text: `Pro is ${usd(PRO.priceUsd)} a month billed monthly, or ${usd(PRO.annualMonthlyUsd)} a month on the annual plan (${usd(PRO.annualUpfrontUsd)} billed up front). Max 5x is ${usd(MAX5.priceUsd)} a month and Max 20x is ${usd(MAX20.priceUsd)}, both billed monthly only. Prices exclude tax, and Anthropic says prices and plans are subject to change at its discretion. Claude Code is included in Pro and Max.`,
        sources: [PLAN_SOURCES.pricing, PLAN_SOURCES.maxPlan, PLAN_SOURCES.proPlan],
      },
      {
        text: `Anthropic states the Max multiples per five-hour session: Max 5x is five times Pro's per-session usage allowance, and Max 20x is twenty times. No Anthropic page states a weekly multiple, a token or message count, or the size of Pro's allowance, so the calculator prints none. To rate a plan, it takes the hours into a window where Pro stops you, multiplies them by 1, 5 or 20, and compares the result with the hours you work in your busiest five-hour window. Headroom means 60% of that capacity or less, tight means up to 100%, and over means more. The scaling is our arithmetic on the published multiples, and Anthropic doesn't promise it. The weekly limit is never rated.`,
        sources: [PLAN_SOURCES.maxPlan, PLAN_SOURCES.pricing],
      },
      {
        text: `Anthropic changes Claude Code's limits often. Five-hour limits doubled on ${LIMIT_CHANGES.fiveHourDoubled} and rose again on ${LIMIT_CHANGES.fiveHourRaised}. Weekly limits ran 50% higher from ${LIMIT_CHANGES.weeklyPromotionStart} to ${LIMIT_CHANGES.weeklyPromotionEnd}, and since ${LIMIT_CHANGES.weeklyChanged} they've been 25% higher than before that promotion. Anthropic didn't publish how big the ${LIMIT_CHANGES.fiveHourRaised} increase was in hours or tokens. Any reading of where Pro stops you taken before ${LIMIT_CHANGES.fiveHourRaised} is out of date, which is why the calculator asks for a recent one.`,
        sources: [PLAN_SOURCES.spacex, PLAN_SOURCES.weeklyPromotion, PLAN_SOURCES.opus55],
      },
      {
        text: `The dollar figure is an estimate at API list price. Don't read it as what a plan costs, or as a quote. Per million tokens, ${API.opus.label} is ${usd(API.opus.input)} input, ${usd(API.opus.output)} output, ${usd(API.opus.cacheRead)} cache read and ${usd(API.opus.cacheWrite5m)} for a five-minute cache write. ${API.sonnet.label} is ${usd(API.sonnet.input)}, ${usd(API.sonnet.output)}, ${usd(API.sonnet.cacheRead)} and ${usd(API.sonnet.cacheWrite5m)}. Anthropic reports that Claude Code reads ${ANTHROPIC_COST.inputToOutputRatio} input tokens for every output token, and that cache reads make up most of the cost. So the estimate counts ${ANTHROPIC_COST.inputToOutputRatio} times the output tokens as input, prices ${Math.round(PLAN_FACTS.estimate.cacheReadShare * 100)}% of that as cache reads and the rest as cache writes. That split is Hivra's assumption, and so are the ${Math.round(PLAN_FACTS.estimate.outputMPerHour.normal * 1000)}K output tokens in a normal hour and ${Math.round(PLAN_FACTS.estimate.outputMPerHour.heavy * 1000)}K in a heavy one. Anthropic publishes none of them.`,
        sources: [PLAN_SOURCES.apiPricing, PLAN_SOURCES.sessionsBlog],
      },
      {
        text: `Anthropic's docs give a way to check those assumptions. They put API-billed Claude Code at about ${PLAN_DAY} per developer per active day, and ${usd(ANTHROPIC_COST.perMonthLowUsd)} to ${usd(ANTHROPIC_COST.perMonthHighUsd)} per developer per month across enterprise deployments. For 90% of users, costs stay below ${usd(ANTHROPIC_COST.p90PerActiveDayUsd)} per active day. With our assumptions, a normal three-hour day comes to about ${NORMAL_SONNET_DAY} on ${API.sonnet.label} and ${NORMAL_OPUS_DAY} on ${API.opus.label}, either side of that average, and a heavy three-hour day on ${API.opus.label} lands above the ${usd(ANTHROPIC_COST.p90PerActiveDayUsd)} line. The second figure on the page is the ${PLAN_DAY} enterprise average times your active days. It's an average, and it can't predict your own cost.`,
        sources: [PLAN_SOURCES.costs],
      },
      {
        text: `${PLAN_FACTS.defaultModel.label} has been Claude Code's default model on Pro, Max, Team and Enterprise since ${PLAN_FACTS.defaultModel.since}, so the model mix starts at 100% Opus. ${API.fable.label} (${usd(API.fable.input)} input, ${usd(API.fable.output)} output) is never the default. Max includes it up to 50% of weekly limits and Pro uses usage credits for it, so the calculator leaves it out. It also leaves out ${API.haiku.label} (${HAIKU_PRICES}), fast mode (available through usage credits only), Team and Enterprise seats, and usage credits themselves.`,
        sources: [PLAN_SOURCES.modelConfig, PLAN_SOURCES.fable, PLAN_SOURCES.fastMode, PLAN_SOURCES.apiPricing],
      },
      {
        text: `How this was checked: every value on this page was read from the Anthropic pages linked above in ${monthYear(PLAN_FACTS.lastVerified)}, then checked against them a second time. The API rates were checked against Anthropic's pricing table again in ${monthYear(PLAN_FACTS.apiRatesRead)}. Anthropic changes plans often, so the month matters. Your inputs stay in your browser.`,
      },
    ],
  },
  examples: [
    {
      title: "A typical week",
      inputs: `5 days a week, 3 hours a day, 100% ${API.opus.label}, normal use, Pro stops you about 2 hours in, weekly limit not hit`,
      command: [
        "Pro      $20/mo   Would hit limits",
        "Max 5x   $100/mo  Fits with headroom",
        "Max 20x  $200/mo  Fits with headroom",
        "API list price, estimated: $376/mo",
      ].join("\n"),
      result:
        "Pro stops you two hours into a three-hour day. Five times two hours covers the window, so Max 5x is the cheapest plan that fits. The same work at API list price comes to an estimated $376 a month, well above Max 5x's $100.",
    },
    {
      title: "Light use, where the API can win",
      inputs: `1 day a week, 1 hour a day, 100% ${API.sonnet.label}, normal use, Pro never stops you, weekly limit not hit`,
      command: [
        "Pro      $20/mo   Fits with headroom",
        "Max 5x   $100/mo  Fits with headroom",
        "Max 20x  $200/mo  Fits with headroom",
        "API list price, estimated: $12.55/mo",
      ].join("\n"),
      result:
        "Pro covers you. But one hour a week is light enough that the estimate at API list price, $12.55 a month, comes out under Pro's $20. That's the one kind of schedule where paying per token can be cheaper, and it leans on the assumptions above.",
    },
    {
      title: "Long days and a weekly stop",
      inputs: `4 days a week, 6 hours a day, 50% ${API.opus.label}, normal use, Pro stops you about 1 hour in, Pro's weekly limit stops you`,
      command: [
        "Pro      $20/mo   Would hit limits",
        "Max 5x   $100/mo  Tight",
        "Max 20x  $200/mo  Fits with headroom",
        "API list price, estimated: $452/mo",
      ].join("\n"),
      result:
        "Five times one hour is five hours against a five-hour window, so Max 5x is rated tight and Max 20x has headroom. The weekly stop on Pro is a separate limit, and the calculator can't rate it because Anthropic publishes no weekly multiple for Max. The verdict says so.",
    },
    {
      title: "Pro stops you almost at once",
      inputs: `5 days a week, 5 hours a day, 100% ${API.opus.label}, normal use, Pro stops you about 30 minutes in, weekly limit not hit`,
      command: [
        "Pro      $20/mo   Would hit limits",
        "Max 5x   $100/mo  Would hit limits",
        "Max 20x  $200/mo  Fits with headroom",
        "API list price, estimated: $627/mo",
      ].join("\n"),
      result:
        "Five times thirty minutes is about two and a half hours. That falls short of a five-hour window, so only Max 20x clears it. At API list price the same work comes to an estimated $627 a month, above Max 20x's $200.",
    },
  ],
};

export const TOOL_ENTRIES: ToolEntry[] = [
  PLAN_CALCULATOR_ENTRY,
  {
    slug: "agent-survival-check",
    name: "Agent Survival Check",
    h1: "Will your agent still be running tomorrow morning?",
    subhead:
      "Answer a few questions about your setup. Find out whether Claude Code keeps working when you close the lid, and what to fix if it doesn't.",
    metaTitle: "Keep Claude Code Running 24/7: Agent Survival Check",
    browserTitle: "Keep Claude Code Running 24/7: Agent Survival Check | Hivra",
    metaDescription:
      "Answer a few questions about your setup and find out if Claude Code keeps running when you close your laptop. Covers sleep, SSH drops, tmux and reboots.",
    intro: {
      lede: "A long-running agent is only as reliable as the computer and terminal session underneath it. Claude Code can be midway through a job when your laptop sleeps, your SSH connection drops or the server restarts. Having the right model does not help when its process has stopped.",
      body: [
        "Use this check to describe where your agent runs, how you keep its session alive and what happens when something fails. You will get a practical risk assessment and an ordered list of fixes. It is not a live health monitor, and its score is not a prediction of uptime. If an ordinary VPS with tmux and a restart service solves your problem, we will tell you that rather than pretending you need managed hosting.",
      ],
    },
    faqs: [
      {
        q: "Why does Claude Code stop when I close my laptop?",
        a: "Sleep suspends every process on the machine, including your terminal and the agent inside it. On wake, network connections may have dropped and long running tool calls may have timed out. If the agent ran over SSH, the disconnect usually kills the remote session too unless it was inside tmux or screen.",
      },
      {
        q: "Does tmux keep Claude Code running?",
        a: "On an always-on machine, yes. tmux detaches the session from your terminal, so closing the SSH connection doesn't kill the agent. It does nothing for a laptop that goes to sleep, because the whole machine suspends, tmux included.",
      },
      {
        q: "Can I just stop my laptop from sleeping?",
        a: "Partly. On macOS, caffeinate blocks sleep while it runs. It blocks full system sleep only on AC power, and closing a MacBook lid still sleeps it unless you've set up closed-display mode with an external display. On Linux you can tell logind to ignore the lid. You pay in battery, heat and a machine you can't close or carry. Reboots, updates and network changes still kill the run.",
      },
      {
        q: "How do I keep an AI agent running overnight?",
        a: "Run it on a machine that stays on. That can be a desktop you leave running, a VPS with tmux, or a managed computer. Hivra runs Claude Code on a cloud computer with your own Anthropic sign-in (subject to the provider's terms). The $9.99 a month plan gives it 2 vCPU and 4 GB, and paid plans aren't paused for inactivity. Start the run inside tmux in the computer's Terminal tab, or send it from Telegram, and it keeps going with your laptop closed.",
      },
      {
        q: "Is a VPS with tmux enough?",
        a: "Often yes. A $5 VPS plus tmux keeps the process alive around the clock. You handle the install, the updates and the restart when something crashes. Checking in from a phone means SSH. Managed hosting is the same idea with the ops handled, plus a chat and a web terminal in the browser.",
      },
    ],
    relatedLinks: [
      { href: "/agents/claude-code", label: "Run Claude Code on Hivra" },
      { href: "/agents/codex", label: "Run Codex on Hivra" },
      { href: "/pricing", label: "Hivra pricing" },
    ],
    componentKey: "agent-survival-check",
    primaryKeyword: "keep claude code running 24/7",
    vendors: ["Anthropic", "OpenAI"],
  },
  {
    slug: "ai-agent-hosting-cost-calculator",
    name: "AI Agent Hosting Cost Calculator",
    h1: "What does it really cost to keep an AI agent running?",
    subhead:
      "Compare what running an agent 24/7 costs on a VPS you manage and on a managed computer. Your time is part of the bill.",
    metaTitle: "AI Agent Hosting Cost Calculator: VPS vs Managed",
    browserTitle: "AI Agent Hosting Cost Calculator: VPS vs Managed | Hivra",
    metaDescription:
      "Work out what running an AI agent 24/7 costs on a VPS you manage versus a managed computer. It counts your time as well as the server bill.",
    intro: {
      lede: "A five-dollar server sounds hard to beat. It often is, particularly if you are comfortable maintaining Linux and already have a machine online. But the invoice from your hosting provider is not always the whole cost. Installation, updates, backups, troubleshooting and the odd late-night restart take time too.",
      body: [
        "This calculator lets you compare a VPS you manage with a managed Hivra computer over twelve months. You choose the server, put a value on your time and decide whether backups and other extras belong in the comparison. You can also set your time cost to zero. The result should help you decide, not simply point you towards Hivra.",
      ],
      note: "The model bill is separate in both cases. Neither a VPS nor Hivra's hosting plan includes unlimited Claude, Codex or API inference. We also do not quietly bundle backups into Hivra's entry-level price when they are not included.",
    },
    faqs: [
      {
        q: "How much does it cost to run an AI agent 24/7?",
        a: "A small VPS lists at about $5 to $12 a month before tax. Hardware you already own costs mostly electricity, roughly $1 to $10 a month depending on the machine. A managed computer on Hivra is $9.99 a month for 2 vCPU and 4 GB. Model usage bills separately on all three.",
      },
      {
        q: "What is the cheapest way to run an AI agent?",
        a: "Hardware you already own, if it can stay on. An old laptop or a mini PC costs only electricity. A small VPS is next at about $5 a month. The tradeoff is your time: the install, updates, restarts, and some way to reach the agent from your phone.",
      },
      {
        q: "Why not just run the agent on my laptop?",
        a: "It stops when the laptop does. Sleep, reboots, and moving between networks all kill a long run. A laptop works for sessions you sit through. For overnight or scheduled work you need a machine that stays on.",
      },
      {
        q: "How does Hivra compare to a VPS of the same size?",
        a: `Hetzner's CX23 has the same 2 vCPU and 4 GB. It lists at $6.49 a month in Germany and Finland, plus $0.60 for its IPv4 address, before tax. ${HETZNER_LIMITED_NOTE} DigitalOcean and Vultr list 2 vCPU and 4 GB at $24 and $20 a month. Hivra is $9.99 a month and installs and runs the agent for you.`,
      },
      {
        q: "Does managed hosting include the model costs?",
        a: "No. The plan does not include AI usage. Bring your own account or key where the agent supports it, or pay with Hivra credits. If you sign in with your own Claude or ChatGPT account, that is subject to the provider's terms. Hivra charges for the computer: $9.99 a month for 2 vCPU and 4 GB, or $19.99 a month for 4 vCPU and 8 GB.",
      },
      {
        q: "When does self-hosting win?",
        a: "When your time is cheap to you or the ops are the fun part. If you already run a home server, adding an agent costs almost nothing. If you value evenings more than root access, managed hosting usually comes out ahead once you price your hours at anything real.",
      },
    ],
    relatedLinks: [
      { href: "/pricing", label: "Hivra pricing" },
      { href: "/agents/claude-code", label: "Run Claude Code on Hivra" },
      { href: "/agents/codex", label: "Run Codex on Hivra" },
    ],
    componentKey: "hosting-cost-calculator",
    primaryKeyword: "ai agent hosting cost",
    vendors: ["Anthropic", "OpenAI", "Hetzner", "DigitalOcean", "Vultr", "AWS"],
  },
  {
    slug: "claude-code-limit-reset-calculator",
    name: "Claude Code Limit Reset Calculator",
    h1: "When will Claude Code let you work again?",
    subhead:
      "Enter the time you sent the first prompt of this session. See the minute the five-hour window should close, and why the weekly limit is a different clock.",
    metaTitle: "When Does Claude Code Usage Limit Reset? Calculator",
    browserTitle: "When Does Claude Code Usage Limit Reset? Calculator | Hivra",
    metaDescription:
      "Enter your first prompt time and see when your Claude Code five-hour window reopens. Plus why waiting five hours never clears the weekly limit.",
    intro: {
      lede: "A Claude Code limit can arrive in the middle of an otherwise productive session. You remember when you started, but not necessarily when the window ends, and the message about weekly usage can look deceptively similar.",
      body: [
        "Put in the time of your first message and this calculator will show a *possible* end to your five-hour session window on your own clock. If you know your weekly reset, you can add that separately. The important distinction is that waiting five hours does not clear a weekly allowance.",
      ],
      note: "Anthropic's own usage screen and the reset time in Claude Code remain authoritative. This tool estimates timing from an explicitly stated first-message assumption; it cannot see your account or grant additional usage.",
    },
    faqs: [
      {
        q: "When does the Claude Code usage limit reset?",
        a: "Five hours after your session started, whatever the clock says. Anthropic describes a rolling five-hour session window and doesn't document what opens it. The widely reported behaviour, and the one this calculator assumes, is that your first message opens it: send it at 10:20 and the window closes at 15:20. Claude Code's limit message and the /usage command show the exact reset time.",
      },
      {
        q: "Why does my Claude Code limit reset at a different time each day?",
        a: "Because the window follows your own usage. On the first message model, a 9am start resets at 2pm and a 1pm start resets at 6pm. There's no fixed daily reset time, so a calculator beats guessing.",
      },
      {
        q: "I waited 5 hours and I'm still limited. What happened?",
        a: "You probably hit a weekly limit. Weekly limits sit on top of the five-hour window and reset at a fixed time each week, assigned to your account, so waiting out a session doesn't restore them. It can also be a model limit, such as the Opus limit, and then switching models with /model keeps you working. Claude Code's message names the limit you hit.",
      },
      {
        q: "Does using Claude on the web use up my Claude Code limit?",
        a: "Yes. Claude on the web, desktop and mobile and Claude Code all draw from the same pool. A heavy chat session in the browser leaves less for Claude Code inside the same window.",
      },
      {
        q: "Does running Claude Code on a server give me more usage?",
        a: "No. The limits follow your Anthropic account, so a cloud computer gets exactly the same quota as your laptop. What changes is whether the window gets used. Claude Code can pick a task back up on its own after a reset, but only while the session stays open. If your laptop sleeps through the reset for more than about 30 minutes, it waits for you to press Enter.",
      },
      {
        q: "How do I see how much quota I have left?",
        a: "Run /usage inside Claude Code, or open Settings, then Usage, on your Claude account. Both show what's left in the current session and against the weekly limit, with reset times. Anthropic doesn't publish exact prompt or token caps per plan, so those readouts are more reliable than any published number.",
      },
    ],
    relatedLinks: [
      { href: "/agents/claude-code", label: "Run Claude Code on Hivra" },
      { href: "/pricing", label: "Hivra pricing" },
    ],
    componentKey: "limit-reset-calculator",
    primaryKeyword: "when does claude code usage limit reset",
    vendors: ["Anthropic"],
  },
  {
    slug: "keep-mac-awake",
    name: "Keep Mac Awake Command Builder",
    h1: "Keep your Mac awake while an agent works",
    subhead:
      "Pick macOS or Linux, how long, power and lid. You get the exact command, how to check it's working, and a list of what it won't cover.",
    metaTitle: "Caffeinate Mac: Keep Your Mac Awake, Command Builder",
    browserTitle: "Caffeinate Mac: Keep Your Mac Awake, Command Builder | Hivra",
    metaDescription:
      "Build the exact caffeinate command to keep a Mac awake while Claude Code or Codex runs, with the Linux version and a list of what it can't cover.",
    intro: {
      lede: "If you are running Claude Code, Codex or another CLI agent locally, your Mac going to sleep can interrupt the job. macOS already includes a small tool called `caffeinate` that can help, and in many cases it is all you need.",
      body: [
        "Choose your operating system, whether you are plugged in, what you want to run and how long you need it awake. The builder will give you a command you can copy, a way to check it and an explanation of its limits.",
      ],
      note: "The crucial catch: keeping a computer awake is not the same as keeping an agent reliable. It will not prevent reboots, recover from a failed tool call or guarantee that a MacBook stays running with its lid closed. This page tells you where those boundaries are instead of promising an overnight run it cannot deliver.",
    },
    faqs: [
      {
        q: "How do I use caffeinate on Mac?",
        a: "Open Terminal and run caffeinate -i. That stops idle sleep until you press Ctrl-C. To keep the Mac awake only while a command runs, put caffeinate in front of it, for example caffeinate -is claude. The -s flag also blocks system sleep, but only on AC power. The -t flag sets a timeout in seconds, though caffeinate ignores it when it wraps a command.",
      },
      {
        q: "What is the difference between caffeinate -i and -s?",
        a: "-i creates an assertion that stops the system from idle sleeping. -s creates one that stops the system from sleeping, and Apple's manual says it's valid only while the Mac runs on AC power. On battery, only -i applies.",
      },
      {
        q: "How do I keep my Mac awake with the lid closed?",
        a: "caffeinate doesn't promise that. Apple documents closed-lid use of a MacBook when an external display is connected, with power connected and an external keyboard and mouse or trackpad. Without those, plan on the lid sleeping the Mac. If a run has to outlast a closed laptop, run it on a machine that stays on.",
      },
      {
        q: "Will Claude Code keep running if my computer goes to sleep?",
        a: "No. Sleep suspends every process on the machine, Claude Code included, and a call in flight can fail when the machine wakes. Keep the Mac awake with caffeinate while it works, or run it on a machine that stays on.",
      },
      {
        q: "How do I stop caffeinate?",
        a: "Press Ctrl-C in the terminal tab where it runs. If it wraps a command, it stops when the command exits, and a timed caffeinate -t stops when the timeout ends. To stop one you started in the background, run pkill caffeinate.",
      },
      {
        q: "Does caffeinate work on battery?",
        a: "Partly. -i works on battery and stops idle sleep, though the battery keeps draining. -s only applies on AC power, so the builder leaves it out when you say you're on battery.",
      },
      {
        q: "How do I keep a Linux laptop awake when I close the lid?",
        a: "Run the command under systemd-inhibit --what=sleep:handle-lid-switch. The lock lasts while the command runs. For a permanent change, set HandleLidSwitch=ignore in logind.conf. Some desktops handle the lid themselves, so test with the lid closed for a minute.",
      },
    ],
    faqCode: [
      "caffeinate -is claude",
      "caffeinate -i",
      "caffeinate -t",
      "pkill caffeinate",
      "systemd-inhibit --what=sleep:handle-lid-switch",
      "HandleLidSwitch=ignore",
      "logind.conf",
      "Ctrl-C",
      "-i",
      "-s",
      "-t",
    ],
    relatedLinks: [
      { href: "/tools/agent-survival-check", label: "Check if your whole setup survives a closed laptop" },
      { href: "/tools/tmux-cheat-sheet", label: "tmux cheat sheet for AI coding agents" },
      { href: "/agents/claude-code", label: "Run Claude Code on Hivra" },
    ],
    componentKey: "keep-mac-awake",
    primaryKeyword: "caffeinate mac",
    vendors: ["Anthropic", "OpenAI", "Apple"],
    method: {
      heading: "How the command is built",
      lastVerified: KEEP_AWAKE_FACTS.lastVerified,
      paragraphs: [
        {
          text: "On a Mac the builder uses caffeinate, which comes with macOS. The -i flag creates an assertion that stops idle sleep. The -s flag creates one that stops system sleep, and the manual says it's valid only while the Mac runs on AC power, so the builder adds it only when you say you're plugged in.",
          sources: [KEEP_AWAKE_FACTS.sources.caffeinate],
        },
        {
          text: "When caffeinate wraps a command, it holds its assertions for as long as the command runs. The manual says the -t timeout isn't used in that form. So for a fixed number of hours, the builder gives you a separate caffeinate -t command for its own terminal tab, with the hours converted to seconds.",
          sources: [KEEP_AWAKE_FACTS.sources.caffeinate],
        },
        {
          text: "The manual doesn't promise that caffeinate keeps a closed MacBook awake. Apple documents using a MacBook with the lid closed when an external display is connected, with power connected and an external keyboard and mouse or trackpad. So the builder treats a closed lid as something caffeinate alone doesn't cover.",
          sources: [KEEP_AWAKE_FACTS.sources.appleLidClosed, KEEP_AWAKE_FACTS.sources.appleDisplayGuide],
        },
        {
          text: "pmset is how you check, and how you make a setting stick. pmset -g assertions lists the assertions caffeinate takes. pmset -g custom shows your current settings, and setting sleep to 0 turns the system sleep timer off until you change it back. It's a saved setting, and it won't fix a closed lid.",
          sources: [KEEP_AWAKE_FACTS.sources.pmset],
        },
        {
          text: "On Linux the builder uses systemd-inhibit. Its --what option takes a colon-separated list. That list includes sleep, which blocks suspend and hibernate, and handle-lid-switch, which blocks the lid switch handling. The lock is held while the command it runs is alive, and --list shows the active locks. The builder adds handle-lid-switch only when you say the lid will be closed. For a permanent change, the HandleLidSwitch setting in logind.conf controls what a closed lid does.",
          sources: [KEEP_AWAKE_FACTS.sources.systemdInhibit, KEEP_AWAKE_FACTS.sources.logindConf],
        },
        {
          text: "How this was tested: the builder only prints commands and runs nothing on your machine. We checked the caffeinate timeout and the assertion names by running caffeinate -is -t on a MacBook on AC power with macOS 26.6.2 on 2026-09-30, then reading the assertions back with pmset -g assertions. We built the Linux commands from the manual and haven't run them for this page.",
        },
      ],
    },
    examples: [
      {
        title: "Claude Code on a plugged-in MacBook, lid open",
        inputs: "macOS, until the command exits, plugged in, lid open, claude",
        command: "caffeinate -is claude",
        result:
          "Idle sleep and system sleep are both held off while claude runs and the Mac is on power. The lid has to stay open. Shutting it would put the Mac to sleep.",
      },
      {
        title: "An 8 hour Codex run on battery",
        inputs: "macOS, for 8 hours, on battery, lid open, codex",
        command: "caffeinate -i -t 28800",
        result:
          "A caffeinate running in one terminal tab holds off idle sleep for 28,800 seconds, and Codex starts in another. -s is left out because it needs AC power. The battery keeps draining.",
      },
      {
        title: "A Linux laptop with the lid closed",
        inputs: "Linux, until the command exits, plugged in, lid closed, claude",
        command: 'systemd-inhibit --what=sleep:handle-lid-switch --why="agent run" claude',
        result:
          "While claude runs, suspend and the lid-close action are blocked. If your desktop handles the lid itself, test with the lid closed for a minute before you rely on it.",
      },
    ],
  },
  {
    slug: "tmux-cheat-sheet",
    name: "tmux Cheat Sheet for AI Coding Agents",
    h1: "tmux commands worth keeping nearby",
    subhead:
      "Sessions, windows, panes, detach and attach, copy mode and logging, plus the few commands that keep an AI coding agent in a session you can leave and come back to.",
    metaTitle: "tmux Cheat Sheet: Commands and Keys for AI Agents",
    browserTitle: "tmux Cheat Sheet: Commands and Keys for AI Agents | Hivra",
    metaDescription:
      "A tmux cheat sheet with copy buttons: sessions, windows, panes, detach and attach, copy mode and logging, plus commands for AI coding agents.",
    intro: {
      lede: "You do not need to learn every corner of tmux to make it useful. Start a named session, run your agent, detach, then return later from another terminal or device. That handful of commands solves one of the most irritating problems with long-running CLI work: losing the terminal that was holding everything together.",
      body: [
        "This reference covers sessions, windows, panes, copy mode, logging and a few practical setups for Claude Code and Codex. The commands are here to copy, not memorise. We also explain the underlying behaviour, because tmux protects you from terminal disconnects, not from a sleeping computer, a reboot or an agent crash.",
      ],
      note: TMUX_KEYS_NOTE,
    },
    faqs: [
      {
        q: "What is the tmux prefix key?",
        a: "Ctrl-b by default. Press Ctrl and b together, let go, then press the command key. Ctrl-b d detaches from the session, Ctrl-b c creates a window and Ctrl-b % splits the pane into left and right.",
      },
      {
        q: "How do I detach from and reattach to a tmux session?",
        a: "Press Ctrl-b then d to detach. The session keeps running. Run tmux ls to list sessions and tmux attach -t NAME to attach to one. If another device is still attached, tmux attach -d -t NAME detaches it as it attaches you.",
      },
      {
        q: "How do I scroll in tmux?",
        a: "Press Ctrl-b then [ to enter copy mode, then scroll with the arrow keys or Page Up and Page Down. Leave with Escape, or q if you use vi keys. Ctrl-b Page Up enters copy mode and scrolls one page up. To scroll with the mouse, run tmux set -g mouse on.",
      },
      {
        q: "What is the difference between a tmux session, window and pane?",
        a: "A session is a named workspace that keeps running in the background. A window is one full-screen view inside a session, like a browser tab. A pane is one terminal inside a window, made by splitting it.",
      },
      {
        q: "How do I keep Claude Code running in tmux?",
        a: "Start a session with tmux new -s claude, run claude inside it, and press Ctrl-b then d to detach. Claude Code keeps running in the session until the machine sleeps, restarts or you kill the session. Reattach with tmux attach -t claude. If the CLI itself exited and you need the chat history, see the resume guide for Codex and Claude Code.",
      },
      {
        q: "Does tmux keep a process running when my laptop sleeps?",
        a: `No. tmux keeps a session alive through a closed terminal or a dropped SSH connection, but a sleeping laptop suspends everything on it, tmux included. To keep a run going, use a computer that stays on. ${CLI_RUN_LIFETIME}`,
      },
      {
        q: "How do I log tmux output to a file?",
        a: "Run tmux pipe-pane -o -t NAME: 'cat >> ~/NAME.log' to append everything the pane prints from that moment. Run it again, or tmux pipe-pane -t NAME:, to stop. To save the existing history once, run tmux capture-pane -p -S - -t NAME: > file.",
      },
    ],
    faqCode: [
      "tmux pipe-pane -o -t NAME: 'cat >> ~/NAME.log'",
      "tmux pipe-pane -t NAME:",
      "tmux capture-pane -p -S - -t NAME: > file",
      "tmux attach -d -t NAME",
      "tmux attach -t NAME",
      "tmux attach -t claude",
      "tmux new -s claude",
      "tmux set -g mouse on",
      "tmux ls",
      "Ctrl-b then [",
      "Ctrl-b then d",
      "Ctrl-b Page Up",
      "Ctrl-b d",
      "Ctrl-b c",
      "Ctrl-b %",
      "Ctrl-b",
    ],
    relatedLinks: [
      { href: "/tools/keep-mac-awake", label: "Keep a Mac awake with caffeinate" },
      { href: "/tools/agent-survival-check", label: "Check if your setup survives a closed laptop" },
      { href: "/blog/codex-resume-session", label: "Resume a Codex or Claude Code session" },
      { href: "/agents/claude-code", label: "Run Claude Code on Hivra" },
      { href: "/agents/codex", label: "Run Codex on Hivra" },
    ],
    componentKey: "tmux-cheat-sheet",
    primaryKeyword: "tmux cheat sheet",
    vendors: ["Anthropic", "OpenAI"],
    method: {
      heading: "How this cheat sheet was checked",
      lastVerified: TMUX_FACTS.lastVerified,
      paragraphs: [
        {
          text: "Every key and command comes from the tmux manual: the default key bindings table, the new-session, attach-session, pipe-pane, capture-pane and send-keys entries, and the copy-mode tables for emacs and vi keys.",
          sources: [TMUX_FACTS.sources.manual],
        },
        {
          text: "Commands that act on a pane end the target with a colon, as in claude:. The manual says a target that isn't fully qualified is a best guess, and that scripts should qualify it. NAME: means that session's current window and active pane.",
          sources: [TMUX_FACTS.sources.manual],
        },
        {
          text: "The logging commands use pipe-pane. It sends a pane's output to a command from the moment it runs, and it doesn't include earlier output. The -o flag opens a pipe only if none is open, and it closes one that's already open. With no command, pipe-pane closes the current pipe.",
          sources: [TMUX_FACTS.sources.manual],
        },
        {
          text: "tmux keeps its sessions in a server process on the machine it runs on. A disconnect leaves that server running. A machine that sleeps or powers off stops it. That's why the sheet says tmux survives disconnects but not a sleeping laptop.",
        },
        {
          text: "How this was checked: we read the commands from the manual and haven't run them on every tmux version. If a command is refused, check tmux -V and the manual for your version.",
        },
      ],
    },
    examples: [
      {
        title: "Claude Code in a named session",
        inputs: "Claude Code, session name claude, logging off",
        command: [
          "# Start the session in the background",
          "tmux new -d -s claude",
          "# Run the agent inside it",
          "tmux send-keys -t claude: 'claude' Enter",
          "# Watch it. Ctrl-b then d leaves it running",
          "tmux attach -t claude",
        ].join("\n"),
        result:
          "The session exists before the agent starts, so closing the terminal later leaves both running. Ctrl-b then d detaches on purpose.",
      },
      {
        title: "A logged Codex run",
        inputs: "Codex, session name codex, logging on",
        command: [
          "# Start the session in the background",
          "tmux new -d -s codex",
          "# Log everything the pane prints, from now on",
          "tmux pipe-pane -o -t codex: 'cat >> ~/codex.log'",
          "# Run the agent inside it",
          "tmux send-keys -t codex: 'codex' Enter",
          "# Watch it. Ctrl-b then d leaves it running",
          "tmux attach -t codex",
        ].join("\n"),
        result:
          "Logging starts before the agent does, so the file holds the whole run. It's raw terminal output and includes anything the pane shows, so keep it private.",
      },
      {
        title: "Picking a session up from another device",
        inputs: "Claude Code, session name claude, attached on a laptop, now on a phone over SSH",
        command: "tmux attach -d -t claude",
        result:
          "Attaches the phone and detaches the laptop. The session and the agent in it are unaffected by the switch, as long as the machine they run on stayed awake.",
      },
    ],
  },
];

export function getToolEntry(slug: string): ToolEntry | undefined {
  return TOOL_ENTRIES.find((entry) => entry.slug === slug);
}

/** Absolute site path of a tool page. */
export function toolPath(slug: string): string {
  return `/tools/${slug}`;
}

/** Social card served by app/tools/[slug]/opengraph-image.tsx (or the hub's). */
export function toolOgImage(slug?: string) {
  return {
    url: slug ? `/tools/${slug}/opengraph-image` : "/tools/opengraph-image",
    width: 1200,
    height: 630,
    alt: slug ? `${getToolEntry(slug)?.name ?? "Free tool"}, a free tool from Hivra` : "Free tools for running AI agents, from Hivra",
    type: "image/png",
  };
}

/** "Hivra is independent and is not affiliated with A, B or C." */
export function nonAffiliationLine(vendors: readonly string[]): string {
  if (vendors.length === 0) return "Hivra is independent.";
  const list =
    vendors.length === 1
      ? vendors[0]
      : `${vendors.slice(0, -1).join(", ")} or ${vendors[vendors.length - 1]}`;
  return `Hivra is independent and is not affiliated with ${list}.`;
}
