import {
  buildHermesConfigWithInstanceBankrWallet,
  buildHermesConfigWithComposioMcp,
  putHermesConfigWithBindMountFallback,
} from "@/lib/hermes-config-write";
import {
  decryptInstanceBankrRuntimeApiKey,
  getBankrWalletForInstance,
} from "@/lib/billing/bankr-instance-wallets";
import { supabaseAdmin } from "@/lib/supabase";

jest.mock("@/lib/billing/bankr-instance-wallets", () => ({
  decryptInstanceBankrRuntimeApiKey: jest.fn(),
  getBankrWalletForInstance: jest.fn(),
}));

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

describe("Hermes config Composio MCP reconciliation", () => {
  const entry = {
    url: "https://backend.composio.dev/v3/mcp/srv_1?user_id=user_123",
    headers: { "x-api-key": "ck_abc" },
  };

  it("PRESERVES config (same reference) when entry is undefined — general callers don't manage composio", () => {
    const config = {
      model: "claude",
      mcp_servers: { composio: entry, other: { url: "https://x" } },
    };
    const result = buildHermesConfigWithComposioMcp({ config });
    expect(result).toBe(config);
    expect((result.mcp_servers as Record<string, unknown>).composio).toBeDefined();
    expect((result.mcp_servers as Record<string, unknown>).other).toBeDefined();
  });

  it("sets the composio entry, stripping any prior one and keeping other servers", () => {
    const config = {
      model: "claude",
      mcp_servers: {
        composio: { url: "https://stale", headers: { "x-api-key": "old" } },
        other: { url: "https://x" },
      },
    };
    const result = buildHermesConfigWithComposioMcp({ config, entry });
    const servers = result.mcp_servers as Record<string, unknown>;
    expect(servers.composio).toEqual(entry);
    expect(servers.other).toBeDefined();
  });

  it("entry=null strips the managed composio entry, preserving other mcp_servers", () => {
    const config = { mcp_servers: { composio: entry, other: { url: "https://x" } } };
    const result = buildHermesConfigWithComposioMcp({ config, entry: null });
    const servers = result.mcp_servers as Record<string, unknown>;
    expect(servers.composio).toBeUndefined();
    expect(servers.other).toBeDefined();
  });

  it("removes mcp_servers entirely when composio was the only entry and entry=null", () => {
    const config = { model: "claude", mcp_servers: { composio: entry } };
    const result = buildHermesConfigWithComposioMcp({ config, entry: null });
    expect(result.mcp_servers).toBeUndefined();
  });

  it("strips the dead `pipedream` entry whenever it reconciles (migrated off it)", () => {
    const config = {
      mcp_servers: { pipedream: { url: "https://old" }, other: { url: "https://x" } },
    };
    const result = buildHermesConfigWithComposioMcp({ config, entry });
    const servers = result.mcp_servers as Record<string, unknown>;
    expect(servers.pipedream).toBeUndefined();
    expect(servers.composio).toEqual({ url: entry.url, headers: entry.headers });
    expect(servers.other).toBeDefined();
  });

  it("removes mcp_servers entirely when pipedream was the only (dead) entry and no key", () => {
    const config = { mcp_servers: { pipedream: { url: "https://old" } } };
    const result = buildHermesConfigWithComposioMcp({ config, entry: null });
    expect(result.mcp_servers).toBeUndefined();
  });

  it("bumps mcp_discovery_timeout to >=15 when setting composio (remote Tool Router is slow)", () => {
    // unset → bumped
    expect(buildHermesConfigWithComposioMcp({ config: {}, entry }).mcp_discovery_timeout).toBe(15);
    // too-low default (1.5) → bumped
    expect(
      buildHermesConfigWithComposioMcp({ config: { mcp_discovery_timeout: 1.5 }, entry }).mcp_discovery_timeout,
    ).toBe(15);
  });

  it("does NOT lower an already-generous mcp_discovery_timeout, nor touch it when stripping", () => {
    expect(
      buildHermesConfigWithComposioMcp({ config: { mcp_discovery_timeout: 30 }, entry }).mcp_discovery_timeout,
    ).toBe(30);
    // stripping (entry:null) leaves the timeout as-is
    expect(
      buildHermesConfigWithComposioMcp({ config: { mcp_discovery_timeout: 1.5 }, entry: null }).mcp_discovery_timeout,
    ).toBe(1.5);
  });
});

describe("Hermes config Bankr wallet injection", () => {
  const mockedGetWallet = getBankrWalletForInstance as jest.MockedFunction<typeof getBankrWalletForInstance>;
  const mockedDecrypt = decryptInstanceBankrRuntimeApiKey as jest.MockedFunction<typeof decryptInstanceBankrRuntimeApiKey>;
  const mockedFrom = supabaseAdmin!.from as jest.Mock;

  const wallet = {
    id: "row_1",
    instanceId: "inst_123",
    hivraAgentId: null,
    userId: "user_123",
    bankrWalletId: "wlt_123",
    evmAddress: "0x000000000000000000000000000000000000ba5e",
    normalizedEvmAddress: "0x000000000000000000000000000000000000ba5e",
    apiKeyPreview: "bk_agent_...cret",
    apiKeyStatus: "active" as const,
    withdrawalDestinationEvm: "0x000000000000000000000000000000000000feed",
    withdrawalDestinationSetAt: "2026-05-02T12:00:00.000Z",
    status: "active" as const,
    metadata: {},
    createdAt: "2026-05-02T12:00:00.000Z",
    updatedAt: "2026-05-02T12:00:00.000Z",
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetWallet.mockResolvedValue(wallet);
    mockedDecrypt.mockResolvedValue("bk_agent_cleartext_secret");
  });

  it("adds a transient bankr block when an active wallet exists", async () => {
    const config = await buildHermesConfigWithInstanceBankrWallet({
      instanceId: "inst_123",
      config: { model: { default: "nous/deep" } },
    });

    expect(config).toEqual({
      model: { default: "nous/deep" },
      bankr: {
        walletAddress: wallet.evmAddress,
        apiKey: "bk_agent_cleartext_secret",
        walletId: wallet.bankrWalletId,
        withdrawalDestination: wallet.withdrawalDestinationEvm,
      },
    });
  });

  it("omits the bankr block for pending wallets", async () => {
    mockedGetWallet.mockResolvedValue({ ...wallet, status: "pending" });

    const config = await buildHermesConfigWithInstanceBankrWallet({
      instanceId: "inst_123",
      config: { model: { default: "nous/deep" } },
    });

    expect(config).toEqual({ model: { default: "nous/deep" } });
    expect(mockedDecrypt).not.toHaveBeenCalled();
  });

  it("pushes the cleartext API key only to the agent API and never writes it to hermes_instances.config", async () => {
    const api = {
      baseUrl: "https://agent.example.test/web-api",
      get: jest.fn(),
      post: jest.fn(),
      put: jest.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
      del: jest.fn(),
    };

    await putHermesConfigWithBindMountFallback({
      api,
      config: { display: { streaming: true } },
      instanceId: "inst_123",
      containerName: "agent-inst_123",
      hermesHomeDir: "/opt/data",
      ip: "203.0.113.10",
      guestTarget: null,
    });

    expect(api.put).toHaveBeenCalledWith(
      "/api/config",
      {
        config: expect.objectContaining({
          display: { streaming: true },
          bankr: expect.objectContaining({ apiKey: "bk_agent_cleartext_secret" }),
        }),
      },
      { timeout: 20_000 }
    );
    expect(mockedFrom).not.toHaveBeenCalledWith("hermes_instances");
  });
});
