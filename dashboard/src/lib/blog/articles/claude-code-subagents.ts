import { BlogArticle } from "../types";
import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE } from "../plan-facts";
import { CLI_RUN_LIFETIME } from "../runtime-facts";

// Written 2026-11-28 for "claude code subagents" (US about 1,600 searches a month, difficulty 19). Hub page for subagents in
// Claude Code. Hooks stay in claude-code-hooks, MCP in claude-code-mcp, the permission flag in
// claude-code-dangerously-skip-permissions, running it on a server in claude-code-on-linux.
// Primary source, fetched 2026-11-28 (read in full):
// https://code.claude.com/docs/en/sub-agents (also served as sub-agents.md): what a subagent is, built-in subagents (Explore,
//   Plan, general-purpose, other helpers and how to disable them), quickstart and /agents behaviour, scopes and priority table,
//   --agents JSON and its fields, plugin subagent limits, file format and live reload, full frontmatter table, files Claude Code
//   skips, model choice and order, CLAUDE_CODE_SUBAGENT_MODEL and _FORCE, effort, available tools and the tools Claude Code removes,
//   tools vs disallowedTools, MCP tool entries, Agent(...) allowlist, mcpServers and trust, permission modes, skills preload,
//   persistent memory, frontmatter hooks and SubagentStart/SubagentStop, Agent(name) deny rule, automatic delegation, @-mention,
//   --agent and the agent setting, foreground and background, resume with SendMessage, transcripts and cleanup, output scanning,
//   chaining and parallel patterns, subagents vs main conversation, nesting depth and CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH,
//   the 20-subagent concurrent limit, what loads at startup, forks and /subtask, the code-reviewer, debugger and db-reader examples.
// Search research 2026-11-28: a web search for "claude code subagents how to create custom subagent" returned the Anthropic docs
//   page first, then third-party tutorials (dev.to, DataCamp, CodeSignal, Apidog). Nothing from those pages is quoted; every fact
//   below comes from the Anthropic page above. Reddit and People Also Ask were not available through the search tool, so the FAQs
//   follow the questions the doc answers (what, where, how many, model, tools, nesting, background, resume).
// Hivra facts: app/agents/content/claude-code.ts (official Anthropic CLI installed on the computer, Terminal and Files in the
//   browser, Telegram tab, Hivra administrators retain infrastructure access), lib/blog/runtime-facts.ts (CLI_RUN_LIFETIME),
//   lib/blog/plan-facts.ts (price and size). The repo has nothing on subagents, so nothing is claimed about Hivra adding or managing them.
// Not claimed: that Hivra adds, manages, schedules or vets subagents; that a subagent fan-out survives a closed tab without tmux;
//   affiliation with Anthropic; setup times; backups.

const code = (lang: string, body: string): string => "```" + lang + "\n" + body.trim() + "\n```";

const SCOPE_TABLE = [
  "| Location | Scope | Priority |",
  "|---|---|---|",
  "| Managed settings | Organization-wide | 1 (highest) |",
  "| `--agents` CLI flag | Current session only | 2 |",
  "| `.claude/agents/` | Current project | 3 |",
  "| `~/.claude/agents/` | All your projects | 4 |",
  "| A plugin's `agents/` directory | Wherever the plugin is enabled | 5 (lowest) |",
].join("\n");

const BUILTIN_TABLE = [
  "| Subagent | Tools | Used for |",
  "|---|---|---|",
  "| Explore | Read-only (Write and Edit denied) | Searching and understanding a codebase. Claude sets a thoroughness of quick, medium or very thorough |",
  "| Plan | Read-only (Write and Edit denied) | Gathering context in plan mode before a plan is presented |",
  "| general-purpose | Every tool available to subagents | Complex tasks that need both exploring and changing things |",
  "| statusline-setup | Helper agent, runs on Sonnet | When you run `/statusline` |",
  "| claude-code-guide | Helper agent, runs on Haiku | When you ask questions about Claude Code features |",
].join("\n");

