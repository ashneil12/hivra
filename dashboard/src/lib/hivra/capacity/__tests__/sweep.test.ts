import { readFileSync } from "node:fs";
import { join } from "node:path";

import { runHostCapacitySweep, readStoredCapacity, type StoredCapacityReading } from "../sweep";
import { loadCapacityCriticalHostIds, selectAvoidingCriticalHosts, CAPACITY_READING_MAX_AGE_MS } from "../placement";

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));
jest.mock("@/lib/ops-events", () => ({ reportOpsEvent: jest.fn() }));
jest.mock("@/lib/services/proxmox-instance-service", () => ({
  runProxmoxHostScript: jest.fn(),
  resolveProxmoxTargetConfiguration: (env: Record<string, string | undefined>, id: string) => ({ id, env: { ...env, PROXMOX_NODE: id } }),
  isProxmoxProvisioningConfigured: (env: Record<string, string | undefined>) => env.PROXMOX_NODE !== "unconfigured",
}));

const NOW = Date.parse("2026-11-17T12:00:00.000Z");
const ON = { HIVRA_HOST_CAPACITY_ALERTS: "on" };

type Row = Record<string, unknown>;

/** A small stand-in for the admin client: two tables, the filters the sweep uses, and a record of updates. */
function fakeDb(tables: { proxmox_hosts: Row[]; hivra_agents?: Row[] }, fail: { hosts?: boolean; agents?: boolean; update?: boolean } = {}) {
  const updates: Array<{ id: unknown; patch: Row }> = [];
  const db = {
    updates,
    from(table: "proxmox_hosts" | "hivra_agents") {
      let rows = [...(tables[table] ?? [])];
      let patch: Row | null = null;
      const query = {
        select: () => query,
        update: (value: Row) => { patch = value; return query; },
        eq: (column: string, value: unknown) => {
          if (patch) {
            updates.push({ id: value, patch });
            return Promise.resolve({ error: fail.update ? { message: "no column" } : null });
          }
          rows = rows.filter((row) => row[column] === value);
          return query;
        },
        neq: (column: string, value: unknown) => { rows = rows.filter((row) => row[column] !== value); return query; },
        is: (column: string, value: unknown) => { rows = rows.filter((row) => (row[column] ?? null) === value); return query; },
        order: () => query,
        range: (from: number, to: number) => Promise.resolve(
          fail.agents ? { data: null, error: { message: "down" } } : { data: rows.slice(from, to + 1), error: null },
        ),
        then: (resolve: (value: unknown) => unknown) => resolve(
          fail.hosts ? { data: null, error: { message: "down" } } : { data: rows, error: null },
        ),
      };
      return query;
    },
  };
  return db;
}

const host = (id: string, over: Row = {}): Row => ({
  id, status: "active", wake_headroom_ram_mb: 8192, capacity_reading: null,
  // As the sweep writes it: the time of the stored reading.
  capacity_reading_at: (over.capacity_reading as StoredCapacityReading | undefined)?.at ?? null, ...over,
});
const agent = (proxmox_host: string, ram: number, sleep_state = "awake", over: Row = {}): Row => ({
  id: `00000000-0000-4000-8000-${String(Math.random()).slice(2, 14).padEnd(12, "0")}`,
  proxmox_host, ram, ram_max: null, sleep_state, status: "running",
  deployment_mode: "hivra-managed", computer_substrate: "proxmox-kvm", deployment_target_id: null, ...over,
});
const out = (availableMb: number, poolPercent = 40, totalMb = 128_000) => ({
  ok: true, stderr: "",
  stdout: [
    `HIVRA_CAPACITY mem total_mb=${totalMb} available_mb=${availableMb}`,
    `HIVRA_CAPACITY pool source=lvm name=vg0/pool size_mb=900000 used_percent=${poolPercent}`,
    "HIVRA_CAPACITY vms running=5 paused=2 stopped=3",
  ].join("\n"),
});
const stored = (over: Partial<StoredCapacityReading> = {}): StoredCapacityReading => ({
  v: 1, at: new Date(NOW - 60_000).toISOString(), level: "ok", reasons: [], canAdmitStandard: true,
  oversubscriptionRatio: 0.5, memTotalMb: 128_000, memAvailableMb: 64_000, wakeHeadroomMb: 8192, pool: null, vms: null,
  agents: { total: 0, napping: 0, hibernated: 0, committedRamMb: 0, hibernatedRamMb: 0, largestHibernatedRamMb: 0 },
  ...over,
});

