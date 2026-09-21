import "server-only";
import { chunk } from "@/lib/array-utils";

import { supabaseAdmin } from "@/lib/supabase";
import { log } from "@/lib/logger";

/**
 * Conversion-funnel analytics for the admin insights page.
 *
 * Funnel definition (from the prod-data audit over hermes_subscriptions —
 * one row per user, created_at = signup — joined to hermes_instances):
 * - signup          = subscription row created in the window
 * - deployed        = user has at least one instance row (any status)
 * - went active     = an instance reached first_active_at
 * - used past day 1 = an instance has activity > 24h after first_active_at
 * - paid now        = current plan is one of the paid plans
 *
 * Day-0 vs later upgrades prefer the upgraded_at column when it exists (it
 * ships in a separate instrumentation PR); until then the best available
 * inference is current_period_start - created_at, so the queries probe for
 * the column and fall back gracefully. Note the fallback conflates monthly
 * renewals with conversions (current_period_start moves on renewal).
 */

export const FUNNEL_PAID_PLANS = ["operator", "fleet", "command"] as const;

const WEEKLY_COHORT_WEEKS = 8;
const DAILY_TREND_DAYS = 14;
/** Exported so the warm-pool campaign uses the same "engaged" window. */
export const ENGAGED_POOL_ACTIVITY_DAYS = 7;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
// PostgREST silently caps un-ranged selects at 1000 rows, so every row
// fetch pages explicitly with a deterministic order.
const PAGE_SIZE = 1000;
const IN_CHUNK_SIZE = 200;

export interface FunnelSubscriptionRow {
  user_id: string;
  plan: string | null;
  created_at: string;
  current_period_start: string | null;
  upgraded_at?: string | null;
}

export interface FunnelInstanceRow {
  user_id: string | null;
  created_at: string;
  first_active_at: string | null;
  last_activity_at: string | null;
}

export interface FunnelWeeklyCohort {
  /** YYYY-MM-DD of the cohort's UTC Monday. */
  weekStart: string;
  signups: number;
  deployed: number;
  wentActive: number;
  usedPastDay1: number;
  paidNow: number;
}

export interface FunnelDailyPoint {
  /** YYYY-MM-DD (UTC). */
  date: string;
  signups: number;
  deploys: number;
  activations: number;
  payments: number;
}

export interface FunnelUpgradeSplit {
  /** Paid < 1h after signup. */
  day0: number;
  /** Paid > 24h after signup. */
  later: number;
  /** 1h–24h, or no usable upgrade timestamp. */
  unclear: number;
}

export interface ConversionFunnelStats {
  generatedAt: string;
  /** Oldest → newest, always WEEKLY_COHORT_WEEKS buckets. */
  weeklyCohorts: FunnelWeeklyCohort[];
  /** Oldest → newest, always DAILY_TREND_DAYS points. */
  daily: FunnelDailyPoint[];
  /** Free plan + live instance + activity within 7 days. */
  engagedFreePool: number;
  currentTotals: { free: number; paidByPlan: Record<string, number> };
  /** Paid users among the weekly-cohort window's signups. */
  upgradeSplit: FunnelUpgradeSplit;
  upgradeTimestampSource: "upgraded_at" | "period_start_inference";
}

// ---------- pure helpers (unit-tested) ----------

export function isPaidPlan(plan: string | null | undefined): boolean {
  return !!plan && (FUNNEL_PAID_PLANS as readonly string[]).includes(plan);
}

/** YYYY-MM-DD in UTC for a timestamp. */
export function utcDayKey(value: string | Date): string {
  const d = value instanceof Date ? value : new Date(value);
  return d.toISOString().slice(0, 10);
}

/** YYYY-MM-DD of the UTC Monday of the timestamp's week. */
export function utcWeekStartKey(value: string | Date): string {
  const d = value instanceof Date ? value : new Date(value);
  const daysSinceMonday = (d.getUTCDay() + 6) % 7;
  return utcDayKey(new Date(d.getTime() - daysSinceMonday * DAY_MS));
}

/** The last n UTC week-start keys (oldest → newest), ending in the current week. */
export function lastNWeekStarts(n: number, now: Date): string[] {
  const currentStart = new Date(`${utcWeekStartKey(now)}T00:00:00.000Z`).getTime();
  const out: string[] = [];
  for (let k = n - 1; k >= 0; k--) {
    out.push(utcDayKey(new Date(currentStart - k * 7 * DAY_MS)));
  }
  return out;
}

/** The last n UTC day keys (oldest → newest), ending today. */
export function lastNDayKeys(n: number, now: Date): string[] {
  const out: string[] = [];
  for (let k = n - 1; k >= 0; k--) {
    out.push(utcDayKey(new Date(now.getTime() - k * DAY_MS)));
  }
  return out;
}

