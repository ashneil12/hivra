/**
 * Hivra — Subscription Plan Definitions
 *
 * Each plan provides a "compute pool" (totalCpu / totalRam) that the user can
 * split however they like across their agents, within per-agent caps.
 *
 * Example: "operator" has 2 CPU / 4GB total.
 * - 1 agent at 2 CPU / 4GB ✓
 * - 2 agents at 1 CPU / 2GB each ✓
 * - 3 agents ✗ (exceeds maxAgents)
 */

import { AGENT_SLOTS, SCHEDULING_PRIORITY } from "./agent-slots";

export const PLANS = {
  free: {
    name: "Free",
    price: 0,
    yearlyPrice: 0,
    stripePriceId: "",
    stripeYearlyPriceId: "",
    description: "Launch 1 active agent with guarded starter compute",
    tagline: "start without a bill.",
    trialDays: 0,
    maxAgents: AGENT_SLOTS.free,
    priority: SCHEDULING_PRIORITY.free,
    maxCpuPerAgent: 0.5,
    maxRamPerAgent: 1024,
    totalCpu: 0.5,
    totalRam: 1024,
    features: [
      "One starter agent — sleeps after 4 idle days",
      "Hermes Agent pre-configured",
      "BYO AI key — zero markup",
      "Anti-abuse safeguards",
      "Upgrade when you need more compute",
    ],
    specs: {
      cpu: "0.5 vCPU total",
      ram: "1GB total",
      agents: "1 active",
    },
  },
  operator: {
    // User-facing label is "Pro" as of 2026-04-30; the internal key
    // stays `operator` so the rest of the codebase (Stripe price env,
    // entitlement logic, instance provisioning) doesn't have to
    // rename anything. The Stripe LIVE price was rotated to a new
    // $9.99/mo price; the existing single Operator subscriber was
    // migrated with proration_behavior=none.
    name: "Pro",
    price: 999, // $9.99/mo in cents
    yearlyPrice: 7900, // $79.00/yr in cents
    stripePriceId: process.env.STRIPE_OPERATOR_PRICE_ID || "",
    stripeYearlyPriceId: process.env.STRIPE_OPERATOR_YEARLY_PRICE_ID || "",
    description: "Run up to 3 active agents with enough compute for real workloads",
    tagline: "prove it works.",
    trialDays: 0,
    maxAgents: AGENT_SLOTS.operator,
    priority: SCHEDULING_PRIORITY.operator,
    maxCpuPerAgent: 2,
    maxRamPerAgent: 4096,   // MB
    totalCpu: 2,
    totalRam: 4096,         // MB
    features: [
      "Always-on — never paused for inactivity",
      "Autonomous browsing & tool use",
      "Persistent memory across sessions",
      "Scheduled tasks & cron jobs",
      "BYO AI key — zero markup",
    ],
    specs: {
      cpu: "2 vCPU total",
      ram: "4GB total",
      agents: "3 agents",
    },
  },
  fleet: {
    // User-facing label is "Power" as of 2026-04-30. Internal key
    // stays `fleet`. Stripe price rotated to a new $19.99/mo price;
    // the active Fleet subscriber was migrated with
    // proration_behavior=none.
    name: "Power",
    price: 1999, // $19.99/mo in cents
    yearlyPrice: 14900, // $149.00/yr in cents
    stripePriceId: process.env.STRIPE_FLEET_PRICE_ID || "",
    stripeYearlyPriceId: process.env.STRIPE_FLEET_YEARLY_PRICE_ID || "",
    description: "Run up to 5 active agents with more compute and fleet controls",
    tagline: "this is where it scales.",
    popular: true,
    trialDays: 0,
    maxAgents: AGENT_SLOTS.fleet,
    priority: SCHEDULING_PRIORITY.fleet,
    maxCpuPerAgent: 4,
    maxRamPerAgent: 8192,
    totalCpu: 4,
    totalRam: 8192,
    features: [
      "Everything in Pro",
      "Burst CPU when capacity allows",
      "Priority over free tier",
      "Future marketplace access",
      "Email support (48 hr)",
    ],
    specs: {
      cpu: "4 vCPU total",
      ram: "8GB total",
      agents: "5 agents",
    },
  },
  command: {
    name: "Command",
    price: 4900, // $49/mo in cents
    stripePriceId: process.env.STRIPE_COMMAND_PRICE_ID || "",
    description: "Full-scale fleet operations — maximum hardware, priority everything",
    tagline: "fleet-scale operations.",
    trialDays: 0,
    maxAgents: AGENT_SLOTS.command,
    priority: SCHEDULING_PRIORITY.command,
    maxCpuPerAgent: 8,
    maxRamPerAgent: 16384,
    totalCpu: 8,
    totalRam: 16384,
    features: [
      "Everything in Power",
      "1-click deploy from prompt library",
      "Future marketplace access",
      "Priority infrastructure support (24 hr)",
      "1:1 dedicated support (first 14 days)",
    ],
    specs: {
      cpu: "10 vCPU total",
      ram: "56GB total",
      agents: "8 agents",
    },
  },
} as const;

