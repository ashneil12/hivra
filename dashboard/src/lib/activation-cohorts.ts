import "server-only";
import { chunk } from "@/lib/array-utils";

import { supabaseAdmin } from "@/lib/supabase";
import { log } from "@/lib/logger";
import { FUNNEL_PAID_PLANS, isPaidPlan, utcDayKey, utcWeekStartKey, lastNWeekStarts } from "@/lib/conversion-funnel";

/**
 * Weekly activation + retention cohorts for the admin insights page.
 *
 * This module is ADDITIVE. It deliberately does NOT reuse conversion-funnel's
 * cohort definition, which keys cohorts on the *subscription* signup week and
 * treats `hermes_instances.first_active_at` (stamped at VM BOOT) as "went
 * active". That conflates "the box booted" with "the human actually used it".
 *
 * Here a cohort is keyed on the *instance* `created_at` week (the deploy
 * moment), and we split the funnel into honest stages:
 *
 *   deployed  = distinct users with an instance created that week
 *   booted    = >=1 of that cohort's instances reached first_active_at (boot)
 *   used      = >=1 reached first_usage_at (the real "human used it" signal,
 *               only stamped since FIRST_USAGE_INSTRUMENTED_FROM)
 *   paid      = the user is on a paying plan (operator/fleet/command)
 *   retained  = still paying past cycle 1 — a paid subscription whose
 *               current_period_end has advanced past the retention horizon,
 *               OR the user's instance is still alive (not deleted) and last
 *               active > RETENTION_DAYS after the cohort deploy.
 *
 * The booted-vs-used gap is the whole point: it makes the "boots but is never
 * touched" leak visible, and lets the week's shipped fixes (durable
 * first_usage stamp, activity-digest email, free standing task, gated
 * auto-seed) be proven by watching `used` and `retained` move per cohort.
 *
 * first_usage_at only began being stamped on 2026-05-30. Cohorts whose deploy
 * week ENDS before that date can never have a `used` value, so they report
 * `usedKnown: false` (rendered as n/a) instead of a misleading 0. Cohorts that
 * straddle the cutoff are reported as known — they are partially instrumented,
 * which is the honest floor.
 */

/** First day first_usage_at was stamped (verified from prod). */
export const FIRST_USAGE_INSTRUMENTED_FROM = "2026-05-30";

/** Paid past this many days after deploy counts as "retained" (cycle 1 ≈ 30d + grace). */
export const RETENTION_DAYS = 35;

const WEEKLY_COHORT_WEEKS = 8;
const DAY_MS = 86_400_000;
const PAGE_SIZE = 1000;
const IN_CHUNK_SIZE = 200;

export interface ActivationInstanceRow {
  user_id: string | null;
  created_at: string;
  first_active_at: string | null;
  first_usage_at: string | null;
  last_activity_at: string | null;
  deleted_at: string | null;
  standing_task_seeded_at: string | null;
}

export interface ActivationSubscriptionRow {
  user_id: string;
  plan: string | null;
  status: string | null;
  current_period_end: string | null;
}

interface ActivationDigestRow {
  user_id: string | null;
}

export interface ActivationCohort {
  /** YYYY-MM-DD of the cohort's UTC Monday (instance deploy week). */
  weekStart: string;
  /** Distinct users who deployed an instance this week. */
  deployed: number;
  /** Of `deployed`, how many had an instance reach first_active_at (boot). */
  booted: number;
  /**
   * Of `deployed`, how many had an instance reach first_usage_at (real use).
   * Only meaningful when usedKnown is true.
   */
  used: number;
  /**
   * False when the cohort's deploy week ENDS before first_usage_at
   * instrumentation began — `used` is then unknowable, not zero. Render n/a.
   */
  usedKnown: boolean;
  /** Of `deployed`, how many are on a paying plan now. */
  paid: number;
  /** Of `deployed`, how many are still paying / still active past cycle 1. */
  retained: number;
  /** Of `deployed`, how many were sent an activity-digest email. */
  digestEmailed: number;
  /** Of `deployed`, how many have a standing task seeded. */
  withStandingTask: number;
}

export interface ActivationCohortStats {
  generatedAt: string;
  /** Oldest → newest, always WEEKLY_COHORT_WEEKS buckets. */
  cohorts: ActivationCohort[];
  /** Echoed so the UI can label the discontinuity without hardcoding it. */
  firstUsageInstrumentedFrom: string;
  retentionDays: number;
}

// ---------- pure helpers (unit-tested) ----------

/**
 * The Sunday (inclusive) that ends the UTC week beginning at `weekStart`.
 * Used to decide whether a cohort week predates first_usage instrumentation.
 */
export function utcWeekEndKey(weekStart: string): string {
  const start = Date.parse(`${weekStart}T00:00:00.000Z`);
  return utcDayKey(new Date(start + 6 * DAY_MS));
}

