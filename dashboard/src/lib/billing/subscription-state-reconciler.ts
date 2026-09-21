import Stripe from "stripe";

import { getStripe } from "@/lib/stripe";
import { supabaseAdmin } from "@/lib/supabase";
import { log } from "@/lib/logger";
import { StripeWebhookService } from "@/lib/services/stripe-webhook-service";

export const SUBSCRIPTION_STATE_RECONCILER_LOG_SOURCE = "subscription-state-reconciler";

const PAID_PLANS = ["operator", "fleet", "command"] as const;
const RECONCILED_STATUSES = ["pending", "active", "past_due", "trialing"] as const;
const STRIPE_GRANT_STATUSES = new Set(["active", "trialing", "past_due"]);
const STALE_PENDING_CHECKOUT_WINDOW_MS = 60 * 60 * 1000;

interface SubscriptionStateRow {
  user_id: string;
  plan: string;
  status: string;
  instance_limit: number;
  total_cpu_budget: number;
  total_ram_budget: number;
  stripe_subscription_id: string | null;
  stripe_customer_id: string | null;
  current_period_end: string | null;
  grace_period_ends_at: string | null;
  updated_at: string | null;
}

type ReconcileAction =
  | "reset_pending_abandoned"
  | "reset_terminal_stripe"
  | "canceled_terminal_stripe"
  | "activated_stripe_grant"
  | "skipped_open_checkout"
  | "skipped_recent_pending"
  | "skipped_stripe_grant"
  | "skipped_stale_row"
  | "manual_review"
  | "error";

interface SubscriptionStateReconcileEntry {
  userId: string;
  plan: string;
  status: string;
  stripeSubscriptionId: string | null;
  stripeCustomerId: string | null;
  action: ReconcileAction;
  detail?: string;
}

export interface SubscriptionStateReconcileResult {
  scanned: number;
  pendingReset: number;
  paidAccessReset: number;
  canceledTerminalStripe: number;
  pendingActivatedFromStripe: number;
  skippedOpenCheckout: number;
  skippedRecentPending: number;
  skippedStripeGrant: number;
  skippedStaleRow: number;
  manualReview: number;
  runtimeRowsUpdated: number;
  runtimeRowsChanged: number;
  errors: number;
  entries: SubscriptionStateReconcileEntry[];
}

interface ReconcileRpcResult {
  subscription_updated?: boolean;
  reason?: string;
  instances_updated?: number;
  instances_changed?: number;
  target_tier?: string | null;
}

function emptyResult(): SubscriptionStateReconcileResult {
  return {
    scanned: 0,
    pendingReset: 0,
    paidAccessReset: 0,
    canceledTerminalStripe: 0,
    pendingActivatedFromStripe: 0,
    skippedOpenCheckout: 0,
    skippedRecentPending: 0,
    skippedStripeGrant: 0,
    skippedStaleRow: 0,
    manualReview: 0,
    runtimeRowsUpdated: 0,
    runtimeRowsChanged: 0,
    errors: 0,
    entries: [],
  };
}

function isManualSubscriptionId(subscriptionId: string | null | undefined): boolean {
  return typeof subscriptionId === "string" && subscriptionId.startsWith("manual_");
}

function isStalePending(row: SubscriptionStateRow, nowMs: number): boolean {
  if (row.status !== "pending") return false;
  if (!row.updated_at) return true;
  const updatedMs = new Date(row.updated_at).getTime();
  if (!Number.isFinite(updatedMs)) return true;
  return nowMs - updatedMs > STALE_PENDING_CHECKOUT_WINDOW_MS;
}

async function reconcileRowToFree(row: SubscriptionStateRow, nowIso: string) {
  if (!supabaseAdmin) return { error: new Error("supabaseAdmin missing") };

  const { data, error } = await supabaseAdmin.rpc(
    "reconcile_stale_subscription_state_to_free",
    {
      p_user_id: row.user_id,
      p_observed_plan: row.plan,
      p_observed_status: row.status,
      p_observed_stripe_subscription_id: row.stripe_subscription_id,
      p_observed_updated_at: row.updated_at,
      p_now: nowIso,
    }
  );

  return { data: data as ReconcileRpcResult | null, error };
}

