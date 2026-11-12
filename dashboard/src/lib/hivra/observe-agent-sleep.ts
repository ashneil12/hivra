import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";
import {
  decideSleep,
  parseSleepMode,
  type AgentSleepPolicy,
  type SleepMode,
  type SleepSignals,
  type SleepVerdict,
} from "@/lib/hivra/agent-sleep-policy";

/**
 * Observe-only sleep log (Step 1 of the agent sleep/wake design).
 *
 * Every run, for each running Hivra-managed agent, works out what the sleep
 * policy WOULD decide and records it. It never contacts a host and never changes
 * a VM or an agent; the only writes are rows in hivra_agent_sleep_observations.
 *
 * Signals come only from data already in the database. Anything the database
 * cannot tell us (open connections, active runs, terminals, CPU, schedules,
 * channel sockets) stays unknown, so every verdict is `awake` and the reasons
 * list which signals were missing. That is the point: the log shows how much we
 * would still need to measure before any agent could be put to sleep.
 *
 * With HIVRA_SLEEP_MODE unset or `off` this does nothing at all, not even a read.
 */

const LOG_SOURCE = "observe-agent-sleep";

export const OBSERVE_PAGE_SIZE = 200;
export const OBSERVE_MAX_AGENTS = 2000;
export const OBSERVATION_RETENTION_DAYS = 30;
const PRUNE_BATCH = 1000;
const PRUNE_MAX_BATCHES = 5;
/** Events older than this are not read; an agent with none is "idle at least this long". */
const EVENT_LOOKBACK_MS = 6 * 60 * 60 * 1000;
/**
 * Rows per events request. PostgREST caps every response at max_rows (1000 in
 * supabase/config.toml, the hosted default), so a larger limit would be cut
 * silently. Keep this at or below that cap and page with .range().
 */
export const EVENT_PAGE_SIZE = 1000;
/** Most event pages read per agent page; past this the read counts as truncated. */
export const EVENT_MAX_PAGES = 10;
/** A desktop session that expired this recently still counts as attached. */
const DESKTOP_GRACE_MS = 10 * 60 * 1000;

interface AgentRow {
  id: string;
  type: string;
  operation_id: string | null;
  created_at: string | null;
  always_on: boolean | null;
  sleep_policy: string | null;
}

export interface ObserveAgentSleepSummary {
  mode: SleepMode;
  skipped: boolean;
  reason?: string;
  scanned: number;
  inserted: number;
  pruned: number;
  truncated: boolean;
  verdicts: Record<SleepVerdict, number>;
  errors: number;
}

function emptySummary(mode: SleepMode): ObserveAgentSleepSummary {
  return {
    mode,
    skipped: false,
    scanned: 0,
    inserted: 0,
    pruned: 0,
    truncated: false,
    verdicts: { awake: 0, would_nap: 0, would_hibernate: 0, ineligible: 0 },
    errors: 0,
  };
}

function isAgentSleepPolicy(value: string | null): value is AgentSleepPolicy {
  return value === "off" || value === "t1" || value === "t3" || value === "full";
}

function parseMs(value: string | null | undefined): number | null {
  const ms = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? ms : null;
}

