/**
 * Lifecycle-email sweep.
 *
 * Daily cohort selection + send for the five lifecycle emails (see
 * email/lifecycle.ts). Driven by /api/cron/lifecycle-emails.
 *
 * Cohorts (all windows evaluated against the run time, in hours/days ago):
 *   day1_idle    signup 24–48h ago, zero (non-deleted) instances
 *   day1_active  first instance created 24–48h ago
 *   day3_usecase signup 72–96h ago
 *   day7_offer   signup 168–192h ago (day 7–8), free plan only
 *   trial_day5   paid plan, upgraded_at 120–144h ago, trial-experiment
 *                'trial' bucket (only while TRIAL_EXPERIMENT_ENABLED)
 *   stalled_5d   a live instance whose last_activity_at is 5–21 days old
 *   activity_digest  weekly "what your agent did" recap for users with a
 *                webui-backed instance active in the last 7 days (lowest
 *                priority; ledger key stamped with the ISO year-week so it
 *                fires at most once per user per ISO week)
 *
 * trial_day5 honesty note: Stripe's 'trialing' status is NOT queryable from
 * hermes_subscriptions — the webhook maps trialing → 'active' on purpose.
 * The cohort is therefore a proxy: upgraded_at (stamped at trial start,
 * since trialing counts as a paid activation) + the deterministic
 * bucketForUser recompute. It cannot see users who cancelled mid-trial,
 * and a trial-bucket user who paid WITHOUT a trial (checkout before the
 * experiment was enabled, day-5 window after) would be mailed incorrectly
 * — acceptable for a default-off experiment, revisit if trials launch.
 *
 * Guarantees:
 *   - At most one lifecycle email per user per run (priority = the order
 *     above), so overlapping windows never double-mail someone in a day.
 *   - At most one send per (user, key) EVER, via the lifecycle_email_sends
 *     ledger (checked before send, inserted after Resend accepts) plus a
 *     stable Resend idempotencyKey `lifecycle_<key>_<user_id>` as a second
 *     line of defense if the ledger write races or fails.
 *   - Per-send try/catch: one bad row never kills the run.
 *   - Hard cap (LIFECYCLE_EMAILS_BATCH_SIZE, default 50) per run so a
 *     selection bug can't drain Resend in one shot.
 *   - The 21-day stalled lookback floor stops the first enabled run from
 *     mailing the entire historical dormant fleet.
 *
 * Recipient resolution copies the cold-storage-notifications mechanism:
 * Clerk user fetch → primary email, falling back to any verified address.
 */

import "server-only";
import { chunk } from "@/lib/array-utils";

import {
  bucketForUser,
  isTrialExperimentEnabled,
} from "@/lib/billing/trial-experiment";
import { type InstanceActivityDigest } from "@/lib/command-center/activity";
import { isPaidPlan } from "@/lib/conversion-funnel";
import {
  sendLifecycleEmail,
  type ActivityDigestSummary,
  type LifecycleEmailContentParams,
  type LifecycleEmailKey,
} from "@/lib/email/lifecycle";
import { log } from "@/lib/logger";
import { posthogClient } from "@/lib/posthog";
import { sendMobilePushToUser } from "@/lib/push/expo-push";
import { supabaseAdmin } from "@/lib/supabase";
import { summarizeInstanceUsage, type UsageSnapshotRow } from "@/lib/usage-summary";

const LOG_SOURCE = "lifecycle-email-sweep";
const CLERK_API_BASE_URL = "https://api.clerk.com/v1";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const QUERY_LIMIT = 1000;
const IN_CHUNK_SIZE = 200;

const DEFAULT_BATCH_SIZE = 50;
const STALLED_MIN_DAYS = 5;
const STALLED_LOOKBACK_DAYS = 21;
/** Activity-digest cohort: a webui instance active within this many days. */
const ACTIVITY_DIGEST_LOOKBACK_DAYS = 7;

// ---------- row shapes ----------

export interface LifecycleSubscriptionRow {
  user_id: string;
  plan: string | null;
  created_at: string;
  /** First free->paid transition; trial starts stamp this too. */
  upgraded_at?: string | null;
}