async function hasOpenCheckout(row: SubscriptionStateRow): Promise<boolean> {
  if (!row.stripe_customer_id) return false;
  const stripe = getStripe();
  const sessions = await stripe.checkout.sessions.list({
    customer: row.stripe_customer_id,
    limit: 20,
  });
  return sessions.data.some((session) => session.status === "open");
}

function stripeCustomerId(customer: Stripe.Subscription["customer"]): string | null {
  if (typeof customer === "string") return customer;
  return customer?.id ?? null;
}

function subscriptionBelongsToRow(subscription: Stripe.Subscription, row: SubscriptionStateRow): boolean {
  const metadataUserId = subscription.metadata?.user_id;
  const customerId = stripeCustomerId(subscription.customer);
  const metadataMatches = !metadataUserId || metadataUserId === row.user_id;
  const customerMatches = !row.stripe_customer_id || customerId === row.stripe_customer_id;
  return metadataMatches && customerMatches;
}

function pendingGrantCanBeApplied(subscription: Stripe.Subscription, row: SubscriptionStateRow): boolean {
  const metadataUserId = subscription.metadata?.user_id;
  const metadataPlan = subscription.metadata?.plan;
  return metadataUserId === row.user_id && PAID_PLANS.includes(metadataPlan as typeof PAID_PLANS[number]);
}

interface StripeGrantLookup {
  /** Subscription in a status that grants plan access, if any. */
  live: Stripe.Subscription | null;
  /**
   * The row's own subscription when it exists at Stripe but is terminal
   * (canceled / incomplete_expired / unpaid). Present so terminal rows can be
   * routed through the canonical cancel path instead of a free-reset.
   */
  terminal: Stripe.Subscription | null;
}

async function lookupStripeGrant(row: SubscriptionStateRow): Promise<StripeGrantLookup> {
  if (isManualSubscriptionId(row.stripe_subscription_id)) {
    return { live: null, terminal: null };
  }

  const stripe = getStripe();
  let terminal: Stripe.Subscription | null = null;

  if (row.stripe_subscription_id) {
    try {
      const subscription = await stripe.subscriptions.retrieve(row.stripe_subscription_id);
      if (subscriptionBelongsToRow(subscription, row)) {
        if (STRIPE_GRANT_STATUSES.has(subscription.status)) {
          return { live: subscription, terminal: null };
        }
        terminal = subscription;
      }
    } catch (error) {
      const code = error instanceof Stripe.errors.StripeError ? error.code : undefined;
      if (code !== "resource_missing") throw error;
    }
  }

  // Always fall through to the customer's subscription list. Previously this
  // only ran when the row had NO subscription id, so a stale id pointing at a
  // dead subscription hid the customer's live one and the row was wrongly
  // reset to Free even though the user was still paying.
  if (row.stripe_customer_id) {
    const subscriptions = await stripe.subscriptions.list({
      customer: row.stripe_customer_id,
      status: "all",
      limit: 100,
    });
    const live =
      subscriptions.data.find(
        (subscription) =>
          STRIPE_GRANT_STATUSES.has(subscription.status) &&
          subscriptionBelongsToRow(subscription, row)
      ) ?? null;
    if (live) return { live, terminal: null };
  }

  return { live: null, terminal };
}

function entry(row: SubscriptionStateRow, action: ReconcileAction, detail?: string): SubscriptionStateReconcileEntry {
  return {
    userId: row.user_id,
    plan: row.plan,
    status: row.status,
    stripeSubscriptionId: row.stripe_subscription_id,
    stripeCustomerId: row.stripe_customer_id,
    action,
    detail,
  };
}

