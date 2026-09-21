import { runCapacityPressureSweep } from "@/lib/recovery/capacity-pressure-sweep";
import { supabaseAdmin } from "@/lib/supabase";
import {
  shutdownProxmoxInstance,
  getProxmoxInfrastructure,
  getProxmoxHostRoutingConfigFromInfrastructure,
  isProxmoxVmMissingResult,
  resolveProxmoxMaxTenantInstances,
} from "@/lib/services/proxmox-instance-service";
import { sendCapacityPausedEmail } from "@/lib/email/capacity-pause";

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

jest.mock("@/lib/ops-events", () => ({
  reportOpsEvent: jest.fn().mockResolvedValue(null),
}));

jest.mock("@/lib/services/proxmox-instance-service", () => ({
  shutdownProxmoxInstance: jest.fn(),
  getProxmoxInfrastructure: jest.fn(),
  getProxmoxHostRoutingConfigFromInfrastructure: jest.fn(() => null),
  isProxmoxVmMissingResult: jest.fn(() => false),
  resolveProxmoxMaxTenantInstances: jest.fn(() => null),
}));

jest.mock("@/lib/email/capacity-pause", () => ({
  sendCapacityPausedEmail: jest.fn(),
}));

type HostRow = {
  id: string;
  total_ram_mb: number;
  reserved_ram_mb: number;
  wake_headroom_ram_mb: number;
  status: string;
  max_tenant_instances: number | null;
};

type CandidateRow = {
  id: string;
  user_id: string;
  name: string | null;
  resource_tier: string | null;
  proxmox_node: string | null;
  proxmox_vmid: number | null;
  host_id: string | null;
  config: Record<string, unknown> | null;
  ram_limit: number | null;
  last_activity_at: string | null;
  created_at?: string | null;
  last_lifecycle_transition_at?: string | null;
  notifications_sent?: Record<string, unknown> | null;
};

function buildSweepStub(params: {
  hosts: HostRow[];
  instancesByHost: Record<string, CandidateRow[]>;
}) {
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];

  (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
    if (table === "proxmox_hosts") {
      const query: Record<string, unknown> = {};
      query.select = jest.fn().mockReturnValue(query);
      query.in = jest.fn(async () => ({ data: params.hosts, error: null }));
      return query;
    }
    if (table === "hermes_instances") {
      // The sweep issues two chain shapes against this table: a candidate
      // select (select → eq(proxmox_node) → eq(lifecycle_state) → is → limit)
      // and writes (update → eq(id)) for both the pause patch and the
      // notifications_sent marker. One stub serves both.
      const query: Record<string, unknown> = {};
      let hostId: string | null = null;
      let patch: Record<string, unknown> | null = null;
      query.select = jest.fn().mockReturnValue(query);
      query.is = jest.fn().mockReturnValue(query);
      query.update = jest.fn((value: Record<string, unknown>) => {
        patch = value;
        return query;
      });
      query.eq = jest.fn((column: string, value: string) => {
        if (column === "id" && patch) {
          updates.push({ id: value, patch });
          return Promise.resolve({ error: null });
        }
        if (column === "proxmox_node") hostId = value;
        return query;
      });
      query.limit = jest.fn(async () => ({
        data: params.instancesByHost[hostId ?? ""] ?? [],
        error: null,
      }));
      return query;
    }
    throw new Error(`Unexpected table lookup: ${table}`);
  });

  return { updates };
}

function buildHost(id: string, overrides: Partial<HostRow> = {}): HostRow {
  return {
    id,
    total_ram_mb: 65536,
    reserved_ram_mb: 4096,
    wake_headroom_ram_mb: 8192,
    status: "active",
    max_tenant_instances: 10,
    ...overrides,
  };
}

function buildInstance(
  id: string,
  node: string,
  overrides: Partial<CandidateRow> = {}
): CandidateRow {
  return {
    id,
    user_id: `user_${id}`,
    name: null,
    resource_tier: "credit_base",
    proxmox_node: node,
    proxmox_vmid: 200,
    host_id: null,
    config: { infrastructure: { ...baseProxmoxInfra, node } },
    ram_limit: 1024,
    last_activity_at: NOW_ISO,
    created_at: "2026-04-01T00:00:00.000Z",
    last_lifecycle_transition_at: "2026-04-01T00:00:00.000Z",
    notifications_sent: null,
    ...overrides,
  };
}

const baseProxmoxInfra = {
  provider: "proxmox" as const,
  node: "fixturenode1",
  vmid: 200,
  privateIpv4: "10.250.21.50",
  gatewayHost: "abc.agents.hermesos.cloud",
};

