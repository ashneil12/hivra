import { runRecoverUnhealthyActiveInstancesSweep } from "../recover-unhealthy-active-instances";
import { fetchFirstReachableGatewayResponse } from "@/lib/agent-gateway";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import {
  applyLiveUpdate,
  resolveInstanceIpv4,
} from "@/lib/services/instance-orchestrator";
import { getProxmoxInstanceStatus } from "@/lib/services/proxmox-instance-service";
import { supabaseAdmin } from "@/lib/supabase";
import { recoverProxmoxInstanceAcrossFleet } from "@/lib/recovery/recover-orphan-provisioning";

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

jest.mock("@/lib/agent-gateway", () => ({
  fetchFirstReachableGatewayResponse: jest.fn(),
}));

jest.mock("@/lib/services/instance-orchestrator", () => ({
  applyLiveUpdate: jest.fn(),
  resolveInstanceIpv4: jest.fn(),
}));

jest.mock("@/lib/clerk-hermes-settings", () => ({
  loadGlobalHermesSettingsForUser: jest.fn().mockResolvedValue({}),
}));

jest.mock("@/lib/ops-events", () => ({
  reportOpsEvent: jest.fn().mockResolvedValue({ id: "evt-1", fingerprint: "fp" }),
}));

// Keep the pure helpers real (getProxmoxInfrastructure / stripProxmoxInfrastructure)
// and only stub the SSH-backed liveness probe.
jest.mock("@/lib/services/proxmox-instance-service", () => {
  const actual = jest.requireActual("@/lib/services/proxmox-instance-service");
  return {
    ...actual,
    getProxmoxInstanceStatus: jest.fn(),
  };
});

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/recovery/recover-orphan-provisioning", () => ({
  recoverProxmoxInstanceAcrossFleet: jest.fn(),
}));

const mockedProbe = fetchFirstReachableGatewayResponse as jest.Mock;
const mockedApplyLiveUpdate = applyLiveUpdate as jest.Mock;
const mockedResolveIpv4 = resolveInstanceIpv4 as jest.Mock;
const mockedReportOpsEvent = reportOpsEvent as jest.Mock;

type RowOverrides = Partial<{
  id: string;
  user_id: string;
  provider: string;
  name: string | null;
  status: string | null;
  lifecycle_state: string | null;
  backend: string | null;
  subdomain: string | null;
  hetzner_server_id: number | null;
  gateway_url: string;
  api_key_encrypted: string;
  api_server_key_encrypted: string | null;
  honcho_api_key_encrypted: string | null;
  config: Record<string, unknown> | null;
  host_id: string | null;
  proxmox_node: string | null;
  ipv4_address: string | null;
  cpu_limit: number;
  ram_limit: number;
  entitlement_state: string | null;
  scheduled_deletion_at: string | null;
  deleted_at: string | null;
  last_auto_restart_at: string | null;
  auto_restart_attempts: number | null;
}>;

function buildRow(overrides: RowOverrides = {}) {
  return {
    id: "inst-1",
    user_id: "user-1",
    provider: "anthropic",
    name: "agent-1",
    status: "running",
    lifecycle_state: "active",
    backend: "webui",
    subdomain: null,
    hetzner_server_id: null,
    gateway_url: "https://inst1.agents.hermesos.cloud",
    api_key_encrypted: "encrypted",
    api_server_key_encrypted: null,
    honcho_api_key_encrypted: null,
    config: {},
    host_id: "host-1",
    proxmox_node: "fixturenode6",
    ipv4_address: "10.240.0.1",
    cpu_limit: 1,
    ram_limit: 2048,
    entitlement_state: "ok",
    scheduled_deletion_at: null,
    deleted_at: null,
    last_auto_restart_at: null,
    auto_restart_attempts: 0,
    ...overrides,
  };
}

interface EventRow {
  instance_id: string;
  first_seen_at: string;
}

interface UpdateCall {
  table: string;
  patch: Record<string, unknown>;
  whereId: string;
}

