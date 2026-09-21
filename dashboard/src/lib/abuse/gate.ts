import { hasPlanAccessStatus } from "@/lib/billing/subscription-status";
import { resolveEffectiveSubscription } from "@/lib/billing/instance-entitlement";
import { log } from "@/lib/logger";
import { assessRisk } from "./risk-scorer";
import { getRiskAssessment, type RiskAssessmentRow } from "./repository";

const LOG_SOURCE = "abuse-gate";

/**
 * How recently must a "decision=allow" assessment have been computed to be
 * trusted without re-checking? 30 days balances:
 *   - not re-pinging proxycheck/FPJS every single provisioning request
 *   - catching accounts whose situation changed (compromise, abuse pattern)
 */
const ASSESSMENT_FRESHNESS_DAYS = 30;

export type GateOutcome =
  | { allow: true }
  | {
      allow: false;
      status: number;
      message: string;
      reason: "blocked" | "card_required";
      assessment?: RiskAssessmentRow | null;
    };

export interface GateInputs {
  userId: string;
  ip: string | null;
  email: string | null;
  fingerprintRequestId: string | null;
}

/**
 * The free-tier abuse gate. Run BEFORE InstanceService.createInstance() in
 * the POST /api/instances handler.
 *
 * Decision tree:
 *   1. Paid subscriber? → allow (they passed Stripe checkout)
 *   2. Existing assessment with card_satisfied_at? → allow (they put a card on file)
 *   3. Existing assessment with decision="allow" + recent? → allow (already cleared)
 *   4. Existing assessment with decision="block"? → deny
 *   5. Existing assessment with decision="require_card" + no card? → deny w/ card-required
 *   6. No assessment / stale assessment → compute fresh, then act on decision
 *
 * Fail-open posture: if anything in the gate logic itself throws, we log
 * and return allow=true. Better to provision an occasional bad actor than
 * to take down legitimate signups when proxycheck is flaky. Hard-block
 * cases (decision="block") still deny because they came from explicit
 * upstream signals, not from a gate failure.
 */
export async function checkProvisioningGate(
  inputs: GateInputs
): Promise<GateOutcome> {
  try {
    // Step 1: paid subscribers and token-holding qualifiers bypass
    // entirely. Stripe checkout is itself a strong signal, and a user
    // who has put real money down via $HERMESOS to qualify for Pro /
    // Power tier has cleared an equivalently strong bar — we don't
    // want either group tripped up by a re-check that might block
    // legit users on residential VPNs.
    if (await hasEntitledAccess(inputs.userId)) {
      return { allow: true };
    }

    // Step 2-5: check existing assessment
    const existing = await getRiskAssessment(inputs.userId);
    const cached = evaluateExistingAssessment(existing);
    if (cached) {
      return cached;
    }

    // Step 6: compute fresh assessment
    const assessment = await assessRisk(inputs);

    if (assessment.decision === "block") {
      log.warn("abuse gate blocking provisioning", {
        source: LOG_SOURCE,
        failureType: "abuse_gate_block",
        userId: inputs.userId,
        score: assessment.score,
        tier: assessment.tier,
      });
      return {
        allow: false,
        status: 403,
        message:
          "Account flagged by automated review. Contact support if this is in error.",
        reason: "blocked",
      };
    }

    if (assessment.decision === "require_card") {
      log.info("abuse gate requiring card on file", {
        source: LOG_SOURCE,
        userId: inputs.userId,
        score: assessment.score,
        tier: assessment.tier,
      });
      return {
        allow: false,
        status: 402,
        message:
          "Card on file required to deploy on the free tier. No charge will be made.",
        reason: "card_required",
      };
    }

    return { allow: true };
  } catch (err) {
    // Fail-open. Log loudly so we notice gate breakage in ops dashboards.
    log.error(
      "abuse gate threw — failing open",
      err instanceof Error ? err : new Error("non-error thrown by gate"),
      {
        source: LOG_SOURCE,
        failureType: "abuse_gate_exception",
        userId: inputs.userId,
        errorName: err instanceof Error ? err.name : typeof err,
      }
    );
    return { allow: true };
  }
}

