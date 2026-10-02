// tmux cheat sheet data and command builder (/tools/tmux-cheat-sheet). Pure, so
// the page, the builder, the URL parameters and the tests read one source.
//
// Every key and command here was checked on 2026-09-30 against the tmux(1)
// manual (man7.org): the DEFAULT KEY BINDINGS table, the new-session (-A, -d,
// -s), attach-session (-d, -t), pipe-pane (-o, and "no command closes the
// pipe"), capture-pane (-p, -S with "-" as the start of history) and send-keys
// entries, the copy-mode table (emacs and vi keys), and the mode-keys, mouse
// and history-limit options. The manual says a target that is not fully
// qualified is a best guess and that scripts should qualify it, so commands
// that act on a pane use "NAME:" (that session's current window and active
// pane). Update lastVerified only when that page is re-read.
//
// Copy note: the word "windows" is tmux vocabulary. The public-copy rules ban
// the capitalised word for the operating system, so it is never capitalised
// here, including at the start of a sentence or heading.

export const TMUX_FACTS = {
  lastVerified: "2026-09-30",
  sources: {
    manual: { label: "tmux(1) manual", url: "https://man7.org/linux/man-pages/man1/tmux.1.html" },
  },
} as const;

export interface CheatRow {
  id: string;
  /** Keys pressed inside tmux, for example "Ctrl-b d". */
  keys?: string;
  /** A command to type in a shell, with a copy button. */
  command?: string;
  does: string;
}

export interface CheatSection {
  id: string;
  title: string;
  intro: string;
  rows: CheatRow[];
}

export const TMUX_KEYS_NOTE =
  "Keys written Ctrl-b d mean: press Ctrl and b together, let go, then press d. Ctrl-b is tmux's default prefix key.";

export const TMUX_TARGET_NOTE =
  "A trailing colon, as in claude:, points a command at that session's current window and active pane. tmux's manual says scripts should fully qualify a target, so the pane commands here do.";

