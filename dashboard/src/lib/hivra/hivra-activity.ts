import "server-only";

import { attachActivityLine } from "@/lib/agent-computers/attach-activity";
import { supabaseAdmin } from "@/lib/supabase";
import { log } from "@/lib/logger";

/**
 * Hivra-lane activity reader for the Activity page.
 *
 * The Activity surface was Hermes-lane-only (see lib/billing/agent-activity.ts):
 * it reads `hermes_instances` + `instance_usage_snapshots`, both of which are
 * empty for a customer whose fleet is Hivra boxes. Meanwhile the Hivra lane
 * records plenty — `hivra_agent_events` is an append-only per-user lifecycle
 * log (indexed on `(user_id, created_at desc)`, deliberately without an FK so a
 * deleted agent's history survives), and `hivra_remote_desktop_sessions`
 * records actual desktop use. Both were read by nothing, so an active Hivra
 * customer's Activity page rendered "No usage yet".
 *
 * This module reads those tables. It deliberately reports ACTIVITY, not usage:
 * Hivra boxes run the customer's own model keys (`managed_venice` is false
 * fleet-wide, `llm_config` null), so no token or cost figure exists for them
 * and none is invented here. See the panel, which must not render a token or
 * dollar card off this data.
 *
 * Never throws on a query failure: the caller isolates the lane and surfaces
 * `degraded` so a telemetry-table hiccup cannot blank the whole page.
 */

const PAGE_SIZE = 1000;
// PostgREST caps un-ranged selects at 1000 rows; a large fleet's window can
// exceed one page. Cap the page count so a runaway window cannot spin forever.
const MAX_PAGES = 20;
// Newest N events kept for the timeline. The full window is still counted.
const RECENT_LIMIT = 25;

export interface HivraActivityEvent {
  id: string;
  event: string;
  agentType: string | null;
  agentId: string | null;
  createdAt: string;
  /** The row's own words, for an agent added to a computer (design 5.7). */
  summary?: string;
}

export interface HivraActivityDailyPoint {
  date: string;
  count: number;
}

export interface HivraFleet {
  /** Boxes in a running state. */
  runningAgents: number;
  /** Non-deleted boxes of any state (running + stopped + error). */
  totalAgents: number;
  /** Earliest box creation, ISO — anchors the "since" copy for a silent fleet. */
  firstAgentAt: string | null;
  /** Raw status → count, so the caller can render "7 running · 3 stopped". */
  byStatus: Record<string, number>;
}

export interface HivraActivity {
  eventCount: number;
  /** Event name → count, descending by count. */
  byEvent: Array<{ event: string; count: number }>;
  /** Agent kind (codex/linux-desktop/…) → event count, descending. */
  byAgentType: Array<{ agentType: string; count: number }>;
  /** Distinct UTC days with an event or a desktop session, across both sources. */
  activeDays: number;
  desktopSessions: number;
  /** Distinct UTC days with a desktop session. */
  desktopDays: number;
  /** Zero-filled over the window, oldest → newest; counts events + sessions. */
  daily: HivraActivityDailyPoint[];
  fleet: HivraFleet;
  /** Newest-first timeline, capped at RECENT_LIMIT. */
  recent: HivraActivityEvent[];
  /** True when the page cap clipped the window (counts are then a floor). */
  truncated: boolean;
  /** Set when the Hivra read failed; the lane is empty and must not be trusted. */
  degraded?: boolean;
}

type AdminClient = NonNullable<typeof supabaseAdmin>;

interface QueryError {
  message?: string | null;
  code?: string | null;
}

type PageResult<T> = { data: T[] | null; error: QueryError | null };

/**
 * Page through a query explicitly. PostgREST silently caps un-ranged selects at
 * 1000 rows, so an un-paged read would undercount a busy fleet's window.
 * `maxPages` is a backstop, not a target — reaching it sets `truncated`.
 */
