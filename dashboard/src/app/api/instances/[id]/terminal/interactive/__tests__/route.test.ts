import { NextRequest } from "next/server";

import { GET, POST } from "../route";
import { auth } from "@clerk/nextjs/server";
import { fetchFirstReachableGatewayResponse } from "@/lib/agent-gateway";
import {
  ensureManagedSidecarScript,
  getSecureUserInstance,
} from "@/lib/services/instance-security";
import { recordInstanceUserActivity } from "@/lib/instance-activity";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));

jest.mock("@/lib/agent-gateway", () => ({
  fetchFirstReachableGatewayResponse: jest.fn(),
}));

jest.mock("@/lib/services/instance-security", () => ({
  ensureManagedSidecarScript: jest.fn(),
  getSecureUserInstance: jest.fn(),
}));

jest.mock("@/lib/instance-activity", () => ({
  recordInstanceUserActivity: jest.fn().mockResolvedValue({
    ok: true,
    recordedAt: "2026-05-14T20:30:00.000Z",
  }),
}));

describe("/api/instances/[id]/terminal/interactive", () => {
  const mockedAuth = auth as jest.MockedFunction<typeof auth>;
  const mockedFetchFirstReachableGatewayResponse =
    fetchFirstReachableGatewayResponse as jest.MockedFunction<typeof fetchFirstReachableGatewayResponse>;
  const mockedEnsureManagedSidecarScript =
    ensureManagedSidecarScript as jest.MockedFunction<typeof ensureManagedSidecarScript>;
  const mockedGetSecureUserInstance =
    getSecureUserInstance as jest.MockedFunction<typeof getSecureUserInstance>;
  const mockedRecordInstanceUserActivity =
    recordInstanceUserActivity as jest.MockedFunction<typeof recordInstanceUserActivity>;
  let consoleWarnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    mockedAuth.mockResolvedValue({ userId: "user_123" } as Awaited<ReturnType<typeof auth>>);
    mockedEnsureManagedSidecarScript.mockResolvedValue(true);
    mockedGetSecureUserInstance.mockResolvedValue({
      instance: {
        id: "inst_123",
        gateway_url: "https://agent.example.com/profiles/default",
        api_server_key_encrypted: "encrypted-server-key",
        user_id: "user_123",
        status: "running",
      },
      apiServerKey: "server-key",
      instanceIpv4: "203.0.113.10",
      error: null,
    });
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
  });

  it("starts a terminal session through the sidecar proxy and returns a signed gateway websocket url", async () => {
    mockedFetchFirstReachableGatewayResponse.mockResolvedValue({
      response: new Response(
        JSON.stringify({
          ok: true,
          sessionKey: "term:user_123:inst_123:tui",
          sessionToken: "22222222-2222-4222-8222-222222222222",
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        },
      ),
      url: "https://agent.example.com/_sidecar/api/terminal",
    });

    const response = await POST(
      new NextRequest("http://localhost/api/instances/inst_123/terminal/interactive", {
        method: "POST",
        body: JSON.stringify({ action: "start", cols: 100, rows: 40, mode: "tui" }),
        headers: { "Content-Type": "application/json" },
      }),
      { params: Promise.resolve({ id: "inst_123" }) },
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toMatchObject({
      ok: true,
      sessionKey: "term:user_123:inst_123:tui",
      sessionToken: "22222222-2222-4222-8222-222222222222",
    });
    expect(json).toHaveProperty("gatewayWebSocketUrl");
    expect(Object.keys(json).sort()).toEqual(["gatewayWebSocketUrl", "ok", "sessionKey", "sessionToken"]);
    const gatewayWebSocketUrl = new URL(json.gatewayWebSocketUrl);
    expect(gatewayWebSocketUrl.origin).toBe("wss://agent.example.com");
    expect(gatewayWebSocketUrl.pathname).toBe("/_sidecar/api/terminal/ws");
    expect(gatewayWebSocketUrl.searchParams.get("includeScrollback")).toBe("1");
    const terminalToken = gatewayWebSocketUrl.searchParams.get("token");
    expect(typeof terminalToken).toBe("string");
    expect(terminalToken).toContain(".");

    expect(mockedEnsureManagedSidecarScript).not.toHaveBeenCalled();
    expect(mockedFetchFirstReachableGatewayResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://agent.example.com/profiles/default",
        pathname: "/_sidecar/api/terminal",
        instanceIpv4: "203.0.113.10",
        method: "POST",
        body: JSON.stringify({ action: "start", cols: 100, rows: 40, mode: "tui" }),
      }),
    );

    const forwardedHeaders = mockedFetchFirstReachableGatewayResponse.mock.calls[0]?.[0]
      ?.headers as Headers;
    expect(forwardedHeaders.get("content-type")).toBe("application/json");
    expect(forwardedHeaders.get("x-hermes-timestamp")).toBeTruthy();
    expect(forwardedHeaders.get("x-hermes-signature")).toMatch(/^[a-f0-9]{64}$/);
    expect(mockedRecordInstanceUserActivity).toHaveBeenCalledWith({
      instanceId: "inst_123",
      userId: "user_123",
      source: "terminal_start",
    });
  });

  it("starts WebUI shell terminals through the current dashboard sidecar and returns a signed gateway websocket url", async () => {
    mockedGetSecureUserInstance.mockResolvedValue({
      instance: {
        id: "inst_123",
        backend: "webui",
        gateway_url: "https://webui.example.com",
        api_server_key_encrypted: "encrypted-server-key",
        user_id: "user_123",
        status: "running",
      },
      apiServerKey: "server-key",
      instanceIpv4: "203.0.113.10",
      error: null,
    });
    mockedFetchFirstReachableGatewayResponse.mockResolvedValue({
      response: new Response(
        JSON.stringify({
          ok: true,
          sessionKey: "term:user_123:inst_123:shell",
          sessionToken: "22222222-2222-4222-8222-222222222222",
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        },
      ),
      url: "https://webui.example.com/_sidecar/api/terminal",
    });

    const response = await POST(
      new NextRequest("http://localhost/api/instances/inst_123/terminal/interactive", {
        method: "POST",
        body: JSON.stringify({ action: "start", cols: 100, rows: 40, mode: "shell" }),
        headers: { "Content-Type": "application/json" },
      }),
      { params: Promise.resolve({ id: "inst_123" }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      sessionKey: "term:user_123:inst_123:shell",
      sessionToken: "22222222-2222-4222-8222-222222222222",
      gatewayWebSocketUrl: expect.stringContaining("/_sidecar/api/terminal/ws"),
    });
    expect(mockedEnsureManagedSidecarScript).not.toHaveBeenCalled();
  });

  it("starts WebUI-backed Hermes TUI sessions through the current dashboard sidecar and returns a signed gateway websocket url", async () => {
    mockedGetSecureUserInstance.mockResolvedValue({
      instance: {
        id: "inst_123",
        backend: "webui",
        gateway_url: "https://webui.example.com",
        api_server_key_encrypted: "encrypted-server-key",
        user_id: "user_123",
        status: "running",
      },
      apiServerKey: "server-key",
      instanceIpv4: "203.0.113.10",
      error: null,
    });

    mockedFetchFirstReachableGatewayResponse.mockResolvedValue({
      response: new Response(
        JSON.stringify({
          ok: true,
          sessionKey: "term:user_123:inst_123:tui",
          sessionToken: "22222222-2222-4222-8222-222222222222",
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        },
      ),
      url: "https://webui.example.com/_sidecar/api/terminal",
    });

    const response = await POST(
      new NextRequest("http://localhost/api/instances/inst_123/terminal/interactive", {
        method: "POST",
        body: JSON.stringify({ action: "start", cols: 100, rows: 40, mode: "tui" }),
        headers: { "Content-Type": "application/json" },
      }),
      { params: Promise.resolve({ id: "inst_123" }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      sessionKey: "term:user_123:inst_123:tui",
      sessionToken: "22222222-2222-4222-8222-222222222222",
      gatewayWebSocketUrl: expect.stringContaining("/_sidecar/api/terminal/ws"),
    });
    expect(mockedFetchFirstReachableGatewayResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://webui.example.com",
        pathname: "/_sidecar/api/terminal",
        instanceIpv4: "203.0.113.10",
        method: "POST",
        body: JSON.stringify({ action: "start", cols: 100, rows: 40, mode: "tui" }),
      })
    );
    expect(mockedEnsureManagedSidecarScript).not.toHaveBeenCalled();
  });

  it("refreshes and retries the WebUI dashboard sidecar when the first shell terminal start is rejected", async () => {
    const proxmoxConfig = {
      infrastructure: {
        provider: "proxmox" as const,
        node: "fixturenode13",
        vmid: 1302,
        privateIpv4: "10.250.20.52",
        gatewayHost: "webui.example.com",
      },
    };
    mockedGetSecureUserInstance.mockResolvedValue({
      instance: {
        id: "inst_123",
        backend: "webui",
        gateway_url: "https://webui.example.com",
        api_server_key_encrypted: "encrypted-server-key",
        user_id: "user_123",
        status: "running",
        config: proxmoxConfig,
        host_id: "host-fixturenode13",
      },
      apiServerKey: "server-key",
      instanceIpv4: "10.250.20.52",
      error: null,
    });
    mockedFetchFirstReachableGatewayResponse
      .mockResolvedValueOnce({
        response: new Response("old-sidecar-secret-leak", {
          status: 500,
          headers: {
            "Content-Type": "text/plain",
          },
        }),
        url: "https://webui.example.com/_sidecar/api/terminal",
      })
      .mockResolvedValueOnce({
        response: new Response(
          JSON.stringify({
            ok: true,
            sessionKey: "term:user_123:inst_123:shell",
            sessionToken: "22222222-2222-4222-8222-222222222222",
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          },
        ),
        url: "https://webui.example.com/_sidecar/api/terminal",
      });

    const response = await POST(
      new NextRequest("http://localhost/api/instances/inst_123/terminal/interactive", {
        method: "POST",
        body: JSON.stringify({ action: "start", cols: 100, rows: 40, mode: "shell" }),
        headers: { "Content-Type": "application/json" },
      }),
      { params: Promise.resolve({ id: "inst_123" }) },
    );
    const json = await response.json();
    const warningOutput = consoleWarnSpy.mock.calls.flat().join(" ");

    expect(response.status).toBe(200);
    expect(json).toMatchObject({
      ok: true,
      sessionKey: "term:user_123:inst_123:shell",
      sessionToken: "22222222-2222-4222-8222-222222222222",
      gatewayWebSocketUrl: expect.stringContaining("/_sidecar/api/terminal/ws"),
    });
    expect(mockedEnsureManagedSidecarScript).toHaveBeenCalledWith({
      id: "inst_123",
      instanceIpv4: "10.250.20.52",
      composeService: "dashboard-sidecar",
      config: proxmoxConfig,
      hostId: "host-fixturenode13",
    });
    expect(mockedFetchFirstReachableGatewayResponse).toHaveBeenCalledTimes(2);
    expect(warningOutput).toContain("terminal_sidecar_request_rejected");
    expect(warningOutput).toContain("\"attempt\":\"initial\"");
    expect(warningOutput).not.toContain("old-sidecar-secret-leak");
  });

  it("forwards resize requests with the caller-provided session identity", async () => {
    mockedFetchFirstReachableGatewayResponse.mockResolvedValue({
      response: new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      }),
      url: "https://agent.example.com/_sidecar/api/terminal",
    });

    const response = await POST(
      new NextRequest("http://localhost/api/instances/inst_123/terminal/interactive", {
        method: "POST",
        body: JSON.stringify({
          action: "resize",
          cols: 144,
          rows: 48,
          mode: "tui",
          sessionKey: "term:user_123:inst_123:tui",
          sessionToken: "11111111-1111-4111-8111-111111111111",
        }),
        headers: { "Content-Type": "application/json" },
      }),
      { params: Promise.resolve({ id: "inst_123" }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mockedEnsureManagedSidecarScript).not.toHaveBeenCalled();
    expect(mockedFetchFirstReachableGatewayResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://agent.example.com/profiles/default",
        pathname: "/_sidecar/api/terminal",
        method: "POST",
        body: JSON.stringify({
          action: "resize",
          cols: 144,
          rows: 48,
          mode: "tui",
          sessionKey: "term:user_123:inst_123:tui",
          sessionToken: "11111111-1111-4111-8111-111111111111",
        }),
      }),
    );
  });

  it("proxies the sidecar SSE stream for an existing terminal session", async () => {
    mockedFetchFirstReachableGatewayResponse.mockResolvedValue({
      response: new Response('data: {"type":"output","data":"hello"}\n\n', {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
        },
      }),
      url: "https://agent.example.com/_sidecar/api/terminal",
    });

    const response = await GET(
      new NextRequest(
        "http://localhost/api/instances/inst_123/terminal/interactive?sessionKey=term:user_123:inst_123:tui&sessionToken=11111111-1111-4111-8111-111111111111&includeScrollback=0",
      ),
      { params: Promise.resolve({ id: "inst_123" }) },
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain('"hello"');
    expect(mockedFetchFirstReachableGatewayResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://agent.example.com/profiles/default",
        pathname:
          "/_sidecar/api/terminal?sessionKey=term%3Auser_123%3Ainst_123%3Atui&sessionToken=11111111-1111-4111-8111-111111111111&includeScrollback=0",
        instanceIpv4: "203.0.113.10",
        method: "GET",
      }),
    );
  });

  it("does not expose upstream attach failures to the client", async () => {
    mockedFetchFirstReachableGatewayResponse.mockResolvedValue({
      response: new Response("terminal-attach-secret-leak", {
        status: 502,
        headers: {
          "Content-Type": "text/plain",
        },
      }),
      url: "https://agent.example.com/_sidecar/api/terminal",
    });

    const response = await GET(
      new NextRequest(
        "http://localhost/api/instances/inst_123/terminal/interactive?sessionKey=term:user_123:inst_123:tui&sessionToken=11111111-1111-4111-8111-111111111111",
      ),
      { params: Promise.resolve({ id: "inst_123" }) },
    );
    const json = await response.json();

    expect(response.status).toBe(502);
    expect(json.error).toBe("Failed to attach to terminal session");
    expect(json.error).not.toContain("terminal-attach-secret-leak");
  });

  it("does not expose unexpected terminal request failures to the client", async () => {
    mockedEnsureManagedSidecarScript.mockResolvedValueOnce(false);
    mockedFetchFirstReachableGatewayResponse.mockRejectedValueOnce(
      new Error("terminal-request-secret-leak"),
    );

    const response = await POST(
      new NextRequest("http://localhost/api/instances/inst_123/terminal/interactive", {
        method: "POST",
        body: JSON.stringify({ action: "start", cols: 100, rows: 40, mode: "tui" }),
        headers: { "Content-Type": "application/json" },
      }),
      { params: Promise.resolve({ id: "inst_123" }) },
    );
    const json = await response.json();

    expect(response.status).toBe(502);
    expect(json.error).toBe("Terminal request failed");
    expect(json.error).not.toContain("terminal-request-secret-leak");
    expect(consoleWarnSpy.mock.calls.flat().join(" ")).toContain("terminal_sidecar_request_failed");
    expect(consoleWarnSpy.mock.calls.flat().join(" ")).not.toContain("terminal-request-secret-leak");
  });

  it("logs rejected terminal sidecar requests without exposing upstream response bodies", async () => {
    mockedFetchFirstReachableGatewayResponse.mockResolvedValue({
      response: new Response("terminal-start-secret-leak", {
        status: 500,
        headers: {
          "Content-Type": "text/plain",
        },
      }),
      url: "https://agent.example.com/_sidecar/api/terminal",
    });

    const response = await POST(
      new NextRequest("http://localhost/api/instances/inst_123/terminal/interactive", {
        method: "POST",
        body: JSON.stringify({ action: "start", cols: 100, rows: 40, mode: "tui" }),
        headers: { "Content-Type": "application/json" },
      }),
      { params: Promise.resolve({ id: "inst_123" }) },
    );
    const json = await response.json();
    const warningOutput = consoleWarnSpy.mock.calls.flat().join(" ");

    expect(response.status).toBe(500);
    expect(json.error).toBe("Terminal request failed");
    expect(warningOutput).toContain("terminal_sidecar_request_rejected");
    expect(warningOutput).toContain("\"status\":500");
    expect(warningOutput).not.toContain("terminal-start-secret-leak");
  });

  it("reports terminal request failure when start fails and managed refresh cannot be confirmed", async () => {
    mockedEnsureManagedSidecarScript.mockResolvedValueOnce(false);
    mockedFetchFirstReachableGatewayResponse.mockResolvedValue({
      response: new Response("old-sidecar-secret-leak", {
        status: 500,
        headers: {
          "Content-Type": "text/plain",
        },
      }),
      url: "https://agent.example.com/_sidecar/api/terminal",
    });

    const response = await POST(
      new NextRequest("http://localhost/api/instances/inst_123/terminal/interactive", {
        method: "POST",
        body: JSON.stringify({ action: "start", cols: 100, rows: 40, mode: "tui" }),
        headers: { "Content-Type": "application/json" },
      }),
      { params: Promise.resolve({ id: "inst_123" }) },
    );
    const json = await response.json();
    const warningOutput = consoleWarnSpy.mock.calls.flat().join(" ");

    expect(response.status).toBe(500);
    expect(json.error).toBe("Terminal request failed");
    expect(mockedFetchFirstReachableGatewayResponse).toHaveBeenCalledTimes(1);
    expect(warningOutput).toContain("terminal_sidecar_request_rejected");
    expect(warningOutput).toContain("managed_sidecar_refresh_unconfirmed");
    expect(warningOutput).toContain("terminal_sidecar_refresh_unconfirmed_after_start_failure");
    expect(warningOutput).not.toContain("old-sidecar-secret-leak");
  });

  it("does not log raw sidecar refresh failures when refresh-after-failed-start throws", async () => {
    mockedEnsureManagedSidecarScript.mockRejectedValueOnce(new Error("sidecar-secret-leak"));
    mockedFetchFirstReachableGatewayResponse.mockResolvedValue({
      response: new Response("old-sidecar-secret-leak", {
        status: 500,
        headers: {
          "Content-Type": "text/plain",
        },
      }),
      url: "https://agent.example.com/_sidecar/api/terminal",
    });

    const response = await POST(
      new NextRequest("http://localhost/api/instances/inst_123/terminal/interactive", {
        method: "POST",
        body: JSON.stringify({ action: "start", cols: 100, rows: 40, mode: "tui" }),
        headers: { "Content-Type": "application/json" },
      }),
      { params: Promise.resolve({ id: "inst_123" }) },
    );

    const json = await response.json();
    const warningOutput = consoleWarnSpy.mock.calls.flat().join(" ");

    expect(response.status).toBe(500);
    expect(json.error).toBe("Terminal request failed");
    expect(mockedFetchFirstReachableGatewayResponse).toHaveBeenCalledTimes(1);
    expect(warningOutput).toContain("terminal_sidecar_refresh_unconfirmed_after_start_failure");
    expect(warningOutput).not.toContain("sidecar-secret-leak");
    expect(warningOutput).not.toContain("old-sidecar-secret-leak");
  });
});
