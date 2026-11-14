/** @jest-environment node */
/**
 * $HIVRA from the hermesos_lock wallet. Refused while $HIVRA is dormant or
 * only scheduled (nothing read, claimed, minted or sent); once live, the live
 * $HIVRA balance is read from the $HIVRA contract and the whole of it is sent
 * as an ERC-20 transfer of that contract, with the exact raw amount. The
 * $HERMESOS lane is unchanged either way.
 */
const mockLaunch = { contractAddress: "", decimals: 18, poolId: "", activatesAt: "" };
jest.mock("@/lib/billing/hivra-token-launch", () => ({ HIVRA_TOKEN_LAUNCH: mockLaunch }));

const mockInserts: Record<string, unknown>[] = [];
jest.mock("@/lib/supabase", () => {
  const chain = (result: unknown): unknown =>
    new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (prop === "then") return (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
          if (prop === "maybeSingle" || prop === "single") return async () => result;
          return () => chain(result);
        },
      }
    );
  return {
    supabaseAdmin: {
      from: () => ({
        insert: (payload: Record<string, unknown>) => {
          mockInserts.push(payload);
          return chain({ data: { id: "claim_1" }, error: null });
        },
        update: () => chain({ error: null }),
      }),
    },
  };
});
const mockGetLockWallet = jest.fn();
jest.mock("../token-holdings", () => ({
  ...jest.requireActual("../token-holdings"),
  getHermesLockWallet: (...args: unknown[]) => mockGetLockWallet(...args),
}));
jest.mock("../withdraw-address", () => ({
  getUserWithdrawAddress: jest.fn(async () => ({
    normalizedAddress: "0x1111111111111111111111111111111111111111",
    setAt: "2026-01-01T00:00:00.000Z",
  })),
}));
jest.mock("../bankr-wallets", () => ({
  ...jest.requireActual("../bankr-wallets"),
  getBankrPartnerConfig: () => ({ partnerKey: "partner", apiBaseUrl: "https://bankr.test" }),
}));
jest.mock("../bankr-deposit-wallets", () => ({
  getBankrDepositWalletCredentialForUser: jest.fn(async () => ({ bankrWalletId: "bw_1" })),
}));
jest.mock("../treasury-gas", () => ({
  ensureWalletHasGas: jest.fn(async () => ({ status: "already_funded" })),
}));

import { withdrawAllHermesTokensForUser } from "../bankr-withdraw";
import { HERMESOS_TOKEN } from "../token-registry";

const HIVRA_PUBLISHED = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
const HIVRA_ADDRESS = HIVRA_PUBLISHED.toLowerCase();
const LOCK_WALLET = "0x00000000000000000000000000000000000010c4";
const RPC_URL = "https://rpc.test";
// 1,234,567.890123456789012345 tokens: needs every one of 18 decimals.
const BALANCE_RAW = 1234567890123456789012345n;
const NOW = new Date("2026-11-01T00:00:00Z");

function launch(activatesAt: string) {
  mockLaunch.contractAddress = HIVRA_PUBLISHED;
  mockLaunch.poolId = `0x${"cd".repeat(32)}`;
  mockLaunch.activatesAt = activatesAt;
}

function makeFetch() {
  const rpcTargets: string[] = [];
  const transfers: Record<string, unknown>[] = [];
  const fetchImpl = jest.fn(async (url: string, init: { body?: string }) => {
    if (url === RPC_URL) {
      const call = JSON.parse(init.body ?? "{}") as { method: string; params: Array<{ to?: string }> };
      if (call.method === "eth_call") {
        rpcTargets.push(String(call.params[0]?.to));
        return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: `0x${BALANCE_RAW.toString(16)}` }) };
      }
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x10" }) };
    }
    if (url.includes("/api-keys")) return { ok: true, status: 200, json: async () => ({ apiKey: "k" }) };
    transfers.push(JSON.parse(init.body ?? "{}"));
    return { ok: true, status: 200, json: async () => ({ txHash: `0x${"ab".repeat(32)}` }), text: async () => "" };
  });
  return { fetchImpl, rpcTargets, transfers };
}

