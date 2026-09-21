import { NextRequest } from "next/server";

import { GET } from "../route";
import { auth } from "@clerk/nextjs/server";
import { agentWebApi } from "@/lib/agent-web-api";
import { sshExec } from "@/lib/hetzner/ssh";
import { getInstanceBackend } from "@/lib/instance-backend";
import { validateConsoleAccess } from "@/lib/services/console-helpers";
import {
  loadUserNousVaultBundle,
  readCachedNousVaultBundle,
} from "@/lib/services/nous-runtime-auth";
import { apiError } from "@/lib/api-response";

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

jest.mock("@/lib/services/nous-runtime-auth", () => ({
  loadUserNousVaultBundle: jest.fn(),
  readCachedNousVaultBundle: jest.fn(),
}));

describe("GET /api/instances/[id]/oauth/providers", () => {
  const mockedAuth = auth as jest.MockedFunction<typeof auth>;
  const mockedAgentWebApi = agentWebApi as jest.MockedFunction<typeof agentWebApi>;
  const mockedSshExec = sshExec as jest.MockedFunction<typeof sshExec>;
  const mockedGetInstanceBackend = getInstanceBackend as jest.MockedFunction<typeof getInstanceBackend>;
  const mockedValidateConsoleAccess = validateConsoleAccess as jest.MockedFunction<typeof validateConsoleAccess>;
  const mockedLoadUserNousVaultBundle = loadUserNousVaultBundle as jest.MockedFunction<typeof loadUserNousVaultBundle>;
  const mockedReadCachedNousVaultBundle = readCachedNousVaultBundle as jest.MockedFunction<typeof readCachedNousVaultBundle>;
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
    // Post-collapse: a "gateway" backend is webfree (isWebfreeBackend), so the
    // provider catalog is served by the WebUI SSH path identically to a "webui"
    // backend. The legacy agentWebApi upstream catalog is dormant.
    mockedGetInstanceBackend.mockResolvedValue("gateway");
    mockedValidateConsoleAccess.mockResolvedValue({
      id: "inst-123",
      userId: "user_123",
      hostIp: "203.0.113.10",
      instance: {
        id: "inst-123",
        user_id: "user_123",
        provider: "nous",
        api_key_encrypted: null,
        config: {},
      },
      errorResponse: null,
    } as Awaited<ReturnType<typeof validateConsoleAccess>>);
    mockedReadCachedNousVaultBundle.mockReturnValue(null);
    mockedLoadUserNousVaultBundle.mockResolvedValue({
      bundle: null,
      encryptedKey: null,
      vaultKeyId: null,
    });
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  const getConsoleOutput = () => JSON.stringify(consoleErrorSpy.mock.calls);

  it("serves the WebUI Nous provider catalog for a gateway (webfree) backend", async () => {
    mockedSshExec.mockResolvedValue({
      ok: true,
      stdout: JSON.stringify({
        authenticated: true,
        source: "hermes-auth-store",
      }),
      stderr: "",
      error: "",
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/providers"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(mockedGetInstanceBackend).toHaveBeenCalledWith("inst-123", "user_123");
    expect(mockedAgentWebApi).not.toHaveBeenCalled();
    expect(json).toEqual({
      success: true,
      data: {
        runtime: "webui",
        providers: [
          {
            id: "nous",
            name: "Nous Portal",
            flow: "device_code",
            cli_command: "hermes auth add nous",
            docs_url: "https://portal.nousresearch.com",
            status: {
              logged_in: true,
              source: "hermes-auth-store",
              source_label: "Agent runtime",
              has_refresh_token: false,
              runtime: "webui",
            },
          },
        ],
      },
    });
  });

  it("serves the same WebUI catalog for a webui backend", async () => {
    mockedGetInstanceBackend.mockResolvedValue("webui");
    mockedSshExec.mockResolvedValue({
      ok: true,
      stdout: JSON.stringify({
        authenticated: true,
        source: "hermes-auth-store",
      }),
      stderr: "",
      error: "",
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/providers"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(mockedAgentWebApi).not.toHaveBeenCalled();
    expect(json.data.runtime).toBe("webui");
    expect(json.data.providers[0].id).toBe("nous");
    expect(json.data.providers[0].status.logged_in).toBe(true);
  });

  it("returns 401 when the user is not authenticated", async () => {
    mockedAuth.mockResolvedValue({ userId: null } as Awaited<ReturnType<typeof auth>>);

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/providers"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(401);
    expect(mockedGetInstanceBackend).not.toHaveBeenCalled();
    expect(mockedAgentWebApi).not.toHaveBeenCalled();
    expect(json.error).toBe("Unauthorized");
  });

  it("surfaces console access errors from the WebUI catalog path", async () => {
    mockedValidateConsoleAccess.mockResolvedValue({
      errorResponse: apiError("Instance offline or unknown IP", 404),
    } as Awaited<ReturnType<typeof validateConsoleAccess>>);

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/providers"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(404);
    expect(mockedAgentWebApi).not.toHaveBeenCalled();
    expect(json.error).toBe("Instance offline or unknown IP");
  });

  // REGRESSION GUARD (gateway≡webfree collapse): the webfree branch is
  // `return await webUIProviderCatalog(id)` (route.ts:120). The `await` is
  // load-bearing — without it a rejection from validateConsoleAccess would escape
  // GET's try/catch instead of being redacted to a 500. This test goes RED if the
  // await is ever dropped (the un-awaited form the collapse originally shipped).
  it("does not expose unexpected provider catalog failures to the client or logs", async () => {
    mockedValidateConsoleAccess.mockRejectedValue(new Error("provider-catalog-secret"));

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/providers"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error).toBe("Internal Server Error");
    expect(JSON.stringify(json)).not.toContain("provider-catalog-secret");
    expect(getConsoleOutput()).not.toContain("provider-catalog-secret");
  });

  // REGRESSION GUARD (gateway≡webfree collapse): with the load-bearing `await` at
  // route.ts:120, a timeout raised while resolving console access is caught by
  // GET's catch and mapped to the degraded-catalog fallback. Goes RED if the
  // await is dropped (the rejection would then bypass the catch).
  it("returns a degraded catalog when the WebUI provider catalog times out", async () => {
    const timeoutError = new Error("The operation was aborted due to timeout");
    timeoutError.name = "TimeoutError";
    mockedValidateConsoleAccess.mockRejectedValue(timeoutError);

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/providers"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual({
      success: true,
      data: {
        degraded: true,
        providers: [
          {
            id: "nous",
            name: "Nous Portal",
            flow: "device_code",
            status: {
              logged_in: false,
              unavailable: true,
              reason: "timeout",
            },
          },
        ],
      },
    });
    expect(getConsoleOutput()).not.toContain("aborted due to timeout");
  });
});
