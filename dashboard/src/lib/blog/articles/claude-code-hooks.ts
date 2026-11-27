import { BlogArticle } from "../types";
import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE } from "../plan-facts";
import { CLI_RUN_LIFETIME } from "../runtime-facts";

// Written 2026-11-27 for "claude code hooks" (US about 2,900 searches a month). Hub page for hooks in Claude Code. MCP stays in
// claude-code-mcp, the permission flag in claude-code-dangerously-skip-permissions, running it on a server in claude-code-on-linux.
// Primary sources, all fetched 2026-11-27:
// https://code.claude.com/docs/en/hooks-guide (what hooks are, first Notification hook, /hooks check, notification matchers and
//   the notify-send / osascript / PowerShell commands, Prettier PostToolUse example, protect-files.sh PreToolUse example with
//   chmod +x, SessionStart compact re-injection, ConfigChange audit log, "Log every Bash command" example, how hooks combine
//   results, hook input and output, exit codes, hookSpecificOutput, matcher table, `if` field, hook types, disableAllHooks,
//   limitations, Stop hook block cap and stop_hook_active, troubleshooting: claude --debug, /debug, jq not found, shell profile
//   output before the JSON)
// https://code.claude.com/docs/en/hooks (full event list, config locations, matcher evaluation, handler types and fields,
//   default timeouts, common input fields, exit-code table and per-event behaviour, universal JSON output fields,
//   decision control per event, environment variables, allowManagedHooksOnly, allowedHttpHookUrls, httpHookAllowedEnvVars,
//   the 10,000-character output cap). The last ~9,500 characters of this page did not load in the fetch tool, so nothing from
//   the debug-hooks and security sections of the reference is quoted beyond what the guide page repeats.
// https://code.claude.com/docs/en/settings (four settings scopes and their files, precedence order, lists merge, hot reload of
//   hooks edits, /status, --settings, cloud sessions read only some settings)
// Hivra facts: app/agents/content/claude-code.ts (official Anthropic CLI installed on the computer, browser terminal and
//   files, Terminal tab, Hivra administrators retain infrastructure access), lib/blog/runtime-facts.ts (CLI_RUN_LIFETIME),
//   lib/blog/plan-facts.ts (price and size), lib/hivra/agent-seo-catalog.ts.
// Not claimed: that Hivra preinstalls, configures or vets hooks, MCP servers or plugins; that a Hivra computer has a desktop
//   notification daemon; affiliation with Anthropic; setup times; backups.

const code = (lang: string, body: string): string => "```" + lang + "\n" + body.trim() + "\n```";

const EVENT_TABLE = [
  "| Event | When it fires | Can it block? |",
  "|---|---|---|",
  "| `SessionStart` | A session begins or resumes | No |",
  "| `Setup` | Claude Code starts with `--init-only`, or with `--init` or `--maintenance` in `-p` mode | No |",
  "| `UserPromptSubmit` | You submit a prompt, before Claude processes it | Yes |",
  "| `UserPromptExpansion` | A command you type expands into a prompt | Yes |",
  "| `PreToolUse` | Before a tool call runs | Yes |",
  "| `PermissionRequest` | A tool call needs a permission decision | Decides via JSON (exit 2 is ignored) |",
  "| `PermissionDenied` | Auto mode denies a tool call | No (can ask to retry) |",
  "| `PostToolUse` | After a tool call succeeds | Feeds back to Claude (tool already ran) |",
  "| `PostToolUseFailure` | After a tool call fails | Feeds back to Claude |",
  "| `PostToolBatch` | After a batch of parallel tool calls resolves, before the next model call | Yes |",
  "| `Notification` | Claude Code sends a notification | No |",
  "| `MessageDisplay` | While assistant message text is displayed | No (display only) |",
  "| `SubagentStart` | A subagent is spawned | No |",
  "| `SubagentStop` | A subagent finishes | Yes |",
  "| `TaskCreated` | A task is being created with `TaskCreate` | Yes |",
  "| `TaskCompleted` | A task is being marked completed | Yes |",
  "| `Stop` | Claude finishes responding | Yes |",
  "| `StopFailure` | The turn ends because of an API error | No |",
  "| `TeammateIdle` | An agent team teammate is about to go idle | Yes |",
  "| `InstructionsLoaded` | A CLAUDE.md or `.claude/rules/*.md` file is loaded | No |",
  "| `ConfigChange` | A configuration file changes during a session | Yes (except managed policy settings) |",
  "| `CwdChanged` | The working directory changes, for example after `cd` | No |",
  "| `DirectoryAdded` | A working directory is added mid-session | No |",
  "| `FileChanged` | A watched file changes on disk | No |",
  "| `WorktreeCreate` | A worktree is being created; your hook replaces the default git behaviour | Any failure stops it |",
  "| `WorktreeRemove` | A worktree your hook created is being removed | Only fails if the folder is still there afterwards |",
  "| `PreCompact` | Before context compaction | Yes |",
  "| `PostCompact` | After compaction completes | No |",
  "| `PreModelSwitch` | Before a requested model switch is applied | Yes |",
  "| `PostModelSwitch` | After the session's model changes | No |",
  "| `Elicitation` | An MCP server asks for user input during a tool call | Yes (declines it) |",
  "| `ElicitationResult` | After you answer an MCP elicitation, before the answer goes back | Yes |",
  "| `SessionEnd` | The session ends | No |",
].join("\n");

