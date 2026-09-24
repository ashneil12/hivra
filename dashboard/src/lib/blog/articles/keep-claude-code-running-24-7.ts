import { BlogArticle } from "../types";
import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE, PLAN_SUMMARY } from "../plan-facts";
import { CLI_RUN_LIFETIME } from "../runtime-facts";

export const article: BlogArticle = {
  slug: "keep-claude-code-running-24-7",
  title: "How to keep Claude Code running 24/7 (even when your laptop closes)",
  metaTitle: "How to keep Claude Code running 24/7",
  metaDescription:
    "Claude Code dies when your laptop sleeps or SSH drops. The real fixes: tmux and screen, headless runs with nohup, a DIY VPS, and managed hosting.",
  publishedDate: "2026-07-15",
  lastModified: "2026-09-24",
  readingTimeMin: 9,
  author: "Hivra team",
  tagline: "Your session should not die because your lid closed.",
  intro:
    "You kick off a long Claude Code task, close the laptop, and come back to a dead session. The fix is not a flag or a setting. The process has to live on a machine that stays awake. Here is every way to do that, from tmux to a small VPS to fully managed.",
  sections: [
    {
      heading: "Why your Claude Code session dies",
      paragraphs: [
        "Claude Code is an interactive terminal program. It lives inside your shell session. Anything that kills the shell kills the agent mid-task. The three usual killers:\n\n- **Laptop sleep.** Close the lid and macOS or Windows suspends every process. Claude Code included. Nothing runs until you wake it up.\n- **SSH disconnect.** Running Claude Code on a remote server over SSH? When the connection drops, the shell gets SIGHUP and the CLI dies with it. Flaky wifi is enough.\n- **Terminal close.** Quit the terminal app, or the window crashes, and the child process goes down too.",
        "One thing to get straight before any fix: tmux on your laptop does not survive sleep. tmux protects a session from disconnects and closed windows. It cannot keep a suspended machine working. If the hardware sleeps, everything sleeps. So the real question is where the process runs, not which multiplexer you use. To score a specific setup against these failure modes, run it through the [agent survival check](/tools/agent-survival-check).",
      ],
    },
    {
      heading: "Fix 1: tmux (or screen) on a machine that stays awake",
      paragraphs: [
        "If you have any always-on machine (a desktop, a home server, a VPS), tmux is the classic answer. It keeps your terminal session alive on that machine even after you disconnect.\n\n```bash\n# Start a named session and launch Claude Code inside it\ntmux new -s claude\nclaude\n\n# Detach without killing anything: press Ctrl+b, then d\n\n# Later, from any connection:\ntmux attach -t claude\n\n# See what is running\ntmux ls\n```\n\nYour SSH connection can drop a hundred times. The session keeps working on the server. You reattach and pick up exactly where the agent left off.",
        "Prefer `screen`? Same idea, older tool:\n\n```bash\nscreen -S claude    # start\n# Detach: Ctrl+a, then d\nscreen -r claude    # reattach\n```\n\ntmux is the better default in 2026. Panes, better scripting, active development. But screen ships preinstalled on more distros, and for this one job either works.",
      ],
    },
    {
      heading: "Fix 2: nohup for one-shot headless runs",
      paragraphs: [
        "You do not always need the interactive session. Claude Code has a headless mode (`claude -p`) that takes a prompt, runs it, and exits. For fire-and-forget jobs, `nohup` keeps that run alive after you log out:\n\n```bash\nnohup claude -p \"run the test suite, fix any failures, and commit\" > run.log 2>&1 &\n\n# Check on it later\ntail -f run.log\n```\n\n`nohup` detaches the process from your terminal so the logout SIGHUP never reaches it. Good for single tasks. Wrong tool for an ongoing interactive session, because you cannot reattach and steer. For that, use tmux.",
      ],
    },
    {
      heading: "Fix 3: the DIY VPS route",
      paragraphs: [
        "No always-on machine at home? Rent one. Anthropic's system requirements for Claude Code list 4 GB of RAM, and a 4 GB server from a budget host runs roughly $5-10/month. The setup:\n\n```bash\n# 1. SSH into the fresh server\nssh root@your-vps-ip\n\n# 2. Install Claude Code with Anthropic's native installer\ncurl -fsSL https://claude.ai/install.sh | bash\n\n# 3. Authenticate (run claude once and follow the login flow)\nclaude\n\n# 4. Run it inside tmux so it survives your disconnects\ntmux new -s claude\nclaude\n```\n\nPrefer npm? `npm install -g @anthropic-ai/claude-code` installs the same binary and needs Node.js 22 or later. Detach, close your laptop, go to sleep. The agent keeps working. Reattach from your phone over SSH if you want to check in.",
        "What the DIY route actually costs you beyond the server rent:\n\n- **Setup time.** An hour or two if the steps go clean. More if they do not.\n- **Auth friction.** The login flow on a headless server means copying URLs and codes between machines.\n- **Maintenance.** OS updates, CLI updates, disk filling up with logs. Small jobs, but they land on you at bad times.\n- **Security.** The server is on the public internet with your logged-in agent on it. SSH keys only, firewall on, fail2ban is a good idea. That is your job now.\n- **No interface.** You get a terminal over SSH. No browser view of what the agent is doing, no file browser, nothing on mobile beyond a raw shell.",
      ],
    },
    {
      heading: "Fix 4: the managed route",
      paragraphs: [
        `[Hivra](/) runs the official Claude Code CLI from Anthropic on a private virtual machine provisioned for you, a computer whose only job is running your agent. Hivra's chat runs the CLI with permission prompts bypassed by default inside that VM, and the Permissions setting on the agent's Manage tab narrows that to Limited or Read-only.\n\nWhat you get, per the actual product:\n\n- **Your own Anthropic login.** After launch, you sign in with your own Anthropic account on the computer, the same login flow as on your laptop. The login is stored on that VM.\n- **A computer that stays on, with one rule to know.** ${CLI_RUN_LIFETIME}\n- **A Telegram tab.** Connect your own bot in the agent's Telegram tab, under Manage, and send Claude Code work from your phone. Those runs execute on the computer, not in your browser.\n- **Browser access to the computer.** Chat, terminal, files, skills, and browser tabs wrap the standard CLI, so you can check on it from your phone.\n- **A live self-hosted browser.** The Claude Code computer ships browser automation, so the agent can drive a real Chrome browser on its own VM.\n- **No server admin.** Hivra provisions the machine and runs it for you.\n\nLaunch it from [the Claude Code agent page](/agents/claude-code).`,
        `Plan note: ${PLAN_SUMMARY} The ${ENTRY_PLAN_PRICE} plan is ${ENTRY_PLAN_SIZE}, enough for Claude Code with its browser. Full details on [the pricing page](/pricing). One more cost question worth settling before you commit: whether your current Claude subscription covers round-the-clock usage. The [Claude Code plan calculator](/tools/claude-code-plan-calculator) does that math. Hivra is independent and is not affiliated with Anthropic.`,
      ],
    },
    {
      heading: "DIY vs managed: the honest tradeoffs",
      paragraphs: [
        `| | DIY VPS + tmux | Hivra managed |\n|---|---|---|\n| Cash cost | $5-10/mo | From ${ENTRY_PLAN_PRICE}/mo |\n| Setup | 1-2 hours of your time | Pick the agent, then sign in |\n| Keeps running with the laptop closed | Yes, inside tmux | Yes, inside tmux in the Terminal tab or sent through Telegram |\n| Interface | SSH terminal only | Browser: chat, terminal, files, skills |\n| Agent browser automation | You install and maintain it | Included on the Claude Code computer |\n| Server setup | You | Done for you |\n| Access to the machine | Your own SSH hardening | Private VM, reached through your Hivra dashboard |\n| Control over the machine | Total (root on your VPS) | Managed VM, resize CPU/RAM in the dashboard |\n\nIf you enjoy running servers and want total control, the DIY route is legitimate and cheap. If you want the agent working tonight without owning another Linux server, managed wins on time.`,
      ],
    },
    {
      heading: "Which fix should you pick?",
      paragraphs: [
        "- **You already have an always-on machine:** tmux. Done. Costs nothing.\n- **You need one long task to finish overnight:** `nohup claude -p` on any machine that stays awake.\n- **You want a permanent 24/7 setup and like sysadmin work:** a small VPS plus tmux, roughly $5-10/month.\n- **You want a permanent 24/7 setup without the sysadmin work:** [run Claude Code on Hivra](/agents/claude-code). Sign in with your own Anthropic account and the computer stays up. Start long runs inside tmux in its Terminal tab, or send them through Telegram, so they keep going after you close the laptop.",
      ],
    },
  ],
  faqs: [
    {
      q: "Does tmux keep Claude Code running when I close my laptop?",
      a: "No. tmux protects the session from disconnects and closed terminal windows, but when your laptop sleeps, every process on it is suspended, tmux included. tmux only helps on a machine that stays awake: a desktop, home server, or VPS.",
    },
    {
      q: "Can I run Claude Code on a VPS?",
      a: "Yes. Install it with Anthropic's native installer (curl -fsSL https://claude.ai/install.sh | bash), authenticate, and run it inside tmux so it survives SSH drops. Anthropic lists 4 GB of RAM in its system requirements, so pick a server with at least that much.",
    },
    {
      q: "How much does it cost to run Claude Code 24/7?",
      a: `DIY: roughly $5-10/month for a 4 GB VPS from a budget host, plus your setup and maintenance time. Managed on Hivra: plans start at ${ENTRY_PLAN_PRICE}/month for ${ENTRY_PLAN_SIZE}, and paid plans are not paused for inactivity. Your Claude usage bills through your own Anthropic account either way.`,
    },
    {
      q: "Do I need an API key to run Claude Code in the cloud?",
      a: "On Hivra, no separate key setup is required for Claude Code: you sign in with your own Anthropic account on the computer after launch, the same login flow as on your laptop. The login is stored on the agent's VM.",
    },
    {
      q: "Does Hivra modify Claude Code?",
      a: "No. It is the official Claude Code CLI from Anthropic on a private VM. Hivra's chat runs it with permission prompts bypassed by default, and the agent's Manage tab can narrow that to Limited or Read-only. The chat, terminal, files, skills, and browser tabs are a convenience layer around the standard CLI. Hivra is independent and is not affiliated with Anthropic.",
    },
    {
      q: "Does a Claude Code task on Hivra keep running when I close my laptop?",
      a: `Yes, if you start it inside tmux or send it through Telegram. ${CLI_RUN_LIFETIME}`,
    },
    {
      q: "What happens to a running task if my SSH connection drops?",
      a: "If Claude Code is running inside tmux or screen on the remote machine, nothing. The session keeps working and you reattach with tmux attach -t claude. If it is running bare in the SSH shell, the disconnect sends SIGHUP and the task dies.",
    },
  ],
  relatedArticles: [
    {
      slug: "ai-agent-memory-systems",
      title: "AI agent memory systems in 2026: Zep, Mem0, Letta, and dual-layer architectures",
    },
    {
      slug: "ai-agent-browser-automation-tools",
      title: "AI agent browser automation in 2026: Browser Use, Stagehand, Playwright, and Puppeteer",
    },
    { slug: "run-codex-24-7-in-the-cloud", title: "How to run Codex 24/7 in the cloud" },
    { slug: "best-vps-for-hermes-agent", title: "Best VPS for Hermes Agent in 2026" },
    { slug: "cost-of-running-ai-agent", title: "How much does it cost to run an AI agent?" },
    { slug: "hermes-agent-cron-scheduled-tasks", title: "Hermes Agent scheduled tasks" },
  ],
  relatedFeatures: [
    { slug: "browser-automation", title: "Browser automation" },
  ],
};
