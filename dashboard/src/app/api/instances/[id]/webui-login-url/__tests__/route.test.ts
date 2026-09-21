import { NextRequest } from "next/server";

import { GET } from "../route";
import { auth } from "@clerk/nextjs/server";
import { fetchFirstReachableGatewayResponse } from "@/lib/agent-gateway";
import { sshExec } from "@/lib/hetzner/ssh";
import { recordInstanceUserActivity } from "@/lib/instance-activity";
import { log } from "@/lib/logger";
import { getSecureUserInstance } from "@/lib/services/instance-security";
import { detectAndRepairApiServerKeyDrift } from "@/lib/webui-handoff-key-resync";
import { verifyWebuiHandoffSignature } from "@/lib/webui-handoff";

const mockReadinessSingle = jest.fn();
const mockReadinessNeq = jest.fn(() => ({ single: mockReadinessSingle }));
const mockReadinessEqUser = jest.fn(() => ({ neq: mockReadinessNeq }));
const mockReadinessEqId = jest.fn(() => ({ eq: mockReadinessEqUser }));
const mockReadinessSelect = jest.fn(() => ({ eq: mockReadinessEqId }));
const mockReadinessFrom = jest.fn(() => ({ select: mockReadinessSelect }));

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));

jest.mock("@/lib/services/instance-security", () => ({
  getSecureUserInstance: jest.fn(),
}));

// The drift self-heal is unit-tested in webui-handoff-key-resync.test.ts. Here
// it is stubbed to a pass-through by default so the existing probe-sequence
// assertions stay deterministic (no extra signed-handoff gateway fetch); the
// dedicated tests below override it to exercise the route's re-mint wiring.
jest.mock("@/lib/webui-handoff-key-resync", () => ({
  detectAndRepairApiServerKeyDrift: jest.fn(),
}));

jest.mock("@/lib/agent-gateway", () => ({
  fetchFirstReachableGatewayResponse: jest.fn(),
}));

jest.mock("@/lib/hetzner/ssh", () => ({
  sshExec: jest.fn(),
}));

jest.mock("@/lib/instance-activity", () => ({
  recordInstanceUserActivity: jest.fn().mockResolvedValue({ ok: true }),
}));

jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: () => mockReadinessFrom(),
  },
}));

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

