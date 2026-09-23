/**
 * What a settled yearly $HermesOS payment does to the payer's instances.
 *
 * Settlement (settle_yearly_token_payment) only writes the subscription row.
 * Nothing moved existing instances onto the tier the payment bought, and
 * nothing brought back instances a billing lane had suspended: a user whose
 * card subscription lapsed, and who then paid for a year, stayed stopped with
 * every instance action blocked (instance_entitlement_suspended). The Stripe
 * and Apple activation paths both do this work; this is the yearly lane's
 * equivalent, run right after a payment settles.
 *
 * Best-effort and never throws: the payment is already recorded, so a failure
 * here is logged for an operator and the refresh-token-tiers cron re-applies
 * the tier on its next tick.
 */

import { resolveEffectiveSubscription, type EffectiveSubscription } from "@/lib/billing/instance-entitlement";
import { isPaidTier, tierFromPlanKey } from "@/lib/services/tier-specs";
import { log } from "@/lib/logger";

const LOG_SOURCE = "yearly-activation";

export type YearlyPaymentTrigger = "activated" | "renewed" | "already_settled";

export async function applyYearlyPaymentToInstances(
  userId: string,
  trigger: YearlyPaymentTrigger
): Promise<void> {
  let entitlement: EffectiveSubscription | null;
  try {
    entitlement = await resolveEffectiveSubscription(userId);
  } catch (err) {
    log.error("yearly payment settled but the entitlement lookup failed; instances left as they are", err, {
      source: LOG_SOURCE,
      failureType: "yearly_activation_entitlement_lookup_failed",
      userId,
      trigger,
    });
    return;
  }

  // The resolver ranks every lane, so a paid card plan that outranks the new
  // year still decides the tier; the yearly row only has to make the user
  // entitled for their suspended instances to come back.
  if (!entitlement || entitlement.instance_limit <= 0 || !isPaidTier(entitlement.plan)) {
    log.warn("yearly payment settled but no paid entitlement resolved; instances left as they are", {
      source: LOG_SOURCE,
      failureType: "yearly_activation_no_entitlement",
      userId,
      trigger,
      resolvedSource: entitlement?.source ?? null,
    });
    return;
  }

  try {
    const { applyTierChange } = await import("@/lib/services/tier-change-service");
    await applyTierChange({
      userId,
      newTier: tierFromPlanKey(entitlement.plan),
      source: "token_yearly",
      reason: `yearly $HermesOS payment ${trigger} (${entitlement.source} ${entitlement.plan})`,
    });
  } catch (err) {
    log.error("tier change after a yearly payment failed", err, {
      source: LOG_SOURCE,
      failureType: "yearly_activation_tier_change_failed",
      userId,
      trigger,
    });
  }

  try {
    const { StripeWebhookService } = await import("@/lib/services/stripe-webhook-service");
    await StripeWebhookService.restoreScheduledDeletions(userId);
    await StripeWebhookService.resumeBillingSuspendedInstances(userId);
  } catch (err) {
    log.error("resuming billing-suspended instances after a yearly payment failed", err, {
      source: LOG_SOURCE,
      failureType: "yearly_activation_resume_failed",
      userId,
      trigger,
    });
  }
}
