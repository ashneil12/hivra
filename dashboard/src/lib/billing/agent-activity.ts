import "server-only";
import { chunk } from "@/lib/array-utils";

import { supabaseAdmin } from "@/lib/supabase";
import { log } from "@/lib/logger";
import { SELF_HOST_USER_ID } from "@/lib/self-host/config";
import {
  emptyHivraActivity,
  getUserHivraActivity,
  type HivraActivity,
} from "@/lib/hivra/hivra-activity";

/**
 * Per-user "Your agent at work" activity surface.
 *
 * TWO LANES, because a customer can have either kind of box and the two record
 * fundamentally different things:
 *
 *   Hermes lane (`hermes_instances` + `instance_usage_snapshots`) — metered
 *   usage: sessions, tokens, spend, models, skills. `instance_usage_snapshots`
 *   is keyed by `instance_id` with no `user_id`, so we scope per-user by first
 *   resolving the user's non-deleted instance ids, then reading snapshots for
 *   exactly those ids. This half is a USAGE view.
 *
 *   Hivra lane (`lib/hivra/hivra-activity.ts`) — lifecycle activity: launches,
 *   provisions, restarts, desktop sessions. Hivra boxes run the customer's own
 *   model keys, so no token or cost figure exists for them; this half is an
 *   ACTIVITY view and must never be rendered as tokens or dollars.
 *
 * Both lanes always run. The result carries a `coverage` discriminator so the
 * client can pick honest copy instead of collapsing four different truths ("no
 * boxes", "boxes but nothing recorded", "activity but no metering", "metered
 * usage") into one false "No usage yet".
 *
 * Read-only; no migration. The Hermes query never throws — a failure degrades
 * to a zeroed Hermes half flagged `degraded`. A Hivra-lane failure is isolated
 * to `hivra.degraded` so it cannot blank a page whose other half is fine.
 */

const DEFAULT_DAYS = 30;
const MIN_DAYS = 1;
const MAX_DAYS = 90;
const DAY_MS = 86_400_000;
const TOP_N = 5;
// PostgREST silently caps un-ranged selects at 1000 rows; page explicitly.
const PAGE_SIZE = 1000;
// hermes_instances .in() lists are chunked so a user with many instances never
// builds a giant filter string.
const IN_CHUNK_SIZE = 200;

export interface AgentActivityTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
  estimatedCostUsd: number;
  sessions: number;
  apiCalls: number;
  toolCalls: number;
}

export interface AgentActivityDailyPoint {
  /** YYYY-MM-DD (UTC). */
  date: string;
  totalTokens: number;
  estimatedCostUsd: number;
  sessions: number;
}

export interface AgentActivityModel {
  model: string;
  totalTokens: number;
}

export interface AgentActivitySkill {
  skill: string;
  count: number;
}

/**
 * What this payload is entitled to claim. The client picks its empty-state copy
 * from this rather than inferring it from zeroed totals — inferring is exactly
 * how an active Hivra customer was told they had never used the product.
 *   'usage'    — Hermes-lane metered usage exists (tokens/cost).
 *   'activity' — no metered usage, but recorded Hivra-lane activity exists.
 *   'none'     — nothing recorded on either lane (a genuinely new account).
 */
export type AgentActivityCoverage = "usage" | "activity" | "none";

export interface AgentActivity {
  totals: AgentActivityTotals;
  /** Oldest → newest, always `days` points (zero-filled across the range). */
  daily: AgentActivityDailyPoint[];
  /** Top 5 models by total tokens, descending. */
  topModels: AgentActivityModel[];
  /** Top 5 skills by invocation count, descending. */
  topSkills: AgentActivitySkill[];
  /** How many of the user's (non-deleted) Hermes instances were considered. */
  instanceCount: number;
  /** Distinct UTC days in the window with any snapshot activity. */
  activeDays: number;
  /** Hivra-lane activity. Present on every payload; may be empty. */
  hivra: HivraActivity;
  coverage: AgentActivityCoverage;
  generatedAt: string;
  /**
   * True only when the underlying HERMES query failed and the zeroed payload is
   * a fallback rather than a genuine "no usage yet" result. Lets the route /
   * panel distinguish an error from an empty account without breaking the
   * never-throws contract. Absent/false on the happy path. A Hivra-lane failure
   * does NOT set this — it sets `hivra.degraded`, so one lane's hiccup cannot
   * blank a page the other lane can still fill.
   */
  degraded?: boolean;
}

