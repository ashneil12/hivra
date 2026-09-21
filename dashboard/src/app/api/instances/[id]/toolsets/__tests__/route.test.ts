import { NextRequest } from "next/server";

import { GET, PUT } from "../route";
import { auth } from "@clerk/nextjs/server";
import { agentWebApi } from "@/lib/agent-web-api";
import { getInstanceBackend } from "@/lib/instance-backend";
import { supabaseAdmin } from "@/lib/supabase";
import { resolveInstanceIpv4 } from "@/lib/instance-resolvers";
import { putHermesConfigWithBindMountFallback } from "@/lib/hermes-config-write";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));

jest.mock("@/lib/agent-web-api", () => ({
  agentWebApi: jest.fn(),
}));

jest.mock("@/lib/instance-backend", () => ({
  getInstanceBackend: jest.fn(),
}));

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/instance-resolvers", () => ({
  resolveInstanceIpv4: jest.fn(),
}));

jest.mock("@/lib/hermes-config-write", () => ({
  putHermesConfigWithBindMountFallback: jest.fn(),
}));

describe("GET /api/instances/[id]/toolsets", () => {
  const mockedAuth = auth as jest.MockedFunction<typeof auth>;
  const mockedAgentWebApi = agentWebApi as jest.MockedFunction<typeof agentWebApi>;
  const mockedGetInstanceBackend = getInstanceBackend as jest.MockedFunction<typeof getInstanceBackend>;
  const mockedFrom = supabaseAdmin!.from as jest.Mock;
  const mockedResolveInstanceIpv4 = resolveInstanceIpv4 as jest.MockedFunction<typeof resolveInstanceIpv4>;
  const mockedConfigFallback = putHermesConfigWithBindMountFallback as jest.MockedFunction<typeof putHermesConfigWithBindMountFallback>;
  const signedInAuth = { userId: "user_123" } as Awaited<ReturnType<typeof auth>>;
  let consoleErrorSpy: jest.SpyInstance;
  const apiClient = {
    baseUrl: "https://agent.example.com/web-api",
    get: jest.fn(),
    post: jest.fn(),
    put: jest.fn(),
    del: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    mockedAuth.mockResolvedValue(signedInAuth);
    mockedGetInstanceBackend.mockResolvedValue("gateway");
    mockedAgentWebApi.mockResolvedValue(apiClient);
    mockedResolveInstanceIpv4.mockResolvedValue("203.0.113.10");
    mockedConfigFallback.mockResolvedValue({ ok: true, mode: "direct-write-fallback" });
    mockedFrom.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: {
          id: "inst-123",
          config: {},
        },
        error: null,
      }),
    });
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("returns an empty toolset list for gateway-backed instances (collapsed onto webfree)", async () => {
    // Post gateway≡webfree collapse, a "gateway" backend is treated identically
    // to "webui": both short-circuit to an empty toolset list and never reach the
    // legacy upstream web dashboard API.
    apiClient.get.mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            name: "browser",
            label: "Browser",
            description: "Browser automation",
            enabled: true,
            configured: true,
            tools: ["browser_open", "browser_click"],
          },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123/toolsets"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(agentWebApi).not.toHaveBeenCalled();
    expect(apiClient.get).not.toHaveBeenCalled();
    expect(json).toEqual({
      success: true,
      data: [],
    });
  });

  it("returns an empty toolset list for WebUI-backed instances", async () => {
    mockedGetInstanceBackend.mockResolvedValue("webui");

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123/toolsets"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(agentWebApi).not.toHaveBeenCalled();
    expect(json).toEqual({
      success: true,
      data: [],
    });
  });

  it("does not route WebUI toolset toggles through the legacy dashboard token path", async () => {
    mockedGetInstanceBackend.mockResolvedValue("webui");

    const response = await PUT(
      new NextRequest("http://localhost/api/instances/inst-123/toolsets", {
        method: "PUT",
        body: JSON.stringify({ name: "browser", enabled: true }),
        headers: {
          "Content-Type": "application/json",
        },
      }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(501);
    expect(agentWebApi).not.toHaveBeenCalled();
    expect(json).toMatchObject({
      success: false,
      error: "This runtime does not expose dashboard toolset toggles yet.",
    });
  });

  it("never reaches the upstream path on gateway timeouts (collapsed onto webfree)", async () => {
    // The legacy upstream toolsets call is short-circuited for gateway boxes, so a
    // would-be upstream timeout can no longer surface — gateway returns the empty
    // webfree list just like webui.
    apiClient.get.mockRejectedValue(
      new DOMException("The operation was aborted due to timeout", "TimeoutError")
    );

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123/toolsets"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(agentWebApi).not.toHaveBeenCalled();
    expect(apiClient.get).not.toHaveBeenCalled();
    expect(json).toEqual({
      success: true,
      data: [],
    });
  });

  it("never reaches the upstream path that could leak failure bodies on gateway boxes", async () => {
    // A 502 upstream body can no longer be reached for gateway boxes post-collapse;
    // the handler short-circuits to the empty webfree list before any upstream call.
    apiClient.get.mockResolvedValue(
      new Response("toolset-secret-leak", { status: 502, statusText: "Bad Gateway" })
    );

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123/toolsets"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(agentWebApi).not.toHaveBeenCalled();
    expect(apiClient.get).not.toHaveBeenCalled();
    expect(json).toEqual({
      success: true,
      data: [],
    });
    expect(JSON.stringify(consoleErrorSpy.mock.calls)).not.toContain("toolset-secret-leak");
  });

  it("does not route gateway toolset toggles through the legacy config-write path (collapsed onto webfree)", async () => {
    // Post-collapse a "gateway" box is treated like "webui": the PUT short-circuits
    // with a 501 before any upstream toolsets/config call or hardened config write,
    // so the legacy cli platform_toolsets write path is never exercised.
    apiClient.get.mockImplementation(async (path: string) => {
      if (path === "/api/tools/toolsets") {
        return new Response(
          JSON.stringify([
            { name: "web", label: "Web", enabled: true, configured: true, tools: ["web_search"] },
            { name: "skills", label: "Skills", enabled: true, configured: true, tools: ["skills_list"] },
            { name: "browser", label: "Browser", enabled: false, configured: true, tools: ["browser_open"] },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      if (path === "/api/config") {
        return new Response(
          JSON.stringify({
            model: "gpt-5",
            platform_toolsets: {
              cli: ["hermes-cli", "mcp-olympus"],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      throw new Error(`Unexpected path: ${path}`);
    });

    const response = await PUT(
      new NextRequest("http://localhost/api/instances/inst-123/toolsets", {
        method: "PUT",
        body: JSON.stringify({ name: "browser", enabled: true }),
        headers: {
          "Content-Type": "application/json",
        },
      }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(501);
    expect(agentWebApi).not.toHaveBeenCalled();
    expect(apiClient.get).not.toHaveBeenCalled();
    expect(mockedConfigFallback).not.toHaveBeenCalled();
    expect(json).toMatchObject({
      success: false,
      error: "This runtime does not expose dashboard toolset toggles yet.",
    });
  });
});
