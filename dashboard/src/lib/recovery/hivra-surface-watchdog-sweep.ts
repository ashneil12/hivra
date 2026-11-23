/**
 * Relay box-side surface watchdog receipts to ops_events.
 *
 * Blind spot this closes: a wedged agent surface can sit for hours with the
 * box itself answering health checks — the wedge this was written for left an
 * Agent Zero box proxied-502 from ~13:12 to 17:27 UTC with zero ops signal,
 * and it recovered only because the owner clicked Restart. The box-side
 * watchdog (hivra-surface-watchdog.py, installed by provisioning and shipped
 * to existing boxes by the managed runtime update) probes the real user path
 * through the box's own gateway and restarts the owning unit under bounds; it
 * records what it did in receipts the gateway serves at
 * GET /api/surface-watchdog. This sweep reads those receipts — the same
 * origin-validated, bearer-authenticated, SSRF-safe path as the other box
 * reads — and turns each event into an ops_events row.
 *
 * The box-side events cover the incident's second silence too: a unit failing
 * or crash-looping (e.g. bux-browser-keeper.service restarting thousands of
 * times) emits `unit_failing` once per cooldown instead of failing forever
 * without a signal.
 *
 * Dedup: each box event carries a unique id that lands in its ops row's title
 * (`...[<event id>]`) and metadata.event_id. Before relaying a box's events
 * the sweep batch-looks-up which of those titles already have an ops_events
 * row and relays only the new ones — a re-read of the receipt list must not
 * touch last_seen_at or occurrence_count (re-reads used to make an old outage
 * look current, with counts in the hundreds). The batch lookup is only the
 * fast path: correctness rests on the write itself — each relay goes through
 * an INSERT keyed on the event's fingerprint (reportOpsEventOnce), which the
 * unique constraint resolves atomically, so two overlapping sweeps that both
 * read "not stored" cannot have the second one's write land on the dedupe
 * UPDATE branch and bump the row the first just inserted.
 */

import { log } from "@/lib/logger";
import { reportOpsEventOnce, type OpsEventInput } from "@/lib/ops-events";
import { supabaseAdmin } from "@/lib/supabase";
import {
  readSurfaceWatchdogFromBox,
  type SurfaceWatchdogEvent,
  type SurfaceWatchdogReading,
} from "@/lib/hivra/agent-cli-meta";

const SOURCE = "hivra-surface-watchdog-sweep";

// Events the box emits, their ops severity, and how to phrase them.
const EVENT_SEVERITY: Record<string, OpsEventInput["severity"]> = {
  gateway_down: "warn",
  gateway_recovered: "info",
  unit_restart: "warn",
  recovered: "info",
  recovery_exhausted: "error",
  unit_failing: "warn",
  watchdog_error: "warn",
};

const READ_CONCURRENCY = 8;
// Per-run caps: receipts are relayed, not acted on, so a backlog drains across
// sweeps instead of bursting ops writes.
const MAX_RELAY_PER_BOX = 10;
// Wall-clock guard: reads are bounded per box but a fleet of unreachable
// origins must not ride into the function ceiling.
const SOFT_BUDGET_MS = 4 * 60 * 1000;
const MAX_CANDIDATES = 500;

interface WatchdogCandidateRow {
  id: string;
  user_id: string;
  type: string | null;
  chat_url: string | null;
  cf_hostname: string | null;
  api_token: string | null;
}

export interface SurfaceWatchdogSweepSummary {
  scanned: number;
  reported: number;
  notInstalled: number;
  unreachable: number;
  notReached: number;
  relayed: number;
  failed: number;
}

function emptySummary(): SurfaceWatchdogSweepSummary {
  return { scanned: 0, reported: 0, notInstalled: 0, unreachable: 0, notReached: 0, relayed: 0, failed: 0 };
}

/**
 * The ops row for one box event. The event id goes in the title so every box
 * event is a distinct fingerprint — a repeat read of the same event dedupes to
 * an occurrence count instead of a duplicate row.
 */