export interface LifecycleInstanceRow {
  id: string;
  user_id: string | null;
  name: string | null;
  created_at: string;
  last_activity_at: string | null;
  /** "gateway" | "webui" | null. Only the activity-digest cohort reads it. */
  backend?: string | null;
  /**
   * Launch goal id captured by the welcome flow (Wave 1.2), e.g. "research".
   * Threaded into day1/day3 lifecycle copy so re-engagement references the job
   * the user signed up to do. Null when onboarding was skipped.
   */
  goal?: string | null;
  /** First task the user asked their agent to demonstrate, captured at launch. */
  first_task?: string | null;
}

export interface DueLifecycleEmail {
  key: LifecycleEmailKey;
  /** Instance the email should deep-link to, when one applies. */
  instance: LifecycleInstanceRow | null;
}

export interface LifecycleSweepSummary {
  candidates: number;
  day1_idle: number;
  day1_active: number;
  day3_usecase: number;
  day7_offer: number;
  stalled_5d: number;
  trial_day5: number;
  activity_digest: number;
  /** Digest candidates skipped because the box was empty/unreachable. */
  activity_digest_skipped: number;
  skipped_already_sent: number;
  skipped_no_email: number;
  failed: number;
  capHit: boolean;
  /** Mobile pushes delivered beside the attention emails (iOS Phase 2, additive). */
  pushes_sent: number;
  pushes_failed: number;
}

/**
 * The lifecycle cohorts that ALSO fan out a mobile push beside the email
 * (iOS Phase 2 — the "task-finished / needs-attention" lane). Deliberately
 * NOT every cohort: day1/day3/day7/trial are marketing re-engagement mails and
 * pushing them would burn the notification channel's trust; the two below are
 * the agent-status moments a phone user actually wants interrupted for.
 * The push shares the email's send-once guards (lifecycle_email_sends ledger +
 * the at-most-one-per-user-per-run rule) because it only fires in the same
 * iteration whose email was accepted and ledgered.
 */
const PUSH_ELIGIBLE_LIFECYCLE_KEYS = new Set<string>(["stalled_5d"]);

// ---------- pure cohort helpers (unit-tested) ----------

/** True when `ts` is between minHoursAgo (inclusive) and maxHoursAgo (exclusive) before `now`. */
export function withinHoursAgo(
  ts: string,
  now: Date,
  minHoursAgo: number,
  maxHoursAgo: number
): boolean {
  const age = now.getTime() - Date.parse(ts);
  if (!Number.isFinite(age)) return false;
  return age >= minHoursAgo * HOUR_MS && age < maxHoursAgo * HOUR_MS;
}

/** The user's earliest-created instance, or null. */
export function earliestInstance(
  instances: LifecycleInstanceRow[]
): LifecycleInstanceRow | null {
  let earliest: LifecycleInstanceRow | null = null;
  for (const inst of instances) {
    if (!earliest || Date.parse(inst.created_at) < Date.parse(earliest.created_at)) {
      earliest = inst;
    }
  }
  return earliest;
}

/**
 * The instance whose last_activity_at stalled inside the window (5–21 days
 * old), preferring the most recently active one. Null when nothing stalled.
 */
export function stalledInstance(
  instances: LifecycleInstanceRow[],
  now: Date
): LifecycleInstanceRow | null {
  let best: LifecycleInstanceRow | null = null;
  for (const inst of instances) {
    if (!inst.last_activity_at) continue;
    const inWindow = withinHoursAgo(
      inst.last_activity_at,
      now,
      STALLED_MIN_DAYS * 24,
      STALLED_LOOKBACK_DAYS * 24
    );
    if (!inWindow) continue;
    if (
      !best ||
      Date.parse(inst.last_activity_at) > Date.parse(best.last_activity_at as string)
    ) {
      best = inst;
    }
  }
  return best;
}

// ---------- activity-digest cohort helpers (unit-tested) ----------

/**
 * ISO-8601 year + week for `now`, formatted `YYYY'W'WW` (e.g. "2026W24").
 *
 * Weeks start Monday; week 1 is the week containing the first Thursday of the
 * year (the ISO rule). Computed in UTC so the cron is timezone-stable. Used to
 * stamp the recurring activity-digest ledger key so the same user is mailed at
 * most once per ISO week even though the cron runs daily.
 */
