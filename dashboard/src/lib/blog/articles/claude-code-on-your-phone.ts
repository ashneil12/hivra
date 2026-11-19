import { BlogArticle } from "../types";
import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE, PLAN_SUMMARY } from "../plan-facts";
import { CLI_RUN_LIFETIME } from "../runtime-facts";

// Written 2026-11-18 for "claude code mobile" (US 1,000 searches a month, KD 22) and "claude code on phone"
// (390 a month, KD 16, rising). It is the hub page: Remote Control depth stays in claude-code-remote-control, channels
// depth in control-claude-code-from-telegram, running it round the clock in keep-claude-code-running-24-7.
// Competing pages read for intent on 2026-11-18 (not used as fact sources): sealos.io/blog/claude-code-on-phone,
// zilliz.com/blog/3-easiest-ways-to-use-claude-code-on-your-mobile-phone, buildermethods.com/library/claude-code-on-mobile,
// skeptrune.substack.com (Termux + Tailscale), harper.blog/2026/01/05/claude-code-is-better-on-your-phone, flaviocopes.com.
// Primary sources, all fetched 2026-11-18:
// https://code.claude.com/docs/en/mobile (apps, Code tab, /mobile QR, which feature to use, limitations, permission modes, push)
// https://code.claude.com/docs/en/claude-code-on-the-web (plans, GitHub, --cloud, --teleport, expiry, limits, no separate VM charge)
// https://code.claude.com/docs/en/web-quickstart (steps, Default environment, permission modes, comparison table)
// https://code.claude.com/docs/en/cloud-environments (Trusted network access default)
// https://code.claude.com/docs/en/remote-control (requirements, commands, flags, limitations, tmux advice, 10 minute server-mode outage)
// https://code.claude.com/docs/en/channels (research preview, Telegram/Discord/iMessage, --channels, Bun, session must be open, plans)
// https://code.claude.com/docs/en/platforms (work when you are away from your terminal)
// https://code.claude.com/docs/en/feature-availability (per-plan table: cloud sessions, Remote Control, Channels, Dispatch)
// https://code.claude.com/docs/en/quickstart (install.sh, claude, login)
// https://support.claude.com/en/articles/13947068 (Dispatch: limited beta, desktop awake, Pro/Max/Ultra)
// https://github.com/tmux/tmux/wiki/Getting-Started (new -s, C-b d, attach -t, ls)
// https://blink.sh/ (Blink Shell: iOS and iPadOS, SSH and Mosh, $19.99/year after 2 weeks free; price not quoted in copy)
// https://termius.com/ (Termius: SSH client for macOS, Windows, Linux, iOS, Android)
// https://tailscale.com/kb/1193/tailscale-ssh (tailscale set --ssh; host on Linux or macOS)
// Hivra facts: dashboard/src/app/agents/content/claude-code.ts, lib/blog/runtime-facts.ts (CLI_RUN_LIFETIME),
// lib/blog/plan-facts.ts. Remote Control has NOT been tested on a Hivra computer, so no claim about it is made for Hivra.
// Not claimed: Claude plan prices, usage numbers, Mosh support in Termius, any Hivra mobile app.

