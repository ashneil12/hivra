import { BlogArticle } from "../types";
import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE, LARGER_PLAN_PRICE, LARGER_PLAN_SIZE, MONEY_BACK_GUARANTEE } from "../plan-facts";
import { CLI_RUN_LIFETIME } from "../runtime-facts";

export const article: BlogArticle = {
  slug: "claude-code-vs-codex-24-7",
  title: "Claude Code vs Codex for 24/7 autonomous work: which should you host?",
  metaTitle: "Claude Code vs Codex for 24/7 autonomous work",
  metaDescription:
    "Claude Code suits long multi-hour sessions and Codex suits many small headless tasks. Compared on compaction, resume, subscription cost and server needs.",
  publishedDate: "2026-07-15",
  lastModified: "2026-10-06",
  readingTimeMin: 10,
  author: "Hivra team",
  tagline: "The 20-minute benchmark tells you nothing about hour 9.",
  intro:
    "Plenty of Claude Code vs Codex comparisons test them as assistants you sit beside in a terminal. More and more people run them another way: on a server, around the clock, with nobody watching. Judge them like that and the picks change.",
  shortAnswer:
    "It depends on the work. Claude Code suits long multi-hour runs on one big codebase, because compaction and session resume keep a run going. Codex suits a steady stream of small, scoped tasks, and codex exec is a clean headless lane for them. Both sign in with a subscription, so spend is capped. Neither needs a big server.",
  sections: [
    {
      heading: "What changes when nobody is watching",
      paragraphs: [
        "The usual comparison hands both agents a bug, watches for twenty minutes and scores the diff. That's useful if your agent lives in your IDE and you sit next to it. A growing share of usage looks nothing like that, though. The agent runs on a machine that stays on, picks up tasks from a queue or a schedule, and you check in twice a day.\n\nAt that pace you're asking different questions:\n\n- What happens to a session at hour 6 instead of minute 20?\n- What does the context window look like after 400 tool calls, and what cleans it up?\n- What does a month of near-continuous use cost, and is there a cap?\n- Can the agent pick a session back up after a restart, or does a reboot wipe the work in progress?\n- How much babysitting does each one need when nobody's around?\n\nThe IDE comparisons don't score any of that. This one does.",
        `Both CLIs are good, and both are the vendors' own terminal programs. Hosting them doesn't change that. On [Hivra](/) you get the same official CLIs you'd install yourself. Hivra's chat runs them with [permission prompts bypassed by default](/blog/claude-code-dangerously-skip-permissions) inside each private VM, and the agent's Manage tab narrows that to Limited or Read-only. So the question here is simply which upstream tool holds up better on a machine that stays on.\n\nOne hosting fact shapes every long run below. ${CLI_RUN_LIFETIME}`,
      ],
    },
    {
      heading: "Long-running autonomy: compaction, resume, and session persistence",
      paragraphs: [
        "**Claude Code** was built for long sessions, and you can see it in four features:\n\n- **Auto-compaction.** When the context window fills, Claude Code summarizes older turns and keeps going, and `/compact` triggers it by hand. For an all-night task nothing else here matters as much, because every long-running agent outgrows its context window sooner or later.\n- **Session resume.** `claude --continue` picks up the most recent session and `claude --resume` lets you choose an older one. A VM reboot or a crashed terminal doesn't erase the work. You reattach to the conversation.\n- **CLAUDE.md and skills.** Project memory lives in files, so it survives restarts.\n- **Headless mode.** `claude -p \"prompt\"` runs a task non-interactively. That's what cron jobs and schedulers call.",
        "**Codex** has the same pieces, built with different priorities:\n\n- **`codex exec`** is the non-interactive mode, and it's well supported. For fire-and-forget batch work (run the tests, fix what broke, open a PR), we'd call `codex exec` the cleanest headless interface either vendor ships.\n- **Resume support** exists (`codex resume`), and AGENTS.md does the project-memory job that CLAUDE.md does for Claude Code.\n- **Sandboxing and approval modes** are more conservative by default. Codex is careful about touching things without a human saying yes. That's a good instinct on an unattended machine, but you'll spend more time up front setting the approval policy so a 3 a.m. run doesn't stall waiting for a yes.",
        "Our read: for one long continuous session that has to survive a full context window, Claude Code's compaction is more mature. For a stream of small, well-scoped headless tasks, Codex's `exec` mode fits well. Either way, expect both to need a restart or a fresh session somewhere in a long marathon, and expect them to fail in different ways when they do.",
      ],
    },
    {
      heading: "Subscription vs API cost at a 24/7 duty cycle",
      paragraphs: [
        "Running around the clock changes the cost math completely. At twenty minutes a day, API-key billing is pocket change. Around the clock, per-token billing has no ceiling, and a chatty agent stuck in a retry loop can burn real money overnight.\n\nBoth CLIs get around this the same way. You log in with the subscription you already pay for:\n\n- **Claude Code** signs in with your Anthropic account. A Claude Pro subscription runs $20/month on monthly billing, and the Max tiers start at $100/month for heavy usage. Usage is metered in rolling five-hour windows, so, as long as no API key is set in the environment and usage credits are off, the worst case for a runaway agent is hitting the window limit and waiting, with no surprise bill.\n- **Codex** signs in with your ChatGPT account. ChatGPT Plus is $20/month with Codex included, and Pro starts at $100/month (Pro 100, Pro 200 or Pro 500, per OpenAI's help article, as of October 2026). It works the same way, with a usage limit where you'd otherwise have an open meter. [Codex pricing by ChatGPT plan](/blog/codex-pricing-by-chatgpt-plan) has the plan-by-plan breakdown.\n\nFor autonomous work that cap is exactly what you want, because it turns \"what could this cost me?\" into a known number. If you're not sure which Claude plan a 24/7 workload needs, the [Claude Code plan calculator](/tools/claude-code-plan-calculator) estimates it from your expected hours and intensity. [Claude Code pricing: Pro vs Max](/blog/claude-max-vs-pro-for-claude-code) lays out the plan numbers Anthropic publishes.",
        `The server is a separate line on the bill. A DIY VPS adds $5-10/month per agent, plus your admin time. On Hivra, hosting is a flat plan fee (from ${ENTRY_PLAN_PRICE}/month for ${ENTRY_PLAN_SIZE}, see [pricing](/pricing)). On your own logins Hivra has no AI usage to mark up, because your Claude Code agent bills through your Anthropic login and your Codex agent through your ChatGPT login. [BYO API key explained](/blog/byo-api-key-explained) covers the whole BYO model.`,
      ],
    },
    {
      heading: "What each needs from its server",
      paragraphs: [
        `Neither agent is heavy. The model runs in the vendor's cloud, and the CLI on your machine handles orchestration, file edits and shell commands. Both install with one command and both run on a small VM, though Anthropic's system requirements list 4 GB of RAM for Claude Code. On Hivra, the ${ENTRY_PLAN_PRICE} plan's ${ENTRY_PLAN_SIZE} covers either CLI with its browser turned on.\n\nWhat actually changes the requirements:\n\n- **Your workload, not the CLI.** Compiling a Rust monorepo or running a big test suite needs CPU and RAM whichever agent kicks it off.\n- **Disk.** Repos, node_modules, build artifacts and logs pile up on any machine that runs for months. Size the disk for the project, since the agent itself takes little.\n- **Browser automation.** If the agent drives a real Chrome browser for web tasks, that's the biggest single jump in resources on the machine. Chrome is hungrier than either CLI.\n- **Headless auth.** On a DIY server, both login flows mean copying URLs or codes between the server and your laptop. It's a one-time chore per agent, and [the Claude Code 24/7 guide](/blog/keep-claude-code-running-24-7) and [the Codex cloud guide](/blog/run-codex-24-7-in-the-cloud) walk through it step by step.\n\nOn server needs it's close to a tie, so let the workload pick the agent. If you're still deciding where the server should live at all, the [AI agent hosting guide](/blog/ai-agent-hosting-guide) compares the four real options.`,
      ],
    },
    {
      heading: "Running both side by side on one plan",
      paragraphs: [
        `You don't have to pick one.\n\nOn Hivra, a plan's compute is a pool you split across your agents. The ${LARGER_PLAN_PRICE}/month plan's ${LARGER_PLAN_SIZE} fits a [Claude Code agent](/agents/claude-code) signed into your Anthropic account and a [Codex agent](/agents/codex) signed into your ChatGPT account, both with their browsers on. Each runs on its own private VM, with its own terminal, files, and chat in the browser.\n\nRunning both gets you a real bake-off. Give them the same task from your actual backlog and compare the PRs. A week of that beats every benchmark article, because it's scored on your own repo and conventions. Once you see where each is strong, split the queue: marathon refactors to one agent, batch fixes to the other. And when one subscription hits its usage limit mid-day, the other agent can take the next task, since two capped subscriptions give you two separate usage windows to draw on.\n\nIf you already pay for a Claude subscription and ChatGPT, running both agents 24/7 costs you one hosting plan on top.`,
      ],
    },
    {
      heading: "Verdict by workload type",
      paragraphs: [
        "There's no overall winner, but each workload has one:\n\n- **Long multi-hour tasks on one big codebase** (deep refactors, migrations, \"work through this 40-item checklist\"): **Claude Code.** Compaction plus session resume is what lets a run finish instead of starting over.\n- **High volume of small scoped tasks** (nightly test-fix runs, dependency bumps, triage): **Codex.** `codex exec` plus a scheduler makes a clean, predictable pipeline, which is what you want at 3 a.m.\n- **You already pay for Claude Pro or Max:** Claude Code. Your marginal AI cost is zero.\n- **You already pay for ChatGPT Plus or Pro:** Codex, for the same reason.\n- **One self-contained change to a GitHub repo, and Codex was your pick:** OpenAI's own Codex cloud, if your ChatGPT plan lists it. The [Codex cloud guide](/blog/run-codex-24-7-in-the-cloud) covers when a computer that stays on wins instead.\n- **Web-heavy tasks that need a real browser:** either CLI works. What decides it is a machine with browser automation, and that comes from the host (included with paid plans on Hivra), whichever CLI you run.\n- **You can't decide:** run both for a month on one plan and let your own backlog pick the winner.\n- **You want Cursor's IDE loop, not a terminal CLI:** that's a different question. [Cursor vs Claude Code](/blog/cursor-vs-claude-code) sorts it by job, and [Cursor Cloud Agents](/blog/cursor-cloud-agents) covers what Cursor does when you close the laptop.",
      ],
    },
    {
      heading: "Try the comparison on your own backlog",
      paragraphs: [
        `Launch a [Claude Code agent](/agents/claude-code) or a [Codex agent](/agents/codex) on Hivra, sign in with the subscription you already have, and hand it a real task from this week's list. Plans start at ${ENTRY_PLAN_PRICE}/month for ${ENTRY_PLAN_SIZE} (see [pricing](/pricing)), paid plans are not paused for inactivity, and they come with a ${MONEY_BACK_GUARANTEE}. Start the task inside tmux in the computer's Terminal tab (or, on Claude Code, send it through Telegram) and it keeps going after you close the laptop. [The plan calculator](/tools/claude-code-plan-calculator) tells you which Claude plan the workload needs. Hivra is independent and is not affiliated with Anthropic or OpenAI.`,
      ],
    },
  ],
  faqs: [
    {
      q: "Which is better for long-running tasks, Claude Code or Codex?",
      a: "For one long continuous session, Claude Code has the edge. Auto-compaction keeps the context window usable over hundreds of tool calls, and claude --continue resumes a session after a restart. For a high volume of short scoped tasks run headlessly, Codex's codex exec mode is the cleaner fit.",
    },
    {
      q: "Is it cheaper to run Claude Code or Codex 24/7?",
      a: "It's roughly a tie if you use subscription login. Claude Code bills through a Claude subscription (Pro at $20/month, Max tiers from $100/month) and Codex through a ChatGPT subscription (Plus at $20/month, Pro from $100/month). Both put a usage limit on your spend where an API key would leave an open meter. Per-token API billing is the expensive route at a 24/7 duty cycle for either agent.",
    },
    {
      q: "Can I run Claude Code and Codex on the same hosting plan?",
      a: `Yes, as long as both agents fit in the plan's compute pool. On Hivra, the ${LARGER_PLAN_PRICE}/month plan (${LARGER_PLAN_SIZE}) fits one Claude Code agent and one Codex agent with their browsers on, each on its own private VM with its own login.`,
    },
    {
      q: "Do I need API keys to host Claude Code or Codex?",
      a: "No. On Hivra, Claude Code signs in with your own Anthropic account and Codex with your own ChatGPT account, the same login flows the CLIs use on a laptop. The logins are stored on each agent's VM, and Hivra adds no markup when you sign in with your own accounts.",
    },
    {
      q: "What happens when a hosted agent hits its subscription usage limit mid-task?",
      a: "The run in progress stops with a usage-limit error. The computer, its files and the session history stay, so you resume the session once the window resets. That's one reason to run both agents: when one subscription hits its limit, the other agent can take the next task.",
    },
    {
      q: "Are the hosted versions of Claude Code and Codex modified?",
      a: "No. Hivra runs the official Anthropic Claude Code CLI and the official OpenAI Codex CLI on private VMs. Hivra's chat runs them with permission prompts bypassed by default, and the agent's Manage tab can narrow that to Limited or Read-only. The browser interface (chat, terminal, files, skills) is a convenience layer around the standard CLIs. Hivra is independent and is not affiliated with Anthropic or OpenAI.",
    },
  ],
  relatedArticles: [
    { slug: "codex-pricing-by-chatgpt-plan", title: "Codex pricing by ChatGPT plan: Plus, Pro 100/200/500 and API keys" },
    { slug: "cursor-vs-claude-code", title: "Cursor vs Claude Code: which keeps going when you walk away?" },
    { slug: "cursor-cloud-agents", title: "Cursor Cloud Agents: what they cost, and what happens when you close your laptop" },

    {
      slug: "ai-agent-browser-automation-tools",
      title: "AI agent browser automation in 2026: Browser Use, Stagehand, Playwright, and Puppeteer",
    },
    { slug: "ai-agent-hosting-guide", title: "AI agent hosting in 2026: every real option compared (VPS, serverless, managed)" },
    { slug: "keep-claude-code-running-24-7", title: "How to keep Claude Code running 24/7" },
    { slug: "run-codex-24-7-in-the-cloud", title: "Codex cloud, or Codex on a computer that stays on? Where to run it 24/7" },
    { slug: "byo-api-key-explained", title: "BYO API key: what it means and why it matters" },
    { slug: "cost-of-running-ai-agent", title: "How much does it cost to run an AI agent?" },
  ],
  relatedFeatures: [
    { slug: "browser-automation", title: "Browser automation" },
  ],
};
