/**
 * Monthly AI allowance for plans bought on the plan ladder.
 *
 * Each month of an active ladder subscription pays the plan's allowance into
 * the owner's managed AI balance (the card wallet). Spending is taken from the
 * allowance first; one month of unspent allowance rolls over and anything
 * older expires at the next grant. The SQL function grant_plan_ai_allowance
 * does the money part atomically and is idempotent per period key, so the
 * daily cron, the webhook and a retry can all call this safely.
 *
 * Months are counted from the subscription's current period start, so a
 * yearly plan gets twelve monthly grants, not one.
 */

import { supabaseAdmin } from "@/lib/supabase";
import { log } from "@/lib/logger";
import { PLAN_LADDER_ID } from "@/lib/subscription/plan-ladder";

const LOG_SOURCE = "plan-ai-allowance";

type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message?: string } | null }>;

export interface AllowanceSubscriptionRow {
  user_id: string;
  stripe_subscription_id: string | null;
  status: string | null;
  plan_ladder: string | null;
  ai_allowance_micro_usd: number | string | null;
  current_period_start: string | null;
  current_period_end?: string | null;
}

/** anchor + n calendar months, clamped to the month's last day (as Stripe bills). */
export function addMonthsClamped(anchor: Date, months: number): Date {
  const y = anchor.getUTCFullYear();
  const m = anchor.getUTCMonth() + months;
  const targetYear = y + Math.floor(m / 12);
  const targetMonth = ((m % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      targetYear,
      targetMonth,
      Math.min(anchor.getUTCDate(), lastDay),
      anchor.getUTCHours(),
      anchor.getUTCMinutes(),
      anchor.getUTCSeconds(),
    ),
  );
}

/**
 * The allowance month `now` falls in, as a stable key, or null when the
 * subscription has no usable period start or `now` is before it.
 */
export function allowancePeriodKey(
  row: Pick<AllowanceSubscriptionRow, "stripe_subscription_id" | "current_period_start" | "user_id">,
  now: Date,
): string | null {
  if (!row.current_period_start) return null;
  const anchor = new Date(row.current_period_start);
  if (Number.isNaN(anchor.getTime()) || now < anchor) return null;
  let n = 0;
  // At most 12 steps for a yearly period; a guard keeps a bad date harmless.
  while (n < 24 && addMonthsClamped(anchor, n + 1) <= now) n += 1;
  const start = addMonthsClamped(anchor, n).toISOString().slice(0, 10);
  return `${row.stripe_subscription_id ?? "manual"}:${start}`;
}

export function allowanceAmountMicroUsd(row: Pick<AllowanceSubscriptionRow, "ai_allowance_micro_usd">): number {
  const amount = Number(row.ai_allowance_micro_usd ?? 0);
  return Number.isSafeInteger(amount) && amount > 0 ? amount : 0;
}

/** Whether a row earns an allowance right now. */
export function earnsAllowance(row: AllowanceSubscriptionRow): boolean {
  return (
    row.plan_ladder === PLAN_LADDER_ID &&
    row.status === "active" &&
    Boolean(row.stripe_subscription_id) &&
    allowanceAmountMicroUsd(row) > 0
  );
}

export type GrantOutcome =
  | { status: "granted"; amountMicroUsd: number; expiredMicroUsd: number; periodKey: string }
  | { status: "already_granted" | "not_eligible" | "no_period"; periodKey?: string };

export async function grantAllowanceForRow(
  row: AllowanceSubscriptionRow,
  now: Date,
  rpc: Rpc,
): Promise<GrantOutcome> {
  if (!earnsAllowance(row)) return { status: "not_eligible" };
  const periodKey = allowancePeriodKey(row, now);
  if (!periodKey) return { status: "no_period" };
  const { data, error } = await rpc("grant_plan_ai_allowance", {
    p_user_id: row.user_id,
    p_period_key: periodKey,
    p_amount_micro_usd: allowanceAmountMicroUsd(row),
    p_now: now.toISOString(),
  });
  if (error) throw new Error(error.message || "grant_plan_ai_allowance failed");
  const result = (data ?? {}) as { granted?: boolean; amountMicroUsd?: number; expiredMicroUsd?: number };
  if (!result.granted) return { status: "already_granted", periodKey };
  return {
    status: "granted",
    periodKey,
    amountMicroUsd: Number(result.amountMicroUsd ?? 0),
    expiredMicroUsd: Number(result.expiredMicroUsd ?? 0),
  };
}

const ROW_COLUMNS =
  "user_id, stripe_subscription_id, status, plan_ladder, ai_allowance_micro_usd, current_period_start, current_period_end";

/** Pay this owner's allowance for the current month if it is due. Never throws. */
export async function grantPlanAllowanceForUser(userId: string, now: Date = new Date()): Promise<GrantOutcome | null> {
  if (!supabaseAdmin) return null;
  try {
    const { data, error } = await supabaseAdmin
      .from("hermes_subscriptions")
      .select(ROW_COLUMNS)
      .eq("user_id", userId)
      .maybeSingle();
    if (error || !data) return null;
    const client = supabaseAdmin;
    return await grantAllowanceForRow(data as AllowanceSubscriptionRow, now, (fn, args) => client.rpc(fn, args));
  } catch (error) {
    log.warn("plan AI allowance grant failed", {
      source: LOG_SOURCE,
      failureType: "plan_allowance_grant_failed",
      userId,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export interface AllowanceSweepSummary {
  scanned: number;
  granted: number;
  alreadyGranted: number;
  failed: number;
  grantedMicroUsd: number;
  expiredMicroUsd: number;
}

/** Daily: pay every due allowance. Runs whether or not the switch is on, so paid months are always honoured. */
export async function grantDuePlanAllowances(now: Date = new Date()): Promise<AllowanceSweepSummary> {
  const summary: AllowanceSweepSummary = {
    scanned: 0,
    granted: 0,
    alreadyGranted: 0,
    failed: 0,
    grantedMicroUsd: 0,
    expiredMicroUsd: 0,
  };
  if (!supabaseAdmin) return summary;
  const client = supabaseAdmin;
  const { data, error } = await client
    .from("hermes_subscriptions")
    .select(ROW_COLUMNS)
    .eq("plan_ladder", PLAN_LADDER_ID)
    .eq("status", "active")
    .gt("ai_allowance_micro_usd", 0);
  if (error) throw new Error(error.message || "Could not load ladder subscriptions");
  for (const row of (data ?? []) as AllowanceSubscriptionRow[]) {
    summary.scanned += 1;
    try {
      const outcome = await grantAllowanceForRow(row, now, (fn, args) => client.rpc(fn, args));
      if (outcome.status === "granted") {
        summary.granted += 1;
        summary.grantedMicroUsd += outcome.amountMicroUsd;
        summary.expiredMicroUsd += outcome.expiredMicroUsd;
      } else if (outcome.status === "already_granted") {
        summary.alreadyGranted += 1;
      }
    } catch (grantError) {
      summary.failed += 1;
      log.warn("plan AI allowance grant failed", {
        source: LOG_SOURCE,
        failureType: "plan_allowance_grant_failed",
        userId: row.user_id,
        errorMessage: grantError instanceof Error ? grantError.message : String(grantError),
      });
    }
  }
  return summary;
}