const FRONTMATTER_TABLE = [
  "| Field | Required | What it does |",
  "|---|---|---|",
  "| `name` | Yes | Unique identifier, at most 256 characters. Cannot start with `-` or contain `:`. The filename does not have to match |",
  "| `description` | Yes | When Claude should delegate to this subagent |",
  "| `tools` | No | Allowlist of tools, as a comma-separated string or a YAML list. Inherits every tool available to subagents if omitted |",
  "| `disallowedTools` | No | Tools to remove from the inherited or listed set. Applied before `tools` |",
  "| `model` | No | `sonnet`, `opus`, `haiku`, `fable`, a full model ID, or `inherit` |",
  "| `permissionMode` | No | `default`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`, `plan`, or `manual` (alias for `default`). Ignored for plugin subagents |",
  "| `maxTurns` | No | Most agentic turns before the subagent stops. Output is then marked partial and Claude can resume it |",
  "| `autoCompactWindow` | No | Compact this subagent's context earlier, at a token count of 100000 or more (Claude Code v2.1.296 or later) |",
  "| `skills` | No | Skills whose full content is loaded into the subagent's context at startup |",
  "| `mcpServers` | No | MCP servers for this subagent: a name of one you already configured, or an inline definition. Ignored for plugin subagents |",
  "| `hooks` | No | Lifecycle hooks that run only while this subagent is active. Ignored for plugin subagents |",
  "| `memory` | No | Persistent memory scope: `user`, `project` or `local` |",
  "| `background` | No | `true` keeps this subagent in the background even when Claude asks to wait for it |",
  "| `omitClaudeMd` | No | `true` starts the subagent without your user, project and local CLAUDE.md files (v2.1.271 or later) |",
  "| `effort` | No | `low`, `medium`, `high`, `xhigh` or `max`, depending on the model. Overrides the session's effort level |",
  "| `isolation` | No | `worktree` runs the subagent in a temporary git worktree, an isolated copy of the repository |",
  "| `color` | No | Display color in the task list and transcript: red, blue, green, yellow, purple, orange, pink or cyan |",
  "| `initialPrompt` | No | Submitted as the first user turn when this agent runs as the main session (`--agent` or the `agent` setting) |",
  "| `experimental` | No | A map of experimental options. Its `cacheTtl` key takes `5m` or `1h` (v2.1.248 or later) |",
].join("\n");

const WHEN_TABLE = [
  "| Situation | Use | Why |",
  "|---|---|---|",
  "| A side task that would dump search results, logs or file contents you will not reference again | A subagent | The work stays in its own context and only a summary comes back |",
  "| The same kind of worker, with the same instructions, again and again | A custom subagent | You write the instructions once |",
  "| You want to enforce which tools a worker can use | A subagent with `tools` or `disallowedTools` | The limit is in the definition |",
  "| Back-and-forth, iterating, or planning then building then testing with shared context | The main conversation | A subagent starts fresh and does not see your history |",
  "| A quick, targeted change | The main conversation | Less delay |",
  "| A reusable prompt or workflow that should run in your main context | A skill | Skills run in the main conversation |",
  "| A question about something already in the conversation | `/btw` | No tool access, and the answer is not added to history |",
].join("\n");

