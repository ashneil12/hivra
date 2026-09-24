import { BlogArticle } from "../types";
import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE, LARGER_PLAN_PRICE, LARGER_PLAN_SIZE, MONEY_BACK_GUARANTEE } from "../plan-facts";
import { CLI_RUN_LIFETIME, SERVER_SIDE_AGENTS_KEEP_WORKING } from "../runtime-facts";

export const article: BlogArticle = {
  slug: "ai-agent-hosting-guide",
  title:
    "AI agent hosting in 2026: every real option compared (VPS, serverless, managed)",
  metaTitle: "AI agent hosting in 2026: every option compared",
  metaDescription:
    "Where should an AI agent live? Your own hardware, a VPS, serverless, or managed hosting, compared on real costs, security basics, and upkeep.",
  publishedDate: "2026-07-15",
  lastModified: "2026-09-24",
  readingTimeMin: 11,
  author: "Hivra team",
  tagline: "An agent that lives on your laptop is not really an agent.",
  intro:
    "Search for AI agent hosting and you get enterprise cloud docs and thin listicles. Neither answers the actual question: where should a personal or CLI agent live so it keeps working when you close your laptop? Here is every real option, with real prices.",
  sections: [
    {
      heading: "What hosting an AI agent actually means",
      paragraphs: [
        "An AI agent is a long-running process. It holds a session, calls a model, uses tools, writes files, and waits for the next trigger. That last part is what separates hosting an agent from hosting a website. A website answers requests and forgets you. An agent has state: memory files, a workspace full of code, auth sessions, scheduled jobs mid-flight.",
        "So hosting an AI agent means giving that process three things:\n\n- **A machine that stays awake.** If the hardware suspends, the agent suspends. Your laptop fails this test the moment you close the lid.\n- **Persistent disk.** The agent's memory, workspace, and login state have to survive restarts. Wipe the disk and the agent starts life over. How much of that state is worth keeping depends on the [memory system the agent uses](/blog/ai-agent-memory-systems).\n- **A way back in.** You need to check on it, steer it, and read its output from wherever you are, ideally including your phone.",
        "Everything below is judged against those three requirements. The model API is a separate cost and a separate decision. Hosting is about where the process runs, not which model it calls. If you want the full cost picture including tokens, we broke that down in [how much it costs to run an AI agent](/blog/cost-of-running-ai-agent).",
      ],
    },
    {
      heading: "The four options",
      paragraphs: [
        "**Option 1: your own hardware.** A desktop that stays on, a home server, a Raspberry Pi, an old laptop with the lid-close sleep disabled. Marginal cash cost is near zero. You already own the machine. The catch is everything else: your home internet drops, the power flickers, the machine needs OS updates, and remote access means either exposing SSH to the internet or running a tunnel. Fine for tinkering. Fragile as the thing your agent's uptime depends on.",
        "**Option 2: a VPS.** Rent a small virtual server for $5-10/month from Hetzner, DigitalOcean, or similar. This is the classic DIY answer and it genuinely works. You get root, a static IP, and a datacenter's uptime instead of your apartment's. You also inherit the sysadmin job: hardening SSH, applying patches, watching disk usage, and rebuilding the server when something breaks at 2am. We covered the concrete setup in [best VPS for Hermes Agent](/blog/best-vps-for-hermes-agent), and the [AI agent VPS guide](/blog/ai-agent-vps) has specs and provider picks for any CLI agent.",
        "**Option 3: serverless.** Lambda, Cloud Run, Workers, and friends. Great for stateless request-response code. A poor fit for agents, and it is worth being precise about why. Serverless platforms bill per invocation and shut your process down between requests. Execution time limits (often 5-15 minutes) kill long tasks. Local disk is ephemeral, so the agent's memory and workspace vanish between runs. You can bolt on external storage and queues to fake persistence, but at that point you have built a distributed system to avoid renting a $6 server. Serverless makes sense for narrow event-driven automations, not for a persistent agent with a workspace.",
        "**Option 4: managed agent hosting.** A platform provisions a dedicated machine, installs the agent, wires up a web interface, and runs the server for you. You trade root access and some flexibility for a setup you do not have to build. This category barely existed two years ago. [Hivra](/) is our version of it: each agent runs on its own private VM, and Claude Code and Codex are the vendors' official CLIs, so [Claude Code](/agents/claude-code) is signed into with your own Anthropic account and [Codex](/agents/codex) with your own ChatGPT login. Zero markup on AI usage, because the usage bills through your accounts, not ours. We did the full total-cost math against DIY in [managed vs self-hosted AI agents](/blog/managed-vs-self-hosted-ai-agents).",
      ],
    },
    {
      heading: "What CLI agents specifically need",
      paragraphs: [
        "Most hosting comparisons are written for web apps. CLI agents like Claude Code, Codex, and [Hermes](/agents/hermes) have a different shape. (Choosing between the first two? We compared them as hosted always-on agents in [Claude Code vs Codex for 24/7 work](/blog/claude-code-vs-codex-24-7).) Four requirements decide whether a host actually works for them:",
        `- **Process persistence.** The agent must survive your disconnect. On a VPS that means running it inside tmux or screen so an SSH drop does not kill the session. On managed hosting, check which runs the platform promises will survive a closed laptop. ${CLI_RUN_LIFETIME}\n- **A real browser.** Modern agents do research, fill forms, and test web apps by driving Chrome. That needs a full browser install on the same machine, plus the RAM to run it. Chrome is the hungriest thing on an agent's machine by a wide margin. Budget for it or the agent's most useful skill is missing.\n- **Memory and workspace on disk.** Agents accumulate context: memory files, cloned repos, generated artifacts. The disk has to persist across restarts, and you want more than a few GB free.\n- **Restart behavior.** Machines reboot. Kernels get patched. Something has to bring the agent back up afterward: a systemd unit you write yourself, or a supervisor the platform runs for you. An agent that stays down after the first unattended reboot is not a 24/7 agent.`,
        "Serverless fails the first and third requirements outright. Your own hardware and a VPS can meet all four if you do the work. Managed hosting is built to meet them for you, which is most of what you are paying for.",
      ],
    },
    {
      heading: "Real cost comparison",
      paragraphs: [
        `Cash costs first, then the honest part: your time.\n\n| Option | Cash per month | Setup time | Maintenance | Keeps running with your laptop closed |\n|---|---|---|---|---|\n| Own hardware | ~$3-8 electricity | 1-3 hours | Yours, plus home internet risk | Yes, if the machine stays awake |\n| VPS (DIY) | $5-10 | 1-2 hours | Yours: patches, security, restarts | Yes |\n| Serverless | Varies, often near $0 idle | Hours to days of glue code | Yours, and the architecture fights you | N/A, no persistent process |\n| Managed (Hivra) | From ${ENTRY_PLAN_PRICE} | Pick an agent and sign in | The server is run for you | Yes for the computer, and for Claude Code or Codex runs inside tmux |\n\nOn Hivra specifically: the ${ENTRY_PLAN_PRICE}/month plan is ${ENTRY_PLAN_SIZE}, and the ${LARGER_PLAN_PRICE}/month plan is ${LARGER_PLAN_SIZE}. Paid plans are not paused for inactivity, and both come with a ${MONEY_BACK_GUARANTEE}. ${SERVER_SIDE_AGENTS_KEEP_WORKING} For Claude Code and Codex, start long runs inside tmux in the computer's Terminal tab, or on Claude Code send them through Telegram, and they keep going after you close the laptop. Full details on [the pricing page](/pricing).`,
        "Two things the table cannot show. First, DIY cash costs are floors, not totals: an hour of your time spent patching a server has a price even if no invoice arrives. Second, model usage dwarfs hosting for heavy users either way. A busy agent can spend more on tokens in a day than the VPS costs in a month. If you want numbers for your own setup, [the hosting cost calculator](/tools/ai-agent-hosting-cost-calculator) lets you compare DIY and managed with your actual usage.",
      ],
    },
    {
      heading: "Security basics that actually matter",
      paragraphs: [
        "An agent's server is a strange thing to secure: it holds logged-in sessions for your accounts and it runs a program whose whole job is executing commands. Whatever host you pick, get these right:",
        "- **No public ports beyond SSH.** The agent's web interface should never listen on 0.0.0.0 without auth in front of it. Reverse-proxy it behind authentication or tunnel to it. An open agent dashboard is remote code execution as a service, for everyone.\n- **SSH keys only, password auth off.** One line in sshd_config. Non-negotiable on a public VPS.\n- **Prefer login sessions over raw API keys.** A key pasted into a .env file on a server is a key that leaks in a backup, a log line, or a repo. Subscription logins (your Anthropic account for Claude Code, your ChatGPT account for Codex) can be revoked from the provider's side without rotating a key everywhere. We wrote more on this in [BYO API key explained](/blog/byo-api-key-explained).\n- **Isolate the agent from your other stuff.** Do not run your agent on the same machine as your database or your personal files. One machine per agent is the clean model: if an agent is tricked into running something hostile, the blast radius is its own VM. This is how Hivra provisions every agent, and it is worth replicating if you self-host.\n- **Patch on a schedule.** Unattended-upgrades on Debian or Ubuntu takes five minutes to enable and closes the boring-but-real hole of a six-month-old kernel.",
      ],
    },
    {
      heading: "One-click deploys: what is real",
      paragraphs: [
        "Deploy an AI agent in one click is a claim worth auditing, because it hides two very different products. Version one: a template that spins up a container with a chatbot wrapper and a text box. It demos well and does little, because there is no persistent workspace, no browser, and often no real CLI underneath. Version two: a platform that provisions actual infrastructure with the real agent on it.",
        "The test is what exists after the click. You should be able to answer yes to all of these:\n\n- Is the real agent underneath (the vendor's CLI or the open-source project), and does the host tell you which build it runs and with which permission settings?\n- Do you sign in with your own model account, so usage bills at provider rates with no markup?\n- Is there a persistent VM with a workspace, or just a stateless container?\n- Can the agent drive a real browser?\n- Can you reach the terminal, the files, and the running session from a browser, including on your phone?",
        "On Hivra the launch provisions a private VM with the agent running on it, and chat, terminal, files, and browser tabs on top. Six agents are launchable today: Hermes, Claude Code, Codex, [Aeon](/agents/aeon), [OpenClaw](/agents/openclaw), and [Agent Zero](/agents/agent-zero). OpenClaw and Agent Zero need a paid plan. If you are weighing those last two against each other, we compared them in [Agent Zero vs OpenClaw hosting](/blog/agent-zero-vs-openclaw-hosting).",
      ],
    },
    {
      heading: "Which option wins for which person",
      paragraphs: [
        `- **You have a home server and enjoy tending it:** your own hardware. Cheapest marginal cost, and you already accepted the ops work.\n- **You want full root, total control, and do not mind the sysadmin job:** a $5-10 VPS with tmux, SSH hardening, and a systemd unit. Legitimate, proven, cheap.\n- **You need a narrow event-driven automation, not a persistent agent:** serverless, honestly. Right tool for that one job.\n- **You want the agent working tonight and never want to think about the server:** managed. Pick an agent, launch it, sign in with your own account, and the computer stays up. On Hivra that is ${ENTRY_PLAN_PRICE}/month for ${ENTRY_PLAN_SIZE} or ${LARGER_PLAN_PRICE}/month for ${LARGER_PLAN_SIZE}.`,
        "The wrong answer is the default one: leaving the agent on your laptop and hoping. An agent that [dies when the terminal closes](/blog/ai-agent-dies-terminal-closes-fixes) is a chat session with extra steps. Put it on [a machine that runs 24/7](/blog/run-ai-agents-24-7), whichever of the four ways you choose, and it starts earning the name.",
      ],
    },
  ],
  faqs: [
    {
      q: "Can I host an AI agent for free?",
      a: "Yes, if you run it on hardware you already own that stays awake, which costs only electricity. Model usage is a separate cost on your own account either way. Paid hosting starts where your own hardware stops being reliable enough.",
    },
    {
      q: "What is the cheapest way to host an AI agent 24/7?",
      a: `A small VPS at $5-10/month is the cheapest always-on option if you value your setup and maintenance time at zero. If you do not, Hivra's ${ENTRY_PLAN_PRICE}/month plan (${ENTRY_PLAN_SIZE}) is in the same price band and removes the sysadmin work, with a ${MONEY_BACK_GUARANTEE}.`,
    },
    {
      q: "Can I run an AI agent on AWS Lambda or another serverless platform?",
      a: "Not well. Serverless platforms enforce execution time limits, shut processes down between invocations, and give you ephemeral disk. Agents need a long-running process and persistent state. Serverless fits narrow event-driven automations, but a persistent agent belongs on a VM.",
    },
    {
      q: "How much RAM does an AI agent server need?",
      a: "Many agent CLIs run in about 1 GB, though Anthropic lists 4 GB for Claude Code. The moment the agent drives a real browser, budget 2-4 GB for the browser alone, because Chrome is the heaviest process on the machine. On the DIY route that means the cheapest VPS tier is often too small for browser work; size up or the browser gets killed mid-task.",
    },
    {
      q: "Do I need an API key to host an agent in the cloud?",
      a: "Not necessarily. Claude Code signs in with your Anthropic account and Codex with your ChatGPT login, the same flow as on a laptop. That is usually better than pasting an API key into a server .env file, since the login is revocable from the provider's side. Other agents, like Hermes with your chosen model provider, do take a key you supply.",
    },
    {
      q: "Is it safe to run an AI agent on a public VPS?",
      a: "It can be, if you treat it like the sensitive machine it is: SSH keys only, no public ports without auth in front, the agent isolated on its own machine, and patches applied on a schedule. The agent holds your logged-in sessions and executes commands, so an exposed dashboard is the main thing to never allow.",
    },
  ],
  relatedArticles: [
    {
      slug: "run-ai-agents-24-7",
      title: "How to run AI agents 24/7: infrastructure, recovery, and real cost (2026)",
    },
    {
      slug: "ai-agent-vps",
      title: "AI agent VPS guide: specs, providers, and setup that actually works (2026)",
    },
    {
      slug: "managed-vs-self-hosted-ai-agents",
      title: "Managed vs self-hosted AI agents: the honest total-cost math (2026)",
    },
    {
      slug: "claude-code-vs-codex-24-7",
      title: "Claude Code vs Codex for 24/7 autonomous work: which should you host?",
    },
    {
      slug: "ai-agent-dies-terminal-closes-fixes",
      title: "Why your AI agent dies when you close the terminal (and every fix that works)",
    },
    {
      slug: "cost-of-running-ai-agent",
      title: "How much does it cost to run an AI agent?",
    },
    {
      slug: "what-is-an-ai-agent",
      title: "What is an AI agent? A clear, technical explanation for 2026",
    },
    {
      slug: "ai-agent-memory-systems",
      title: "AI agent memory systems in 2026: Zep, Mem0, Letta, and dual-layer architectures",
    },
    {
      slug: "ai-agent-browser-automation-tools",
      title: "AI agent browser automation in 2026: Browser Use, Stagehand, Playwright, and Puppeteer",
    },
  ],
  relatedFeatures: [{ slug: "browser-automation", title: "Browser automation" }],
};
