import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { GET, PATCH } from "../route";
import { ProfileService } from "@/lib/services/profile-service";
import { supabaseAdmin } from "@/lib/supabase";
import { resolveWebUIInstanceClient } from "@/lib/webui/instance";
import { WebUIError } from "@/lib/webui/client";
import { sshExec } from "@/lib/hetzner/ssh";
import {
  loadUserCodexVaultBundle,
  readCachedCodexVaultBundle,
  syncCodexRuntimeAuthStore,
} from "@/lib/services/codex-runtime-auth";
import {
  loadUserNousVaultBundle,
  readCachedNousVaultBundle,
  syncNousRuntimeAuthStore,
} from "@/lib/services/nous-runtime-auth";
import { log } from "@/lib/logger";
import { makeJsonRequest } from "@/test-utils";

const mockCreateManagedVeniceProxyKey = jest.fn();

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());;

jest.mock("@/lib/services/profile-service", () => {
  const actual = jest.requireActual("@/lib/services/profile-service");
  return {
    ...actual,
    ProfileService: {
      ...actual.ProfileService,
      syncProfiles: jest.fn(),
      getHostIpForInstance: jest.fn(),
    },
  };
});

jest.mock("@/lib/hetzner/ssh", () => ({
  sshExec: jest.fn(),
}));

jest.mock("@/lib/services/codex-runtime-auth", () => ({
  loadUserCodexVaultBundle: jest.fn(),
  readCachedCodexVaultBundle: jest.fn(),
  syncCodexRuntimeAuthStore: jest.fn(),
}));

jest.mock("@/lib/services/nous-runtime-auth", () => ({
  loadUserNousVaultBundle: jest.fn(),
  readCachedNousVaultBundle: jest.fn(),
  syncNousRuntimeAuthStore: jest.fn(),
}));

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/webui/instance", () => ({
  resolveWebUIInstanceClient: jest.fn(),
}));

jest.mock("@/lib/venice/proxy-keys", () => ({
  createManagedVeniceProxyKey: (...args: unknown[]) =>
    mockCreateManagedVeniceProxyKey(...args),
}));

jest.mock("@/lib/venice/managed-endpoints", () => ({
  getManagedVeniceProxyBaseUrl: () => "https://hermesos.cloud/api/managed-venice/v1",
}));

