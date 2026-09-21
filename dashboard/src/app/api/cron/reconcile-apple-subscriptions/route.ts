/**
 * Apple subscription reconciler cron.
 *
 * Self-heals apple_iap_subscriptions rows stranded in a non-terminal status
 * past their current_period_end — the failure mode when an App Store Server
 * Notification (EXPIRED, DID_RENEW, …) is dropped or exhausts Apple's retry
 * schedule. See apple-subscription-reconciler.ts for the full rationale;
 * shape mirrors /api/cron/reconcile-subscription-grace.
 *
 * Idempotent: converged rows no longer match the scan; credit grants dedupe
 * on the per-period ledger reference.
 */

import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";
import { reportOpsEvent } from "@/lib/ops-events";
import {
  APPLE_RECONCILER_LOG_SOURCE,
  reconcileAppleSubscriptions,
} from "@/lib/billing/apple-subscription-reconciler";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error(
      "CRON_SECRET is not configured; refusing to run",
      new Error("CRON_SECRET missing"),
      {
        source: APPLE_RECONCILER_LOG_SOURCE,
        route: "/api/cron/reconcile-apple-subscriptions",
        method: "GET",
        failureType: "cron_secret_missing",
      }
    );
    return apiError("Cron secret is not configured", 500);
  }
  if (!verifyBearerHeader(req, cronSecret)) {
    return apiError("Unauthorized", 401);
  }
  if (!supabaseAdmin) {
    return apiError("Database not configured", 500);
  }

  try {
    const result = await reconcileAppleSubscriptions();

    // A converged row means a notification was dropped — a low-severity
    // breadcrumb makes a bulk pattern visible in the ops feed.
    if (result.converged > 0) {
      await reportOpsEvent({
        source: APPLE_RECONCILER_LOG_SOURCE,
        severity: "warn",
        title: `Reconciled ${result.converged} stranded Apple subscription row(s)`,
        message:
          `${result.converged} apple_iap_subscriptions row(s) were past their ` +
          `period end while the App Store reported a different live status. ` +
          `Converged through the canonical state machine. A dropped App Store ` +
          `Server Notification is the likely cause.`,
        route: "/api/cron/reconcile-apple-subscriptions",
        metadata: {
          failureType: "stranded_apple_subscription_reconciled",
          scanned: result.scanned,
          converged: result.converged,
          manualReview: result.manualReview,
          skipped: result.skipped,
          errors: result.errors,
        },
      });
    }

    // Escalate independently on rows Apple can't account for and on rows that
    // fail every tick — either keeps a lapsed subscriber on paid access.
    if (result.manualReview > 0 || result.errors > 0) {
      await reportOpsEvent({
        source: APPLE_RECONCILER_LOG_SOURCE,
        severity: "warn",
        title: `Apple reconcile needs attention (${result.manualReview} manual, ${result.errors} errors)`,
        message:
          `${result.manualReview} row(s) had no matching App Store record and ` +
          `${result.errors} row(s) failed to converge this run. A row that ` +
          `fails every tick keeps a lapsed Apple subscriber on stale paid access.`,
        route: "/api/cron/reconcile-apple-subscriptions",
        metadata: {
          failureType: "apple_reconcile_attention",
          scanned: result.scanned,
          converged: result.converged,
          manualReview: result.manualReview,
          skipped: result.skipped,
          errors: result.errors,
        },
      });
    }

    return apiSuccess({
      scanned: result.scanned,
      converged: result.converged,
      manualReview: result.manualReview,
      skipped: result.skipped,
      errors: result.errors,
    });
  } catch (err) {
    log.error("reconcile-apple-subscriptions failed", err, {
      source: APPLE_RECONCILER_LOG_SOURCE,
      route: "/api/cron/reconcile-apple-subscriptions",
      method: "GET",
      failureType: "apple_reconcile_failed",
    });
    const message = err instanceof Error ? err.message : "Apple reconcile failed";
    return apiError(message, 500);
  }
}
