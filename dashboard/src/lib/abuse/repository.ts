import { supabaseAdmin } from "@/lib/supabase";
import { log } from "@/lib/logger";

const LOG_SOURCE = "abuse-repository";

/**
 * Persistence layer for the signup_risk_assessments table.
 *
 * All mutations go through the service-role client; RLS denies writes from
 * end-user sessions by design (see 20260430180000_signup_risk_assessments.sql).
 * Reads via this module are intended for server-side gate checks; for
 * end-user "why is my account held?" surfaces, query directly through the
 * RLS-bound supabase client.
 */

export type RiskTier = "low" | "medium" | "high" | "critical";
export type RiskDecision = "allow" | "require_card" | "block";

export interface RiskAssessmentRow {
  user_id: string;
  ip_address: string | null;
  asn: string | null;
  asn_organization: string | null;
  country_code: string | null;
  is_vpn: boolean;
  is_proxy: boolean;
  is_tor: boolean;
  is_datacenter: boolean;
  email_domain: string | null;
  is_disposable_email: boolean;
  fingerprint_visitor_id: string | null;
  fingerprint_request_id: string | null;
  fingerprint_confidence: number | null;
  risk_score: number;
  risk_tier: RiskTier;
  decision: RiskDecision;
  card_required_at: string | null;
  card_satisfied_at: string | null;
  card_setup_intent_id: string | null;
  card_payment_method_id: string | null;
  card_fingerprint: string | null;
  card_funding: string | null;
  raw_signals: Record<string, unknown>;
  last_checked_at: string;
  created_at: string;
  updated_at: string;
}

export type RiskAssessmentUpsert = Omit<
  RiskAssessmentRow,
  "created_at" | "updated_at" | "last_checked_at"
> & {
  last_checked_at?: string;
};

/**
 * Read the latest risk assessment for a user, or null if none exists.
 * Returns null on DB errors too (logged) — callers should treat null as
 * "no prior assessment" and proceed to compute one.
 */
export async function getRiskAssessment(
  userId: string
): Promise<RiskAssessmentRow | null> {
  if (!supabaseAdmin) {
    log.error(
      "supabaseAdmin not configured — risk assessment read skipped",
      new Error("supabaseAdmin missing"),
      { source: LOG_SOURCE, failureType: "supabase_not_configured" }
    );
    return null;
  }

  const { data, error } = await supabaseAdmin
    .from("signup_risk_assessments")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    log.warn("getRiskAssessment failed", {
      source: LOG_SOURCE,
      failureType: "risk_assessment_read_failed",
      userId,
      errorCode: error.code,
    });
    return null;
  }

  return (data as RiskAssessmentRow | null) ?? null;
}

/**
 * Upsert (insert-or-update) a risk assessment row keyed by user_id. Always
 * refreshes last_checked_at to now() unless an explicit value is supplied.
 */
export async function upsertRiskAssessment(
  row: RiskAssessmentUpsert
): Promise<void> {
  if (!supabaseAdmin) {
    log.error(
      "supabaseAdmin not configured — risk assessment write skipped",
      new Error("supabaseAdmin missing"),
      { source: LOG_SOURCE, failureType: "supabase_not_configured" }
    );
    return;
  }

  const payload = {
    ...row,
    last_checked_at: row.last_checked_at ?? new Date().toISOString(),
  };

  const { error } = await supabaseAdmin
    .from("signup_risk_assessments")
    .upsert(payload, { onConflict: "user_id" });

  if (error) {
    log.error(
      "upsertRiskAssessment failed",
      new Error(error.message || "supabase upsert failed"),
      {
        source: LOG_SOURCE,
        failureType: "risk_assessment_write_failed",
        userId: row.user_id,
        errorCode: error.code,
      }
    );
    // Deliberately don't throw — if persistence fails we still want the
    // gate decision to be applied for THIS request. The next request will
    // re-compute (we'll just lose the historical record).
  }
}

/**
 * Count distinct users that share the same FingerprintJS visitor_id.
 * Used at risk-check time to detect multi-account abuse from one device.
 *
 * Excludes the row for `excludeUserId` (typically the current user being
 * assessed) so we report the count of OTHER accounts sharing this device.
 */
