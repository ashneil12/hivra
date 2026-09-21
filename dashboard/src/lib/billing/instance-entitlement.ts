/**
 * Effective subscription resolver — single source of truth for "is this
 * user entitled to provision an agent, and what compute pool do they
 * get?"
 *
 * Three entitlement sources are considered equivalent at the access layer:
 *
 *   1. Subscription table entitlement — `hermes_subscriptions` row with
 *      status 'active', 'past_due', or 'trialing'. Paid rows are Stripe
 *      subscriptions; the Free row is created directly with
 *      plan='free' and the same resource-budget fields.
 *
 *   2. Yearly $HermesOS subscription — `yearly_token_subscriptions` row
 *      with status 'active' or 'grace'. User paid one year up front
 *      with $HermesOS; the row's `expires_at` is paid_at + 365d.
 *      Treated like a Stripe sub for entitlement purposes.
 *
 *   3. Token-tier qualification — `token_tier_qualifications` row with
 *      currently_eligible = true. Pro-tier eligibility maps to the
 *      `operator` plan's compute limits, Power-tier maps to `fleet`.
 *
 *   4. Apple IAP subscription — `apple_iap_subscriptions` row in an
 *      access-granting status (active/trialing/grace_period). The iOS
 *      lane's parallel money path; written only by the Apple webhook,
 *      reconciler and mobile attach endpoint.
 *
 * Precedence: paid Stripe → apple_iap → yearly_token → holding → Free Stripe row.
 * The Free row is a fallback, not a winner — sign-up auto-creates an
 * active 'free' row, so treating Free as a "real" Stripe sub would
 * block the token-tier path for every wallet-only user. A paid plan
 * always wins; if there is no paid plan, token entitlements get a
 * chance before the Free defaults apply.
 *
 * Grace period note: the eligibility evaluator in token-tier-eligibility
 * keeps `currently_eligible = true` until breach + grace expires, then
 * flips to false on suspend. That matches how the wallet UI displays
 * "Eligible" vs "Not yet eligible," so this helper checks the strict
 * boolean and stays consistent. No special grace handling here.
 */

import { supabaseAdmin } from "@/lib/supabase";
import { isLiveStripeSubscriptionId } from "@/lib/billing/subscription-status";
import { PLANS, getWorkspaceCloudPlan } from "@/lib/subscription/plans";
import { APPLE_ACCESS_STATUSES } from "@/lib/billing/apple-products";
import { log } from "@/lib/logger";

export interface EffectiveSubscription {
  plan: string;
  status: "active" | "past_due" | "trialing";
  instance_limit: number;
  total_cpu_budget: number;
  total_ram_budget: number;
  source:
    | "stripe"
    | "free"
    | "token_holding"
    | "token_yearly"
    | "workspace_cloud"
    | "apple_iap";
  /** Token tier when source === 'token_holding' or 'token_yearly'. */
  tokenTier?: "pro" | "power";
  /**
   * Stripe-only: when the current billing cycle ends (ISO 8601). Surfaced
   * here so callers like /api/billing/usage can render "Renews on …"
   * without a second round-trip to hermes_subscriptions. Always null for
   * token-holding rows — eligibility runs while the threshold is held.
   */
  currentPeriodEnd?: string | null;
  /**
   * True only when the current plan is backed by a live Stripe subscription
   * that can be upgraded through Stripe's prorated subscription update API.
   * Manual/token/free entitlements must use secure checkout instead.
   */
  canChangePlanInPlace: boolean;
}

interface SubscriptionRow {
  plan: string;
  status: string;
  instance_limit: number;
  total_cpu_budget: number;
  total_ram_budget: number;
  current_period_end: string | null;
  stripe_subscription_id: string | null;
  grace_period_ends_at: string | null;
}

interface QualificationRow {
  tier: "pro" | "power";
  currently_eligible: boolean;
}

