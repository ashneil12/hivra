// Claude Code plan calculator logic (/tools/claude-code-plan-calculator). Pure,
// so the component, the worked examples on the page and the tests all read the
// same rules. Every external fact comes from claude-plan-facts.ts.
//
// What the tool knows and what it does not:
//
// - Anthropic states Max 5x and Max 20x only as five and twenty times Pro's
//   usage per five-hour session. It publishes no token or message counts, no
//   absolute size for Pro's allowance and no weekly multiple for Max. So the
//   fit rating is not a fact about a plan: it scales the one number the visitor
//   can observe, how far into a five-hour window Pro stops them, by the
//   published session multiples. The weekly limit is never rated.
// - The API figure is an ESTIMATE at list price. It uses Anthropic's published
//   input-to-output ratio and cache-read prices, and two assumptions that are
//   Hivra's (see CLAUDE_PLAN_FACTS.estimate). The result is held within reach
//   of Anthropic's own $13-per-active-day average by claude-plan-calc.test.ts.

import {
  CLAUDE_PLAN_FACTS,
  usd,
  type ClaudeModelKey,
  type ClaudePlanKey,
} from "./claude-plan-facts";

const F = CLAUDE_PLAN_FACTS;

export type FitLevel = "headroom" | "tight" | "over";

/**
 * Where Pro's five-hour limit stops the visitor today, in hours into a window.
 * "never" means Pro has not stopped them; "unknown" means they have not used Pro.
 */
export const PRO_HIT_OPTIONS = [
  { value: "0.5", label: "About 30 minutes in" },
  { value: "1", label: "About 1 hour in" },
  { value: "2", label: "About 2 hours in" },
  { value: "3", label: "About 3 hours in" },
  { value: "4", label: "About 4 hours in" },
  { value: "never", label: "Pro never stops me" },
  { value: "unknown", label: "I have not used Pro" },
] as const;

export type ProHit = (typeof PRO_HIT_OPTIONS)[number]["value"];

/** Whether Pro's separate weekly limit has ended the visitor's week early. */
export const PRO_WEEKLY_OPTIONS = [
  { value: "no", label: "I have not hit it" },
  { value: "yes", label: "It stops me before the week resets" },
] as const;

export type ProWeekly = (typeof PRO_WEEKLY_OPTIONS)[number]["value"];

export interface PlanInput {
  daysPerWeek: number;
  hoursPerDay: number;
  /** Share of work on Opus 5.5, 0 to 100. The rest is Sonnet 5.5. */
  opusPct: number;
  heavyUse: boolean;
  proHit: ProHit;
  proWeekly: ProWeekly;
}

/**
 * Opus 5.5 is Claude Code's default model on Pro and Max, so a visitor who
 * never runs /model is at 100% Opus. The Pro reading is an example the visitor
 * replaces, not an Anthropic figure.
 */
export const PLAN_DEFAULTS: PlanInput = {
  daysPerWeek: 5,
  hoursPerDay: 3,
  opusPct: 100,
  heavyUse: false,
  proHit: "2",
  proWeekly: "no",
};

export interface PlanFit {
  key: ClaudePlanKey;
  label: string;
  priceUsd: number;
  fit: FitLevel | null;
  detail: string;
}

export interface PlanResult {
  weeklyHours: number;
  monthlyHours: number;
  activeDaysPerMonth: number;
  /** Estimated API-equivalent cost of the schedule at list price, USD a month. */
  apiCostPerMonth: number;
  /** Anthropic's documented average per active day, times the visitor's active days. */
  anthropicAveragePerMonth: number;
  planFits: PlanFit[];
  verdict: string;
  /** The plan rows and the API line as the page prints them, one per line. */
  tableLines: string[];
}

export const FIT_LABELS: Record<FitLevel, string> = {
  headroom: "Fits with headroom",
  tight: "Tight",
  over: "Would hit limits",
};

/** "$117", "$7.79": whole dollars from $100 up, cents below. */
export function formatUsd(value: number): string {
  if (value >= 100) return `$${Math.round(value)}`;
  return usd(Number.isInteger(value) ? value : Math.round(value * 100) / 100);
}

export function formatHours(hours: number): string {
  return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
}

/**
 * Estimated API cost of one active hour on one model at list price:
 * output tokens at the output rate, input tokens (Anthropic's 324:1 multiple of
 * output) at the cache-read rate for the cache-hit share and at the 5-minute
 * cache-write rate for the rest.
 */
