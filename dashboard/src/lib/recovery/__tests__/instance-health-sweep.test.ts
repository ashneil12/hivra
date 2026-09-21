/**
 * Tests for the synthetic instance-health probe.
 *
 * The probe's whole point is to surface broken instances BEFORE a user
 * notices — the 2026-04-30 outage left multiple instances quietly
 * unhealthy for hours with no server-side signal until users tripped
 * them in chat. The behavior we lock in here:
 *   - 4xx on the probe IS healthy (gateway responded; auth-rejected
 *     unsigned probe is fine — same heuristic as the Caddy reload
 *     rollback probe in profile-service)
 *   - 5xx is unhealthy
 *   - network failure / abort is unhealthy
 *   - successful probes do NOT report ops events (no log noise)
 */

import { probeInstanceGateway, runInstanceHealthSweep } from "../instance-health-sweep";

const mockSupabaseAdmin = { value: null as unknown };
jest.mock("@/lib/supabase", () => ({
  get supabaseAdmin() {
    return mockSupabaseAdmin.value;
  },
}));
jest.mock("@/lib/ops-events", () => ({ reportOpsEvent: jest.fn() }));
// The generic-failure fallback confirm calls the SAME helper as
// recover-unhealthy-active. Mock it so we can drive "reachable / not
// reachable" deterministically without real network or AbortSignal timers
// (buildGatewayProbeUrls' IP-fallback wiring is covered by gateway-probe.test).
jest.mock("@/lib/agent-gateway", () => ({
  fetchFirstReachableGatewayResponse: jest.fn(),
}));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

import { reportOpsEvent } from "@/lib/ops-events";
import { fetchFirstReachableGatewayResponse } from "@/lib/agent-gateway";

const mockedConfirm = fetchFirstReachableGatewayResponse as jest.Mock;

describe("probeInstanceGateway", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  it("treats 401/403/404 as healthy — gateway responded, just rejected the unsigned probe", async () => {
    for (const status of [401, 403, 404]) {
      global.fetch = jest.fn().mockResolvedValue({ status }) as unknown as typeof fetch;
      const result = await probeInstanceGateway({ instanceId: "i", gatewayUrl: "https://x.example" });
      expect(result.status).toBe(status);
      expect(result.ok).toBe(true);
    }
  });

  it("treats 5xx as unhealthy", async () => {
    for (const status of [500, 502, 503, 504]) {
      global.fetch = jest.fn().mockResolvedValue({ status }) as unknown as typeof fetch;
      const result = await probeInstanceGateway({ instanceId: "i", gatewayUrl: "https://x.example" });
      expect(result.status).toBe(status);
      expect(result.ok).toBe(false);
    }
  });

  it("treats network errors / aborts as unhealthy and captures the error name+message", async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError("Failed to fetch")) as unknown as typeof fetch;
    const result = await probeInstanceGateway({ instanceId: "i", gatewayUrl: "https://x.example" });
    expect(result.ok).toBe(false);
    expect(result.status).toBeNull();
    expect(result.errorName).toBe("TypeError");
    expect(result.errorMessage).toBe("Failed to fetch");
  });

  it("strips trailing slashes on the gateway URL so probes hit the canonical /health", async () => {
    // /health is the unauthenticated agent-gateway health endpoint — the
    // same path recover-unhealthy-active, recover-stuck, and the instance
    // routes probe. The prober used to hit /api/health (the old hermes-webui
    // app route, now 401/slow post-webfree), which is what made the two
    // sweeps disagree and churn the open-event backlog.
    const fetchMock = jest.fn().mockResolvedValue({ status: 200 });
    global.fetch = fetchMock as unknown as typeof fetch;
    await probeInstanceGateway({ instanceId: "i", gatewayUrl: "https://x.example///" });
    expect(fetchMock).toHaveBeenCalledWith("https://x.example/health", expect.any(Object));
  });

  it("reads clock skew from the response Date header, and stays undefined (never throws) when absent", async () => {
    // Box clock ~90s ahead of us → positive skew.
    const boxDate = new Date(Date.now() + 90_000).toUTCString();
    global.fetch = jest.fn().mockResolvedValue({
      status: 200,
      headers: { get: (k: string) => (k.toLowerCase() === "date" ? boxDate : null) },
    }) as unknown as typeof fetch;
    const ahead = await probeInstanceGateway({ instanceId: "i", gatewayUrl: "https://x.example" });
    expect(ahead.clockSkewMs).toBeGreaterThan(60_000);

    // The bare `{ status }` mock shape (no .headers) must not throw or set skew.
    global.fetch = jest.fn().mockResolvedValue({ status: 200 }) as unknown as typeof fetch;
    const noHeader = await probeInstanceGateway({ instanceId: "i", gatewayUrl: "https://x.example" });
    expect(noHeader.clockSkewMs).toBeUndefined();
    expect(noHeader.ok).toBe(true);
  });
});

