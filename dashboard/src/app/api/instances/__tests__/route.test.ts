import { NextRequest } from "next/server";

import { GET, POST } from "../route";
import { auth, currentUser } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getHetznerInstanceStatus } from "@/lib/services/hetzner-instance-service";
import { getProxmoxInstanceStatus } from "@/lib/services/proxmox-instance-service";
import { checkProvisioningGate } from "@/lib/abuse/gate";
import { InstanceService } from "@/lib/services/instance-service";
import { fetchFirstReachableGatewayResponse } from "@/lib/agent-gateway";
import { recoverProxmoxInstanceAcrossFleet } from "@/lib/recovery/recover-orphan-provisioning";
import { makeJsonRequest } from "@/test-utils";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
  currentUser: jest.fn(),
}));

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/services/hetzner-instance-service", () => ({
  getHetznerInstanceStatus: jest.fn(),
}));

jest.mock("@/lib/services/proxmox-instance-service", () => {
  const actual = jest.requireActual("@/lib/services/proxmox-instance-service");
  return {
    ...actual,
    getProxmoxInstanceStatus: jest.fn().mockResolvedValue({ status: "running" }),
  };
});

jest.mock("@/lib/instance-settings", () => ({
  getPublicInstanceConfig: jest.fn((config: Record<string, unknown>) => config),
}));

jest.mock("@/lib/agent-gateway", () => ({
  fetchFirstReachableGatewayResponse: jest.fn(),
}));

jest.mock("@/lib/abuse/gate", () => ({
  checkProvisioningGate: jest.fn(),
}));

jest.mock("@/lib/crypto", () => ({
  decryptApiKey: jest.fn((value: string) => value),
}));

// Post-ready SOUL.md seed hook: the list sync schedules it when a webfree box
// is promoted to running (deterministic close of the provision seed race).
jest.mock("@/lib/recovery/soul-seed-reconcile", () => ({
  scheduleSoulSeedReconcileAfterResponse: jest.fn(),
}));

// Agent-ready push hook (iOS Phase 2): scheduled at the same promotion seam,
// mocked so no expo transport / after() context is needed in tests.
jest.mock("@/lib/push/agent-ready-push", () => ({
  scheduleAgentReadyPushAfterResponse: jest.fn(),
}));

jest.mock("@/lib/recovery/recover-orphan-provisioning", () => ({
  recoverProxmoxInstanceAcrossFleet: jest.fn(),
}));

import { scheduleSoulSeedReconcileAfterResponse } from "@/lib/recovery/soul-seed-reconcile";
import { scheduleAgentReadyPushAfterResponse } from "@/lib/push/agent-ready-push";

const mockedScheduleSoulSeed =
  scheduleSoulSeedReconcileAfterResponse as jest.Mock;
const mockedScheduleAgentReadyPush =
  scheduleAgentReadyPushAfterResponse as jest.Mock;

