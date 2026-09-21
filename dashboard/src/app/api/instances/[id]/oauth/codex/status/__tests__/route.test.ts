import { NextRequest } from "next/server";
import { GET } from "../route";
import { validateConsoleAccess } from "@/lib/services/console-helpers";
import { sshExec } from "@/lib/hetzner/ssh";
import { ProfileService } from "@/lib/services/profile-service";
import { supabaseAdmin } from "@/lib/supabase";
import { apiError } from "@/lib/api-response";
import { encryptApiKey } from "@/lib/crypto";
import { serializeCodexVaultBundle } from "@/lib/codex-oauth";

jest.mock("@/lib/services/console-helpers");
jest.mock("@/lib/hetzner/ssh");
jest.mock("@/lib/api-response", () => {
  const actual = jest.requireActual("@/lib/api-response");
  return {
    ...actual,
    apiError: jest.fn(actual.apiError),
  };
});
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;
jest.mock("@/lib/services/profile-service", () => ({
  ProfileService: {
    getProfileProvider: jest.fn(),
    startProfileGateway: jest.fn(),
    stopProfileGateway: jest.fn(),
  },
}));

describe("GET /api/instances/[id]/oauth/codex/status", () => {
  const mockedGetProfileProvider = ProfileService.getProfileProvider as jest.MockedFunction<typeof ProfileService.getProfileProvider>;
  const mockedStartProfileGateway = ProfileService.startProfileGateway as jest.MockedFunction<typeof ProfileService.startProfileGateway>;
  const mockedStopProfileGateway = ProfileService.stopProfileGateway as jest.MockedFunction<typeof ProfileService.stopProfileGateway>;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    (sshExec as jest.Mock).mockReset();
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    process.env.ENCRYPTION_KEY = "a".repeat(64);
    (validateConsoleAccess as jest.Mock).mockResolvedValue({
      id: "inst-123",
      hostIp: "127.0.0.1",
      userId: "user_123",
      instance: {
        id: "inst-123",
        provider: "codex",
        config: {},
      },
    });
    mockedGetProfileProvider.mockResolvedValue(null);
    mockedStartProfileGateway.mockResolvedValue(undefined);
    mockedStopProfileGateway.mockResolvedValue(undefined);
    (supabaseAdmin!.from as jest.Mock).mockReturnValue({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
      update: jest.fn().mockReturnThis(),
      insert: jest.fn().mockReturnThis(),
    });
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("treats a profile-level Codex vault session as authenticated without restarting during passive status polling", async () => {
    (validateConsoleAccess as jest.Mock).mockResolvedValue({
      id: "inst-123",
      hostIp: "127.0.0.1",
      userId: "user_123",
      instance: {
        id: "inst-123",
        provider: "openai",
        config: { hermes_home_dir: "/opt/data" },
      },
    });
    mockedGetProfileProvider.mockResolvedValue("codex");
    (sshExec as jest.Mock)
      .mockResolvedValueOnce({
        ok: false,
        stdout: "",
        stderr: "runtime auth check failed",
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout: '{"changed":true,"synced":1}',
        stderr: "",
      });

    const encryptedVaultBundle = encryptApiKey(serializeCodexVaultBundle({
      accessToken: "access-123",
      refreshToken: "refresh-456",
      lastRefresh: "2026-04-11T12:00:00Z",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    }));

    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "user_api_keys") {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          maybeSingle: jest.fn().mockResolvedValue({
            data: {
              id: "vault-1",
              encrypted_key: encryptedVaultBundle,
            },
            error: null,
          }),
          update: jest.fn().mockReturnThis(),
          insert: jest.fn().mockReturnThis(),
        };
      }

      throw new Error(`Unexpected table ${table}`);
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/codex/status?profile=strategy"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.authenticated).toBe(true);
    expect(json.data.source).toBe("stored-vault");
    expect(json.data.gatewayRestartTriggered).toBe(false);
    expect(json.data.gatewayRestartRequired).toBe(true);
    expect(mockedStopProfileGateway).not.toHaveBeenCalled();
    expect(mockedStartProfileGateway).not.toHaveBeenCalled();
    expect((sshExec as jest.Mock).mock.calls[0][1]).toContain("_save_codex_tokens");
    expect((sshExec as jest.Mock).mock.calls[0][1]).toContain(
      'export HERMES_HOME="/opt/data/profiles/strategy"'
    );
    expect((sshExec as jest.Mock).mock.calls[1][1]).toContain('BASE_HOME="/opt/data/profiles/strategy"');
  });

  it("restarts a profile runtime only when an explicit Codex OAuth apply poll asks for it", async () => {
    (validateConsoleAccess as jest.Mock).mockResolvedValue({
      id: "inst-123",
      hostIp: "127.0.0.1",
      userId: "user_123",
      instance: {
        id: "inst-123",
        provider: "openai",
        config: { hermes_home_dir: "/opt/data" },
      },
    });
    mockedGetProfileProvider.mockResolvedValue("codex");
    (sshExec as jest.Mock)
      .mockResolvedValueOnce({
        ok: false,
        stdout: "",
        stderr: "runtime auth check failed",
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout: '{"changed":true,"synced":1}',
        stderr: "",
      });

    const encryptedVaultBundle = encryptApiKey(serializeCodexVaultBundle({
      accessToken: "access-123",
      refreshToken: "refresh-456",
      lastRefresh: "2026-04-11T12:00:00Z",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    }));

    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "user_api_keys") {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          maybeSingle: jest.fn().mockResolvedValue({
            data: {
              id: "vault-1",
              encrypted_key: encryptedVaultBundle,
            },
            error: null,
          }),
          update: jest.fn().mockReturnThis(),
          insert: jest.fn().mockReturnThis(),
        };
      }

      throw new Error(`Unexpected table ${table}`);
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/codex/status?profile=strategy&apply=1"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.authenticated).toBe(true);
    expect(json.data.source).toBe("stored-vault");
    expect(json.data.gatewayRestartTriggered).toBe(true);
    expect(json.data.gatewayRestartRequired).toBe(false);
    expect(mockedStopProfileGateway).toHaveBeenCalledWith("inst-123", "user_123", "strategy");
    expect(mockedStartProfileGateway).toHaveBeenCalledWith("inst-123", "user_123", "strategy");
  });

  it("syncs a stored Codex OAuth session into the WebUI runtime without restarting during passive status polling", async () => {
    (validateConsoleAccess as jest.Mock).mockResolvedValue({
      id: "inst-123",
      hostIp: "127.0.0.1",
      userId: "user_123",
      instance: {
        id: "inst-123",
        backend: "webui",
        provider: "codex",
        config: {},
      },
    });
    const encryptedVaultBundle = encryptApiKey(serializeCodexVaultBundle({
      accessToken: "access-123",
      refreshToken: "refresh-456",
      lastRefresh: "2026-04-11T12:00:00Z",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    }));

    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "user_api_keys") {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          maybeSingle: jest.fn().mockResolvedValue({
            data: {
              id: "vault-1",
              encrypted_key: encryptedVaultBundle,
            },
            error: null,
          }),
          update: jest.fn().mockReturnThis(),
          insert: jest.fn().mockReturnThis(),
        };
      }

      throw new Error(`Unexpected table ${table}`);
    });
    (sshExec as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        stdout: '{"authenticated":false}',
        stderr: "",
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout: '{"changed":true,"synced":1}',
        stderr: "",
      });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/codex/status"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data).toMatchObject({
      authenticated: true,
      source: "stored-vault",
      runtime: "webui",
      gatewayRestartTriggered: false,
      gatewayRestartRequired: true,
    });
    expect(json.data.vaultKeyId).toBe("vault-1");
    expect((sshExec as jest.Mock).mock.calls[0][1]).toContain('docker exec -u "1024:1024" -i "$AGENT_CONTAINER"');
    expect((sshExec as jest.Mock).mock.calls[0][1]).toContain("for candidate_container in agent-inst-123 agent-inst-123-gateway; do");
    expect((sshExec as jest.Mock).mock.calls[0][1]).toContain('export HERMES_HOME="/home/hermes/.hermes"');
    expect((sshExec as jest.Mock).mock.calls[1][1]).toContain('BASE_HOME="/home/hermes/.hermes"');
    expect(sshExec).toHaveBeenCalledTimes(2);
  });

  it("restarts the WebUI runtime only when an explicit Codex OAuth apply poll asks for it", async () => {
    (validateConsoleAccess as jest.Mock).mockResolvedValue({
      id: "inst-123",
      hostIp: "127.0.0.1",
      userId: "user_123",
      instance: {
        id: "inst-123",
        backend: "webui",
        provider: "codex",
        config: {},
      },
    });
    const encryptedVaultBundle = encryptApiKey(serializeCodexVaultBundle({
      accessToken: "access-123",
      refreshToken: "refresh-456",
      lastRefresh: "2026-04-11T12:00:00Z",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    }));

    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "user_api_keys") {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          maybeSingle: jest.fn().mockResolvedValue({
            data: {
              id: "vault-1",
              encrypted_key: encryptedVaultBundle,
            },
            error: null,
          }),
          update: jest.fn().mockReturnThis(),
          insert: jest.fn().mockReturnThis(),
        };
      }

      throw new Error(`Unexpected table ${table}`);
    });
    (sshExec as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        stdout: '{"authenticated":false}',
        stderr: "",
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout: '{"changed":true,"synced":1}',
        stderr: "",
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout: "",
        stderr: "",
      });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/codex/status?apply=1"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data).toMatchObject({
      authenticated: true,
      source: "stored-vault",
      runtime: "webui",
      gatewayRestartTriggered: true,
      gatewayRestartRequired: false,
    });
    expect((sshExec as jest.Mock).mock.calls[2][1]).toContain("docker restart $RESTART_CONTAINERS");
  });

  it("polls the selected profile home when device auth completes live", async () => {
    (validateConsoleAccess as jest.Mock).mockResolvedValue({
      id: "inst-123",
      hostIp: "127.0.0.1",
      userId: "user_123",
      instance: {
        id: "inst-123",
        provider: "openai",
        config: {},
      },
    });
    mockedGetProfileProvider.mockResolvedValue("codex");
    (sshExec as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        stdout: JSON.stringify({
          authenticated: true,
          source: "device-code",
          vaultBundle: {
            accessToken: "access-123",
            refreshToken: "refresh-456",
            lastRefresh: "2026-04-11T12:00:00Z",
            baseUrl: "https://chatgpt.com/backend-api/codex",
          },
        }),
        stderr: "",
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout: '{"changed":false,"synced":1}',
        stderr: "",
      });

    const maybeSingle = jest.fn().mockResolvedValue({ data: null, error: null });
    const insertSelectSingle = jest.fn().mockResolvedValue({ data: { id: "vault-1" }, error: null });
    const insert = jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        single: insertSelectSingle,
      }),
    });

    (supabaseAdmin!.from as jest.Mock).mockReturnValue({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle,
      insert,
      update: jest.fn().mockReturnThis(),
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/codex/status?profile=strategy&apply=1"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.authenticated).toBe(true);
    expect(json.data.gatewayRestartTriggered).toBe(true);
    expect((sshExec as jest.Mock).mock.calls[0][1]).toContain(
      'export HERMES_HOME="/opt/data/profiles/strategy"'
    );
    expect((sshExec as jest.Mock).mock.calls[1][1]).toContain('BASE_HOME="/opt/data/profiles/strategy"');
    expect(mockedStopProfileGateway).toHaveBeenCalledWith("inst-123", "user_123", "strategy");
    expect(mockedStartProfileGateway).toHaveBeenCalledWith("inst-123", "user_123", "strategy");
  });

  it("rejects invalid profile names before touching SSH or profile helpers", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/codex/status?profile=../../etc/passwd"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error).toBe("Invalid profile name format");
    expect(mockedGetProfileProvider).not.toHaveBeenCalled();
    expect(sshExec).not.toHaveBeenCalled();
  });

  it("returns Hermes-managed authentication status without reading Codex CLI auth.json", async () => {
    (sshExec as jest.Mock).mockResolvedValue({
      ok: true,
      stdout: '{"authenticated":true,"source":"device-code"}',
      stderr: "",
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/codex/status?apply=1"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.authenticated).toBe(true);

    const command = (sshExec as jest.Mock).mock.calls[0][1];
    expect(command).toContain('docker exec -u "hermes" -i "$AGENT_CONTAINER"');
    expect(command).toContain("for candidate_container in agent-inst-123 agent-inst-123-gateway; do");
    expect(command).toContain('export HERMES_HOME="/opt/data"');
    expect(command).toContain("_save_codex_tokens");
    expect(command).not.toContain("_update_config_for_provider");
    expect(command).not.toContain("/root/.codex/auth.json");
  });

  it("stores reusable Codex OAuth bundles in the Vault when auth completes", async () => {
    (sshExec as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        stdout: JSON.stringify({
          authenticated: true,
          source: "device-code",
          vaultBundle: {
            accessToken: "access-123",
            refreshToken: "refresh-456",
            lastRefresh: "2026-04-11T12:00:00Z",
            baseUrl: "https://chatgpt.com/backend-api/codex",
          },
        }),
        stderr: "",
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout: '{"changed":false,"synced":1}',
        stderr: "",
      });

    const maybeSingle = jest.fn().mockResolvedValue({ data: null, error: null });
    const insertSelectSingle = jest.fn().mockResolvedValue({ data: { id: "vault-1" }, error: null });
    const insert = jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        single: insertSelectSingle,
      }),
    });

    (supabaseAdmin!.from as jest.Mock).mockReturnValue({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle,
      insert,
      update: jest.fn().mockReturnThis(),
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/codex/status?apply=1"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.authenticated).toBe(true);
    expect(supabaseAdmin!.from).toHaveBeenCalledWith("user_api_keys");
    expect(insert).toHaveBeenCalled();
  });

  it("creates a distinct Vault session when a new Codex device login completes", async () => {
    (sshExec as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        stdout: JSON.stringify({
          authenticated: true,
          source: "device-code",
          vaultBundle: {
            accessToken: "new-access",
            refreshToken: "new-refresh",
            lastRefresh: "2026-04-25T05:30:00Z",
            baseUrl: "https://chatgpt.com/backend-api/codex",
          },
        }),
        stderr: "",
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout: '{"changed":false,"synced":1}',
        stderr: "",
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout: "",
        stderr: "",
      });

    const update = jest.fn().mockReturnThis();
    const insertSelectSingle = jest.fn().mockResolvedValue({ data: { id: "vault-new" }, error: null });
    const insert = jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        single: insertSelectSingle,
      }),
    });
    const vaultBuilder = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: { id: "vault-existing", name: "Codex OAuth Session" },
        error: null,
      }),
      update,
      insert,
    };
    const instanceEqProvider = jest.fn().mockResolvedValue({ error: null });
    const instanceEqUser = jest.fn().mockReturnValue({ eq: instanceEqProvider });
    const instanceEqId = jest.fn().mockReturnValue({ eq: instanceEqUser });
    const instanceUpdate = jest.fn().mockReturnValue({ eq: instanceEqId });

    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "user_api_keys") return vaultBuilder;
      if (table === "hermes_instances") return { update: instanceUpdate };
      throw new Error(`Unexpected table ${table}`);
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/codex/status?apply=1"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.vaultKeyId).toBe("vault-new");
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      name: expect.stringMatching(/^Codex OAuth Session/),
      provider: "codex",
      key_preview: "OAuth session (reusable)",
    }));
    expect(update).not.toHaveBeenCalled();
  });

  it("binds reusable Codex OAuth bundles to the instance after auth completes", async () => {
    (sshExec as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        stdout: JSON.stringify({
          authenticated: true,
          source: "device-code",
          vaultBundle: {
            accessToken: "access-123",
            refreshToken: "refresh-456",
            lastRefresh: "2026-04-11T12:00:00Z",
            baseUrl: "https://chatgpt.com/backend-api/codex",
          },
        }),
        stderr: "",
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout: '{"changed":false,"synced":1}',
        stderr: "",
      });

    const vaultBuilder = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: { id: "vault-1" }, error: null }),
      update: jest.fn().mockReturnThis(),
      insert: jest.fn().mockReturnThis(),
    };
    const instanceEqProvider = jest.fn().mockResolvedValue({ error: null });
    const instanceEqUser = jest.fn().mockReturnValue({ eq: instanceEqProvider });
    const instanceEqId = jest.fn().mockReturnValue({ eq: instanceEqUser });
    const instanceUpdate = jest.fn().mockReturnValue({ eq: instanceEqId });

    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "user_api_keys") {
        return vaultBuilder;
      }

      if (table === "hermes_instances") {
        return {
          update: instanceUpdate,
        };
      }

      throw new Error(`Unexpected table ${table}`);
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/codex/status?apply=1"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(instanceUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        api_key_encrypted: expect.any(String),
        api_key_preview: "OAuth session (reusable)",
      })
    );
    expect(instanceEqId).toHaveBeenCalledWith("id", "inst-123");
    expect(instanceEqUser).toHaveBeenCalledWith("user_id", "user_123");
    expect(instanceEqProvider).toHaveBeenCalledWith("provider", "codex");
  });

  it("restarts the codex gateway once when the instance bundle changes", async () => {
    const nextBundle = {
      accessToken: "access-123",
      refreshToken: "refresh-456",
      lastRefresh: "2026-04-11T12:00:00Z",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    };

    (validateConsoleAccess as jest.Mock).mockResolvedValue({
      id: "inst-123",
      hostIp: "127.0.0.1",
      userId: "user_123",
      instance: {
        id: "inst-123",
        provider: "codex",
      },
    });

    (sshExec as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        stdout: JSON.stringify({
          authenticated: true,
          source: "device-code",
          vaultBundle: nextBundle,
        }),
        stderr: "",
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout: '{"changed":false,"synced":1}',
        stderr: "",
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout: "",
        stderr: "",
      });

    const vaultBuilder = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: { id: "vault-1" }, error: null }),
      update: jest.fn().mockReturnThis(),
      insert: jest.fn().mockReturnThis(),
    };
    const instanceEqProvider = jest.fn().mockResolvedValue({ error: null });
    const instanceEqUser = jest.fn().mockReturnValue({ eq: instanceEqProvider });
    const instanceEqId = jest.fn().mockReturnValue({ eq: instanceEqUser });
    const instanceUpdate = jest.fn().mockReturnValue({ eq: instanceEqId });

    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "user_api_keys") {
        return vaultBuilder;
      }

      if (table === "hermes_instances") {
        return {
          update: instanceUpdate,
        };
      }

      throw new Error(`Unexpected table ${table}`);
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/codex/status?apply=1"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.gatewayRestartTriggered).toBe(true);
    expect(sshExec).toHaveBeenCalledTimes(3);
    expect((sshExec as jest.Mock).mock.calls[1][1]).toContain(
      "for container_name in agent-inst-123 agent-inst-123-web agent-inst-123-acp agent-inst-123-mcp agent-inst-123-gateway; do"
    );
    expect((sshExec as jest.Mock).mock.calls[1][1]).toContain('BASE_HOME="/opt/data"');
    expect((sshExec as jest.Mock).mock.calls[2][1]).toContain(
      "for container_name in agent-inst-123 agent-inst-123-web agent-inst-123-acp agent-inst-123-mcp agent-inst-123-gateway; do"
    );
    expect((sshExec as jest.Mock).mock.calls[2][1]).toContain("docker restart $RESTART_CONTAINERS");
  });

  it("does not restart the codex gateway when the stored bundle already matches", async () => {
    const existingBundle = {
      accessToken: "access-123",
      refreshToken: "refresh-456",
      lastRefresh: "2026-04-11T12:00:00Z",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    };

    (validateConsoleAccess as jest.Mock).mockResolvedValue({
      id: "inst-123",
      hostIp: "127.0.0.1",
      userId: "user_123",
      instance: {
        id: "inst-123",
        provider: "codex",
        api_key_encrypted: encryptApiKey(serializeCodexVaultBundle(existingBundle)),
      },
    });

    (sshExec as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        stdout: JSON.stringify({
          authenticated: true,
          source: "device-code",
          vaultBundle: existingBundle,
        }),
        stderr: "",
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout: '{"changed":false,"synced":1}',
        stderr: "",
      });

    const vaultBuilder = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: { id: "vault-1" }, error: null }),
      update: jest.fn().mockReturnThis(),
      insert: jest.fn().mockReturnThis(),
    };
    const instanceEqProvider = jest.fn().mockResolvedValue({ error: null });
    const instanceEqUser = jest.fn().mockReturnValue({ eq: instanceEqProvider });
    const instanceEqId = jest.fn().mockReturnValue({ eq: instanceEqUser });
    const instanceUpdate = jest.fn().mockReturnValue({ eq: instanceEqId });

    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "user_api_keys") {
        return vaultBuilder;
      }

      if (table === "hermes_instances") {
        return {
          update: instanceUpdate,
        };
      }

      throw new Error(`Unexpected table ${table}`);
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/codex/status?apply=1"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.gatewayRestartTriggered).toBe(false);
    expect(sshExec).toHaveBeenCalledTimes(2);
  });

  it("does not restart the codex gateway during steady-state auth polling", async () => {
    const nextBundle = {
      accessToken: "access-123",
      refreshToken: "refresh-456",
      lastRefresh: "2026-04-11T12:00:00Z",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    };

    (validateConsoleAccess as jest.Mock).mockResolvedValue({
      id: "inst-123",
      hostIp: "127.0.0.1",
      userId: "user_123",
      instance: {
        id: "inst-123",
        provider: "codex",
      },
    });

    (sshExec as jest.Mock).mockResolvedValueOnce({
      ok: true,
      stdout: JSON.stringify({
        authenticated: true,
        source: "hermes-auth-store",
        vaultBundle: nextBundle,
      }),
      stderr: "",
    });

    const vaultBuilder = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: { id: "vault-1" }, error: null }),
      update: jest.fn().mockReturnThis(),
      insert: jest.fn().mockReturnThis(),
    };
    const instanceEqProvider = jest.fn().mockResolvedValue({ error: null });
    const instanceEqUser = jest.fn().mockReturnValue({ eq: instanceEqProvider });
    const instanceEqId = jest.fn().mockReturnValue({ eq: instanceEqUser });
    const instanceUpdate = jest.fn().mockReturnValue({ eq: instanceEqId });

    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "user_api_keys") {
        return vaultBuilder;
      }

      if (table === "hermes_instances") {
        return {
          update: instanceUpdate,
        };
      }

      throw new Error(`Unexpected table ${table}`);
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/codex/status"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.gatewayRestartTriggered).toBe(false);
    expect(sshExec).toHaveBeenCalledTimes(1);
  });

  it("mirrors root-mode auth repairs into both the active home and legacy /opt/data", async () => {
    const existingBundle = {
      accessToken: "access-123",
      refreshToken: "refresh-456",
      lastRefresh: "2026-04-11T12:00:00Z",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    };

    (validateConsoleAccess as jest.Mock).mockResolvedValue({
      id: "inst-123",
      hostIp: "127.0.0.1",
      userId: "user_123",
      instance: {
        id: "inst-123",
        provider: "codex",
        api_key_encrypted: encryptApiKey(serializeCodexVaultBundle(existingBundle)),
        config: {
          agentSettings: {
            enableRootAccess: true,
          },
        },
      },
    });

    (sshExec as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        stdout: JSON.stringify({
          authenticated: true,
          source: "device-code",
          vaultBundle: existingBundle,
        }),
        stderr: "",
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout: '{"changed":false,"synced":1}',
        stderr: "",
      });

    const vaultBuilder = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: { id: "vault-1" }, error: null }),
      update: jest.fn().mockReturnThis(),
      insert: jest.fn().mockReturnThis(),
    };
    const instanceEqProvider = jest.fn().mockResolvedValue({ error: null });
    const instanceEqUser = jest.fn().mockReturnValue({ eq: instanceEqProvider });
    const instanceEqId = jest.fn().mockReturnValue({ eq: instanceEqUser });
    const instanceUpdate = jest.fn().mockReturnValue({ eq: instanceEqId });

    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "user_api_keys") {
        return vaultBuilder;
      }

      if (table === "hermes_instances") {
        return {
          update: instanceUpdate,
        };
      }

      throw new Error(`Unexpected table ${table}`);
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/codex/status"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.gatewayRestartTriggered).toBe(false);
    expect(sshExec).toHaveBeenCalledTimes(2);
    expect((sshExec as jest.Mock).mock.calls[1][1]).toContain('BASE_HOME="/root/.hermes"');
    expect((sshExec as jest.Mock).mock.calls[1][1]).toContain('LEGACY_BASE_HOME="/opt/data"');
  });

  it("restarts the codex gateway when runtime auth store ownership is repaired", async () => {
    const existingBundle = {
      accessToken: "access-123",
      refreshToken: "refresh-456",
      lastRefresh: "2026-04-11T12:00:00Z",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    };

    (validateConsoleAccess as jest.Mock).mockResolvedValue({
      id: "inst-123",
      hostIp: "127.0.0.1",
      userId: "user_123",
      instance: {
        id: "inst-123",
        provider: "codex",
        api_key_encrypted: encryptApiKey(serializeCodexVaultBundle(existingBundle)),
      },
    });

    (sshExec as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        stdout: JSON.stringify({
          authenticated: true,
          source: "device-code",
          vaultBundle: existingBundle,
        }),
        stderr: "",
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout: '{"changed":true,"synced":1}',
        stderr: "",
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout: "",
        stderr: "",
      });

    const vaultBuilder = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: { id: "vault-1" }, error: null }),
      update: jest.fn().mockReturnThis(),
      insert: jest.fn().mockReturnThis(),
    };
    const instanceEqProvider = jest.fn().mockResolvedValue({ error: null });
    const instanceEqUser = jest.fn().mockReturnValue({ eq: instanceEqProvider });
    const instanceEqId = jest.fn().mockReturnValue({ eq: instanceEqUser });
    const instanceUpdate = jest.fn().mockReturnValue({ eq: instanceEqId });

    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "user_api_keys") {
        return vaultBuilder;
      }

      if (table === "hermes_instances") {
        return {
          update: instanceUpdate,
        };
      }

      throw new Error(`Unexpected table ${table}`);
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/codex/status?apply=1"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.gatewayRestartTriggered).toBe(true);
    expect(sshExec).toHaveBeenCalledTimes(3);
    expect((sshExec as jest.Mock).mock.calls[2][1]).toContain(
      "for container_name in agent-inst-123 agent-inst-123-web agent-inst-123-acp agent-inst-123-mcp agent-inst-123-gateway; do"
    );
    expect((sshExec as jest.Mock).mock.calls[2][1]).toContain("docker restart $RESTART_CONTAINERS");
  });

  it("returns authenticated with a persistence error when Vault save fails", async () => {
    delete process.env.ENCRYPTION_KEY;
    (sshExec as jest.Mock).mockResolvedValue({
      ok: true,
      stdout: JSON.stringify({
        authenticated: true,
        source: "device-code",
        vaultBundle: {
          accessToken: "access-123",
          refreshToken: "refresh-456",
          lastRefresh: "2026-04-11T12:00:00Z",
          baseUrl: "https://chatgpt.com/backend-api/codex",
        },
      }),
      stderr: "",
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/codex/status"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.authenticated).toBe(true);
    expect(json.data.persistenceError).toBe(
      "Unable to save the reusable Vault session. Please try again or contact support."
    );
  });

  it("falls back to the stored vault bundle when the live status check fails", async () => {
    const existingBundle = {
      accessToken: "access-123",
      refreshToken: "refresh-456",
      lastRefresh: "2026-04-11T12:00:00Z",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      source: "device-code",
    };

    (validateConsoleAccess as jest.Mock).mockResolvedValue({
      id: "inst-123",
      hostIp: "127.0.0.1",
      userId: "user_123",
      instance: {
        id: "inst-123",
        provider: "codex",
        api_key_encrypted: encryptApiKey(serializeCodexVaultBundle(existingBundle)),
      },
    });

    (sshExec as jest.Mock).mockResolvedValue({
      ok: false,
      stdout: "",
      stderr: "ssh: handshake failed",
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/codex/status"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.authenticated).toBe(true);
    expect(json.data.source).toBe("stored-vault");
    expect(json.data.cached).toBe(true);
    expect(json.data.degraded).toBe(true);
    expect(json.data.gatewayRestartTriggered).toBe(false);
  });

  it("uses a stored Vault session when the live runtime auth store is stale", async () => {
    const existingBundle = {
      accessToken: "access-123",
      refreshToken: "refresh-456",
      lastRefresh: "2026-04-11T12:00:00Z",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      source: "device-code",
    };

    (validateConsoleAccess as jest.Mock).mockResolvedValue({
      id: "inst-123",
      hostIp: "127.0.0.1",
      userId: "user_123",
      instance: {
        id: "inst-123",
        provider: "codex",
        api_key_encrypted: encryptApiKey(serializeCodexVaultBundle(existingBundle)),
      },
    });

    (sshExec as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        stdout: '{"authenticated":false}',
        stderr: "",
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout: '{"changed":true,"synced":1}',
        stderr: "",
      });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/codex/status"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.authenticated).toBe(true);
    expect(json.data.source).toBe("stored-vault");
    expect(json.data.gatewayRestartTriggered).toBe(false);
    expect(json.data.gatewayRestartRequired).toBe(true);
    expect(sshExec).toHaveBeenCalledTimes(2);
    expect((sshExec as jest.Mock).mock.calls[1][1]).toContain('BASE_HOME="/opt/data"');
  });

  it("does not accept an older Vault session while a new device login is pending", async () => {
    const existingBundle = {
      accessToken: "access-123",
      refreshToken: "refresh-456",
      lastRefresh: "2026-04-11T12:00:00Z",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      source: "device-code",
    };

    (validateConsoleAccess as jest.Mock).mockResolvedValue({
      id: "inst-123",
      hostIp: "127.0.0.1",
      userId: "user_123",
      instance: {
        id: "inst-123",
        provider: "codex",
        api_key_encrypted: encryptApiKey(serializeCodexVaultBundle(existingBundle)),
      },
    });

    (sshExec as jest.Mock).mockResolvedValue({
      ok: true,
      stdout: '{"authenticated":false,"pendingDeviceFlow":true}',
      stderr: "",
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/codex/status"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.authenticated).toBe(false);
    expect(json.data.pendingDeviceFlow).toBe(true);
    expect(sshExec).toHaveBeenCalledTimes(1);
  });

  it("falls back to a stored Vault session for WebUI openai-codex aliases when the live check fails", async () => {
    const existingBundle = {
      accessToken: "access-123",
      refreshToken: "refresh-456",
      lastRefresh: "2026-04-11T12:00:00Z",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      source: "device-code",
    };

    (validateConsoleAccess as jest.Mock).mockResolvedValue({
      id: "inst-123",
      hostIp: "127.0.0.1",
      userId: "user_123",
      instance: {
        id: "inst-123",
        backend: "webui",
        provider: "openai-codex",
        config: {},
      },
    });

    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "user_api_keys") {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          order: jest.fn().mockReturnThis(),
          limit: jest.fn().mockReturnThis(),
          maybeSingle: jest.fn().mockResolvedValue({
            data: {
              id: "vault-1",
              encrypted_key: encryptApiKey(serializeCodexVaultBundle(existingBundle)),
            },
            error: null,
          }),
          update: jest.fn().mockReturnThis(),
          insert: jest.fn().mockReturnThis(),
        };
      }

      throw new Error(`Unexpected table ${table}`);
    });

    (sshExec as jest.Mock).mockResolvedValue({
      ok: false,
      stdout: "",
      stderr: "AttributeError: module 'hermes_cli.auth' has no attribute '_read_codex_tokens'",
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/codex/status"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data).toMatchObject({
      authenticated: true,
      source: "stored-vault",
      cached: true,
      degraded: true,
      runtime: "webui",
      vaultKeyId: "vault-1",
    });
  });

  it("attributes status failures to the codex oauth status route", async () => {
    (sshExec as jest.Mock).mockResolvedValue({
      ok: false,
      stdout: "",
      stderr: "Traceback (most recent call last): urllib.error.HTTPError: HTTP Error 530:",
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/codex/status"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    // Unclassified codex command failures default to 503 (transient
    // service-unavailable) rather than 500. The polling UI treats 503 as
    // "try again later" instead of escalating, which stops the
    // production 500-spam when codex CLI is missing or returns an
    // unrecognized stderr.
    expect(response.status).toBe(503);
    expect(json.error).toBe("Failed to check the Hermes Codex auth status.");
    expect(JSON.stringify(json)).not.toContain("HTTP Error 530");
    expect(consoleErrorSpy.mock.calls.flat().join(" ")).not.toContain("HTTP Error 530");
    expect(apiError).toHaveBeenCalledWith(
      "Failed to check the Hermes Codex auth status.",
      503,
      expect.objectContaining({
        failureType: "codex_status_command_failed",
        stderrPresent: true,
        errorPresent: false,
        stdoutPresent: false,
      }),
      undefined,
      expect.objectContaining({
        source: "codex-oauth-status",
        route: "/api/instances/[id]/oauth/codex/status",
      })
    );
  });

  it("classifies runtime auth helper contract failures without logging raw stderr", async () => {
    (sshExec as jest.Mock).mockResolvedValue({
      ok: false,
      stdout: "",
      stderr: "Traceback (most recent call last): AttributeError: module 'hermes_cli.auth' has no attribute '_read_codex_tokens'",
      error: "Command exited with code 1: AttributeError: module 'hermes_cli.auth' has no attribute '_read_codex_tokens'",
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/codex/status"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(503);
    expect(json.error).toBe("Codex auth support is unavailable in this Hermes runtime. Update or restart the instance, then try again.");
    expect(consoleErrorSpy.mock.calls.flat().join(" ")).not.toContain("_read_codex_tokens");
    expect(apiError).toHaveBeenCalledWith(
      "Codex auth support is unavailable in this Hermes runtime. Update or restart the instance, then try again.",
      503,
      expect.objectContaining({
        failureType: "codex_status_command_failed",
        failureCategory: "codex_auth_private_helper_missing",
        stderrPresent: true,
        errorPresent: true,
        stdoutPresent: false,
      }),
      undefined,
      expect.objectContaining({
        source: "codex-oauth-status",
        route: "/api/instances/[id]/oauth/codex/status",
      })
    );
  });

  it("does not leak unreadable status payloads to the client", async () => {
    (sshExec as jest.Mock).mockResolvedValue({
      ok: true,
      stdout: "refresh_token=super-secret",
      stderr: "",
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/codex/status"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error).toBe("Codex status command returned an unreadable status payload.");
    expect(JSON.stringify(json)).not.toContain("super-secret");
    expect(consoleErrorSpy.mock.calls.flat().join(" ")).not.toContain("super-secret");
    expect(apiError).toHaveBeenCalledWith(
      "Codex status command returned an unreadable status payload.",
      500,
      expect.objectContaining({
        failureType: "codex_status_parse_failed",
        errorName: "Error",
        outputLength: "refresh_token=super-secret".length,
      }),
      undefined,
      expect.objectContaining({
        source: "codex-oauth-status",
        route: "/api/instances/[id]/oauth/codex/status",
      })
    );
  });

  it("returns 503 when the agent container is not running", async () => {
    (sshExec as jest.Mock).mockResolvedValue({
      ok: false,
      stdout: "",
      stderr: "Error response from daemon: container 726b3a6a74e2067893483d8cf31cad497aebc85ef320b262bf50e60836d53103 is not running",
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/codex/status"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(503);
    expect(json.error).toBe("Agent container is not running. Please start your instance first.");
    expect(apiError).toHaveBeenCalledWith(
      "Agent container is not running. Please start your instance first.",
      503,
      undefined,
      undefined,
      expect.objectContaining({
        source: "codex-oauth-status",
        route: "/api/instances/[id]/oauth/codex/status",
      })
    );
  });

  it("returns 503 when the host connection resets during the live status check", async () => {
    (sshExec as jest.Mock).mockResolvedValue({
      ok: false,
      stdout: "",
      stderr: "SSH connection error: write ECONNRESET",
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/codex/status"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(503);
    expect(json.error).toBe("Unable to reach the Hermes runtime right now. Try again in a moment.");
    expect(apiError).toHaveBeenCalledWith(
      "Unable to reach the Hermes runtime right now. Try again in a moment.",
      503,
      undefined,
      undefined,
      expect.objectContaining({
        source: "codex-oauth-status",
        route: "/api/instances/[id]/oauth/codex/status",
      })
    );
  });

  it("returns a generic timeout message when SSH fingerprint capture is still warming up", async () => {
    (sshExec as jest.Mock).mockResolvedValue({
      ok: false,
      stdout: "",
      stderr: "",
      error: "Timed out capturing SSH host fingerprint from 203.0.113.80 after 5355ms",
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/codex/status"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(504);
    expect(json.error).toBe("Timed out while checking the Hermes Codex auth status. Try again in a moment.");
    expect(JSON.stringify(json)).not.toContain("203.0.113.80");
    expect(apiError).toHaveBeenCalledWith(
      "Timed out while checking the Hermes Codex auth status. Try again in a moment.",
      504,
      undefined,
      undefined,
      expect.objectContaining({
        source: "codex-oauth-status",
        route: "/api/instances/[id]/oauth/codex/status",
        metadata: expect.objectContaining({
          hostIp: "127.0.0.1",
        }),
      })
    );
  });
});
