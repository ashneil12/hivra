/**
 * @jest-environment node
 */
import { NextRequest } from "next/server";
import { GET } from "../route";
import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";
import { decryptApiKey } from "@/lib/crypto";
import { fetchFirstReachableGatewayResponse } from "@/lib/agent-gateway";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/crypto", () => ({
  decryptApiKey: jest.fn(),
}));

jest.mock("@/lib/agent-gateway", () => ({
  fetchFirstReachableGatewayResponse: jest.fn(),
}));

const mockedAuth = auth as jest.MockedFunction<typeof auth>;
const mockedFrom = supabaseAdmin!.from as jest.Mock;
const mockedDecrypt = decryptApiKey as jest.MockedFunction<typeof decryptApiKey>;
const mockedGateway = fetchFirstReachableGatewayResponse as jest.MockedFunction<
  typeof fetchFirstReachableGatewayResponse
>;

const INSTANCE_ID = "00000000-0000-4000-8000-000000001025";

function buildRequest(): NextRequest {
  return new NextRequest(
    `http://localhost/api/instances/${INSTANCE_ID}/memory/status`,
    { method: "GET" },
  );
}

function buildParams(): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id: INSTANCE_ID }) };
}

function mockInstance(config: Record<string, unknown>, gateway = "https://agent.example.com") {
  mockedFrom.mockReturnValueOnce({
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue({
      data: {
        id: INSTANCE_ID,
        gateway_url: gateway,
        api_server_key_encrypted: "enc-key",
        config,
      },
      error: null,
    }),
  });
}

describe("GET /api/instances/[id]/memory/status", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedAuth.mockResolvedValue({ userId: "user-123" } as Awaited<ReturnType<typeof auth>>);
    mockedDecrypt.mockReturnValue("server-key");
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("returns 401 when unauthenticated", async () => {
    mockedAuth.mockResolvedValueOnce({ userId: null } as Awaited<ReturnType<typeof auth>>);
    const res = await GET(buildRequest(), buildParams());
    expect(res.status).toBe(401);
  });

  it("returns 404 when instance not found", async () => {
    mockedFrom.mockReturnValueOnce({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({ data: null, error: { message: "not found" } }),
    });
    const res = await GET(buildRequest(), buildParams());
    expect(res.status).toBe(404);
  });

  it("reports drift when agent provider differs from saved provider", async () => {
    mockInstance({ memorySystem: { provider: "mem0" } });
    mockedGateway.mockResolvedValue({
      response: new Response(JSON.stringify({ memory: { provider: "honcho" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
      url: "https://agent.example.com/api/config",
    });

    const res = await GET(buildRequest(), buildParams());
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(json.data.dbProvider).toBe("mem0");
    expect(json.data.agentProvider).toBe("honcho");
    expect(json.data.agentReachable).toBe(true);
    expect(json.data.drift).toBe(true);
  });

  it("reports drift=false when agent provider matches saved provider", async () => {
    mockInstance({ memorySystem: { provider: "honcho" } });
    mockedGateway.mockResolvedValue({
      response: new Response(JSON.stringify({ memory: { provider: "honcho" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
      url: "https://agent.example.com/api/config",
    });

    const res = await GET(buildRequest(), buildParams());
    const json = await res.json();

    expect(json.data.drift).toBe(false);
    expect(json.data.agentReachable).toBe(true);
  });

  it("returns agentReachable=false when gateway is unreachable", async () => {
    mockInstance({ memorySystem: { provider: "honcho" } });
    mockedGateway.mockRejectedValue(new Error("connect ETIMEDOUT"));

    const res = await GET(buildRequest(), buildParams());
    const json = await res.json();

    expect(json.data.agentReachable).toBe(false);
    expect(json.data.drift).toBe(false);
    // F100: with a provider configured but the agent unreachable, drift is
    // genuinely unknown — it must NOT be reported as a confirmed "in sync".
    expect(json.data.driftStatus).toBe("unknown");
    expect(json.data.agentError).toMatch(/ETIMEDOUT|unreachable/i);
  });

  it("returns agentError when instance has no gateway_url yet", async () => {
    mockInstance({ memorySystem: { provider: "honcho" } }, "");
    const res = await GET(buildRequest(), buildParams());
    const json = await res.json();
    expect(json.data.agentReachable).toBe(false);
    expect(json.data.agentError).toMatch(/not been deployed/i);
  });

  it("probes the OpenViking endpoint when configured", async () => {
    mockInstance({
      memorySystem: { provider: "openviking", openVikingEndpoint: "https://openviking.example" },
    });
    mockedGateway.mockResolvedValue({
      response: new Response(JSON.stringify({ memory: { provider: "openviking" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
      url: "https://agent.example.com/api/config",
    });
    const fetchMock = jest.fn().mockResolvedValue(new Response(null, { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await GET(buildRequest(), buildParams());
    const json = await res.json();

    expect(json.data.endpointHealthy).toBe(true);
    expect(json.data.drift).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://openviking.example/health",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("flags OpenViking endpoint as unhealthy when probe fails", async () => {
    mockInstance({
      memorySystem: { provider: "openviking", openVikingEndpoint: "https://openviking.example" },
    });
    mockedGateway.mockResolvedValue({
      response: new Response(JSON.stringify({ memory: { provider: "openviking" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
      url: "https://agent.example.com/api/config",
    });
    global.fetch = jest.fn().mockRejectedValue(new TypeError("fetch failed")) as unknown as typeof fetch;

    const res = await GET(buildRequest(), buildParams());
    const json = await res.json();

    expect(json.data.endpointHealthy).toBe(false);
    expect(json.data.endpointError).toMatch(/did not respond/i);
  });

  it("does not fetch unsafe saved OpenViking endpoints from the dashboard server", async () => {
    mockInstance({
      memorySystem: { provider: "openviking", openVikingEndpoint: "http://127.0.0.1:3000" },
    });
    mockedGateway.mockResolvedValue({
      response: new Response(JSON.stringify({ memory: { provider: "openviking" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
      url: "https://agent.example.com/api/config",
    });
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await GET(buildRequest(), buildParams());
    const json = await res.json();

    expect(json.data.endpointHealthy).toBe(false);
    expect(json.data.endpointError).toMatch(/not allowed/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not probe endpoint for providers other than OpenViking", async () => {
    mockInstance({ memorySystem: { provider: "mem0" } });
    mockedGateway.mockResolvedValue({
      response: new Response(JSON.stringify({ memory: { provider: "mem0" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
      url: "https://agent.example.com/api/config",
    });
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await GET(buildRequest(), buildParams());
    const json = await res.json();

    expect(json.data.endpointHealthy).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
