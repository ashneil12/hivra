import { NextRequest } from "next/server";
import crypto from "node:crypto";

import { GET } from "../route";
import { auth } from "@clerk/nextjs/server";
import {
  AgentGatewayRequestError,
  fetchFirstReachableGatewayResponse,
} from "@/lib/agent-gateway";
import {
  ensureManagedSidecarScript,
  getSecureUserInstance,
  recoverAndPersistApiServerKeyFromManagedHost,
} from "@/lib/services/instance-security";
import { log } from "@/lib/logger";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));

jest.mock("@/lib/services/instance-security", () => ({
  getSecureUserInstance: jest.fn(),
  ensureManagedSidecarScript: jest.fn(),
  recoverAndPersistApiServerKeyFromManagedHost: jest.fn(),
}));

jest.mock("@/lib/agent-gateway", () => {
  const actual = jest.requireActual("@/lib/agent-gateway");
  return {
    ...actual,
    fetchFirstReachableGatewayResponse: jest.fn(),
  };
});

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

describe("GET /api/instances/[id]/official-dashboard", () => {
  type SecureUserInstanceResult = Awaited<ReturnType<typeof getSecureUserInstance>>;
  type SecureUserInstanceSuccess = Extract<SecureUserInstanceResult, { error: null }>;

  const mockedAuth = auth as jest.MockedFunction<typeof auth>;
  const mockedGetSecureUserInstance = getSecureUserInstance as jest.MockedFunction<typeof getSecureUserInstance>;
  const mockedEnsureManagedSidecarScript =
    ensureManagedSidecarScript as jest.MockedFunction<typeof ensureManagedSidecarScript>;
  const mockedRecoverApiServerKey =
    recoverAndPersistApiServerKeyFromManagedHost as jest.MockedFunction<typeof recoverAndPersistApiServerKeyFromManagedHost>;
  const mockedFetchGatewayResponse =
    fetchFirstReachableGatewayResponse as jest.MockedFunction<typeof fetchFirstReachableGatewayResponse>;
  let consoleWarnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    mockedAuth.mockResolvedValue({ userId: "user_123" } as Awaited<ReturnType<typeof auth>>);
    mockedEnsureManagedSidecarScript.mockResolvedValue(true);
    mockedFetchGatewayResponse.mockResolvedValue({
      response: new Response(JSON.stringify({ ok: true }), { status: 200 }),
      url: "https://agent.example.com/_sidecar/dashboard-session-check",
    });
    mockedRecoverApiServerKey.mockResolvedValue(null);
    const secureUserInstance: SecureUserInstanceSuccess = {
      instance: {
        id: "inst_123",
        gateway_url: "https://agent.example.com",
        api_server_key_encrypted: "encrypted-key",
        user_id: "user_123",
        status: "running",
        host_id: null,
        hetzner_server_id: null,
        cpu_limit: null,
        ram_limit: null,
      },
      apiServerKey: "server-key",
      instanceIpv4: "203.0.113.10",
      error: null,
    };

    mockedGetSecureUserInstance.mockResolvedValue(secureUserInstance);
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
  });

  it("redirects authorized owners through the sidecar dashboard handoff without blocking on a sidecar refresh", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst_123/official-dashboard"),
      { params: Promise.resolve({ id: "inst_123" }) }
    );

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).toContain("https://agent.example.com/_sidecar/dashboard-login");
    expect(location).toContain("next=%2F");
    expect(location).toContain("nonce=");
    expect(location).toContain("sig=");
    expect(mockedEnsureManagedSidecarScript).not.toHaveBeenCalled();
    expect(mockedFetchGatewayResponse).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: "https://agent.example.com",
      pathname: "/_sidecar/dashboard-session-check",
      instanceIpv4: "203.0.113.10",
    }));
  });

  it("keeps managed sslip.io gateways on HTTPS when the certificate is available", async () => {
    mockedGetSecureUserInstance.mockResolvedValue({
      instance: {
        id: "inst_123",
        gateway_url: "https://203-0-113-10.sslip.io",
        api_server_key_encrypted: "encrypted-key",
        user_id: "user_123",
        status: "running",
        host_id: null,
        hetzner_server_id: null,
        cpu_limit: null,
        ram_limit: null,
      },
      apiServerKey: "server-key",
      instanceIpv4: "203.0.113.10",
      error: null,
    } as Awaited<ReturnType<typeof getSecureUserInstance>>);

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst_123/official-dashboard"),
      { params: Promise.resolve({ id: "inst_123" }) }
    );

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).toContain("https://203-0-113-10.sslip.io/_sidecar/dashboard-login");
    expect(location).not.toContain("http://203.0.113.10");
  });

  it("can return the signed dashboard handoff URL as JSON for the existing app tab to launch", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst_123/official-dashboard?format=json"),
      { params: Promise.resolve({ id: "inst_123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(json.url).toContain("https://agent.example.com/_sidecar/dashboard-login");
    expect(json.url).toContain("next=%2F");
    expect(json.url).toContain("nonce=");
    expect(json.url).toContain("sig=");
    expect(json.url).not.toContain("server-key");
  });

  it("returns 401 when the user is not authenticated", async () => {
    mockedAuth.mockResolvedValue({ userId: null } as Awaited<ReturnType<typeof auth>>);

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst_123/official-dashboard"),
      { params: Promise.resolve({ id: "inst_123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(401);
    expect(json.error).toBe("Unauthorized");
    expect(mockedGetSecureUserInstance).not.toHaveBeenCalled();
  });

  it("returns 404 when the instance lookup fails ownership or readiness checks", async () => {
    mockedGetSecureUserInstance.mockResolvedValue({
      instance: null,
      apiServerKey: "",
      instanceIpv4: "",
      error: "Instance not found or unauthorized",
    } as Awaited<ReturnType<typeof getSecureUserInstance>>);

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst_123/official-dashboard"),
      { params: Promise.resolve({ id: "inst_123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(404);
    expect(json.error).toContain("Instance not found");
  });

  it("opens WebUI dashboards through the signed sidecar handoff without exposing the bearer", async () => {
    mockedGetSecureUserInstance.mockResolvedValue({
      instance: {
        id: "inst_123",
        backend: "webui",
        gateway_url: "https://webui.example.com",
        api_server_key_encrypted: "encrypted-key",
        user_id: "user_123",
        status: "running",
        host_id: null,
        hetzner_server_id: null,
        cpu_limit: null,
        ram_limit: null,
      },
      apiServerKey: "server-key",
      instanceIpv4: "203.0.113.10",
      error: null,
    } as Awaited<ReturnType<typeof getSecureUserInstance>>);

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst_123/official-dashboard"),
      { params: Promise.resolve({ id: "inst_123" }) }
    );

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).toContain("https://webui.example.com/_sidecar/dashboard-login");
    expect(new URL(location || "").searchParams.get("next")).toBe("/dash");
    expect(location).toContain("nonce=");
    expect(location).toContain("sig=");
    expect(location).not.toContain("server-key");
    expect(mockedEnsureManagedSidecarScript).not.toHaveBeenCalled();
    expect(mockedFetchGatewayResponse).toHaveBeenCalledWith(expect.objectContaining({
      pathname: "/_sidecar/api/status",
      baseUrl: "https://webui.example.com",
    }));
  });

  it("does not send the browser to a WebUI official dashboard until the upstream dashboard answers", async () => {
    mockedGetSecureUserInstance.mockResolvedValue({
      instance: {
        id: "inst_123",
        backend: "webui",
        gateway_url: "https://webui.example.com",
        api_server_key_encrypted: "encrypted-key",
        user_id: "user_123",
        status: "running",
        host_id: null,
        hetzner_server_id: null,
        cpu_limit: null,
        ram_limit: null,
      },
      apiServerKey: "server-key",
      instanceIpv4: "203.0.113.10",
      error: null,
    } as Awaited<ReturnType<typeof getSecureUserInstance>>);
    mockedFetchGatewayResponse
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify({ ok: true }), { status: 200 }),
        url: "https://webui.example.com/_sidecar/dashboard-session-check",
      })
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify({ error: "dashboard unavailable" }), { status: 503 }),
        url: "https://webui.example.com/_sidecar/api/status",
      });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst_123/official-dashboard"),
      { params: Promise.resolve({ id: "inst_123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(502);
    expect(response.headers.get("location")).toBeNull();
    expect(json.error).toContain("Official dashboard is still starting");
    expect(mockedFetchGatewayResponse).toHaveBeenLastCalledWith(expect.objectContaining({
      pathname: "/_sidecar/api/status",
      timeoutMs: 20_000,
    }));
    expect(log.warn).toHaveBeenCalledWith(
      "official dashboard upstream status check did not return ready",
      expect.objectContaining({
        source: "official-dashboard",
        failureType: "official_dashboard_upstream_status_not_ready",
        status: 503,
      }),
    );
  });

  it("does not log raw sidecar refresh failures while recovering a not-ready dashboard", async () => {
    mockedFetchGatewayResponse
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify({ ok: false }), { status: 503 }),
        url: "https://agent.example.com/_sidecar/dashboard-session-check",
      })
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify({ ok: true }), { status: 200 }),
        url: "https://agent.example.com/_sidecar/dashboard-session-check",
      });
    mockedEnsureManagedSidecarScript.mockRejectedValueOnce(new Error("sidecar-secret-leak"));

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst_123/official-dashboard"),
      { params: Promise.resolve({ id: "inst_123" }) }
    );

    expect(response.status).toBe(307);
    expect(log.warn).toHaveBeenCalledWith(
      "failed to refresh managed sidecar before launch",
      expect.objectContaining({
        source: "official-dashboard",
        failureType: "managed_sidecar_refresh_failed",
      }),
      expect.any(Error),
    );
    const allCalls = (log.warn as jest.Mock).mock.calls;
    const stringified = allCalls
      .map((args: unknown[]) =>
        args
          .map((arg: unknown) =>
            typeof arg === "string"
              ? arg
              : (() => {
                  try {
                    return JSON.stringify(arg);
                  } catch {
                    return String(arg);
                  }
                })(),
          )
          .join(" "),
      )
      .join(" ");
    expect(stringified).not.toContain("sidecar-secret-leak");
  });

  it("logs when the WebUI dashboard sidecar refresh cannot be confirmed", async () => {
    mockedGetSecureUserInstance.mockResolvedValue({
      instance: {
        id: "inst_123",
        backend: "webui",
        gateway_url: "https://webui.example.com",
        api_server_key_encrypted: "encrypted-key",
        user_id: "user_123",
        status: "running",
        host_id: null,
        hetzner_server_id: null,
        cpu_limit: null,
        ram_limit: null,
      },
      apiServerKey: "server-key",
      instanceIpv4: "203.0.113.10",
      error: null,
    } as Awaited<ReturnType<typeof getSecureUserInstance>>);
    mockedEnsureManagedSidecarScript.mockResolvedValueOnce(false);
    mockedFetchGatewayResponse
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify({ ok: false }), { status: 503 }),
        url: "https://webui.example.com/_sidecar/dashboard-session-check",
      })
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify({ ok: true }), { status: 200 }),
        url: "https://webui.example.com/_sidecar/dashboard-session-check",
      });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst_123/official-dashboard"),
      { params: Promise.resolve({ id: "inst_123" }) }
    );

    expect(response.status).toBe(307);
    expect(mockedFetchGatewayResponse).toHaveBeenCalledTimes(3);
    expect(mockedFetchGatewayResponse.mock.invocationCallOrder[0]).toBeLessThan(
      mockedEnsureManagedSidecarScript.mock.invocationCallOrder[0],
    );
    expect(mockedEnsureManagedSidecarScript).toHaveBeenCalledWith({
      id: "inst_123",
      instanceIpv4: "203.0.113.10",
      composeService: "dashboard-sidecar",
      config: undefined,
      hostId: null,
    });
    expect(log.warn).toHaveBeenCalledWith(
      "WebUI dashboard sidecar refresh did not report ready before launch",
      expect.objectContaining({
        source: "official-dashboard",
        failureType: "webui_dashboard_sidecar_refresh_not_ready",
        instanceId: "inst_123",
      }),
    );
  });

  it("recovers a stale stored API key before signing the dashboard handoff", async () => {
    // The Proxmox config.infrastructure handle must be forwarded into the
    // recovery so it routes the SSH read through the managing pve host instead
    // of failing closed on the unroutable private guest IP.
    const proxmoxConfig = {
      infrastructure: {
        provider: "proxmox",
        node: "fixturenode10",
        vmid: 1000,
        privateIpv4: "10.250.20.50",
      },
    };
    mockedGetSecureUserInstance.mockResolvedValue({
      instance: {
        id: "inst_123",
        backend: "webui",
        gateway_url: "https://webui.example.com/profiles/research",
        api_server_key_encrypted: "encrypted-key",
        config: proxmoxConfig,
        user_id: "user_123",
        status: "running",
        host_id: "host_123",
        hetzner_server_id: 42,
        ipv4_address: "203.0.113.10",
        cpu_limit: null,
        ram_limit: null,
      },
      apiServerKey: "stale-server-key",
      instanceIpv4: "203.0.113.10",
      error: null,
    } as Awaited<ReturnType<typeof getSecureUserInstance>>);
    mockedFetchGatewayResponse
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify({ error: "Invalid HMAC signature" }), { status: 403 }),
        url: "https://webui.example.com/_sidecar/dashboard-session-check",
      })
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify({ ok: true }), { status: 200 }),
        url: "https://webui.example.com/_sidecar/dashboard-session-check",
      });
    mockedRecoverApiServerKey.mockResolvedValueOnce({
      apiServerKey: "fresh-server-key",
      instanceIpv4: "203.0.113.10",
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst_123/official-dashboard"),
      { params: Promise.resolve({ id: "inst_123" }) }
    );

    expect(response.status).toBe(307);
    expect(mockedRecoverApiServerKey).toHaveBeenCalledWith({
      id: "inst_123",
      gateway_url: "https://webui.example.com/profiles/research",
      host_id: "host_123",
      hetzner_server_id: 42,
      ipv4_address: "203.0.113.10",
      config: proxmoxConfig,
    }, {
      ignoreApiServerKey: "stale-server-key",
    });
    expect(mockedFetchGatewayResponse).toHaveBeenCalledTimes(3);
    expect(mockedFetchGatewayResponse).toHaveBeenNthCalledWith(2, expect.objectContaining({
      baseUrl: "https://webui.example.com",
      pathname: "/_sidecar/dashboard-session-check",
      instanceIpv4: "203.0.113.10",
    }));
    expect(mockedFetchGatewayResponse).toHaveBeenLastCalledWith(expect.objectContaining({
      baseUrl: "https://webui.example.com",
      pathname: "/_sidecar/api/status",
      instanceIpv4: "203.0.113.10",
    }));

    const location = response.headers.get("location");
    expect(location).toContain("https://webui.example.com/_sidecar/dashboard-login");
    const handoffUrl = new URL(location || "");
    const expiresAt = Number(handoffUrl.searchParams.get("exp"));
    const nonce = handoffUrl.searchParams.get("nonce") || "";
    const nextPath = handoffUrl.searchParams.get("next") || "";
    const expectedFreshSig = crypto
      .createHmac("sha256", "fresh-server-key")
      .update(`${expiresAt}.${nonce}.${nextPath}`)
      .digest("hex");
    const staleSig = crypto
      .createHmac("sha256", "stale-server-key")
      .update(`${expiresAt}.${nonce}.${nextPath}`)
      .digest("hex");
    expect(handoffUrl.searchParams.get("sig")).toBe(expectedFreshSig);
    expect(handoffUrl.searchParams.get("sig")).not.toBe(staleSig);
    expect(log.warn).toHaveBeenCalledWith(
      "official dashboard recovered stale sidecar bearer before handoff",
      expect.objectContaining({
        source: "official-dashboard",
        failureType: "official_dashboard_stale_bearer_recovered",
        instanceId: "inst_123",
        status: 403,
      }),
    );
  });

  it("does not redirect to a dashboard login URL when stale bearer recovery is unavailable", async () => {
    mockedFetchGatewayResponse.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: "Invalid HMAC signature" }), { status: 403 }),
      url: "https://agent.example.com/_sidecar/dashboard-session-check",
    });
    mockedRecoverApiServerKey.mockResolvedValueOnce(null);

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst_123/official-dashboard"),
      { params: Promise.resolve({ id: "inst_123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(502);
    expect(response.headers.get("location")).toBeNull();
    expect(json.error).toBe("Official dashboard authentication could not be verified");
    expect(log.warn).toHaveBeenCalledWith(
      "official dashboard sidecar rejected stored bearer and recovery was unavailable",
      expect.objectContaining({
        source: "official-dashboard",
        failureType: "official_dashboard_stale_bearer_recovery_unavailable",
        status: 403,
      }),
    );
  });

  it("logs gateway attempts when the dashboard sidecar auth probe cannot connect", async () => {
    mockedFetchGatewayResponse
      .mockRejectedValueOnce(new AgentGatewayRequestError({
        requestId: "req_handoff_123",
        baseUrl: "https://agent.example.com",
        pathname: "/_sidecar/dashboard-session-check?sig=super-secret",
        method: "GET",
        timeoutScope: "request",
        attempts: [
          {
            attempt: 1,
            probeIndex: 1,
            url: "https://agent.example.com/_sidecar/dashboard-session-check?sig=<redacted>",
            method: "GET",
            timeoutMs: 6_000,
            timeoutScope: "request",
            errorName: "Error",
            errorMessage: "dns lookup failed",
          },
          {
            attempt: 1,
            probeIndex: 2,
            url: "http://203.0.113.10/_sidecar/dashboard-session-check?sig=<redacted>",
            method: "GET",
            timeoutMs: 6_000,
            timeoutScope: "request",
            errorName: "Error",
            errorMessage: "connect ECONNREFUSED",
          },
        ],
      }))
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify({ ok: true }), { status: 200 }),
        url: "https://agent.example.com/_sidecar/dashboard-session-check",
      });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst_123/official-dashboard"),
      { params: Promise.resolve({ id: "inst_123" }) }
    );

    expect(response.status).toBe(307);
    expect(log.warn).toHaveBeenCalledWith(
      "official dashboard sidecar auth check failed before handoff",
      expect.objectContaining({
        source: "official-dashboard",
        failureType: "official_dashboard_sidecar_auth_check_failed",
        gatewayAttemptCount: 2,
        gatewayRequestId: "req_handoff_123",
        gatewayAttempts: [
          expect.objectContaining({
            url: "https://agent.example.com/_sidecar/dashboard-session-check?sig=<redacted>",
            errorMessage: "dns lookup failed",
          }),
          expect.objectContaining({
            url: "http://203.0.113.10/_sidecar/dashboard-session-check?sig=<redacted>",
            errorMessage: "connect ECONNREFUSED",
          }),
        ],
      }),
      expect.any(AgentGatewayRequestError),
    );
    expect(JSON.stringify((log.warn as jest.Mock).mock.calls)).not.toContain("super-secret");
  });
});