/**
 * Classify when a paid user upgraded relative to signup. < 1h = bought on
 * day 0; > 24h = upgraded later; in between (or no timestamp) is unclear —
 * deliberate, because under the current_period_start inference a renewal
 * can land anywhere.
 */
export function classifyUpgrade(
  signupAt: string,
  upgradeAt: string | null | undefined
): "day0" | "later" | "unclear" {
  if (!upgradeAt) return "unclear";
  const delta = Date.parse(upgradeAt) - Date.parse(signupAt);
  if (!Number.isFinite(delta)) return "unclear";
  if (delta < HOUR_MS) return "day0";
  if (delta > DAY_MS) return "later";
  return "unclear";
}

export function instanceUsedPastDay1(instance: FunnelInstanceRow): boolean {
  if (!instance.first_active_at || !instance.last_activity_at) return false;
  return (
    Date.parse(instance.last_activity_at) > Date.parse(instance.first_active_at) + DAY_MS
  );
}

export function groupInstancesByUser(
  instances: FunnelInstanceRow[]
): Map<string, FunnelInstanceRow[]> {
  const byUser = new Map<string, FunnelInstanceRow[]>();
  for (const inst of instances) {
    if (!inst.user_id) continue;
    const list = byUser.get(inst.user_id);
    if (list) list.push(inst);
    else byUser.set(inst.user_id, [inst]);
  }
  return byUser;
}

export function buildWeeklyCohorts(
  subs: FunnelSubscriptionRow[],
  instancesByUser: Map<string, FunnelInstanceRow[]>,
  weekStarts: string[]
): FunnelWeeklyCohort[] {
  const byWeek = new Map<string, FunnelWeeklyCohort>(
    weekStarts.map((weekStart) => [
      weekStart,
      { weekStart, signups: 0, deployed: 0, wentActive: 0, usedPastDay1: 0, paidNow: 0 },
    ])
  );
  for (const sub of subs) {
    const cohort = byWeek.get(utcWeekStartKey(sub.created_at));
    if (!cohort) continue;
    cohort.signups += 1;
    const instances = instancesByUser.get(sub.user_id) ?? [];
    if (instances.length > 0) cohort.deployed += 1;
    if (instances.some((i) => i.first_active_at)) cohort.wentActive += 1;
    if (instances.some(instanceUsedPastDay1)) cohort.usedPastDay1 += 1;
    if (isPaidPlan(sub.plan)) cohort.paidNow += 1;
  }
  return weekStarts.map((w) => byWeek.get(w)!);
}

export function buildDailySeries(
  dayKeys: string[],
  events: {
    signupDates: string[];
    deployDates: string[];
    activationDates: string[];
    paymentDates: string[];
  }
): FunnelDailyPoint[] {
  const byDay = new Map<string, FunnelDailyPoint>(
    dayKeys.map((date) => [date, { date, signups: 0, deploys: 0, activations: 0, payments: 0 }])
  );
  const tally = (dates: string[], key: "signups" | "deploys" | "activations" | "payments") => {
    for (const ts of dates) {
      const point = byDay.get(utcDayKey(ts));
      if (point) point[key] += 1;
    }
  };
  tally(events.signupDates, "signups");
  tally(events.deployDates, "deploys");
  tally(events.activationDates, "activations");
  tally(events.paymentDates, "payments");
  return dayKeys.map((d) => byDay.get(d)!);
}

export function buildUpgradeSplit(subs: FunnelSubscriptionRow[]): FunnelUpgradeSplit {
  const split: FunnelUpgradeSplit = { day0: 0, later: 0, unclear: 0 };
  for (const sub of subs) {
    if (!isPaidPlan(sub.plan)) continue;
    split[classifyUpgrade(sub.created_at, sub.upgraded_at ?? sub.current_period_start)] += 1;
  }
  return split;
}

// ---------- queries ----------

interface QueryError {
  message?: string | null;
  code?: string | null;
}

type PageResult<T> = { data: T[] | null; error: QueryError | null };

function queryError(label: string, error: QueryError): Error {
  return new Error(`${label}: ${error.message || error.code || "query failed"}`);
}

async function fetchAllPages<T>(
  label: string,
  page: (from: number, to: number) => PromiseLike<PageResult<T>>
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) throw queryError(label, error);
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return rows;
  }
}

type AdminClient = NonNullable<typeof supabaseAdmin>;

