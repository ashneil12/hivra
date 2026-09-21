import { isInstanceLifecycleState, type InstanceLifecycleState } from "@/lib/instance-lifecycle";
import { hasPlanAccessWithGrace } from "@/lib/billing/subscription-status";
import {
  freeResourceTierForStorage,
  isFreeResourceTier,
} from "@/lib/resource-tiers";
import {
  resolveTierProvisioningLimits,
  type TierKey,
} from "@/lib/services/tier-specs";
import type { PlanKey } from "@/lib/subscription";

type ComputeEntitlementTier = PlanKey | "credit_base" | "token_base";

interface ComputeEntitlementSubscription {
  plan: string;
  status: string;
  /**
   * Dunning cutoff anchor. Optional so existing callers compile unchanged —
   * omitting it fails OPEN (the sub keeps entitling), matching
   * `hasPlanAccessWithGrace`. Callers that gate real Pro+ features must select
   * and pass it, or a grace-expired failed payment keeps its tier.
   */
  grace_period_ends_at?: string | null;
}

interface ComputeEntitlementTokenHolding {
  verified: boolean;
  balance: number;
}

export interface ComputeEntitlementInstance {
  id: string;
  cpu: number;
  ram: number;
  state: InstanceLifecycleState;
}

interface RequestedComputeInstance {
  cpu: number;
  ram: number;
}

export interface ComputeEntitlementInput {
  userId: string;
  subscription: ComputeEntitlementSubscription | null;
  creditBalanceCredits: number | null;
  reservedCredits?: number;
  tokenHolding: ComputeEntitlementTokenHolding;
  activeInstances: ComputeEntitlementInstance[];
  requestedInstance?: RequestedComputeInstance;
}

interface ComputeEntitlementLimits {
  maxInstances: number;
  totalCpu: number;
  totalRam: number;
  maxCpuPerInstance: number;
  maxRamPerInstance: number;
}

export interface ComputeEntitlementDecision {
  mode: "dry_run";
  enforced: false;
  userId: string;
  verified: boolean;
  failClosed: boolean;
  allowedTier: ComputeEntitlementTier | null;
  limits: ComputeEntitlementLimits | null;
  availableCredits: number | null;
  canProvision: boolean;
  shouldPause: boolean;
  shouldResume: boolean;
  payAsYouGoEnabled: boolean;
  reasons: string[];
}

const MINIMUM_TOKEN_BALANCE = 1;

function normalizeSubscriptionTier(value: string | null | undefined): ComputeEntitlementTier | null {
  if (isFreeResourceTier(value)) {
    return freeResourceTierForStorage();
  }

  if (
    value === "operator" ||
    value === "fleet" ||
    value === "command"
  ) {
    return value;
  }

  return null;
}

function getTierLimits(tier: ComputeEntitlementTier): ComputeEntitlementLimits {
  const limits = resolveTierProvisioningLimits(tier as TierKey);
  return {
    maxInstances: limits.maxInstances,
    totalCpu: limits.totalCpu,
    totalRam: limits.totalRam,
    maxCpuPerInstance: limits.maxCpuPerInstance,
    maxRamPerInstance: limits.maxRamPerInstance,
  };
}

function usedResources(instances: ComputeEntitlementInstance[]) {
  return instances
    .filter((instance) => instance.state !== "deleted")
    .reduce(
      (sum, instance) => ({
        count: sum.count + 1,
        cpu: sum.cpu + instance.cpu,
        ram: sum.ram + instance.ram,
      }),
      { count: 0, cpu: 0, ram: 0 }
    );
}