/**
 * A snapshot row, narrowed to the columns this module reads. Numeric columns
 * are bigint/numeric, so PostgREST returns them as strings; everything but
 * `stat_date` is optional/nullable and coerced via `num()` — exported so the
 * pure aggregator can be unit-tested with partial fixtures.
 */
export interface SnapshotRow {
  stat_date: string;
  input_tokens?: number | string | null;
  output_tokens?: number | string | null;
  total_tokens?: number | string | null;
  cache_read_tokens?: number | string | null;
  reasoning_tokens?: number | string | null;
  estimated_cost_usd?: number | string | null;
  sessions?: number | string | null;
  api_calls?: number | string | null;
  tool_calls?: number | string | null;
  by_model?: unknown;
  skills?: unknown;
}

const SNAPSHOT_COLUMNS =
  "stat_date, input_tokens, output_tokens, total_tokens, cache_read_tokens, " +
  "reasoning_tokens, estimated_cost_usd, sessions, api_calls, tool_calls, by_model, skills";

// ---------- pure helpers (unit-tested) ----------

export function clampDays(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value)) return DEFAULT_DAYS;
  return Math.max(MIN_DAYS, Math.min(MAX_DAYS, Math.floor(value)));
}

/** YYYY-MM-DD in UTC for a date string or Date. */
export function utcDayKey(value: string | Date): string {
  const d = value instanceof Date ? value : new Date(value);
  return d.toISOString().slice(0, 10);
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
 * bigint/numeric columns come back from PostgREST as strings; cost is numeric.
 * Coerce defensively and drop anything non-finite to 0.
 */
function num(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function emptyTotals(): AgentActivityTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    estimatedCostUsd: 0,
    sessions: 0,
    apiCalls: 0,
    toolCalls: 0,
  };
}

/**
 * `by_model` is a jsonb map of model → either a token count or an object that
 * carries a token total under one of a few common keys. Coerce both shapes so
 * a snapshot writer that nests counts still aggregates correctly.
 */
function modelTokens(value: unknown): number {
  if (typeof value === "number" || typeof value === "string") return num(value);
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    for (const key of ["total_tokens", "totalTokens", "tokens", "total"]) {
      if (key in rec) return num(rec[key]);
    }
  }
  return 0;
}

/**
 * `skills` jsonb is either an object map (skill → count) or an array of names /
 * `{name|skill, count}` entries. Coerce both into a name → count map.
 */
function skillCounts(value: unknown): Map<string, number> {
  const out = new Map<string, number>();
  const add = (name: unknown, count: number) => {
    if (typeof name !== "string" || !name) return;
    out.set(name, (out.get(name) ?? 0) + (Number.isFinite(count) ? count : 0));
  };
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === "string") add(entry, 1);
      else if (entry && typeof entry === "object") {
        const rec = entry as Record<string, unknown>;
        const name = rec.name ?? rec.skill;
        add(name, num(rec.count ?? rec.calls ?? rec.invocations ?? 1) || 1);
      }
    }
  } else if (value && typeof value === "object") {
    for (const [name, count] of Object.entries(value as Record<string, unknown>)) {
      add(name, num(count));
    }
  }
  return out;
}

/**
 * Fold a set of snapshot rows into the panel's shape, zero-filling `daily`
 * across `dayKeys` and taking the top-N models/skills. Pure — exported so the
 * aggregation is unit-testable without a DB.
 */
