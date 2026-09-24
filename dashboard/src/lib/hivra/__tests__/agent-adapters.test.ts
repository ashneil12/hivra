import {
  getAdapter,
  extractAssistantText,
  isCodexTracingLine,
  type AgentAdapter,
  type ChatSink,
  type ToolPatch,
  type TurnOutcome,
} from "@/lib/hivra/agent-adapters";

// A recording sink so we can assert exactly what a parser emitted.
function recorder() {
  const calls: string[] = [];
  let text = "";
  const tools = new Map<string | undefined, ToolPatch>();
  const warnings: string[] = [];
  const outcomes: TurnOutcome[] = [];
  let sessionId: string | null = null;
  const sink: ChatSink = {
    setSessionId: (id) => {
      sessionId = id;
      calls.push("session:" + id);
    },
    appendText: (t) => {
      text += t;
      calls.push("append:" + t);
    },
    setText: (t) => {
      text = t;
      calls.push("set:" + t);
    },
    upsertTool: (id, patch) => {
      tools.set(id, { ...(tools.get(id) || {}), ...patch });
      calls.push("tool:" + (id ?? "?") + ":" + (patch.status ?? ""));
    },
    appendWarning: (t) => {
      warnings.push(t);
      calls.push("warn:" + t);
    },
    reportOutcome: (outcome) => {
      outcomes.push(outcome);
      calls.push("outcome:" + outcome);
    },
  };
  return {
    sink,
    calls,
    warnings,
    outcomes,
    get text() {
      return text;
    },
    get sessionId() {
      return sessionId;
    },
    tool: (id: string) => tools.get(id),
  };
}

function run(adapter: AgentAdapter, events: Record<string, unknown>[]) {
  const r = recorder();
  const state = adapter.createTurnState();
  for (const ev of events) adapter.parseEvent(ev, r.sink, state);
  return r;
}

