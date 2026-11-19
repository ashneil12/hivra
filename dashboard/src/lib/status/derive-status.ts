// Pure derivation of the public component states from rows that already exist
// in the database. No I/O here so the rules are easy to test. Nothing in the
// output carries host names, ids, counts or error text: only names, states and
// times.

export type ComponentState = "operational" | "degraded" | "down" | "unknown";

export type ComponentKey = "website" | "launching" | "ai" | "computers";

export const COMPONENT_NAMES: Record<ComponentKey, string> = {
  website: "Website and dashboard",
  launching: "Launching agents",
  ai: "Hivra AI",
  computers: "Agent computers",
};

export const COMPONENT_ORDER: readonly ComponentKey[] = ["website", "launching", "ai", "computers"];

export interface HeartbeatSignal {
  cron_name: string;
  last_success_at: string | null;
}

export interface OpsEventSignal {
  source: string;
  severity: string;
  last_seen_at: string;
  archived_at?: string | null;
}

export interface HostSignal {
  status: string;
  capacity_reading_at: string | null;
  capacity_reading_level: string | null;
}

export interface CaptureSignal {
  level: "healthy" | "warn" | "critical";
  attempts: number;
  minAttempts: number;
}

export interface IncidentSignal {
  id: string;
  title: string;
  body: string | null;
  component: string | null;
  severity: "degraded" | "down" | "maintenance";
  started_at: string;
  resolved_at: string | null;
}

export interface StatusSignals {
  now: number;
  /** False when the database could not be read at all. */
  databaseReadable: boolean;
  heartbeats: HeartbeatSignal[];
  opsEvents: OpsEventSignal[];
  hosts: HostSignal[];
  /** Managed inference capture check, or null when it could not be read. */
  capture: CaptureSignal | null;
  incidents: IncidentSignal[];
}

const MINUTE = 60_000;

// A heartbeat counts as fresh within 2x its cron period, the same budget the
// dead-man watchdog uses.
export const LAUNCH_HEARTBEATS = [
  { name: "probe-instance-health", budgetMinutes: 10 },
  { name: "recover-unhealthy-active-instances", budgetMinutes: 30 },
] as const;

// Ops event sources that report agent launch failures.
export const LAUNCH_EVENT_SOURCES: readonly string[] = [
  "recover-orphan-provisioning",
  "cron.recover_orphan_provisioning_errors",
  "workspace-cloud-provisioner",
];
const LAUNCH_EVENT_WINDOW_MINUTES = 60;

export const AI_EVENT_SOURCE = "cron/managed-venice-health";
// The monitor reports each problem at most once per ~6h, so an event seen in
// this window may still describe the present.
const AI_EVENT_WINDOW_MINUTES = 7 * 60;

// Placement ignores a capacity reading older than this; so do we.
const HOST_READING_BUDGET_MINUTES = 15;

function ageMinutes(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return null;
  return (now - ms) / MINUTE;
}

const RANK: Record<ComponentState, number> = { operational: 0, unknown: 1, degraded: 2, down: 3 };

export function worseState(a: ComponentState, b: ComponentState): ComponentState {
  return RANK[b] > RANK[a] ? b : a;
}

function recentEvents(events: OpsEventSignal[], sources: readonly string[], windowMin: number, now: number) {
  return events.filter((e) => {
    if (!sources.includes(e.source) || e.archived_at) return false;
    const age = ageMinutes(e.last_seen_at, now);
    return age !== null && age >= -1 && age <= windowMin;
  });
}

function deriveLaunching(s: StatusSignals): ComponentState {
  let stale = 0;
  let missing = 0;
  for (const def of LAUNCH_HEARTBEATS) {
    const row = s.heartbeats.find((h) => h.cron_name === def.name);
    const age = ageMinutes(row?.last_success_at, s.now);
    if (age === null) missing += 1;
    else if (age > def.budgetMinutes) stale += 1;
  }
  let state: ComponentState;
  if (stale === LAUNCH_HEARTBEATS.length) state = "down";
  else if (stale > 0) state = "degraded";
  else if (missing > 0) state = "unknown";
  else state = "operational";

  const events = recentEvents(s.opsEvents, LAUNCH_EVENT_SOURCES, LAUNCH_EVENT_WINDOW_MINUTES, s.now);
  if (events.some((e) => e.severity === "fatal" || e.severity === "error")) {
    state = worseState(state, "degraded");
  }
  return state;
}

