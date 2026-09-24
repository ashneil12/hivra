import { BlogArticle } from "../types";
import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE, LARGER_PLAN_PRICE, LARGER_PLAN_SIZE, MONEY_BACK_GUARANTEE } from "../plan-facts";
import { CLI_RUN_LIFETIME } from "../runtime-facts";

export const article: BlogArticle = {
  slug: "claude-code-vs-codex-24-7",
  title: "Claude Code vs Codex for 24/7 autonomous work: which should you host?",
  metaTitle: "Claude Code vs Codex for 24/7 autonomous work",
  metaDescription:
    "Claude Code vs Codex as hosted always-on agents, not IDE sidekicks: session persistence, compaction, subscription vs API cost, and server needs.",
  publishedDate: "2026-07-15",
  lastModified: "2026-09-24",
  readingTimeMin: 10,
  author: "Hivra team",
  tagline: "The 20-minute benchmark tells you nothing about hour 9.",
  intro:
    "Plenty of articles compare Claude Code and Codex as coding assistants you babysit in a terminal. Almost none compare them the way people increasingly run them: on a server, around the clock, working while you sleep. That comparison has different winners.",
  sections: [
    {
      heading: "The comparison everyone writes vs the one that matters",
      paragraphs: [
        "The standard Claude Code vs Codex article gives both agents a bug, watches for twenty minutes, and scores the diff. Useful if your agent lives in your IDE and you sit next to it. But a growing share of usage looks nothing like that. The agent runs on a machine that stays on, picks up tasks from a queue or a schedule, and you check in twice a day.\n\nAt that duty cycle the questions change:\n\n- What happens to a session at hour 6, not minute 20?\n- What does the context window do after 400 tool calls, and who cleans it up?\n- What does a month of near-continuous usage cost, and is that cost capped?\n- Can the agent recover a session after a restart, or does a reboot erase the work in progress?\n- How much babysitting does each one demand when nobody is watching?\n\nNobody scores those in the IDE comparisons. This article does.",
        `One framing note before the details: both CLIs are excellent, both ship from their vendors as official terminal programs, and hosting does not change what they are. On [Hivra](/) they are the same official CLIs you would install yourself; Hivra's chat runs them with permission prompts bypassed by default inside each private VM, and the agent's Manage tab narrows that to Limited or Read-only. So this is not a hosted-flavor comparison. It is the honest question of which upstream tool holds up better on a machine that stays on.\n\nOne hosting fact shapes every long run below. ${CLI_RUN_LIFETIME}`,
      ],
    },
    {
      heading: "Long-running autonomy: compaction, resume, and session persistence",
      paragraphs: [
        "**Claude Code** was built with long sessions in mind and it shows in the plumbing:\n\n- **Auto-compaction.** When the context window fills, Claude Code summarizes older turns and keeps going. You can also trigger it manually with `/compact`. For a task that runs all night, this is the single most important feature, because every long-running agent eventually outgrows its context window.\n- **Session resume.** `claude --continue` picks up the most recent session and `claude --resume` lets you choose an older one. A VM reboot or a crashed terminal does not erase the work; you reattach to the conversation.\n- **CLAUDE.md and skills.** Project memory lives in files, not in the session, so knowledge survives restarts by design.\n- **Headless mode.** `claude -p \"prompt\"` runs a task non-interactively, which is what cron jobs and schedulers actually call.",
        "**Codex** has grown the same organs, with different accents:\n\n- **`codex exec`** is the non-interactive lane, and it is a first-class citizen. For fire-and-forget batch work (run the tests, fix what broke, open a PR), `codex exec` is arguably the cleanest headless interface either vendor ships.\n- **Resume support** exists (`codex resume`), and AGENTS.md plays the project-memory role that CLAUDE.md plays on the other side.\n- **Sandboxing and approval modes** are more conservative by default. Codex is cautious about what it touches without a human confirming. Good instinct for an unattended machine, but it means you spend more time up front configuring approval policy so a 3 a.m. run does not stall waiting for a yes.",
        "The honest read: for one long continuous session that has to survive context exhaustion, Claude Code's compaction story is more mature. For a stream of small, well-scoped tasks executed headlessly, Codex's `exec` mode is a beautiful fit. Neither tool falls over at hour 9; they just fail differently when they fail, and Claude Code degrades more gracefully mid-marathon.",
      ],
    },
    {
      heading: "Subscription vs API cost at a 24/7 duty cycle",
      paragraphs: [
        "This is where the always-on framing changes the math completely. At twenty minutes a day, API-key billing is pocket change. At a 24/7 duty cycle, per-token API billing is an uncapped liability: a chatty agent in a retry loop can burn through real money overnight.\n\nBoth CLIs solve this the same way: log in with the subscription you already pay for.\n\n- **Claude Code** signs in with your Anthropic account. A Claude Pro subscription runs $20/month on monthly billing, and the Max tiers start at $100/month for heavy usage. Usage is metered in rolling five-hour windows, so the worst case for a runaway agent is hitting the window limit and waiting, not a surprise bill.\n- **Codex** signs in with your ChatGPT account. ChatGPT Plus is $20/month with Codex included, and Pro starts at $100/month with 5x or 20x the Plus limits. Same shape: a usage limit rather than an open meter.\n\nFor autonomous work this cap is not a limitation, it is the feature. A capped subscription turns \"what could this cost me\" into a known number. Not sure which Claude plan a 24/7 workload actually needs? The [Claude Code plan calculator](/tools/claude-code-plan-calculator) does that estimate from your expected hours and intensity.",
        `Where does the server itself fit in the bill? A DIY VPS adds $5-10/month per agent plus your admin time. On Hivra, hosting is a flat plan fee (from ${ENTRY_PLAN_PRICE}/month, see [pricing](/pricing)) and there is zero markup on AI usage, because there is no AI usage to mark up: your Claude Code agent bills through your Anthropic login and your Codex agent bills through your ChatGPT login. The full BYO model is covered in [BYO API key explained](/blog/byo-api-key-explained).`,
      ],
    },
    {
      heading: "What each needs from its server",
      paragraphs: [
        `The good news: neither agent is heavy. The model runs in the vendor's cloud; the CLI on your machine is doing orchestration, file edits, and shell commands. Both install with a single command and both run on a small VM, though Anthropic's system requirements list 4 GB of RAM for Claude Code. On Hivra, the ${ENTRY_PLAN_PRICE} plan's ${ENTRY_PLAN_SIZE} covers either CLI with its browser turned on.\n\nWhat actually moves the requirements:\n\n- **Your workload, not the CLI.** Compiling a Rust monorepo or running a fat test suite needs CPU and RAM regardless of which agent triggers it.\n- **Disk.** Repos, node_modules, build artifacts, and logs accumulate on any long-lived machine. Budget for the project, not the agent.\n- **Browser automation.** If the agent drives a real Chrome browser for web tasks, that is the biggest single resource jump on the machine. Chrome is hungrier than either CLI.\n- **Headless auth.** On a DIY server, both login flows involve shuttling URLs or codes between the server and your laptop. Budget the friction once per agent. The setup mechanics are covered step by step in [the Claude Code 24/7 guide](/blog/keep-claude-code-running-24-7) and [the Codex cloud guide](/blog/run-codex-24-7-in-the-cloud).\n\nServer requirements are close to a tie, and that is the point: infrastructure should not drive this decision. If you are still choosing where that server should live at all, the [AI agent hosting guide](/blog/ai-agent-hosting-guide) compares the four real options.`,
      ],
    },
    {
      heading: "Running both side by side on one plan",
      paragraphs: [
        `Here is the option the versus articles never mention: you do not have to choose.\n\nOn Hivra, a plan's compute is a pool you split across your agents. The ${LARGER_PLAN_PRICE}/month plan's ${LARGER_PLAN_SIZE} fits a [Claude Code agent](/agents/claude-code) signed into your Anthropic account and a [Codex agent](/agents/codex) signed into your ChatGPT account, both with their browsers on. Each runs on its own private VM, with its own terminal, files, and chat in the browser.\n\nWhat side-by-side gets you in practice:\n\n- **A real bake-off on your code.** Give both the same task from your actual backlog and compare the PRs. One week of that beats every benchmark article, because it is scored on your repo, your stack, your conventions.\n- **Workload routing.** Once you see where each is strong, split the queue: marathon refactors to one agent, batch fixes to the other.\n- **Redundancy on usage windows.** When one subscription hits its usage limit mid-day, the other agent can take the next task. Two capped subscriptions behave like a larger pooled budget.\n\nIf you already pay for both a Claude subscription and ChatGPT, the incremental cost of running both agents 24/7 is one hosting plan.`,
      ],
    },
    {
      heading: "Verdict by workload type",
      paragraphs: [
        "No single winner. A winner per workload:\n\n- **Long multi-hour tasks on one big codebase** (deep refactors, migrations, \"work through this 40-item checklist\"): **Claude Code.** Compaction plus session resume is the difference between finishing and starting over.\n- **High volume of small scoped tasks** (nightly test-fix runs, dependency bumps, triage): **Codex.** `codex exec` plus a scheduler is a clean, boring pipeline, and boring is what you want at 3 a.m.\n- **You already pay for Claude Pro or Max:** Claude Code. Your marginal AI cost is zero.\n- **You already pay for ChatGPT Plus or Pro:** Codex. Same logic, other direction.\n- **Web-heavy tasks that need a real browser:** either CLI works; the deciding factor is a machine with browser automation, which is a hosting feature (included with paid plans on Hivra), not a CLI feature.\n- **You genuinely cannot decide:** run both for a month on one plan and let your own backlog pick the winner.",
      ],
    },
    {
      heading: "Try the comparison on your own backlog",
      paragraphs: [
        `Reading a verdict is worse than running one. Launch a [Claude Code agent](/agents/claude-code) or a [Codex agent](/agents/codex) on Hivra, sign in with the subscription you already have, and hand it a real task from this week's list. Plans start at ${ENTRY_PLAN_PRICE}/month (see [pricing](/pricing)), paid plans are not paused for inactivity, and they come with a ${MONEY_BACK_GUARANTEE}. Start the task inside tmux in the computer's Terminal tab (or, on Claude Code, send it through Telegram) and it keeps going after you close the laptop. The calculator at [/tools/claude-code-plan-calculator](/tools/claude-code-plan-calculator) will tell you which Claude plan the workload actually needs. Hivra is independent and is not affiliated with Anthropic or OpenAI.`,
      ],
    },
  ],
  faqs: [
    {
      q: "Which is better for long-running tasks, Claude Code or Codex?",
      a: "For a single long continuous session, Claude Code has the edge: auto-compaction keeps the context window usable over hundreds of tool calls, and claude --continue resumes a session after a restart. For a high volume of short scoped tasks run headlessly, Codex's codex exec mode is the cleaner fit.",
    },
    {
      q: "Is it cheaper to run Claude Code or Codex 24/7?",
      a: "Roughly a tie if you use subscription login. Claude Code bills through a Claude subscription (Pro at $20/month, Max tiers from $100/month) and Codex through a ChatGPT subscription (Plus at $20/month, Pro from $100/month). Both put a usage limit on your spend instead of an open meter. Per-token API billing is the expensive route at a 24/7 duty cycle for either agent.",
    },
    {
      q: "Can I run Claude Code and Codex on the same hosting plan?",
      a: `Yes, as long as both agents fit in the plan's compute pool. On Hivra, the ${LARGER_PLAN_PRICE}/month plan (${LARGER_PLAN_SIZE}) fits one Claude Code agent and one Codex agent with their browsers on, each on its own private VM with its own login.`,
    },
    {
      q: "Do I need API keys to host Claude Code or Codex?",
      a: "No. On Hivra, Claude Code signs in with your own Anthropic account and Codex signs in with your own ChatGPT account, the same login flows the CLIs use on a laptop. The logins are stored on each agent's VM, and there is no markup on AI usage.",
    },
    {
      q: "What happens when a hosted agent hits its subscription usage limit mid-task?",
      a: "The run in progress stops with a usage-limit error. The computer, its files, and the session history stay, so you resume the session once the window resets. It is an argument for running both agents: when one subscription hits its limit, the other agent can take the next task.",
    },
    {
      q: "Are the hosted versions of Claude Code and Codex modified?",
      a: "No. Hivra runs the official Anthropic Claude Code CLI and the official OpenAI Codex CLI on private VMs. Hivra's chat runs them with permission prompts bypassed by default, and the agent's Manage tab can narrow that to Limited or Read-only. The browser interface (chat, terminal, files, skills) is a convenience layer around the standard CLIs. Hivra is independent and is not affiliated with Anthropic or OpenAI.",
    },
  ],
  relatedArticles: [
    {
      slug: "ai-agent-browser-automation-tools",
      title: "AI agent browser automation in 2026: Browser Use, Stagehand, Playwright, and Puppeteer",
    },
    { slug: "ai-agent-hosting-guide", title: "AI agent hosting in 2026: every real option compared (VPS, serverless, managed)" },
    { slug: "keep-claude-code-running-24-7", title: "How to keep Claude Code running 24/7" },
    { slug: "run-codex-24-7-in-the-cloud", title: "How to run Codex 24/7 in the cloud" },
    { slug: "byo-api-key-explained", title: "BYO API key: what it means and why it matters" },
    { slug: "cost-of-running-ai-agent", title: "How much does it cost to run an AI agent?" },
  ],
  relatedFeatures: [
    { slug: "browser-automation", title: "Browser automation" },
  ],
};