describe("runInstanceHealthSweep", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.clearAllMocks();
  });

  // Captures every ops_events archive query the sweep issues so a test can
  // assert it closed the right events (source + instance_id set).
  interface ArchiveCall {
    source: string | null;
    archivedAtIsNull: boolean;
    instanceIds: string[] | null;
  }

  function mockRunningInstances(
    rows: Array<{
      id: string;
      user_id: string;
      gateway_url: string | null;
      backend?: string | null;
      infrastructure_provider?: string | null;
      ipv4_address?: string | null;
      proxmox_vmid?: number | null;
      lifecycle_state?: string | null;
    }>,
    options: {
      archivedRows?: Array<{ id: string }>;
      // Pre-existing consecutive_failures per instance id. Lets a test simulate
      // "this is the Nth failing tick" without running the sweep N times. When
      // unset an instance reads 0 (first failing tick → suppressed).
      existingFailureCounts?: Record<string, number>;
    } = {},
  ): {
    archiveCalls: ArchiveCall[];
    probeStateUpserts: Array<{ instance_id: string; consecutive_failures: number }>;
    probeStateDeletes: string[][];
    autoRestartResets: Array<{ patch: Record<string, unknown>; ids: string[]; gtColumn: string; gtValue: unknown }>;
  } {
    const archivedRows = options.archivedRows ?? [];
    const existingFailureCounts = options.existingFailureCounts ?? {};
    const archiveCalls: ArchiveCall[] = [];
    const probeStateUpserts: Array<{ instance_id: string; consecutive_failures: number }> = [];
    const probeStateDeletes: string[][] = [];
    // Captures the hermes_instances.auto_restart_attempts reset the healthy path
    // issues (update({auto_restart_attempts:0}).in("id",…).gt("auto_restart_attempts",0)).
    const autoRestartResets: Array<{ patch: Record<string, unknown>; ids: string[]; gtColumn: string; gtValue: unknown }> = [];
    mockSupabaseAdmin.value = {
      from: jest.fn((table: string) => {
        if (table === "ops_events") {
          const call: ArchiveCall = { source: null, archivedAtIsNull: false, instanceIds: null };
          const chain: Record<string, jest.Mock> = {
            update: jest.fn(() => chain),
            eq: jest.fn((col: string, val: unknown) => {
              if (col === "source") call.source = val as string;
              return chain;
            }),
            is: jest.fn((col: string, val: unknown) => {
              if (col === "archived_at") call.archivedAtIsNull = val === null;
              return chain;
            }),
            in: jest.fn((col: string, vals: string[]) => {
              if (col === "instance_id") call.instanceIds = vals;
              // The action-failure archive scopes its sources with `.in("source", ...)`
              // (vs the health archive's `.eq("source", ...)`); record it so the
              // self-heal test can assert the user-facing failure events get closed.
              if (col === "source") call.source = vals.join(",");
              return chain;
            }),
            select: jest.fn(() => {
              archiveCalls.push(call);
              return Promise.resolve({ data: archivedRows, error: null });
            }),
          };
          return chain;
        }
        if (table === "instance_health_probe_state") {
          // Supports both the bump path (select→eq→maybeSingle, then upsert) and
          // the reset path (delete→in). The chain is intentionally permissive so
          // either call order resolves.
          let selectedInstanceId: string | null = null;
          const chain: Record<string, jest.Mock> = {
            select: jest.fn(() => chain),
            eq: jest.fn((col: string, val: unknown) => {
              if (col === "instance_id") selectedInstanceId = val as string;
              return chain;
            }),
            maybeSingle: jest.fn(() =>
              Promise.resolve({
                data:
                  selectedInstanceId && existingFailureCounts[selectedInstanceId]
                    ? { consecutive_failures: existingFailureCounts[selectedInstanceId] }
                    : null,
                error: null,
              }),
            ),
            upsert: jest.fn((row: { instance_id: string; consecutive_failures: number }) => {
              probeStateUpserts.push({
                instance_id: row.instance_id,
                consecutive_failures: row.consecutive_failures,
              });
              return Promise.resolve({ data: null, error: null });
            }),
            delete: jest.fn(() => chain),
            in: jest.fn((col: string, vals: string[]) => {
              if (col === "instance_id") probeStateDeletes.push(vals);
              return Promise.resolve({ data: null, error: null });
            }),
          };
          return chain;
        }
        if (table === "hermes_instances") {
          return {
            // The initial running-fleet SELECT.
            select: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                not: jest.fn().mockResolvedValue({
                  data: rows.map((r) => ({ status: "running", backend: r.backend ?? "webui", ...r })),
                  error: null,
                }),
              }),
            }),
            // The healthy-path auto_restart_attempts reset:
            // update({auto_restart_attempts:0,…}).in("id", ids).gt("auto_restart_attempts", 0)
            update: jest.fn((patch: Record<string, unknown>) => ({
              in: jest.fn((_col: string, vals: string[]) => ({
                gt: jest.fn((gtColumn: string, gtValue: unknown) => {
                  autoRestartResets.push({ patch, ids: vals, gtColumn, gtValue });
                  return Promise.resolve({ data: null, error: null });
                }),
              })),
            })),
          };
        }
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              not: jest.fn().mockResolvedValue({
                data: rows.map((r) => ({ status: "running", backend: r.backend ?? "webui", ...r })),
                error: null,
              }),
            }),
          }),
        };
      }),
    };
    return { archiveCalls, probeStateUpserts, probeStateDeletes, autoRestartResets };
  }

  it("reports a config incident when a Hetzner row uses non-sslip custom DNS", async () => {
    mockSupabaseAdmin.value = {
      from: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            not: jest.fn().mockResolvedValue({
              data: [
                {
                  id: "hetzner-bad-dns",
                  user_id: "u1",
                  gateway_url: "https://agent.hermesos.cloud",
                  status: "running",
                  backend: "webui",
                  infrastructure_provider: "hetzner",
                  hetzner_server_id: 123,
                  ipv4_address: "192.0.2.91",
                },
              ],
              error: null,
            }),
          }),
        }),
      }),
    };
    global.fetch = jest.fn().mockResolvedValue({ status: 401 }) as unknown as typeof fetch;

    const summary = await runInstanceHealthSweep();

    expect(summary.failed).toBe(1);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(reportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "synthetic.gateway-config",
        severity: "fatal",
        instanceId: "hetzner-bad-dns",
        metadata: expect.objectContaining({
          failureOwner: "control-plane",
          failureType: "hetzner_gateway_url_not_sslip",
          recoveryAction: "canonicalize_gateway_url",
          expectedGatewayUrl: "https://192-0-2-91.sslip.io",
        }),
      }),
    );
  });

  it("reports a route incident when a Proxmox agents.hermesos.cloud gateway fails TLS before any HTTP response", async () => {
    mockSupabaseAdmin.value = {
      from: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            not: jest.fn().mockResolvedValue({
              data: [
                {
                  id: "proxmox-missing-route",
                  user_id: "u1",
                  gateway_url: "https://missing.agents.hermesos.cloud",
                  status: "running",
                  backend: "webui",
                  infrastructure_provider: "proxmox",
                  proxmox_vmid: 206,
                },
              ],
              error: null,
            }),
          }),
        }),
      }),
    };
    const tlsError = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("tlsv1 alert internal error"), {
        code: "ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR",
      }),
    });
    global.fetch = jest.fn().mockRejectedValue(tlsError) as unknown as typeof fetch;

    const summary = await runInstanceHealthSweep();

    expect(summary.failed).toBe(1);
    expect(reportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "synthetic.gateway-route",
        severity: "fatal",
        instanceId: "proxmox-missing-route",
        metadata: expect.objectContaining({
          failureOwner: "hypervisor",
          failureType: "proxmox_caddy_route_or_cert_missing",
          recoveryAction: "rebuild_caddy_route",
          proxmoxVmid: 206,
        }),
      }),
    );
  });

  it("skips intentionally-paused boxes (lifecycle_state='paused') so a powered-off VM never cries wolf", async () => {
    // Repro of the 2026-06-24 noise: a paused box whose status drifted back to
    // 'running' (so the status='running' query returns it) but is powered off, so
    // every /health probe fails. lifecycle_state='paused' must exclude it BEFORE
    // the network probe — otherwise it logs thousands of bogus failures.
    mockRunningInstances([
      { id: "live", user_id: "u1", gateway_url: "https://live.example" },
      { id: "paused", user_id: "u1", gateway_url: "https://paused.example", lifecycle_state: "paused" },
    ]);
    global.fetch = jest.fn().mockResolvedValue({ status: 200 }) as unknown as typeof fetch;

    const summary = await runInstanceHealthSweep();

    // Only the live box is probed; the paused box never touches the network and
    // never opens an ops event.
    expect(summary.probed).toBe(1);
    expect(summary.skippedPaused).toBe(1);
    expect(summary.failed).toBe(0);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith("https://live.example/health", expect.any(Object));
    expect(reportOpsEvent).not.toHaveBeenCalled();
  });

  it("pages ONE fatal when a box's clock skew exceeds the threshold — kill-switch silences it", async () => {
    // A healthy (200) box whose HTTP Date is ~40s ahead: /health is fine but a fresh
    // 30s webui-login token would expire on arrival → blank chat. The skew guard must
    // catch it even though the probe itself is 'healthy' (2026-07-01 fixturenodea incident).
    const skewedDate = new Date(Date.now() + 40_000).toUTCString();
    const withSkewFetch = () =>
      jest.fn().mockResolvedValue({
        status: 200,
        headers: { get: (k: string) => (k.toLowerCase() === "date" ? skewedDate : null) },
      }) as unknown as typeof fetch;

    mockRunningInstances([{ id: "skewed", user_id: "u1", gateway_url: "https://skewed.example" }]);
    global.fetch = withSkewFetch();
    await runInstanceHealthSweep();
    expect(reportOpsEvent).toHaveBeenCalledTimes(1);
    expect(reportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: "fatal",
        source: "instance-health-sweep",
        metadata: expect.objectContaining({
          failureType: "instance_clock_skew",
          count: 1,
          worstInstanceId: "skewed",
        }),
      }),
    );

    // Kill-switch: HERMES_CLOCK_SKEW_GUARD=off suppresses the guard entirely.
    (reportOpsEvent as jest.Mock).mockClear();
    process.env.HERMES_CLOCK_SKEW_GUARD = "off";
    mockRunningInstances([{ id: "skewed", user_id: "u1", gateway_url: "https://skewed.example" }]);
    global.fetch = withSkewFetch();
    await runInstanceHealthSweep();
    delete process.env.HERMES_CLOCK_SKEW_GUARD;
    expect(reportOpsEvent).not.toHaveBeenCalled();
  });

  it("reports ops events ONLY for unhealthy gateways — healthy probes are silent (on the 2nd consecutive failing tick)", async () => {
    // i2 already has one prior failing tick recorded, so THIS tick crosses the
    // consecutive-failure threshold and opens the event. (A fresh first failure
    // is covered by the gate test below — it stays silent.)
    mockRunningInstances(
      [
        { id: "i1", user_id: "u1", gateway_url: "https://healthy.example" },
        { id: "i2", user_id: "u1", gateway_url: "https://broken.example" },
      ],
      { existingFailureCounts: { i2: 1 } },
    );
    global.fetch = jest.fn(((url: string) => {
      if (typeof url === "string" && url.includes("healthy.example")) {
        return Promise.resolve({ status: 401 });
      }
      return Promise.resolve({ status: 502 });
    }) as unknown as typeof fetch);

    const summary = await runInstanceHealthSweep();
    expect(summary.probed).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.suppressedPendingFailures).toBe(0);
    expect(reportOpsEvent).toHaveBeenCalledTimes(1);
    expect(reportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: "i2",
        userId: "u1",
        severity: "error",
        source: "synthetic.instance-health",
        metadata: expect.objectContaining({
          failureOwner: "runtime",
          failurePhase: "runtime",
          recoveryAction: "repair_runtime",
          consecutiveFailures: 2,
        }),
      }),
    );
  });

  it("does NOT open a generic event on the FIRST failing tick — gates crying-wolf behind 2 consecutive failures", async () => {
    const { probeStateUpserts } = mockRunningInstances([
      { id: "flap", user_id: "u1", gateway_url: "https://flap.example" },
    ]);
    // A 502 is a real HTTP response (status !== null), so it bypasses the
    // fallback-confirm and lands directly in the generic-event branch — the
    // exact path the AbortError-under-load false positives took.
    global.fetch = jest.fn().mockResolvedValue({ status: 502 }) as unknown as typeof fetch;

    const summary = await runInstanceHealthSweep();

    // The probe DID fail (counts toward failed) but the event is suppressed
    // this tick — only the counter is bumped.
    expect(summary.failed).toBe(1);
    expect(summary.suppressedPendingFailures).toBe(1);
    expect(reportOpsEvent).not.toHaveBeenCalled();
    expect(probeStateUpserts).toEqual([
      expect.objectContaining({ instance_id: "flap", consecutive_failures: 1 }),
    ]);
  });

  it("resets the consecutive-failure counter for an instance that probes healthy", async () => {
    const { probeStateDeletes } = mockRunningInstances([
      { id: "back", user_id: "u1", gateway_url: "https://back.example" },
    ]);
    global.fetch = jest.fn().mockResolvedValue({ status: 200 }) as unknown as typeof fetch;

    await runInstanceHealthSweep();

    // Healthy → its failure counter row is deleted so a later flap needs two
    // fresh consecutive ticks before paging again.
    expect(probeStateDeletes.some((batch) => batch.includes("back"))).toBe(true);
  });

  it("clears auto_restart_attempts for an instance that probes healthy so a recovered box can't page on the auto-repair cap", async () => {
    const { autoRestartResets } = mockRunningInstances([
      { id: "recovered", user_id: "u1", gateway_url: "https://recovered.example" },
    ]);
    global.fetch = jest.fn().mockResolvedValue({ status: 200 }) as unknown as typeof fetch;

    await runInstanceHealthSweep();

    // recover-unhealthy-active only ever BUMPS auto_restart_attempts (the sole
    // reset lived in recover-stuck, which never touches active/running rows).
    // The healthy sweep must clear it — filtered server-side to attempts>0 so a
    // healthy fleet isn't rewritten every tick.
    const reset = autoRestartResets.find((call) => call.ids.includes("recovered"));
    expect(reset).toBeDefined();
    expect(reset?.patch).toEqual(
      expect.objectContaining({ auto_restart_attempts: 0 }),
    );
    expect(reset?.gtColumn).toBe("auto_restart_attempts");
    expect(reset?.gtValue).toBe(0);
  });

  it("does NOT reset auto_restart_attempts for an instance that probes unhealthy", async () => {
    const { autoRestartResets } = mockRunningInstances([
      { id: "sick", user_id: "u1", gateway_url: "https://sick.example" },
    ]);
    // 502 is a real HTTP response → unhealthy (ok:false), never added to the
    // healthy set, so its counter must be left intact for recover-unhealthy.
    global.fetch = jest.fn().mockResolvedValue({ status: 502 }) as unknown as typeof fetch;

    await runInstanceHealthSweep();

    expect(autoRestartResets.some((call) => call.ids.includes("sick"))).toBe(false);
  });

  it("skips instances with empty gateway_url so a half-provisioned row never reports a fake outage", async () => {
    mockRunningInstances([
      { id: "i1", user_id: "u1", gateway_url: null },
      { id: "i2", user_id: "u1", gateway_url: "  " },
    ]);
    global.fetch = jest.fn() as unknown as typeof fetch;

    const summary = await runInstanceHealthSweep();
    expect(summary.probed).toBe(0);
    expect(summary.failed).toBe(0);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(reportOpsEvent).not.toHaveBeenCalled();
  });

  // ---- self-heal + reachable-set parity with recover-unhealthy-active ----
  // The 2026-06-10 churn: the prober opened synthetic.instance-health on a
  // /api/health failure, recover-unhealthy-active probed the same box healthy
  // on /health and archived the event, and the next prober tick re-opened it.
  // The open-event count rebounded to 732 instances against a ~790 fleet that
  // PostHog showed actively in use. Fix = probe /health AND close on recovery.

  it("self-heals: archives open synthetic.instance-health events for instances that probe healthy", async () => {
    const { archiveCalls } = mockRunningInstances(
      [{ id: "h1", user_id: "u1", gateway_url: "https://ok.example" }],
      { archivedRows: [{ id: "e1" }, { id: "e2" }] },
    );
    global.fetch = jest.fn().mockResolvedValue({ status: 200 }) as unknown as typeof fetch;

    const summary = await runInstanceHealthSweep();

    expect(summary.failed).toBe(0);
    expect(summary.archivedHealthy).toBe(2);
    // The user-facing action/runtime failure events get closed on recovery too.
    expect(summary.archivedActionFailures).toBe(2);
    expect(reportOpsEvent).not.toHaveBeenCalled();
    // Two archives on recovery, both keyed on instance_id (not fingerprint) so
    // they close every open row for the healthy instance:
    //  [0] the prober's own synthetic.instance-health rows, and
    //  [1] the user-facing instance-actions/orchestrator failure events — the
    //      "ACTIVE FAILURE OWNERSHIP" banner a timed-out Update/Repair left
    //      behind. Without [1], a box that recreated healthy kept a permanent
    //      failure banner that scared the owner into re-clicking into more 500s.
    expect(archiveCalls).toHaveLength(2);
    expect(archiveCalls[0]).toEqual({
      source: "synthetic.instance-health",
      archivedAtIsNull: true,
      instanceIds: ["h1"],
    });
    expect(archiveCalls[1]).toEqual({
      source: "instance-actions,instance-orchestrator",
      archivedAtIsNull: true,
      instanceIds: ["h1"],
    });
  });

  it("does NOT flag — and self-heals — an instance whose gateway host throws but answers on a fallback candidate URL", async () => {
    const { archiveCalls } = mockRunningInstances(
      [
        {
          id: "fb1",
          user_id: "u1",
          gateway_url: "https://box.hermesos.cloud",
          infrastructure_provider: "proxmox",
          ipv4_address: "10.240.0.9",
          proxmox_vmid: 201,
        },
      ],
      { archivedRows: [{ id: "ev1" }] },
    );
    // Primary probe to the stored gateway host throws (ECONNREFUSED, not TLS),
    // so result.status is null → the sweep confirms against the recovery set.
    global.fetch = jest.fn(() =>
      Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: new Error("connect ECONNREFUSED") })),
    ) as unknown as typeof fetch;
    // recover-unhealthy-active's reachable set answers 2xx (e.g. the direct IP).
    mockedConfirm.mockResolvedValue({
      response: { ok: true, status: 200, text: async () => "" },
      url: "http://10.240.0.9/health",
    });

    const summary = await runInstanceHealthSweep();

    expect(mockedConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: "https://box.hermesos.cloud", pathname: "/health", instanceIpv4: "10.240.0.9" }),
    );
    expect(summary.recoveredViaFallback).toBe(1);
    expect(summary.failed).toBe(0);
    expect(reportOpsEvent).not.toHaveBeenCalled();
    expect(summary.archivedHealthy).toBe(1);
    expect(archiveCalls[0]).toEqual({
      source: "synthetic.instance-health",
      archivedAtIsNull: true,
      instanceIds: ["fb1"],
    });
  });

  it("still flags an instance that is unreachable on every candidate URL (no false rescue)", async () => {
    mockRunningInstances(
      [
        {
          id: "down1",
          user_id: "u1",
          gateway_url: "https://dead.hermesos.cloud",
          infrastructure_provider: "proxmox",
          ipv4_address: "10.240.0.7",
        },
      ],
      // Second consecutive failing tick so the gate opens the event.
      { existingFailureCounts: { down1: 1 } },
    );
    global.fetch = jest.fn(() =>
      Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: new Error("connect ECONNREFUSED") })),
    ) as unknown as typeof fetch;
    // Every candidate URL in the recovery set also fails → genuinely down.
    mockedConfirm.mockRejectedValue(new Error("Gateway request failed after 2 attempts"));

    const summary = await runInstanceHealthSweep();

    expect(mockedConfirm).toHaveBeenCalledTimes(1);
    expect(summary.recoveredViaFallback).toBe(0);
    expect(summary.failed).toBe(1);
    expect(reportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({ source: "synthetic.instance-health", instanceId: "down1" }),
    );
  });

  it("does NOT fire a fallback confirm for a 5xx response — the host already answered, so the two sweeps cannot disagree", async () => {
    mockRunningInstances(
      [
        {
          id: "e5",
          user_id: "u1",
          gateway_url: "https://err.hermesos.cloud",
          infrastructure_provider: "proxmox",
          ipv4_address: "10.240.0.3",
        },
      ],
      // Second consecutive failing tick so the gate opens the event (we're
      // asserting the no-fallback-confirm path, not the gate itself).
      { existingFailureCounts: { e5: 1 } },
    );
    global.fetch = jest.fn().mockResolvedValue({ status: 502 }) as unknown as typeof fetch;

    const summary = await runInstanceHealthSweep();

    expect(mockedConfirm).not.toHaveBeenCalled();
    expect(summary.failed).toBe(1);
    expect(summary.recoveredViaFallback).toBe(0);
    expect(reportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({ source: "synthetic.instance-health", instanceId: "e5" }),
    );
  });
});

