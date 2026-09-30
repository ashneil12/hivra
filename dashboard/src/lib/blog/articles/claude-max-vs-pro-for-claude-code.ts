import { BlogArticle } from "../types";
import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE, LARGER_PLAN_PRICE, LARGER_PLAN_SIZE, MONEY_BACK_GUARANTEE } from "../plan-facts";
import { CLI_RUN_LIFETIME } from "../runtime-facts";
import {
  CLAUDE_PLAN_CHANGELOG,
  CLAUDE_PLAN_FACTS,
  breakEvenDays,
  formatDays,
  usd,
} from "../../tools/claude-plan-facts";

// Written 2026-09-30 for searches like "claude pro vs max", "claude max plan" and "claude code pricing". Every
// Anthropic figure below is read from lib/tools/claude-plan-facts.ts, the same module the plan calculator uses, and was
// read on Anthropic's own pages on 2026-09-30 (the links sit beside each claim). Nothing is stated that Anthropic does
// not publish: the post says what is not published, and labels anything computed as arithmetic on published numbers.
// Re-read the linked pages and update claude-plan-facts.ts, its test and this file together, never one alone.
//
// Facts left out on purpose: the community claim that Max 20x's weekly limit is about twice Pro's (no Anthropic page
// states a weekly multiple), any figure that rests only on a post on X or on news coverage, and the start date of the
// peak-hours limit reduction (Anthropic confirms it existed and removed it on 2026-05-06, nothing more).