const NOW = new Date("2026-06-10T12:00:00.000Z");
const NOW_ISO = NOW.toISOString();
const daysAgo = (days: number) =>
  new Date(NOW.getTime() - days * 86_400_000).toISOString();

// 11 active on a cap-10 host = pressure 1.1; target floor(10*0.95)=9 → 2 parks.
function buildHotHostInstances(node: string): CandidateRow[] {
  const idle = [
    buildInstance(`${node}_free_oldest`, node, {
      last_activity_at: daysAgo(30),
    }),
    buildInstance(`${node}_free_older`, node, {
      resource_tier: "token_base",
      last_activity_at: daysAgo(10),
    }),
    buildInstance(`${node}_free_idle`, node, {
      last_activity_at: daysAgo(3),
    }),
    buildInstance(`${node}_paid_idle`, node, {
      resource_tier: "operator",
      last_activity_at: daysAgo(30),
    }),
    buildInstance(`${node}_free_recent`, node, {
      last_activity_at: daysAgo(0),
    }),
  ];
  const filler = Array.from({ length: 6 }, (_, i) =>
    buildInstance(`${node}_filler_${i}`, node, { last_activity_at: daysAgo(0) })
  );
  return [...idle, ...filler];
}

describe("runCapacityPressureSweep", () => {
  const originalEnv = process.env;
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      CAPACITY_PRESSURE_SWEEP_ENABLED: "true",
    };
    delete process.env.CAPACITY_PRESSURE_DRY_RUN;
    delete process.env.CAPACITY_PRESSURE_INCLUDE_PAID;
    delete process.env.CAPACITY_PRESSURE_MAX_TOTAL;
    delete process.env.CLERK_SECRET_KEY;
    (getProxmoxInfrastructure as jest.Mock).mockReturnValue(baseProxmoxInfra);
    (shutdownProxmoxInstance as jest.Mock).mockResolvedValue({
      ok: true,
      stdout: "",
      stderr: "",
    });
    (getProxmoxHostRoutingConfigFromInfrastructure as jest.Mock).mockReturnValue(
      null
    );
    (isProxmoxVmMissingResult as jest.Mock).mockReturnValue(false);
    (resolveProxmoxMaxTenantInstances as jest.Mock).mockReturnValue(null);
    (sendCapacityPausedEmail as jest.Mock).mockResolvedValue({
      sent: true,
      messageId: "msg_1",
    });
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
  });

  it("does not sweep when the production opt-in is not enabled", async () => {
    delete process.env.CAPACITY_PRESSURE_SWEEP_ENABLED;
    buildSweepStub({
      hosts: [buildHost("fixturenode2")],
      instancesByHost: { "fixturenode2": buildHotHostInstances("fixturenode2") },
    });

    const summary = await runCapacityPressureSweep({ now: NOW });

    expect(summary.skipped).toBe(true);
    expect(summary.enabled).toBe(false);
    expect(summary.dryRun).toBe(true);
    expect(summary.parked).toBe(0);
    expect(summary.hosts).toEqual([]);
    expect(supabaseAdmin!.from).not.toHaveBeenCalled();
    expect(shutdownProxmoxInstance).not.toHaveBeenCalled();
  });

  it("dry-runs by default: plans free+idlest first on the hot host without acting", async () => {
    const { updates } = buildSweepStub({
      hosts: [buildHost("fixturenode1"), buildHost("fixturenode2")],
      instancesByHost: {
        // Cold host: 5/10 — reported, untouched.
        "fixturenode1": Array.from({ length: 5 }, (_, i) =>
          buildInstance(`fixturenode1_inst_${i}`, "fixturenode1", {
            last_activity_at: daysAgo(30),
          })
        ),
        "fixturenode2": buildHotHostInstances("fixturenode2"),
      },
    });

    const summary = await runCapacityPressureSweep({ now: NOW });

    expect(summary.skipped).toBe(false);
    expect(summary.dryRun).toBe(true);
    expect(summary.hostsScanned).toBe(2);
    expect(summary.hotHosts).toBe(1);
    expect(summary.parked).toBe(2);
    expect(summary.emailsSent).toBe(0);

    // Worst pressure first in the report ordering.
    expect(summary.hosts.map((h) => h.host)).toEqual(["fixturenode2", "fixturenode1"]);

    const hot = summary.hosts[0];
    expect(hot).toMatchObject({
      host: "fixturenode2",
      active: 11,
      cap: 10,
      pressure: 1.1,
      hot: true,
    });
    // RAM pressure reported alongside: 11 × 1024MB / (65536 - 4096 - 8192).
    expect(hot.ramAllocatedMb).toBe(11 * 1024);
    expect(hot.ramUsableMb).toBe(53248);
    expect(hot.ramPressure).toBeCloseTo((11 * 1024) / 53248, 3);

    // Plan = the two idlest FREE instances; the recently-active free agent
    // and the (default-excluded) paid agent are never candidates.
    expect(hot.parked).toEqual([
      { id: "fixturenode2_free_oldest", tier: "credit_base", idleDays: 30 },
      { id: "fixturenode2_free_older", tier: "token_base", idleDays: 10 },
    ]);

    const cold = summary.hosts[1];
    expect(cold).toMatchObject({ host: "fixturenode1", hot: false, parked: [] });

    // Dry run touches nothing.
    expect(shutdownProxmoxInstance).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
    expect(sendCapacityPausedEmail).not.toHaveBeenCalled();
  });

  it("parks a dormant instance whose only recent touch was a PLATFORM lifecycle transition", async () => {
    // Parity with the inactivity-sweep fix: a fleet-wide maintenance pass
    // (e.g. the 2026-06-08 webfree migration) bumps last_lifecycle_transition_at
    // with no user activity. idleDays must be computed from genuine activity, so
    // such an instance is still the idlest candidate on a hot host and gets
    // parked first — the old anchor logic would have scored it idleDays=0.
    const instances = buildHotHostInstances("fixturenode2").map((inst) =>
      inst.id === "fixturenode2_free_oldest"
        ? { ...inst, last_lifecycle_transition_at: NOW_ISO }
        : inst
    );
    buildSweepStub({
      hosts: [buildHost("fixturenode2")],
      instancesByHost: { "fixturenode2": instances },
    });

    const summary = await runCapacityPressureSweep({ now: NOW });

    const hot = summary.hosts[0];
    expect(hot.parked).toEqual([
      { id: "fixturenode2_free_oldest", tier: "credit_base", idleDays: 30 },
      { id: "fixturenode2_free_older", tier: "token_base", idleDays: 10 },
    ]);
  });

  it("act mode parks, writes paused_reason='capacity_pressure', and emails the owner", async () => {
    process.env.CAPACITY_PRESSURE_DRY_RUN = "false";
    process.env.CLERK_SECRET_KEY = "clerk-secret";
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        id: "user_x",
        first_name: "Ash",
        primary_email_address_id: "em_1",
        email_addresses: [{ id: "em_1", email_address: "owner@example.com" }],
      }),
    })) as unknown as typeof fetch;

    const { updates } = buildSweepStub({
      hosts: [buildHost("fixturenode2")],
      instancesByHost: { "fixturenode2": buildHotHostInstances("fixturenode2") },
    });

    const summary = await runCapacityPressureSweep({ now: NOW });

    expect(summary.dryRun).toBe(false);
    expect(summary.parked).toBe(2);
    expect(summary.failed).toBe(0);
    expect(summary.emailsSent).toBe(2);
    expect(shutdownProxmoxInstance).toHaveBeenCalledTimes(2);

    const pauseUpdates = updates.filter((u) => u.patch.lifecycle_state);
    expect(pauseUpdates.map((u) => u.id)).toEqual([
      "fixturenode2_free_oldest",
      "fixturenode2_free_older",
    ]);
    for (const update of pauseUpdates) {
      expect(update.patch).toEqual(
        expect.objectContaining({
          lifecycle_state: "paused",
          paused_reason: "capacity_pressure",
          status: "stopped",
        })
      );
      expect(update.patch.last_lifecycle_transition_at).toEqual(
        expect.any(String)
      );
    }

    // Email carries the documented idempotency key and the send gets
    // recorded in notifications_sent.
    expect(sendCapacityPausedEmail).toHaveBeenCalledTimes(2);
    const firstSend = (sendCapacityPausedEmail as jest.Mock).mock.calls[0][0];
    expect(firstSend.email).toBe("owner@example.com");
    expect(firstSend.idempotencyKey).toMatch(
      /^fixturenode2_free_oldest:capacity_paused:/
    );
    const markerUpdates = updates.filter((u) => u.patch.notifications_sent);
    expect(markerUpdates.map((u) => u.id)).toEqual([
      "fixturenode2_free_oldest",
      "fixturenode2_free_older",
    ]);
    for (const marker of markerUpdates) {
      expect(
        (marker.patch.notifications_sent as Record<string, unknown>)
          .capacity_paused
      ).toEqual(expect.any(String));
    }
  });

  it("parks a dormant instance whose only recent touch was PLATFORM maintenance", async () => {
    // Parity with the inactivity-sweep fix: a recent last_lifecycle_transition_at
    // from a fleet-wide maintenance pass (e.g. the 2026-06-08 webfree migration)
    // must NOT shield an instance the user abandoned. idleDays is computed from
    // last_activity_at, not the platform transition.
    const instances = [
      // Idlest by user activity (30d) but platform-touched moments ago.
      buildInstance("fixturenode2_free_oldest", "fixturenode2", {
        last_activity_at: daysAgo(30),
        last_lifecycle_transition_at: daysAgo(0),
      }),
      buildInstance("fixturenode2_free_older", "fixturenode2", {
        resource_tier: "token_base",
        last_activity_at: daysAgo(10),
        last_lifecycle_transition_at: daysAgo(0),
      }),
      buildInstance("fixturenode2_free_idle", "fixturenode2", { last_activity_at: daysAgo(3) }),
      buildInstance("fixturenode2_free_recent", "fixturenode2", { last_activity_at: daysAgo(0) }),
      ...Array.from({ length: 7 }, (_, i) =>
        buildInstance(`fixturenode2_filler_${i}`, "fixturenode2", { last_activity_at: daysAgo(0) })
      ),
    ];
    buildSweepStub({
      hosts: [buildHost("fixturenode2")],
      instancesByHost: { "fixturenode2": instances },
    });

    const summary = await runCapacityPressureSweep({ now: NOW });

    // 11 active on a cap-10 host → 2 parks: the two platform-touched dormant
    // agents, with idleDays from real activity (not the recent transition).
    expect(summary.hosts[0].parked).toEqual([
      { id: "fixturenode2_free_oldest", tier: "credit_base", idleDays: 30 },
      { id: "fixturenode2_free_older", tier: "token_base", idleDays: 10 },
    ]);
  });

  it("relieves the worst host first and respects the global cap", async () => {
    process.env.CAPACITY_PRESSURE_MAX_TOTAL = "3";
    const hostA = Array.from({ length: 14 }, (_, i) =>
      buildInstance(`a_inst_${i}`, "pveA", { last_activity_at: daysAgo(20 + i) })
    );
    buildSweepStub({
      // pveB listed first to prove the sweep re-orders by pressure.
      hosts: [buildHost("pveB"), buildHost("pveA")],
      instancesByHost: {
        pveB: buildHotHostInstances("pveB"), // pressure 1.1
        pveA: hostA, // pressure 1.4
      },
    });

    const summary = await runCapacityPressureSweep({ now: NOW });

    expect(summary.hotHosts).toBe(2);
    expect(summary.hosts.map((h) => h.host)).toEqual(["pveA", "pveB"]);

    // pveA needs 14 - floor(10*0.95) = 5 but is capped at 3/host, which
    // exhausts the global budget of 3 — pveB gets nothing this run.
    expect(summary.parked).toBe(3);
    expect(summary.hosts[0].parked).toHaveLength(3);
    expect(summary.hosts[1].parked).toEqual([]);
  });

  it("includes paid tiers only when opted in AND idle past the 7-day floor", async () => {
    process.env.CAPACITY_PRESSURE_INCLUDE_PAID = "true";
    const instances = [
      buildInstance("paid_long_idle", "fixturenode2", {
        resource_tier: "operator",
        last_activity_at: daysAgo(8),
      }),
      buildInstance("paid_short_idle", "fixturenode2", {
        resource_tier: "fleet",
        last_activity_at: daysAgo(3),
      }),
      ...Array.from({ length: 9 }, (_, i) =>
        buildInstance(`recent_${i}`, "fixturenode2", { last_activity_at: daysAgo(0) })
      ),
    ];
    buildSweepStub({
      hosts: [buildHost("fixturenode2")],
      instancesByHost: { "fixturenode2": instances },
    });

    const summary = await runCapacityPressureSweep({ now: NOW });

    // 3 days idle clears the free 48h bar but NOT the paid 7-day floor —
    // only the 8-day-idle paid agent is plannable.
    expect(summary.parked).toBe(1);
    expect(summary.hosts[0].parked).toEqual([
      { id: "paid_long_idle", tier: "operator", idleDays: 8 },
    ]);
  });

  it("never plans parks on a host under the threshold", async () => {
    buildSweepStub({
      hosts: [buildHost("fixturenode5", { max_tenant_instances: 20 })],
      instancesByHost: {
        "fixturenode5": Array.from({ length: 11 }, (_, i) =>
          buildInstance(`fixturenode5_inst_${i}`, "fixturenode5", {
            last_activity_at: daysAgo(30),
          })
        ),
      },
    });

    const summary = await runCapacityPressureSweep({ now: NOW });

    expect(summary.hotHosts).toBe(0);
    expect(summary.parked).toBe(0);
    expect(summary.hosts[0]).toMatchObject({
      host: "fixturenode5",
      active: 11,
      cap: 20,
      pressure: 0.55,
      hot: false,
    });
  });
});