export function isoYearWeek(now: Date): string {
  // Shift to the Thursday of the current ISO week, then read its year + the
  // week number relative to that year's first Thursday.
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  // getUTCDay(): 0=Sun..6=Sat. ISO day 1=Mon..7=Sun.
  const isoDay = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + 4 - isoDay);
  const isoYear = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7);
  return `${isoYear}W${String(week).padStart(2, "0")}`;
}

/** Week-stamped ledger key for the activity digest, e.g. "activity_digest_2026W24". */
export function activityDigestKey(now: Date): string {
  return `activity_digest_${isoYearWeek(now)}`;
}

/**
 * The most-recently-active instance whose last_activity_at is within the digest
 * lookback window (7 days). Null when the user has no qualifying instance. The
 * digest content is sourced from the backend-agnostic instance_usage_snapshots
 * rollup, so every backend qualifies (gateway is now the only backend).
 */
export function activityDigestInstance(
  instances: LifecycleInstanceRow[],
  now: Date
): LifecycleInstanceRow | null {
  let best: LifecycleInstanceRow | null = null;
  for (const inst of instances) {
    if (!inst.last_activity_at) continue;
    const age = now.getTime() - Date.parse(inst.last_activity_at);
    if (!Number.isFinite(age) || age < 0 || age >= ACTIVITY_DIGEST_LOOKBACK_DAYS * DAY_MS) {
      continue;
    }
    if (
      !best ||
      Date.parse(inst.last_activity_at) > Date.parse(best.last_activity_at as string)
    ) {
      best = inst;
    }
  }
  return best;
}

/**
 * Collapse a runtime InstanceActivityDigest into the flat shape the digest
 * email renders. Returns null when there's nothing worth mailing (no recent
 * sessions to summarize), so the caller skips an empty digest.
 */
export function summarizeActivityDigest(
  digest: InstanceActivityDigest
): ActivityDigestSummary | null {
  const sessions = digest.recentSessions ?? [];
  if (sessions.length === 0) return null;

  let totalMessages = 0;
  let sawMessageCount = false;
  let totalCost = 0;
  let sawCost = false;
  const modelCounts = new Map<string, number>();

  for (const session of sessions) {
    if (typeof session.messageCount === "number" && Number.isFinite(session.messageCount)) {
      totalMessages += session.messageCount;
      sawMessageCount = true;
    }
    if (typeof session.estimatedCostUsd === "number" && Number.isFinite(session.estimatedCostUsd)) {
      totalCost += session.estimatedCostUsd;
      sawCost = true;
    }
    if (session.model) {
      modelCounts.set(session.model, (modelCounts.get(session.model) ?? 0) + 1);
    }
  }

  let topModel: string | null = null;
  let topModelCount = 0;
  for (const [model, count] of modelCounts) {
    if (count > topModelCount) {
      topModel = model;
      topModelCount = count;
    }
  }

  return {
    sessionCount: sessions.length,
    totalMessages: sawMessageCount ? totalMessages : null,
    topModel,
    estimatedCostUsd: sawCost ? totalCost : null,
    attentionLabels: (digest.attentionItems ?? []).map((item) => item.label).filter(Boolean),
  };
}

/**
 * All lifecycle emails due for a user right now, in send-priority order.
 * The sweep sends only the first one that hasn't already been sent.
 */
