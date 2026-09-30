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
// in ONE const table inside each tool component, with a lastVerified date that
// the page renders. Every figure in this file was checked against the vendor's
// own page on 2026-09-24.
//
// Copy rules (CI-tested in __tests__/tool-catalog.test.ts): no em dashes or en
// dashes, no trial or card claims, no unmeasured speed claims, short sentences,
// real numbers, honest tradeoffs including when DIY wins.

import { CLI_RUN_LIFETIME } from "@/lib/blog/runtime-facts";
import { PUBLIC_START_HREF } from "@/lib/public-start";
import { KEEP_AWAKE_FACTS } from "./keep-awake";
import { TMUX_FACTS } from "./tmux-sheet";

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

export interface ToolEntry {
  slug: string;
  name: string;
  h1: string;
  subhead: string;
  /** Page title before the root " | Hivra" suffix. At most 55 characters. */
  metaTitle: string;
  /** 120 to 155 characters. */
  metaDescription: string;
  /** Two short paragraphs rendered above the tool. */
  longIntro: string[];
  /** At least 4 real questions from the keyword cluster. */
  faqs: ToolFaq[];
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
  metaDescription:
    "Free tools for people who run AI agents: keep-awake commands, a tmux cheat sheet, Claude plan and limit calculators, a survival check and hosting costs.",
  eyebrow: "Free. No signup.",
  intro:
    "Calculators, checks, command builders and a cheat sheet we built for our own decisions, published as they are. Every number states its assumptions, and the answers stay honest even when the answer is that you do not need us.",
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

export const TOOL_ENTRIES: ToolEntry[] = [
  {
    slug: "claude-code-plan-calculator",
    name: "Claude Code Plan Calculator",
    h1: "Claude Code plan calculator",
    subhead:
      "Enter how much you code with Claude and where Pro's limit stops you today. Get the cheapest plan that fits, and what the same usage would cost at API rates.",
    metaTitle: "Claude Code Plan Calculator: Pro vs Max",
    metaDescription:
      "Estimate your Claude Code usage and see which Anthropic plan fits: Pro at $20, Max 5x at $100, or Max 20x at $200 a month. With an API cost comparison.",
    longIntro: [
      "Anthropic sells Claude Code on three individual plans: Pro at $20 a month, Max 5x at $100, and Max 20x at $200. Max 5x gives five times Pro's usage per five-hour session and Max 20x gives twenty times. Anthropic does not publish fixed caps, so most people guess.",
      "This calculator works from what you already know. Set your days, hours and model mix, then tell it how far into a session Pro's limit usually stops you. You get a fit rating for each plan and what the same usage would cost at API rates. If Pro covers you, it says so.",
    ],
    faqs: [
      {
        q: "Is Claude Max worth it?",
        a: "Only if Pro's limits stop you. Max 5x gives five times Pro's usage per five-hour session and Max 20x gives twenty times. If you rarely see a session limit on Pro, Max is money you do not need to spend. If Pro stops you early in most sessions, the calculator above shows which multiple covers your day.",
      },
      {
        q: "What is the difference between Claude Pro and Max?",
        a: "Price and capacity. Pro is $20 a month billed monthly, or $17 a month on an annual plan. Max 5x is $100 a month and Max 20x is $200. Max 5x gives five times Pro's usage per five-hour session and Max 20x gives twenty times. All three include Claude Code, and Anthropic lists Opus and Sonnet on all three.",
      },
      {
        q: "What are the Claude Code usage limits?",
        a: "Two layers. A session limit on a rolling five-hour window, and weekly limits on top that reset at a fixed time each week assigned to your account. Claude Code shares both with Claude on the web, desktop and mobile. Anthropic does not publish fixed hour or message caps, so this calculator scales from where Pro stops you today instead of guessing a number.",
      },
      {
        q: "Is the API cheaper than a Claude subscription?",
        a: "For light use, yes. At API rates Sonnet 5 costs $2 per million input tokens and $10 per million output tokens. A few short sessions a week can land under $20 a month, and then the API or Pro is the right call. Heavy daily use adds up fast. Anthropic puts the average for enterprise Claude Code deployments at about $13 per developer per active day at API rates, and at that level a flat plan wins.",
      },
      {
        q: "What happens when I hit my Claude Code limit?",
        a: "Claude Code stops and shows the time the limit resets. You can wait, turn on usage credits to keep working at standard API rates, or move to a bigger plan. Recent versions can also wait in the open session and pick the task back up on their own after the reset.",
      },
      {
        q: "Do the plan limits apply if Claude Code runs in the cloud?",
        a: "Yes. The limits follow your Anthropic account, not the machine. Running Claude Code on an always-on computer does not raise your caps. It does mean a run you start inside tmux there keeps working after your laptop sleeps, so the hours you pay for produce finished work.",
      },
    ],
    relatedLinks: [
      { href: "/agents/claude-code", label: "Run Claude Code on Hivra" },
      { href: "/pricing", label: "Hivra pricing" },
    ],
    componentKey: "plan-calculator",
    primaryKeyword: "claude code plan calculator",
    vendors: ["Anthropic"],
  },
  {
    slug: "agent-survival-check",
    name: "Agent Survival Check",
    h1: "Will your agent survive the night?",
    subhead:
      "Answer a few questions about your setup. Find out whether Claude Code keeps working when you close the lid, and what to fix if it does not.",
    metaTitle: "Keep Claude Code Running 24/7: Agent Survival Check",
    metaDescription:
      "Answer a few questions about your setup and find out if Claude Code keeps running when you close your laptop. Covers sleep, SSH drops, tmux and reboots.",
    longIntro: [
      "Claude Code runs on your machine. Close the lid and the OS suspends it mid task. Nothing runs while the lid is shut, and a long tool call or network request often fails when the machine wakes. The same goes for Codex and most CLI agents.",
      "This check walks through your setup: where the agent runs, how the session stays alive, and what happens on sleep, network drops and reboots. It answers honestly. For some setups tmux on a VPS is enough, and the result says so.",
    ],
    faqs: [
      {
        q: "Why does Claude Code stop when I close my laptop?",
        a: "Sleep suspends every process on the machine, including your terminal and the agent inside it. On wake, network connections may have dropped and long running tool calls may have timed out. If the agent ran over SSH, the disconnect usually kills the remote session too unless it was inside tmux or screen.",
      },
      {
        q: "Does tmux keep Claude Code running?",
        a: "On an always-on machine, yes. tmux detaches the session from your terminal, so closing the SSH connection does not kill the agent. It does nothing for a laptop that goes to sleep, because the whole machine suspends, tmux included.",
      },
      {
        q: "Can I just stop my laptop from sleeping?",
        a: "Partly. On macOS, caffeinate blocks sleep while it runs, full system sleep only on AC power, and closing a MacBook lid still sleeps it unless you set up closed-display mode with an external display. On Linux you can tell logind to ignore the lid. You pay in battery, heat, and a machine you cannot close or carry. Reboots, updates and network changes still kill the run.",
      },
      {
        q: "How do I keep an AI agent running overnight?",
        a: "Run it on a machine that stays on. Three ways: a desktop that stays on, a VPS with tmux, or a managed computer. Hivra runs Claude Code on a cloud computer with your own Anthropic sign-in. The $9.99 a month plan gives it 2 vCPU and 4 GB, and paid plans are not paused for inactivity. Start the run inside tmux in the computer's Terminal tab, or send it from Telegram, and it keeps going with your laptop closed.",
      },
      {
        q: "Is a VPS with tmux enough?",
        a: "Often yes. A $5 VPS plus tmux keeps the process alive around the clock. You handle the install, the updates, and the restart when something crashes, and checking in from a phone means SSH. Managed hosting is the same idea with the ops handled, plus a chat and a web terminal in the browser.",
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
    h1: "AI agent hosting cost calculator",
    subhead:
      "Compare what running an agent 24/7 really costs on a VPS you manage and on a managed computer. Your time is part of the bill.",
    metaTitle: "AI Agent Hosting Cost Calculator: VPS vs Managed",
    metaDescription:
      "Work out what running an AI agent 24/7 really costs on a VPS you manage versus a managed computer. Counts your time, not just the server bill.",
    longIntro: [
      "Running an AI agent 24/7 needs a computer that stays on. The usual options: a VPS you rent and manage, hardware you already own, or a managed agent computer. Each has a real monthly cost, and the server bill is only part of it.",
      "This calculator compares one VPS you run yourself with one managed computer: the server bill, setup time, and the maintenance hours priced at your own rate, plus DIY backups if you tick them. Hivra's price does not include backups, so they start off. Model usage is separate on both, billed through your own Claude or ChatGPT login or API key. DIY genuinely wins in some cases. The numbers show where.",
    ],
    faqs: [
      {
        q: "How much does it cost to run an AI agent 24/7?",
        a: "A small VPS lists at about $5 to $12 a month before tax. Hardware you already own costs mostly electricity, roughly $1 to $10 a month depending on the machine. A managed computer on Hivra is $9.99 a month for 2 vCPU and 4 GB. Model usage bills separately through your own account on all three.",
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
        a: "Hetzner's CX23 has the same 2 vCPU and 4 GB and lists at $6.49 a month in Germany and Finland, plus $0.60 for its IPv4 address, before tax. DigitalOcean and Vultr list 2 vCPU and 4 GB at $24 and $20 a month. Hivra is $9.99 a month and installs and runs the agent for you.",
      },
      {
        q: "Does managed hosting include the model costs?",
        a: "No. On Hivra you sign in with your own Claude or ChatGPT account, or paste your own API key. Hivra charges for the computer: $9.99 a month for 2 vCPU and 4 GB, or $19.99 a month for 4 vCPU and 8 GB.",
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
    h1: "When does your Claude Code limit reset?",
    subhead:
      "Enter the time you sent the first prompt of this session. See the minute the five-hour window should close, and why the weekly limit is a different clock.",
    metaTitle: "When Does Claude Code Usage Limit Reset? Calculator",
    metaDescription:
      "Enter your first prompt time and see when your Claude Code five-hour window reopens. Plus why waiting five hours never clears the weekly limit.",
    longIntro: [
      "Claude Code stops with a usage limit message, and the reset time moves around from day to day. The reason is that the five-hour session window is rolling. It follows your own usage, not the top of the hour and not midnight.",
      "Give this calculator the time of your first prompt and it does the arithmetic. It also separates the two limits people confuse. The five-hour window and the weekly limit are different clocks, and waiting out one does nothing for the other.",
    ],
    faqs: [
      {
        q: "When does the Claude Code usage limit reset?",
        a: "Five hours after your session started, not on a fixed clock hour. Anthropic describes a rolling five-hour session window and does not document what opens it. The widely reported behavior, and the one this calculator assumes, is that your first message opens it: send it at 10:20 and the window closes at 15:20. Claude Code's limit message and the /usage command show the exact reset time.",
      },
      {
        q: "Why does my Claude Code limit reset at a different time each day?",
        a: "Because the window follows your own usage rather than a shared schedule. On the first message model, a 9am start resets at 2pm and a 1pm start resets at 6pm. There is no fixed daily reset time, which is why a calculator is easier than guessing.",
      },
      {
        q: "I waited 5 hours and I am still limited. What happened?",
        a: "You probably hit a weekly limit rather than the session limit. Weekly limits sit on top of the five-hour window and reset at a fixed time each week assigned to your account, so waiting out a session does not restore them. It can also be a model limit, such as the Opus limit, and then switching models with /model keeps you working. Claude Code's message names the limit you hit.",
      },
      {
        q: "Does using Claude on the web use up my Claude Code limit?",
        a: "Yes. Claude on the web, desktop and mobile and Claude Code all draw from the same pool. A heavy chat session in the browser leaves less for Claude Code inside the same window.",
      },
      {
        q: "Does running Claude Code on a server give me more usage?",
        a: "No. The limits follow your Anthropic account, not the machine, so a cloud computer gets exactly the same quota as your laptop. What changes is whether the window gets used. Claude Code can pick a task back up on its own after a reset, but only while the session stays open. If your laptop sleeps through the reset for more than about 30 minutes, it waits for you to press Enter.",
      },
      {
        q: "How do I see how much quota I have left?",
        a: "Run /usage inside Claude Code, or open Settings, then Usage, on your Claude account. Both show what is left in the current session and against the weekly limit, with reset times. Anthropic does not publish exact prompt or token caps per plan, so those readouts are more reliable than any published number.",
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
    h1: "Caffeinate on Mac: keep it awake while an agent runs",
    subhead:
      "Pick macOS or Linux, how long, power and lid. Get the exact command, how to check it works, and a plain list of what it will not cover.",
    metaTitle: "Caffeinate Mac: Keep Your Mac Awake, Command Builder",
    metaDescription:
      "Build the exact caffeinate command to keep a Mac awake while Claude Code or Codex runs, with the Linux version and a list of what it cannot cover.",
    longIntro: [
      "caffeinate is the command macOS ships to stop the Mac sleeping while a job runs. The -i flag stops idle sleep, -s stops system sleep but only on AC power, and -t sets a timeout in seconds. Apple documents closed-lid use only with an external display, power connected and an external keyboard and mouse or trackpad, and caffeinate's manual makes no promise about the lid.",
      "Answer four questions and the builder prints the exact command for macOS or Linux, how to check it is working, and a plain list of what it will not cover. The command you type stays in your browser.",
    ],
    faqs: [
      {
        q: "How do I use caffeinate on Mac?",
        a: "Open Terminal and run caffeinate -i to stop idle sleep until you press Ctrl-C. To keep the Mac awake only while a command runs, put caffeinate in front of it, for example caffeinate -is claude. The -s flag adds system sleep prevention and only works on AC power. The -t flag sets a timeout in seconds, but caffeinate ignores it when it wraps a command.",
      },
      {
        q: "What is the difference between caffeinate -i and -s?",
        a: "-i creates an assertion that stops the system from idle sleeping. -s creates one that stops the system from sleeping, and Apple's manual says it is valid only while the Mac runs on AC power. On battery, -i is the one that applies.",
      },
      {
        q: "How do I keep my Mac awake with the lid closed?",
        a: "caffeinate does not promise that. Apple documents using a MacBook with the lid closed when an external display is connected, with power connected and an external keyboard and mouse or trackpad. Without those, plan on the lid sleeping the Mac. If a run has to outlast a closed laptop, run it on a machine that stays on instead.",
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
        a: "Partly. -i works on battery and stops idle sleep, and the battery keeps draining. -s only applies on AC power, so the builder leaves it out when you say you are on battery.",
      },
      {
        q: "How do I keep a Linux laptop awake when I close the lid?",
        a: "Run the command under systemd-inhibit --what=sleep:handle-lid-switch. The lock lasts while the command runs. For a permanent change, set HandleLidSwitch=ignore in logind.conf. Some desktops handle the lid themselves, so test with the lid closed for a minute.",
      },
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
          text: "On a Mac the builder uses caffeinate, which comes with macOS. The -i flag creates an assertion that stops idle sleep. The -s flag creates one that stops system sleep, and the manual says it is valid only while the Mac runs on AC power, so the builder adds it only when you say you are plugged in.",
          sources: [KEEP_AWAKE_FACTS.sources.caffeinate],
        },
        {
          text: "When caffeinate wraps a command, it holds its assertions for as long as the command runs. The manual says the -t timeout is not used in that form, so for a fixed number of hours the builder gives you a separate caffeinate -t command for its own terminal tab, with the hours converted to seconds.",
          sources: [KEEP_AWAKE_FACTS.sources.caffeinate],
        },
        {
          text: "The manual does not promise that caffeinate keeps a closed MacBook awake. Apple documents using a MacBook with the lid closed when an external display is connected, with power connected and an external keyboard and mouse or trackpad. So the builder treats a closed lid as something caffeinate alone does not cover.",
          sources: [KEEP_AWAKE_FACTS.sources.appleLidClosed, KEEP_AWAKE_FACTS.sources.appleDisplayGuide],
        },
        {
          text: "pmset is the check and the persistent option. pmset -g assertions lists the assertions caffeinate takes. pmset -g custom shows your current settings, and setting sleep to 0 turns the system sleep timer off until you change it back. That is a saved setting, not a closed-lid fix.",
          sources: [KEEP_AWAKE_FACTS.sources.pmset],
        },
        {
          text: "On Linux the builder uses systemd-inhibit. Its --what option takes a colon-separated list that includes sleep, which blocks suspend and hibernate, and handle-lid-switch, which blocks the lid switch handling. The lock is held while the command it runs is alive, and --list shows the locks that are active. The builder adds handle-lid-switch only when you say the lid will be closed. For a permanent change, the HandleLidSwitch setting in logind.conf controls what a closed lid does.",
          sources: [KEEP_AWAKE_FACTS.sources.systemdInhibit, KEEP_AWAKE_FACTS.sources.logindConf],
        },
        {
          text: "How this was tested: the builder only prints commands and runs nothing on your machine. The caffeinate timeout and the assertion names were checked by running caffeinate -is -t on a MacBook on AC power with macOS 26.6.2 on 2026-09-30, and reading the assertions back with pmset -g assertions. The Linux commands were built from the manual and were not run for this page.",
        },
      ],
    },
    examples: [
      {
        title: "Claude Code on a plugged-in MacBook, lid open",
        inputs: "macOS, until the command exits, plugged in, lid open, claude",
        command: "caffeinate -is claude",
        result:
          "Idle sleep and system sleep are both held off while claude runs and the Mac is on power. The lid has to stay open: shutting it would put the Mac to sleep.",
      },
      {
        title: "An 8 hour Codex run on battery",
        inputs: "macOS, for 8 hours, on battery, lid open, codex",
        command: "caffeinate -i -t 28800",
        result:
          "Idle sleep is held off for 28,800 seconds by a caffeinate running in one terminal tab, and Codex starts in another. -s is left out because it needs AC power, and the battery keeps draining.",
      },
      {
        title: "A Linux laptop with the lid closed",
        inputs: "Linux, until the command exits, plugged in, lid closed, claude",
        command: 'systemd-inhibit --what=sleep:handle-lid-switch --why="agent run" claude',
        result:
          "Suspend and the lid-close action are blocked while claude runs. If your desktop handles the lid itself, test with the lid closed for a minute before you rely on it.",
      },
    ],
  },
  {
    slug: "tmux-cheat-sheet",
    name: "tmux Cheat Sheet for AI Coding Agents",
    h1: "tmux cheat sheet",
    subhead:
      "Sessions, windows, panes, detach and attach, copy mode and logging, plus the few commands that keep an AI coding agent in a session you can leave and come back to.",
    metaTitle: "tmux Cheat Sheet: Commands and Keys for AI Agents",
    metaDescription:
      "A tmux cheat sheet with copy buttons: sessions, windows, panes, detach and attach, copy mode and logging, plus commands for AI coding agents.",
    longIntro: [
      "tmux is a terminal multiplexer. It runs your shells inside sessions that keep going when your terminal closes or your SSH connection drops. You attach to a session to look at it and detach to leave it running.",
      "Every command below has a copy button and was checked against the tmux manual on 2026-09-30. The last section is for AI coding agents: one named session per agent, re-attaching from another device and keeping a log. tmux survives disconnects. It does not survive a sleeping laptop.",
    ],
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
        a: "Start a session with tmux new -s claude, run claude inside it, and press Ctrl-b then d to detach. Claude Code keeps running in the session until the machine sleeps, restarts or you kill the session. Reattach with tmux attach -t claude.",
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
    relatedLinks: [
      { href: "/tools/keep-mac-awake", label: "Keep a Mac awake with caffeinate" },
      { href: "/tools/agent-survival-check", label: "Check if your setup survives a closed laptop" },
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
          text: "Commands that act on a pane end the target with a colon, as in claude:. The manual says a target that is not fully qualified is a best guess and that scripts should qualify it. NAME: means that session's current window and active pane.",
          sources: [TMUX_FACTS.sources.manual],
        },
        {
          text: "The logging commands use pipe-pane. It sends a pane's output to a command from the moment it runs and does not include earlier output. The -o flag opens a pipe only if none is open, and closes an open one, and pipe-pane with no command closes the current pipe.",
          sources: [TMUX_FACTS.sources.manual],
        },
        {
          text: "tmux keeps its sessions in a server process on the machine it runs on. A disconnect leaves that server running. A machine that sleeps or powers off stops it. That is why the sheet says tmux survives disconnects and not a sleeping laptop.",
        },
        {
          text: "How this was checked: the commands were read from the manual and were not run on every tmux version. If a command is refused, check tmux -V and the manual for your version.",
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
          "Logging starts before the agent does, so the file holds the whole run. It is raw terminal output and includes anything the pane shows, so keep it private.",
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
