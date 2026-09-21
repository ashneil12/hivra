import { NextRequest } from "next/server";

import { GET } from "../route";
import { auth } from "@clerk/nextjs/server";
import { agentWebApi } from "@/lib/agent-web-api";
import { sshExec } from "@/lib/hetzner/ssh";
import { getInstanceBackend } from "@/lib/instance-backend";
import { validateConsoleAccess } from "@/lib/services/console-helpers";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));

jest.mock("@/lib/agent-web-api", () => ({
  agentWebApi: jest.fn(),
}));

jest.mock("@/lib/hetzner/ssh", () => ({
  sshExec: jest.fn(),
}));

jest.mock("@/lib/instance-backend", () => ({
  getInstanceBackend: jest.fn(),
}));

jest.mock("@/lib/services/console-helpers", () => ({
  validateConsoleAccess: jest.fn(),
}));

describe("GET /api/instances/[id]/oauth/providers/[provider]/poll/[sessionId]", () => {
  const mockedAuth = auth as jest.MockedFunction<typeof auth>;
  const mockedAgentWebApi = agentWebApi as jest.MockedFunction<typeof agentWebApi>;
  const mockedGetInstanceBackend = getInstanceBackend as jest.MockedFunction<typeof getInstanceBackend>;
  const mockedValidateConsoleAccess = validateConsoleAccess as jest.MockedFunction<typeof validateConsoleAccess>;
  const mockedSshExec = sshExec as jest.MockedFunction<typeof sshExec>;
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
    mockedAuth.mockResolvedValue({ userId: "user_123" } as Awaited<ReturnType<typeof auth>>);
    mockedAgentWebApi.mockResolvedValue(apiClient);
    mockedGetInstanceBackend.mockResolvedValue("gateway");
    mockedValidateConsoleAccess.mockResolvedValue({
      id: "inst-123",
      userId: "user_123",
      hostIp: "203.0.113.10",
      instance: { id: "inst-123", backend: "webui" },
      errorResponse: null,
    } as Awaited<ReturnType<typeof validateConsoleAccess>>);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  const getConsoleOutput = () => JSON.stringify(consoleErrorSpy.mock.calls);

  it("polls the WebUI Nous Portal device-code session status for a gateway (webfree) backend", async () => {
    // Post-collapse: a "gateway" backend is webfree (isWebfreeBackend), so it
    // routes through the WebUI SSH path identically to a "webui" backend — the
    // legacy agentWebApi upstream path is dormant and never reached.
    mockedSshExec.mockResolvedValue({
      ok: true,
      stdout: JSON.stringify({
        session_id: "sess-123",
        status: "approved",
        expires_at: "2026-04-18T12:00:00Z",
      }),
      stderr: "",
      error: "",
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/providers/nous/poll/sess-123"),
      { params: Promise.resolve({ id: "inst-123", provider: "nous", sessionId: "sess-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(mockedSshExec).toHaveBeenCalled();
    expect(mockedAgentWebApi).not.toHaveBeenCalled();
    expect(json.data.status).toBe("approved");
    expect(json.data.session_id).toBe("sess-123");
    expect(json.data.runtime).toBe("webui");
  });

  it("polls the WebUI Nous Portal session status identically for an explicit webui backend", async () => {
    mockedGetInstanceBackend.mockResolvedValue("webui");
    mockedSshExec.mockResolvedValue({
      ok: true,
      stdout: JSON.stringify({
        session_id: "sess-123",
        status: "approved",
        expires_at: "2026-04-18T12:00:00Z",
      }),
      stderr: "",
      error: "",
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/providers/nous/poll/sess-123"),
      { params: Promise.resolve({ id: "inst-123", provider: "nous", sessionId: "sess-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(mockedSshExec).toHaveBeenCalled();
    expect(mockedAgentWebApi).not.toHaveBeenCalled();
    expect(json.data.status).toBe("approved");
    expect(json.data.runtime).toBe("webui");
  });

  it("surfaces WebUI poll command failures as a generic poll error", async () => {
    mockedSshExec.mockResolvedValue({
      ok: false,
      stdout: JSON.stringify({ status: "error", error_message: "Session expired" }),
      stderr: "",
      error: "",
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/providers/nous/poll/sess-123"),
      { params: Promise.resolve({ id: "inst-123", provider: "nous", sessionId: "sess-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error).toBe("Failed to poll Nous Portal login.");
  });

  it("returns 504 when the WebUI poll command times out", async () => {
    mockedSshExec.mockResolvedValue({
      ok: false,
      stdout: "",
      stderr: "The operation was aborted due to timeout: poll-secret",
      error: "",
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/providers/nous/poll/sess-123"),
      { params: Promise.resolve({ id: "inst-123", provider: "nous", sessionId: "sess-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(504);
    expect(json.error).toBe("The operation timed out while polling provider auth status");
    expect(JSON.stringify(json)).not.toContain("poll-secret");
    expect(getConsoleOutput()).not.toContain("poll-secret");
  });

  it("does not expose unexpected upstream polling failures to the client or logs", async () => {
    mockedSshExec.mockRejectedValue(new Error("unexpected-poll-secret"));

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/providers/nous/poll/sess-123"),
      { params: Promise.resolve({ id: "inst-123", provider: "nous", sessionId: "sess-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error).toBe("Internal Server Error");
    expect(JSON.stringify(json)).not.toContain("unexpected-poll-secret");
    expect(getConsoleOutput()).not.toContain("unexpected-poll-secret");
  });
});