// Includes 'trialing' to preserve the abuse-gate bypass behavior the
// previous isPaidSubscriber() helper had — trialing subs are billed
// (Stripe holds a payment method) and that's a strong-enough signal to
// skip risk scoring. Provisioning callers that want to additionally
// reject trialing (instance-service does, since trialing budgets are
// often $0) check `sub.status` themselves.
const STRIPE_ACCESS_STATUSES = new Set(["active", "past_due", "trialing"]);

/**
 * Returns the effective subscription for the user, or null if neither
 * a paid Stripe sub nor a token-holding qualification entitles them.
 *
 * Reads `hermes_subscriptions` first; falls back to
 * `token_tier_qualifications` only when the Stripe path doesn't yield
 * an active row.
 */
export async function resolveEffectiveSubscription(
  userId: string
): Promise<EffectiveSubscription | null> {
  if (!supabaseAdmin) return null;

  const { data: subRow } = await supabaseAdmin
    .from("hermes_subscriptions")
    .select("plan, status, instance_limit, total_cpu_budget, total_ram_budget, current_period_end, stripe_subscription_id, grace_period_ends_at")
    .eq("user_id", userId)
    .maybeSingle<SubscriptionRow>();

  // Dunning cutoff: a `past_due` Stripe sub only grants access WHILE it is
  // still inside its grace window. Once `grace_period_ends_at` has elapsed, the
  // failed-payment sub stops entitling the user — otherwise access rode the
  // full ~2-week Stripe retry window for free (a user could let the card fail,
  // keep Pro the whole time, then resubscribe). Policy: 48h keep-alive, then
  // lapse until payment recovers (`handleInvoicePaid` clears the anchor and
  // flips back to active).
  //
  // FAIL-OPEN on a null anchor: we only cut off when there is an EXPLICIT,
  // elapsed grace timestamp. A `past_due` row that somehow lacks the anchor
  // keeps access — erring toward never locking out a paying customer over a
  // missing stamp. `handlePaymentFailed` (invoice.payment_failed) stamps the
  // anchor from the first decline, and Stripe fires that event alongside the
  // past_due transition, so a real failed-payment row always carries one; the
  // fail-open only covers the rare/brief window where a subscription.updated →
  // past_due arrives before any payment_failed.
  const graceExpired =
    !!subRow &&
    subRow.status === "past_due" &&
    typeof subRow.grace_period_ends_at === "string" &&
    Date.parse(subRow.grace_period_ends_at) <= Date.now();

  const hasStripeAccess =
    !!subRow && STRIPE_ACCESS_STATUSES.has(subRow.status) && !graceExpired;

  // A paid Stripe sub is authoritative *only while it still grants seats*.
  // The auto-created 'free' row is NOT a winner — it's a placeholder so the
  // UI has something to render pre-purchase, and treating it as a winner
  // would block every wallet-only user from their token-tier entitlement.
  //
  // The `instance_limit > 0` guard closes a silent-lockout bug: when a paid
  // sub degrades (payment failed → past_due, or a dropped
  // `customer.subscription.deleted` webhook left the row stuck at past_due),
  // dunning zeroes `instance_limit` but leaves `status` in the access set and
  // `plan` non-free. Without this guard the zeroed row short-circuits here and
  // returns `instance_limit: 0`, masking a perfectly valid token-tier or
  // yearly entitlement underneath and surfacing as
  // "Your <Plan> plan allows 0 agents". Falling through lets the token/yearly
  // path win when it should. A healthy paid sub (limit > 0) still wins outright.
  if (hasStripeAccess && subRow.plan !== "free" && subRow.instance_limit > 0) {
    return {
      plan: subRow.plan,
      status: subRow.status as "active" | "past_due" | "trialing",
      instance_limit: subRow.instance_limit,
      total_cpu_budget: subRow.total_cpu_budget,
      total_ram_budget: subRow.total_ram_budget,
      source: "stripe",
      currentPeriodEnd: subRow.current_period_end ?? null,
      canChangePlanInPlace: isLiveStripeSubscriptionId(subRow.stripe_subscription_id),
    };
  }

  // Apple IAP (iOS App Store) subscription — second-priority source, ahead
  // of the token entitlements: it is real recurring money, like Stripe. The
  // lane keeps its own table (apple_iap_subscriptions, written only by the
  // Apple webhook/reconciler/attach paths) so the Stripe machinery never
  // touches it. Only access-granting statuses count here — 'active',
  // 'trialing', and 'grace_period' (Apple Billing Grace Period keeps access
  // while Apple retries the card). 'past_due' (billing retry with NO grace),
  // 'expired' and 'revoked' fall through to the token/free sources exactly
  // like a lapsed Stripe row does.
  const { data: appleRow } = await supabaseAdmin
    .from("apple_iap_subscriptions")
    .select("plan, status, current_period_end")
    .eq("user_id", userId)
    .in("status", APPLE_ACCESS_STATUSES as unknown as string[])
    .maybeSingle<{ plan: string; status: string; current_period_end: string | null }>();

  if (appleRow && appleRow.plan in PLANS) {
    const applePlan = PLANS[appleRow.plan as keyof typeof PLANS];
    return {
      plan: appleRow.plan,
      // grace_period renders as past_due so existing status consumers show
      // their billing-warning treatment without learning a new status word.
      status:
        appleRow.status === "trialing"
          ? "trialing"
          : appleRow.status === "grace_period"
            ? "past_due"
            : "active",
      instance_limit: applePlan.maxAgents,
      total_cpu_budget: applePlan.totalCpu,
      total_ram_budget: applePlan.totalRam,
      source: "apple_iap",
      currentPeriodEnd: appleRow.current_period_end ?? null,
      // Plan changes happen in the App Store (upgrade/downgrade sheets), never
      // through Stripe's prorated update API.
      canChangePlanInPlace: false,
    };
  }

  // Yearly $HermesOS one-time-payment sub — next-priority source.
  // The row in `yearly_token_subscriptions` carries paid_at + expires_at
  // (paid_at + 365d), and status 'active' or 'grace' means the user
  // is currently entitled to the tier.
  const { data: yearlyRows } = await supabaseAdmin
    .from("yearly_token_subscriptions")
    .select("tier, status, expires_at")
    .eq("user_id", userId)
    .in("status", ["active", "grace"])
    .order("paid_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ tier: "pro" | "power"; status: string; expires_at: string }>();

  if (yearlyRows) {
    const planKey = yearlyRows.tier === "power" ? "fleet" : "operator";
    const plan = PLANS[planKey as keyof typeof PLANS];
    return {
      plan: planKey,
      status: "active",
      instance_limit: plan.maxAgents,
      total_cpu_budget: plan.totalCpu,
      total_ram_budget: plan.totalRam,
      source: "token_yearly",
      tokenTier: yearlyRows.tier,
      // Surface the 365-day expiry so the dashboard can render
      // "Active until 1 May 2027" instead of "Renews on …".
      currentPeriodEnd: yearlyRows.expires_at,
      canChangePlanInPlace: false,
    };
  }

  const { data: qualRows } = await supabaseAdmin
    .from("token_tier_qualifications")
    .select("tier, currently_eligible")
    .eq("user_id", userId)
    .eq("currently_eligible", true);

  const quals = (qualRows as QualificationRow[] | null) ?? [];
  if (quals.length > 0) {
    // Power outranks Pro when the user qualifies for both — give them the
    // larger compute pool they paid for.
    const tier: "pro" | "power" = quals.some((q) => q.tier === "power")
      ? "power"
      : "pro";

    return tier === "power"
      ? {
          plan: "fleet",
          status: "active",
          instance_limit: PLANS.fleet.maxAgents,
          total_cpu_budget: PLANS.fleet.totalCpu,
          total_ram_budget: PLANS.fleet.totalRam,
          source: "token_holding",
          tokenTier: "power",
          canChangePlanInPlace: false,
        }
      : {
          plan: "operator",
          status: "active",
          instance_limit: PLANS.operator.maxAgents,
          total_cpu_budget: PLANS.operator.totalCpu,
          total_ram_budget: PLANS.operator.totalRam,
          source: "token_holding",
          tokenTier: "pro",
          canChangePlanInPlace: false,
        };
  }

  // Free Stripe row is the FALLBACK. We get here when there is no paid
  // Stripe sub, no yearly token sub, and no eligible token-tier
  // qualification — but the user still signed up and has an active
  // 'free' row. Hand them the Free plan's budgets so the dashboard
  // renders correctly instead of "no subscription".
  if (hasStripeAccess && subRow.plan === "free") {
    return {
      plan: subRow.plan,
      status: subRow.status as "active" | "past_due" | "trialing",
      instance_limit: subRow.instance_limit,
      total_cpu_budget: subRow.total_cpu_budget,
      total_ram_budget: subRow.total_ram_budget,
      source: "free",
      currentPeriodEnd: subRow.current_period_end ?? null,
      canChangePlanInPlace: false,
    };
  }

  return null;
}

interface WorkspaceCloudSubscriptionRow {
  plan: string;
  status: string;
  instance_limit: number;
  total_cpu_budget: number;
  total_ram_budget: number;
  current_period_end: string | null;
}

/**
 * Effective entitlement for the Hermes Workspace cloud lane.
 *
 * Fully separate from resolveEffectiveSubscription: reads only the lane's own
 * `workspace_cloud_subscriptions` table so the two products' billing never
 * cross-contaminates. Returns null when the user has no active lane
 * subscription (caller then blocks provisioning with a "subscribe" message).
 *
 * WORKSPACE_CLOUD_BILLING_BYPASS=true synthesises an active lane entitlement —
 * test-only affordance for exercising the lane on canary before the lane's
 * Stripe products/webhook exist (mirrors the existing NODE_ENV dev mock in
 * createInstance). MUST stay unset in production.
 */
export async function resolveWorkspaceCloudEntitlement(
  userId: string
): Promise<EffectiveSubscription | null> {
  if (!supabaseAdmin) return null;

  const { data: row } = await supabaseAdmin
    .from("workspace_cloud_subscriptions")
    .select(
      "plan, status, instance_limit, total_cpu_budget, total_ram_budget, current_period_end"
    )
    .eq("user_id", userId)
    .maybeSingle<WorkspaceCloudSubscriptionRow>();

  if (row && STRIPE_ACCESS_STATUSES.has(row.status)) {
    return {
      plan: row.plan,
      status: row.status as "active" | "past_due" | "trialing",
      instance_limit: row.instance_limit,
      total_cpu_budget: row.total_cpu_budget,
      total_ram_budget: row.total_ram_budget,
      source: "workspace_cloud",
      currentPeriodEnd: row.current_period_end ?? null,
      canChangePlanInPlace: false,
    };
  }

  // Hard runtime guard: the billing bypass synthesises a FREE active
  // entitlement and must NEVER take effect in production (where it would let
  // anyone provision a real VM for free). A code comment is not a guard — if
  // the flag is ever set in a prod deploy, refuse it and log loudly rather than
  // silently honoring it.
  if (process.env.WORKSPACE_CLOUD_BILLING_BYPASS === "true") {
    if (process.env.NODE_ENV === "production") {
      log.error(
        "WORKSPACE_CLOUD_BILLING_BYPASS is set in production; ignoring (no free entitlement granted)",
        new Error("workspace_cloud_billing_bypass_in_production"),
        {
          source: "instance-entitlement",
          failureType: "workspace_cloud_billing_bypass_in_production",
          userId,
        }
      );
      return null;
    }
    const plan = getWorkspaceCloudPlan();
    return {
      plan: plan.key,
      status: "active",
      instance_limit: plan.maxAgents,
      total_cpu_budget: plan.totalCpu,
      total_ram_budget: plan.totalRam,
      source: "workspace_cloud",
      currentPeriodEnd: null,
      canChangePlanInPlace: false,
    };
  }

  return null;
}
