import { NextRequest } from "next/server";

import { clerkClient } from "@clerk/nextjs/server";

import { GET, POST } from "../route";
import { applyLiveUpdate, resolveInstanceIpv4 } from "@/lib/services/instance-orchestrator";
import type { InFlightUpdateGateReport } from "@/lib/services/inflight-update-gate";
import {
  OPERATOR_LIVE_UPDATE,
  systemLiveUpdate,
} from "@/lib/services/live-update-initiator";
import { FLEET_SYNC_SKIP_LIFECYCLE_IN_LIST } from "@/lib/instance-lifecycle";
import { supabaseAdmin } from "@/lib/supabase";

// The DB CHECK vocabulary for hermes_instances.lifecycle_state
// (supabase/migrations/20260516123000_cold_storage_lifecycle.sql). Filtering on
// anything outside this set matches ZERO rows — silently.
const LIFECYCLE_CHECK_STATES = [
  "pending", "provisioning", "active", "paused", "suspended", "deleting",
  "deleted", "failed", "archiving", "cold_archived", "restoring", "pending_deletion",
];


jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@clerk/nextjs/server", () => ({
  clerkClient: jest.fn(),
}));

jest.mock("@/lib/services/instance-orchestrator", () => ({
  applyLiveUpdate: jest.fn(),
  resolveInstanceIpv4: jest.fn(),
}));

const FLEET_SYNC = systemLiveUpdate("fleet_sync");

function launched(initiator = OPERATOR_LIVE_UPDATE) {
  return { applied: true as const, initiator, inFlightGate: null };
}

function busyGate(deferrals: number): InFlightUpdateGateReport {
  return {
    action: "defer",
    verdict: "busy",
    reason: "in_flight_turn",
    liveTurns: 1,
    unreadableMarkers: 0,
    deferrals,
    streakSeconds: 60,
  };
}

