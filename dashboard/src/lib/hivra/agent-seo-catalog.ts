// Agent SEO catalog: the registry and metadata of the public /agents pages.
//
// Keyed to agent-catalog ids and limited to agents that are launchable today
// (available: true). Pure data (no React) so the pages, the sitemap
// (lib/seo-urls.ts) and the tests can all import it. Product facts trace back
// to agent-catalog.ts (runtime availability, resource floors, browser add-on),
// welcome-agent-catalog.ts (sign-in and connect flows) and the billing plans in
// lib/subscription. If a fact isn't in code, it doesn't get claimed here.
//
// The words of each page live in app/agents/content/ (one module per agent plus
// the directory), written from Ash's batch 02 files. This file keeps what the
// rest of the code reads: the slugs, the sign-up agentType, the browser title and
// search description, the sitemap date and the shared links.
//
// Pricing rules (owner decision 2026-09-14): the public ladder and checkout
// sell the same two entry sizes at the same prices under different names, so
// copy names a plan by PRICE AND SIZE ("$9.99 a month for 2 vCPU and 4 GB"),
// never by plan name. No trial, no hosted free plan, no agent-count limits.
// Every computer Hivra Cloud runs for you is paid, for every agent alike (owner decision
// 2026-10-21): no page or description names one agent as the paid one, because that reads as
// if the others host for free. A free account works with a computer or server you connect yourself.
// "Stays on" is only claimed for paid plans, which are never paused for
// inactivity. The Claude Code, Codex and OpenClaw titles say it about the
// computer but cannot carry the paid qualifier, so the hero paragraph beside
// each carries it (STAYS_ON in app/agents/content/shared.ts). No title or
// description says the agent itself is "always on". The tests in
// __tests__/agent-seo-catalog.test.ts hold these rules.

import type { AgentId } from "@/lib/hivra/agent-catalog";
import type { WelcomeAgentTypeKey } from "@/lib/welcome-agent-catalog";
import { CLI_RUN_FALSE_CLAIMS } from "@/lib/blog/runtime-facts";
import { PUBLIC_START_HREF } from "@/lib/public-start";

/** Subset of the ops catalog that gets a public landing page. */
export type AgentSeoSlug = Extract<
  AgentId,
  "hermes" | "claude-code" | "codex" | "aeon" | "openclaw" | "agent-zero"
>;

export interface AgentSeoEntry {
  slug: AgentSeoSlug;
  /** The sign-up agentType key that opens Launch on this agent (Hermes is "general"). */
  agentType: WelcomeAgentTypeKey;
  /**
   * The browser title without the brand. The pages publish `${metaTitle} | Hivra` as an absolute
   * title (agentPageTitle), which is the title Ash wrote; this bare form is what the SEO title index reads.
   * Exception: the Claude Code, Codex and OpenClaw titles were reworded on 2026-10-21 to say the computer
   * stays on, not that the agent is "always on" or runs "even when your laptop is off". For Claude Code and
   * Codex, lib/blog/runtime-facts.ts promises only the computer staying on, plus a run started inside tmux (or,
   * on Claude Code, sent through Telegram). OpenClaw's gateway does run on the computer itself (same file), but
   * the 2026-10-21 copy fix list put the claim on the computer for it too, to match the other two.
   */
  metaTitle: string;
  metaDescription: string;
}

/**
 * Date these pages last changed substantively (sitemap lastmod). The agent pages
 * were rewritten from Ash's batch 02 copy on 2026-10-20, and on 2026-10-21 every one
 * took the same paid-computer wording (no agent is the "paid" one) and the Aeon
 * dashboard-computer line. Move it only for a real content change.
 */
export const AGENT_PAGES_LAST_MODIFIED = "2026-10-21";

/**
 * Entry monthly price for every agent page, as the JSON-LD Offer price. It is
 * checkout's $9.99 plan (PLANS.operator, 2 vCPU / 4 GB) and the public ladder's
 * $9.99 size; the catalog test pins both so neither can drift from this.
 */
export const AGENT_OFFER_PRICE_USD = "9.99";

/**
 * Primary CTA on the hub: the public start link (sign-up, then Launch), so a
 * visitor chooses where the agent runs before any plan or checkout.
 */
export const AGENTS_HUB_DEPLOY_HREF = PUBLIC_START_HREF;