function deriveAi(s: StatusSignals): ComponentState {
  const events = recentEvents(s.opsEvents, [AI_EVENT_SOURCE], AI_EVENT_WINDOW_MINUTES, s.now);
  let fromEvents: ComponentState = "unknown";
  if (events.some((e) => e.severity === "fatal")) fromEvents = "down";
  else if (events.some((e) => e.severity === "warn" || e.severity === "error")) fromEvents = "degraded";

  const c = s.capture;
  if (c) {
    if (c.level === "critical") return "down";
    if (c.level === "warn") return worseState("degraded", fromEvents);
    // A healthy reading only counts when there was enough traffic to judge.
    if (c.attempts >= c.minAttempts) return fromEvents === "unknown" ? "operational" : fromEvents;
  }
  return fromEvents;
}

function deriveComputers(s: StatusSignals): ComponentState {
  const active = s.hosts.filter((h) => h.status === "active");
  if (active.length === 0) return "unknown";
  const fresh = active.filter((h) => {
    const age = ageMinutes(h.capacity_reading_at, s.now);
    return age !== null && age <= HOST_READING_BUDGET_MINUTES;
  });
  if (fresh.length === 0) return "unknown";
  const critical = fresh.filter((h) => h.capacity_reading_level === "critical").length;
  if (critical === fresh.length && fresh.length === active.length) return "down";
  if (critical > 0) return "degraded";
  const readable = fresh.every((h) => h.capacity_reading_level === "ok" || h.capacity_reading_level === "warn");
  if (!readable) return "unknown";
  // Some active computers have no fresh reading: we cannot vouch for all of them.
  return fresh.length === active.length ? "operational" : "degraded";
}

export function deriveComponentStates(s: StatusSignals): Record<ComponentKey, ComponentState> {
  const states: Record<ComponentKey, ComponentState> = s.databaseReadable
    ? {
        website: "operational",
        launching: deriveLaunching(s),
        ai: deriveAi(s),
        computers: deriveComputers(s),
      }
    : { website: "degraded", launching: "unknown", ai: "unknown", computers: "unknown" };

  // A published, unresolved incident can only make a component look worse.
  for (const incident of s.incidents) {
    if (incident.resolved_at || incident.severity === "maintenance") continue;
    const key = incident.component as ComponentKey | null;
    if (key && key in states) states[key] = worseState(states[key], incident.severity);
  }
  return states;
}

export function overallHeadline(states: Record<ComponentKey, ComponentState>): {
  state: ComponentState;
  headline: string;
} {
  const all = Object.values(states);
  if (all.includes("down")) return { state: "down", headline: "Some parts of Hivra are down" };
  if (all.includes("degraded")) return { state: "degraded", headline: "Some parts of Hivra are not working as they should" };
  if (all.includes("unknown")) return { state: "unknown", headline: "We cannot confirm every part right now" };
  return { state: "operational", headline: "Everything is working" };
}

export interface PublicStatus {
  generatedAt: string;
  overall: { state: ComponentState; headline: string };
  components: Array<{ key: ComponentKey; name: string; state: ComponentState }>;
  incidents: Array<{
    id: string;
    title: string;
    body: string | null;
    component: string | null;
    severity: IncidentSignal["severity"];
    startedAt: string;
    resolvedAt: string | null;
  }>;
}

const INCIDENT_WINDOW_MS = 30 * 24 * 60 * MINUTE;

export function buildPublicStatus(s: StatusSignals): PublicStatus {
  const states = deriveComponentStates(s);
  const incidents = s.incidents
    .filter((i) => {
      const started = new Date(i.started_at).getTime();
      return Number.isFinite(started) && s.now - started <= INCIDENT_WINDOW_MS;
    })
    .sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime())
    .map((i) => ({
      id: i.id,
      title: i.title,
      body: i.body,
      component: i.component && i.component in COMPONENT_NAMES ? COMPONENT_NAMES[i.component as ComponentKey] : null,
      severity: i.severity,
      startedAt: i.started_at,
      resolvedAt: i.resolved_at,
    }));
  return {
    generatedAt: new Date(s.now).toISOString(),
    overall: overallHeadline(states),
    components: COMPONENT_ORDER.map((key) => ({ key, name: COMPONENT_NAMES[key], state: states[key] })),
    incidents,
  };
}