function request(body: unknown, authorization = "Bearer expected-secret") {
  return new NextRequest("http://localhost/api/cron/redeploy-webui-instances", {
    method: "POST",
    headers: {
      authorization,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function selectQuery(data: unknown[], error: Error | null = null) {
  const inMock = jest.fn().mockResolvedValue({ data, error });
  const selectMock = jest.fn().mockReturnValue({ in: inMock });
  return { select: selectMock, selectMock, inMock };
}

describe("POST /api/cron/redeploy-webui-instances", () => {
  const originalCronSecret = process.env.CRON_SECRET;
  const mockedSupabaseAdmin = supabaseAdmin as unknown as { from: jest.Mock };
  const mockedClerkClient = clerkClient as jest.MockedFunction<typeof clerkClient>;
  const mockedResolveInstanceIpv4 = resolveInstanceIpv4 as jest.MockedFunction<typeof resolveInstanceIpv4>;
  const mockedApplyLiveUpdate = applyLiveUpdate as jest.MockedFunction<typeof applyLiveUpdate>;
  let consoleErrorSpy: jest.SpyInstance;
  let consoleWarnSpy: jest.SpyInstance;
  let consoleLogSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CRON_SECRET = "expected-secret";
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    consoleLogSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    mockedClerkClient.mockResolvedValue({
      users: {
        getUser: jest.fn().mockResolvedValue({ publicMetadata: { hermes: { memoryMode: "hybrid" } } }),
      },
    } as never);
    mockedResolveInstanceIpv4.mockResolvedValue("10.250.20.98");
    mockedApplyLiveUpdate.mockResolvedValue(launched());
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleLogSpy.mockRestore();
    if (originalCronSecret === undefined) {
      delete process.env.CRON_SECRET;
    } else {
      process.env.CRON_SECRET = originalCronSecret;
    }
  });

  it("fails closed when CRON_SECRET is missing", async () => {
    delete process.env.CRON_SECRET;

    const response = await POST(request({ instanceIds: ["inst-1"] }));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toMatch(/cron secret is not configured/i);
    expect(mockedApplyLiveUpdate).not.toHaveBeenCalled();
  });

  it("rejects requests with the wrong bearer token", async () => {
    const response = await POST(request({ instanceIds: ["inst-1"] }, "Bearer wrong"));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error).toBe("Unauthorized");
    expect(mockedApplyLiveUpdate).not.toHaveBeenCalled();
  });

  it("redeploys requested webfree instances (webui AND gateway) from saved production config", async () => {
    const webuiRow = {
      id: "inst-webui",
      user_id: "user-1",
      name: "Oracle",
      status: "running",
      backend: "webui",
      provider: "crof",
      subdomain: "oracle",
      hetzner_server_id: null,
      gateway_url: "https://oracle.example.com",
      api_key_encrypted: "encrypted-provider",
      api_server_key_encrypted: "encrypted-server",
      honcho_api_key_encrypted: null,
      config: { model: "deepseek-v4-pro" },
      host_id: null,
      ipv4_address: null,
      cpu_limit: 1,
      ram_limit: 1024,
      infrastructure_provider: "proxmox",
      proxmox_vmid: 318,
    };
    const gatewayRow = { ...webuiRow, id: "inst-gateway", backend: "gateway" };
    const query = selectQuery([webuiRow, gatewayRow]);
    mockedSupabaseAdmin.from.mockReturnValue(query);

    const response = await POST(request({ instanceIds: ["inst-webui", "inst-gateway"] }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(query.selectMock).toHaveBeenCalledWith(expect.stringContaining("api_key_encrypted"));
    expect(query.inMock).toHaveBeenCalledWith("id", ["inst-webui", "inst-gateway"]);
    // Post gateway≡webfree collapse: BOTH the webui-backend and gateway-backend
    // rows are webfree and get redeployed (gateway is no longer skipped).
    expect(mockedResolveInstanceIpv4).toHaveBeenCalledWith(webuiRow, supabaseAdmin);
    expect(mockedResolveInstanceIpv4).toHaveBeenCalledWith(gatewayRow, supabaseAdmin);
    expect(mockedApplyLiveUpdate).toHaveBeenCalledTimes(2);
    // A targeted POST is an operator rescue: it recreates now, without the
    // in-flight turn gate the scheduled sweep uses.
    expect(mockedApplyLiveUpdate).toHaveBeenCalledWith(
      webuiRow,
      "10.250.20.98",
      expect.any(Object),
      supabaseAdmin,
      { initiator: OPERATOR_LIVE_UPDATE },
    );
    expect(mockedApplyLiveUpdate).toHaveBeenCalledWith(
      gatewayRow,
      "10.250.20.98",
      expect.any(Object),
      supabaseAdmin,
      { initiator: OPERATOR_LIVE_UPDATE },
    );
    expect(body.data).toMatchObject({
      requested: 2,
      launched: 2,
      failed: 0,
      skipped: 0,
    });
    expect(body.data.results).toEqual([
      {
        id: "inst-webui",
        name: "Oracle",
        success: true,
        status: "redeploying",
      },
      {
        id: "inst-gateway",
        name: "Oracle",
        success: true,
        status: "redeploying",
      },
    ]);
  });

  it("skips an intentionally-paused instance without attempting an SSH redeploy or raising an error", async () => {
    // Repro of the 2026-06-24 false positive: a runbook POST that includes a
    // paused (idle-swept) box. lifecycle_state='paused' with status drifted back
    // to 'running'. applyLiveUpdate would SSH into a powered-off VM and fail with
    // "VM not reachable over SSH", logging an error-level ops event for a box
    // that is EXPECTED to be unreachable. We must skip it instead.
    const pausedRow = {
      id: "inst-paused",
      user_id: "user-1",
      name: "Dormant",
      status: "running",
      lifecycle_state: "paused",
      backend: "webui",
      provider: "crof",
      api_key_encrypted: "encrypted-provider",
      config: {},
      infrastructure_provider: "proxmox",
      proxmox_vmid: 235,
    };
    mockedSupabaseAdmin.from.mockReturnValue(selectQuery([pausedRow]));

    const response = await POST(request({ instanceIds: ["inst-paused"] }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({ requested: 1, launched: 0, failed: 0, skipped: 1 });
    expect(body.data.results).toEqual([
      {
        id: "inst-paused",
        name: "Dormant",
        success: false,
        skipped: true,
        error: "Instance is paused (idle-swept); resume it to redeploy",
      },
    ]);
    // Skipped BEFORE any IP resolution or SSH redeploy, and with no error log.
    expect(mockedResolveInstanceIpv4).not.toHaveBeenCalled();
    expect(mockedApplyLiveUpdate).not.toHaveBeenCalled();
    const errorLogs = consoleErrorSpy.mock.calls.flat().join(" ");
    expect(errorLogs).not.toContain("webui redeploy launch failed");
  });

  it("does not expose raw launch failures in logs or response payloads", async () => {
    const webuiRow = {
      id: "inst-webui",
      user_id: "user-1",
      name: "Oracle",
      status: "running",
      backend: "webui",
      provider: "crof",
      api_key_encrypted: "encrypted-provider",
      config: {},
    };
    mockedSupabaseAdmin.from.mockReturnValue(selectQuery([webuiRow]));
    mockedApplyLiveUpdate.mockResolvedValueOnce({
      applied: false,
      error: "ssh failed with bearer super-secret-runtime-token",
      initiator: OPERATOR_LIVE_UPDATE,
    });

    const response = await POST(request({ instanceIds: ["inst-webui"] }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.failed).toBe(1);
    expect(body.data.results).toEqual([
      {
        id: "inst-webui",
        name: "Oracle",
        success: false,
        error: "Live redeploy launch failed",
      },
    ]);
    const logs = consoleErrorSpy.mock.calls.flat().join(" ");
    expect(logs).toContain("webui redeploy launch failed");
    expect(logs).not.toContain("super-secret-runtime-token");
  });

  // Prod fixturecase03 (2026-06): an owner-orphaned box, armed for deletion, was
  // "rescued" by a targeted POST. The redeploy SUCCEEDED and rewrote status to
  // 'running' — silently disarming purge-expired, whose only intake is
  // status='scheduled_for_deletion'. The row then sat a month past its deadline.
  // The GET sweep's query deny-list cannot protect this path, so the guard has
  // to live in redeployOne, on the ATTEMPT — both outcomes clobber.
  it.each([
    ["status=scheduled_for_deletion", { status: "scheduled_for_deletion", config: {} }],
    ["config.owner_orphaned (status already clobbered to failed)", { status: "failed", config: { owner_orphaned: true } }],
  ])("skips a box armed for teardown instead of disarming the purge: %s", async (_label, overrides) => {
    mockedSupabaseAdmin.from.mockReturnValue(
      selectQuery([
        {
          id: "inst-orphan",
          user_id: "user_gone",
          name: "MY_FIRST_AGENT",
          backend: "webui",
          gateway_url: "https://orphan.example",
          api_key_encrypted: "key",
          ...overrides,
        },
      ]),
    );

    const response = await POST(request({ instanceIds: ["inst-orphan"] }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.skipped).toBe(1);
    expect(body.data.failed).toBe(0);
    expect(body.data.results[0].error).toContain("scheduled for deletion");
    // The load-bearing assertion: no redeploy attempt => no status rewrite =>
    // the teardown marker survives.
    expect(mockedApplyLiveUpdate).not.toHaveBeenCalled();
  });
});

function getRequest(authorization = "Bearer expected-secret") {
  return new NextRequest("http://localhost/api/cron/redeploy-webui-instances", {
    method: "GET",
    headers: { authorization },
  });
}

function fleetSelectQuery(data: unknown[], error: Error | null = null, stampError: Error | null = null) {
  // Chain: .from().select().in("backend",...).or(...).not("lifecycle_state","in",...)
  //        .neq("status","scheduled_for_deletion").order(...).order(...).limit(...)
  // The same in/or/not/neq prefix also terminates the eligible-count query
  // (`select("id",{count,head})...`), which AWAITS it — so the neq-result must be
  // both chainable (`.order`) and awaitable (thenable resolving `{count}`).
  const limitMock = jest.fn().mockResolvedValue({ data, error });
  const orderMock: jest.Mock = jest.fn(() => ({ order: orderMock, limit: limitMock }));
  const neqResult = {
    order: orderMock,
    then: (resolve: (value: { count: number; error: Error | null }) => unknown) =>
      resolve({ count: data.length, error }),
  };
  const neqMock = jest.fn().mockReturnValue(neqResult);
  const notMock = jest.fn().mockReturnValue({ neq: neqMock });
  const orMock = jest.fn().mockReturnValue({ not: notMock });
  const backendInMock = jest.fn().mockReturnValue({ or: orMock });
  const selectMock = jest.fn().mockReturnValue({ in: backendInMock });
  // `.from()` is shared by the batch select, the eligible-count, AND the
  // fairness-cursor stamp (`update({last_sync_attempt_at}).in("id", ids)`).
  const stampInMock = jest.fn().mockResolvedValue({ error: stampError });
  const updateMock = jest.fn().mockReturnValue({ in: stampInMock });
  return {
    select: selectMock,
    update: updateMock,
    selectMock,
    backendInMock,
    orMock,
    notMock,
    neqMock,
    orderMock,
    limitMock,
    updateMock,
    stampInMock,
  };
}

describe("GET /api/cron/redeploy-webui-instances (scheduled fleet sweep)", () => {
  const originalCronSecret = process.env.CRON_SECRET;
  const mockedSupabaseAdmin = supabaseAdmin as unknown as { from: jest.Mock };
  const mockedClerkClient = clerkClient as jest.MockedFunction<typeof clerkClient>;
  const mockedResolveInstanceIpv4 = resolveInstanceIpv4 as jest.MockedFunction<typeof resolveInstanceIpv4>;
  const mockedApplyLiveUpdate = applyLiveUpdate as jest.MockedFunction<typeof applyLiveUpdate>;
  let consoleErrorSpy: jest.SpyInstance;
  let consoleWarnSpy: jest.SpyInstance;
  let consoleLogSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CRON_SECRET = "expected-secret";
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    consoleLogSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    mockedClerkClient.mockResolvedValue({
      users: {
        getUser: jest.fn().mockResolvedValue({ publicMetadata: { hermes: {} } }),
      },
    } as never);
    mockedResolveInstanceIpv4.mockResolvedValue("10.250.21.55");
    mockedApplyLiveUpdate.mockResolvedValue(launched(FLEET_SYNC));
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleLogSpy.mockRestore();
    if (originalCronSecret === undefined) {
      delete process.env.CRON_SECRET;
    } else {
      process.env.CRON_SECRET = originalCronSecret;
    }
  });

  it("rejects requests with the wrong bearer token", async () => {
    const response = await GET(getRequest("Bearer wrong"));
    expect(response.status).toBe(401);
    expect(mockedApplyLiveUpdate).not.toHaveBeenCalled();
  });

  it("processes all live webui instances returned by the fleet query", async () => {
    const query = fleetSelectQuery([
      {
        id: "inst-a",
        user_id: "user_a",
        name: "agent-a",
        backend: "webui",
        gateway_url: "https://a.example",
        api_key_encrypted: "key-a",
        infrastructure_provider: "proxmox",
        proxmox_vmid: 101,
      },
      {
        id: "inst-b",
        user_id: "user_b",
        name: "agent-b",
        backend: "webui",
        gateway_url: "https://b.example",
        api_key_encrypted: "key-b",
        infrastructure_provider: "proxmox",
        proxmox_vmid: 102,
      },
    ]);
    mockedSupabaseAdmin.from.mockReturnValue(query);

    const response = await GET(getRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.mode).toBe("fleet-sync");
    expect(body.data.requested).toBe(2);
    expect(body.data.launched).toBe(2);
    expect(body.data.failed).toBe(0);
    // Confirms we queried for the right shape — webfree-backend set + active-ish lifecycle.
    expect(query.backendInMock).toHaveBeenCalledWith("backend", ["webui", "gateway"]);
    // Every lifecycle literal we filter on MUST be a member of the column's
    // CHECK vocabulary. The original filter used STATUS words ('running',
    // 'provisioned') that the constraint does not allow, so it silently
    // collapsed to lifecycle_state='active' and starved everything else.
    const orArg = String(query.orMock.mock.calls[0][0]);
    const lifecycleLiterals = (orArg.match(/lifecycle_state\.in\.\(([^)]*)\)/)?.[1] ?? "")
      .split(",")
      .filter(Boolean);
    expect(lifecycleLiterals.length).toBeGreaterThan(0);
    for (const literal of lifecycleLiterals) {
      expect(LIFECYCLE_CHECK_STATES).toContain(literal);
    }
    // 'failed' must be eligible: a dispatch failure stamps lifecycle_state=
    // 'failed', so excluding it EJECTS a box from the sweep permanently.
    expect(lifecycleLiterals).toContain("failed");
    // The status arm rescues boxes whose lifecycle_state drifted...
    expect(orArg).toContain("status.eq.running");
    // ...and the deny-list is what keeps that arm from redeploying a destroyed
    // (cold_archived), mid-deletion or billing-suspended box on a stale status.
    expect(query.notMock).toHaveBeenCalledWith(
      "lifecycle_state",
      "in",
      FLEET_SYNC_SKIP_LIFECYCLE_IN_LIST
    );
    for (const denied of ["deleted", "cold_archived", "deleting", "restoring", "suspended", "paused"]) {
      expect(FLEET_SYNC_SKIP_LIFECYCLE_IN_LIST).toContain(denied);
    }
    // A row armed for teardown must never be selected: the orphan sweep sets
    // status='scheduled_for_deletion' but leaves lifecycle_state='active', so
    // the lifecycle deny-list cannot catch it and a redeploy would rewrite the
    // status — destroying purge-expired's only intake marker.
    expect(query.neqMock).toHaveBeenCalledWith("status", "scheduled_for_deletion");
    // Under-delivery must be visible: launched < eligibleTotal => more ticks needed.
    expect(body.data.eligibleTotal).toBe(2);
    // Sweep advances by least-recently-ATTEMPTED (NULLS FIRST = never-attempted
    // VMs first), id as the deterministic tiebreaker. It must NOT order by
    // last_synced_at: that is only stamped on success, so a permanently-failing
    // box would never advance and would camp the head of the queue forever.
    expect(query.orderMock).toHaveBeenNthCalledWith(1, "last_sync_attempt_at", {
      ascending: true,
      nullsFirst: true,
    });
    expect(query.orderMock).toHaveBeenNthCalledWith(2, "id", { ascending: true });
    expect(query.orderMock).not.toHaveBeenCalledWith("last_synced_at", expect.anything());
    expect(mockedApplyLiveUpdate).toHaveBeenCalledTimes(2);
    // The scheduled sweep is system-initiated, so every update passes the
    // in-flight turn gate instead of recreating mid-turn.
    for (const call of mockedApplyLiveUpdate.mock.calls) {
      expect(call[4]).toEqual({ initiator: FLEET_SYNC });
    }
  });

  it("defers a box with an agent turn in flight: not launched, not failed, requeued first for the next tick", async () => {
    const query = fleetSelectQuery([
      { id: "inst-busy", user_id: "user_a", name: "busy", backend: "gateway", gateway_url: "https://a.example" },
      { id: "inst-idle", user_id: "user_b", name: "idle", backend: "gateway", gateway_url: "https://b.example" },
    ]);
    mockedSupabaseAdmin.from.mockReturnValue(query);
    mockedApplyLiveUpdate.mockImplementation(async (row) =>
      row.id === "inst-busy"
        ? {
            applied: false,
            deferred: true,
            reason: "deferred_busy",
            error: "Deferred: an agent turn is in flight (deferral 1); the next run retries",
            initiator: FLEET_SYNC,
            inFlightGate: busyGate(1),
          }
        : launched(FLEET_SYNC),
    );

    const response = await GET(getRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({ requested: 2, launched: 1, failed: 0, skipped: 0, deferred: 1 });
    expect(body.data.results).toEqual(
      expect.arrayContaining([
        {
          id: "inst-busy",
          name: "busy",
          success: false,
          deferred: true,
          deferrals: 1,
          error: "deferred_busy",
        },
      ]),
    );
    // Both rows were stamped up front; only the deferred one is put back at the
    // head of the queue (NULLS FIRST) so the next tick retries it.
    expect(query.stampInMock).toHaveBeenNthCalledWith(1, "id", ["inst-busy", "inst-idle"]);
    expect(query.updateMock).toHaveBeenCalledWith({ last_sync_attempt_at: null });
    expect(query.stampInMock).toHaveBeenLastCalledWith("id", ["inst-busy"]);
    // A deferral is routine, not a failure: no failure ops event.
    expect(consoleErrorSpy.mock.calls.flat().join(" ")).not.toContain("webui redeploy launch failed");
  });

  it("does not requeue anything when no box was deferred", async () => {
    const query = fleetSelectQuery([
      { id: "inst-a", user_id: "user_a", name: "agent-a", backend: "webui", gateway_url: "https://a.example" },
    ]);
    mockedSupabaseAdmin.from.mockReturnValue(query);

    const response = await GET(getRequest());
    const body = await response.json();

    expect(body.data.deferred).toBe(0);
    expect(query.updateMock).not.toHaveBeenCalledWith({ last_sync_attempt_at: null });
  });

  it("stamps the fairness cursor for every selected row BEFORE redeploying", async () => {
    const query = fleetSelectQuery([
      { id: "inst-a", user_id: "user_a", name: "agent-a", backend: "webui", gateway_url: "https://a.example" },
      { id: "inst-b", user_id: "user_b", name: "agent-b", backend: "webui", gateway_url: "https://b.example" },
    ]);
    mockedSupabaseAdmin.from.mockReturnValue(query);
    const callOrder: string[] = [];
    query.stampInMock.mockImplementation(async () => {
      callOrder.push("stamp");
      return { error: null };
    });
    mockedApplyLiveUpdate.mockImplementation(async () => {
      callOrder.push("redeploy");
      return launched(FLEET_SYNC);
    });

    await GET(getRequest());

    expect(query.updateMock).toHaveBeenCalledWith({
      last_sync_attempt_at: expect.any(String),
    });
    // Every row the tick SELECTED is stamped — not just the ones that succeed.
    expect(query.stampInMock).toHaveBeenCalledWith("id", ["inst-a", "inst-b"]);
    // Ordering is load-bearing: stamping up-front means a tick killed at the
    // 300s ceiling still rotates the queue instead of re-selecting the same head.
    expect(callOrder).toEqual(["stamp", "redeploy", "redeploy"]);
  });

  it("advances the fairness cursor even when every redeploy FAILS (the starvation fix)", async () => {
    // The exact prod shape: rows that fail every tick. Pre-fix they kept their
    // old last_synced_at, re-sorted to the front, and held the batch forever.
    const query = fleetSelectQuery([
      { id: "dead-1", user_id: "user_a", name: "MY_FIRST_AGENT", backend: "webui", gateway_url: "https://a.example" },
      { id: "dead-2", user_id: "user_b", name: "Kappy", backend: "webui", gateway_url: "https://b.example" },
    ]);
    mockedSupabaseAdmin.from.mockReturnValue(query);
    mockedApplyLiveUpdate.mockResolvedValue({ applied: false, error: "VM not reachable over SSH" } as never);

    const response = await GET(getRequest());
    const body = await response.json();

    expect(body.data.failed).toBe(2);
    expect(body.data.launched).toBe(0);
    // The whole point: a total-failure tick STILL rotates the queue, so these
    // two go to the back and healthy boxes get the slots next tick.
    expect(query.stampInMock).toHaveBeenCalledWith("id", ["dead-1", "dead-2"]);
    expect(response.status).toBe(200);
  });

  it("keeps sweeping when the fairness-cursor stamp fails", async () => {
    // Degrades to the old re-roll-the-same-cohort behaviour rather than
    // abandoning a tick's redeploys; must be loud, not silent.
    const query = fleetSelectQuery(
      [{ id: "inst-a", user_id: "user_a", name: "agent-a", backend: "webui", gateway_url: "https://a.example" }],
      null,
      new Error("stamp exploded"),
    );
    mockedSupabaseAdmin.from.mockReturnValue(query);

    const response = await GET(getRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.launched).toBe(1);
    expect(consoleErrorSpy.mock.calls.flat().join(" ")).toContain(
      "fleet-sync attempt-cursor stamp failed",
    );
  });

  it("returns an empty result set when no live instances are returned", async () => {
    const query = fleetSelectQuery([]);
    mockedSupabaseAdmin.from.mockReturnValue(query);

    const response = await GET(getRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.mode).toBe("fleet-sync");
    expect(body.data.requested).toBe(0);
    expect(body.data.results).toEqual([]);
    expect(mockedApplyLiveUpdate).not.toHaveBeenCalled();
  });
});
