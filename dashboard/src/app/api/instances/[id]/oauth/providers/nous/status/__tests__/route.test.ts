import { NextRequest } from "next/server";

import { GET } from "../route";
import { validateConsoleAccess } from "@/lib/services/console-helpers";
import { sshExec } from "@/lib/hetzner/ssh";
import {
  loadUserNousVaultBundle,
  readCachedNousVaultBundle,
} from "@/lib/services/nous-runtime-auth";
import { supabaseAdmin } from "@/lib/supabase";
import { apiError } from "@/lib/api-response";

jest.mock("@/lib/services/console-helpers", () => ({
  validateConsoleAccess: jest.fn(),
}));

jest.mock("@/lib/hetzner/ssh", () => ({
  sshExec: jest.fn(),
}));

jest.mock("@/lib/services/nous-runtime-auth", () => ({
  loadUserNousVaultBundle: jest.fn(),
  readCachedNousVaultBundle: jest.fn(),
}));

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/api-response", () => {
  const actual = jest.requireActual("@/lib/api-response");
  return {
    ...actual,
    apiError: jest.fn(actual.apiError),
  };
});

describe("GET /api/instances/[id]/oauth/providers/nous/status", () => {
  const mockedValidateConsoleAccess = validateConsoleAccess as jest.MockedFunction<typeof validateConsoleAccess>;
  const mockedSshExec = sshExec as jest.MockedFunction<typeof sshExec>;
  const mockedLoadUserNousVaultBundle = loadUserNousVaultBundle as jest.MockedFunction<typeof loadUserNousVaultBundle>;
  const mockedReadCachedNousVaultBundle = readCachedNousVaultBundle as jest.MockedFunction<typeof readCachedNousVaultBundle>;
  const mockedSupabaseFrom = supabaseAdmin!.from as jest.Mock;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    process.env.ENCRYPTION_KEY = "a".repeat(64);
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
    });
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

  it("persists a freshly approved Nous session into Vault and returns its status", async () => {
    mockedSshExec.mockResolvedValue({
      ok: true,
      stdout: JSON.stringify({
        authenticated: true,
        source: "hermes-auth-store",
        vaultBundle: {
          portalBaseUrl: "https://portal.nousresearch.com",
          inferenceBaseUrl: "https://inference-api.nousresearch.com/v1",
          clientId: "hermes-cli",
          accessToken: "access-token",
          refreshToken: "refresh-token",
          agentKey: "agent-key",
          source: "hermes-auth-store",
        },
      }),
      stderr: "",
      error: undefined,
    });

    const maybeSingle = jest.fn().mockResolvedValue({ data: null, error: null });
    const insertSingle = jest.fn().mockResolvedValue({ data: { id: "vault-nous-1" }, error: null });
    const insert = jest.fn(() => ({
      select: jest.fn(() => ({
        single: insertSingle,
      })),
    }));

    const instanceUpdateEqProvider = jest.fn().mockResolvedValue({ error: null });
    const instanceUpdateEqUser = jest.fn(() => ({
      eq: instanceUpdateEqProvider,
    }));
    const instanceUpdateEqId = jest.fn(() => ({
      eq: instanceUpdateEqUser,
    }));
    const instanceUpdate = jest.fn(() => ({
      eq: instanceUpdateEqId,
    }));

    mockedSupabaseFrom.mockImplementation((table: string) => {
      if (table === "user_api_keys") {
        return {
          select: jest.fn(() => ({
            eq: jest.fn(() => ({
              eq: jest.fn(() => ({
                eq: jest.fn(() => ({
                  maybeSingle,
                })),
              })),
            })),
          })),
          update: jest.fn(),
          insert,
        };
      }

      if (table === "hermes_instances") {
        return {
          update: instanceUpdate,
        };
      }

      throw new Error(`Unexpected table ${table}`);
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/providers/nous/status"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.authenticated).toBe(true);
    expect(json.data.vaultKeyId).toBe("vault-nous-1");
    expect(insertSingle).toHaveBeenCalled();
    expect(instanceUpdate).toHaveBeenCalled();
  });

  it("falls back to the stored Vault session when the live auth read fails", async () => {
    mockedSshExec.mockResolvedValue({
      ok: false,
      stdout: "",
      stderr: "container unavailable",
      error: "container unavailable",
    });
    mockedLoadUserNousVaultBundle.mockResolvedValue({
      bundle: {
        portalBaseUrl: "https://portal.nousresearch.com",
        inferenceBaseUrl: "https://inference-api.nousresearch.com/v1",
        clientId: "hermes-cli",
        accessToken: "vault-access",
        refreshToken: "vault-refresh",
        source: "stored-vault",
      },
      encryptedKey: "encrypted",
      vaultKeyId: "vault-existing",
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/providers/nous/status"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.authenticated).toBe(true);
    expect(json.data.source).toBe("stored-vault");
    expect(json.data.vaultKeyId).toBe("vault-existing");
  });

  it("reports a non-success error (not optimistic success) when Vault save fails", async () => {
    delete process.env.ENCRYPTION_KEY;
    mockedSshExec.mockResolvedValue({
      ok: true,
      stdout: JSON.stringify({
        authenticated: true,
        source: "hermes-auth-store",
        vaultBundle: {
          portalBaseUrl: "https://portal.nousresearch.com",
          inferenceBaseUrl: "https://inference-api.nousresearch.com/v1",
          clientId: "hermes-cli",
          accessToken: "access-token",
          refreshToken: "refresh-token",
          agentKey: "agent-key",
          source: "hermes-auth-store",
        },
      }),
      stderr: "",
      error: undefined,
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/providers/nous/status"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    // Persistence threw — the route must NOT claim success, or a consumer
    // reading only `success`/`authenticated` would believe the credential
    // was stored when it was not.
    expect(response.status).toBe(502);
    expect(json.success).toBe(false);
    expect(json.persisted).toBe(false);
    expect(json.error).toBe(
      "Unable to save the reusable Vault session. Please try again or contact support."
    );
    // The live read still succeeded, so we report that honestly alongside the failure.
    expect(json.authenticated).toBe(true);
  });

  it("does not leak raw upstream errors when the live auth read fails", async () => {
    mockedSshExec.mockResolvedValue({
      ok: false,
      stdout: "",
      stderr: "refresh_token=super-secret",
      error: undefined,
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/providers/nous/status"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error).toBe("Failed to read Nous Portal auth state.");
    expect(JSON.stringify(json)).not.toContain("super-secret");
    expect(consoleErrorSpy.mock.calls.flat().join(" ")).not.toContain("super-secret");
    expect(apiError).toHaveBeenCalledWith(
      "Failed to read Nous Portal auth state.",
      500,
      expect.objectContaining({
        failureType: "nous_status_command_failed",
        stderrPresent: true,
        errorPresent: false,
        stdoutPresent: false,
      }),
      undefined,
      expect.objectContaining({
        source: "nous-oauth-status",
        route: "/api/instances/[id]/oauth/providers/nous/status",
      })
    );
  });

  it("does not leak unreadable live auth payloads", async () => {
    mockedSshExec.mockResolvedValue({
      ok: true,
      stdout: "refresh_token=super-secret",
      stderr: "",
      error: undefined,
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/providers/nous/status"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error).toBe("Failed to read Nous Portal auth state.");
    expect(JSON.stringify(json)).not.toContain("super-secret");
    expect(consoleErrorSpy.mock.calls.flat().join(" ")).not.toContain("super-secret");
    expect(apiError).toHaveBeenCalledWith(
      "Failed to read Nous Portal auth state.",
      500,
      expect.objectContaining({
        failureType: "nous_status_unexpected_error",
        errorName: "Error",
      }),
      undefined,
      expect.objectContaining({
        source: "nous-oauth-status",
        route: "/api/instances/[id]/oauth/providers/nous/status",
      })
    );
  });
});