describe("Caddy h2-wedged detection", () => {
  // Regression guard for the 2026-04-30 incident where a Caddy
  // certmagic panic during ACME left the per-host HTTPS server
  // wedged in process memory. Cert was on disk, ALPN negotiated h2
  // cleanly, openssl s_client on the host succeeded — but real
  // browsers (and Node fetch over h2) saw `tlsv1 alert internal
  // error` mid-handshake and the chat workspace never loaded.
  // `systemctl reload caddy` did NOT clear the in-memory state;
  // a full stop+start did. Without this fallback the sweeper would
  // log a generic "fetch failed" indistinguishable from "agent
  // actually down" and the wedge could go unnoticed for hours.

  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.clearAllMocks();
  });

  function buildTlsErrorTypeError(): TypeError {
    // Mirrors what undici/Node fetch actually throws on a TLS
    // handshake failure: a TypeError("fetch failed") whose `.cause`
    // chain carries the underlying SSL error.
    const cause = Object.assign(new Error("tlsv1 alert internal error"), {
      name: "Error",
      code: "ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR",
    });
    return Object.assign(new TypeError("fetch failed"), { cause });
  }

  it("retries with HTTP/1.1 when the default probe throws a TLS error AND emits tlsWedged on success", async () => {
    let callCount = 0;
    global.fetch = jest.fn(((_url: string, init?: RequestInit & { dispatcher?: unknown }) => {
      callCount += 1;
      // First call: no dispatcher → default protocol (h2 preferred).
      // Simulate the Caddy wedge by throwing a TLS error.
      if (callCount === 1) {
        expect(init?.dispatcher).toBeUndefined();
        return Promise.reject(buildTlsErrorTypeError());
      }
      // Second call: dispatcher set → HTTP/1.1 fallback. Simulate
      // the wedge — h1.1 still works because the HTTP/1.1 server
      // path in Caddy is independent of the broken h2 server state.
      expect(init?.dispatcher).toBeDefined();
      return Promise.resolve({ status: 401 });
    }) as unknown as typeof fetch);

    const result = await probeInstanceGateway({
      instanceId: "i-wedged",
      gatewayUrl: "https://wedged.example",
    });

    expect(result.tlsWedged).toBe(true);
    expect(result.ok).toBe(false); // h2 is what users hit — treat as unhealthy
    expect(result.status).toBe(401); // captured from the h1.1 fallback
    expect(callCount).toBe(2);
  });

  it("does NOT retry with HTTP/1.1 for a non-TLS network error (real outage)", async () => {
    let callCount = 0;
    global.fetch = jest.fn((() => {
      callCount += 1;
      // Plain ECONNREFUSED — Caddy is down entirely, not wedged.
      // The h1.1 fallback would also fail, so don't waste a probe.
      const cause = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      return Promise.reject(Object.assign(new TypeError("fetch failed"), { cause }));
    }) as unknown as typeof fetch);

    const result = await probeInstanceGateway({
      instanceId: "i-down",
      gatewayUrl: "https://down.example",
    });

    expect(result.tlsWedged).toBeUndefined();
    expect(result.ok).toBe(false);
    expect(callCount).toBe(1);
  });

  it("falls through to plain failure when h2 fails with TLS error AND h1.1 also fails (real TLS outage)", async () => {
    let callCount = 0;
    global.fetch = jest.fn((() => {
      callCount += 1;
      // Both protocols throw — Caddy is genuinely broken at the TLS
      // layer (cert revoked, port closed, etc.), not just wedged.
      return Promise.reject(buildTlsErrorTypeError());
    }) as unknown as typeof fetch);

    const result = await probeInstanceGateway({
      instanceId: "i-tls-broken",
      gatewayUrl: "https://broken-tls.example",
    });

    expect(result.tlsWedged).toBeUndefined();
    expect(result.ok).toBe(false);
    expect(result.errorName).toBe("TypeError");
    expect(callCount).toBe(2);
  });

  it("emits a fatal-severity ops event with source synthetic.tls-wedged when the wedge pattern is detected", async () => {
    mockSupabaseAdmin.value = {
      from: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            not: jest.fn().mockResolvedValue({
              data: [{ id: "i-wedged", user_id: "u1", gateway_url: "https://wedged.example", status: "running", backend: "webui" }],
              error: null,
            }),
          }),
        }),
      }),
    };
    let callCount = 0;
    global.fetch = jest.fn(((_url: string, init?: RequestInit & { dispatcher?: unknown }) => {
      callCount += 1;
      if (callCount === 1) return Promise.reject(buildTlsErrorTypeError());
      expect(init?.dispatcher).toBeDefined();
      return Promise.resolve({ status: 401 });
    }) as unknown as typeof fetch);

    const summary = await runInstanceHealthSweep();
    expect(summary.failed).toBe(1);
    expect(reportOpsEvent).toHaveBeenCalledTimes(1);
    expect(reportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "synthetic.tls-wedged",
        severity: "fatal",
        instanceId: "i-wedged",
        metadata: expect.objectContaining({
          failureOwner: "hypervisor",
          failurePhase: "network",
          recoveryAction: "restart_gateway",
        }),
      }),
    );
    // Recovery hint must be in the event message so an operator
    // sees the right action without digging through the runbook.
    const call = (reportOpsEvent as jest.Mock).mock.calls[0][0];
    expect(call.message).toContain("systemctl stop caddy");
    expect(call.message).toContain("systemctl start caddy");
  });
});