export type PlanKey = keyof typeof PLANS;

/**
 * Hermes Workspace Cloud — separate lane plans.
 *
 * Deliberately kept OUT of `PLANS` so the Hivra pricing UI, PLAN_ORDER,
 * entitlement precedence, and Stripe webhook mapping never mix the two
 * products. Workspace Cloud is its own surface (provisioned on wrk1, tagged
 * product_surface='workspace_cloud').
 *
 * Per the product decision these mirror the existing Hivra tiers (Pro =
 * operator, Power = fleet) — same prices/specs — but carry distinct internal
 * keys/names so Workspace Cloud subscriptions are always distinguishable from
 * Hivra ones in records and logs. By default they point at the SAME Stripe
 * price IDs as the Hivra tiers (env), and can be split onto dedicated lane
 * prices later by setting WORKSPACE_CLOUD_*_PRICE_ID.
 */
export const WORKSPACE_CLOUD_PLANS = {
  ws_cloud_pro: {
    key: "ws_cloud_pro",
    name: "Workspace Cloud Pro",
    mirrors: "operator",
    price: PLANS.operator.price,
    stripePriceId:
      process.env.WORKSPACE_CLOUD_PRO_PRICE_ID ||
      process.env.STRIPE_OPERATOR_PRICE_ID ||
      "",
    stripeYearlyPriceId:
      process.env.WORKSPACE_CLOUD_PRO_YEARLY_PRICE_ID ||
      process.env.STRIPE_OPERATOR_YEARLY_PRICE_ID ||
      "",
    // One cloud agent per tier for now (single-agent product). Raise if/when
    // multi-agent is requested.
    maxAgents: 1,
    maxCpuPerAgent: PLANS.operator.maxCpuPerAgent,
    maxRamPerAgent: PLANS.operator.maxRamPerAgent,
    totalCpu: PLANS.operator.totalCpu,
    totalRam: PLANS.operator.totalRam,
  },
  ws_cloud_power: {
    key: "ws_cloud_power",
    name: "Workspace Cloud Power",
    mirrors: "fleet",
    price: PLANS.fleet.price,
    stripePriceId:
      process.env.WORKSPACE_CLOUD_POWER_PRICE_ID ||
      process.env.STRIPE_FLEET_PRICE_ID ||
      "",
    stripeYearlyPriceId:
      process.env.WORKSPACE_CLOUD_POWER_YEARLY_PRICE_ID ||
      process.env.STRIPE_FLEET_YEARLY_PRICE_ID ||
      "",
    // One cloud agent per tier for now (single-agent product).
    maxAgents: 1,
    maxCpuPerAgent: PLANS.fleet.maxCpuPerAgent,
    maxRamPerAgent: PLANS.fleet.maxRamPerAgent,
    totalCpu: PLANS.fleet.totalCpu,
    totalRam: PLANS.fleet.totalRam,
  },
} as const;

export type WorkspaceCloudPlanKey = keyof typeof WORKSPACE_CLOUD_PLANS;

/** Default lane plan key — entry tier (mirrors Hivra Pro). */
export const DEFAULT_WORKSPACE_CLOUD_PLAN_KEY: WorkspaceCloudPlanKey =
  "ws_cloud_pro";

