/**
 * Apple subscription reconciler — the Apple lane's equivalent of
 * subscription-grace-reconciler.ts.
 *
 * Why this exists
 * ---------------
 * Every lifecycle transition on the Apple lane depends on Apple successfully
 * delivering an App Store Server Notification AND our handler processing it.
 * A dropped EXPIRED (or a notification that arrived before the attach binding
 * existed and exhausted Apple's retry schedule) strands a row in an
 * access-granting status forever — exactly the failure mode the Stripe grace
 * reconciler exists for, and exactly what the old skipped-non-`sub_`-rows gap
 * did to lapsed manual rows.
 *
 * What it does
 * ------------
 * Finds apple_iap_subscriptions rows in a non-terminal status whose
 * current_period_end has passed, asks the App Store Server API for the live
 * subscription status (Get All Subscription Statuses by
 * originalTransactionId — the platform, never the DB row, is the source of
 * truth), and converges each row through the SAME state-machine primitives
 * the webhook uses (activate / grace / billing-retry / expire / revoke), so
 * DB state and instance side effects are identical to the happy path.
 *
 * Idempotent: a row converged to a terminal status no longer matches the
 * scan; an ACTIVE convergence's credit grant dedupes on the per-period
 * reference.
 */

import type {
  AppStoreServerAPIClient,
  SignedDataVerifier,
} from "@apple/app-store-server-library";

import { supabaseAdmin } from "@/lib/supabase";
import { log } from "@/lib/logger";
import {
  APPLE_NON_TERMINAL_STATUSES,
  type AppleEnvironment,
} from "@/lib/billing/apple-products";
import {
  getAppStoreServerAPIClient,
  getAppleSignedDataVerifier,
} from "@/lib/billing/apple-verifier";
import { AppleWebhookService } from "@/lib/services/apple-webhook-service";

export const APPLE_RECONCILER_LOG_SOURCE = "apple-subscription-reconciler";

/** App Store Server API status codes (Status enum). */
const APPLE_STATUS_ACTIVE = 1;
const APPLE_STATUS_EXPIRED = 2;
const APPLE_STATUS_BILLING_RETRY = 3;
const APPLE_STATUS_BILLING_GRACE_PERIOD = 4;
const APPLE_STATUS_REVOKED = 5;

interface AppleReconcileEntry {
  userId: string;
  originalTransactionId: string;
  /** Live App Store status code, or "missing" when Apple has no record. */
  liveAppleStatus: number | "missing" | "unknown";
  action:
    | "converged_active"
    | "converged_grace"
    | "converged_billing_retry"
    | "converged_expired"
    | "converged_revoked"
    | "skipped_stale"
    | "manual_review"
    | "error";
  detail?: string;
}

export interface AppleReconcileResult {
  scanned: number;
  converged: number;
  manualReview: number;
  skipped: number;
  errors: number;
  entries: AppleReconcileEntry[];
}

interface StrandedAppleRow {
  user_id: string;
  apple_original_transaction_id: string;
  status: string;
  environment: string;
  current_period_end: string | null;
}

export interface AppleReconcilerDeps {
  getClient?: (environment: AppleEnvironment) => AppStoreServerAPIClient;
  getVerifier?: (environment: AppleEnvironment) => SignedDataVerifier;
}

function toEnvironment(value: string): AppleEnvironment {
  return value === "Sandbox" ? "Sandbox" : "Production";
}

/**
 * Reconcile stranded Apple subscription rows against the App Store Server API.
 *
 * @param nowIso ISO timestamp treated as "now" (injectable for tests).
 * @param deps   Client/verifier factories (injectable for tests).
 */
