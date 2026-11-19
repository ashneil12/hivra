// The card trial: a 7-day Stripe trial of the entry plan (Pro), card required
// at Checkout. Off unless HIVRA_CARD_TRIAL=on. While it runs, the account gets
// a small computer pool, its Hivra Cloud agents sleep when idle and can't be
// kept awake, and the AI starter credit is capped. When the trial ends, Stripe
// charges the card and the subscription becomes a normal Pro plan. A trial that
// ends unpaid or canceled goes through the existing billing suspension path.
// Owner decision 2026-11-19.

import type Stripe from "stripe";
import { supabaseAdmin } from "@/lib/supabase";
import { log } from "@/lib/logger";
import { getStripePriceId, PLANS } from "@/lib/subscription/plans";
import { activePlanLadder, isPlanLadderEnabled } from "@/lib/subscription/plan-ladder";

const SOURCE = "card-trial";

export const CARD_TRIAL_DAYS = 7;
export const CARD_TRIAL_PLAN = "operator" as const;
/** Stripe subscription metadata that marks a card trial. */
export const CARD_TRIAL_METADATA_KEY = "hivra_trial";
export const CARD_TRIAL_METADATA_VALUE = "card_7d";

/** The trial's computer pool: one agent, 1 vCPU and 2 GB, enough for every agent's base size. */
export const CARD_TRIAL_LIMITS = { maxAgents: 1, totalCpu: 1, totalRam: 2048 } as const;

/** The most AI starter credit a trialing account gets. */
export const CARD_TRIAL_STARTER_CREDIT_USD = 1;

export function isCardTrialEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.HIVRA_CARD_TRIAL?.trim().toLowerCase() === "on";
}

/** The offer and its renewal amount, for the same monthly entry price checkout sells. */
export function getCardTrialOffer(): { monthlyCents: number } | null {
  if (!isCardTrialEnabled() || !supabaseAdmin || !process.env.STRIPE_SECRET_KEY?.trim() ||
      !process.env.STRIPE_WEBHOOK_SECRET?.trim()) return null;

  if (isPlanLadderEnabled()) {
    const config = activePlanLadder();
    if (!config) return null;
    const entry = config.plans[CARD_TRIAL_PLAN];
    return entry.monthlyCents > 0 ? { monthlyCents: entry.monthlyCents } : null;
  }

  try {
    if (!getStripePriceId(CARD_TRIAL_PLAN, "monthly").trim()) return null;
    return { monthlyCents: PLANS[CARD_TRIAL_PLAN].price };
  } catch {
    return null;
  }
}

/** True when this Stripe subscription is a card trial that is still in its trial. */
export function isCardTrialSubscription(
  subscription: Pick<Stripe.Subscription, "status" | "metadata">
): boolean {
  return (
    subscription.status === "trialing" &&
    subscription.metadata?.[CARD_TRIAL_METADATA_KEY] === CARD_TRIAL_METADATA_VALUE
  );
}

export interface CardTrialHistory {
  /** The account's subscription row, if any. */
  existingSub?: { stripe_subscription_id?: string | null; upgraded_at?: string | null } | null;
  /** Whether a trial attempt was ever recorded for this account. */
  hadTrial: boolean;
}

/**
 * Whether this checkout gets the trial: the switch is on, it is the entry plan
 * billed monthly, and the account has never paid or trialed before.
 */
export function checkoutGetsCardTrial(
  input: { planKey: string; cadence: string } & CardTrialHistory,
  env: Record<string, string | undefined> = process.env
): boolean {
  if (!isCardTrialEnabled(env)) return false;
  if (input.planKey !== CARD_TRIAL_PLAN || input.cadence !== "monthly") return false;
  if (input.hadTrial) return false;
  if (input.existingSub?.upgraded_at) return false;
  if (input.existingSub?.stripe_subscription_id) return false;
  return true;
}