export const TMUX_SECTIONS: CheatSection[] = [
  {
    id: "sessions",
    title: "Sessions",
    intro: "A session is one named workspace. It keeps running in the background until you kill it or the machine restarts.",
    rows: [
      { id: "new", command: "tmux new -s NAME", does: "Start a named session and attach to it." },
      { id: "new-detached", command: "tmux new -d -s NAME", does: "Start a session in the background without attaching." },
      { id: "new-or-attach", command: "tmux new -A -s NAME", does: "Attach to NAME if it exists, otherwise create it." },
      { id: "ls", command: "tmux ls", does: "List sessions." },
      { id: "rename", keys: "Ctrl-b $", command: "tmux rename-session -t OLD NEW", does: "Rename the current session." },
      { id: "choose-session", keys: "Ctrl-b s", does: "Pick a session from a list." },
      { id: "switch-session", keys: "Ctrl-b ( or Ctrl-b )", does: "Switch to the previous or next session." },
      { id: "kill-session", command: "tmux kill-session -t NAME", does: "Destroy a session and everything running in it." },
    ],
  },
  {
    id: "windows",
    title: "Tabs inside a session (windows)",
    intro: "A window fills the screen, like a browser tab. A session can hold many.",
    rows: [
      { id: "new-window", keys: "Ctrl-b c", command: "tmux new-window -n NAME", does: "Create a window." },
      { id: "next-window", keys: "Ctrl-b n", does: "Go to the next window." },
      { id: "previous-window", keys: "Ctrl-b p", does: "Go to the previous window." },
      { id: "select-window", keys: "Ctrl-b 0 to 9", does: "Jump to a window by its number." },
      { id: "choose-window", keys: "Ctrl-b w", does: "Pick a window from a list." },
      { id: "rename-window", keys: "Ctrl-b ,", does: "Rename the current window." },
      { id: "kill-window", keys: "Ctrl-b &", does: "Kill the current window. tmux asks you to confirm." },
    ],
  },
  {
    id: "panes",
    title: "Panes (splits inside a window)",
    intro: "A pane is one terminal. Split a window to watch several things at once.",
    rows: [
      { id: "split-lr", keys: "Ctrl-b %", command: "tmux split-window -h", does: "Split into left and right panes." },
      { id: "split-tb", keys: 'Ctrl-b "', command: "tmux split-window -v", does: "Split into top and bottom panes." },
      { id: "move", keys: "Ctrl-b then an arrow key", does: "Move to the pane above, below, left or right." },
      { id: "next-pane", keys: "Ctrl-b o", does: "Move to the next pane." },
      { id: "zoom", keys: "Ctrl-b z", does: "Zoom the current pane to fill the window. Press again to restore." },
      { id: "resize", keys: "Ctrl-b, then hold Ctrl and press an arrow key", does: "Resize the current pane one cell at a time." },
      { id: "layout", keys: "Ctrl-b Space", does: "Cycle through the preset layouts." },
      { id: "break", keys: "Ctrl-b !", does: "Break the current pane out into its own window." },
      { id: "kill-pane", keys: "Ctrl-b x", does: "Kill the current pane. tmux asks you to confirm." },
    ],
  },
  {
    id: "detach-attach",
    title: "Detach and attach",
    intro: "Detaching leaves the session running. Attaching brings it back, from the same terminal or another device.",
    rows: [
      { id: "detach", keys: "Ctrl-b d", command: "tmux detach", does: "Detach. Everything in the session keeps running." },
      { id: "attach", command: "tmux attach -t NAME", does: "Attach to a session that's already running." },
      { id: "attach-last", command: "tmux attach", does: "Attach to the most recently used session." },
      { id: "take-over", command: "tmux attach -d -t NAME", does: "Attach and detach any other client still attached, for example your laptop." },
    ],
  },
  {
    id: "copy-mode",
    title: "Copy mode and scrollback",
    intro:
      "Copy mode is how you scroll back and copy text inside tmux. The keys depend on the mode-keys option: emacs keys by default, vi keys if your VISUAL or EDITOR contains vi.",
    rows: [
      { id: "enter-copy", keys: "Ctrl-b [", does: "Enter copy mode. Scroll with the arrow keys or Page Up and Page Down." },
      { id: "page-up", keys: "Ctrl-b Page Up", does: "Enter copy mode and scroll one page up." },
      { id: "emacs-select", keys: "Ctrl-Space, then Alt-w", does: "Emacs keys: start a selection, then copy it and leave copy mode." },
      { id: "vi-select", keys: "Space, then Enter", does: "Vi keys: start a selection, then copy it and leave copy mode." },
      { id: "search", keys: "Ctrl-s or Ctrl-r (emacs), / or ? (vi)", does: "Search forwards or backwards through the history." },
      { id: "leave-copy", keys: "Escape (emacs) or q (vi)", does: "Leave copy mode without copying." },
      { id: "paste", keys: "Ctrl-b ]", does: "Paste the most recently copied text." },
      { id: "vi-keys", command: "tmux set -g mode-keys vi", does: "Use vi keys in copy mode." },
      { id: "history", command: "tmux set -g history-limit 50000", does: "Hold up to 50,000 lines of history per pane." },
      { id: "mouse", command: "tmux set -g mouse on", does: "Let the mouse scroll, select and switch panes." },
    ],
  },
  {
    id: "logging",
    title: "Log a pane to a file",
    intro:
      "pipe-pane sends everything a pane prints to a command. It starts from the moment you run it and doesn't include earlier output. The file holds raw terminal output, so it includes anything the pane showed, secrets included. Keep it private.",
    rows: [
      {
        id: "log-start",
        command: "tmux pipe-pane -o -t NAME: 'cat >> ~/NAME.log'",
        does: "Start appending the pane's output to a file. The -o flag only opens a pipe if none is open, and closes an open one, so running it again turns logging off.",
      },
      { id: "log-stop", command: "tmux pipe-pane -t NAME:", does: "Stop logging. With no command, pipe-pane closes the current pipe." },
      {
        id: "log-snapshot",
        command: "tmux capture-pane -p -S - -t NAME: > ~/NAME-scrollback.txt",
        does: "Save the pane's whole history and screen to a file once. The - after -S means the start of the history.",
      },
    ],
  },
];

export interface AgentRow {
  id: string;
  command: string;
  does: string;
}

/** The "AI coding agents" section, written for a session named claude. */
export const TMUX_AGENT_SECTION: { id: string; title: string; intro: string; rows: AgentRow[] } = {
  id: "ai-agents",
  title: "tmux for AI coding agents",
  intro:
    "A coding agent is a long-running process, so give it a session you can leave and come back to. Use one named session per agent, re-attach from any device, and keep a log.",
  rows: [
    { id: "agent-new", command: "tmux new -d -s claude", does: "One named session per agent, started in the background, so tmux ls tells you what's running." },
    {
      id: "agent-start",
      command: "tmux send-keys -t claude: 'claude' Enter",
      does: "Type the agent's command into the session. The shell stays open after the agent exits, so you can read the last output.",
    },
    { id: "agent-attach", command: "tmux attach -t claude", does: "Watch it work. Ctrl-b d leaves it running." },
    { id: "agent-ls", command: "tmux ls", does: "See every agent session at a glance." },
    {
      id: "agent-takeover",
      command: "tmux attach -d -t claude",
      does: "Pick it up from another device: connect to the machine over SSH, then run this. The -d detaches the device that was still attached.",
    },
    { id: "agent-log", command: "tmux pipe-pane -o -t claude: 'cat >> ~/claude.log'", does: "Keep a log of everything the agent prints from now on." },
    { id: "agent-peek", command: "tmux capture-pane -p -S -40 -t claude:", does: "Peek at the current screen plus 40 lines of history without attaching." },
    { id: "agent-kill", command: "tmux kill-session -t claude", does: "Stop the session, and the agent with it." },
  ],
};

