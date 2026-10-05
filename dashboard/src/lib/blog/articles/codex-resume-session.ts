import { BlogArticle } from "../types";
import { LARGER_PLAN_PRICE, LARGER_PLAN_SIZE, PLAN_SUMMARY } from "../plan-facts";
import { CLI_RUN_LIFETIME } from "../runtime-facts";

// Written 2026-10-05 for "codex resume" (880 US searches a month Aug 2026, KD 0) with
// "codex resume session" (480) folded in. Claude Code resume stays a section: code.claude.com
// owns that SERP (checked 2026-10-02).
//
// Sources read this run:
// - OpenAI Codex CLI reference (developers.openai.com/codex/cli/reference and
//   learn.chatgpt.com/docs/developer-commands): codex resume, --last, --all,
//   --include-non-interactive, codex exec resume, /resume, codex fork
// - Local `codex resume --help` and `codex exec resume --help` on Codex CLI 0.159.0
// - Local check: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl on this machine
// - Anthropic sessions docs (code.claude.com/docs/en/sessions): --continue, --resume,
//   /resume, ~/.claude/projects/, cleanupPeriodDays default 30 days
// - Hivra chat spawn: dashboard/provisioner/hivra-chat/server.js (codex exec resume,
//   claude --resume)
// - Community tip: ian.is/post/codex-session-resume (credit @fcoury for the early
//   "continue from latest jsonl" pattern; official `codex resume` supersedes it)
//
// F2 (session history surviving a browser reconnect on Hivra) is untested: do not claim it.
// Never say Hivra keeps or backs up sessions. Export JSON / shared account memory are
// Claude Code and Codex only.

const READ_ON = "5 October 2026";
const CODEX_VER = "0.159.0";
const CLAUDE_VER = "2.1.265";
const CODEX_REF = "https://developers.openai.com/codex/cli/reference";
const CLAUDE_SESSIONS = "https://code.claude.com/docs/en/sessions";
const IAN_TIP = "https://ian.is/post/codex-session-resume";

