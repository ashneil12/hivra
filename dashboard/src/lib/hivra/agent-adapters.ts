// One place that knows how each CLI agent's event stream maps to chat-UI ops.
//
// Adding a new CLI agent = add one AgentAdapter to ADAPTERS (and a matching
// adapter on the box). The SAME parseEvent drives BOTH the live chat
// (HivraChat) and the welcome extraction (agent-welcome), so those two can never
// diverge — that divergence was the "welcome rendered twice" bug.
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

export interface ToolPatch {
  name?: string;
  detail?: string;
  status?: ToolStatus;
  result?: string;
}

// The UI operations a parser may perform. HivraChat wires these to React state;
// the welcome extractor wires them to an in-memory buffer. A parser never
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
  /**
   * Surface a NON-FATAL notice (rendered as "⚠ …" under the message). The turn
   * may still finish successfully — e.g. an MCP server that failed to connect,
   * codex ERROR-level tracing, or a codex retry notice. A warning must never,
   * on its own, mark the turn as failed.
   */
  appendWarning(text: string): void;
  /**
   * The agent reported that the turn FAILED (terminal): claude `result` with
   * is_error, codex `turn.failed`, or a codex `error` the turn never recovered
   * from. `reason` is the human-readable cause shown with the failed turn.
   */
  fail(reason: string): void;
  /**
   * The box reported that the agent process exited (`{type:"_done", code}` —
   * written by the box on child close). `null` means the process was killed by
   * a signal. Only a 0 exit confirms the turn completed; anything else is a
   * failure even if the transport then closes cleanly.
   */
  exit(code: number | null): void;
}

export interface AgentAdapter {
  kind: AgentKind;
  /** Human label for the agent (used in UI copy / defaults). */
  label: string;
  /** Fresh per-turn scratch state (e.g. codex's id→segment map). */
  createTurnState(): Record<string, unknown>;
  /** Map one stream event onto sink operations. Pure w.r.t. the sink. */
  parseEvent(ev: Record<string, unknown>, sink: ChatSink, state: Record<string, unknown>): void;
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

// Box-level protocol events, shared by every adapter. Returns true when the
// event was consumed.
//   {type:"_done", code}  — the agent process exited (box: child "close").
//   {type:"_stderr", text:"spawn error: …"} — the box could not start the agent
//     and ended the stream without `_done` (box: child "error").
const SPAWN_ERROR_PREFIX = "spawn error:";
function parseBoxEvent(ev: Record<string, unknown>, sink: ChatSink): boolean {
  if (ev.type === "_done") {
    sink.exit(typeof ev.code === "number" ? ev.code : null);
    return true;
  }
  if (ev.type === "_stderr" && typeof ev.text === "string" && ev.text.startsWith(SPAWN_ERROR_PREFIX)) {
    const detail = ev.text.slice(SPAWN_ERROR_PREFIX.length).trim();
    sink.fail(detail ? `Agent process could not start (${detail})` : "Agent process could not start");
    return true;
  }
  return false;
}

// Codex item statuses (exec_events: CommandExecutionStatus / PatchApplyStatus /
// McpToolCallStatus). Only an observed success maps to "done".
function codexItemStatus(item: Record<string, unknown>, completed: boolean): ToolStatus {
  const status = typeof item.status === "string" ? item.status : "";
  if (status === "failed" || status === "declined") return "error";
  if (item.error && typeof item.error === "object") return "error";
  if ("exit_code" in item && item.exit_code !== undefined) {
    const exit = item.exit_code;
    if (typeof exit === "number" && exit !== 0) return "error";
    // A finished command with no exit code was never run to completion.
    if (completed && exit === null) return "error";
  }
  if (!completed || status === "in_progress") return "running";
  return "done";
}


// ---- claude: `claude -p --output-format stream-json --include-partial-messages` ----
const claudeAdapter: AgentAdapter = {
  kind: "claude",
  label: "Claude Code",
  createTurnState: () => ({ seenText: false }),
  parseEvent(ev, sink, state) {
    const type = ev.type as string;
    if (parseBoxEvent(ev, sink)) return;

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
        sink.fail(msg);
      }
    } else if (type === "_stderr") {
      const text = String(ev.text || "");
      if (/error|invalid|denied|expired|unauthor/i.test(text)) sink.appendWarning(text.trim());
    }
  },
};

