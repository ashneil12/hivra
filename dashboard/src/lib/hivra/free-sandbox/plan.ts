/**
 * Which ladder a sandbox's owner is on. Read through `resolveEffectiveSubscription` with `throwOnQueryError`, so a
 * failed read is "unknown" and the bridge refuses to place or wake rather than guessing. No row, or only the Free
 * account, is the free tier: that is the normal state for a free user, not an error.
 */
import { paysForHostedCompute } from "@/lib/billing/hosted-compute";
import { type EffectiveSubscription, resolveEffectiveSubscription } from "@/lib/billing/instance-entitlement";

export type SandboxTier = { tier: "free" } | { tier: "paid"; plan: string } | { tier: "unknown" };

type Resolve = typeof resolveEffectiveSubscription;

export async function sandboxTierFor(userId: string, resolve: Resolve = resolveEffectiveSubscription): Promise<SandboxTier> {
  let entitlement: EffectiveSubscription | null;
  try {
    entitlement = await resolve(userId, { throwOnQueryError: true });
  } catch {
    return { tier: "unknown" };
  }
  if (entitlement && paysForHostedCompute(entitlement)) return { tier: "paid", plan: entitlement.plan };
  return { tier: "free" };
}