export function aggregateSnapshots(
  rows: SnapshotRow[],
  dayKeys: string[],
  instanceCount: number,
  now: Date,
  hivra: HivraActivity = emptyHivraActivity(dayKeys, now)
): AgentActivity {
  const totals = emptyTotals();
  const byDay = new Map<string, AgentActivityDailyPoint>(
    dayKeys.map((date) => [date, { date, totalTokens: 0, estimatedCostUsd: 0, sessions: 0 }])
  );
  const modelTotals = new Map<string, number>();
  const skillTotals = new Map<string, number>();
  const activeDayKeys = new Set<string>();

  for (const row of rows) {
    const inputTokens = num(row.input_tokens);
    const outputTokens = num(row.output_tokens);
    const totalTokens = num(row.total_tokens);
    const cacheReadTokens = num(row.cache_read_tokens);
    const reasoningTokens = num(row.reasoning_tokens);
    const cost = num(row.estimated_cost_usd);
    const sessions = num(row.sessions);
    const apiCalls = num(row.api_calls);
    const toolCalls = num(row.tool_calls);

    totals.inputTokens += inputTokens;
    totals.outputTokens += outputTokens;
    totals.totalTokens += totalTokens;
    totals.cacheReadTokens += cacheReadTokens;
    totals.reasoningTokens += reasoningTokens;
    totals.estimatedCostUsd += cost;
    totals.sessions += sessions;
    totals.apiCalls += apiCalls;
    totals.toolCalls += toolCalls;

    const dayKey = utcDayKey(row.stat_date);
    activeDayKeys.add(dayKey);
    const point = byDay.get(dayKey);
    if (point) {
      point.totalTokens += totalTokens;
      point.estimatedCostUsd += cost;
      point.sessions += sessions;
    }

    if (row.by_model && typeof row.by_model === "object") {
      for (const [model, raw] of Object.entries(row.by_model as Record<string, unknown>)) {
        if (!model) continue;
        modelTotals.set(model, (modelTotals.get(model) ?? 0) + modelTokens(raw));
      }
    }
    for (const [skill, count] of skillCounts(row.skills)) {
      skillTotals.set(skill, (skillTotals.get(skill) ?? 0) + count);
    }
  }

  const topModels: AgentActivityModel[] = [...modelTotals.entries()]
    .map(([model, totalTokens]) => ({ model, totalTokens }))
    .filter((m) => m.totalTokens > 0)
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, TOP_N);

  const topSkills: AgentActivitySkill[] = [...skillTotals.entries()]
    .map(([skill, count]) => ({ skill, count }))
    .filter((s) => s.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_N);

  return {
    totals,
    daily: dayKeys.map((d) => byDay.get(d)!),
    topModels,
    topSkills,
    instanceCount,
    activeDays: activeDayKeys.size,
    hivra,
    coverage: coverageOf(totals, hivra),
    generatedAt: now.toISOString(),
  };
}

/**
 * Which claim the payload supports. Metered usage wins when present (it is the
 * richer signal); otherwise RECORDED activity; otherwise nothing.
 *
 * 'activity' means something was actually observed — deliberately NOT "the user
 * has boxes". A fleet that has never reported an event has no recorded activity,
 * and collapsing that into 'activity' would tell a brand-new user we can see
 * their agents working when we have seen nothing. The client renders that case
 * as its own "you have N agents but nothing recorded yet" state, keyed off
 * `hivra.fleet.totalAgents`, which is where fleet presence belongs.
 *
 * Keep the totals terms in lockstep with AgentActivityPanel's `hasUsage`.
 */
function coverageOf(
  totals: AgentActivityTotals,
  hivra: HivraActivity
): AgentActivityCoverage {
  if (
    totals.totalTokens > 0 ||
    totals.sessions > 0 ||
    totals.apiCalls > 0 ||
    totals.toolCalls > 0 ||
    totals.estimatedCostUsd > 0
  ) {
    return "usage";
  }
  if (hivra.eventCount > 0 || hivra.desktopSessions > 0) {
    return "activity";
  }
  return "none";
}

/** Both lanes empty — the truthfully-blank payload. */
export function emptyAgentActivity(days: number, now: Date): AgentActivity {
  return aggregateSnapshots([], lastNDayKeys(clampDays(days), now), 0, now);
}

// ---------- queries ----------

type AdminClient = NonNullable<typeof supabaseAdmin>;

interface QueryError {
  message?: string | null;
  code?: string | null;
}

type PageResult<T> = { data: T[] | null; error: QueryError | null };

