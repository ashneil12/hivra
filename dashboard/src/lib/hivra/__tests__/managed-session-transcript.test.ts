import {
  addManagedPrompt,
  applyManagedSessionEvent,
  emptyManagedTranscript,
  pendingManagedApprovals,
  sanitizeManagedSessionEvent,
  type ManagedSessionEvent,
} from "../managed-session-transcript";

let counter = 0;
function event(type: string, data: Record<string, unknown>, runId: string | null = "run_1"): ManagedSessionEvent {
  counter += 1;
  const sanitized = sanitizeManagedSessionEvent({ eventId: `evt_${counter}`, runId, at: null, type, data });
  if (!sanitized) throw new Error(`event ${type} was dropped`);
  return sanitized;
}

function fold(events: ManagedSessionEvent[]) {
  return events.reduce(applyManagedSessionEvent, emptyManagedTranscript());
}

describe("sanitizeManagedSessionEvent", () => {
  it("drops kinds Hivra does not render and never copies raw provider fields", () => {
    expect(sanitizeManagedSessionEvent({ eventId: "e", runId: "r", at: null, type: "run.cost_accrued", data: {} })).toBeNull();
    expect(sanitizeManagedSessionEvent({ eventId: "e", runId: null, at: null, type: "stream.state", data: { state: "live" } })).toBeNull();
    const sanitized = sanitizeManagedSessionEvent({
      eventId: "e", runId: "r", at: null, type: "run.tool_call_started",
      data: { tool_call_id: "t1", name: "bash", arguments: { command: "/bin/bash -lc 'ls /workspace/src'" }, source_raw: "SECRET", env: { TOKEN: "x" } },
    });
    expect(sanitized?.data).toEqual({ toolCallId: "t1", label: "ls src" });
    expect(JSON.stringify(sanitized)).not.toContain("SECRET");
  });

  it("reads the approval id from hitl_id or request_id and summarizes the command", () => {
    const fromHitlId = sanitizeManagedSessionEvent({ eventId: "e", runId: "r", at: null, type: "run.human_input_requested",
      data: { hitl_id: "hitl_1", action: "HITL_ACTION_BASH", details: { command: "rm -rf build" } } });
    expect(fromHitlId?.data).toEqual({ requestId: "hitl_1", action: "HITL_ACTION_BASH", summary: "Run a command: rm -rf build" });
    const legacy = sanitizeManagedSessionEvent({ eventId: "e", runId: "r", at: null, type: "run.human_input_requested",
      data: { request_id: "req_2", payload: { action: "HITL_ACTION_GITHUB_CREATE_PR" } } });
    expect(legacy?.data).toMatchObject({ requestId: "req_2", action: "HITL_ACTION_GITHUB_CREATE_PR" });
  });
});

describe("applyManagedSessionEvent", () => {
  it("streams answer text separately from reasoning and records completion usage", () => {
    const transcript = fold([
      event("run.started", {}),
      event("run.token_delta", { text: "thinking…", is_reasoning: true }),
      event("run.token_delta", { text: "Hello " }),
      event("run.token_delta", { text: "world" }),
      event("run.completed", { total_tokens_in: 10, total_tokens_out: 4, run_cost_micros: 1200 }),
    ]);
    expect(transcript.runs).toHaveLength(1);
    expect(transcript.runs[0]).toMatchObject({ text: "Hello world", reasoning: "thinking…", state: "completed", tokensIn: 10, tokensOut: 4, costMicros: 1200 });
  });

  it("ignores a replayed event it already applied", () => {
    const delta = event("run.token_delta", { text: "once" });
    const transcript = [delta, delta].reduce(applyManagedSessionEvent, emptyManagedTranscript());
    expect(transcript.runs[0].text).toBe("once");
  });

  it("tracks a tool call from start to failure", () => {
    const transcript = fold([
      event("run.tool_call_started", { tool_call_id: "t1", name: "bash", input: { cmd: "npm test" } }),
      event("run.tool_call_completed", { tool_call_id: "t1", ok: false, duration_ms: 812, summary: "1 failing\nmore" }),
    ]);
    expect(transcript.runs[0].tools).toEqual([{ id: "t1", label: "npm test", status: "error", summary: "1 failing more", durationMs: 812 }]);
  });

  it("keeps an approval pending until DigitalOcean reports the decision", () => {
    let transcript = fold([event("run.human_input_requested", { hitl_id: "h1", action: "HITL_ACTION_BASH", details: { argv: ["git", "push"] } })]);
    expect(transcript.runs[0].state).toBe("awaiting_approval");
    expect(pendingManagedApprovals(transcript)).toEqual([expect.objectContaining({ requestId: "h1", runId: "run_1", state: "pending" })]);
    transcript = applyManagedSessionEvent(transcript, event("run.human_input_received", { hitl_id: "h1", outcome: 1 }));
    expect(transcript.runs[0].approvals[0].state).toBe("approved");
    expect(transcript.runs[0].state).toBe("running");
    expect(pendingManagedApprovals(transcript)).toEqual([]);
  });

  it("explains a failed run and records a session pause without a run", () => {
    const transcript = fold([
      event("run.failed", { code: 6 }),
      event("session.updated", { status: "paused", pause_reason: "low_balance" }, null),
    ]);
    expect(transcript.runs[0]).toMatchObject({ state: "failed", error: "The budget was exceeded." });
    expect(transcript).toMatchObject({ sessionStatus: "paused", pauseReason: "low_balance" });
  });

  it("attaches the prompt Hivra recorded to the run DigitalOcean returned", () => {
    const transcript = addManagedPrompt(fold([event("run.token_delta", { text: "Done." }, "run_9")]), "run_9", "Fix the build");
    expect(transcript.runs[0]).toMatchObject({ runId: "run_9", prompt: "Fix the build", text: "Done." });
  });
});
