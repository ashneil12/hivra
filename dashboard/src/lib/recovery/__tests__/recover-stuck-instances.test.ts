import {
  runRecoverStuckInstancesSweep,
  runRecoverStuckRestoringSweep,
} from "../recover-stuck-instances";
import { fetchFirstReachableGatewayResponse } from "@/lib/agent-gateway";
import { log } from "@/lib/logger";
import {
  startProxmoxInstance,
  isProxmoxVmMissingResult,
} from "@/lib/services/proxmox-instance-service";
import { supabaseAdmin } from "@/lib/supabase";

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

jest.mock("@/lib/agent-gateway", () => ({
  fetchFirstReachableGatewayResponse: jest.fn(),
}));

jest.mock("@/lib/services/proxmox-instance-service", () => ({
  startProxmoxInstance: jest.fn(),
  isProxmoxVmMissingResult: jest.fn(),
  getProxmoxHostRoutingConfigFromInfrastructure: jest.fn().mockReturnValue(null),
}));

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/crypto", () => ({
  decryptApiKey: jest.fn((value: string) => value),
}));

// The post-ready SOUL.md seed hook fires per recovered row; the sweep only
// depends on its never-throws contract, so stub it out entirely.
jest.mock("@/lib/recovery/soul-seed-reconcile", () => ({
  reconcileSoulSeedAfterReady: jest.fn().mockResolvedValue(null),
}));

import { reconcileSoulSeedAfterReady } from "@/lib/recovery/soul-seed-reconcile";

const mockedSoulSeedAfterReady = reconcileSoulSeedAfterReady as jest.Mock;
const mockedProbe = fetchFirstReachableGatewayResponse as jest.Mock;
const mockedStart = startProxmoxInstance as jest.Mock;
const mockedVmMissing = isProxmoxVmMissingResult as jest.Mock;

type RowOverrides = Partial<{
  id: string;
  user_id: string;
  host_id: string | null;
  proxmox_vmid: number | null;
  proxmox_node: string | null;
  gateway_url: string;
  ipv4_address: string | null;
  status: string | null;
  lifecycle_state: string | null;
  backend: string | null;
  api_server_key_encrypted: string | null;
  created_at: string;
  last_auto_restart_at: string | null;
  auto_restart_attempts: number | null;
}>;

function buildRow(overrides: RowOverrides = {}) {
  return {
    id: "inst-1",
    user_id: "user-1",
    host_id: "host-1",
    proxmox_vmid: 9100,
    proxmox_node: "fixturenode1",
    gateway_url: "https://example.gateway",
    ipv4_address: "10.240.0.1",
    status: "error",
    lifecycle_state: "failed",
    backend: null,
    api_server_key_encrypted: null,
    created_at: "2026-05-09T00:00:00.000Z",
    last_auto_restart_at: null,
    auto_restart_attempts: 0,
    ...overrides,
  };
}