/**
 * A cohort's `used` count is knowable only if any part of its deploy week is on
 * or after instrumentation started. We use the week END so a cohort is treated
 * as known the moment instrumentation touches even its last day — the honest
 * (lower-bound) floor, never an inflated zero for a fully-dark week.
 */
export function isUsedKnownForWeek(weekStart: string, instrumentedFrom: string): boolean {
  return utcWeekEndKey(weekStart) >= instrumentedFrom;
}

export function groupInstancesByUser(
  instances: ActivationInstanceRow[]
): Map<string, ActivationInstanceRow[]> {
  const byUser = new Map<string, ActivationInstanceRow[]>();
  for (const inst of instances) {
    if (!inst.user_id) continue;
    const list = byUser.get(inst.user_id);
    if (list) list.push(inst);
    else byUser.set(inst.user_id, [inst]);
  }
  return byUser;
}

/**
 * A user retained past cycle 1 if EITHER:
 *  - they hold an active paying subscription whose current_period_end is more
 *    than RETENTION_DAYS after the cohort deploy (they paid into a 2nd cycle), OR
 *  - any of their cohort instances is still alive (not deleted) and was active
 *    more than RETENTION_DAYS after the deploy (still using it, free or paid).
 */
export function isRetained(
  deployAt: string,
  instances: ActivationInstanceRow[],
  sub: ActivationSubscriptionRow | undefined,
  now: Date,
  retentionDays = RETENTION_DAYS
): boolean {
  const deploy = Date.parse(deployAt);
  if (!Number.isFinite(deploy)) return false;
  const horizon = deploy + retentionDays * DAY_MS;

  if (sub && isPaidPlan(sub.plan) && sub.status === "active" && sub.current_period_end) {
    const end = Date.parse(sub.current_period_end);
    if (Number.isFinite(end) && end > horizon) return true;
  }

  for (const inst of instances) {
    if (inst.deleted_at) continue;
    if (!inst.last_activity_at) continue;
    const last = Date.parse(inst.last_activity_at);
    if (Number.isFinite(last) && last > horizon && last <= now.getTime()) return true;
  }
  return false;
}

