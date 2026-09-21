import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import { supabaseAdmin } from "@/lib/supabase";
import {
  SUBSCRIPTION_STATE_RECONCILER_LOG_SOURCE,
  reconcileSubscriptionState,
} from "@/lib/billing/subscription-state-reconciler";

const ROUTE = "/api/cron/reconcile-subscription-state";
const MAX_REVIEW_ENTRIES = 25;

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error(
      "CRON_SECRET is not configured; refusing to run",
      new Error("CRON_SECRET missing"),
      {
        source: SUBSCRIPTION_STATE_RECONCILER_LOG_SOURCE,
        route: ROUTE,
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
    const result = await reconcileSubscriptionState();
    const changed =
      result.pendingReset +
      result.paidAccessReset +
      result.canceledTerminalStripe +
      result.pendingActivatedFromStripe;
    const manualReviewEntries = result.entries
      .filter((entry) => entry.action === "manual_review")
      .slice(0, MAX_REVIEW_ENTRIES)
      .map((entry) => ({
        userId: entry.userId,
        plan: entry.plan,
        status: entry.status,
        stripeSubscriptionId: entry.stripeSubscriptionId,
        stripeCustomerId: entry.stripeCustomerId,
      }));

    if (
      changed > 0 ||
      result.manualReview > 0 ||
      result.skippedStaleRow > 0 ||
      result.runtimeRowsChanged > 0 ||
      result.errors > 0
    ) {
      // Raise severity to 'error' when genuine reconcile failures occurred —
      // previously all outcomes (routine resets, manual review, errors) shared
      // 'warn', so an errored run looked like a normal one on the feed.
      const reviewBacklogged = result.manualReview > MAX_REVIEW_ENTRIES;
      await reportOpsEvent({
        source: SUBSCRIPTION_STATE_RECONCILER_LOG_SOURCE,
        severity: result.errors > 0 ? "error" : "warn",
        title:
          result.errors > 0
            ? `Subscription-state reconcile hit ${result.errors} error(s)`
            : "Reconciled stale billing subscription state",
        message:
          `${result.pendingReset} abandoned pending checkout row(s), ` +
          `${result.pendingActivatedFromStripe} Stripe-proven pending row(s) were activated, ` +
          `${result.canceledTerminalStripe} terminal-subscription row(s) were routed through the cancel path, and ` +
          `${result.paidAccessReset} no-subscription paid-access row(s) were reset to Free. ` +
          `${result.runtimeRowsChanged} runtime row(s) changed by the transactional DB reconcile. ` +
          `${result.manualReview} manual/no-Stripe paid row(s) need operator review` +
          `${reviewBacklogged ? ` (only the first ${MAX_REVIEW_ENTRIES} are listed — backlog exceeds the cap)` : ""}. ` +
          `${result.errors} row(s) errored during reconcile.`,
        route: ROUTE,
        metadata: {
          failureType:
            result.errors > 0
              ? "subscription_state_reconcile_errors"
              : "stale_billing_subscription_state_reconciled",
          scanned: result.scanned,
          pendingReset: result.pendingReset,
          paidAccessReset: result.paidAccessReset,
          canceledTerminalStripe: result.canceledTerminalStripe,
          pendingActivatedFromStripe: result.pendingActivatedFromStripe,
          skippedOpenCheckout: result.skippedOpenCheckout,
          skippedRecentPending: result.skippedRecentPending,
          skippedStripeGrant: result.skippedStripeGrant,
          skippedStaleRow: result.skippedStaleRow,
          manualReview: result.manualReview,
          manualReviewEntries,
          manualReviewBacklogged: reviewBacklogged,
          runtimeRowsUpdated: result.runtimeRowsUpdated,
          runtimeRowsChanged: result.runtimeRowsChanged,
          errors: result.errors,
        },
      });
    }

    return apiSuccess({
      scanned: result.scanned,
      pendingReset: result.pendingReset,
      paidAccessReset: result.paidAccessReset,
      canceledTerminalStripe: result.canceledTerminalStripe,
      pendingActivatedFromStripe: result.pendingActivatedFromStripe,
      skippedOpenCheckout: result.skippedOpenCheckout,
      skippedRecentPending: result.skippedRecentPending,
      skippedStripeGrant: result.skippedStripeGrant,
      skippedStaleRow: result.skippedStaleRow,
      manualReview: result.manualReview,
      manualReviewEntries,
      manualReviewBacklogged: result.manualReview > MAX_REVIEW_ENTRIES,
      runtimeRowsUpdated: result.runtimeRowsUpdated,
      runtimeRowsChanged: result.runtimeRowsChanged,
      errors: result.errors,
    });
  } catch (error) {
    log.error("reconcile-subscription-state failed", error, {
      source: SUBSCRIPTION_STATE_RECONCILER_LOG_SOURCE,
      route: ROUTE,
      method: "GET",
      failureType: "subscription_state_reconcile_failed",
    });
    return apiError(
      error instanceof Error ? error.message : "Subscription state reconcile failed",
      500
    );
  }
}

export const POST = GET;