export function selectDueLifecycleEmails(input: {
  subscription: LifecycleSubscriptionRow | null;
  instances: LifecycleInstanceRow[];
  now: Date;
  /**
   * Whether the 7-day Pro trial experiment is on (callers pass
   * isTrialExperimentEnabled()). Default false so the trial_day5 cohort is
   * inert everywhere until the experiment launches.
   */
  trialExperimentEnabled?: boolean;
}): DueLifecycleEmail[] {
  const { subscription, instances, now, trialExperimentEnabled = false } = input;
  const due: DueLifecycleEmail[] = [];

  const first = earliestInstance(instances);

  if (
    subscription &&
    withinHoursAgo(subscription.created_at, now, 24, 48) &&
    instances.length === 0
  ) {
    due.push({ key: "day1_idle", instance: null });
  }

  if (first && withinHoursAgo(first.created_at, now, 24, 48)) {
    due.push({ key: "day1_active", instance: first });
  }

  if (subscription && withinHoursAgo(subscription.created_at, now, 72, 96)) {
    due.push({ key: "day3_usecase", instance: first });
  }

  if (
    subscription &&
    withinHoursAgo(subscription.created_at, now, 168, 192) &&
    !isPaidPlan(subscription.plan)
  ) {
    due.push({ key: "day7_offer", instance: null });
  }

  // trial_day5: day 5–6 of the 7-day trial, proxied by upgraded_at (see the
  // honesty note in the module docstring). Placed ahead of stalled_5d so a
  // trialing user gets the trial email over the generic revival nudge.
  if (
    trialExperimentEnabled &&
    subscription?.upgraded_at &&
    isPaidPlan(subscription.plan) &&
    withinHoursAgo(subscription.upgraded_at, now, 120, 144) &&
    bucketForUser(subscription.user_id) === "trial"
  ) {
    due.push({ key: "trial_day5", instance: first });
  }

  const stalled = stalledInstance(instances, now);
  if (stalled) {
    due.push({ key: "stalled_5d", instance: stalled });
  }

  return due;
}

// ---------- Clerk recipient resolution (same mechanism as cold-storage) ----------

type ClerkUser = {
  id: string;
  first_name?: string | null;
  primary_email_address_id?: string | null;
  email_addresses?: Array<{
    id: string;
    email_address: string;
    verification?: { status?: string | null } | null;
  }>;
};

