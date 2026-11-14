/** @jest-environment node */
/**
 * Agent wallet balances list $HIVRA (read from the $HIVRA contract, exact)
 * only once it is live; while it is dormant the token list is unchanged.
 */
const mockLaunch = { contractAddress: "", decimals: 18, poolId: "", activatesAt: "" };
jest.mock("@/lib/billing/hivra-token-launch", () => ({
  get HIVRA_TOKEN_LAUNCH() {
    return mockLaunch;
  },
}));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));

import { readInstanceBankrWalletBalances, trackedBaseErc20Tokens } from "../bankr-instance-wallets";

const HIVRA_PUBLISHED = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
const HIVRA_ADDRESS = HIVRA_PUBLISHED.toLowerCase();
const RPC_URL = "https://rpc.test";

function goLive() {
  mockLaunch.contractAddress = HIVRA_PUBLISHED;
  mockLaunch.poolId = `0x${"cd".repeat(32)}`;
  mockLaunch.activatesAt = "2026-01-01T00:00:00Z";
}

function rpcFetch(hivraRaw: bigint) {
  return jest.fn(async (_url: string, init: { body?: string }) => {
    const call = JSON.parse(init.body ?? "{}") as { method: string; params: Array<{ to?: string }> };
    const result =
      call.method === "eth_getBalance"
        ? "0x0"
        : call.params[0]?.to === HIVRA_ADDRESS
          ? `0x${hivraRaw.toString(16)}`
          : "0x0";
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) };
  });
}

beforeEach(() => {
  mockLaunch.contractAddress = "";
  mockLaunch.poolId = "";
  mockLaunch.activatesAt = "";
});

it("tracks the original token list while $HIVRA is dormant", () => {
  expect(trackedBaseErc20Tokens().map((token) => token.symbol)).toEqual(["USDC", "HERMESOS", "BNKR", "VVV", "DIEM"]);
});

it("adds $HIVRA right after HERMESOS once live, with the registry's address", () => {
  goLive();
  const tokens = trackedBaseErc20Tokens();
  expect(tokens.map((token) => token.symbol)).toEqual(["USDC", "HERMESOS", "HIVRA", "BNKR", "VVV", "DIEM"]);
  expect(tokens[2]).toEqual({ symbol: "HIVRA", address: HIVRA_ADDRESS, decimals: 18 });
});

it("does not add $HIVRA while it is only scheduled", () => {
  goLive();
  expect(trackedBaseErc20Tokens(new Date("2025-12-31T23:59:59Z")).map((token) => token.symbol)).not.toContain("HIVRA");
});

it("reports the exact live $HIVRA balance of an agent wallet once live", async () => {
  goLive();
  const balances = await readInstanceBankrWalletBalances({
    walletAddress: "0x000000000000000000000000000000000000a001",
    env: { HERMES_BASE_RPC_URL: RPC_URL },
    fetchImpl: rpcFetch(42000000000000000001n) as never,
  });
  expect(balances.find((balance) => balance.tokenSymbol === "HIVRA")).toEqual({
    chain: "Base",
    tokenSymbol: "HIVRA",
    tokenAddress: HIVRA_ADDRESS,
    tokenDecimals: 18,
    balanceDisplay: "42.000000000000000001",
  });
});

it("lists no $HIVRA balance while dormant", async () => {
  const balances = await readInstanceBankrWalletBalances({
    walletAddress: "0x000000000000000000000000000000000000a002",
    env: { HERMES_BASE_RPC_URL: RPC_URL },
    fetchImpl: rpcFetch(1n) as never,
  });
  expect(balances.map((balance) => balance.tokenSymbol)).toEqual(["ETH", "USDC", "HERMESOS", "BNKR", "VVV", "DIEM"]);
});
