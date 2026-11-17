/**
 * Hivra — the next plan ladder, behind a switch.
 *
 * The ladder reuses the existing internal plan keys (`operator`, `fleet`,
 * `command`) so every place that already knows "this is a paid plan" keeps
 * working. What changes for a subscription bought on the ladder is read from
 * settings, never from this file: display names, prices, Stripe price IDs,
 * agent counts, always-on counts, the compute pool and the monthly AI
 * allowance. The repository holds the mechanism only.
 *
 * Switch:   HIVRA_PLAN_LADDER=on        (anything else is off)
 * Settings: HIVRA_PLAN_LADDER_CONFIG    JSON, see `PlanLadderConfigSchema`
 *
 * A subscription belongs to the ladder when its Stripe metadata carries
 * `plan_ladder` = PLAN_LADDER_ID, or its plan price is one of the ladder's
 * prices. Rows written for a ladder subscription carry `plan_ladder` too, so a
 * ladder subscriber keeps the ladder's limits if the switch is turned off
 * later, and a subscriber from before the ladder never changes.
 */

import { z } from "zod";

import type { Cadence, PlanKey } from "./plans";

/** Version tag written to Stripe metadata and hermes_subscriptions.plan_ladder. */
export const PLAN_LADDER_ID = "2026-11";

/** Paid plan keys the ladder can sell. Free stays the free account. */
export const LADDER_PAID_PLAN_KEYS = ["operator", "fleet", "command"] as const;
export type LadderPaidPlanKey = (typeof LADDER_PAID_PLAN_KEYS)[number];

const PriceId = z.string().trim().regex(/^price_[A-Za-z0-9]+$/, "a Stripe price ID (price_...)");
const Cents = z.number().int().min(0).max(1_000_000);

const LadderPlanSchema = z
  .object({
    /** Name shown to the customer, e.g. "Plus". */
    name: z.string().trim().min(1).max(40),
    monthlyCents: Cents,
    monthlyPriceId: PriceId,
    yearlyCents: Cents.nullable().optional(),
    yearlyPriceId: PriceId.nullable().optional(),
    /** Agents the owner may keep (awake or asleep). */
    agents: z.number().int().min(1).max(500),
    /** Agents that may be kept awake ("Keep awake") without the paid extra. */
    alwaysOn: z.number().int().min(0).max(500),
    /** Largest computer one agent may have. */
    agentCpu: z.number().positive().max(64),
    agentRamMb: z.number().int().min(512).max(262_144),
    /** Total compute across the owner's agents. Defaults to one agent's size times `agents`. */
    poolCpu: z.number().positive().max(4096).optional(),
    poolRamMb: z.number().int().min(512).max(16_777_216).optional(),
    /** Managed AI paid into the owner's AI balance each month, in cents. */
    aiAllowanceCents: Cents.default(0),
    /** Short lines for the plan card. */
    features: z.array(z.string().trim().min(1).max(140)).max(12).default([]),
    popular: z.boolean().optional(),
    /**
     * Hours without use before a sleeping agent is packed into storage (deep
     * sleep). Read by the storage tier once it exists; stored here so every
     * plan's timing lives in one place.
     */
    storeAfterIdleHours: z.number().int().min(1).max(8760).optional(),
  })
  .refine((plan) => !plan.yearlyPriceId === !plan.yearlyCents, {
    message: "yearlyCents and yearlyPriceId go together",
  });

export const PlanLadderConfigSchema = z.object({
  plans: z.object({
    operator: LadderPlanSchema,
    fleet: LadderPlanSchema,
    command: LadderPlanSchema,
  }),
  /** Keep one more agent awake, billed per agent per month. Optional. */
  alwaysOnExtra: z
    .object({
      priceId: PriceId,
      monthlyCents: Cents,
      maxPerAccount: z.number().int().min(1).max(100).default(10),
    })
    .optional(),
  /** Free account display name. Free gets no hosted computer either way. */
  freeName: z.string().trim().min(1).max(40).default("Free"),
  /**
   * Limits for the free cloud agent, kept here so the agent app's provisioner
   * reads one place. The dashboard stores them and enforces none of them.
   */
  free: z
    .object({
      agents: z.number().int().min(0).max(10).optional(),
      sleepAfterIdleMinutes: z.number().int().min(1).max(1440).optional(),
      storeAfterDaysAway: z.number().int().min(1).max(365).optional(),
      storeAfterIdleHours: z.number().int().min(1).max(8760).optional(),
      storeWarningDays: z.number().int().min(0).max(30).optional(),
      filesGb: z.number().min(0).max(100).optional(),
      memoryMb: z.number().int().min(128).max(16384).optional(),
      cpus: z.number().min(0.1).max(8).optional(),
      scheduledJobs: z.number().int().min(0).max(100).optional(),
      scheduledJobMinHours: z.number().min(0).max(720).optional(),
      channels: z.boolean().optional(),
      browser: z.boolean().optional(),
      team: z.boolean().optional(),
      aiUsdPerDay: z.number().min(0).max(100).optional(),
      linePriority: z.enum(["low", "normal", "high"]).optional(),
      headStartDays: z.number().int().min(0).max(90).optional(),
      /** Agent kinds Free may start, in the order offered. */
      agentKinds: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
      freePlacesPerServer: z.number().int().min(0).max(10_000).optional(),
      /** Idle test ceilings an agent kind must pass to be offered on Free. */
      idleMbMax: z.number().int().min(0).max(65_536).optional(),
      imageAddMbMax: z.number().int().min(0).max(65_536).optional(),
    })
    .optional(),
});

