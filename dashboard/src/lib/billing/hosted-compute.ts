import type { EffectiveSubscription } from "@/lib/billing/instance-entitlement";

/**
 * The Free account is the platform: sign in, connect your own computer, use
 * Hivra. It never includes a Hivra-hosted computer. Hosted compute is bought
 * (any paid plan, or an equivalent token entitlement); everything else is
 * bring-your-own. Owner decision 2026-10-07.
 */
export const HOSTED_COMPUTE_REQUIRES_PLAN_CODE = "hosted_compute_requires_plan" as const;

export const HOSTED_COMPUTE_REQUIRES_PLAN_MESSAGE =
  "A Hivra-hosted computer needs a paid plan. Your free account works with your own computer: connect one, or choose a plan.";

/**
 * True when the entitlement is only the Free account fallback row (no paid
 * Stripe/Apple sub, no yearly token plan, no token-holding tier).
 */
export function isFreeAccountEntitlement(
  sub: Pick<EffectiveSubscription, "plan" | "source"> | null | undefined
): boolean {
  return !!sub && sub.source === "free" && sub.plan === "free";
}

/**
 * True when the entitlement pays for a Hivra-hosted computer. The Free account
 * does not, and neither does a 'trialing' one (a Stripe sub from before trials
 * were removed, or an App Store intro offer): Hivra has no trials, so a trial
 * is refused here exactly as createInstance and the mobile launch refuse it.
 */
export function paysForHostedCompute(
  sub: Pick<EffectiveSubscription, "plan" | "source" | "status"> | null | undefined
): boolean {
  return !!sub && !isFreeAccountEntitlement(sub) && sub.status !== "trialing";
}
