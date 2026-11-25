import { BlogArticle } from "../types";
import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE } from "../plan-facts";
import { CLI_RUN_LIFETIME } from "../runtime-facts";

// Written 2026-11-19 for "claude code linux" (US 1,300 searches a month, KD 27, rising 46%). It is the Linux hub page:
// Remote Control depth stays in claude-code-remote-control, keeping it alive in keep-claude-code-running-24-7, VPS sizing
// in ai-agent-vps, the permission flag in claude-code-dangerously-skip-permissions. Windows lives in claude-code-on-windows.
// Competing pages read for intent on 2026-11-19 (not used as fact sources): computingforgeeks.com/install-claude-desktop-claude-code-linux,
// linuxcapable.com/how-to-install-claude-code-on-ubuntu-linux, linuxize.com/post/how-to-install-claude-code-on-linux,
// morphllm.com/claude-code-linux, codeagentswarm.com/en/guides/claude-code-on-linux, claudecodeclub.ai/blog/claude-code-linux.
// Primary sources, all fetched 2026-11-19:
// https://code.claude.com/docs/en/setup (requirements, install.sh, apt/dnf/apk, npm, Alpine, verify, update, channels, network storage, uninstall)
// https://code.claude.com/docs/en/troubleshoot-install (PATH, directory permissions, low-memory servers, musl/glibc, Illegal instruction, Bus error, npm errors, OAuth over SSH)
// https://code.claude.com/docs/en/troubleshooting (ripgrep and USE_BUILTIN_RIPGREP, clipboard over SSH)
// https://code.claude.com/docs/en/authentication (browser login, paste code, claude auth login, credentials file on Linux, claude setup-token)
// https://code.claude.com/docs/en/remote-control (needs a claude.ai login, local process must keep running, tmux or screen on a remote machine)
// https://code.claude.com/docs/en/desktop-linux (desktop app beta: Ubuntu 22.04+ or Debian 12+, x86_64 or arm64)
// https://github.com/tmux/tmux/wiki/Getting-Started (new -s, C-b d, ls, attach -t)
// Hivra facts: lib/hivra/agent-seo-catalog.ts and app/agents/content/claude-code.ts (official Anthropic CLI installed, browser terminal,
// files, Telegram tab, tmux guidance), lib/blog/runtime-facts.ts (CLI_RUN_LIFETIME), lib/blog/plan-facts.ts (price and size).
// Not claimed: affiliation with Anthropic; Hivra setup times; backups; any VPS provider price; Claude plan prices or limits.

