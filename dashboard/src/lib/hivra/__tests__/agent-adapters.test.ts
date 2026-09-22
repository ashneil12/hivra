import {
  getAdapter,
  extractAssistantTurn,
  settleTurn,
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

    it("keeps top-level errors non-fatal when the turn then completes (retry notices of any wording)", () => {
      const r = run(getAdapter("codex"), [
        { type: "thread.started", thread_id: "th-r" },
        { type: "turn.started" },
        { type: "error", message: "Reconnecting... 1/5" },
        { type: "error", message: "Falling back from WebSockets to HTTPS transport." },
        { type: "error", message: "stream disconnected before completion: idle timeout waiting for SSE" },
        { type: "item.completed", item: { id: "w", type: "error", message: "MCP server docs failed to start" } },
        { type: "item.completed", item: { id: "a", type: "agent_message", text: "All done." } },
        { type: "turn.completed", usage: {} },
        { type: "_done", code: 0 },
      ]);
      expect(r.warnings).toEqual([
        "Reconnecting... 1/5",
        "Falling back from WebSockets to HTTPS transport.",
        "stream disconnected before completion: idle timeout waiting for SSE",
        "MCP server docs failed to start",
      ]);
      expect(r.failures).toEqual([]);
      expect(r.exits).toEqual([0]);
    });

    it("fails with the last top-level error when the process ends without turn.completed", () => {
      const r = run(getAdapter("codex"), [
        { type: "turn.started" },
        { type: "error", message: "Reconnecting... 5/5" },
        { type: "error", message: "unexpected status 401 Unauthorized" },
        { type: "_done", code: 1 },
      ]);
      expect(r.failures).toEqual(["unexpected status 401 Unauthorized"]);
      expect(r.calls.slice(-2)).toEqual(["fail:unexpected status 401 Unauthorized", "exit:1"]);
      // Even a 0 exit does not confirm a turn that never completed after an error.
      const zero = run(getAdapter("codex"), [{ type: "error", message: "stream error" }, { type: "_done", code: 0 }]);
      expect(zero.failures).toEqual(["stream error"]);
      // No error seen: the exit code alone decides (no invented failure).
      expect(run(getAdapter("codex"), [{ type: "_done", code: 0 }]).failures).toEqual([]);
    });

    it("drops a top-level error the agent recovered from, so a later kill or crash is reported as itself", () => {
      const cmdStart = { type: "item.started", item: { id: "c1", type: "command_execution", command: "npm test", exit_code: null, status: "in_progress" } };
      const cmdDone = { type: "item.completed", item: { id: "c1", type: "command_execution", command: "npm test", exit_code: 0, status: "completed" } };
      const msg = { type: "item.completed", item: { id: "m1", type: "agent_message", text: "Half way there" } };
      const killed = run(getAdapter("codex"), [
        { type: "turn.started" },
        { type: "error", message: "Reconnecting... 1/5" },
        cmdStart, cmdDone, msg,
        { type: "_done", code: null },
      ]);
      expect(killed.failures).toEqual([]);
      expect(killed.exits).toEqual([null]);
      expect(settleTurn({ failure: killed.failures[0], exitCode: null })).toEqual({ outcome: "error", failure: "Agent process was killed before it finished" });
      // The welcome path settles the same way.
      expect(extractAssistantTurn([
        { type: "error", message: "Falling back from WebSockets to HTTPS transport." },
        cmdStart, cmdDone, msg,
        { type: "_done", code: 101 },
      ], "codex")).toMatchObject({ outcome: "error", failure: "Agent process exited unexpectedly (code 101)" });
      // A single progress event is enough: the agent carried on after the notice.
      expect(run(getAdapter("codex"), [{ type: "error", message: "Reconnecting... 2/5" }, cmdStart, { type: "_done", code: 137 }]).failures).toEqual([]);
      // A warning item is not progress.
      expect(run(getAdapter("codex"), [
        { type: "error", message: "unexpected status 401 Unauthorized" },
        { type: "item.completed", item: { id: "w", type: "error", message: "MCP server docs failed to start" } },
        { type: "_done", code: 1 },
      ]).failures).toEqual(["unexpected status 401 Unauthorized"]);
      // An error AFTER the last progress is still the reason.
      expect(run(getAdapter("codex"), [cmdStart, cmdDone, { type: "error", message: "unexpected status 401 Unauthorized" }, { type: "_done", code: 1 }]).failures)
        .toEqual(["unexpected status 401 Unauthorized"]);
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

    // Each failure signal on its own, so no branch is masked by another.
    it.each([
      ["status declined alone", { id: "d", type: "file_change", changes: [{ path: "a.ts" }], status: "declined" }],
      ["an error object alone", { id: "e", type: "mcp_tool_call", server: "docs", tool: "search", status: "completed", error: { message: "boom" } }],
      ["a completed command with a null exit code alone", { id: "n", type: "command_execution", command: "sleep 9", aggregated_output: "", exit_code: null, status: "completed" }],
      ["a non-zero exit code alone", { id: "x", type: "command_execution", command: "false", aggregated_output: "", exit_code: 1, status: "completed" }],
    ])("maps %s to error", (_label, item) => {
      const r = run(getAdapter("codex"), [{ type: "item.completed", item }]);
      expect(r.tool(String(item.id))).toMatchObject({ status: "error" });
    });

    it("keeps an in-progress command with no exit code yet running", () => {
      const r = run(getAdapter("codex"), [{ type: "item.started", item: { id: "p", type: "command_execution", command: "sleep 9", exit_code: null, status: "in_progress" } }]);
      expect(r.tool("p")).toMatchObject({ status: "running" });
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

    it.each(["claude", "codex", "generic"])("%s treats the box's spawn-error line as a terminal failure, not a warning", (kind) => {
      const r = run(getAdapter(kind), [{ type: "_stderr", text: "spawn error: spawn /usr/bin/claude ENOENT" }]);
      expect(r.failures).toEqual(["Agent process could not start (spawn /usr/bin/claude ENOENT)"]);
      expect(r.warnings).toEqual([]);
    });
  });

  describe("extractAssistantTurn (welcome path shares the live parser)", () => {
    const done = { type: "_done", code: 0 };
    it("claude: single copy from deltas", () => {
      const turn = extractAssistantTurn(
        [
          { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Welcome " } } },
          { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "aboard." } } },
          { type: "assistant", message: { content: [{ type: "text", text: "Welcome aboard." }] } },
          done,
        ],
        "claude",
      );
      expect(turn).toEqual({ text: "Welcome aboard.", warnings: [], outcome: "complete" });
    });

    it("codex: joined segments", () => {
      const turn = extractAssistantTurn(
        [
          { type: "item.completed", item: { id: "a", item_type: "agent_message", text: "Forge here." } },
          { type: "item.completed", item: { id: "b", item_type: "agent_message", text: " What first?" } },
          { type: "turn.completed" },
          done,
        ],
        "codex",
      );
      expect(turn.text).toBe("Forge here.\n\nWhat first?");
      expect(turn.outcome).toBe("complete");
    });

    it("generic: plain text", () => {
      expect(extractAssistantTurn([{ type: "_text", text: "hi there" }, done], "generic").text).toBe("hi there");
    });

    it("reports a killed, failed or unconfirmed turn instead of passing its text off as finished", () => {
      const delta = { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Pulling your list now" } } };
      expect(extractAssistantTurn([delta, { type: "_done", code: null }], "claude")).toEqual({
        text: "Pulling your list now", warnings: [], outcome: "error", failure: "Agent process was killed before it finished",
      });
      expect(extractAssistantTurn([
        { type: "assistant", message: { content: [{ type: "text", text: "Invalid API key · Please run /login" }] } },
        { type: "result", is_error: true, result: "Invalid API key · Please run /login" },
        { type: "_done", code: 1 },
      ], "claude")).toMatchObject({ outcome: "error", failure: "Invalid API key · Please run /login" });
      expect(extractAssistantTurn([delta], "claude").outcome).toBe("unconfirmed");
      expect(extractAssistantTurn([{ type: "_stderr", text: "token expired" }, delta, done], "claude").warnings).toEqual(["token expired"]);
    });
  });

  describe("settleTurn", () => {
    it("lets a reported failure win, and confirms completion only on a 0 exit", () => {
      expect(settleTurn({ failure: "boom", exitCode: 0 })).toEqual({ outcome: "error", failure: "boom" });
      expect(settleTurn({})).toEqual({ outcome: "unconfirmed" });
      expect(settleTurn({ exitCode: 0 })).toEqual({ outcome: "complete" });
      expect(settleTurn({ exitCode: 137 })).toEqual({ outcome: "error", failure: "Agent process exited unexpectedly (code 137)" });
      expect(settleTurn({ exitCode: null })).toEqual({ outcome: "error", failure: "Agent process was killed before it finished" });
    });
  });
});