function mockSupabase({
  events,
  rows,
  updateCalls,
  archiveCalls,
  selectInCalls,
  rowsError,
  eventsError,
}: {
  events: EventRow[];
  rows: ReturnType<typeof buildRow>[];
  updateCalls?: UpdateCall[];
  archiveCalls?: Array<{ patch: Record<string, unknown>; instanceIds: string[] }>;
  selectInCalls?: string[][];
  rowsError?: string;
  eventsError?: string;
}) {
  (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
    if (table === "ops_events") {
      return {
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            is: jest.fn().mockReturnValue({
              lt: jest.fn().mockReturnValue({
                not: jest.fn().mockResolvedValue(
                  eventsError
                    ? { data: null, error: { message: eventsError } }
                    : { data: events, error: null },
                ),
              }),
            }),
          }),
        }),
        update: jest.fn().mockImplementation((patch: Record<string, unknown>) => ({
          eq: jest.fn().mockReturnValue({
            is: jest.fn().mockReturnValue({
              in: jest.fn().mockImplementation((_col: string, instanceIds: string[]) => ({
                select: jest.fn().mockImplementation(() => {
                  archiveCalls?.push({ patch, instanceIds });
                  return Promise.resolve({
                    data: instanceIds.map((id) => ({ id: `event-${id}` })),
                    error: null,
                  });
                }),
              })),
            }),
          }),
        })),
      };
    }
    if (table === "hermes_instances") {
      return {
        select: jest.fn().mockReturnValue({
          in: jest.fn().mockImplementation((_col: string, ids: string[]) => {
            selectInCalls?.push(ids);
            return {
              eq: jest.fn().mockReturnValue({
                eq: jest.fn().mockReturnValue({
                  // Post gateway≡webfree collapse the backend filter is
                  // `.in("backend", WEBFREE_BACKENDS)` (was `.eq("backend","webui")`).
                  in: jest.fn().mockReturnValue({
                    not: jest.fn().mockReturnValue({
                      is: jest.fn().mockReturnValue({
                        is: jest.fn().mockResolvedValue(
                          rowsError
                            ? { data: null, error: { message: rowsError } }
                            : { data: rows, error: null },
                        ),
                      }),
                    }),
                  }),
                }),
              }),
            };
          }),
        }),
        update: jest.fn().mockImplementation((patch: Record<string, unknown>) => ({
          eq: jest.fn().mockImplementation((_col: string, whereId: string) => {
            updateCalls?.push({ table: "hermes_instances", patch, whereId });
            return Promise.resolve({ error: null });
          }),
        })),
      };
    }
    throw new Error(`Unexpected table: ${table}`);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  (recoverProxmoxInstanceAcrossFleet as jest.Mock).mockResolvedValue({ status: "gone" });
  mockedResolveIpv4.mockResolvedValue("10.240.0.1");
  mockedApplyLiveUpdate.mockResolvedValue({ applied: true });
});