function setup(tables: Parameters<typeof fakeDb>[0], byHost: Record<string, unknown>, fail?: Parameters<typeof fakeDb>[1]) {
  const db = fakeDb(tables, fail);
  const report = jest.fn().mockResolvedValue(null);
  const runHostScript = jest.fn(async (_script: string, env: Record<string, string | undefined>) => {
    const result = byHost[String(env.PROXMOX_NODE)];
    if (result instanceof Error) throw result;
    return result;
  });
  const run = (env: Record<string, string | undefined> = ON) =>
    runHostCapacitySweep({ db, env, now: () => NOW, report, runHostScript: runHostScript as never });
  return { db, report, runHostScript, run };
}

describe("runHostCapacitySweep", () => {
  it.each([{}, { HIVRA_HOST_CAPACITY_ALERTS: "off" }])("does nothing with the flag off (%p)", async (env) => {
    const { run, runHostScript, report, db } = setup({ proxmox_hosts: [host("nodea")] }, { nodea: out(1000, 99) });
    expect(await run(env)).toMatchObject({ skipped: true, reason: "flag_off" });
    expect(runHostScript).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
    expect(db.updates).toEqual([]);
  });

  it("stores an ok reading with agent totals and raises nothing", async () => {
    const { run, report, db, runHostScript } = setup({
      proxmox_hosts: [host("nodea"), host("nodeb", { status: "draining" }), host("unconfigured")],
      hivra_agents: [
        agent("nodea", 8), agent("nodea", 8, "napping"), agent("nodea", 4, "hibernated", { ram_max: 16 }),
        agent("nodea", 8, "hibernated"), agent("nodeb", 8),
        agent("nodea", 64, "awake", { status: "deleted" }),
        agent("nodea", 64, "awake", { deployment_mode: "self-managed" }),
      ],
    }, { nodea: out(64_000) });
    const summary = await run();
    expect(summary).toMatchObject({ skipped: false, hosts: 1, read: 1, probeFailed: 0, levels: { ok: 1, warn: 0, critical: 0 }, fleetFull: false, errors: 0 });
    expect(runHostScript).toHaveBeenCalledTimes(1);
    expect(report).not.toHaveBeenCalled();
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0].id).toBe("nodea");
    expect(db.updates[0].patch.capacity_reading_at).toBe("2026-11-17T12:00:00.000Z");
    expect(db.updates[0].patch.capacity_reading).toMatchObject({
      v: 1, level: "ok", reasons: [], canAdmitStandard: true, memAvailableMb: 64_000, wakeHeadroomMb: 8192,
      oversubscriptionRatio: 0.32,
      pool: { name: "vg0/pool", usedPercent: 40 },
      vms: { running: 5, paused: 2, stopped: 3 },
      agents: { total: 4, napping: 1, hibernated: 2, committedRamMb: 40_960, hibernatedRamMb: 24_576, largestHibernatedRamMb: 16_384 },
    });
  });

  it("raises one event per host with a fingerprint that does not move with the numbers", async () => {
    const tables = { proxmox_hosts: [host("nodea"), host("nodeb")] };
    const first = setup(tables, { nodea: out(64_000, 85), nodeb: out(4000) });
    expect(await first.run()).toMatchObject({ levels: { ok: 0, warn: 1, critical: 1 }, fleetFull: false });
    const second = setup(tables, { nodea: out(60_000, 88), nodeb: out(3000) });
    await second.run();

    const events = (report: jest.Mock) => report.mock.calls.map(([event]) => event).sort((a, b) => a.title.localeCompare(b.title));
    const [warn, critical] = events(first.report);
    expect(warn).toMatchObject({ source: "hivra.host_capacity", severity: "warn", title: "Host nodea capacity warn" });
    expect(warn.metadata).toMatchObject({ host_id: "nodea", reasons: ["disk_pool_high"], pool: { usedPercent: 85 } });
    // Fatal is the severity that pages an admin; the day in the fingerprint makes it once a day per host.
    expect(critical).toMatchObject({ severity: "fatal", title: "Host nodeb capacity critical", fingerprintDetail: "2026-11-17" });
    expect(warn.fingerprintDetail).toBeUndefined();
    expect(critical.metadata).toMatchObject({ reasons: ["ram_available_low"], memAvailableMb: 4000 });
    const identity = (event: Record<string, unknown>) => [event.source, event.title, event.message, event.route, event.fingerprintDetail];
    expect(events(second.report).map(identity)).toEqual([warn, critical].map(identity));
  });

  it("is critical when the largest hibernated agent would not fit", async () => {
    const { run, report } = setup({
      proxmox_hosts: [host("nodea", { wake_headroom_ram_mb: 2048 })],
      hivra_agents: [agent("nodea", 32, "hibernated")],
    }, { nodea: out(20_000) });
    await run();
    expect(report.mock.calls[0][0].metadata).toMatchObject({ level: "critical", reasons: ["wake_would_not_fit"] });
  });

  it("raises one fleet event, fatal, when no host can take a standard agent", async () => {
    const { run, report } = setup({ proxmox_hosts: [host("nodea"), host("nodeb")] }, { nodea: out(9000), nodeb: out(12_000) });
    expect(await run()).toMatchObject({ fleetFull: true, levels: { ok: 1, warn: 1, critical: 0 } });
    const fleet = report.mock.calls.map(([event]) => event).filter((event) => event.source === "hivra.fleet_capacity");
    expect(fleet).toHaveLength(1);
    expect(fleet[0]).toMatchObject({ severity: "fatal", fingerprintDetail: "2026-11-17 full since 2026-11-17T12" });
    expect(fleet[0].metadata.by_host.nodeb).toMatchObject({ level: "ok", mem_available_mb: 12_000 });
  });

  it("keeps one fleet fingerprint while an outage lasts, and a new one for a second outage that day", async () => {
    const full = (since: string) => stored({ level: "warn", canAdmitStandard: false, fullSince: since });
    const detail = async (nodeb: StoredCapacityReading) => {
      const { run, report, db } = setup({
        proxmox_hosts: [host("nodea", { capacity_reading: full("2026-11-17T08:10:00.000Z") }), host("nodeb", { capacity_reading: nodeb })],
      }, { nodea: out(9000), nodeb: out(9000) });
      await run();
      const fleet = report.mock.calls.map(([event]) => event).find((event) => event.source === "hivra.fleet_capacity");
      return [fleet.fingerprintDetail, db.updates.map((update) => (update.patch.capacity_reading as StoredCapacityReading).fullSince)];
    };
    // Lasting: both hosts were already full, so the marker stays at the hour the last one filled.
    expect(await detail(full("2026-11-17T09:40:00.000Z"))).toEqual([
      "2026-11-17 full since 2026-11-17T09", ["2026-11-17T08:10:00.000Z", "2026-11-17T09:40:00.000Z"],
    ]);
    // nodeb had room in between: the fleet is full again from now, which is a new fingerprint and a new page.
    expect(await detail(stored())).toEqual([
      "2026-11-17 full since 2026-11-17T12", ["2026-11-17T08:10:00.000Z", "2026-11-17T12:00:00.000Z"],
    ]);
  });

  it("raises an event for a host with no recent reading, and does not let it hold back the fleet alert", async () => {
    const old = stored({ at: new Date(NOW - CAPACITY_READING_MAX_AGE_MS - 1).toISOString() });
    const { run, report, db } = setup({ proxmox_hosts: [host("nodea"), host("nodeb"), host("nodec", { capacity_reading: old })] }, {
      nodea: out(4000), nodeb: new Error("ssh down"), nodec: { ok: false, stdout: "garbage", stderr: "" },
    });
    expect(await run()).toMatchObject({ hosts: 3, read: 1, probeFailed: 2, fleetFull: true });
    const events = report.mock.calls.map(([event]) => event);
    const unread = events.filter((event) => event.source === "hivra.host_capacity_unread");
    expect(unread.map((event) => [event.severity, event.title]).sort()).toEqual([
      ["error", "Host nodeb capacity could not be read"], ["error", "Host nodec capacity could not be read"],
    ]);
    const fleet = events.find((event) => event.source === "hivra.fleet_capacity");
    expect(fleet.metadata.unread_hosts.sort()).toEqual(["nodeb", "nodec"]);
    expect(Object.keys(fleet.metadata.by_host)).toEqual(["nodea"]);
    // A host that was not read keeps whatever was stored: nothing is written for it.
    expect(db.updates.map((update) => update.id)).toEqual(["nodea"]);
  });

  it("counts a recent stored reading for a host that missed one run", async () => {
    const tables = (nodeb: StoredCapacityReading) => ({ proxmox_hosts: [host("nodea"), host("nodeb", { capacity_reading: nodeb })] });
    const roomy = setup(tables(stored()), { nodea: out(4000), nodeb: new Error("ssh down") });
    expect(await roomy.run()).toMatchObject({ read: 1, probeFailed: 1, fleetFull: false });
    expect(roomy.report.mock.calls.map(([event]) => event.source)).toEqual(["hivra.host_capacity"]);

    const full = setup(tables(stored({ level: "critical", canAdmitStandard: false })), { nodea: out(4000), nodeb: new Error("ssh down") });
    expect(await full.run()).toMatchObject({ fleetFull: true });
    expect(full.report.mock.calls.map(([event]) => event.source)).toEqual(["hivra.host_capacity", "hivra.fleet_capacity"]);
  });

  it("raises no fleet alert when no host could be read", async () => {
    const { run, report } = setup({ proxmox_hosts: [host("nodea")] }, { nodea: new Error("ssh down") });
    expect(await run()).toMatchObject({ read: 0, probeFailed: 1, fleetFull: false });
    expect(report.mock.calls.map(([event]) => event.source)).toEqual(["hivra.host_capacity_unread"]);
  });

  it("reads only the listed hosts when a list is set", async () => {
    const db = fakeDb({ proxmox_hosts: [host("nodea"), host("nodeb")] });
    const runHostScript = jest.fn(async () => out(64_000));
    const env = { ...ON, HIVRA_HOST_CAPACITY_HOSTS: " NodeB , " };
    const summary = await runHostCapacitySweep({ db, env, now: () => NOW, report: jest.fn(), runHostScript: runHostScript as never });
    expect(summary).toMatchObject({ hosts: 1, read: 1 });
    expect(runHostScript).toHaveBeenCalledTimes(1);
    expect((runHostScript.mock.calls[0] as unknown[])[1]).toMatchObject({ PROXMOX_NODE: "nodeb" });
  });

  it("starts no host after a minute, so the run ends in time", async () => {
    const db = fakeDb({ proxmox_hosts: ["a", "b", "c", "d", "e", "f"].map((id) => host(`node${id}`)) });
    let clock = NOW;
    // Each host takes 40 seconds; four run side by side.
    const runHostScript = jest.fn(async () => { await Promise.resolve(); clock += 40_000; return out(64_000); });
    const summary = await runHostCapacitySweep({ db, env: ON, now: () => clock, report: jest.fn(), runHostScript: runHostScript as never });
    expect(runHostScript).toHaveBeenCalledTimes(4);
    expect(summary).toMatchObject({ hosts: 6, read: 4, probeFailed: 2 });
    expect(runHostScript.mock.calls[0]).toEqual([expect.any(String), expect.any(Object), { timeoutMs: 45_000 }]);
  });

  it("raises a recovery event once when a host or the fleet clears", async () => {
    const before = stored({ level: "critical", reasons: ["ram_available_low"], canAdmitStandard: false });
    const { run, report } = setup({ proxmox_hosts: [host("nodea", { capacity_reading: before })] }, { nodea: out(64_000) });
    await run();
    expect(report.mock.calls.map(([event]) => [event.source, event.severity])).toEqual([
      ["hivra.host_capacity_recovered", "info"],
      ["hivra.fleet_capacity_recovered", "info"],
    ]);

    const steady = setup({ proxmox_hosts: [host("nodea", { capacity_reading: stored() })] }, { nodea: out(64_000) });
    await steady.run();
    expect(steady.report).not.toHaveBeenCalled();
  });

  it("still alerts when the reading cannot be stored, and counts the error", async () => {
    const { run, report } = setup({ proxmox_hosts: [host("nodea")] }, { nodea: out(4000) }, { update: true });
    expect(await run()).toMatchObject({ errors: 1, levels: { critical: 1 } });
    expect(report).toHaveBeenCalled();
  });

  it.each([{ hosts: true }, { agents: true }])("reads no host when a query fails (%p)", async (fail) => {
    const { run, runHostScript, report } = setup({ proxmox_hosts: [host("nodea")] }, { nodea: out(4000) }, fail);
    expect(await run()).toMatchObject({ skipped: false, failed: true, errors: 1, read: 0 });
    expect(runHostScript).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
  });

  it("survives a failing event report", async () => {
    const { run, report } = setup({ proxmox_hosts: [host("nodea")] }, { nodea: out(4000) });
    report.mockRejectedValue(new Error("ops down"));
    expect(await run()).toMatchObject({ read: 1, errors: 2 });
  });
});