beforeEach(() => {
  mockLaunch.contractAddress = "";
  mockLaunch.poolId = "";
  mockLaunch.activatesAt = "";
  mockInserts.length = 0;
  mockGetLockWallet.mockReset();
  mockGetLockWallet.mockResolvedValue({ id: "lock", address: LOCK_WALLET });
});

describe("lock-wallet $HIVRA withdraw", () => {
  it("refuses $HIVRA while it is dormant, before reading or sending anything", async () => {
    const { fetchImpl } = makeFetch();
    const result = await withdrawAllHermesTokensForUser({
      userId: "user_1",
      asset: "HIVRA",
      rpcUrl: RPC_URL,
      fetchImpl: fetchImpl as never,
      now: NOW,
    });
    expect(result).toEqual({ status: "asset_unavailable", errorMessage: "$HIVRA withdrawals open once $HIVRA is live." });
    expect(mockGetLockWallet).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(mockInserts).toEqual([]);
  });

  it("refuses $HIVRA while it is only scheduled", async () => {
    launch("2026-12-01T00:00:00Z");
    const { fetchImpl } = makeFetch();
    const result = await withdrawAllHermesTokensForUser({
      userId: "user_1",
      asset: "HIVRA",
      rpcUrl: RPC_URL,
      fetchImpl: fetchImpl as never,
      now: NOW,
    });
    expect(result.status).toBe("asset_unavailable");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("once live, reads the $HIVRA contract and sends the whole balance as an ERC-20 transfer of $HIVRA", async () => {
    launch("2026-10-01T00:00:00Z");
    const { fetchImpl, rpcTargets, transfers } = makeFetch();
    const result = await withdrawAllHermesTokensForUser({
      userId: "user_1",
      asset: "HIVRA",
      rpcUrl: RPC_URL,
      fetchImpl: fetchImpl as never,
      now: NOW,
    });
    expect(result).toMatchObject({
      status: "submitted",
      amountRaw: BALANCE_RAW.toString(),
      amountDisplay: "1234567.890123456789012345",
      recipientAddress: "0x1111111111111111111111111111111111111111",
    });
    expect(rpcTargets).toEqual([HIVRA_ADDRESS]);
    expect(transfers).toEqual([
      {
        tokenAddress: HIVRA_ADDRESS,
        recipientAddress: "0x1111111111111111111111111111111111111111",
        amount: "1234567.890123456789012345",
        isNativeToken: false,
      },
    ]);
    // The claim row names its token, so the ledger never reads it as $HermesOS.
    expect(mockInserts).toEqual([
      {
        user_id: "user_1",
        status: "in_flight",
        amount_raw: BALANCE_RAW.toString(),
        recipient: "0x1111111111111111111111111111111111111111",
        chain: "base",
        token_symbol: "HIVRA",
        token_address: HIVRA_ADDRESS,
        token_decimals: 18,
      },
    ]);
  });

  it.each([
    ["dormant", ""],
    ["live", "2026-10-01T00:00:00Z"],
  ])("keeps the $HERMESOS withdraw unchanged while $HIVRA is %s", async (_label, activatesAt) => {
    if (activatesAt) launch(activatesAt);
    const { fetchImpl, rpcTargets, transfers } = makeFetch();
    const result = await withdrawAllHermesTokensForUser({
      userId: "user_1",
      rpcUrl: RPC_URL,
      fetchImpl: fetchImpl as never,
      now: NOW,
    });
    expect(result.status).toBe("submitted");
    expect(rpcTargets).toEqual([HERMESOS_TOKEN.address]);
    expect(transfers).toEqual([
      {
        tokenAddress: HERMESOS_TOKEN.address,
        recipientAddress: "0x1111111111111111111111111111111111111111",
        amount: "1234567.890123456789012345",
        isNativeToken: false,
      },
    ]);
    // The original claim shape: no token columns.
    expect(mockInserts).toEqual([
      {
        user_id: "user_1",
        status: "in_flight",
        amount_raw: BALANCE_RAW.toString(),
        recipient: "0x1111111111111111111111111111111111111111",
      },
    ]);
  });
});