/** The Checkout fields that start the trial. The card is always collected. */
export function cardTrialCheckoutFields(): {
  payment_method_collection: "always";
  subscription_data: Pick<Stripe.Checkout.SessionCreateParams.SubscriptionData, "trial_period_days" | "trial_settings">;
  metadata: Record<string, string>;
} {
  return {
    payment_method_collection: "always",
    subscription_data: {
      trial_period_days: CARD_TRIAL_DAYS,
      trial_settings: { end_behavior: { missing_payment_method: "cancel" } },
    },
    metadata: { [CARD_TRIAL_METADATA_KEY]: CARD_TRIAL_METADATA_VALUE },
  };
}

type Db = NonNullable<typeof supabaseAdmin>;

function readTrialHistory(userId: string, db: Db) {
  return db.from("hermes_trial_usage").select("id").eq("user_id", userId).limit(1);
}

/** Whether the account ever attempted a card trial. A failed read counts as yes. */
export async function accountHadCardTrial(userId: string, db: Db | null = supabaseAdmin): Promise<boolean> {
  if (!db) return true;
  const { data, error } = await readTrialHistory(userId, db);
  if (error) {
    log.warn("could not read trial history; not offering a trial", {
      source: SOURCE,
      failureType: "card_trial_history_read_failed",
      userId,
    });
    return true;
  }
  return Array.isArray(data) && data.length > 0;
}

/** When the account's running card trial ends (ISO), or null when it is not in one. A failed read is null. */
export async function readCardTrialEndsAt(userId: string, db: Db | null = supabaseAdmin, now: Date = new Date()): Promise<string | null> {
  if (!db) return null;
  try {
    const { data, error } = await db
      .from("hermes_subscriptions")
      .select("trial_ends_at")
      .eq("user_id", userId)
      .maybeSingle();
    if (error || !data) return null;
    const endsAt = (data as { trial_ends_at?: string | null }).trial_ends_at;
    return typeof endsAt === "string" && new Date(endsAt).getTime() > now.getTime() ? endsAt : null;
  } catch {
    return null;
  }
}

/** True while the account's subscription row is inside a card trial. A failed read is false. */
export async function isInCardTrial(userId: string, db: Db | null = supabaseAdmin, now: Date = new Date()): Promise<boolean> {
  return (await readCardTrialEndsAt(userId, db, now)) !== null;
}

/** Card fingerprint of the subscription's default payment method, or null. */
async function cardFingerprint(stripe: Stripe, subscription: Stripe.Subscription): Promise<string | null> {
  const pm = subscription.default_payment_method;
  const pmId = typeof pm === "string" ? pm : pm?.id;
  if (!pmId) return null;
  const method = typeof pm === "object" && pm?.card ? pm : await stripe.paymentMethods.retrieve(pmId);
  return method.card?.fingerprint ?? null;
}

/**
 * Records a card trial when it starts. If another account already trialed with
 * the same card, cancel the duplicate without charging for a paid plan.
 * Returns true when the trial was rejected. Throws on a failed write so the
 * webhook retries.
 */
