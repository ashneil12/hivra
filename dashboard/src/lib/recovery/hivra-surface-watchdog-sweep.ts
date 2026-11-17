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
 * Dedup is free: each box event carries a unique id, so an event's ops row has
 * a unique fingerprint and re-reads of it only bump occurrence_count.
 */

import { log } from "@/lib/logger";
import { reportOpsEvent, type OpsEventInput } from "@/lib/ops-events";
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

export interface SurfaceWatchdogSweepOptions {
  now?: () => number;
  read?: typeof readSurfaceWatchdogFromBox;
  report?: typeof reportOpsEvent;
}

export async function runSurfaceWatchdogSweep(options: SurfaceWatchdogSweepOptions = {}): Promise<SurfaceWatchdogSweepSummary> {
  const now = options.now ?? Date.now;
  const read = options.read ?? readSurfaceWatchdogFromBox;
  const report = options.report ?? reportOpsEvent;
  const summary = emptySummary();
  const db = supabaseAdmin;
  if (!db) {
    log.error("supabaseAdmin not configured; skipping surface watchdog sweep", new Error("supabaseAdmin missing"), {
      source: SOURCE, failureType: "supabase_admin_unavailable",
    });
    return summary;
  }

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
    for (const event of reading.report.events.slice(-MAX_RELAY_PER_BOX)) {
      try {
        await report(opsEventForWatchdogEvent(row, event));
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
