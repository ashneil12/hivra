// One place that knows how each CLI agent's event stream maps to chat-UI ops.
//
// Adding a new CLI agent = add one AgentAdapter to ADAPTERS (and a matching
// adapter on the box). The SAME parseEvent drives every chat turn in HivraChat,
// the first-contact welcome included, and extractAssistantText for
// non-interactive turns, so those can never diverge — that divergence was the
// "welcome rendered twice" bug.
//
// Agents fall in two shapes:
//   - structured   (claude `--output-format stream-json`, codex `--json`): rich
//                   events → text deltas + tool cards.
//   - generic      (any other CLI): the box wraps stdout as `{type:"_text"}`
//                   lines and we render them as plain streaming text.

// "operatoros" boxes run a Hermes brain whose event stream is parsed by the same
// default (claude) adapter as every other Hermes/general agent (cliKind "claude").
// It is a first-class kind here so the catalog's cliKind ("operatoros") flows
// through the chat components and on to the box as agent_kind without a cast.
export type AgentKind = "claude" | "codex" | "generic" | "operatoros";
export type ToolStatus = "running" | "done" | "error";
/** How a turn ended, as the agent's own final event reports it. */
export type TurnOutcome = "complete" | "error";

export interface ToolPatch {
  name?: string;
  detail?: string;
  status?: ToolStatus;
  result?: string;
}

// The UI operations a parser may perform. HivraChat wires these to React state;
// extractAssistantText wires them to an in-memory buffer. A parser never
// touches React or the DOM directly — it only emits these intents.
export interface ChatSink {
  /** Record the agent's resume id (claude session_id / codex thread_id). */
  setSessionId(id: string): void;
  /** Append streamed text to the current assistant message. */
  appendText(text: string): void;
  /** Replace the current assistant message text (agents that re-send full text). */
  setText(text: string): void;
  /** Create or update a tool card by id. */
  upsertTool(id: string | undefined, patch: ToolPatch): void;
  /** Surface a warning (rendered as "⚠ …" under the message). A warning never
   * decides how the turn ended: a turn can warn and still complete. */
  appendWarning(text: string): void;
  /** The agent's own final event says how the turn ended (Claude's `result`,
   * Codex's `turn.completed` / `turn.failed`). Agents without one leave it to
   * the process's exit. */
  reportOutcome(outcome: TurnOutcome): void;
}

export interface AgentAdapter {
  kind: AgentKind;
  /** Human label for the agent (used in UI copy / defaults). */
  label: string;
  /** Fresh per-turn scratch state (e.g. codex's id→segment map). */
  createTurnState(): Record<string, unknown>;
  /** Map one stream event onto sink operations. Pure w.r.t. the sink. */
  parseEvent(ev: Record<string, unknown>, sink: ChatSink, state: Record<string, unknown>): void;
  /** The turn's stream is over, whether or not its `_done` line arrived: emit
   * anything held back waiting for more (Codex's last stderr line when the
   * stream ended on it without a newline). */
  endTurn(sink: ChatSink, state: Record<string, unknown>): void;
}

// ---- parse-time formatters (shared by adapters) ----

function fmtInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  return String(i.command || i.url || i.file_path || i.path || i.pattern || i.query || "").slice(0, 130);
}

function snippet(content: unknown): string {
  if (typeof content === "string") return content.slice(0, 200);
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === "object" && "text" in c ? String((c as Record<string, unknown>).text) : ""))
      .join(" ")
      .slice(0, 200);
  }
  return "";
}

// Codex `file_change` carries a changed-paths list; flatten it for the subtitle.
function fmtCodexFiles(item: Record<string, unknown>): string {
  const ch = item.changes;
  if (Array.isArray(ch)) {
    return ch
      .map((c) => (c && typeof c === "object" ? String((c as Record<string, unknown>).path || (c as Record<string, unknown>).file || "") : ""))
      .filter(Boolean)
      .join(", ")
      .slice(0, 130);
  }
  return String(item.path || "");
}

// Join the text blocks of a Claude message's content (ignores tool_use blocks).
function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b && typeof b === "object" && (b as Record<string, unknown>).type === "text" ? String((b as Record<string, unknown>).text || "") : ""))
    .filter(Boolean)
    .join("");
}

