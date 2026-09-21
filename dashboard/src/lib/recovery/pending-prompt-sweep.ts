import "server-only";

import { sendAgentApprovalNeededEmail } from "@/lib/email/agent-approval-needed";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import { sendMobilePushToUser } from "@/lib/push/expo-push";
import { resolveClerkRecipient } from "@/lib/recovery/lifecycle-email-sweep";
import { supabaseAdmin } from "@/lib/supabase";

// Companion cron for the agent-approval-notify feature. Two jobs, both cheap:
//
//   (1) EXPIRE — mark rows whose expires_at has passed but which the agent
//       never resolved. This happens when the agent DIES while blocked and so
//       never fires post_approval_response. Without it a stale badge/email row
//       lingers past the agent's park window.
//
//   (2) NUDGE — for a prompt that has stayed unresolved past NUDGE_AFTER_SECONDS
//       and hasn't been emailed yet, send ONE "your agent needs you" email to
//       the owner (they've closed the workspace tab and can't see the in-iframe
//       prompt). Email-first: notified_at is stamped only AFTER Resend accepts,
//       and a stable Resend idempotencyKey backstops a lost marker write.
//
// The 90s nudge delay means a user who is actually watching the iframe answers
// before any email fires — no inbox spam for the common case.

const LOG_SOURCE = "pending-prompt-sweep";
export const PENDING_PROMPT_CRON_NAME = "expire-pending-prompts";

const DEFAULT_NUDGE_AFTER_SECONDS = 90;
const DEFAULT_EMAIL_LIMIT = 50;

export interface PendingPromptSweepSummary {
  expired: number;
  nudgeCandidates: number;
  emailsSent: number;
  emailsFailed: number;
  emailSkippedNoRecipient: number;
  /** Mobile pushes delivered beside the nudge emails (iOS Phase 2, additive). */
  pushesSent: number;
  pushesFailed: number;
  errors: number;
  dryRun: boolean;
}

