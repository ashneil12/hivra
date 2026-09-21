import { agentWebApi } from "@/lib/agent-web-api";
import { fetchFirstReachableGatewayResponse } from "@/lib/agent-gateway";
import { supabaseAdmin } from "@/lib/supabase";
import { decryptApiKey } from "@/lib/crypto";
import { resolveInstanceIpv4 } from "@/lib/instance-resolvers";

jest.mock("@/lib/agent-gateway", () => ({
  fetchFirstReachableGatewayResponse: jest.fn(),
}));

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/instance-resolvers", () => ({
  resolveInstanceIpv4: jest.fn(),
}));

jest.mock("@/lib/crypto", () => ({
  decryptApiKey: jest.fn(() => "decrypted-api-key"),
}));

describe("agentWebApi", () => {
  const mockedFetchFirstReachableGatewayResponse =
    fetchFirstReachableGatewayResponse as jest.MockedFunction<
      typeof fetchFirstReachableGatewayResponse
    >;
  const mockedFrom = supabaseAdmin!.from as jest.Mock;
  const mockSingle = jest.fn();
  const mockEqUser = jest.fn(() => ({ single: mockSingle }));
  const mockEqId = jest.fn(() => ({ eq: mockEqUser }));
  const mockSelect = jest.fn(() => ({ eq: mockEqId }));

  beforeEach(() => {
    jest.clearAllMocks();
    (resolveInstanceIpv4 as jest.Mock).mockResolvedValue("203.0.113.11");

    mockedFrom.mockReturnValue({
      select: mockSelect,
    });

    mockSingle.mockResolvedValue({
      data: {
        id: "inst_123",
        gateway_url: "https://agent.example.com",
        status: "running",
        api_server_key_encrypted: "encrypted-key",
      },
      error: null,
    });
  });

  it("uses the shared gateway probe helper for GET requests", async () => {
    mockedFetchFirstReachableGatewayResponse
      .mockResolvedValueOnce({
        url: "https://agent.example.com/web-api/",
        response: new Response(
          '<!doctype html><html><head><script>window.__HERMES_SESSION_TOKEN__="upstream-session-token";</script></head></html>',
          {
            status: 200,
            headers: { "Content-Type": "text/html" },
          }
        ),
      })
      .mockResolvedValueOnce({
        url: "http://agent.example.com/web-api/api/sessions",
        response: new Response(JSON.stringify({ sessions: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      });

    const api = await agentWebApi("inst_123", "user_123");
    const response = await api.get("/api/sessions", { timeout: 9_000 });

    expect(fetchFirstReachableGatewayResponse).toHaveBeenNthCalledWith(1, {
      baseUrl: "https://agent.example.com/web-api",
      pathname: "/",
      instanceIpv4: "203.0.113.11",
      method: "GET",
      headers: expect.objectContaining({
        Accept: "text/html",
        Connection: "close",
        "X-Hermes-Timestamp": expect.any(String),
        "X-Hermes-Signature": expect.any(String),
      }),
      timeoutMs: 15_000,
    });
    expect(fetchFirstReachableGatewayResponse).toHaveBeenNthCalledWith(2, {
      baseUrl: "https://agent.example.com/web-api",
      pathname: "/api/sessions",
      instanceIpv4: "203.0.113.11",
      method: "GET",
      headers: expect.objectContaining({
        Accept: "application/json",
        Connection: "close",
        Authorization: "Bearer upstream-session-token",
        "X-Hermes-Timestamp": expect.any(String),
        "X-Hermes-Signature": expect.any(String),
      }),
      timeoutMs: 9_000,
    });
    expect(decryptApiKey).toHaveBeenCalledWith("encrypted-key");
    expect(response.status).toBe(200);
  });
});