async function finalizeReset(
  row: SubscriptionStateRow,
  action: "reset_pending_abandoned" | "reset_terminal_stripe",
  nowIso: string,
  result: SubscriptionStateReconcileResult
): Promise<void> {
  const { data, error: rpcError } = await reconcileRowToFree(row, nowIso);
  if (rpcError) throw rpcError;

  if (!data?.subscription_updated) {
    result.skippedStaleRow += 1;
    result.entries.push(entry(row, "skipped_stale_row", data?.reason ?? "transactional reconcile did not update row"));
    return;
  }

  if (action === "reset_pending_abandoned") result.pendingReset += 1;
  else result.paidAccessReset += 1;

  const runtimeRowsUpdated = data.instances_updated ?? 0;
  const runtimeRowsChanged = data.instances_changed ?? 0;
  result.runtimeRowsUpdated += runtimeRowsUpdated;
  result.runtimeRowsChanged += runtimeRowsChanged;
  result.entries.push(
    entry(
      row,
      action,
      `target_tier=${data.target_tier ?? "unknown"}; runtime_rows_updated=${runtimeRowsUpdated}; runtime_rows_changed=${runtimeRowsChanged}`
    )
  );
}

async function activatePendingStripeGrant(
  row: SubscriptionStateRow,
  subscription: Stripe.Subscription,
  result: SubscriptionStateReconcileResult
): Promise<void> {
  if (!pendingGrantCanBeApplied(subscription, row)) {
    result.manualReview += 1;
    result.entries.push(
      entry(
        row,
        "manual_review",
        `Stripe grant ${subscription.id} is live but missing matching user/plan metadata`
      )
    );
    return;
  }

  await StripeWebhookService.handleSubscriptionChange(subscription);
  result.pendingActivatedFromStripe += 1;
  result.entries.push(
    entry(
      row,
      "activated_stripe_grant",
      `subscription_id=${subscription.id}; stripe_status=${subscription.status}`
    )
  );
}

/**
 * Reconcile subscription-table state that can otherwise accumulate forever:
 *
 * - abandoned paid Checkout rows (`status='pending'`) are reset to Free after
 *   the checkout window when Stripe has no open session and no live sub;
 * - stale pending rows that do have a live Stripe grant are activated through
 *   the canonical Stripe webhook service so missed webhook/confirm retries do
 *   not strand paying users in `pending` forever;
 * - paid-access rows whose own Stripe subscription is terminal are routed
 *   through the canonical cancel path (handleSubscriptionDeleted), preserving
 *   plan + sub id and the paid-cancel suspend ladder; only rows Stripe has no
 *   subscription object for at all are reset to Free;
 * - the DB RPC performs the subscription reset and instance-cap update in one
 *   row-locked transaction, preserving token/yearly entitlement and setting
 *   tier_change_pending for the existing protected resize cron;
 * - manual/no-Stripe paid-access rows are surfaced for operator review instead
 *   of silently revoked, because those can represent intentional legacy comps.
 */