export function apiCostPerActiveHour(model: Extract<ClaudeModelKey, "opus" | "sonnet">, heavy: boolean): number {
  const rates = F.api[model];
  const outputM = heavy ? F.estimate.outputMPerHour.heavy : F.estimate.outputMPerHour.normal;
  const inputM = outputM * F.anthropicCost.inputToOutputRatio;
  const readM = inputM * F.estimate.cacheReadShare;
  const writeM = inputM - readM;
  return outputM * rates.output + readM * rates.cacheRead + writeM * rates.cacheWrite5m;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

const WEEKLY_NOTE =
  "Your weekly limit is a separate limit. Anthropic states Max 5x and Max 20x only as multiples of Pro's usage per five-hour session and publishes no weekly multiple, so the ratings above cover your five-hour windows only. Check /usage after your first full week on a Max plan.";

export function computePlanResult(input: PlanInput): PlanResult {
  const daysPerWeek = clamp(input.daysPerWeek, 1, 7);
  const hoursPerDay = clamp(input.hoursPerDay, 1, 12);
  const opusFrac = clamp(input.opusPct, 0, 100) / 100;

  const weeklyHours = daysPerWeek * hoursPerDay;
  const monthlyHours = weeklyHours * F.estimate.weeksPerMonth;
  const activeDaysPerMonth = daysPerWeek * F.estimate.weeksPerMonth;

  const hourCost =
    opusFrac * apiCostPerActiveHour("opus", input.heavyUse) + (1 - opusFrac) * apiCostPerActiveHour("sonnet", input.heavyUse);
  const apiCostPerMonth = monthlyHours * hourCost;
  const anthropicAveragePerMonth = activeDaysPerMonth * F.anthropicCost.perActiveDayUsd;

  // Hours of work in the busiest five-hour window of a day.
  const peakWindowHours = Math.min(hoursPerDay, F.windowHours);
  const proCapacityHours = input.proHit === "never" || input.proHit === "unknown" ? null : Number(input.proHit);

  const planFits: PlanFit[] = (Object.keys(F.plans) as ClaudePlanKey[]).map((key) => {
    const plan = F.plans[key];
    if (input.proHit === "unknown") {
      return { key, label: plan.label, priceUsd: plan.priceUsd, fit: null, detail: `${plan.multiplier}x Pro's usage per session` };
    }
    if (input.proHit === "never") {
      return { key, label: plan.label, priceUsd: plan.priceUsd, fit: "headroom", detail: "Pro already covers your sessions" };
    }
    const capacity = (proCapacityHours as number) * plan.multiplier;
    const ratio = peakWindowHours / capacity;
    const fit: FitLevel = ratio <= 0.6 ? "headroom" : ratio <= 1 ? "tight" : "over";
    const capacityLabel = capacity >= F.windowHours ? `the full ${F.windowHours}h window` : `~${formatHours(capacity)}`;
    return {
      key,
      label: plan.label,
      priceUsd: plan.priceUsd,
      fit,
      detail: `${formatHours(peakWindowHours)} of work per window vs ${capacityLabel} estimated`,
    };
  });

  const api = formatUsd(apiCostPerMonth);
  const cheapestFit = planFits.find((p) => p.fit !== null && p.fit !== "over");
  let verdict: string;
  if (input.proHit === "unknown") {
    verdict = `Anthropic does not publish Pro's cap, so tell the calculator where Pro stops you to rate each plan. At API list price this schedule is an estimated ${api}/month.`;
  } else if (!cheapestFit) {
    verdict = `Going by your Pro reading, your sessions need more than Max 20x gives. Anthropic's ways past a limit are usage credits billed at API rates, a Claude Console account for API-billed work, or waiting for the reset. At API list price this schedule is an estimated ${api}/month.`;
  } else if (apiCostPerMonth < cheapestFit.priceUsd) {
    verdict = `${cheapestFit.label} at ${formatUsd(cheapestFit.priceUsd)}/month is the cheapest plan that fits, but at this volume API billing is estimated cheaper: about ${api}/month.`;
  } else {
    verdict = `${cheapestFit.label} at ${formatUsd(cheapestFit.priceUsd)}/month is the cheapest plan that fits. The same usage at API list price is an estimated ${api}/month.`;
  }
  if (input.proWeekly === "yes") verdict = `${verdict} ${WEEKLY_NOTE}`;

  const tableLines = [
    ...planFits.map((plan) => {
      const fit = plan.fit ? FIT_LABELS[plan.fit] : "Not rated";
      return `${plan.label.padEnd(8)} ${`${formatUsd(plan.priceUsd)}/mo`.padEnd(8)} ${fit}`;
    }),
    `API list price, estimated: ${api}/mo`,
  ];

  return { weeklyHours, monthlyHours, activeDaysPerMonth, apiCostPerMonth, anthropicAveragePerMonth, planFits, verdict, tableLines };
}