/** Does hermes_subscriptions.upgraded_at exist yet? (Separate instrumentation PR.) */
async function probeUpgradedAtColumn(client: AdminClient): Promise<boolean> {
  const { error } = await client.from("hermes_subscriptions").select("upgraded_at").limit(1);
  if (!error) return true;
  if (error.code === "42703" || (error.message ?? "").includes("upgraded_at")) return false;
  // Unrelated failure — assume present; the real fetch will surface the error.
  return true;
}

function fetchWindowSubscriptions(
  client: AdminClient,
  windowStartIso: string,
  hasUpgradedAt: boolean
): Promise<FunnelSubscriptionRow[]> {
  const cols = `user_id, plan, created_at, current_period_start${hasUpgradedAt ? ", upgraded_at" : ""}`;
  return fetchAllPages<FunnelSubscriptionRow>(
    "funnel signups window",
    (from, to) =>
      client
        .from("hermes_subscriptions")
        .select(cols)
        .gte("created_at", windowStartIso)
        .order("id")
        .range(from, to) as unknown as PromiseLike<PageResult<FunnelSubscriptionRow>>
  );
}

async function fetchInstancesForUsers(
  client: AdminClient,
  userIds: string[]
): Promise<FunnelInstanceRow[]> {
  const rows: FunnelInstanceRow[] = [];
  for (const ids of chunk(userIds, IN_CHUNK_SIZE)) {
    rows.push(
      ...(await fetchAllPages<FunnelInstanceRow>("funnel cohort instances", (from, to) =>
        client
          .from("hermes_instances")
          .select("user_id, created_at, first_active_at, last_activity_at")
          .in("user_id", ids)
          .order("id")
          .range(from, to)
      ))
    );
  }
  return rows;
}

function fetchPayments(
  client: AdminClient,
  startIso: string,
  hasUpgradedAt: boolean
): Promise<FunnelSubscriptionRow[]> {
  return fetchAllPages<FunnelSubscriptionRow>("funnel payments", (from, to) => {
    let q = client
      .from("hermes_subscriptions")
      .select(
        `user_id, plan, created_at, current_period_start${hasUpgradedAt ? ", upgraded_at" : ""}`
      )
      .in("plan", [...FUNNEL_PAID_PLANS]);
    q = hasUpgradedAt
      ? q.or(
          `upgraded_at.gte.${startIso},and(upgraded_at.is.null,current_period_start.gte.${startIso})`
        )
      : q.gte("current_period_start", startIso);
    return q.order("id").range(from, to) as unknown as PromiseLike<
      PageResult<FunnelSubscriptionRow>
    >;
  });
}

/**
 * The engaged-free pool as user ids: free plan + a running (lifecycle_state
 * 'active') instance + last_activity_at on or after the cutoff. Sorted for
 * deterministic ordering — the warm-pool campaign slices this list, so a
 * dry-run preview and the real send must agree on order.
 *
 * Exported for the warm-pool campaign (see warm-pool-campaign-sweep.ts);
 * fetchEngagedFreePool keeps the insights panel on the same definition.
 */
export async function fetchEngagedFreeUserIds(
  client: AdminClient,
  activityCutoffIso: string
): Promise<string[]> {
  const liveActive = await fetchAllPages<{ user_id: string | null }>(
    "funnel engaged instances",
    (from, to) =>
      client
        .from("hermes_instances")
        .select("user_id")
        .eq("lifecycle_state", "active")
        .gte("last_activity_at", activityCutoffIso)
        .not("user_id", "is", null)
        .order("id")
        .range(from, to)
  );
  const userIds = [...new Set(liveActive.map((r) => r.user_id).filter((id): id is string => !!id))];
  const engaged = new Set<string>();
  for (const ids of chunk(userIds, IN_CHUNK_SIZE)) {
    const { data, error } = await client
      .from("hermes_subscriptions")
      .select("user_id")
      .eq("plan", "free")
      .in("user_id", ids);
    if (error) throw queryError("funnel engaged free pool", error);
    for (const row of data ?? []) {
      if (row.user_id) engaged.add(row.user_id);
    }
  }
  return [...engaged].sort();
}

async function fetchEngagedFreePool(client: AdminClient, activityCutoffIso: string): Promise<number> {
  return (await fetchEngagedFreeUserIds(client, activityCutoffIso)).length;
}

async function fetchPlanTotals(
  client: AdminClient
): Promise<{ free: number; paidByPlan: Record<string, number> }> {
  const plans = ["free", ...FUNNEL_PAID_PLANS];
  const counts = await Promise.all(
    plans.map(async (plan) => {
      const { count, error } = await client
        .from("hermes_subscriptions")
        .select("user_id", { count: "exact", head: true })
        .eq("plan", plan)
        .eq("status", "active");
      if (error) throw queryError(`funnel plan total (${plan})`, error);
      return count ?? 0;
    })
  );
  const paidByPlan: Record<string, number> = {};
  FUNNEL_PAID_PLANS.forEach((plan, i) => {
    paidByPlan[plan] = counts[i + 1];
  });
  return { free: counts[0], paidByPlan };
}