async function fetchAllPages<T>(
  label: string,
  page: (from: number, to: number) => PromiseLike<PageResult<T>>
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) {
      throw new Error(`${label}: ${error.message || error.code || "query failed"}`);
    }
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return rows;
  }
}

/** This user's non-deleted Hermes instance ids. */
async function fetchUserInstanceIds(client: AdminClient, userId: string): Promise<string[]> {
  const rows = await fetchAllPages<{ id: string }>("agent-activity instances", (from, to) =>
    client
      .from("hermes_instances")
      .select("id")
      .eq("user_id", userId)
      .is("deleted_at", null)
      .order("id")
      .range(from, to)
  );
  return rows.map((r) => r.id).filter((id): id is string => !!id);
}

async function fetchSnapshots(
  client: AdminClient,
  instanceIds: string[],
  windowStartDay: string
): Promise<SnapshotRow[]> {
  const rows: SnapshotRow[] = [];
  for (const ids of chunk(instanceIds, IN_CHUNK_SIZE)) {
    rows.push(
      ...(await fetchAllPages<SnapshotRow>(
        "agent-activity snapshots",
        (from, to) =>
          client
            .from("instance_usage_snapshots")
            .select(SNAPSHOT_COLUMNS)
            .in("instance_id", ids)
            .gte("stat_date", windowStartDay)
            .order("stat_date")
            .range(from, to) as unknown as PromiseLike<PageResult<SnapshotRow>>
      ))
    );
  }
  return rows;
}

// ---------- entry point ----------

/**
 * Per-user agent activity over the last `opts.days` (default 30, clamped to
 * 1..90). Returns totals, a zero-filled daily series, top models, top skills,
 * the instance count considered, and the number of active days. Never throws —
 * a missing admin client or a query failure returns a zeroed object.
 */
export async function getUserAgentActivity(
  userId: string,
  opts: { days?: number } = {},
  now = new Date()
): Promise<AgentActivity> {
  const days = clampDays(opts.days);
  const dayKeys = lastNDayKeys(days, now);
  const windowStartDay = dayKeys[0];

  // A user with no id, the local self-host operator, and a missing admin client
  // all resolve to a truthfully-empty payload on BOTH lanes. The self-host
  // sentinel is not a hosted Clerk/Supabase UUID: querying the hosted UUID
  // column with it turns a healthy empty install into a PostgREST error.
  if (!userId || !userId.trim() || userId === SELF_HOST_USER_ID) {
    return emptyAgentActivity(days, now);
  }
  if (!supabaseAdmin) {
    log.warn("agent-activity: supabaseAdmin is null (env vars missing)", {
      source: "billing.agent-activity",
    });
    return emptyAgentActivity(days, now);
  }
  const client = supabaseAdmin;

  // The two lanes are read independently so neither can take the other down:
  // a Hermes query failure degrades only the usage half, and a Hivra failure is
  // confined to `hivra.degraded` by getUserHivraActivity's own try/catch.
  const hivra = await getUserHivraActivity(userId, dayKeys, now);

  try {
    const instanceIds = await fetchUserInstanceIds(client, userId);
    // Deliberately NOT short-circuiting on zero instances: a customer whose
    // fleet is entirely Hivra boxes has no rows here, and returning early would
    // skip the Hivra half that actually holds their activity.
    const rows =
      instanceIds.length > 0 ? await fetchSnapshots(client, instanceIds, windowStartDay) : [];
    return aggregateSnapshots(rows, dayKeys, instanceIds.length, now, hivra);
  } catch (error) {
    log.error(
      "agent-activity: query failed",
      error instanceof Error ? error : new Error(String(error)),
      { source: "billing.agent-activity", userId }
    );
    // Flag the zeroed payload as a fallback so the caller can surface a retry
    // affordance instead of the identical "no usage yet" empty state. The Hivra
    // half is preserved — this failure is the Hermes lane's alone — and coverage
    // is recomputed against it, or the payload would claim 'none' while still
    // carrying renderable activity.
    const fallback = emptyAgentActivity(days, now);
    return {
      ...fallback,
      hivra,
      coverage: hivra.eventCount > 0 || hivra.desktopSessions > 0 ? "activity" : fallback.coverage,
      degraded: true,
    };
  }
}