export type PlanLadderConfig = z.infer<typeof PlanLadderConfigSchema>;
export type LadderPlan = z.infer<typeof LadderPlanSchema>;

export interface LadderPlanLimits {
  name: string;
  maxAgents: number;
  alwaysOn: number;
  maxCpuPerAgent: number;
  maxRamPerAgent: number;
  totalCpu: number;
  totalRam: number;
  aiAllowanceMicroUsd: number;
}

type Env = Record<string, string | undefined>;

export function isPlanLadderEnabled(env: Env = process.env): boolean {
  return env.HIVRA_PLAN_LADDER?.trim().toLowerCase() === "on";
}

let cached: { raw: string | undefined; value: PlanLadderConfig | null } | null = null;

/**
 * The ladder's settings, or null when they are missing or invalid. Parsing
 * never throws: a broken setting must not take billing down, it only means
 * the ladder is not offered (and is logged by the caller that needed it).
 */
export function readPlanLadderConfig(env: Env = process.env): PlanLadderConfig | null {
  const raw = env.HIVRA_PLAN_LADDER_CONFIG;
  if (env === process.env && cached && cached.raw === raw) return cached.value;
  let value: PlanLadderConfig | null = null;
  if (raw && raw.trim()) {
    try {
      const parsed = PlanLadderConfigSchema.safeParse(JSON.parse(raw));
      value = parsed.success ? parsed.data : null;
    } catch {
      value = null;
    }
  }
  if (env === process.env) cached = { raw, value };
  return value;
}

/** Why the config was rejected, for logs and the setup check. Null when valid or unset. */
export function planLadderConfigProblem(env: Env = process.env): string | null {
  const raw = env.HIVRA_PLAN_LADDER_CONFIG;
  if (!raw || !raw.trim()) return "HIVRA_PLAN_LADDER_CONFIG is not set";
  try {
    const parsed = PlanLadderConfigSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return null;
    return parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
  } catch {
    return "HIVRA_PLAN_LADDER_CONFIG is not valid JSON";
  }
}

/** The ladder when it is switched on AND configured; otherwise null. */
export function activePlanLadder(env: Env = process.env): PlanLadderConfig | null {
  return isPlanLadderEnabled(env) ? readPlanLadderConfig(env) : null;
}

export function isLadderPaidPlanKey(planKey: string | null | undefined): planKey is LadderPaidPlanKey {
  return (LADDER_PAID_PLAN_KEYS as readonly string[]).includes(String(planKey));
}

export function ladderPlanLimits(config: PlanLadderConfig, planKey: LadderPaidPlanKey): LadderPlanLimits {
  const plan = config.plans[planKey];
  return {
    name: plan.name,
    maxAgents: plan.agents,
    alwaysOn: plan.alwaysOn,
    maxCpuPerAgent: plan.agentCpu,
    maxRamPerAgent: plan.agentRamMb,
    totalCpu: plan.poolCpu ?? plan.agentCpu * plan.agents,
    totalRam: plan.poolRamMb ?? plan.agentRamMb * plan.agents,
    aiAllowanceMicroUsd: plan.aiAllowanceCents * 10_000,
  };
}

/** The Stripe price for a ladder plan and cadence, or null when it has none. */
export function ladderPriceId(
  config: PlanLadderConfig,
  planKey: LadderPaidPlanKey,
  cadence: Cadence,
): string | null {
  const plan = config.plans[planKey];
  return cadence === "yearly" ? plan.yearlyPriceId ?? null : plan.monthlyPriceId;
}

/** Which ladder plan and cadence a Stripe price belongs to, if any. */
export function ladderPlanForPriceId(
  config: PlanLadderConfig | null,
  priceId: string | null | undefined,
): { planKey: LadderPaidPlanKey; cadence: Cadence } | null {
  if (!config || !priceId) return null;
  for (const planKey of LADDER_PAID_PLAN_KEYS) {
    const plan = config.plans[planKey];
    if (plan.monthlyPriceId === priceId) return { planKey, cadence: "monthly" };
    if (plan.yearlyPriceId && plan.yearlyPriceId === priceId) return { planKey, cadence: "yearly" };
  }
  return null;
}

export function isAlwaysOnExtraPrice(config: PlanLadderConfig | null, priceId: string | null | undefined): boolean {
  return Boolean(config?.alwaysOnExtra && priceId && config.alwaysOnExtra.priceId === priceId);
}

