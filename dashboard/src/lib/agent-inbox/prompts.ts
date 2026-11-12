import "server-only";

import crypto from "node:crypto";

import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";
import { APPROVAL_CHOICES, type ApprovalChoice, type InboxPrompt } from "./types";

export { APPROVAL_CHOICES, type ApprovalChoice, type InboxPrompt };

/**
 * Needs you answers for agents on Hivra computers.
 *
 * The hivra-inbox Hermes plugin (provisioner/hermes-plugins/hivra-inbox)
 * reports what Hermes is waiting on through /api/internal/agent-prompts and
 * polls it for the owner's answer. Rows live in agent_inbox_prompts.
 *
 * Off unless HIVRA_INBOX_ANSWERS is on: then nothing is read, installed or
 * answered, and Needs you behaves exactly as before.
 */

const SOURCE = "agent-inbox";
export const MAX_TTL_SECONDS = 24 * 60 * 60;

export function inboxAnswersEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.HIVRA_INBOX_ANSWERS?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on";
}

export interface InboxComputer {
  id: string;
  user_id: string;
  type: string;
  status: string;
}

interface PromptRow {
  agent_id: string;
  prompt_id: string;
  kind: string;
  summary: string | null;
  command: string | null;
  command_complete: boolean | null;
  choices: string[] | null;
  created_at: string;
  expires_at: string;
  answer_choice: string | null;
  answer_text?: string | null;
  answered_at: string | null;
  resolved_at?: string | null;
  user_id?: string;
}

function db() {
  if (!supabaseAdmin) throw new Error("Database not configured");
  return supabaseAdmin;
}

function cleanChoices(value: unknown): ApprovalChoice[] {
  if (!Array.isArray(value)) return [];
  const allowed = new Set<string>(APPROVAL_CHOICES);
  return APPROVAL_CHOICES.filter((choice) => value.includes(choice) && allowed.has(choice));
}

function toPrompt(row: PromptRow): InboxPrompt {
  const kind = row.kind === "clarify" ? "clarify" : "approval";
  const choices = kind === "approval" ? cleanChoices(row.choices) : [];
  return {
    promptId: row.prompt_id,
    kind,
    summary: row.summary?.trim() || null,
    command: row.command?.trim() || null,
    commandComplete: Boolean(row.command_complete),
    choices,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    answerable: kind === "approval" && choices.includes("deny"),
    answeredChoice: (cleanChoices([row.answer_choice])[0] ?? null),
  };
}

/** The computer a hivra-inbox plugin speaks for, from its box token. Null when unknown. */
export async function computerForToken(authorization: string | null): Promise<InboxComputer | null> {
  const token = authorization?.match(/^Bearer\s+([0-9a-f]{64})$/i)?.[1]?.toLowerCase();
  if (!token) return null;
  const { data, error } = await db()
    .from("hivra_agents")
    .select("id, user_id, type, status, api_token")
    .eq("api_token", token)
    .neq("status", "deleted")
    .limit(2);
  if (error || !Array.isArray(data) || data.length !== 1) return null;
  const row = data[0] as InboxComputer & { api_token: string | null };
  const stored = Buffer.from(String(row.api_token ?? ""), "utf8");
  const presented = Buffer.from(token, "utf8");
  if (stored.length !== presented.length || !crypto.timingSafeEqual(stored, presented)) return null;
  return { id: row.id, user_id: row.user_id, type: row.type, status: row.status };
}

export interface PendingInput {
  promptId: string;
  kind: "approval" | "clarify";
  summary?: string;
  command?: string;
  commandComplete?: boolean;
  choices?: string[];
  sessionId?: string;
  ttlSeconds?: number;
}

export async function recordPending(computer: InboxComputer, input: PendingInput, now = new Date()): Promise<void> {
  const ttl = Math.min(Math.max(Math.floor(input.ttlSeconds ?? 300), 30), MAX_TTL_SECONDS);
  const kind = input.kind;
  const choices = kind === "approval" ? cleanChoices(input.choices ?? []) : [];
  const { error } = await db()
    .from("agent_inbox_prompts")
    .upsert({
      agent_id: computer.id,
      user_id: computer.user_id,
      prompt_id: input.promptId,
      kind,
      summary: input.summary?.trim() || null,
      command: kind === "approval" ? input.command?.trim() || null : null,
      command_complete: kind === "approval" && Boolean(input.commandComplete && input.command?.trim()),
      choices: choices.includes("deny") ? choices : [],
      session_id: input.sessionId?.trim() || null,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + ttl * 1000).toISOString(),
    }, { onConflict: "agent_id,prompt_id", ignoreDuplicates: true });
  if (error) throw new Error(`could not record a prompt: ${error.message}`);
}