export function getWorkspaceCloudPlan(key?: string) {
  return (
    WORKSPACE_CLOUD_PLANS[key as WorkspaceCloudPlanKey] ||
    WORKSPACE_CLOUD_PLANS[DEFAULT_WORKSPACE_CLOUD_PLAN_KEY]
  );
}

/**
 * Whether a lane plan resolves to a DEDICATED Workspace Cloud Stripe price for
 * the given cadence — i.e. the WORKSPACE_CLOUD_*_PRICE_ID env is set rather than
 * silently falling back to the shared Hivra operator/fleet price.
 *
 * Lane membership is decided by surface metadata, not the price ID, so a
 * fallback price would still route correctly in the webhook — BUT it would
 * charge a "Workspace Cloud" subscriber on the Hivra Stripe price, making the
 * two products billing-indistinguishable in Stripe and a single metadata bug
 * away from cross-contamination. Callers should fail closed on a fallback price
 * unless explicitly opted in. Returns false when only the shared fallback (or
 * nothing) is configured for that cadence.
 */
export function hasDedicatedWorkspaceCloudPrice(
  key: WorkspaceCloudPlanKey,
  cadence: "monthly" | "yearly"
): boolean {
  if (cadence === "yearly") {
    return key === "ws_cloud_pro"
      ? !!process.env.WORKSPACE_CLOUD_PRO_YEARLY_PRICE_ID?.trim()
      : !!process.env.WORKSPACE_CLOUD_POWER_YEARLY_PRICE_ID?.trim();
  }
  return key === "ws_cloud_pro"
    ? !!process.env.WORKSPACE_CLOUD_PRO_PRICE_ID?.trim()
    : !!process.env.WORKSPACE_CLOUD_POWER_PRICE_ID?.trim();
}

/**
 * Stripe price IDs from BEFORE the 2026-04-30 price rotation that still have
 * live subscribers attached. The rotation moved STRIPE_OPERATOR_PRICE_ID /
 * STRIPE_FLEET_PRICE_ID to the new $9.99/$19.99 prices, but subscriptions
 * created on the old prices keep billing on them forever — Stripe never
 * migrates a subscription's price. The webhook plan/price cross-check must
 * treat these as valid for their plan, otherwise every subscription event for
 * a legacy subscriber is dropped and their row drifts (the 2026-07 ghost-payer
 * incident: 38 users / 105 dropped events).
 */
export const LEGACY_STRIPE_PRICE_IDS: Readonly<
  Partial<Record<PlanKey, readonly string[]>>
> = {
  operator: ["price_1THZgbRmaqy4HoEnvyd6bpG1"], // $19/mo Operator (pre-rotation)
  fleet: ["price_1THZgcRmaqy4HoEnFmbmWj55"], // $29/mo Fleet (pre-rotation)
};

/** Ordered lowest → highest. Used to determine upgrade vs downgrade. */
export const PLAN_ORDER: PlanKey[] = ["free", "operator", "fleet", "command"];

/** All plan keys available for sale (displayed in pricing UI). */
// Command is delisted for now — `PLANS.command` is kept so existing subscribers
// and the backend tier mapping still resolve, but it's hidden from selection UI.
export const ACTIVE_PLAN_KEYS: PlanKey[] = ["free", "operator", "fleet"];

/**
 * Backup Addon — $10/month recurring charge per server.
 * Enables Hetzner's native daily backup system (~20% of server cost).
 * Backups can be disabled but this addon remains on the Stripe subscription.
 */
export const BACKUP_ADDON = {
  priceId: process.env.STRIPE_BACKUP_ADDON_PRICE_ID || "",
  priceInCents: 1000, // $10/month
} as const;

/**
 * Grace period (in hours) after cancellation or payment failure before
 * the server is scheduled for deletion. Kept short because we're running
 * real Hetzner infrastructure that costs money every hour.
 */
export const TRIAL_GRACE_HOURS = 48;

/**
 * Returns true if `targetPlan` is a higher tier than `currentPlan`.
 */
export function isPlanUpgrade(currentPlan: PlanKey, targetPlan: PlanKey): boolean {
  const fromIdx = PLAN_ORDER.indexOf(currentPlan);
  const toIdx = PLAN_ORDER.indexOf(targetPlan);
  return toIdx > fromIdx;
}