export const article: BlogArticle = {
  slug: "codex-resume-session",
  title: "How to resume a Codex session (and Claude Code too)",
  metaTitle: "Resume a Codex CLI session: commands (5 Oct 2026)",
  metaDescription:
    "Resume a Codex CLI session with codex resume, --last, session ID, or exec resume. Where history lives, tmux reattach, and Claude Code resume too.",
  publishedDate: "2026-10-05",
  lastModified: "2026-10-05",
  readingTimeMin: 11,
  author: "Hivra team",
  tagline: "codex resume brings the chat back. tmux brings the live process back.",
  intro: `Codex stores each chat on disk, so you can leave and come back. The commands below were checked against Codex CLI ${CODEX_VER} on ${READ_ON}. Claude Code's resume flags sit in a later section, because Anthropic already owns that search.`,
  shortAnswer: `To resume a Codex CLI session, run codex resume --last for the newest chat in this folder, codex resume for the picker, or codex resume <id>. Sessions are saved under ~/.codex/sessions/. Checked against Codex CLI ${CODEX_VER} on ${READ_ON}. Claude Code uses claude --continue or claude --resume instead.`,
  sections: [
    {
      heading: `Codex resume commands (CLI ${CODEX_VER}, ${READ_ON})`,
      paragraphs: [
        `OpenAI's [CLI reference](${CODEX_REF}) lists \`codex resume\` as the way to continue an interactive session. We also ran \`codex resume --help\` and \`codex exec resume --help\` on Codex CLI ${CODEX_VER} on ${READ_ON}. Use these:`,
        [
          "| Command | What it does |",
          "|---|---|",
          "| `codex resume` | Opens the session picker for this working directory |",
          "| `codex resume --last` | Skips the picker and reopens the newest session here |",
          "| `codex resume --all` | Same picker, but across every folder (shows a CWD column) |",
          "| `codex resume <SESSION_ID>` | Resumes one session by UUID or by name (UUID wins if both match) |",
          "| `codex resume --include-non-interactive` | Also lists sessions started with `codex exec` |",
          "| `codex resume --last \"next step\"` | Resumes the newest session and sends a follow-up prompt |",
          "| `/resume` inside the TUI | Opens the same picker without leaving Codex |",
          "| `codex fork` / `codex fork --last` | Copies a session into a new chat, leaves the original alone |",
        ].join("\n"),
        `\`codex resume --last\` only looks in the current working directory unless you add \`--all\`. If the folder you're in differs from the folder the session saved, Codex asks which directory to use. You can set \`tui.resume_cwd\` to \`"current"\` or \`"session"\` in config to skip that prompt. An explicit \`--cd\` / \`-C\` wins over that setting.`,
        `Before \`codex resume\` shipped, people scraped the latest rollout file by hand. Ian Nuttall's [codex_continue tip](${IAN_TIP}) (crediting @fcoury) is the pattern that post describes. Prefer the built-in command now.`,
      ],
    },
    {
      heading: "Where Codex stores session history",
      paragraphs: [
        `On this machine, Codex CLI ${CODEX_VER} writes one JSONL rollout file per session under \`~/.codex/sessions/YYYY/MM/DD/\`, named like \`rollout-….jsonl\`. If you set \`CODEX_HOME\`, look under that directory instead of \`~/.codex\`. OpenAI's public CLI reference page doesn't spell the path out; the layout above is what we see on disk on ${READ_ON}.`,
        "That file is the chat: your prompts, the model's replies, tool calls and outputs. Resume reloads it. Delete the file (or run `codex delete` on the session) and you lose that transcript.",
        "Archiving is different from deleting. `codex archive <SESSION>` hides a session from the active list and keeps the transcript. `codex unarchive <SESSION>` brings it back. `codex delete <SESSION>` removes the transcript for good.",
      ],
    },
    {
      heading: "Resume a non-interactive `codex exec` run",
      paragraphs: [
        `Scripted runs use \`codex exec\` (alias \`codex e\`). To continue one, OpenAI's reference and local help both show a \`resume\` subcommand:`,
        [
          "```bash",
          "# Newest exec session in this folder, with a follow-up prompt",
          'codex exec resume --last "run the failing tests again"',
          "",
          "# A specific session id",
          'codex exec resume <SESSION_ID> "continue from the last step"',
          "",
          "# Search across folders when picking --last",
          "codex exec resume --last --all",
          "```",
        ].join("\n"),
        "Add `--include-non-interactive` on the interactive `codex resume` picker if you want those exec sessions listed there too.",
      ],
    },
    {
      heading: "tmux reattach vs Codex resume: two different jobs",
      paragraphs: [
        "People mix these up.",
        "**tmux** keeps a live process going through a closed terminal or a dropped SSH connection. You reattach with `tmux attach -t NAME` and the same Codex process is still there, mid-turn if it was mid-turn. The [tmux cheat sheet](/tools/tmux-cheat-sheet) has the keys.",
        "**`codex resume`** reloads a saved chat after the Codex process has exited. New process, same transcript.",
        "On a laptop that sleeps, neither helps while the machine is asleep. Sleep suspends everything. For work that has to keep going with the lid shut, put the CLI inside tmux on a computer that stays on. The [24/7 Claude Code guide](/blog/keep-claude-code-running-24-7) and the [Codex cloud vs own computer guide](/blog/run-codex-24-7-in-the-cloud) cover that choice.",
      ],
    },
    {
      heading: `Claude Code resume (CLI ${CLAUDE_VER}, docs read ${READ_ON})`,
      paragraphs: [
        `Anthropic's [sessions docs](${CLAUDE_SESSIONS}) (read ${READ_ON}) are the source for Claude Code. Local \`claude --version\` on this machine reported ${CLAUDE_VER}. The flags:`,
        [
          "| Command | What it does |",
          "|---|---|",
          "| `claude --continue` | Reopens the most recent conversation in the current directory |",
          "| `claude --resume` | Opens the session picker |",
          "| `claude --resume <name-or-id>` | Resumes that named session or session ID |",
          "| `claude --resume /absolute/path/to/file.jsonl` | Resumes from a transcript file path |",
          "| `/resume` inside a session | Switches to another conversation from the picker |",
        ].join("\n"),
        "Claude Code stores transcripts as JSONL under `~/.claude/projects/<project-dir>/`, where the project directory name is your working path with non-alphanumeric characters replaced by `-`. The default retention is 30 days (`cleanupPeriodDays` in `settings.json`). Change that setting if you need it longer.",
        "A resumed Claude Code session restores conversation history, and in several launch paths it also restores model, agent, permission mode, active goals and unexpired scheduled tasks. Background Bash and monitor tasks aren't restored. Anthropic's docs spell out the permission-mode cases by how you resume; pass `--permission-mode` or `--dangerously-skip-permissions` when you want to override.",
        "This page doesn't try to outrank Anthropic on \"claude code resume\". Use their docs for edge cases. The Codex half is the gap this guide fills.",
      ],
    },
    {
      heading: "What Hivra does with resume",
      paragraphs: [
        `${CLI_RUN_LIFETIME}`,
        "Hivra's browser chat for Claude Code and Codex resumes a stored session id when you send the next message. In the provisioner code that spawn path uses `codex exec resume <sessionId> …` for Codex and `claude --resume <sessionId>` for Claude Code (see `dashboard/provisioner/hivra-chat/server.js`). That's how the chat process is started again. It isn't a tested claim that every browser reconnect restores the full transcript you saw before you left.",
        "We haven't verified that CLI session history and tmux sessions survive a closed laptop plus a browser reconnect on a served Hivra computer end to end. So this page does not claim that. What we do state is the line above: the computer stays on and keeps files, sessions and login on a paid plan, and a run you start inside tmux in the Terminal tab keeps going after you close the laptop.",
        "Hivra does not promise backups of your sessions. Export JSON and shared account memory exist for Claude Code and Codex computers only.",
        `${PLAN_SUMMARY} The ${LARGER_PLAN_PRICE} plan is ${LARGER_PLAN_SIZE}. Launch Codex from [the Codex agent page](/agents/codex) or Claude Code from [the Claude Code agent page](/agents/claude-code). Hivra is independent and is not affiliated with OpenAI or Anthropic.`,
      ],
    },
  ],
  faqs: [
    {
      q: "How do I resume the most recent Codex session?",
      a: `Run codex resume --last in the same working directory. That skips the picker. Add --all if the newest session you want might live in another folder. Checked against Codex CLI ${CODEX_VER} on ${READ_ON}.`,
    },
    {
      q: "Where does Codex store sessions?",
      a: `On this machine with Codex CLI ${CODEX_VER}, under ~/.codex/sessions/YYYY/MM/DD/ as rollout-*.jsonl files (or under $CODEX_HOME/sessions/ if CODEX_HOME is set). OpenAI's public CLI reference doesn't print that path; we confirmed it on disk on ${READ_ON}.`,
    },
    {
      q: "What is the difference between tmux attach and codex resume?",
      a: "tmux attach rejoins a process that is still running. codex resume starts Codex again and reloads a saved transcript after the process has exited. Use both when you want a long run that survives disconnects and a way back after you quit.",
    },
    {
      q: "How do I resume a Codex exec session?",
      a: 'Use codex exec resume --last "follow-up prompt", or pass a session id: codex exec resume <SESSION_ID> "follow-up". Add --all with --last to search outside the current directory.',
    },
    {
      q: "How do I resume a Claude Code session?",
      a: `claude --continue reopens the most recent chat in this directory. claude --resume opens the picker, and claude --resume <name-or-id> jumps straight to one session. Anthropic's sessions docs, read ${READ_ON}, are the full reference. Local claude --version reported ${CLAUDE_VER}.`,
    },
    {
      q: "How long does Claude Code keep session history?",
      a: "Anthropic's sessions docs say the default cleanupPeriodDays is 30. Change that in settings.json if you need a different window. Codex retention on disk follows whatever you leave under ~/.codex/sessions/ until you archive or delete.",
    },
    {
      q: "Does a Hivra computer keep my Codex sessions when I close the laptop?",
      a: `${CLI_RUN_LIFETIME} We haven't published a measured test of session history across a browser reconnect, so treat that as untested. Hivra does not promise session backups.`,
    },
    {
      q: "Can I resume Codex from another device?",
      a: "The CLI resume commands read session files on the machine where Codex ran. To continue from another device, that device needs access to the same machine (SSH, a cloud desktop, or a Hivra computer you open in the browser) and the same ~/.codex data. Codex cloud is a different product path; see the Codex 24/7 guide for when OpenAI's cloud is enough.",
    },
    {
      q: "Is Hivra affiliated with OpenAI or Anthropic?",
      a: "No. Hivra is independent and is not affiliated with OpenAI or Anthropic. You sign in with your own ChatGPT or Claude account on the computer.",
    },
  ],
  relatedArticles: [
    { slug: "run-codex-24-7-in-the-cloud", title: "Codex cloud, or Codex on a computer that stays on?" },
    { slug: "keep-claude-code-running-24-7", title: "Will Claude Code keep running if you close your laptop?" },
    { slug: "claude-code-vs-codex-24-7", title: "Claude Code vs Codex for running 24/7" },
    { slug: "codex-pricing-by-chatgpt-plan", title: "Codex pricing by ChatGPT plan" },
    { slug: "ai-agent-dies-terminal-closes-fixes", title: "Why your AI agent dies when the terminal closes" },
  ],
};