describe("agent-adapters", () => {
  describe("getAdapter", () => {
    it("resolves known kinds and falls back to claude", () => {
      expect(getAdapter("claude").kind).toBe("claude");
      expect(getAdapter("codex").kind).toBe("codex");
      expect(getAdapter("generic").kind).toBe("generic");
      expect(getAdapter("nonsense").kind).toBe("claude");
      expect(getAdapter(null).kind).toBe("claude");
    });
  });

  describe("claude adapter", () => {
    it("streams text deltas, captures session id and tool cards", () => {
      const r = run(getAdapter("claude"), [
        { type: "system", subtype: "init", session_id: "s-123" },
        { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello " } } },
        { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "world" } } },
        { type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls -la" } } } },
        { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "file1\nfile2" }] } },
        { type: "result", session_id: "s-123" },
      ]);
      expect(r.text).toBe("Hello world");
      expect(r.sessionId).toBe("s-123");
      expect(r.tool("t1")).toMatchObject({ name: "Bash", detail: "ls -la", status: "done", result: "file1\nfile2" });
    });

    it("does NOT double text when partials AND a final assistant message arrive", () => {
      const r = run(getAdapter("claude"), [
        { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hi there." } } },
        { type: "assistant", message: { content: [{ type: "text", text: "Hi there." }] } },
      ]);
      expect(r.text).toBe("Hi there.");
    });

    it("falls back to the assistant message text when no partials were streamed", () => {
      const r = run(getAdapter("claude"), [
        { type: "assistant", message: { content: [{ type: "text", text: "No partials here." }] } },
      ]);
      expect(r.text).toBe("No partials here.");
    });

    it("marks a failed tool result as error", () => {
      const r = run(getAdapter("claude"), [
        { type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", id: "t9", name: "Bash", input: { command: "false" } } } },
        { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t9", is_error: true, content: "boom" }] } },
      ]);
      expect(r.tool("t9")).toMatchObject({ status: "error", result: "boom" });
    });

    it("surfaces auth-ish stderr as a warning but ignores benign stderr", () => {
      const r = run(getAdapter("claude"), [
        { type: "_stderr", text: "just a debug line" },
        { type: "_stderr", text: "token invalidated / unauthorized" },
      ]);
      expect(r.warnings).toEqual(["token invalidated / unauthorized"]);
    });

    it("surfaces an is_error result (e.g. invalid --model → API 404) as a warning", () => {
      // Gotcha shape: subtype stays "success" on API failures — is_error is the signal.
      const r = run(getAdapter("claude"), [
        { type: "result", subtype: "success", is_error: true, api_error_status: 404, session_id: "sid-1", result: "There's an issue with the selected model (bogus). It may not exist or you may not have access to it." },
      ]);
      expect(r.sessionId).toBe("sid-1");
      expect(r.warnings).toEqual(["There's an issue with the selected model (bogus). It may not exist or you may not have access to it."]);
    });

    it("stays silent on a successful result", () => {
      const r = run(getAdapter("claude"), [
        { type: "result", subtype: "success", is_error: false, session_id: "sid-2", result: "done" },
      ]);
      expect(r.warnings).toEqual([]);
    });

    it("reports how the turn ended from its result, never from a warning", () => {
      const ok = run(getAdapter("claude"), [
        { type: "_stderr", text: "MCP server docs: connection error" },
        { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Done." } } },
        { type: "result", subtype: "success", is_error: false, session_id: "sid-3" },
      ]);
      expect(ok.warnings).toEqual(["MCP server docs: connection error"]);
      expect(ok.outcomes).toEqual(["complete"]);
      const failed = run(getAdapter("claude"), [{ type: "result", subtype: "success", is_error: true, result: "Credit balance is too low" }]);
      expect(failed.outcomes).toEqual(["error"]);
      expect(run(getAdapter("claude"), [{ type: "_stderr", text: "fatal error" }]).outcomes).toEqual([]);
    });
  });

  describe("codex adapter", () => {
    it("accumulates agent messages in order and trims each segment", () => {
      const r = run(getAdapter("codex"), [
        { type: "thread.started", thread_id: "th-1" },
        { type: "item.completed", item: { id: "a", item_type: "agent_message", text: "Part one." } },
        { type: "item.completed", item: { id: "b", item_type: "agent_message", text: "  Part two.  " } },
      ]);
      expect(r.sessionId).toBe("th-1");
      expect(r.text).toBe("Part one.\n\nPart two.");
    });

    it("renders command_execution as a Bash tool card with exit status", () => {
      const r = run(getAdapter("codex"), [
        { type: "item.started", item: { id: "c1", item_type: "command_execution", command: "pytest" } },
        { type: "item.completed", item: { id: "c1", item_type: "command_execution", command: "pytest", aggregated_output: "1 passed", exit_code: 0 } },
      ]);
      expect(r.tool("c1")).toMatchObject({ name: "Bash", detail: "pytest", status: "done", result: "1 passed" });
    });

    it("flags a nonzero exit code as an error", () => {
      const r = run(getAdapter("codex"), [
        { type: "item.completed", item: { id: "c2", item_type: "command_execution", command: "pytest", exit_code: 1 } },
      ]);
      expect(r.tool("c2")).toMatchObject({ status: "error" });
    });

    it("surfaces turn.failed as a warning", () => {
      const r = run(getAdapter("codex"), [{ type: "turn.failed", error: { message: "rate limited" } }]);
      expect(r.warnings).toEqual(["rate limited"]);
    });

    // Captured from tracing-subscriber's fmt layer configured the way `codex
    // exec` configures its stderr (codex-rs/exec/src/lib.rs), emitting the
    // session-init skill error from codex-rs/core/src/session/session.rs.
    const SKILL_ERROR = "2026-09-24T17:59:18.578959Z ERROR codex_core::session::session: failed to load skill /home/user/.agents/skills/notes/SKILL.md: missing YAML frontmatter delimited by ---";
    const MCP_ERROR = "2026-09-24T17:59:18.579123Z ERROR codex_core::mcp_connection_manager: MCP client for `docs` failed to start: program not found";
    const SKILL_ERROR_ANSI = "\u001b[2m2026-09-24T17:59:18.612687Z\u001b[0m \u001b[31mERROR\u001b[0m \u001b[2mcodex_core::session::session\u001b[0m\u001b[2m:\u001b[0m failed to load skill /home/user/.agents/skills/notes/SKILL.md: missing YAML frontmatter delimited by ---";
    const SPANNED_ERROR = "2026-09-24T17:59:26.449919Z ERROR codex.exec{otel.kind=\"internal\"}:turn{otel.name=\"session_task.turn\" thread.id=\"00000000-0000-4000-8000-000000000001\"}: codex_core::mcp_connection_manager: MCP client for `docs` failed to start: program not found";

    it("recognises Codex's tracing lines by their format, not their wording", () => {
      for (const line of [
        SKILL_ERROR,
        MCP_ERROR,
        SKILL_ERROR_ANSI,
        SPANNED_ERROR,
        "2026-09-24T17:59:18.578959Z  WARN codex_core::config: unauthorized field ignored",
        "2026-09-24T17:59:18.578959+00:00 INFO codex_exec: starting",
        "ERROR codex_core::skills::loader: failed to load skill notes: missing YAML frontmatter",
        "ERROR codex.exec{otel.kind=\"internal\"}: codex_core::session: invalid state",
      ]) expect([line, isCodexTracingLine(line)]).toEqual([line, true]);
      for (const line of [
        "Error loading config.toml: invalid type: string, expected a boolean",
        "ERROR: unexpected status 401 Unauthorized",
        "error: unexpected argument '--bogus' found",
        "Not inside a trusted directory and --skip-git-repo-check was not specified.",
        "spawn error: spawn /usr/bin/codex ENOENT",
        "ERROR something went wrong",
      ]) expect([line, isCodexTracingLine(line)]).toEqual([line, false]);
    });

    it("keeps Codex's tracing diagnostics out of the chat and shows its plain errors", () => {
      const r = run(getAdapter("codex"), [
        { type: "_stderr", text: SKILL_ERROR + "\n" + MCP_ERROR + "\n" },
        { type: "_stderr", text: SKILL_ERROR_ANSI + "\n" + SPANNED_ERROR + "\n" },
        // A multi-line tracing message keeps its continuation lines with it.
        { type: "_stderr", text: "2026-09-24T17:59:18.579200Z ERROR codex_core::exec: command failed:\n    permission denied (os error 13)\n\n" },
        { type: "_stderr", text: "Error loading config.toml: invalid type: string, expected a boolean\n" },
        { type: "item.completed", item: { id: "a", type: "agent_message", text: "Here is the summary." } },
        { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
        { type: "_done", code: 0 },
      ]);
      expect(r.warnings).toEqual(["Error loading config.toml: invalid type: string, expected a boolean"]);
      expect(r.text).toBe("Here is the summary.");
      expect(r.outcomes).toEqual(["complete"]);
    });

    it("judges whole stderr lines when the pipe splits them", () => {
      const cut = SKILL_ERROR.indexOf("missing");
      const r = run(getAdapter("codex"), [
        { type: "_stderr", text: SKILL_ERROR.slice(0, cut) },
        { type: "_stderr", text: SKILL_ERROR.slice(cut) + "\nError: unexpected status 401 Unauth" },
        { type: "_stderr", text: "orized: token expired\n" },
        // A last line with no newline still shows once the run ends.
        { type: "_stderr", text: "spawn error: spawn /usr/bin/codex ENOENT" },
        { type: "_done", code: null },
      ]);
      expect(r.warnings).toEqual([
        "Error: unexpected status 401 Unauthorized: token expired",
        "spawn error: spawn /usr/bin/codex ENOENT",
      ]);
    });

    it("shows a usage limit once when Codex reports it as an error and again as the failed turn", () => {
      const limit = "You've hit your usage limit. Upgrade to Plus to continue using Codex, or try again in 2 hours.";
      const r = run(getAdapter("codex"), [
        { type: "thread.started", thread_id: "th-2" },
        { type: "turn.started" },
        { type: "error", message: limit },
        { type: "turn.failed", error: { message: limit } },
        { type: "_done", code: 1 },
      ]);
      expect(r.warnings).toEqual([limit]);
      expect(r.outcomes).toEqual(["error"]);
    });

    it("still shows a failed turn's own reason when it differs from an earlier error", () => {
      const r = run(getAdapter("codex"), [
        { type: "error", message: "Reconnecting... 1/5" },
        { type: "turn.failed", error: { message: "stream disconnected before completion" } },
      ]);
      expect(r.warnings).toEqual(["Reconnecting... 1/5", "stream disconnected before completion"]);
      expect(run(getAdapter("codex"), [{ type: "error", message: "boom" }, { type: "turn.failed", error: {} }]).warnings).toEqual(["boom"]);
    });

    it("reports a completed turn even after a warning", () => {
      const r = run(getAdapter("codex"), [
        { type: "item.completed", item: { id: "w", type: "error", message: "Model metadata for `gpt-test` not found." } },
        { type: "item.completed", item: { id: "a", type: "agent_message", text: "Done." } },
        { type: "turn.completed", usage: {} },
      ]);
      expect(r.warnings).toEqual(["Model metadata for `gpt-test` not found."]);
      expect(r.outcomes).toEqual(["complete"]);
    });
  });

  describe("generic adapter", () => {
    it("streams plain _text and ignores _done", () => {
      const r = run(getAdapter("generic"), [
        { type: "_text", text: "thinking" },
        { type: "_text", text: "... done." },
        { type: "_done", code: 0 },
      ]);
      expect(r.text).toBe("thinking... done.");
    });

    it("surfaces error-ish stderr only", () => {
      const r = run(getAdapter("generic"), [
        { type: "_stderr", text: "loading model" },
        { type: "_stderr", text: "Traceback (most recent call last)" },
      ]);
      expect(r.warnings).toEqual(["Traceback (most recent call last)"]);
    });
  });

  describe("extractAssistantText (welcome path shares the live parser)", () => {
    it("claude: single copy from deltas", () => {
      const text = extractAssistantText(
        [
          { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Welcome " } } },
          { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "aboard." } } },
          { type: "assistant", message: { content: [{ type: "text", text: "Welcome aboard." }] } },
        ],
        "claude",
      );
      expect(text).toBe("Welcome aboard.");
    });

    it("codex: joined segments", () => {
      const text = extractAssistantText(
        [
          { type: "item.completed", item: { id: "a", item_type: "agent_message", text: "Forge here." } },
          { type: "item.completed", item: { id: "b", item_type: "agent_message", text: " What first?" } },
        ],
        "codex",
      );
      expect(text).toBe("Forge here.\n\nWhat first?");
    });

    it("generic: plain text", () => {
      const text = extractAssistantText([{ type: "_text", text: "hi there" }], "generic");
      expect(text).toBe("hi there");
    });
  });
});