export const claudeCodeOnYourPhone: BlogArticle = {
  slug: "claude-code-on-your-phone",
  title: "Claude Code on your phone: every way to use it from mobile (as of November 2026)",
  metaTitle: "Claude Code on Mobile: 4 Ways to Use It on a Phone",
  metaDescription:
    "Four ways to use Claude Code from your phone: cloud sessions, Remote Control, channels, or SSH with tmux. What each needs and where each one breaks.",
  publishedDate: "2026-11-18",
  lastModified: "2026-11-18",
  readingTimeMin: 13,
  author: "Hivra team",
  tagline: "There is no separate Claude Code app, but there are four real ways in.",
  intro:
    "You want to start a task, check on a long run or answer a question from your phone while the real work happens somewhere else. Claude Code can do that, but which route you pick decides what must stay switched on, which plan you need and what you can actually do from a small screen.",
  shortAnswer:
    "As of November 2026 there are four ways to use Claude Code from a phone: cloud sessions in the Claude app (they run on Anthropic's servers and need GitHub to clone and push), Remote Control (steers a session on your own computer), channels (Telegram, Discord or iMessage), or SSH into an always-on machine running tmux.",
  sections: [
    {
      heading: "The short version",
      paragraphs: [
        "Claude Code has no separate mobile app. Anthropic's docs say so directly: the Claude app for [iOS](https://apps.apple.com/us/app/claude-by-anthropic/id6473753684) and [Android](https://play.google.com/store/apps/details?id=com.anthropic.claude) is a client for Claude Code sessions, not a place where code runs. You find them under the **Code** tab ([Claude Code on mobile](https://code.claude.com/docs/en/mobile)).",
        "So the real question is where Claude Code runs while your phone watches it. There are four answers:",
        "- **On Anthropic's servers** (cloud sessions, also called Claude Code on the web). Works with your laptop off and your phone in a drawer. Needs a GitHub repository.\n- **On your own computer, steered from the phone** (Remote Control). You get your local files, tools and MCP servers, but that computer has to stay on.\n- **On your own computer, reached through a chat app** (channels for Telegram, Discord and iMessage). Good for quick questions and alerts. Research preview.\n- **On a machine you manage, reached over SSH** (the DIY route). A phone terminal app plus tmux on a server or home machine that stays on.",
      ],
    },
    {
      heading: "The four routes compared",
      paragraphs: [
        [
          "| Route | Where Claude Code runs | What must stay on | Plan you need | Main limits |",
          "|---|---|---|---|---|",
          "| Cloud sessions (Code tab, claude.ai/code) | Anthropic-managed cloud VM by default | Nothing of yours | Pro, Max, Team, or Enterprise with a premium or Chat + Claude Code seat | Needs GitHub (a non-GitHub repo can be uploaded as a bundle but can't push back); idle sessions expire; Accept edits, Plan and Auto modes only (Auto only if your organization allows it); shares your plan's usage limits |",
          "| Remote Control | Your own computer | The computer, and the `claude` process on it | Pro, Max, Team or Enterprise; no API keys; Team and Enterprise need an admin to enable it | Local terminal-only commands such as `/plugin` and `/resume` don't work from the app; goes offline if the process stops |",
          "| Channels (Telegram, Discord, iMessage) | Your own computer, in a session you left open | The computer and the open session | Pro and Max users opt in themselves; Team and Enterprise need an admin; Console API keys also work | Research preview; events only arrive while the session is open; iMessage needs macOS and Bun is required |",
          "| SSH + tmux | A server or home machine you run | The machine, and a tmux session on it | Whatever you already use to sign in to Claude Code | You set it up and secure it; typing on a phone keyboard |",
          "| Dispatch | The Claude Desktop app on your computer | The computer awake, with the app open | Pro or Max per the docs; the support article says limited beta and not open to new users | Docs list it as not available on Team or Enterprise; needs the Desktop app |",
          `| Hivra computer | Official Claude Code CLI on a computer of its own | The computer, and the active tmux session on it | A paid Hivra plan (from ${ENTRY_PLAN_PRICE} a month for ${ENTRY_PLAN_SIZE}), plus model access through your own Anthropic sign-in or Hivra credits | Terminal in a browser; long runs go in tmux |`,
        ].join("\n"),
        "Plan requirements come from Anthropic's [feature availability table](https://code.claude.com/docs/en/feature-availability), the cloud sessions page and the Remote Control page. Cloud sessions and Remote Control both need a claude.ai account, so they don't work with an Anthropic Console API key or through Amazon Bedrock, Google Cloud's Agent Platform or Microsoft Foundry.",
      ],
    },
    {
      heading: "Route 1: cloud sessions in the Claude app",
      paragraphs: [
        "This is the closest thing to a real mobile Claude Code. You describe a task in the app, Claude Code clones your repository into an isolated VM on Anthropic's infrastructure, works on it and pushes a branch. Closing the app doesn't stop it. Anthropic's docs describe cloud sessions as the choice when \"the task should keep running after you put your phone away\" ([mobile docs](https://code.claude.com/docs/en/mobile)).",
        "**Set it up once** ([cloud quickstart](https://code.claude.com/docs/en/web-quickstart)):\n\n1. Install the Claude app and sign in with the same claude.ai account you use for Claude Code. On an iPad, install the same iOS app. Running `/mobile` inside Claude Code shows a QR code that opens the right app store.\n2. Tap **Code**, or open claude.ai/code/new on your phone.\n3. Connect GitHub when prompted (on Team and Enterprise, an Owner must first turn on the GitHub connector). A session can clone any public repository, but private repositories need the Claude GitHub App installed on them. If you already use the GitHub CLI, running `/web-setup` in Claude Code connects GitHub using your `gh` token instead. On Team and Enterprise it only works once an Owner turns on Quick setup.\n4. Pro and Max accounts get a **Default** environment created for them, with Trusted network access. Team and Enterprise accounts create it in a short form, unless an Owner has turned on Quick setup.",
        "**Start a task:** pick a repository and branch, choose a permission mode, describe the task and submit. Each task gets its own session and branch, so you can start several. When Claude is done, open the diff, comment on lines, and tap **Create PR**.",
        "From a terminal, `claude --cloud \"your task\"` creates a cloud session for the current repository, and `claude --teleport` pulls one back down to your terminal. From the CLI the handoff is one-way: you can pull a cloud session down, but you can't push an existing terminal session up.",
        "**What to know before you rely on it:**\n\n- **Plans.** Cloud sessions are available on Pro, Max and Team plans, and on Enterprise with a premium seat or a Chat + Claude Code seat. There's no separate charge for the VM, but sessions count toward your plan's usage limits, and running tasks in parallel uses them up faster.\n- **GitHub.** Cloning and pull requests need GitHub. A GitLab or Bitbucket repo can be uploaded as a local bundle with `CCR_FORCE_BUNDLE=1`, but the session can't push back to that remote.\n- **Permission modes.** Cloud sessions offer Accept edits, Plan and Auto, and Auto appears only when your organization allows it and the model supports it. There is no Manual and no Bypass permissions.\n- **Network.** The default environment reaches common package registries and allowlisted domains and nothing else. Change that per environment.\n- **Idle expiry.** Cloud sessions stop after a period of inactivity and the VM is reclaimed. Reopening one gives you a fresh VM with your conversation history, but background shell commands, subagents and scheduled tasks you set up inside the session are not restored.\n- **Not your machine.** It sees the repository, not your local config, tools or MCP servers.",
        "If your code lives on GitHub and the task is well defined, start here. It's the only route where nothing of yours has to stay on.",
      ],
    },
    {
      heading: "Route 2: Remote Control, a window into a session on your computer",
      paragraphs: [
        "Remote Control connects the Claude app or claude.ai/code to a Claude Code session that keeps running on your own machine. Your filesystem, MCP servers and project settings stay available, and the conversation stays in sync between the terminal and the phone. The catch is in Anthropic's own words: the web and mobile interfaces are a window into that local session, so your computer has to stay on and the `claude` process has to keep running ([Remote Control docs](https://code.claude.com/docs/en/remote-control)).",
        "The quick version:\n\n```\nclaude remote-control\n```\n\nPress the spacebar to show a QR code, scan it, or open the Claude app, tap **Code** and pick the session (a computer icon with a green dot means it's online). Already in a session? Type `/remote-control`. It needs a Pro, Max, Team or Enterprise plan, and Team and Enterprise need an Owner to switch it on first. API keys are not supported.",
        "Two limits matter on a phone. From the app you can pick Manual, Accept edits or Plan, and Auto when auto mode is available to the session, but not Bypass permissions. And in server mode, if your machine is awake but loses the network, Claude Code gives up after roughly 10 minutes and the process exits. If you run it on a remote machine, Anthropic's docs say to start it inside tmux or screen so it survives you disconnecting from SSH.",
        "Everything else, including the \"Can't reach your computer\" errors and how to keep the session alive, is in our full guide: [Claude Code Remote Control](/blog/claude-code-remote-control).",
      ],
    },
    {
      heading: "Route 3: channels, a chat app wired to a running session",
      paragraphs: [
        "Channels push messages into a Claude Code session that's already running on your computer, and Claude can reply in the same chat. Telegram, Discord and iMessage are the three that ship in the research preview ([channels docs](https://code.claude.com/docs/en/channels)).",
        "For Telegram the shape is: create a bot with BotFather, install the plugin with `/plugin install telegram@claude-plugins-official`, save the token with `/telegram:configure`, restart with the flag below, then pair your account and set the allowlist policy.\n\n```\nclaude --channels plugin:telegram@claude-plugins-official\n```",
        "What to know: the plugins need Bun. iMessage needs macOS and reads your Messages database, so it can't run on a Linux server. Events only arrive while the session is open, so for an always-on setup Anthropic says to run Claude in a background process or persistent terminal. If Claude hits a permission prompt while you're away, the session pauses until you respond, unless the channel supports permission relay. Pro and Max users without an organization skip the admin checks, and Team and Enterprise organizations must enable channels. Channels are also one of the few phone routes that work with a Console API key. Because it's a research preview, the flag and protocol may change.",
        "Setup for all three, with the access rules, is in [Claude Code Channels: Telegram, Discord and iMessage](/blog/control-claude-code-from-telegram).",
      ],
    },
    {
      heading: "Route 4: SSH from your phone into an always-on machine",
      paragraphs: [
        "This is the do-it-yourself route, and it needs no Anthropic remote feature at all. You run Claude Code in tmux on a machine that stays on, and use a terminal app on your phone to connect. It's the most flexible route, and the one where you do all the work.",
        "**1. Get a machine that stays on.** A cheap VPS, a home server or a spare desktop. Install Claude Code with Anthropic's installer, then run `claude` once and sign in:\n\n```\ncurl -fsSL https://claude.ai/install.sh | bash\nclaude --version\nclaude\n```\n\nStep 2 needs tmux. Check with `tmux -V`, and if it is missing, install it, for example `sudo apt install tmux` on Ubuntu or Debian.\n\nOn first use Claude Code prompts you to log in, and your credentials are stored so you don't repeat it ([quickstart](https://code.claude.com/docs/en/quickstart)). If that machine is a Linux server, [Claude Code on Linux](/blog/claude-code-on-linux) has the full install and SSH sign-in steps. A Windows PC is a poor fit for this route: tmux needs WSL, and WSL can shut its Linux VM down once nothing on the Windows side is using it, which ends the tmux session. Use a Linux machine here, and see [Claude Code on Windows](/blog/claude-code-on-windows) for running it at your desk.",
        "**2. Run it inside tmux.** tmux keeps the terminal session alive on the machine when your phone drops the connection:\n\n```\ntmux new -s claude\nclaude\n# detach with Ctrl+b then d\ntmux ls\ntmux attach -t claude\n```\n\nThose are the commands from the [tmux wiki](https://github.com/tmux/tmux/wiki/Getting-Started), and our [tmux cheat sheet](/tools/tmux-cheat-sheet) has the rest. Your SSH connection can drop as often as it likes. The agent keeps working, and you reattach to find it where it was.",
        "**3. Install an SSH app on your phone.** [Termius](https://termius.com/) is an SSH client for iOS and Android. [Blink Shell](https://blink.sh/) is an iOS and iPadOS terminal with both SSH and Mosh built in, and its site says connections stay intact after the device sleeps.",
        "**4. Don't expose the server carelessly.** Use SSH keys and turn off password logins. If you'd rather not open port 22 to the internet, Tailscale can put the machine and your phone on a private network, and `tailscale set --ssh` lets Tailscale handle SSH authentication on a Linux host ([Tailscale SSH](https://tailscale.com/kb/1193/tailscale-ssh)). A Mac can only host Tailscale SSH if it runs the open-source `tailscale` and `tailscaled` command-line variant, not the App Store or standalone app. Otherwise use standard SSH over the tailnet.",
        "**What it's like in practice.** You get the full Claude Code interface, every slash command and every permission mode, because you're simply in the terminal. You also get a phone keyboard and a narrow screen. It suits checking on a run or sending a short instruction better than writing code. Our guide to [keeping Claude Code running 24/7](/blog/keep-claude-code-running-24-7) covers the server side in more depth.",
      ],
    },
    {
      heading: "What about Dispatch and Slack?",
      paragraphs: [
        "**Claude Code in Slack** also starts a cloud session when you mention `@Claude` ([platforms page](https://code.claude.com/docs/en/platforms)). **Dispatch** lets you message a task from the Claude mobile app and have it run in the Claude Desktop app on your computer. Anthropic's docs list it for Pro and Max plans and not for Team or Enterprise, and the Claude Help Center article says the computer must be awake with the Desktop app open. The same help article also describes Dispatch as in limited beta and not open to new users, so you may not see it. Anthropic's docs describe it as a way to delegate work with minimal setup ([Dispatch article](https://support.claude.com/en/articles/13947068)).",
      ],
    },
    {
      heading: "Which route should you pick?",
      paragraphs: [
        "- **Your repo is on GitHub and you mostly delegate tasks:** cloud sessions. Nothing of yours has to stay on, and it's the most phone-friendly experience.\n- **You need your local files, tools or MCP servers, and your computer is on anyway:** Remote Control.\n- **You want a quick chat with Claude from the apps you already use:** channels, on Telegram or Discord.\n- **You want full control, any provider and a plain terminal:** SSH and tmux on a machine you run.\n- **You want the same thing without running the machine yourself:** a managed computer, covered next.",
        "For the plan side, see [Claude Code pricing: Pro vs Max](/blog/claude-max-vs-pro-for-claude-code). For the risks of leaving an agent alone, see [is it safe to leave an AI agent running unattended](/blog/is-it-safe-to-leave-an-ai-agent-running-unattended). Whatever the route, lock down who can message the agent and keep secrets out of the repo.",
      ],
    },
    {
      heading: "Route 5: a Claude Code computer on Hivra, opened from a browser",
      paragraphs: [
        "Hivra is the do-it-yourself route with the machine already taken care of. You launch Claude Code on a private cloud computer that is reserved for it, with the official Anthropic CLI already installed, and you reach its terminal, files and chat from a browser, wherever you are, with nothing to install. Hivra is not affiliated with Anthropic.",
        `**What you get.** ${PLAN_SUMMARY} Open the computer's Terminal tab, start \`tmux\` and run \`claude\` inside it. ${CLI_RUN_LIFETIME} Your files, repositories and Claude Code login stay on the computer, so you return to the same workspace from any device.`,
        "**You aren't locked into one agent.** The same Hivra account launches [Hermes](/agents/hermes), [OpenClaw](/agents/openclaw), [Claude Code](/agents/claude-code), [Codex](/agents/codex) and [Agent Zero](/agents/agent-zero), each on a computer of its own. You can try Claude Code and Codex side by side without a second account or server, and manage all of them from the same account. Our [Claude Code vs Codex comparison](/blog/claude-code-vs-codex-24-7) goes through the trade-offs.",
        "**Why it can beat the other routes.**\n\n- **No machine to run.** No VPS to patch, no SSH keys to manage and no home PC left on. The computer stays on with a paid plan.\n- **No GitHub requirement.** It's a normal computer with a terminal and files, so your repository can come from anywhere, and the agent can use the tools you install.\n- **Easy to reach.** The browser terminal and files avoid a separate SSH app, and the agent's Telegram tab, under Manage, is there if you want to send work from chat.\n- **Your own sign-in.** Sign in with your own Anthropic account on the computer, or pick Hivra credits when you launch and Claude Code runs on Claude models through Venice. Hivra hosting does not include or replace an Anthropic subscription.",
        "**Where another route fits better.** If your code is on GitHub and the tasks are self-contained, Anthropic's cloud sessions already cover the use case on the plan you have. If you want the native Claude app experience, Remote Control gives you that, and we haven't tested it on a Hivra computer, so we don't promise it there. Typing into a terminal in a phone browser is still typing into a terminal. And Hivra administrators retain infrastructure access to the managed computers, so keep truly secret material off a hosted machine.",
        "[Launch Claude Code on Hivra](/agents/claude-code) if you want the always-on machine without being its sysadmin.",
      ],
    },
    {
      heading: "The bottom line",
      paragraphs: [
        "For most people on a Claude plan, the answer is cloud sessions from the Claude app: it's built for phones and needs nothing running at home. When the work needs your local machine, add Remote Control or a channel and keep that machine on. When you want full control, rent or build an always-on machine and SSH in over tmux.",
        "And if you'd rather have that always-on computer without maintaining it, Hivra gives Claude Code one of its own, reachable from a browser, with Hermes, OpenClaw, Codex and Agent Zero available from the same account whenever you want to try them.",
      ],
    },
  ],
  faqs: [
    {
      q: "Is there a Claude Code mobile app?",
      a: "No separate one. The Claude app for iOS and Android has a Code tab that acts as a client for Claude Code sessions: cloud sessions on Anthropic's servers, or a session on your own computer through Remote Control. The code doesn't run on the phone.",
    },
    {
      q: "Can I use Claude Code on my phone without my computer being on?",
      a: "Yes, with cloud sessions, which run on Anthropic's infrastructure and need GitHub for cloning and pushing (a repo elsewhere can be uploaded as a local bundle but can't push back), or with an always-on machine you reach over SSH. Remote Control, channels and Dispatch drive your own computer, so it has to stay on.",
    },
    {
      q: "Which Claude plan do I need for Claude Code on mobile?",
      a: "Cloud sessions are on Pro, Max and Team, and on Enterprise with a premium or Chat + Claude Code seat. Remote Control and channels are on Pro and Max, and on Team and Enterprise once an admin enables them. Console API keys don't work for cloud sessions or Remote Control, but channels accept them.",
    },
    {
      q: "Does Claude Code on the web cost extra?",
      a: "Anthropic says there is no separate charge for the cloud VM. Cloud sessions count toward your plan's usage limits alongside your other Claude and Claude Code usage, so heavy parallel use drains them faster.",
    },
    {
      q: "Can I run Claude Code on Android?",
      a: "Yes. The Claude app on Google Play has the same Code tab as the iOS app, and Termius offers an SSH client for Android if you prefer the DIY route. Blink Shell is iOS and iPadOS only.",
    },
    {
      q: "Do I need GitHub to use Claude Code from my phone?",
      a: "For cloud sessions, yes, for cloning and pull requests. A non-GitHub repo can be uploaded as a local bundle but can't be pushed back. Remote Control, channels and SSH don't need GitHub, because they work on files on a machine you control.",
    },
    {
      q: "Is it safe to leave Claude Code running while I'm away from my desk?",
      a: "It can be, with care. Limit who can message the agent, keep secrets out of the repo, set a spending cap and avoid bypassing permission prompts unless the environment is one you trust. Cloud sessions run in isolated VMs with limited network access by default.",
    },
    {
      q: "What is the best way to use Claude Code from a phone?",
      a: "For most people, cloud sessions in the Claude app. If your work depends on local files or tools, use Remote Control with a computer that stays on, or an SSH and tmux setup. A managed computer such as Hivra's removes the server upkeep from that last route.",
    },
  ],
  relatedArticles: [
    { slug: "claude-code-on-windows", title: "Claude Code on Windows: install natively, in WSL, or on a Linux computer (as of November 2026)" },
    { slug: "claude-code-remote-control", title: "Claude Code Remote Control: how it works and how to keep it online" },
    { slug: "control-claude-code-from-telegram", title: "Claude Code Channels: Telegram, Discord and iMessage" },
    { slug: "keep-claude-code-running-24-7", title: "Will Claude Code keep running if you close your laptop? (And how to run it 24/7)" },
    { slug: "claude-max-vs-pro-for-claude-code", title: "Claude Code pricing: Pro vs Max, and when API billing is cheaper" },
    { slug: "claude-code-vs-codex-24-7", title: "Claude Code vs Codex for 24/7 autonomous work: which should you host?" },
  ],
  relatedComparisons: [{ slug: "vs-self-hosted", title: "Hivra vs self-hosted VPS" }],
};