export async function recordResolved(computer: InboxComputer, promptId: string, outcome: string, now = new Date()): Promise<void> {
  const { error } = await db()
    .from("agent_inbox_prompts")
    .update({ resolved_at: now.toISOString(), resolved_outcome: outcome.slice(0, 32) })
    .eq("agent_id", computer.id)
    .eq("prompt_id", promptId)
    .is("resolved_at", null);
  if (error) throw new Error(`could not close a prompt: ${error.message}`);
}

/** Answers the owner gave that the computer has not applied yet. */
export async function answersFor(computer: InboxComputer, promptIds: string[]): Promise<{ prompt_id: string; choice: ApprovalChoice; text: string | null }[]> {
  if (promptIds.length === 0) return [];
  const { data, error } = await db()
    .from("agent_inbox_prompts")
    .select("prompt_id, answer_choice, answer_text")
    .eq("agent_id", computer.id)
    .in("prompt_id", promptIds)
    .not("answered_at", "is", null)
    .is("resolved_at", null);
  if (error) throw new Error(`could not read answers: ${error.message}`);
  return ((data ?? []) as Pick<PromptRow, "prompt_id" | "answer_choice" | "answer_text">[]).flatMap((row) => {
    const choice = cleanChoices([row.answer_choice])[0];
    return choice ? [{ prompt_id: row.prompt_id, choice, text: row.answer_text ?? null }] : [];
  });
}

/** The newest open prompt per agent. Never throws: a read failure only hides the answer cards. */
export async function openPromptsFor(agentIds: string[], now = new Date()): Promise<Record<string, InboxPrompt>> {
  const ids = [...new Set(agentIds.filter(Boolean))];
  if (!ids.length || !supabaseAdmin || !inboxAnswersEnabled()) return {};
  try {
    const { data, error } = await supabaseAdmin
      .from("agent_inbox_prompts")
      .select("agent_id, prompt_id, kind, summary, command, command_complete, choices, created_at, expires_at, answer_choice, answered_at")
      .in("agent_id", ids)
      .is("resolved_at", null)
      .gt("expires_at", now.toISOString())
      .order("created_at", { ascending: false })
      .limit(Math.min(Math.max(ids.length * 10, 100), 1000));
    if (error) throw error;
    const out: Record<string, InboxPrompt> = {};
    for (const row of (data ?? []) as PromptRow[]) {
      if (!out[row.agent_id]) out[row.agent_id] = toPrompt(row);
    }
    return out;
  } catch (error) {
    log.warn("could not read agent prompts; Needs you shows no answer cards", {
      source: SOURCE, failureType: "agent_prompt_read_failed",
      errorDescription: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

export type AnswerResult =
  | { ok: true; prompt: InboxPrompt }
  | { ok: false; status: 400 | 404 | 409; message: string };

/** Record the owner's answer. The computer picks it up within a few seconds. */
export async function answerPrompt(
  userId: string,
  agentId: string,
  promptId: string,
  answer: { choice: ApprovalChoice; text?: string | null },
  now = new Date(),
): Promise<AnswerResult> {
  const { data, error } = await db()
    .from("agent_inbox_prompts")
    .select("agent_id, user_id, prompt_id, kind, summary, command, command_complete, choices, created_at, expires_at, answer_choice, answered_at, resolved_at")
    .eq("agent_id", agentId)
    .eq("prompt_id", promptId)
    .eq("user_id", userId)
    .maybeSingle<PromptRow>();
  if (error) throw new Error(`could not read the prompt: ${error.message}`);
  if (!data) return { ok: false, status: 404, message: "This request is no longer waiting." };
  if (data.resolved_at || Date.parse(data.expires_at) <= now.getTime()) {
    return { ok: false, status: 409, message: "Your agent stopped waiting for this one." };
  }
  if (data.answered_at) return { ok: false, status: 409, message: "This was already answered." };
  const prompt = toPrompt(data);
  if (!prompt.answerable) return { ok: false, status: 400, message: "Answer this one in the chat." };
  if (!prompt.choices.includes(answer.choice)) return { ok: false, status: 400, message: "That answer is not offered for this request." };
  if (answer.choice !== "deny" && !prompt.commandComplete) {
    return { ok: false, status: 400, message: "Open the chat to see the whole command before you allow it." };
  }
  const text = answer.choice === "deny" ? answer.text?.trim().slice(0, 500) || null : null;
  const { data: updated, error: updateError } = await db()
    .from("agent_inbox_prompts")
    .update({ answer_choice: answer.choice, answer_text: text, answered_at: now.toISOString() })
    .eq("agent_id", agentId)
    .eq("prompt_id", promptId)
    .eq("user_id", userId)
    .is("answered_at", null)
    .is("resolved_at", null)
    .select("prompt_id");
  if (updateError) throw new Error(`could not save the answer: ${updateError.message}`);
  if (!updated?.length) return { ok: false, status: 409, message: "This was already answered." };
  return { ok: true, prompt: { ...prompt, answeredChoice: answer.choice } };
}
