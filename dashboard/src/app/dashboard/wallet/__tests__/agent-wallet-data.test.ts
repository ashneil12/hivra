import { loadAgentWalletsFromApi } from "../agent-wallet-data";

describe("agent wallet data loading", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500) {
    return {
      ok,
      status,
      json: jest.fn().mockResolvedValue(body),
    } as unknown as Response;
  }

  it("loads running-agent wallet status without auto-provisioning missing wallets", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({
        data: [
          { id: "inst_pending", name: "Sparrow", status: "running", provider: "openai" },
          { id: "inst_stopped", name: "Dormant", status: "stopped", provider: "openai" },
        ],
      }))
      // /api/hivra/agents fires in the same Promise.all tick — call 2.
      .mockResolvedValueOnce(jsonResponse({ data: { agents: [] } }))
      .mockResolvedValueOnce(jsonResponse({
        data: {
          wallet: {
            evmAddress: null,
            bankrWalletId: null,
            status: "pending",
            withdrawalDestinationEvm: "0x1111111111111111111111111111111111111111",
            apiKeyStatus: "missing",
          },
          balance: null,
          balances: [],
        },
      }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await loadAgentWalletsFromApi();

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/instances?summary=true", { method: "GET" });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/hivra/agents", { method: "GET" });
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/instances/inst_pending/bankr-wallet", { method: "GET" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result).toEqual({
      totalAgents: 2,
      cards: [
        {
          instance: { id: "inst_pending", name: "Sparrow", status: "running", provider: "openai", lane: "hermes" },
          wallet: {
            evmAddress: null,
            bankrWalletId: null,
            status: "pending",
            withdrawalDestinationEvm: "0x1111111111111111111111111111111111111111",
            apiKeyStatus: "missing",
          },
          balance: null,
          balances: [],
          withdrawalRecipients: [],
          balanceFailed: false,
          balanceError: null,
        },
      ],
    });
  });

  it("marks balance failures as retryable with request context when the API fails soft", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({
        data: [{ id: "inst_active", name: "Sparrow", status: "running", provider: "openai" }],
      }))
      .mockResolvedValueOnce(jsonResponse({ data: { agents: [] } }))
      .mockResolvedValueOnce(jsonResponse({
        data: {
          wallet: {
            evmAddress: "0x1111111111111111111111111111111111111111",
            bankrWalletId: "wlt_123",
            status: "active",
            withdrawalDestinationEvm: null,
            apiKeyStatus: "active",
          },
          balance: null,
          balances: null,
          balanceError: {
            failureType: "bankr_instance_wallet_balance_rpc_failed",
            retryable: true,
            requestId: "req_wallet_rpc_123",
            message: "Balance temporarily unavailable. Your wallet address is still usable; retry the balance check shortly.",
          },
        },
      }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await loadAgentWalletsFromApi();

    expect(result.cards[0]).toMatchObject({
      balance: null,
      balances: [],
      balanceFailed: true,
      balanceError: {
        failureType: "bankr_instance_wallet_balance_rpc_failed",
        retryable: true,
        requestId: "req_wallet_rpc_123",
      },
    });
  });

  it("preserves the pending card without retrying provisioning", async () => {
    const pendingWallet = {
      evmAddress: null,
      bankrWalletId: null,
      status: "pending" as const,
      withdrawalDestinationEvm: null,
      apiKeyStatus: "missing" as const,
    };
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({
        data: [{ id: "inst_pending", name: "Sparrow", status: "running", provider: "openai" }],
      }))
      .mockResolvedValueOnce(jsonResponse({ data: { agents: [] } }))
      .mockResolvedValueOnce(jsonResponse({ data: { wallet: pendingWallet, balance: null, balances: [] } }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await loadAgentWalletsFromApi();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.cards[0]).toMatchObject({
      wallet: pendingWallet,
      balance: null,
      balances: [],
      balanceFailed: false,
      balanceError: null,
    });
  });

  it("lists running Hivra CLI boxes as hivra-lane cards via their own wallet route", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: [] }))
      .mockResolvedValueOnce(jsonResponse({
        data: {
          agents: [
            { id: "box_codex", name: "Moneymaker", status: "running", type: "codex" },
            { id: "box_aeon", name: "Background", status: "running", type: "aeon" },
            { id: "box_stopped", name: "Off", status: "stopped", type: "claude-code" },
          ],
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        data: { wallet: null, balance: null, balances: [] },
      }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await loadAgentWalletsFromApi();

    // Only the running CLI box gets a card — aeon and stopped boxes are excluded.
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/hivra/agents/box_codex/bankr-wallet", { method: "GET" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.totalAgents).toBe(1);
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0].instance).toEqual({
      id: "box_codex",
      name: "Moneymaker",
      status: "running",
      provider: "codex",
      lane: "hivra",
    });
  });

  it("keeps the wallet page hermes-only when the hivra lane is disabled (404)", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({
        data: [{ id: "inst_active", name: "Sparrow", status: "running", provider: "openai" }],
      }))
      .mockResolvedValueOnce(jsonResponse({ error: "Not found" }, false, 404))
      .mockResolvedValueOnce(jsonResponse({
        data: { wallet: null, balance: null, balances: [] },
      }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await loadAgentWalletsFromApi();

    expect(result.totalAgents).toBe(1);
    expect(result.cards[0].instance.lane).toBe("hermes");
  });
});
