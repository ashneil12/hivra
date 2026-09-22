import {
  getAdapter,
  extractAssistantText,
  type AgentAdapter,
  type ChatSink,
  type ToolPatch,
} from "@/lib/hivra/agent-adapters";

// A recording sink so we can assert exactly what a parser emitted.
function recorder() {
  const calls: string[] = [];
  let text = "";
  const tools = new Map<string | undefined, ToolPatch>();
  const warnings: string[] = [];
  const failures: string[] = [];
  const exits: (number | null)[] = [];
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
    fail: (reason) => {
      failures.push(reason);
      calls.push("fail:" + reason);
    },
    exit: (code) => {
      exits.push(code);
      calls.push("exit:" + code);
    },
  };
  return {
    sink,
    calls,
    warnings,
    failures,
    exits,
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

    it("reports an is_error result (e.g. invalid --model → API 404) as a terminal failure", () => {
      // Gotcha shape: subtype stays "success" on API failures — is_error is the signal.
      const r = run(getAdapter("claude"), [
        { type: "result", subtype: "success", is_error: true, api_error_status: 404, session_id: "sid-1", result: "There's an issue with the selected model (bogus). It may not exist or you may not have access to it." },
      ]);
      expect(r.sessionId).toBe("sid-1");
      expect(r.failures).toEqual(["There's an issue with the selected model (bogus). It may not exist or you may not have access to it."]);
      expect(r.warnings).toEqual([]);
    });

    it("stays silent on a successful result", () => {
      const r = run(getAdapter("claude"), [
        { type: "result", subtype: "success", is_error: false, session_id: "sid-2", result: "done" },
      ]);
      expect(r.warnings).toEqual([]);
      expect(r.failures).toEqual([]);
    });

    it("keeps error-ish stderr (e.g. an MCP server connection error) non-fatal", () => {
      const r = run(getAdapter("claude"), [
        { type: "_stderr", text: "[MCP] server 'docs' connection error, continuing without it\n" },
        { type: "result", subtype: "success", is_error: false, session_id: "sid-3" },
      ]);
      expect(r.warnings).toEqual(["[MCP] server 'docs' connection error, continuing without it"]);
      expect(r.failures).toEqual([]);
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

    it("reports turn.failed as a terminal failure", () => {
      const r = run(getAdapter("codex"), [{ type: "turn.failed", error: { message: "rate limited" } }]);
      expect(r.failures).toEqual(["rate limited"]);
      expect(r.warnings).toEqual([]);
    });

    it("keeps a retryable stream error non-fatal and a fatal error terminal", () => {
      const r = run(getAdapter("codex"), [
        { type: "error", message: "Reconnecting... 1/5" },
        { type: "error", message: "stream disconnected before completion; retrying 2/5 in 400ms" },
        { type: "item.completed", item: { id: "w", type: "error", message: "MCP server docs failed to start" } },
        { type: "error", message: "unexpected status 401 Unauthorized" },
      ]);
      expect(r.warnings).toEqual([
        "Reconnecting... 1/5",
        "stream disconnected before completion; retrying 2/5 in 400ms",
        "MCP server docs failed to start",
      ]);
      expect(r.failures).toEqual(["unexpected status 401 Unauthorized"]);
    });

    it("keeps ERROR-level stderr tracing non-fatal", () => {
      const r = run(getAdapter("codex"), [
        { type: "_stderr", text: "2026-09-22T10:00:00Z ERROR codex_core::mcp: MCP client for `docs` failed to start" },
      ]);
      expect(r.warnings).toHaveLength(1);
      expect(r.failures).toEqual([]);
    });

    it("maps failed, declined and non-zero-exit completed items to error", () => {
      const r = run(getAdapter("codex"), [
        { type: "item.completed", item: { id: "m1", type: "mcp_tool_call", server: "docs", tool: "search", status: "failed", error: { message: "boom" } } },
        { type: "item.completed", item: { id: "f1", type: "file_change", changes: [{ path: "a.ts", kind: "update" }], status: "failed" } },
        { type: "item.completed", item: { id: "c1", type: "command_execution", command: "rm x", aggregated_output: "", exit_code: null, status: "declined" } },
        { type: "item.completed", item: { id: "c2", type: "command_execution", command: "false", aggregated_output: "", exit_code: 2, status: "failed" } },
        { type: "item.completed", item: { id: "c3", type: "command_execution", command: "ls", aggregated_output: "ok", exit_code: 0, status: "completed" } },
        { type: "item.completed", item: { id: "f2", type: "file_change", changes: [{ path: "b.ts", kind: "add" }], status: "completed" } },
        { type: "item.completed", item: { id: "m2", type: "mcp_tool_call", server: "docs", tool: "read", status: "completed" } },
      ]);
      expect(r.tool("m1")).toMatchObject({ status: "error" });
      expect(r.tool("f1")).toMatchObject({ status: "error" });
      expect(r.tool("c1")).toMatchObject({ status: "error" });
      expect(r.tool("c2")).toMatchObject({ status: "error" });
      expect(r.tool("c3")).toMatchObject({ status: "done" });
      expect(r.tool("f2")).toMatchObject({ status: "done" });
      expect(r.tool("m2")).toMatchObject({ status: "done" });
    });
  });

  describe("generic adapter", () => {
    it("streams plain _text and reports the box's _done exit code", () => {
      const r = run(getAdapter("generic"), [
        { type: "_text", text: "thinking" },
        { type: "_text", text: "... done." },
        { type: "_done", code: 0 },
      ]);
      expect(r.text).toBe("thinking... done.");
      expect(r.exits).toEqual([0]);
    });

    it("surfaces error-ish stderr only", () => {
      const r = run(getAdapter("generic"), [
        { type: "_stderr", text: "loading model" },
        { type: "_stderr", text: "Traceback (most recent call last)" },
      ]);
      expect(r.warnings).toEqual(["Traceback (most recent call last)"]);
    });
  });

  describe("box _done event", () => {
    it.each(["claude", "codex", "generic", "operatoros"])("%s reports the child exit code, including a signal kill (null)", (kind) => {
      expect(run(getAdapter(kind), [{ type: "_done", code: 137 }]).exits).toEqual([137]);
      expect(run(getAdapter(kind), [{ type: "_done", code: null }]).exits).toEqual([null]);
      expect(run(getAdapter(kind), [{ type: "_done", code: 0 }]).exits).toEqual([0]);
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