export async function reconcileAppleSubscriptions(
  nowIso: string = new Date().toISOString(),
  deps: AppleReconcilerDeps = {}
): Promise<AppleReconcileResult> {
  const result: AppleReconcileResult = {
    scanned: 0,
    converged: 0,
    manualReview: 0,
    skipped: 0,
    errors: 0,
    entries: [],
  };

  if (!supabaseAdmin) {
    log.error(
      "supabaseAdmin not configured; skipping apple reconcile",
      new Error("supabaseAdmin missing"),
      { source: APPLE_RECONCILER_LOG_SOURCE }
    );
    return result;
  }

  const { data: rows, error } = await supabaseAdmin
    .from("apple_iap_subscriptions")
    .select(
      "user_id, apple_original_transaction_id, status, environment, current_period_end"
    )
    .in("status", APPLE_NON_TERMINAL_STATUSES as unknown as string[])
    .not("current_period_end", "is", null)
    .lt("current_period_end", nowIso);

  if (error) {
    log.error("failed to query stranded apple subscription rows", error, {
      source: APPLE_RECONCILER_LOG_SOURCE,
      failureType: "apple_reconcile_query_failed",
    });
    result.errors += 1;
    return result;
  }

  const stranded = (rows as StrandedAppleRow[] | null) ?? [];
  result.scanned = stranded.length;

  const getClient = deps.getClient ?? getAppStoreServerAPIClient;
  const getVerifier = deps.getVerifier ?? getAppleSignedDataVerifier;

  for (const row of stranded) {
    const entry: AppleReconcileEntry = {
      userId: row.user_id,
      originalTransactionId: row.apple_original_transaction_id,
      liveAppleStatus: "unknown",
      action: "error",
    };

    try {
      const environment = toEnvironment(row.environment);
      const client = getClient(environment);

      let statusResponse;
      try {
        statusResponse = await client.getAllSubscriptionStatuses(
          row.apple_original_transaction_id
        );
      } catch (apiError) {
        // 4040010 TransactionIdNotFoundError / any 404-family: Apple has no
        // record for this transaction. Never guess destructive: surface for
        // a human instead of expiring on our own say-so.
        const httpStatus = (apiError as { httpStatusCode?: number })?.httpStatusCode;
        if (httpStatus === 404) {
          entry.liveAppleStatus = "missing";
          entry.action = "manual_review";
          entry.detail = "App Store has no record of this transaction";
          result.manualReview += 1;
          result.entries.push(entry);
          continue;
        }
        throw apiError;
      }

      // Locate the lastTransactions item for our subscription.
      const lastTransaction = (statusResponse.data ?? [])
        .flatMap((group) => group.lastTransactions ?? [])
        .find(
          (item) =>
            item.originalTransactionId === row.apple_original_transaction_id
        );

      if (!lastTransaction || typeof lastTransaction.status !== "number") {
        entry.liveAppleStatus = "missing";
        entry.action = "manual_review";
        entry.detail = "no lastTransactions entry for originalTransactionId";
        result.manualReview += 1;
        result.entries.push(entry);
        continue;
      }

      entry.liveAppleStatus = lastTransaction.status;

      const verifier = getVerifier(environment);
      const transaction = lastTransaction.signedTransactionInfo
        ? await verifier.verifyAndDecodeTransaction(
            lastTransaction.signedTransactionInfo
          )
        : null;
      const renewalInfo = lastTransaction.signedRenewalInfo
        ? await verifier.verifyAndDecodeRenewalInfo(
            lastTransaction.signedRenewalInfo
          )
        : null;

      switch (lastTransaction.status) {
        case APPLE_STATUS_ACTIVE: {
          if (!transaction) {
            entry.action = "manual_review";
            entry.detail = "live status ACTIVE but no signedTransactionInfo";
            result.manualReview += 1;
            break;
          }
          const outcome = await AppleWebhookService.activateFromTransaction({
            userId: row.user_id,
            transaction,
            renewalInfo,
            environment,
            notificationType: "RECONCILE_ACTIVE",
          });
          if (outcome.action === "skipped_stale") {
            entry.action = "skipped_stale";
            result.skipped += 1;
          } else {
            entry.action = "converged_active";
            result.converged += 1;
          }
          break;
        }
        case APPLE_STATUS_BILLING_GRACE_PERIOD: {
          await AppleWebhookService.markGracePeriod({
            userId: row.user_id,
            renewalInfo,
            notificationType: "RECONCILE_GRACE_PERIOD",
          });
          entry.action = "converged_grace";
          result.converged += 1;
          break;
        }
        case APPLE_STATUS_BILLING_RETRY: {
          await AppleWebhookService.markBillingRetry(
            row.user_id,
            "RECONCILE_BILLING_RETRY"
          );
          entry.action = "converged_billing_retry";
          result.converged += 1;
          break;
        }
        case APPLE_STATUS_EXPIRED: {
          await AppleWebhookService.expireSubscription(
            row.user_id,
            "RECONCILE_EXPIRED"
          );
          entry.action = "converged_expired";
          result.converged += 1;
          break;
        }
        case APPLE_STATUS_REVOKED: {
          await AppleWebhookService.revokeSubscription(
            row.user_id,
            "RECONCILE_REVOKED"
          );
          entry.action = "converged_revoked";
          result.converged += 1;
          break;
        }
        default: {
          entry.action = "manual_review";
          entry.detail = `unrecognized App Store status ${lastTransaction.status}`;
          result.manualReview += 1;
        }
      }

      result.entries.push(entry);
    } catch (err) {
      log.error("apple reconcile failed for row", err, {
        source: APPLE_RECONCILER_LOG_SOURCE,
        failureType: "apple_reconcile_row_failed",
        userId: row.user_id,
        originalTransactionId: row.apple_original_transaction_id,
      });
      entry.action = "error";
      entry.detail = err instanceof Error ? err.message : String(err);
      result.errors += 1;
      result.entries.push(entry);
    }
  }

  if (result.converged > 0 || result.manualReview > 0 || result.errors > 0) {
    log.info("apple reconcile pass complete", {
      source: APPLE_RECONCILER_LOG_SOURCE,
      scanned: result.scanned,
      converged: result.converged,
      manualReview: result.manualReview,
      skipped: result.skipped,
      errors: result.errors,
    });
  }

  return result;
}
