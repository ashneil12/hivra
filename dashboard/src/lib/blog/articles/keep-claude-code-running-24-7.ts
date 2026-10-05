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
    "No, not on the laptop: closing the lid sleeps it and pauses Claude Code. Here's what keeps running: Anthropic's cloud, or tmux on a machine that stays on.",
  publishedDate: "2026-07-15",
  lastModified: "2026-09-30",
  readingTimeMin: 10,
  author: "Hivra team",
  tagline: "Short answer: not on the laptop. Here's what does keep running.",
  intro:
    "Closing the lid is the most common way a long Claude Code task stops. Five fixes keep a run going while you're away, from a one-line command to a computer of its own.",
  shortAnswer:
    "Not if Claude Code is running on the laptop. Closing the lid puts a laptop to sleep, and sleep pauses every program on it, Claude Code included, until you wake it. To work with the lid shut, run it on a machine that stays on. That means Anthropic's cloud sessions, or your own always-on computer with Claude Code inside tmux.",
  sections: [
    {
      heading: "What keeps running when you close the lid",
      paragraphs: [
        "A sleeping laptop runs nothing. Every program freezes, so a Claude Code session on the laptop pauses when the lid closes and picks up again when you wake it. A request to Anthropic that was in flight at that moment may fail when the laptop comes back. Anthropic's docs say the same about Remote Control: if your laptop sleeps or your network drops, the session reconnects once the machine is back online ([Claude Code docs](https://code.claude.com/docs/en/remote-control)).",
        "| Where Claude Code runs | Keeps going with the lid shut? | What to know |\n|---|---|---|\n| Your laptop, as it comes | No | The session pauses and resumes when you wake the laptop. |\n| Your laptop, kept awake on purpose | Only with the right setup | `caffeinate` stops idle sleep on a Mac but doesn't stop a closed lid from sleeping it. See the keep-awake section below. |\n| Your laptop, controlled from your phone with Remote Control | No | It's a window into the session on your machine. Anthropic's docs say the computer has to stay on and the `claude` process has to keep running. |\n| Claude Code on the web (Anthropic's cloud) | Yes | Runs on Anthropic's machines. Needs a paid Claude plan and works from a GitHub repository. An idle session can expire. |\n| A machine that stays on, with Claude Code inside tmux | Yes | tmux keeps the session alive through disconnects. The machine itself must stay on: a desktop, a home server or a VPS. |\n| A Hivra computer, run inside tmux in its Terminal tab | Yes | See Fix 5 for which runs are covered. |",
      ],
    },
    {
      heading: "Does locking my screen stop Claude Code?",
      paragraphs: [
        "No. Locking and sleeping are different things. A locked Mac is awake with the screen protected, and its programs keep running. The catch: an idle laptop goes to sleep by itself after a while, and a closed lid sleeps it straight away. Sleep is what pauses Claude Code, so what matters is whether the laptop will sleep.",
        "You set the idle timers yourself. On a Mac they're in System Settings, under Battery, then Options, where you can also stop automatic sleeping while the display is off ([Apple Support](https://support.apple.com/guide/mac-help/mchle41a6ccd/mac)). Screen lock, display sleep and system sleep are three separate settings, so check the system sleep timer.",
      ],
    },
    {
      heading: "Can I just keep the laptop awake?",
      paragraphs: [
        "For a short task at your desk, yes. Each command below holds the laptop awake only while Claude Code is running.\n\n```bash\n# macOS: prevent idle sleep for as long as claude runs\ncaffeinate -i claude\n\n# macOS, on power only: prevent system sleep (per the man page, -s works only on AC power)\ncaffeinate -s claude\n\n# Linux with systemd: hold off sleep and lid-switch handling while claude runs\nsystemd-inhibit --what=sleep:handle-lid-switch claude\n```\n\nOn Windows, set what closing the lid does in Control Panel, under Power Options, to \"Do nothing\".",
        "`caffeinate` doesn't keep a MacBook awake with the lid closed. Apple describes lid-closed use in closed-display mode, with power connected, an external display and a keyboard or mouse attached ([Apple Support](https://support.apple.com/en-in/117373)). A laptop left running inside a bag can also get hot, and a reboot, a dropped network or a move to a different Wi-Fi network still ends the run. Keeping a laptop awake is a patch. If the run matters, put it on a machine that's meant to stay on. If you do go the laptop route, the [keep-awake command builder](/tools/keep-mac-awake) writes the command for your setup and tells you what it won't cover.",
      ],
    },
    {
      heading: "Can I control it from my phone while the laptop is closed?",
      paragraphs: [
        "Depends which phone option you mean. Remote Control connects your phone or browser to a session that's still running on your computer, so that computer has to stay on and awake. It helps when you walk away from your desk. Shut the lid and leave, and the session sleeps with the laptop. The [Remote Control guide](/blog/claude-code-remote-control) has the commands, the two offline messages you can run into and how to keep the host machine online.\n\nClaude Code on the web runs on Anthropic's infrastructure, so the session keeps going after you close your laptop and you can check on it from any device ([Claude Code docs](https://code.claude.com/docs/en/claude-code-on-the-web)). A machine that stays on works too, reached over SSH or a browser view. On Hivra you can also send Claude Code work from your phone through the Telegram tab. Those runs execute on your Hivra computer.",
      ],
    },
    {
      heading: "Fix 1: tmux (or screen) on a machine that stays awake",
      paragraphs: [
        "Got an always-on machine (a desktop, a home server, a VPS)? Then tmux is the classic answer. It keeps your terminal session alive on that machine even after you disconnect. Anthropic's Remote Control docs recommend the same for a session on a remote machine: start it inside tmux or screen.\n\n```bash\n# Start a named session and launch Claude Code inside it\ntmux new -s claude\nclaude\n\n# Detach without killing anything: press Ctrl+b, then d\n\n# Later, from any connection:\ntmux attach -t claude\n\n# See what is running\ntmux ls\n```\n\nThe [tmux cheat sheet](/tools/tmux-cheat-sheet) has the keys and commands on one page.\n\nYour SSH connection can drop a hundred times and the session keeps working on the server. Reattach and you're back where the agent left off. The rule from the top still holds, though: tmux on your laptop doesn't survive sleep. It covers disconnects and closed terminal windows, and it can't do anything about a sleeping machine.",
        "Prefer `screen`? Same idea, older tool:\n\n```bash\nscreen -S claude    # start\n# Detach: Ctrl+a, then d\nscreen -r claude    # reattach\n```\n\ntmux is the better default in 2026. Panes, better scripting, active development. But screen ships preinstalled on more distros, and for this one job either works. To check your own setup for the usual ways these runs die, try the [agent survival check](/tools/agent-survival-check).",
      ],
    },
    {
      heading: "Fix 2: nohup for one-shot headless runs",
      paragraphs: [
        "You don't always need the interactive session. Claude Code has a headless mode (`claude -p`) that takes a prompt, runs it and exits. For fire-and-forget jobs, `nohup` keeps that run alive after you log out:\n\n```bash\nnohup claude -p \"run the test suite, fix any failures, and commit\" > run.log 2>&1 &\n\n# Check on it later\ntail -f run.log\n```\n\n`nohup` detaches the process from your terminal, so the logout SIGHUP never reaches it. That suits single tasks. It's the wrong tool for an ongoing interactive session, because you can't reattach and steer. Use tmux for that.",
      ],
    },
    {
      heading: "Fix 3: the DIY VPS route",
      paragraphs: [
        "No always-on machine at home? Rent one. Anthropic's system requirements for Claude Code list 4 GB of RAM, and a 4 GB server from a budget host runs roughly $5-10/month. Setup looks like this:\n\n```bash\n# 1. SSH into the fresh server\nssh root@your-vps-ip\n\n# 2. Install Claude Code with Anthropic's native installer\ncurl -fsSL https://claude.ai/install.sh | bash\n\n# 3. Authenticate (run claude once and follow the login flow)\nclaude\n\n# 4. Run it inside tmux so it survives your disconnects\ntmux new -s claude\nclaude\n```\n\nPrefer npm? `npm install -g @anthropic-ai/claude-code` installs the same binary and needs Node.js 22 or later. Then detach, close your laptop and go to sleep. The agent keeps working, and you can reattach from your phone over SSH if you want to check in.",
        "Beyond the server rent, the DIY route has other costs. Setup takes an hour or two if the steps go clean, and more if they don't. The login flow on a headless server means copying URLs and codes between machines. Then comes upkeep: OS updates, CLI updates, a disk filling up with logs. Small jobs, but they land on you at bad times.\n\nSecurity is yours too. The server sits on the public internet with your logged-in agent on it. SSH keys only, firewall on, fail2ban is a good idea. That's your job now. All you get is a terminal over SSH: no browser view of what the agent is doing, no file browser, nothing on mobile beyond a raw shell.",
      ],
    },
    {
      heading: "Fix 4: Anthropic's own cloud (Claude Code on the web)",
      paragraphs: [
        "If you only use Claude Code and your work lives in GitHub repositories, this may be all you need. A cloud session runs on machines Anthropic manages, and Anthropic's documentation says it keeps running after you close your laptop ([Claude Code docs](https://code.claude.com/docs/en/claude-code-on-the-web)). You start one from claude.ai/code, from the Claude app, or from the terminal with `claude --cloud`.\n\nThe same documentation, as checked on 30 September 2026, sets a few conditions. Cloud sessions are available on Pro, Max and Team plans, and to Enterprise users with eligible seats. The session clones a GitHub repository. You can send a local repository up as a bundle, but results can only be pushed back to GitHub.\n\nIdle sessions expire. A session stops after a period of inactivity and the machine is reclaimed. You can reopen it with its history, but work that was still running in the background isn't restored. Your own files, tools, logins and other agents stay behind too, since it's Anthropic's environment.\n\nA computer of your own makes sense when you want those things to stay put between tasks, or to run other agents beside Claude Code.",
      ],
    },
    {
      heading: "Fix 5: a computer of your own on Hivra",
      paragraphs: [
        `[Hivra](/) runs the official Claude Code CLI from Anthropic on a private virtual machine set up for you, a computer whose only job is running your agent. Hivra's chat runs the CLI with permission prompts bypassed by default inside that VM, and the Permissions setting on the agent's Manage tab narrows that to Limited or Read-only. The [skip-permissions guide](/blog/claude-code-dangerously-skip-permissions) lays out what bypassed prompts mean for your files, and which checks still run.\n\nAfter launch, you sign in with your own Anthropic account on the computer, the same login flow as on your laptop. The login is stored on that VM. Hivra sets up the machine and runs it for you, so there's no server admin on your side.\n\nIn practice:\n\n- ${CLI_RUN_LIFETIME}\n- Connect your own bot in the agent's Telegram tab, under Manage, and send Claude Code work from your phone.\n- You reach the computer from a browser. Chat, terminal, files, skills and browser tabs wrap the standard CLI, so you can check on it from your phone.\n- There's a live self-hosted browser too. The Claude Code computer ships browser automation, so the agent can drive a real Chrome browser on its own VM.\n\nLaunch it from [the Claude Code agent page](/agents/claude-code).`,
        `${PLAN_SUMMARY} The ${ENTRY_PLAN_PRICE} plan is ${ENTRY_PLAN_SIZE}, enough for Claude Code with its browser, and [the pricing page](/pricing) has the full details. Before you commit, check whether your current Claude subscription covers round-the-clock usage. The [Claude Code plan calculator](/tools/claude-code-plan-calculator) does that math, and [Claude Code pricing: Pro vs Max](/blog/claude-max-vs-pro-for-claude-code) sets out which plan fits and what Anthropic publishes about the limits. Hivra is independent and is not affiliated with Anthropic.`,
      ],
    },
    {
      heading: "DIY vs managed, side by side",
      paragraphs: [
        `| | DIY VPS + tmux | Hivra managed |\n|---|---|---|\n| Cash cost | $5-10/mo | From ${ENTRY_PLAN_PRICE}/mo (${ENTRY_PLAN_SIZE}) |\n| Setup | 1-2 hours of your time | Pick the agent, then sign in |\n| Keeps running with the laptop closed | Yes, inside tmux | Yes, inside tmux in the Terminal tab or sent through Telegram |\n| Interface | SSH terminal only | Browser: chat, terminal, files, skills |\n| Agent browser automation | You install and maintain it | Included on the Claude Code computer |\n| Server setup | You | Done for you |\n| Access to the machine | Your own SSH hardening | Private VM, reached through your Hivra dashboard |\n| Control over the machine | Total (root on your VPS) | Managed VM, resize CPU/RAM in the dashboard |\n\nIf you like running servers and want total control, DIY is a fine route, and it's cheap. If you want the agent working tonight without owning another Linux server, managed gets you there faster.`,
      ],
    },
    {
      heading: "Which fix should you pick?",
      paragraphs: [
        "- **Short task, you're at your desk:** `caffeinate -i claude` and leave the lid open.\n- **You already have an always-on machine:** tmux. Done. Costs nothing.\n- **One long task has to finish overnight:** `nohup claude -p` on any machine that stays awake.\n- **You only use Claude Code on GitHub repositories:** try Claude Code on the web first.\n- **You want a permanent 24/7 setup and you like sysadmin work:** a small VPS plus tmux, roughly $5-10/month.\n- **You want a permanent 24/7 setup without the sysadmin work:** [run Claude Code on Hivra](/agents/claude-code). Sign in with your own Anthropic account and the computer stays up. Start long runs inside tmux in its Terminal tab, or send them through Telegram, so they keep going after you close the laptop.",
      ],
    },
  ],
  faqs: [
    {
      q: "Will Claude Code keep running if I close my laptop?",
      a: "Not if it's running on the laptop. Closing the lid puts the laptop to sleep, which pauses every program on it, Claude Code included, until you wake it. For a run that keeps going with the lid shut, use Anthropic's cloud (Claude Code on the web) or a machine that stays on, with Claude Code inside tmux.",
    },
    {
      q: "Does locking my screen stop Claude Code?",
      a: "No. A locked screen isn't sleep, so programs keep running. What pauses Claude Code is the laptop going to sleep, which happens when its idle timer runs out or the lid closes. On a Mac, check the sleep settings in System Settings, under Battery, then Options.",
    },
    {
      q: "Does Claude Code keep running if my Mac goes to sleep?",
      a: "No. Sleep pauses every process. A Remote Control session reconnects when the machine wakes and a local session carries on, but nothing runs while the Mac sleeps. A request to Anthropic that was in flight when the Mac went to sleep may fail on wake.",
    },
    {
      q: "Can I close my laptop and use Claude Code from my phone?",
      a: "Only if Claude Code is running somewhere that stays on. Remote Control needs your computer to stay on and awake, so closing the lid cuts you off. Claude Code on the web runs on Anthropic's machines and keeps going. So does a computer that stays on, reached over SSH or a browser.",
    },
    {
      q: "Does tmux keep Claude Code running when I close my laptop?",
      a: "No. tmux covers disconnects and closed terminal windows, but when your laptop sleeps every process on it is suspended, tmux included. It only helps on a machine that stays awake: a desktop, a home server or a VPS.",
    },
    {
      q: "Can I run Claude Code on a VPS?",
      a: "Yes. Install it with Anthropic's native installer (curl -fsSL https://claude.ai/install.sh | bash), authenticate, and run it inside tmux so it survives SSH drops. Anthropic lists 4 GB of RAM in its system requirements, so pick a server with at least that much.",
    },
    {
      q: "How much does it cost to run Claude Code 24/7?",
      a: `DIY runs roughly $5-10/month for a 4 GB VPS from a budget host, plus your setup and maintenance time. On Hivra, plans start at ${ENTRY_PLAN_PRICE}/month for ${ENTRY_PLAN_SIZE}, and paid plans aren't paused for inactivity. Either way, your Claude usage bills through your own Anthropic account.`,
    },
    {
      q: "Do I need an API key to run Claude Code in the cloud?",
      a: "On Hivra, you don't need to set up a separate key for Claude Code. After launch you sign in with your own Anthropic account on the computer, the same login flow as on your laptop. The login is stored on the agent's VM.",
    },
    {
      q: "Does Hivra modify Claude Code?",
      a: "No. It's the official Claude Code CLI from Anthropic on a private VM. Hivra's chat runs it with permission prompts bypassed by default, and the agent's Manage tab can narrow that to Limited or Read-only. The chat, terminal, files, skills and browser tabs are a convenience layer around the standard CLI. Hivra is independent and is not affiliated with Anthropic.",
    },
    {
      q: "Does a Claude Code task on Hivra keep running when I close my laptop?",
      a: `Yes, if you start it inside tmux or send it through Telegram. ${CLI_RUN_LIFETIME}`,
    },
    {
      q: "What happens to a running task if my SSH connection drops?",
      a: "If Claude Code is running inside tmux or screen on the remote machine, nothing. The session keeps working and you reattach with tmux attach -t claude. If it's running bare in the SSH shell, the disconnect sends SIGHUP and the task dies.",
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
