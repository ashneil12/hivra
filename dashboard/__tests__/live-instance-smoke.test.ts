// eslint-disable-next-line @typescript-eslint/no-require-imports -- test exercises the shipped CommonJS entrypoint.
const { resolveSmokeConfig, runSmoke } = require("../scripts/live-instance-smoke.cjs");

describe("live-instance-smoke", () => {
  it("resolves dashboard mode from dashboard route credentials", () => {
    expect(
      resolveSmokeConfig({
        SMOKE_MODE: "dashboard",
        SMOKE_DASHBOARD_URL: "https://dashboard.example.com/",
        SMOKE_INSTANCE_ID: "inst-123",
        SMOKE_SESSION_COOKIE: "session-token",
      })
    ).toEqual({
      mode: "dashboard",
      baseUrl: "https://dashboard.example.com",
      instanceId: "inst-123",
      timeoutMs: 10_000,
      headers: {
        Accept: "application/json",
        Cookie: "__session=session-token",
      },
    });
  });

  it("runs the dashboard-route smoke against health and sidecar endpoints", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ isReady: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

    const summary = await runSmoke(
      resolveSmokeConfig({
        SMOKE_MODE: "dashboard",
        SMOKE_DASHBOARD_URL: "https://dashboard.example.com",
        SMOKE_INSTANCE_ID: "inst-123",
        SMOKE_COOKIE_HEADER: "__session=session-token; __client_uat=1",
      }),
      fetchMock
    );

    expect(summary.mode).toBe("dashboard");
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://dashboard.example.com/api/instances/inst-123/health",
      expect.objectContaining({
        method: "GET",
        headers: {
          Accept: "application/json",
          Cookie: "__session=session-token; __client_uat=1",
        },
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://dashboard.example.com/api/instances/inst-123/browser-sessions",
      expect.objectContaining({
        method: "GET",
      })
    );
  });

  it("runs the direct fallback smoke against gateway and sidecar probes", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: "gpt-test" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response("ok", {
          status: 200,
        })
      );

    const summary = await runSmoke(
      resolveSmokeConfig({
        SMOKE_MODE: "direct",
        SMOKE_GATEWAY_URL: "https://agent.example.com/",
        SMOKE_API_SERVER_KEY: "secret-key",
      }),
      fetchMock
    );

    expect(summary.mode).toBe("direct");
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://agent.example.com/v1/models",
      expect.objectContaining({
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: "Bearer secret-key",
        },
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://agent.example.com/vnc/core/rfb.js",
      expect.objectContaining({
        method: "GET",
      })
    );
  });
});
