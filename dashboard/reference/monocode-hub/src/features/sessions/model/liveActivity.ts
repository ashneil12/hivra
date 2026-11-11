// What an agent is doing right now, in plain words, for the live step line under a working reply (Ash, 28 Oct: "instead
// of just saying 'writing,' I have no idea if it's actually working or not"). Built only from the turn's own streamed
// blocks: no detail means "Thinking", never a guessed step. The timer and the stall clock are what this window saw
// (blocks carry no times of their own), kept per turn so a remount doesn't reset them.
import { isReadTool } from "../../../integrations/harness/core/preview";
import { displayPath } from "../../../shared/lib/paths";
import { delegateToolName } from "./monocodeToolCall";
import type { Block } from "./session";
import { plainCommandRow } from "../../../shared/lib/plainCommand";
import { isProseBlock, isThinkingBlock, isToolBlock, isToolSearchStep, needsApproval, toolCategory } from "./transcriptActivity";

/** `lastStep`: on a "Thinking" step, the last tool step of the turn, for "Still working on …" (r66). */
export type LiveStep = { key: string; label: string; lastStep?: string };
/**
 * How a step names its file: rooms and Mono 1:1s say just the file name ("Reading app.tsx"); coding chats give the path
 * and the command (Critiquito, 29 Oct).
 */
export type StepDetail = "name" | "full";
/** What a turn's worker is doing now, from the worker's own stream (r62): the parent turn and the room show it. */
export type WorkerProgress = { label: string; lastEventAt: number };
/** A step, when this window first saw it, and when it last saw anything new in the turn's stream. */
export type LiveActivity = LiveStep & { since: number; lastEventAt: number; stepSince?: number };

/** No new event for this long and the line says so, in grey, instead of a step that may be over. */
export const STALL_MS = 60_000;
/**
 * r66 (Alfred, 0.16.5: "Thinking" for 5+ minutes): thinking this long with no tool, while the stream's heartbeat still
 * comes, the line says what it is still on ("Still working on running npm test"), not a bare "Thinking".
 * r67 (Alfred's r66 rechecks): at 60 s it never showed; real thinking stretches between steps run 20-30 s (frank's
 * longest was ~25 s), so it shows from 20 s.
 */
export const STILL_MS = 20_000;
/**
 * r67 (realconv S8 on 0.16.8: 12 minutes, never a "Still working"): a model that streams no thinking (grok through the
 * bridge) sends nothing between a tool's end and its next step, so the stream was silent at 60 s and STALL_MS won over
 * STILL_MS every time; the line went "Thinking" to "No activity for 1 min" and "Still working on ..." could not show.
 * Thinking after a step is quiet by nature: it reads "Still working on <last step>" for up to this long with nothing new
 * before it says nothing is happening. A running tool still reads stalled after STALL_MS.
 */
export const THINK_STALL_MS = 5 * 60_000;

const DONE = new Set(["completed", "failed", "error", "cancelled", "canceled", "interrupted", "stopped"]);
const CHECK = /\b(?:test|tests|vitest|jest|playwright|tsc|typecheck|lint|eslint|clippy|check|cargo\s+(?:test|check|fmt))\b/i;
const MAX_PATH = 56;
const MAX_COMMAND = 48;

