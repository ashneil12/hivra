import "server-only";

import { supabaseAdmin } from "@/lib/supabase";

/**
 * "Always allow" for Claude Code prompts in Needs you.
 *
 * Off unless HIVRA_INBOX_ALWAYS_ALLOW is on. A rule only ever matches one
 * exact thing the owner saw: the exact command text for Bash, or the exact
 * file path for Write/Edit/MultiEdit/NotebookEdit. There is no wildcard and no
 * "allow this whole tool". A prompt with no safe match is never offered "always".
 */

const FILE_PREFIX: Record<string, string> = { Write: "Write ", Edit: "Edit ", MultiEdit: "Edit ", NotebookEdit: "Edit " };

export function alwaysAllowEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.HIVRA_INBOX_ALWAYS_ALLOW?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}

/**
 * The exact text a rule would store for this prompt, or null when no safe
 * match exists (unknown tool, command cut short, redacted, or no file path).
 */
export function safeRuleCommand(tool: string | null | undefined, command: string | null | undefined, complete: boolean): string | null {
  const text = command?.trim();
  if (!tool || !text || !complete) return null;
  // The hook redacts secrets to ***: such text could stand for many different commands.
  if (text.includes("***")) return null;
  if (tool === "Bash") return text;
  const prefix = FILE_PREFIX[tool];
  if (!prefix || !text.startsWith(prefix)) return null;
  const path = text.slice(prefix.length);
  if (!path.startsWith("/") || path.split("/").includes("..") || /[\r\n]/.test(path)) return null;
  return text;
}

function db() {
  if (!supabaseAdmin) throw new Error("Database not configured");
  return supabaseAdmin;
}

/** Whether an active rule already allows exactly this. */
export async function hasActiveRule(agentId: string, userId: string, tool: string, command: string): Promise<boolean> {
  const { data, error } = await db()
    .from("agent_inbox_allow_rules")
    .select("id")
    .eq("agent_id", agentId)
    .eq("user_id", userId)
    .eq("tool", tool)
    .eq("command_pattern", command)
    .is("revoked_at", null)
    .limit(1);
  return !error && Array.isArray(data) && data.length > 0;
}

/** Store a rule from an answered prompt (once per exact command). */
export async function createRule(
  agentId: string,
  userId: string,
  tool: string,
  command: string,
  promptRowId?: string | null,
): Promise<void> {
  if (await hasActiveRule(agentId, userId, tool, command)) return;
  const { error } = await db()
    .from("agent_inbox_allow_rules")
    .insert({ agent_id: agentId, user_id: userId, tool, command_pattern: command, created_from_prompt: promptRowId ?? null });
  if (error) throw new Error(`could not save the rule: ${error.message}`);
}

export interface AllowRule {
  id: string;
  tool: string;
  command: string | null;
  createdAt: string;
}

/** The owner's active rules for one agent, or null when the agent is not theirs. */
export async function listRules(userId: string, agentId: string): Promise<AllowRule[] | null> {
  const { data: agent, error: agentError } = await db()
    .from("hivra_agents").select("id").eq("id", agentId).eq("user_id", userId).neq("status", "deleted").maybeSingle();
  if (agentError) throw new Error(`could not load the agent: ${agentError.message}`);
  if (!agent) return null;
  const { data, error } = await db()
    .from("agent_inbox_allow_rules")
    .select("id, tool, command_pattern, created_at")
    .eq("agent_id", agentId)
    .eq("user_id", userId)
    .is("revoked_at", null)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(`could not read the rules: ${error.message}`);
  return ((data ?? []) as { id: string; tool: string; command_pattern: string | null; created_at: string }[])
    .map((row) => ({ id: row.id, tool: row.tool, command: row.command_pattern, createdAt: row.created_at }));
}

/** Revoke one rule. False when it is not the owner's, or already revoked. */
export async function revokeRule(userId: string, agentId: string, ruleId: string, now = new Date()): Promise<boolean> {
  const { data, error } = await db()
    .from("agent_inbox_allow_rules")
    .update({ revoked_at: now.toISOString() })
    .eq("id", ruleId)
    .eq("agent_id", agentId)
    .eq("user_id", userId)
    .is("revoked_at", null)
    .select("id");
  if (error) throw new Error(`could not revoke the rule: ${error.message}`);
  return Boolean(data?.length);
}