describe("runRecoverUnhealthyActiveInstancesSweep", () => {
  it("returns 0 candidates when no qualifying ops_events exist", async () => {
    mockSupabase({ events: [], rows: [] });

    const summary = await runRecoverUnhealthyActiveInstancesSweep();

    expect(summary.candidates).toBe(0);
    expect(summary.redeployAttempted).toBe(0);
    expect(mockedApplyLiveUpdate).not.toHaveBeenCalled();
  });

  it("redeploys when probe re-confirms unhealthy and attempts < cap", async () => {
    // 2026-05-18 incident: instance silently down for days while still
    // tagged active/running. The synthetic.instance-health event flagged
    // it; this sweep auto-redeploys via applyLiveUpdate.
    const longAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const updateCalls: UpdateCall[] = [];
    mockSupabase({
      events: [{ instance_id: "inst-1", first_seen_at: longAgo }],
      rows: [buildRow()],
      updateCalls,
    });
    mockedProbe.mockResolvedValue({
      response: { ok: false, status: 521, text: async () => "" },
      url: "https://inst1.agents.hermesos.cloud/health",
    });

    const summary = await runRecoverUnhealthyActiveInstancesSweep();

    expect(summary.candidates).toBe(1);
    expect(summary.redeployAttempted).toBe(1);
    expect(summary.alreadyHealthy).toBe(0);
    expect(summary.exhausted).toBe(0);
    expect(mockedApplyLiveUpdate).toHaveBeenCalledTimes(1);
    // Bookkeeping write: bumped counter + stamped last_auto_restart_at.
    const bookkeeping = updateCalls.find(
      (call) => call.patch.auto_restart_attempts === 1,
    );
    expect(bookkeeping).toBeDefined();
    expect(bookkeeping!.patch.last_auto_restart_at).toEqual(expect.any(String));
  });

  it("releases a row (no redeploy) when its Proxmox VM is gone, so the recreate cron picks it up", async () => {
    // The Phase-2 cleanup trap destroyed the VM, so an SSH redeploy can
    // never succeed — looping it would just burn the attempt cap and page
    // an operator while the row stays 'running' forever, invisible to
    // recover-missing-vm-instances. Instead release the row (error + null
    // proxmox_vmid + infrastructureReleased marker) so the recreate cron
    // rebuilds it on a healthy host.
    const longAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const updateCalls: UpdateCall[] = [];
    mockSupabase({
      events: [{ instance_id: "inst-1", first_seen_at: longAgo }],
      rows: [
        buildRow({
          config: {
            infrastructure: {
              provider: "proxmox",
              vmid: 777,
              privateIpv4: "10.240.0.1",
              gatewayHost: "inst1.agents.hermesos.cloud",
            },
          },
        }),
      ],
      updateCalls,
    });
    // Probe is unhealthy (VM gone), then qm status reports the VM missing.
    mockedProbe.mockResolvedValue({
      response: { ok: false, status: 521, text: async () => "" },
      url: "https://inst1.agents.hermesos.cloud/health",
    });
    (getProxmoxInstanceStatus as jest.Mock).mockResolvedValue({
      status: "stopped",
      vmMissing: true,
    });

    const summary = await runRecoverUnhealthyActiveInstancesSweep();

    expect(summary.vmReleased).toBe(1);
    expect(summary.redeployAttempted).toBe(0);
    expect(summary.redeployFailed).toBe(0);
    expect(summary.exhausted).toBe(0);
    // No SSH redeploy and no fatal exhausted alert against a dead VM.
    expect(mockedApplyLiveUpdate).not.toHaveBeenCalled();
    expect(mockedReportOpsEvent).not.toHaveBeenCalled();

    const releasePatch = updateCalls.find((call) => call.patch.status === "error");
    expect(releasePatch).toBeDefined();
    expect(releasePatch!.whereId).toBe("inst-1");
    expect(releasePatch!.patch.proxmox_vmid).toBeNull();
    const releasedConfig = releasePatch!.patch.config as {
      infrastructure?: unknown;
      infrastructureReleased?: { reason?: string; at?: string };
    };
    expect(releasedConfig.infrastructure).toBeUndefined();
    expect(releasedConfig.infrastructureReleased?.reason).toBe(
      "vm_missing_across_fleet"
    );
  });

  it("skips when the re-probe shows the instance has self-recovered", async () => {
    // ops_events rows aren't deleted on success — they stay around with
    // archived_at=null until the user archives. So a healthy probe means
    // the instance recovered between the last health-sweep tick and ours.
    const longAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const archiveCalls: Array<{
      patch: Record<string, unknown>;
      instanceIds: string[];
    }> = [];
    mockSupabase({
      events: [{ instance_id: "inst-1", first_seen_at: longAgo }],
      rows: [buildRow()],
      archiveCalls,
    });
    mockedProbe.mockResolvedValue({
      response: { ok: true, text: async () => "" },
      url: "https://inst1.agents.hermesos.cloud/health",
    });

    const summary = await runRecoverUnhealthyActiveInstancesSweep();

    expect(summary.candidates).toBe(1);
    expect(summary.alreadyHealthy).toBe(1);
    expect(summary.redeployAttempted).toBe(0);
    expect(mockedApplyLiveUpdate).not.toHaveBeenCalled();

    // The healed instance's open health event must be archived so the
    // open-event backlog can't grow without bound (the 2026-06-10
    // URL-overflow incident).
    expect(summary.archivedHealthy).toBe(1);
    expect(archiveCalls).toHaveLength(1);
    expect(archiveCalls[0].instanceIds).toEqual(["inst-1"]);
    expect(archiveCalls[0].patch).toHaveProperty("archived_at");
  });

  it("respects the cooldown after a recent auto-restart", async () => {
    const longAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const recentRestart = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    mockSupabase({
      events: [{ instance_id: "inst-1", first_seen_at: longAgo }],
      rows: [
        buildRow({
          last_auto_restart_at: recentRestart,
          auto_restart_attempts: 1,
        }),
      ],
    });
    mockedProbe.mockResolvedValue({
      response: { ok: false, status: 521, text: async () => "" },
      url: "https://inst1.agents.hermesos.cloud/health",
    });

    const summary = await runRecoverUnhealthyActiveInstancesSweep();

    expect(summary.cooldownSkipped).toBe(1);
    expect(summary.redeployAttempted).toBe(0);
    expect(mockedApplyLiveUpdate).not.toHaveBeenCalled();
  });

  it("emits a fatal ops_event and stops attempting after the cap", async () => {
    const longAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    mockSupabase({
      events: [{ instance_id: "inst-1", first_seen_at: longAgo }],
      rows: [buildRow({ auto_restart_attempts: 3 })],
    });
    mockedProbe.mockResolvedValue({
      response: { ok: false, status: 521, text: async () => "" },
      url: "https://inst1.agents.hermesos.cloud/health",
    });

    const summary = await runRecoverUnhealthyActiveInstancesSweep();

    expect(summary.exhausted).toBe(1);
    expect(summary.redeployAttempted).toBe(0);
    expect(mockedApplyLiveUpdate).not.toHaveBeenCalled();
    expect(mockedReportOpsEvent).toHaveBeenCalledTimes(1);
    const [reportInput] = mockedReportOpsEvent.mock.calls[0];
    expect(reportInput).toMatchObject({
      source: "synthetic.auto-repair-exhausted",
      severity: "fatal",
      instanceId: "inst-1",
      userId: "user-1",
      metadata: expect.objectContaining({
        failureType: "auto_repair_exhausted",
        recoveryAction: "repair_runtime",
      }),
    });
  });

  it("bumps the counter when applyLiveUpdate fails to launch", async () => {
    const longAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const updateCalls: UpdateCall[] = [];
    mockSupabase({
      events: [{ instance_id: "inst-1", first_seen_at: longAgo }],
      rows: [buildRow()],
      updateCalls,
    });
    mockedProbe.mockResolvedValue({
      response: { ok: false, status: 521, text: async () => "" },
      url: "https://inst1.agents.hermesos.cloud/health",
    });
    mockedApplyLiveUpdate.mockResolvedValue({
      applied: false,
      error: "ssh: connection refused",
    });

    const summary = await runRecoverUnhealthyActiveInstancesSweep();

    expect(summary.redeployFailed).toBe(1);
    expect(summary.redeployAttempted).toBe(0);
    // Counter still got bumped so the cooldown engages.
    const bookkeeping = updateCalls.find(
      (call) => call.patch.auto_restart_attempts === 1,
    );
    expect(bookkeeping).toBeDefined();
    expect(bookkeeping!.patch.last_auto_restart_at).toEqual(expect.any(String));
  });

  it("skips suspended entitlement states", async () => {
    const longAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    mockSupabase({
      events: [{ instance_id: "inst-1", first_seen_at: longAgo }],
      rows: [buildRow({ entitlement_state: "suspended" })],
    });
    mockedProbe.mockResolvedValue({
      response: { ok: false, status: 521, text: async () => "" },
      url: "https://inst1.agents.hermesos.cloud/health",
    });

    const summary = await runRecoverUnhealthyActiveInstancesSweep();

    expect(summary.candidates).toBe(0);
    expect(mockedApplyLiveUpdate).not.toHaveBeenCalled();
  });

  it("skips paused entitlement states", async () => {
    const longAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    mockSupabase({
      events: [{ instance_id: "inst-1", first_seen_at: longAgo }],
      rows: [buildRow({ entitlement_state: "paused" })],
    });
    mockedProbe.mockResolvedValue({
      response: { ok: false, status: 521, text: async () => "" },
      url: "https://inst1.agents.hermesos.cloud/health",
    });

    const summary = await runRecoverUnhealthyActiveInstancesSweep();

    expect(summary.candidates).toBe(0);
    expect(mockedApplyLiveUpdate).not.toHaveBeenCalled();
  });

  it("repairs longest-broken instances first when the per-run cap bites", async () => {
    // 6 candidates, MAX_REPAIRS_PER_RUN=5 — the oldest 5 should be picked.
    const baseMs = Date.now() - 3 * 60 * 60 * 1000;
    const events: EventRow[] = [];
    const rows: ReturnType<typeof buildRow>[] = [];
    for (let i = 0; i < 6; i += 1) {
      const id = `inst-${i}`;
      events.push({
        instance_id: id,
        first_seen_at: new Date(baseMs - i * 60_000).toISOString(),
      });
      rows.push(buildRow({ id, ipv4_address: `10.240.0.${i + 1}` }));
    }
    mockSupabase({ events, rows });
    mockedProbe.mockResolvedValue({
      response: { ok: false, status: 521, text: async () => "" },
      url: "https://inst.agents.hermesos.cloud/health",
    });

    const summary = await runRecoverUnhealthyActiveInstancesSweep();

    expect(summary.candidates).toBe(6);
    expect(summary.redeployAttempted).toBe(5);
    // Oldest-first ordering: inst-5 has firstUnhealthyAt = baseMs - 5min
    // (earliest), inst-0 = baseMs (latest). So inst-0 is the one skipped.
    const repairedIds = mockedApplyLiveUpdate.mock.calls.map(
      (call: unknown[]) =>
        (call[0] as { id: string }).id,
    );
    expect(repairedIds).toContain("inst-5");
    expect(repairedIds).not.toContain("inst-0");
  });

  it("emits a structured summary when candidates exist", async () => {
    const longAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    mockSupabase({
      events: [{ instance_id: "inst-1", first_seen_at: longAgo }],
      rows: [buildRow()],
    });
    mockedProbe.mockResolvedValue({
      response: { ok: true, text: async () => "" },
      url: "https://inst1.agents.hermesos.cloud/health",
    });

    await runRecoverUnhealthyActiveInstancesSweep();

    const infoCalls = (log.info as jest.Mock).mock.calls;
    const summary = infoCalls.find(
      ([msg]: [string]) => msg === "recover-unhealthy-active sweep summary",
    );
    expect(summary).toBeDefined();
    expect(summary![1]).toMatchObject({
      source: "recover-unhealthy-active-instances",
      candidates: 1,
      alreadyHealthy: 1,
      archivedHealthy: 1,
    });
  });

  it("chunks the instance-row lookup so a large event backlog cannot overflow the query URL", async () => {
    // Regression for the 2026-06-10 incident: 964 open health events made
    // the single .in("id", [...]) query string exceed the PostgREST URL
    // limit, the query 400'd, and the cron died fleet-wide every tick.
    const longAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const events = Array.from({ length: 250 }, (_, i) => ({
      instance_id: `inst-${i}`,
      first_seen_at: longAgo,
    }));
    const selectInCalls: string[][] = [];
    mockSupabase({ events, rows: [], selectInCalls });

    const summary = await runRecoverUnhealthyActiveInstancesSweep();

    expect(summary.candidates).toBe(0);
    expect(selectInCalls).toHaveLength(3);
    for (const ids of selectInCalls) {
      expect(ids.length).toBeLessThanOrEqual(100);
    }
    expect(selectInCalls.flat()).toHaveLength(250);
  });

  it("anchors first-unhealthy on the EARLIEST event per instance", async () => {
    // If multiple ops_events rows exist for the same instance (e.g. the
    // gateway_url changed between outages and produced new fingerprints),
    // the cumulative outage is anchored on the earliest first_seen_at.
    const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const twoHoursAgo = new Date(Date.now() - 2.5 * 60 * 60 * 1000).toISOString();
    mockSupabase({
      events: [
        { instance_id: "inst-1", first_seen_at: twoHoursAgo },
        { instance_id: "inst-1", first_seen_at: sixHoursAgo },
      ],
      rows: [buildRow({ auto_restart_attempts: 3 })],
    });
    mockedProbe.mockResolvedValue({
      response: { ok: false, status: 521, text: async () => "" },
      url: "https://inst1.agents.hermesos.cloud/health",
    });

    await runRecoverUnhealthyActiveInstancesSweep();

    // The exhausted event should carry the EARLIEST first_seen_at.
    expect(mockedReportOpsEvent).toHaveBeenCalledTimes(1);
    const [reportInput] = mockedReportOpsEvent.mock.calls[0];
    expect(reportInput.metadata.firstUnhealthyAt).toBe(sixHoursAgo);
  });

  it("propagates ops_events query errors", async () => {
    mockSupabase({
      events: [],
      rows: [],
      eventsError: "ops_events table unreachable",
    });

    await expect(runRecoverUnhealthyActiveInstancesSweep()).rejects.toThrow(
      /ops_events table unreachable/,
    );
  });

  it("propagates hermes_instances query errors", async () => {
    const longAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    mockSupabase({
      events: [{ instance_id: "inst-1", first_seen_at: longAgo }],
      rows: [],
      rowsError: "hermes_instances unreachable",
    });

    await expect(runRecoverUnhealthyActiveInstancesSweep()).rejects.toThrow(
      /hermes_instances unreachable/,
    );
  });
});
