import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Retention for Needs you requests (agent_inbox_prompts).
 *
 * A row holds what an agent asked its owner: a summary, the command waiting
 * for approval, and any reason the owner typed when refusing. That text is
 * only useful while the request is open and for a short while after, so the
 * owner can see what they answered. A request is open for at most 24 hours
 * (MAX_TTL_SECONDS in prompts.ts), so `expires_at` is the latest moment it
 * can still be waiting. Once `expires_at` is CLOSED_PROMPT_RETENTION_DAYS in
 * the past, the row is deleted.
 *
 * Effect on "Allow for this chat": recordPending() reads an earlier 'session'
 * answer back (same computer, chat and tool) so the agent is not asked again,
 * and it stores each request it lets through that way as a 'session' answer
 * too. So a chat that keeps using the tool keeps its permission, and a chat
 * that has been quiet for longer than the window is asked once more.
 *
 * This runs whether or not HIVRA_INBOX_ANSWERS is on, so rows written while
 * it was on still go. It has no switch of its own: only ?dryRun=1 on the
 * cron route turns a run into a count.
 */

export const CLOSED_PROMPT_RETENTION_DAYS = 7;

const TABLE = "agent_inbox_prompts";

export interface InboxPromptRetentionSummary {
  dryRun: boolean;
  retentionDays: number;
  cutoff: string;
  /** Closed requests deleted (on a dry run: how many would be). */
  deleted: number;
}

export function inboxPromptRetentionCutoff(now: Date): Date {
  return new Date(now.getTime() - CLOSED_PROMPT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

export async function runInboxPromptRetention(
  client: SupabaseClient,
  options: { now?: Date; dryRun?: boolean } = {}
): Promise<InboxPromptRetentionSummary> {
  const dryRun = options.dryRun === true;
  const cutoff = inboxPromptRetentionCutoff(options.now ?? new Date()).toISOString();

  const { count, error } = dryRun
    ? await client.from(TABLE).select("id", { count: "exact", head: true }).lt("expires_at", cutoff)
    : await client.from(TABLE).delete({ count: "exact" }).lt("expires_at", cutoff);
  if (error) {
    throw new Error(`agent inbox retention could not ${dryRun ? "count" : "delete"} closed requests: ${error.message}`);
  }
  return { dryRun, retentionDays: CLOSED_PROMPT_RETENTION_DAYS, cutoff, deleted: count ?? 0 };
}