// ---- claude: `claude -p --output-format stream-json --include-partial-messages` ----
const claudeAdapter: AgentAdapter = {
  kind: "claude",
  label: "Claude Code",
  createTurnState: () => ({ seenText: false }),
  parseEvent(ev, sink, state) {
    const type = ev.type as string;

    if (type === "system" && ev.subtype === "init") {
      const sid = ev.session_id as string | undefined;
      if (sid) sink.setSessionId(sid);
    } else if (type === "stream_event" && ev.event && typeof ev.event === "object") {
      const e = ev.event as Record<string, unknown>;
      const et = e.type as string;
      if (et === "content_block_delta") {
        const delta = e.delta as { type?: string; text?: string } | undefined;
        if (delta?.type === "text_delta" && delta.text) {
          state.seenText = true;
          sink.appendText(delta.text);
        }
      } else if (et === "content_block_start") {
        const cb = e.content_block as { type?: string; id?: string; name?: string; input?: unknown } | undefined;
        if (cb?.type === "tool_use") {
          sink.upsertTool(cb.id, { name: cb.name || "tool", detail: fmtInput(cb.input), status: "running" });
        }
      }
    } else if (type === "assistant") {
      const content = ((ev.message as Record<string, unknown>)?.content as unknown[]) || [];
      for (const c of content) {
        if (c && typeof c === "object" && (c as Record<string, unknown>).type === "tool_use") {
          const block = c as Record<string, unknown>;
          sink.upsertTool(block.id as string, { name: (block.name as string) || "tool", detail: fmtInput(block.input), status: "running" });
        }
      }
      // Fallback: a run without --include-partial-messages emits no text deltas,
      // only this complete message. Use its text ONLY when no deltas were seen,
      // so partial+final never double the text (the welcome-rendered-twice bug).
      if (!state.seenText) {
        const txt = textFromContent((ev.message as Record<string, unknown>)?.content);
        if (txt) {
          state.seenText = true;
          sink.appendText(txt);
        }
      }
    } else if (type === "user") {
      const content = ((ev.message as Record<string, unknown>)?.content as unknown[]) || [];
      for (const c of content) {
        if (c && typeof c === "object" && (c as Record<string, unknown>).type === "tool_result") {
          const block = c as Record<string, unknown>;
          sink.upsertTool(block.tool_use_id as string, { status: block.is_error ? "error" : "done", result: snippet(block.content) });
        }
      }
    } else if (type === "result") {
      const sid = ev.session_id as string | undefined;
      if (sid) sink.setSessionId(sid);
      // API failures (e.g. an invalid --model → 404) land HERE with is_error:true
      // and the human message in `result` — while subtype still says "success".
      // Without this the turn just ends silently with an empty assistant bubble.
      if (ev.is_error) {
        const msg = typeof ev.result === "string" && ev.result ? ev.result : "The request failed.";
        sink.appendWarning(msg);
      }
      sink.reportOutcome(ev.is_error ? "error" : "complete");
    } else if (type === "_stderr") {
      const text = String(ev.text || "");
      if (/error|invalid|denied|expired|unauthor/i.test(text)) sink.appendWarning(text.trim());
    }
  },
  // Every event is judged as it arrives; nothing is held back.
  endTurn() {},
};

