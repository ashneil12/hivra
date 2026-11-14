/**
 * Feedback-email sweep.
 *
 * Daily selection + send for the two feedback emails (see email/feedback.ts).
 * Driven by /api/cron/feedback-emails, which stays inert until
 * FEEDBACK_EMAILS_ENABLED=true.
 *
 * Cohorts:
 *   feedback_checkin  an active paid subscription that has been paid for at
 *                     least FEEDBACK_CHECKIN_MIN_PAID_DAYS (upgraded_at, else
 *                     the subscription's created_at)
 *   cancel_feedback   a subscription cancelled (status "canceled", stamped at
 *                     updated_at) between CANCEL_FEEDBACK_MIN_DAYS and
 *                     CANCEL_FEEDBACK_MAX_DAYS ago
 *
 * Each key goes to a user at most once ever, through the same
 * lifecycle_email_sends ledger and Resend idempotency key pattern as the
 * lifecycle sweep. The first enabled run asks every current paying customer
 * once, spread over several days by the per-run cap.
 */

import "server-only";

import { FUNNEL_PAID_PLANS } from "@/lib/conversion-funnel";
import { chunk } from "@/lib/array-utils";
import { sendFeedbackEmail, type FeedbackEmailKey } from "@/lib/email/feedback";
import { log } from "@/lib/logger";
import { posthogClient } from "@/lib/posthog";
import { resolveClerkRecipient } from "@/lib/recovery/lifecycle-email-sweep";
import { supabaseAdmin } from "@/lib/supabase";

const LOG_SOURCE = "feedback-email-sweep";
const DAY_MS = 86_400_000;
const QUERY_LIMIT = 1000;
const IN_CHUNK_SIZE = 200;
const DEFAULT_BATCH_SIZE = 25;

export const FEEDBACK_CHECKIN_MIN_PAID_DAYS = 14;
export const CANCEL_FEEDBACK_MIN_DAYS = 2;
export const CANCEL_FEEDBACK_MAX_DAYS = 30;

export interface FeedbackSubscriptionRow {
  user_id: string;
  plan: string | null;
  status: string | null;
  created_at: string;
  updated_at: string | null;
  upgraded_at?: string | null;
}

export interface FeedbackSweepSummary {
  candidates: number;
  feedback_checkin: number;
  cancel_feedback: number;
  skipped_already_sent: number;
  skipped_no_email: number;
  failed: number;
  capHit: boolean;
}

function ageMs(ts: string | null | undefined, now: Date): number | null {
  if (!ts) return null;
  const parsed = Date.parse(ts);
  return Number.isFinite(parsed) ? now.getTime() - parsed : null;
}

/** The feedback email this subscription is due, or null. */
export function selectFeedbackEmail(
  sub: FeedbackSubscriptionRow,
  now: Date
): FeedbackEmailKey | null {
  if (sub.status === "canceled") {
    const age = ageMs(sub.updated_at, now);
    if (age === null) return null;
    return age >= CANCEL_FEEDBACK_MIN_DAYS * DAY_MS && age < CANCEL_FEEDBACK_MAX_DAYS * DAY_MS
      ? "cancel_feedback"
      : null;
  }
  if (sub.status === "active" && (FUNNEL_PAID_PLANS as readonly string[]).includes(sub.plan ?? "")) {
    const age = ageMs(sub.upgraded_at ?? sub.created_at, now);
    return age !== null && age >= FEEDBACK_CHECKIN_MIN_PAID_DAYS * DAY_MS ? "feedback_checkin" : null;
  }
  return null;
}

function resolveBatchSize(): number {
  const parsed = Number.parseInt(process.env.FEEDBACK_EMAILS_BATCH_SIZE?.trim() ?? "", 10);
  return Math.min(200, Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_BATCH_SIZE);
}

type QueryError = { message?: string | null } | null;

function throwOnError(label: string, error: QueryError): void {
  if (error) throw new Error(`${label}: ${error.message || "query failed"}`);
}