describe("GET /api/instances/[id]/webui-login-url", () => {
  type SecureUserInstanceResult = Awaited<ReturnType<typeof getSecureUserInstance>>;
  type SecureUserInstanceSuccess = Extract<SecureUserInstanceResult, { error: null }>;

  const mockedAuth = auth as jest.MockedFunction<typeof auth>;
  const mockedGetSecureUserInstance = getSecureUserInstance as jest.MockedFunction<typeof getSecureUserInstance>;
  const mockedFetchFirstReachableGatewayResponse =
    fetchFirstReachableGatewayResponse as jest.MockedFunction<typeof fetchFirstReachableGatewayResponse>;
  const mockedSshExec = sshExec as jest.MockedFunction<typeof sshExec>;
  const mockedRecordInstanceUserActivity =
    recordInstanceUserActivity as jest.MockedFunction<typeof recordInstanceUserActivity>;
  const mockedDetectDrift =
    detectAndRepairApiServerKeyDrift as jest.MockedFunction<typeof detectAndRepairApiServerKeyDrift>;
  const mockedLogInfo = log.info as jest.Mock;
  const mockedLogWarn = log.warn as jest.Mock;
  const originalFetch = global.fetch;
  const mockedGatewayFetch = jest.fn();

  function happyInstance(): SecureUserInstanceSuccess {
    return {
      instance: {
        id: "inst_123",
        gateway_url: "https://agent.example.com",
        api_server_key_encrypted: "encrypted-key",
        user_id: "user_123",
        status: "running",
        backend: "webui",
        config: {},
        host_id: null,
        hetzner_server_id: null,
        cpu_limit: null,
        ram_limit: null,
      },
      apiServerKey: "server-key-deadbeef-deadbeef-deadbeef",
      instanceIpv4: "203.0.113.10",
      error: null,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockedFetchFirstReachableGatewayResponse.mockResolvedValue({
      url: "https://agent.example.com/",
      response: new Response("ok", { status: 200 }),
    });
    mockedSshExec.mockResolvedValue({
      ok: true,
      stdout: "CADDY_ROOT_PUBLIC_REPAIRED\n",
      stderr: "",
    });
    mockedGatewayFetch.mockResolvedValue({
      ok: true,
      status: 200,
      body: null,
    } as unknown as Response);
    global.fetch = mockedGatewayFetch as unknown as typeof fetch;
    mockedAuth.mockResolvedValue({ userId: "user_123" } as Awaited<ReturnType<typeof auth>>);
    mockReadinessSingle.mockResolvedValue({
      data: { status: "running" },
      error: null,
    });
    mockedGetSecureUserInstance.mockResolvedValue(happyInstance());
    // Default: no drift — mint with the same key getSecureUserInstance returned.
    mockedDetectDrift.mockImplementation(async ({ apiServerKey }) => ({ apiServerKey }));
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function callRoute(id = "inst_123") {
    return GET(
      new NextRequest(`http://localhost/api/instances/${id}/webui-login-url`),
      { params: Promise.resolve({ id }) },
    );
  }

  function callRouteWithLocale(locale: string, id = "inst_123") {
    return GET(
      new NextRequest(`http://localhost/api/instances/${id}/webui-login-url?locale=${encodeURIComponent(locale)}`),
      { params: Promise.resolve({ id }) },
    );
  }

  function callRouteWithAppearance(theme: string, skin = "hivra", id = "inst_123") {
    return GET(
      new NextRequest(`http://localhost/api/instances/${id}/webui-login-url?theme=${encodeURIComponent(theme)}&skin=${encodeURIComponent(skin)}`),
      { params: Promise.resolve({ id }) },
    );
  }

  it("returns a sidecar cookie handoff URL that redirects to the iframe hash-token URL", async () => {
    const response = await callRoute();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(mockedFetchFirstReachableGatewayResponse).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: "https://agent.example.com",
      pathname: "/",
      instanceIpv4: "203.0.113.10",
      method: "GET",
      timeoutScope: "request",
      headers: expect.objectContaining({
        Accept: "text/html,application/xhtml+xml",
      }),
    }));
    expect(typeof body.url).toBe("string");
    const parsed = new URL(body.url);
    expect(parsed.origin).toBe("https://agent.example.com");
    expect(parsed.pathname).toBe("/_sidecar/webui-login");
    expect(parsed.searchParams.get("exp")).toMatch(/^\d+$/);
    expect(parsed.searchParams.get("nonce")).toMatch(/^[a-f0-9]{32}$/);
    expect(parsed.searchParams.get("sig")).toMatch(/^[a-f0-9]{64}$/);
    expect(parsed.searchParams.get("next")).toMatch(/^\/webchat#iframe_token=/);
    expect(typeof body.expiresAt).toBe("number");
    expect(body.expiresAt).toBeGreaterThan(Date.now());
  });

  it("mints the same WebUI hash-token handoff for a gateway-backend instance (gateway≡webfree)", async () => {
    // Post gateway≡webfree collapse, a "gateway" box is treated identically to a
    // "webui" box: isWebfreeBackend("gateway") === true, so it ships the full
    // webfree stack (official-dashboard + /webchat shell + /webui-login sidecar)
    // and gets the cookie-backed /webui-login handoff with the hash bearer — the
    // same as the sibling webui case above. The legacy /dashboard-login path is
    // dormant; no backend value routes to it anymore.
    mockedGetSecureUserInstance.mockResolvedValueOnce({
      ...happyInstance(),
      instance: { ...happyInstance().instance, backend: "gateway" },
    } as SecureUserInstanceResult);

    const response = await callRoute();
    expect(response.status).toBe(200);
    const body = await response.json();
    const parsed = new URL(body.url);
    expect(parsed.pathname).toBe("/_sidecar/webui-login");
    expect(parsed.searchParams.get("sig")).toMatch(/^[a-f0-9]{64}$/);
    const next = parsed.searchParams.get("next") ?? "";
    expect(next).toMatch(/^\/webchat#iframe_token=/);
  });

  it("records opening the WebUI as deliberate instance activity", async () => {
    const response = await callRoute();

    expect(response.status).toBe(200);
    expect(mockedRecordInstanceUserActivity).toHaveBeenCalledWith({
      instanceId: "inst_123",
      userId: "user_123",
      source: "webui_login",
    });
  });

  it("sets no-store cache headers", async () => {
    const response = await callRoute();
    expect(response.headers.get("cache-control")).toMatch(/no-store/);
  });

  it("rejects unauthenticated callers with 401", async () => {
    mockedAuth.mockResolvedValueOnce({ userId: null } as Awaited<ReturnType<typeof auth>>);
    const response = await callRoute();
    expect(response.status).toBe(401);
  });

  it("returns 404 when instance lookup says not found", async () => {
    mockReadinessSingle.mockResolvedValueOnce({
      data: null,
      error: { message: "not found" },
    });
    const response = await callRoute("inst_other");
    expect(response.status).toBe(404);
    expect(mockedGetSecureUserInstance).not.toHaveBeenCalled();
  });

  it("keeps the handoff pending while a WebUI instance is still provisioning", async () => {
    mockReadinessSingle.mockResolvedValueOnce({
      data: { status: "provisioning" },
      error: null,
    });

    const response = await callRoute();
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body).toEqual({
      kind: "pending",
      reason: "instance_not_ready",
      instanceStatus: "provisioning",
      retryAfterMs: 4000,
      message: "Your workspace is still starting. Hermes will open it as soon as the Web UI is ready.",
    });
    expect(response.headers.get("cache-control")).toMatch(/no-store/);
    expect(mockedGetSecureUserInstance).not.toHaveBeenCalled();
    expect(mockedGatewayFetch).not.toHaveBeenCalled();
    expect(mockedLogInfo).toHaveBeenCalledWith(
      "webui handoff pending while instance is not ready",
      expect.objectContaining({
        failureType: "webui_handoff_instance_not_ready",
        instanceId: "inst_123",
        instanceStatus: "provisioning",
      }),
    );
  });

  it.each([
    ["stopped", "instance_stopped"],
    ["paused", "instance_stopped"],
    ["error", "instance_error"],
    ["failed", "instance_failed"],
  ])(
    "answers the not-running 400 for status '%s' with the machine-readable reason '%s'",
    async (status, reason) => {
      mockReadinessSingle.mockResolvedValueOnce({
        data: { status },
        error: null,
      });

      const response = await callRoute();
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body).toEqual({
        error: "Instance is not currently running",
        reason,
        instanceStatus: status,
      });
      expect(mockedGetSecureUserInstance).not.toHaveBeenCalled();
      expect(mockedLogWarn).toHaveBeenCalledWith(
        "webui handoff requested for non-running instance",
        expect.objectContaining({
          failureType: "webui_handoff_instance_not_running",
          instanceId: "inst_123",
          instanceStatus: status,
          notRunningReason: reason,
        }),
      );
    },
  );

  it("keeps the handoff pending and logs details when the gateway cannot serve HTTPS", async () => {
    mockedFetchFirstReachableGatewayResponse.mockRejectedValueOnce(
      Object.assign(new TypeError("fetch failed"), { code: "TLS_ALERT_INTERNAL_ERROR" }),
    );

    const response = await callRoute();
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body).toEqual({
      kind: "pending",
      reason: "gateway_unreachable",
      instanceStatus: "running",
      retryAfterMs: 4000,
      message: "Your workspace is running, but its secure gateway is not reachable yet. Hermes will retry automatically.",
    });
    expect(body.url).toBeUndefined();
    expect(mockedLogWarn).toHaveBeenCalledWith(
      "webui handoff gateway probe failed",
      expect.objectContaining({
        failureType: "webui_handoff_gateway_unreachable",
        gatewayHost: "agent.example.com",
        instanceId: "inst_123",
        probeReason: "fetch failed",
        probeErrorName: "TypeError",
        probeErrorCode: "TLS_ALERT_INTERNAL_ERROR",
      }),
    );
  });

  it("repairs stale WebUI Caddy files that block the initial HTML shell", async () => {
    mockedFetchFirstReachableGatewayResponse
      .mockResolvedValueOnce({
        url: "https://agent.example.com/",
        response: new Response("unauthorized", { status: 401 }),
      })
      .mockResolvedValueOnce({
        url: "https://agent.example.com/",
        response: new Response("ok", { status: 200 }),
      })
      .mockResolvedValueOnce({
        url: "https://agent.example.com/webchat",
        response: new Response("ok", { status: 200 }),
      });

    const response = await callRoute();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(typeof body.url).toBe("string");
    expect(mockedFetchFirstReachableGatewayResponse).toHaveBeenNthCalledWith(1, expect.objectContaining({
      pathname: "/",
    }));
    expect(mockedFetchFirstReachableGatewayResponse).toHaveBeenNthCalledWith(2, expect.objectContaining({
      pathname: "/",
    }));
    expect(mockedFetchFirstReachableGatewayResponse).toHaveBeenNthCalledWith(3, expect.objectContaining({
      pathname: "/webchat",
    }));
    expect(mockedSshExec).toHaveBeenCalledWith(
      "203.0.113.10",
      expect.stringContaining("CADDY_PUBLIC_SHELL_ALREADY_PRESENT"),
      expect.objectContaining({ timeoutMs: 30_000 }),
    );
    const repairCommand = mockedSshExec.mock.calls[0][1];
    // Script now passes the expected Caddyfile as a base64-encoded variable
    // and compares it against the on-disk file via sha256sum. The literal
    // base64 only appears in the `expected_b64=` assignment.
    const encodedCaddyfile = repairCommand.match(/expected_b64='([^']+)'/)?.[1];
    expect(encodedCaddyfile).toBeTruthy();
    const decodedCaddyfile = Buffer.from(encodedCaddyfile!, "base64").toString("utf8");
    expect(decodedCaddyfile).toContain("handle_path /webchat*");
    expect(decodedCaddyfile).toContain("handle_path /dash*");
    expect(decodedCaddyfile).toContain("@hermesDesktopDocument");
    expect(decodedCaddyfile).toContain("try_files {path} /index.html");
    expect(decodedCaddyfile).toContain("@public path / /health");
    expect(decodedCaddyfile).toContain("@publicHtml {");
    expect(decodedCaddyfile).toContain("rewrite * /");
    expect(repairCommand).toContain("sha256sum");
    expect(repairCommand).toContain("CADDY_PUBLIC_SHELL_ALREADY_PRESENT");
    expect(repairCommand).toContain("CADDY_PUBLIC_SHELL_REPAIRED");
    expect(mockedLogWarn).toHaveBeenCalledWith(
      "webui handoff gateway probe failed; reconciling Caddy public shell before retry",
      expect.objectContaining({
        failureType: "webui_handoff_caddy_public_shell_repair_attempt",
        instanceId: "inst_123",
        probePath: "/",
        probeStatus: 401,
      }),
    );
  });

  it("serves a gateway-backend instance via the webfree root/SPA probes (gateway≡webfree)", async () => {
    mockedGetSecureUserInstance.mockResolvedValueOnce({
      ...happyInstance(),
      instance: { ...happyInstance().instance, backend: "gateway" },
    });
    // Post gateway≡webfree collapse, a "gateway" box ships the full webfree stack
    // (official-dashboard + /webchat shell), so readiness is probed against the
    // public WebUI surface ("/" then "/webchat") — NOT the legacy gateway sidecar
    // readiness endpoint. Both probes serve their shell (default 200 mock), so the
    // Caddyfile reconciliation never fires and the handoff URL is minted.
    const response = await callRoute();
    const body = await response.json();

    // No reconciliation needed — the public shell probes succeed, so Caddy is
    // never rewritten.
    expect(mockedSshExec).not.toHaveBeenCalled();
    // Readiness is probed against the webfree root + SPA shell, like every webui box.
    expect(mockedFetchFirstReachableGatewayResponse).toHaveBeenCalledWith(
      expect.objectContaining({ pathname: "/" }),
    );
    expect(mockedFetchFirstReachableGatewayResponse).toHaveBeenCalledWith(
      expect.objectContaining({ pathname: "/webchat" }),
    );
    // A reachable webfree shell mints the hash-token handoff.
    expect(response.status).toBe(200);
    expect(typeof body.url).toBe("string");
    expect(new URL(body.url).pathname).toBe("/_sidecar/webui-login");
    // The legacy "skipping repair for non-webui backend" branch is dormant — a
    // gateway box is now a webfree (webui) backend, so it never logs that.
    expect(mockedLogInfo).not.toHaveBeenCalledWith(
      "webui handoff gateway probe failed for non-webui backend; skipping WebUI Caddy repair",
      expect.anything(),
    );
  });

  it("returns 202 pending for a gateway-backend instance whose webfree shell is not up yet (5xx persists after reconcile)", async () => {
    mockedGetSecureUserInstance.mockResolvedValueOnce({
      ...happyInstance(),
      instance: { ...happyInstance().instance, backend: "gateway" },
    });
    // Gateway≡webfree: the box is probed against the WebUI root shell. A 502 on
    // "/" is a status-bearing failure, so the SHA256-gated Caddyfile repair fires
    // (the webfree container topology is the same for gateway boxes). The repaired
    // probe still 502s (mockResolvedValue → 502 every call), so the handoff stays
    // pending and retryable.
    mockedFetchFirstReachableGatewayResponse.mockResolvedValue({
      url: "https://agent.example.com/",
      response: new Response("bad gateway", { status: 502 }),
    });

    const response = await callRoute();
    const body = await response.json();

    // The repair is attempted (webfree backend, status-bearing failure).
    expect(mockedSshExec).toHaveBeenCalled();
    expect(response.status).toBe(202);
    expect(body.reason).toBe("gateway_unreachable");
  });

  it("repairs stale WebUI Caddy files that block SPA document navigations after root loads", async () => {
    mockedFetchFirstReachableGatewayResponse
      .mockResolvedValueOnce({
        url: "https://agent.example.com/",
        response: new Response("ok", { status: 200 }),
      })
      .mockResolvedValueOnce({
        url: "https://agent.example.com/webchat",
        response: new Response("unauthorized", { status: 401 }),
      })
      .mockResolvedValueOnce({
        url: "https://agent.example.com/webchat",
        response: new Response("ok", { status: 200 }),
      });

    const response = await callRoute();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(typeof body.url).toBe("string");
    expect(mockedFetchFirstReachableGatewayResponse).toHaveBeenNthCalledWith(1, expect.objectContaining({
      pathname: "/",
    }));
    expect(mockedFetchFirstReachableGatewayResponse).toHaveBeenNthCalledWith(2, expect.objectContaining({
      pathname: "/webchat",
    }));
    expect(mockedFetchFirstReachableGatewayResponse).toHaveBeenNthCalledWith(3, expect.objectContaining({
      pathname: "/webchat",
    }));
    expect(mockedSshExec).toHaveBeenCalledWith(
      "203.0.113.10",
      expect.stringContaining("sha256sum"),
      expect.objectContaining({ timeoutMs: 30_000 }),
    );
    expect(mockedLogWarn).toHaveBeenCalledWith(
      "webui handoff gateway probe failed; reconciling Caddy public shell before retry",
      expect.objectContaining({
        failureType: "webui_handoff_caddy_public_shell_repair_attempt",
        probePath: "/webchat",
        probeStatus: 401,
      }),
    );
  });

  it("repairs stale Caddy files when a nested admin SPA route returns 404", async () => {
    let adminDocumentAttempts = 0;
    mockedFetchFirstReachableGatewayResponse.mockImplementation(async ({ pathname }) => {
      if (pathname === "/dash/sessions") {
        adminDocumentAttempts += 1;
        return {
          url: "https://agent.example.com/dash/sessions",
          response: new Response(adminDocumentAttempts === 1 ? "not found" : "ok", {
            status: adminDocumentAttempts === 1 ? 404 : 200,
          }),
        };
      }

      return {
        url: `https://agent.example.com${pathname}`,
        response: new Response("ok", { status: 200 }),
      };
    });

    const response = await callRoute();

    expect(response.status).toBe(200);
    expect(mockedFetchFirstReachableGatewayResponse).toHaveBeenNthCalledWith(3, expect.objectContaining({
      pathname: "/dash/sessions",
    }));
    expect(mockedFetchFirstReachableGatewayResponse).toHaveBeenNthCalledWith(4, expect.objectContaining({
      pathname: "/dash/sessions",
    }));
    expect(mockedSshExec).toHaveBeenCalledWith(
      "203.0.113.10",
      expect.stringContaining("sha256sum"),
      expect.objectContaining({ timeoutMs: 30_000 }),
    );
    expect(mockedLogWarn).toHaveBeenCalledWith(
      "webui handoff gateway probe failed; reconciling Caddy public shell before retry",
      expect.objectContaining({
        failureType: "webui_handoff_caddy_public_shell_repair_attempt",
        probePath: "/dash/sessions",
        probeStatus: 404,
      }),
    );
  });

  it("routes stale Caddy auth repairs through the explicit Proxmox host config", async () => {
    mockedGetSecureUserInstance.mockResolvedValueOnce({
      ...happyInstance(),
      instance: {
        ...happyInstance().instance,
        host_id: "host_fixturenode2",
        config: {
          infrastructure: {
            provider: "proxmox",
            vmid: 205,
            privateIpv4: "10.250.21.55",
            gatewayHost: "agent.example.com",
            hostSlug: "fixturenode2",
          },
        },
      },
      instanceIpv4: "10.250.21.55",
    });
    mockedFetchFirstReachableGatewayResponse
      .mockResolvedValueOnce({
        url: "https://agent.example.com/",
        response: new Response("unauthorized", { status: 401 }),
      })
      .mockResolvedValueOnce({
        url: "https://agent.example.com/",
        response: new Response("ok", { status: 200 }),
      })
      .mockResolvedValueOnce({
        url: "https://agent.example.com/webchat",
        response: new Response("ok", { status: 200 }),
      });

    const response = await callRoute();

    expect(response.status).toBe(200);
    expect(mockedSshExec).toHaveBeenCalledWith(
      "10.250.21.55",
      expect.stringContaining("sha256sum"),
      expect.objectContaining({
        timeoutMs: 30_000,
        proxmoxHostConfig: expect.objectContaining({
          hostId: "host_fixturenode2",
          hostSlug: "fixturenode2",
          failClosed: true,
        }),
      }),
    );
  });

  it("recovers stranded SPA shells where /webchat returns 404 by reconciling the Caddyfile", async () => {
    // Regression: pre-735e1e0a the inner Caddyfile builder didn't emit
    // `rewrite * /` inside @publicHtml. Any instance whose Caddyfile was
    // written by that builder could route the public SPA shell to a 404. The
    // old recover-trigger only fired on 401/403, so those instances stayed
    // stranded forever. Recovery now fires on any HTTP-status failure and
    // the SHA256-gated repair script rewrites the file to whatever the
    // current builder emits, recovering the SPA shell on the next probe.
    mockedFetchFirstReachableGatewayResponse
      .mockResolvedValueOnce({
        url: "https://agent.example.com/",
        response: new Response("ok", { status: 200 }),
      })
      .mockResolvedValueOnce({
        url: "https://agent.example.com/webchat",
        response: new Response("missing route", { status: 404 }),
      })
      .mockResolvedValueOnce({
        url: "https://agent.example.com/webchat",
        response: new Response("ok", { status: 200 }),
      });

    const response = await callRoute();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(typeof body.url).toBe("string");
    expect(mockedSshExec).toHaveBeenCalledWith(
      "203.0.113.10",
      expect.stringContaining("sha256sum"),
      expect.objectContaining({ timeoutMs: 30_000 }),
    );
    expect(mockedLogWarn).toHaveBeenCalledWith(
      "webui handoff gateway probe failed; reconciling Caddy public shell before retry",
      expect.objectContaining({
        failureType: "webui_handoff_caddy_public_shell_repair_attempt",
        probePath: "/webchat",
        probeStatus: 404,
      }),
    );
  });

  it("keeps the handoff pending when /webchat still fails after reconciliation with a never-401 status", async () => {
    // SPA probe returns 500 every time. Reconciliation fires (status is
    // numeric) but the post-repair probe still 500s. Because the failure
    // is still status-bearing, the route falls through to the webchat-shell
    // handoff so the user still loads the SPA — better than stranding.
    mockedFetchFirstReachableGatewayResponse
      .mockResolvedValueOnce({
        url: "https://agent.example.com/",
        response: new Response("ok", { status: 200 }),
      })
      .mockResolvedValueOnce({
        url: "https://agent.example.com/webchat",
        response: new Response("upstream error", { status: 500 }),
      })
      .mockResolvedValueOnce({
        url: "https://agent.example.com/webchat",
        response: new Response("upstream error", { status: 500 }),
      });

    const response = await callRoute();
    const body = await response.json();

    expect(response.status).toBe(200);
    const parsed = new URL(body.url);
    expect(parsed.pathname).toBe("/_sidecar/webui-login");
    expect(parsed.searchParams.get("next")).toMatch(/^\/webchat#iframe_token=/);
    expect(mockedSshExec).toHaveBeenCalled();
    expect(mockedLogWarn).toHaveBeenCalledWith(
      "webui handoff SPA shell still failing after Caddy reconciliation; continuing with root shell handoff",
      expect.objectContaining({
        failureType: "webui_handoff_spa_shell_recovery_failed_continuing",
        probePath: "/webchat",
        probeStatus: 500,
      }),
    );
  });

  it("returns pending when /webchat fails with a connection-level error (no HTTP status, no repair attempted)", async () => {
    // Connection-level failures (TLS reset, ECONNREFUSED, timeout) have no
    // probeStatus. The Caddyfile reconciliation can't help when the box
    // isn't even responding, so the route skips SSH and returns pending —
    // the user will retry while whatever is down recovers.
    mockedFetchFirstReachableGatewayResponse
      .mockResolvedValueOnce({
        url: "https://agent.example.com/",
        response: new Response("ok", { status: 200 }),
      })
      .mockRejectedValueOnce(
        Object.assign(new TypeError("fetch failed"), { code: "ECONNREFUSED" }),
      );

    const response = await callRoute();
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body).toEqual({
      kind: "pending",
      reason: "gateway_unreachable",
      instanceStatus: "running",
      retryAfterMs: 4000,
      message: "Your workspace is running, but its secure gateway is not reachable yet. Hermes will retry automatically.",
    });
    expect(mockedSshExec).not.toHaveBeenCalled();
    expect(mockedLogWarn).toHaveBeenCalledWith(
      "webui handoff SPA shell probe failed",
      expect.objectContaining({
        failureType: "webui_handoff_spa_shell_unreachable",
        probePath: "/webchat",
        probeErrorCode: "ECONNREFUSED",
      }),
    );
  });

  it("continues with the root shell handoff when stale SPA document auth cannot be repaired", async () => {
    mockedFetchFirstReachableGatewayResponse
      .mockResolvedValueOnce({
        url: "https://agent.example.com/",
        response: new Response("ok", { status: 200 }),
      })
      .mockResolvedValueOnce({
        url: "https://agent.example.com/webchat",
        response: new Response("unauthorized", { status: 401 }),
      });
    mockedSshExec.mockResolvedValueOnce({
      ok: false,
      stdout: "",
      stderr: "ssh route unavailable",
      error: "ssh failed",
    });

    const response = await callRoute();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(typeof body.url).toBe("string");
    const parsed = new URL(body.url);
    expect(parsed.pathname).toBe("/_sidecar/webui-login");
    expect(parsed.searchParams.get("next")).toMatch(/^\/webchat#iframe_token=/);
    expect(mockedSshExec).toHaveBeenCalled();
    expect(mockedLogWarn).toHaveBeenCalledWith(
      "webui handoff SPA shell still failing after Caddy reconciliation; continuing with root shell handoff",
      expect.objectContaining({
        failureType: "webui_handoff_spa_shell_recovery_failed_continuing",
        gatewayHost: "agent.example.com",
        instanceId: "inst_123",
        probePath: "/webchat",
        probeStatus: 401,
      }),
    );
  });

  it("returns 400 when gateway URL is missing on the instance", async () => {
    mockedGetSecureUserInstance.mockResolvedValueOnce({
      instance: null,
      apiServerKey: "",
      instanceIpv4: "",
      error: "Gateway URL not configured",
    });
    const response = await callRoute();
    expect(response.status).toBe(400);
  });

  it("returns 500 when apiServerKey is missing despite a running instance", async () => {
    // Empty string apiServerKey behaves the same as missing for our checks
    // (we use Boolean()-style truthiness on the value).
    mockedGetSecureUserInstance.mockResolvedValueOnce({
      instance: happyInstance().instance,
      apiServerKey: "",
      instanceIpv4: "",
      error: null,
    } as Awaited<ReturnType<typeof getSecureUserInstance>>);
    const response = await callRoute();
    expect(response.status).toBe(500);
  });

  it("returns one-time sidecar login URLs with the same hash-token redirect target", async () => {
    const a = await callRoute();
    const b = await callRoute();
    const aBody = await a.json();
    const bBody = await b.json();
    const aUrl = new URL(aBody.url);
    const bUrl = new URL(bBody.url);
    expect(aBody.url).not.toBe(bBody.url);
    expect(aUrl.searchParams.get("nonce")).not.toBe(bUrl.searchParams.get("nonce"));
    expect(aUrl.searchParams.get("next")).toBe(bUrl.searchParams.get("next"));
  });

  it("expiresAt reflects the long-lived bearer (12h, not the old 30s HMAC TTL)", async () => {
    const before = Date.now();
    const response = await callRoute();
    const body = await response.json();
    const after = Date.now();
    const TWELVE_H = 12 * 60 * 60 * 1000;
    // The hash-token URL uses the long-lived apiServerKey as the bearer;
    // expiresAt is just an upper bound for UI hints, set to 12h ahead.
    expect(body.expiresAt - before).toBeLessThanOrEqual(TWELVE_H + 100);
    expect(body.expiresAt - after).toBeGreaterThanOrEqual(TWELVE_H - 1000);
  });

  it("scopes the WebUI handoff URL to Chinese when requested", async () => {
    const response = await callRouteWithLocale("zh-CN");
    const body = await response.json();
    const parsed = new URL(body.url);
    const next = parsed.searchParams.get("next") ?? "";

    expect(next).toContain("locale=zh-CN");
    expect(next).toContain("lang=zh-CN");
    expect(next).toContain("#iframe_token=");
  });

  it("scopes the WebUI handoff URL to the dashboard appearance when requested", async () => {
    const response = await callRouteWithAppearance("hermesos-light");
    const body = await response.json();
    const parsed = new URL(body.url);
    const next = parsed.searchParams.get("next") ?? "";

    expect(response.status).toBe(200);
    expect(next).toContain("theme=hermesos-light");
    expect(next).toContain("skin=hivra");
    expect(next).toContain("#iframe_token=");
  });

  it("still accepts the legacy HermesOS appearance skin for old handoff URLs", async () => {
    const response = await callRouteWithAppearance("dark", "hermesos");
    const body = await response.json();
    const parsed = new URL(body.url);
    const next = parsed.searchParams.get("next") ?? "";

    expect(response.status).toBe(200);
    expect(next).toContain("theme=dark");
    expect(next).toContain("skin=hermesos");
  });

  it("runs the drift self-heal with the stored key after the box is confirmed healthy", async () => {
    await callRoute();

    expect(mockedDetectDrift).toHaveBeenCalledWith(
      expect.objectContaining({
        instance: expect.objectContaining({ id: "inst_123" }),
        apiServerKey: "server-key-deadbeef-deadbeef-deadbeef",
        baseUrl: "https://agent.example.com",
        instanceIpv4: "203.0.113.10",
        isWebuiBackend: true,
        userId: "user_123",
      }),
    );
  });

  it("re-mints the handoff signature with the recovered key when a drift is self-healed", async () => {
    const recoveredKey = "recovered-vm-key-cafebabe-cafebabe";
    mockedDetectDrift.mockResolvedValueOnce({ apiServerKey: recoveredKey });

    const response = await callRoute();
    const body = await response.json();
    expect(response.status).toBe(200);

    const parsed = new URL(body.url);
    const verifyArgs = {
      expiresAt: Number(parsed.searchParams.get("exp")),
      nonce: parsed.searchParams.get("nonce") ?? "",
      nextPath: parsed.searchParams.get("next") ?? "",
      signature: parsed.searchParams.get("sig") ?? "",
    };

    // The minted signature must verify under the RECOVERED key, not the stale
    // stored key — i.e. the route used the self-healed key for the mint.
    expect(verifyWebuiHandoffSignature({ apiServerKey: recoveredKey, ...verifyArgs })).toBe(true);
    expect(
      verifyWebuiHandoffSignature({
        apiServerKey: "server-key-deadbeef-deadbeef-deadbeef",
        ...verifyArgs,
      }),
    ).toBe(false);
  });

  it("does not run the drift self-heal until the box is confirmed healthy (still-provisioning short-circuit)", async () => {
    mockReadinessSingle.mockResolvedValueOnce({
      data: { status: "provisioning" },
      error: null,
    });

    const response = await callRoute();
    expect(response.status).toBe(202);
    expect(mockedDetectDrift).not.toHaveBeenCalled();
  });
});