describe("GET /api/instances", () => {
  const instancesUpdateEqMock = jest.fn().mockResolvedValue({ error: null });
  const instancesUpdateMock = jest.fn().mockReturnValue({
    eq: instancesUpdateEqMock,
  });
  let instanceRows: Array<Record<string, unknown>>;

  let consoleErrorSpy: jest.SpyInstance;
  let consoleWarnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    (recoverProxmoxInstanceAcrossFleet as jest.Mock).mockResolvedValue({
      status: "inconclusive",
    });
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_123" });
    (currentUser as unknown as jest.Mock).mockResolvedValue({
      primaryEmailAddress: { emailAddress: "person@example.com" },
      emailAddresses: [],
    });
    (checkProvisioningGate as jest.Mock).mockResolvedValue({ allow: true });
    (getHetznerInstanceStatus as jest.Mock).mockResolvedValue({
      status: "running",
      ipv4: "203.0.113.10",
    });
    (fetchFirstReachableGatewayResponse as jest.Mock).mockRejectedValue(
      new Error("gateway still warming")
    );
    instanceRows = [
      {
        id: "inst-123",
        name: "Atlas",
        status: "provisioning",
        provider: "openai",
        gateway_url: "https://atlas.example.com",
        api_server_key_encrypted: "gateway-secret",
        ipv4_address: "203.0.113.10",
        hetzner_server_id: 42,
        config: { model: "gpt-test" },
        lifecycle_state: "provisioning",
        created_at: "2026-04-18T10:00:00.000Z",
      },
    ];

    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "hermes_instances") {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              neq: jest.fn().mockReturnValue({
                neq: jest.fn().mockReturnValue({
                  order: jest.fn().mockReturnValue({
                    returns: jest.fn().mockResolvedValue({
                      data: instanceRows,
                      error: null,
                    }),
                  }),
                }),
              }),
            }),
          }),
          update: instancesUpdateMock,
        };
      }

      if (table === "ops_events") {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              is: jest.fn().mockReturnValue({
                in: jest.fn().mockReturnValue({
                  order: jest.fn().mockResolvedValue({
                    data: [],
                    error: null,
                  }),
                }),
              }),
            }),
            is: jest.fn().mockReturnValue({
              in: jest.fn().mockReturnValue({
                order: jest.fn().mockResolvedValue({
                  data: [],
                  error: null,
                }),
              }),
            }),
          }),
        };
      }

      throw new Error(`Unexpected table ${table}`);
    });
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  it("keeps provisioning instances out of running state until the gateway answers", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/instances?summary=true")
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data).toEqual([
      expect.objectContaining({
        id: "inst-123",
        status: "provisioning",
        public_ipv4: "203.0.113.10",
      }),
    ]);
    expect(fetchFirstReachableGatewayResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://atlas.example.com",
        pathname: "/v1/models",
        instanceIpv4: "203.0.113.10",
        headers: expect.objectContaining({
          Authorization: "Bearer gateway-secret",
        }),
      })
    );
    expect(
      instancesUpdateMock.mock.calls.some(
        ([payload]) => payload && typeof payload === "object" && (payload as { status?: string }).status === "running"
      )
    ).toBe(false);
  });

  it("probes WebUI-backed Hetzner instances through /health before marking them running", async () => {
    instanceRows = [
      {
        id: "inst-webui",
        name: "WebUI Agent",
        status: "provisioning",
        provider: "openai",
        backend: "webui",
        gateway_url: "https://webui.example.com",
        api_server_key_encrypted: "gateway-secret",
        ipv4_address: "203.0.113.10",
        hetzner_server_id: 42,
        config: { model: "gpt-test" },
        created_at: "2026-04-18T10:00:00.000Z",
      },
    ];
    (fetchFirstReachableGatewayResponse as jest.Mock).mockResolvedValue({
      response: {
        ok: true,
        text: jest.fn().mockResolvedValue("ok"),
      },
      url: "https://webui.example.com/health",
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances?summary=true")
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data).toEqual([
      expect.objectContaining({
        id: "inst-webui",
        status: "running",
      }),
    ]);
    expect(fetchFirstReachableGatewayResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://webui.example.com",
        pathname: "/health",
        instanceIpv4: "203.0.113.10",
        headers: {},
      })
    );
    expect(instancesUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "running",
        lifecycle_state: "active",
        last_lifecycle_transition_at: expect.any(String),
      })
    );
    // A webfree promotion to running must schedule the post-ready SOUL.md
    // seed — the only write guaranteed to land AFTER the agent's own
    // factory-default write (the in-band provision seed races it and loses).
    expect(mockedScheduleSoulSeed).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: "inst-webui",
        trigger: "list_provision_promote",
      })
    );
  });

  it("asks Supabase to exclude terminal-deleted rows from list results", async () => {
    // Belt-and-suspenders: filter BOTH `status='deleted'` (UI-facing flag
    // older code wrote) AND `lifecycle_state='deleted'` (post-Sprint-0
    // source of truth). Pre-2026-05-17 only the status check existed,
    // and a cleanup pass that set lifecycle_state without syncing status
    // left 9 production rows ghost-visible to users in their dashboards.
    const returnsMock = jest.fn().mockResolvedValue({ data: [], error: null });
    const orderMock = jest.fn().mockReturnValue({ returns: returnsMock });
    const lifecycleNeqMock = jest.fn().mockReturnValue({ order: orderMock });
    const statusNeqMock = jest
      .fn()
      .mockReturnValue({ neq: lifecycleNeqMock });
    const eqMock = jest.fn().mockReturnValue({ neq: statusNeqMock });
    const selectMock = jest.fn().mockReturnValue({ eq: eqMock });

    (supabaseAdmin!.from as jest.Mock).mockImplementationOnce((table: string) => {
      if (table !== "hermes_instances") {
        throw new Error(`Unexpected table ${table}`);
      }

      return { select: selectMock, update: instancesUpdateMock };
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances?summary=true")
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data).toEqual([]);
    expect(eqMock).toHaveBeenCalledWith("user_id", "user_123");
    expect(statusNeqMock).toHaveBeenCalledWith("status", "deleted");
    expect(lifecycleNeqMock).toHaveBeenCalledWith("lifecycle_state", "deleted");
  });

  it("skips live running-instance probes in summary mode", async () => {
    instanceRows = [
      {
        id: "inst-123",
        name: "Atlas",
        status: "running",
        provider: "openai",
        gateway_url: "https://atlas.example.com",
        api_server_key_encrypted: "gateway-secret",
        ipv4_address: "203.0.113.10",
        hetzner_server_id: 42,
        config: { model: "gpt-test" },
        created_at: "2026-04-18T10:00:00.000Z",
      },
    ];

    const response = await GET(
      new NextRequest("http://localhost/api/instances?summary=true")
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data).toEqual([
      expect.objectContaining({
        id: "inst-123",
        status: "running",
      }),
    ]);
    expect(getHetznerInstanceStatus).not.toHaveBeenCalled();
    expect(fetchFirstReachableGatewayResponse).not.toHaveBeenCalled();
    expect(instancesUpdateMock).not.toHaveBeenCalled();
  });

  it("keeps cold-storage lifecycle fields in summary mode so the dashboard can offer restore", async () => {
    instanceRows = [
      {
        id: "inst-cold",
        name: "Cold Agent",
        status: "stopped",
        provider: "openai",
        gateway_url: null,
        api_server_key_encrypted: null,
        ipv4_address: null,
        hetzner_server_id: null,
        lifecycle_state: "cold_archived",
        paused_reason: "cold_archived",
        config: { model: "gpt-test" },
        created_at: "2026-04-18T10:00:00.000Z",
      },
    ];

    const response = await GET(
      new NextRequest("http://localhost/api/instances?summary=true")
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data).toEqual([
      expect.objectContaining({
        id: "inst-cold",
        status: "stopped",
        lifecycle_state: "cold_archived",
        paused_reason: "cold_archived",
      }),
    ]);
    expect(getHetznerInstanceStatus).not.toHaveBeenCalled();
    expect(fetchFirstReachableGatewayResponse).not.toHaveBeenCalled();
  });

  it("exposes first_usage_at in summary mode so the onboarding checklist can read activation", async () => {
    instanceRows = [
      {
        id: "inst-activated",
        name: "Activated Agent",
        status: "running",
        provider: "openai",
        gateway_url: null,
        api_server_key_encrypted: null,
        ipv4_address: null,
        hetzner_server_id: null,
        lifecycle_state: "active",
        config: { model: "gpt-test" },
        created_at: "2026-06-09T10:00:00.000Z",
        first_usage_at: "2026-06-09T12:34:56.000Z",
      },
      {
        id: "inst-untouched",
        name: "Untouched Agent",
        status: "running",
        provider: "openai",
        gateway_url: null,
        api_server_key_encrypted: null,
        ipv4_address: null,
        hetzner_server_id: null,
        lifecycle_state: "active",
        config: { model: "gpt-test" },
        created_at: "2026-06-09T10:00:00.000Z",
      },
    ];

    const response = await GET(
      new NextRequest("http://localhost/api/instances?summary=true")
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data).toEqual([
      expect.objectContaining({
        id: "inst-activated",
        created_at: "2026-06-09T10:00:00.000Z",
        first_usage_at: "2026-06-09T12:34:56.000Z",
      }),
      expect.objectContaining({
        id: "inst-untouched",
        first_usage_at: null,
      }),
    ]);
  });

  it("probes Proxmox-backed provisioning instances without calling Hetzner", async () => {
    instanceRows = [
      {
        id: "inst-proxmox",
        name: "Proxmox Agent",
        status: "provisioning",
        provider: "openai",
        gateway_url: "https://abc123.203-0-113-10.sslip.io",
        api_server_key_encrypted: "gateway-secret",
        ipv4_address: "10.250.20.51",
        hetzner_server_id: null,
        lifecycle_state: "provisioning",
        config: {
          infrastructure: {
            provider: "proxmox",
            vmid: 201,
            privateIpv4: "10.250.20.51",
            gatewayHost: "abc123.203-0-113-10.sslip.io",
          },
        },
        created_at: "2026-04-18T10:00:00.000Z",
      },
    ];
    (fetchFirstReachableGatewayResponse as jest.Mock).mockResolvedValue({
      response: {
        ok: true,
        text: jest.fn().mockResolvedValue("ok"),
      },
      url: "https://abc123.203-0-113-10.sslip.io/v1/models",
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances?summary=true")
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data).toEqual([
      expect.objectContaining({
        id: "inst-proxmox",
        status: "running",
      }),
    ]);
    expect(getHetznerInstanceStatus).not.toHaveBeenCalled();
    expect(fetchFirstReachableGatewayResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://abc123.203-0-113-10.sslip.io",
        pathname: "/v1/models",
        headers: expect.objectContaining({
          Authorization: "Bearer gateway-secret",
        }),
      })
    );
    expect(instancesUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "running",
        lifecycle_state: "active",
        last_lifecycle_transition_at: expect.any(String),
      })
    );
    // This row is a LEGACY non-webfree instance (no `backend` field, bearer
    // probe) — the SOUL.md seed is a webfree-lane concept, so its promotion
    // must NOT schedule the post-ready reconcile.
    expect(mockedScheduleSoulSeed).not.toHaveBeenCalled();
  });

  it("promotes gateway-backend Proxmox rows over the bearer-authed chat lane, not /health", async () => {
    // '/health' answers from the official-dashboard shell before the gateway
    // that answers chat is up (canary run fixturecase04: 8s gap; prod fixturecase05:
    // >190s) — promoting on it painted a workspace whose first message died.
    instanceRows = [
      {
        id: "inst-proxmox-gw",
        name: "Proxmox Webfree Agent",
        status: "provisioning",
        provider: "venice",
        backend: "gateway",
        gateway_url: "https://abc123.203-0-113-10.sslip.io",
        api_server_key_encrypted: "chat-lane-secret",
        ipv4_address: "10.250.20.51",
        hetzner_server_id: null,
        lifecycle_state: "provisioning",
        config: {
          infrastructure: {
            provider: "proxmox",
            vmid: 202,
            privateIpv4: "10.250.20.51",
            gatewayHost: "abc123.203-0-113-10.sslip.io",
          },
        },
        created_at: "2026-07-10T10:00:00.000Z",
      },
    ];
    (fetchFirstReachableGatewayResponse as jest.Mock).mockResolvedValue({
      response: {
        ok: true,
        text: jest.fn().mockResolvedValue("[]"),
      },
      url: "https://abc123.203-0-113-10.sslip.io/api/sessions",
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances?summary=true")
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data).toEqual([
      expect.objectContaining({
        id: "inst-proxmox-gw",
        status: "running",
      }),
    ]);
    expect(fetchFirstReachableGatewayResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://abc123.203-0-113-10.sslip.io",
        pathname: "/api/sessions",
        headers: { Authorization: "Bearer chat-lane-secret" },
      })
    );
  });

  it("schedules the agent-ready push when a provisioning Proxmox box is promoted to running", async () => {
    instanceRows = [
      {
        id: "inst-proxmox-gw",
        name: "Proxmox Webfree Agent",
        status: "provisioning",
        provider: "venice",
        backend: "gateway",
        gateway_url: "https://abc123.203-0-113-10.sslip.io",
        api_server_key_encrypted: "chat-lane-secret",
        ipv4_address: "10.250.20.51",
        hetzner_server_id: null,
        lifecycle_state: "provisioning",
        config: {
          infrastructure: {
            provider: "proxmox",
            vmid: 202,
            privateIpv4: "10.250.20.51",
            gatewayHost: "abc123.203-0-113-10.sslip.io",
          },
        },
        created_at: "2026-07-10T10:00:00.000Z",
      },
    ];
    (fetchFirstReachableGatewayResponse as jest.Mock).mockResolvedValue({
      response: { ok: true, text: jest.fn().mockResolvedValue("[]") },
      url: "https://abc123.203-0-113-10.sslip.io/api/sessions",
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances?summary=true")
    );
    const json = await response.json();

    expect(json.data).toEqual([
      expect.objectContaining({ id: "inst-proxmox-gw", status: "running" }),
    ]);
    expect(mockedScheduleAgentReadyPush).toHaveBeenCalledTimes(1);
    expect(mockedScheduleAgentReadyPush).toHaveBeenCalledWith({
      instanceId: "inst-proxmox-gw",
      userId: "user_123",
      trigger: "list_provision_promote_proxmox",
    });
  });

  it("schedules the agent-ready push on the Hetzner promotion lane too", async () => {
    instanceRows = [
      {
        id: "inst-webui",
        name: "WebUI Agent",
        status: "provisioning",
        provider: "openai",
        backend: "webui",
        gateway_url: "https://webui.example.com",
        api_server_key_encrypted: "gateway-secret",
        ipv4_address: "203.0.113.10",
        hetzner_server_id: 42,
        config: { model: "gpt-test" },
        created_at: "2026-04-18T10:00:00.000Z",
      },
    ];
    (fetchFirstReachableGatewayResponse as jest.Mock).mockResolvedValue({
      response: { ok: true, text: jest.fn().mockResolvedValue("ok") },
      url: "https://webui.example.com/health",
    });

    await GET(new NextRequest("http://localhost/api/instances?summary=true"));

    expect(mockedScheduleAgentReadyPush).toHaveBeenCalledWith({
      instanceId: "inst-webui",
      userId: "user_123",
      trigger: "list_provision_promote_hetzner",
    });
  });

  it("does NOT schedule the agent-ready push when a redeploying box comes back running", async () => {
    // "ready — say hi" is a first-provision moment only; a redeploy finishing
    // must not re-notify (belt: the trigger gate here; braces: the
    // notifications_sent once-guard inside the scheduled callback).
    instanceRows = [
      {
        id: "inst-redeploy",
        name: "Redeploying Agent",
        status: "redeploying",
        provider: "venice",
        backend: "gateway",
        gateway_url: "https://redeploy.203-0-113-10.sslip.io",
        api_server_key_encrypted: "chat-lane-secret",
        ipv4_address: "10.250.20.52",
        hetzner_server_id: null,
        lifecycle_state: "provisioning",
        config: {
          infrastructure: {
            provider: "proxmox",
            vmid: 203,
            privateIpv4: "10.250.20.52",
            gatewayHost: "redeploy.203-0-113-10.sslip.io",
          },
        },
        created_at: "2026-07-10T10:00:00.000Z",
      },
    ];
    (fetchFirstReachableGatewayResponse as jest.Mock).mockResolvedValue({
      response: { ok: true, text: jest.fn().mockResolvedValue("[]") },
      url: "https://redeploy.203-0-113-10.sslip.io/api/sessions",
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances?summary=true")
    );
    const json = await response.json();

    expect(json.data).toEqual([
      expect.objectContaining({ id: "inst-redeploy", status: "running" }),
    ]);
    expect(mockedScheduleAgentReadyPush).not.toHaveBeenCalled();
  });

  it("does NOT downgrade a long-running instance on a single failed gateway probe during full fetches (2026-06-28 regression guard — async health crons own running-box health)", async () => {
    instanceRows = [
      {
        id: "inst-123",
        name: "Atlas",
        status: "running",
        provider: "openai",
        gateway_url: "https://atlas.example.com",
        api_server_key_encrypted: "gateway-secret",
        ipv4_address: "203.0.113.10",
        hetzner_server_id: 42,
        config: { model: "gpt-test" },
        created_at: "2026-04-18T10:00:00.000Z",
      },
    ];
    // Probe can't reach the box — a transient blip or a Vercel-side reachability
    // gap (e.g. a grey-cloud DNS record whose raw host IP Vercel can't connect
    // to). A single synchronous miss must NOT flap a healthy running box to
    // "provisioning" — in the [id] reconcile the 25-min stale-sweeper then
    // hard-errors that to "Agent Offline" (the day-long incident). Degraded-
    // runtime detection is the recover-unhealthy-active cron's job (it retries).
    (fetchFirstReachableGatewayResponse as jest.Mock).mockRejectedValueOnce(
      new Error("connect ETIMEDOUT (unreachable from Vercel)")
    );

    const response = await GET(
      new NextRequest("http://localhost/api/instances")
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data).toEqual([
      expect.objectContaining({
        id: "inst-123",
        status: "running",
      })
    ]);
    // Security regression guard: the encrypted gateway bearer is a
    // server-only secret pulled in by select("*"). Full mode must redact
    // it (the `...inst` spread would otherwise serialize it to the client).
    expect(json.data[0]).not.toHaveProperty("api_server_key_encrypted");
    // The probe still RUNS — we just don't act on a single miss for a running box.
    expect(fetchFirstReachableGatewayResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://atlas.example.com",
        pathname: "/v1/models",
        instanceIpv4: "203.0.113.10",
      })
    );
    // Must NOT persist a provisioning/error downgrade for the running box.
    expect(
      instancesUpdateMock.mock.calls.some(
        ([payload]) =>
          payload &&
          typeof payload === "object" &&
          ["provisioning", "error"].includes((payload as { status?: string }).status as string)
      )
    ).toBe(false);
  });

  it("preserves a Proxmox handle when a routed-host miss is inconclusive across the fleet", async () => {
    // The Phase-2 cleanup trap destroyed the VM (failed bootstrap), so
    // `qm status` reports it missing. Before this fix the list reconcile
    // only set status="stopped" while leaving proxmox_vmid + config.infra
    // intact and no release marker — recover-missing-vm-instances (which
    // needs proxmox_vmid IS NULL + an infrastructureReleased marker) never
    // matched, and the user was stuck on the repairing banner forever.
    instanceRows = [
      {
        id: "inst-vm-gone",
        name: "Ghost Agent",
        status: "running",
        provider: "openai",
        backend: "webui",
        gateway_url: "https://ghost.203-0-113-10.sslip.io",
        api_server_key_encrypted: "gateway-secret",
        ipv4_address: "10.250.20.77",
        hetzner_server_id: null,
        lifecycle_state: "active",
        config: {
          model: "gpt-test",
          infrastructure: {
            provider: "proxmox",
            vmid: 777,
            privateIpv4: "10.250.20.77",
            gatewayHost: "ghost.203-0-113-10.sslip.io",
          },
        },
        created_at: "2026-04-18T10:00:00.000Z",
      },
    ];
    // Per-vmid fallback (no host-routing config on the infra → batch is
    // skipped) returns vmMissing.
    (getProxmoxInstanceStatus as jest.Mock).mockResolvedValueOnce({
      status: "stopped",
      vmMissing: true,
    });

    // Full fetch (no summary) so a running box is synced.
    const response = await GET(new NextRequest("http://localhost/api/instances"));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    // No HTTP probe should run — the VM is gone, qm status is authoritative.
    expect(fetchFirstReachableGatewayResponse).not.toHaveBeenCalled();

    const releasePatch = instancesUpdateMock.mock.calls
      .map(([payload]) => payload as Record<string, unknown> | undefined)
      .find((payload) => payload && payload.status === "error");
    expect(releasePatch).toBeDefined();
    expect(releasePatch!.proxmox_vmid).toBeUndefined();
    expect(releasePatch!.config).toBeUndefined();
    expect(recoverProxmoxInstanceAcrossFleet).toHaveBeenCalledWith(
      expect.objectContaining({ id: "inst-vm-gone", proxmox_vmid: 777 }),
    );
    // The released row surfaces as a terminal error, not silently "stopped".
    expect(json.data[0]).toEqual(
      expect.objectContaining({ id: "inst-vm-gone", status: "error" })
    );
  });

  it("does not log raw database text when instance rows cannot be loaded", async () => {
    (supabaseAdmin!.from as jest.Mock).mockImplementationOnce((table: string) => {
      if (table !== "hermes_instances") {
        throw new Error(`Unexpected table ${table}`);
      }

      return {
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            neq: jest.fn().mockReturnValue({
              neq: jest.fn().mockReturnValue({
                order: jest.fn().mockReturnValue({
                  returns: jest.fn().mockResolvedValue({
                    data: null,
                    error: { message: "instances read replica 5 timed out" },
                  }),
                }),
              }),
            }),
          }),
        }),
        update: instancesUpdateMock,
      };
    });

    const response = await GET(new NextRequest("http://localhost/api/instances"));
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error).toBe("Failed to fetch instances");
    expect(JSON.stringify(json)).not.toContain("instances read replica 5 timed out");
    expect(consoleErrorSpy.mock.calls.flat().join(" ")).not.toContain("instances read replica 5 timed out");
  });

  it("hides unexpected GET errors from the client", async () => {
    (supabaseAdmin!.from as jest.Mock).mockImplementationOnce(() => {
      throw new Error("instances-get-secret");
    });

    const response = await GET(new NextRequest("http://localhost/api/instances"));
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error).toBe("Internal Server Error");
    expect(json.error).not.toContain("instances-get-secret");
    expect(consoleErrorSpy.mock.calls.flat().join(" ")).not.toContain("instances-get-secret");
  });

  it("hides unexpected POST errors from the client", async () => {
    (auth as unknown as jest.Mock).mockRejectedValueOnce(new Error("instances-post-secret"));

    const response = await POST(
      makeJsonRequest("http://localhost/api/instances", {}, { method: "POST" })
    );
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error).toBe("Internal Server Error");
    expect(json.error).not.toContain("instances-post-secret");
    expect(consoleErrorSpy.mock.calls.flat().join(" ")).not.toContain("instances-post-secret");
  });

  it("returns card_required and skips provisioning when the free-tier abuse gate requires a card", async () => {
    (checkProvisioningGate as jest.Mock).mockResolvedValueOnce({
      allow: false,
      status: 402,
      message: "Card on file required to deploy on the free tier. No charge will be made.",
      reason: "card_required",
    });
    const createInstanceSpy = jest.spyOn(InstanceService, "createInstance");

    const response = await POST(
      new NextRequest("http://localhost/api/instances", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "198.51.100.42",
        },
        body: JSON.stringify({
          name: "Gate Test",
          provider: "openai",
          apiKey: "sk-test",
          model: "gpt-test",
          fingerprintRequestId: "fp_req_123",
        }),
      })
    );
    const json = await response.json();

    expect(response.status).toBe(402);
    expect(json).toEqual(
      expect.objectContaining({
        success: false,
        error: "Card on file required to deploy on the free tier. No charge will be made.",
        reason: "card_required",
      })
    );
    expect(checkProvisioningGate).toHaveBeenCalledWith({
      userId: "user_123",
      ip: "198.51.100.42",
      email: "person@example.com",
      fingerprintRequestId: "fp_req_123",
    });
    expect(createInstanceSpy).not.toHaveBeenCalled();
  });

  it("returns blocked and skips provisioning when the free-tier abuse gate hard-blocks the account", async () => {
    (checkProvisioningGate as jest.Mock).mockResolvedValueOnce({
      allow: false,
      status: 403,
      message: "Account flagged by automated review. Contact support if this is in error.",
      reason: "blocked",
    });
    const createInstanceSpy = jest.spyOn(InstanceService, "createInstance");

    const response = await POST(
      new NextRequest("http://localhost/api/instances", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "198.51.100.43",
        },
        body: JSON.stringify({
          name: "Blocked Test",
          provider: "openai",
          apiKey: "sk-test",
          model: "gpt-test",
          fingerprintRequestId: "fp_req_blocked",
        }),
      })
    );
    const json = await response.json();

    expect(response.status).toBe(403);
    expect(json).toEqual(
      expect.objectContaining({
        success: false,
        error: "Account flagged by automated review. Contact support if this is in error.",
        reason: "blocked",
      })
    );
    expect(checkProvisioningGate).toHaveBeenCalledWith({
      userId: "user_123",
      ip: "198.51.100.43",
      email: "person@example.com",
      fingerprintRequestId: "fp_req_blocked",
    });
    expect(createInstanceSpy).not.toHaveBeenCalled();
  });

  it("returns the failureType code on provision failures and never leaks host-script internals", async () => {
    const rawHostStderr =
      "[caddy] missing Cloudflare Origin CA cert/key at /etc/caddy/wildcards/hermesos.cloud.{crt,key}; seed the host before provisioning";
    const createInstanceSpy = jest
      .spyOn(InstanceService, "createInstance")
      .mockResolvedValueOnce({
        success: false,
        status: 500,
        message:
          "Our capacity system hit a snag provisioning your agent — we've been alerted. Please try again in a few minutes.",
        failureType: "provision_host_failure",
        // Server-only detail channel — apiError must keep this out of the
        // response body.
        error: { detail: rawHostStderr },
      });

    const response = await POST(
      new NextRequest("http://localhost/api/instances", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "198.51.100.44",
        },
        body: JSON.stringify({
          name: "Host Failure Test",
          provider: "openai",
          apiKey: "sk-test",
          model: "gpt-test",
        }),
      })
    );
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json).toEqual(
      expect.objectContaining({
        success: false,
        failureType: "provision_host_failure",
      })
    );
    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain("/etc/caddy");
    expect(serialized).not.toContain("Cloudflare Origin CA");
    // Deploy failures are user-attributable: the request context threads the
    // authed userId into the error log (and from there into ops_events).
    expect(consoleErrorSpy.mock.calls.flat().join(" ")).toContain("user_123");

    createInstanceSpy.mockRestore();
  });

  it("logs 4xx deploy rejections at error level with a status-derived failureType", async () => {
    const createInstanceSpy = jest
      .spyOn(InstanceService, "createInstance")
      .mockResolvedValueOnce({
        success: false,
        status: 403,
        message:
          "Insufficient CPU budget. Your Operator plan has 16 vCPU total.",
      });

    const response = await POST(
      new NextRequest("http://localhost/api/instances", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "198.51.100.45",
        },
        body: JSON.stringify({
          name: "Budget Test",
          provider: "openai",
          apiKey: "sk-test",
          model: "gpt-test",
        }),
      })
    );
    const json = await response.json();

    expect(response.status).toBe(403);
    expect(json).toEqual(
      expect.objectContaining({
        success: false,
        error: "Insufficient CPU budget. Your Operator plan has 16 vCPU total.",
        failureType: "deploy_rejected_403",
      })
    );
    // Only error-level log lines mirror into ops_events; the rejection must
    // land there with its failureType and the authed userId.
    const loggedErrors = consoleErrorSpy.mock.calls.flat().join(" ");
    expect(loggedErrors).toContain("deploy_rejected_403");
    expect(loggedErrors).toContain("user_123");

    createInstanceSpy.mockRestore();
  });
});