/**
 * Numeric rank of a plan within PLAN_ORDER (lowest → highest).
 * `free` = 0, `operator` = 1, `fleet` = 2, `command` = 3.
 *
 * Returns -1 for an unknown key so callers can fail closed (treat an
 * unrecognised plan as "not comparable" rather than silently ranking it
 * above/below a real tier).
 */
export function planRank(plan: PlanKey): number {
  return PLAN_ORDER.indexOf(plan);
}

/**
 * True when `targetPlan` is a strictly LOWER **paid** tier than `currentPlan`.
 *
 * This deliberately excludes the `free` tier on either side — a move to free
 * is a cancellation, not a downgrade, and is handled by the cancel/subscription
 * flow, not the in-place change-plan path. Both ranks must therefore be ≥ the
 * rank of `operator` (the lowest paid tier).
 */
export function isPaidPlanDowngrade(currentPlan: PlanKey, targetPlan: PlanKey): boolean {
  const lowestPaidRank = planRank("operator");
  const fromRank = planRank(currentPlan);
  const toRank = planRank(targetPlan);
  if (fromRank < 0 || toRank < 0) return false;
  // Both endpoints must be real paid tiers; target must be strictly lower.
  return fromRank >= lowestPaidRank && toRank >= lowestPaidRank && toRank < fromRank;
}

/**
 * Returns the number of free trial days for a plan.
 */
export function getTrialDays(planKey: string): number {
  const plan = getPlan(planKey);
  return plan.trialDays ?? 0;
}

/**
 * Returns the resource delta when switching plans.
 * Positive = gaining resources, negative = losing.
 */
export function getPlanDiff(
  from: PlanKey,
  to: PlanKey
): { agents: number; cpu: number; ramGb: number } {
  const fromPlan = PLANS[from];
  const toPlan = PLANS[to];
  return {
    agents: toPlan.maxAgents - fromPlan.maxAgents,
    cpu: toPlan.totalCpu - fromPlan.totalCpu,
    ramGb: (toPlan.totalRam - fromPlan.totalRam) / 1024,
  };
}

/**
 * Look up a plan by key. Falls back to "operator" if the key is invalid.
 */
export function getPlan(key: string) {
  if (key === "credit_base") return PLANS.free;
  return PLANS[key as PlanKey] || PLANS.operator;
}

/**
 * Subscription billing cadence. Default everywhere is "monthly" — yearly
 * support was added 2026-05-01 and is opt-in via the `cadence` parameter
 * in the subscribe / change-plan APIs.
 */
export type Cadence = "monthly" | "yearly";

/**
 * Get the Stripe Price ID for a plan + cadence, with validation.
 * Throws if the price ID is not configured for the requested cadence.
 *
 * `cadence` defaults to "monthly" so existing call sites that pre-date
 * the yearly feature continue working without changes.
 */
export function getStripePriceId(planKey: string, cadence: Cadence = "monthly"): string {
  const plan = getPlan(planKey);
  const priceId =
    cadence === "yearly"
      ? "stripeYearlyPriceId" in plan
        ? plan.stripeYearlyPriceId
        : ""
      : plan.stripePriceId;
  if (!priceId) {
    const envVar =
      cadence === "yearly"
        ? `STRIPE_${planKey.toUpperCase()}_YEARLY_PRICE_ID`
        : `STRIPE_${planKey.toUpperCase()}_PRICE_ID`;
    throw new Error(
      `Stripe Price ID not configured for plan "${planKey}" cadence "${cadence}". ` +
        `Set the ${envVar} environment variable.`
    );
  }
  return priceId;
}

/** True if the plan has a configured yearly Stripe price (i.e. the env var resolved). */
export function planHasYearlyPrice(planKey: string): boolean {
  const plan = getPlan(planKey);
  return "stripeYearlyPriceId" in plan && Boolean(plan.stripeYearlyPriceId);
}

/**
 * Format cents as a dollar string. E.g. 1900 → "$19"
 */
export function formatPrice(cents: number): string {
  return `$${cents / 100}`;
}
