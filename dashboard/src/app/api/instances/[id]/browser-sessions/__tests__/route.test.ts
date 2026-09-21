import { NextRequest } from "next/server";
import { GET } from "../route";
import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";
import { resolveInstanceIpv4 } from "@/lib/instance-resolvers";
import { decryptApiKey } from "@/lib/crypto";
import { fetchFirstReachableGatewayResponse } from "@/lib/agent-gateway";
import { reportOpsEvent } from "@/lib/ops-events";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/instance-resolvers", () => ({
  resolveInstanceIpv4: jest.fn(),
}));

jest.mock("@/lib/crypto", () => ({
  decryptApiKey: jest.fn(),
}));

jest.mock("@/lib/agent-gateway", () => ({
  fetchFirstReachableGatewayResponse: jest.fn(),
}));

jest.mock("@/lib/ops-events", () => ({
  reportOpsEvent: jest.fn(),
}));

describe("GET /api/instances/[id]/browser-sessions", () => {
  const mockAuth = auth as jest.MockedFunction<typeof auth>;
  const mockFrom = supabaseAdmin!.from as jest.Mock;
  const mockResolveIpv4 = resolveInstanceIpv4 as jest.MockedFunction<typeof resolveInstanceIpv4>;
  const mockDecryptApiKey = decryptApiKey as jest.MockedFunction<typeof decryptApiKey>;
  const mockFetchGateway = fetchFirstReachableGatewayResponse as jest.MockedFunction<typeof fetchFirstReachableGatewayResponse>;
  const mockReportOpsEvent = reportOpsEvent as jest.MockedFunction<typeof reportOpsEvent>;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    mockAuth.mockResolvedValue({ userId: "user_123" } as Awaited<ReturnType<typeof auth>>);
    mockResolveIpv4.mockResolvedValue("203.0.113.10");
    mockDecryptApiKey.mockReturnValue("raw-api-server-key");
    mockFetchGateway.mockResolvedValue({
      url: "https://203-0-113-10.sslip.io/vnc/core/rfb.js",
      response: new Response("rfb-js-bundle", { status: 200 }),
    });

    const query = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      neq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: {
          id: "inst_123",
          user_id: "user_123",
          status: "running",
          gateway_url: "http://203.0.113.10",
          api_server_key_encrypted: "encrypted",
        },
      }),
    };

    mockFrom.mockReturnValue(query);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("probes the browser sidecar noVNC asset through the primary gateway path instead of a public side port", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst_123/browser-sessions", { method: "GET" }),
      { params: Promise.resolve({ id: "inst_123" }) }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mockFetchGateway).toHaveBeenCalledWith({
      baseUrl: "https://203-0-113-10.sslip.io",
      pathname: "/vnc/core/rfb.js",
      instanceIpv4: "203.0.113.10",
      headers: { Authorization: "Bearer raw-api-server-key" },
      timeoutMs: 5000,
    });
  });

  it("returns 503 when the sidecar noVNC asset is not reachable yet", async () => {
    mockFetchGateway.mockResolvedValueOnce({
      url: "https://203-0-113-10.sslip.io/vnc/core/rfb.js",
      response: new Response("not found", { status: 404 }),
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst_123/browser-sessions", { method: "GET" }),
      { params: Promise.resolve({ id: "inst_123" }) }
    );

    expect(response.status).toBe(503);
    expect(await response.text()).toBe("Browser sidecar not ready");
    expect(mockReportOpsEvent).not.toHaveBeenCalled();
  });

  it("does not log raw unexpected browser probe failures", async () => {
    mockAuth.mockRejectedValueOnce(new Error("browser-session-secret-leak"));

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst_123/browser-sessions", { method: "GET" }),
      { params: Promise.resolve({ id: "inst_123" }) }
    );

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Internal Server Error");
    expect(JSON.stringify(mockReportOpsEvent.mock.calls)).not.toContain("browser-session-secret-leak");
    expect(mockReportOpsEvent).toHaveBeenCalledWith(expect.objectContaining({
      message: "Browser session probe failed",
      metadata: expect.objectContaining({
        failureType: "browser_session_probe_failed",
        errorName: "Error",
      }),
    }));
  });
});