const F = CLAUDE_PLAN_FACTS;
const S = F.sources;
const PRO = F.plans.pro;
const MAX5 = F.plans.max5x;
const MAX20 = F.plans.max20x;
const API = F.api;
const COST = F.anthropicCost;
const CHANGES = F.limitChanges;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-09-30" as "30 September 2026". */
function longDate(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

const READ_ON = longDate(F.lastVerified);
const DAY = usd(COST.perActiveDayUsd);
const P90_DAY = usd(COST.p90PerActiveDayUsd);

const proDays = formatDays(breakEvenDays(PRO.priceUsd, COST.perActiveDayUsd));
const max5Days = formatDays(breakEvenDays(MAX5.priceUsd, COST.perActiveDayUsd));
const max20Days = formatDays(breakEvenDays(MAX20.priceUsd, COST.perActiveDayUsd));
const proDaysP90 = formatDays(breakEvenDays(PRO.priceUsd, COST.p90PerActiveDayUsd));
const max5DaysP90 = formatDays(breakEvenDays(MAX5.priceUsd, COST.p90PerActiveDayUsd));
const max20DaysP90 = formatDays(breakEvenDays(MAX20.priceUsd, COST.p90PerActiveDayUsd));

// The worked example in the break-even section: ten active days a month at Anthropic's average day.
const EXAMPLE_DAYS = 10;
const exampleMonth = usd(EXAMPLE_DAYS * COST.perActiveDayUsd);

const link = (source: { label: string; url: string }, text: string = source.label) => `[${text}](${source.url})`;

/** Every ISO day inside a sentence as "30 September 2026", so the post reads one date format. */
const proseDates = (text: string): string => text.replace(/\d{4}-\d{2}-\d{2}/g, longDate);

// A list, not a table: each row is a sentence and a source, which a phone shows whole instead of in a scroll box.
const changelogList = CLAUDE_PLAN_CHANGELOG.map(
  (row) => `- **${longDate(row.date)}**: ${proseDates(row.text)} Source: [${row.source.label}](${row.source.url}).`,
).join("\n");

export const article: BlogArticle = {
  slug: "claude-max-vs-pro-for-claude-code",
  title: "Claude Code pricing: Pro vs Max, and when API billing is cheaper",
  metaTitle: "Claude Code Pricing: Pro vs Max and API costs",
  metaDescription: `Claude Code pricing: Pro ${usd(PRO.priceUsd)}, Max 5x ${usd(MAX5.priceUsd)}, Max 20x ${usd(MAX20.priceUsd)} a month. Which plan fits, when API billing is cheaper, and what to do at a limit.`,
  publishedDate: "2026-09-30",
  lastModified: "2026-09-30",
  readingTimeMin: 17,
  author: "Hivra team",
  tagline: `Start on Pro at ${usd(PRO.priceUsd)}. Move to Max only when Pro's limit stops you.`,
  intro: `Claude Code is included in Pro (${usd(PRO.priceUsd)} a month), Max 5x (${usd(MAX5.priceUsd)}) and Max 20x (${usd(MAX20.priceUsd)}), prices read ${READ_ON}. Anthropic states Max's extra usage only as a multiple of Pro's per five-hour session and does not currently publish message or token counts, so this page gives a rule for choosing, the break-even against API billing, what to do at a limit, and when Anthropic's own cloud is enough.`,
  shortAnswer: `Start on Pro (${usd(PRO.priceUsd)}). Move to Max 5x (${usd(MAX5.priceUsd)}) when Pro's five-hour limit stops you in most sessions, and to Max 20x (${usd(MAX20.priceUsd)}) only if Max 5x still does. Max adds usage per session, not a different Opus or Sonnet. At Anthropic's ${DAY} enterprise average day, API billing beats Pro only below ${proDays} active days a month.`,
  sections: [
    {
      heading: `Claude Code pricing by plan, read ${READ_ON}`,
      paragraphs: [
        `Claude Code is included in every paid Claude plan: Pro, Max, Team and Enterprise. Anthropic states the gap between plans as a multiple of Pro's usage per five-hour session, not as a count of messages or tokens. This is what ${link(S.pricing, "its pricing page")}, ${link(S.maxPlan, "the Max article")} and ${link(S.proPlan, "the Pro article")} say today.`,
        [
          `- **Pro:** ${usd(PRO.priceUsd)} a month, or ${usd(PRO.annualMonthlyUsd)} a month on the annual plan (${usd(PRO.annualUpfrontUsd)} billed up front). The baseline that the Max multiples are measured against.`,
          `- **Max 5x:** ${usd(MAX5.priceUsd)} a month, monthly only. ${MAX5.multiplier}x Pro's usage per five-hour session.`,
          `- **Max 20x:** ${usd(MAX20.priceUsd)} a month, monthly only. ${MAX20.multiplier}x Pro's usage per five-hour session.`,
          "- **Weekly limit:** all three have one. Anthropic does not publish the size of Pro's, or a weekly multiple for Max.",
          `- **${API.fable.label}:** usage credits only on Pro. Included on Max up to 50% of weekly limits.`,
          "- **Claude Code:** included in all three.",
        ].join("\n"),
        `Prices exclude tax, and Anthropic says prices and plans are subject to change at its discretion. The Max prices are for web subscriptions: mobile pricing may vary by app platform. Max also lists higher output limits, early access to advanced features and priority access at high traffic times. The pricing table shows priority access under Max only, while the Pro article lists it for Pro too, so read that row as "Max has it", not "Pro lacks it".`,
        `Team and Enterprise work differently. A Team seat is ${usd(F.team.standardMonthlyUsd)} a month (${usd(F.team.standardAnnualUsd)} a month on the annual plan) for Standard, with ${F.team.standardMultiplier}x Pro's per-session allowance, or ${usd(F.team.premiumMonthlyUsd)} (${usd(F.team.premiumAnnualUsd)} a month on the annual plan) for Premium, with ${F.team.premiumMultiplier}x, for ${F.team.minSeats} to ${F.team.maxSeats} members, and the limits are per member (${link(S.teamPlan, "Team plan article")}). A Premium seat is not a Max plan: it is bought as a seat on a Team plan with at least ${F.team.minSeats} members, and its ${F.team.premiumMultiplier}x sits between Max 5x and Max 20x. Enterprise is ${usd(F.enterpriseSeatUsd)} per seat a month billed annually plus usage at API rates, and Claude Code is included in the single seat on new and self-serve Enterprise plans (${link(S.claudeCodeTeam, "Claude Code for Team and Enterprise")}).`,
      ],
    },
    {
      heading: "Which plan fits which workload",
      paragraphs: [
        "Anthropic will not tell you how many hours Pro covers, so the choice rests on what you observe. Use this rule. It is ours, not Anthropic's.",
        [
          "- **Stay on Pro** if the five-hour limit rarely stops you and the weekly limit has never ended your week early.",
          "- **Move to Max 5x** if Pro's five-hour limit stops you in most working sessions. If Pro stops you two hours into a window, five times that is about ten hours, more than the whole five-hour window.",
          "- **Move to Max 20x** only if Max 5x still stops you inside a window. If Pro stopped you 30 minutes in, Max 5x covers about two and a half hours and Max 20x a full five-hour window.",
          "- **Treat the weekly limit as a separate wall.** Anthropic states the Max multiples per five-hour session only, and no Anthropic page states a weekly multiple. If Pro's weekly limit is what stops you, the published figures cannot tell you how much more week Max gives. Check `/usage` after your first full week.",
        ].join("\n"),
        `The hours above are arithmetic on Anthropic's published multiples, not a promise that usage scales in a straight line. Everything you do while signed in to your account draws on the same pool: chat on the web, desktop and mobile, and every Claude Code session you run at once (${link(S.pricing, "pricing FAQ")}).`,
        `Measure instead of guessing. \`/usage\` in Claude Code shows your plan usage bars and when they reset, and the Usage page in your Claude account settings shows the session limit and the weekly limits (${link(S.costs, "Claude Code docs")}, ${link(S.usageLimitTips, "help article")}). Mind the dates: Claude Code's weekly limits changed on ${longDate(CHANGES.weeklyChanged)}, when a 50% promotion ended and they settled at 25% above where they were before it, and Anthropic raised five-hour limits on ${longDate(CHANGES.fiveHourRaised)}. A reading of where Pro stops you from before those days is out of date. The [Claude Code plan calculator](/tools/claude-code-plan-calculator) applies this rule to your own hours and Pro reading, rates each plan, and says plainly when it cannot.`,
      ],
    },
    {
      heading: "What Anthropic does not publish",
      paragraphs: [
        `A lot of Claude plan advice online states numbers Anthropic does not currently publish. This is what no Anthropic page states, as of ${READ_ON}:`,
        [
          "- How many messages or tokens a five-hour window or a week holds on any plan. The pricing FAQ says there is no fixed message count.",
          `- Pro's own allowance. Only multiples of Pro are published: ${MAX5.multiplier}x and ${MAX20.multiplier}x for Max, and ${F.team.standardMultiplier}x and ${F.team.premiumMultiplier}x for Team seats.`,
          "- Any weekly multiple for Max 5x or Max 20x. The 5x and 20x are stated per five-hour session.",
          `- What any limit is in hours or tokens, including how big the ${longDate(CHANGES.fiveHourRaised)} five-hour increase was.`,
          "- What opens the five-hour window. Anthropic calls it a rolling window. That your first message opens it is widely reported, not documented.",
          "- How much faster Opus uses your quota than Sonnet. Anthropic says Opus uses meaningfully more quota and costs several times more per turn, and gives no figure for quota.",
          "- How \"up to 50% of weekly limits\" for Fable converts to tokens, or how long that rule will last.",
          "- Whether the paused credit for Agent SDK and `claude -p` usage will come back, or when.",
        ].join("\n"),
        "When a page gives you any of these as a fact, it is an estimate or a guess. Ours are labelled as estimates, with the assumption beside them.",
      ],
    },
    {
      heading: "API key or subscription: the break-even",
      paragraphs: [
        `Claude Code can bill two ways. A plan charges a flat price and enforces the limits above. An API key charges per token at list price, with no plan limits. Anthropic's own planning figures for API-billed Claude Code are about ${DAY} per developer per active day and ${usd(COST.perMonthLowUsd)} to ${usd(COST.perMonthHighUsd)} per developer per month across enterprise deployments, with costs below ${P90_DAY} per active day for 90% of users (${link(S.costs, "Claude Code docs")}). Those figures are API bills, so they say what the same work costs without a plan.`,
        "The break-even is one division:\n\n```text\nbreak-even active days a month = plan price / API cost per active day\n```",
        `Break-even days at Anthropic's ${DAY} enterprise average day, and at the ${P90_DAY} day that 90% of users stay below:`,
        [
          `| Plan | At ${DAY} a day | At ${P90_DAY} a day |`,
          "|---|---|---|",
          `| Pro (${usd(PRO.priceUsd)}) | ${proDays} days | ${proDaysP90} days |`,
          `| Max 5x (${usd(MAX5.priceUsd)}) | ${max5Days} days | ${max5DaysP90} days |`,
          `| Max 20x (${usd(MAX20.priceUsd)}) | ${max20Days} days | ${max20DaysP90} days |`,
        ].join("\n"),
        `Read it this way: if you use Claude Code on more active days a month than the number in the table, the plan costs less than the same tokens at API list price, as long as the plan's limits cover that usage. At Anthropic's enterprise average day, API billing beats Pro only below about ${proDays} active days a month, and beats Max 5x below about ${max5Days}. A worked example: ${EXAMPLE_DAYS} active days a month at ${DAY} a day is ${exampleMonth} on the API. That is more than Max 5x's ${usd(MAX5.priceUsd)} and far more than Pro's ${usd(PRO.priceUsd)}, so a plan that covers your sessions costs less than the API. It is less than Max 20x's ${usd(MAX20.priceUsd)}, so Max 20x would cost more than the API for the same ${EXAMPLE_DAYS} days.`,
        `Your day may cost more or less than the average. The cost figure in \`/usage\` is an estimate of what a session would cost at API list price, and Anthropic says it is not relevant to billing on Pro and Max, but it is a fair number to use as your API cost per active day. For your own hours and model mix, the [Claude Code plan calculator](/tools/claude-code-plan-calculator) prints an estimate, labelled as one, with its assumptions.`,
        `API list prices per million tokens, read on ${READ_ON} (${link(S.apiPricing, "Claude API pricing")}):`,
        [
          "| Model | Input | Output | Cache read | Cache write (5 minutes) |",
          "|---|---|---|---|---|",
          ...(["fable", "opus", "sonnet", "haiku"] as const).map((key) => {
            const m = API[key];
            return `| ${m.label} | ${usd(m.input)} | ${usd(m.output)} | ${usd(m.cacheRead)} | ${usd(m.cacheWrite5m)} |`;
          }),
        ].join("\n"),
        "Anthropic says Haiku 5.5 will join the Claude 5.5 family in the coming weeks, so recheck the Haiku row before you rely on it.",
        `Most of a Claude Code bill is cache reads, not fresh input. In Anthropic's own data from March to September 2026, Claude reads ${COST.inputToOutputRatio} input tokens for every output token, up from ${COST.inputToOutputRatioBefore}, and cache reads make up the majority of the cost of agentic coding work (${link(S.sessionsBlog, "Anthropic, 24 September 2026")}). On a plan the prompt cache lasts an hour. On an API key it lasts five minutes by default (${link(S.costs, "Claude Code docs")}).`,
        "One trap runs the other way. If `ANTHROPIC_API_KEY` is set in your environment, Claude Code uses it instead of your plan and bills API usage. Interactive sessions ask once whether to approve the key, and `claude -p` uses it whenever it is set. To go back to your plan:\n\n```bash\n# Is a key set? Prints \"set\" if so.\necho \"${ANTHROPIC_API_KEY:+set}\"\n\n# Remove it for this shell, then check inside Claude Code with /status\nunset ANTHROPIC_API_KEY\n```\n\nTo stop being offered API credits at a limit, sign in with only your plan credentials: `claude auth logout`, then `claude auth login`.",
        "For what API bills look like for agents that are not coding CLIs, see [The real cost of running a persistent AI agent in 2026](/blog/cost-of-running-ai-agent).",
      ],
    },
    {
      heading: "What happens when you hit a limit, and what to do",
      paragraphs: [
        `Claude Code names the limit and its reset time. These are the four messages in ${link(S.errors, "Anthropic's error reference")}:`,
        "```text\nYou've hit your session limit · resets 3:45pm\nYou've hit your weekly limit · resets Mon 12:00am\nYou've hit your Opus limit · resets 3:45pm\nYou've hit your Sonnet limit · resets 3:45pm\n```",
        "The session and weekly limits cover every model, so switching models does not help. The Opus and Sonnet limits cover only that model family, so `/model` to a model outside the family keeps you working, although the first request after a switch misses the prompt cache. A single burst of heavy activity can use up the weekly allowance before the session window resets.",
        [
          "1. **Find out which limit it is.** `/usage` shows your plan usage bars and when they reset, and `/rate-limit-options` opens the menu of choices. To estimate when a five-hour window closes, the [Claude Code limit reset calculator](/tools/claude-code-limit-reset-calculator) works from the time of your first prompt, which is how the window is widely reported to open.",
          `2. **Wait in the same session.** Claude Code 2.1.234 (${longDate("2026-08-17")}) and later waits in an open interactive session signed in with your plan and continues the task after a usage limit resets (${link(S.interactiveMode, "docs")}). If the computer slept through the reset for more than about 30 minutes, press Enter to continue. It does not start on its own when the reset is more than 24 hours away, which is often the case for a weekly limit, or in Remote Control sessions, but you can start a wait from \`/rate-limit-options\` and it keeps counting down. \`claude -p\` and background sessions do not get it.`,
          `3. **Use usage credits.** \`/usage-credits\` manages them. They are billed at standard API rates, separately from your plan, prepaid, with an optional monthly spend cap and auto-reload (${link(S.usageCredits, "Anthropic's article")}). Bundles are sold at 10%, 20% or 30% off: $50 of credits for $45, $250 for $200, and $1,000 for $700 (${link(S.usageBundles, "article dated 18 May 2026")}).`,
          `4. **Switch to a Claude Console account** for API-billed work during an intensive sprint (${link(S.claudeCodeProMax, "Anthropic's article")}).`,
          "5. **Move up a tier.** Pro to Max 5x, or Max 5x to Max 20x. On Max 20x, Anthropic's options are usage credits, a Console account or waiting.",
          `6. **Use a limit reset if you have one.** Anthropic occasionally offers a reset that puts the five-hour or weekly limit back to full, and gave subscribers a saveable one when Opus 5.5 launched on ${longDate(CHANGES.fiveHourRaised)}. Use it under Settings, then Usage, with "Reset for free" on Claude on the web or desktop. The button is not in Claude Code or on mobile, but the reset applies everywhere because limits are shared, and weekly limits still reset on their usual day (${link(S.limitReset, "Anthropic's article")}).`,
        ].join("\n"),
        "The wait ends if you exit Claude Code or hand the session to another surface, and it re-arms at most twice in a row.",
        `Agent SDK and \`claude -p\` usage: Anthropic announced a separate monthly credit for it, then paused that on ${longDate("2026-06-15")}. Its help article, dated 16 June 2026, says usage from the Agent SDK, \`claude -p\` and third-party apps still draws from your plan's limits, and that Anthropic will announce any change before it takes effect (${link(S.agentSdk, "Anthropic's article")}). We found nothing newer on ${READ_ON}, so recheck before you build on it.`,
      ],
    },
    {
      heading: "Model choice changes how fast the quota goes",
      paragraphs: [
        [
          `- **The default changed.** ${F.defaultModel.label} has been Claude Code's default on Pro, Max, Team and Enterprise since ${longDate(F.defaultModel.since)} (Claude Code 2.1.280). Before that, Pro and Team Standard defaulted to Sonnet (${link(S.modelConfig, "Claude Code docs")}).`,
          `- **The advice and the default point different ways.** Anthropic's own guide says Sonnet is the right choice for the large majority of coding work and that Opus uses meaningfully more of your quota (${link(S.modelGuide, "Anthropic's guide")}). The default is Opus, so switching is your lever: \`/model\` picks a model, and \`/model opusplan\` plans with Opus and executes with Sonnet.`,
          `- **Fable is never the default.** Max plans include Fable 5 and 5.1 up to 50% of their weekly limits, drawing the same pool faster. Pro uses usage credits for them (${link(S.fable, "Anthropic's article")}).`,
          "- **Thinking cannot be turned off** on Opus 5.5, Sonnet 5.5 or the Fable models, and thinking tokens bill as output. `/effort` lowers the effort, which is the cost lever.",
          `- **Fast mode** is a research preview that runs Opus 5.5 up to 2.5x faster at $8 input and $40 output per million tokens. On a plan it runs on usage credits only and does not count against your plan's limits (${link(S.fastMode, "docs")}).`,
        ].join("\n"),
      ],
    },
    {
      heading: "When Anthropic's own cloud is enough",
      paragraphs: [
        `Anthropic will run Claude Code in the cloud for you. A cloud session runs on Anthropic-managed machines, so it keeps going while your laptop is shut. It is available on Pro, Max and Team plans and to Enterprise users on premium or Chat + Claude Code seats, it shares your plan's limits, and Anthropic says there is no separate compute charge for the cloud machine (${link(S.cloudSessions, "Claude Code docs")}).`,
        "It fits when your work is tasks on GitHub repositories that can run unattended. Cloning a repository and opening pull requests need GitHub. A repository hosted elsewhere can be sent as a local bundle, but the results cannot be pushed back. By default you get Anthropic's environment, not a computer of your own.",
        `Remote Control is different. It lets you drive a session from your phone or browser, but the session runs on your own machine, which has to stay on with the \`claude\` process running. It reconnects after the machine sleeps, and it does not work with API keys (${link(S.remoteControl, "Claude Code docs")}).`,
        "When you sign in with your plan, every one of these options draws on the same plan limits. A cloud session, Remote Control, a VPS and a Hivra computer all spend your account's five-hour and weekly allowance, and none raises it. On an API key there is no plan allowance to raise. For the full comparison of ways to keep a run going with the lid shut, see [Will Claude Code keep running if I close my laptop?](/blog/keep-claude-code-running-24-7)",
      ],
    },
    {
      heading: "Running Claude Code off your laptop on Hivra",
      paragraphs: [
        "If you want a computer of your own that stays on, [Hivra](/) runs Claude Code on one, and you sign in with your own Anthropic account. That changes where the work runs, not what your plan allows: your five-hour and weekly limits follow your account, so a Hivra computer does not raise them.",
        `Hivra plans are ${ENTRY_PLAN_PRICE} a month for ${ENTRY_PLAN_SIZE}, or ${LARGER_PLAN_PRICE} a month for ${LARGER_PLAN_SIZE}, with a ${MONEY_BACK_GUARANTEE}. Hivra runs the official Claude Code CLI, and on your own Anthropic login it adds no markup on Claude usage: usage bills through Anthropic against your plan.`,
        CLI_RUN_LIFETIME,
        `Anthropic sets the terms for hosting Claude Code, and its legal page says the advertised usage limits for Pro and Max assume ordinary, individual usage of Claude Code and the Agent SDK. Read ${link(S.legal, "that page")} before you put a plan behind round-the-clock automation.`,
        "Hivra is not the better choice in every case. If your tasks live in GitHub repositories and can run unattended, Anthropic's cloud sessions have no separate compute charge and draw on your plan's limits. If you only need a run to keep going while the laptop stays open and plugged in, a keep-awake command is enough, and the [keep-awake command builder](/tools/keep-mac-awake) writes it. A computer of your own pays off when you want your files, sessions and login to stay in place between tasks.",
        "Start Claude Code from [the Claude Code agent page](/agents/claude-code). Hivra is independent and is not affiliated with Anthropic or OpenAI.",
      ],
    },
    {
      heading: "What changed and when: the Claude plan changelog",
      paragraphs: [
        `These are dated changes to Claude plans and Claude Code limits, each with the Anthropic page that states it. Last checked ${READ_ON}. Anthropic changes plans often, so open the linked page before you rely on a row. Changes that only news sites or posts on X reported are left out.`,
        changelogList,
      ],
    },
  ],
  faqs: [
    {
      q: "Is Claude Code included in Pro?",
      a: `Yes. Claude Code is included in Pro, Max, Team and Enterprise, and can also be billed to an API key instead of a plan. Pro is ${usd(PRO.priceUsd)} a month billed monthly, or ${usd(PRO.annualMonthlyUsd)} a month on the annual plan (${usd(PRO.annualUpfrontUsd)} billed up front). Pro does not include API usage through the Claude Console. Prices read on ${READ_ON} from Anthropic's pricing page.`,
    },
    {
      q: "What is the Claude Max plan?",
      a: `Max is Anthropic's higher-usage individual plan, in two sizes: Max 5x at ${usd(MAX5.priceUsd)} a month and Max 20x at ${usd(MAX20.priceUsd)} a month, billed monthly only. It gives five or twenty times Pro's usage per five-hour session, includes Claude Code, and includes the Fable models up to 50% of its weekly limits. Anthropic also lists higher output limits, early access to advanced features and priority access at high traffic times. Prices read on ${READ_ON}, before tax.`,
    },
    {
      q: "What are Claude Max limits?",
      a: `Anthropic states them as multiples of Pro's usage per five-hour session: Max 5x is five times and Max 20x twenty times. Both also have weekly limits, which apply across all models and reset at a fixed time assigned to your account. Anthropic publishes no weekly multiple, no message or token counts and no size for Pro's own allowance, so a weekly multiple or hour count you see elsewhere is not one Anthropic currently publishes.`,
    },
    {
      q: "What is the difference between Claude Pro and Max?",
      a: `Price, capacity and a few extras. Pro is ${usd(PRO.priceUsd)} a month, or ${usd(PRO.annualMonthlyUsd)} a month on the annual plan. Max 5x is ${usd(MAX5.priceUsd)} and Max 20x is ${usd(MAX20.priceUsd)}, both billed monthly only. The capacity gap is stated per five-hour session, at five and twenty times Pro's. Max also lists higher output limits, early access to advanced features and priority access at high traffic times, and includes Fable models up to 50% of its weekly limits, where Pro pays usage credits for them.`,
    },
    {
      q: "Is Max worth it for Claude Code?",
      a: `Only if Pro stops you. If Pro's five-hour limit stops you in most sessions, Max 5x at ${usd(MAX5.priceUsd)} a month gives five times the per-session allowance, and Max 20x at ${usd(MAX20.priceUsd)} gives twenty times. If Pro rarely stops you, Max is money you do not need to spend. Check /usage after your first full week to see how the weekly limit treats you.`,
    },
    {
      q: "Is Claude Pro enough for Claude Code?",
      a: `It is if Pro's limits cover your sessions, and Anthropic does not publish how many hours that is. Claude Code is included in Pro at ${usd(PRO.priceUsd)} a month, and Pro runs both Opus and Sonnet. ${F.defaultModel.label} has been the default on Pro since ${longDate(F.defaultModel.since)} and uses more quota than Sonnet, so if Pro stops you often, try /model to Sonnet before you pay for Max. /usage shows where you stand.`,
    },
    {
      q: "Does Claude Max work faster than Pro?",
      a: `Anthropic's pricing page does not list speed as a Max benefit. Pro and Max both run Opus and Sonnet. The extras it lists for Max are higher output limits, early access to advanced features and priority access at high traffic times, on top of more usage per session and Fable models up to 50% of weekly limits. Fast mode, a research preview that runs Opus 5.5 up to 2.5x faster, is billed through usage credits on Pro and Max alike and does not count against plan limits.`,
    },
    {
      q: "What happens when I hit the Claude Code limit?",
      a: `Claude Code stops and shows which limit you hit and when it resets, for example "You've hit your session limit · resets 3:45pm". You can wait, and recent versions continue the task in the open session after the reset. You can also turn on usage credits with /usage-credits to keep working at standard API rates, use a Claude Console account for API-billed work, or move up a plan. An Opus or Sonnet limit covers only that model family, so /model to another family keeps you working.`,
    },
    {
      q: "Is the API cheaper than a Claude subscription for Claude Code?",
      a: `Only for light use. Anthropic's docs put API-billed Claude Code at about ${DAY} per developer per active day across enterprise deployments, so a plan is cheaper, if its limits cover your sessions, once you use it on more than about ${proDays} active days a month for Pro, ${max5Days} for Max 5x or ${max20Days} for Max 20x. At the ${P90_DAY} day that 90% of users stay under, the figures are ${proDaysP90}, ${max5DaysP90} and ${max20DaysP90}. The formula is plan price divided by your API cost per active day.`,
    },
    {
      q: "Does Claude Code use my subscription or my API key?",
      a: "If ANTHROPIC_API_KEY is set in your environment, Claude Code uses the key instead of your plan and bills API usage. Interactive sessions ask you once to approve it, and claude -p uses it whenever it is set. Run unset ANTHROPIC_API_KEY and check /status to go back to your plan.",
    },
    {
      q: "Does running Claude Code on a server or on Hivra give me more usage?",
      a: `No. When you sign in with your plan, your limits follow your Anthropic account, not the machine, so Anthropic's cloud sessions, Remote Control, a VPS and a Hivra computer all draw on the same allowance. What a computer that stays on changes is whether the hours you pay for get used. ${CLI_RUN_LIFETIME} Hivra is independent and is not affiliated with Anthropic or OpenAI.`,
    },
  ],
  relatedArticles: [
    { slug: "keep-claude-code-running-24-7", title: "Will Claude Code keep running if you close your laptop? (And how to run it 24/7)" },
    { slug: "cost-of-running-ai-agent", title: "The real cost of running a persistent AI agent in 2026" },
    { slug: "claude-code-vs-codex-24-7", title: "Claude Code vs Codex for 24/7 autonomous work: which should you host?" },
    { slug: "byo-api-key-explained", title: "BYO API key: what it means and why it matters" },
    { slug: "control-claude-code-from-telegram", title: "How to control Claude Code from Telegram" },
  ],
};
