import { BlogArticle } from "../types";
import { LARGER_PLAN_PRICE, LARGER_PLAN_SIZE, PLAN_SUMMARY } from "../plan-facts";

// Written 2026-10-02 for "claude dangerously skip permissions" (9,900 US searches a month, KD 7, Aug 2026 data), with the
// variants "claude code auto mode", "claude code yolo mode", "codex yolo", "claude code bypass permissions" and "claude
// code sandbox" folded into the sections below instead of getting pages of their own.
//
// Vendor facts were read on 2026-10-02 from the vendor's own pages: Anthropic's permission-modes, sandbox-environments,
// devcontainer, security, cli-reference, headless and tools-reference docs at code.claude.com, Anthropic's engineering
// post on auto mode (25 March 2026), and OpenAI's agent-approvals-security and developer-commands pages. Several of them
// are version-gated, so the page tells readers to run claude --version. Re-read the pages before changing a number, and
// keep the 2 October 2026 date beside every claim until you have.
//
// Hivra facts come from code: dashboard/provisioner/hivra-chat/server.js (Codex flags by restrict value, Claude flags by
// restrict value), HivraManage.tsx (the Permissions setting), provisioner/hivra-agent-shell (the session tabs start the
// CLI with no flags) and bux-hivra-chat.service (the chat service runs as a regular user). The claude-code-dangerously-
// skip-permissions test ties the flags in the Hivra table to that source.
//
// Left out on purpose: third-party incident stories and statistics (none is confirmed on a primary page), GitHub issue
// 93099 (its narrative says auto mode and its mode field says Accept Edits), and the phrase "Safe YOLO mode" (it is not in
// Anthropic's docs today). Not claimed: that a Hivra computer makes the flag safe, anything about outbound traffic or
// credential isolation inside a Hivra computer, which mode the session tabs start in, which CLI version a computer runs,
// that Limited stops every shell command, that Read-only can't run commands, that the non-root chat account limits what the
// agent can change (provisioner/system-prompt.md and computer-contract.ts say an agent's own computer gives it sudo, and the
// contract says a Codex agent added to an existing desktop has none), that Read-only denies every prompt (it sets no
// permission mode, so the run takes Claude Code's own starting mode), or that Remote Control works on a Hivra computer.
export const article: BlogArticle = {
  slug: "claude-code-dangerously-skip-permissions",
  title: "Claude Code's --dangerously-skip-permissions flag: what it skips and where to run it",
  metaTitle: "Claude --dangerously-skip-permissions: what it skips",
  metaDescription:
    "What Claude's --dangerously-skip-permissions flag skips, how it differs from auto mode, and where to run it. Checked against Anthropic's docs, 2 Oct 2026.",
  publishedDate: "2026-10-02",
  lastModified: "2026-10-02",
  readingTimeMin: 15,
  author: "Hivra team",
  tagline: "With the prompts off, the thing around Claude Code is your protection.",
  intro:
    "One flag turns off Claude Code's permission prompts, and Anthropic says to use it only inside a container or VM. We read the vendors' docs on 2 October 2026 and checked Hivra's defaults against our own code. Some checks still run with the flag on. A separate computer keeps a mistake off your laptop, and anything you sign in to on it stays in reach.",
  shortAnswer:
    "Claude Code's --dangerously-skip-permissions flag turns off its permission prompts, so commands and edits run without asking. Anthropic's docs, read 2 October 2026, say to run it only in a container or VM as a non-root user. Auto mode is the safer hands-off pick. A separate computer protects your laptop. It doesn't protect what you sign in to on it.",
  sections: [
    {
      heading: "What does --dangerously-skip-permissions do?",
      paragraphs: [
        "It starts Claude Code in `bypassPermissions` mode, which turns the permission prompts off. Tool calls run at once, and that includes writes to protected paths such as `.git` and `.claude`. The flag and `--permission-mode bypassPermissions` do the same thing ([CLI reference](https://code.claude.com/docs/en/cli-reference), [permission modes](https://code.claude.com/docs/en/permission-modes)).\n\nThe Anthropic facts in this guide are from its docs as read on 2 October 2026. Some of them depend on your Claude Code version, so run `claude --version` before you trust a line.",
        "Not everything switches off. Deny rules still block in every mode, bypass included, and ask rules still prompt. Allow rules do nothing here: with the flag on, an allowlist that leaves out `rm` doesn't stop `rm`.\n\nThen there are the protected paths. With the flag on, Claude Code writes to `.git`, `.claude`, `.vscode`, `.idea`, `.husky` and a few more folders without asking. It does the same for files such as `.gitconfig`, `.bashrc`, `.zshrc`, `.npmrc` and `.mcp.json`. Manual and accept-edits modes prompt for those writes. Anthropic guards them in those other modes to protect your repository state and Claude's own configuration.",
      ],
    },
    {
      heading: "Is --dangerously-skip-permissions safe?",
      paragraphs: [
        "Not by itself. Anthropic's docs, read on 2 October 2026, say bypass mode offers no protection against prompt injection or unintended actions, so whatever surrounds Claude Code is the protection you have. Anthropic says to use the mode only in isolated environments such as containers, VMs or dev containers, and its warning adds \"without internet access\". On its [sandbox page](https://code.claude.com/docs/en/sandbox-environments) it says to always run the flag inside a container, a VM or the sandbox runtime, so file tools, MCP servers and hooks sit inside the boundary too.",
        "It goes wrong in ordinary ways. The model points a delete at the wrong path, or reads a file or web page whose text steers it somewhere you never wanted it to go. Or it ends up holding a login, a key or a tool server you didn't mean to hand over. We don't know how often any of that happens, and we won't guess.",
        "Isolation helps, with a limit Anthropic states itself. It cuts the impact of a breach and doesn't remove the risk: an agent with network access can still leak what it can read, and a writable project mount can still be changed.\n\nPeople reach for the flag because prompts wear them out. Anthropic's [engineering post on auto mode](https://www.anthropic.com/engineering/claude-code-auto-mode), dated 25 March 2026, says users approve 93% of permission prompts. A prompt you click through that often was never much of a guard.",
      ],
    },
    {
      heading: "What are Claude Code's permission modes?",
      paragraphs: [
        "Six: Manual, `acceptEdits`, `plan`, `auto`, `dontAsk` and `bypassPermissions`. This table is from Anthropic's [permission modes page](https://code.claude.com/docs/en/permission-modes), read on 2 October 2026. Manual is the label for the config value `default`.",
        [
          "| Mode | Runs without asking | Start it with |",
          "|---|---|---|",
          "| `default` (Manual) | Reads only | `--permission-mode default` |",
          "| `acceptEdits` | Reads, file edits and common filesystem commands such as `mkdir`, `touch`, `rm`, `mv` and `cp`, inside the working directory | `--permission-mode acceptEdits` |",
          "| `plan` | Reads, plus classifier-approved commands when auto mode is available. Edits wait for a plan you approve | `--permission-mode plan` |",
          "| `auto` | Everything, with background safety checks by a second model | `--permission-mode auto` |",
          "| `dontAsk` | Reads and pre-approved tools. Anything that would prompt is denied | `--permission-mode dontAsk` |",
          "| `bypassPermissions` | Everything | `--dangerously-skip-permissions` |",
        ].join("\n"),
        "The Manual label and the `manual` alias need v2.1.200 or later. Auto mode has been the built-in starting mode for terminal and VS Code sessions since v2.1.283, and before that only on Pro, Max and Team plans. On the Anthropic API, auto needs Opus 4.6 or later, Sonnet 4.6 or later or a Fable model, and admins can turn it off. `dontAsk` never shows up in the Shift+Tab cycle, so you set it with the flag.\n\nEach app handles bypass its own way. VS Code needs its Allow dangerously skip permissions toggle. The desktop app needs Allow bypass permissions mode on Pro and Max, and organization policy decides on Team and Enterprise. Anthropic's cloud sessions don't offer bypass at all.",
      ],
    },
    {
      heading: "Should I use Claude Code's auto mode instead of --dangerously-skip-permissions?",
      paragraphs: [
        "On your own laptop, yes. Auto mode puts a second model, a classifier, in front of risky actions, which is a check the flag doesn't have. It blocks actions that go beyond what you asked, aim at infrastructure it doesn't recognise, or look driven by hostile content Claude read. After 3 blocks in a row or 20 in total it pauses and prompts you again. As of 2 October 2026, Anthropic's docs still warn that auto mode reduces prompts without guaranteeing safety.",
        "Anthropic published error rates for the classifier in the engineering post dated 25 March 2026. On 10,000 real tool calls from Anthropic's own staff, it wrongly blocked 0.4% of them. It let through 17% of 52 real cases where the agent went past what the user had authorised, and 5.7% of 1,000 synthetic data-exfiltration attempts. That 52 is a small set, and Anthropic calls the 17% the honest number. The same post calls auto mode a substantial improvement for people running the flag, then adds that it won't replace careful review on high-stakes infrastructure. Sonnet 5 is the default classifier model in the docs now, and we found no newer figures, so read those rates as March's, not today's.",
        "Anthropic calls the classifier a per-action control and says a container still adds a layer for unattended runs. For the flag, its docs say to use a container or VM. Auto mode doesn't come with that rule.\n\nOn a Hivra computer, Chat passes the skip flag by default. It doesn't pass auto mode.",
      ],
    },
    {
      heading: "What is the Codex equivalent of --dangerously-skip-permissions?",
      paragraphs: [
        "It's `--dangerously-bypass-approvals-and-sandbox`, which OpenAI also lets you type as `--yolo`. It turns off approvals and the sandbox together. OpenAI's [CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli) says to use it only inside an externally hardened environment, and its [approvals page](https://learn.chatgpt.com/docs/agent-approvals-security) lists it as no sandbox, no approvals, not recommended. Both pages were read on 2 October 2026.",
        [
          "Codex splits the dial in two:",
          "",
          "| Setting | Values |",
          "|---|---|",
          "| `--sandbox` | `read-only`, `workspace-write`, `danger-full-access` |",
          "| `--ask-for-approval` | `on-request`, `never` |",
        ].join("\n"),
        "`-a never` works with every sandbox mode, so you can switch the prompts off and keep the sandbox. OpenAI's advice for unattended local work that can stay inside the workspace is `--sandbox workspace-write`, and to avoid the bypass flag unless you're inside a dedicated sandbox VM.\n\nOn launch, Codex checks whether the folder is version controlled. For one that is, OpenAI recommends the Auto preset, which is workspace-write with on-request approvals. For any other folder it recommends read-only. OpenAI documents the workspace-write sandbox as keeping network access off until you turn it on in config (`sandbox_workspace_write.network_access`). That's OpenAI's stated default for the CLI. We haven't checked it on a Hivra computer.",
        "OpenAI gives the same warning Anthropic does. With the bypass flag or `danger-full-access` inside a devcontainer, a malicious project can exfiltrate anything available there, Codex credentials included, so use that pattern only with trusted repositories.",
      ],
    },
    {
      heading: "Where should I run --dangerously-skip-permissions so a mistake can't touch my laptop?",
      paragraphs: [
        "Inside a container, a VM or Anthropic's sandbox runtime. Anthropic puts the whole Claude Code process inside that boundary, because the sandboxed Bash tool alone leaves file tools, MCP servers and hooks outside it. The options below are from Anthropic's [sandbox environments page](https://code.claude.com/docs/en/sandbox-environments), read on 2 October 2026, plus one row of ours.",
        [
          "| Option | What it isolates | Worth knowing |",
          "|---|---|---|",
          "| Sandboxed Bash tool | Bash, PowerShell and Monitor commands | Not enough alone for unattended runs |",
          "| Sandbox runtime | The whole Claude Code process | A beta research preview |",
          "| Dev container | The development environment | Needs Docker. Anthropic's example has a default-deny firewall |",
          "| Custom container | The development environment | Needs Docker. You set the network rules |",
          "| Virtual machine | A full operating system | The strongest separation, with its own kernel |",
          "| Cloud sessions | An Anthropic-managed VM | Needs a Claude subscription. No bypass option |",
          "| A separate always-on computer | The agent's mistakes, away from your laptop | Whatever you sign in to on it stays reachable |",
        ].join("\n"),
        "If you only use Claude Code and your work lives on GitHub, start with Anthropic's cloud sessions. Anthropic's [security page](https://code.claude.com/docs/en/security) says its proxy holds the GitHub credential, and the session VM gets only a short-lived one scoped to that session. Its [permission modes page](https://code.claude.com/docs/en/permission-modes) lists no bypass option for cloud sessions. A plain computer, ours included, makes no such promise.\n\nFor Codex, OpenAI has its own cloud. Its approvals page describes the older Codex Cloud (Legacy) as isolated OpenAI-managed containers whose agent phase runs offline by default, and it points to other pages for the current one.",
      ],
    },
    {
      heading: "What does Hivra run Claude Code and Codex with?",
      paragraphs: [
        "By default, Chat runs Claude Code with the skip flag and Codex with its bypass flag. The Permissions setting on the agent's Manage tab narrows both to Limited or Read-only. The Claude Code session tab and the Codex session tab start the CLI with no permission flags.",
        [
          "| Permissions setting | Claude Code | Codex |",
          "|---|---|---|",
          "| Full access (the default) | `claude -p` with `--dangerously-skip-permissions` | `codex exec` with `--dangerously-bypass-approvals-and-sandbox` |",
          "| Limited | Keeps the skip flag, adds `--disallowedTools Bash` | `--sandbox workspace-write` |",
          "| Read-only | Drops the skip flag | `--sandbox read-only` |",
        ].join("\n"),
        "That table comes from Hivra's code. We haven't run a deletion or prompt-injection test against a Hivra computer, so none of it is a safety result.\n\nYou'll find it under Permissions on the Manage tab, and it applies from the next message. It shows only for Claude Code and Codex, and only on computers recent enough to support it. The session tabs are different: the CLI starts there with no flags, so you get its own default for its version and your account. The Terminal tab is a plain shell where you type your own flags.",
        "Limited removes the Bash tool for Claude Code. Anthropic's tool docs say Monitor commands follow the same rules as Bash, but we haven't tested what a Limited agent can still run, so treat Limited as less access and don't count on it as a lock on every shell command. Read-only drops the skip flag and sets no permission mode, so the run starts in whatever mode Claude Code picks for its version. For a `claude -p` run that's Manual in sessions that fetch feature flags. In sessions that don't, it's auto on v2.1.285 or later and Manual before that ([permission modes](https://code.claude.com/docs/en/permission-modes)). In a Manual run with nobody there to answer, Anthropic's [headless docs](https://code.claude.com/docs/en/headless) say requests that would prompt are denied, while reads and a built-in set of read-only commands still run. As for what a Read-only agent can still change, that's untested.\n\nChat runs as a regular user on the computer, not as root, which is the condition Anthropic sets for starting the flag on Linux. Don't read it as a limit. We haven't checked what that account can change, and on a computer launched for a Claude Code or Codex agent, Hivra's own instructions to the agent say it has sudo. Hivra pins the CLI version on its computers, so it can trail the newest release. Run `claude --version` in the Terminal tab and compare it with the version numbers in this guide.",
        "In Chat's default setting, no prompt stands between the agent and a command. The computer around it is the boundary. Anthropic's own example for unattended runs is `claude -p` with the flag inside an isolated environment. Whether a Hivra computer holds up as one, we haven't tested. It's a separate machine from your laptop. How much that protects depends on what you sign in to there.",
      ],
    },
    {
      heading: "What does a separate computer not protect?",
      paragraphs: [
        "Anything you sign in to on it. A computer of its own keeps a mistake off your laptop. An agent with full access can still reach every login, key and repository you put there.",
        "Anthropic warns about the same thing with containers, in docs read on 2 October 2026. With the skip flag on, a dev container doesn't stop a malicious project from exfiltrating anything accessible inside it, including the Claude Code credentials in `~/.claude` ([Anthropic, dev containers](https://code.claude.com/docs/en/devcontainer)). OpenAI says the same about Codex credentials. Both tell you to use trusted repositories only.\n\nOn Hivra, the Claude or ChatGPT login you use sits on the computer, and Hivra's admins can reach the host machines these computers run on. We're saying nothing, one way or the other, about outbound traffic limits or credential isolation on a Hivra computer. Assume the agent can reach whatever you put on it.",
        "So sign in with only what the job needs. Anthropic advises repository-scoped or short-lived tokens. Deploy keys, cloud credentials and production access shouldn't be on that computer at all. Try it on a throwaway repository first.",
      ],
    },
    {
      heading: "How do I limit the damage when Claude Code runs with the prompts off?",
      paragraphs: [
        "Give it less to break. Work on a branch, keep secrets off the machine, and add deny rules, because deny rules still block in bypass mode and allow rules do nothing there.",
        "`--disallowedTools` takes deny rules on the command line. A bare tool name such as `Edit` removes that tool from Claude's context, and a scoped rule such as `Bash(rm *)` leaves the tool and denies only matching calls. Anthropic's CLI reference, read on 2 October 2026, notes that Bash rules match a command as written, so a deny rule narrows what the agent does and doesn't make it safe. In `claude -p` runs, `--max-turns` and `--max-budget-usd` cap a run too, and they work in print mode only ([CLI reference](https://code.claude.com/docs/en/cli-reference)).\n\nOn Hivra, the Permissions setting on the agent's Manage tab (Limited or Read-only) cuts what a Claude Code or Codex agent can do. For Codex, `--sandbox workspace-write` suits unattended work that can stay inside the workspace. Plain habits help too: commit before a long run and read the diff after it.",
      ],
    },
    {
      heading: "Why does Claude Code still ask for permission with the flag on?",
      paragraphs: [
        "A few checks still run with the flag on. Ask rules prompt, deletes aimed at critical paths ask first, and an administrator can block the mode outright. Here are the details, plus the places where the mode isn't offered at all (from Anthropic's docs, as read on 2 October 2026):\n\n- Ask rules still prompt, and so do `rm` and `rmdir` aimed at a critical path: the filesystem root, top-level folders, your home directory, your working directory and its parents. In a terminal that prompt has a two-minute countdown, and Claude Code denies the command when it runs out (v2.1.281 or later).\n- With `permissions.blockReadsOutsideWorkingDirectories` on, some reads outside the working directory prompt even in bypass mode (v2.1.257 or later).\n- Administrators can block the mode with `permissions.disableBypassPermissionsMode`. On Linux and macOS, Claude Code refuses to start with the flag as root or under sudo, unless it detects a recognized sandbox.\n- You can't switch bypass on from a session that started without it. `--allow-dangerously-skip-permissions` puts it in the Shift+Tab cycle without turning it on. A `bypassPermissions` value in a project or local settings file has no effect on v2.1.257 or later, and the session starts in Manual mode. Before v2.1.257, a project file could turn it on.\n- VS Code and the desktop app need their own toggles. A session you steer from the Claude app through Remote Control can't pick Bypass or Auto. Cloud sessions don't offer it.\n- In a `claude -p` run with the flag, the few calls that would still prompt are denied instead. The first interactive start shows a warning dialog, and accepting it stores `skipDangerousModePermissionPrompt` in `~/.claude/settings.json`. `claude -p` shows no dialog.",
      ],
    },
    {
      heading: "Which setup should I pick to run Claude Code or Codex without prompts?",
      paragraphs: [
        "On a laptop with no sandbox, use auto mode. For Claude-only work on GitHub repositories, start with Anthropic's cloud sessions. For Claude Code or Codex on a computer that stays on, a Hivra computer fits, as long as you accept that anything you sign in to on it stays reachable.",
        [
          "| You want | Pick | Because |",
          "|---|---|---|",
          "| A laptop, and you're watching | Manual or auto | Manual asks before commands and edits. Auto has a classifier review commands and anything beyond reads and edits in your working directory |",
          "| A laptop and a long task | Auto, or the sandbox runtime | Auto needs no container. The sandbox runtime isolates the whole process |",
          "| A throwaway repository in your own container | The flag plus a default-deny firewall | It's the setup Anthropic's example dev container uses |",
          "| Claude Code only, work on GitHub | Anthropic's cloud sessions | Anthropic's proxy holds the GitHub credential, and there's no bypass option |",
          "| Codex only, in the cloud | OpenAI's own cloud | OpenAI's approvals page covers the older cloud's isolation and links to the current one |",
          "| Claude Code or Codex on a computer that stays on | A Hivra computer | It stays on and runs the official CLI with your own login. Whatever you sign in to on it stays reachable |",
        ].join("\n"),
        `A Hivra computer fits the last row only. In the other five rows, the pick in the middle column is the better call. ${PLAN_SUMMARY} The ${LARGER_PLAN_PRICE} plan is ${LARGER_PLAN_SIZE}. You can start from [the Claude Code agent page](/agents/claude-code) or [the Codex agent page](/agents/codex), and [the pricing page](/pricing) has the rest. For the wider question of leaving an agent running while you're away, read [is it safe to leave an agent running unattended](/blog/is-it-safe-to-leave-an-ai-agent-running-unattended). [Keeping Claude Code running 24/7](/blog/keep-claude-code-running-24-7) covers the staying-on part. Hivra is independent and is not affiliated with Anthropic or OpenAI.`,
      ],
    },
  ],
  faqs: [
    {
      q: "What does --dangerously-skip-permissions do?",
      a: "It starts Claude Code in bypassPermissions mode and turns off the permission prompts, so commands and file edits run without asking, including writes to protected paths such as .git and .claude. Deny rules still block, ask rules still prompt, and allow rules do nothing. Anthropic's docs, read 2 October 2026, say to use it only in isolated environments such as containers and VMs.",
    },
    {
      q: "Is --dangerously-skip-permissions safe?",
      a: "Not by itself. Anthropic's docs say bypass mode offers no protection against prompt injection or unintended actions, so the container, VM or sandbox around it is the protection. Isolation cuts the impact of a mistake, and an agent with network access can still leak what it can read. A separate computer keeps the damage off your laptop. Whatever you sign in to on it is still within the agent's reach.",
    },
    {
      q: "What is the difference between auto mode and --dangerously-skip-permissions?",
      a: "The flag turns the prompts off and puts nothing in their place. Auto mode has a second model review commands and anything beyond reads and edits in your working directory. It blocks actions that go beyond your request, aim at unrecognised infrastructure or look driven by hostile content. Anthropic says auto mode reduces prompts without guaranteeing safety, and its March 2026 post gave error rates for it. For the flag, its docs say to use it only inside a container or VM. Auto mode doesn't come with that rule.",
    },
    {
      q: "Can you run --dangerously-skip-permissions as root?",
      a: "Not on Linux or macOS. Claude Code refuses to start with the flag as root or under sudo, unless it detects a recognized sandbox. Anthropic's advice is to run the container, VM or sandbox runtime as a non-root user.",
    },
    {
      q: "Why does Claude Code still ask for permission with --dangerously-skip-permissions?",
      a: "A few checks still run with the flag on. Ask rules still prompt, and rm or rmdir aimed at a critical path such as your home directory still asks, with a two-minute countdown in a terminal on v2.1.281 or later. An administrator can block the mode, and a session that started without the flag can't switch it on later. In a claude -p run, the few calls that would still prompt are denied instead.",
    },
    {
      q: "Does --dangerously-skip-permissions ignore deny rules?",
      a: "No. Deny rules block in every mode, bypass included, and ask rules still prompt. Allow rules have no effect in bypass mode, so an allowlist that leaves out a command doesn't stop it. Deny rules are the rule type to add when you run the flag. Ask rules help too if someone's there to answer the prompt.",
    },
    {
      q: "Can I turn on bypass permissions in the middle of a session?",
      a: "Only if you started the session with it enabled. You can't enter bypassPermissions from a session that started without it. Launching with --allow-dangerously-skip-permissions adds it to the Shift+Tab cycle without turning it on. A bypassPermissions value in a project or local settings file has no effect on v2.1.257 or later, and the session starts in Manual mode.",
    },
    {
      q: "Does claude -p skip permissions?",
      a: "No. claude -p runs Claude Code without a terminal and doesn't turn permission checks off by itself. With nobody there to answer, Anthropic's headless docs say requests that would prompt are denied. For a fully unattended run, Anthropic's docs show claude -p with --dangerously-skip-permissions inside a container, a VM or the sandbox runtime.",
    },
    {
      q: "What is the Codex equivalent of --dangerously-skip-permissions?",
      a: "--dangerously-bypass-approvals-and-sandbox, which OpenAI also accepts as --yolo. It turns off approvals and the sandbox together, and OpenAI says to use it only inside an externally hardened environment. Codex also splits the controls: --sandbox takes read-only, workspace-write or danger-full-access, and --ask-for-approval takes on-request or never. For unattended local work that can stay inside the workspace, OpenAI suggests --sandbox workspace-write.",
    },
    {
      q: "Does Claude Code Desktop support skip permissions?",
      a: "Yes, behind a toggle. The desktop app's mode selector shows Bypass permissions only when Allow bypass permissions mode is on in Desktop settings, which you set yourself on Pro and Max. On Team and Enterprise, organization policy decides. VS Code has its own Allow dangerously skip permissions toggle, and Anthropic's cloud sessions don't offer bypass at all.",
    },
    {
      q: "What does Hivra run Claude Code and Codex with?",
      a: "By default, Chat runs Claude Code with --dangerously-skip-permissions and Codex with --dangerously-bypass-approvals-and-sandbox. The Permissions setting on the agent's Manage tab narrows that to Limited or Read-only from the next message. The Claude Code session tab and the Codex session tab start the CLI with no permission flags. Hivra is independent and is not affiliated with Anthropic or OpenAI.",
    },
  ],
  relatedArticles: [
    { slug: "is-it-safe-to-leave-an-ai-agent-running-unattended", title: "Is it safe to leave an AI agent running unattended? The four risks that matter" },
    { slug: "keep-claude-code-running-24-7", title: "Will Claude Code keep running if you close your laptop? (And how to run it 24/7)" },
    { slug: "claude-code-vs-codex-24-7", title: "Claude Code vs Codex for 24/7 autonomous work: which should you host?" },
    { slug: "run-codex-24-7-in-the-cloud", title: "How to run Codex 24/7 in the cloud (Codex CLI hosting explained)" },
    { slug: "claude-code-remote-control", title: "Claude Code Remote Control: how it works and how to keep it online" },
  ],
};