describe("Proxmox host-wedge cluster detection", () => {
  // Regression guard: when Caddy on a Proxmox host wedges or its
  // origin port stops listening, every instance hosted there returns
  // a Cloudflare 521 ("Web server is down"). The h2-wedged path above
  // can't catch this because Cloudflare absorbs the wedge — from the
  // probe's POV it's a clean HTTP response with status 521. Without
  // this aggregator, ops sees N indistinguishable per-instance
  // failures and has to manually correlate them to a host.
  //
  // The 04:10 spike on 2026-05-09 had 17 simultaneous 521s on fixturenodea
  // and was filed under 17 separate `synthetic.instance-health` rows
  // with no host-level signal. After this aggregator, the same
  // event pattern surfaces a single fatal `synthetic.proxmox-host-wedged`
  // alert with the affected count and recovery instructions.

  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.clearAllMocks();
  });

  function mockProxmoxFleet(
    rows: Array<{
      id: string;
      gateway_url: string;
      proxmox_node: string;
      proxmox_vmid?: number;
    }>,
  ) {
    mockSupabaseAdmin.value = {
      from: jest.fn((table: string) => {
        if (table === "instance_health_probe_state") {
          // Seed every instance as already having one prior failing tick so the
          // host-wedge 521s open per-instance events on this run (the host-wedge
          // tests assert the per-instance failure banners fire alongside the
          // single host-level fatal). The bump/reset chain is permissive.
          const chain: Record<string, jest.Mock> = {
            select: jest.fn(() => chain),
            eq: jest.fn(() => chain),
            maybeSingle: jest.fn(() => Promise.resolve({ data: { consecutive_failures: 1 }, error: null })),
            upsert: jest.fn(() => Promise.resolve({ data: null, error: null })),
            delete: jest.fn(() => chain),
            in: jest.fn(() => Promise.resolve({ data: null, error: null })),
          };
          return chain;
        }
        if (table === "ops_events") {
          const chain: Record<string, jest.Mock> = {
            update: jest.fn(() => chain),
            eq: jest.fn(() => chain),
            is: jest.fn(() => chain),
            in: jest.fn(() => chain),
            select: jest.fn(() => Promise.resolve({ data: [], error: null })),
          };
          return chain;
        }
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              not: jest.fn().mockResolvedValue({
                data: rows.map((r) => ({
                  user_id: "u1",
                  status: "running",
                  backend: "webui",
                  infrastructure_provider: "proxmox",
                  proxmox_vmid: r.proxmox_vmid ?? 200,
                  ...r,
                })),
                error: null,
              }),
            }),
          }),
        };
      }),
    };
  }

  it("emits a single fatal synthetic.proxmox-host-wedged event when 2+ instances on the same node return 521", async () => {
    mockProxmoxFleet([
      { id: "vm-a", gateway_url: "https://aaa.hermesos.cloud", proxmox_node: "fixturenode2" },
      { id: "vm-b", gateway_url: "https://bbb.hermesos.cloud", proxmox_node: "fixturenode2" },
      { id: "vm-c", gateway_url: "https://ccc.hermesos.cloud", proxmox_node: "fixturenode2" },
    ]);
    global.fetch = jest.fn().mockResolvedValue({ status: 521 }) as unknown as typeof fetch;

    const summary = await runInstanceHealthSweep();
    expect(summary.failed).toBe(3);

    const calls = (reportOpsEvent as jest.Mock).mock.calls.map((args) => args[0]);
    const hostWedge = calls.find((c) => c.source === "synthetic.proxmox-host-wedged");
    expect(hostWedge).toBeDefined();
    expect(hostWedge.severity).toBe("fatal");
    expect(hostWedge.metadata).toMatchObject({
      failureOwner: "hypervisor",
      failureType: "proxmox_host_origin_unreachable",
      recoveryAction: "restart_host_caddy",
      proxmoxNode: "fixturenode2",
      affectedInstanceCount: 3,
    });
    expect(hostWedge.metadata.affectedInstanceIds.sort()).toEqual(["vm-a", "vm-b", "vm-c"]);
    expect(hostWedge.metadata.statusCounts).toEqual({ "521": 3 });
    // Per-instance events still fire so user-facing failure banners stay accurate.
    expect(calls.filter((c) => c.source === "synthetic.instance-health")).toHaveLength(3);
  });

  it("does NOT emit a host-wedge event when only one instance on a node fails (could be a real per-VM issue)", async () => {
    mockProxmoxFleet([
      { id: "vm-only", gateway_url: "https://solo.hermesos.cloud", proxmox_node: "fixturenode2" },
    ]);
    global.fetch = jest.fn().mockResolvedValue({ status: 521 }) as unknown as typeof fetch;

    await runInstanceHealthSweep();
    const calls = (reportOpsEvent as jest.Mock).mock.calls.map((args) => args[0]);
    expect(calls.find((c) => c.source === "synthetic.proxmox-host-wedged")).toBeUndefined();
  });

  it("does NOT emit a host-wedge event when failures are not Cloudflare-origin codes (502/503 are runtime issues, not host)", async () => {
    mockProxmoxFleet([
      { id: "vm-a", gateway_url: "https://aaa.hermesos.cloud", proxmox_node: "fixturenode2" },
      { id: "vm-b", gateway_url: "https://bbb.hermesos.cloud", proxmox_node: "fixturenode2" },
    ]);
    global.fetch = jest.fn().mockResolvedValue({ status: 502 }) as unknown as typeof fetch;

    await runInstanceHealthSweep();
    const calls = (reportOpsEvent as jest.Mock).mock.calls.map((args) => args[0]);
    expect(calls.find((c) => c.source === "synthetic.proxmox-host-wedged")).toBeUndefined();
  });

  it("scopes wedge detection per-host: failures on different nodes do not aggregate together", async () => {
    mockProxmoxFleet([
      { id: "vm-a1", gateway_url: "https://a1.hermesos.cloud", proxmox_node: "fixturenode2" },
      { id: "vm-b1", gateway_url: "https://b1.hermesos.cloud", proxmox_node: "fixturenode3" },
    ]);
    global.fetch = jest.fn().mockResolvedValue({ status: 521 }) as unknown as typeof fetch;

    await runInstanceHealthSweep();
    const calls = (reportOpsEvent as jest.Mock).mock.calls.map((args) => args[0]);
    expect(calls.find((c) => c.source === "synthetic.proxmox-host-wedged")).toBeUndefined();
  });

  it("counts a mix of Cloudflare origin codes (521+523+525) toward the same host wedge", async () => {
    mockProxmoxFleet([
      { id: "vm-a", gateway_url: "https://aaa.hermesos.cloud", proxmox_node: "fixturenode2" },
      { id: "vm-b", gateway_url: "https://bbb.hermesos.cloud", proxmox_node: "fixturenode2" },
      { id: "vm-c", gateway_url: "https://ccc.hermesos.cloud", proxmox_node: "fixturenode2" },
    ]);
    let i = 0;
    const codes = [521, 523, 525];
    global.fetch = jest.fn(() => Promise.resolve({ status: codes[i++] })) as unknown as typeof fetch;

    await runInstanceHealthSweep();
    const calls = (reportOpsEvent as jest.Mock).mock.calls.map((args) => args[0]);
    const hostWedge = calls.find((c) => c.source === "synthetic.proxmox-host-wedged");
    expect(hostWedge).toBeDefined();
    expect(hostWedge.metadata.affectedInstanceCount).toBe(3);
    expect(hostWedge.metadata.statusCounts).toEqual({ "521": 1, "523": 1, "525": 1 });
  });
});
