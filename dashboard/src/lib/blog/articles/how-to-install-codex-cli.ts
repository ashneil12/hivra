import { BlogArticle } from "../types";
import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE, LARGER_PLAN_PRICE, LARGER_PLAN_SIZE } from "../plan-facts";

// Written 2026-11-19 for the "codex cli install" searches (US 4,400/mo, low difficulty; related "codex cli windows" 480,
// "codex cli linux" 320). Primary sources fetched 2026-11-19:
// https://github.com/openai/codex (README: install commands for Mac/Linux and Windows, installer download source and
//   the CODEX_INSTALLER_USE_RELEASES_OPENAI_COM override, npm and Homebrew commands, GitHub Release archive names,
//   Sign in with ChatGPT, API key needs additional setup)
// https://raw.githubusercontent.com/openai/codex/main/docs/install.md (build from source steps, git 2.23+, 4 GB RAM
//   minimum / 8 GB recommended, macOS 12+, Ubuntu 20.04+, Debian 10+, Windows 11 via WSL2; written for contributors)
// https://learn.chatgpt.com/docs/cli (OpenAI's Codex CLI page, redirected from developers.openai.com/codex/cli: install
//   tabs for macOS/Linux, Windows, npm, Homebrew; update by rerunning the installer; sign in with ChatGPT on first run;
//   first run in a project directory; Git checkpoints advice)
// https://learn.chatgpt.com/codex/windows/wsl (wsl --install, run the installer inside WSL, WSL2 required, WSL1 not
//   supported from Codex 0.115, keep repos under the Linux home, which codex check, wsl --update, wsl --shutdown)
// https://learn.chatgpt.com/codex/windows/windows-sandbox (Windows sandbox modes, Windows 11 recommended, Windows 10
//   1809+ best effort, MXC single-command test from Codex CLI 0.162.0)
// https://learn.chatgpt.com/docs/auth and https://learn.chatgpt.com/codex/auth (ChatGPT sign-in opens a browser, API key
//   from platform.openai.com/api-keys, cached login in ~/.codex/auth.json or the OS credential store,
//   cli_auth_credentials_store values, API key for programmatic and CI use, Codex cloud needs ChatGPT sign-in, API usage
//   billed at API rates)
// https://learn.chatgpt.com/docs/developer-commands?surface=cli (codex login, codex logout, codex update, codex resume)
// https://learn.chatgpt.com/codex/pricing (Codex included in Free, Go, Plus, Pro, Business, Edu, Enterprise; API key
//   excludes cloud features such as GitHub code review and Slack)
// https://github.com/openai/codex/releases/latest (GitHub Releases is where the fallback downloads come from)
// Top-result and Reddit research: the current ranking pages (OpenAI docs, third-party install guides) were checked via
// search results only; every fact in the copy comes from the OpenAI pages above.
// Hivra facts: dashboard/src/app/agents/content/codex.ts, lib/hivra/agent-seo-catalog.ts, lib/blog/runtime-facts.ts,
// lib/blog/plan-facts.ts.
// Not claimed: the --with-api-key flag or any env var for API key login (OpenAI's pages do not show CLI steps for it),
// Node.js version requirements for npm, device-auth flags, Telegram for Codex, that Hivra updates Codex for you.

