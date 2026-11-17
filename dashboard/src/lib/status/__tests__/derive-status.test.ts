import {
  buildPublicStatus,
  deriveComponentStates,
  type StatusSignals,
} from "../derive-status";
import { statusPageEnabled } from "../status-switch";

const NOW = Date.parse("2026-11-17T12:00:00Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

function healthy(): StatusSignals {
  return {
    now: NOW,
    databaseReadable: true,
    heartbeats: [
      { cron_name: "probe-instance-health", last_success_at: ago(3) },
      { cron_name: "recover-unhealthy-active-instances", last_success_at: ago(10) },
    ],
    opsEvents: [],
    hosts: [{ status: "active", capacity_reading_at: ago(2), capacity_reading_level: "ok" }],
    capture: { level: "healthy", attempts: 40, minAttempts: 3 },
    incidents: [],
  };
}

describe("deriveComponentStates", () => {
  it("is operational everywhere when every signal is fresh and healthy", () => {
    expect(deriveComponentStates(healthy())).toEqual({
      website: "operational",
      launching: "operational",
      ai: "operational",
      computers: "operational",
    });
  });

  it("reports unknown, not operational, when signals are missing", () => {
    const s = { ...healthy(), heartbeats: [], hosts: [], capture: null };
    const states = deriveComponentStates(s);
    expect(states.launching).toBe("unknown");
    expect(states.ai).toBe("unknown");
    expect(states.computers).toBe("unknown");
  });

  it("reports unknown for computers when readings are stale", () => {
    const s = healthy();
    s.hosts = [{ status: "active", capacity_reading_at: ago(60), capacity_reading_level: "ok" }];
    expect(deriveComponentStates(s).computers).toBe("unknown");
  });

  it("ignores hosts that are not active", () => {
    const s = healthy();
    s.hosts.push({ status: "draining", capacity_reading_at: null, capacity_reading_level: null });
    expect(deriveComponentStates(s).computers).toBe("operational");
  });

  it("degrades computers when one host is critical and down when all are", () => {
    const s = healthy();
    s.hosts = [
      { status: "active", capacity_reading_at: ago(1), capacity_reading_level: "critical" },
      { status: "active", capacity_reading_at: ago(1), capacity_reading_level: "ok" },
    ];
    expect(deriveComponentStates(s).computers).toBe("degraded");
    s.hosts[1].capacity_reading_level = "critical";
    expect(deriveComponentStates(s).computers).toBe("down");
  });

  it("degrades launching when one prober is stale and down when both are", () => {
    const s = healthy();
    s.heartbeats[0].last_success_at = ago(30);
    expect(deriveComponentStates(s).launching).toBe("degraded");
    s.heartbeats[1].last_success_at = ago(120);
    expect(deriveComponentStates(s).launching).toBe("down");
  });

  it("degrades launching on a recent launch failure event", () => {
    const s = healthy();
    s.opsEvents = [{ source: "recover-orphan-provisioning", severity: "fatal", last_seen_at: ago(5) }];
    expect(deriveComponentStates(s).launching).toBe("degraded");
    s.opsEvents[0].archived_at = ago(1);
    expect(deriveComponentStates(s).launching).toBe("operational");
  });

  it("maps the managed inference capture check", () => {
    const s = healthy();
    s.capture = { level: "critical", attempts: 10, minAttempts: 3 };
    expect(deriveComponentStates(s).ai).toBe("down");
    s.capture = { level: "warn", attempts: 10, minAttempts: 3 };
    expect(deriveComponentStates(s).ai).toBe("degraded");
    s.capture = { level: "healthy", attempts: 1, minAttempts: 3 };
    expect(deriveComponentStates(s).ai).toBe("unknown");
  });

  it("uses a recent fatal monitor event for Hivra AI", () => {
    const s = healthy();
    s.capture = null;
    s.opsEvents = [{ source: "cron/managed-venice-health", severity: "fatal", last_seen_at: ago(90) }];
    expect(deriveComponentStates(s).ai).toBe("down");
    s.opsEvents[0].last_seen_at = ago(60 * 12);
    expect(deriveComponentStates(s).ai).toBe("unknown");
  });

  it("says everything but the website is unknown when the database is unreadable", () => {
    const states = deriveComponentStates({ ...healthy(), databaseReadable: false });
    expect(states).toEqual({ website: "degraded", launching: "unknown", ai: "unknown", computers: "unknown" });
  });

  it("lets an open incident worsen a component but not a maintenance note or a resolved one", () => {
    const s = healthy();
    const base = { id: "1", title: "t", body: null, component: "ai", started_at: ago(10), resolved_at: null };
    s.incidents = [{ ...base, severity: "down" }];
    expect(deriveComponentStates(s).ai).toBe("down");
    s.incidents = [{ ...base, severity: "maintenance" }];
    expect(deriveComponentStates(s).ai).toBe("operational");
    s.incidents = [{ ...base, severity: "down", resolved_at: ago(1) }];
    expect(deriveComponentStates(s).ai).toBe("operational");
  });
});

describe("buildPublicStatus", () => {
  it("shows only incidents from the last 30 days, newest first, with plain component names", () => {
    const s = healthy();
    const mk = (id: string, days: number) => ({
      id,
      title: id,
      body: null,
      component: "computers",
      severity: "degraded" as const,
      started_at: ago(days * 24 * 60),
      resolved_at: null,
    });
    s.incidents = [mk("old", 40), mk("a", 5), mk("b", 1)];
    const out = buildPublicStatus(s);
    expect(out.incidents.map((i) => i.id)).toEqual(["b", "a"]);
    expect(out.incidents[0].component).toBe("Agent computers");
  });

  it("exposes only names, states and times", () => {
    const out = buildPublicStatus(healthy());
    expect(Object.keys(out).sort()).toEqual(["components", "generatedAt", "incidents", "overall"]);
    expect(out.components.map((c) => c.name)).toEqual([
      "Website and dashboard",
      "Launching agents",
      "Hivra AI",
      "Agent computers",
    ]);
    expect(out.overall.state).toBe("operational");
  });
});

describe("statusPageEnabled", () => {
  it("is off unless 1 or true", () => {
    expect(statusPageEnabled({})).toBe(false);
    expect(statusPageEnabled({ NEXT_PUBLIC_HIVRA_STATUS_PAGE: "0" })).toBe(false);
    expect(statusPageEnabled({ NEXT_PUBLIC_HIVRA_STATUS_PAGE: "1" })).toBe(true);
    expect(statusPageEnabled({ NEXT_PUBLIC_HIVRA_STATUS_PAGE: "True" })).toBe(true);
  });
});
