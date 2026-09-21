import { runInstanceEgressSweep } from "../instance-egress-sweep";
import { reportOpsEvent } from "@/lib/ops-events";
import { recoverAndPersistApiServerKeyFromManagedHost } from "@/lib/services/instance-security";

const mockSupabaseAdmin = { value: null as unknown };
const mockArchiveEq = jest.fn();
const mockArchiveIs = jest.fn();
const mockOpsEventsUpdate = jest.fn();

jest.mock("@/lib/supabase", () => ({
  get supabaseAdmin() {
    return mockSupabaseAdmin.value;
  },
}));

jest.mock("@/lib/crypto", () => ({
  decryptApiKey: jest.fn(() => "gateway-secret"),
}));

jest.mock("@/lib/ops-events", () => ({
  reportOpsEvent: jest.fn().mockResolvedValue({ id: "evt_123", fingerprint: "fp_123" }),
}));

jest.mock("@/lib/services/instance-security", () => ({
  recoverAndPersistApiServerKeyFromManagedHost: jest.fn(),
}));

function mockRunningInstances() {
  mockArchiveEq.mockReturnValue({ eq: mockArchiveEq, is: mockArchiveIs });
  mockArchiveIs.mockResolvedValue({ error: null });
  mockOpsEventsUpdate.mockReturnValue({ eq: mockArchiveEq });

  mockSupabaseAdmin.value = {
    from: jest.fn((table: string) => {
      if (table === "ops_events") {
        return { update: mockOpsEventsUpdate };
      }

      return {
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            not: jest.fn().mockReturnValue({
              not: jest.fn().mockResolvedValue({
                data: [
                  {
                    id: "inst-123",
                    user_id: "user-123",
                    gateway_url: "https://agent.example.com",
                    status: "running",
                    backend: "webui",
                    api_server_key_encrypted: "encrypted",
                    host_id: "host-123",
                    hetzner_server_id: null,
                    ipv4_address: "10.250.20.56",
                  },
                ],
                error: null,
              }),
            }),
          }),
        }),
      };
    }),
  };
}

