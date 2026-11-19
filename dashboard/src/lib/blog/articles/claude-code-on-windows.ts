import { BlogArticle } from "../types";
import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE } from "../plan-facts";

// Written 2026-11-19 for "claude code windows" (2,400 US searches a month, difficulty 22, rising).
// Anthropic docs fetched 2026-11-19:
// https://code.claude.com/docs/en/setup (system requirements, native install commands for PowerShell and CMD,
//   Git for Windows optional, CLAUDE_CODE_GIT_BASH_PATH, PowerShell tool, WSL 2 vs WSL 1 table, npm install and
//   Node.js 22, WinGet, claude --version / claude doctor, authenticate, auto-updates, claude update)
// https://code.claude.com/docs/en/troubleshoot-install (wrong command per shell, PATH fix, npm execution policy,
//   "requires either Git for Windows or PowerShell", WSL1 Exec format error, file in use during install,
//   claude.exe missing after an update, TLS and revocation errors)
// https://code.claude.com/docs/en/terminal-guide (first-time Windows walkthrough, PS vs CMD prompt)
// https://code.claude.com/docs/en/tools-reference (PowerShell tool availability)
// https://code.claude.com/docs/en/sandboxing (sandbox runs on macOS, Linux and WSL2, not native Windows)
// https://code.claude.com/docs/en/troubleshooting (slow or incomplete search on WSL, keep projects on the Linux filesystem)
// https://code.claude.com/docs/en/desktop-quickstart (Desktop app for Windows, ARM64 installer, WSL 2 sessions)
// https://git-scm.com/docs/git-config (core.autocrlf behaviour)
// Hivra facts: dashboard/src/app/agents/content/claude-code.ts, lib/hivra/agent-seo-catalog.ts, lib/blog/runtime-facts.ts
// (CLI_RUN_LIFETIME wording: computer stays on, tmux), lib/blog/plan-facts.ts. Sentences about Hivra avoid the word
// "Windows" (claim-rules.ts). Not claimed: Remote Control on a Hivra computer, any Windows app from Hivra, setup times.