// ---------- entry point ----------

function emptyFunnelStats(now: Date): ConversionFunnelStats {
  return {
    generatedAt: now.toISOString(),
    weeklyCohorts: lastNWeekStarts(WEEKLY_COHORT_WEEKS, now).map((weekStart) => ({
      weekStart,
      signups: 0,
      deployed: 0,
      wentActive: 0,
      usedPastDay1: 0,
      paidNow: 0,
    })),
    daily: lastNDayKeys(DAILY_TREND_DAYS, now).map((date) => ({
      date,
      signups: 0,
      deploys: 0,
      activations: 0,
      payments: 0,
    })),
    engagedFreePool: 0,
    currentTotals: {
      free: 0,
      paidByPlan: Object.fromEntries(FUNNEL_PAID_PLANS.map((p) => [p, 0])),
    },
    upgradeSplit: { day0: 0, later: 0, unclear: 0 },
    upgradeTimestampSource: "period_start_inference",
  };
}

/**
 * Compute the conversion funnel for the admin insights page: weekly signup
 * cohorts (last 8 weeks), the last-14-days daily trend, the engaged-free
 * pool, and current plan totals. Never throws — returns zeroed stats if the
 * admin client is unavailable or a query fails.
 */
export async function getConversionFunnel(now = new Date()): Promise<ConversionFunnelStats> {
  if (!supabaseAdmin) {
    log.warn("conversion-funnel: supabaseAdmin is null (env vars missing)", {
      source: "conversion-funnel",
    });
    return emptyFunnelStats(now);
  }
  const client = supabaseAdmin;

  const weekStarts = lastNWeekStarts(WEEKLY_COHORT_WEEKS, now);
  const dayKeys = lastNDayKeys(DAILY_TREND_DAYS, now);
  const cohortWindowStartIso = `${weekStarts[0]}T00:00:00.000Z`;
  const dailyWindowStartIso = `${dayKeys[0]}T00:00:00.000Z`;
  const engagedCutoffIso = new Date(
    now.getTime() - ENGAGED_POOL_ACTIVITY_DAYS * DAY_MS
  ).toISOString();

  try {
    const hasUpgradedAt = await probeUpgradedAtColumn(client);

    const [windowSubs, deploys, activations, payments, engagedFreePool, currentTotals] =
      await Promise.all([
        fetchWindowSubscriptions(client, cohortWindowStartIso, hasUpgradedAt),
        fetchAllPages<{ created_at: string }>("funnel deploys", (from, to) =>
          client
            .from("hermes_instances")
            .select("created_at")
            .gte("created_at", dailyWindowStartIso)
            .order("id")
            .range(from, to)
        ),
        fetchAllPages<{ first_active_at: string }>("funnel activations", (from, to) =>
          client
            .from("hermes_instances")
            .select("first_active_at")
            .gte("first_active_at", dailyWindowStartIso)
            .order("id")
            .range(from, to)
        ),
        fetchPayments(client, dailyWindowStartIso, hasUpgradedAt),
        fetchEngagedFreePool(client, engagedCutoffIso),
        fetchPlanTotals(client),
      ]);

    const cohortInstances = await fetchInstancesForUsers(client, [
      ...new Set(windowSubs.map((s) => s.user_id)),
    ]);

    return {
      generatedAt: now.toISOString(),
      weeklyCohorts: buildWeeklyCohorts(
        windowSubs,
        groupInstancesByUser(cohortInstances),
        weekStarts
      ),
      daily: buildDailySeries(dayKeys, {
        signupDates: windowSubs.map((s) => s.created_at),
        deployDates: deploys.map((d) => d.created_at),
        activationDates: activations.map((a) => a.first_active_at),
        paymentDates: payments
          .map((p) => p.upgraded_at ?? p.current_period_start)
          .filter((ts): ts is string => !!ts),
      }),
      engagedFreePool,
      currentTotals,
      upgradeSplit: buildUpgradeSplit(windowSubs),
      upgradeTimestampSource: hasUpgradedAt ? "upgraded_at" : "period_start_inference",
    };
  } catch (error) {
    log.error(
      "conversion-funnel: query failed",
      error instanceof Error ? error : new Error(String(error)),
      { source: "conversion-funnel" }
    );
    return emptyFunnelStats(now);
  }
}