describe("GET /api/instances/[id]/profiles", () => {
  const mockedAuth = auth as jest.MockedFunction<typeof auth>;
  const mockedSyncProfiles = ProfileService.syncProfiles as jest.MockedFunction<typeof ProfileService.syncProfiles>;
  const mockedGetHostIpForInstance = ProfileService.getHostIpForInstance as jest.MockedFunction<typeof ProfileService.getHostIpForInstance>;
  const mockedFrom = supabaseAdmin!.from as jest.Mock;
  const mockedResolveWebUIInstanceClient = resolveWebUIInstanceClient as jest.MockedFunction<typeof resolveWebUIInstanceClient>;
  const mockedSshExec = sshExec as jest.MockedFunction<typeof sshExec>;
  const mockedLoadUserCodexVaultBundle = loadUserCodexVaultBundle as jest.MockedFunction<typeof loadUserCodexVaultBundle>;
  const mockedReadCachedCodexVaultBundle = readCachedCodexVaultBundle as jest.MockedFunction<typeof readCachedCodexVaultBundle>;
  const mockedSyncCodexRuntimeAuthStore = syncCodexRuntimeAuthStore as jest.MockedFunction<typeof syncCodexRuntimeAuthStore>;
  const mockedLoadUserNousVaultBundle = loadUserNousVaultBundle as jest.MockedFunction<typeof loadUserNousVaultBundle>;
  const mockedReadCachedNousVaultBundle = readCachedNousVaultBundle as jest.MockedFunction<typeof readCachedNousVaultBundle>;
  const mockedSyncNousRuntimeAuthStore = syncNousRuntimeAuthStore as jest.MockedFunction<typeof syncNousRuntimeAuthStore>;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    mockedAuth.mockResolvedValue({ userId: "user_123" } as Awaited<ReturnType<typeof auth>>);
    mockedGetHostIpForInstance.mockResolvedValue("127.0.0.1");
    mockedSshExec.mockResolvedValue({ ok: true, stdout: "", stderr: "" });
    mockedReadCachedCodexVaultBundle.mockReturnValue(null);
    mockedLoadUserCodexVaultBundle.mockResolvedValue({
      bundle: null,
      encryptedKey: null,
      vaultKeyId: null,
    });
    mockedSyncCodexRuntimeAuthStore.mockResolvedValue({ changed: false });
    mockedReadCachedNousVaultBundle.mockReturnValue(null);
    mockedLoadUserNousVaultBundle.mockResolvedValue({
      bundle: null,
      encryptedKey: null,
      vaultKeyId: null,
    });
    mockedSyncNousRuntimeAuthStore.mockResolvedValue({ changed: false });
    mockCreateManagedVeniceProxyKey.mockResolvedValue({
      id: "managed_key_1",
      plaintextKey: "hven_live_profile_proxy",
      defaultWalletType: "hermesos",
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("returns 404 instead of exposing default metadata for another user's instance", async () => {
    mockedFrom.mockImplementation((table: string) => {
      const filters: Record<string, unknown> = {};
      const chain: {
        select: jest.Mock;
        eq: jest.Mock;
        order: jest.Mock;
        single: jest.Mock;
      } = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn((column: string, value: unknown) => {
          filters[column] = value;
          return chain;
        }),
        order: jest.fn().mockReturnThis(),
        single: jest.fn().mockImplementation(async () => {
          if (table === "hermes_instances") {
            if (filters.id === "inst_123" && filters.user_id === undefined) {
              return {
                data: {
                  name: "Foreign Agent",
                  config: {
                    provider: "codex",
                    model: "gpt-5.4",
                    agentSettings: {
                      systemPrompt: "foreign prompt",
                    },
                  },
                },
                error: null,
              };
            }

            return { data: null, error: { message: "not found" } };
          }

          return { data: null, error: null };
        }),
      };

      return chain;
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst_123/profiles"),
      { params: Promise.resolve({ id: "inst_123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(404);
    expect(json.error).toBe("Instance not found");
  });

  it("falls back to stored profiles when an explicit sync request fails", async () => {
    mockedSyncProfiles.mockRejectedValueOnce(new Error("sync failed"));
    mockedFrom.mockImplementation((table: string) => {
      const chain: {
        select: jest.Mock;
        eq: jest.Mock;
        order: jest.Mock;
        single: jest.Mock;
      } = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        order: jest.fn().mockResolvedValue({
          data: [],
          error: null,
        }),
        single: jest.fn().mockResolvedValue(
          table === "hermes_instances"
            ? {
                data: {
                  name: "Managed Agent",
                  config: {
                    provider: "codex",
                    model: "gpt-5.4",
                  },
                },
                error: null,
              }
            : { data: null, error: null }
        ),
      };

      return chain;
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst_123/profiles?sync=true"),
      { params: Promise.resolve({ id: "inst_123" }) }
    );
    const json = await response.json();

    expect(mockedSyncProfiles).toHaveBeenCalledWith("inst_123", "user_123");
    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "default",
          display_name: "Managed Agent",
        }),
      ])
    );
  });

  it("returns stored profile summaries without selecting prompt fields", async () => {
    // Post-collapse a `gateway` box is webfree: GET resolves a WebUI client
    // first. We exercise the stored-summary path via the webfree fallback
    // (profiles() unreachable) so the SELECT-shape + ordering assertions still
    // cover loadStoredProfiles.
    mockedResolveWebUIInstanceClient.mockResolvedValue({
      ok: true,
      baseUrl: "https://webui.example.com",
      client: {
        profiles: jest.fn().mockRejectedValue(
          new WebUIError("network: fetch failed", { status: 0, body: "" })
        ),
      } as unknown as Awaited<ReturnType<typeof resolveWebUIInstanceClient>> extends { ok: true; client: infer T } ? T : never,
    });
    const selects: string[] = [];
    const orders: Array<[string, { ascending?: boolean } | undefined]> = [];
    mockedFrom.mockImplementation((table: string) => {
      const chain: {
        select: jest.Mock;
        eq: jest.Mock;
        order: jest.Mock;
        single: jest.Mock;
      } = {
        select: jest.fn((value: string) => {
          selects.push(value);
          return chain;
        }),
        eq: jest.fn().mockReturnThis(),
        order: jest.fn((column: string, options?: { ascending?: boolean }) => {
          orders.push([column, options]);
          return Promise.resolve(
            table === "profiles"
              ? {
                  data: [{
                    id: "profile-research",
                    instance_id: "inst_123",
                    user_id: "user_123",
                    name: "research",
                    display_name: "Research",
                    avatar_url: null,
                    model: "gpt-5",
                    provider: "openai",
                    status: "running",
                    gateway_port: 8001,
                    created_at: "2026-04-26T12:00:00.000Z",
                    updated_at: "2026-04-26T12:00:00.000Z",
                  }],
                  error: null,
                }
              : { data: null, error: null }
          );
        }),
        single: jest.fn().mockResolvedValue(
          table === "hermes_instances"
            ? {
                data: {
                  name: "Managed Agent",
                  config: {
                    provider: "codex",
                    model: "gpt-5.4",
                    agentSettings: {
                      systemPrompt: "do not include this",
                    },
                  },
                  backend: "gateway",
                },
                error: null,
              }
            : { data: null, error: null }
        ),
      };

      return chain;
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst_123/profiles?summary=true"),
      { params: Promise.resolve({ id: "inst_123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(selects).toContain("id, instance_id, user_id, name, display_name, avatar_url, model, provider, status, gateway_port, created_at, updated_at");
    expect(selects).not.toContain("*");
    expect(orders).toContainEqual(["created_at", { ascending: true }]);
    expect(JSON.stringify(json.data)).not.toContain("system_prompt");
    expect(JSON.stringify(json.data)).not.toContain("do not include this");
  });

  it("applies the stored database profile order when listing profiles", async () => {
    // `gateway` is webfree post-collapse, so the stored DB ordering is applied
    // on the webfree fallback path (profiles() unreachable → stored rows +
    // applyProfileOrder honoring config.profileOrder).
    mockedResolveWebUIInstanceClient.mockResolvedValue({
      ok: true,
      baseUrl: "https://webui.example.com",
      client: {
        profiles: jest.fn().mockRejectedValue(
          new WebUIError("network: fetch failed", { status: 0, body: "" })
        ),
      } as unknown as Awaited<ReturnType<typeof resolveWebUIInstanceClient>> extends { ok: true; client: infer T } ? T : never,
    });
    mockedFrom.mockImplementation((table: string) => {
      const chain: {
        select: jest.Mock;
        eq: jest.Mock;
        order: jest.Mock;
        single: jest.Mock;
      } = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        order: jest.fn().mockResolvedValue(
          table === "profiles"
            ? {
                data: [
                  {
                    id: "profile-first",
                    instance_id: "inst_123",
                    user_id: "user_123",
                    name: "first",
                    display_name: "First",
                    avatar_url: null,
                    model: "gpt-5",
                    provider: "openai",
                    status: "running",
                    gateway_port: 8001,
                    created_at: "2026-04-26T12:00:00.000Z",
                    updated_at: "2026-04-26T12:00:00.000Z",
                  },
                  {
                    id: "profile-second",
                    instance_id: "inst_123",
                    user_id: "user_123",
                    name: "second",
                    display_name: "Second",
                    avatar_url: null,
                    model: "gpt-5",
                    provider: "openai",
                    status: "running",
                    gateway_port: 8002,
                    created_at: "2026-04-26T12:01:00.000Z",
                    updated_at: "2026-04-26T12:01:00.000Z",
                  },
                ],
                error: null,
              }
            : { data: null, error: null }
        ),
        single: jest.fn().mockResolvedValue(
          table === "hermes_instances"
            ? {
                data: {
                  name: "Managed Agent",
                  config: {
                    profileOrder: ["second", "default", "first"],
                  },
                  backend: "gateway",
                },
                error: null,
              }
            : { data: null, error: null }
        ),
      };

      return chain;
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst_123/profiles?summary=true"),
      { params: Promise.resolve({ id: "inst_123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.map((profile: { name: string }) => profile.name)).toEqual([
      "second",
      "default",
      "first",
    ]);
  });

  it("persists profile order on the instance config", async () => {
    const updates: unknown[] = [];
    mockedFrom.mockImplementation((table: string) => {
      if (table !== "hermes_instances") throw new Error(`Unexpected table ${table}`);

      const selectChain: {
        select: jest.Mock;
        update: jest.Mock;
        eq: jest.Mock;
        single: jest.Mock;
        error?: null;
      } = {
        select: jest.fn().mockReturnThis(),
        update: jest.fn((value: unknown) => {
          updates.push(value);
          const updateChain = {
            error: null,
            eq: jest.fn().mockReturnThis(),
          };
          updateChain.eq.mockReturnValue(updateChain);
          return updateChain;
        }),
        eq: jest.fn().mockReturnThis(),
        single: jest.fn().mockResolvedValue({
          data: {
            config: {
              provider: "openai",
              existingSetting: true,
            },
          },
          error: null,
        }),
      };

      return selectChain;
    });

    const response = await PATCH(
      makeJsonRequest("http://localhost/api/instances/inst_123/profiles", { order: ["research", "default", "research"] }, { method: "PATCH" }),
      { params: Promise.resolve({ id: "inst_123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.profileOrder).toEqual(["research", "default"]);
    expect(updates).toEqual([{
      config: {
        provider: "openai",
        existingSetting: true,
        profileOrder: ["research", "default"],
      },
    }]);
  });

  it("rejects malformed profile order JSON without reading instance data", async () => {
    const response = await PATCH(
      new NextRequest("http://localhost/api/instances/inst_123/profiles", {
        method: "PATCH",
        body: "{",
      }),
      { params: Promise.resolve({ id: "inst_123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error).toBe("Invalid JSON body");
    expect(mockedFrom).not.toHaveBeenCalled();
  });

  it("rejects unsafe profile names before updating profile order", async () => {
    const response = await PATCH(
      makeJsonRequest("http://localhost/api/instances/inst_123/profiles", { order: ["default", "../secrets"] }, { method: "PATCH" }),
      { params: Promise.resolve({ id: "inst_123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error).toBe("Invalid profile name in order");
    expect(mockedFrom).not.toHaveBeenCalled();
  });

  it("returns live profiles from WebUI for WebUI-backed instances", async () => {
    // The per-profile /api/settings enrichment has been retired (that endpoint
    // 404s fleet-wide and no consumer read the enriched fields). GET now maps
    // /api/profiles straight through — each profile's own model/provider is
    // authoritative — with NO per-profile settings round-trip.
    const settingsMock = jest.fn();
    mockedResolveWebUIInstanceClient.mockResolvedValue({
      ok: true,
      baseUrl: "https://webui.example.com",
      client: {
        profiles: jest.fn().mockResolvedValue({
          active: "research",
          profiles: [
            {
              name: "default",
              is_default: true,
              is_active: false,
              gateway_running: false,
              model: "@crof:kimi-k2.6-precision",
              provider: "crof",
            },
            {
              name: "research",
              is_default: false,
              is_active: true,
              gateway_running: true,
              skill_count: 2,
              model: "@crof:deepseek-v3.2",
              provider: "crof",
            },
          ],
        }),
        settings: settingsMock,
      } as unknown as Awaited<ReturnType<typeof resolveWebUIInstanceClient>> extends { ok: true; client: infer T } ? T : never,
    });
    mockedFrom.mockImplementation((table: string) => {
      if (table !== "hermes_instances") throw new Error(`Unexpected table ${table}`);
      return {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        single: jest.fn().mockResolvedValue({
          data: {
            name: "WebUI Agent",
            config: {},
            backend: "webui",
          },
          error: null,
        }),
      };
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst_123/profiles"),
      { params: Promise.resolve({ id: "inst_123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data).toEqual([
      expect.objectContaining({
        name: "default",
        display_name: "WebUI Agent",
        model: "kimi-k2.6-precision",
        provider: "crof",
        status: "stopped",
      }),
      expect.objectContaining({
        name: "research",
        display_name: "research",
        model: "deepseek-v3.2",
        provider: "crof",
        status: "running",
      }),
    ]);
    // The retired enrichment must never issue a per-profile settings call.
    expect(settingsMock).not.toHaveBeenCalled();
    expect(mockedSyncProfiles).not.toHaveBeenCalled();
  });

  it("returns lightweight WebUI profile summaries without per-profile runtime settings", async () => {
    mockedResolveWebUIInstanceClient.mockResolvedValue({
      ok: true,
      baseUrl: "https://webui.example.com",
      client: {
        profiles: jest.fn().mockResolvedValue({
          active: "research",
          profiles: [
            {
              name: "default",
              is_default: true,
              is_active: false,
              gateway_running: false,
            },
            {
              name: "research",
              is_default: false,
              is_active: true,
              gateway_running: true,
            },
          ],
        }),
      } as unknown as Awaited<ReturnType<typeof resolveWebUIInstanceClient>> extends { ok: true; client: infer T } ? T : never,
    });
    mockedFrom.mockImplementation((table: string) => {
      if (table !== "hermes_instances") throw new Error(`Unexpected table ${table}`);
      return {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        single: jest.fn().mockResolvedValue({
          data: {
            name: "WebUI Agent",
            config: {},
            backend: "webui",
          },
          error: null,
        }),
      };
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst_123/profiles?summary=true"),
      { params: Promise.resolve({ id: "inst_123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data).toEqual([
      expect.objectContaining({
        name: "default",
        display_name: "WebUI Agent",
        status: "stopped",
      }),
      expect.objectContaining({
        name: "research",
        display_name: "research",
        status: "running",
      }),
    ]);
    expect(JSON.stringify(json.data)).not.toContain("system_prompt");
  });

  it("falls back to stored profiles when WebUI profile summaries are temporarily unreachable", async () => {
    mockedResolveWebUIInstanceClient.mockResolvedValue({
      ok: true,
      baseUrl: "https://webui.example.com",
      client: {
        profiles: jest.fn().mockRejectedValue(
          new WebUIError("network: fetch failed", { status: 0, body: "" })
        ),
      } as unknown as Awaited<ReturnType<typeof resolveWebUIInstanceClient>> extends { ok: true; client: infer T } ? T : never,
    });
    mockedFrom.mockImplementation((table: string) => {
      const chain: {
        select: jest.Mock;
        eq: jest.Mock;
        order: jest.Mock;
        single: jest.Mock;
      } = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        order: jest.fn().mockResolvedValue(
          table === "profiles"
            ? {
                data: [{
                  id: "profile-research",
                  instance_id: "inst_123",
                  user_id: "user_123",
                  name: "research",
                  display_name: "Research",
                  avatar_url: null,
                  model: "gpt-5",
                  provider: "openai",
                  status: "running",
                  gateway_port: null,
                  created_at: "2026-04-26T12:00:00.000Z",
                  updated_at: "2026-04-26T12:00:00.000Z",
                }],
                error: null,
              }
            : { data: null, error: null }
        ),
        single: jest.fn().mockResolvedValue(
          table === "hermes_instances"
            ? {
                data: {
                  name: "WebUI Agent",
                  config: {
                    provider: "codex",
                    model: "gpt-5.4",
                    profileOrder: ["research", "default"],
                  },
                  backend: "webui",
                },
                error: null,
              }
            : { data: null, error: null }
        ),
      };

      return chain;
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst_123/profiles?summary=true"),
      { params: Promise.resolve({ id: "inst_123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.map((profile: { name: string }) => profile.name)).toEqual([
      "research",
      "default",
    ]);
    expect(json.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "default",
          display_name: "WebUI Agent",
        }),
      ])
    );
    expect(log.warn).toHaveBeenCalledWith(
      "WebUI profile request failed; falling back to stored rows",
      expect.objectContaining({
        instanceId: "inst_123",
        userId: "user_123",
        upstreamStatus: 0,
        failureType: "webui_profiles_request_failed",
      }),
      expect.anything(),
    );
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
  it("falls back to stored profiles when sync fails because the runtime is offline", async () => {
    mockedSyncProfiles.mockRejectedValueOnce(
      new Error("Failed to sync profiles: Error response from daemon: container abc123 is not running client_secret=super-secret")
    );

    mockedFrom.mockImplementation((table: string) => {
      const filters: Record<string, unknown> = {};
      const chain: {
        select: jest.Mock;
        eq: jest.Mock;
        order: jest.Mock;
        single: jest.Mock;
      } = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn((column: string, value: unknown) => {
          filters[column] = value;
          return chain;
        }),
        order: jest.fn().mockImplementation(async () => {
          if (table === "profiles") {
            return {
              data: [],
              error: null,
            };
          }

          return {
            data: null,
            error: null,
          };
        }),
        single: jest.fn().mockImplementation(async () => {
          if (table === "hermes_instances") {
            return {
              data: {
                name: "Recovered Agent",
                config: {
                  provider: "codex",
                  model: "gpt-5.4",
                },
              },
              error: null,
            };
          }

          return { data: null, error: null };
        }),
      };

      return chain;
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst_123/profiles?sync=true"),
      { params: Promise.resolve({ id: "inst_123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(Array.isArray(json.data)).toBe(true);
    expect(json.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "default",
          display_name: "Recovered Agent",
        }),
      ])
    );
    expect(log.warn).toHaveBeenCalledWith(
      "live profile sync failed; falling back to stored rows",
      expect.objectContaining({
        instanceId: "inst_123",
        userId: "user_123",
        failureType: "live_profile_sync_failed",
      }),
      expect.anything(),
    );
    // Inspect msg + ctx args only (skip err — logger redacts in production).
    const messageAndCtxArgs = (log.warn as jest.Mock).mock.calls
      .map((args) => [args[0], args[1]])
      .flat()
      .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
      .join(" ");
    expect(messageAndCtxArgs).not.toContain("super-secret");
  });

  it("does not log raw database text when profile rows cannot be loaded", async () => {
    mockedFrom.mockImplementation((table: string) => {
      const chain: {
        select: jest.Mock;
        eq: jest.Mock;
        order: jest.Mock;
        single: jest.Mock;
      } = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        order: jest.fn().mockResolvedValue(
          table === "profiles"
            ? {
                data: null,
                error: { message: "profiles replica shard 11 failed" },
              }
            : {
                data: null,
                error: null,
              }
        ),
        single: jest.fn().mockResolvedValue(
          table === "hermes_instances"
            ? {
                data: {
                  name: "Managed Agent",
                  config: {
                    provider: "codex",
                    model: "gpt-5.4",
                  },
                },
                error: null,
              }
            : { data: null, error: null }
        ),
      };

      return chain;
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst_123/profiles"),
      { params: Promise.resolve({ id: "inst_123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error).toBe("Failed to fetch profiles");
    expect(JSON.stringify(json)).not.toContain("profiles replica shard 11 failed");
    expect(consoleErrorSpy.mock.calls.flat().join(" ")).not.toContain("profiles replica shard 11 failed");
  });
});