function mockSupabaseSelect(rows: ReturnType<typeof buildRow>[]) {
  // SELECT chain shape: .or(filter).not(...).lt(...).is(...).is(...)
  // UPDATE chain shape:
  //   recovered path → .update(...).eq("id", id).or(filter)         → terminal
  //   auto-restart   → .update(...).eq("id", id)                    → terminal (awaited directly)
  // So .eq() must return a thenable that ALSO exposes .or() for the recovered branch.
  (supabaseAdmin!.from as jest.Mock).mockImplementation(() => {
    return {
      select: jest.fn().mockReturnValue({
        or: jest.fn().mockReturnValue({
          not: jest.fn().mockReturnValue({
            lt: jest.fn().mockReturnValue({
              is: jest.fn().mockReturnValue({
                is: jest.fn().mockResolvedValue({ data: rows, error: null }),
              }),
            }),
          }),
        }),
      }),
      update: jest.fn().mockImplementation(() => ({
        eq: jest.fn().mockImplementation(() => {
          const terminal = Promise.resolve({ error: null });
          return Object.assign(terminal, {
            or: jest.fn().mockResolvedValue({ error: null }),
          });
        }),
      })),
    };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedVmMissing.mockReturnValue(false);
});

describe("runRecoverStuckInstancesSweep", () => {
  it("probes gateway-backend rows over the bearer-authed chat lane, not /health", async () => {
    // '/health' answers from the official-dashboard shell before the gateway
    // that answers chat is up; this sweep's 90s grace + 2-min cadence would
    // otherwise promote a fresh box mid-window (see buildStuckProbeTarget).
    mockSupabaseSelect([
      buildRow({
        backend: "gateway",
        api_server_key_encrypted: "chat-lane-secret",
        lifecycle_state: "provisioning",
      }),
    ]);
    mockedProbe.mockResolvedValue({
      response: { ok: true, text: async () => "[]" },
    });

    const summary = await runRecoverStuckInstancesSweep();

    expect(summary.recovered).toBe(1);
    expect(mockedProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: "/api/sessions",
        headers: { Authorization: "Bearer chat-lane-secret" },
      })
    );
  });

  it("keeps the public /health probe for rows without a gateway backend or key", async () => {
    mockSupabaseSelect([buildRow()]);
    mockedProbe.mockResolvedValue({
      response: { ok: true, text: async () => "" },
    });

    await runRecoverStuckInstancesSweep();

    expect(mockedProbe).toHaveBeenCalledWith(
      expect.objectContaining({ pathname: "/health" })
    );
    expect(mockedProbe.mock.calls[0][0].headers).toBeUndefined();
  });

  it("flips healthy probes to running and resets the restart counter", async () => {
    mockSupabaseSelect([buildRow({ auto_restart_attempts: 2 })]);
    mockedProbe.mockResolvedValue({
      response: { ok: true, text: async () => "" },
    });

    const summary = await runRecoverStuckInstancesSweep();

    expect(summary.recovered).toBe(1);
    expect(summary.restartAttempted).toBe(0);
    expect(summary.stillUnreachable).toBe(0);
    expect(mockedStart).not.toHaveBeenCalled();
    // The promotion is the first observed readiness of a slow provision — the
    // exact moment the in-band SOUL.md seed has already lost its race to the
    // agent's factory-default write. The sweep must fire the post-ready
    // reconcile for the recovered row.
    expect(mockedSoulSeedAfterReady).toHaveBeenCalledTimes(1);
    expect(mockedSoulSeedAfterReady).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: "inst-1",
        trigger: "recover_stuck_promote",
      }),
    );
  });

  it("does NOT fire the post-ready soul seed when nothing was recovered", async () => {
    mockSupabaseSelect([buildRow()]);
    mockedProbe.mockResolvedValue({
      response: { ok: false, text: async () => "" },
    });
    mockedStart.mockResolvedValue({ ok: true, stdout: "started", stderr: "" });

    const summary = await runRecoverStuckInstancesSweep();

    expect(summary.recovered).toBe(0);
    expect(mockedSoulSeedAfterReady).not.toHaveBeenCalled();
  });

  it("recovers rows stuck at status=redeploying even when lifecycle_state still says active", async () => {
    // Regression for 2026-05-17 incident: the fleet-sync cron used to write
    // only `status` and leave lifecycle_state="active", so the older
    // lifecycle-only filter missed them entirely. The widened OR filter
    // catches status='redeploying' independently of lifecycle_state, and
    // a successful /health probe flips them back to running.
    mockSupabaseSelect([
      buildRow({
        status: "redeploying",
        lifecycle_state: "active",
        auto_restart_attempts: 0,
      }),
    ]);
    mockedProbe.mockResolvedValue({
      response: { ok: true, text: async () => "" },
    });

    const summary = await runRecoverStuckInstancesSweep();

    expect(summary.recovered).toBe(1);
    expect(summary.restartAttempted).toBe(0);
  });

  it("recovers Hetzner-backed rows too (no infrastructure_provider gating)", async () => {
    // Code B drops the proxmox-only SQL filter; auto-restart still gates
    // on proxmox_vmid + proxmox_node so Hetzner rows correctly skip qm start.
    mockSupabaseSelect([
      buildRow({
        proxmox_vmid: null,
        proxmox_node: null,
        status: "redeploying",
        lifecycle_state: "active",
      }),
    ]);
    mockedProbe.mockResolvedValue({
      response: { ok: true, text: async () => "" },
    });

    const summary = await runRecoverStuckInstancesSweep();

    expect(summary.recovered).toBe(1);
    expect(mockedStart).not.toHaveBeenCalled();
  });

  it("attempts auto-restart for failed rows with unreachable gateway", async () => {
    mockSupabaseSelect([buildRow()]);
    mockedProbe.mockResolvedValue({
      response: { ok: false, text: async () => "" },
    });
    mockedStart.mockResolvedValue({ ok: true, stdout: "started", stderr: "" });

    const summary = await runRecoverStuckInstancesSweep();

    expect(summary.stillUnreachable).toBe(1);
    expect(summary.restartAttempted).toBe(1);
    expect(summary.recovered).toBe(0);
    expect(mockedStart).toHaveBeenCalledWith(
      { vmid: 9100, node: "fixturenode1" },
      expect.objectContaining({ hostConfig: null }),
    );
  });

  it("does NOT restart fresh provisioning rows even when probe fails", async () => {
    // Phase 2 bootstrap takes 3-7 min; rows in their first ~15 min are
    // legitimately still booting and must not be restarted.
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    mockSupabaseSelect([
      buildRow({
        lifecycle_state: "provisioning",
        status: "provisioning",
        created_at: fiveMinAgo,
      }),
    ]);
    mockedProbe.mockResolvedValue({
      response: { ok: false, text: async () => "" },
    });

    const summary = await runRecoverStuckInstancesSweep();

    expect(summary.stillUnreachable).toBe(1);
    expect(summary.restartAttempted).toBe(0);
    expect(mockedStart).not.toHaveBeenCalled();
  });

  it("restarts stale provisioning rows older than the 15-minute Phase 2 budget", async () => {
    // Regression: observed 2026-05-11 with fixturenodea holding multiple
    // 30+ min provisioning rows that never moved without manual
    // intervention. Past 15 min the gateway probe has had 7+ tries
    // already; if it's still provisioning, the qm-start path must
    // take over so the user isn't stranded forever.
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    mockSupabaseSelect([
      buildRow({
        lifecycle_state: "provisioning",
        status: "provisioning",
        created_at: thirtyMinAgo,
      }),
    ]);
    mockedProbe.mockResolvedValue({
      response: { ok: false, text: async () => "" },
    });
    mockedStart.mockResolvedValue({ ok: true, stdout: "started", stderr: "" });

    const summary = await runRecoverStuckInstancesSweep();

    expect(summary.restartAttempted).toBe(1);
    expect(summary.stillUnreachable).toBe(1);
    expect(mockedStart).toHaveBeenCalledTimes(1);
  });

  it("respects MAX_AUTO_RESTART_ATTEMPTS cap", async () => {
    mockSupabaseSelect([buildRow({ auto_restart_attempts: 3 })]);
    mockedProbe.mockResolvedValue({
      response: { ok: false, text: async () => "" },
    });

    const summary = await runRecoverStuckInstancesSweep();

    expect(summary.stillUnreachable).toBe(1);
    expect(summary.restartAttempted).toBe(0);
    expect(mockedStart).not.toHaveBeenCalled();
  });

  it("respects the 15-minute cooldown between restart attempts", async () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    mockSupabaseSelect([
      buildRow({ last_auto_restart_at: fiveMinAgo, auto_restart_attempts: 1 }),
    ]);
    mockedProbe.mockResolvedValue({
      response: { ok: false, text: async () => "" },
    });

    const summary = await runRecoverStuckInstancesSweep();

    expect(summary.restartAttempted).toBe(0);
    expect(mockedStart).not.toHaveBeenCalled();
  });

  it("attempts restart again once cooldown has elapsed", async () => {
    const twentyMinAgo = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    mockSupabaseSelect([
      buildRow({ last_auto_restart_at: twentyMinAgo, auto_restart_attempts: 1 }),
    ]);
    mockedProbe.mockResolvedValue({
      response: { ok: false, text: async () => "" },
    });
    mockedStart.mockResolvedValue({ ok: true, stdout: "started", stderr: "" });

    const summary = await runRecoverStuckInstancesSweep();

    expect(summary.restartAttempted).toBe(1);
    expect(mockedStart).toHaveBeenCalledTimes(1);
  });

  it("flips to error and caps attempts when the VM no longer exists", async () => {
    mockSupabaseSelect([buildRow()]);
    mockedProbe.mockResolvedValue({
      response: { ok: false, text: async () => "" },
    });
    mockedStart.mockResolvedValue({
      ok: false,
      stdout: "",
      stderr: "VM 9100 not found",
    });
    mockedVmMissing.mockReturnValue(true);

    const summary = await runRecoverStuckInstancesSweep();

    expect(summary.restartFailed).toBe(1);
    expect(summary.restartAttempted).toBe(0);
  });

  it("counts a Proxmox host failure as restartFailed without flipping state", async () => {
    mockSupabaseSelect([buildRow()]);
    mockedProbe.mockResolvedValue({
      response: { ok: false, text: async () => "" },
    });
    mockedStart.mockResolvedValue({
      ok: false,
      stdout: "",
      stderr: "ssh: connection refused",
    });

    const summary = await runRecoverStuckInstancesSweep();

    expect(summary.restartFailed).toBe(1);
    expect(summary.restartAttempted).toBe(0);
  });

  it("skips rows with no proxmox_vmid", async () => {
    mockSupabaseSelect([buildRow({ proxmox_vmid: null })]);
    mockedProbe.mockResolvedValue({
      response: { ok: false, text: async () => "" },
    });

    const summary = await runRecoverStuckInstancesSweep();

    expect(summary.restartAttempted).toBe(0);
    expect(mockedStart).not.toHaveBeenCalled();
  });

  it("skips rows with NO infrastructure handle (no proxmox vmid AND no host_id) — does not flip them to running", async () => {
    // Regression for the 2026-05-17/18/19 zombie pattern: rows with
    // lifecycle_state='failed', NULL proxmox handle, and NULL host_id
    // were getting probed against their leftover gateway_url, returning
    // 200 from a stale Caddy snippet, and being flipped back to
    // active+running. They can't legitimately be running anywhere —
    // there's no VM. Skipping at the candidate-filter level means the
    // probe never runs and the row keeps its terminal state until an
    // operator hard-deletes it.
    mockSupabaseSelect([
      buildRow({
        proxmox_vmid: null,
        proxmox_node: null,
        host_id: null,
      }),
    ]);
    mockedProbe.mockResolvedValue({
      response: { ok: true, text: async () => "" },
    });

    const summary = await runRecoverStuckInstancesSweep();

    expect(summary.candidates).toBe(0);
    expect(summary.recovered).toBe(0);
    expect(mockedProbe).not.toHaveBeenCalled();
  });

  it("emits a structured warn when the gateway probe throws", async () => {
    mockSupabaseSelect([
      buildRow({
        id: "inst-throw",
        gateway_url: "https://throws.example",
        ipv4_address: "10.240.0.99",
      }),
    ]);
    const fakeError = Object.assign(new Error("ECONNREFUSED 10.240.0.99:443"), {
      name: "FetchError",
    });
    mockedProbe.mockRejectedValue(fakeError);

    await runRecoverStuckInstancesSweep();

    const warnCalls = (log.warn as jest.Mock).mock.calls;
    const probeFailures = warnCalls.filter(
      ([, ctx]: [string, Record<string, unknown>]) =>
        ctx?.failureType === "recover_stuck_probe_failed",
    );
    expect(probeFailures).toHaveLength(1);
    const [msg, ctx] = probeFailures[0];
    expect(msg).toBe("recover-stuck-instances probe threw");
    expect(ctx).toMatchObject({
      source: "recover-stuck-instances",
      failureType: "recover_stuck_probe_failed",
      instanceId: "inst-throw",
      gatewayUrl: "https://throws.example",
      errorName: "FetchError",
      errorMessage: expect.stringContaining("ECONNREFUSED"),
    });
    expect(typeof ctx.elapsedMs).toBe("number");
    expect(Array.isArray(ctx.probeUrls)).toBe(true);
    expect((ctx.probeUrls as string[]).length).toBeGreaterThan(0);
  });

  it("emits a structured warn when the gateway probe returns a non-ok status", async () => {
    mockSupabaseSelect([buildRow({ id: "inst-502" })]);
    mockedProbe.mockResolvedValue({
      response: { ok: false, status: 502, text: async () => "" },
      url: "https://gw.example/health",
    });

    await runRecoverStuckInstancesSweep();

    const warnCalls = (log.warn as jest.Mock).mock.calls;
    const probeFailures = warnCalls.filter(
      ([, ctx]: [string, Record<string, unknown>]) =>
        ctx?.failureType === "recover_stuck_probe_failed",
    );
    expect(probeFailures).toHaveLength(1);
    const [msg, ctx] = probeFailures[0];
    expect(msg).toBe("recover-stuck-instances probe returned non-ok");
    expect(ctx).toMatchObject({
      failureType: "recover_stuck_probe_failed",
      instanceId: "inst-502",
      status: 502,
      probeUrl: "https://gw.example/health",
    });
    expect(typeof ctx.elapsedMs).toBe("number");
  });

  it("emits an info summary when the sweep evaluates candidates", async () => {
    mockSupabaseSelect([buildRow()]);
    mockedProbe.mockResolvedValue({
      response: { ok: true, text: async () => "" },
      url: "https://gw.example/health",
    });

    await runRecoverStuckInstancesSweep();

    const infoCalls = (log.info as jest.Mock).mock.calls;
    const summary = infoCalls.find(
      ([m]: [string]) =>
        typeof m === "string" && m === "recover-stuck-instances sweep summary",
    );
    expect(summary).toBeDefined();
    expect(summary![1]).toMatchObject({
      source: "recover-stuck-instances",
      candidates: 1,
      recovered: 1,
      stillUnreachable: 0,
      restartAttempted: 0,
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// runRecoverStuckRestoringSweep — finalizes cold-restore rows stranded in
// lifecycle_state='restoring' (function killed mid-restore, or the script
// reported health_pending). SELECT chain:
//   .select().eq('lifecycle_state','restoring').not('gateway_url','is',null)
//     .lt('last_lifecycle_transition_at',cutoff).is('deleted_at',null)
// UPDATE chain: .update(...).eq('id',id).eq('lifecycle_state','restoring')
type RestoringRowOverrides = Partial<{
  id: string;
  user_id: string;
  host_id: string | null;
  proxmox_vmid: number | null;
  proxmox_node: string | null;
  gateway_url: string;
  ipv4_address: string | null;
  status: string | null;
  lifecycle_state: string | null;
  lifecycle_substate: string | null;
  last_lifecycle_transition_at: string | null;
}>;

function buildRestoringRow(overrides: RestoringRowOverrides = {}) {
  return {
    id: "inst-restoring-1",
    user_id: "user-1",
    host_id: "host-1",
    proxmox_vmid: 9200,
    proxmox_node: "fixturenode5",
    gateway_url: "https://restoring.gateway",
    ipv4_address: "10.250.22.50",
    status: "provisioning",
    lifecycle_state: "restoring",
    lifecycle_substate: "restore_health_pending",
    // 30 min ago — past the 25-min RESTORING_STALE_MS grace.
    last_lifecycle_transition_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

function mockRestoringSelect(rows: ReturnType<typeof buildRestoringRow>[]) {
  const updatePatches: Array<Record<string, unknown>> = [];
  (supabaseAdmin!.from as jest.Mock).mockImplementation(() => {
    return {
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          not: jest.fn().mockReturnValue({
            lt: jest.fn().mockReturnValue({
              is: jest.fn().mockResolvedValue({ data: rows, error: null }),
            }),
          }),
        }),
      }),
      update: jest.fn().mockImplementation((patch: Record<string, unknown>) => ({
        // .eq('id',id).eq('lifecycle_state','restoring') — terminal on 2nd eq.
        eq: jest.fn().mockReturnValue({
          eq: jest.fn().mockImplementation(async () => {
            updatePatches.push(patch);
            return { error: null };
          }),
        }),
      })),
    };
  });
  return { updatePatches };
}

describe("runRecoverStuckRestoringSweep", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedVmMissing.mockReturnValue(false);
  });

  it("promotes a healthy stuck-restoring row to running and clears the substate", async () => {
    const { updatePatches } = mockRestoringSelect([buildRestoringRow()]);
    mockedProbe.mockResolvedValue({
      response: { ok: true, text: async () => "" },
      url: "https://restoring.gateway/health",
    });

    const summary = await runRecoverStuckRestoringSweep();

    expect(summary.candidates).toBe(1);
    expect(summary.recovered).toBe(1);
    expect(summary.stillUnreachable).toBe(0);
    expect(summary.errors).toBe(0);
    expect(updatePatches).toHaveLength(1);
    expect(updatePatches[0]).toMatchObject({
      status: "running",
      lifecycle_substate: null,
    });
  });

  it("leaves an unreachable stuck-restoring row in place (no teardown, no promote)", async () => {
    const { updatePatches } = mockRestoringSelect([buildRestoringRow()]);
    mockedProbe.mockResolvedValue({
      response: { ok: false, status: 502, text: async () => "" },
      url: "https://restoring.gateway/health",
    });

    const summary = await runRecoverStuckRestoringSweep();

    expect(summary.candidates).toBe(1);
    expect(summary.recovered).toBe(0);
    expect(summary.stillUnreachable).toBe(1);
    expect(updatePatches).toHaveLength(0);
    expect(mockedStart).not.toHaveBeenCalled();
  });

  it("filters out a restoring row with no gateway_url", async () => {
    mockRestoringSelect([
      buildRestoringRow({ gateway_url: "" as unknown as string }),
    ]);

    const summary = await runRecoverStuckRestoringSweep();

    expect(summary.candidates).toBe(0);
    expect(mockedProbe).not.toHaveBeenCalled();
  });
});
