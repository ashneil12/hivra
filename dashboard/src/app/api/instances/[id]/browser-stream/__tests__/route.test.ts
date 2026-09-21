import { NextRequest } from "next/server";
import { GET } from "../route";
import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";
import { resolveInstanceIpv4 } from "@/lib/instance-resolvers";
import { decryptApiKey } from "@/lib/crypto";
import { reportOpsEvent } from "@/lib/ops-events";
import { isProTierUser } from "@/lib/billing/pro-tier";

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

jest.mock("@/lib/ops-events", () => ({
  reportOpsEvent: jest.fn(),
}));

jest.mock("@/lib/billing/pro-tier", () => ({
  isProTierUser: jest.fn(),
}));

describe("GET /api/instances/[id]/browser-stream", () => {
  const mockAuth = auth as jest.MockedFunction<typeof auth>;
  const mockFrom = supabaseAdmin!.from as jest.Mock;
  const mockResolveIpv4 = resolveInstanceIpv4 as jest.MockedFunction<typeof resolveInstanceIpv4>;
  const mockDecryptApiKey = decryptApiKey as jest.MockedFunction<typeof decryptApiKey>;
  const mockReportOpsEvent = reportOpsEvent as jest.MockedFunction<typeof reportOpsEvent>;
  const mockIsProTierUser = isProTierUser as jest.MockedFunction<typeof isProTierUser>;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    mockAuth.mockResolvedValue({ userId: "user_123" } as Awaited<ReturnType<typeof auth>>);
    mockIsProTierUser.mockResolvedValue({ ok: true, tier: "operator" } as Awaited<ReturnType<typeof isProTierUser>>);
    mockResolveIpv4.mockResolvedValue("203.0.113.10");
    mockDecryptApiKey.mockReturnValue("raw-api-server-key");

    const query = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      neq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: {
          id: "inst_123",
          user_id: "user_123",
          status: "running",
          gateway_url: "https://agent.example.com",
          api_server_key_encrypted: "encrypted",
          config: {
            agentSettings: {
              browserSidecarEnabled: false,
            },
          },
        },
      }),
    };

    mockFrom.mockReturnValue(query);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("redirects to the instance noVNC viewer when the sidecar is enabled", async () => {
    const queryWithSidecar = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      neq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: {
          id: "inst_456",
          user_id: "user_123",
          status: "running",
          gateway_url: "https://agent.example.com",
          api_server_key_encrypted: "encrypted",
          config: {
            agentSettings: {
              browserSidecarEnabled: true,
            },
          },
        },
      }),
    };
    mockFrom.mockReturnValue(queryWithSidecar);

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst_456/browser-stream", { method: "GET" }),
      { params: Promise.resolve({ id: "inst_456" }) }
    );

    // Same-origin redirect to the instance's own noVNC app (the proven box
    // mechanism) — not a cross-origin custom viewer (the dashboard CSP blocks
    // importing rfb.js from the instance domain).
    expect(response.status).toBe(302);
    const loc = response.headers.get("location") || "";
    expect(loc).toContain("https://agent.example.com/vnc/vnc.html");
    expect(loc).toContain("path=vnc/websockify");
    expect(loc).toContain("autoconnect=true");
    expect(loc).toContain("password=");
    // Must not embed the raw signing secret, nor route via the old signed path.
    expect(loc).not.toContain("raw-api-server-key");
    expect(loc).not.toContain("/browser-sidecar/novnc");
  });

  it("auto-detects a running sidecar via /browser-sidecar/novnc/core/rfb.js probe and serves the viewer even when the DB flag is false", async () => {
    const queryFlagFalse = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      neq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: {
          id: "inst_789",
          user_id: "user_123",
          status: "running",
          gateway_url: "https://agent.example.com",
          api_server_key_encrypted: "encrypted",
          config: {
            agentSettings: {
              // flag is FALSE — covers manual-provisioning + flag-drift cases
              browserSidecarEnabled: false,
            },
          },
        },
      }),
    };
    mockFrom.mockReturnValue(queryFlagFalse);

    // Mock the probe HEAD request to succeed (sidecar exists at runtime).
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(
      new Response(null, { status: 200 }) as unknown as Response
    );

    try {
      const response = await GET(
        new NextRequest("http://localhost/api/instances/inst_789/browser-stream", { method: "GET" }),
        { params: Promise.resolve({ id: "inst_789" }) }
      );

      // Probe should have been HEAD'd at the same-origin /vnc/ noVNC asset.
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringMatching(/\/vnc\/core\/rfb\.js$/),
        expect.objectContaining({ method: "HEAD" }),
      );
      // Sidecar viewer (redirect) must be served despite flag=false.
      expect(response.status).toBe(302);
      expect(response.headers.get("location") || "").toContain("/vnc/vnc.html");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("returns 404 when the sidecar is disabled and no running sidecar is detected", async () => {
    const queryNoSidecar = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      neq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: {
          id: "inst_999",
          user_id: "user_123",
          status: "running",
          gateway_url: "https://agent.example.com",
          api_server_key_encrypted: "encrypted",
          config: {
            agentSettings: { browserSidecarEnabled: false },
          },
        },
      }),
    };
    mockFrom.mockReturnValue(queryNoSidecar);

    // Probe fails → no sidecar. The legacy camofox/VNC HTML pages are gone, so
    // the route reports "no browser stream" rather than serving a viewer.
    const fetchSpy = jest.spyOn(global, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    try {
      const response = await GET(
        new NextRequest("http://localhost/api/instances/inst_999/browser-stream", { method: "GET" }),
        { params: Promise.resolve({ id: "inst_999" }) }
      );
      expect(response.status).toBe(404);
      expect(await response.text()).toContain("No browser stream available");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("returns 403 for a non-Pro user even when the sidecar is enabled", async () => {
    mockIsProTierUser.mockResolvedValue({ ok: false, tier: null } as Awaited<ReturnType<typeof isProTierUser>>);
    const queryWithSidecar = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      neq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: {
          id: "inst_456",
          user_id: "user_123",
          status: "running",
          gateway_url: "https://agent.example.com",
          api_server_key_encrypted: "encrypted",
          config: { agentSettings: { browserSidecarEnabled: true } },
        },
      }),
    };
    mockFrom.mockReturnValue(queryWithSidecar);

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst_456/browser-stream", { method: "GET" }),
      { params: Promise.resolve({ id: "inst_456" }) }
    );

    expect(response.status).toBe(403);
  });

  it("does not log raw unexpected browser stream failures", async () => {
    mockAuth.mockRejectedValueOnce(new Error("browser-stream-secret-leak"));

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst_123/browser-stream", { method: "GET" }),
      { params: Promise.resolve({ id: "inst_123" }) }
    );

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Internal Server Error");
    expect(JSON.stringify(mockReportOpsEvent.mock.calls)).not.toContain("browser-stream-secret-leak");
    expect(mockReportOpsEvent).toHaveBeenCalledWith(expect.objectContaining({
      message: "Browser stream failed",
      metadata: expect.objectContaining({
        failureType: "browser_stream_failed",
        errorName: "Error",
      }),
    }));
  });
});
