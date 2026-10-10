import { BlogArticle } from "../types";
import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE, PLAN_SUMMARY } from "../plan-facts";
import { CLI_RUN_LIFETIME } from "../runtime-facts";

// Rewritten 2026-09-30 from Search Console: about 20,000 impressions a month come from "will Claude keep running if I
// close / lock my laptop" questions at position 7 to 10 with almost no clicks, because the old page never answered them.
// Facts checked 2026-09-30: Claude Code docs (Remote Control; Claude Code on the web), the macOS caffeinate man page,
// Apple Support (closed-display use, sleep settings). Re-check the Anthropic pages before editing the table.
// Extended 2026-10-07: most top queries say plain "Claude" and ask about locking or sleep, and many mean the Claude
// desktop app (Cowork, scheduled tasks). Lock/sleep/lid section facts, fetched 2026-10-07:
// support.claude.com articles 13345190 (get started with Cowork), 15520349 (Cowork on web, desktop and mobile;
// Pro and Max moved to the cloud on 6 Oct 2026), 13854387 (Cowork scheduled tasks), 13947068 (Dispatch),
// 14128542 (computer use), 16761823 (Cowork and chat are one Claude); code.claude.com/docs/en/desktop-scheduled-tasks
// and /desktop; Apple mh10330 (closing the display sleeps a Mac laptop); Microsoft "Shut down, sleep, or hibernate
// your PC" and the lid switch close action page; Apple's MacBook Pro external display guide for lid-closed use.
// Only the Remote Control docs touch locking (screen-lock listener for phone notifications); the Cowork and desktop
// pages don't, and nothing says what happens to a plain chat reply mid-answer or to computer use behind a lock:
// keep those as stated gaps, not guesses. The lock column of the table is our reading, and the copy says so.
// Hivra runs Claude Code (CLI) only. Never claim it runs the Claude desktop app or Cowork.
export const article: BlogArticle = {
  slug: "keep-claude-code-running-24-7",
  title: "Will Claude keep running if you close your laptop or lock it? (And how to run Claude Code 24/7)",
  metaTitle: "Will Claude keep running if I close or lock my laptop?",
  metaDescription:
    "Locking your screen doesn't put your computer to sleep. Closing the lid usually does. Here's what that means for the Claude app, Cowork and Claude Code.",
  publishedDate: "2026-07-15",
  lastModified: "2026-10-07",
  readingTimeMin: 12,
  author: "Hivra team",
  tagline: "Locking won't sleep your computer. A closed lid usually will. Here's what keeps running.",
  intro:
    "Closing the lid stops a long Claude Code run, and some tasks in the Claude app too. Below: what locking, sleep and a closed lid each do to Claude, then five fixes that keep Claude Code going while you're away, from a one-line command to a computer of its own.",
  shortAnswer:
    "Locking the screen doesn't put the computer to sleep, so local Claude work keeps running. Sleep stops it, and closing a laptop's lid normally sleeps it. New Cowork tasks on Pro and Max plans run in Anthropic's cloud and keep going. So does Claude Code on a computer that stays on, such as a server running it in tmux.",
  sections: [
    {
      heading: "What keeps running when you close the lid",
      paragraphs: [
        "A sleeping laptop runs nothing. Every program freezes, so a Claude Code session on the laptop pauses when the lid closes and picks up again when you wake it. A request to Anthropic that was in flight at that moment may fail when the laptop comes back. Anthropic's docs say the same about Remote Control: if your laptop sleeps or your network drops, the session reconnects once the machine is back online ([Claude Code docs](https://code.claude.com/docs/en/remote-control)).",
        "| Where Claude Code runs | Keeps going with the lid shut? | What to know |\n|---|---|---|\n| Your laptop, as it comes | No | The session pauses and resumes when you wake the laptop. |\n| Your laptop, kept awake on purpose | Only with the right setup | `caffeinate` stops idle sleep on a Mac but doesn't stop a closed lid from sleeping it. See the keep-awake section below. |\n| Your laptop, controlled from your phone with Remote Control | No | It's a window into the session on your machine. Anthropic's docs say the computer has to stay on and the `claude` process has to keep running. |\n| Claude Code on the web (Anthropic's cloud) | Yes | Runs on Anthropic's machines. Needs a paid Claude plan and works from a GitHub repository. An idle session can expire. |\n| A machine that stays on, with Claude Code inside tmux | Yes | tmux keeps the session alive through disconnects. The machine itself must stay on: a desktop, a home server or a VPS. |\n| A Hivra computer, run inside tmux in its Terminal tab | Yes | See Fix 5 for which runs are covered. |",
      ],
    },
    {
      heading: "Lock, sleep or close the lid: what happens to Claude?",
      paragraphs: [
        "Locking puts a password in front of the screen. It doesn't put the computer to sleep, so its programs keep running. Sleep is what stops work. A sleeping computer doesn't run your programs until you wake it, and it drops into sleep by itself once its idle timer runs out.\n\nClosing the lid is the fast way to sleep a laptop. Apple says closing the display puts a Mac laptop to sleep ([Apple Support](https://support.apple.com/guide/mac-help/put-your-mac-to-sleep-or-wake-it-mh10330/mac)). Microsoft says a lot of Windows PCs, especially laptops, do the same when you close the lid ([Microsoft Support](https://support.microsoft.com/en-us/windows/experience/power-battery/shut-down-sleep-or-hibernate-your-pc)). So for anything running on your own computer, one question decides it: will the computer sleep?",
        "The Claude app is where people get caught out. Some of its work runs on Anthropic's servers and some runs on your computer, and the two behave differently. The sleep column is what Anthropic's help center and docs say, as of October 2026. The lock column is our reading of them, and the paragraph after the table explains why.\n\n| What you're running | Screen locked | Asleep, or lid closed |\n|---|---|---|\n| Claude Code in a terminal, or a Local session in Claude Code Desktop | Keeps running | Pauses until the computer wakes |\n| A new Cowork task on a Pro or Max plan | Keeps running | Keeps running in Anthropic's cloud |\n| A Cowork task you started on your computer before the move to the cloud | Keeps running while the app is open | May end. Anthropic says to keep the app open the whole time |\n| A new Cowork scheduled task that doesn't need local files or apps | Runs on time | Runs on time in the cloud |\n| A Cowork task that reads your local files or uses the app's browser | Keeps running while the app is open | The task carries on in the cloud, but it can't reach your files while the computer sleeps |\n| Dispatch, sending tasks from your phone to your desktop (closed to new users) | Keeps running | Doesn't run. Anthropic says the computer must be awake with the app open |\n| A local scheduled task in Claude Code Desktop | Runs on time | Skipped, with one catch-up run when the computer wakes |\n| A Cloud session in Claude Code Desktop, or Claude Code on the web | Keeps running | Keeps running on Anthropic's machines |\n\nAnthropic moved new Cowork tasks on Pro and Max plans to its cloud. They keep going when you close your laptop, and their scheduled tasks run with no device online ([Claude Help Center](https://support.claude.com/en/articles/15520349-use-claude-cowork-on-web-desktop-and-mobile)). Tasks you'd already started on your computer before that move stay there, and Anthropic says those may end if the app closes or the computer sleeps ([Claude Help Center](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork)). A scheduled task that needs local files or apps only runs locally ([Claude Help Center](https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-claude-cowork)). On Team and Enterprise plans, Cowork in the cloud is still in beta.\n\nClaude Code Desktop is stricter. Its local scheduled tasks only fire while the app is open and the computer is awake. If the computer sleeps through a run, it's skipped, and on wake the app starts one catch-up run for the most recent miss in the last seven days ([Claude Code docs](https://code.claude.com/docs/en/desktop-scheduled-tasks)). Cloud sessions keep going even if you close the app or shut the computer down ([Claude Code docs](https://code.claude.com/docs/en/desktop)).",
        "Why the lock column says what it does: Anthropic's Cowork and desktop pages don't mention locking. For Dispatch and computer use they say your computer needs to be awake with the Claude Desktop app open, and a locked computer is still awake. The Claude Code Remote Control docs go a step further and suggest switching phone notifications on when your screen locks, which only makes sense if Claude Code is still working behind the lock ([Claude Code docs](https://code.claude.com/docs/en/remote-control)). What Anthropic doesn't say is whether computer use, browser use or Dispatch can do their clicking and typing while the screen is locked. If a task depends on those, test it before you walk away.\n\nAnd a plain chat? Anthropic's new combined Claude experience, rolling out gradually to Pro and Max plans first, keeps more involved tasks running in the cloud if you close your laptop or leave the page ([Claude Help Center](https://support.claude.com/en/articles/16761823-claude-cowork-and-chat-are-one-claude)). For an ordinary chat reply that's halfway written when the laptop sleeps, Anthropic's docs don't say.",
        "Mac or Windows? Anthropic's rules are the same on both. What differs is the lid. On Windows, closing the lid is a setting. In Control Panel, under Power Options, the \"When I close the lid\" list sets what happens, and Windows supports Do nothing, Sleep, Hibernate and Shut down there, though Hibernate isn't offered on every PC ([Microsoft Support](https://support.microsoft.com/en-us/windows/experience/power-battery/shut-down-sleep-or-hibernate-your-pc), [Microsoft Learn](https://learn.microsoft.com/en-us/windows-hardware/customize/power-settings/power-button-and-lid-settings-lid-switch-close-action)). Pick Do nothing and the laptop stays awake with the lid shut. On a MacBook, Apple documents lid-closed use with an external display and accessories connected, covered further down.\n\nThe Claude app also has a **Keep computer awake** switch, in Settings, then This computer, then System. It stops idle sleep. Anthropic's own docs spell out the limit: closing the laptop lid still puts it to sleep ([Claude Code docs](https://code.claude.com/docs/en/desktop-scheduled-tasks)).\n\nYou set the idle timers yourself. On a Mac, the inactivity timers are in System Settings, under Lock Screen. On a Mac laptop, Battery, then Options, has a switch that stops automatic sleeping on the power adapter while the display is off ([Apple Support](https://support.apple.com/guide/mac-help/mchle41a6ccd/mac)).\n\nOne thing Hivra can't help with here: it doesn't run the Claude app or Cowork. What it runs is Claude Code, the terminal version, on a computer that stays on while you're on a paid plan. That's Fix 5 below.",
      ],
    },
    {
      heading: "Can I just keep the laptop awake?",
      paragraphs: [
        "For a short task at your desk, yes. Each command below holds the laptop awake only while Claude Code is running.\n\n```bash\n# macOS: prevent idle sleep for as long as claude runs\ncaffeinate -i claude\n\n# macOS, on power only: prevent system sleep (per the man page, -s works only on AC power)\ncaffeinate -s claude\n\n# Linux with systemd: hold off sleep and lid-switch handling while claude runs\nsystemd-inhibit --what=sleep:handle-lid-switch claude\n```\n\nOn Windows, set what closing the lid does in Control Panel, under Power Options, to \"Do nothing\".",
        "`caffeinate` doesn't keep a MacBook awake with the lid closed. Apple documents closing the lid with an external display connected ([Apple Support](https://support.apple.com/guide/macbook-pro/connect-an-external-display-apd8cdd74f57/mac)), and its dual-display guide lists an external keyboard and mouse or trackpad and power among the requirements ([Apple Support](https://support.apple.com/en-in/117373)). A laptop left running inside a bag can also get hot, and a reboot, a dropped network or a move to a different Wi-Fi network still ends the run. Keeping a laptop awake is a patch. If the run matters, put it on a machine that's meant to stay on. If you do go the laptop route, the [keep-awake command builder](/tools/keep-mac-awake) writes the command for your setup and tells you what it won't cover.",
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
        "Got an always-on machine (a desktop, a home server, a VPS)? Then tmux is the classic answer. It keeps your terminal session alive on that machine even after you disconnect. Anthropic's Remote Control docs recommend the same for a session on a remote machine: start it inside tmux or screen.\n\n```bash\n# Start a named session and launch Claude Code inside it\ntmux new -s claude\nclaude\n\n# Detach without killing anything: press Ctrl+b, then d\n\n# Later, from any connection:\ntmux attach -t claude\n\n# See what is running\ntmux ls\n```\n\nThe [tmux cheat sheet](/tools/tmux-cheat-sheet) has the keys and commands on one page. If the CLI process itself exited and you need the chat history back, [resume a Codex or Claude Code session](/blog/codex-resume-session) covers the resume commands.\n\nYour SSH connection can drop a hundred times and the session keeps working on the server. Reattach and you're back where the agent left off. The rule from the top still holds, though: tmux on your laptop doesn't survive sleep. It covers disconnects and closed terminal windows, and it can't do anything about a sleeping machine.",
        "Prefer `screen`? Same idea, older tool:\n\n```bash\nscreen -S claude    # start\n# Detach: Ctrl+a, then d\nscreen -r claude    # reattach\n```\n\ntmux is the better default today. Panes, better scripting, active development. But screen ships preinstalled on more distros, and for this one job either works. To check your own setup for the usual ways these runs die, try the [agent survival check](/tools/agent-survival-check).",
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
        "If you only use Claude Code and your work lives in GitHub repositories, this may be all you need. A cloud session runs on machines Anthropic manages, and Anthropic's documentation says it keeps running after you close your laptop ([Claude Code docs](https://code.claude.com/docs/en/claude-code-on-the-web)). You start one from claude.ai/code, from the Claude app, or from the terminal with `claude --cloud`.\n\nThe same docs set a few conditions. Cloud sessions are available on Pro, Max and Team plans, and to Enterprise users with eligible seats. The session clones a GitHub repository. You can send a local repository up as a bundle, but results can only be pushed back to GitHub.\n\nIdle sessions expire. A session stops after a period of inactivity and the machine is reclaimed. You can reopen it with its history, but work that was still running in the background isn't restored. Your own files, tools, logins and other agents stay behind too, since it's Anthropic's environment.\n\nA computer of your own makes sense when you want those things to stay put between tasks, or to run other agents beside Claude Code.\n\nIf you use Codex too, you've got the same choice with OpenAI's cloud. [Codex cloud or your own computer](/blog/run-codex-24-7-in-the-cloud) lines the routes up with dates, and says when OpenAI's cloud is enough. Using Cursor? Same question, different answer. [Cursor Cloud Agents](/blog/cursor-cloud-agents) covers what it costs to let Cursor work with the lid shut, and [Cursor vs Claude Code](/blog/cursor-vs-claude-code) helps you pick between the two.",
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
        "- **You use the Claude app, not the terminal:** on Pro and Max plans, new Cowork tasks already run in Anthropic's cloud. Keep the app open on an awake computer only when a task needs your files, browser or apps.\n- **Short task, you're at your desk:** `caffeinate -i claude` and leave the lid open.\n- **You already have an always-on machine:** tmux. Done. Costs nothing.\n- **One long task has to finish overnight:** `nohup claude -p` on any machine that stays awake.\n- **You only use Claude Code on GitHub repositories:** try Claude Code on the web first.\n- **You want a permanent 24/7 setup and you like sysadmin work:** a small VPS plus tmux, roughly $5-10/month.\n- **You want a permanent 24/7 setup without the sysadmin work:** [run Claude Code on Hivra](/agents/claude-code). Sign in with your own Anthropic account and the computer stays up. Start long runs inside tmux in its Terminal tab, or send them through Telegram, so they keep going after you close the laptop.",
      ],
    },
  ],
  faqs: [
    {
      q: "Will Claude keep running if I close my laptop?",
      a: "Only what runs somewhere else: Anthropic's cloud, or another computer that stays on. Closing the lid normally puts a laptop to sleep. Claude Code on the laptop pauses until it wakes, local tasks in the Claude app may end, and local scheduled tasks are skipped. New Cowork tasks on Pro and Max plans keep going in Anthropic's cloud, and so does Claude Code in tmux on a server.",
    },
    {
      q: "Will Claude keep running if I lock my computer?",
      a: "Usually, yes. Locking doesn't put the computer to sleep, so Claude Code keeps running, and local work in the Claude app keeps going while the app is open. Cloud tasks don't need the app at all. The catch is the idle timer: if the computer falls asleep on its own later, local work stops. Anthropic's docs don't say whether computer use works behind a locked screen.",
    },
    {
      q: "Does Claude keep working if my computer goes to sleep?",
      a: "Only what runs somewhere else. New Cowork tasks on Pro and Max plans, Cowork's cloud scheduled tasks and Claude Code cloud sessions carry on, and so does Claude Code on a server that stays on. On the sleeping computer, Claude Code pauses until it wakes. A Remote Control session reconnects once the machine is back online.",
    },
    {
      q: "Do Claude's scheduled tasks run while my computer is asleep?",
      a: "Cowork's do. Anthropic says they run remotely, so they fire on time with the computer asleep or the desktop app closed. Older ones that already ran on your computer stay there, and so does any task that needs local files or apps. Local scheduled tasks in Claude Code Desktop only run while the app is open and the computer is awake, and a missed run gets one catch-up when it wakes.",
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
      q: "Does Hivra modify Claude Code, and do I need an API key?",
      a: "No to both. It's the official Claude Code CLI from Anthropic on a private VM, and after launch you sign in with your own Anthropic account, the same login flow as on your laptop. The login is stored on that VM. Hivra's chat runs it with permission prompts bypassed by default, and the agent's Manage tab can narrow that to Limited or Read-only. The chat, terminal, files, skills and browser tabs are a convenience layer around the standard CLI. Hivra is independent and is not affiliated with Anthropic.",
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
    { slug: "codex-resume-session", title: "How to resume a Codex session (and Claude Code too)" },
    { slug: "run-codex-24-7-in-the-cloud", title: "Codex cloud, or Codex on a computer that stays on? Where to run it 24/7" },
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