export async function countAccountsWithFingerprint(
  visitorId: string,
  excludeUserId?: string
): Promise<number> {
  if (!supabaseAdmin) return 0;
  if (!visitorId) return 0;

  let query = supabaseAdmin
    .from("signup_risk_assessments")
    .select("user_id", { count: "exact", head: true })
    .eq("fingerprint_visitor_id", visitorId);

  if (excludeUserId) {
    query = query.neq("user_id", excludeUserId);
  }

  const { count, error } = await query;

  if (error) {
    log.warn("countAccountsWithFingerprint failed", {
      source: LOG_SOURCE,
      failureType: "fingerprint_count_failed",
      errorCode: error.code,
    });
    return 0;
  }

  return count ?? 0;
}

/**
 * Find a risk assessment by Stripe SetupIntent id. Used by the webhook
 * handler when setup_intent.succeeded fires — we don't get the user_id in
 * that event payload (only the intent id), so we look it up here.
 */
async function findByCardSetupIntent(
  intentId: string
): Promise<RiskAssessmentRow | null> {
  if (!supabaseAdmin) return null;

  const { data, error } = await supabaseAdmin
    .from("signup_risk_assessments")
    .select("*")
    .eq("card_setup_intent_id", intentId)
    .maybeSingle();

  if (error) {
    log.warn("findByCardSetupIntent failed", {
      source: LOG_SOURCE,
      failureType: "find_by_setup_intent_failed",
      errorCode: error.code,
    });
    return null;
  }

  return (data as RiskAssessmentRow | null) ?? null;
}

/**
 * Mark a user as having a card on file (called from setup_intent.succeeded
 * webhook). Sets card_satisfied_at + card_payment_method_id and flips
 * decision back to "allow" so subsequent provisioning attempts succeed.
 *
 * Uses upsert because the webhook can theoretically fire before
 * attachSetupIntent finishes its write (different code paths, different
 * latencies — Stripe webhooks are fast). The CHECK constraints on
 * decision/risk_tier require sane defaults if we're inserting a fresh row.
 */
export async function markCardOnFile(params: {
  userId: string;
  setupIntentId: string;
  paymentMethodId: string;
  cardFingerprint: string | null;
  cardFunding: string | null;
}): Promise<void> {
  if (!supabaseAdmin) return;

  const now = new Date().toISOString();

  const { error } = await supabaseAdmin.from("signup_risk_assessments").upsert(
    {
      user_id: params.userId,
      card_satisfied_at: now,
      card_setup_intent_id: params.setupIntentId,
      card_payment_method_id: params.paymentMethodId,
      card_fingerprint: params.cardFingerprint,
      card_funding: params.cardFunding,
      decision: "allow",
      // Defaults for fresh-row inserts (NOT NULL columns with CHECKs)
      risk_score: 0,
      risk_tier: "low",
      raw_signals: { source: "card_on_file_webhook" },
    },
    { onConflict: "user_id" }
  );

  if (error) {
    log.error(
      "markCardOnFile failed",
      new Error(error.message || "supabase upsert failed"),
      {
        source: LOG_SOURCE,
        failureType: "card_on_file_mark_failed",
        userId: params.userId,
        errorCode: error.code,
      }
    );
  }
}

/**
 * Reasons we reject a card at the setup_intent.succeeded webhook layer
 * (after Stripe accepted the card itself, but before we'll honour it as
 * "card on file" for the abuse gate).
 *
 *   prepaid_card     PaymentMethod.card.funding === 'prepaid'. Most virtual-
 *                    card services (Privacy.com, Lithic, etc.) issue prepaid
 *                    BINs, so this is the cheapest signal that catches them.
 *
 *   card_collision   Another user already has card_satisfied_at set with the
 *                    same card_fingerprint. Same physical card across two
 *                    accounts → second one is denied.
 */
export type CardRejectionReason = "prepaid_card" | "card_collision";

