import { NextRequest } from "next/server";

import { POST } from "../route";
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

describe("POST /api/instances/[id]/oauth/providers/[provider]/start", () => {
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

  it("starts the WebUI Nous Portal device-code flow for a gateway (webfree) backend", async () => {
    // Post-collapse: a "gateway" backend is webfree (isWebfreeBackend), so it
    // routes through the WebUI SSH path identically to a "webui" backend — the
    // legacy agentWebApi upstream path is dormant and never reached.
    mockedSshExec.mockResolvedValue({
      ok: true,
      stdout: JSON.stringify({
        session_id: "sess-123",
        flow: "device_code",
        user_code: "ABCD-EFGH",
        verification_url: "https://portal.nousresearch.com/device",
        poll_interval: 5,
      }),
      stderr: "",
      error: "",
    });

    const response = await POST(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/providers/nous/start", { method: "POST" }),
      { params: Promise.resolve({ id: "inst-123", provider: "nous" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(mockedSshExec).toHaveBeenCalled();
    expect(mockedAgentWebApi).not.toHaveBeenCalled();
    expect(json.data.session_id).toBe("sess-123");
    expect(json.data.user_code).toBe("ABCD-EFGH");
    expect(json.data.runtime).toBe("webui");
  });

  it("surfaces WebUI login start errors for a gateway (webfree) backend", async () => {
    mockedSshExec.mockResolvedValue({
      ok: false,
      stdout: JSON.stringify({
        status: "error",
        error_message: "Provider not enabled",
      }),
      stderr: "",
      error: "",
    });

    const response = await POST(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/providers/nous/start", { method: "POST" }),
      { params: Promise.resolve({ id: "inst-123", provider: "nous" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(502);
    expect(json.error).toBe("Provider not enabled");
  });

  it("does not expose unexpected login start failures to the client or logs", async () => {
    mockedSshExec.mockRejectedValue(new Error("provider-start-secret"));

    const response = await POST(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/providers/nous/start", { method: "POST" }),
      { params: Promise.resolve({ id: "inst-123", provider: "nous" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error).toBe("Internal Server Error");
    expect(JSON.stringify(json)).not.toContain("provider-start-secret");
    expect(getConsoleOutput()).not.toContain("provider-start-secret");
  });

  it("surfaces structured WebUI Nous start command errors with redaction", async () => {
    mockedGetInstanceBackend.mockResolvedValue("webui");
    mockedSshExec.mockResolvedValue({
      ok: false,
      stdout: JSON.stringify({
        status: "error",
        error_message: "Portal returned 503 with refresh_token=oauth-secret",
      }),
      stderr: "",
      error: "",
    });

    const response = await POST(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/providers/nous/start", { method: "POST" }),
      { params: Promise.resolve({ id: "inst-123", provider: "nous" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(502);
    expect(json.error).toBe("Portal returned 503 with refresh_token=[REDACTED]");
    expect(JSON.stringify(json)).not.toContain("oauth-secret");
    expect(getConsoleOutput()).not.toContain("oauth-secret");
  });

  it("reports missing WebUI OAuth runtime helpers as an update/restart problem", async () => {
    mockedGetInstanceBackend.mockResolvedValue("webui");
    mockedSshExec.mockResolvedValue({
      ok: false,
      stdout: JSON.stringify({
        status: "error",
        error_message: "cannot import name '_request_device_code' from 'hermes_cli.auth'",
      }),
      stderr: "",
      error: "",
    });

    const response = await POST(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/providers/nous/start", { method: "POST" }),
      { params: Promise.resolve({ id: "inst-123", provider: "nous" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(503);
    expect(json.error).toBe(
      "Nous Portal auth support is unavailable in this Hermes runtime. Update or restart the instance, then try again."
    );
  });

  it("reports SSH warm-up instead of hiding it behind the generic Nous start failure", async () => {
    mockedGetInstanceBackend.mockResolvedValue("webui");
    mockedSshExec.mockResolvedValue({
      ok: false,
      stdout: "",
      stderr: "",
      error: "SSH connection error: connect ETIMEDOUT 203.0.113.10:22",
    });

    const response = await POST(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/providers/nous/start", { method: "POST" }),
      { params: Promise.resolve({ id: "inst-123", provider: "nous" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(409);
    expect(json.error).toBe("Instance is still provisioning SSH access. Try again in a moment.");
  });
});
