import { NextRequest } from "next/server";

import { GET } from "../route";
import { auth } from "@clerk/nextjs/server";
import { agentWebApi } from "@/lib/agent-web-api";
import { getInstanceBackend } from "@/lib/instance-backend";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));

jest.mock("@/lib/agent-web-api", () => ({
  agentWebApi: jest.fn(),
}));

jest.mock("@/lib/instance-backend", () => ({
  getInstanceBackend: jest.fn(),
}));

describe("GET /api/instances/[id]/dashboard-plugins", () => {
  const mockedAuth = auth as jest.MockedFunction<typeof auth>;
  const mockedAgentWebApi = agentWebApi as jest.MockedFunction<typeof agentWebApi>;
  const mockedGetInstanceBackend = getInstanceBackend as jest.MockedFunction<typeof getInstanceBackend>;
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
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("returns an empty plugin list for gateway-backed instances (collapsed onto webfree)", async () => {
    // Post gateway≡webfree collapse: a "gateway" box is treated identically to a
    // "webui" box. isWebfreeBackend("gateway") is true, so the route short-circuits
    // to an empty plugin list WITHOUT ever reaching the legacy upstream web-API path.
    mockedGetInstanceBackend.mockResolvedValue("gateway");
    apiClient.get.mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            name: "example-dashboard",
            label: "Example Dashboard",
            description: "Adds a dashboard extension.",
            version: "1.0.0",
            source: "bundled",
            slots: ["instance.header"],
            has_api: true,
            tab: { path: "/example-dashboard", position: "end" },
          },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123/dashboard-plugins"),
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

  it("returns an empty plugin list for WebUI-backed instances", async () => {
    mockedGetInstanceBackend.mockResolvedValue("webui");

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123/dashboard-plugins"),
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

  it("short-circuits before upstream so an upstream timeout never reaches the client (collapsed)", async () => {
    // Pre-collapse this surfaced a 504 from the legacy upstream path. Post-collapse
    // every backend value is webfree, so the route returns the empty list and the
    // upstream client is never invoked — the timeout mock is unreachable by design.
    mockedGetInstanceBackend.mockResolvedValue("gateway");
    apiClient.get.mockRejectedValue(
      new DOMException("The operation was aborted due to timeout", "TimeoutError")
    );

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123/dashboard-plugins"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(agentWebApi).not.toHaveBeenCalled();
    expect(apiClient.get).not.toHaveBeenCalled();
    expect(json).toEqual({ success: true, data: [] });
    expect(JSON.stringify(consoleErrorSpy.mock.calls)).not.toContain("aborted due to timeout");
  });

  it("short-circuits before upstream so a raw upstream failure body can never leak (collapsed)", async () => {
    // Pre-collapse this returned a sanitized 502 from the legacy upstream path.
    // Post-collapse the webfree short-circuit means the upstream body is never
    // fetched, so there is nothing to sanitize or leak.
    mockedGetInstanceBackend.mockResolvedValue("gateway");
    apiClient.get.mockResolvedValue(
      new Response("plugin-secret-leak", { status: 502, statusText: "Bad Gateway" })
    );

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123/dashboard-plugins"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(agentWebApi).not.toHaveBeenCalled();
    expect(apiClient.get).not.toHaveBeenCalled();
    expect(json).toEqual({ success: true, data: [] });
    expect(JSON.stringify(json)).not.toContain("plugin-secret-leak");
    expect(JSON.stringify(consoleErrorSpy.mock.calls)).not.toContain("plugin-secret-leak");
  });
});