/**
 * Decide whether an existing assessment is fresh enough to short-circuit
 * the gate without re-running providers. Returns null if we should
 * re-compute, or a final outcome if we can use the cached row.
 */
function evaluateExistingAssessment(
  row: RiskAssessmentRow | null
): GateOutcome | null {
  if (!row) return null;

  // Card-on-file always passes: they cleared the gate once, that's enough
  // until a manual review knocks them back. (We don't auto-revoke today;
  // that'd be a follow-up if we see card-bypass abuse.)
  if (row.card_satisfied_at) {
    return { allow: true };
  }

  // Hard block sticks until manually cleared.
  if (row.decision === "block") {
    return {
      allow: false,
      status: 403,
      message: blockMessageForRow(row),
      reason: "blocked",
      assessment: row,
    };
  }

  // require_card without card_satisfied_at → still needs the card
  if (row.decision === "require_card") {
    return {
      allow: false,
      status: 402,
      message:
        "Card on file required to deploy on the free tier. No charge will be made.",
      reason: "card_required",
      assessment: row,
    };
  }

  // decision === "allow" — trust if recent, recompute if stale
  if (row.decision === "allow" && isAssessmentFresh(row)) {
    return { allow: true };
  }

  return null;
}

function isAssessmentFresh(row: RiskAssessmentRow): boolean {
  const checked = Date.parse(row.last_checked_at);
  if (Number.isNaN(checked)) return false;
  const ageMs = Date.now() - checked;
  const maxAgeMs = ASSESSMENT_FRESHNESS_DAYS * 24 * 60 * 60 * 1000;
  return ageMs <= maxAgeMs;
}

/**
 * Tailor the 403 block message based on raw_signals.block_reason. The
 * webhook layer writes a reason when it rejects a card (prepaid or
 * fingerprint collision); surfacing it here lets the user understand
 * the failure is about their card, not their account in general.
 *
 * Falls back to the generic message when the reason is missing or
 * unrecognised — older block decisions written before this field
 * existed are still served the legacy message.
 */
function blockMessageForRow(row: RiskAssessmentRow): string {
  const reason =
    typeof row.raw_signals === "object" && row.raw_signals !== null
      ? (row.raw_signals as Record<string, unknown>).block_reason
      : null;

  if (reason === "prepaid_card") {
    return "Prepaid and virtual cards aren't accepted on the free tier. Please use a credit or debit card.";
  }
  if (reason === "card_collision") {
    return "This card is already on file for another account. Please use a different card or contact support.";
  }
  return "Account flagged by automated review. Contact support if this is in error.";
}

/**
 * Either a paid Stripe subscriber or a token-holding tier qualifier
 * bypasses the abuse gate. Both have put money down via a path that's
 * itself a strong signal of intent.
 *
 * Fail-closed on infrastructure error: if the subscription/qualification
 * lookup throws, we treat the user as non-entitled and let the regular
 * gate logic run. That keeps a flaky DB read from inadvertently
 * whitelisting a flagged account.
 */
async function hasEntitledAccess(userId: string): Promise<boolean> {
  try {
    const sub = await resolveEffectiveSubscription(userId);
    if (!sub) return false;
    if (sub.source === "token_holding") return true;
    // Stripe path — preserve the existing access-status check (which
    // accepts 'trialing' on top of 'active'/'past_due'), just routed
    // through the resolver for a single source of truth.
    return hasPlanAccessStatus(sub.status);
  } catch (error) {
    log.warn("hasEntitledAccess query failed — treating as non-entitled", {
      source: LOG_SOURCE,
      failureType: "subscription_status_query_failed",
      userId,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