/** The plain statement the page must make about what tmux does and does not keep alive. */
export const TMUX_SLEEP_NOTE =
  "tmux keeps a session alive through disconnects: a closed terminal, a dropped SSH connection, a different device. It doesn't keep anything going through a sleeping laptop, because the whole machine suspends, tmux included.";

export const TMUX_HIERARCHY_ALT =
  "Diagram of how tmux nests its parts. One tmux server holds sessions, each session holds windows, and each window is split into panes. Your terminal is a client that attaches to a session and can detach from it without stopping it.";

export const TMUX_HIERARCHY_TEXT =
  "The tmux server holds sessions. A session holds windows. A window holds panes. Your terminal is a client: it attaches to one session and detaches without stopping it.";

export const TMUX_DIAGRAM = {
  src: "/images/tools/tmux-session-hierarchy.svg",
  width: 720,
  height: 556,
} as const;

// ---- The builder ----------------------------------------------------------

export type TmuxAgent = "claude" | "codex" | "other";

export const TMUX_AGENTS = ["claude", "codex", "other"] as const;
/** Agents a shared link may carry. "other" needs a typed command, which stays in the visitor's browser. */
export const TMUX_LINK_AGENTS = ["claude", "codex"] as const;

export const TMUX_AGENT_LABELS: Record<TmuxAgent, string> = {
  claude: "Claude Code",
  codex: "Codex",
  other: "Another command-line agent",
};

export const TMUX_SESSION_NAME_MAX = 24;
export const TMUX_COMMAND_MAX = 120;

export interface TmuxBuilderInput {
  agent: TmuxAgent;
  /** Session name as typed. Sanitised by cleanSessionName. */
  sessionName: string;
  /** The command for agent "other". */
  otherCommand: string;
  logging: boolean;
}

export const TMUX_BUILDER_DEFAULTS: TmuxBuilderInput = {
  agent: "claude",
  sessionName: "",
  otherCommand: "",
  logging: false,
};

export const TMUX_OTHER_PLACEHOLDER = "your-agent";

/** The command a preset agent runs. */
export function agentCommand(agent: TmuxAgent, otherCommand: string): string {
  if (agent === "claude") return "claude";
  if (agent === "codex") return "codex";
  return cleanOtherCommand(otherCommand);
}

export function cleanOtherCommand(raw: string): string {
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, TMUX_COMMAND_MAX)
    .trim();
  return cleaned === "" ? TMUX_OTHER_PLACEHOLDER : cleaned;
}

/** Letters, digits, dash and underscore only: safe in a shell and in a tmux target. */
export function cleanSessionName(raw: string, fallback: string): string {
  const cleaned = raw
    .replace(/[^A-Za-z0-9_-]/g, "")
    .slice(0, TMUX_SESSION_NAME_MAX);
  return cleaned === "" ? fallback : cleaned;
}

/** The session name used when the visitor has not typed one. */
export function defaultSessionName(agent: TmuxAgent): string {
  return agent === "other" ? "agent" : agent;
}

/** Quote a string for a POSIX shell inside single quotes. */
export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface TmuxBuilderResult {
  sessionName: string;
  command: string;
  lines: string[];
  script: string;
  /** Commands for later, once the session is running. */
  later: { label: string; command: string }[];
}

export function buildTmuxCommands(input: TmuxBuilderInput): TmuxBuilderResult {
  const sessionName = cleanSessionName(input.sessionName, defaultSessionName(input.agent));
  const command = agentCommand(input.agent, input.otherCommand);
  const target = `${sessionName}:`;
  const lines: string[] = [];
  lines.push("# Start the session in the background");
  lines.push(`tmux new -d -s ${sessionName}`);
  if (input.logging) {
    lines.push("# Log everything the pane prints, from now on");
    lines.push(`tmux pipe-pane -o -t ${target} 'cat >> ~/${sessionName}.log'`);
  }
  lines.push("# Run the agent inside it");
  lines.push(`tmux send-keys -t ${target} ${shellSingleQuote(command)} Enter`);
  lines.push("# Watch it. Ctrl-b then d leaves it running");
  lines.push(`tmux attach -t ${sessionName}`);

  const later: TmuxBuilderResult["later"] = [
    { label: "Come back to it, from any device you can SSH from", command: `tmux attach -d -t ${sessionName}` },
    { label: "Peek without attaching", command: `tmux capture-pane -p -S -40 -t ${target}` },
  ];
  if (input.logging) {
    later.push({ label: "Stop logging", command: `tmux pipe-pane -t ${target}` });
  }
  later.push({ label: "Stop the session and the agent", command: `tmux kill-session -t ${sessionName}` });

  return { sessionName, command, lines, script: lines.join("\n"), later };
}
