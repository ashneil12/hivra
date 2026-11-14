/** @jest-environment node */
/**
 * The HIVRA asset selector on agent wallets (both lanes). Refused while
 * $HIVRA is dormant or only scheduled, before the wallet, key, balance or
 * claim is touched; once live it reads the $HIVRA contract and sends an
 * ERC-20 transfer of it for the exact amount asked. HERMESOS and ETH keep
 * their original transfers.
 */
const mockLaunch = { contractAddress: "", decimals: 18, poolId: "", activatesAt: "" };
jest.mock("@/lib/billing/hivra-token-launch", () => ({ HIVRA_TOKEN_LAUNCH: mockLaunch }));

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));

const mockGetWalletForInstance = jest.fn();
const mockGetWalletForOwner = jest.fn();
const mockDecryptApiKey = jest.fn();
jest.mock("@/lib/billing/bankr-instance-wallets", () => ({
  decryptInstanceBankrApiKey: (...args: unknown[]) => mockDecryptApiKey(...args),
  getBankrWalletForInstance: (...args: unknown[]) => mockGetWalletForInstance(...args),
  getBankrWalletForOwner: (...args: unknown[]) => mockGetWalletForOwner(...args),
  instanceBankrWalletPublicSummary: () => ({ status: "active" }),
  upsertWithdrawalRecipient: jest.fn(),
}));

jest.mock("@/lib/billing/bankr-wallets", () => ({
  ...jest.requireActual("@/lib/billing/bankr-wallets"),
  getBankrPartnerConfig: () => ({ partnerKey: "partner", apiBaseUrl: "https://bankr.test" }),
}));

import {
  withdrawForOwner,
  withdrawHermesTokensForInstance,
  withdrawHivraTokensForInstance,
  withdrawBaseEthForInstance,
} from "../bankr-instance-withdraw";
import { HERMESOS_TOKEN } from "../token-registry";

const HIVRA_PUBLISHED = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
const HIVRA_ADDRESS = HIVRA_PUBLISHED.toLowerCase();
const RPC_URL = "https://rpc.test";
const DESTINATION = "0x1111111111111111111111111111111111111111";
const BALANCE_RAW = 5000000000000000000000000n; // 5,000,000 tokens
const NOW = new Date("2026-11-01T00:00:00Z");

const record = {
  id: "row_1",
  instanceId: "inst_1",
  userId: "user_1",
  bankrWalletId: "wlt_1",
  evmAddress: "0x000000000000000000000000000000000000ba5e",
  normalizedEvmAddress: "0x000000000000000000000000000000000000ba5e",
  apiKeyPreview: "bk_...key",
  apiKeyStatus: "active" as const,
  withdrawalDestinationEvm: DESTINATION,
  withdrawalDestinationSetAt: "2026-01-01T00:00:00.000Z",
  status: "active" as const,
  metadata: {},
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function launch(activatesAt: string) {
  mockLaunch.contractAddress = HIVRA_PUBLISHED;
  mockLaunch.poolId = `0x${"cd".repeat(32)}`;
  mockLaunch.activatesAt = activatesAt;
}

function makeDb() {
  const inserts: Record<string, unknown>[] = [];
  const single = jest.fn(async () => ({ data: { id: "claim_1" }, error: null }));
  const insert = jest.fn((payload: Record<string, unknown>) => {
    inserts.push(payload);
    return { select: () => ({ single }) };
  });
  const update = jest.fn(() => ({ eq: jest.fn(async () => ({ error: null })) }));
  return { db: { from: jest.fn(() => ({ insert, update })) } as never, inserts };
}

function makeFetch() {
  const rpcCalls: Array<{ method: string; to?: string }> = [];
  const transfers: Array<{ apiKey: string | undefined; body: Record<string, unknown> }> = [];
  const fetchImpl = jest.fn(async (url: string, init: { body?: string; headers?: Record<string, string> }) => {
    if (url === RPC_URL) {
      const call = JSON.parse(init.body ?? "{}") as { method: string; params: Array<{ to?: string }> };
      rpcCalls.push({ method: call.method, to: call.params?.[0]?.to });
      const result = call.method === "eth_blockNumber" ? "0x10" : `0x${BALANCE_RAW.toString(16)}`;
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) };
    }
    transfers.push({ apiKey: init.headers?.["X-API-Key"], body: JSON.parse(init.body ?? "{}") });
    return { ok: true, status: 200, json: async () => ({ txHash: `0x${"ab".repeat(32)}` }), text: async () => "" };
  });
  return { fetchImpl, rpcCalls, transfers };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLaunch.contractAddress = "";
  mockLaunch.poolId = "";
  mockLaunch.activatesAt = "";
  mockGetWalletForInstance.mockResolvedValue(record);
  mockGetWalletForOwner.mockResolvedValue(record);
  mockDecryptApiKey.mockResolvedValue("bk_agent_secret");
});

