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