describe("readStoredCapacity", () => {
  it.each([null, undefined, "x", {}, { v: 2, at: "t", level: "ok", canAdmitStandard: true }, { v: 1, at: "t", level: "full", canAdmitStandard: true }])(
    "has nothing for %p", (value) => expect(readStoredCapacity(value)).toBeNull(),
  );
});

describe("placement", () => {
  const critical = stored({ level: "critical", canAdmitStandard: false });
  const deps = (rows: Row[], env: Record<string, string | undefined> = ON, fail?: Parameters<typeof fakeDb>[1]) =>
    ({ db: fakeDb({ proxmox_hosts: rows }, fail), env, now: () => NOW });

  it("names the hosts whose fresh reading is critical", async () => {
    expect(await loadCapacityCriticalHostIds(deps([
      host("nodea", { capacity_reading: critical }),
      host("nodeb", { capacity_reading: stored({ level: "warn" }) }),
      host("nodec"),
      host("noded", { capacity_reading: critical, status: "draining" }),
    ]))).toEqual(["nodea"]);
  });

  it.each([
    ["the flag is off", deps([host("nodea", { capacity_reading: critical }), host("nodeb")], {})],
    ["the query fails", deps([host("nodea", { capacity_reading: critical }), host("nodeb")], ON, { hosts: true })],
    ["every host is critical", deps([host("nodea", { capacity_reading: critical }), host("nodeb", { capacity_reading: critical })])],
    ["the reading is old", deps([host("nodea", { capacity_reading: stored({ ...critical, at: new Date(NOW - CAPACITY_READING_MAX_AGE_MS - 1).toISOString() }) }), host("nodeb")])],
    ["the reading is from the future", deps([host("nodea", { capacity_reading: stored({ ...critical, at: new Date(NOW + 60_000).toISOString() }) }), host("nodeb")])],
    ["the reading is malformed", deps([host("nodea", { capacity_reading: { level: "critical" } }), host("nodeb")])],
    ["there is no reading", deps([host("nodea"), host("nodeb")])],
  ])("skips no host when %s", async (_name, d) => {
    expect(await loadCapacityCriticalHostIds(d)).toEqual([]);
  });

  it("places without the critical host when another host takes the launch", async () => {
    const select = jest.fn().mockResolvedValue({ ok: true, targetId: "nodeb" });
    const d = deps([host("nodea", { capacity_reading: critical }), host("nodeb")]);
    expect(await selectAvoidingCriticalHosts(select, d)).toEqual({ ok: true, targetId: "nodeb" });
    expect(select.mock.calls).toEqual([[["nodea"]]]);
  });

  it("tries every host again when the others cannot take it", async () => {
    const select = jest.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: true, targetId: "nodea" });
    const d = deps([host("nodea", { capacity_reading: critical }), host("nodeb")]);
    expect(await selectAvoidingCriticalHosts(select, d)).toEqual({ ok: true, targetId: "nodea" });
    expect(select.mock.calls).toEqual([[["nodea"]], [undefined]]);
  });

  it.each([
    ["the flag is off", {}, false],
    ["the host is forced", ON, true],
  ])("selects once, unchanged, when %s", async (_name, env, forced) => {
    const select = jest.fn().mockResolvedValue({ ok: false });
    const d = deps([host("nodea", { capacity_reading: critical }), host("nodeb")], env);
    expect(await selectAvoidingCriticalHosts(select, { ...d, forced })).toEqual({ ok: false });
    expect(select.mock.calls).toEqual([[undefined]]);
  });
});

describe("launch wiring", () => {
  // The launch path is covered by the agents route tests with the switch off. This holds the two lines
  // that connect it to the capacity readings: the skipped hosts reach the selection, and a forced host bypasses them.
  const source = readFileSync(join(__dirname, "../../launch-agent.ts"), "utf8");

  it("passes the skipped hosts to the host selection and leaves a forced host alone", () => {
    expect(source).toMatch(/selectAvoidingCriticalHosts\(excludeTargetIds => selectAvailableProxmoxProvisionTarget\(\{/);
    expect(source).toContain("...(excludeTargetIds ? { excludeTargetIds } : {}),");
    expect(source).toContain("{ forced: Boolean(forceTargetId) }");
  });
});