export function opsEventForWatchdogEvent(row: { id: string; user_id: string; type: string | null }, event: SurfaceWatchdogEvent): OpsEventInput {
  const unit = event.unit ?? event.kind ?? "surface";
  const source = `box.surface_watchdog.${event.type}`;
  const severity = EVENT_SEVERITY[event.type] ?? "warn";
  const detail = [
    event.type === "unit_restart" ? `restarted ${unit} (attempt ${event.attempt ?? "?"})` : null,
    event.type === "recovered" ? `${unit} serving again` : null,
    event.type === "recovery_exhausted" ? `${unit} still down after ${event.restarts ?? "?"} restart(s)` : null,
    event.type === "unit_failing" ? `${unit} ${event.reason ?? "failing"} (NRestarts=${event.nRestarts ?? "?"})` : null,
    event.type === "gateway_down" ? "the box gateway is unreachable from inside the box" : null,
    event.type === "gateway_recovered" ? "the box gateway answers again" : null,
    event.type === "watchdog_error" ? `watchdog cycle error: ${event.reason ?? "unknown"}` : null,
    event.downForS != null ? `down ${event.downForS}s` : null,
    event.reason != null && event.type !== "watchdog_error" && event.type !== "unit_failing" ? `last probe: ${event.reason}` : null,
    event.ok === false ? "restart command failed" : null,
  ].filter(Boolean).join("; ");
  return {
    source,
    severity,
    title: `surface watchdog: ${event.type} ${unit} [${event.id}]`,
    message: `Box-side watchdog on agent ${row.id}${row.type ? ` (${row.type})` : ""}: ${detail || event.type}.`,
    route: "/api/cron/hivra-surface-watchdog",
    userId: row.user_id,
    instanceId: row.id,
    metadata: {
      event_id: event.id,
      event_type: event.type,
      event_at: event.at,
      agent_type: row.type,
      unit: event.unit,
      kind: event.kind,
      reason: event.reason,
      ok: event.ok,
      down_for_s: event.downForS,
      n_restarts: event.nRestarts,
      attempt: event.attempt,
      restarts: event.restarts,
    },
  };
}

async function inPool<T>(items: T[], concurrency: number, work: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await work(item);
  }));
}

type SweepDb = NonNullable<typeof supabaseAdmin>;

/**
 * The subset of `titles` that already have an ops_events row for this
 * instance. Matching on the deterministic title — which embeds the box event
 * id — is equivalent to matching metadata.event_id without a JSON-path
 * filter, and archived rows count as stored (an operator archived them on
 * purpose; the relay must not resurrect them). Returns null when the lookup
 * itself fails so the caller can decide; the sweep treats null as "unknown"
 * and still relays (delivery beats count accuracy for one tick, and the
 * failure is logged loudly).
 */
export async function lookupRelayedWatchdogTitles(
  db: SweepDb,
  instanceId: string,
  titles: string[],
): Promise<Set<string> | null> {
  if (titles.length === 0) return new Set();
  const { data, error } = await db
    .from("ops_events")
    .select("title")
    .eq("instance_id", instanceId)
    .in("title", titles);
  if (error) {
    log.error("surface watchdog relay dedupe lookup failed", error, {
      source: SOURCE,
      failureType: "watchdog_relay_dedupe_lookup_failed",
      instanceId,
    });
    return null;
  }
  return new Set(
    ((data ?? []) as Array<{ title: string | null }>)
      .map((row) => row.title)
      .filter((title): title is string => typeof title === "string"),
  );
}

export interface SurfaceWatchdogSweepOptions {
  now?: () => number;
  read?: typeof readSurfaceWatchdogFromBox;
  /**
   * Insert-only persistence for one relayed receipt: writes the ops row iff
   * its fingerprint is not already stored and reports whether THIS call
   * wrote it — the atomic guard two overlapping sweeps need.
   */
  insertOnce?: typeof reportOpsEventOnce;
  /** Test hook: which of a box's event titles are already stored. Defaults to a real ops_events lookup. */
  lookupRelayedTitles?: (instanceId: string, titles: string[]) => Promise<Set<string>>;
}