describe("agent wallet HIVRA withdraw", () => {
  it.each([
    ["dormant", ""],
    ["scheduled", "2026-12-01T00:00:00Z"],
  ])("refuses HIVRA while $HIVRA is %s, before touching the wallet", async (_label, activatesAt) => {
    if (activatesAt) launch(activatesAt);
    const { db, inserts } = makeDb();
    const { fetchImpl } = makeFetch();

    const results = [
      await withdrawHivraTokensForInstance({
        instanceId: "inst_1",
        userId: "user_1",
        amountDisplay: "1",
        rpcUrl: RPC_URL,
        fetchImpl: fetchImpl as never,
        db,
        now: NOW,
      }),
      await withdrawForOwner({
        owner: { hivraAgentId: "agent_1" },
        userId: "user_1",
        amountDisplay: "1",
        asset: "HIVRA",
        rpcUrl: RPC_URL,
        fetchImpl: fetchImpl as never,
        db,
        now: NOW,
      }),
    ];

    for (const result of results) {
      expect(result).toEqual({ status: "invalid_token", errorMessage: "$HIVRA withdrawals open once $HIVRA is live." });
    }
    expect(mockGetWalletForInstance).not.toHaveBeenCalled();
    expect(mockGetWalletForOwner).not.toHaveBeenCalled();
    expect(mockDecryptApiKey).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(inserts).toEqual([]);
  });

  it("once live, sends an ERC-20 transfer of the $HIVRA contract for the exact amount (instance lane)", async () => {
    launch("2026-10-01T00:00:00Z");
    const { db, inserts } = makeDb();
    const { fetchImpl, rpcCalls, transfers } = makeFetch();

    const result = await withdrawHivraTokensForInstance({
      instanceId: "inst_1",
      userId: "user_1",
      amountDisplay: "1,234.000000000000000001",
      rpcUrl: RPC_URL,
      fetchImpl: fetchImpl as never,
      db,
      now: NOW,
    });

    expect(result).toMatchObject({
      status: "submitted",
      amountRaw: "1234000000000000000001",
      amountDisplay: "1234.000000000000000001",
      recipientAddress: DESTINATION,
    });
    expect(rpcCalls.filter((call) => call.method === "eth_call").map((call) => call.to)).toEqual([HIVRA_ADDRESS]);
    expect(transfers).toEqual([
      {
        apiKey: "bk_agent_secret",
        body: {
          tokenAddress: HIVRA_ADDRESS,
          recipientAddress: DESTINATION,
          amount: "1234.000000000000000001",
          isNativeToken: false,
        },
      },
    ]);
    expect(inserts).toEqual([
      expect.objectContaining({
        amount_raw: "1234000000000000000001",
        recipient: DESTINATION,
        chain: "base",
        token_symbol: "HIVRA",
        token_address: HIVRA_ADDRESS,
        token_decimals: 18,
      }),
    ]);
  });

  it("once live, the owner lane resolves the wallet by owner and sends $HIVRA", async () => {
    launch("2026-10-01T00:00:00Z");
    const { db } = makeDb();
    const { fetchImpl, transfers } = makeFetch();

    const result = await withdrawForOwner({
      owner: { hivraAgentId: "agent_1" },
      userId: "user_1",
      amountDisplay: "2",
      asset: "HIVRA",
      rpcUrl: RPC_URL,
      fetchImpl: fetchImpl as never,
      db,
      now: NOW,
    });

    expect(result.status).toBe("submitted");
    expect(mockGetWalletForOwner).toHaveBeenCalledWith(expect.objectContaining({ owner: { hivraAgentId: "agent_1" } }));
    expect(mockGetWalletForInstance).not.toHaveBeenCalled();
    expect(transfers.map((transfer) => transfer.body)).toEqual([
      { tokenAddress: HIVRA_ADDRESS, recipientAddress: DESTINATION, amount: "2", isNativeToken: false },
    ]);
  });

  it("refuses more $HIVRA than the live balance", async () => {
    launch("2026-10-01T00:00:00Z");
    const { db, inserts } = makeDb();
    const { fetchImpl, transfers } = makeFetch();

    const result = await withdrawHivraTokensForInstance({
      instanceId: "inst_1",
      userId: "user_1",
      amountDisplay: "5000000.000000000000000001",
      rpcUrl: RPC_URL,
      fetchImpl: fetchImpl as never,
      db,
      now: NOW,
    });

    expect(result.status).toBe("insufficient_balance");
    expect(result.errorMessage).toBe("Requested withdrawal amount exceeds the live $HIVRA balance (5000000).");
    expect(transfers).toEqual([]);
    expect(inserts).toEqual([]);
  });

  it.each([
    ["dormant", ""],
    ["live", "2026-10-01T00:00:00Z"],
  ])("keeps HERMESOS and ETH transfers unchanged while $HIVRA is %s", async (_label, activatesAt) => {
    if (activatesAt) launch(activatesAt);
    const { db, inserts } = makeDb();
    const { fetchImpl, transfers } = makeFetch();
    fetchImpl.mockImplementation(async (url: string, init: { body?: string; headers?: Record<string, string> }) => {
      if (url === RPC_URL) {
        const call = JSON.parse(init.body ?? "{}") as { method: string };
        const result = call.method === "eth_blockNumber" ? "0x10" : `0x${BALANCE_RAW.toString(16)}`;
        return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) } as never;
      }
      transfers.push({ apiKey: init.headers?.["X-API-Key"], body: JSON.parse(init.body ?? "{}") });
      return { ok: true, status: 200, json: async () => ({ txHash: "0xabc" }), text: async () => "" } as never;
    });

    const hermes = await withdrawHermesTokensForInstance({
      instanceId: "inst_1",
      userId: "user_1",
      amountDisplay: "3",
      rpcUrl: RPC_URL,
      fetchImpl: fetchImpl as never,
      db,
      now: NOW,
    });
    const eth = await withdrawBaseEthForInstance({
      instanceId: "inst_1",
      userId: "user_1",
      amountDisplay: "0.5",
      rpcUrl: RPC_URL,
      fetchImpl: fetchImpl as never,
      db,
      now: NOW,
    });

    expect(hermes.status).toBe("submitted");
    expect(eth.status).toBe("submitted");
    expect(transfers.map((transfer) => transfer.body)).toEqual([
      { tokenAddress: HERMESOS_TOKEN.address, recipientAddress: DESTINATION, amount: "3", isNativeToken: false },
      {
        tokenAddress: "0x0000000000000000000000000000000000000000",
        recipientAddress: DESTINATION,
        amount: "0.5",
        isNativeToken: true,
      },
    ]);
    expect(inserts.map((row) => [row.token_symbol, row.token_address])).toEqual([
      ["HERMESOS", HERMESOS_TOKEN.address],
      ["ETH", null],
    ]);
  });
});