// ---- codex: `codex exec --json` — thread/turn/item event model ----
const codexAdapter: AgentAdapter = {
  kind: "codex",
  label: "Codex",
  createTurnState: () => ({ segments: new Map<string, string>(), turnCompleted: false, lastError: undefined }),
  parseEvent(ev, sink, state) {
    const type = ev.type as string;
    const segments = state.segments as Map<string, string>;
    if (type === "_done" && !state.turnCompleted && typeof state.lastError === "string") {
      // The process ended without finishing the turn after reporting an error:
      // that error is why the turn did not complete.
      sink.fail(state.lastError);
    }
    if (parseBoxEvent(ev, sink)) return;

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
        sink.upsertTool(id, { name: "Bash", detail: cmd.slice(0, 130), status: codexItemStatus(item, done), result: out ? out.slice(0, 2000) : undefined });
      } else if (itype === "file_change" || itype === "patch" || itype === "patch_apply") {
        sink.upsertTool(id, { name: "Edit", detail: fmtCodexFiles(item), status: codexItemStatus(item, done) });
      } else if (itype === "web_search") {
        sink.upsertTool(id, { name: "WebSearch", detail: String(item.query || "").slice(0, 130), status: codexItemStatus(item, done) });
      } else if (itype === "mcp_tool_call") {
        sink.upsertTool(id, { name: String(item.tool || item.name || "mcp"), detail: String(item.server || ""), status: codexItemStatus(item, done) });
      } else if (itype === "error") {
        // Codex's non-fatal warnings arrive as `error` items.
        sink.appendWarning(String(item.message || "error"));
      }
      return;
    }
    if (type === "turn.completed") {
      // The turn finished: any earlier top-level `error` was recovered from.
      state.turnCompleted = true;
      return;
    }
    if (type === "turn.failed") {
      const err = (ev.error as Record<string, unknown>) || {};
      sink.fail(String(err.message || "turn failed"));
      return;
    }
    if (type === "error") {
      // Codex emits top-level `error` for retry-layer notices ("Reconnecting...
      // 1/5", "Falling back from WebSockets to HTTPS transport.", "stream
      // connection failed; waiting to retry") as well as for errors it does not
      // recover from, and the wording is not a stable contract. So an `error` is
      // never terminal on its own: it is shown as a notice, and it becomes the
      // turn's failure reason only if the turn then ends without turn.completed
      // (see `_done` below). A fatal error also arrives as turn.failed or a
      // non-zero exit.
      const msg = String(ev.message || "");
      if (!msg) return;
      sink.appendWarning(msg);
      state.lastError = msg;
      return;
    }
    if (type === "_stderr") {
      const text = String(ev.text || "");
      if (/error|invalid|denied|expired|unauthor/i.test(text)) sink.appendWarning(text.trim());
      return;
    }
    // ignore turn.started / unrecognised
  },
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
    if (parseBoxEvent(ev, sink)) return;
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
    // ignore anything unrecognised
  },
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

/** How a finished turn ended. `unconfirmed`: the box never reported the exit. */
export type SettledOutcome = "complete" | "error" | "unconfirmed";

export function exitFailure(code: number | null): string {
  return code === null
    ? "Agent process was killed before it finished"
    : `Agent process exited unexpectedly (code ${code})`;
}

/**
 * Derive a finished turn's outcome from what the agent and the box reported —
 * never from the transport closing. A reported failure wins; otherwise only a
 * 0 exit in the box's `_done` confirms completion. Shared by the live chat and
 * the welcome turn so the two can never disagree about how a turn ended.
 */
export function settleTurn(observed: { failure?: string; exitCode?: number | null }): { outcome: SettledOutcome; failure?: string } {
  if (observed.failure) return { outcome: "error", failure: observed.failure };
  if (observed.exitCode === undefined) return { outcome: "unconfirmed" };
  if (observed.exitCode === 0) return { outcome: "complete" };
  return { outcome: "error", failure: exitFailure(observed.exitCode) };
}

export interface AssistantTurn {
  text: string;
  warnings: string[];
  outcome: SettledOutcome;
  failure?: string;
}

/**
 * Run an agent's parser over a complete turn's stream events and return what
 * it produced and how it ended — used for non-interactive turns (e.g. the
 * welcome message). Shares the exact parser the live chat uses, so the two
 * never diverge.
 */
export function extractAssistantTurn(events: Record<string, unknown>[], kind: string): AssistantTurn {
  const adapter = getAdapter(kind);
  const state = adapter.createTurnState();
  let text = "";
  const warnings: string[] = [];
  let failure: string | undefined;
  let exitCode: number | null | undefined;
  const sink: ChatSink = {
    setSessionId: () => {},
    appendText: (t) => {
      text += t;
    },
    setText: (t) => {
      text = t;
    },
    upsertTool: () => {},
    appendWarning: (t) => {
      const warning = t.trim();
      if (warning) warnings.push(warning);
    },
    // The first terminal cause reported is the one shown (same as the live chat).
    fail: (reason) => {
      failure = failure || reason;
    },
    exit: (code) => {
      exitCode = code;
    },
  };
  for (const ev of events) adapter.parseEvent(ev, sink, state);
  return { text, warnings, ...settleTurn({ failure, exitCode }) };
}
