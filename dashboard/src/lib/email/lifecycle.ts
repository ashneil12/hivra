/**
 * Lifecycle emails — Resend integration.
 *
 * Six emails driven by the lifecycle-emails cron (day 1 idle / day 1
 * active / day 3 use-case / day 7 offer / stalled after 5 days / trial
 * day 5), selected by key. Send-at-most-once bookkeeping lives in lifecycle_email_sends
 * (see the lifecycle-email-sweep module); this module only knows how to
 * build and send each email.
 *
 * Voice: direct, minimal, dry. No exclamation points, no hype. Signed
 * "— Ash / Founder, Hivra" like the other email modules (the stalled
 * email is written as the agent, with an Ash footnote).
 */

import { Resend } from "resend";

import {
  lifecycleUnsubscribeHeaders,
  resolveFromEmail,
  resolveReplyToEmail,
} from "@/lib/email/config";
import { GOALS } from "@/lib/hivra/agent-identity";
import { log } from "@/lib/logger";
import { SITE_URL } from "@/lib/seo-urls";

export const LIFECYCLE_EMAIL_KEYS = [
  "day1_idle",
  "day1_active",
  "day3_usecase",
  "day7_offer",
  "stalled_5d",
  "trial_day5",
  "activity_digest",
] as const;

export type LifecycleEmailKey = (typeof LIFECYCLE_EMAIL_KEYS)[number];

/**
 * Summary the weekly activity-digest email renders. Built cron-side from
 * buildInstanceActivityDigest (see lib/command-center/activity.ts) — the
 * builder here only formats it, it never reaches the WebUI itself.
 */
export interface ActivityDigestSummary {
  /** Number of sessions touched in the digest window. */
  sessionCount: number;
  /** Total messages across those sessions (null when none reported it). */
  totalMessages: number | null;
  /** Most-used model across the recent sessions, when known. */
  topModel: string | null;
  /** Estimated spend across the recent sessions, when known. */
  estimatedCostUsd: number | null;
  /** Human-readable attention lines (e.g. "Waiting on an approval"). */
  attentionLabels: string[];
}

export interface LifecycleEmailContentParams {
  firstName?: string | null;
  agentName?: string | null;
  /** Instance to deep-link to, when the email talks about a specific agent. */
  instanceId?: string | null;
  /** Populated only for the activity_digest email. */
  activityDigest?: ActivityDigestSummary | null;
  /**
   * Launch goal id captured at deploy (Wave 1.2), e.g. "research". The day1/day3
   * builders map it to a human label via the goal registry and weave it into the
   * copy. Absent/unknown → generic fallback (the email never says "goal: null").
   */
  goal?: string | null;
  /** First task the user asked their agent to demonstrate, captured at launch. */
  firstTask?: string | null;
}

export interface LifecycleEmailSendParams extends LifecycleEmailContentParams {
  email: string;
  idempotencyKey: string;
}

export interface LifecycleEmailContent {
  subject: string;
  text: string;
  html: string;
  ctaUrl: string;
}

export type LifecycleEmailSendResult =
  | { sent: true; messageId?: string }
  | { sent: false; reason: "not_configured" | "send_failed"; errorMessage?: string };

const LOG_SOURCE = "lifecycle-email";
const DASHBOARD_URL = `${SITE_URL}/dashboard`;
/** A new launch in the one place agents and computers start from. */
const LAUNCH_URL = `${SITE_URL}/dashboard/launch?kind=agent&start=1`;
const BILLING_URL = `${SITE_URL}/dashboard/billing`;

function greeting(firstName?: string | null): string {
  return firstName?.trim() ? `Hey ${firstName.trim()},` : "Hey,";
}

function agentDisplayName(agentName?: string | null): string {
  return agentName?.trim() ? agentName.trim() : "your agent";
}

function instanceUrl(instanceId?: string | null): string {
  return instanceId ? `${SITE_URL}/dashboard/instances/${instanceId}` : DASHBOARD_URL;
}

/**
 * Copy-friendly noun phrase for each launch goal, for use mid-sentence
 * ("...to help you research a topic"). Keyed off the same registry the picker
 * uses (lib/hivra/agent-identity GOALS) so a new goal is a compile error here
 * until it gets a phrase. The picker labels ("Research a topic") double as the
 * phrase verbatim, lowercased.
 */
