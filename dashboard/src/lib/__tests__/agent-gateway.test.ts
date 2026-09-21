import { fetchFirstReachableGatewayResponse } from "@/lib/agent-gateway";
import { fetchWithInsecureTLS } from "@/lib/insecure-fetch";

jest.mock("@/lib/insecure-fetch", () => ({
  fetchWithInsecureTLS: jest.fn(),
}));

describe("fetchFirstReachableGatewayResponse", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("does not downgrade to http when the secure probe fails", async () => {
    const fetchSpy = jest.spyOn(global, "fetch");
    (fetchWithInsecureTLS as jest.Mock).mockRejectedValueOnce(new Error("connect ECONNREFUSED"));

    await expect(
      fetchFirstReachableGatewayResponse({
        baseUrl: "https://agent.example.com",
        pathname: "/api/skills",
        timeoutMs: 5_000,
        headers: { Authorization: "Bearer token" },
      })
    ).rejects.toThrow("connect ECONNREFUSED");

    expect(fetchWithInsecureTLS).toHaveBeenCalledWith(
      "https://agent.example.com/api/skills",
      expect.objectContaining({
        method: "GET",
        headers: { Authorization: "Bearer token" },
      })
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("returns the first non-throwing response even when it is non-2xx", async () => {
    const fetchSpy = jest.spyOn(global, "fetch");
    (fetchWithInsecureTLS as jest.Mock).mockResolvedValueOnce(
      new Response("not found", { status: 404 })
    );

    const result = await fetchFirstReachableGatewayResponse({
      baseUrl: "https://agent.example.com",
      pathname: "/missing",
      timeoutMs: 5_000,
    });

    expect(result.url).toBe("https://agent.example.com/missing");
    expect(result.response.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("retries transient probe failures before succeeding", async () => {
    (fetchWithInsecureTLS as jest.Mock)
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

    const result = await fetchFirstReachableGatewayResponse({
      baseUrl: "https://agent.example.com",
      pathname: "/api/jobs?include_disabled=true",
      timeoutMs: 5_000,
      headers: { Authorization: "Bearer token" },
      retries: 3,
    });

    expect(fetchWithInsecureTLS).toHaveBeenCalledTimes(3);
    expect(result.url).toBe("https://agent.example.com/api/jobs?include_disabled=true");
    expect(result.response.status).toBe(200);
  });

  it("tries the direct IPv4 fallback when the gateway hostname probe throws", async () => {
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    (fetchWithInsecureTLS as jest.Mock)
      .mockRejectedValueOnce(new Error("dns lookup failed"));

    const result = await fetchFirstReachableGatewayResponse({
      baseUrl: "https://203-0-113-11.sslip.io",
      pathname: "/v1/models",
      timeoutMs: 5_000,
      instanceIpv4: "203.0.113.11",
    });

    expect(fetchWithInsecureTLS).toHaveBeenCalledWith(
      "https://203-0-113-11.sslip.io/v1/models",
      expect.objectContaining({
        method: "GET",
      })
    );
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://203.0.113.11/v1/models",
      expect.objectContaining({
        method: "GET",
      })
    );
    expect(result.url).toBe("http://203.0.113.11/v1/models");
    expect(result.response.status).toBe(200);
    fetchSpy.mockRestore();
  });

  it("tries the direct IPv4 fallback when the gateway hostname returns Cloudflare 525", async () => {
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    (fetchWithInsecureTLS as jest.Mock).mockResolvedValueOnce(
      new Response("SSL handshake failed", { status: 525 })
    );

    const result = await fetchFirstReachableGatewayResponse({
      baseUrl: "https://agent.example.com",
      pathname: "/v1/models",
      timeoutMs: 5_000,
      instanceIpv4: "203.0.113.11",
    });

    expect(fetchWithInsecureTLS).toHaveBeenCalledWith(
      "https://agent.example.com/v1/models",
      expect.objectContaining({
        method: "GET",
      })
    );
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://203.0.113.11/v1/models",
      expect.objectContaining({
        method: "GET",
      })
    );
    expect(result.url).toBe("http://203.0.113.11/v1/models");
    expect(result.response.status).toBe(200);
    fetchSpy.mockRestore();
  });

  it("tries the direct profile gateway port after hostname and routed IPv4 probes fail", async () => {
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const result = await fetchFirstReachableGatewayResponse({
      baseUrl: "https://203-0-113-11.sslip.io/profiles/research",
      pathname: "/api/sessions",
      timeoutMs: 5_000,
      instanceIpv4: "203.0.113.11",
      profileGatewayPort: 8650,
    });

    expect(fetchSpy).toHaveBeenNthCalledWith(
      1,
      "http://203.0.113.11:8650/api/sessions",
      expect.objectContaining({
        method: "GET",
      })
    );
    expect(result.url).toBe("http://203.0.113.11:8650/api/sessions");
    expect(result.response.status).toBe(200);
    expect(fetchWithInsecureTLS).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("clears connect-only timeouts after the upstream stream has connected", async () => {
    let capturedSignal: AbortSignal | undefined;

    (fetchWithInsecureTLS as jest.Mock).mockImplementationOnce(async (_url: string, init?: RequestInit) => {
      capturedSignal = init?.signal as AbortSignal | undefined;
      return new Response(
        new ReadableStream({
          start() {
            // Keep the body open to mimic a live SSE stream.
          },
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
          },
        }
      );
    });

    const result = await fetchFirstReachableGatewayResponse({
      baseUrl: "https://agent.example.com",
      pathname: "/api/sessions/conv-123/chat/stream",
      timeoutMs: 25,
      timeoutScope: "connect",
      method: "POST",
    });

    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(result.response.status).toBe(200);
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(false);
  });

  it("falls back after the first probe hangs until its timeout", async () => {
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    (fetchWithInsecureTLS as jest.Mock).mockImplementationOnce((_: string, init?: RequestInit) => {
      const signal = init?.signal;
      return new Promise((_, reject) => {
        if (signal) {
          signal.addEventListener(
            "abort",
            () => reject(signal.reason ?? new Error("aborted")),
            { once: true }
          );
        }
      });
    });

    const result = await fetchFirstReachableGatewayResponse({
      baseUrl: "https://203-0-113-11.sslip.io",
      pathname: "/v1/models",
      timeoutMs: 100,
      instanceIpv4: "203.0.113.11",
    });

    expect(fetchWithInsecureTLS).toHaveBeenCalledWith(
      "https://203-0-113-11.sslip.io/v1/models",
      expect.objectContaining({
        method: "GET",
      })
    );
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://203.0.113.11/v1/models",
      expect.objectContaining({
        method: "GET",
      })
    );
    expect(result.url).toBe("http://203.0.113.11/v1/models");
    expect(result.response.status).toBe(200);
    fetchSpy.mockRestore();
  });

  it("falls back after a connect-only probe hangs until its timeout", async () => {
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    (fetchWithInsecureTLS as jest.Mock).mockImplementationOnce((_: string, init?: RequestInit) => {
      const signal = init?.signal;
      return new Promise((_, reject) => {
        if (signal) {
          signal.addEventListener(
            "abort",
            () => reject(signal.reason ?? new Error("aborted")),
            { once: true }
          );
        }
      });
    });

    const result = await fetchFirstReachableGatewayResponse({
      baseUrl: "https://203-0-113-11.sslip.io",
      pathname: "/api/sessions/conv-123/chat/stream",
      timeoutMs: 100,
      timeoutScope: "connect",
      instanceIpv4: "203.0.113.11",
      method: "POST",
    });

    expect(fetchWithInsecureTLS).toHaveBeenCalledWith(
      "https://203-0-113-11.sslip.io/api/sessions/conv-123/chat/stream",
      expect.objectContaining({
        method: "POST",
      })
    );
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://203.0.113.11/api/sessions/conv-123/chat/stream",
      expect.objectContaining({
        method: "POST",
      })
    );
    expect(result.url).toBe("http://203.0.113.11/api/sessions/conv-123/chat/stream");
    expect(result.response.status).toBe(200);
    fetchSpy.mockRestore();
  });

  it("throws a diagnostic error with every attempted gateway route when all probes fail", async () => {
    const fetchSpy = jest
      .spyOn(global, "fetch")
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED 203.0.113.11"));
    (fetchWithInsecureTLS as jest.Mock).mockRejectedValueOnce(new Error("dns lookup failed"));

    let caught: unknown;
    try {
      await fetchFirstReachableGatewayResponse({
        baseUrl: "https://203-0-113-11.sslip.io",
        pathname: "/api/chat/stream?stream_id=stream_123&exp=123&sig=super-secret-signature",
        timeoutMs: 5_000,
        timeoutScope: "connect",
        method: "GET",
        instanceIpv4: "203.0.113.11",
        requestId: "req_gateway_123",
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toMatchObject({
      name: "AgentGatewayRequestError",
      requestId: "req_gateway_123",
      attempts: [
        {
          url: "https://203-0-113-11.sslip.io/api/chat/stream?stream_id=<redacted>&exp=<redacted>&sig=<redacted>",
          errorName: "Error",
          errorMessage: "dns lookup failed",
          timeoutScope: "connect",
        },
        {
          url: "http://203.0.113.11/api/chat/stream?stream_id=<redacted>&exp=<redacted>&sig=<redacted>",
          errorName: "Error",
          errorMessage: "connect ECONNREFUSED 203.0.113.11",
          timeoutScope: "connect",
        },
      ],
    });
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("Gateway request failed after 2 attempts");
    expect((caught as Error).message).toContain("dns lookup failed");
    expect((caught as Error).message).toContain("connect ECONNREFUSED");
    expect(JSON.stringify(caught)).not.toContain("super-secret-signature");
    expect(JSON.stringify(caught)).not.toContain("stream_123");
    fetchSpy.mockRestore();
  });
});
