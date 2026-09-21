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
  /** Surface a warning inline (rendered as "⚠ …" under the message). */
  appendWarning(text: string): void;
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
  createTurnState: () => ({ segments: new Map<string, string>() }),
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
        sink.appendWarning(String(item.message || "error"));
      }
      return;
    }
    if (type === "turn.failed") {
      const err = (ev.error as Record<string, unknown>) || {};
      sink.appendWarning(String(err.message || "turn failed"));
      return;
    }
    if (type === "error") {
      const msg = String(ev.message || "");
      if (msg) sink.appendWarning(msg);
      return;
    }
    if (type === "_stderr") {
      const text = String(ev.text || "");
      if (/error|invalid|denied|expired|unauthor/i.test(text)) sink.appendWarning(text.trim());
      return;
    }
    // ignore turn.started / _done / unrecognised
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
 * text it produced — used for non-interactive turns (e.g. the welcome message).
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
  };
  for (const ev of events) adapter.parseEvent(ev, sink, state);
  return text;
}