const SCOPE_TABLE = [
  "| Where | Applies to | Shared with the team? |",
  "|---|---|---|",
  "| `~/.claude/settings.json` | All your projects on this machine | No |",
  "| `.claude/settings.json` | One project | Yes, commit it |",
  "| `.claude/settings.local.json` | One project, just you | No, keep it out of git |",
  "| Managed policy settings | Everyone in an organization | Yes, set by admins |",
  "| A plugin's `hooks/hooks.json` | While the plugin is enabled | Yes |",
  "| Skill or subagent frontmatter | While that skill or subagent is active | Yes |",
].join("\n");

const EXIT_TABLE = [
  "| Exit code | What it means |",
  "|---|---|",
  "| 0 | Success. If stdout is a single JSON object, Claude Code reads it as your instructions |",
  "| 2 | A blocking error on events that can block. Whatever you wrote to stderr is the reason |",
  "| Anything else | A non-blocking error. The action goes ahead and you see a hook error notice |",
].join("\n");

export const claudeCodeHooks: BlogArticle = {
  slug: "claude-code-hooks",
  title: "Claude Code hooks: what they are and how to set them up",
  metaTitle: "Claude Code hooks: what they are and how to set up",
  metaDescription:
    "Claude Code hooks run your shell commands at fixed points: format after edits, block risky commands, get notified. Events, config and examples.",
  publishedDate: "2026-11-27",
  lastModified: "2026-11-27",
  readingTimeMin: 14,
  author: "Hivra team",
  tagline: "Rules you write once and Claude Code follows every time, because a program enforces them, not a prompt.",
  intro:
    "A line in CLAUDE.md is a request. Claude usually follows it, and sometimes does not. A hook is different: it is a command that Claude Code itself runs at a set moment, so the formatter always runs and the protected file is always protected. This guide covers what hooks are, every event, where to put them, how matchers and exit codes work, six examples you can copy and how to debug a hook that does nothing.",
  shortAnswer:
    "Claude Code hooks are shell commands that Claude Code runs automatically at set points, such as before a tool runs, after a file edit or when it needs your input. You add them under a hooks key in a settings file and check them with /hooks. They run every time, so they can format code, block commands and notify you.",
  sections: [
    {
      heading: "What Claude Code hooks are",
      paragraphs: [
        "Anthropic's documentation describes hooks as user-defined shell commands that Claude Code runs at specific points in its lifecycle. The point of that sentence is the word deterministic: certain actions always happen, rather than relying on the model to choose to run them.",
        "Each hook belongs to an event, such as `PreToolUse` (before a tool call) or `Stop` (when Claude finishes responding). When the event fires, Claude Code checks your settings for hooks that match, runs them, passes the details of what is happening to your command as JSON on standard input, and reads the exit code and output to decide what to do next.",
        "A hook can **react** (format a file, send a notification), **block** (refuse an edit to `.env`) or **feed information back to Claude** (add the current git branch to the conversation).",
        "The docs list five handler types. `command` runs a shell command and is by far the most common, so it is the one this guide uses. `http` posts the event JSON to a URL. `mcp_tool` calls a tool on an MCP server you have already configured (our [Claude Code MCP guide](/blog/claude-code-mcp) covers adding one). `prompt` asks a Claude model to make a single judgment call, and `agent` starts a subagent to check a condition and is marked experimental in the docs.",
        "Hooks run wherever Claude Code itself runs. If you want them on a computer that stays on rather than your laptop, see [Claude Code on Hivra](/agents/claude-code).",
      ],
    },
    {
      heading: "Hooks, CLAUDE.md or permissions: which one to use",
      paragraphs: [
        "These three tools overlap, and people often reach for the wrong one.",
        [
          "| You want to | Use | Why |",
          "|---|---|---|",
          "| Tell Claude how your project works | CLAUDE.md | It is guidance the model reads. It is not enforced |",
          "| Always run a tool after an action (format, lint, log) | A hook | Claude Code runs it, not the model |",
          "| Stop a specific action every time | A hook, or a deny rule | Both are enforced outside the model |",
          "| Allow or deny tools in a simple way | Permission rules | Documented as the right tool for hard allow and deny lists |",
          "| Add one-off information at session start | A `SessionStart` hook, or CLAUDE.md for fixed text | The docs suggest CLAUDE.md for static conventions |",
        ].join("\n"),
        "One caveat from the docs matters here. The `if` filter on a hook is best-effort (for example, a Bash command Claude Code cannot split into parts runs your hook regardless), and the docs say to use the permission system rather than a hook to enforce a hard allow or deny. A hook that blocks is still a good second layer, and it can do things a permission rule cannot, such as checking a file's contents before an edit.",
      ],
    },
    {
      heading: "Every Claude Code hook event",
      paragraphs: [
        "As of November 2026, the [hooks reference](https://code.claude.com/docs/en/hooks) lists these events. The last column is a simplified reading of the exit-code section: whether your hook can stop the thing that happened. You will use perhaps five of them often, `PreToolUse`, `PostToolUse`, `Notification`, `Stop` and `SessionStart`. The rest are there for specific jobs, and the list has grown over time, so check the reference for the version you run.",
        EVENT_TABLE,
        "By cadence, `SessionStart` fires when a session starts or resumes and again after `/clear` or compaction, `SessionEnd` fires when a session ends, `UserPromptSubmit`, `Stop` and `StopFailure` fire once per turn, and `PreToolUse` and `PostToolUse` fire on every tool call. A turn with fifty tool calls runs those two fifty times, so keep their hooks quick.",
      ],
    },
    {
      heading: "Where to put hooks: settings files and the /hooks menu",
      paragraphs: [
        "Hooks live in the `hooks` key of a settings file. The [settings documentation](https://code.claude.com/docs/en/settings) describes four scopes, and the hooks guide adds the places plugins, skills and subagents can carry hooks.",
        SCOPE_TABLE,
        "Hook entries merge across levels, so a project hook and a user hook for the same event both run. Managed hooks cannot be turned off from outside managed settings. Settings precedence, highest first, runs managed settings, the command line (`--settings`), project local, shared project, then user, and the docs say that lists merge rather than override.",
        "Claude Code watches your settings files and reloads them when they change, so edits to `hooks` normally apply to the running session without a restart.",
        "Type `/hooks` at the prompt to open the hooks menu. It is a read-only browser that shows each hook, where it was defined and the full command. Use it to confirm that a hook you just wrote was picked up, under the right event. You edit the settings file yourself, or ask Claude to write the hook for you.",
        "Hooks need a trusted folder. In an interactive session, the docs say Claude Code holds back hooks from every settings file, your own user settings included, until you accept the workspace trust dialog for the folder. In a `-p` or SDK run there is no dialog and the folder counts as trusted, so review a repository's `.claude/` settings before you script `claude -p` over it. That is a feature: cloning someone else's repository should not run their commands before you have agreed to.",
      ],
    },
    {
      heading: "How a hook is shaped: events, matchers and handlers",
      paragraphs: [
        "A hook entry has three levels: the event, a matcher group, and the handlers inside the group.",
        code(
          "json",
          String.raw`{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          { "type": "command", "command": "f=$(jq -r '.tool_input.file_path') && npx prettier --write --ignore-unknown \"$f\"" }
        ]
      }
    ]
  }
}`,
        ),
        "The `matcher` narrows which occurrences of the event run the hook. For tool events it matches the tool name. The docs give these evaluation rules:",
        "- An empty matcher, `\"*\"` or no matcher at all matches everything.\n- If the matcher contains only letters, digits, underscores, hyphens, spaces, commas and `|`, it is read as an exact name or a list of exact names, so `Edit|Write` and `Edit, Write` both mean those two tools.\n- Any other character makes it a JavaScript regular expression, unanchored, so use `^...$` if you need a whole-string match.\n- MCP tools are named `mcp__<server>__<tool>`, so `mcp__github__.*` matches every tool from a server called github.",
        "Different events match on different things. `SessionStart` matches how the session started (`startup`, `resume`, `clear`, `compact` or `fork`). `Notification` matches the notification type, such as `permission_prompt` or `idle_prompt`. `ConfigChange` matches the settings source. Some events, including `UserPromptSubmit`, `Stop`, `PostToolBatch` and `CwdChanged`, have no matcher and fire every time. A matcher on an event that does not support one is silently ignored.",
        "For tool events there is also an `if` field that uses permission rule syntax, such as `Bash(git *)` or `Edit(*.ts)`. It holds one rule, and the hook process starts only if the tool call matches.",
      ],
    },
    {
      heading: "What your hook receives and how it answers",
      paragraphs: [
        "When an event fires, Claude Code sends your command a JSON object on standard input. Every event includes `session_id`, `cwd` and `hook_event_name`, plus other common fields such as `transcript_path` and `permission_mode`. Tool events add `tool_name` and `tool_input`. For a Bash call, `tool_input.command` is the command line. The docs' own example for `npm test` looks like this:",
        code(
          "json",
          String.raw`{
  "session_id": "abc123",
  "cwd": "/Users/example/myproject",
  "hook_event_name": "PreToolUse",
  "tool_name": "Bash",
  "tool_input": {
    "command": "npm test"
  }
}`,
        ),
        "Other events add their own fields: `UserPromptSubmit` gets the `prompt`, `SessionStart` a `source`. Scripts usually read the JSON with `jq`, which you may need to install.",
        "You answer with the exit code, and optionally JSON on standard output.",
        EXIT_TABLE,
        "Two details save a lot of confusion. First, exit 0 from a `PreToolUse` hook does not approve the tool call. It means \"no objection\", and the normal permission flow still applies. Second, the docs advise picking one approach per hook: exit 2 with a message on stderr, or exit 0 with JSON.",
        "For finer control, exit 0 and print a single JSON object with nothing around it. The universal fields are `continue` (set to `false` to stop Claude entirely), `stopReason`, `systemMessage` (a warning shown to you) and `terminalSequence`. Event-specific answers go inside `hookSpecificOutput`, which needs a `hookEventName`. A `PreToolUse` hook that denies a call looks like this:",
        code(
          "json",
          String.raw`{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Use rg instead of grep for better performance"
  }
}`,
        ),
        "Decision control differs by event. `PreToolUse` uses `permissionDecision` (`allow`, `deny` or `ask`, plus `defer`, which only works in non-interactive `-p` runs) and the reason goes back to Claude. `UserPromptSubmit`, `PostToolUse`, `Stop`, `SubagentStop`, `ConfigChange` and `PreCompact` use a top-level `\"decision\": \"block\"` with a `reason`. `PermissionRequest` uses `hookSpecificOutput.decision.behavior`. Text for Claude goes in `additionalContext`, nested inside `hookSpecificOutput`: at the top level it is silently ignored. The docs cap `additionalContext`, `systemMessage` and plain stdout at 10,000 characters each; anything longer is saved to a file and Claude gets the path plus a short preview.",
        "When several hooks match the same event they run in parallel, and each runs to completion before the results are merged. For `PreToolUse` the most restrictive answer wins, in the order deny, defer, ask, allow. Because matching hooks run in parallel, one hook's deny does not stop the others from running, so do not rely on a deny to suppress another hook's side effects.",
      ],
    },
    {
      heading: "Timeouts and environment variables",
      paragraphs: [
        "Each hook has a `timeout` in seconds. The docs give these defaults: 10 minutes for `command`, `http` and `mcp_tool` hooks, 30 seconds for `prompt` hooks and 60 seconds for `agent` hooks. Claude Code lowers the command default to 30 seconds on `UserPromptSubmit` and the model-switch events, and to 10 seconds on `MessageDisplay`. `SessionEnd` hooks share a 1.5 second budget between them, which a longer per-hook timeout can raise, up to 60 seconds.",
        "The variables the docs name for hook commands:",
        "- `CLAUDE_PROJECT_DIR`: the project root where the session started. Use it to point at scripts, as in `\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/protect-files.sh`, so the path works however Claude has changed directory.\n- `CLAUDE_ENV_FILE`: available to `SessionStart` hooks (and `CwdChanged` and `FileChanged`), a file path where you can write `export` lines so later Bash commands in the session get those variables.\n- `CLAUDE_CODE_REMOTE`: set to `true` in remote web environments only.\n- `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PLUGIN_DATA`: for hooks shipped inside a plugin.",
      ],
    },
    {
      heading: "Six hooks you can copy",
      paragraphs: [
        "These follow the examples in Anthropic's [hooks guide](https://code.claude.com/docs/en/hooks-guide). Add each block to the settings file named in its heading, and merge it into any existing `hooks` object rather than replacing the whole object. If that object already has an array for the same event, such as `PostToolUse`, append the new matcher group to that array instead of adding a second key, because a duplicate key can silently replace the first one.",
        "**1. A desktop notification when Claude needs you.** Add to `~/.claude/settings.json`. This is the docs' first-hook walkthrough. On Linux it uses `notify-send`; on macOS the docs use `osascript`, and for Windows a PowerShell dialog.\n\n" +
          code(
            "json",
            String.raw`{
  "hooks": {
    "Notification": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "notify-send 'Claude Code' 'Claude Code needs your attention'"
          }
        ]
      }
    ]
  }
}`,
          ) +
          "\n\nThe empty matcher fires on every notification type. To narrow it, use `permission_prompt` (Claude needs approval) or `idle_prompt` (Claude finished about 60 seconds ago and you have not typed). The docs warn that `notify-send` needs a desktop notification daemon, which headless servers, SSH sessions and most containers do not have.",
        "**2. Format every file Claude edits.** Add to `.claude/settings.json`. It matches the two file-writing tools and pipes the edited path to Prettier.\n\n" +
          code(
            "json",
            String.raw`{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "f=$(jq -r '.tool_input.file_path') && npx prettier --write --ignore-unknown \"$f\""
          }
        ]
      }
    ]
  }
}`,
          ) +
          "\n\nThe docs note that a successful hook shows nothing in the conversation, so check that the file was reformatted. They also point out that Claude can change files through Bash, which this hook does not see. A `FileChanged` hook, or a `Stop` hook that scans the working tree once per turn, covers that case.",
        "**3. Block edits to protected files.** Save this as `.claude/hooks/protect-files.sh`, run `chmod +x .claude/hooks/protect-files.sh`, then register it.\n\n" +
          code(
            "bash",
            String.raw`#!/bin/bash
# protect-files.sh

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

PROTECTED_PATTERNS=(".env" "package-lock.json" ".git/")

for pattern in "${"$"}{PROTECTED_PATTERNS[@]}"; do
  if [[ "$FILE_PATH" == *"$pattern"* ]]; then
    echo "Blocked: $FILE_PATH matches protected pattern '$pattern'" >&2
    exit 2
  fi
done

exit 0`,
          ) +
          "\n\n" +
          code(
            "json",
            String.raw`{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/protect-files.sh"
          }
        ]
      }
    ]
  }
}`,
          ) +
          "\n\nThis is the exit-2 pattern: the edit is cancelled before it happens, and the `Blocked:` message goes to Claude as feedback so it can try something else.",
        "**4. Log every Bash command.** Add to `~/.claude/settings.json` or a project file. `PostToolUse` fires after a command succeeds and `PostToolUseFailure` after one fails, so registering the logger on both catches every command, and `jq -r '.tool_input.command'` pulls out just the command string.\n\n" +
          code(
            "json",
            String.raw`{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "jq -r '.tool_input.command' >> ~/.claude/command-log.txt"
          }
        ]
      }
    ],
    "PostToolUseFailure": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "jq -r '.tool_input.command' >> ~/.claude/command-log.txt"
          }
        ]
      }
    ]
  }
}`,
          ) +
          "",
        "**5. Re-inject context after compaction.** When the context window fills, Claude Code summarizes the conversation and details can be lost. A `SessionStart` hook with the `compact` matcher runs again after each compaction, and plain text on standard output is added to Claude's context.\n\n" +
          code(
            "json",
            String.raw`{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "compact",
        "hooks": [
          {
            "type": "command",
            "command": "echo 'Reminder: use Bun, not npm. Run bun test before committing. Current sprint: auth refactor.'"
          }
        ]
      }
    ]
  }
}`,
          ) +
          "\n\nReplace the `echo` with a command that produces live output, such as `git log --oneline -5`.",
        "**6. Keep an audit log of settings changes.** The `ConfigChange` event fires when a settings or skills file changes during a session. Add to `~/.claude/settings.json`:\n\n" +
          code(
            "json",
            String.raw`{
  "hooks": {
    "ConfigChange": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "jq -c '{timestamp: now | todate, source: .source, file: .file_path}' >> ~/claude-config-audit.log"
          }
        ]
      }
    ]
  }
}`,
          ) +
          "\n\nIt appends one JSON line per change. To block a change instead, exit 2 or return a block decision.",
        "A seventh pattern deserves a mention because it surprises people: a `PreToolUse` hook that returns a `deny` blocks the tool even in `bypassPermissions` mode or with `--dangerously-skip-permissions`, because these hooks fire before any permission-mode check. That makes hooks the right place for rules that must hold when you have switched prompts off. Our guide to [that flag](/blog/claude-code-dangerously-skip-permissions) covers what it skips.",
      ],
    },
    {
      heading: "Debugging a hook that does nothing",
      paragraphs: [
        "The docs give a checklist, and most failures fall into a few groups.",
        "- **Run `/hooks`** and confirm the hook appears under the event you meant. If your organization has set `allowManagedHooksOnly` in managed settings, your own hooks are ignored.\n- **Check you picked the right event:** `PreToolUse` runs before a tool, `PostToolUse` after.\n- **Run the script by hand** with test input: `echo '{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"ls\"}}' | ./my-hook.sh`, then `echo $?` to see the exit code.\n- **Command not found:** use absolute paths or `$CLAUDE_PROJECT_DIR` for scripts. **jq: command not found:** install `jq`, or parse the JSON with Python or Node.\n- **Read the debug log.** Start a session with `claude --debug`, or type `/debug` in a session you already started. A hook that succeeds usually shows nothing in the conversation, so the debug log is where you see that it ran and what it printed.",
        "Three failure modes are worth knowing by name. If your JSON is ignored with no error, something may be printing before it: an unconditional `echo` in your shell profile makes the output start with something other than `{`, so Claude Code reads it as plain text. Guard such lines with a check on `$-` so they run only in interactive shells, because hooks run in non-interactive ones. If a field is ignored, check its nesting: `permissionDecision` belongs inside `hookSpecificOutput`, and `claude --debug` logs `Hook JSON output had unrecognized keys` when something is misplaced. And build JSON with `jq`, not string concatenation, so quotes inside values are escaped.",
        "A `Stop` hook can loop. It fires whenever Claude finishes responding, so a hook that blocks the stop makes Claude keep working. Claude Code overrides a Stop hook after it blocks eight times in a row with no tool call in between, and the docs tell you to read the `stop_hook_active` field from the input and exit early when it is `true`.",
        "To switch everything off while you debug, set `\"disableAllHooks\": true` in settings. To remove a single hook, delete its entry from the settings file.",
      ],
    },
    {
      heading: "Security: hooks are commands that run on your machine",
      paragraphs: [
        "A hook is a shell command that runs automatically in the current directory with Claude Code's environment. Treat a hook file like any other script you would run, and read one before you accept it from someone else.",
        "- **Read project hooks before you trust a folder.** A `.claude/settings.json` that arrives with a repository can define hooks, and in an interactive session they run once you accept the trust dialog. A `-p` run treats the folder as trusted, so they run straight away.\n- **Do not lean on matchers or `if` for hard rules.** The docs call the `if` filter best-effort. Use permission rules for allow and deny lists.\n- **Fail closed when it matters.** On most events a hook that crashes, times out or prints invalid output is a non-blocking error and the action goes ahead (there are exceptions, such as `WorktreeCreate`, where any failure stops it). Setting `\"onFailure\": \"block\"` (on `command`, `http` or `mcp_tool` hooks, Claude Code v2.1.295 or later) on a hook makes a failure block the action instead.\n- **Write `additionalContext` as facts.** Text you inject reaches Claude as a system reminder. The docs advise factual statements rather than commands, and warn that instruction-style text can trip prompt-injection defenses.\n- **Know the org controls.** Managed settings can set `allowManagedHooksOnly`, which blocks user, project, local and most plugin hooks.",
      ],
    },
    {
      heading: "Running Claude Code hooks on a Hivra computer",
      paragraphs: [
        "A hook is a shell command, and it runs on whatever machine Claude Code runs on. On your laptop that means your formatter, your log files and your notifications live on your laptop, and they stop when it sleeps. Where you run Claude Code decides where your hooks run.",
        "Hivra runs the official Claude Code CLI on a cloud computer of its own, and you reach its terminal and files from a browser on any device. Hooks work there the way the docs describe, because it is a normal Claude Code install: you open the Terminal tab and edit `~/.claude/settings.json` or the project's `.claude/settings.json`, and `/hooks` shows what loaded. Nothing in this guide changes. Three things follow.",
        "- **Hooks run where the agent runs.** The computer stays on, so a formatter on `PostToolUse`, a command log or a `Stop` check keeps running through a run you are not watching. " +
          CLI_RUN_LIFETIME +
          "\n- **Side effects stay off your laptop.** A hook that runs a script, writes logs or calls a tool does so on the Hivra computer, so your laptop is not where it happens. Add a `PreToolUse` guard on `.env` and an unattended agent's actions stay on that computer, under a rule Claude Code enforces.\n- **You are not locked into one agent.** The same Hivra account launches other agents too, including Hermes, OpenClaw, Codex and Agent Zero, each on a computer of its own, and you reach them from a browser on any device. Hooks are a Claude Code feature, but you can try another agent beside it from the same account.",
        "Plans start at " + ENTRY_PLAN_PRICE + " a month for " + ENTRY_PLAN_SIZE + ". You sign in to Claude Code with your own Anthropic account, as you would locally. Hivra hosting does not include or replace your Anthropic subscription or usage, and Hivra is not affiliated with Anthropic.",
        "Some honest limits. Hivra does not configure hooks for you, so you write them as you would anywhere. Desktop notification commands such as `notify-send` need a notification daemon, so on a remote computer you will want a hook that reaches you another way, for instance a command that posts to a chat webhook, which you write yourself. Hivra administrators retain infrastructure access to managed hosts, so a server you run entirely yourself gives you more control. And if you only use Claude Code at your desk, your own machine is simpler.",
        "[Launch Claude Code on Hivra](/agents/claude-code) if you want your hooks to keep running when your laptop is shut. If you would rather build the server yourself, our [Claude Code on Linux guide](/blog/claude-code-on-linux) covers it.",
      ],
    },
    {
      heading: "A sensible first set of hooks",
      paragraphs: [
        "If you add only three, start here. Add the notification hook to your user settings so you know when Claude is waiting. Add the formatter to the project settings so every edit lands tidy. Add the protect-files guard so `.env` and lock files are off limits. Run `/hooks` to confirm all three loaded, trigger each once, and only then commit the project file for your team.",
        "Add more when you catch yourself repeating an instruction to Claude, and read the [hooks reference](https://code.claude.com/docs/en/hooks) for the exact fields of any event you use, because the schema changes between releases.",
      ],
    },
  ],
  faqs: [
    {
      q: "What are Claude Code hooks?",
      a: "Hooks are user-defined shell commands that Claude Code runs automatically at specific points in its lifecycle, such as before a tool call, after a file edit, when Claude finishes or when it needs your input. Because Claude Code runs them, not the model, the actions are deterministic.",
    },
    {
      q: "Where do I configure Claude Code hooks?",
      a: "In the hooks key of a settings file: ~/.claude/settings.json for all your projects, .claude/settings.json for a project you can commit, or .claude/settings.local.json for personal project settings. Plugins, skills and subagents can also carry hooks. Hook entries merge across levels.",
    },
    {
      q: "How do I block a tool call with a hook?",
      a: "Use a PreToolUse hook. Write the reason to stderr and exit with code 2, and Claude Code cancels the call and gives Claude the message. Or exit 0 and print JSON with hookSpecificOutput.permissionDecision set to deny. Use one approach per hook, not both.",
    },
    {
      q: "What do exit codes 0 and 2 mean in a hook?",
      a: "Exit 0 means success, and if standard output is a single JSON object Claude Code reads it as instructions. Exit 2 is a blocking error on events that can block, with stderr as the reason. Any other exit code is a non-blocking error and the action proceeds.",
    },
    {
      q: "Why is my Claude Code hook not running?",
      a: "Check /hooks to see whether it loaded under the right event, then check the matcher, which is case-sensitive and ignored on events that do not support one. Run the script by hand with sample input, make sure it is executable, and start claude with --debug to read the log.",
    },
    {
      q: "Can a hook override --dangerously-skip-permissions?",
      a: "Yes, in one direction. A PreToolUse hook that returns a deny blocks the tool even in bypassPermissions mode or with that flag, because these hooks fire before any permission-mode check. A hook cannot loosen restrictions past what your permission rules allow.",
    },
    {
      q: "Do Claude Code hooks work on a remote server or cloud computer?",
      a: "Yes. A hook is a shell command that runs on the machine where Claude Code runs, so on a server or a Hivra computer the hooks run there. Notification commands such as notify-send need a desktop notification daemon, which headless servers usually lack.",
    },
  ],
  relatedArticles: [
    { slug: "claude-code-mcp", title: "Claude Code MCP: how to add and manage MCP servers" },
    { slug: "claude-code-dangerously-skip-permissions", title: "Claude Code's --dangerously-skip-permissions flag: what it skips and where to run it" },
    { slug: "claude-code-on-linux", title: "Claude Code on Linux: install, sign in, run it on a server and fix common errors" },
    { slug: "keep-claude-code-running-24-7", title: "Will Claude keep running if you close your laptop or lock it? (And how to run Claude Code 24/7)" },
    { slug: "is-it-safe-to-leave-an-ai-agent-running-unattended", title: "Is it safe to leave an AI agent running unattended? The four risks that matter" },
  ],
  relatedComparisons: [{ slug: "vs-self-hosted", title: "Hivra vs self-hosted VPS" }],
};