async function fetchPages<T>(
  page: (from: number, to: number) => PromiseLike<PageResult<T>>,
  maxPages: number
): Promise<{ rows: T[]; truncated: boolean }> {
  const rows: T[] = [];
  for (let i = 0; i < maxPages; i++) {
    const from = i * PAGE_SIZE;
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) {
      throw new Error(error.message || error.code || "hivra activity query failed");
    }
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

/** YYYY-MM-DD in UTC — matches the Hermes lane's day-key convention. */
export function utcDayKey(value: string | Date): string {
  const d = value instanceof Date ? value : new Date(value);
  return d.toISOString().slice(0, 10);
}

/** The last n UTC day keys (oldest → newest), ending on `now`'s UTC day. */
export function lastNDayKeys(n: number, now: Date): string[] {
  const out: string[] = [];
  for (let k = n - 1; k >= 0; k--) {
    out.push(utcDayKey(new Date(now.getTime() - k * 86_400_000)));
  }
  return out;
}

export interface HivraEventRow {
  id?: string | null;
  agent_id?: string | null;
  event?: string | null;
  agent_type?: string | null;
  created_at?: string | null;
  /** Label fields of an attach event's detail, selected by name (never the whole detail). */
  attach_agent?: string | null;
  attach_computer?: string | null;
  attach_access?: string | null;
}

export interface HivraSessionRow {
  id?: string | null;
  created_at?: string | null;
}

export interface HivraFleetRow {
  id?: string | null;
  type?: string | null;
  status?: string | null;
  created_at?: string | null;
}

function emptyFleet(): HivraFleet {
  return { runningAgents: 0, totalAgents: 0, firstAgentAt: null, byStatus: {} };
}

/**
 * Fold the three Hivra reads into the lane's shape. Pure — exported so the
 * aggregation is unit-testable without a DB.
 *
 * Note the event log deliberately outlives the agents it describes (78 of one
 * customer's 89 boxes are deleted but their events survive), so events are NOT
 * joined back to the live fleet and a null/unknown agent_type is kept as-is.
 */
export function aggregateHivraActivity(
  eventRows: HivraEventRow[],
  sessionRows: HivraSessionRow[],
  fleetRows: HivraFleetRow[],
  dayKeys: string[],
  now: Date,
  truncated = false
): HivraActivity {
  const byDay = new Map<string, number>(dayKeys.map((date) => [date, 0]));
  const eventCounts = new Map<string, number>();
  const typeCounts = new Map<string, number>();
  const activeDayKeys = new Set<string>();
  const desktopDayKeys = new Set<string>();

  const events: HivraActivityEvent[] = [];

  for (const row of eventRows) {
    const created = row?.created_at;
    if (!created) continue;
    const dayKey = utcDayKey(created);
    activeDayKeys.add(dayKey);
    // Only days inside the window move the series; the window is already the
    // query bound, so this guards against a boundary row only.
    if (byDay.has(dayKey)) byDay.set(dayKey, (byDay.get(dayKey) ?? 0) + 1);

    const event = typeof row.event === "string" && row.event ? row.event : "unknown";
    eventCounts.set(event, (eventCounts.get(event) ?? 0) + 1);

    const agentType = typeof row.agent_type === "string" && row.agent_type ? row.agent_type : null;
    if (agentType) typeCounts.set(agentType, (typeCounts.get(agentType) ?? 0) + 1);

    if (row.id) {
      const summary = attachActivityLine(event, { agentName: row.attach_agent, computerName: row.attach_computer, access: row.attach_access });
      events.push({ id: row.id, event, agentType, agentId: row.agent_id ?? null, createdAt: created, ...(summary ? { summary } : {}) });
    }
  }

  let desktopSessions = 0;
  for (const row of sessionRows) {
    const created = row?.created_at;
    if (!created) continue;
    desktopSessions++;
    const dayKey = utcDayKey(created);
    desktopDayKeys.add(dayKey);
    activeDayKeys.add(dayKey);
    if (byDay.has(dayKey)) byDay.set(dayKey, (byDay.get(dayKey) ?? 0) + 1);
  }

  const fleet = emptyFleet();
  for (const row of fleetRows) {
    const status = typeof row.status === "string" && row.status ? row.status : "unknown";
    fleet.totalAgents++;
    fleet.byStatus[status] = (fleet.byStatus[status] ?? 0) + 1;
    if (status === "running") fleet.runningAgents++;
    const created = row?.created_at;
    if (created && (fleet.firstAgentAt === null || created < fleet.firstAgentAt)) {
      fleet.firstAgentAt = created;
    }
  }

  const byEvent = [...eventCounts.entries()]
    .map(([event, count]) => ({ event, count }))
    .sort((a, b) => b.count - a.count || a.event.localeCompare(b.event));

  const byAgentType = [...typeCounts.entries()]
    .map(([agentType, count]) => ({ agentType, count }))
    .sort((a, b) => b.count - a.count || a.agentType.localeCompare(b.agentType));

  events.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));

  return {
    eventCount: eventRows.length,
    byEvent,
    byAgentType,
    activeDays: activeDayKeys.size,
    desktopSessions,
    desktopDays: desktopDayKeys.size,
    daily: dayKeys.map((date) => ({ date, count: byDay.get(date) ?? 0 })),
    fleet,
    recent: events.slice(0, RECENT_LIMIT),
    truncated,
  };
}

