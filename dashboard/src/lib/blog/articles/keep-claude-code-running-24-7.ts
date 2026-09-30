import { BlogArticle } from "../types";
import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE, PLAN_SUMMARY } from "../plan-facts";
import { CLI_RUN_LIFETIME } from "../runtime-facts";

// Rewritten 2026-09-30 from Search Console: about 20,000 impressions a month come from "will Claude keep running if I
// close / lock my laptop" questions at position 7 to 10 with almost no clicks, because the old page never answered them.
// Facts checked 2026-09-30: Claude Code docs (Remote Control; Claude Code on the web), the macOS caffeinate man page,
// Apple Support (closed-display use, sleep settings). Re-check the Anthropic pages before editing the table.
export const article: BlogArticle = {
  slug: "keep-claude-code-running-24-7",
  title: "Will Claude Code keep running if you close your laptop? (And how to run it 24/7)",
  metaTitle: "Will Claude Code keep running if I close my laptop?",
  metaDescription:
    "No, not on the laptop: closing the lid sleeps it and pauses Claude Code. Here is what keeps running: Anthropic's cloud, or tmux on a machine that stays on.",
  publishedDate: "2026-07-15",
  lastModified: "2026-09-30",
  readingTimeMin: 10,
  author: "Hivra team",
  tagline: "Short answer: not on the laptop. Here is what does keep running.",
  intro:
    "Closing the lid is the most common way a long Claude Code task stops. This page says exactly what happens, what survives, and the five ways to keep a run going while you are away, from a one-line command to a computer of its own.",
  shortAnswer:
    "Not if Claude Code is running on the laptop. Closing the lid puts a laptop to sleep, and sleep pauses every program on it, Claude Code included, until you wake it. To keep working with the lid shut, run it on a machine that stays on: Anthropic's cloud sessions, or your own always-on computer with Claude Code inside tmux.",
  sections: [
    {
      heading: "What keeps running when you close the lid",
      paragraphs: [
        "A sleeping laptop runs nothing. Sleep freezes every program, so a Claude Code session on the laptop pauses when the lid closes and carries on when you wake it. A request to Anthropic that was in flight at that moment may fail when the laptop comes back. Anthropic's own docs say the same thing from the other side: if your laptop sleeps or your network drops, a Remote Control session reconnects when the machine is back online ([Claude Code docs](https://code.claude.com/docs/en/remote-control)).",
        "| Where Claude Code runs | Keeps going with the lid shut? | What to know |\n|---|---|---|\n| Your laptop, as it comes | No | The session pauses and resumes when you wake the laptop. |\n| Your laptop, kept awake on purpose | Only with the right setup | `caffeinate` stops idle sleep on a Mac but does not stop a closed lid from sleeping it. See the next section. |\n| Your laptop, controlled from your phone with Remote Control | No | It is a window into the session on your machine. Anthropic's docs say the computer has to stay on and the `claude` process has to keep running. |\n| Claude Code on the web (Anthropic's cloud) | Yes | Runs on Anthropic's machines. Needs a paid Claude plan and works from a GitHub repository. An idle session can expire. |\n| A machine that stays on, with Claude Code inside tmux | Yes | tmux keeps the session alive through disconnects. The machine itself must stay on: a desktop, a home server or a VPS. |\n| A Hivra computer, run inside tmux in its Terminal tab | Yes | See the last section for exactly which runs are covered. |",
      ],
    },
    {
      heading: "Does locking my screen stop Claude Code?",
      paragraphs: [
        "No. Locking and sleeping are different things. A locked Mac is awake with the screen protected, and its programs keep running. The catch is that an idle laptop goes to sleep by itself after a while, and a closed lid sleeps it straight away. Sleep is what pauses Claude Code, so the real question is whether the laptop will sleep, not whether it is locked.",
        "You set the idle timers yourself. On a Mac they are in System Settings, under Battery, then Options, where you can also stop automatic sleeping while the display is off ([Apple Support](https://support.apple.com/guide/mac-help/mchle41a6ccd/mac)). Screen lock, display sleep and system sleep are three separate things, so check the system sleep timer, not just the lock.",
      ],
    },
    {
      heading: "Can I just keep the laptop awake?",
      paragraphs: [
        "For a short task at your desk, yes. Each command below holds the laptop awake only while Claude Code is running.\n\n```bash\n# macOS: prevent idle sleep for as long as claude runs\ncaffeinate -i claude\n\n# macOS, on power only: prevent system sleep (per the man page, -s works only on AC power)\ncaffeinate -s claude\n\n# Linux with systemd: hold off sleep and lid-switch handling while claude runs\nsystemd-inhibit --what=sleep:handle-lid-switch claude\n```\n\nOn Windows, set what closing the lid does in Control Panel, under Power Options, to \"Do nothing\".",
        "Be honest about the limits. `caffeinate` does not keep a MacBook awake with the lid closed: Apple describes lid-closed use in closed-display mode, with power connected, an external display and a keyboard or mouse attached ([Apple Support](https://support.apple.com/en-in/117373)). A laptop that stays on inside a bag can also get hot, and a reboot, a dropped network or a moved Wi-Fi network still ends the run. Keeping a laptop awake is a patch. A machine that was meant to stay on is the fix. If you do use the laptop route, the [keep-awake command builder](/tools/keep-mac-awake) writes the exact command for your setup and says what it will not cover.",
      ],
    },
    {
      heading: "Can I control it from my phone while the laptop is closed?",
      paragraphs: [
        "It depends which phone option you mean. Remote Control connects your phone or browser to a session that is still running on your computer, so the computer must stay on and awake. It helps when you walk away from your desk, not when you shut the lid and leave.\n\nClaude Code on the web runs on Anthropic's infrastructure, so the session keeps going after you close your laptop and you can check it from any device ([Claude Code docs](https://code.claude.com/docs/en/claude-code-on-the-web)). The third route is a machine that stays on, which you reach over SSH or a browser view. On Hivra you can also send Claude Code work from your phone through the Telegram tab, and those runs execute on the computer.",
      ],
    },
    {
      heading: "Fix 1: tmux (or screen) on a machine that stays awake",
      paragraphs: [
        "If you have any always-on machine (a desktop, a home server, a VPS), tmux is the classic answer. It keeps your terminal session alive on that machine even after you disconnect. Anthropic's Remote Control docs recommend exactly this for a session on a remote machine: start it inside tmux or screen.\n\n```bash\n# Start a named session and launch Claude Code inside it\ntmux new -s claude\nclaude\n\n# Detach without killing anything: press Ctrl+b, then d\n\n# Later, from any connection:\ntmux attach -t claude\n\n# See what is running\ntmux ls\n```\n\nFor the keys and commands on one page, see the [tmux cheat sheet](/tools/tmux-cheat-sheet).\n\nYour SSH connection can drop a hundred times. The session keeps working on the server. You reattach and pick up exactly where the agent left off. Remember the rule from the top of this page: tmux on your laptop does not survive sleep. It protects a session from disconnects and closed terminal windows, not from a sleeping machine.",
        "Prefer `screen`? Same idea, older tool:\n\n```bash\nscreen -S claude    # start\n# Detach: Ctrl+a, then d\nscreen -r claude    # reattach\n```\n\ntmux is the better default in 2026. Panes, better scripting, active development. But screen ships preinstalled on more distros, and for this one job either works. To score a specific setup against the usual failure modes, run it through the [agent survival check](/tools/agent-survival-check).",
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
      heading: "Fix 4: Anthropic's own cloud (Claude Code on the web)",
      paragraphs: [
        "If you only use Claude Code and your work lives in GitHub repositories, this may be all you need. A cloud session runs on machines Anthropic manages, and Anthropic's documentation says it keeps running after you close your laptop ([Claude Code docs](https://code.claude.com/docs/en/claude-code-on-the-web)). You start one from claude.ai/code, from the Claude app, or from the terminal with `claude --cloud`.\n\nThings to weigh, all from the same documentation as checked on 30 September 2026:\n\n- **Plan.** Cloud sessions are available on Pro, Max and Team plans, and to Enterprise users with eligible seats.\n- **Where the code lives.** The session clones a GitHub repository. Sending a local repository as a bundle is possible, but results can only be pushed back to GitHub.\n- **Idle sessions expire.** Cloud sessions stop after a period of inactivity and the machine is reclaimed. You can reopen the session with its history, but work that was still running in the background is not restored.\n- **It is not your computer.** You get Anthropic's environment, not your own files, tools, logins or other agents.\n\nA computer of your own makes sense when you want those things to stay put between tasks, or to run other agents beside Claude Code.",
      ],
    },
    {
      heading: "Fix 5: a computer of your own on Hivra",
      paragraphs: [
        `[Hivra](/) runs the official Claude Code CLI from Anthropic on a private virtual machine provisioned for you, a computer whose only job is running your agent. Hivra's chat runs the CLI with permission prompts bypassed by default inside that VM, and the Permissions setting on the agent's Manage tab narrows that to Limited or Read-only.\n\nWhat you get, per the actual product:\n\n- **Your own Anthropic login.** After launch, you sign in with your own Anthropic account on the computer, the same login flow as on your laptop. The login is stored on that VM.\n- **A computer that stays on, with one rule to know.** ${CLI_RUN_LIFETIME}\n- **A Telegram tab.** Connect your own bot in the agent's Telegram tab, under Manage, and send Claude Code work from your phone. Those runs execute on the computer, not in your browser.\n- **Browser access to the computer.** Chat, terminal, files, skills, and browser tabs wrap the standard CLI, so you can check on it from your phone.\n- **A live self-hosted browser.** The Claude Code computer ships browser automation, so the agent can drive a real Chrome browser on its own VM.\n- **No server admin.** Hivra provisions the machine and runs it for you.\n\nLaunch it from [the Claude Code agent page](/agents/claude-code).`,
        `Plan note: ${PLAN_SUMMARY} The ${ENTRY_PLAN_PRICE} plan is ${ENTRY_PLAN_SIZE}, enough for Claude Code with its browser. Full details on [the pricing page](/pricing). One more cost question worth settling before you commit: whether your current Claude subscription covers round-the-clock usage. The [Claude Code plan calculator](/tools/claude-code-plan-calculator) does that math, and [Claude Code pricing: Pro vs Max](/blog/claude-max-vs-pro-for-claude-code) sets out which plan fits and what Anthropic publishes about the limits. Hivra is independent and is not affiliated with Anthropic.`,
      ],
    },
    {
      heading: "DIY vs managed: the honest tradeoffs",
      paragraphs: [
        `| | DIY VPS + tmux | Hivra managed |\n|---|---|---|\n| Cash cost | $5-10/mo | From ${ENTRY_PLAN_PRICE}/mo (${ENTRY_PLAN_SIZE}) |\n| Setup | 1-2 hours of your time | Pick the agent, then sign in |\n| Keeps running with the laptop closed | Yes, inside tmux | Yes, inside tmux in the Terminal tab or sent through Telegram |\n| Interface | SSH terminal only | Browser: chat, terminal, files, skills |\n| Agent browser automation | You install and maintain it | Included on the Claude Code computer |\n| Server setup | You | Done for you |\n| Access to the machine | Your own SSH hardening | Private VM, reached through your Hivra dashboard |\n| Control over the machine | Total (root on your VPS) | Managed VM, resize CPU/RAM in the dashboard |\n\nIf you enjoy running servers and want total control, the DIY route is legitimate and cheap. If you want the agent working tonight without owning another Linux server, managed wins on time.`,
      ],
    },
    {
      heading: "Which fix should you pick?",
      paragraphs: [
        "- **Short task, you are at your desk:** `caffeinate -i claude` and leave the lid open.\n- **You already have an always-on machine:** tmux. Done. Costs nothing.\n- **You need one long task to finish overnight:** `nohup claude -p` on any machine that stays awake.\n- **You only use Claude Code on GitHub repositories:** try Claude Code on the web first.\n- **You want a permanent 24/7 setup and like sysadmin work:** a small VPS plus tmux, roughly $5-10/month.\n- **You want a permanent 24/7 setup without the sysadmin work:** [run Claude Code on Hivra](/agents/claude-code). Sign in with your own Anthropic account and the computer stays up. Start long runs inside tmux in its Terminal tab, or send them through Telegram, so they keep going after you close the laptop.",
      ],
    },
  ],
  faqs: [
    {
      q: "Will Claude Code keep running if I close my laptop?",
      a: "Not if it is running on the laptop. Closing the lid puts the laptop to sleep, which pauses every program on it, Claude Code included, until you wake it. To keep a run going with the lid shut, run it on Anthropic's cloud (Claude Code on the web) or on a machine that stays on, inside tmux.",
    },
    {
      q: "Does locking my screen stop Claude Code?",
      a: "No. A locked screen is not sleep, and programs keep running. What pauses Claude Code is the laptop going to sleep, which happens when its idle timer runs out or the lid closes. Check the sleep settings in System Settings, under Battery, then Options, on a Mac.",
    },
    {
      q: "Does Claude Code keep running if my Mac goes to sleep?",
      a: "No. Sleep pauses every process. A Remote Control session reconnects when the machine wakes, and a local session carries on, but nothing runs while the Mac sleeps. A request to Anthropic that was in flight when the Mac went to sleep may fail on wake.",
    },
    {
      q: "Can I close my laptop and use Claude Code from my phone?",
      a: "Only if Claude Code is running somewhere that stays on. Remote Control needs your computer to stay on and awake, so closing the lid ends it. Claude Code on the web runs on Anthropic's machines and keeps going, and a computer that stays on, reached over SSH or a browser, works too.",
    },
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
    { slug: "run-codex-24-7-in-the-cloud", title: "How to run Codex 24/7 in the cloud" },
    { slug: "control-claude-code-from-telegram", title: "Control Claude Code from Telegram" },
    { slug: "ai-agent-dies-terminal-closes-fixes", title: "Why your AI agent dies when the terminal closes, and the fixes" },
    { slug: "claude-code-vs-codex-24-7", title: "Claude Code vs Codex for running 24/7" },
    { slug: "cost-of-running-ai-agent", title: "How much does it cost to run an AI agent?" },
    { slug: "best-vps-for-hermes-agent", title: "Best VPS for Hermes Agent in 2026" },
  ],
  relatedFeatures: [
    { slug: "browser-automation", title: "Browser automation" },
  ],
};
