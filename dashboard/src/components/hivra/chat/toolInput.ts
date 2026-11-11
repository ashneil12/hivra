// Adapted from MonoCode (MIT License, Copyright (c) 2026 Nick); see THIRD_PARTY_LICENSES/monocode.txt.
//
// What a tool's own input says, for the rows that show more than a name: a
// task list (TodoWrite), a file's edit (Edit, MultiEdit, Write) and a plan
// (ExitPlanMode). MonoCode reads these from its transcript blocks; Hivra's
// replies carry the tool chip's input JSON, so the same readings are made from
// that. Anything that does not look right is null, and the row stays plain.

export type TaskStatus = "pending" | "in_progress" | "completed" | "cancelled";
export interface TaskItem {
  id?: string;
  text: string;
  status: TaskStatus;
}

export type DiffLineKind = "context" | "add" | "remove";
export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}
export interface DiffPreview {
  path: string;
  /** A written file: its new contents are shown, but what they replaced is not known. */
  contentOnly: boolean;
  lines: DiffLine[];
  added: number;
  removed: number;
  /** More changed lines than are shown. */
  truncated: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function normalizedName(name: string): string {
  return name.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

// ── Task lists ───────────────────────────────────────────────────────────

export function isTaskListTool(name: string): boolean {
  const n = normalizedName(name);
  return ["todowrite", "writetodos", "updatetodos"].some((candidate) => n === candidate || n.endsWith(candidate));
}

export function normalizeTaskStatus(value: unknown): TaskStatus {
  const status = String(value ?? "pending").trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (status === "completed" || status === "complete" || status === "done") return "completed";
  if (status === "inprogress" || status === "active" || status === "running") return "in_progress";
  if (status === "cancelled" || status === "canceled" || status === "skipped") return "cancelled";
  return "pending";
}

/** The `todos` of a TodoWrite call as task rows; null when the tool is another or carries none. */
export function taskListFromToolInput(name: string, input: unknown): TaskItem[] | null {
  if (!isTaskListTool(name)) return null;
  const todos = asRecord(input)?.todos;
  if (!Array.isArray(todos)) return null;
  const items = todos.flatMap((todo): TaskItem[] => {
    const row = asRecord(todo);
    const text = [row?.content, row?.activeForm, row?.text].find((value): value is string => typeof value === "string" && !!value.trim())?.trim();
    if (!text) return [];
    const rawId = row?.id;
    const id = typeof rawId === "string" ? rawId.trim() || undefined : typeof rawId === "number" && Number.isFinite(rawId) ? String(rawId) : undefined;
    return [{ ...(id ? { id } : {}), text, status: normalizeTaskStatus(row?.status) }];
  });
  return items.length ? items : null;
}

/** "2 of 5", or "Complete" once every task that is not cancelled is done. */
export function taskListProgressLabel(items: readonly TaskItem[]): string {
  const completed = items.filter((item) => item.status === "completed").length;
  const actionable = items.filter((item) => item.status !== "cancelled").length;
  if (actionable > 0 && completed === actionable) return "Complete";
  return `${completed} of ${actionable || items.length}`;
}

// ── Edits ────────────────────────────────────────────────────────────────

const CONTEXT_LINES = 2;
const MAX_SHOWN_LINES = 80;

function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** One edit as diff lines: the lines both sides share at the start and the end are context, the rest is removed and added. */
function editLines(oldText: string, newText: string): DiffLine[] {
  const before = splitLines(oldText);
  const after = splitLines(newText);
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;
  let tail = 0;
  while (tail < before.length - head && tail < after.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  const lines: DiffLine[] = [];
  for (const text of before.slice(Math.max(0, head - CONTEXT_LINES), head)) lines.push({ kind: "context", text });
  for (const text of before.slice(head, before.length - tail)) lines.push({ kind: "remove", text });
  for (const text of after.slice(head, after.length - tail)) lines.push({ kind: "add", text });
  for (const text of before.slice(before.length - tail, before.length - tail + CONTEXT_LINES)) lines.push({ kind: "context", text });
  return lines;
}

export function isEditTool(name: string): boolean {
  const n = normalizedName(name);
  return n === "edit" || n === "multiedit" || n === "write";
}

/** The change an Edit, MultiEdit or Write call makes, for the diff preview; null when its input does not say. */
export function diffFromToolInput(name: string, input: unknown): DiffPreview | null {
  const n = normalizedName(name);
  const rec = asRecord(input);
  if (!rec || !isEditTool(name)) return null;
  const path = typeof rec.file_path === "string" ? rec.file_path : typeof rec.path === "string" ? rec.path : "";
  if (!path) return null;
  let lines: DiffLine[] = [];
  let contentOnly = false;
  if (n === "write") {
    if (typeof rec.content !== "string") return null;
    contentOnly = true;
    lines = splitLines(rec.content).map((text) => ({ kind: "add" as const, text }));
  } else if (n === "edit") {
    if (typeof rec.old_string !== "string" || typeof rec.new_string !== "string") return null;
    lines = editLines(rec.old_string, rec.new_string);
  } else {
    const edits = Array.isArray(rec.edits) ? rec.edits : null;
    if (!edits) return null;
    for (const edit of edits) {
      const e = asRecord(edit);
      if (typeof e?.old_string !== "string" || typeof e.new_string !== "string") continue;
      if (lines.length) lines.push({ kind: "context", text: "⋯" });
      lines.push(...editLines(e.old_string, e.new_string));
    }
  }
  if (lines.length === 0) return null;
  const added = lines.filter((line) => line.kind === "add").length;
  const removed = lines.filter((line) => line.kind === "remove").length;
  return { path, contentOnly, lines: lines.slice(0, MAX_SHOWN_LINES), added, removed, truncated: lines.length > MAX_SHOWN_LINES };
}

// ── Plans ────────────────────────────────────────────────────────────────

export function isPlanTool(name: string): boolean {
  return normalizedName(name) === "exitplanmode";
}

/** The Markdown plan an ExitPlanMode call carries; null when it carries none. */
export function planFromToolInput(name: string, input: unknown): string | null {
  if (!isPlanTool(name)) return null;
  const plan = asRecord(input)?.plan;
  return typeof plan === "string" && plan.trim() ? plan : null;
}

function unwrapMarkdown(value: string): string {
  return value.replace(/!\[[^\]]*]\([^)]*\)/g, "").replace(/\[([^\]]+)]\([^)]*\)/g, "$1").replace(/[*_`]+/g, "").trim();
}

/** First Markdown heading, or the first prose line. */
export function planTitle(text: string): string {
  const heading = text.match(/^\s{0,3}#{1,6}\s+(.+)$/m);
  if (heading) return unwrapMarkdown(heading[1]);
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("```") || trimmed === "---") continue;
    return unwrapMarkdown(trimmed).slice(0, 80) || "Plan";
  }
  return "Plan";
}

/** The first prose paragraph that is not the title heading. */
export function planSummary(text: string): string {
  const title = planTitle(text);
  const parts: string[] = [];
  let inFence = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || /^\s{0,3}#{1,6}\s+/.test(line)) continue;
    const trimmed = line.trim();
    if (!trimmed || trimmed === "---") continue;
    const next = unwrapMarkdown(trimmed.replace(/^[-*+]\s+/, ""));
    if (!next || next === title) continue;
    parts.push(next);
    if (parts.join(" ").length >= 140) break;
  }
  const summary = parts.join(" ");
  if (!summary) return "";
  return summary.length > 140 ? `${summary.slice(0, 139)}…` : summary;
}

/** The file's name, for a chip: the last part of a path. */
export function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}