function shortPath(path: string): string {
  return path.length > MAX_PATH ? `…${path.slice(path.length - MAX_PATH + 1)}` : path;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** "npm test", "cargo test --lib": a command's first words with no paths in them, for a room or a Mono's 1:1 (r65). */
function shortCommand(command: string): string | undefined {
  // The program and its verb: up to three words, stopping at the first flag, path or pipe.
  const words: string[] = [];
  for (const w of command.split(" ").filter(Boolean)) {
    if (w.startsWith("-") || /[\\/~<>|&;]/.test(w) || words.length === 3) break;
    words.push(w);
  }
  const out = words.join(" ");
  return out.length > MAX_COMMAND ? `${out.slice(0, MAX_COMMAND - 1)}…` : out || undefined;
}

/** "mcp__linear__list_issues" → "Linear: list issues"; "TodoWrite" → "todo write". Undefined when it names nothing. */
export function toolName(raw: string | undefined): string | undefined {
  const t = (raw ?? "").trim().split(/\s+/)[0] ?? "";
  if (!t || /[\\/]/.test(t)) return undefined;
  const words = (s: string) => s.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase();
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(t);
  if (mcp) {
    const server = words(mcp[1]!);
    return `${server.charAt(0).toUpperCase()}${server.slice(1)}: ${words(mcp[2]!)}`;
  }
  return words(t) || undefined;
}

/** "d_1014e3d62a", "a_10292eae8d", a uuid or a long hash: an id the app made, not words Ash would recognise. */
const RAW_ID = /^(?:[a-z]{1,4}[_-])?(?=[0-9a-f-]*\d)[0-9a-f-]*[0-9a-f]{8,}[0-9a-f-]*$/i;

/**
 * r67 (Alfred's r66 rechecks: "Searching for “d_1014e3d62a|d_1014d69d70|d_101…”"): a search for ids or a regex of them
 * says what it looks for in words; a plain search keeps its words, and an "a|b|c" search names the first and counts the rest.
 */
export function searchStep(query: string): string {
  const parts = query
    .replace(/\\[bwsdBWSD]/g, " ")
    .replace(/[()^$*+?[\]{}\\]/g, " ")
    .split("|")
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (!parts.length) return "Searching the project";
  const ids = parts.filter((p) => p.split(" ").every((w) => RAW_ID.test(w)));
  if (ids.length === parts.length) return parts.length > 1 ? `Searching for ${parts.length} ids` : "Searching for an id";
  const words = parts.filter((p) => !ids.includes(p));
  const first = words[0]!;
  const shown = first.length > 32 ? `${first.slice(0, 31)}…` : first;
  const more = parts.length - 1;
  return more ? `Searching for “${shown}” and ${more} more` : `Searching for “${shown}”`;
}

/** r97 (Critiquito d): the Lead's hand-off step, short and plain. */
export const HANDING_OUT = "Handing out a job";

function toolStep(block: Block, cwd?: string, detail: StepDetail = "full"): string {
  const preview = block.tool?.preview;
  const rawPath = preview?.path ? displayPath(preview.path, cwd) : preview?.fileName;
  const path = rawPath ? (detail === "name" ? fileName(rawPath) : shortPath(rawPath)) : undefined;
  const title = block.text || block.tool?.title || "";
  const delegate = delegateToolName(block);
  if (delegate === "delegate_task") return HANDING_OUT;
  if (delegate === "task_wait" || delegate === "task_status") return "Waiting on a worker";
  const command = block.tool?.command?.replace(/\s+/g, " ").trim();
  switch (toolCategory(block)) {
    case "agent":
      return "Waiting on a worker";
    case "edit":
      return path ? `Editing ${path}` : "Editing a file";
    case "research":
      if (isReadTool(block.tool?.kind, title, preview)) return path ? `Reading ${path}` : "Reading a file";
      // r65 (PM's r63 run): the real search, not a generic word.
      if (/web/i.test(`${block.tool?.kind ?? ""} ${title}`)) return /fetch/i.test(title) ? "Reading a web page" : "Searching the web";
      if (preview?.query) return searchStep(preview.query);
      return "Searching the project";
    case "run":
      // A coding chat names the command it runs; a room or a Mono's 1:1 keeps it plain.
      if (detail === "full" && command)
        return `Running ${command.length > MAX_COMMAND ? `${command.slice(0, MAX_COMMAND - 1)}…` : command}`;
      // r65: a room or 1:1 still says what runs ("Running npm test"), without paths or arguments past the third word.
      if (command && shortCommand(command)) return `Running ${shortCommand(command)}`;
      return CHECK.test(title) ? "Running a check" : "Running a command";
    default: {
      if (/web/i.test(`${block.tool?.kind ?? ""} ${title}`)) return /fetch/i.test(title) ? "Reading a web page" : "Searching the web";
      const name = toolName(block.tool?.title ?? title);
      return name ? `Using ${name}` : "Using a tool";
    }
  }
}

/**
 * r97 items 1 and k (Critiquito, c02 BLIND 242d sidebar foot: "Searching for *select:…", "Running npm test"): a step reads
 * in the same plain words the chat rows use (r96 plainCommandRow): "Run the tests", "Look at the changes". The harness
 * looking up its own tools is no step at all ("Getting ready"); callers skip it where they can.
 */
function plainWordsStep(block: Block, step: string): string {
  if (isToolSearchStep(block)) return "Getting ready";
  const command = block.tool?.command?.replace(/\s+/g, " ").trim();
  if (toolCategory(block) !== "run" || !command) return step;
  const plain = plainCommandRow(command);
  if (plain === command) return step;
  return plain.length > MAX_COMMAND + 12 ? `${plain.slice(0, MAX_COMMAND + 11)}…` : plain;
}

/** r92: a tool step in plain words with just the file's name ("Reading format.ts", "Handing out a job"). */
export function plainToolStep(block: Block, cwd?: string): string {
  return plainWordsStep(block, toolStep(block, cwd, "name"));
}

/** The turn's current step, from its latest block that says anything. */
export function liveStep(blocks: readonly Block[], cwd?: string, detail: StepDetail = "full"): LiveStep {
  // r97: the harness looking up its own tools is no step Ash sees.
  const seen = blocks.filter((b) => b.role !== "user" && !b.internal && !b.draft && !(isToolBlock(b) && isToolSearchStep(b)));
  const waiting = seen.find(needsApproval);
  if (waiting) return { key: `approval:${waiting.id}`, label: "Waiting for your OK" };
  const workflow = seen.find((b) => b.workflowRun?.status === "running");
  if (workflow) return { key: `workflow:${workflow.id}`, label: "Waiting on workers" };
  let latest: Block | undefined;
  for (const block of seen) if (isToolBlock(block) || isProseBlock(block) || isThinkingBlock(block)) latest = block;
  if (!latest) return { key: "start", label: "Thinking" };
  let lastTool: Block | undefined;
  for (const block of seen) if (isToolBlock(block)) lastTool = block;
  const lastStep = lastTool ? toolStep(lastTool, cwd, detail) : undefined;
  const thinking = (key: string): LiveStep => (lastStep ? { key, label: "Thinking", lastStep } : { key, label: "Thinking" });
  if (isToolBlock(latest)) {
    const status = latest.tool?.status?.toLowerCase();
    if (latest.tool?.background && !DONE.has(status ?? "")) return { key: `bg:${latest.id}`, label: "Waiting on a background task" };
    // A finished call is not what it is doing now: it is deciding what comes next.
    if (status && DONE.has(status)) return thinking(`after:${latest.id}`);
    return { key: `tool:${latest.id}`, label: toolStep(latest, cwd, detail) };
  }
  if (isProseBlock(latest)) return { key: `prose:${latest.id}`, label: "Writing" };
  return thinking(`think:${latest.id}`);
}

/** Changes whenever the stream brings anything: a block, more words, output, a status. */
function signature(blocks: readonly Block[]): string {
  let chars = 0;
  let detail = 0;
  let marks = "";
  for (const b of blocks) {
    chars += b.text.length;
    detail += b.tool?.detail?.length ?? 0;
    // A tool's last-update time moves with the provider's heartbeat (tool.progress): a quiet build still counts.
    marks += `${b.tool?.status ?? ""}${b.tool?.updatedAt ?? ""}${b.approval?.decided ?? ""}${b.workflowRun?.status ?? ""}${b.agentRun?.steps.length ?? ""},`;
  }
  return `${blocks.length}:${chars}:${detail}:${marks}`;
}

type Tracked = LiveActivity & { sig: string };
const tracked = new Map<string, Tracked>();
const MAX_TRACKED = 200;

/**
 * The activity of turn `id` given its blocks now: the step's start moves when the step changes, the last event when
 * anything in the stream does. `startedAt` (the turn's own start, when known) seeds a turn seen for the first time with nothing back yet; `override` is a
 * step the caller knows better (waiting for answers, or on background tasks).
 */
export function trackActivity(
  id: string,
  blocks: readonly Block[],
  now: number,
  cwd?: string,
  startedAt?: number,
  override?: LiveStep,
  options: { detail?: StepDetail; worker?: WorkerProgress } = {},
): LiveActivity {
  let step = override ?? liveStep(blocks, cwd, options.detail);
  // Waiting on a worker says what the worker is doing, and the worker's activity keeps this turn from reading stalled.
  const worker = options.worker && step.key.startsWith("tool:") && step.label === "Waiting on a worker" ? options.worker : undefined;
  if (worker) step = { key: step.key, label: `Worker: ${worker.label.charAt(0).toLowerCase()}${worker.label.slice(1)}` };
  const sig = signature(blocks);
  const prev = tracked.get(id);
  // Times the stream itself carries (r62): when the step's tool started and the newest tool update, saved on the
  // blocks, so a reload or a remount keeps the real clocks instead of starting them again.
  const stepBlock = step.key.startsWith("tool:") ? blocks.find((b) => `tool:${b.id}` === step.key) : undefined;
  const toolStart = stepBlock?.tool?.startedAt && stepBlock.tool.startedAt <= now ? stepBlock.tool.startedAt : undefined;
  let toolUpdate = 0;
  for (const b of blocks) if (b.tool?.updatedAt && b.tool.updatedAt <= now && b.tool.updatedAt > toolUpdate) toolUpdate = b.tool.updatedAt;
  let next: Tracked;
  if (!prev) {
    // Only a turn with nothing back yet has been "Thinking" since it began; a later step, first seen now, starts now
    // (or when its tool says it started).
    const start = startedAt && startedAt <= now && step.key === "start" ? startedAt : (toolStart ?? now);
    const seen = blocks.some((b) => b.role !== "user");
    // First seen after a reload: the newest saved tool update is the last event we know of, not this moment.
    const last = !seen ? start : toolUpdate && stepBlock ? toolUpdate : now;
    next = { ...step, since: start, lastEventAt: last, sig };
  } else {
    next = {
      ...step,
      since: prev.key === step.key ? prev.since : (toolStart ?? now),
      lastEventAt: prev.sig === sig ? prev.lastEventAt : now,
      sig,
    };
  }
  if (worker && worker.lastEventAt > next.lastEventAt && worker.lastEventAt <= now) next = { ...next, lastEventAt: worker.lastEventAt };
  tracked.delete(id);
  tracked.set(id, next);
  if (tracked.size > MAX_TRACKED) tracked.delete(tracked.keys().next().value as string);
  const { sig: _sig, ...activity } = next;
  return { ...activity, stepSince: activity.since };
}

// ---- Worker progress (r62) ----------------------------------------------------------------------------------------
// The app's delegation watch (useDelegationTree) publishes, for each chat that has a worker running, what that worker is
// doing now, read from the worker's own stream with trackActivity. The parent turn's line and the room read it here.
const workers = new Map<string, WorkerProgress>();

/** What the worker of chat `ownerSession` is doing now; nothing clears it. */
export function noteWorkerProgress(ownerSession: string, progress: WorkerProgress | undefined): void {
  if (progress) workers.set(ownerSession, progress);
  else workers.delete(ownerSession);
}

/** The latest progress of a worker that chat `ownerSession` waits on, if one is running. */
export function workerProgress(ownerSession: string | undefined): WorkerProgress | undefined {
  return ownerSession ? workers.get(ownerSession) : undefined;
}

/** The turn is over: its clocks go. */
export function forgetActivity(id: string): void {
  tracked.delete(id);
}

/** "6s", "1m 02s", "1h 05m". */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

// The chat's plain rows say what to do ("Run the tests", r97 k); after "Still working on" they read as doing it.
const ING: Record<string, string> = { run: "running", look: "looking", search: "searching", check: "checking", install: "installing", list: "listing", read: "reading", remember: "remembering", forget: "forgetting" };
const onStep = (step: string) => {
  const [first = "", ...rest] = step.split(" ");
  const word = ING[first.toLowerCase()] ?? first.charAt(0).toLowerCase() + first.slice(1);
  return [word, ...rest].join(" ").replace(/, then (\w+)/g, (m, w: string) => (ING[w] ? `, then ${ING[w]}` : m));
};

/** What the line reads at `now`: the step and its timer, or, after a minute with nothing new, that nothing is happening. */
export function activityLine(activity: LiveActivity, now: number): { text: string; stalled: boolean } {
  const idle = now - activity.lastEventAt;
  if (idle >= (activity.label === "Thinking" ? THINK_STALL_MS : STALL_MS)) return { text: `No activity for ${Math.floor(idle / 60_000)} min`, stalled: true };
  if (activity.label === "Thinking" && now - (activity.stepSince ?? activity.since) >= STILL_MS) {
    // r97 (Critiquito d): not "Still working on handing work to a worker · 20s": the hand-off says itself.
    if (activity.lastStep === HANDING_OUT) return { text: `${HANDING_OUT} · ${formatElapsed(now - activity.since)}`, stalled: false };
    const on = activity.lastStep ? ` on ${onStep(activity.lastStep)}` : "";
    return { text: `Still working${on} · ${formatElapsed(now - activity.since)}`, stalled: false };
  }
  // r96 (Critiquito): under a second there is no time worth showing ("Thinking · 0s"), so the step stands alone.
  if (now - activity.since < 1000) return { text: activity.label, stalled: false };
  return { text: `${activity.label} · ${formatElapsed(now - activity.since)}`, stalled: false };
}