export async function runFeedbackEmailSweep(opts?: {
  now?: Date;
  batchSize?: number;
}): Promise<FeedbackSweepSummary> {
  const summary: FeedbackSweepSummary = {
    candidates: 0,
    feedback_checkin: 0,
    cancel_feedback: 0,
    skipped_already_sent: 0,
    skipped_no_email: 0,
    failed: 0,
    capHit: false,
  };

  if (!supabaseAdmin) throw new Error("Database not configured");
  const db = supabaseAdmin;
  const now = opts?.now ?? new Date();
  const batchSize = Math.max(1, opts?.batchSize ?? resolveBatchSize());
  const clerkSecret = process.env.CLERK_SECRET_KEY?.trim();
  const iso = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString();
  const columns = "user_id, plan, status, created_at, updated_at, upgraded_at";

  const { data: paidRows, error: paidErr } = await db
    .from("hermes_subscriptions")
    .select(columns)
    .eq("status", "active")
    .in("plan", [...FUNNEL_PAID_PLANS])
    .lte("created_at", iso(FEEDBACK_CHECKIN_MIN_PAID_DAYS * DAY_MS))
    .order("user_id")
    .limit(QUERY_LIMIT);
  throwOnError("paid subscription query failed", paidErr);

  const { data: cancelRows, error: cancelErr } = await db
    .from("hermes_subscriptions")
    .select(columns)
    .eq("status", "canceled")
    .gte("updated_at", iso(CANCEL_FEEDBACK_MAX_DAYS * DAY_MS))
    .lte("updated_at", iso(CANCEL_FEEDBACK_MIN_DAYS * DAY_MS))
    .order("user_id")
    .limit(QUERY_LIMIT);
  throwOnError("cancelled subscription query failed", cancelErr);

  const dueByUser = new Map<string, FeedbackEmailKey>();
  for (const row of [...(paidRows ?? []), ...(cancelRows ?? [])] as FeedbackSubscriptionRow[]) {
    const key = selectFeedbackEmail(row, now);
    if (key && !dueByUser.has(row.user_id)) dueByUser.set(row.user_id, key);
  }
  const userIds = [...dueByUser.keys()];
  summary.candidates = userIds.length;
  if (userIds.length === 0) return summary;

  const alreadySent = new Set<string>();
  for (const ids of chunk(userIds, IN_CHUNK_SIZE)) {
    const { data, error } = await db
      .from("lifecycle_email_sends")
      .select("user_id, email_key")
      .in("user_id", ids)
      .in("email_key", ["feedback_checkin", "cancel_feedback"])
      .limit(QUERY_LIMIT);
    throwOnError("lifecycle_email_sends query failed", error);
    for (const row of (data ?? []) as Array<{ user_id: string; email_key: string }>) {
      alreadySent.add(`${row.user_id}:${row.email_key}`);
    }
  }

  const planned: Array<{ userId: string; key: FeedbackEmailKey }> = [];
  for (const userId of userIds) {
    const key = dueByUser.get(userId)!;
    if (alreadySent.has(`${userId}:${key}`)) {
      summary.skipped_already_sent += 1;
      continue;
    }
    planned.push({ userId, key });
  }
  if (planned.length > batchSize) {
    summary.capHit = true;
    planned.length = batchSize;
  }

  for (const { userId, key } of planned) {
    try {
      if (!clerkSecret) {
        summary.skipped_no_email += 1;
        continue;
      }
      const recipient = await resolveClerkRecipient(clerkSecret, userId);
      if (!recipient) {
        summary.skipped_no_email += 1;
        continue;
      }
      const res = await sendFeedbackEmail(key, {
        email: recipient.email,
        firstName: recipient.firstName,
        idempotencyKey: `feedback_${key}_${userId}`,
      });
      if (!res.sent) {
        summary.failed += 1;
        continue;
      }
      const { error: insertErr } = await db
        .from("lifecycle_email_sends")
        .upsert(
          { user_id: userId, email_key: key },
          { onConflict: "user_id,email_key", ignoreDuplicates: true }
        );
      if (insertErr) {
        summary.failed += 1;
        log.warn("feedback email sent but ledger insert failed", {
          source: LOG_SOURCE,
          userId,
          emailKey: key,
          errorMessage: insertErr.message,
        });
        continue;
      }
      summary[key] += 1;
      posthogClient.capture({
        distinctId: userId,
        event: "feedback_email_sent",
        properties: { email_key: key, $insert_id: `feedback_email_sent_${key}_${userId}` },
      });
    } catch (err) {
      summary.failed += 1;
      log.warn("feedback email send failed", {
        source: LOG_SOURCE,
        userId,
        emailKey: key,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }

  try {
    await posthogClient.flush();
  } catch (err) {
    log.warn("feedback-email-sweep: posthog flush failed", {
      source: LOG_SOURCE,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }
  return summary;
}