async function fetchClerkUser(secretKey: string, userId: string): Promise<ClerkUser | null> {
  const response = await fetch(`${CLERK_API_BASE_URL}/users/${userId}`, {
    headers: { Authorization: `Bearer ${secretKey}` },
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Clerk user fetch failed for ${userId}: ${response.status}`);
  }
  return (await response.json()) as ClerkUser;
}

function chooseEmail(user: ClerkUser): string | null {
  const addresses = user.email_addresses ?? [];
  const primary = addresses.find((a) => a.id === user.primary_email_address_id);
  const verified = addresses.find((a) => a.verification?.status === "verified");
  return primary?.email_address ?? verified?.email_address ?? addresses[0]?.email_address ?? null;
}

/**
 * Resolve a Clerk user id to a recipient (primary email, falling back to any
 * verified address) plus first name. Exported so the warm-pool campaign uses
 * the exact same mechanism as the lifecycle sweep. Returns null when the
 * Clerk user is gone or has no usable address; throws on Clerk API errors.
 */
export async function resolveClerkRecipient(
  secretKey: string,
  userId: string
): Promise<{ email: string; firstName: string | null } | null> {
  const clerkUser = await fetchClerkUser(secretKey, userId);
  if (!clerkUser) return null;
  const email = chooseEmail(clerkUser);
  if (!email) return null;
  return { email, firstName: clerkUser.first_name ?? null };
}

// ---------- queries ----------

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveLifecycleBatchSize(): number {
  return Math.min(500, envInt("LIFECYCLE_EMAILS_BATCH_SIZE", DEFAULT_BATCH_SIZE));
}

type QueryError = { message?: string | null } | null;

function throwOnError(label: string, error: QueryError): void {
  if (error) throw new Error(`${label}: ${error.message || "query failed"}`);
}

// ---------- the sweep ----------

/**
 * Cron-safe activity-digest fetch for a single instance. Reads the
 * backend-agnostic instance_usage_snapshots rollup via supabaseAdmin (the same
 * source as the /api/instances/[id]/usage-summary route), so it works for every
 * backend and needs no live runtime call or Clerk `auth()`. Returns null when
 * the agent recorded nothing in the lookback window; the caller then skips the
 * digest for that user. Injectable so the sweep is unit-testable.
 */
export type ActivityDigestFetcher = (input: {
  instanceId: string;
  userId: string;
  instanceName: string | null;
}) => Promise<ActivityDigestSummary | null>;

export async function fetchActivityDigestSummary(input: {
  instanceId: string;
  userId: string;
  instanceName: string | null;
}): Promise<ActivityDigestSummary | null> {
  if (!supabaseAdmin) return null;

  // stat_date is a UTC DATE; bound to the lookback window's calendar floor.
  const sinceIso = new Date(Date.now() - ACTIVITY_DIGEST_LOOKBACK_DAYS * DAY_MS)
    .toISOString()
    .slice(0, 10);
  const { data, error } = await supabaseAdmin
    .from("instance_usage_snapshots")
    .select(
      "stat_date, total_tokens, sessions, api_calls, tool_calls, estimated_cost_usd, by_model"
    )
    .eq("instance_id", input.instanceId)
    .gte("stat_date", sinceIso);
  if (error) return null;

  const usage = summarizeInstanceUsage(
    (data ?? []) as UsageSnapshotRow[],
    ACTIVITY_DIGEST_LOOKBACK_DAYS
  );
  // No empty digests: skip when the agent recorded no sessions this window.
  if (usage.isEmpty || usage.sessions === 0) return null;

  return {
    sessionCount: usage.sessions,
    totalMessages: null,
    topModel: usage.topModel,
    estimatedCostUsd: usage.estimatedCostUsd > 0 ? usage.estimatedCostUsd : null,
    attentionLabels: [],
  };
}

export async function runLifecycleEmailSweep(opts?: {
  now?: Date;
  batchSize?: number;
  /** Override the activity-digest fetch (tests inject a stub). */
  activityDigestFetcher?: ActivityDigestFetcher;
}): Promise<LifecycleSweepSummary> {
  const summary: LifecycleSweepSummary = {
    candidates: 0,
    day1_idle: 0,
    day1_active: 0,
    day3_usecase: 0,
    day7_offer: 0,
    stalled_5d: 0,
    trial_day5: 0,
    activity_digest: 0,
    activity_digest_skipped: 0,
    skipped_already_sent: 0,
    skipped_no_email: 0,
    failed: 0,
    capHit: false,
    pushes_sent: 0,
    pushes_failed: 0,
  };

  if (!supabaseAdmin) throw new Error("Database not configured");
  const db = supabaseAdmin;

  const now = opts?.now ?? new Date();
  const batchSize = Math.max(1, opts?.batchSize ?? resolveLifecycleBatchSize());
  const clerkSecret = process.env.CLERK_SECRET_KEY?.trim();

  const iso = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString();

  // 1. Signups in the widest subscription window (24h–8d ago) cover the
  //    day1_idle / day3_usecase / day7_offer cohorts in one query.
  const { data: subRows, error: subErr } = await db
    .from("hermes_subscriptions")
    .select("user_id, plan, created_at, upgraded_at")
    .gte("created_at", iso(192 * HOUR_MS))
    .lte("created_at", iso(24 * HOUR_MS))
    .limit(QUERY_LIMIT);
  throwOnError("subscription window query failed", subErr);
  const subs = (subRows ?? []) as LifecycleSubscriptionRow[];

  // 1b. Trial day-5 cohort (only while the trial experiment is on): paid
  //     rows whose upgraded_at — the trial-start proxy, see the module
  //     docstring — landed 120–144h ago. Queried separately because these
  //     users may have signed up long before the created_at window above.
  const trialExperimentEnabled = isTrialExperimentEnabled();
  if (trialExperimentEnabled) {
    const { data: trialRows, error: trialErr } = await db
      .from("hermes_subscriptions")
      .select("user_id, plan, created_at, upgraded_at")
      .gte("upgraded_at", iso(144 * HOUR_MS))
      .lte("upgraded_at", iso(120 * HOUR_MS))
      .neq("plan", "free")
      .limit(QUERY_LIMIT);
    throwOnError("trial-day5 window query failed", trialErr);
    for (const row of (trialRows ?? []) as LifecycleSubscriptionRow[]) {
      if (!subs.some((s) => s.user_id === row.user_id)) subs.push(row);
    }
  }

  // 2. Instances created 24–48h ago (day1_active candidates — verified as
  //    the user's FIRST instance later, against the full instance fetch).
  const { data: newInstRows, error: newInstErr } = await db
    .from("hermes_instances")
    .select("id, user_id, name, created_at, last_activity_at")
    .gte("created_at", iso(48 * HOUR_MS))
    .lte("created_at", iso(24 * HOUR_MS))
    .is("deleted_at", null)
    .limit(QUERY_LIMIT);
  throwOnError("new-instance window query failed", newInstErr);

  // 3. Live instances that stalled 5–21 days ago. lifecycle_state='active'
  //    keeps suspended/cold-archived agents out — those have their own
  //    email tracks and "I'm still running" would be a lie.
  const { data: stalledRows, error: stalledErr } = await db
    .from("hermes_instances")
    .select("id, user_id, name, created_at, last_activity_at")
    .gte("last_activity_at", iso(STALLED_LOOKBACK_DAYS * DAY_MS))
    .lte("last_activity_at", iso(STALLED_MIN_DAYS * DAY_MS))
    .eq("lifecycle_state", "active")
    .is("deleted_at", null)
    .limit(QUERY_LIMIT);
  throwOnError("stalled-instance window query failed", stalledErr);

  // 3b. Activity-digest cohort: any instance active within the last 7 days
  //     (backend-agnostic — gateway is now the only backend). The full per-user
  //     fetch below re-derives the chosen instance; this query only widens the
  //     candidate pool to users who'd otherwise be in no onboarding window.
  const { data: digestRows, error: digestErr } = await db
    .from("hermes_instances")
    .select("id, user_id, name, created_at, last_activity_at, backend")
    .gte("last_activity_at", iso(ACTIVITY_DIGEST_LOOKBACK_DAYS * DAY_MS))
    .is("deleted_at", null)
    .limit(QUERY_LIMIT);
  throwOnError("activity-digest window query failed", digestErr);

  const subByUser = new Map(subs.map((s) => [s.user_id, s]));
  const candidateUserIds = new Set<string>(subByUser.keys());
  for (const row of (newInstRows ?? []) as LifecycleInstanceRow[]) {
    if (row.user_id) candidateUserIds.add(row.user_id);
  }
  for (const row of (stalledRows ?? []) as LifecycleInstanceRow[]) {
    if (row.user_id) candidateUserIds.add(row.user_id);
  }
  for (const row of (digestRows ?? []) as LifecycleInstanceRow[]) {
    if (row.user_id) candidateUserIds.add(row.user_id);
  }
  const userIds = [...candidateUserIds];
  summary.candidates = userIds.length;
  if (userIds.length === 0) return summary;

  // 4. Every candidate's full (non-deleted) instance list — needed for the
  //    zero-instances check and the first-instance check.
  const instancesByUser = new Map<string, LifecycleInstanceRow[]>();
  for (const ids of chunk(userIds, IN_CHUNK_SIZE)) {
    const { data, error } = await db
      .from("hermes_instances")
      .select("id, user_id, name, created_at, last_activity_at, backend, goal, first_task")
      .in("user_id", ids)
      .is("deleted_at", null)
      .limit(QUERY_LIMIT);
    throwOnError("instances-by-user query failed", error);
    for (const row of (data ?? []) as LifecycleInstanceRow[]) {
      if (!row.user_id) continue;
      const list = instancesByUser.get(row.user_id);
      if (list) list.push(row);
      else instancesByUser.set(row.user_id, [row]);
    }
  }

  // 5. The already-sent ledger for the candidates.
  const alreadySent = new Set<string>();
  for (const ids of chunk(userIds, IN_CHUNK_SIZE)) {
    const { data, error } = await db
      .from("lifecycle_email_sends")
      .select("user_id, email_key")
      .in("user_id", ids)
      .limit(QUERY_LIMIT);
    throwOnError("lifecycle_email_sends query failed", error);
    for (const row of (data ?? []) as Array<{ user_id: string; email_key: string }>) {
      alreadySent.add(`${row.user_id}:${row.email_key}`);
    }
  }

  // 6. Pick at most one unsent email per user, then cap the run. The
  //    activity-digest cohort is lowest priority, so a user who's due an
  //    onboarding/revival email this run is excluded from the digest pass
  //    (still at most one lifecycle email per user per run).
  const planned: Array<{ userId: string; due: DueLifecycleEmail }> = [];
  const plannedUserIds = new Set<string>();
  for (const userId of userIds) {
    const due = selectDueLifecycleEmails({
      subscription: subByUser.get(userId) ?? null,
      instances: instancesByUser.get(userId) ?? [],
      now,
      trialExperimentEnabled,
    });
    const unsent = due.filter((d) => !alreadySent.has(`${userId}:${d.key}`));
    if (due.length > 0 && unsent.length === 0) {
      summary.skipped_already_sent += 1;
      continue;
    }
    if (unsent.length > 0) {
      planned.push({ userId, due: unsent[0] });
      plannedUserIds.add(userId);
    }
  }
  if (planned.length > batchSize) {
    summary.capHit = true;
    planned.length = batchSize;
  }

  // 7. Resolve recipients and send, one failure at a time.
  let captured = 0;
  for (const { userId, due } of planned) {
    try {
      if (!clerkSecret) {
        summary.skipped_no_email += 1;
        continue;
      }
      const recipient = await resolveClerkRecipient(clerkSecret, userId);
      if (!recipient) {
        summary.skipped_no_email += 1;
        continue;
      }

      const res = await sendLifecycleEmail(due.key, {
        email: recipient.email,
        firstName: recipient.firstName,
        agentName: due.instance?.name ?? null,
        instanceId: due.instance?.id ?? null,
        // Wave 1.2: thread the launch goal/first task captured at deploy so the
        // day1/day3 builders can reference the user's stated job. Null/undefined
        // for cohorts with no instance (day1_idle) — the builders fall back to
        // generic copy.
        goal: due.instance?.goal ?? null,
        firstTask: due.instance?.first_task ?? null,
        idempotencyKey: `lifecycle_${due.key}_${userId}`,
      });
      if (!res.sent) {
        summary.failed += 1;
        continue;
      }

      // Ledger write AFTER Resend accepts. If this fails the Resend
      // idempotencyKey still dedupes the retry, so count it failed (not
      // clean) and move on.
      const { error: insertErr } = await db
        .from("lifecycle_email_sends")
        .upsert(
          { user_id: userId, email_key: due.key },
          { onConflict: "user_id,email_key", ignoreDuplicates: true }
        );
      if (insertErr) {
        summary.failed += 1;
        log.warn("lifecycle email sent but ledger insert failed", {
          source: LOG_SOURCE,
          userId,
          emailKey: due.key,
          errorMessage: insertErr.message,
        });
        continue;
      }

      summary[due.key] += 1;
      posthogClient.capture({
        distinctId: userId,
        event: "lifecycle_email_sent",
        properties: {
          email_key: due.key,
          $insert_id: `lifecycle_email_sent_${due.key}_${userId}`,
        },
      });

      // Mobile push beside the email (iOS Phase 2 — additive; attention-type
      // cohorts only, see PUSH_ELIGIBLE_LIFECYCLE_KEYS). Reached only after the
      // email was accepted AND ledgered, so the push inherits the exact same
      // send-once guarantees. No-tokens users are a clean no-op in the sender.
      if (PUSH_ELIGIBLE_LIFECYCLE_KEYS.has(due.key) && due.instance) {
        try {
          const agentLabel = due.instance.name?.trim() || "Your agent";
          const pushResult = await sendMobilePushToUser({
            userId,
            title: `${agentLabel} is ready for more`,
            body: "It's been a few days — send over the next task.",
            url: `hivra://chat/${due.instance.id}`,
            data: { kind: `lifecycle_${due.key}`, instanceId: due.instance.id },
          });
          summary.pushes_sent += pushResult.sent;
          summary.pushes_failed += pushResult.failed;
        } catch (pushErr) {
          // sendMobilePushToUser never throws by contract; belt-and-braces so
          // a regression there can't break the email sweep.
          summary.pushes_failed += 1;
          log.warn("lifecycle push failed (email already sent)", {
            source: LOG_SOURCE,
            userId,
            emailKey: due.key,
            errorMessage: pushErr instanceof Error ? pushErr.message : String(pushErr),
          });
        }
      }
      captured += 1;
    } catch (err) {
      summary.failed += 1;
      log.warn("lifecycle email send failed", {
        source: LOG_SOURCE,
        userId,
        emailKey: due.key,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 8. Activity-digest pass (lowest priority). Only users who weren't mailed
  //    an onboarding/revival email this run, who have a webui instance active
  //    within the last 7 days, and who haven't already received THIS ISO
  //    week's digest. Shares the per-run batch cap with the main pass.
  const digestKey = activityDigestKey(now);
  const digestFetcher = opts?.activityDigestFetcher ?? fetchActivityDigestSummary;
  let remainingCap = Math.max(0, batchSize - planned.length);
  for (const userId of userIds) {
    if (remainingCap <= 0) {
      summary.capHit = true;
      break;
    }
    if (plannedUserIds.has(userId)) continue;
    if (alreadySent.has(`${userId}:${digestKey}`)) continue;

    const instance = activityDigestInstance(instancesByUser.get(userId) ?? [], now);
    if (!instance) continue;

    try {
      if (!clerkSecret) {
        summary.skipped_no_email += 1;
        continue;
      }
      const recipient = await resolveClerkRecipient(clerkSecret, userId);
      if (!recipient) {
        summary.skipped_no_email += 1;
        continue;
      }

      // Fetch the digest BEFORE consuming cap/sending — skip silently when the
      // box is unreachable or has no recent sessions (no empty digests).
      const activityDigest = await digestFetcher({
        instanceId: instance.id,
        userId,
        instanceName: instance.name,
      });
      if (!activityDigest) {
        summary.activity_digest_skipped += 1;
        continue;
      }

      remainingCap -= 1;

      const params: LifecycleEmailContentParams = {
        firstName: recipient.firstName,
        agentName: instance.name,
        instanceId: instance.id,
        activityDigest,
      };
      const res = await sendLifecycleEmail("activity_digest", {
        ...params,
        email: recipient.email,
        idempotencyKey: `lifecycle_${digestKey}_${userId}`,
      });
      if (!res.sent) {
        summary.failed += 1;
        continue;
      }

      const { error: insertErr } = await db
        .from("lifecycle_email_sends")
        .upsert(
          { user_id: userId, email_key: digestKey },
          { onConflict: "user_id,email_key", ignoreDuplicates: true }
        );
      if (insertErr) {
        summary.failed += 1;
        log.warn("activity digest sent but ledger insert failed", {
          source: LOG_SOURCE,
          userId,
          emailKey: digestKey,
          errorMessage: insertErr.message,
        });
        continue;
      }

      summary.activity_digest += 1;
      posthogClient.capture({
        distinctId: userId,
        event: "lifecycle_email_sent",
        properties: {
          email_key: digestKey,
          email_cohort: "activity_digest",
          $insert_id: `lifecycle_email_sent_${digestKey}_${userId}`,
        },
      });

      // Mobile push beside the digest email (iOS Phase 2 — additive). Mirrors
      // the email's attentionItems→attentionLabels thread: when the digest
      // carries attention labels the push leads with them ("needs you");
      // otherwise it's the plain "here's what your agent did" recap moment.
      // Same ISO-week ledger guard as the email — this block only runs in the
      // iteration whose digest email was accepted and ledgered.
      try {
        const agentLabel = instance.name?.trim() || "Your agent";
        const attention = (activityDigest.attentionLabels ?? []).filter(Boolean);
        const sessionCount = activityDigest.sessionCount;
        const pushResult = await sendMobilePushToUser({
          userId,
          title: `What ${agentLabel} got done this week`,
          body:
            attention.length > 0
              ? `Needs your attention: ${attention.join(", ")}`
              : `${sessionCount} work session${sessionCount === 1 ? "" : "s"} — open the recap.`,
          url: `hivra://chat/${instance.id}`,
          data: { kind: "lifecycle_activity_digest", instanceId: instance.id },
        });
        summary.pushes_sent += pushResult.sent;
        summary.pushes_failed += pushResult.failed;
      } catch (pushErr) {
        summary.pushes_failed += 1;
        log.warn("activity digest push failed (email already sent)", {
          source: LOG_SOURCE,
          userId,
          emailKey: digestKey,
          errorMessage: pushErr instanceof Error ? pushErr.message : String(pushErr),
        });
      }
      captured += 1;
    } catch (err) {
      summary.failed += 1;
      log.warn("activity digest send failed", {
        source: LOG_SOURCE,
        userId,
        emailKey: digestKey,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Flush before the function dies — Vercel won't wait for async flushes.
  if (captured > 0) {
    try {
      await posthogClient.flush();
    } catch (err) {
      log.warn("posthog flush failed", {
        source: LOG_SOURCE,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return summary;
}