interface NudgeRow {
  id: string;
  instance_id: string;
  prompt_id: string;
  user_id: string;
  kind: string | null;
  summary: string | null;
  created_at: string;
  hermes_instances: { name: string | null; agent_type: string | null } | null;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function runPendingPromptSweep(options?: {
  dryRun?: boolean;
  limit?: number;
}): Promise<PendingPromptSweepSummary> {
  const dryRun = options?.dryRun ?? false;
  const emailLimit = options?.limit ?? envInt("PENDING_PROMPT_EMAIL_LIMIT", DEFAULT_EMAIL_LIMIT);
  const nudgeAfterSeconds = envInt("PENDING_PROMPT_NUDGE_AFTER_SECONDS", DEFAULT_NUDGE_AFTER_SECONDS);

  const summary: PendingPromptSweepSummary = {
    expired: 0,
    nudgeCandidates: 0,
    emailsSent: 0,
    emailsFailed: 0,
    emailSkippedNoRecipient: 0,
    pushesSent: 0,
    pushesFailed: 0,
    errors: 0,
    dryRun,
  };

  const supabase = supabaseAdmin;
  if (!supabase) {
    log.warn("supabaseAdmin unavailable; skipping pending-prompt sweep", {
      source: LOG_SOURCE,
      failureType: "supabase_unconfigured",
    });
    return summary;
  }

  const nowIso = new Date().toISOString();

  // (1) EXPIRE — resolve rows the agent abandoned (died mid-wait). Marking
  // resolved_at closes both the badge (open-prompt read filters on it) and any
  // pending nudge. resolved_choice='timeout' matches what the agent itself
  // would have relayed on a clean timeout.
  if (!dryRun) {
    const { data: expiredRows, error: expireErr } = await supabase
      .from("instance_pending_prompts")
      .update({ resolved_at: nowIso, resolved_choice: "timeout" })
      .is("resolved_at", null)
      .lt("expires_at", nowIso)
      .select("id");
    if (expireErr) {
      summary.errors += 1;
      log.warn("failed to expire stale pending prompts", {
        source: LOG_SOURCE,
        failureType: "expire_failed",
        errorDescription: expireErr.message,
      });
    } else {
      summary.expired = expiredRows?.length ?? 0;
    }
  }

  // (2) NUDGE — unresolved, unexpired, un-emailed prompts older than the nudge
  // delay. Join the instance for the agent display name.
  const nudgeBeforeIso = new Date(Date.now() - nudgeAfterSeconds * 1000).toISOString();
  const { data: nudgeData, error: nudgeErr } = await supabase
    .from("instance_pending_prompts")
    .select(
      "id, instance_id, prompt_id, user_id, kind, summary, created_at, hermes_instances(name, agent_type)"
    )
    .is("resolved_at", null)
    .is("notified_at", null)
    .gt("expires_at", nowIso)
    .lt("created_at", nudgeBeforeIso)
    .order("created_at", { ascending: true })
    .limit(emailLimit);

  if (nudgeErr) {
    summary.errors += 1;
    log.warn("failed to load pending-prompt nudge candidates", {
      source: LOG_SOURCE,
      failureType: "nudge_query_failed",
      errorDescription: nudgeErr.message,
    });
    return summary;
  }

  const rows = (nudgeData ?? []) as unknown as NudgeRow[];
  summary.nudgeCandidates = rows.length;
  if (rows.length === 0) return summary;

  const clerkSecret = process.env.CLERK_SECRET_KEY?.trim();
  if (!clerkSecret) {
    log.warn("CLERK_SECRET_KEY not configured; cannot resolve nudge recipients", {
      source: LOG_SOURCE,
      failureType: "clerk_secret_missing",
      candidates: rows.length,
    });
    return summary;
  }

  for (const row of rows) {
    try {
      const recipient = await resolveClerkRecipient(clerkSecret, row.user_id);
      if (!recipient?.email) {
        summary.emailSkippedNoRecipient += 1;
        continue;
      }

      if (dryRun) {
        summary.emailsSent += 1;
        continue;
      }

      const kind = row.kind === "clarify" ? "clarify" : "approval";
      const result = await sendAgentApprovalNeededEmail({
        email: recipient.email,
        firstName: recipient.firstName,
        agentName: row.hermes_instances?.name ?? null,
        agentType: row.hermes_instances?.agent_type ?? null,
        instanceId: row.instance_id,
        summary: row.summary,
        kind,
        // Stable per prompt row — Resend dedupes even if the marker write below
        // is lost, so a re-run never double-sends.
        idempotencyKey: `pending-prompt:${row.id}`,
      });

      if (!result.sent) {
        summary.emailsFailed += 1;
        continue;
      }

      // Marker AFTER the send accepted (email-first). The unique row means this
      // prompt is never selected again once notified_at is set.
      const { error: markErr } = await supabase
        .from("instance_pending_prompts")
        .update({ notified_at: new Date().toISOString() })
        .eq("id", row.id);
      if (markErr) {
        // The Resend idempotencyKey still prevents a duplicate send next run.
        log.warn("failed to persist pending-prompt notified_at marker", {
          source: LOG_SOURCE,
          failureType: "notified_marker_failed",
          instanceId: row.instance_id,
          errorDescription: markErr.message,
        });
      }
      summary.emailsSent += 1;

      // Mobile push beside the email (iOS Phase 2 — additive, never gates or
      // reorders the email path above). Shares the email's once-guard: this
      // block is only reached in the iteration whose Resend send was accepted,
      // and notified_at keeps the row out of every future run. A user with no
      // registered device tokens is a clean no-op inside the sender.
      try {
        const agentLabel = row.hermes_instances?.name?.trim() || "Your agent";
        const pushResult = await sendMobilePushToUser({
          userId: row.user_id,
          title:
            kind === "clarify"
              ? `${agentLabel} has a question`
              : `${agentLabel} needs your approval`,
          body:
            row.summary?.trim() ||
            (kind === "clarify"
              ? "Answer to unblock it."
              : "Approve or deny to unblock it."),
          url: `hivra://approval/${row.instance_id}`,
          data: { kind: `agent_${kind}`, instanceId: row.instance_id },
        });
        summary.pushesSent += pushResult.sent;
        summary.pushesFailed += pushResult.failed;
      } catch (pushErr) {
        // sendMobilePushToUser never throws by contract; this catch is a
        // belt-and-braces so a regression there can't break the email sweep.
        summary.pushesFailed += 1;
        log.warn("pending-prompt push failed (email already sent)", {
          source: LOG_SOURCE,
          failureType: "pending_prompt_push_failed",
          instanceId: row.instance_id,
          errorDescription:
            pushErr instanceof Error ? pushErr.message : String(pushErr),
        });
      }
    } catch (err) {
      summary.errors += 1;
      const msg = err instanceof Error ? err.message : String(err);
      log.warn("pending-prompt nudge failed for one row", {
        source: LOG_SOURCE,
        failureType: "nudge_row_failed",
        instanceId: row.instance_id,
        errorDescription: msg,
      });
    }
  }

  // Notable-only ops event (keep title/message stable; volatile counts in
  // metadata) so a persistent send-failure condition pages once, not per tick.
  if (!dryRun && (summary.emailsFailed > 0 || summary.errors > 0)) {
    await reportOpsEvent({
      source: "cron.pending_prompt_nudge_degraded",
      severity: "warn",
      title: "expire-pending-prompts had send failures",
      message:
        "The pending-prompt nudge cron could not deliver one or more agent-approval emails. Owners of blocked agents may not have been notified; check RESEND/Clerk config.",
      route: "/api/cron/expire-pending-prompts",
      metadata: {
        expired: summary.expired,
        nudge_candidates: summary.nudgeCandidates,
        emails_sent: summary.emailsSent,
        emails_failed: summary.emailsFailed,
        email_skipped_no_recipient: summary.emailSkippedNoRecipient,
        errors: summary.errors,
      },
    });
  }

  return summary;
}
