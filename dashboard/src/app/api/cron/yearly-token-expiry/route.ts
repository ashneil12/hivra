/**
 * Yearly token-subscription expiry cron.
 *
 * Three passes per tick:
 *
 *   1. Pre-expiry warning — for active subs whose expires_at is within
 *      7 days AND no expiry_warning_email_sent_at, send the
 *      "expiring soon" email and stamp the timestamp.
 *
 *   2. Move to grace — for active subs whose expires_at has just passed,
 *      flip status='active' → 'grace'. Tier access continues during
 *      grace via provisioning-entitlements.
 *
 *   3. Move to expired — for grace subs whose expires_at + 7 days has
 *      passed, flip status='grace' → 'expired' and send the "ended"
 *      email. provisioning-entitlements stops granting tier access at
 *      this point.
 *
 * All passes are idempotent. Re-running on the same tick is a no-op.
 */

import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import { supabaseAdmin } from "@/lib/supabase";
import { sendYearlyTokenSubscriptionNotification } from "@/lib/email/yearly-token-subscription-notifications";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

interface SubRow {
  id: string;
  user_id: string;
  tier: "pro" | "power";
  expires_at: string;
  status: "active" | "grace" | "expired" | "cancelled";
  expiry_warning_email_sent_at: string | null;
  expired_email_sent_at: string | null;
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error("CRON_SECRET is not configured; refusing to run", new Error("missing CRON_SECRET"), {
      source: "yearly-token-expiry",
      route: "/api/cron/yearly-token-expiry",
      method: "GET",
    });
    return apiError("Cron secret not configured", 500);
  }
  if (!verifyBearerHeader(req, cronSecret)) {
    return apiError("Unauthorized", 401);
  }
  if (!supabaseAdmin) {
    return apiError("Database not configured", 500);
  }

  const now = new Date();
  const sevenDaysFromNow = new Date(now.getTime() + SEVEN_DAYS_MS);
  const sevenDaysAgo = new Date(now.getTime() - SEVEN_DAYS_MS);

  try {
    return await runYearlyTokenExpiry(now, sevenDaysFromNow, sevenDaysAgo);
  } catch (error) {
    // No top-level guard previously: an unexpected throw mid-pass returned an
    // unstructured 500 and left later passes unrun for the day with no signal.
    log.error("yearly-token-expiry cron failed", error, {
      source: "yearly-token-expiry",
      route: "/api/cron/yearly-token-expiry",
      method: "GET",
      failureType: "yearly_token_expiry_failed",
    });
    await reportOpsEvent({
      source: "cron.yearly-token-expiry",
      severity: "warn",
      title: "Yearly token expiry cron failed",
      message:
        "yearly-token-expiry threw before completing. Pre-expiry warnings, grace " +
        "transitions, and expirations may be partially or fully skipped for this run.",
      route: "/api/cron/yearly-token-expiry",
      metadata: {
        failureType: "yearly_token_expiry_failed",
        errorName: error instanceof Error ? error.name : typeof error,
      },
    });
    return apiError("Yearly token expiry cron failed", 500, {
      failureType: "yearly_token_expiry_failed",
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}

async function runYearlyTokenExpiry(
  now: Date,
  sevenDaysFromNow: Date,
  sevenDaysAgo: Date,
) {
  if (!supabaseAdmin) {
    return apiError("Database not configured", 500);
  }

  // ─── Pass 1: pre-expiry warning emails ─────────────────────────────
  const { data: warnRows, error: warnErr } = await supabaseAdmin
    .from("yearly_token_subscriptions")
    .select("id, user_id, tier, expires_at, status, expiry_warning_email_sent_at, expired_email_sent_at")
    .eq("status", "active")
    .is("expiry_warning_email_sent_at", null)
    .lt("expires_at", sevenDaysFromNow.toISOString())
    .gt("expires_at", now.toISOString())
    .limit(100);
  // A query failure must NOT be treated as "zero rows" — that silently skips
  // every warning this run. Throw so the top-level guard logs + ops-events it.
  if (warnErr) {
    throw new Error(`warn-row query failed: ${warnErr.message || warnErr.code || "unknown"}`);
  }

  let warnSent = 0;
  let warnFailed = 0;
  for (const row of (warnRows as SubRow[] | null) ?? []) {
    const result = await sendYearlyTokenSubscriptionNotification({
      userId: row.user_id,
      tier: row.tier,
      transition: "expiring_soon",
      expiresAt: new Date(row.expires_at),
    });
    if (result.sent) {
      warnSent += 1;
      // Only stamp the sent-timestamp on a SUCCESSFUL send. Stamping
      // unconditionally meant a Resend outage permanently suppressed the
      // warning (the row would never re-match this SELECT). Leaving it null on
      // failure lets the next tick retry; the row stays eligible because the
      // expires_at window is days wide, so a few retries won't spam users.
      await supabaseAdmin
        .from("yearly_token_subscriptions")
        .update({ expiry_warning_email_sent_at: now.toISOString(), updated_at: now.toISOString() })
        .eq("id", row.id);
    } else {
      warnFailed += 1;
    }
  }

  // ─── Pass 2: move expired-but-still-active rows into grace ─────────
  const { data: graceCandidates, error: graceErr } = await supabaseAdmin
    .from("yearly_token_subscriptions")
    .select("id")
    .eq("status", "active")
    .lt("expires_at", now.toISOString())
    .limit(200);
  if (graceErr) {
    throw new Error(`grace-candidate query failed: ${graceErr.message || graceErr.code || "unknown"}`);
  }

  let movedToGrace = 0;
  if (graceCandidates && graceCandidates.length > 0) {
    const ids = (graceCandidates as { id: string }[]).map((r) => r.id);
    const { error } = await supabaseAdmin
      .from("yearly_token_subscriptions")
      .update({ status: "grace", updated_at: now.toISOString() })
      .in("id", ids);
    if (!error) movedToGrace = ids.length;
  }

  // ─── Pass 3: expire grace rows past their grace window ─────────────
  const { data: expireRows, error: expireErr } = await supabaseAdmin
    .from("yearly_token_subscriptions")
    .select("id, user_id, tier, expires_at, status, expiry_warning_email_sent_at, expired_email_sent_at")
    .eq("status", "grace")
    .lt("expires_at", sevenDaysAgo.toISOString())
    .limit(100);
  if (expireErr) {
    throw new Error(`expire-row query failed: ${expireErr.message || expireErr.code || "unknown"}`);
  }

  let expired = 0;
  let expiredEmailSent = 0;
  let expiredEmailFailed = 0;
  for (const row of (expireRows as SubRow[] | null) ?? []) {
    // ORDER MATTERS: send the expiry email BEFORE flipping status to
    // 'expired'. Previously the row was flipped first, so if the email
    // send threw (Resend hiccup, env missing) the row was 'expired'
    // with no email sent — and the next tick's SELECT requires
    // `status='grace'`, so the row was excluded forever. User got no
    // notification, and there was no obvious recovery path.
    let emailWritten = false;
    if (!row.expired_email_sent_at) {
      try {
        const result = await sendYearlyTokenSubscriptionNotification({
          userId: row.user_id,
          tier: row.tier,
          transition: "expired",
          expiresAt: new Date(row.expires_at),
        });
        if (result.sent) {
          expiredEmailSent += 1;
          await supabaseAdmin
            .from("yearly_token_subscriptions")
            .update({ expired_email_sent_at: now.toISOString(), updated_at: now.toISOString() })
            .eq("id", row.id);
          emailWritten = true;
        } else {
          expiredEmailFailed += 1;
        }
      } catch {
        expiredEmailFailed += 1;
      }
    }

    // Only flip to 'expired' if either the email already went out or
    // we just wrote `expired_email_sent_at`. If the email failed AND
    // we haven't written it yet, leave the row as 'grace' so the next
    // tick retries the email. The grace window is 7 days, so a few
    // missed cron ticks worth of retries is fine.
    if (row.expired_email_sent_at || emailWritten) {
      await supabaseAdmin
        .from("yearly_token_subscriptions")
        .update({ status: "expired", updated_at: now.toISOString() })
        .eq("id", row.id);
      expired += 1;
    }
  }

  return apiSuccess({
    ranAt: now.toISOString(),
    warningEmails: { sent: warnSent, failed: warnFailed },
    movedToGrace,
    expired,
    expiredEmails: { sent: expiredEmailSent, failed: expiredEmailFailed },
  });
}
