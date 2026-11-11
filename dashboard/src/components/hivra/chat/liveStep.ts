// Adapted from MonoCode (MIT License, Copyright (c) 2026 Nick); see THIRD_PARTY_LICENSES/monocode.txt.
//
// What the agent is doing right now, in plain words, for the live line above a
// working reply ("Running npm test", "Reading app.tsx", "Searching the web").
// MonoCode builds it from its own transcript blocks; Hivra's replies carry tool
// chips (the CLI's tool name plus one detail string), so the same plain words
// are worked out from those. A step it cannot name is "Using <tool>", never a
// guess.

import type { ToolChip } from "./types";

const MAX_COMMAND = 48;
const CHECK = /\b(?:test|tests|vitest|jest|playwright|pytest|tsc|typecheck|lint|eslint|clippy|check|cargo\s+(?:test|check|fmt))\b/i;

function fileName(path: string): string {
  return path.trim().split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** "npm test", "cargo test --lib": a command's first words with no paths in them. */
function shortCommand(command: string): string | undefined {
  // `cd app && npm test` is "npm test": the step is the last thing it runs.
  const parts = command.split(/&&|;|\|\|/).map((part) => part.trim()).filter(Boolean);
  const run = parts.filter((part) => !/^cd\s/.test(part)).pop() ?? "";
  // The program and its verb: up to three words, stopping at the first flag, path or pipe.
  const words: string[] = [];
  for (const word of run.split(/\s+/).filter(Boolean)) {
    if (word.startsWith("-") || /[\\/~<>|&;$]/.test(word) || words.length === 3) break;
    words.push(word);
  }
  const out = words.join(" ");
  return out.length > MAX_COMMAND ? `${out.slice(0, MAX_COMMAND - 1)}…` : out || undefined;
}

/** "mcp__linear__list_issues" is "Linear: list issues"; "TodoWrite" is "todo write". */
export function toolDisplayName(raw: string | undefined): string | undefined {
  const token = (raw ?? "").trim().split(/\s+/)[0] ?? "";
  if (!token || /[\\/]/.test(token)) return undefined;
  const words = (value: string) => value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase();
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(token);
  if (mcp) {
    const server = words(mcp[1]);
    return `${server.charAt(0).toUpperCase()}${server.slice(1)}: ${words(mcp[2])}`;
  }
  return words(token) || undefined;
}

/** One tool as a plain step: "Running npm test", "Reading app.tsx". */
export function toolStep(tool: Pick<ToolChip, "name" | "detail">): string {
  const name = tool.name || "tool";
  const detail = (tool.detail || "").replace(/\s+/g, " ").trim();
  if (/^(?:bash|shell|exec|command|run)/i.test(name) || /command_execution/i.test(name)) {
    const short = detail ? shortCommand(detail) : undefined;
    if (short) return `Running ${short}`;
    return CHECK.test(detail) ? "Running a check" : "Running a command";
  }
  if (/web[\s_-]?search/i.test(name)) return "Searching the web";
  if (/web[\s_-]?fetch|fetch/i.test(name)) return "Reading a web page";
  if (/^(?:read|view|cat|open)/i.test(name)) return detail ? `Reading ${fileName(detail)}` : "Reading a file";
  if (/write|edit|notebook|patch/i.test(name)) return detail ? `Editing ${fileName(detail.split(",")[0])}` : "Editing a file";
  if (/grep|glob|search|find|ls$/i.test(name)) return "Searching the project";
  if (/browser|cdp|harness|navigate|screenshot|click/i.test(name)) return "Using the browser";
  if (/todo|plan/i.test(name)) return "Planning the work";
  if (/^(?:task|agent)/i.test(name)) return "Waiting on a helper";
  const label = toolDisplayName(name);
  return label ? `Using ${label}` : "Using a tool";
}

/**
 * The line above a working reply. The newest running tool names the step; with
 * none running the agent is either writing the reply or still thinking.
 */
export function liveStepLabel(tools: readonly ToolChip[], hasText: boolean): string {
  const running = tools.filter((tool) => tool.status === "running");
  const latest = running[running.length - 1];
  if (latest) {
    const step = toolStep(latest);
    return running.length > 1 ? `${step} · ${running.length} running` : step;
  }
  return hasText ? "Writing" : "Thinking";
}

/** "Used 3 tools", with "· 1 failed" when some did. */
export function usedToolsLabel(tools: readonly ToolChip[]): { used: string; failed: string | null } {
  const failed = tools.filter((tool) => tool.status === "error").length;
  return {
    used: `Used ${tools.length} tool${tools.length === 1 ? "" : "s"}`,
    failed: failed ? `${failed} failed` : null,
  };
}