const GOAL_EMAIL_PHRASE: Record<string, string> = {
  build: "build software",
  research: "research a topic",
  grow: "grow a business",
  write: "write and create",
  automate: "automate work",
  analyze: "analyze data",
  ops: "run operations",
  assist: "get a hand with whatever comes up",
};

// Build-time guard: every registry goal must have an email phrase. Keeps the two
// lists from drifting silently when someone adds a goal to the picker.
for (const g of GOALS) {
  if (!GOAL_EMAIL_PHRASE[g.id]) {
    GOAL_EMAIL_PHRASE[g.id] = g.label.toLowerCase();
  }
}

/**
 * Resolve a captured goal id to a copy-friendly phrase, or null when no usable
 * goal was captured (absent, blank, or an unknown id). Returns null rather than
 * coercing to the default goal so the email falls back to generic copy instead
 * of asserting a job the user never picked.
 */
function goalEmailPhrase(goal?: string | null): string | null {
  const id = goal?.trim();
  if (!id) return null;
  return GOAL_EMAIL_PHRASE[id] ?? null;
}

/** Trimmed first task, or null when none was captured. */
function firstTaskPhrase(firstTask?: string | null): string | null {
  const trimmed = firstTask?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Collapse free-text (the user's first task may be multi-line) to a single
 * tidy line for inlining into a sentence: whitespace runs squashed, a trailing
 * period dropped (it sits inside quotes), and capped so a pasted paragraph
 * can't blow out the email. Caller is responsible for HTML-escaping the result.
 */
function oneLine(value: string, maxLen = 140): string {
  const collapsed = value.replace(/\s+/g, " ").trim().replace(/\.$/, "");
  return collapsed.length > maxLen ? `${collapsed.slice(0, maxLen - 1).trimEnd()}…` : collapsed;
}

/** Minimal HTML escaping for user-supplied text dropped into email markup. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const PARAGRAPH_STYLE = "margin:0 0 20px;font-size:16px;line-height:1.6;color:#1a1a1a;";
const LIST_STYLE = "margin:0 0 20px;padding-left:20px;font-size:16px;line-height:1.6;color:#1a1a1a;";
const LIST_ITEM_STYLE = "margin:0 0 12px;";

function htmlParagraph(content: string): string {
  return `<p style="${PARAGRAPH_STYLE}">${content}</p>`;
}

function htmlList(items: string[]): string {
  const lis = items.map((item) => `<li style="${LIST_ITEM_STYLE}">${item}</li>`).join("");
  return `<ul style="${LIST_STYLE}">${lis}</ul>`;
}

/** Same shell as the other customer emails (see cold-storage.ts). */
function shellHtml(opts: {
  preheader: string;
  eyebrow: string;
  title: string;
  body: string;
  ctaText: string;
  ctaUrl: string;
  footerNote?: string;
}): string {
  const sans = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const mono = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
  const serif = "Georgia,'Times New Roman',serif";
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><title>${opts.title}</title></head>
  <body style="margin:0;padding:0;background:#f5f1e8;font-family:${sans};color:#1a1a1a;-webkit-font-smoothing:antialiased;">
    <span style="display:none !important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;">${opts.preheader}</span>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f1e8;">
      <tr><td align="center" style="padding:40px 16px;">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;background:#ffffff;border:1px solid #e7e2d6;border-radius:6px;">
          <tr><td style="padding:36px 36px 24px;">
            <p style="margin:0 0 18px;font-family:${mono};font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:#b3261e;font-weight:700;">${opts.eyebrow}</p>
            <h1 style="margin:0 0 20px;font-family:${serif};font-size:28px;line-height:1.15;font-weight:700;color:#1a1a1a;">${opts.title}</h1>
            ${opts.body}
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0 8px;">
              <tr><td style="background:#1a1a1a;border-radius:4px;">
                <a href="${opts.ctaUrl}" style="display:inline-block;padding:14px 26px;font-family:${mono};font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:#ffffff;text-decoration:none;font-weight:700;">${opts.ctaText} &rarr;</a>
              </td></tr>
            </table>
          </td></tr>
          ${opts.footerNote
            ? `<tr><td style="padding:0 36px 36px;border-top:1px solid #ece7da;">
                <div style="height:20px;line-height:20px;font-size:0;">&nbsp;</div>
                <p style="margin:0;font-size:14px;line-height:1.6;color:#666;">${opts.footerNote}</p>
              </td></tr>`
            : ""}
        </table>
        <p style="margin:18px 0 0;font-family:${mono};font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#9a9a9a;">hermesos.cloud</p>
      </td></tr>
    </table>
  </body>
</html>`;
}

function buildDay1Idle(params: LifecycleEmailContentParams): LifecycleEmailContent {
  const subject = "your agent is still waiting";
  const ctaUrl = LAUNCH_URL;
  const asks = [
    `"Watch Hacker News for anything about my industry and summarize the good posts each morning."`,
    `"Take this messy CSV and turn it into a clean summary table."`,
    `"Draft replies to these three emails, in my tone, shorter than I would."`,
  ];

  // Wave 1.2: if we captured what the user came to do, name it back to them.
  // Most day1_idle recipients have no instance (and so no goal), so this is the
  // exception path — the generic intro is the default.
  const goalPhrase = goalEmailPhrase(params.goal);
  const introText = goalPhrase
    ? `You signed up yesterday to ${goalPhrase}, but never deployed an agent to do it. Fair — most tools ask a lot before showing anything. This one takes about two minutes and the free plan covers it.`
    : "You signed up yesterday but never deployed an agent. Fair — most tools ask a lot before showing anything. This one takes about two minutes and the free plan covers it.";

  const text = [
    greeting(params.firstName),
    "",
    introText,
    "",
    "Three things people actually ask theirs:",
    "",
    ...asks.map((a) => `  • ${a}`),
    "",
    `Pick one and try it: ${ctaUrl}`,
    "",
    "Reply if something blocked you. I read every reply.",
    "",
    "— Ash",
    "Founder, Hivra",
  ].join("\n");
  const html = shellHtml({
    preheader: "Deploying takes about two minutes. Three things to ask it first.",
    eyebrow: "Day one",
    title: "Your agent is still waiting.",
    body: [
      htmlParagraph(greeting(params.firstName)),
      htmlParagraph(goalPhrase ? escapeHtml(introText) : introText),
      htmlParagraph("Three things people actually ask theirs:"),
      htmlList(asks),
    ].join("\n"),
    ctaText: "Deploy your agent",
    ctaUrl,
    footerNote: "Reply if something blocked you. I read every reply. — Ash, Founder, Hivra",
  });
  return { subject, text, html, ctaUrl };
}

function buildDay1Active(params: LifecycleEmailContentParams): LifecycleEmailContent {
  const agent = agentDisplayName(params.agentName);
  const subject = `${agent} made it through day one`;
  const ctaUrl = instanceUrl(params.instanceId);
  const capabilities = [
    `<strong>Web browsing.</strong> "Check my competitor's pricing page each morning and tell me when it changes." That needs live web access.`,
    `<strong>Persistent memory.</strong> Tell it once how you like reports formatted; it still knows next week.`,
    `<strong>Scheduled tasks.</strong> "Every Friday at 4pm, send me a summary of the week." It runs without you asking.`,
  ];
  const capabilitiesText = [
    `Web browsing. "Check my competitor's pricing page each morning and tell me when it changes." That needs live web access.`,
    `Persistent memory. Tell it once how you like reports formatted; it still knows next week.`,
    `Scheduled tasks. "Every Friday at 4pm, send me a summary of the week." It runs without you asking.`,
  ];
  const text = [
    greeting(params.firstName),
    "",
    `${agent} has been up for a day now. Good start.`,
    "",
    "Three things it can't do yet on the free plan:",
    "",
    ...capabilitiesText.map((c) => `  • ${c}`),
    "",
    "All three come with Pro. No rush — the free plan is yours as long as you want it.",
    "",
    `Keep going: ${ctaUrl}`,
    "",
    "— Ash",
    "Founder, Hivra",
  ].join("\n");
  const html = shellHtml({
    preheader: "Day one done. Three things your agent can't do yet.",
    eyebrow: "Day one",
    title: `${agent} made it through day one.`,
    body: [
      htmlParagraph(greeting(params.firstName)),
      htmlParagraph(`${agent} has been up for a day now. Good start.`),
      htmlParagraph("Three things it can't do yet on the free plan:"),
      htmlList(capabilities),
      htmlParagraph(
        "All three come with Pro. No rush — the free plan is yours as long as you want it."
      ),
    ].join("\n"),
    ctaText: "Open your agent",
    ctaUrl,
    footerNote: "Reply to this email if anything's unclear. I read every reply. — Ash, Founder, Hivra",
  });
  return { subject, text, html, ctaUrl };
}

/**
 * Goal-matched "standing order" examples for the day-3 use-case story
 * (CONVERSION_PLAN 1.6). Keyed by GoalId; the generic example is the fallback
 * for an absent/unknown goal. Each is a single quoted standing task the user
 * could paste verbatim, concrete to the job they signed up to do.
 */
const DAY3_GOAL_EXAMPLE: Record<string, string> = {
  build:
    `"Every morning, pull the new issues and failing CI runs on my repo, group them by what's actually broken, and give me a short triage list — what to fix first and why."`,
  research:
    `"Every morning, scan for new papers and posts on the topic I'm tracking, keep the three that actually move things, and give me a five-line brief on each — finding, why it matters."`,
  grow:
    `"Every morning, check my top competitor's site and pricing, flag anything that changed overnight, and tell me what it means for us in two lines."`,
  write:
    `"Every morning, turn yesterday's notes and saved links into one tidy draft I can edit — headline, three sections, no filler."`,
  automate:
    `"Every morning, look at the repetitive things I did yesterday, pick the one most worth automating, and hand me a step-by-step plan to do it."`,
  analyze:
    `"Every morning, pull the latest numbers from the sheet I share, flag anything that moved more than 10%, and explain in plain terms what's driving it."`,
  ops:
    `"Every morning, check the systems I run for errors or drift overnight, rank what needs attention, and give me a five-line status — what's healthy, what isn't."`,
  assist:
    `"Every morning, scan the news for my industry, pick the three items that actually matter, and give me a five-line briefing on each — what happened, why it matters."`,
};

const DAY3_GENERIC_EXAMPLE = DAY3_GOAL_EXAMPLE.assist;

function buildDay3Usecase(params: LifecycleEmailContentParams): LifecycleEmailContent {
  const subject = "give your agent a standing order";
  const ctaUrl = instanceUrl(params.instanceId);

  // Wave 1.2 / CONVERSION_PLAN 1.6: tell the use-case story matched to the goal
  // the user picked at launch. Falls back to the generic news-briefing example
  // when no goal was captured.
  const goalKey = params.goal?.trim();
  const goalPhrase = goalEmailPhrase(params.goal);
  const example =
    (goalKey && DAY3_GOAL_EXAMPLE[goalKey]) || DAY3_GENERIC_EXAMPLE;

  // If the user told us their first task at launch, acknowledge it as the bridge
  // into the standing-order idea. The task is free user text, so it's quoted
  // rather than spliced into the sentence grammar.
  const task = firstTaskPhrase(params.firstTask);
  const introText = task
    ? `You started your agent off with "${oneLine(task)}". Good first ask — but the people who get real value go one step further: they set up a standing task that runs without being asked.`
    : goalPhrase
      ? `You signed up to ${goalPhrase}. Most people then use their agent like a search box — ask, read, close the tab. The ones who get real value out of it set up a standing task instead.`
      : "Most people use their agent like a search box. Ask, read, close the tab. The ones who get real value out of it set up a standing task instead.";

  const text = [
    greeting(params.firstName),
    "",
    introText,
    "",
    "A worked example. Tell your agent:",
    "",
    `  ${example}`,
    "",
    "You write that once. From then on the briefing is just there every morning. That's the difference between a chatbot and an operator.",
    "",
    `Try it in chat: ${ctaUrl}`,
    "",
    "— Ash",
    "Founder, Hivra",
  ].join("\n");
  const html = shellHtml({
    preheader: "One standing task beats fifty one-off questions.",
    eyebrow: "Day three",
    title: "Give your agent a standing order.",
    body: [
      htmlParagraph(greeting(params.firstName)),
      htmlParagraph(task || goalPhrase ? escapeHtml(introText) : introText),
      htmlParagraph("A worked example. Tell your agent:"),
      htmlParagraph(`<em>${escapeHtml(example)}</em>`),
      htmlParagraph(
        "You write that once. From then on the briefing is just there every morning. That's the difference between a chatbot and an operator."
      ),
    ].join("\n"),
    ctaText: "Open the chat",
    ctaUrl,
    footerNote: "Reply to this email if anything's unclear. I read every reply. — Ash, Founder, Hivra",
  });
  return { subject, text, html, ctaUrl };
}

function buildDay7Offer(params: LifecycleEmailContentParams): LifecycleEmailContent {
  const subject = "the honest pitch for Pro";
  const ctaUrl = BILLING_URL;
  const changes = [
    `<strong>Always-on</strong> — your agent is never paused for inactivity (free agents sleep after 4 idle days).`,
    `<strong>2 vCPU / 4 GB RAM</strong> — double the headroom, noticeably faster under load.`,
    `<strong>Web browsing</strong> — your agent can read live pages, not just what it already knows.`,
    `<strong>Persistent memory</strong> — context carries across conversations instead of resetting.`,
    `<strong>Scheduled tasks</strong> — standing jobs that run on a timer, no prompt needed.`,
  ];
  const changesText = [
    "Always-on — your agent is never paused for inactivity (free agents sleep after 4 idle days).",
    "2 vCPU / 4 GB RAM — double the headroom, noticeably faster under load.",
    "Web browsing — your agent can read live pages, not just what it already knows.",
    "Persistent memory — context carries across conversations instead of resetting.",
    "Scheduled tasks — standing jobs that run on a timer, no prompt needed.",
  ];
  const text = [
    greeting(params.firstName),
    "",
    "You've had a week on the free plan. Here's the honest pitch for Pro — and if the agent hasn't been useful, skip this email.",
    "",
    "$9.99/mo, or $79/yr.",
    "",
    "What actually changes:",
    "",
    ...changesText.map((c) => `  • ${c}`),
    "",
    "That's the whole list. Cancel any time from the same page.",
    "",
    `Upgrade: ${ctaUrl}`,
    "",
    "— Ash",
    "Founder, Hivra",
  ].join("\n");
  const html = shellHtml({
    preheader: "$9.99/mo or $79/yr. Five things change. That's the list.",
    eyebrow: "Day seven",
    title: "The honest pitch for Pro.",
    body: [
      htmlParagraph(greeting(params.firstName)),
      htmlParagraph(
        "You've had a week on the free plan. Here's the honest pitch for Pro — and if the agent hasn't been useful, skip this email."
      ),
      htmlParagraph("<strong>$9.99/mo, or $79/yr.</strong> What actually changes:"),
      htmlList(changes),
      htmlParagraph("That's the whole list. Cancel any time from the same page."),
    ].join("\n"),
    ctaText: "See plans",
    ctaUrl,
    footerNote: "Reply to this email if anything's unclear. I read every reply. — Ash, Founder, Hivra",
  });
  return { subject, text, html, ctaUrl };
}

function buildStalled5d(params: LifecycleEmailContentParams): LifecycleEmailContent {
  const agent = agentDisplayName(params.agentName);
  const subject = `it's ${agent} — two things I could be doing`;
  const ctaUrl = instanceUrl(params.instanceId);
  const ideas = [
    `<strong>Watching something for you.</strong> A price, a competitor's page, a feed — I'll only speak up when something changes.`,
    `<strong>Clearing something tedious.</strong> A messy file, a folder of links, a draft you keep not starting.`,
  ];
  const ideasText = [
    "Watching something for you. A price, a competitor's page, a feed — I'll only speak up when something changes.",
    "Clearing something tedious. A messy file, a folder of links, a draft you keep not starting.",
  ];
  const footnote =
    "Your agent doesn't send its own mail yet — I wrote this on its behalf. Replies come to me. — Ash, Founder, Hivra";
  const text = [
    greeting(params.firstName),
    "",
    `It's ${agent}. You haven't said anything in a few days. I'm still here, running.`,
    "",
    "Two things I could be doing right now:",
    "",
    ...ideasText.map((i) => `  • ${i}`),
    "",
    "Pick one, or tell me something better.",
    "",
    ctaUrl,
    "",
    `— ${agent}`,
    "",
    `(${footnote})`,
  ].join("\n");
  const html = shellHtml({
    preheader: "Still running. Two things I could be doing right now.",
    eyebrow: "Still running",
    title: `It's ${agent}.`,
    body: [
      htmlParagraph(greeting(params.firstName)),
      htmlParagraph(
        `You haven't said anything in a few days. I'm still here, running. Two things I could be doing right now:`
      ),
      htmlList(ideas),
      htmlParagraph("Pick one, or tell me something better."),
      htmlParagraph(`— ${agent}`),
    ].join("\n"),
    ctaText: "Open the chat",
    ctaUrl,
    footerNote: footnote,
  });
  return { subject, text, html, ctaUrl };
}

function buildTrialDay5(params: LifecycleEmailContentParams): LifecycleEmailContent {
  const agent = agentDisplayName(params.agentName);
  const subject = "your Pro trial ends in two days";
  const ctaUrl = BILLING_URL;
  const keeps = [
    `<strong>Web browsing</strong> — ${agent} keeps reading live pages.`,
    `<strong>Persistent memory</strong> — context keeps carrying across conversations.`,
    `<strong>Scheduled tasks</strong> — standing jobs keep running on their timer.`,
  ];
  const keepsText = [
    `Web browsing — ${agent} keeps reading live pages.`,
    "Persistent memory — context keeps carrying across conversations.",
    "Scheduled tasks — standing jobs keep running on their timer.",
  ];
  const text = [
    greeting(params.firstName),
    "",
    "You're five days into the seven-day Pro trial. Two days left, so here's the honest version of what happens next.",
    "",
    "If you do nothing and your card is on file, Pro continues at $9.99/mo and everything keeps working:",
    "",
    ...keepsText.map((k) => `  • ${k}`),
    "",
    "If it hasn't been useful, cancel from the billing page before the trial ends and you won't be charged. No hard feelings.",
    "",
    `Billing page (keep it or cancel, same place): ${ctaUrl}`,
    "",
    "Reply if something didn't work the way you expected. I read every reply.",
    "",
    "— Ash",
    "Founder, Hivra",
  ].join("\n");
  const html = shellHtml({
    preheader: "Two days left. Keep it or cancel — same page, no tricks.",
    eyebrow: "Trial — day five",
    title: "Your Pro trial ends in two days.",
    body: [
      htmlParagraph(greeting(params.firstName)),
      htmlParagraph(
        "You're five days into the seven-day Pro trial. Two days left, so here's the honest version of what happens next."
      ),
      htmlParagraph(
        "If you do nothing and your card is on file, Pro continues at <strong>$9.99/mo</strong> and everything keeps working:"
      ),
      htmlList(keeps),
      htmlParagraph(
        "If it hasn't been useful, cancel from the billing page before the trial ends and you won't be charged. No hard feelings."
      ),
    ].join("\n"),
    ctaText: "Open billing",
    ctaUrl,
    footerNote:
      "Reply if something didn't work the way you expected. I read every reply. — Ash, Founder, Hivra",
  });
  return { subject, text, html, ctaUrl };
}

function formatCostUsd(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  // Sub-cent spend reads better with more precision; otherwise two decimals.
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

function pluralize(count: number, singular: string, plural?: string): string {
  return count === 1 ? singular : plural ?? `${singular}s`;
}

function buildActivityDigest(params: LifecycleEmailContentParams): LifecycleEmailContent {
  const agent = agentDisplayName(params.agentName);
  const ctaUrl = instanceUrl(params.instanceId);
  const digest = params.activityDigest ?? {
    sessionCount: 0,
    totalMessages: null,
    topModel: null,
    estimatedCostUsd: null,
    attentionLabels: [],
  };

  const subject = `What ${agent} did this week`;

  // Stat lines — only include the ones we actually have numbers for, so the
  // email never shows a hollow "0 messages / no model" digest.
  const sessionLine = `${digest.sessionCount} ${pluralize(digest.sessionCount, "session")} this week`;
  const stats: string[] = [sessionLine];
  if (typeof digest.totalMessages === "number" && digest.totalMessages > 0) {
    stats.push(`${digest.totalMessages} ${pluralize(digest.totalMessages, "message")} exchanged`);
  }
  if (digest.topModel) {
    stats.push(`Mostly on ${digest.topModel}`);
  }
  const cost = formatCostUsd(digest.estimatedCostUsd);
  if (cost) {
    stats.push(`About ${cost} in estimated compute`);
  }

  const attention = digest.attentionLabels.filter((l) => l.trim());
  const hasAttention = attention.length > 0;
  const attentionIntro =
    attention.length === 1
      ? "One thing is waiting on you:"
      : "A few things are waiting on you:";

  const text = [
    greeting(params.firstName),
    "",
    `Here's what ${agent} got up to over the last week.`,
    "",
    ...stats.map((s) => `  • ${s}`),
    ...(hasAttention
      ? ["", attentionIntro, "", ...attention.map((a) => `  • ${a}`)]
      : []),
    "",
    `Pick up where you left off: ${ctaUrl}`,
    "",
    "— Ash",
    "Founder, Hivra",
  ].join("\n");

  const bodyParts = [
    htmlParagraph(greeting(params.firstName)),
    htmlParagraph(`Here's what ${agent} got up to over the last week.`),
    htmlList(stats),
  ];
  if (hasAttention) {
    bodyParts.push(htmlParagraph(attentionIntro));
    bodyParts.push(htmlList(attention));
  }

  const html = shellHtml({
    preheader: `${sessionLine}. Here's the recap.`,
    eyebrow: "Weekly recap",
    title: `What ${agent} did this week.`,
    body: bodyParts.join("\n"),
    ctaText: "Open your agent",
    ctaUrl,
    footerNote: "Reply if you'd like a different cadence. I read every reply. — Ash, Founder, Hivra",
  });
  return { subject, text, html, ctaUrl };
}

const BUILDERS: Record<
  LifecycleEmailKey,
  (params: LifecycleEmailContentParams) => LifecycleEmailContent
> = {
  day1_idle: buildDay1Idle,
  day1_active: buildDay1Active,
  day3_usecase: buildDay3Usecase,
  day7_offer: buildDay7Offer,
  stalled_5d: buildStalled5d,
  trial_day5: buildTrialDay5,
  activity_digest: buildActivityDigest,
};

/** Exported for tests and previews; sendLifecycleEmail uses it internally. */
export function buildLifecycleEmail(
  key: LifecycleEmailKey,
  params: LifecycleEmailContentParams
): LifecycleEmailContent {
  return BUILDERS[key](params);
}

export async function sendLifecycleEmail(
  key: LifecycleEmailKey,
  params: LifecycleEmailSendParams
): Promise<LifecycleEmailSendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    log.warn("RESEND_API_KEY not configured; skipping lifecycle email", {
      source: LOG_SOURCE,
      to: params.email,
      emailKey: key,
    });
    return { sent: false, reason: "not_configured" };
  }
  const from = resolveFromEmail();
  const replyTo = resolveReplyToEmail();
  const content = buildLifecycleEmail(key, params);
  try {
    const resend = new Resend(apiKey);
    const { data, error } = await resend.emails.send(
      {
        from,
        to: params.email,
        replyTo,
        subject: content.subject,
        text: content.text,
        html: content.html,
        // List-Unsubscribe / one-click headers: lifecycle email is
        // marketing-adjacent, so give recipients (and Gmail/Apple Mail) a
        // real opt-out affordance. Improves deliverability reputation.
        headers: lifecycleUnsubscribeHeaders(),
      },
      { idempotencyKey: params.idempotencyKey }
    );
    if (error) {
      log.warn("lifecycle email Resend send failed", {
        source: LOG_SOURCE,
        to: params.email,
        emailKey: key,
        errorName: error.name,
        errorMessage: error.message,
      });
      return { sent: false, reason: "send_failed", errorMessage: error.message };
    }
    return { sent: true, messageId: data?.id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn("lifecycle email Resend threw", {
      source: LOG_SOURCE,
      to: params.email,
      emailKey: key,
      errorMessage: msg,
    });
    return { sent: false, reason: "send_failed", errorMessage: msg };
  }
}