// ---- codex stderr: tracing diagnostics are not replies ----
// `codex exec` logs through tracing-subscriber's default formatter on stderr
// (codex-rs/exec/src/lib.rs: `fmt::layer().with_writer(std::io::stderr)`,
// filter "error" unless RUST_LOG widens it). Every event starts a line with an
// RFC 3339 time, a level padded to five characters, any enabled spans, and the
// module path it came from:
//   2026-09-24T17:59:18.578959Z ERROR codex_core::session::session: failed to load skill …
//   2026-09-24T17:59:26.449919Z  WARN codex.exec{otel.kind="internal"}: codex_core::mcp: …
// with ANSI colours when stderr is a terminal. These are Codex's own
// diagnostics (a skill it could not load, an MCP server that did not start),
// not part of the reply. A problem the owner has to act on — sign-in, a usage
// limit, a model that does not exist — reaches the chat as an `error` or
// `turn.failed` event on stdout. Plain stderr lines, such as the "Error
// loading config.toml: …" Codex prints before a run starts, still show.
const ANSI_ESCAPE = /\x1b\[[0-9;?]*[A-Za-z]/g;
const TRACING_LEVEL = "(?:TRACE|DEBUG|INFO|WARN|ERROR)";
const TRACING_LINE = new RegExp(`^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})\\s+${TRACING_LEVEL}\\s`);
// The same line from a formatter without the time: a level, any spans, then a
// Rust module path ("codex_core::session: ").
const UNTIMED_TRACING_LINE = new RegExp(`^${TRACING_LEVEL}\\s+(?:[^\\s:{}]+(?:\\{[^}]*\\})?:)*\\s*[A-Za-z_]\\w*(?:::\\w+)+:(?:\\s|$)`);
const ACTIONABLE_STDERR = /error|invalid|denied|expired|unauthor/i;

/** True for a line of Codex's tracing output (see above). */
export function isCodexTracingLine(line: string): boolean {
  const plain = line.replace(ANSI_ESCAPE, "");
  return TRACING_LINE.test(plain) || UNTIMED_TRACING_LINE.test(plain);
}

// stderr reaches the chat in the chunks the pipe delivered, which can hold
// several lines or part of one; only whole lines are judged. A tracing event's
// message can span lines, so the indented or blank lines right after one are
// part of it.
function codexStderr(state: Record<string, unknown>, text: string, flush: boolean): string | null {
  const lines = (String(state.stderrTail || "") + text).split(/\r?\n/);
  state.stderrTail = flush ? "" : lines.pop() || "";
  const shown: string[] = [];
  for (const line of lines) {
    if (isCodexTracingLine(line)) state.inTracing = true;
    else if (!(state.inTracing && (!line.trim() || /^\s/.test(line)))) {
      state.inTracing = false;
      shown.push(line);
    }
  }
  const out = shown.join("\n").trim();
  return out && ACTIONABLE_STDERR.test(out) ? out : null;
}

// Codex states a failure more than once: a usage limit arrives as a top-level
// `error` and again as the `turn.failed` that ends the turn. Show each message
// once per turn.
function warnOnce(sink: ChatSink, state: Record<string, unknown>, text: string) {
  const message = text.trim();
  const key = message.replace(/\s+/g, " ");
  const warned = state.warned as Set<string>;
  if (!key || warned.has(key)) return;
  warned.add(key);
  sink.appendWarning(message);
}

// Judge the stderr line still held back for its newline: the stream is over.
function flushCodexStderr(sink: ChatSink, state: Record<string, unknown>) {
  const text = codexStderr(state, "", true);
  if (text) warnOnce(sink, state, text);
}

// ---- codex: `codex exec --json` — thread/turn/item event model ----
const codexAdapter: AgentAdapter = {
  kind: "codex",
  label: "Codex",
  createTurnState: () => ({ segments: new Map<string, string>(), warned: new Set<string>(), stderrTail: "", inTracing: false }),
  parseEvent(ev, sink, state) {
    const type = ev.type as string;
    const segments = state.segments as Map<string, string>;

    if (type === "thread.started") {
      const tid = ev.thread_id as string | undefined;
      if (tid) sink.setSessionId(tid); // resume id
      return;
    }
    if (type === "item.started" || type === "item.updated" || type === "item.completed") {
      const item = (ev.item as Record<string, unknown>) || {};
      const itype = String(item.item_type || item.type || "");
      const id = String(item.id || itype);
      const done = type === "item.completed";
      if (itype === "agent_message" || itype === "assistant_message") {
        // Codex re-sends the full message text per update; accumulate id→text in
        // order so multiple agent messages in one turn concatenate cleanly.
        const text = String(item.text || item.message || snippet(item.content)).trim();
        if (text) {
          segments.set(id, text);
          sink.setText(Array.from(segments.values()).join("\n\n"));
        }
      } else if (itype === "command_execution") {
        const cmd = String(item.command || "");
        const out = String(item.aggregated_output || item.output || "");
        const exit = item.exit_code;
        const status: ToolStatus = done ? (typeof exit === "number" && exit !== 0 ? "error" : "done") : "running";
        sink.upsertTool(id, { name: "Bash", detail: cmd.slice(0, 130), status, result: out ? out.slice(0, 2000) : undefined });
      } else if (itype === "file_change" || itype === "patch" || itype === "patch_apply") {
        sink.upsertTool(id, { name: "Edit", detail: fmtCodexFiles(item), status: done ? "done" : "running" });
      } else if (itype === "web_search") {
        sink.upsertTool(id, { name: "WebSearch", detail: String(item.query || "").slice(0, 130), status: done ? "done" : "running" });
      } else if (itype === "mcp_tool_call") {
        sink.upsertTool(id, { name: String(item.tool || item.name || "mcp"), detail: String(item.server || ""), status: done ? "done" : "running" });
      } else if (itype === "error") {
        warnOnce(sink, state, String(item.message || "error"));
      }
      return;
    }
    if (type === "turn.completed") {
      sink.reportOutcome("complete");
      return;
    }
    if (type === "turn.failed") {
      // The turn's end. Its message is usually the `error` already shown.
      const err = (ev.error as Record<string, unknown>) || {};
      const message = String(err.message || "").trim();
      if (message || (state.warned as Set<string>).size === 0) warnOnce(sink, state, message || "turn failed");
      sink.reportOutcome("error");
      return;
    }
    if (type === "error") {
      const msg = String(ev.message || "");
      if (msg) warnOnce(sink, state, msg);
      return;
    }
    if (type === "_stderr") {
      const text = codexStderr(state, String(ev.text || ""), false);
      if (text) warnOnce(sink, state, text);
      return;
    }
    if (type === "_done") {
      flushCodexStderr(sink, state);
      return;
    }
    // ignore turn.started / unrecognised
  },
  // A computer on the chat gateway from before detached runs ends a stream
  // without `_done` when Codex could not start: its one line is the
  // "spawn error: …" stderr, with no newline of its own.
  endTurn: flushCodexStderr,
};

// ---- generic: ANY other CLI agent the box wraps as plain text ----
// The box streams the child's stdout as `{type:"_text",text}` lines (and stderr
// as `_stderr`). No tools, no structure — just live text. This is the seam that
// makes the base universal: a CLI agent with no JSON mode still chats.
const genericAdapter: AgentAdapter = {
  kind: "generic",
  label: "Agent",
  createTurnState: () => ({}),
  parseEvent(ev, sink) {
    const type = ev.type as string;
    if (type === "_text") {
      const t = String(ev.text || "");
      if (t) sink.appendText(t);
      return;
    }
    if (type === "_stderr") {
      const text = String(ev.text || "");
      if (/error|invalid|denied|expired|unauthor|fatal|traceback/i.test(text)) sink.appendWarning(text.trim());
      return;
    }
    // ignore _done and anything unrecognised
  },
  endTurn() {},
};

const ADAPTERS: Record<AgentKind, AgentAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  generic: genericAdapter,
  // OperatorOS = a Hermes brain → parsed by the default/claude adapter, exactly
  // as getAdapter() already fell back to for this kind before it was named here.
  operatoros: claudeAdapter,
};

/** Resolve an adapter by kind, defaulting to claude for unknown kinds. */
export function getAdapter(kind: string | null | undefined): AgentAdapter {
  return ADAPTERS[(kind as AgentKind)] || claudeAdapter;
}

/**
 * Run an agent's parser over a list of stream events and return the assistant
 * text it produced — for non-interactive turns that need only the final text.
 * Shares the exact parser the live chat uses, so the two never diverge.
 */
export function extractAssistantText(events: Record<string, unknown>[], kind: string): string {
  const adapter = getAdapter(kind);
  const state = adapter.createTurnState();
  let text = "";
  const sink: ChatSink = {
    setSessionId: () => {},
    appendText: (t) => {
      text += t;
    },
    setText: (t) => {
      text = t;
    },
    upsertTool: () => {},
    appendWarning: () => {},
    reportOutcome: () => {},
  };
  for (const ev of events) adapter.parseEvent(ev, sink, state);
  adapter.endTurn(sink, state);
  return text;
}