describe("runInstanceEgressSweep", () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    mockArchiveEq.mockReset();
    mockArchiveIs.mockReset();
    mockOpsEventsUpdate.mockReset();
    (recoverAndPersistApiServerKeyFromManagedHost as jest.Mock).mockResolvedValue(null);
    mockRunningInstances();
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  it("tags endpoint failures with failure ownership metadata", async () => {
    global.fetch = jest.fn().mockResolvedValue({ status: 500 }) as unknown as typeof fetch;

    const summary = await runInstanceEgressSweep();

    expect(summary.endpointFailed).toBe(1);
    expect(reportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "synthetic.egress-endpoint",
        instanceId: "inst-123",
        metadata: expect.objectContaining({
          failureOwner: "runtime",
          failurePhase: "egress",
          failureType: "egress_endpoint_unreachable",
          recoveryAction: "repair_runtime",
        }),
      })
    );
  });

  it("tags target failures with failure ownership metadata", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      status: 200,
      json: jest.fn().mockResolvedValue({
        targets: [
          {
            target: "api.openai.com",
            ok: false,
            errorClass: "gaierror",
            errorDetail: "DNS lookup failed",
          },
        ],
      }),
    }) as unknown as typeof fetch;

    const summary = await runInstanceEgressSweep();

    expect(summary.targetFailures).toBe(1);
    expect(reportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "synthetic.egress-target",
        instanceId: "inst-123",
        metadata: expect.objectContaining({
          failureOwner: "runtime",
          failurePhase: "egress",
          failureType: "egress_target_unreachable",
          recoveryAction: "repair_runtime",
        }),
      })
    );
  });

  it("skips intentionally-paused boxes (lifecycle_state='paused') so a powered-off VM's egress endpoint isn't probed", async () => {
    // The status='running' query can return a paused box whose status drifted
    // back to 'running'; its VM is shut down, so the egress endpoint is always
    // unreachable. lifecycle_state='paused' must exclude it before the probe.
    mockArchiveEq.mockReturnValue({ eq: mockArchiveEq, is: mockArchiveIs });
    mockArchiveIs.mockResolvedValue({ error: null });
    mockOpsEventsUpdate.mockReturnValue({ eq: mockArchiveEq });
    mockSupabaseAdmin.value = {
      from: jest.fn((table: string) => {
        if (table === "ops_events") {
          return { update: mockOpsEventsUpdate };
        }
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              not: jest.fn().mockReturnValue({
                not: jest.fn().mockResolvedValue({
                  data: [
                    {
                      id: "live",
                      user_id: "u1",
                      gateway_url: "https://live.example",
                      status: "running",
                      backend: "webui",
                      api_server_key_encrypted: "encrypted",
                      host_id: null,
                      hetzner_server_id: null,
                      ipv4_address: null,
                      lifecycle_state: "active",
                    },
                    {
                      id: "paused",
                      user_id: "u1",
                      gateway_url: "https://paused.example",
                      status: "running",
                      backend: "webui",
                      api_server_key_encrypted: "encrypted",
                      host_id: null,
                      hetzner_server_id: null,
                      ipv4_address: null,
                      lifecycle_state: "paused",
                    },
                  ],
                  error: null,
                }),
              }),
            }),
          }),
        };
      }),
    };
    global.fetch = jest.fn().mockResolvedValue({
      status: 200,
      json: jest.fn().mockResolvedValue({ targets: [{ target: "api.openai.com", ok: true }] }),
    }) as unknown as typeof fetch;

    const summary = await runInstanceEgressSweep();

    expect(summary.probed).toBe(1);
    expect(summary.skippedPaused).toBe(1);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("https://live.example/api/health/egress"),
      expect.any(Object),
    );
    expect(reportOpsEvent).not.toHaveBeenCalled();
  });

  it("treats persistent 401 as endpoint-missing instead of alerting, since webui doesn't process bearer auth and the route isn't implemented", async () => {
    // Reproduces the May 2026 ops-feed noise where 3 instances with webui
    // auth enabled returned 401 on every probe — webui's check_auth rejects
    // unknown paths (including /api/health/egress which isn't implemented)
    // before route lookup and ignores Authorization: Bearer entirely.
    global.fetch = jest.fn().mockResolvedValue({ status: 401 }) as unknown as typeof fetch;

    const summary = await runInstanceEgressSweep();

    expect(summary.endpointMissing).toBe(1);
    expect(summary.endpointFailed).toBe(0);
    expect(reportOpsEvent).not.toHaveBeenCalled();
    // Archive any pre-existing unauth alerts so the ops feed clears without
    // a manual purge after deploy.
    expect(mockOpsEventsUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ archived_at: expect.any(String) }),
    );
    expect(mockArchiveEq).toHaveBeenCalledWith("metadata->>endpointStatus", "unauth");
  });

  it("never recovers or persists an API server key on endpoint unauth (an egress probe must not mutate security keys)", async () => {
    // Regression guard: persisting a recovered key from a 5-min cron — with an
    // object literal that omits config.infrastructure, so recovery could not
    // route to the managing pve host — wrote a stranger's key over this
    // instance's (cross-tenant key corruption → blank white workspace). The
    // probe must now leave keys untouched and never retry with a "recovered"
    // bearer; the unauth result is handled as endpoint-missing below.
    (recoverAndPersistApiServerKeyFromManagedHost as jest.Mock).mockResolvedValue({
      apiServerKey: "fresh-gateway-secret",
      instanceIpv4: "10.250.20.56",
    });
    global.fetch = jest.fn().mockResolvedValue({ status: 401 }) as unknown as typeof fetch;

    const summary = await runInstanceEgressSweep();

    expect(recoverAndPersistApiServerKeyFromManagedHost).not.toHaveBeenCalled();
    // No second probe with a "recovered" bearer — exactly one fetch per instance.
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(summary.endpointMissing).toBe(1);
    expect(summary.endpointFailed).toBe(0);
    expect(reportOpsEvent).not.toHaveBeenCalled();
    // Prior unauth alerts are still archived so the ops feed clears.
    expect(mockArchiveEq).toHaveBeenCalledWith("metadata->>endpointStatus", "unauth");
  });
});
