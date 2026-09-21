jest.mock("server-only", () => ({}));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

import { log } from "@/lib/logger";
import { WebUIClient, __clearWebUIAuthCookieCacheForTests } from "../client";

describe("WebUIClient auth cache", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    __clearWebUIAuthCookieCacheForTests();
    jest.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("reuses the WebUI auth cookie across client instances", async () => {
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();

      if (url.endsWith("/api/auth/login")) {
        return new Response("{}", {
          status: 200,
          headers: { "set-cookie": "webui_session=abc; Path=/; HttpOnly" },
        });
      }

      if (url.endsWith("/api/sessions")) {
        const cookie = new Headers(init?.headers).get("cookie");
        if (cookie === "webui_session=abc") {
          return Response.json({ sessions: [], cli_count: 0 });
        }
        return new Response("unauthorized", { status: 401 });
      }

      return new Response("not found", { status: 404 });
    });
    global.fetch = fetchMock as typeof fetch;

    const cfg = {
      baseUrl: "https://webui.example.com/",
      password: "correct horse battery staple",
    };

    await expect(new WebUIClient(cfg).listSessions()).resolves.toEqual([]);
    await expect(new WebUIClient(cfg).listSessions()).resolves.toEqual([]);

    const loginCalls = fetchMock.mock.calls.filter(([input]) =>
      input.toString().endsWith("/api/auth/login"),
    );
    expect(loginCalls).toHaveLength(1);

    const secondClientSessionCall = fetchMock.mock.calls[3];
    expect(secondClientSessionCall[0].toString()).toBe("https://webui.example.com/api/sessions");
    expect(new Headers(secondClientSessionCall[1]?.headers).get("cookie")).toBe("webui_session=abc");
  });

  it("refreshes the cached WebUI auth cookie after a 401", async () => {
    let loginCount = 0;
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();

      if (url.endsWith("/api/auth/login")) {
        loginCount += 1;
        return new Response("{}", {
          status: 200,
          headers: { "set-cookie": `webui_session=${loginCount === 1 ? "old" : "fresh"}; Path=/; HttpOnly` },
        });
      }

      if (url.endsWith("/api/sessions")) {
        const cookie = new Headers(init?.headers).get("cookie");
        if (cookie === "webui_session=fresh") {
          return Response.json({ sessions: [], cli_count: 0 });
        }
        return new Response("unauthorized", { status: 401 });
      }

      return new Response("not found", { status: 404 });
    });
    global.fetch = fetchMock as typeof fetch;

    const cfg = {
      baseUrl: "https://webui.example.com",
      password: "correct horse battery staple",
    };

    await expect(new WebUIClient(cfg).listSessions()).rejects.toMatchObject({ status: 401 });
    await expect(new WebUIClient(cfg).listSessions()).resolves.toEqual([]);

    const loginCalls = fetchMock.mock.calls.filter(([input]) =>
      input.toString().endsWith("/api/auth/login"),
    );
    expect(loginCalls).toHaveLength(2);

    const retriedSessionCall = fetchMock.mock.calls.at(-1);
    expect(retriedSessionCall?.[0].toString()).toBe("https://webui.example.com/api/sessions");
    expect(new Headers(retriedSessionCall?.[1]?.headers).get("cookie")).toBe("webui_session=fresh");
  });

  it("recovers a stale bearer and retries the failed WebUI request once", async () => {
    const recover = jest.fn().mockResolvedValue({
      apiServerKey: "fresh-key",
      instanceIpv4: "203.0.113.10",
    });
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "https://webui.example.com/api/memory") {
        const authorization = new Headers(init?.headers).get("authorization");
        if (authorization === "Bearer fresh-key") {
          return Response.json({ memory: "remember this", user: "Ash" });
        }
        return new Response("auth 401", { status: 401 });
      }
      return new Response("not found", { status: 404 });
    });
    global.fetch = fetchMock as typeof fetch;

    await expect(
      new WebUIClient({
        baseUrl: "https://webui.example.com",
        bearer: "stale-key",
        password: "stale-key",
        staleBearerRecovery: {
          failureTypePrefix: "shared_webui_client",
          logCtx: {
            source: "webui-instance",
            route: "/api/instances/[id]/memory",
            instanceId: "inst-123",
            userId: "user-123",
          },
          recover,
        },
      } as ConstructorParameters<typeof WebUIClient>[0]).memory()
    ).resolves.toEqual({ memory: "remember this", user: "Ash" });

    expect(recover).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("authorization")).toBe("Bearer stale-key");
    expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get("authorization")).toBe("Bearer fresh-key");
    expect(log.warn).toHaveBeenCalledWith(
      "WebUI bearer recovered after upstream 401; retrying request",
      expect.objectContaining({
        failureType: "shared_webui_client_stale_bearer_recovered",
        upstreamStatus: 401,
        route: "/api/instances/[id]/memory",
      })
    );
  });

  it("treats malformed successful WebUI JSON as a bad upstream response", async () => {
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      const url = input.toString();
      if (url === "https://webui.example.com/api/memory") {
        return new Response("<html>not json</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    global.fetch = fetchMock as typeof fetch;

    await expect(
      new WebUIClient({ baseUrl: "https://webui.example.com" }).memory()
    ).rejects.toMatchObject({
      name: "WebUIError",
      status: 502,
      body: "<html>not json</html>",
    });
  });

  it("passes optional linked file paths to the skill content endpoint", async () => {
    const fetchMock = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>(async (input, init) => {
      void init;
      const url = input.toString();
      if (url === "https://webui.example.com/api/skills/content?name=copywriting&file=docs%2Fexample.md") {
        return Response.json({ content: "# Example", path: "docs/example.md" });
      }
      return new Response("not found", { status: 404 });
    });
    global.fetch = fetchMock as typeof fetch;

    await expect(
      new WebUIClient({ baseUrl: "https://webui.example.com" }).skillContent("copywriting", "docs/example.md")
    ).resolves.toEqual({ content: "# Example", path: "docs/example.md" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://webui.example.com/api/skills/content?name=copywriting&file=docs%2Fexample.md",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("falls back to the instance IPv4 when the public WebUI hostname cannot be fetched", async () => {
    const fetchMock = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>(async (input, init) => {
      void init;
      const url = input.toString();
      if (url === "https://webui.example.com/api/sessions") {
        throw new TypeError("fetch failed");
      }
      if (url === "http://203.0.113.10/api/sessions") {
        return Response.json({ sessions: [], cli_count: 0 });
      }
      return new Response("not found", { status: 404 });
    });
    global.fetch = fetchMock as typeof fetch;

    await expect(
      new WebUIClient({
        baseUrl: "https://webui.example.com",
        bearer: "secret-key",
        instanceIpv4: "203.0.113.10",
      }).listSessions()
    ).resolves.toEqual([]);

    expect(fetchMock.mock.calls.map(([input]) => input.toString())).toEqual([
      "https://webui.example.com/api/sessions",
      "http://203.0.113.10/api/sessions",
    ]);
    expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get("authorization")).toBe("Bearer secret-key");
    expect(log.warn).toHaveBeenCalledWith(
      "webui gateway candidate failed; trying fallback",
      expect.objectContaining({
        source: "webui-client",
        route: "/api/sessions",
        failureType: "webui_gateway_candidate_failed",
        upstreamHost: "webui.example.com",
        fallbackHost: "203.0.113.10",
      }),
      expect.any(TypeError)
    );
  });

  it("scopes runtime settings requests to a WebUI profile cookie", async () => {
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      const url = input.toString();
      if (url === "https://webui.example.com/api/default-model") {
        return Response.json({ ok: true, model: "deepseek-v3.2" });
      }
      if (url === "https://webui.example.com/api/providers") {
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    });
    global.fetch = fetchMock as typeof fetch;

    const client = new WebUIClient({ baseUrl: "https://webui.example.com" });

    await expect(
      client.setDefaultModel("@crof:deepseek-v3.2", { profile: "research" })
    ).resolves.toEqual({ ok: true, model: "deepseek-v3.2" });
    await expect(
      client.setProviderKey("crof", "sk-test", { profile: "research" })
    ).resolves.toEqual({ ok: true });

    const modelCall = fetchMock.mock.calls[0];
    expect(new Headers(modelCall[1]?.headers).get("cookie")).toBe("hermes_profile=research");
    expect(JSON.parse(String(modelCall[1]?.body))).toEqual({ model: "@crof:deepseek-v3.2" });

    const providerCall = fetchMock.mock.calls[1];
    expect(new Headers(providerCall[1]?.headers).get("cookie")).toBe("hermes_profile=research");
    expect(JSON.parse(String(providerCall[1]?.body))).toEqual({
      provider: "crof",
      api_key: "sk-test",
    });
  });

  it("scopes runtime model catalog requests to a WebUI profile cookie", async () => {
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      const url = input.toString();
      if (url === "https://webui.example.com/api/models") {
        return Response.json({ default_model: "claude-opus-4-7", active_provider: "custom" });
      }
      return new Response("not found", { status: 404 });
    });
    global.fetch = fetchMock as typeof fetch;

    await expect(
      new WebUIClient({ baseUrl: "https://webui.example.com" }).models({ profile: "research" })
    ).resolves.toEqual({ default_model: "claude-opus-4-7", active_provider: "custom" });

    const modelsCall = fetchMock.mock.calls[0];
    expect(new Headers(modelsCall[1]?.headers).get("cookie")).toBe("hermes_profile=research");
  });

  it("scopes background runtime requests to a WebUI profile cookie", async () => {
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "https://webui.example.com/api/background/status?session_id=sess-123") {
        expect(new Headers(init?.headers).get("cookie")).toBe("hermes_profile=research");
        return Response.json({ results: [{ task_id: "task-1" }] });
      }
      if (url === "https://webui.example.com/api/background") {
        expect(new Headers(init?.headers).get("cookie")).toBe("hermes_profile=research");
        expect(JSON.parse(String(init?.body))).toEqual({
          session_id: "sess-123",
          prompt: "summarize this",
        });
        return Response.json({ task_id: "task-2" });
      }
      return new Response("not found", { status: 404 });
    });
    global.fetch = fetchMock as typeof fetch;

    const client = new WebUIClient({ baseUrl: "https://webui.example.com" });
    const backgroundStatus = client.backgroundStatus.bind(client) as (
      sessionId: string,
      opts?: { profile?: string },
    ) => Promise<unknown>;
    const startBackground = client.startBackground.bind(client) as (
      sessionId: string,
      prompt: string,
      opts?: { profile?: string },
    ) => Promise<unknown>;

    await expect(backgroundStatus("sess-123", { profile: "research" })).resolves.toEqual({
      results: [{ task_id: "task-1" }],
    });
    await expect(startBackground("sess-123", "summarize this", { profile: "research" })).resolves.toEqual({
      task_id: "task-2",
    });
  });

  it("scopes session list requests to a WebUI profile cookie", async () => {
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "https://webui.example.com/api/sessions") {
        expect(new Headers(init?.headers).get("cookie")).toBe("hermes_profile=research");
        return Response.json({ sessions: [{ session_id: "research-session", profile: "research" }], cli_count: 0 });
      }
      return new Response("not found", { status: 404 });
    });
    global.fetch = fetchMock as typeof fetch;

    await expect(
      new WebUIClient({ baseUrl: "https://webui.example.com" }).listSessions({ profile: "research" })
    ).resolves.toEqual([{ session_id: "research-session", profile: "research" }]);
  });

  it("uploads chat attachments with multipart form data scoped to the WebUI profile", async () => {
    const file = new File(["image-bytes"], "screen.png", { type: "image/png" });
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "https://webui.example.com/api/upload") {
        const headers = new Headers(init?.headers);
        expect(headers.get("cookie")).toBe("hermes_profile=research");
        expect(headers.get("content-type")).toBeNull();
        expect(init?.body).toBeInstanceOf(FormData);
        const form = init?.body as FormData;
        expect(form.get("session_id")).toBe("sess-123");
        expect(form.get("file")).toBe(file);
        return Response.json({
          filename: "screen.png",
          name: "screen.png",
          path: "/workspace/screen.png",
          size: 11,
          mime: "image/png",
          is_image: true,
        });
      }
      return new Response("not found", { status: 404 });
    });
    global.fetch = fetchMock as typeof fetch;

    await expect(
      new WebUIClient({ baseUrl: "https://webui.example.com" }).uploadChatAttachment("sess-123", file, {
        profile: "research",
      })
    ).resolves.toEqual({
      filename: "screen.png",
      name: "screen.png",
      path: "/workspace/screen.png",
      size: 11,
      mime: "image/png",
      is_image: true,
    });
  });

  it("keeps the profile cookie when retrying after WebUI auth refresh", async () => {
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();

      if (url.endsWith("/api/auth/login")) {
        return new Response("{}", {
          status: 200,
          headers: { "set-cookie": "webui_session=fresh; Path=/; HttpOnly" },
        });
      }

      if (url.endsWith("/api/default-model")) {
        const cookie = new Headers(init?.headers).get("cookie");
        if (cookie === "webui_session=fresh; hermes_profile=research") {
          return Response.json({ ok: true, model: "deepseek-v3.2" });
        }
        return new Response("unauthorized", { status: 401 });
      }

      return new Response("not found", { status: 404 });
    });
    global.fetch = fetchMock as typeof fetch;

    await expect(
      new WebUIClient({
        baseUrl: "https://webui.example.com",
        password: "correct horse battery staple",
      }).setDefaultModel("@crof:deepseek-v3.2", { profile: "research" })
    ).resolves.toEqual({ ok: true, model: "deepseek-v3.2" });

    const retriedModelCall = fetchMock.mock.calls.at(-1);
    expect(retriedModelCall?.[0].toString()).toBe("https://webui.example.com/api/default-model");
    expect(new Headers(retriedModelCall?.[1]?.headers).get("cookie")).toBe(
      "webui_session=fresh; hermes_profile=research"
    );
  });
});
