import { BlogArticle } from "../types";
import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE, LARGER_PLAN_PRICE, LARGER_PLAN_SIZE } from "../plan-facts";

// Written 2026-11-18 for the "codex mobile" searches (US 1,300/mo, difficulty 9; related "use codex cli from phone",
// "codex on iphone", "codex app"). Primary sources fetched 2026-11-18:
// https://openai.com/index/work-with-codex-from-anywhere/ (May 2026 announcement: Codex in the ChatGPT mobile apps,
//   preview, iOS and Android, connects to a laptop, Mac mini or managed remote environment, secure relay, all plans
//   including Free and Go, Windows desktop connection "coming soon" at launch, Remote SSH generally available)
// https://learn.chatgpt.com/docs/mobile.md and https://learn.chatgpt.com/codex/mobile (what you can do from the phone,
//   Cloud or a connected Mac/PC, keep the computer awake and online, "availability depends on rollout and your
//   workspace settings")
// https://learn.chatgpt.com/docs/remote-connections and .md (requirements, setup steps, QR pairing, host types,
//   Remote SSH steps, handoff limits, security advice, troubleshooting; Linux not listed as a host)
// https://learn.chatgpt.com/codex/cloud (start a cloud task, Work in > Cloud, environments, tasks keep running while
//   your computer sleeps, network options)
// https://learn.chatgpt.com/codex/pricing (plans including Codex; API key route excludes cloud features)
// https://learn.chatgpt.com/docs/cli (install, codex cloud command, codex resume)
// https://learn.chatgpt.com/docs/auth (auth.json treated like a password; ChatGPT sign-in opens a browser)
// https://github.com/openai/codex (install commands, platforms, sign-in)
// https://termius.com/ (iOS and Android SSH client) and https://blink.sh/ (iOS and iPadOS, Mosh, SSH)
// Device auth: the CLI command reference (learn.chatgpt.com/docs/developer-commands?surface=cli) says codex login supports
// "device auth"; the exact flag, beta label and ChatGPT security setting could not be confirmed on an OpenAI page, so the
// copy does not name them.
// Hivra facts: dashboard/src/app/agents/content/codex.ts, lib/blog/runtime-facts.ts, lib/blog/plan-facts.ts.
// Not claimed: that the ChatGPT mobile app can connect to a Hivra computer (untested, and OpenAI lists only
// macOS and Windows desktop-app hosts); Telegram for Codex; any Codex usage limit numbers.

