/**
 * Grace-expiry reconciler for Stripe subscriptions.
 *
 * Why this exists
 * ---------------
 * The `past_due → canceled` transition for a Stripe subscription depends
 * entirely on Stripe successfully delivering a `customer.subscription.deleted`
 * (or `.updated` → canceled) webhook AND our handler processing it. If that
 * webhook is ever dropped, retried-past-its-window, or fails mid-flight, the
 * `hermes_subscriptions` row is stranded at `status='past_due'` with a
 * `grace_period_ends_at` in the past — forever. Nothing else reads
 * `grace_period_ends_at`, so there is no self-healing path.
 *
 * Observed impact: a Power-tier token holder cancelled their monthly Command
 * plan; Stripe marked the sub canceled but the DB row stayed `past_due` with
 * `instance_limit = 0`. Because the entitlement resolver treated the degraded
 * row as authoritative, it masked the user's valid token tier and surfaced
 * "Your Command Plan allows 0 agents." (The resolver guard in
 * instance-entitlement.ts now prevents the masking; this reconciler removes
 * the stranded row entirely so state is correct, not just papered over.)
 *
 * What it does
 * ------------
 * Finds `hermes_subscriptions` rows where status is in a "grace-bearing"
 * state (`past_due`) and `grace_period_ends_at` has passed. For each, it
 * fetches the live Stripe subscription and, when Stripe reports a terminal
 * state (canceled / unpaid / incomplete_expired / missing), routes the row
 * through the SAME canonical `handleSubscriptionDeleted` path the webhook uses
 * — so DB state and instance cleanup are byte-for-byte identical to the happy
 * path. Rows whose Stripe sub is somehow active again are left untouched (the
 * webhook will have already corrected them).
 *
 * Idempotent: a row already synced to `canceled` no longer matches the query,
 * so re-running on the same tick is a no-op.
 */

import Stripe from "stripe";

import { getStripe } from "@/lib/stripe";
import { supabaseAdmin } from "@/lib/supabase";
import { log } from "@/lib/logger";
import { StripeWebhookService } from "@/lib/services/stripe-webhook-service";
import { enforceGraceExpiredComputeStop } from "@/lib/recovery/dunning-grace-enforce";

export const GRACE_RECONCILER_LOG_SOURCE = "subscription-grace-reconciler";

/** Stripe statuses that mean "this sub no longer grants access." */
const TERMINAL_STRIPE_STATUSES = new Set<Stripe.Subscription.Status>([
  "canceled",
  "unpaid",
  "incomplete_expired",
]);

/** Internal statuses that carry a grace window we should reconcile. */
const GRACE_BEARING_STATUSES = ["past_due"] as const;

interface GraceReconcileEntry {
  userId: string;
  subscriptionId: string | null;
  /** Live Stripe status, or "missing" when the sub no longer exists. */
  liveStripeStatus: string;
  action:
    | "synced_canceled"
    | "skipped_active"
    | "skipped_no_stripe_id"
    | "enforced_stopped"
    | "error";
  detail?: string;
}

export interface GraceReconcileResult {
  scanned: number;
  syncedCanceled: number;
  skipped: number;
  errors: number;
  /** VMs actually powered off by the grace-expiry compute enforcer. */
  enforcedStopped: number;
  entries: GraceReconcileEntry[];
}

interface StrandedRow {
  user_id: string;
  status: string;
  plan: string;
  instance_limit: number;
  stripe_subscription_id: string | null;
  grace_period_ends_at: string | null;
}

/**
 * Reconcile stranded grace-expired subscription rows against live Stripe.
 *
 * @param nowIso ISO timestamp treated as "now" (injectable for tests).
 */
