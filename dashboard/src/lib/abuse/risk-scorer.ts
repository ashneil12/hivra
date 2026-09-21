import { log } from "@/lib/logger";
import { lookupIp, type NetworkSignals } from "./proxycheck";
import { checkEmail, type EmailSignals } from "./disposable-email";
import { verifyRequest, type FingerprintSignals } from "./fingerprint";
import {
  countAccountsWithFingerprint,
  upsertRiskAssessment,
  type RiskDecision,
  type RiskTier,
} from "./repository";

const LOG_SOURCE = "abuse-risk-scorer";

/**
 * Risk scoring weights. Tuned for free-tier hosting abuse:
 *   - Tor exit nodes are a near-certain abuse signal (+50)
 *   - Datacenter ASNs catch crypto miners spinning up VMs (+30)
 *   - Disposable email + fingerprint collision = clearly an abuse ring
 *
 * Scores are bucketed into tiers, then mapped to decisions:
 *   low (0-29)        → allow
 *   medium (30-59)    → require_card
 *   high (60-84)      → require_card (same action, higher confidence)
 *   critical (85-100) → block
 *
 * Constants live here (not in the repository) because the *meaning* of a
 * score is policy, and the persistence layer should stay generic.
 */
const WEIGHTS = {
  IS_TOR: 50,
  IS_VPN: 25,
  IS_PROXY: 25,
  IS_DATACENTER: 30,
  IS_DISPOSABLE_EMAIL: 30,
  FPJS_BOT: 50,
  FPJS_INCOGNITO: 10,
  FPJS_VPN: 15,
  FPJS_IP_CHANGED: 10,
  FPJS_LOW_CONFIDENCE: 10,
  PROXYCHECK_HIGH_RISK: 20,
  FINGERPRINT_COLLISION_PER_ACCOUNT: 40,
  FINGERPRINT_COLLISION_CAP: 60,
} as const;

const TIER_THRESHOLDS = {
  low: 29,
  medium: 59,
  high: 84,
  // critical: 85+
} as const;

export interface RiskInputs {
  userId: string;
  ip: string | null;
  email: string | null;
  fingerprintRequestId: string | null;
}

export interface RiskAssessment {
  decision: RiskDecision;
  tier: RiskTier;
  score: number;
  signals: {
    network: NetworkSignals | null;
    email: EmailSignals | null;
    fingerprint: FingerprintSignals | null;
    fingerprintCollisionCount: number;
  };
  /** Human-readable reasons for why each score component fired. */
  reasons: string[];
}

/**
 * Compute a fresh risk assessment for a user and persist it.
 *
 * Calls the three signal providers (proxycheck, disposable email, FPJS)
 * in parallel, aggregates their outputs into a single score, and writes
 * the result to signup_risk_assessments. Returns the assessment so the
 * caller (typically the /api/instances gate) can act on it immediately.
 *
 * Provider failures degrade gracefully (signals come back null, score is
 * computed without their contribution). This is a deliberate fail-open
 * posture: we'd rather let through a few bad actors during a proxycheck
 * outage than block legitimate users when the upstream is flaky. The card-
 * on-file requirement at the medium tier provides a second line of defence.
 */
export async function assessRisk(inputs: RiskInputs): Promise<RiskAssessment> {
  // Fan out to all three providers in parallel — they're independent.
  const [network, email, fingerprint] = await Promise.all([
    inputs.ip ? lookupIp(inputs.ip) : Promise.resolve(null),
    Promise.resolve(checkEmail(inputs.email)),
    inputs.fingerprintRequestId
      ? verifyRequest(inputs.fingerprintRequestId)
      : Promise.resolve(null),
  ]);

  // Fingerprint collision check requires a second DB call, only worth doing
  // if FPJS gave us a visitorId. Do it after the parallel fetch since it
  // depends on the FPJS result.
  let fingerprintCollisionCount = 0;
  if (fingerprint?.visitorId) {
    fingerprintCollisionCount = await countAccountsWithFingerprint(
      fingerprint.visitorId,
      inputs.userId
    );
  }

  const { score, reasons } = computeScore({
    network,
    email,
    fingerprint,
    fingerprintCollisionCount,
  });

  const tier = scoreToTier(score);
  const decision = tierToDecision(tier);

  // Persist. Fire-and-forget at the await level — repository logs errors
  // internally and never throws, so this won't blow up the request flow.
  await upsertRiskAssessment({
    user_id: inputs.userId,
    ip_address: network?.ip ?? inputs.ip ?? null,
    asn: network?.asn ?? null,
    asn_organization: network?.asnOrganization ?? null,
    country_code: network?.countryCode ?? null,
    is_vpn: network?.isVpn ?? false,
    is_proxy: network?.isProxy ?? false,
    is_tor: network?.isTor ?? false,
    is_datacenter: network?.isDatacenter ?? false,
    email_domain: email?.domain ?? null,
    is_disposable_email: email?.isDisposable ?? false,
    fingerprint_visitor_id: fingerprint?.visitorId ?? null,
    fingerprint_request_id: fingerprint?.requestId ?? null,
    fingerprint_confidence: fingerprint?.confidence ?? null,
    risk_score: score,
    risk_tier: tier,
    decision,
    card_required_at: null,
    card_satisfied_at: null,
    card_setup_intent_id: null,
    card_payment_method_id: null,
    card_fingerprint: null,
    card_funding: null,
    raw_signals: {
      network: network?.raw ?? null,
      fingerprint: fingerprint?.raw ?? null,
      collision_count: fingerprintCollisionCount,
      reasons,
    },
  });

  log.info("risk assessment computed", {
    source: LOG_SOURCE,
    userId: inputs.userId,
    score,
    tier,
    decision,
    isVpn: network?.isVpn ?? false,
    isTor: network?.isTor ?? false,
    isDatacenter: network?.isDatacenter ?? false,
    isDisposableEmail: email?.isDisposable ?? false,
    fingerprintCollisionCount,
  });

  return {
    decision,
    tier,
    score,
    signals: { network, email, fingerprint, fingerprintCollisionCount },
    reasons,
  };
}

