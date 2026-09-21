import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";

// Batch reader for the per-instance "your agent is blocked waiting on you"
// indicator. Mirrors instance-failure-alerts.ts: one .in("instance_id", ids)
// query for the whole card list, keeping only the newest OPEN prompt per
// instance. Rows are written by POST /api/internal/agent-notify (the
// hivra_approval_relay agent plugin) and closed when the agent resolves the
// approval or the expire-pending-prompts cron ages them out.

const LOG_SOURCE = "instance-pending-prompts";

export interface InstancePendingPrompt {
  promptId: string;
  kind: "approval" | "clarify";
  summary: string | null;
  surface: string | null;
  createdAt: string | null;
  expiresAt: string | null;
}

interface PendingPromptRow {
  instance_id: unknown;
  prompt_id: unknown;
  kind: unknown;
  summary: unknown;
  surface: unknown;
  created_at: unknown;
  expires_at: unknown;
}

function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return String(error);
}

/**
 * Return the newest open prompt per instance, keyed by instance id. Open =
 * resolved_at IS NULL AND expires_at > now(). Never throws — a read failure
 * degrades to "no indicator" rather than breaking the instance list.
 */
export async function getOpenPendingPrompts(
  instanceIds: string[]
): Promise<Record<string, InstancePendingPrompt>> {
  if (!supabaseAdmin) return {};

  const normalizedIds = Array.from(
    new Set(instanceIds.map((id) => id.trim()).filter((id) => id.length > 0))
  );
  if (normalizedIds.length === 0) return {};

  try {
    const nowIso = new Date().toISOString();
    // The dedupe loop keeps the newest OPEN row per instance. Ordering +
    // limiting are GLOBAL (PostgREST can't DISTINCT ON without an RPC), so in
    // principle one instance with many open rows could fill the budget and
    // crowd a quieter instance's badge out of the result. We make that
    // unreachable rather than merely rare: the agent's blocking model parks ~1
    // approval at a time per instance, and every open row self-expires
    // (expires_at), so a realistic user never approaches this cap. Budget = a
    // generous per-instance allowance with a high floor and a hard ceiling. If
    // per-instance fairness ever genuinely bites, replace this with a
    // DISTINCT ON (instance_id) RPC.
    const scanBudget = Math.min(Math.max(normalizedIds.length * 20, 200), 1000);
    const { data, error } = await supabaseAdmin
      .from("instance_pending_prompts")
      .select("instance_id, prompt_id, kind, summary, surface, created_at, expires_at")
      .in("instance_id", normalizedIds)
      .is("resolved_at", null)
      .gt("expires_at", nowIso)
      .order("created_at", { ascending: false })
      .limit(scanBudget);

    if (error) {
      log.warn("failed to read pending prompts; continuing without approval indicators", {
        source: LOG_SOURCE,
        failureType: "pending_prompt_read_failed",
        errorDescription: describeError(error),
      }, error);
      return {};
    }

    const out: Record<string, InstancePendingPrompt> = {};
    for (const row of (data || []) as PendingPromptRow[]) {
      const instanceId = optionalString(row.instance_id);
      if (!instanceId || out[instanceId]) continue; // first = newest
      const kind = row.kind === "clarify" ? "clarify" : "approval";
      out[instanceId] = {
        promptId: optionalString(row.prompt_id) ?? "",
        kind,
        summary: optionalString(row.summary),
        surface: optionalString(row.surface),
        createdAt: optionalString(row.created_at),
        expiresAt: optionalString(row.expires_at),
      };
    }
    return out;
  } catch (error) {
    log.warn("unexpected error reading pending prompts", {
      source: LOG_SOURCE,
      failureType: "pending_prompt_read_unexpected",
      errorDescription: describeError(error),
    }, error);
    return {};
  }
}
