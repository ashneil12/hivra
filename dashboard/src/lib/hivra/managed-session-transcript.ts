// DigitalOcean harness session events → Hivra chat transcript.
//
// Pure data (no server-only imports) so the same reducer runs on the server,
// which whitelists and bounds each provider event before it leaves Hivra, and
// in the browser, which folds the sanitized events into what the chat shows.
// Nothing here invents state: a run is only "complete" after run.completed, an
// approval only resolved after DigitalOcean reports the decision.

export const MANAGED_SESSION_EVENT_TYPES = [
  "run.started",
  "run.token_delta",
  "run.tool_call_started",
  "run.tool_call_completed",
  "run.human_input_requested",
  "run.human_input_received",
  "run.completed",
  "run.failed",
  "run.paused",
  "run.resumed",
  "run.log",
  "session.updated",
] as const;

export type ManagedSessionEventType = (typeof MANAGED_SESSION_EVENT_TYPES)[number];

const EVENT_TYPE_SET = new Set<string>(MANAGED_SESSION_EVENT_TYPES);

/** A provider event after Hivra's whitelist: bounded, secret-free fields only. */
export interface ManagedSessionEvent {
  id: string;
  runId: string | null;
  type: ManagedSessionEventType;
  at: string | null;
  data: Record<string, string | number | boolean | null>;
}

export type ManagedToolStatus = "running" | "done" | "error";
export type ManagedApprovalState = "pending" | "approved" | "rejected" | "deferred";

export interface ManagedTranscriptTool {
  id: string;
  label: string;
  status: ManagedToolStatus;
  summary: string | null;
  durationMs: number | null;
}

export interface ManagedTranscriptApproval {
  requestId: string;
  action: string;
  summary: string;
  state: ManagedApprovalState;
}

export type ManagedRunState = "running" | "awaiting_approval" | "paused" | "completed" | "failed";

export interface ManagedTranscriptRun {
  runId: string;
  prompt: string | null;
  text: string;
  reasoning: string;
  tools: ManagedTranscriptTool[];
  approvals: ManagedTranscriptApproval[];
  logs: string[];
  state: ManagedRunState;
  error: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  costMicros: number | null;
}

export interface ManagedTranscript {
  runs: ManagedTranscriptRun[];
  /** Latest session.updated status as DigitalOcean spelled it, if any. */
  sessionStatus: string | null;
  pauseReason: string | null;
  lastEventId: string | null;
  seenEventIds: string[];
}

const MAX_TEXT = 16 * 1024;
const MAX_SUMMARY = 500;
const MAX_LABEL = 200;
const MAX_SEEN = 2_000;
const MAX_RUN_TEXT = 256 * 1024;

export function emptyManagedTranscript(): ManagedTranscript {
  return { runs: [], sessionStatus: null, pauseReason: null, lastEventId: null, seenEventIds: [] };
}

function bounded(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\u0000/g, "");
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function oneLine(value: string | null, max: number): string | null {
  if (!value) return null;
  const line = value.replace(/\s+/g, " ").trim();
  if (!line) return null;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }
  return null;
}

const SHELL_WRAPPER = /^(?:\/usr\/bin\/|\/bin\/)?(?:bash|zsh|ksh|dash|sh)\s+-[a-z]*c\s+/;

