/**
 * Yearly token-subscription expiry cron.
 *
 * Four passes per tick:
 *
 *   1. Pre-expiry warning — for active subs whose expires_at is within
 *      7 days AND no expiry_warning_email_sent_at, send the
 *      "expiring soon" email and stamp the timestamp.
 *
 *   2. Move to grace — active subs whose expires_at has passed flip
 *      'active' -> 'grace'. Tier access continues during grace.
 *
 *   3. Move to expired — grace subs whose expires_at + 7 days has passed flip
 *      'grace' -> 'expired'. This is driven by the DATE alone: entitlement
 *      ends on time whether or not an email can be delivered.
 *
 *   4. Ended email — expired subs whose "ended" email has not gone out yet
 *      are emailed and stamped; a failed send is retried on later ticks for
 *      a bounded window.
 *
 * Transitions are compare-and-set in the UPDATE itself, so a renewal that
 * lands between reads and writes is never moved (and never emailed).
 * Re-running on the same tick is a no-op.
 */

import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import { supabaseAdmin } from "@/lib/supabase";
import { sendYearlyTokenSubscriptionNotification } from "@/lib/email/yearly-token-subscription-notifications";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
// Keep retrying an undelivered "ended" email for this long after the grace
// window closed, then give up (a user with no email address never gets one).
const ENDED_EMAIL_RETRY_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const PASS_LIMIT = 200;

interface SubRow {
  id: string;
  user_id: string;
  tier: "pro" | "power";
  expires_at: string;
  status: "active" | "grace" | "expired" | "cancelled" | "renewed";
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
    .order("expires_at", { ascending: true })
    .limit(PASS_LIMIT);
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
      // Only stamp on a SUCCESSFUL send, so a Resend outage is retried next
      // tick (the window is days wide).
      await supabaseAdmin
        .from("yearly_token_subscriptions")
        .update({ expiry_warning_email_sent_at: now.toISOString(), updated_at: now.toISOString() })
        .eq("id", row.id)
        .is("expiry_warning_email_sent_at", null);
    } else {
      warnFailed += 1;
    }
  }

  // ─── Pass 2: active rows past their end move into grace ────────────
  const { data: graced, error: graceErr } = await supabaseAdmin
    .from("yearly_token_subscriptions")
    .update({ status: "grace", updated_at: now.toISOString() })
    .eq("status", "active")
    .lt("expires_at", now.toISOString())
    .select("id");
  if (graceErr) {
    throw new Error(`grace transition failed: ${graceErr.message || graceErr.code || "unknown"}`);
  }
  const movedToGrace = Array.isArray(graced) ? graced.length : 0;

  // ─── Pass 3: grace rows past their grace window expire ─────────────
  const { data: expiredRows, error: expireErr } = await supabaseAdmin
    .from("yearly_token_subscriptions")
    .update({ status: "expired", updated_at: now.toISOString() })
    .eq("status", "grace")
    .lt("expires_at", sevenDaysAgo.toISOString())
    .select("id");
  if (expireErr) {
    throw new Error(`expiry transition failed: ${expireErr.message || expireErr.code || "unknown"}`);
  }
  const expired = Array.isArray(expiredRows) ? expiredRows.length : 0;

  // ─── Pass 4: "ended" email for expired rows not yet notified ───────
  const retryFloor = new Date(sevenDaysAgo.getTime() - ENDED_EMAIL_RETRY_WINDOW_MS);
  const { data: emailRows, error: emailErr } = await supabaseAdmin
    .from("yearly_token_subscriptions")
    .select("id, user_id, tier, expires_at, status, expiry_warning_email_sent_at, expired_email_sent_at")
    .eq("status", "expired")
    .is("expired_email_sent_at", null)
    .gt("expires_at", retryFloor.toISOString())
    .order("expires_at", { ascending: true })
    .limit(PASS_LIMIT);
  if (emailErr) {
    throw new Error(`ended-email query failed: ${emailErr.message || emailErr.code || "unknown"}`);
  }

  let expiredEmailSent = 0;
  let expiredEmailFailed = 0;
  for (const row of (emailRows as SubRow[] | null) ?? []) {
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
          .eq("id", row.id)
          .is("expired_email_sent_at", null);
      } else {
        expiredEmailFailed += 1;
      }
    } catch {
      expiredEmailFailed += 1;
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