export async function runObserveAgentSleepSweep(
  options: { env?: Record<string, string | undefined>; now?: number } = {},
): Promise<ObserveAgentSleepSummary> {
  const mode = parseSleepMode((options.env ?? process.env).HIVRA_SLEEP_MODE);
  if (mode === "off") return { ...emptySummary(mode), skipped: true, reason: "sleep_mode_off" };

  const summary = emptySummary(mode);
  const db = supabaseAdmin;
  if (!db) {
    log.error("supabase admin client unavailable; cannot observe agent sleep", new Error("supabaseAdmin missing"), {
      source: LOG_SOURCE,
      failureType: "supabase_admin_unavailable",
    });
    return { ...summary, skipped: true, reason: "supabase_unavailable", errors: 1 };
  }

  const nowMs = options.now ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const eventSinceMs = nowMs - EVENT_LOOKBACK_MS;
  const fail = (message: string, error: unknown, failureType: string) => {
    summary.errors += 1;
    log.error(message, error instanceof Error ? error : new Error(JSON.stringify(error)), {
      source: LOG_SOURCE,
      failureType,
    });
  };

  let cursor: string | null = null;
  while (summary.scanned < OBSERVE_MAX_AGENTS) {
    let query = db
      .from("hivra_agents")
      .select("id, type, operation_id, created_at, always_on, sleep_policy")
      .eq("status", "running")
      .eq("deployment_mode", "hivra-managed")
      .is("deployment_target_id", null)
      .order("id", { ascending: true })
      .limit(Math.min(OBSERVE_PAGE_SIZE, OBSERVE_MAX_AGENTS - summary.scanned));
    if (cursor) query = query.gt("id", cursor);
    const { data, error } = await query;
    if (error) {
      fail("failed to load agents for sleep observation", error, "observe_agents_query_failed");
      return summary;
    }
    const agents = (data ?? []) as AgentRow[];
    if (agents.length === 0) break;
    cursor = agents[agents.length - 1].id;
    summary.scanned += agents.length;

    const ids = agents.map((agent) => agent.id);
    const lastEventAt = new Map<string, number>();
    let eventsKnown = true;
    let eventsComplete = false;
    {
      const sinceIso = new Date(eventSinceMs).toISOString();
      for (let eventPage = 0; eventPage < EVENT_MAX_PAGES; eventPage += 1) {
        const from = eventPage * EVENT_PAGE_SIZE;
        const { data: events, error: eventsError } = await db
          .from("hivra_agent_events")
          .select("agent_id, created_at")
          .in("agent_id", ids)
          .gte("created_at", sinceIso)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .range(from, from + EVENT_PAGE_SIZE - 1);
        if (eventsError) {
          eventsKnown = false;
          fail("failed to read agent events for sleep observation", eventsError, "observe_events_query_failed");
          break;
        }
        const rows = (events ?? []) as Array<{ agent_id: string | null; created_at: string }>;
        // Newest first, so the first row seen for an agent is its latest event.
        for (const row of rows) {
          const at = parseMs(row.created_at);
          if (row.agent_id && at !== null && !lastEventAt.has(row.agent_id)) lastEventAt.set(row.agent_id, at);
        }
        // A short page means we have read everything; every agent seen means nothing older can matter.
        if (rows.length < EVENT_PAGE_SIZE || lastEventAt.size >= ids.length) {
          eventsComplete = true;
          break;
        }
      }
      if (eventsKnown && !eventsComplete) {
        summary.truncated = true;
        log.warn("agent events read was truncated; agents without an event are treated as unknown", {
          source: LOG_SOURCE,
          failureType: "observe_events_truncated",
          pages: EVENT_MAX_PAGES,
        });
      }
    }

    const attachedDesktops = new Set<string>();
    let desktopsKnown = true;
    {
      const { data: sessions, error: sessionsError } = await db
        .from("hivra_remote_desktop_sessions")
        .select("computer_id")
        .eq("computer_kind", "hivra-agent")
        .in("computer_id", ids)
        .is("revoked_at", null)
        .gte("expires_at", new Date(nowMs - DESKTOP_GRACE_MS).toISOString());
      if (sessionsError) {
        desktopsKnown = false;
        fail("failed to read desktop sessions for sleep observation", sessionsError, "observe_desktops_query_failed");
      } else {
        for (const row of (sessions ?? []) as Array<{ computer_id: string }>) attachedDesktops.add(row.computer_id);
      }
    }

    const rows = agents.map((agent) => {
      const createdMs = parseMs(agent.created_at);
      const signals: SleepSignals = {
        agentType: agent.type,
        sampledAt: nowMs,
        operationInFlight: agent.operation_id !== null,
        desktopAttached: desktopsKnown ? attachedDesktops.has(agent.id) : undefined,
      };
      if (eventsKnown) {
        const lastEvent = lastEventAt.get(agent.id);
        if (lastEvent !== undefined) {
          // Never earlier than the agent's own birth.
          signals.lastActivityAt = Math.max(lastEvent, createdMs ?? 0);
        } else if (eventsComplete) {
          // Nothing in the whole lookback window: idle at least that long, or since birth.
          signals.lastActivityAt = Math.max(eventSinceMs, createdMs ?? 0);
        }
        // Truncated read and no event seen: leave lastActivityAt unknown (fail toward awake).
      }
      // Observe what the policy would do if the owner had opted in; a per-agent
      // `off` would otherwise hide everything. always_on is still respected.
      const stored = isAgentSleepPolicy(agent.sleep_policy) ? agent.sleep_policy : "off";
      const decision = decideSleep(
        signals,
        { sleepPolicy: stored === "off" ? "full" : stored, alwaysOn: agent.always_on === true },
        nowMs,
      );
      summary.verdicts[decision.verdict] += 1;
      return {
        agent_id: agent.id,
        observed_at: nowIso,
        mode,
        verdict: decision.verdict,
        reasons: decision.reasons,
        idle_seconds: decision.idleSeconds,
        agent_type: agent.type,
      };
    });

    const { error: insertError } = await db.from("hivra_agent_sleep_observations").insert(rows);
    if (insertError) fail("failed to record sleep observations", insertError, "observe_insert_failed");
    else summary.inserted += rows.length;

    if (agents.length < OBSERVE_PAGE_SIZE) break;
  }

  summary.truncated = summary.truncated || summary.scanned >= OBSERVE_MAX_AGENTS;
  summary.pruned = await pruneOldObservations(db, nowMs, fail);
  return summary;
}

async function pruneOldObservations(
  db: NonNullable<typeof supabaseAdmin>,
  nowMs: number,
  fail: (message: string, error: unknown, failureType: string) => void,
): Promise<number> {
  const cutoff = new Date(nowMs - OBSERVATION_RETENTION_DAYS * 86_400_000).toISOString();
  let pruned = 0;
  for (let batch = 0; batch < PRUNE_MAX_BATCHES; batch += 1) {
    const { data, error } = await db
      .from("hivra_agent_sleep_observations")
      .select("id")
      .lt("observed_at", cutoff)
      .order("observed_at", { ascending: true })
      .limit(PRUNE_BATCH);
    if (error) {
      fail("failed to find old sleep observations", error, "observe_prune_select_failed");
      break;
    }
    const ids = ((data ?? []) as Array<{ id: number }>).map((row) => row.id);
    if (ids.length === 0) break;
    const { error: deleteError } = await db.from("hivra_agent_sleep_observations").delete().in("id", ids);
    if (deleteError) {
      fail("failed to prune old sleep observations", deleteError, "observe_prune_delete_failed");
      break;
    }
    pruned += ids.length;
    if (ids.length < PRUNE_BATCH) break;
  }
  return pruned;
}