function isWithinLimits(
  limits: ComputeEntitlementLimits,
  activeInstances: ComputeEntitlementInstance[],
  requestedInstance?: RequestedComputeInstance
): boolean {
  const used = usedResources(activeInstances);
  const requestedCpu = requestedInstance?.cpu ?? 0;
  const requestedRam = requestedInstance?.ram ?? 0;
  const requestedCount = requestedInstance ? 1 : 0;

  if (requestedCpu > limits.maxCpuPerInstance || requestedRam > limits.maxRamPerInstance) {
    return false;
  }

  return (
    used.count + requestedCount <= limits.maxInstances &&
    used.cpu + requestedCpu <= limits.totalCpu &&
    used.ram + requestedRam <= limits.totalRam
  );
}

export function normalizeEntitlementInstance(row: {
  id: string;
  lifecycle_state?: unknown;
  status?: unknown;
  cpu_limit?: unknown;
  ram_limit?: unknown;
}): ComputeEntitlementInstance {
  const lifecycleState = isInstanceLifecycleState(row.lifecycle_state)
    ? row.lifecycle_state
    : row.status === "running"
      ? "active"
      : row.status === "stopped"
        ? "paused"
        : row.status === "deleted"
          ? "deleted"
          : "provisioning";

  return {
    id: row.id,
    state: lifecycleState,
    cpu: typeof row.cpu_limit === "number" && Number.isFinite(row.cpu_limit) ? row.cpu_limit : 0,
    ram: typeof row.ram_limit === "number" && Number.isFinite(row.ram_limit) ? row.ram_limit : 0,
  };
}

export function evaluateComputeEntitlement(
  input: ComputeEntitlementInput
): ComputeEntitlementDecision {
  const reasons: string[] = [];
  const activeInstances = input.activeInstances.filter((instance) => instance.state !== "deleted");
  const availableCredits =
    input.creditBalanceCredits === null
      ? null
      : Math.max(0, input.creditBalanceCredits - (input.reservedCredits ?? 0));

  let allowedTier: ComputeEntitlementTier | null = null;
  let limits: ComputeEntitlementLimits | null = null;
  let verified = false;

  const planKey = normalizeSubscriptionTier(input.subscription?.plan);
  // Dunning cutoff (flag-gated, see hasPlanAccessWithGrace): a past_due sub
  // stops granting its compute tier once the 48h grace anchor elapses, so a
  // failed payment can't hold Pro+ features for Stripe's whole retry window.
  // Falls through to the token/credit branches below, exactly as an
  // unentitled sub would.
  if (
    planKey &&
    input.subscription &&
    hasPlanAccessWithGrace(input.subscription)
  ) {
    allowedTier = planKey;
    limits = getTierLimits(planKey);
    verified = true;
    reasons.push(`Subscription ${input.subscription.status} on ${planKey}.`);
  } else if (input.tokenHolding.verified && input.tokenHolding.balance >= MINIMUM_TOKEN_BALANCE) {
    allowedTier = "token_base";
    limits = getTierLimits("token_base");
    verified = true;
    reasons.push("Verified Hivra token holding unlocks base compute.");
  } else if (availableCredits !== null && availableCredits > 0) {
    reasons.push("Credits are available for billing/top-ups but do not unlock a compute tier.");
  }

  if (!verified || !limits) {
    return {
      mode: "dry_run",
      enforced: false,
      userId: input.userId,
      verified: false,
      failClosed: true,
      allowedTier: null,
      limits: null,
      availableCredits,
      canProvision: false,
      shouldPause: activeInstances.length > 0,
      shouldResume: false,
      payAsYouGoEnabled: false,
      reasons: reasons.length > 0
        ? reasons
        : ["No verified subscription or token entitlement."],
    };
  }

  const withinLimits = isWithinLimits(limits, activeInstances, input.requestedInstance);
  if (!withinLimits) {
    reasons.push("Requested resources exceed allowed tier.");
  }

  return {
    mode: "dry_run",
    enforced: false,
    userId: input.userId,
    verified,
    failClosed: false,
    allowedTier,
    limits,
    availableCredits,
    canProvision: withinLimits,
    shouldPause: false,
    shouldResume: activeInstances.some((instance) => instance.state === "paused"),
    payAsYouGoEnabled: false,
    reasons,
  };
}
