// Pure rules for the Venice promo campaigns (no database, no clock reads).
// The money-moving steps (grant, expiry) are SQL functions in
// supabase/migrations/20261111143017_venice_promo_campaigns.sql; these helpers
// decide who qualifies, size a bonus, and mirror the expiry math for display
// and tests.

export const VENICE_PROMO_FLAG = "HIVRA_VENICE_PROMO_ENABLED";
export const RETURNING_SUBSCRIBER_MIN_GAP_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Master switch. Anything but the exact string "true" is off. */
export function isVenicePromoEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[VENICE_PROMO_FLAG] === "true";
}

export type PromoKind = "launch_credit" | "topup_bonus";

export interface PromoCampaign {
  id: string;
  slug: string;
  kind: PromoKind;
  code: string | null;
  enabled: boolean;
  startsAt: string | null;
  endsAt: string | null;
  grantCutoffAt: string | null;
  budgetMicroUsd: number;
  perUserCapMicroUsd: number;
  bonusBps: number | null;
  maxGrants: number;
  grantExpiryDays: number;
}

/** A campaign can grant right now (the SQL function re-checks all of this). */
export function isCampaignGrantable(campaign: PromoCampaign, now: Date): boolean {
  if (!campaign.enabled || !campaign.startsAt) return false;
  const cutoff = campaign.grantCutoffAt ?? campaign.endsAt;
  if (!cutoff) return false;
  const t = now.getTime();
  if (t < Date.parse(campaign.startsAt) || t > Date.parse(cutoff)) return false;
  if (campaign.endsAt && t > Date.parse(campaign.endsAt)) return false;
  return true;
}

/** Codes are case-insensitive: trim, upper-case, and only letters, digits, "-" and "_". */
export function normalizePromoCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.trim().toUpperCase();
  return /^[A-Z0-9_-]{1,32}$/.test(code) ? code : null;
}

export function codeMatches(campaignCode: string | null, input: string | null): boolean {
  return Boolean(campaignCode && input && normalizePromoCode(campaignCode) === input);
}

// --- Launch credit eligibility -------------------------------------------------

export interface LaunchEligibilityFacts {
  /** An active (or trialing) paid plan right now. */
  hasActivePaidPlan: boolean;
  /** When the current run of the paid plan began. Null when unknown. */
  currentRunStartedAt: Date | null;
  /** True when the user had any paid subscription before the current run. */
  hasPriorPaid: boolean;
  /** When the most recent earlier paid subscription ended. Null when none ended. */
  priorPaidEndedAt: Date | null;
}

export type LaunchEligibilityReason =
  | "new_subscriber"
  | "returning_subscriber"
  | "no_paid_plan"
  | "existing_subscriber"
  | "returned_too_soon"
  | "unsupported_plan_source";

export interface LaunchEligibility {
  eligible: boolean;
  reason: LaunchEligibilityReason;
}

/**
 * Launch credit goes to
 *   (a) a new subscriber: an active paid plan and no earlier paid subscription;
 *   (b) a returning subscriber: an earlier paid subscription that ended at least
 *       30 days before the current run began.
 * Anyone else is an existing subscriber (an earlier subscription still live, or
 * one that ended less than 30 days before they came back) and is not eligible.
 */
export function evaluateLaunchEligibility(facts: LaunchEligibilityFacts, now: Date): LaunchEligibility {
  if (!facts.hasActivePaidPlan) return { eligible: false, reason: "no_paid_plan" };
  if (!facts.hasPriorPaid) return { eligible: true, reason: "new_subscriber" };
  if (!facts.priorPaidEndedAt) return { eligible: false, reason: "existing_subscriber" };
  const returnedAt = (facts.currentRunStartedAt ?? now).getTime();
  const gapMs = returnedAt - facts.priorPaidEndedAt.getTime();
  if (gapMs >= RETURNING_SUBSCRIBER_MIN_GAP_DAYS * DAY_MS) {
    return { eligible: true, reason: "returning_subscriber" };
  }
  return { eligible: false, reason: "returned_too_soon" };
}

// --- Top-up bonus --------------------------------------------------------------

/** bonus = paid * bps / 10,000 rounded down, capped. Integer micro-USD. */
export function topupBonusMicroUsd(paidMicroUsd: number, bonusBps: number, capMicroUsd: number): number {
  if (!Number.isSafeInteger(paidMicroUsd) || paidMicroUsd <= 0) return 0;
  if (!Number.isInteger(bonusBps) || bonusBps <= 0) return 0;
  const raw = (BigInt(paidMicroUsd) * BigInt(bonusBps)) / BigInt(10_000);
  const capped = raw < BigInt(capMicroUsd) ? raw : BigInt(capMicroUsd);
  return Number(capped);
}

export function topupBonusReferenceId(campaignId: string, sessionId: string): string {
  return `topup_bonus:${campaignId}:${sessionId}`;
}

export function launchCreditReferenceId(campaignId: string, userId: string): string {
  return `launch_credit:${campaignId}:${userId}`;
}

// --- Expiry math (mirror of expire_venice_promo_grant) --------------------------

/** Card spend since the grant consumes the promo money first. */
export function promoSpentMicroUsd(amountMicroUsd: number, cardSpendSinceGrantMicroUsd: number): number {
  return Math.min(Math.max(0, cardSpendSinceGrantMicroUsd), amountMicroUsd);
}

export function promoUnspentMicroUsd(amountMicroUsd: number, cardSpendSinceGrantMicroUsd: number): number {
  return amountMicroUsd - promoSpentMicroUsd(amountMicroUsd, cardSpendSinceGrantMicroUsd);
}

/** What expiry takes out of the wallet: the unspent promo part, never more than what is available. */
export function promoExpiryRemovalMicroUsd(params: {
  amountMicroUsd: number;
  cardSpendSinceGrantMicroUsd: number;
  walletAvailableMicroUsd: number;
}): number {
  return Math.min(
    promoUnspentMicroUsd(params.amountMicroUsd, params.cardSpendSinceGrantMicroUsd),
    Math.max(0, params.walletAvailableMicroUsd)
  );
}

// --- Display -------------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatPromoDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

function formatUsd(microUsd: number): string {
  const dollars = Math.floor(microUsd / 10_000) / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

/** "$10 Venice launch credit, expires 12 Dec" */
export function promoLineLabel(kind: PromoKind, remainingMicroUsd: number, expiresAtIso: string): string {
  const name = kind === "launch_credit" ? "Venice launch credit" : "Venice top-up bonus";
  return `${formatUsd(remainingMicroUsd)} ${name}, expires ${formatPromoDate(expiresAtIso)}`;
}
