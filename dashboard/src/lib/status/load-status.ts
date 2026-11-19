import { supabaseAdmin } from "@/lib/supabase";
import { resolveManagedVeniceHealthConfig, runCaptureDroughtDetector } from "@/lib/ops/managed-venice-health";

import {
  AI_EVENT_SOURCE,
  LAUNCH_EVENT_SOURCES,
  LAUNCH_HEARTBEATS,
  buildPublicStatus,
  type CaptureSignal,
  type HeartbeatSignal,
  type HostSignal,
  type IncidentSignal,
  type OpsEventSignal,
  type PublicStatus,
  type StatusSignals,
} from "./derive-status";

const CACHE_MS = 60_000;
let cached: { at: number; value: PublicStatus } | null = null;

type Row = Record<string, unknown>;

/** Reads the existing signals with the service role and builds the public view. Cached for about a minute. */
export async function loadPublicStatus(now: number = Date.now()): Promise<PublicStatus> {
  if (cached && now >= cached.at && now - cached.at < CACHE_MS) return cached.value;
  const value = await readAndBuild(now);
  cached = { at: now, value };
  return value;
}

async function readAndBuild(now: number): Promise<PublicStatus> {
  const db = supabaseAdmin;
  const empty: StatusSignals = {
    now,
    databaseReadable: false,
    heartbeats: [],
    opsEvents: [],
    hosts: [],
    capture: null,
    incidents: [],
  };
  if (!db) return buildPublicStatus(empty);

  try {
    const since = new Date(now - 30 * 24 * 3_600_000).toISOString();
    const eventSince = new Date(now - 8 * 3_600_000).toISOString();
    const sources = [...LAUNCH_EVENT_SOURCES, AI_EVENT_SOURCE];

    const [hb, ev, hosts, inc] = await Promise.all([
      db
        .from("ops_cron_heartbeats")
        .select("cron_name, last_success_at")
        .in("cron_name", LAUNCH_HEARTBEATS.map((h) => h.name)),
      db
        .from("ops_events")
        .select("source, severity, last_seen_at, archived_at")
        .in("source", sources)
        .gte("last_seen_at", eventSince),
      db.from("proxmox_hosts").select("status, capacity_reading_at, capacity_reading"),
      db
        .from("hivra_status_incidents")
        .select("id, title, body, component, severity, started_at, resolved_at")
        .eq("published", true)
        .gte("started_at", since),
    ]);

    // The heartbeat read is the baseline: if it fails the database is not usable.
    if (hb.error) return buildPublicStatus(empty);

    let capture: CaptureSignal | null = null;
    try {
      const config = resolveManagedVeniceHealthConfig();
      const result = await runCaptureDroughtDetector(db, config, now);
      capture = { level: result.level, attempts: result.attempts, minAttempts: config.minAttempts };
    } catch {
      capture = null;
    }

    return buildPublicStatus({
      now,
      databaseReadable: true,
      heartbeats: (hb.data ?? []) as unknown as HeartbeatSignal[],
      opsEvents: ev.error ? [] : ((ev.data ?? []) as unknown as OpsEventSignal[]),
      hosts: hosts.error
        ? []
        : ((hosts.data ?? []) as Row[]).map(
            (r): HostSignal => ({
              status: String(r.status ?? ""),
              capacity_reading_at: (r.capacity_reading_at as string | null) ?? null,
              capacity_reading_level:
                r.capacity_reading && typeof r.capacity_reading === "object"
                  ? ((r.capacity_reading as { level?: string }).level ?? null)
                  : null,
            }),
          ),
      capture,
      incidents: inc.error ? [] : ((inc.data ?? []) as unknown as IncidentSignal[]),
    });
  } catch {
    return buildPublicStatus(empty);
  }
}