export function buildActivationCohorts(
  instances: ActivationInstanceRow[],
  subsByUser: Map<string, ActivationSubscriptionRow>,
  digestUserIds: Set<string>,
  weekStarts: string[],
  now: Date,
  options: { instrumentedFrom?: string; retentionDays?: number } = {}
): ActivationCohort[] {
  const instrumentedFrom = options.instrumentedFrom ?? FIRST_USAGE_INSTRUMENTED_FROM;
  const retentionDays = options.retentionDays ?? RETENTION_DAYS;

  // Track, per (week, user), the rolled-up signals across that user's
  // instances deployed in the week, so a user is counted once per cohort.
  interface UserAgg {
    booted: boolean;
    used: boolean;
    instances: ActivationInstanceRow[];
    earliestDeploy: string;
  }
  const perWeekUsers = new Map<string, Map<string, UserAgg>>(
    weekStarts.map((w) => [w, new Map<string, UserAgg>()])
  );

  for (const inst of instances) {
    if (!inst.user_id) continue;
    const week = utcWeekStartKey(inst.created_at);
    const users = perWeekUsers.get(week);
    if (!users) continue;
    let agg = users.get(inst.user_id);
    if (!agg) {
      agg = { booted: false, used: false, instances: [], earliestDeploy: inst.created_at };
      users.set(inst.user_id, agg);
    }
    agg.instances.push(inst);
    if (inst.first_active_at) agg.booted = true;
    if (inst.first_usage_at) agg.used = true;
    if (Date.parse(inst.created_at) < Date.parse(agg.earliestDeploy)) {
      agg.earliestDeploy = inst.created_at;
    }
  }

  return weekStarts.map((weekStart) => {
    const users = perWeekUsers.get(weekStart)!;
    const usedKnown = isUsedKnownForWeek(weekStart, instrumentedFrom);
    let deployed = 0;
    let booted = 0;
    let used = 0;
    let paid = 0;
    let retained = 0;
    let digestEmailed = 0;
    let withStandingTask = 0;

    for (const [userId, agg] of users) {
      deployed += 1;
      if (agg.booted) booted += 1;
      if (usedKnown && agg.used) used += 1;
      const sub = subsByUser.get(userId);
      if (sub && isPaidPlan(sub.plan) && sub.status === "active") paid += 1;
      if (isRetained(agg.earliestDeploy, agg.instances, sub, now, retentionDays)) retained += 1;
      if (digestUserIds.has(userId)) digestEmailed += 1;
      if (agg.instances.some((i) => i.standing_task_seeded_at)) withStandingTask += 1;
    }

    return {
      weekStart,
      deployed,
      booted,
      used,
      usedKnown,
      paid,
      retained,
      digestEmailed,
      withStandingTask,
    };
  });
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

function fetchWindowInstances(
  client: AdminClient,
  windowStartIso: string
): Promise<ActivationInstanceRow[]> {
  return fetchAllPages<ActivationInstanceRow>("activation cohort instances", (from, to) =>
    client
      .from("hermes_instances")
      .select(
        "user_id, created_at, first_active_at, first_usage_at, last_activity_at, deleted_at, standing_task_seeded_at"
      )
      .gte("created_at", windowStartIso)
      .order("id")
      .range(from, to) as unknown as PromiseLike<PageResult<ActivationInstanceRow>>
  );
}

async function fetchSubscriptionsForUsers(
  client: AdminClient,
  userIds: string[]
): Promise<ActivationSubscriptionRow[]> {
  const rows: ActivationSubscriptionRow[] = [];
  for (const ids of chunk(userIds, IN_CHUNK_SIZE)) {
    rows.push(
      ...(await fetchAllPages<ActivationSubscriptionRow>("activation cohort subscriptions", (from, to) =>
        client
          .from("hermes_subscriptions")
          .select("user_id, plan, status, current_period_end")
          .in("user_id", ids)
          .order("user_id")
          .range(from, to)
      ))
    );
  }
  return rows;
}

async function fetchDigestUserIds(
  client: AdminClient,
  userIds: string[]
): Promise<Set<string>> {
  const out = new Set<string>();
  for (const ids of chunk(userIds, IN_CHUNK_SIZE)) {
    const rows = await fetchAllPages<ActivationDigestRow>("activation digest sends", (from, to) =>
      client
        .from("lifecycle_email_sends")
        .select("user_id")
        .like("email_key", "activity_digest%")
        .in("user_id", ids)
        .order("user_id")
        .range(from, to)
    );
    for (const r of rows) if (r.user_id) out.add(r.user_id);
  }
  return out;
}

/**
 * Pick one subscription row per user. Prefer a paying, active subscription so
 * the paid/retained classification reflects the user's best current standing.
 */
export function pickSubscriptionByUser(
  rows: ActivationSubscriptionRow[]
): Map<string, ActivationSubscriptionRow> {
  const byUser = new Map<string, ActivationSubscriptionRow>();
  for (const row of rows) {
    const existing = byUser.get(row.user_id);
    if (!existing) {
      byUser.set(row.user_id, row);
      continue;
    }
    const rowIsPreferred = isPaidPlan(row.plan) && row.status === "active";
    const existingIsPreferred = isPaidPlan(existing.plan) && existing.status === "active";
    if (rowIsPreferred && !existingIsPreferred) byUser.set(row.user_id, row);
  }
  return byUser;
}

// ---------- entry point ----------

function emptyStats(now: Date): ActivationCohortStats {
  const weekStarts = lastNWeekStarts(WEEKLY_COHORT_WEEKS, now);
  return {
    generatedAt: now.toISOString(),
    cohorts: weekStarts.map((weekStart) => ({
      weekStart,
      deployed: 0,
      booted: 0,
      used: 0,
      usedKnown: isUsedKnownForWeek(weekStart, FIRST_USAGE_INSTRUMENTED_FROM),
      paid: 0,
      retained: 0,
      digestEmailed: 0,
      withStandingTask: 0,
    })),
    firstUsageInstrumentedFrom: FIRST_USAGE_INSTRUMENTED_FROM,
    retentionDays: RETENTION_DAYS,
  };
}

/**
 * Compute weekly activation + retention cohorts (last 8 weeks) for the admin
 * insights page. Never throws — returns zeroed stats if the admin client is
 * unavailable or a query fails (mirrors getConversionFunnel).
 */
export async function getActivationCohorts(now = new Date()): Promise<ActivationCohortStats> {
  if (!supabaseAdmin) {
    log.warn("activation-cohorts: supabaseAdmin is null (env vars missing)", {
      source: "activation-cohorts",
    });
    return emptyStats(now);
  }
  const client = supabaseAdmin;

  const weekStarts = lastNWeekStarts(WEEKLY_COHORT_WEEKS, now);
  const windowStartIso = `${weekStarts[0]}T00:00:00.000Z`;

  try {
    const instances = await fetchWindowInstances(client, windowStartIso);
    const userIds = [
      ...new Set(instances.map((i) => i.user_id).filter((id): id is string => !!id)),
    ];

    const [subs, digestUserIds] = await Promise.all([
      fetchSubscriptionsForUsers(client, userIds),
      fetchDigestUserIds(client, userIds),
    ]);

    return {
      generatedAt: now.toISOString(),
      cohorts: buildActivationCohorts(
        instances,
        pickSubscriptionByUser(subs),
        digestUserIds,
        weekStarts,
        now
      ),
      firstUsageInstrumentedFrom: FIRST_USAGE_INSTRUMENTED_FROM,
      retentionDays: RETENTION_DAYS,
    };
  } catch (error) {
    log.error(
      "activation-cohorts: query failed",
      error instanceof Error ? error : new Error(String(error)),
      { source: "activation-cohorts" }
    );
    return emptyStats(now);
  }
}

// Keep paid-plan list importable for symmetry with conversion-funnel consumers.
export { FUNNEL_PAID_PLANS };