export async function reconcileSubscriptionGrace(
  nowIso: string = new Date().toISOString()
): Promise<GraceReconcileResult> {
  const result: GraceReconcileResult = {
    scanned: 0,
    syncedCanceled: 0,
    skipped: 0,
    errors: 0,
    enforcedStopped: 0,
    entries: [],
  };

  if (!supabaseAdmin) {
    log.error(
      "supabaseAdmin not configured; skipping grace reconcile",
      new Error("supabaseAdmin missing"),
      { source: GRACE_RECONCILER_LOG_SOURCE }
    );
    return result;
  }

  const { data: rows, error } = await supabaseAdmin
    .from("hermes_subscriptions")
    .select(
      "user_id, status, plan, instance_limit, stripe_subscription_id, grace_period_ends_at"
    )
    .in("status", GRACE_BEARING_STATUSES as unknown as string[])
    .not("grace_period_ends_at", "is", null)
    .lt("grace_period_ends_at", nowIso);

  if (error) {
    log.error("failed to query stranded grace rows", error, {
      source: GRACE_RECONCILER_LOG_SOURCE,
      failureType: "grace_query_failed",
    });
    result.errors += 1;
    return result;
  }

  const stranded = (rows as StrandedRow[] | null) ?? [];
  result.scanned = stranded.length;

  for (const row of stranded) {
    const entry: GraceReconcileEntry = {
      userId: row.user_id,
      subscriptionId: row.stripe_subscription_id,
      liveStripeStatus: "unknown",
      action: "error",
    };

    try {
      if (!row.stripe_subscription_id) {
        // A grace-expired row with no Stripe sub id can't be reconciled
        // against Stripe. Leave it for manual review rather than guessing.
        entry.action = "skipped_no_stripe_id";
        entry.liveStripeStatus = "missing";
        result.skipped += 1;
        result.entries.push(entry);
        continue;
      }

      const stripe = getStripe();
      let subscription: Stripe.Subscription | null = null;
      try {
        subscription = await stripe.subscriptions.retrieve(
          row.stripe_subscription_id
        );
      } catch (err) {
        // resource_missing → the sub was deleted at Stripe and we never
        // synced. Treat as terminal: synthesize the minimal shape
        // handleSubscriptionDeleted needs (id + metadata.user_id).
        const code =
          err instanceof Stripe.errors.StripeError ? err.code : undefined;
        if (code === "resource_missing") {
          entry.liveStripeStatus = "missing";
          await StripeWebhookService.handleSubscriptionDeleted({
            id: row.stripe_subscription_id,
            metadata: { user_id: row.user_id },
          } as unknown as Stripe.Subscription);
          entry.action = "synced_canceled";
          entry.detail = "stripe resource_missing";
          result.syncedCanceled += 1;
          result.entries.push(entry);
          continue;
        }
        throw err;
      }

      entry.liveStripeStatus = subscription.status;

      if (TERMINAL_STRIPE_STATUSES.has(subscription.status)) {
        // Route through the canonical handler so DB + instance cleanup
        // match the webhook path exactly. Ensure metadata.user_id is set
        // (older subs may lack it) so the handler targets the right user.
        const withMeta = {
          ...subscription,
          metadata: {
            ...(subscription.metadata ?? {}),
            user_id: subscription.metadata?.user_id ?? row.user_id,
          },
        } as Stripe.Subscription;
        await StripeWebhookService.handleSubscriptionDeleted(withMeta);
        entry.action = "synced_canceled";
        entry.detail = `stripe status ${subscription.status}`;
        result.syncedCanceled += 1;
      } else if (subscription.status === "past_due") {
        // Grace has EXPIRED on our side (this row matched
        // grace_period_ends_at < now) but Stripe is still smart-retrying — it
        // hasn't given up, so we must NOT cancel the sub. The entitlement
        // resolver has already lapsed access for a grace-expired past_due row;
        // now make compute ACTUALLY stop. A billing suspend only flips DB flags
        // and leaves the VM running + reachable over the direct WS lane, so a
        // failed-payment user kept full Pro compute for the whole retry window.
        // enforceGraceExpiredComputeStop is dark-flagged (DUNNING_GRACE_ENFORCE_LIVE)
        // and entitlement-guarded (skips users who still hold a token/yearly tier).
        const enforce = await enforceGraceExpiredComputeStop(row.user_id);
        entry.action = "enforced_stopped";
        entry.detail = `grace expired, stripe still past_due → ${enforce.outcome} (${enforce.affected})`;
        result.enforcedStopped += enforce.affected > 0 && enforce.outcome === "stopped"
          ? enforce.affected
          : 0;
        result.skipped += 1;
      } else {
        // Stripe considers this sub live again (active/trialing) — the user
        // paid and recovered. Don't override Stripe's truth.
        entry.action = "skipped_active";
        result.skipped += 1;
      }
      result.entries.push(entry);
    } catch (err) {
      log.error("grace reconcile failed for row", err, {
        source: GRACE_RECONCILER_LOG_SOURCE,
        failureType: "grace_reconcile_row_failed",
        userId: row.user_id,
        subscriptionId: row.stripe_subscription_id,
      });
      entry.action = "error";
      entry.detail = err instanceof Error ? err.message : String(err);
      result.errors += 1;
      result.entries.push(entry);
    }
  }

  if (result.syncedCanceled > 0 || result.errors > 0) {
    log.info("grace reconcile pass complete", {
      source: GRACE_RECONCILER_LOG_SOURCE,
      scanned: result.scanned,
      syncedCanceled: result.syncedCanceled,
      skipped: result.skipped,
      errors: result.errors,
    });
  }

  return result;
}
