// Venice promo campaigns: redeem a code, grant launch credit and top-up
// bonuses, expire unspent promo money.
//
// WHICH LEDGER. A managed Venice proxy key bound to the "card" wallet spends
// from managed_venice_card_ledger_entries (debit_managed_venice_wallet /
// capture_managed_venice_reservation write their negative entries there). That
// is the only ledger promo money is granted into (source "promo"). The
// "bonus_credit" ledger in lib/billing/credits.ts (referrals) funds compute
// credits, not managed Venice chat, so it is not used here.
//
// ATTRIBUTION. Another module reads the ?ref=venice cookie. This module does not
// import it: whoever has the cookie (signup, billing page loader, the redeem
// route) passes `{ ref, code }` to recordVeniceAttribution / redeemVeniceCode.
//
// HOOKS (all flag-gated by HIVRA_VENICE_PROMO_ENABLED, all best-effort: a promo
// failure is logged and never fails the launch, request or top-up it rides on):
//   * launch credit: tryGrantLaunchCredit runs (1) when a managed Venice proxy
//     key is minted for a card wallet (the launch of an agent in credits mode),
//     so the grant lands before the wallet is resolved, and (2) on a card-wallet
//     authorize, for a user whose key was minted before they redeemed.
//   * top-up bonus: tryGrantTopupBonus runs in the Stripe webhook right after
//     the card top-up is credited.

import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";
import {
  codeMatches,
  evaluateLaunchEligibility,
  isCampaignGrantable,
  isVenicePromoEnabled,
  launchCreditReferenceId,
  normalizePromoCode,
  promoLineLabel,
  promoUnspentMicroUsd,
  topupBonusMicroUsd,
  topupBonusReferenceId,
  type LaunchEligibility,
  type LaunchEligibilityFacts,
  type PromoCampaign,
  type PromoKind,
} from "./core";

const SOURCE = "venice-promo";

type QueryError = { code?: string; message?: string } | null;
type Result = { data: unknown; error: QueryError };
type Query = PromiseLike<Result> & {
  select: (...args: unknown[]) => Query;
  eq: (...args: unknown[]) => Query;
  in: (...args: unknown[]) => Query;
  gte: (...args: unknown[]) => Query;
  lte: (...args: unknown[]) => Query;
  lt: (...args: unknown[]) => Query;
  order: (...args: unknown[]) => Query;
  limit: (...args: unknown[]) => Query;
  maybeSingle: () => PromiseLike<Result>;
  insert: (...args: unknown[]) => Query;
  upsert: (...args: unknown[]) => Query;
};

export interface PromoDb {
  from: (table: string) => unknown;
  rpc?: (fn: string, args: Record<string, unknown>) => PromiseLike<Result>;
}

function q(db: PromoDb, table: string): Query {
  return db.from(table) as Query;
}

function resolveDb(db?: PromoDb | null): PromoDb | null {
  return db ?? (supabaseAdmin as unknown as PromoDb | null);
}