export async function reconcileSubscriptionState(
  nowIso: string = new Date().toISOString()
): Promise<SubscriptionStateReconcileResult> {
  const result = emptyResult();

  if (!supabaseAdmin) {
    log.error("supabaseAdmin not configured; skipping subscription-state reconcile", new Error("supabaseAdmin missing"), {
      source: SUBSCRIPTION_STATE_RECONCILER_LOG_SOURCE,
    });
    return result;
  }

  const { data, error } = await supabaseAdmin
    .from("hermes_subscriptions")
    .select(
      "user_id, plan, status, instance_limit, total_cpu_budget, total_ram_budget, stripe_subscription_id, stripe_customer_id, current_period_end, grace_period_ends_at, updated_at"
    )
    .in("plan", PAID_PLANS as unknown as string[])
    .in("status", RECONCILED_STATUSES as unknown as string[])
    .order("updated_at", { ascending: true, nullsFirst: true });

  if (error) {
    log.error("failed to query paid subscription state rows", error, {
      source: SUBSCRIPTION_STATE_RECONCILER_LOG_SOURCE,
      failureType: "subscription_state_query_failed",
    });
    result.errors += 1;
    return result;
  }

  const rows = (data as SubscriptionStateRow[] | null) ?? [];
  result.scanned = rows.length;
  const nowMs = new Date(nowIso).getTime();

  for (const row of rows) {
    try {
      if (row.status === "pending") {
        if (!isStalePending(row, nowMs)) {
          result.skippedRecentPending += 1;
          result.entries.push(entry(row, "skipped_recent_pending"));
          continue;
        }

        const pendingGrant = (await lookupStripeGrant(row)).live;
        if (pendingGrant) {
          await activatePendingStripeGrant(row, pendingGrant, result);
          continue;
        }

        if (await hasOpenCheckout(row)) {
          result.skippedOpenCheckout += 1;
          result.entries.push(entry(row, "skipped_open_checkout"));
          continue;
        }

        await finalizeReset(row, "reset_pending_abandoned", nowIso, result);
        continue;
      }

      if (!row.stripe_subscription_id || isManualSubscriptionId(row.stripe_subscription_id)) {
        result.manualReview += 1;
        result.entries.push(entry(row, "manual_review", "paid access row has no live Stripe subscription id"));
        continue;
      }

      const lookup = await lookupStripeGrant(row);
      if (lookup.live) {
        result.skippedStripeGrant += 1;
        result.entries.push(entry(row, "skipped_stripe_grant"));
        continue;
      }

      // The row's own subscription exists but is terminal: route it through
      // the canonical cancel path (status='canceled', plan + sub id retained,
      // instances suspended on the paid-cancel ladder). The old behavior —
      // RPC-resetting to a free/active row with a nulled sub id — erased the
      // Stripe linkage, dropped canceled payers onto the free-tier idle-purge
      // ladder, and minted the 2026-06→07 ghost-payer rows.
      if (
        lookup.terminal &&
        lookup.terminal.id === row.stripe_subscription_id &&
        lookup.terminal.metadata?.user_id === row.user_id
      ) {
        await StripeWebhookService.handleSubscriptionDeleted(lookup.terminal);
        result.canceledTerminalStripe += 1;
        result.entries.push(
          entry(
            row,
            "canceled_terminal_stripe",
            `subscription_id=${lookup.terminal.id}; stripe_status=${lookup.terminal.status}`
          )
        );
        continue;
      }

      await finalizeReset(row, "reset_terminal_stripe", nowIso, result);
    } catch (error) {
      log.error("subscription-state reconcile failed for row", error, {
        source: SUBSCRIPTION_STATE_RECONCILER_LOG_SOURCE,
        failureType: "subscription_state_row_failed",
        userId: row.user_id,
        subscriptionId: row.stripe_subscription_id,
      });
      result.errors += 1;
      result.entries.push(entry(row, "error", error instanceof Error ? error.message : String(error)));
    }
  }

  if (
    result.pendingReset > 0 ||
    result.paidAccessReset > 0 ||
    result.canceledTerminalStripe > 0 ||
    result.pendingActivatedFromStripe > 0 ||
    result.manualReview > 0 ||
    result.skippedStaleRow > 0 ||
    result.errors > 0
  ) {
    log.info("subscription-state reconcile pass complete", {
      source: SUBSCRIPTION_STATE_RECONCILER_LOG_SOURCE,
      scanned: result.scanned,
      pendingReset: result.pendingReset,
      paidAccessReset: result.paidAccessReset,
      canceledTerminalStripe: result.canceledTerminalStripe,
      pendingActivatedFromStripe: result.pendingActivatedFromStripe,
      runtimeRowsUpdated: result.runtimeRowsUpdated,
      runtimeRowsChanged: result.runtimeRowsChanged,
      manualReview: result.manualReview,
      skippedStaleRow: result.skippedStaleRow,
      errors: result.errors,
    });
  }

  return result;
}