/**
 * Persist a card-attachment rejection. Stores the card details for audit
 * (so we can see WHICH card was rejected, not just that something was)
 * and flips the assessment to decision='block' so the next provisioning
 * attempt is denied with a tailored message via the gate.
 *
 * Note: we deliberately do NOT set card_satisfied_at — the user still
 * lacks a valid card on file. They can attempt the SetupIntent flow
 * again with a different (non-prepaid, non-collision) card.
 */
export async function markCardRejected(params: {
  userId: string;
  setupIntentId: string;
  paymentMethodId: string;
  cardFingerprint: string | null;
  cardFunding: string | null;
  reason: CardRejectionReason;
}): Promise<void> {
  if (!supabaseAdmin) return;

  const { error } = await supabaseAdmin.from("signup_risk_assessments").upsert(
    {
      user_id: params.userId,
      card_setup_intent_id: params.setupIntentId,
      card_payment_method_id: params.paymentMethodId,
      card_fingerprint: params.cardFingerprint,
      card_funding: params.cardFunding,
      decision: "block",
      // Defaults for fresh-row inserts (NOT NULL columns with CHECKs)
      risk_score: 0,
      risk_tier: "low",
      raw_signals: {
        source: "card_on_file_webhook",
        block_reason: params.reason,
      },
    },
    { onConflict: "user_id" }
  );

  if (error) {
    log.error(
      "markCardRejected failed",
      new Error(error.message || "supabase upsert failed"),
      {
        source: LOG_SOURCE,
        failureType: "card_rejection_mark_failed",
        userId: params.userId,
        errorCode: error.code,
      }
    );
  }
}

/**
 * Look up whether any user OTHER than `excludeUserId` has already cleared
 * the card-on-file gate using the same physical card (matched on Stripe's
 * stable card_fingerprint). Returns the colliding user_id if found, or
 * null otherwise. Used by the setup_intent webhook to deny "same card,
 * second account" abuse.
 *
 * Only considers rows with card_satisfied_at set — an account that
 * attempted the same card and was already rejected isn't a "collision"
 * worth blocking the next user on.
 */
export async function findOtherUserWithSatisfiedFingerprint(
  fingerprint: string,
  excludeUserId: string
): Promise<string | null> {
  if (!supabaseAdmin) return null;
  if (!fingerprint) return null;

  const { data, error } = await supabaseAdmin
    .from("signup_risk_assessments")
    .select("user_id")
    .eq("card_fingerprint", fingerprint)
    .not("card_satisfied_at", "is", null)
    .neq("user_id", excludeUserId)
    .limit(1)
    .maybeSingle();

  if (error) {
    log.warn("findOtherUserWithSatisfiedFingerprint failed", {
      source: LOG_SOURCE,
      failureType: "card_fingerprint_lookup_failed",
      errorCode: error.code,
    });
    return null;
  }

  return (data as { user_id: string } | null)?.user_id ?? null;
}

/**
 * Record that a SetupIntent was created for a user (called when we hand
 * the client_secret back to the frontend). Lets the webhook find this
 * row by intent id when setup_intent.succeeded fires later.
 *
 * Upserts so this works even if the user reached the setup-intent endpoint
 * without a prior risk assessment (e.g. proactive card-on-file).
 */
export async function attachSetupIntent(params: {
  userId: string;
  setupIntentId: string;
}): Promise<void> {
  if (!supabaseAdmin) return;

  const now = new Date().toISOString();

  const { error } = await supabaseAdmin.from("signup_risk_assessments").upsert(
    {
      user_id: params.userId,
      card_setup_intent_id: params.setupIntentId,
      card_required_at: now,
      // Defaults for fresh-row inserts
      risk_score: 0,
      risk_tier: "low",
      decision: "require_card",
      raw_signals: { source: "setup_intent_attach" },
    },
    { onConflict: "user_id", ignoreDuplicates: false }
  );

  if (error) {
    log.warn("attachSetupIntent failed", {
      source: LOG_SOURCE,
      failureType: "attach_setup_intent_failed",
      userId: params.userId,
      errorCode: error.code,
    });
  }
}