export const claudeCodeOnLinux: BlogArticle = {
  slug: "claude-code-on-linux",
  title: "Claude Code on Linux: install, sign in, run it on a server and fix common errors",
  metaTitle: "Claude Code on Linux: install, sign in and run it 24/7",
  metaDescription:
    "How to install Claude Code on Linux, sign in on a desktop or an SSH server, keep it running in tmux, update it and fix the usual errors.",
  publishedDate: "2026-11-19",
  lastModified: "2026-11-19",
  readingTimeMin: 13,
  author: "Hivra team",
  tagline: "One command to install, one browser tab to sign in, and a few Linux gotchas worth knowing about.",
  intro:
    "Claude Code runs well on Linux, and Anthropic's own docs treat it as a first-class platform. This guide covers what you need, the install command, signing in on a desktop and on a headless server, keeping it alive on a VPS, updating, and the errors people actually hit, using only what Anthropic documents as of November 2026.",
  shortAnswer:
    "To use Claude Code on Linux, run `curl -fsSL https://claude.ai/install.sh | bash`, then `claude`, and sign in through the browser. It needs Ubuntu 20.04+, Debian 10+ or Alpine 3.19+, 4 GB of RAM and a Claude Pro, Max, Team, Enterprise or Console account. On a server, run it inside tmux.",
  sections: [
    {
      heading: "What you need before you install",
      paragraphs: [
        "Anthropic's setup page lists the requirements for the command-line version of Claude Code. On Linux they are:",
        "- **Operating system:** Ubuntu 20.04 or later, Debian 10 or later, or Alpine Linux 3.19 or later. Fedora and RHEL are covered through Anthropic's dnf repository.\n- **Hardware:** 4 GB of RAM or more, and an x64 or ARM64 processor.\n- **Shell:** Bash or Zsh.\n- **Network:** an internet connection, since the model runs on Anthropic's side. Claude Code is also limited to Anthropic's supported countries.\n- **Account:** a Claude Pro, Max, Ultra, Team or Enterprise subscription, or a Claude Console account. The free claude.ai plan does not include Claude Code. Amazon Bedrock, Google Cloud's Agent Platform and Microsoft Foundry also work as providers.",
        "One more thing to know: there is a separate Claude desktop app for Linux, in beta, for Ubuntu 22.04 or later and Debian 12 or later on x86_64 or arm64. This guide is about the terminal version, which is the one that works on a server, and it runs on every distribution above. Anthropic's own advice for Fedora, Arch and other non-Debian distributions is to use the command-line version too.",
        "On Windows? Use WSL and follow the Linux steps here, or read [Claude Code on Windows](/blog/claude-code-on-windows).",
      ],
    },
    {
      heading: "The native install script (the recommended way)",
      paragraphs: [
        "Anthropic marks the native installer as the recommended method. Open a terminal and run:",
        "```bash\ncurl -fsSL https://claude.ai/install.sh | bash\n```",
        "The installer puts a launcher at `~/.local/bin/claude`, which is a symlink into `~/.local/share/claude/versions/`. It needs no sudo, no Node.js and no npm. When it finishes, check it worked:",
        "```bash\nclaude --version\nclaude doctor\n```",
        "`claude --version` prints a version number such as `2.1.211 (Claude Code)`. `claude doctor` prints a read-only health report: install health, settings errors and warnings with suggested fixes, without starting a session.",
        "If your shell says `claude: command not found` after the install, `~/.local/bin` is probably missing from your PATH. The installer reports this under \"Setup notes\" and prints the fix, but it doesn't change PATH itself. To check and fix it in Bash:",
        "```bash\nls -la ~/.local/bin/claude\necho $PATH | tr ':' '\\n' | grep -Fx \"$HOME/.local/bin\"\necho 'export PATH=\"$HOME/.local/bin:$PATH\"' >> ~/.bashrc\nsource ~/.bashrc\n```",
        "The first command confirms the program is there, the second shows whether the folder is on your PATH, and the last two add it permanently for Bash. For Zsh, use `~/.zshrc` in place of `~/.bashrc`. Prefer to skip the server setup? [Claude Code on Hivra](/agents/claude-code) comes with the official CLI already installed.",
      ],
    },
    {
      heading: "Other Linux install methods: apt, dnf, apk and npm",
      paragraphs: [
        "The install script is not the only documented route. Anthropic publishes signed package repositories and an npm package, and each suits a different situation.",
        [
          "| Method | Best for | Auto-updates? | Notes |",
          "|---|---|---|---|",
          "| Native script (`install.sh`) | Most people, desktop or server | Yes, in the background | No sudo, no Node.js. Installs under your home directory |",
          "| apt, dnf or apk repository | Managed fleets, or anyone who wants the system package manager in charge | No, you upgrade with the package manager | Signed repositories, with a `stable` channel and a `latest` channel |",
          "| npm (`npm install -g @anthropic-ai/claude-code@latest`) | People who already live in npm | Yes, if the global directory is writable | Needs Node.js 22 or later. Installs the same native binary |",
        ].join("\n"),
        "The apt, dnf and apk repositories each offer two channels. `stable` serves a version about a week old that skips releases with major regressions. `latest` serves every release as soon as it ships. Anthropic's page has the exact repository setup for each package manager, including the signing key and its fingerprint, so copy those commands from the [setup page](https://code.claude.com/docs/en/setup#install-with-linux-package-managers) rather than from a blog. Once a repository is configured, installing and upgrading are the normal commands:",
        "```bash\nsudo apt install claude-code\nsudo apt update && sudo apt upgrade claude-code\n```",
        "On Fedora and RHEL the equivalents are `sudo dnf install claude-code` and `sudo dnf upgrade claude-code`.",
        "**npm.** The npm package needs Node.js 22 or later. On an older Node, npm prints an `EBADENGINE` warning and finishes the install anyway, and the installed `claude` still runs, because the package downloads a native binary that does not use your Node. Never use `sudo npm install -g`: Anthropic warns it causes permission problems and security risks, and an install that needs sudo can't update itself. Avoid `npm update -g` too, since it may not move you to the newest release. One more trap: npm 12 skips the package's postinstall step by default, so `claude` can then fail with `Error: claude native binary not installed.` Check with `npm --version`; if it starts with 12, Anthropic's fix is to switch to the native installer or allow the step, as its [npm 12 instructions](https://code.claude.com/docs/en/troubleshoot-install#fix-an-npm-12-install) describe.",
        "**Alpine.** Alpine ships without `bash` and `curl`, so the install command fails with a `not found` error until you add them:",
        "```bash\napk add bash curl\n```",
        "Alpine is a musl distribution, and the installer picks the matching musl binary for it. The docs also list `libgcc`, `libstdc++` and `ripgrep` as things it needs on Alpine, so install those too.",
      ],
    },
    {
      heading: "Signing in on a Linux desktop",
      paragraphs: [
        "On a desktop, signing in is the easy case. Run `claude`, and Claude Code opens your browser so you can log in with your claude.ai account (or your Console account, if that is what you use). Approve the request and you are back in the terminal, signed in.",
        "If the browser does not open on its own, press `c` at the login prompt to copy the login URL, and paste it into a browser. If the browser shows a login code instead of redirecting back, paste that code into the terminal where it says `Paste code here if prompted`.",
        "There is one shortcut: if you have set the `ANTHROPIC_API_KEY` environment variable and approve the key when Claude Code asks, it skips the browser login and uses that key instead of your subscription login. The key is a Claude Console API credential, so usage goes to the Console account that owns it, not your Pro or Max plan. Choose it deliberately.",
        "On Linux, Claude Code stores your login in `~/.claude/.credentials.json` with file mode `0600`, so only your user can read it. To sign out and sign in again, type `/logout` inside Claude Code.",
      ],
    },
    {
      heading: "Signing in on a headless server over SSH",
      paragraphs: [
        "A server has no browser, so the normal flow looks stuck. Anthropic documents the fix in its troubleshooting page for \"OAuth login fails in WSL2, SSH, or containers\". You sign in through the URL the terminal prints, on a browser on your own computer:",
        "1. SSH into the server and run `claude`.\n2. At the login prompt, press `c` to copy the login URL, or select it in the terminal. With `claude auth login`, copy the URL it prints.\n3. Open that URL in a browser on your local machine and sign in.\n4. The browser shows a code instead of returning to `localhost`. Paste that code into the terminal at the prompt that begins `Paste code here`.",
        "If pasting into the interactive prompt does nothing, your terminal's paste shortcut may not be reaching the input field. Try an alternate shortcut, such as Shift+Insert, or use `claude auth login`, which reads the pasted code from standard input:",
        "```bash\nclaude auth login\n```",
        "**Tokens for scripts.** For CI jobs and scripts where no interactive login is possible, Anthropic documents `claude setup-token`. It opens the same browser authorization as `/login` and prints a one-year OAuth token, which it does not save anywhere. You copy the token and set it as an environment variable where you want to authenticate:",
        "```bash\nclaude setup-token\nexport CLAUDE_CODE_OAUTH_TOKEN=your-token\n```",
        "That token needs a Pro, Max, Ultra, Team or Enterprise subscription and can only make model requests. It can't start Remote Control sessions or fetch claude.ai connectors, so for those you need a normal interactive login on the server. Treat the token like a password: anyone who has it can use your subscription.",
      ],
    },
    {
      heading: "Running Claude Code on a Linux server or VPS",
      paragraphs: [
        "A VPS is the usual answer to \"I want Claude Code working when my laptop is shut\". It is an ordinary Linux machine in a data centre that stays on, so the setup is the install above plus one habit: run `claude` inside tmux so an SSH disconnect doesn't end the session. Anthropic's Remote Control docs say the same thing: if you run `claude` from a terminal on a remote machine, start it inside `tmux` or `screen` so it keeps going after you disconnect from SSH.",
        "The tmux basics, from the tmux project's own getting-started page:",
        "```bash\n# start a named session and run Claude Code inside it\ntmux new -s claude\nclaude\n\n# detach and leave it running: press Ctrl+b, then d\n\n# list sessions, then reattach later from any SSH connection\ntmux ls\ntmux attach -t claude\n```",
        "Detaching leaves the session running on the server. Reconnect from your phone, a different laptop or another office, run `tmux attach`, and you are back in the same conversation. If you have not used tmux before, our [tmux cheat sheet](/tools/tmux-cheat-sheet) lists the keys.",
        "**What the server needs.** The requirement is 4 GB of RAM or more. Smaller VPS plans are where people hit the install problem in the next section. Pick a server that matches the system requirements, and see [our AI agent VPS guide](/blog/ai-agent-vps) for sizing and providers.",
        "**Reaching it from a phone or browser.** Claude Code has a feature called Remote Control that lets claude.ai/code or the Claude mobile app drive a session running on your machine, with the session still running locally. It needs a claude.ai subscription login (not an API key), and the `claude` process has to stay running, which is why tmux matters again. The full walkthrough is in [Claude Code Remote Control: how it works and how to keep it online](/blog/claude-code-remote-control), and our guide to [running Claude Code 24/7](/blog/keep-claude-code-running-24-7) goes through the other ways to keep a session alive.",
        "**Unattended work and permissions.** On a server you will eventually want Claude Code to work without stopping to ask permission on every command. There is a flag for that, and it deserves care. [What `--dangerously-skip-permissions` skips, and where to run it](/blog/claude-code-dangerously-skip-permissions) explains the trade-off. A disposable server with nothing valuable on it is a much safer place for it than your main machine.",
        "**Connecting tools.** Local (stdio) MCP servers you add with `claude mcp add` run on the same machine as Claude Code, so on a server they keep working after you disconnect, as long as the `claude` session does. Remote (HTTP) servers run at the provider, and Claude Code only connects to them. [Claude Code MCP: how to add and manage MCP servers](/blog/claude-code-mcp) covers the commands, scopes and sign-in.",
      ],
    },
    {
      heading: "Updating Claude Code on Linux",
      paragraphs: [
        "How you update depends on how you installed.",
        "**Native install.** Claude Code checks for updates on startup and periodically while it runs, installs them in the background and applies them the next time you start it. To update right now:",
        "```bash\nclaude update\n```",
        "When an update installs, the command prints a line ending in `to version <new version>`. `claude doctor` shows the result of the last update attempt, which is the first place to look if updates seem stuck.",
        "**apt, dnf and apk.** These do not auto-update through Claude Code. Updates arrive with your normal system upgrades, or by running the upgrade command yourself, such as `sudo apt update && sudo apt upgrade claude-code`.",
        "**npm.** Run `npm install -g @anthropic-ai/claude-code@latest`, not `npm update -g`.",
        "**Release channel.** The `autoUpdatesChannel` setting in `settings.json` takes `\"latest\"` (the default, newest features straight away) or `\"stable\"` (about a week old, skipping releases with major regressions). If you run Claude Code on a machine you can't easily fix, `stable` is the cautious choice. Anthropic notes a newly released model may need the latest channel.",
        "**Pinning or turning updates off.** The install script accepts a channel or version number, for example `curl -fsSL https://claude.ai/install.sh | bash -s stable`. To stop background updates, set `DISABLE_AUTOUPDATER` to `\"1\"` in the `env` block of `settings.json`. That only stops the background check, and `claude update` still works. `DISABLE_UPDATES` blocks every update path.",
      ],
    },
    {
      heading: "Common Linux errors and how to fix them",
      paragraphs: [
        "These are the Linux problems Anthropic's troubleshooting pages cover, with the documented fix for each.",
        "**`claude: command not found`.** `~/.local/bin` is not on your PATH. Check with `ls -la ~/.local/bin/claude`, then add it to your shell profile as shown in the install section above.",
        "**Permission errors during install.** The native installer writes to `~/.claude/`, `~/.local/bin/`, `~/.local/share/claude/`, `~/.local/state/claude/`, `~/.cache/claude/` and `~/.claude.json`. Check the two main ones:",
        "```bash\ntest -w ~/.local/bin && echo \"writable\" || echo \"not writable\"\ntest -w ~/.claude && echo \"writable\" || echo \"not writable\"\n```",
        "If either is not writable, create the folder and make yourself the owner:",
        "```bash\nsudo mkdir -p ~/.local/bin\nsudo chown -R $(whoami) ~/.local\n```",
        "Those two commands repair `~/.local`. If it was `~/.claude` that failed the check, the installer can't write its downloads there either, so take that folder back too with `sudo chown -R $(whoami) ~/.claude`, then run both `test -w` checks again before you retry the install.",
        "If the problem was npm's global directory, Anthropic's advice is to switch to the native installer rather than reach for sudo.",
        "**The install is `Killed` on a small VPS.** A `Killed` message, exit code 137 and a note about running out of memory mean the Linux out-of-memory killer stopped the install. Installing needs roughly 512 MB of free memory, and running Claude Code needs more. Anthropic's fixes are to add swap, close other processes or use a larger server. A 2 GB swap file:",
        "```bash\nsudo fallocate -l 2G /swapfile\nsudo chmod 600 /swapfile\nsudo mkswap /swapfile\nsudo swapon /swapfile\n```",
        "Then run the install command again. Anthropic's note is that Claude Code needs at least 4 GB of RAM, so swap gets you through the install but a bigger server is the real fix.",
        "**Node version warnings (`EBADENGINE`).** This only affects the npm install, which wants Node.js 22 or later. On an older Node it warns and finishes anyway, and the installed `claude` still runs. If you'd rather not manage Node at all, use the native script.",
        "**Search, `@file` mentions or custom skills find nothing (ripgrep).** The bundled `ripgrep` may not run on your system. Install your distribution's package (`sudo apt install ripgrep` on Ubuntu and Debian, `apk add ripgrep` on Alpine, `pacman -S ripgrep` on Arch), then tell Claude Code to use it by setting `USE_BUILTIN_RIPGREP` to `\"0\"` in the `env` block of `settings.json`:",
        "```json\n{\n  \"env\": {\n    \"USE_BUILTIN_RIPGREP\": \"0\"\n  }\n}\n```",
        "Run `claude doctor` afterwards. The Search line should show your system ripgrep's path instead of `OK (bundled)`.",
        "**Missing shared library (`ld-linux-x86-64.so.2` and similar).** The installer may have picked the wrong libc variant. Check which libc you have with `ldd --version 2>&1 | head -1`. On glibc with a musl binary, remove the install and reinstall. On musl (Alpine) with a glibc binary, install the packages named above and rerun the install command.",
        "**`Illegal instruction`.** Either the architecture is wrong (for example an x86 binary on an ARM server; check with `uname -m`) or your CPU lacks AVX. On a VPS, `grep -m1 -ow avx /proc/cpuinfo` printing nothing means the hypervisor isn't passing AVX to your server. Anthropic lists no workaround for the AVX case, and other install methods download the same binary, so the fix is a different host or machine.",
        "**`Bus error` while a session is running.** The executable disappeared from under a running session, which happens on network storage such as an NFS home directory when an upgrade deletes the old binary. Install on local disk, for example with a Linux package manager, and keep each version in its own directory.",
        "When none of this fits, `claude doctor` is the first diagnostic to run, and Anthropic's [installation troubleshooting page](https://code.claude.com/docs/en/troubleshoot-install) lists many more cases.",
      ],
    },
    {
      heading: "Own Linux desktop, VPS or a managed Linux computer: which fits?",
      paragraphs: [
        "There are three realistic places to run Claude Code on Linux, and the install is the same on each. What differs is who looks after the machine and whether it is on when you are not.",
        [
          "| | Your own Linux desktop or laptop | A VPS you rent | A Hivra computer |",
          "|---|---|---|---|",
          "| Setup | The install script, then sign in | Create the server, harden SSH, install, sign in over SSH, install tmux | Launch Claude Code, open it in a browser |",
          "| Who maintains the OS | You | You | Hivra looks after the computer |",
          "| Keeps working when you disconnect | Only while the machine is awake and online | Yes, if you started it inside tmux | A run you start inside tmux keeps going. See the section below |",
          `| Cost | Free if you own the machine | A monthly server bill that varies by provider | From ${ENTRY_PLAN_PRICE} a month for ${ENTRY_PLAN_SIZE} |`,
          "| Reach it from your phone | SSH from a phone, or Remote Control while the machine is awake | SSH from a phone, or Remote Control | Open the computer in a browser on any device |",
          "| Control | Full | Full, including the firewall and the OS | Terminal, files and browser; Hivra manages the host |",
          "| Best for | Day-to-day coding at your desk | People comfortable running a Linux server | People who want the always-on setup without the server admin |",
        ].join("\n"),
        "A simple way to choose: if you only code at your desk, run it on your own Linux machine and skip everything else. If you want sessions to carry on while your laptop is shut, you need a machine that stays on, and the choice is between running one yourself and having one run for you.",
      ],
    },
    {
      heading: "Running Claude Code on a Hivra computer",
      paragraphs: [
        "Hivra is a managed alternative to the VPS route. A Hivra computer comes set up for Claude Code, so there is no server for you to administer and no install to debug. You launch Claude Code, and Hivra starts a private cloud computer reserved for it, with the official Anthropic CLI installed. You open its terminal, files and chat in a browser, from any device.",
        `You sign in with your own Anthropic account on that computer, the same way you would on a desktop, or you choose Hivra credits at launch and Claude Code runs on Claude models through Venice, paid from your credits. Hivra hosting does not include or replace an Anthropic subscription. Plans start at ${ENTRY_PLAN_PRICE} a month for ${ENTRY_PLAN_SIZE}.`,
        CLI_RUN_LIFETIME,
        "Hivra is not tied to one agent. The same account launches Hermes, OpenClaw, Claude Code, Codex and Agent Zero, each on a computer of its own, and you reach all of them from a browser on any device. If you try Codex next month, you don't need a second server, a second account or a second install to work out. Hivra is not affiliated with Anthropic.",
        "Two honest limits. A Hivra computer is a managed machine, so you don't get the freedom of a VPS you root yourself, and Hivra administrators retain infrastructure access to managed hosts. And if you are comfortable running your own VPS, you may not need Hivra at all: everything in the server section above works, and a rented server can be cheaper. Hivra is for the people who would rather skip the setup and keep the time.",
        "[See how Claude Code runs on Hivra](/agents/claude-code), or read how it compares to a plain server in [Hivra vs a self-hosted VPS](/compare/vs-self-hosted).",
      ],
    },
  ],
  faqs: [
    {
      q: "Does Claude Code work on Linux?",
      a: "Yes. Anthropic lists Ubuntu 20.04 or later, Debian 10 or later and Alpine Linux 3.19 or later as supported, on x64 or ARM64 with 4 GB of RAM or more. Install it with `curl -fsSL https://claude.ai/install.sh | bash`, then run `claude`. Fedora and RHEL users can use Anthropic's dnf repository.",
    },
    {
      q: "How do I install Claude Code on Ubuntu?",
      a: "Run `curl -fsSL https://claude.ai/install.sh | bash` in a terminal, then `claude --version` to confirm. You can also use Anthropic's signed apt repository, or npm with Node.js 22 or later. Don't use sudo with npm. Anthropic recommends the native script.",
    },
    {
      q: "Do I need Node.js to run Claude Code on Linux?",
      a: "Not for the recommended install. The native script needs no Node.js. Only the npm install wants Node.js 22 or later, and on an older Node it prints an EBADENGINE warning but still finishes, because the installed claude is a native binary that doesn't use your Node.",
    },
    {
      q: "How do I sign in to Claude Code on a headless Linux server?",
      a: "Run `claude` over SSH and press `c` to copy the login URL. Open it in a browser on your own computer, sign in, then paste the code the browser shows into the terminal at the `Paste code here` prompt. `claude auth login` works the same way if pasting fails. For scripts, `claude setup-token` makes a one-year token.",
    },
    {
      q: "How do I keep Claude Code running on a Linux server after I disconnect?",
      a: "Start it inside tmux: `tmux new -s claude`, run `claude`, then detach with Ctrl+b followed by d. Reattach later with `tmux attach -t claude`. Anthropic's Remote Control docs give the same advice for a remote machine: use tmux or screen so the session survives an SSH disconnect.",
    },
    {
      q: "How do I update Claude Code on Linux?",
      a: "A native install updates itself in the background, and `claude update` applies an update immediately. apt, dnf and apk installs update through your system's package manager, for example `sudo apt update && sudo apt upgrade claude-code`. For npm, run `npm install -g @anthropic-ai/claude-code@latest`.",
    },
    {
      q: "Why does the Claude Code install say Killed on my VPS?",
      a: "The Linux out-of-memory killer stopped it. Installing needs roughly 512 MB of free memory, and Claude Code needs at least 4 GB of RAM to run. Add a swap file, close other processes or move to a larger server, then run the install command again.",
    },
    {
      q: "What do I do when claude says command not found after installing?",
      a: "Your PATH is missing `~/.local/bin`, where the native installer puts the launcher. Add `export PATH=\"$HOME/.local/bin:$PATH\"` to `~/.bashrc` (or `~/.zshrc`), run `source ~/.bashrc`, and try again. `ls -la ~/.local/bin/claude` confirms the program is there.",
    },
    {
      q: "Is there a Claude Code desktop app for Linux?",
      a: "Yes, in beta, for Ubuntu 22.04 or later and Debian 12 or later on x86_64 or arm64, installed from Anthropic's apt repository. On other distributions such as Fedora or Arch, Anthropic says to use the command-line version instead.",
    },
    {
      q: "Do I need a VPS, or can I run Claude Code on my own Linux machine?",
      a: "Your own machine is enough if you only work at your desk. You need a machine that stays on if you want sessions to continue when your laptop is shut. That can be a VPS you manage, or a managed computer such as Hivra's, which skips the server setup.",
    },
  ],
  relatedArticles: [
    { slug: "keep-claude-code-running-24-7", title: "Will Claude keep running if you close your laptop or lock it? (And how to run Claude Code 24/7)" },
    { slug: "ai-agent-vps", title: "AI agent VPS guide: specs, providers, and setup that actually works (2026)" },
    { slug: "claude-code-remote-control", title: "Claude Code Remote Control: how it works and how to keep it online" },
    { slug: "claude-code-dangerously-skip-permissions", title: "Claude Code's --dangerously-skip-permissions flag: what it skips and where to run it" },
  ],
  relatedComparisons: [
    { slug: "vs-self-hosted", title: "Hivra vs self-hosted VPS" },
  ],
};
