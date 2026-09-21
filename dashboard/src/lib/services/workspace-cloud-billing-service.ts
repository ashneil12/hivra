import type Stripe from "stripe";

import { supabaseAdmin } from "@/lib/supabase";
import { getStripe } from "@/lib/stripe";
import {
  WORKSPACE_CLOUD_PLANS,
  getWorkspaceCloudPlan,
  type WorkspaceCloudPlanKey,
} from "@/lib/subscription/plans";
import { log } from "@/lib/logger";
import { upsertPool } from "@/lib/pools/pool-service";

/**
 * Workspace Cloud lane billing — Stripe → workspace_cloud_subscriptions.
 *
 * The lane reuses the SINGLE shared Stripe webhook endpoint; events are routed
 * here by `metadata.surface === 'workspace_cloud'` (set on the checkout session
 * and propagated to the subscription), with the lane price IDs as a fallback
 * signal. This keeps the Hivra billing path (hermes_subscriptions) entirely
 * untouched while writing the lane's own table.
 */
export const WORKSPACE_CLOUD_SURFACE = "workspace_cloud";

const LOG_SOURCE = "workspace-cloud-billing";

function hasLaneSurface(metadata: Stripe.Metadata | null | undefined): boolean {
  return metadata?.surface === WORKSPACE_CLOUD_SURFACE;
}

/** Map every configured lane price ID → its lane plan key. */
function lanePriceIdToPlanKey(): Map<string, WorkspaceCloudPlanKey> {
  const map = new Map<string, WorkspaceCloudPlanKey>();
  for (const [key, plan] of Object.entries(WORKSPACE_CLOUD_PLANS)) {
    if (plan.stripePriceId) map.set(plan.stripePriceId, key as WorkspaceCloudPlanKey);
    if (plan.stripeYearlyPriceId) map.set(plan.stripeYearlyPriceId, key as WorkspaceCloudPlanKey);
  }
  return map;
}

export function isWorkspaceCloudCheckout(session: Stripe.Checkout.Session): boolean {
  return hasLaneSurface(session.metadata);
}

export function isWorkspaceCloudSubscription(subscription: Stripe.Subscription): boolean {
  // Lane membership is decided SOLELY by explicit `surface=workspace_cloud`
  // metadata (every lane checkout stamps it — see subscribe/route.ts). We must
  // NOT infer the lane from the price ID: by default the lane plans reuse the
  // SAME Stripe price IDs as regular Hivra (WORKSPACE_CLOUD_*_PRICE_ID falls
  // back to STRIPE_OPERATOR/FLEET_PRICE_ID), so a price match would wrongly
  // classify a regular Hivra Pro sub as a Workspace Cloud sub — granting
  // cloud Pro to someone who only ever bought regular Hermes.
  return hasLaneSurface(subscription.metadata);
}

function resolveLanePlanKey(subscription: Stripe.Subscription): WorkspaceCloudPlanKey {
  const priceId = subscription.items?.data?.[0]?.price?.id;
  const fromPrice = priceId ? lanePriceIdToPlanKey().get(priceId) : undefined;
  if (fromPrice) return fromPrice;
  const fromMeta = subscription.metadata?.plan;
  if (fromMeta && fromMeta in WORKSPACE_CLOUD_PLANS) {
    return fromMeta as WorkspaceCloudPlanKey;
  }
  return "ws_cloud_pro";
}

// workspace_cloud_subscriptions.status only allows these.
function mapStripeStatus(status: Stripe.Subscription.Status): string {
  switch (status) {
    case "active":
      return "active";
    case "past_due":
      return "past_due";
    case "trialing":
      return "trialing";
    default:
      // canceled, incomplete, incomplete_expired, unpaid, paused → treat as
      // not-entitled. The entitlement resolver only honors active/past_due/
      // trialing, so anything else effectively blocks provisioning.
      return "canceled";
  }
}

function customerId(subscription: Stripe.Subscription): string | null {
  return typeof subscription.customer === "string"
    ? subscription.customer
    : subscription.customer?.id ?? null;
}

function periodEndIso(subscription: Stripe.Subscription): string | null {
  const firstItem = subscription.items?.data?.[0];
  const end =
    firstItem?.current_period_end ??
    (subscription as unknown as { current_period_end?: number }).current_period_end;
  return typeof end === "number" ? new Date(end * 1000).toISOString() : null;
}

export async function handleWorkspaceCloudSubscriptionChange(
  subscription: Stripe.Subscription
): Promise<void> {
  if (!supabaseAdmin) return;
  const userId =
    subscription.metadata?.user_id || subscription.metadata?.clerk_user_id || null;
  if (!userId) {
    log.warn("workspace_cloud subscription change missing user_id metadata", {
      source: LOG_SOURCE,
      failureType: "workspace_cloud_subscription_missing_user",
      subscriptionId: subscription.id,
    });
    return;
  }

  const planKey = resolveLanePlanKey(subscription);
  const plan = getWorkspaceCloudPlan(planKey);

  const { error } = await supabaseAdmin.from("workspace_cloud_subscriptions").upsert(
    {
      user_id: userId,
      plan: planKey,
      status: mapStripeStatus(subscription.status),
      instance_limit: plan.maxAgents,
      total_cpu_budget: plan.totalCpu,
      total_ram_budget: plan.totalRam,
      stripe_customer_id: customerId(subscription),
      stripe_subscription_id: subscription.id,
      current_period_end: periodEndIso(subscription),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" }
  );

  if (error) {
    log.error(
      "failed to upsert workspace_cloud subscription",
      new Error(error.message),
      {
        source: LOG_SOURCE,
        failureType: "workspace_cloud_subscription_upsert_failed",
        subscriptionId: subscription.id,
        userId,
      }
    );
    throw new Error(error.message);
  }

  // Phase 1: mirror the workspace-cloud budget into the explicit pool entity.
  await upsertPool({
    userId,
    productSurface: "workspace_cloud",
    cpuBudget: plan.totalCpu,
    ramBudgetMb: plan.totalRam,
    agentSlots: plan.maxAgents,
    status: mapStripeStatus(subscription.status),
  });
}

export async function handleWorkspaceCloudSubscriptionDeleted(
  subscription: Stripe.Subscription
): Promise<void> {
  if (!supabaseAdmin) return;
  const { error } = await supabaseAdmin
    .from("workspace_cloud_subscriptions")
    .update({ status: "canceled", updated_at: new Date().toISOString() })
    .eq("stripe_subscription_id", subscription.id);
  if (error) {
    log.error(
      "failed to cancel workspace_cloud subscription",
      new Error(error.message),
      {
        source: LOG_SOURCE,
        failureType: "workspace_cloud_subscription_cancel_failed",
        subscriptionId: subscription.id,
      }
    );
    throw new Error(error.message);
  }
}

/**
 * Checkout completed for a lane purchase. Stripe also fires
 * customer.subscription.created, but we resolve the subscription here too so
 * the entitlement row exists the moment the user returns from Checkout.
 */
export async function handleWorkspaceCloudCheckoutCompleted(
  session: Stripe.Checkout.Session
): Promise<void> {
  const subscriptionId =
    typeof session.subscription === "string"
      ? session.subscription
      : session.subscription?.id ?? null;
  if (!subscriptionId) return;
  const stripe = getStripe();
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  // Carry the session's surface/user metadata onto the subscription object in
  // case subscription_data.metadata didn't propagate.
  subscription.metadata = { ...session.metadata, ...subscription.metadata };
  await handleWorkspaceCloudSubscriptionChange(subscription);
}