function num(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

interface CampaignRow {
  id: string;
  slug: string;
  kind: PromoKind;
  code: string | null;
  enabled: boolean;
  starts_at: string | null;
  ends_at: string | null;
  grant_cutoff_at: string | null;
  budget_micro_usd: number | string;
  per_user_cap_micro_usd: number | string;
  bonus_bps: number | null;
  max_grants: number;
  grant_expiry_days: number;
}

const CAMPAIGN_COLUMNS =
  "id, slug, kind, code, enabled, starts_at, ends_at, grant_cutoff_at, budget_micro_usd, per_user_cap_micro_usd, bonus_bps, max_grants, grant_expiry_days";

export function mapCampaign(row: CampaignRow): PromoCampaign {
  return {
    id: row.id,
    slug: row.slug,
    kind: row.kind,
    code: row.code,
    enabled: row.enabled === true,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    grantCutoffAt: row.grant_cutoff_at,
    budgetMicroUsd: num(row.budget_micro_usd),
    perUserCapMicroUsd: num(row.per_user_cap_micro_usd),
    bonusBps: row.bonus_bps ?? null,
    maxGrants: row.max_grants,
    grantExpiryDays: row.grant_expiry_days,
  };
}

async function loadEnabledCampaigns(db: PromoDb, kind: PromoKind): Promise<PromoCampaign[]> {
  const { data, error } = await q(db, "venice_promo_campaigns")
    .select(CAMPAIGN_COLUMNS)
    .eq("kind", kind)
    .eq("enabled", true);
  if (error) throw new Error(error.message || "Failed to load Venice promo campaigns");
  return (Array.isArray(data) ? (data as CampaignRow[]) : []).map(mapCampaign);
}

export type GrantStatus =
  | "granted"
  | "already_granted"
  | "disabled"
  | "not_started"
  | "ended"
  | "budget_exhausted"
  | "max_grants_reached"
  | "campaign_not_found";

export interface GrantOutcome {
  granted: boolean;
  status: GrantStatus;
  grantId?: string;
  amountMicroUsd?: number;
}

async function callGrant(
  db: PromoDb,
  params: {
    campaignId: string;
    userId: string;
    amountMicroUsd: number;
    referenceId: string;
    eligibilityReason: string;
    now: Date;
  }
): Promise<GrantOutcome> {
  if (typeof db.rpc !== "function") throw new Error("Venice promo grants need a database client that can call rpc");
  const { data, error } = await db.rpc("grant_venice_promo", {
    p_campaign_id: params.campaignId,
    p_user_id: params.userId,
    p_amount_micro_usd: params.amountMicroUsd,
    p_reference_id: params.referenceId,
    p_eligibility_reason: params.eligibilityReason,
    p_now: params.now.toISOString(),
  });
  if (error || !data || typeof data !== "object") {
    throw new Error(`grant_venice_promo failed: ${error?.message ?? "no result"}`);
  }
  const r = data as Record<string, unknown>;
  return {
    granted: r.granted === true,
    status: String(r.status) as GrantStatus,
    grantId: typeof r.grantId === "string" ? r.grantId : undefined,
    amountMicroUsd: r.amountMicroUsd === undefined ? undefined : num(r.amountMicroUsd),
  };
}

// --- Redemption ----------------------------------------------------------------

export interface VeniceAttributionInput {
  /** The ?ref value the attribution cookie carries (e.g. "venice"). */
  ref?: string | null;
  /** A promo code the user typed or the cookie carries. */
  code?: string | null;
}

export type RedeemStatus = "saved" | "already_saved" | "already_granted" | "invalid_code" | "disabled";

/**
 * Remember that this user came through the Venice promo (by typed code or by
 * ref=venice). It grants nothing by itself: the credit is granted when they
 * launch with credits (tryGrantLaunchCredit). The campaign is found by code, or,
 * for ref=venice with no code, by the single enabled launch campaign's code.
 */
export async function recordVeniceAttribution(
  params: { userId: string; attribution: VeniceAttributionInput; now?: Date },
  dbArg?: PromoDb | null
): Promise<{ status: RedeemStatus }> {
  if (!isVenicePromoEnabled()) return { status: "disabled" };
  const db = resolveDb(dbArg);
  if (!db) throw new Error("Database not configured");
  const now = params.now ?? new Date();

  const code = normalizePromoCode(params.attribution.code);
  const refIsVenice = (params.attribution.ref ?? "").trim().toLowerCase() === "venice";
  if (!code && !refIsVenice) return { status: "invalid_code" };

  const campaigns = (await loadEnabledCampaigns(db, "launch_credit")).filter((c) => isCampaignGrantable(c, now));
  const campaign = code
    ? campaigns.find((c) => codeMatches(c.code, code))
    : campaigns.find((c) => normalizePromoCode(c.code) === "VENICE");
  if (!campaign) return { status: "invalid_code" };

  const { data: grant, error: grantError } = await q(db, "venice_promo_grants")
    .select("id")
    .eq("campaign_id", campaign.id)
    .eq("user_id", params.userId)
    .maybeSingle();
  if (grantError) throw new Error(grantError.message || "Failed to read Venice promo grants");
  if (grant) return { status: "already_granted" };

  const { data: existing, error: existingError } = await q(db, "venice_promo_redemptions")
    .select("id")
    .eq("campaign_id", campaign.id)
    .eq("user_id", params.userId)
    .maybeSingle();
  if (existingError) throw new Error(existingError.message || "Failed to read Venice promo redemptions");
  if (existing) return { status: "already_saved" };

  const { error } = await q(db, "venice_promo_redemptions").insert({
    campaign_id: campaign.id,
    user_id: params.userId,
    source: code ? "code" : "ref",
    code: code ?? null,
  });
  // A concurrent identical redeem loses on the unique key: same outcome.
  if (error && error.code !== "23505") throw new Error(error.message || "Failed to save Venice promo redemption");
  return { status: error ? "already_saved" : "saved" };
}

/** The redeem route's entry point: a typed code. */
export function redeemVeniceCode(
  params: { userId: string; code: unknown; ref?: string | null; now?: Date },
  db?: PromoDb | null
) {
  return recordVeniceAttribution(
    { userId: params.userId, attribution: { code: normalizePromoCode(params.code), ref: params.ref ?? null }, now: params.now },
    db
  );
}

// --- Launch credit -------------------------------------------------------------

export interface LaunchFactsDeps {
  resolveSubscription: (userId: string) => Promise<{ plan: string; status: string; source: string } | null>;
  loadStripeHistory: (userId: string) => Promise<{
    customerId: string | null;
    currentSubscriptionId: string | null;
    subscriptions: Array<{
      id: string;
      status: string;
      startDate: number | null;
      endedAt: number | null;
      trialEnd: number | null;
    }>;
  }>;
}

/**
 * The facts behind launch eligibility, from the Stripe lane: the plan the user
 * holds now (hermes_subscriptions through resolveEffectiveSubscription) and
 * every subscription Stripe has for their customer. The hermes_subscriptions row
 * is rewritten when someone resubscribes, so Stripe is the only complete
 * history. Plans held through another lane (Apple, yearly token, token holding)
 * are not eligible: their history is not comparable.
 */
export async function loadLaunchEligibilityFacts(
  userId: string,
  deps: LaunchFactsDeps
): Promise<{ facts: LaunchEligibilityFacts | null; unsupported: boolean }> {
  const sub = await deps.resolveSubscription(userId);
  const hasActivePaidPlan = Boolean(sub && sub.plan !== "free" && (sub.status === "active" || sub.status === "trialing"));
  if (!sub || !hasActivePaidPlan) {
    return {
      facts: { hasActivePaidPlan: false, currentRunStartedAt: null, hasPriorPaid: false, priorPaidEndedAt: null },
      unsupported: false,
    };
  }
  if (sub.source !== "stripe") return { facts: null, unsupported: true };

  const history = await deps.loadStripeHistory(userId);
  if (!history.customerId) return { facts: null, unsupported: true };

  const live = new Set(["active", "trialing", "past_due", "unpaid"]);
  const subs = history.subscriptions;
  const current =
    subs.find((s) => s.id === history.currentSubscriptionId) ??
    subs.filter((s) => live.has(s.status)).sort((a, b) => (b.startDate ?? 0) - (a.startDate ?? 0))[0] ??
    null;
  if (!current) return { facts: null, unsupported: true };

  // An earlier paid subscription: not the current one, and not one that never
  // took payment (incomplete, or cancelled before its trial ended).
  const prior = subs.filter((s) => {
    if (s.id === current.id) return false;
    if (s.status === "incomplete" || s.status === "incomplete_expired") return false;
    if (s.status === "canceled" && s.trialEnd && s.endedAt && s.endedAt <= s.trialEnd) return false;
    return true;
  });
  const ended = prior.filter((s) => s.endedAt !== null).map((s) => s.endedAt as number);
  const stillLivePrior = prior.some((s) => s.endedAt === null);

  return {
    facts: {
      hasActivePaidPlan: true,
      currentRunStartedAt: current.startDate ? new Date(current.startDate * 1000) : null,
      hasPriorPaid: prior.length > 0,
      // A prior subscription that has not ended means they are an existing subscriber.
      priorPaidEndedAt: stillLivePrior || ended.length === 0 ? null : new Date(Math.max(...ended) * 1000),
    },
    unsupported: false,
  };
}

async function defaultLaunchFactsDeps(db: PromoDb): Promise<LaunchFactsDeps> {
  const { resolveEffectiveSubscription } = await import("@/lib/billing/instance-entitlement");
  const { getStripe } = await import("@/lib/stripe");
  return {
    resolveSubscription: async (userId) => {
      const sub = await resolveEffectiveSubscription(userId, { throwOnQueryError: true });
      return sub ? { plan: sub.plan, status: sub.status, source: sub.source } : null;
    },
    loadStripeHistory: async (userId) => {
      const { data, error } = await q(db, "hermes_subscriptions")
        .select("stripe_customer_id, stripe_subscription_id")
        .eq("user_id", userId)
        .maybeSingle();
      if (error) throw new Error(error.message || "Failed to read hermes_subscriptions");
      const row = (data ?? null) as { stripe_customer_id?: string | null; stripe_subscription_id?: string | null } | null;
      const customerId = row?.stripe_customer_id ?? null;
      if (!customerId) return { customerId: null, currentSubscriptionId: null, subscriptions: [] };
      const list = await getStripe().subscriptions.list({ customer: customerId, status: "all", limit: 100 });
      return {
        customerId,
        currentSubscriptionId: row?.stripe_subscription_id ?? null,
        subscriptions: list.data.map((s) => ({
          id: s.id,
          status: s.status,
          startDate: s.start_date ?? null,
          endedAt: s.ended_at ?? s.canceled_at ?? null,
          trialEnd: s.trial_end ?? null,
        })),
      };
    },
  };
}

export interface LaunchCreditResult {
  attempted: boolean;
  outcome?: GrantOutcome;
  eligibility?: LaunchEligibility;
  skipped?: string;
}

/**
 * Grant the launch credit when everything holds: flag on, an enabled and open
 * launch campaign, the user redeemed the code (or arrived with ref=venice), no
 * grant yet, and eligibility per evaluateLaunchEligibility. Never throws.
 */
export async function tryGrantLaunchCredit(
  params: { userId: string; now?: Date; factsDeps?: LaunchFactsDeps },
  dbArg?: PromoDb | null
): Promise<LaunchCreditResult> {
  if (!isVenicePromoEnabled()) return { attempted: false, skipped: "flag_off" };
  try {
    const db = resolveDb(dbArg);
    if (!db) return { attempted: false, skipped: "no_database" };
    const now = params.now ?? new Date();

    const campaigns = (await loadEnabledCampaigns(db, "launch_credit")).filter((c) => isCampaignGrantable(c, now));
    if (campaigns.length === 0) return { attempted: false, skipped: "no_open_campaign" };

    const { data: redemptions, error } = await q(db, "venice_promo_redemptions")
      .select("campaign_id")
      .eq("user_id", params.userId)
      .in("campaign_id", campaigns.map((c) => c.id));
    if (error) throw new Error(error.message || "Failed to read Venice promo redemptions");
    const redeemed = new Set((Array.isArray(redemptions) ? redemptions : []).map((r) => (r as { campaign_id: string }).campaign_id));
    const campaign = campaigns.find((c) => redeemed.has(c.id));
    if (!campaign) return { attempted: false, skipped: "not_redeemed" };

    const { data: existingGrant, error: grantError } = await q(db, "venice_promo_grants")
      .select("id")
      .eq("campaign_id", campaign.id)
      .eq("user_id", params.userId)
      .maybeSingle();
    if (grantError) throw new Error(grantError.message || "Failed to read Venice promo grants");
    if (existingGrant) return { attempted: false, skipped: "already_granted" };

    const deps = params.factsDeps ?? (await defaultLaunchFactsDeps(db));
    const { facts, unsupported } = await loadLaunchEligibilityFacts(params.userId, deps);
    const eligibility: LaunchEligibility = facts
      ? evaluateLaunchEligibility(facts, now)
      : { eligible: false, reason: unsupported ? "unsupported_plan_source" : "no_paid_plan" };
    if (!eligibility.eligible) return { attempted: false, eligibility, skipped: "not_eligible" };

    const outcome = await callGrant(db, {
      campaignId: campaign.id,
      userId: params.userId,
      amountMicroUsd: campaign.perUserCapMicroUsd,
      referenceId: launchCreditReferenceId(campaign.id, params.userId),
      eligibilityReason: eligibility.reason,
      now,
    });
    if (outcome.granted) {
      log.info("Venice launch credit granted", {
        source: SOURCE,
        userId: params.userId,
        campaign: campaign.slug,
        amountMicroUsd: outcome.amountMicroUsd,
        eligibilityReason: eligibility.reason,
      });
    }
    return { attempted: true, outcome, eligibility };
  } catch (error) {
    log.warn("Venice launch credit grant failed", {
      source: SOURCE,
      failureType: "venice_launch_credit_failed",
      userId: params.userId,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return { attempted: false, skipped: "error" };
  }
}

// --- Top-up bonus --------------------------------------------------------------

export interface TopupBonusDeps {
  resolveSubscription: LaunchFactsDeps["resolveSubscription"];
}

export interface TopupBonusResult {
  attempted: boolean;
  outcome?: GrantOutcome;
  skipped?: string;
}

/**
 * An existing subscriber's first card top-up during the campaign gets a bonus
 * (bonus_bps of the amount, capped). Called after the top-up is credited, so it
 * runs again on a webhook replay; that is safe because
 *   * the grant's reference_id is derived from the campaign and the Stripe
 *     session, and the SQL function treats a repeat as already_granted;
 *   * (campaign, user) is unique, so a second top-up can never earn another;
 *   * "first" is decided from the ledger itself (the earliest stripe_topup since
 *     the campaign started), not from timing, so a replay reaches the same answer.
 * Never throws.
 */
export async function tryGrantTopupBonus(
  params: { userId: string; sessionId: string; amountMicroUsd: number; now?: Date; deps?: TopupBonusDeps },
  dbArg?: PromoDb | null
): Promise<TopupBonusResult> {
  if (!isVenicePromoEnabled()) return { attempted: false, skipped: "flag_off" };
  try {
    const db = resolveDb(dbArg);
    if (!db) return { attempted: false, skipped: "no_database" };
    const now = params.now ?? new Date();

    const campaigns = (await loadEnabledCampaigns(db, "topup_bonus")).filter((c) => isCampaignGrantable(c, now));
    const campaign = campaigns[0];
    if (!campaign || !campaign.bonusBps || !campaign.startsAt) return { attempted: false, skipped: "no_open_campaign" };

    const bonus = topupBonusMicroUsd(params.amountMicroUsd, campaign.bonusBps, campaign.perUserCapMicroUsd);
    if (bonus <= 0) return { attempted: false, skipped: "no_bonus" };

    const resolveSubscription =
      params.deps?.resolveSubscription ?? (await defaultLaunchFactsDeps(db)).resolveSubscription;
    const sub = await resolveSubscription(params.userId);
    const isSubscriber = Boolean(sub && sub.plan !== "free" && (sub.status === "active" || sub.status === "trialing"));
    if (!isSubscriber) return { attempted: false, skipped: "not_a_subscriber" };

    const { data: first, error } = await q(db, "managed_venice_card_ledger_entries")
      .select("reference_id")
      .eq("user_id", params.userId)
      .eq("source", "stripe")
      .eq("reason", "stripe_topup")
      .gte("created_at", campaign.startsAt)
      .order("created_at", { ascending: true })
      .limit(1);
    if (error) throw new Error(error.message || "Failed to read card top-ups");
    const firstRef = (Array.isArray(first) && first[0] ? (first[0] as { reference_id: string }).reference_id : null) ?? null;
    if (firstRef !== params.sessionId) return { attempted: false, skipped: "not_first_topup" };

    const outcome = await callGrant(db, {
      campaignId: campaign.id,
      userId: params.userId,
      amountMicroUsd: bonus,
      referenceId: topupBonusReferenceId(campaign.id, params.sessionId),
      eligibilityReason: "existing_subscriber_first_topup",
      now,
    });
    if (outcome.granted) {
      log.info("Venice top-up bonus granted", {
        source: SOURCE,
        userId: params.userId,
        campaign: campaign.slug,
        amountMicroUsd: outcome.amountMicroUsd,
      });
    }
    return { attempted: true, outcome };
  } catch (error) {
    log.warn("Venice top-up bonus grant failed", {
      source: SOURCE,
      failureType: "venice_topup_bonus_failed",
      userId: params.userId,
      sessionId: params.sessionId,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return { attempted: false, skipped: "error" };
  }
}

// --- Expiry --------------------------------------------------------------------

export interface ExpiryRunSummary {
  due: number;
  expired: number;
  spent: number;
  skipped: number;
  failed: number;
  removedMicroUsd: number;
}

/** Close every active grant past expires_at, removing only its unspent part. */
export async function expireDuePromoGrants(
  params: { now?: Date; limit?: number } = {},
  dbArg?: PromoDb | null
): Promise<ExpiryRunSummary> {
  const db = resolveDb(dbArg);
  if (!db) throw new Error("Database not configured");
  if (typeof db.rpc !== "function") throw new Error("Venice promo expiry needs a database client that can call rpc");
  const now = params.now ?? new Date();
  const { data, error } = await q(db, "venice_promo_grants")
    .select("id")
    .eq("status", "active")
    .lte("expires_at", now.toISOString())
    .order("expires_at", { ascending: true })
    .limit(params.limit ?? 200);
  if (error) throw new Error(error.message || "Failed to list due Venice promo grants");
  const due = (Array.isArray(data) ? data : []) as Array<{ id: string }>;

  const summary: ExpiryRunSummary = { due: due.length, expired: 0, spent: 0, skipped: 0, failed: 0, removedMicroUsd: 0 };
  for (const grant of due) {
    try {
      const { data: result, error: rpcError } = await db.rpc("expire_venice_promo_grant", {
        p_grant_id: grant.id,
        p_now: now.toISOString(),
      });
      if (rpcError || !result || typeof result !== "object") {
        throw new Error(rpcError?.message ?? "no result");
      }
      const r = result as Record<string, unknown>;
      if (r.expired === true) {
        if (r.status === "spent") summary.spent += 1;
        else summary.expired += 1;
        summary.removedMicroUsd += num(r.removedMicroUsd);
      } else {
        summary.skipped += 1;
      }
    } catch (err) {
      summary.failed += 1;
      log.warn("Venice promo grant expiry failed", {
        source: SOURCE,
        failureType: "venice_promo_expiry_failed",
        grantId: grant.id,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return summary;
}

// --- What the user sees -------------------------------------------------------

export interface PromoLine {
  grantId: string;
  kind: PromoKind;
  remainingMicroUsd: number;
  expiresAt: string;
  label: string;
}

/** Active promo money as part of the user's credits, one line per grant. */
export async function getUserPromoLines(userId: string, dbArg?: PromoDb | null, now: Date = new Date()): Promise<PromoLine[]> {
  const db = resolveDb(dbArg);
  if (!db) return [];
  const { data, error } = await q(db, "venice_promo_grants")
    .select("id, campaign_id, amount_micro_usd, granted_at, expires_at")
    .eq("user_id", userId)
    .eq("status", "active")
    .order("granted_at", { ascending: true });
  if (error) throw new Error(error.message || "Failed to read Venice promo grants");
  const grants = (Array.isArray(data) ? data : []) as Array<{
    id: string;
    campaign_id: string;
    amount_micro_usd: number | string;
    granted_at: string;
    expires_at: string;
  }>;
  const open = grants.filter((g) => Date.parse(g.expires_at) > now.getTime());
  if (open.length === 0) return [];

  const { data: camps, error: campError } = await q(db, "venice_promo_campaigns")
    .select("id, kind")
    .in("id", open.map((g) => g.campaign_id));
  if (campError) throw new Error(campError.message || "Failed to read Venice promo campaigns");
  const kindById = new Map((Array.isArray(camps) ? camps : []).map((c) => [(c as { id: string }).id, (c as { kind: PromoKind }).kind]));

  const earliest = open[0].granted_at;
  const { data: debits, error: debitError } = await q(db, "managed_venice_card_ledger_entries")
    .select("amount_micro_usd, created_at")
    .eq("user_id", userId)
    .eq("reason", "managed_venice_debit")
    .gte("created_at", earliest);
  if (debitError) throw new Error(debitError.message || "Failed to read card spend");
  const debitRows = (Array.isArray(debits) ? debits : []) as Array<{ amount_micro_usd: number | string; created_at: string }>;

  return open.map((g) => {
    const amount = num(g.amount_micro_usd);
    const spend = debitRows
      .filter((d) => Date.parse(d.created_at) >= Date.parse(g.granted_at))
      .reduce((sum, d) => sum - Math.min(0, num(d.amount_micro_usd)), 0);
    const remaining = promoUnspentMicroUsd(amount, spend);
    const kind = kindById.get(g.campaign_id) ?? "launch_credit";
    return {
      grantId: g.id,
      kind,
      remainingMicroUsd: remaining,
      expiresAt: g.expires_at,
      label: promoLineLabel(kind, remaining, g.expires_at),
    };
  }).filter((line) => line.remainingMicroUsd > 0);
}
