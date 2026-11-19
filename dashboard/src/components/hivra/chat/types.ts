import type { ToolStatus, TurnOutcome } from "@/lib/hivra/agent-adapters";

export interface ToolChip {
  id?: string;
  name: string;
  detail: string;
  status: ToolStatus | "unknown";
  result?: string;
  /** The tool's input JSON (trimmed), for the rich rows: tasks, a diff, a plan. */
  input?: unknown;
  /** "thinking": the agent's reasoning, shown as its own muted row. */
  kind?: "thinking";
}

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  tools: ToolChip[];
  streaming?: boolean;
  /** "disconnected": this page lost the reply's stream, but the agent keeps
   * working on its computer and the reply fills in once it is reachable.
   * "unknown": the run finished while no page was watching and the computer
   * no longer keeps its log, so only the text that arrived here is shown. */
  outcome?: "complete" | "error" | "stopped" | "disconnected" | "unknown";
  /** What the agent's own final event said about the turn (Claude's result,
   * Codex's turn.completed / turn.failed). It decides `outcome` once the run
   * ends; an agent that says nothing is judged by its exit. */
  reported?: TurnOutcome;
  /** Warnings the agent raised during the turn, shown under the reply. They
   * never decide how the turn ended. */
  warnings?: string[];
  /** The box run producing this reply: the key for Stop and for re-attaching. */
  runId?: string;
  /** The computer confirmed it started the run (its `_run` line arrived). */
  started?: boolean;
  /** The first-contact welcome's reply, whose prompt never shows: a failed
   * one offers Retry, one that never reached the computer starts again. */
  welcome?: boolean;
  /** Why a reply that has not started yet is waiting (the computer is moving
   * its agent CLI to a new version); cleared once the computer takes it. */
  pending?: string;
  /** The model's context as this reply's stream last reported it. */
  usage?: { used: number; window?: number };
}

export interface Session {
  id: string;
  title: string;
  claudeSessionId: string | null;
  messages: ChatMessage[];
  createdAt: number;
  /** Box-backed session whose messages have been fetched from the VM. */
  loaded?: boolean;
}
