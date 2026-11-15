import "server-only";

// Samples how much each running agent is being used, from what its computer's
// connection service already reports (lib/hivra/agent-cli-meta.ts): when the
// agent's app was last used through it, how many of its connections are open,
// whether a reply is being written and whether a terminal is attached. Counts
// and times only, never content.
//
// It fills public.hivra_agent_activity (the latest reading per agent) and
// public.hivra_agent_activity_hours (readings and in-use readings per hour),
// which the usage report counts as active hours. It measures; it never bills,
// pays, stops or changes an agent.
//
// Ships dark: nothing is read unless HIVRA_AGENT_ACTIVITY_SAMPLING=1.

import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";
import { readAgentActivityFromBox, type AgentActivityReading } from "./agent-cli-meta";
import { agentSoftwareSubject } from "./agent-cli-status";

const SOURCE = "cron/sample-agent-activity";
const PAGE = 1000;
const MAX_PAGES = 20;
const READ_CONCURRENCY = 12;
/** The cron function's limit: maxDuration in app/api/cron/sample-agent-activity. */
export const ACTIVITY_SAMPLING_FUNCTION_LIMIT_MS = 60_000;
/** No new computer is read after this; the rest are read first next time. */
const READ_BUDGET_MS = 40_000;
/** A use older than this before the previous reading is history, not something this reading found. */
const NEW_USE_WINDOW_MS = 60 * 60 * 1000;
/** How far a computer's clock may run ahead of ours. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export function agentActivitySamplingEnabled(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): boolean {
  return env.HIVRA_AGENT_ACTIVITY_SAMPLING === "1";
}

/** What the previous reading stored, in ms. */
export interface StoredAgentActivity {
  observedAt: number | null;
  bootId: string | null;
  appLastUsedAt: number | null;
  lastReplyAt: number | null;
  lastUsedAt: number | null;
}

export interface InterpretedAgentActivity {
  /** The reading found the agent in use: right now, or since the previous reading. */
  active: boolean;
  /** The last moment Hivra knows the agent was used (ms); null when it never saw a use. */
  lastUsedAt: number | null;
  /** The hours (as their first ms) this reading counts as in use. */
  usedHours: number[];
}

/**
 * Decide what one reading says about use. Pure.
 *
 * In use right now: an open app connection, a reply being written, or an
 * attached terminal. Used since the previous reading: a reply newer than the
 * last one seen, or the app's last-used time moving forward under the same
 * connection service start (its start counts as a use, so the first reading
 * after a start only sets the baseline). A use is placed in the hour it
 * happened in.
 */
export function interpretAgentActivity(previous: StoredAgentActivity | null, reading: AgentActivityReading, nowMs: number): InterpretedAgentActivity {
  const floor = (previous?.observedAt ?? nowMs) - NEW_USE_WINDOW_MS;
  const recent = (at: number | null): at is number => at !== null && at >= floor && at <= nowMs + CLOCK_SKEW_MS;
  const uses: number[] = [];

  const reply = reading.lastReplyActivityAt;
  if (recent(reply) && (previous?.lastReplyAt == null || reply > previous.lastReplyAt)) uses.push(Math.min(reply, nowMs));

  const app = reading.appLastUsedAt;
  const sameStart = previous !== null && previous.bootId !== null && previous.bootId === reading.bootId;
  if (recent(app) && sameStart && previous.appLastUsedAt !== null && app > previous.appLastUsedAt) uses.push(Math.min(app, nowMs));

  const inUseNow = (reading.appOpenConnections ?? 0) > 0 || (reading.runningReplies ?? 0) > 0 || reading.terminalAttached === true;
  if (inUseNow) uses.push(nowMs);

  const usedHours = [...new Set(uses.map((at) => Math.floor(at / HOUR_MS) * HOUR_MS))].sort((a, b) => a - b);
  const lastUsedAt = uses.reduce<number | null>((latest, at) => (latest === null || at > latest ? at : latest), previous?.lastUsedAt ?? null);
  return { active: uses.length > 0, lastUsedAt, usedHours };
}

export interface AgentActivitySamplingSummary {
  enabled: boolean;
  /** Running agents Hivra can read. */
  scanned: number;
  /** Agents whose computer answered. */
  sampled: number;
  /** Of those, how many were in use. */
  active: number;
  unreachable: number;
  /** Agents left for the next run because this one ran out of time. */
  notReached: number;
  /** Readings that could not be stored. */
  failed: number;
}

export interface AgentActivitySamplingOptions {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  now?: () => number;
  read?: typeof readAgentActivityFromBox;
}

type Row = Record<string, unknown>;

interface PagedQuery<T> {
  range(from: number, to: number): PromiseLike<{ data: T[] | null; error: { message?: string } | null }>;
}

async function readAll<T>(build: () => unknown): Promise<T[] | null> {
  const rows: T[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { data, error } = await (build() as PagedQuery<T>).range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) return null;
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < PAGE) return rows;
  }
  return rows;
}