function prettyCommand(command: string): string {
  let cmd = command.trim();
  const wrapper = cmd.match(SHELL_WRAPPER)?.[0];
  if (wrapper) {
    const inner = cmd.slice(wrapper.length).trim();
    if (inner) cmd = inner.replace(/^(['"])([\s\S]*)\1$/, "$2");
  }
  return cmd.replaceAll("/workspace/", "");
}

/** Search a tool's arguments for the one-liner a person wants to read. */
function describeToolInput(source: Record<string, unknown> | null, depth = 0): string | null {
  if (!source || depth > 3) return null;
  for (const key of ["command", "cmd"]) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return prettyCommand(value);
    if (Array.isArray(value) && value.every((part) => typeof part === "string")) return prettyCommand(value.join(" "));
  }
  if (Array.isArray(source.argv) && source.argv.every((part) => typeof part === "string")) {
    return prettyCommand((source.argv as string[]).join(" "));
  }
  for (const key of ["file_path", "path", "filePath", "pattern", "query", "url"]) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.replaceAll("/workspace/", "");
  }
  for (const value of Object.values(source)) {
    const nested = describeToolInput(asRecord(value), depth + 1);
    if (nested) return nested;
  }
  return null;
}

function hitlSummary(data: Record<string, unknown>): { action: string; summary: string } {
  const details = asRecord(data.details) ?? {};
  const legacy = asRecord(data.payload) ?? {};
  const merged = { ...legacy, ...details };
  const action = bounded(data.action, 80) ?? bounded(legacy.action, 80) ?? "HITL_ACTION_UNSPECIFIED";
  const command = describeToolInput(merged);
  const label = ACTION_LABELS[action] ?? "Approve this action";
  return { action, summary: oneLine(command ? `${label}: ${command}` : label, MAX_SUMMARY) ?? label };
}

const ACTION_LABELS: Record<string, string> = {
  HITL_ACTION_BASH: "Run a command",
  HITL_ACTION_FILE_WRITE_OUTSIDE_WORKSPACE: "Write outside the workspace",
  HITL_ACTION_GITHUB_COMMIT_PUSH: "Push commits to GitHub",
  HITL_ACTION_GITHUB_CREATE_PR: "Open a GitHub pull request",
  HITL_ACTION_GITHUB_BRANCH_DELETE: "Delete a GitHub branch",
  HITL_ACTION_GITHUB_FORCE_PUSH: "Force-push to GitHub",
};

const HITL_OUTCOMES: Record<string, ManagedApprovalState> = {
  "1": "approved",
  "2": "rejected",
  "3": "deferred",
  HITL_OUTCOME_APPROVE: "approved",
  HITL_OUTCOME_REJECT: "rejected",
  HITL_OUTCOME_DEFER: "deferred",
};

/**
 * Server-side whitelist. Returns null for event kinds Hivra does not render
 * (sandbox allocation, cost accrual, stream control frames) and never copies
 * raw provider payloads, native source frames, or unknown fields.
 */
export function sanitizeManagedSessionEvent(event: {
  eventId: string;
  runId: string | null;
  at: string | null;
  type: string;
  data: Record<string, unknown>;
}): ManagedSessionEvent | null {
  if (!EVENT_TYPE_SET.has(event.type)) return null;
  const type = event.type as ManagedSessionEventType;
  const d = event.data;
  const base = { id: event.eventId, runId: event.runId, type, at: event.at };
  switch (type) {
    case "run.started":
    case "run.resumed":
      return { ...base, data: {} };
    case "run.token_delta": {
      const text = bounded(d.text, MAX_TEXT);
      if (!text) return null;
      return { ...base, data: { text, isReasoning: d.is_reasoning === true } };
    }
    case "run.tool_call_started": {
      const name = bounded(d.name, 80);
      const label = describeToolInput(asRecord(d.arguments)) ?? describeToolInput(asRecord(d.input));
      return {
        ...base,
        data: {
          toolCallId: bounded(d.tool_call_id, 200),
          label: oneLine(label ? label : name, MAX_LABEL) ?? "tool call",
        },
      };
    }
    case "run.tool_call_completed":
      return {
        ...base,
        data: {
          toolCallId: bounded(d.tool_call_id, 200),
          ok: d.ok === true,
          durationMs: finiteNumber(d.duration_ms),
          summary: oneLine(bounded(d.summary, MAX_SUMMARY * 2), MAX_SUMMARY),
        },
      };
    case "run.human_input_requested": {
      const requestId = bounded(d.hitl_id, 200) ?? bounded(d.request_id, 200);
      if (!requestId || !/^[A-Za-z0-9_.:-]{1,200}$/.test(requestId)) return null;
      const { action, summary } = hitlSummary(d);
      return { ...base, data: { requestId, action, summary } };
    }
    case "run.human_input_received": {
      const requestId = bounded(d.hitl_id, 200) ?? bounded(d.request_id, 200);
      const outcome = HITL_OUTCOMES[String(d.outcome)] ?? null;
      if (!requestId) return null;
      return { ...base, data: { requestId, outcome } };
    }
    case "run.completed":
      return {
        ...base,
        data: {
          tokensIn: finiteNumber(d.total_tokens_in),
          tokensOut: finiteNumber(d.total_tokens_out),
          costMicros: finiteNumber(d.run_cost_micros),
        },
      };
    case "run.failed":
      return {
        ...base,
        data: { code: finiteNumber(d.code), message: oneLine(bounded(d.message, MAX_SUMMARY * 2), MAX_SUMMARY) },
      };
    case "run.paused":
      return { ...base, data: { reason: bounded(d.reason, 80) } };
    case "run.log": {
      const message = oneLine(bounded(d.message, MAX_SUMMARY * 2) ?? bounded(d.text, MAX_SUMMARY * 2), MAX_SUMMARY);
      return message ? { ...base, data: { message } } : null;
    }
    case "session.updated":
      return {
        ...base,
        data: { status: bounded(d.status, 64), pauseReason: bounded(d.pause_reason, 80) },
      };
  }
}

function newRun(runId: string, prompt: string | null = null): ManagedTranscriptRun {
  return {
    runId, prompt, text: "", reasoning: "", tools: [], approvals: [], logs: [],
    state: "running", error: null, tokensIn: null, tokensOut: null, costMicros: null,
  };
}

function withRun(
  transcript: ManagedTranscript,
  runId: string,
  update: (run: ManagedTranscriptRun) => ManagedTranscriptRun,
): ManagedTranscript {
  const index = transcript.runs.findIndex((run) => run.runId === runId);
  const runs = transcript.runs.slice();
  if (index < 0) runs.push(update(newRun(runId)));
  else runs[index] = update(runs[index]);
  return { ...transcript, runs };
}

/** Record the prompt Hivra forwarded for a run (history rows or a live send). */
export function addManagedPrompt(transcript: ManagedTranscript, runId: string, prompt: string): ManagedTranscript {
  return withRun(transcript, runId, (run) => ({ ...run, prompt }));
}

const FAILURE_CODES: Record<string, string> = {
  "1": "The model returned an error.",
  "2": "The model timed out.",
  "3": "A tool failed.",
  "4": "The sandbox was lost.",
  "5": "An approval was rejected.",
  "6": "The budget was exceeded.",
  "7": "DigitalOcean reported an internal error.",
};

export function applyManagedSessionEvent(transcript: ManagedTranscript, event: ManagedSessionEvent): ManagedTranscript {
  if (transcript.seenEventIds.includes(event.id)) return transcript;
  const seenEventIds = [...transcript.seenEventIds, event.id].slice(-MAX_SEEN);
  let next: ManagedTranscript = { ...transcript, lastEventId: event.id, seenEventIds };
  const d = event.data;

  if (event.type === "session.updated") {
    return { ...next, sessionStatus: (d.status as string | null) ?? next.sessionStatus, pauseReason: (d.pauseReason as string | null) ?? null };
  }
  if (!event.runId) return next;
  const runId = event.runId;

  switch (event.type) {
    case "run.started":
    case "run.resumed":
      next = withRun(next, runId, (run) => ({ ...run, state: run.approvals.some((a) => a.state === "pending") ? "awaiting_approval" : "running" }));
      break;
    case "run.token_delta":
      next = withRun(next, runId, (run) => d.isReasoning
        ? { ...run, reasoning: (run.reasoning + String(d.text)).slice(-MAX_RUN_TEXT) }
        : { ...run, text: (run.text + String(d.text)).slice(0, MAX_RUN_TEXT) });
      break;
    case "run.tool_call_started": {
      const id = (d.toolCallId as string | null) ?? `${event.id}`;
      next = withRun(next, runId, (run) => {
        if (run.tools.some((tool) => tool.id === id)) return run;
        return { ...run, tools: [...run.tools, { id, label: String(d.label), status: "running", summary: null, durationMs: null }] };
      });
      break;
    }
    case "run.tool_call_completed": {
      const id = d.toolCallId as string | null;
      next = withRun(next, runId, (run) => {
        const index = id ? run.tools.findIndex((tool) => tool.id === id) : -1;
        const done: ManagedTranscriptTool = {
          id: id ?? event.id,
          label: index >= 0 ? run.tools[index].label : "tool call",
          status: d.ok ? "done" : "error",
          summary: (d.summary as string | null) ?? null,
          durationMs: (d.durationMs as number | null) ?? null,
        };
        const tools = run.tools.slice();
        if (index >= 0) tools[index] = done;
        else tools.push(done);
        return { ...run, tools };
      });
      break;
    }
    case "run.human_input_requested": {
      const requestId = String(d.requestId);
      next = withRun(next, runId, (run) => ({
        ...run,
        state: "awaiting_approval",
        approvals: run.approvals.some((a) => a.requestId === requestId)
          ? run.approvals
          : [...run.approvals, { requestId, action: String(d.action), summary: String(d.summary), state: "pending" }],
      }));
      break;
    }
    case "run.human_input_received": {
      const requestId = String(d.requestId);
      const outcome = (d.outcome as ManagedApprovalState | null) ?? null;
      next = withRun(next, runId, (run) => {
        const approvals = run.approvals.map((approval) => approval.requestId === requestId && outcome
          ? { ...approval, state: outcome }
          : approval);
        const stillWaiting = approvals.some((approval) => approval.state === "pending");
        return { ...run, approvals, state: run.state === "awaiting_approval" && !stillWaiting ? "running" : run.state };
      });
      break;
    }
    case "run.completed":
      next = withRun(next, runId, (run) => ({
        ...run,
        state: "completed",
        tokensIn: (d.tokensIn as number | null) ?? null,
        tokensOut: (d.tokensOut as number | null) ?? null,
        costMicros: (d.costMicros as number | null) ?? null,
      }));
      break;
    case "run.failed":
      next = withRun(next, runId, (run) => ({
        ...run,
        state: "failed",
        error: (d.message as string | null) ?? FAILURE_CODES[String(d.code)] ?? "The run failed.",
      }));
      break;
    case "run.paused":
      next = withRun(next, runId, (run) => ({ ...run, state: "paused" }));
      break;
    case "run.log":
      next = withRun(next, runId, (run) => ({ ...run, logs: [...run.logs, String(d.message)].slice(-20) }));
      break;
  }
  return next;
}

export function pendingManagedApprovals(transcript: ManagedTranscript): Array<ManagedTranscriptApproval & { runId: string }> {
  return transcript.runs.flatMap((run) => run.approvals
    .filter((approval) => approval.state === "pending")
    .map((approval) => ({ ...approval, runId: run.runId })));
}