interface SubscriptionItemLike {
  id?: string;
  quantity?: number | null;
  price?: { id?: string | null } | null;
}

/**
 * Reads a Stripe subscription's items the ladder's way: the plan item (by
 * price, so item order never matters) and how many always-on extras are paid
 * for. `isLadder` is true when the metadata says so or a plan price matches.
 */
export function readLadderSubscription(
  config: PlanLadderConfig | null,
  subscription: {
    metadata?: Record<string, string> | null;
    items?: { data?: SubscriptionItemLike[] | null } | null;
  },
): {
  isLadder: boolean;
  planItem: SubscriptionItemLike | null;
  plan: { planKey: LadderPaidPlanKey; cadence: Cadence } | null;
  alwaysOnExtraItem: SubscriptionItemLike | null;
  alwaysOnExtras: number;
} {
  const items = subscription.items?.data ?? [];
  let planItem: SubscriptionItemLike | null = null;
  let plan: { planKey: LadderPaidPlanKey; cadence: Cadence } | null = null;
  let alwaysOnExtraItem: SubscriptionItemLike | null = null;
  for (const item of items) {
    const match = ladderPlanForPriceId(config, item.price?.id);
    if (match && !planItem) {
      planItem = item;
      plan = match;
    } else if (isAlwaysOnExtraPrice(config, item.price?.id)) {
      alwaysOnExtraItem = item;
    }
  }
  const tagged = subscription.metadata?.plan_ladder === PLAN_LADDER_ID;
  return {
    isLadder: tagged || plan !== null,
    planItem,
    plan,
    alwaysOnExtraItem,
    alwaysOnExtras: Math.max(0, Math.trunc(Number(alwaysOnExtraItem?.quantity ?? 0)) || 0),
  };
}

/**
 * The hermes_subscriptions columns a ladder subscription writes, on top of the
 * usual plan/status columns.
 */
export function ladderSubscriptionColumns(
  config: PlanLadderConfig,
  planKey: LadderPaidPlanKey,
  alwaysOnExtras: number,
) {
  const limits = ladderPlanLimits(config, planKey);
  const extras = Math.min(Math.max(0, alwaysOnExtras), config.alwaysOnExtra?.maxPerAccount ?? 0);
  return {
    plan_ladder: PLAN_LADDER_ID,
    instance_limit: limits.maxAgents,
    total_cpu_budget: limits.totalCpu,
    total_ram_budget: limits.totalRam,
    always_on_limit: limits.alwaysOn + extras,
    always_on_extra: extras,
    ai_allowance_micro_usd: limits.aiAllowanceMicroUsd,
  };
}

/** Everything the billing page may show about the ladder. No price IDs. */
export interface PublicPlanLadder {
  id: string;
  freeName: string;
  plans: Array<{
    key: LadderPaidPlanKey;
    name: string;
    monthlyCents: number;
    yearlyCents: number | null;
    agents: number;
    alwaysOn: number;
    agentCpu: number;
    agentRamGb: number;
    aiAllowanceCents: number;
    features: string[];
    popular: boolean;
  }>;
  alwaysOnExtra: { monthlyCents: number; maxPerAccount: number } | null;
}

export function publicPlanLadder(config: PlanLadderConfig): PublicPlanLadder {
  return {
    id: PLAN_LADDER_ID,
    freeName: config.freeName,
    plans: LADDER_PAID_PLAN_KEYS.map((key) => {
      const plan = config.plans[key];
      return {
        key,
        name: plan.name,
        monthlyCents: plan.monthlyCents,
        yearlyCents: plan.yearlyPriceId ? plan.yearlyCents ?? null : null,
        agents: plan.agents,
        alwaysOn: plan.alwaysOn,
        agentCpu: plan.agentCpu,
        agentRamGb: plan.agentRamMb / 1024,
        aiAllowanceCents: plan.aiAllowanceCents,
        features: plan.features,
        popular: plan.popular === true,
      };
    }),
    alwaysOnExtra: config.alwaysOnExtra
      ? { monthlyCents: config.alwaysOnExtra.monthlyCents, maxPerAccount: config.alwaysOnExtra.maxPerAccount }
      : null,
  };
}

/**
 * Whether checkout should sell this person the ladder. New sign-ups only: an
 * account that holds a paid plan from before the ladder keeps it and buys
 * nothing here. Someone whose old plan has ended may buy a ladder plan.
 */
export function sellsLadderTo(
  existing: { plan?: string | null; status?: string | null; plan_ladder?: string | null } | null | undefined,
  holdsPaid: boolean,
): boolean {
  if (!existing || !holdsPaid) return true;
  if (existing.plan === "free") return true;
  return existing.plan_ladder === PLAN_LADDER_ID;
}

/** Narrow a PlanKey to the ladder's paid keys. */
export function asLadderPlanKey(planKey: PlanKey | string): LadderPaidPlanKey | null {
  return isLadderPaidPlanKey(planKey) ? planKey : null;
}