export async function recordCardTrialStart(params: {
  stripe: Stripe;
  subscription: Stripe.Subscription;
  userId: string;
  db?: Db | null;
}): Promise<{ endedEarly: boolean }> {
  const db = params.db ?? supabaseAdmin;
  if (!db) throw new Error("database not configured");
  const { subscription, userId } = params;

  const { data: existing, error: existingError } = await db
    .from("hermes_trial_usage")
    .select("id")
    .eq("stripe_subscription_id", subscription.id)
    .limit(1);
  if (existingError) throw new Error(`trial usage read failed: ${existingError.message}`);
  if (Array.isArray(existing) && existing.length > 0) return { endedEarly: false };

  const fingerprint = await cardFingerprint(params.stripe, subscription);
  let reused = false;
  if (fingerprint) {
    const { data: prior, error: priorError } = await db
      .from("hermes_trial_usage")
      .select("user_id")
      .eq("card_fingerprint", fingerprint)
      .neq("user_id", userId)
      .limit(1);
    if (priorError) throw new Error(`trial usage read failed: ${priorError.message}`);
    reused = Array.isArray(prior) && prior.length > 0;
  }

  if (!reused) {
    const { error: insertError } = await db.from("hermes_trial_usage").insert({
      user_id: userId,
      stripe_subscription_id: subscription.id,
      card_fingerprint: fingerprint,
    });
    if (insertError && insertError.code === "23505") {
      // A unique conflict is either a repeat delivery of this subscription's
      // event (nothing to do) or another trial already on this card.
      const { data: same, error: sameError } = await db
        .from("hermes_trial_usage")
        .select("id")
        .eq("stripe_subscription_id", subscription.id)
        .limit(1);
      if (sameError) throw new Error(`trial usage read failed: ${sameError.message}`);
      if (Array.isArray(same) && same.length > 0) return { endedEarly: false };
      reused = true;
    } else if (insertError) throw new Error(`trial usage write failed: ${insertError.message}`);
  }

  if (reused) {
    log.info("card already used for a trial on another account; canceling duplicate trial", {
      source: SOURCE,
      failureType: "card_trial_card_reused",
      userId,
      subscriptionId: subscription.id,
    });
    // Count the attempt for this account, so its next Checkout can be paid.
    // Do not bind the rejected subscription or card to its trial history:
    // if cancellation fails, the next webhook must still reject it.
    const { data: attempts, error: attemptsError } = await readTrialHistory(userId, db);
    if (attemptsError) throw new Error(`trial usage read failed: ${attemptsError.message}`);
    if (!attempts?.length) {
      const { error: recordError } = await db.from("hermes_trial_usage").insert({ user_id: userId });
      if (recordError) throw new Error(`trial usage write failed: ${recordError.message}`);
    }
    await params.stripe.subscriptions.cancel(subscription.id, { invoice_now: false, prorate: false });
    return { endedEarly: true };
  }
  return { endedEarly: false };
}

/**
 * When a trial converts, its agents go back to the paid default (no forced
 * sleep). Runs only while the subscription row still carries trial_ends_at,
 * so a later sleep choice is never undone. Throws on a failed write so the
 * webhook retries before trial_ends_at is cleared.
 */
export async function releaseCardTrialSleep(userId: string, db: Db | null = supabaseAdmin): Promise<boolean> {
  if (!db) return false;
  const { data, error } = await db
    .from("hermes_subscriptions")
    .select("trial_ends_at")
    .eq("user_id", userId)
    .maybeSingle();
  // A database without the card-trial migration cannot have trial sleep to release.
  if (error?.code === "42703" || error?.code === "PGRST204") return false;
  if (error) throw new Error(`trial sleep release read failed: ${error.message}`);
  if (!(data as { trial_ends_at?: string | null } | null)?.trial_ends_at) return false;
  const { error: updateError } = await db
    .from("hivra_agents")
    .update({ sleep_policy: "off" })
    .eq("user_id", userId)
    .eq("sleep_policy", "full");
  if (updateError) throw new Error(`trial sleep release failed: ${updateError.message}`);
  return true;
}

/** Makes a trial account's new Hivra Cloud agent sleep when idle. Best-effort. */
export async function applyCardTrialSleep(userId: string, agentId: string, db: Db | null = supabaseAdmin): Promise<boolean> {
  if (!db || !(await isInCardTrial(userId, db))) return false;
  const { error } = await db
    .from("hivra_agents")
    .update({ sleep_policy: "full", always_on: false })
    .eq("id", agentId)
    .eq("user_id", userId);
  if (error) {
    log.warn("could not set sleep for a trial agent", {
      source: SOURCE,
      failureType: "card_trial_sleep_policy_failed",
      userId,
      agentId,
    });
    return false;
  }
  return true;
}

export const CARD_TRIAL_UPGRADE_HINT =
  "Upgrade to full Pro now in Billing for 3 agents, 2 vCPU, 4 GB and Keep awake.";

export const CARD_TRIAL_KEEP_AWAKE_MESSAGE =
  `During the free trial, agents sleep when idle. ${CARD_TRIAL_UPGRADE_HINT}`;