/**
 * Pure score computation — extracted so it's unit-testable without mocking
 * the upstream providers. Given a bag of signals, returns a 0-100 score
 * and an ordered list of human-readable reasons.
 */
export function computeScore(params: {
  network: NetworkSignals | null;
  email: EmailSignals | null;
  fingerprint: FingerprintSignals | null;
  fingerprintCollisionCount: number;
}): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;

  if (params.network) {
    if (params.network.isTor) {
      score += WEIGHTS.IS_TOR;
      reasons.push(`tor_exit_node (+${WEIGHTS.IS_TOR})`);
    }
    if (params.network.isVpn) {
      score += WEIGHTS.IS_VPN;
      reasons.push(`vpn_detected (+${WEIGHTS.IS_VPN})`);
    }
    if (params.network.isProxy) {
      score += WEIGHTS.IS_PROXY;
      reasons.push(`proxy_detected (+${WEIGHTS.IS_PROXY})`);
    }
    if (params.network.isDatacenter) {
      score += WEIGHTS.IS_DATACENTER;
      reasons.push(`datacenter_ip (+${WEIGHTS.IS_DATACENTER})`);
    }
    if (
      typeof params.network.upstreamRiskScore === "number" &&
      params.network.upstreamRiskScore >= 80
    ) {
      score += WEIGHTS.PROXYCHECK_HIGH_RISK;
      reasons.push(
        `proxycheck_high_risk:${params.network.upstreamRiskScore} (+${WEIGHTS.PROXYCHECK_HIGH_RISK})`
      );
    }
  }

  if (params.email?.isDisposable) {
    score += WEIGHTS.IS_DISPOSABLE_EMAIL;
    reasons.push(`disposable_email:${params.email.domain} (+${WEIGHTS.IS_DISPOSABLE_EMAIL})`);
  }

  if (params.fingerprint) {
    if (params.fingerprint.bot) {
      score += WEIGHTS.FPJS_BOT;
      reasons.push(`fpjs_bot (+${WEIGHTS.FPJS_BOT})`);
    }
    if (params.fingerprint.incognito) {
      score += WEIGHTS.FPJS_INCOGNITO;
      reasons.push(`fpjs_incognito (+${WEIGHTS.FPJS_INCOGNITO})`);
    }
    if (params.fingerprint.vpn) {
      score += WEIGHTS.FPJS_VPN;
      reasons.push(`fpjs_vpn (+${WEIGHTS.FPJS_VPN})`);
    }
    if (params.fingerprint.ipChanged) {
      score += WEIGHTS.FPJS_IP_CHANGED;
      reasons.push(`fpjs_ip_changed (+${WEIGHTS.FPJS_IP_CHANGED})`);
    }
    if (
      typeof params.fingerprint.confidence === "number" &&
      params.fingerprint.confidence < 0.5
    ) {
      score += WEIGHTS.FPJS_LOW_CONFIDENCE;
      reasons.push(
        `fpjs_low_confidence:${params.fingerprint.confidence.toFixed(2)} (+${WEIGHTS.FPJS_LOW_CONFIDENCE})`
      );
    }
  }

  if (params.fingerprintCollisionCount > 0) {
    const raw =
      params.fingerprintCollisionCount * WEIGHTS.FINGERPRINT_COLLISION_PER_ACCOUNT;
    const capped = Math.min(raw, WEIGHTS.FINGERPRINT_COLLISION_CAP);
    score += capped;
    reasons.push(
      `fingerprint_collision:${params.fingerprintCollisionCount}_other_accounts (+${capped})`
    );
  }

  // Clamp to [0, 100] — the DB constraint enforces this too, but no point
  // sending an out-of-range value.
  score = Math.max(0, Math.min(100, score));

  return { score, reasons };
}

/** Bucket a 0-100 score into a tier label. */
export function scoreToTier(score: number): RiskTier {
  if (score <= TIER_THRESHOLDS.low) return "low";
  if (score <= TIER_THRESHOLDS.medium) return "medium";
  if (score <= TIER_THRESHOLDS.high) return "high";
  return "critical";
}

/** Map a tier to the gate decision the /api/instances handler will enforce. */
export function tierToDecision(tier: RiskTier): RiskDecision {
  switch (tier) {
    case "low":
      return "allow";
    case "medium":
    case "high":
      return "require_card";
    case "critical":
      return "block";
  }
}