export async function runSurfaceWatchdogSweep(options: SurfaceWatchdogSweepOptions = {}): Promise<SurfaceWatchdogSweepSummary> {
  const db = supabaseAdmin;
  if (!db) {
    log.error("supabaseAdmin not configured; skipping surface watchdog sweep", new Error("supabaseAdmin missing"), {
      source: SOURCE, failureType: "supabase_admin_unavailable",
    });
    return emptySummary();
  }

  const now = options.now ?? Date.now;
  const read = options.read ?? readSurfaceWatchdogFromBox;
  const insertOnce = options.insertOnce ?? reportOpsEventOnce;
  const lookupRelayedTitles =
    options.lookupRelayedTitles ??
    ((instanceId: string, titles: string[]) =>
      lookupRelayedWatchdogTitles(db, instanceId, titles).then((found) => found ?? new Set<string>()));
  const summary = emptySummary();

  const { data, error } = await db
    .from("hivra_agents")
    .select("id, user_id, type, chat_url, cf_hostname, api_token")
    .eq("status", "running")
    // A sleeping computer cannot answer; "unreachable" would be a false alarm.
    .eq("sleep_state", "awake")
    .not("chat_url", "is", null)
    .not("api_token", "is", null)
    .order("id", { ascending: true })
    .limit(MAX_CANDIDATES);

  if (error) {
    log.error("surface watchdog candidate query failed", error, {
      source: SOURCE, failureType: "watchdog_candidates_unreadable",
    });
    summary.failed += 1;
    return summary;
  }

  const rows = ((data as WatchdogCandidateRow[] | null) ?? [])
    .filter((row) => typeof row.id === "string" && typeof row.user_id === "string");
  summary.scanned = rows.length;
  const started = now();

  await inPool(rows, READ_CONCURRENCY, async (row) => {
    if (now() - started > SOFT_BUDGET_MS) {
      summary.notReached += 1;
      return;
    }
    let reading: SurfaceWatchdogReading;
    try {
      reading = await read({ chatUrl: row.chat_url, cfHostname: row.cf_hostname, apiToken: row.api_token });
    } catch (error) {
      summary.failed += 1;
      log.error("surface watchdog read threw", error, {
        source: SOURCE, failureType: "watchdog_read_threw", instanceId: row.id, userId: row.user_id,
      });
      return;
    }
    if (reading.observation === "not_installed") {
      // Boxes provisioned before the watchdog get it on their next managed
      // runtime update; nothing to page about meanwhile.
      summary.notInstalled += 1;
      return;
    }
    if (reading.observation === "unreachable") {
      // The health-probe recovery crons own "the box cannot be reached".
      summary.unreachable += 1;
      return;
    }
    summary.reported += 1;
    // Newest-cap keeps a long-unswept box from bursting ops rows; the rest
    // stay in the box's events file and dedupe when they surface later.
    const pending = reading.report.events.slice(-MAX_RELAY_PER_BOX).map((event) =>
      opsEventForWatchdogEvent(row, event),
    );
    // One batch lookup per box: events whose ops row already exists are skipped
    // entirely so a re-read never bumps last_seen_at / occurrence_count.
    const alreadyRelayed = await lookupRelayedTitles(
      row.id,
      pending.map((ops) => ops.title),
    );
    for (const ops of pending) {
      if (alreadyRelayed.has(ops.title)) continue;
      try {
        const inserted = await insertOnce(ops);
        if (inserted == null) {
          // reportOpsEventOnce answers null when the write itself failed — a
          // receipt that never persisted is a failed relay, not a relayed
          // one, or the route heartbeat reads clean while receipts drop.
          summary.failed += 1;
          log.error("surface watchdog event relay did not persist", new Error("reportOpsEventOnce returned null"), {
            source: SOURCE, failureType: "watchdog_event_relay_unpersisted", instanceId: row.id, userId: row.user_id,
          });
          continue;
        }
        if (!inserted.inserted) {
          // A fingerprint conflict resolved to "already stored" — a racing
          // sweep relayed this receipt between our lookup and our insert.
          // That is the dedupe WINNING, not a failure: nothing was bumped
          // or reopened, and the receipt needs no write from us.
          continue;
        }
        summary.relayed += 1;
      } catch (error) {
        summary.failed += 1;
        log.error("surface watchdog event relay failed", error, {
          source: SOURCE, failureType: "watchdog_event_relay_failed", instanceId: row.id, userId: row.user_id,
        });
      }
    }
  });

  if (summary.relayed > 0 || summary.failed > 0) {
    log.info("surface watchdog sweep complete", { source: SOURCE, ...summary });
  }
  return summary;
}