/** Secondary CTA everywhere. */
export const PRICING_HREF = "/pricing";

export const AGENT_SEO_ENTRIES: AgentSeoEntry[] = [
  {
    slug: "claude-code",
    agentType: "claude-code",
    metaTitle: "Run Claude Code in the Cloud, on a Computer That Stays On",
    metaDescription:
      "Run the official Claude Code CLI on a managed cloud computer. Use your Anthropic sign-in, terminal, files and optional live browser. From $9.99/mo.",
  },
  {
    slug: "codex",
    agentType: "codex",
    metaTitle: "Run OpenAI Codex on a Cloud Computer That Stays On",
    metaDescription:
      "Host the official OpenAI Codex CLI on a private cloud VM. Sign in with ChatGPT or an OpenAI API key and keep your coding workspace available. From $9.99/mo.",
  },
  {
    slug: "hermes",
    agentType: "general",
    metaTitle: "Hermes Agent Hosting: Memory, Skills and Scheduled Work",
    metaDescription:
      "Run the open-source Hermes agent on a cloud computer with persistent memory, skills, browser tools and scheduled tasks. From $9.99/mo.",
  },
  {
    slug: "aeon",
    agentType: "aeon",
    metaTitle: "Aeon Agent Hosting: Scheduled Work on Your GitHub",
    metaDescription:
      "Host Aeon's dashboard on Hivra and run scheduled research, PR reviews and scans through your own GitHub Actions. Managed plans from $9.99/mo.",
  },
  {
    slug: "openclaw",
    agentType: "openclaw",
    metaTitle: "OpenClaw Hosting: Message It on a Computer That Stays On",
    metaDescription:
      "Run OpenClaw on a managed cloud VM with its Control UI, messaging integrations and scheduled routines. From $9.99/mo.",
  },
  {
    slug: "agent-zero",
    agentType: "agent-zero",
    metaTitle: "Agent Zero Hosting: Its Own Browser and Cloud Computer",
    metaDescription:
      "Deploy the open-source Agent Zero stack on a private managed VM with its own browser, dashboard and tools. From $9.99/mo.",
  },
];

/** Every slug with a public page, in page order (sitemap + static params). */
export const AGENT_SEO_SLUGS: AgentSeoSlug[] = AGENT_SEO_ENTRIES.map((entry) => entry.slug);

export function getAgentSeoEntry(slug: string): AgentSeoEntry | undefined {
  return AGENT_SEO_ENTRIES.find((entry) => entry.slug === slug);
}

/**
 * The finished browser title, the bare title and the brand: Ash's, bar the three run-level titles
 * reworded on 2026-10-21 (see metaTitle). Published as an absolute title (lib/metadata.ts
 * absoluteTitle), so the root layout does not add " | Hivra" again.
 */
export function agentPageTitle(entry: Pick<AgentSeoEntry, "metaTitle">): string {
  return `${entry.metaTitle} | Hivra`;
}

/**
 * Primary CTA for an agent page: sign-up with this agent named, which opens
 * Launch on that agent (see buildAgentLaunchHref).
 */
export function agentDeployHref(entry: Pick<AgentSeoEntry, "agentType">): string {
  return `${PUBLIC_START_HREF}?agentType=${encodeURIComponent(entry.agentType)}`;
}

/**
 * Claims the /agents pages must never make today (owner decision 2026-09-14
 * plus what checkout sells). The catalog and page tests scan every copy string
 * and the rendered pages against this list.
 */