export const howToInstallCodexCli: BlogArticle = {
  slug: "how-to-install-codex-cli",
  title: "How to install the Codex CLI on Mac, Linux and Windows",
  metaTitle: "How to install the Codex CLI: Mac, Linux, Windows",
  metaDescription:
    "Install OpenAI's Codex CLI with curl, PowerShell, npm or Homebrew, on macOS, Linux, Windows or WSL. Sign-in, updates and common errors fixed.",
  publishedDate: "2026-11-19",
  lastModified: "2026-11-19",
  readingTimeMin: 12,
  author: "Hivra team",
  tagline: "One command per system, then sign in. Here is what to run and what to do when it fails.",
  intro:
    "OpenAI documents four ways to install the Codex CLI, plus a manual download. Most people need only one command. This guide gives the exact command for macOS, Linux and Windows (native and WSL), then covers sign-in, updates and the errors that trip people up.",
  shortAnswer:
    "As of November 2026, on macOS or Linux run `curl -fsSL https://chatgpt.com/codex/install.sh | sh`. On Windows run the PowerShell command in step two below, or use WSL. `npm install -g @openai/codex` and `brew install --cask codex` also work. Then run `codex` and choose Sign in with ChatGPT.",
  sections: [
    {
      heading: "The short version: one install command, then sign in",
      paragraphs: [
        "OpenAI's [Codex CLI README](https://github.com/openai/codex) lists the install commands. They are the same ones OpenAI's [Codex CLI docs](https://learn.chatgpt.com/docs/cli) show in their install tabs. As of November 2026:",
        "- **macOS or Linux:** `curl -fsSL https://chatgpt.com/codex/install.sh | sh`\n- **Windows (PowerShell):** `powershell -ExecutionPolicy ByPass -c \"irm https://chatgpt.com/codex/install.ps1 | iex\"`\n- **Any system with npm:** `npm install -g @openai/codex`\n- **macOS with Homebrew:** `brew install --cask codex`\n- **Manual:** download an archive from the [latest GitHub Release](https://github.com/openai/codex/releases/latest), extract it and rename the binary to `codex`.",
        "After any of them, open a terminal in a project folder and run `codex`. The first time, pick **Sign in with ChatGPT** (or another sign-in method) and a browser window opens to finish the login. That is the whole install.",
        "The rest of this guide covers what to pick, what each system needs, and what to do when something goes wrong. Want Codex on a computer that stays on without installing anything? See [Codex on Hivra](/agents/codex).",
      ],
    },
    {
      heading: "Every install method side by side",
      paragraphs: [
        [
          "| Method | Command | Best for | Watch out for |",
          "|---|---|---|---|",
          "| Standalone installer (macOS, Linux) | `curl -fsSL https://chatgpt.com/codex/install.sh \\| sh` | Most people. No Node.js needed | Pipes a script into your shell, so read it first if that bothers you |",
          "| Standalone installer (Windows) | `powershell -ExecutionPolicy ByPass -c \"irm https://chatgpt.com/codex/install.ps1 \\| iex\"` | Native Windows in PowerShell | Runs a downloaded script with the execution policy bypassed for that one command |",
          "| npm | `npm install -g @openai/codex` | Developers who already manage tools with npm | Needs Node.js and npm already set up |",
          "| Homebrew | `brew install --cask codex` | Mac users who keep everything in Homebrew | It is a cask, so the command needs `--cask` |",
          "| GitHub Release download | Download, extract, rename to `codex` | Locked-down machines, or pinning a build | You put the file on your PATH and handle updates yourself |",
          "| WSL on Windows | `wsl --install`, then the Linux installer inside WSL | Windows users who want a Linux workflow | Keep your repositories in the Linux home folder, not under `/mnt/c` |",
          "| Build from source | `git clone`, then `cargo build` in `codex-rs` | Contributors | Needs the Rust toolchain; not for ordinary use |",
        ].join("\n"),
        "The standalone installers download from `releases.openai.com/codex` by default and fall back to GitHub Releases if that download fails. If you want GitHub Releases from the start, the README shows how to force it. On macOS or Linux:",
        "`curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_INSTALLER_USE_RELEASES_OPENAI_COM=false sh`",
        "And in Windows PowerShell:",
        "`$env:CODEX_INSTALLER_USE_RELEASES_OPENAI_COM='false'; irm https://chatgpt.com/codex/install.ps1 | iex`",
        "If you are not sure which to pick, use the standalone installer for your system. It is the first command OpenAI lists, and it is the one OpenAI's docs also use for updating.",
      ],
    },
    {
      heading: "System requirements",
      paragraphs: [
        "OpenAI's CLI page does not list system requirements, so treat the numbers below as the best published guide rather than a promise. The repository's [install doc](https://github.com/openai/codex/blob/main/docs/install.md) is written for people building Codex from source and is the only place that gives them:",
        "- **Operating systems:** macOS 12 or newer, Ubuntu 20.04 or newer, Debian 10 or newer.\n- **Memory:** 4 GB of RAM minimum, 8 GB recommended.\n- **Git:** version 2.23 or newer is optional but recommended, for the built-in pull request helpers.",
        "That same doc says Windows 11 works through WSL2. OpenAI's newer Windows pages are more specific, and they are covered in the Windows section. For Linux outside that list, the GitHub Release archives are built for x86_64 and arm64 (the file names end in `unknown-linux-musl`), so the manual download is the fallback.",
        "You also need an account to use it: a ChatGPT plan that includes Codex, or an OpenAI API key. Both are covered under sign-in.",
      ],
    },
    {
      heading: "Install the Codex CLI on macOS",
      paragraphs: [
        "Open Terminal and pick one route.",
        "**Standalone installer (the default):**",
        "`curl -fsSL https://chatgpt.com/codex/install.sh | sh`",
        "**Homebrew:**",
        "`brew install --cask codex`",
        "**npm:**",
        "`npm install -g @openai/codex`",
        "If you go the manual route, the GitHub Release has one archive for Apple Silicon (`codex-aarch64-apple-darwin.tar.gz`) and one for older Intel Macs (`codex-x86_64-apple-darwin.tar.gz`). Each contains a single binary with the platform in its name. Rename it to `codex` and put it somewhere on your PATH.",
        "Then open a new terminal window, go to a project folder and run `codex`. Opening a new window matters: your shell reads PATH when it starts, so an old window may not see the new command.",
      ],
    },
    {
      heading: "Install the Codex CLI on Linux",
      paragraphs: [
        "The same standalone installer covers Linux:",
        "`curl -fsSL https://chatgpt.com/codex/install.sh | sh`",
        "`npm install -g @openai/codex` also works wherever npm does. The manual download has Linux archives for x86_64 (`codex-x86_64-unknown-linux-musl.tar.gz`) and arm64 (`codex-aarch64-unknown-linux-musl.tar.gz`). Extract, rename the file to `codex`, and move it onto your PATH.",
        "Run `codex` from a project directory to start. On a remote server with no browser, ChatGPT sign-in can be awkward, because the login flow opens a browser. The sign-in section below covers the options.",
        "Check that it landed where your shell can find it: `which codex || echo \"codex not found\"`. OpenAI's WSL page uses exactly that check, and it works on any Linux shell.",
      ],
    },
    {
      heading: "Install the Codex CLI on Windows: native or WSL",
      paragraphs: [
        "There are two supported shapes on Windows, and OpenAI documents both.",
        "**Native Windows (PowerShell).** The README gives a PowerShell installer:",
        "`powershell -ExecutionPolicy ByPass -c \"irm https://chatgpt.com/codex/install.ps1 | iex\"`",
        "`npm install -g @openai/codex` works here too if you already use npm. After it finishes, open a new PowerShell window and run `codex`. OpenAI's [Windows sandbox page](https://learn.chatgpt.com/codex/windows/windows-sandbox) says Windows 11 is recommended and recent, fully updated Windows 10 is best effort, with Windows 10 version 1809 or newer required for the terminal layer Codex uses (ConPTY). It also says `winget` should be available. That page describes sandbox modes for running commands safely on Windows. The recommended one, called `mxc`, is for compatible Windows devices. From Codex CLI 0.162.0 you can test it for a single command without changing your saved sandbox setting, so update first if the CLI is old.",
        "**WSL (Windows Subsystem for Linux).** This is the better fit if your projects, tools and habits are Linux ones. OpenAI's [WSL page](https://learn.chatgpt.com/codex/windows/wsl) lists the steps:",
        "1. In an elevated PowerShell or Windows Terminal, install WSL and a default Linux distribution: `wsl --install`\n2. Start a shell inside it: `wsl`\n3. In that shell, install and run Codex: `curl -fsSL https://chatgpt.com/codex/install.sh | sh` and then `codex`",
        "Two details from that page save real trouble. First, WSL2 is required: WSL1 was supported through Codex 0.114 and is not supported from 0.115 on. Second, keep your repositories under your Linux home folder, such as `~/code/my-app`, not under `/mnt/c/...`. OpenAI says Windows-mounted paths are slower and cause more symlink and permission problems.",
        "Which to choose? Native is simplest if you work in PowerShell and Windows tools. WSL is better if the project builds with Linux tooling, or you want the same commands as a Linux server. Many people try native first and move to WSL when a toolchain fights them.",
      ],
    },
    {
      heading: "Sign in: ChatGPT account or API key",
      paragraphs: [
        "Codex needs to know who is paying for the work. There are two main ways, and the choice changes what you can use. As of November 2026:",
        "**Sign in with ChatGPT.** Run `codex` and choose **Sign in with ChatGPT**. OpenAI's [auth page](https://learn.chatgpt.com/docs/auth) says this opens a browser window and the browser hands your credentials back to Codex. OpenAI recommends this route if you have a Plus, Pro, Business, Edu or Enterprise plan, and its [pricing page](https://learn.chatgpt.com/codex/pricing) lists Codex as included in Free, Go, Plus, Pro, Business, Edu and Enterprise plans, with limits that vary by plan. Our guide to [Codex pricing by ChatGPT plan](/blog/codex-pricing-by-chatgpt-plan) breaks down what each plan buys.",
        "**Use an API key.** Create a key in the OpenAI dashboard at [platform.openai.com/api-keys](https://platform.openai.com/api-keys). OpenAI says the README route needs [additional setup](https://developers.openai.com/codex/auth#sign-in-with-an-api-key), and its docs recommend API key authentication for programmatic work such as CI/CD jobs. The steps for the CLI live on that page, so follow it rather than a forum post, because the exact setup is the part most likely to change.",
        "**What the API key route changes.** OpenAI's docs say usage is billed at standard API rates and does not draw on your ChatGPT plan's included credits. Cloud features that depend on your ChatGPT workspace, such as GitHub code review and Slack, are not available, and Codex cloud requires ChatGPT sign-in.",
        "**Which should you pick?** If you already pay for a ChatGPT plan and work interactively, sign in with ChatGPT. If you want metered billing, run Codex in scripts, or have no plan, use an API key.",
        "**Where the login is stored.** OpenAI says cached logins live in a plaintext file at `~/.codex/auth.json` or in your operating system's credential store. You choose with a setting called `cli_auth_credentials_store` (values `file`, `keyring`, `auto` and `ephemeral`). OpenAI's docs tell you to treat `auth.json` like a password. To sign out, run `codex logout`, which removes stored credentials. `codex login` signs you in again, and per OpenAI's command reference it supports ChatGPT sign-in, device auth, an API key, or an access token piped over stdin.",
      ],
    },
    {
      heading: "First run: what to do after it installs",
      paragraphs: [
        "OpenAI's CLI page gives a three-step first run. Open a project directory, run `codex`, and describe a task. The page's own example prompt is `Tell me about this project`, and it suggests making a focused change or debugging an issue next.",
        "Its one piece of advice is worth taking: create Git checkpoints before and after a task, so you can revert anything you don't like. Start in a repository with a clean working tree, commit before you ask for a big change, and review the diff afterward.",
        "Once you are using it, the commands you will want first are `codex resume` (continue a previous session) and `codex update`. Our guide to [resuming a Codex session](/blog/codex-resume-session) covers the first in detail. To connect tools such as a docs server or your issue tracker, see [Codex MCP: how to add MCP servers to the Codex CLI](/blog/codex-mcp).",
      ],
    },
    {
      heading: "How to update the Codex CLI",
      paragraphs: [
        "Update the way you installed it. As of November 2026, OpenAI documents these:",
        "- **Standalone installer:** run the install command again. OpenAI's CLI page gives the install command as the update command: `curl -fsSL https://chatgpt.com/codex/install.sh | sh`\n- **`codex update`:** OpenAI's command reference says this checks for and applies an update when the installed release supports self-update.\n- **npm:** run the install command again, `npm install -g @openai/codex`.\n- **Homebrew:** use Homebrew's normal upgrade command for the cask.\n- **Manual download:** fetch the new archive from GitHub Releases and replace the binary.",
        "Check the version you are on with `codex --version` before you report a bug. Some features need a recent build, such as testing the `mxc` Windows sandbox for a single command, which arrived in 0.162.0.",
      ],
    },
    {
      heading: "Common install errors and how to fix them",
      paragraphs: [
        "These are the failures people hit most, with fixes that come from OpenAI's docs or from how the install paths work.",
        "**`codex: command not found` after installing.** The binary is not on your PATH, or your terminal started before the install. Open a brand new terminal window first. Then run `which codex || echo \"codex not found\"` (macOS, Linux, WSL). If it is still missing, rerun the installer. OpenAI's WSL page gives the same advice for editors that cannot find it: confirm the binary is on PATH inside WSL, then reinstall with the script if it is missing.",
        "**The installer cannot download the file.** The standalone installers fall back to GitHub Releases on their own when the first source fails. If it still fails, force GitHub Releases with `CODEX_INSTALLER_USE_RELEASES_OPENAI_COM=false` (commands above), or download the archive by hand from the [latest release](https://github.com/openai/codex/releases/latest). On a network that blocks one host, the other may work.",
        "**PowerShell refuses to run the script.** Use the full command from the README, which sets `-ExecutionPolicy ByPass` for that one command. Don't loosen the policy for your whole machine just to install one tool.",
        "**It works in WSL but is slow, or the repo behaves oddly.** Your project is probably under `/mnt/c`. Move it into your Linux home folder, as OpenAI recommends. If WSL itself is slow, OpenAI's page suggests raising WSL's memory and CPU allocation, then updating with `wsl --update` followed by `wsl --shutdown`.",
        "**An older WSL setup stopped working.** WSL1 is not supported from Codex 0.115 on. Convert to WSL2, or install Codex natively on Windows.",
        "**`npm install -g` fails.** npm problems are usually about your Node.js setup rather than Codex. The standalone installer does not need Node.js, so it is the quickest way around it. Use that, or fix your npm install separately.",
        "**The browser sign-in will not open, such as on a remote server.** ChatGPT sign-in relies on a browser. On a machine without one, `codex login` also supports device auth (see OpenAI's command reference), or you can use an API key, which OpenAI recommends for CI and other programmatic work.",
        "**A credential store error.** If you set `cli_auth_credentials_store` to `keyring`, OpenAI says Codex fails when the OS credential store is unavailable, such as on a minimal server. Switch it to `auto` or `file`, which fall back to `auth.json`.",
        "**It installed, but a command or tool fails on Windows.** That is usually the sandbox rather than the install. See the Windows sandbox page linked above for the modes and their requirements.",
      ],
    },
    {
      heading: "Or skip the install: Codex on a Hivra computer",
      paragraphs: [
        "Everything above puts Codex on a machine you own, which is the right call for most people. If your real problem is that the machine goes to sleep, travels with you or is not the one you want agents running on, there is another route.",
        "Hivra runs the official OpenAI Codex CLI on a private cloud computer of its own. There is nothing to install on your laptop: you open the computer from a browser, sign in with your own ChatGPT account or OpenAI API key, add your repository and work in its Terminal tab. The computer stays on, and it keeps your files, repositories, logins and CLI session history between visits. A Codex run you start inside tmux in that Terminal tab keeps going after you close the laptop.",
        `Plans start at ${ENTRY_PLAN_PRICE} a month for ${ENTRY_PLAN_SIZE}, or ${LARGER_PLAN_PRICE} a month for ${LARGER_PLAN_SIZE}. Your ChatGPT plan or API usage is separate and billed by OpenAI.`,
        "Why pick it for this reader:",
        "- **Nothing to install or debug locally.** No PATH problems, no WSL setup, no installer to rerun on every machine you own.\n- **You aren't locked into one agent.** The same Hivra account launches Hermes, OpenClaw, Claude Code, Codex and Agent Zero, each on a computer of its own, and you reach any of them from a browser on any device. If you try Codex today and Claude Code next week, you don't set anything up twice.\n- **Long runs don't depend on your laptop.** Start the work in tmux, close the lid, and come back to it later from any browser.",
        "Honest limits. A local install is free apart from your OpenAI usage, so if Codex on your own laptop meets your needs, keep it there. A local install is also the better fit for a quick edit in a project that lives on your machine, because the files are right there. Hivra fits when you want work to continue without your laptop, or want one place for several agents. Hivra is independent and is not affiliated with OpenAI.",
        "[See how Codex runs on Hivra](/agents/codex), or read [how to run Codex 24/7 in the cloud](/blog/run-codex-24-7-in-the-cloud) and [how to use Codex from your phone](/blog/codex-mobile).",
      ],
    },
    {
      heading: "Which install route should you pick?",
      paragraphs: [
        "**You are on a Mac or Linux box and want the least friction.** Use the standalone installer. One command, no Node.js, and the same command updates it.",
        "**You are on Windows and live in PowerShell.** Use the native PowerShell installer. Check the Windows sandbox requirements if commands fail inside Codex.",
        "**You are on Windows and your projects build with Linux tools.** Use WSL2 and keep repositories in the Linux home folder.",
        "**You already manage developer tools with npm or Homebrew.** Use `npm install -g @openai/codex` or `brew install --cask codex` and update with the same tool.",
        "**The machine is locked down or you need to pin a build.** Download from GitHub Releases and own the updates.",
        "**You don't want Codex tied to a machine you carry.** Run it on a Hivra computer, and let the laptop be just a browser.",
      ],
    },
  ],
  faqs: [
    {
      q: "How do I install the Codex CLI?",
      a: "On macOS or Linux, run `curl -fsSL https://chatgpt.com/codex/install.sh | sh`. On Windows, run the PowerShell installer from OpenAI's README, or use WSL. `npm install -g @openai/codex` and `brew install --cask codex` also work. Then run `codex` and sign in.",
    },
    {
      q: "Is the Codex CLI free?",
      a: "The CLI is open source and installing it costs nothing, but using it takes either a ChatGPT plan that includes Codex or an OpenAI API key. OpenAI's pricing page lists Codex as included in Free, Go, Plus, Pro, Business, Edu and Enterprise plans with plan-based limits. API key usage is billed at API rates.",
    },
    {
      q: "Does the Codex CLI work on Windows?",
      a: "Yes, in two ways. OpenAI's README gives a native PowerShell installer, and its WSL page documents running the Linux installer inside WSL2. WSL1 is not supported from Codex 0.115 on. For native Windows, OpenAI recommends Windows 11.",
    },
    {
      q: "Do I need Node.js or npm to install Codex?",
      a: "Not with the standalone installers, which are the first commands OpenAI lists. You only need Node.js and npm if you choose `npm install -g @openai/codex`. Homebrew and the manual GitHub Release download don't need it either.",
    },
    {
      q: "How do I update the Codex CLI?",
      a: "Rerun the install command you used. OpenAI's docs give the standalone installer command as the update command. You can also run `codex update`, which applies an update when your installed release supports self-update. Check the result with `codex --version`.",
    },
    {
      q: "Should I sign in with ChatGPT or use an API key?",
      a: "Sign in with ChatGPT if you already have a plan that includes Codex and work interactively. Use an API key for metered billing or automation such as CI. Note that API key usage is billed at API rates, and Codex cloud needs ChatGPT sign-in.",
    },
    {
      q: "Why does my terminal say codex: command not found?",
      a: "The binary isn't on your PATH yet, or the terminal started before you installed it. Open a new terminal window, check with `which codex || echo \"codex not found\"`, and rerun the installer if it is missing. In WSL, make sure you installed inside WSL, not only on Windows.",
    },
    {
      q: "Can I run the Codex CLI without installing anything on my computer?",
      a: "Yes. A Hivra computer runs the official Codex CLI in the cloud, and you use it from a browser. You sign in with your own ChatGPT account or OpenAI API key. A run started inside tmux in its Terminal tab keeps going after you close your laptop. Hivra is not affiliated with OpenAI.",
    },
    {
      q: "Where does Codex store my login?",
      a: "OpenAI says cached logins are kept in `~/.codex/auth.json` or in your operating system's credential store, depending on the `cli_auth_credentials_store` setting. Treat the file like a password, and run `codex logout` to remove stored credentials.",
    },
  ],
  relatedArticles: [
    { slug: "codex-pricing-by-chatgpt-plan", title: "Codex pricing by ChatGPT plan: Plus, Pro 100/200/500 and API keys" },
    { slug: "codex-resume-session", title: "How to resume a Codex session (and Claude Code too)" },
    { slug: "run-codex-24-7-in-the-cloud", title: "Codex cloud, or Codex on a computer that stays on? Where to run it 24/7" },
    { slug: "codex-mobile", title: "Codex on mobile: how to use OpenAI Codex from your phone" },
  ],
  relatedComparisons: [
    { slug: "vs-openai-codex-cloud", title: "OpenAI Codex cloud vs Hivra: tasks in a sandbox or a computer that stays on" },
  ],
};