function ms(value: unknown): number | null {
  const at = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? at : null;
}

function iso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

async function inPool<T>(items: T[], concurrency: number, work: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await work(item);
  }));
}

export async function runAgentActivitySampling(options: AgentActivitySamplingOptions = {}): Promise<AgentActivitySamplingSummary> {
  const enabled = agentActivitySamplingEnabled(options.env ?? process.env);
  const now = options.now ?? Date.now;
  const read = options.read ?? readAgentActivityFromBox;
  const started = now();
  const summary: AgentActivitySamplingSummary = { enabled, scanned: 0, sampled: 0, active: 0, unreachable: 0, notReached: 0, failed: 0 };
  if (!enabled) return summary;
  const db = supabaseAdmin;
  if (!db) {
    log.error("supabase admin client unavailable; cannot sample agent activity", new Error("supabaseAdmin missing"), {
      source: SOURCE, failureType: "supabase_admin_unavailable",
    });
    return summary;
  }

  const agents = await readAll<Row>(() => db
    .from("hivra_agents")
    .select("id, user_id, type, chat_url, cf_hostname, api_token, computer_profile, computer_substrate")
    .eq("status", "running")
    // A sleeping computer cannot answer, and a reading of "unreachable" would be a false alarm.
    .eq("sleep_state", "awake")
    .is("computer_profile", null)
    .not("chat_url", "is", null)
    .order("id", { ascending: true }));
  if (!agents) {
    log.error("failed to load agents to sample", new Error("hivra_agents unreadable"), { source: SOURCE, failureType: "agent_activity_candidates_unreadable" });
    return summary;
  }
  const candidates = agents.flatMap((row) => {
    const subject = agentSoftwareSubject(row);
    return subject && typeof row.id === "string" && typeof row.user_id === "string" ? [{ row, subject, id: row.id, userId: row.user_id }] : [];
  });
  summary.scanned = candidates.length;
  if (candidates.length === 0) return summary;

  // The comparison with the previous reading is the whole measurement, so no
  // agent is read when the previous readings can't be.
  const stored = await readAll<Row>(() => db
    .from("hivra_agent_activity")
    .select("agent_id, observed_at, boot_id, app_last_used_at, last_reply_at, last_used_at")
    .order("agent_id", { ascending: true }));
  if (!stored) {
    log.error("previous agent activity unreadable; no agent read this run", new Error("hivra_agent_activity unreadable"), {
      source: SOURCE, failureType: "agent_activity_unreadable", candidates: candidates.length,
    });
    return summary;
  }
  const previousById = new Map<string, StoredAgentActivity>();
  for (const row of stored) {
    if (typeof row.agent_id !== "string") continue;
    previousById.set(row.agent_id, {
      observedAt: ms(row.observed_at),
      bootId: typeof row.boot_id === "string" ? row.boot_id : null,
      appLastUsedAt: ms(row.app_last_used_at),
      lastReplyAt: ms(row.last_reply_at),
      lastUsedAt: ms(row.last_used_at),
    });
  }
  // Longest unread first, so a run that runs out of time still reaches everyone in turn.
  candidates.sort((a, b) => (previousById.get(a.id)?.observedAt ?? 0) - (previousById.get(b.id)?.observedAt ?? 0));

  await inPool(candidates, READ_CONCURRENCY, async ({ row, subject, id, userId }) => {
    if (now() - started > READ_BUDGET_MS) {
      summary.notReached += 1;
      return;
    }
    const reading = await read({ chatUrl: row.chat_url, cfHostname: row.cf_hostname, apiToken: row.api_token, subject });
    const observedAt = now();
    const base = { p_agent_id: id, p_user_id: userId, p_agent_type: subject.type, p_observed_at: iso(observedAt) };
    let args: Record<string, unknown>;
    if (!reading) {
      summary.unreachable += 1;
      args = { ...base, p_reachable: false };
    } else {
      const seen = interpretAgentActivity(previousById.get(id) ?? null, reading, observedAt);
      summary.sampled += 1;
      if (seen.active) summary.active += 1;
      args = {
        ...base,
        p_reachable: true,
        p_boot_id: reading.bootId,
        p_app_last_used_at: iso(reading.appLastUsedAt),
        p_last_reply_at: iso(reading.lastReplyActivityAt),
        p_last_used_at: iso(seen.lastUsedAt),
        p_open_connections: reading.appOpenConnections,
        p_active_runs: reading.runningReplies,
        p_terminal_attached: reading.terminalAttached,
        p_used_hours: seen.usedHours.map((hour) => new Date(hour).toISOString()),
      };
    }
    const { error } = await db.rpc("hivra_record_agent_activity", args);
    if (error) {
      summary.failed += 1;
      log.warn("agent activity reading not stored", { source: SOURCE, failureType: "agent_activity_store_failed", agentId: id, detail: error.message });
    }
  });
  return summary;
}