export const AGENT_COPY_BANNED_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /free trial/i, reason: "no trial exists" },
  { pattern: /\btrial\b/i, reason: "no trial exists" },
  { pattern: /card required|credit card|no card\b/i, reason: "no card-required or no-card offer" },
  { pattern: /never sleeps/i, reason: "sleep claims belong to plan terms, not agent pages" },
  { pattern: /always free|\bfree (plan|tier)\b|\$0\b/i, reason: "no hosted free plan is advertised" },
  { pattern: /unlimited/i, reason: "no unlimited-agents claim" },
  { pattern: /up to \d+ agents|\b\d+ agents\b|agent slots?\b/i, reason: "no agent-count limits" },
  { pattern: /one click|\bfew minutes\b|\b\d+ minutes\b|\bin minutes\b|\bin seconds\b/i, reason: "no unmeasured speed claims" },
  { pattern: /\bwindows\b/i, reason: "Windows is not generally available" },
  { pattern: /snapshot|\bclones?\b/i, reason: "snapshots and clones are not shipped" },
  { pattern: /backs? (it )?up|backups?/i, reason: "backups are not guaranteed" },
  { pattern: /never sees|never stores?|cannot read|can't read your|no access to your/i, reason: "Hivra administrators keep infrastructure access" },
  { pattern: /desktop app/i, reason: "no desktop app is published" },
  { pattern: /\b(aws|gcp|azure|digitalocean|google cloud)\b/i, reason: "no bring-your-own-cloud on those providers" },
  { pattern: /multi-agent coordination|orchestrat/i, reason: "coordination is not built in" },
  { pattern: /\b(Free|Pro|Power|Starter|Studio|Max|Command) plan\b/, reason: "plan names collide between checkout and the public ladder; use price and size" },
  { pattern: /\bstarter (?:paid )?(?:plan|tier|size)\b/i, reason: "no Starter plan name in any case; use price and size" },
  { pattern: /\bseven-day\b|\beligible\b|\bat checkout\b/i, reason: "refund wording is the shared '7-day money-back guarantee on card payments'" },
  { pattern: /\bsource (?:deployment|configuration|export|copy)\b|\bsite export\b/i, reason: "implementer references from the source export are not reader copy" },
  { pattern: /[\u2013\u2014]/, reason: "no em or en dashes in page copy" },
  // Nothing measured backs an hour count for setting up a server (2026-09-30 copy audit, F-15).
  {
    pattern: /\b\d+\s*(?:-|to)\s*\d+\+?\s*hours?\b|\b(?:an? hour|\d+ hours?) (?:per|a|each|\/) ?month\b|\b(?:spend|spent) (?:a|the) weekend\b|\b(?:the|a) weekend (?:you|setting|configuring|of)\b|\b(?:full|whole) (?:weekend|afternoon)\b/i,
    reason: "no invented hours for setting up or running a server",
  },
  // Claude Code and Codex keep-running claims, shared with the blog and /tools
  // (lib/blog/runtime-facts.ts): the old survives-anything claims, "stops when
  // you close the tab" (false on updated computers) and "the browser chat keeps
  // going" (false on computers without the runtime update).
  ...CLI_RUN_FALSE_CLAIMS.map(({ pattern, reason }) => ({ pattern, reason })),
];

/**
 * Agents whose keep-running promises must say how the run is started. These run
 * the vendor's CLI, and what a browser chat or session-tab run does after the
 * tab closes depends on whether the computer has the 2026.09.24.1 runtime
 * (detached chat runs, session tab inside tmux), which existing computers only
 * get through an owner-approved rollout. So copy promises only what holds on
 * every computer: it stays on and keeps files, sessions and logins; a run
 * started inside tmux in the Terminal tab (tmux is installed on every one), or
 * on Claude Code one sent through Telegram, keeps going. Hermes, OpenClaw and
 * Agent Zero run on the computer and Aeon's tasks on the owner's GitHub
 * Actions, so they are not in this list.
 */
export const CLI_RUN_AGENT_SLUGS: ReadonlyArray<AgentSeoSlug> = ["claude-code", "codex"];

const KEEPS_RUNNING = /\b(keeps?|kept) (going|working|running)\b|\bnothing stops\b|\bwalk away\b|\bfinished work\b/i;
const DETACHED_RUN = /\btmux\b|\bTelegram\b/;

/**
 * Sentences that promise a Claude Code or Codex run keeps working without
 * saying how (inside tmux or from Telegram). Pass `mentioning` to check only
 * sentences about those agents, for copy that also covers the other agents.
 */
export function unqualifiedKeepRunningClaims(text: string, mentioning?: RegExp): string[] {
  return text
    .replace(/([.!?])\s+/g, "$1\n")
    .split(/\n+/)
    .filter((sentence) => KEEPS_RUNNING.test(sentence) && !DETACHED_RUN.test(sentence))
    .filter((sentence) => !mentioning || mentioning.test(sentence));
}

/** Hub-level non-affiliation line, naming every vendor the hub lists. */
export const AGENTS_HUB_AFFILIATION =
  "Hivra is an independent hosting service and is not affiliated with or endorsed by Anthropic, OpenAI, Nous Research, Aeon, OpenClaw or Agent Zero.";
