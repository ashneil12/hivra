/**
 * Subscription grace-expiry reconciler cron.
 *
 * Self-heals `hermes_subscriptions` rows stranded at `status='past_due'` with
 * an expired `grace_period_ends_at` — the failure mode that occurs when a
 * `customer.subscription.deleted` webhook is dropped and the row never
 * transitions to `canceled`. See subscription-grace-reconciler.ts for the
 * full rationale and the incident that motivated it.
 *
 * Runs every 15 minutes. Idempotent: once a row is synced to canceled it no
 * longer matches the query.
 */

import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";
import { reportOpsEvent } from "@/lib/ops-events";
import {
  GRACE_RECONCILER_LOG_SOURCE,
  reconcileSubscriptionGrace,
} from "@/lib/billing/subscription-grace-reconciler";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error(
      "CRON_SECRET is not configured; refusing to run",
      new Error("CRON_SECRET missing"),
      {
        source: GRACE_RECONCILER_LOG_SOURCE,
        route: "/api/cron/reconcile-subscription-grace",
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
    const result = await reconcileSubscriptionGrace();

    // Surface any reconciled rows in the ops feed — a non-zero count means a
    // webhook was dropped, which is worth a single low-severity breadcrumb so
    // the pattern is visible if it starts happening in bulk.
    if (result.syncedCanceled > 0) {
      await reportOpsEvent({
        source: GRACE_RECONCILER_LOG_SOURCE,
        severity: "warn",
        title: `Reconciled ${result.syncedCanceled} stranded subscription row(s)`,
        message:
          `${result.syncedCanceled} subscription row(s) were stuck at past_due ` +
          `past their grace window while Stripe reported them terminal. ` +
          `Synced to canceled via the canonical handler. A dropped ` +
          `customer.subscription.deleted webhook is the likely cause.`,
        route: "/api/cron/reconcile-subscription-grace",
        metadata: {
          failureType: "stranded_subscription_reconciled",
          scanned: result.scanned,
          syncedCanceled: result.syncedCanceled,
          skipped: result.skipped,
          errors: result.errors,
        },
      });
    }

    // Independently escalate on sync errors. The breadcrumb above only fires
    // when something synced — a run where every candidate row FAILED to sync
    // (errors>0, syncedCanceled===0) was previously silent, so a repeatedly
    // failing row produced no distinct alert. reportOpsEvent never throws
    // (its own try/catch returns null), so this can't turn a clean reconcile
    // into a 500.
    if (result.errors > 0) {
      await reportOpsEvent({
        source: GRACE_RECONCILER_LOG_SOURCE,
        severity: "warn",
        title: `Grace reconcile hit ${result.errors} sync error(s)`,
        message:
          `${result.errors} stranded past_due row(s) failed to sync to canceled this run. ` +
          `A row that fails every tick keeps a cancelled customer on stale paid access. ` +
          `Investigate the canonical cancel handler / Stripe state for these users.`,
        route: "/api/cron/reconcile-subscription-grace",
        metadata: {
          failureType: "grace_reconcile_errors",
          scanned: result.scanned,
          syncedCanceled: result.syncedCanceled,
          skipped: result.skipped,
          errors: result.errors,
        },
      });
    }

    return apiSuccess({
      scanned: result.scanned,
      syncedCanceled: result.syncedCanceled,
      skipped: result.skipped,
      errors: result.errors,
    });
  } catch (err) {
    log.error("reconcile-subscription-grace failed", err, {
      source: GRACE_RECONCILER_LOG_SOURCE,
      route: "/api/cron/reconcile-subscription-grace",
      method: "GET",
      failureType: "grace_reconcile_failed",
    });
    const message =
      err instanceof Error ? err.message : "Grace reconcile failed";
    return apiError(message, 500);
  }
}