export const claudeCodeSubagents: BlogArticle = {
  slug: "claude-code-subagents",
  title: "Claude Code subagents: what they are, how to create them and when to use them",
  metaTitle: "Claude Code subagents: how to create and use them",
  metaDescription:
    "Claude Code subagents run side tasks in their own context window. Built-ins, the agent file format, every field, tools, models and examples.",
  publishedDate: "2026-11-28",
  lastModified: "2026-11-28",
  readingTimeMin: 14,
  author: "Hivra team",
  tagline: "A worker with its own context, its own tools and its own instructions, so your main chat stays clean.",
  intro:
    "A long Claude Code session fills up with things you only needed once: search results, test logs, whole files. A subagent takes that kind of job off your main conversation, does it in a separate context window and hands back a summary. This guide covers what subagents are, the built-in ones, how to write your own as a Markdown file, every frontmatter field, how to limit tools and choose a model, how to call a subagent, four example files and what to do when one does not show up.",
  shortAnswer:
    "A Claude Code subagent is a specialized assistant that runs in its own context window with its own system prompt, tools and permissions, then returns only a summary. You define one as a Markdown file with YAML frontmatter in .claude/agents/ or ~/.claude/agents/. Claude delegates to it by its description, or you call it by name.",
  sections: [
    {
      heading: "What a Claude Code subagent is",
      paragraphs: [
        "Anthropic's documentation describes subagents as specialized AI assistants that handle specific types of tasks. Each one runs in its own context window with a custom system prompt, specific tool access and independent permissions. When Claude meets a task that matches a subagent's description, it delegates, the subagent works on its own and the result comes back as a summary.",
        "The main benefit is context. The docs say to use a subagent when a side task would flood your main conversation with search results, logs or file contents you will not refer to again. The noisy work happens elsewhere and your main session keeps only the answer. The other benefits the docs list are enforcing constraints by limiting tools, reusing a configuration across projects, giving a worker a focused prompt for one domain, and controlling cost by routing a task to a faster, lower-cost model such as Haiku.",
        "Two costs are worth knowing before you start. A subagent sends its own requests, and those count toward the same usage limits as your main conversation, so five subagents are not free. And a subagent starts with a fresh context: it does not see your conversation history, the skills you have already used or the files Claude has already read. Claude writes it a delegation message and it works from that.",
        "Subagents run wherever Claude Code runs. If you want that to be a computer that stays on rather than your laptop, see [Claude Code on Hivra](/agents/claude-code).",
      ],
    },
    {
      heading: "Subagent or main conversation: which one to use",
      paragraphs: [
        "The docs give a short decision rule. Use the main conversation for work that needs frequent back-and-forth, for phases that share a lot of context (plan, implement, test), for quick targeted changes and when latency matters. Use a subagent when the task produces verbose output you do not need, when you want to enforce tool restrictions, or when the work is self-contained and can return a summary.",
        WHEN_TABLE,
        "One caution from the docs on parallel work: when subagents finish, their results return to your main conversation, so many subagents that each return long reports can still use a lot of context, and each one spends tokens of its own while it runs. Ask for short reports.",
      ],
    },
    {
      heading: "The built-in subagents",
      paragraphs: [
        "As of November 2026, Claude Code ships with built-in subagents that Claude uses on its own when it fits. Each inherits your permission rules, and most run with a restricted tool set.",
        BUILTIN_TABLE,
        "Explore and Plan start without your CLAUDE.md files and the git status snapshot, to keep research fast and cheap. The docs say a user or project subagent named `Explore` overrides the built-in and keeps its own `model` field, so you can define one with `model: haiku` to run exploration on a lower-cost model.",
        "You can switch built-ins off. Add the name to `permissions.deny`, for example `Agent(Explore)`, to block one type, or deny the `Agent` tool itself to stop Claude delegating at all.",
      ],
    },
    {
      heading: "Create your first subagent",
      paragraphs: [
        "A subagent is a Markdown file with YAML frontmatter. You can ask Claude to write it, or write it yourself. The docs' quickstart asks Claude in plain language:",
        code(
          "text",
          `Create a personal code-improver subagent in ~/.claude/agents/ that scans
files and suggests improvements for readability, performance, and best
practices. It should explain each issue, show the current code, and
provide an improved version. Make it read-only and have it use Sonnet.`,
        ),
        "Claude writes the file with a name, a description, a tools list, a model and a system prompt. Open `~/.claude/agents/code-improver.md` to check it. The docs show this result:",
        code(
          "markdown",
          `---
name: code-improver
description: Scans files and suggests improvements for readability, performance, and best practices. Use after writing or modifying code.
tools: Read, Grep, Glob
model: sonnet
---

You are a code improvement specialist. For each issue you find, explain
the problem, show the current code, and provide an improved version.`,
        ),
        "Because it lives in `~/.claude/agents/`, it is available in every project on that machine. Move it to a project's `.claude/agents/` folder to scope it to one repository. Then ask for it by name:",
        code("text", "Use the code-improver agent to suggest improvements in this project"),
        "In the transcript the delegation shows as a tool-call row with the subagent's name and a short task, such as `code-improver(Suggest code improvements)`.",
        "A note on `/agents`. In current versions the docs say running `/agents` prints a reminder to ask Claude or edit `.claude/agents/` and `~/.claude/agents/` directly. On Claude Code v2.1.197 and earlier, `/agents` opens an interactive wizard with a Running tab and a Library tab for creating, editing and deleting subagents. Which one you see depends on your version, so run `claude --version` if the command behaves differently from this guide.",
        "Claude Code watches both agents folders. When you add or edit a file, or ask Claude to write one, it notices within a few seconds and the next delegation uses the new definition, no restart needed. Two cases still need a restart: folders added with `--add-dir` or `/add-dir`, and sessions started with `--disable-slash-commands`. If Claude cannot find a subagent you just made, restart Claude Code and try again.",
      ],
    },
    {
      heading: "Where subagent files live and which one wins",
      paragraphs: [
        "A file's location decides who can use the subagent. When several subagents share a name, Claude Code uses the one from the higher-priority location.",
        SCOPE_TABLE,
        "Project subagents are discovered by walking up from the current working directory, so every `.claude/agents/` between there and the repository root is scanned, and the definition closest to your working directory wins. The docs recommend checking project subagents into version control so your team can use and improve them. Both folders are scanned recursively, so you can organize files into subfolders like `agents/review/`. The subfolder does not change how a subagent is identified: identity comes only from the `name` field, so keep names unique, because if two files in the same agents directory declare the same name, only one loads. The `/doctor` checkup reports that.",
        "Plugins are the exception. A subfolder inside a plugin's `agents/` directory becomes part of the scoped name, so `agents/review/security.md` in a plugin called `my-plugin` registers as `my-plugin:review:security`. For security, plugin subagents ignore the `hooks`, `mcpServers` and `permissionMode` fields. To use those, copy the agent file into `.claude/agents/` or `~/.claude/agents/`.",
        "For a one-off, `claude --agents` takes the same definitions as JSON, with `prompt` standing in for the Markdown body. They exist only for that session and are not saved to disk. In non-interactive mode it also accepts a path to a JSON file (Claude Code v2.1.281 or later). Organization admins can also deploy managed subagents, which take precedence over project and user ones with the same name.",
      ],
    },
    {
      heading: "Every frontmatter field",
      paragraphs: [
        "Only `name` and `description` are required. Field names are camelCase, such as `maxTurns` and `disallowedTools`, and must match exactly, because Claude Code ignores a field it does not recognize without telling you. To catch a typo, run `claude --debug` and search the log at `~/.claude/debug/<session-id>.txt` for `does not recognize or apply` (Claude Code v2.1.296 or later).",
        FRONTMATTER_TABLE,
        "The body of the file, after the closing `---`, is the system prompt. A subagent receives it plus basic environment details, not the full Claude Code system prompt, and starts in the main conversation's working directory. For an isolated copy of the repository, set `isolation: worktree`.",        "A file is skipped if it has no `name`, if the opening `---` is not on the first line, if the name starts with `-` or contains `:`, if there is a `name` but no `description`, or if the YAML does not parse. Run `claude --debug` to see why.",        "Keep descriptions short. When the combined descriptions of your non-built-in subagents pass 15,000 tokens, Claude Code shows a warning at startup with the total. Move detail into the system prompt, which loads only when that subagent runs.",
      ],
    },
    {
      heading: "Choose a model for a subagent",
      paragraphs: [
        "By default a subagent you define runs on the same model as the conversation that starts it. To choose, set `model` to an alias (`sonnet`, `opus`, `haiku` or `fable`), a full model ID that the `--model` flag accepts, or `inherit`.",
        "When more than one place sets a model, Claude Code uses the first of these:",
        "1. The per-invocation `model` parameter, which Claude can pass when it starts the subagent (an alias only).\n2. The `model` field in the subagent's definition.\n3. The `CLAUDE_CODE_SUBAGENT_MODEL` environment variable.\n4. The main conversation's model.",
        "A common pattern is to put cheap, high-volume work on Haiku and keep the main session on a stronger model. To force one model onto every subagent, set `CLAUDE_CODE_SUBAGENT_MODEL` to the model and `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` to `1` in the `env` block of a settings file (Claude Code v2.1.257 or later). While force is on, the `model` field in definitions is ignored. Run `/tasks` while a subagent is running to see which model it is on. Subagents inherit your extended thinking setup, but the `effort` field lets one run at its own effort level.",
      ],
    },
    {
      heading: "Control what a subagent can do: tools and permissions",
      paragraphs: [
        "A subagent inherits the built-in tools and MCP tools available in the main conversation, with two filters on top. One removes a short list of tools from every subagent, whatever you write in `tools`: `AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode` (unless the subagent's `permissionMode` is `plan`), `ScheduleWakeup`, `Workflow` and a few others, plus `Agent` when the subagent is at the nesting depth limit. The other filter gives background subagents a smaller built-in tool set. The docs warn not to rely on other built-in tools in a background subagent.",
        "To restrict tools, use `tools` as an allowlist or `disallowedTools` as a denylist. If both are set, `disallowedTools` applies first, then `tools` resolves against what is left, and a tool in both is removed. Two docs examples:",
        code(
          "yaml",
          `---
name: safe-researcher
description: Research agent with restricted capabilities
tools: Read, Grep, Glob, Bash
---`,
        ),
        "That subagent has no Edit, Write or MCP tools, but the docs point out it can still change files through Bash. The reverse approach inherits everything except file writes:",
        code(
          "yaml",
          `---
name: no-writes
description: Inherits the available tools except file writes
disallowedTools: Write, Edit
---`,
        ),
        "Both fields take whole-MCP-server entries: `mcp__github__*` in `tools` gives a subagent every tool from the github server, and `mcp__github` in `disallowedTools` withholds them. One trap: a `disallowedTools` entry with a specifier such as `Bash(git push *)` still removes the entire Bash tool, not just those commands. To keep Bash and block specific commands, add a Bash deny rule to `permissions.deny` in your settings, which applies to subagents too.",        "Permission mode is the other control. Set `permissionMode` in the definition, or leave it out to inherit the main conversation's mode. The catch from the docs: if the main conversation is in `bypassPermissions`, `acceptEdits` or auto mode, the subagent runs in that same mode and your setting is ignored, and in plan mode the subagent stays in plan mode. Our guide to [the skip-permissions flag](/blog/claude-code-dangerously-skip-permissions) covers what that mode skips.",
        "For finer control than a tool list gives you, put a `PreToolUse` hook in the subagent's frontmatter, as in the database example below. A subagent can also be given its own MCP servers through `mcpServers`, with an inline definition scoped to that subagent, which keeps a heavy server's tool descriptions out of your main conversation. Inline servers from a project's agent file load only after you trust that folder. Our [Claude Code MCP guide](/blog/claude-code-mcp) covers adding servers, and the [hooks guide](/blog/claude-code-hooks) covers hook events and exit codes.",
      ],
    },
    {
      heading: "How to call a subagent: delegation, @-mention and --agent",
      paragraphs: [
        "There are four ways to get a subagent to run, from loosest to most direct.",
        "- **Automatic delegation.** Claude decides from your request, the `description` fields and the current context. To encourage it, put phrases such as \"use proactively\" in the description.\n- **Natural language.** Name the subagent in your prompt, such as `Use the test-runner subagent to fix failing tests`. Claude typically delegates.\n- **@-mention.** Type `@` and pick the subagent from the typeahead, for example `@\"code-reviewer (agent)\" look at the auth changes`. You can also type `@agent-<name>` by hand. Your full message still goes to Claude, which writes the task prompt.\n- **Whole session.** Run `claude --agent code-reviewer`, or set `\"agent\": \"code-reviewer\"` in `.claude/settings.json`. The main thread then takes on that subagent's tool restrictions and model, and the flag overrides the setting.",
        "For multi-step work, ask Claude to chain subagents: `Use the code-reviewer subagent to find performance issues, then use the optimizer subagent to fix them`. Each finishes and returns results to Claude, which passes what is relevant to the next. For independent investigations, ask for parallel research: `Research the authentication, database, and API modules in parallel using separate subagents`.",
      ],
    },
    {
      heading: "Foreground, background and resuming",
      paragraphs: [
        "Foreground subagents block the main conversation until they finish, and permission prompts pass through to you. Background subagents run while you keep working and surface their permission prompts in your main session, naming the subagent that is asking. You can approve, or press Esc to deny that one tool call without stopping the subagent.",
        "With nothing configured, a subagent that Claude spawns from your main conversation, other than the `web-fetch` agent, starts in the background. The `background: true` field keeps one in the background even when Claude asks to wait. If you want Claude to wait for a result before it continues in an interactive session, the docs say to turn off fork mode by setting `CLAUDE_CODE_FORK_SUBAGENT` to `0` and ask, for example, \"run the reviewer subagent and wait for its report\". Press Ctrl+B to move a waiting subagent to the background. Setting `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` to `1` makes Claude wait for subagents and turns background commands off too.",
        "Each invocation creates a new instance, so to continue earlier work you ask Claude to resume it: `Continue that code review and now analyze the authorization logic`. A resumed subagent keeps its full conversation history. Claude resumes it with the `SendMessage` tool, using the agent's ID or name. Transcripts are stored under `~/.claude/projects/{project}/{sessionId}/subagents/` as `agent-{agentId}.jsonl`, and Claude Code deletes them after the `cleanupPeriodDays` retention period, 30 days by default. The built-in Explore and Plan agents can finish without giving Claude an ID to resume, so for work you will continue use general-purpose or a custom subagent.",
        "If a subagent stops at its `maxTurns` limit, its output is marked partial (Claude Code v2.1.246 or later) and Claude can resume it.",
      ],
    },
    {
      heading: "Forks, nesting and limits",
      paragraphs: [
        "A fork is a subagent that inherits the whole conversation so far instead of starting fresh. It shares the parent's system prompt, tools, model and message history, and its first request reuses the parent's prompt cache, so the docs say it costs less than a fresh subagent for tasks that need the same context. Start one yourself with `/subtask` followed by a task, such as `/subtask draft unit tests for the parser changes so far` (if agent view is turned off, `/subtask` is not available and `/fork` starts the forked subagent instead). It appears in a panel below the prompt and runs in the background. Fork mode is on by default from Claude Code v2.1.302, and in an interactive terminal session from v2.1.232, which is also why Claude cannot wait for a subagent in an interactive session until you turn it off. A fork cannot spawn further forks.",
        "Can subagents spawn subagents? In current versions of Claude Code, yes. Older advice that says they cannot is out of date. By default a subagent can spawn its own subagents, up to three layers below the main conversation. At the depth limit Claude Code withholds the `Agent` tool and the subagent does the work itself. Set `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` in the `env` block of settings to change the depth, and `1` turns nesting off. To keep one subagent from spawning, such as a reviewer that should stay read-only, leave `Agent` out of its `tools` or add it to `disallowedTools`. A nested subagent you define runs on the spawning subagent's model by default.",
        "There is also a concurrency cap: with 20 subagents running, spawning another fails with `Concurrent subagent limit reached`. Set `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` to change it (Claude Code v2.1.217 or later).",        "Remember what a subagent does not see: your conversation history, your output style and the main conversation's auto memory. If a rule must reach it, restate it in the prompt you give Claude when delegating.",      ],
    },
    {
      heading: "Four example subagent files",
      paragraphs: [
        "The first three come from Anthropic's examples. Save any of them as a `.md` file in `.claude/agents/` and Claude Code picks it up. The test runner is ours, built only from fields in the table above, so adapt its prompt to your project.",
        "**1. Code reviewer.** Read-only tools plus Bash for `git diff`. The docs note it has no Edit or Write but can still change files through Bash.\n\n" +
          code(
            "markdown",
            `---
name: code-reviewer
description: Expert code review specialist. Proactively reviews code for quality, security, and maintainability. Use immediately after writing or modifying code.
tools: Read, Grep, Glob, Bash
model: inherit
---

You are a senior code reviewer ensuring high standards of code quality and security.

When invoked:
1. Run git diff to see recent changes
2. Focus on modified files
3. Begin review immediately

Provide feedback organized by priority:
- Critical issues (must fix)
- Warnings (should fix)
- Suggestions (consider improving)

Include specific examples of how to fix issues.`,
          ),
        "**2. Debugger.** This one includes Edit because fixing a bug means changing code.\n\n" +
          code(
            "markdown",
            `---
name: debugger
description: Debugging specialist for errors, test failures, and unexpected behavior. Use proactively when encountering any issues.
tools: Read, Edit, Bash, Grep, Glob
---

You are an expert debugger specializing in root cause analysis.

When invoked:
1. Capture error message and stack trace
2. Identify reproduction steps
3. Isolate the failure location
4. Implement minimal fix
5. Verify solution works

Focus on fixing the underlying issue, not the symptoms.`,
          ),
        "**3. Database query validator.** Bash only, with a `PreToolUse` hook that runs a script before every Bash call. The docs' script reads the JSON on standard input, and exits with code 2 to block SQL writes. Make the script executable with `chmod +x ./scripts/validate-readonly-query.sh`.\n\n" +
          code(
            "markdown",
            `---
name: db-reader
description: Execute read-only database queries. Use when analyzing data or generating reports.
tools: Bash
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "./scripts/validate-readonly-query.sh"
---

You are a database analyst with read-only access. Execute SELECT queries to answer questions about the data.

You cannot modify data. If asked to INSERT, UPDATE, DELETE, or modify schema, explain that you only have read access.`,
          ) +
          "\n\nThe docs call the hook a backstop: the prompt tells the subagent to refuse writes, and if it tries anyway, Claude Code blocks the command and the subagent sees the message from the script. The full script is in the [subagents documentation](https://code.claude.com/docs/en/sub-agents). Hooks in `settings.json` also fire inside subagents, and the `SubagentStart` and `SubagentStop` events take a matcher on the agent name.",
        "**4. Test runner.** This is the \"isolate high-volume operations\" pattern the docs recommend, which is a good use of a cheaper model. It is read-only apart from Bash, and `maxTurns` stops a runaway loop.\n\n" +
          code(
            "markdown",
            `---
name: test-runner
description: Runs the test suite and reports only the failures. Use when tests need to be run and the output is long.
tools: Read, Grep, Glob, Bash
model: haiku
maxTurns: 15
---

You run tests and report briefly.

When invoked:
1. Run the project's test command
2. Report only the failing tests, each with its error message and file
3. If everything passes, say so in one line

Do not edit files. Do not paste full logs.`,
          ),
      ],
    },
    {
      heading: "When a subagent does not show up or does not run",
      paragraphs: [
        "- **It never gets picked.** Claude chooses by description. Make it specific to one job, add \"use proactively\", name it in your prompt, or @-mention it.\n- **It does not appear at all.** Check the file has `name` and `description`, that the first line is `---`, and that the YAML parses. Run `claude --debug` for the reason. For a folder added with `/add-dir`, restart Claude Code.\n- **A field has no effect.** The names are camelCase and exact. Search the debug log for `does not recognize or apply`.\n- **The wrong version runs.** A same-name file in a higher-priority location is winning. Run `/doctor` for duplicate names in one folder.\n- **A tool is missing.** Background subagents get a smaller built-in tool set, and some tools are removed from every subagent.\n- **Spawning fails.** `Concurrent subagent limit reached` means 20 are already running.\n- **Your `permissionMode` is ignored.** If the main conversation is in `bypassPermissions`, `acceptEdits`, auto or plan mode, that mode takes over.",
      ],
    },
    {
      heading: "Security: what a subagent can and cannot protect you from",
      paragraphs: [
        "- **Tool limits are a guardrail, not a sandbox.** A subagent with Bash can still change files, as the docs note. For a hard rule, add a deny rule in settings or a `PreToolUse` hook.\n- **Trust a folder before its agents run hooks or servers.** Inline MCP servers and frontmatter hooks in a project's `.claude/agents/` files stay off until you trust the folder. Read an agent file from a repository before you accept it.\n- **Subagent reports are untrusted text.** The docs say Claude Code scans each final report before Claude reads it, because a subagent may have read files, web pages or command output you never reviewed. The scan does not judge whether content is malicious, and any tool call it leads to still goes through your permission checks.\n- **Background prompts widen your session.** If you answer a background subagent's permission prompt with a grant that lasts for the session, Claude Code applies it to the whole session.",
      ],
    },
    {
      heading: "Running Claude Code subagents on a Hivra computer",
      paragraphs: [
        "Subagents run wherever Claude Code runs. On a laptop that means a long fan-out, such as three reviewers working in parallel or a test runner looping over a big suite, stops mattering the moment the lid closes. Where you run Claude Code decides how long its subagents can keep working.",
        "Hivra runs the official Claude Code CLI on a cloud computer of its own, and you reach its terminal and files from a browser on any device. It is a normal Claude Code install, so everything in this guide works as written: you open the Terminal tab, put files in `.claude/agents/` or `~/.claude/agents/` and Claude Code picks them up. Your project subagents and your user subagents sit on that computer beside the repository. Hivra does not add, manage or schedule subagents for you. They are Claude Code's feature, and the computer is the place they run.",
        "- **A computer that stays on.** " +
          CLI_RUN_LIFETIME +
          "\n- **Long fan-outs outlive your laptop when you start them in tmux.** A Claude Code run started inside tmux keeps going after you shut the laptop, and since subagents work inside that same session, so do the ones it starts. You check the results when you log back in.\n- **You are not locked into one agent.** Subagents are a Claude Code feature, but the same Hivra account launches other agents too, including Hermes, OpenClaw, Codex and Agent Zero, each on a computer of its own, and you reach them from a browser on any device.\n- **Experiments stay off your laptop.** A reviewer with Bash or a database reader runs on a computer separate from your everyday machine.",
        `Plans start at ${ENTRY_PLAN_PRICE} a month for ${ENTRY_PLAN_SIZE}. You can sign in to Claude Code with your own Anthropic account, as you would locally. Hivra hosting does not include or replace your Anthropic subscription or usage, and with your own account every subagent request counts toward your own limits. You can instead choose Hivra credits when you launch, which pay for its model usage instead. Hivra is not affiliated with Anthropic.`,
        "Some honest limits. If you use Claude Code only at your desk, your own machine is simpler and costs nothing extra. A Hivra computer is managed, so you get less freedom than a server you root yourself, and Hivra administrators retain infrastructure access to managed hosts. And a long run that you did not start in tmux does not get the keep-going treatment, so start it there.",
        "[Launch Claude Code on Hivra](/agents/claude-code) if you want your subagents to have a computer that is still on when you are not. To build the server yourself, our [Claude Code on Linux guide](/blog/claude-code-on-linux) covers it, and [how to keep Claude Code running 24/7](/blog/keep-claude-code-running-24-7) explains the tmux approach.",
      ],
    },
    {
      heading: "A sensible first set of subagents",
      paragraphs: [
        "Start with two. A read-only code reviewer in `.claude/agents/`, committed so your team gets it, and a test runner on Haiku that reports only failures. Use each by name a few times, read the transcripts in `/tasks` and tighten the description and prompt until Claude picks them when you expect. Add a debugger once those two earn their place, and try `isolation: worktree` for subagents that make larger edits.",
        "Keep each subagent to one job, grant only the tools it needs, and check the [subagents documentation](https://code.claude.com/docs/en/sub-agents) for the version you run, because fields and defaults change between releases.",
      ],
    },
  ],
  faqs: [
    {
      q: "What are subagents in Claude Code?",
      a: "Subagents are specialized assistants that each run in their own context window with a custom system prompt, specific tool access and independent permissions. Claude delegates a task to one, it works separately, and only a summary returns to your main conversation, which keeps search results and logs out of it.",
    },
    {
      q: "How do I create a custom subagent in Claude Code?",
      a: "Write a Markdown file with YAML frontmatter, where name and description are required and the body is the system prompt, and save it in .claude/agents/ for one project or ~/.claude/agents/ for all projects. You can also ask Claude to write it for you. Claude Code detects the new file within a few seconds.",
    },
    {
      q: "Where are subagents stored, and which one wins if names clash?",
      a: "In .claude/agents/ (project) and ~/.claude/agents/ (user), plus managed settings, the --agents flag and plugins. On a name clash the higher-priority source wins: managed settings, then the --agents flag, then project, then user, then plugin.",
    },
    {
      q: "Can Claude Code subagents spawn other subagents?",
      a: "Yes, in current versions. By default a subagent can spawn its own subagents, up to three layers below the main conversation, and CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH changes the depth. Setting it to 1 turns nesting off. Leave Agent out of a subagent's tools list to stop that one from spawning.",
    },
    {
      q: "How do I choose which model a subagent uses?",
      a: "Set the model field to sonnet, opus, haiku, fable, a full model ID or inherit. Without it, the subagent uses CLAUDE_CODE_SUBAGENT_MODEL if set, otherwise the main conversation's model. A model Claude passes when it starts the subagent takes priority over the definition.",
    },
    {
      q: "How do I limit what tools a subagent can use?",
      a: "Use tools as an allowlist or disallowedTools as a denylist in the frontmatter. If both are set, disallowedTools is applied first. A subagent without Edit and Write can still change files through Bash, so use a PreToolUse hook or a permissions deny rule when you need a hard limit.",
    },
    {
      q: "Do subagents run in the background?",
      a: "By default, a subagent that Claude spawns from your main conversation starts in the background, so you can keep working while it runs. Its permission prompts appear in your main session. Setting background to true in the definition keeps it there even when Claude asks to wait for it.",
    },
    {
      q: "Do subagents cost extra?",
      a: "Each subagent sends its own requests, and those count toward the same usage limits as your main conversation. Routing high-volume work to a lower-cost model such as Haiku with the model field is the documented way to control cost, and asking for short reports limits what returns to your main context.",
    },
    {
      q: "Can a Claude Code subagent keep working after I close my laptop?",
      a: "Only if Claude Code is running somewhere that stays on. On a laptop, closing it stops the work. On a cloud computer, such as one from Hivra, a Claude Code run you start inside tmux keeps going after you close your laptop, along with the subagents it starts in that session, and you check the results when you log back in.",
    },
  ],
  relatedArticles: [
    { slug: "claude-code-hooks", title: "Claude Code hooks: what they are and how to set them up" },
    { slug: "claude-code-mcp", title: "Claude Code MCP: how to add and manage MCP servers" },
    { slug: "claude-code-dangerously-skip-permissions", title: "Claude Code's --dangerously-skip-permissions flag: what it skips and where to run it" },
    { slug: "keep-claude-code-running-24-7", title: "Will Claude keep running if you close your laptop or lock it? (And how to run Claude Code 24/7)" },
    { slug: "multi-agent-systems-explained", title: "Multi-agent AI systems in 2026: how they're built, what they cost, and when they're worth it" },
  ],
  relatedComparisons: [{ slug: "vs-self-hosted", title: "Hivra vs self-hosted VPS" }],
};