export function emptyHivraActivity(dayKeys: string[], now: Date): HivraActivity {
  return aggregateHivraActivity([], [], [], dayKeys, now);
}

// Three label fields of an attach event's detail by name, for its row (5.7);
// the rest of detail is never read here.
const EVENT_COLUMNS = "id, agent_id, event, agent_type, created_at, "
  + "attach_agent:detail->>agentName, attach_computer:detail->>computerName, attach_access:detail->>access";
// `computer_kind` is read but never filtered: a desktop session on a
// hermes-instance is still this user's activity and must not be silently dropped.
const SESSION_COLUMNS = "id, computer_kind, created_at";
const FLEET_COLUMNS = "id, type, status, created_at";

/**
 * The user's Hivra-lane activity over `dayKeys`.
 *
 * Three separate reads, each scoped to the caller's own `user_id`:
 *   1. hivra_agent_events — lifecycle events (launch/provision/restart/…)
 *   2. hivra_remote_desktop_sessions — desktop sessions (the use signal)
 *   3. hivra_agents — fleet truth (how many boxes, what state)
 *
 * `detail` is deliberately NOT selected: it carries infrastructure identifiers
 * (vmid, host) that have no business on a customer surface. Only three label
 * fields of attach events are read by name (agent, computer name, access).
 */
export async function fetchHivraActivity(
  client: AdminClient,
  userId: string,
  dayKeys: string[],
  now = new Date()
): Promise<HivraActivity> {
  const windowStartIso = `${dayKeys[0]}T00:00:00.000Z`;

  const [events, sessions, fleet] = await Promise.all([
    fetchPages<HivraEventRow>(
      (from, to) =>
        client
          .from("hivra_agent_events")
          .select(EVENT_COLUMNS)
          .eq("user_id", userId)
          .gte("created_at", windowStartIso)
          // created_at alone is not a total order — ties are possible and an
          // unstable sort can drop or duplicate rows across a page boundary.
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .range(from, to) as unknown as PromiseLike<PageResult<HivraEventRow>>,
      MAX_PAGES
    ),
    fetchPages<HivraSessionRow>(
      (from, to) =>
        client
          .from("hivra_remote_desktop_sessions")
          .select(SESSION_COLUMNS)
          .eq("user_id", userId)
          .gte("created_at", windowStartIso)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .range(from, to) as unknown as PromiseLike<PageResult<HivraSessionRow>>,
      MAX_PAGES
    ),
    fetchPages<HivraFleetRow>(
      (from, to) =>
        client
          .from("hivra_agents")
          .select(FLEET_COLUMNS)
          .eq("user_id", userId)
          .neq("status", "deleted")
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .range(from, to) as unknown as PromiseLike<PageResult<HivraFleetRow>>,
      MAX_PAGES
    ),
  ]);

  const truncated = events.truncated || sessions.truncated || fleet.truncated;
  if (truncated) {
    log.warn("hivra activity window truncated at page cap", {
      source: "hivra.activity",
      userId,
    });
  }

  return aggregateHivraActivity(events.rows, sessions.rows, fleet.rows, dayKeys, now, truncated);
}

/**
 * Lane entry point used by getUserAgentActivity. Never throws: a query failure
 * returns an empty lane flagged `degraded`, so the caller can render the Hermes
 * half and an inline note instead of a whole-page error.
 */
export async function getUserHivraActivity(
  userId: string,
  dayKeys: string[],
  now = new Date()
): Promise<HivraActivity> {
  if (!supabaseAdmin || !userId || !userId.trim()) {
    return emptyHivraActivity(dayKeys, now);
  }
  try {
    return await fetchHivraActivity(supabaseAdmin, userId, dayKeys, now);
  } catch (error) {
    log.error(
      "hivra activity: query failed",
      error instanceof Error ? error : new Error(String(error)),
      { source: "hivra.activity", userId }
    );
    return { ...emptyHivraActivity(dayKeys, now), degraded: true };
  }
}
