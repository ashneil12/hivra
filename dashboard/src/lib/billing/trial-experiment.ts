/**
 * 7-day Pro trial experiment — deterministic A/B assignment.
 *
 * Default-OFF scaffolding: every export is inert until
 * TRIAL_EXPERIMENT_ENABLED=true is set in the Vercel env, and even then
 * only TRIAL_EXPERIMENT_PERCENT (default 0) of users land in the 'trial'
 * bucket. Assignment is a pure function of the Clerk user id (FNV-1a mod
 * 100), so any surface — checkout, emails, analytics backfills — can
 * re-derive a user's bucket without a lookup table and always agree.
 *
 * Env knobs:
 *   TRIAL_EXPERIMENT_ENABLED   (default false — master gate)
 *   TRIAL_EXPERIMENT_PERCENT   (default 0 — integer 0..100, % in 'trial')
 */

import { getTrialDays } from "@/lib/subscription";

export const TRIAL_EXPERIMENT_TRIAL_DAYS = 7;

export type TrialBucket = "trial" | "control";

/** 32-bit FNV-1a hash — stable, dependency-free, uniform enough for bucketing. */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // hash *= 16777619, in 32-bit space without BigInt.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  if (!v) return fallback;
  return v === "true" || v === "1" || v === "yes";
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function isTrialExperimentEnabled(): boolean {
  return envBool("TRIAL_EXPERIMENT_ENABLED", false);
}

/** Rollout percentage, clamped to 0..100. Default 0 — nobody buckets 'trial'. */
export function trialExperimentPercent(): number {
  const pct = envInt("TRIAL_EXPERIMENT_PERCENT", 0);
  return Math.min(100, Math.max(0, pct));
}

/**
 * Deterministic bucket for a user. Pure: same userId + same percent always
 * yields the same bucket, regardless of where or when it's computed.
 */
export function bucketForUser(userId: string): TrialBucket {
  return fnv1a32(userId) % 100 < trialExperimentPercent() ? "trial" : "control";
}

function isPaidPlanKey(planKey: string): boolean {
  return planKey !== "free";
}

/**
 * Trial days to apply at checkout for this user + plan.
 *
 * 7 only when the experiment is enabled AND the user buckets 'trial' AND the
 * plan is paid. Everything else falls through to the plan's own trialDays
 * via the existing getTrialDays helper (0 for every plan today), so existing
 * callers and the default-off deploy behave exactly as before.
 */
export function getTrialDaysForUser(userId: string, planKey: string): number {
  if (
    isTrialExperimentEnabled() &&
    isPaidPlanKey(planKey) &&
    bucketForUser(userId) === "trial"
  ) {
    return TRIAL_EXPERIMENT_TRIAL_DAYS;
  }
  return getTrialDays(planKey);
}