export const claudeCodeOnWindows: BlogArticle = {
  slug: "claude-code-on-windows",
  title: "Claude Code on Windows: install natively, in WSL, or on a Linux computer (as of November 2026)",
  metaTitle: "Claude Code on Windows: install and fix problems",
  metaDescription:
    "How to install Claude Code on Windows natively or in WSL, sign in, fix PATH and shell errors, and when a remote Linux computer is the better home.",
  publishedDate: "2026-11-19",
  lastModified: "2026-11-19",
  readingTimeMin: 12,
  author: "Hivra team",
  tagline: "You don't need WSL to start, and you don't need a Windows PC to keep it running.",
  intro:
    "Claude Code runs natively on Windows now, so the old advice to set up WSL first is out of date. Here is how to install it from PowerShell or CMD, when WSL is still the better choice, how to sign in, and how to fix the errors Windows users hit most.",
  shortAnswer:
    "To run Claude Code on Windows, open PowerShell and run `irm https://claude.ai/install.ps1 | iex`, then type `claude` and sign in with a Pro, Max, Team, Enterprise or Console account. It needs Windows 10 version 1809 or later and 4 GB of RAM. Git for Windows is optional. WSL 2 is the choice when you want sandboxing.",
  sections: [
    {
      heading: "The short version: native or WSL, and what each needs",
      paragraphs: [
        "Anthropic documents two ways to run Claude Code on a Windows PC, and a third place to run it that has nothing to do with your PC. [Anthropic's setup page](https://code.claude.com/docs/en/setup) lays out the first two:",
        [
          "| Where it runs | What you need | Sandboxing | Best for |",
          "|---|---|---|---|",
          "| Native Windows (PowerShell or CMD) | Nothing extra. Git for Windows is optional | Not supported | Windows-native projects and tools |",
          "| WSL 2 | WSL 2 turned on | Supported | Linux toolchains, or when you want sandboxed command execution |",
          "| WSL 1 | WSL 1 turned on | Not supported | Only if WSL 2 isn't available to you |",
        ].join("\n"),
        "Many Windows users never need more than the first row. If your code is a .NET app, a Node project you edit in VS Code, or anything that builds on Windows, install natively and get on with your day. If your project is built for Linux, or you want Anthropic's sandbox, use WSL 2. The rest of this guide covers both, then what to do when you want Claude Code running somewhere other than your PC. If you'd rather run it on a computer that stays on, [Claude Code on Hivra](/agents/claude-code) comes with the official CLI already installed.",
      ],
    },
    {
      heading: "System requirements",
      paragraphs: [
        "From Anthropic's setup page, as of November 2026:",
        "- **Operating system:** Windows 10 version 1809 or later, or Windows Server 2019 or later.\n- **Hardware:** 4 GB of RAM or more, and an x64 or ARM64 processor.\n- **Network:** an internet connection.\n- **Shell:** PowerShell or CMD for native Windows, or Bash inside WSL.\n- **Location:** one of Anthropic's [supported countries](https://www.anthropic.com/supported-countries).\n- **Account:** a Pro, Max, Ultra, Team, Enterprise or Console account. The free claude.ai plan does not include Claude Code.",
        "Git for Windows is not on the requirements list. It is optional, and the next section explains what it changes. If you are weighing which paid plan to get, see our guide to [Claude Code pricing: Pro vs Max, and when API billing is cheaper](/blog/claude-max-vs-pro-for-claude-code).",
      ],
    },
    {
      heading: "Install Claude Code natively on Windows",
      paragraphs: [
        "This is the route Anthropic recommends for Windows. You do not need to run as Administrator.",
        "**Step 1: open the right terminal.** Press `Win + X` and choose Windows PowerShell or Terminal. Your prompt starts with `PS C:\\Users\\YourName>` in PowerShell. In CMD it shows `C:\\Users\\YourName>` without the `PS`. The two take different install commands, and mixing them up is the most common first error.",
        "**Step 2: run the installer.** In PowerShell:\n\n```\nirm https://claude.ai/install.ps1 | iex\n```\n\nIn CMD:\n\n```\ncurl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd && del install.cmd\n```\n\nThe command shows no progress while it downloads, so leave the window open until it finishes. Anthropic's terminal guide says you'll see \"Claude Code successfully installed!\" when it's done.",
        "**Step 3: check it worked.** Open a new terminal window and run:\n\n```\nclaude --version\n```\n\nA working install prints a version number such as `2.1.211 (Claude Code)`. For a fuller check, `claude doctor` prints read-only diagnostics about the install and your settings without starting a session.",
        "**Step 4: start it in your project.** `cd` into a project folder and run `claude`. The first run opens a browser window to sign in, covered below.",
        "**Git for Windows is optional, but Anthropic recommends it.** It provides Git Bash, which Claude Code's Bash tool needs. Without it, Claude Code runs shell commands through its PowerShell tool instead. With it installed, Claude Code uses Git Bash, and the PowerShell tool is available alongside. If you install Git for Windows, select \"Add to PATH\" during setup. If Claude Code can't find Git Bash, add this to your `settings.json`:\n\n```\n{\n  \"env\": {\n    \"CLAUDE_CODE_GIT_BASH_PATH\": \"C:\\\\Program Files\\\\Git\\\\bin\\\\bash.exe\"\n  }\n}\n```",
        "**Updates.** Native installs update themselves in the background and the new version takes effect the next time you start Claude Code. To update by hand, run `claude update`.",
      ],
    },
    {
      heading: "Install Claude Code in WSL",
      paragraphs: [
        "Anthropic's instruction is short: open your WSL distribution and run the Linux installer, then launch `claude` inside the WSL terminal, not from PowerShell or CMD. The Linux installer is:\n\n```\ncurl -fsSL https://claude.ai/install.sh | bash\n```",
        "Choose WSL 2 over WSL 1 if you can. WSL 2 supports Claude Code's sandboxing, and Anthropic's sandboxing page says that on native Windows Claude Code runs commands unsandboxed, so WSL 2 is the way to get the sandbox on a Windows machine. WSL 1 is also hit by a known native-binary regression: if `claude` prints `cannot execute binary file: Exec format error`, Anthropic's fix is to convert the distribution from PowerShell with `wsl --set-version <DistroName> 2`.",
        "**Keep your project on the Linux side.** Anthropic's troubleshooting page warns that reading across the Windows and Linux file systems on WSL can make search return fewer results than expected. Its advice is to keep the project under `/home/` rather than `/mnt/c/`, or to use native Windows if the project has to live on the Windows drive. Inside WSL everything works as it does on a Linux machine, so [Claude Code on Linux](/blog/claude-code-on-linux) covers the Linux-side errors, ripgrep and tmux in more depth.",
        "If you prefer a graphical app, there is also a Claude desktop app for Windows (with an ARM64 installer), and it can run sessions inside a WSL 2 distribution. That is a separate download from the terminal install above, and the [desktop quickstart](https://code.claude.com/docs/en/desktop-quickstart) covers it.",
      ],
    },
    {
      heading: "npm and WinGet: the other install routes",
      paragraphs: [
        "Anthropic's page lists two more routes for Windows. Neither is the recommended one, and both exist for specific situations.",
        "**npm** needs Node.js 22 or later and installs the same native binary as the standalone installer:\n\n```\nnpm install -g @anthropic-ai/claude-code\n```\n\nUpgrade with `npm install -g @anthropic-ai/claude-code@latest`. Anthropic says to avoid `npm update -g`, which may not move you to the newest release, and never to use `sudo npm install -g`. On Windows, npm creates `.ps1` launcher scripts that PowerShell's execution policy can block, which is the `running scripts is disabled on this system` error covered in the fixes below. Also check `npm --version` first: npm 12 skips Claude Code's postinstall step by default, which leaves `claude` failing with `Error: claude native binary not installed.` or a launcher Windows can't run. Anthropic's [npm 12 fix](https://code.claude.com/docs/en/troubleshoot-install#fix-an-npm-12-install) is to use the native installer instead or allow the step.",
        "**WinGet** installs with `winget install Anthropic.ClaudeCode`. WinGet installs do not auto-update. Run `winget upgrade Anthropic.ClaudeCode` now and then, or set `CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE` to `1` and let Claude Code run the upgrade in the background. The upgrade can fail while Claude Code is running because Windows locks the file, in which case Claude Code shows you the command to run by hand.",
        "If you only want the least maintenance, pick the native installer. It's the one Anthropic marks as recommended and the one that updates itself.",
      ],
    },
    {
      heading: "Signing in",
      paragraphs: [
        "Run `claude` and follow the browser prompts. A browser window opens, you sign in with your Anthropic account, and the terminal picks up the login. You need a Pro, Max, Ultra, Team, Enterprise or Console account, because the free claude.ai plan doesn't include Claude Code.",
        "If you have an `ANTHROPIC_API_KEY` environment variable set and you approve the key when Claude Code asks, it skips the login prompt and uses that key instead of your subscription login. Usage then goes to the Console account that owns the key, not your Pro or Max plan. You can also point Claude Code at Amazon Bedrock, Google Cloud's Agent Platform or Microsoft Foundry instead of an Anthropic account. Anthropic's [authentication page](https://code.claude.com/docs/en/authentication) covers every account type and team setup.",
      ],
    },
    {
      heading: "Common Windows problems and the fixes Anthropic documents",
      paragraphs: [
        "Most Windows trouble comes down to the wrong shell, a missing PATH entry, or a policy that blocks scripts. Anthropic's [installation troubleshooting page](https://code.claude.com/docs/en/troubleshoot-install) has the full list. These are the ones you are most likely to meet.",
        "**`irm` is not recognized.** You are in CMD, not PowerShell. Open PowerShell from the Start menu and run `irm https://claude.ai/install.ps1 | iex`, or use the CMD command shown earlier.",
        "**`The token '&&' is not a valid statement separator`.** The opposite mistake: you pasted the CMD command into PowerShell. Use the PowerShell command.",
        "**`A parameter cannot be found that matches parameter name 'fsSL'`, or `bash` not recognized.** You ran the macOS and Linux command on Windows. In PowerShell, `curl` is an alias for `Invoke-WebRequest` and rejects those flags. Use the PowerShell installer.",
        "**The install command prints script text and nothing installs.** In CMD, the `curl` command without `-o install.cmd` prints the script instead of saving it. Run the complete command, including `-o install.cmd && install.cmd && del install.cmd`.",
        "**`'claude' is not recognized` after a clean install.** This is the PATH problem. The installer puts `claude.exe` in `%USERPROFILE%\\.local\\bin`. Check it is there:\n\n```\nTest-Path \"$env:USERPROFILE\\.local\\bin\\claude.exe\"\n```\n\nIf that prints `True` but `claude` still isn't found, add the folder to your User PATH in PowerShell:\n\n```\n$currentPath = [Environment]::GetEnvironmentVariable('PATH', 'User')\n[Environment]::SetEnvironmentVariable('PATH', \"$currentPath;$env:USERPROFILE\\.local\\bin\", 'User')\n```\n\nThen open a new terminal. A window that was already open keeps its old PATH, and so does a terminal built into an editor such as VS Code, so quit and reopen the editor too.",
        "**`'claude' is not recognized` right after an update.** To update on Windows, Claude Code renames the old `claude.exe` aside and moves the new one in. If that move fails, the folder can be left with only a backup named `claude.exe.old.` followed by a timestamp. Anthropic's fix, in PowerShell:\n\n```\nGet-ChildItem \"$env:USERPROFILE\\.local\\bin\\claude.exe.old.*\" | Sort-Object Name | Select-Object -Last 1 | Rename-Item -NewName claude.exe\n```\n\nIf there is no backup file, run the installer again.",
        "**`The process cannot access the file ... because it is being used by another process`.** A previous install attempt is still running, or antivirus is scanning a half-downloaded file. Close other PowerShell windows, wait for the scan to finish, then clear the downloads folder and retry:\n\n```\nRemove-Item -Recurse -Force \"$env:USERPROFILE\\.claude\\downloads\"\nirm https://claude.ai/install.ps1 | iex\n```",
        "**`running scripts is disabled on this system`.** This shows up with npm installs. PowerShell's execution policy is blocking the `.ps1` launchers npm creates. The PowerShell installer is not affected, because it runs downloaded text directly. Anthropic's options are to allow locally created scripts for your user with `Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser`, to call `claude.cmd` instead of `claude`, or to switch to the PowerShell installer.",
        "**`Claude Code on Windows requires either Git for Windows (for bash) or PowerShell`.** Neither shell was found. If PowerShell is missing from your PATH, add `C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\` to it, or install PowerShell 7. Alternatively install Git for Windows with \"Add to PATH\" selected and restart your terminal.",
        "**TLS or certificate errors on a work network.** Corporate proxies often cause these. Anthropic's page covers them in detail: add your proxy's certificate to the Windows certificate store and run the PowerShell installer, or, if the failing step is the CMD `curl` download, rerun it with `--ssl-revoke-best-effort`. That is your IT team's call, so follow the page rather than a forum post.",
      ],
    },
    {
      heading: "Line endings, paths and permissions",
      paragraphs: [
        "Three Windows habits cause trouble that no installer fixes. Anthropic's pages don't cover the first two directly, so treat the following as general Git and Windows practice, not Claude Code settings.",
        "**Line endings.** Windows text files often use CRLF, and Linux tools and many shell scripts expect LF. Git can convert between the two: with `core.autocrlf` set to `true`, Git converts CRLF to LF on commit and LF to CRLF on checkout, as the [git-config documentation](https://git-scm.com/docs/git-config) describes. That is the right default for a repo you only touch on Windows. If the same repo is also used from WSL or a Linux machine, agree on one setting for the whole team, or Claude Code will show you diffs where every line has changed.",
        "**Paths.** Windows uses backslashes and drive letters, WSL sees the same drive at `/mnt/c/`, and Git Bash writes paths in a third style. When you paste a path into a prompt, use the style of the shell Claude Code is running in. The simplest way to avoid mix-ups is to pick one place for each project and stay there. In WSL that means the Linux file system, for the speed and search reasons given earlier.",
        "**Permissions.** Claude Code asks before it edits files or runs commands, in every setup. That is the main safety net, and it matters more on Windows because native Windows has no sandbox to fall back on. If a command fails with access denied, the first thing to check is whether the folder is one your user can write to. The installer itself writes under your user profile, which is writable by default, so it needs no Administrator rights.",
      ],
    },
    {
      heading: "The catch with any Windows PC: it sleeps",
      paragraphs: [
        "Native or WSL, Claude Code is running on a computer that you also use for everything else. That has one big consequence: when the PC sleeps, hibernates, restarts for an update or loses power, the session stops. WSL stops with Windows, and a terminal on a laptop stops with the lid.",
        "For a quick bug fix or a pairing session that doesn't matter. For a long refactor, a big test run or anything you'd like to check from your phone later, it does. You can tweak power settings to stop the PC sleeping, but that's fighting the machine's job. The cleaner answer is to run Claude Code on a Linux computer that is meant to stay on, and reach it from your PC.",
        "There are guides on our blog for that situation: [how to keep Claude Code running 24/7](/blog/keep-claude-code-running-24-7), [how Remote Control works and how to keep it online](/blog/claude-code-remote-control), and [using Claude Code from your phone](/blog/claude-code-on-your-phone).",
      ],
    },
    {
      heading: "Native Windows vs WSL vs a remote Linux computer",
      paragraphs: [
        [
          "| | Native Windows | WSL 2 | Remote Linux computer |",
          "|---|---|---|---|",
          "| Setup | One PowerShell or CMD command | Turn on WSL 2, then the Linux installer | Rent or provision a machine, then the Linux installer |",
          "| Sandboxing | Not supported | Supported | Supported on Linux |",
          "| Best project location | Windows drive | Linux file system under `/home/` | The machine's own disk |",
          "| Keeps going when your PC sleeps | No | No | Yes, if the machine stays on and you start long runs inside tmux |",
          "| Good for | Windows-native projects and tools | Linux toolchains and sandboxing | Long-running jobs and reaching your work from any device |",
          "| Ongoing upkeep | Self-updating | Self-updating, plus WSL itself | OS, updates, access and security are yours, unless it is managed |",
        ].join("\n"),
        "The honest takeaway is that for many Windows users, native or WSL is enough. If you open a terminal, work with Claude Code while you are at your desk, and close it when you leave, a remote machine adds nothing you need. The remote option earns its keep when work should continue without your PC, or when you want one environment you can open from a laptop, a desktop and a phone.",
      ],
    },
    {
      heading: "A Linux computer for Claude Code on Hivra",
      paragraphs: [
        "If the sleeping PC is your problem, Hivra gives Claude Code a ready Linux computer of its own. You launch Claude Code from the dashboard and the official Anthropic CLI is already installed, so there is no WSL to turn on, no installer to run and no PATH to fix. You reach its terminal and files from a browser on your PC, your phone or a borrowed laptop.",
        `The computer stays on when your PC goes to sleep. It keeps your files, sessions and login, and a Claude Code run you start inside tmux in the computer's Terminal tab keeps going after you close the laptop. On Claude Code, work you send through Telegram, connected in the agent's Telegram tab, runs on the computer, not in your browser. Plans start at ${ENTRY_PLAN_PRICE} a month for ${ENTRY_PLAN_SIZE}. You sign in with your own Anthropic account on the computer, so Hivra hosting does not include or replace a Claude subscription. Hivra is not affiliated with Anthropic.`,
        "**You aren't locked into one agent.** The same Hivra account launches [Hermes](/agents/hermes), [OpenClaw](/agents/openclaw), [Claude Code](/agents/claude-code), [Codex](/agents/codex) and [Agent Zero](/agents/agent-zero), each on a computer of its own, and you reach all of them from a browser on any device. If you want to try Codex next to Claude Code, you don't need a second setup.",
        "**Where another option fits better.** If you work at your desk and your project lives on your PC, native or WSL is simpler and costs nothing extra beyond your Claude account. Typing into a terminal in a phone browser is still typing into a terminal. And Hivra administrators retain infrastructure access to the managed computers, so keep truly secret material off a hosted machine.",
        "[Launch Claude Code on Hivra](/agents/claude-code) if you want it running on a computer that doesn't sleep when your PC does.",
      ],
    },
    {
      heading: "Which one should you pick?",
      paragraphs: [
        "Pick **native Windows** if your projects and tools live on Windows and you want to be running in a couple of minutes of typing, not hours of setup. Install Git for Windows if you want the Bash tool.",
        "Pick **WSL 2** if your code targets Linux, you want sandboxed command execution, or your team's scripts assume a Linux shell. Keep the project in `/home/`.",
        "Pick **a remote Linux computer**, such as one on Hivra, when Claude Code has to carry on after your PC sleeps, or when you want to reach the same workspace from more than one device.",
        "These are not exclusive. Plenty of people use native Claude Code for quick tasks at their desk and a remote computer for the long ones.",
      ],
    },
  ],
  faqs: [
    {
      q: "Can you run Claude Code on Windows?",
      a: "Yes. Claude Code runs natively on Windows 10 version 1809 or later and Windows Server 2019 or later. Open PowerShell and run irm https://claude.ai/install.ps1 | iex, or use the CMD command from Anthropic's setup page. You can also run it inside WSL.",
    },
    {
      q: "Do I need WSL to use Claude Code on Windows?",
      a: "No. Native Windows is supported, and Anthropic recommends the native installer. WSL 2 is worth choosing if your project needs Linux tools or you want Claude Code's sandboxing, which native Windows does not support.",
    },
    {
      q: "Do I need Git for Windows to run Claude Code?",
      a: "No, it is optional. Without it, Claude Code runs shell commands through its PowerShell tool. With it installed, Claude Code uses Git Bash for the Bash tool. If it can't find Git Bash, set CLAUDE_CODE_GIT_BASH_PATH in settings.json.",
    },
    {
      q: "What are the system requirements for Claude Code on Windows?",
      a: "Windows 10 version 1809 or later or Windows Server 2019 or later, 4 GB of RAM or more, an x64 or ARM64 processor, an internet connection, and PowerShell or CMD. You also need a Pro, Max, Ultra, Team, Enterprise or Console account.",
    },
    {
      q: "Why does Windows say 'claude' is not recognized?",
      a: "The install folder is not on your PATH yet. The installer puts claude.exe in %USERPROFILE%\\.local\\bin. Add that folder to your User PATH, then open a new terminal, because windows that were already open keep the old PATH. Anthropic's troubleshooting page has the exact PowerShell commands.",
    },
    {
      q: "Is Claude Code free on Windows?",
      a: "The software installs for free, but using it needs a Pro, Max, Ultra, Team, Enterprise or Console account. The free claude.ai plan does not include Claude Code. See our Pro vs Max guide for how the plans compare.",
    },
    {
      q: "Should I install Claude Code with npm or the native installer?",
      a: "Use the native installer unless you have a reason not to. npm needs Node.js 22 or later and, on Windows, can hit a PowerShell execution policy error. The native installer updates itself, while npm and WinGet installs are updated by you.",
    },
    {
      q: "Does Claude Code keep running when my Windows PC sleeps?",
      a: "No. Native and WSL sessions run on your PC, so they stop when it sleeps or shuts down. To keep a long job going, run Claude Code on a Linux computer that stays on, and start the run inside tmux. A managed computer such as Hivra's removes the server upkeep.",
    },
    {
      q: "Can I use Claude Code on Windows without the terminal?",
      a: "Yes. Anthropic offers a Claude desktop app for Windows, including an ARM64 installer, which can run Claude Code sessions without you typing commands. It can also run sessions inside a WSL 2 distribution.",
    },
  ],
  relatedArticles: [
    { slug: "claude-code-on-linux", title: "Claude Code on Linux: install, sign in, run it on a server and fix common errors" },
    { slug: "keep-claude-code-running-24-7", title: "Will Claude keep running if you close your laptop or lock it? (And how to run Claude Code 24/7)" },
    { slug: "claude-code-remote-control", title: "Claude Code Remote Control: how it works and how to keep it online" },
    { slug: "claude-max-vs-pro-for-claude-code", title: "Claude Code pricing: Pro vs Max, and when API billing is cheaper" },
    { slug: "claude-code-on-your-phone", title: "Claude Code on your phone: every way to use it from mobile (as of November 2026)" },
  ],
  relatedComparisons: [{ slug: "vs-self-hosted", title: "Hivra vs self-hosted VPS" }],
};
