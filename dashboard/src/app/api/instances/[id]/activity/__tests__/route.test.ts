import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { GET } from "../route";
import { getSecureUserInstance } from "@/lib/services/instance-security";
import { resolveWebUIInstanceClient } from "@/lib/webui/instance";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));

jest.mock("@/lib/services/instance-security", () => ({
  getSecureUserInstance: jest.fn(),
}));

jest.mock("@/lib/webui/instance", () => ({
  resolveWebUIInstanceClient: jest.fn(),
}));

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

describe("GET /api/instances/[id]/activity", () => {
  const mockedAuth = auth as jest.MockedFunction<typeof auth>;
  const mockedGetSecureUserInstance = getSecureUserInstance as jest.MockedFunction<typeof getSecureUserInstance>;
  const mockedResolveWebUIInstanceClient = resolveWebUIInstanceClient as jest.MockedFunction<typeof resolveWebUIInstanceClient>;
  const client = {
    status: jest.fn(),
    // Legacy hermes-webui method the fleet image does not serve. Kept on the
    // mock only to assert it is NEVER called (see the regression guard below).
    health: jest.fn(),
    listSessions: jest.fn(),
    pendingApproval: jest.fn(),
    pendingClarify: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockedAuth.mockResolvedValue({ userId: "user-123" } as Awaited<ReturnType<typeof auth>>);
    mockedGetSecureUserInstance.mockResolvedValue({
      instance: {
        id: "inst-123",
        name: "Atlas",
        status: "running",
        backend: "webui",
        gateway_url: "https://webui.example.com",
        api_server_key_encrypted: "encrypted",
        user_id: "user-123",
      },
      error: null,
      apiServerKey: "api-key",
      instanceIpv4: "203.0.113.10",
    });
    mockedResolveWebUIInstanceClient.mockResolvedValue({
      ok: true,
      baseUrl: "https://webui.example.com",
      client: client as unknown as Awaited<ReturnType<typeof resolveWebUIInstanceClient>> extends { ok: true; client: infer T } ? T : never,
    });
    // /api/status is the real, registered agent route. active_agents > 0 is the
    // "responding" signal (maps to the digest's active_streams).
    client.status.mockResolvedValue({ gateway_state: "running", active_agents: 1, active_sessions: 1 });
    client.listSessions.mockResolvedValue([
      {
        session_id: "sess-1",
        title: "Research",
        updated_at: 1_778_900_000,
        message_count: 4,
        model: "glm-5.1",
        estimated_cost: 0.002,
      },
    ]);
    client.pendingApproval.mockResolvedValue(null);
    client.pendingClarify.mockResolvedValue(null);
  });

  // Regression guard. The agent image serves no /api/approval/* or /api/clarify/*
  // route: those requests fall through its GET-only SPA catch-all and 404. The
  // digest used to fire two doomed round-trips per poll and swallow both.
  // Approvals reach the user as push events on the workspace iframe's /api/ws
  // socket, so there is nothing for this route to read. Never call these again.
  it("never probes the nonexistent approval/clarify endpoints", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123/activity"),
      { params: Promise.resolve({ id: "inst-123" }) },
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.state).toBe("responding");
    expect(json.data.headline).toBe("Responding now");
    expect(client.pendingApproval).not.toHaveBeenCalled();
    expect(client.pendingClarify).not.toHaveBeenCalled();
    // Regression guard: the digest must read /api/status, never the legacy
    // hermes-webui /health JSON endpoint. On the fleet image /health returns
    // the SPA HTML shell, so health() throws "response was not JSON" and every
    // running agent falsely reported degraded. Never call health() again.
    expect(client.status).toHaveBeenCalledTimes(1);
    expect(client.health).not.toHaveBeenCalled();
  });

  it("does not resolve WebUI for stopped instances", async () => {
    mockedGetSecureUserInstance.mockResolvedValueOnce({
      instance: {
        id: "inst-123",
        name: "Atlas",
        status: "stopped",
        backend: "webui",
        gateway_url: "https://webui.example.com",
        api_server_key_encrypted: "encrypted",
        user_id: "user-123",
      },
      error: null,
      apiServerKey: "api-key",
      instanceIpv4: "203.0.113.10",
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123/activity"),
      { params: Promise.resolve({ id: "inst-123" }) },
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.state).toBe("not_running");
    expect(json.data.headline).toBe("Agent is stopped");
    expect(mockedResolveWebUIInstanceClient).not.toHaveBeenCalled();
  });

  it("stays calm without leaking raw upstream errors when the runtime can't be read", async () => {
    client.status.mockRejectedValueOnce(new Error("raw prompt-secret upstream body"));

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123/activity"),
      { params: Promise.resolve({ id: "inst-123" }) },
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    // De-alarmed: a runtime that can't be read shows a calm idle state, not an
    // alarming "WebUI is unreachable" (WebUI is retired), and never leaks raw errors.
    expect(json.data.state).toBe("idle");
    expect(json.data.headline).toBe("Ready when you are");
    expect(JSON.stringify(json)).not.toContain("prompt-secret");
    expect(JSON.stringify(json)).not.toMatch(/WebUI/i);
  });

  it("rejects unauthenticated requests", async () => {
    mockedAuth.mockResolvedValueOnce({ userId: null } as Awaited<ReturnType<typeof auth>>);

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123/activity"),
      { params: Promise.resolve({ id: "inst-123" }) },
    );
    const json = await response.json();

    expect(response.status).toBe(401);
    expect(json.error).toBe("Unauthorized");
    expect(mockedGetSecureUserInstance).not.toHaveBeenCalled();
  });
});