export const codexMobile: BlogArticle = {
  slug: "codex-mobile",
  title: "Codex on mobile: how to use OpenAI Codex from your phone",
  metaTitle: "Codex mobile: every way to use Codex from your phone",
  metaDescription:
    "Use OpenAI Codex from an iPhone or Android phone: the ChatGPT app's Codex, cloud tasks, a computer you connect, or the CLI over SSH or a browser.",
  publishedDate: "2026-11-18",
  lastModified: "2026-11-18",
  readingTimeMin: 12,
  author: "Hivra team",
  tagline: "Codex fits in your pocket now, but it still needs a computer to do the work.",
  intro:
    "There is an official Codex in the ChatGPT mobile app, and it can do more than most people expect. It can also do less than the name suggests. Here is what it does, what it needs, and the other ways to reach Codex from a phone when it isn't the right fit.",
  shortAnswer:
    "As of November 2026, open Codex in the ChatGPT mobile app on iOS or Android (a preview). You can start cloud tasks if your workspace shows an environment, or steer Codex on your own Mac or Windows PC. For the Codex CLI itself, SSH into a machine that stays on.",
  sections: [
    {
      heading: "The short version: Codex on a phone is a remote control, not a phone-sized Codex",
      paragraphs: [
        "Nothing writes code on your phone. Codex always runs somewhere else: on OpenAI's computers (Codex cloud), or on a computer you own. The phone is the screen and the keyboard. That one idea explains every option below and every limit.",
        "As of November 2026 there are four real ways to use Codex from a phone:",
        "- **The Codex section of the ChatGPT mobile app, pointed at Cloud.** You start a task, Codex runs it on OpenAI's side, and you review the result on your phone.\n- **The same app, pointed at a computer you own.** You pair your phone with the ChatGPT desktop app on a Mac or Windows PC, then watch, approve and steer Codex work happening there.\n- **The Codex CLI on a machine that stays on, reached from your phone** with an SSH app and tmux. This is the do-it-yourself route, and the most direct way to get the actual terminal interface.\n- **The Codex CLI on a cloud computer with a terminal in the browser,** which you open in your phone's browser. Hivra works this way.",
              ],
    },
    {
      heading: "Option 1: Codex in the ChatGPT mobile app",
      paragraphs: [
        "OpenAI announced [Codex in the ChatGPT mobile apps](https://openai.com/index/work-with-codex-from-anywhere/) in May 2026, and it is labeled a preview. It runs on iOS and Android. OpenAI says the preview is available on all plans, including Free and Go, in all supported regions. OpenAI's own mobile page adds a caveat worth reading: [availability depends on rollout and your workspace settings](https://learn.chatgpt.com/docs/mobile). If you use ChatGPT through work, an admin may need to switch remote access on.",
        "In the app, open **Codex**. On iOS, OpenAI's docs say some app versions still label the same section **Remote**, so look for either name.",
        "**What you can do from the phone**, per OpenAI's docs:",
        "- Start a task, either in Cloud with an environment selected, or on a connected computer with a project selected.\n- Follow progress and send new instructions to a task that is already running.\n- Approve or deny the commands and actions Codex asks about before it carries on, on a connected computer.\n- Review the response, the changed files, the diffs and the test results, then decide what happens next.\n- See your tasks across Cloud and connected computers in one list, pick up an existing conversation, and see when Codex needs your input.",
        "**What it can't do.** It is not a place to run Codex by itself. The phone needs either Cloud or a connected computer behind it. It is not the CLI: you don't get a shell prompt, you get chats, approvals and diffs. And the connected-computer route has real host limits, covered next.",
      ],
    },
    {
      heading: "Option 1a: tasks in Codex cloud, started from the phone",
      paragraphs: [
        "This is the lowest-effort route. Choose Cloud when you start a task in the app. OpenAI's [cloud docs](https://learn.chatgpt.com/codex/cloud) say each task gets its own workspace and keeps running while your computer is asleep, so a task you start on the train keeps going after the phone locks.",
        "If the default environment appears in the picker, you can start from it without picking a repository. If it does not, pick a published environment you can access, which is a setup someone has already prepared. Cloud tasks need an environment that your account and workspace make available, so seeing Codex in the mobile app does not by itself mean you can start them. When it finishes, you review the changed files, ask for follow-ups, then commit or open a pull request.",
        "The catch is the shape of the work. Cloud tasks suit a self-contained change to a repository Codex can reach through a connected GitHub or GitLab account. For GitLab.com, if it shows in the repository picker, create a reusable environment on the web or in the desktop app first (Work in Cloud, Select environment, Create environment, then Publish); the mobile app then uses that environment. They don't give you your own machine's files, tools or half-finished state. OpenAI's pricing page also says cloud tasks may use more of your allowance than local messages, and that the API-key route to Codex excludes cloud features. For which plan includes what, see our [Codex pricing by ChatGPT plan](/blog/codex-pricing-by-chatgpt-plan) guide, and check OpenAI's page for your plan before you rely on cloud tasks, because the Free and Go details were not clear on the pricing page when we checked.",
      ],
    },
    {
      heading: "Option 1b: steering Codex on your own computer",
      paragraphs: [
        "The second mode is the one that makes the phone feel like a remote control. Codex keeps running on a computer you own, and the phone connects to it. OpenAI says files, credentials, permissions and local setup stay on that machine, and a secure relay keeps trusted machines reachable without exposing them to the public internet.",
        "**What you need** ([remote connections docs](https://learn.chatgpt.com/docs/remote-connections)):",
        "- Codex access in your ChatGPT account and workspace.\n- The latest ChatGPT mobile app on iOS or Android.\n- The latest ChatGPT desktop app on the host computer, awake, online and signed in to the same account and workspace.\n- Any MFA, SSO or passkey steps your account requires.",
        "**How to pair them.** Setup starts on the computer, in the desktop app. You can't set it up from the Codex CLI or an IDE extension.",
        "1. On the host, open the desktop app and go to **Settings > Connections > Control this Mac or PC**. Select **Set up** or **Add**, then approve remote access.\n2. Scan the QR code the app shows with your phone. Pair each phone with every host you want it to control, so repeat the step for each computer.\n3. In ChatGPT on the phone, confirm the same account and workspace and complete any sign-in checks. Then open Codex in the app to start work on that host.\n4. Back in **Settings > Connections** on the host, you can review host settings such as keeping the computer awake.",
        "",
        "**The limits that matter most:**",
        "- **The host must be a Mac or Windows PC running the desktop app.** OpenAI's docs list those two. Linux isn't listed as a host, and the docs don't describe pairing a phone with a bare Linux server running only the CLI.\n- **The computer has to stay awake and online.** If it sleeps or loses its network connection, phone access stops. A Mac laptop can keep going with the lid open and power connected, and with the lid closed only if an external display is attached. Choosing Sleep stops access.\n- **It's a preview.** Behavior and availability can change.",
        "That means the realistic version of this route is a computer that is always on, such as a spare Mac or a PC under a desk, with the desktop app signed in. OpenAI's announcement mentions a laptop or a dedicated Mac mini as examples of hosts. If you don't have one, the do-it-yourself and Hivra routes below fill the gap.",
        "The desktop app can also work with hosts from your SSH config (Remote SSH, which OpenAI says is generally available). You need Codex installed and signed in on the remote host. That is a feature of the desktop app, so you still need a Mac or Windows PC running it.",
      ],
    },
    {
      heading: "Option 2: run the Codex CLI on an always-on machine and SSH in from your phone",
      paragraphs: [
        "If you want the real Codex terminal on your phone, this is the oldest route and still the most flexible. The idea: Codex CLI runs inside tmux on a machine that stays on, and your phone connects to it over SSH. If the connection drops, the session carries on, and you reattach when you have signal again.",
        "**On the always-on machine** (a VPS, a home server or a spare computer), install the CLI. OpenAI's [GitHub README](https://github.com/openai/codex) lists these options:\n\n```bash\n# Mac or Linux\ncurl -fsSL https://chatgpt.com/codex/install.sh | sh\n\n# or with npm\nnpm install -g @openai/codex\n```\n\nThe CLI supports macOS (Apple Silicon and Intel) and Linux (x86_64 and arm64).",
        "**Sign in.** Run `codex` and sign in with ChatGPT. OpenAI recommends that with a Plus, Pro, Business, Edu or Enterprise plan. On a server with no browser, OpenAI's CLI reference says `codex login` also supports device auth, so check `codex login --help` for the exact option. See [the 24/7 guide](/blog/run-codex-24-7-in-the-cloud) for running Codex on a server. The other option is an API key, which is billed at API pricing and leaves out cloud features. After signing in, OpenAI's [auth docs](https://learn.chatgpt.com/docs/auth) say Codex caches your login in `~/.codex/auth.json` (or your OS credential store) and tell you to treat that file like a password. Keep it out of backups and screenshots.",
        "**Start Codex inside tmux** so it outlives your phone connection. If tmux is missing on the machine, install it first (for example `sudo apt install tmux` on Ubuntu or Debian):\n\n```bash\ntmux new -s codex\ncodex\n\n# Detach and leave it running: Ctrl+b, then d\n# Later, from your phone: tmux attach -t codex\n```\n\nOur [tmux cheat sheet](/tools/tmux-cheat-sheet) lists the keys. If Codex has exited and you want an earlier chat back, see [how to resume a Codex session](/blog/codex-resume-session).",
        "**On the phone,** use an SSH app. [Termius](https://termius.com/) is an SSH client for iOS and Android. [Blink Shell](https://blink.sh/) runs on iOS and iPadOS and supports Mosh, which is built for sessions that carry over as you move between networks. Any SSH app that supports key authentication works the same way. Add your server, use a key rather than a password, connect, and run `tmux attach -t codex`.",
        "**Reaching the machine.** If it's at home, follow OpenAI's remote-connection advice: don't expose services to the internet, use a VPN or mesh networking tool, trusted keys and a least-privilege account.",
        "**The phone keyboard.** Long diffs wrap awkwardly on a narrow screen and typing a long prompt on glass is slow, so write the task elsewhere and paste it in. For one-shot jobs, `codex exec` with a prompt runs and exits.",
        "**What it costs you.** A server to rent or a computer to power, plus the upkeep: OS patches, CLI updates, disk space, SSH keys and the firewall. Your Codex usage is on top, through your ChatGPT plan or API key.",
      ],
    },
    {
      heading: "Every option side by side",
      paragraphs: [
        [
          "| Option | What you can do from the phone | What it needs | Main limits |",
          "|---|---|---|---|",
          "| ChatGPT app, Cloud | Start tasks, follow progress, send instructions, review diffs and results | ChatGPT mobile app and a plan with Codex cloud | Self-contained repository work; not your own machine; preview; rollout and workspace settings apply |",
          "| ChatGPT app, connected computer | Start tasks, steer running work, approve commands, review diffs | Mac or Windows PC with the ChatGPT desktop app, awake, online, same account | Preview; host must stay awake; Linux isn't a listed host; no shell prompt |",
          "| Codex CLI over SSH and tmux | The real Codex terminal, any file, any tool on the machine | An always-on machine, an SSH app, ChatGPT sign-in or an API key | You maintain the machine; small-screen typing; secure access is on you |",
          "| Browser terminal on a host that provides one | The real Codex terminal in a mobile browser | A hosted computer with a web terminal, or one you build behind a login | Same typing limits; depends on the host |",
          "| Hivra computer | The real Codex CLI in the computer's Terminal, from a phone browser; long runs in tmux | A Hivra plan, plus your ChatGPT sign-in or OpenAI API key | No native app; the ChatGPT mobile app's pairing is for Mac and PC hosts, so it isn't part of this route |",
        ].join("\n"),
      ],
    },
    {
      heading: "Option 3: Codex on a Hivra computer, opened from your phone's browser",
      paragraphs: [
        "Hivra runs the official Codex CLI on a private cloud computer of its own. You open that computer from a browser on any device, including a phone, and use its Terminal to run Codex. There's no SSH app to configure, no key to carry on your phone, and no server to patch.",
        `Here's how it works in practice. You launch Codex from [the Codex agent page](/agents/codex), sign in with your own ChatGPT account or OpenAI API key, add your repository, and open the Terminal tab under Computer. Start Codex inside tmux there, and the run keeps going when you close the page or lock the phone. You reattach from your phone with the same tmux command later. Plans start at ${ENTRY_PLAN_PRICE} a month for ${ENTRY_PLAN_SIZE}, or ${LARGER_PLAN_PRICE} a month for ${LARGER_PLAN_SIZE}. Your ChatGPT plan or API usage is separate, and billed by OpenAI.`,
        "Why pick it for this reader:",
        "- **It's the Codex terminal, not a chat wrapper.** It is the official OpenAI Codex CLI, so what you learn from OpenAI's docs applies, and `codex resume`, `codex exec` and the rest work.\n- **You aren't locked into one agent.** The same Hivra account launches Hermes, OpenClaw, Claude Code, Codex and Agent Zero, each on a computer of its own, and you reach any of them from a browser on any device. If you later want Claude Code from your phone as well, you don't need a second setup.\n- **The computer stays on.** On a paid plan it isn't paused for inactivity, and your files, repositories, logins and CLI session history stay on it. That covers the always-on part of the do-it-yourself route without you running the machine.",
        "Honest limits. There is no native Hivra phone app: you use the browser. A phone keyboard is still a phone keyboard. And we haven't tested the ChatGPT mobile app's connected-computer feature against a Hivra computer. OpenAI's docs list Mac and Windows desktop-app hosts for that feature, so if the ChatGPT app's approval screens are exactly what you want, Cloud in that app, or a Mac or PC you own, fits better. If you want the actual terminal, or a machine that stays on without owning one, Hivra fits better.",
        "Hivra is independent and is not affiliated with OpenAI. [See how Codex runs on Hivra](/agents/codex), or read how it compares with [Claude Code for 24/7 work](/blog/claude-code-vs-codex-24-7).",
      ],
    },
    {
      heading: "Which option should you pick?",
      paragraphs: [
        "**You want to kick off tasks and review diffs from the couch.** Use Cloud in the ChatGPT app, if your account and workspace show an available environment. It's the least setup.",
        "**You already own an always-on Mac or PC.** Install the ChatGPT desktop app, pair your phone with the QR code, and steer Codex on the machine that has your real projects. Keep it awake, and remember it's a preview.",
        "**You live in the terminal and want Codex's real interface.** Use the CLI in tmux on a machine that stays on, reached with an SSH app or a browser terminal. Pick Hivra if you'd rather not run that machine.",
        "You can also combine them. Many people keep a Hivra computer or a VPS for long jobs, and use the ChatGPT app for quick cloud tasks.",
      ],
    },
  ],
  faqs: [
    {
      q: "Is there a Codex mobile app?",
      a: "Codex lives inside the ChatGPT mobile app on iOS and Android, as a section called Codex (some iOS versions label it Remote). OpenAI announced it in May 2026 as a preview. There isn't a separate standalone Codex app for phones.",
    },
    {
      q: "Which plans can use Codex in the ChatGPT mobile app?",
      a: "OpenAI says the mobile preview is available on all plans, including Free and Go, in all supported regions, while its mobile page notes that availability depends on rollout and your workspace settings. Codex cloud tasks and usage limits vary by plan, so check OpenAI's Codex pricing page for yours.",
    },
    {
      q: "Can I run Codex on my iPhone without a computer?",
      a: "Yes, by using Cloud in the ChatGPT app when your account and workspace show an available environment, where tasks run on OpenAI's side and keep going while your phone is locked. To run the Codex CLI instead, you need a machine somewhere that stays on, which you reach from the phone with an SSH app or a browser terminal.",
    },
    {
      q: "Can I use the Codex CLI from my phone?",
      a: "Yes. Install the CLI on an always-on machine, start it inside tmux, and connect with an SSH app such as Termius (iOS and Android) or Blink Shell (iOS and iPadOS). Reattach with tmux attach after any disconnect. A hosted computer with a browser terminal, such as Hivra's, lets you do it from a mobile browser instead.",
    },
    {
      q: "Does my computer have to be on for Codex in the ChatGPT app?",
      a: "For the connected-computer mode, yes. OpenAI says the host must be awake, online and signed in to the same account, and remote access stops if it sleeps or loses network. Cloud tasks are different: OpenAI says each one keeps running while your computer is asleep.",
    },
    {
      q: "Can I connect the ChatGPT app to a Linux server?",
      a: "OpenAI's remote connections docs list Mac and Windows computers running the ChatGPT desktop app as hosts, and don't list Linux. The desktop app can also work with Remote SSH hosts from your SSH config, but that still needs the desktop app on a Mac or Windows PC.",
    },
    {
      q: "Can I set up phone access from the Codex CLI?",
      a: "No. OpenAI's docs say setup for the ChatGPT app's connected-computer mode starts in the desktop app, under Settings > Connections > Control this Mac or PC, and can't be done from the Codex CLI or IDE extension.",
    },
    {
      q: "Will a Codex session survive if my phone loses signal?",
      a: "Cloud tasks do, since they run on OpenAI's side. A CLI session started inside tmux does too, because tmux keeps it running on the server. A CLI run started outside tmux can end with the connection, so always start it inside tmux.",
    },
    {
      q: "Can I use Codex on Hivra from my phone?",
      a: "Yes, through the browser. Hivra gives Codex a private computer with a Terminal you can open from a phone browser. Start Codex inside tmux there and it keeps going after you close the page. Hivra has no native phone app and is not affiliated with OpenAI.",
    },
  ],
  relatedArticles: [
    { slug: "run-codex-24-7-in-the-cloud", title: "Codex cloud, or Codex on a computer that stays on? Where to run it 24/7" },
    { slug: "codex-resume-session", title: "How to resume a Codex session (and Claude Code too)" },
    { slug: "codex-pricing-by-chatgpt-plan", title: "Codex pricing by ChatGPT plan: Plus, Pro 100/200/500 and API keys" },
    { slug: "claude-code-vs-codex-24-7", title: "Claude Code vs Codex for 24/7 autonomous work: which should you host?" },
  ],
};
