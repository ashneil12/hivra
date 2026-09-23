/** @jest-environment node */
/**
 * withdrawAllHermesTokensForUser's beforeTransfer hook (the lock-wallet move
 * writes its breach hold there): it runs with the live amount before the
 * transfer is submitted, and if it throws nothing is sent and the claim row
 * is released as cancelled.
 */
const mockClaimUpdates: Record<string, unknown>[] = [];
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
      from: (table: string) => ({
        select: () =>
          chain({
            data: { id: "own", address: "0x0000000000000000000000000000000000000abc", normalized_address: "0x0000000000000000000000000000000000000abc" },
            error: null,
          }),
        insert: () => chain({ data: { id: "claim_1" }, error: null }),
        update: (payload: Record<string, unknown>) => {
          if (table === "bankr_withdrawals") mockClaimUpdates.push(payload);
          return chain({ error: null });
        },
      }),
    },
  };
});
jest.mock("../token-holdings", () => ({
  ...jest.requireActual("../token-holdings"),
  getHermesLockWallet: jest.fn(async () => ({ id: "lock", address: "0x00000000000000000000000000000000000010c4" })),
  fetchHermesTokenBalance: jest.fn(async () => ({ balanceRaw: "5000000000000000000000000", balanceDisplay: "5000000" })),
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

function bankrFetch() {
  return jest.fn(async (url: string) => {
    if (url.includes("/api-keys")) return { ok: true, status: 200, json: async () => ({ apiKey: "k" }) };
    return { ok: true, status: 200, json: async () => ({ txHash: `0x${"ab".repeat(32)}` }), text: async () => "" };
  });
}

beforeEach(() => {
  mockClaimUpdates.length = 0;
});

it("runs the hook with the live amount before the transfer is submitted", async () => {
  const fetchImpl = bankrFetch();
  const order: string[] = [];
  fetchImpl.mockImplementation(async (url: string) => {
    order.push(url.includes("/api-keys") ? "mint" : "transfer");
    if (url.includes("/api-keys")) return { ok: true, status: 200, json: async () => ({ apiKey: "k" }) };
    return { ok: true, status: 200, json: async () => ({ txHash: `0x${"ab".repeat(32)}` }), text: async () => "" };
  });
  const result = await withdrawAllHermesTokensForUser({
    userId: "user_1",
    destination: "verified_wallet",
    fetchImpl: fetchImpl as never,
    beforeTransfer: async (amountRaw, claimId) => {
      order.push(`hold:${amountRaw}:${claimId}`);
    },
  });
  expect(result.status).toBe("submitted");
  expect(order).toEqual(["mint", "hold:5000000000000000000000000:claim_1", "transfer"]);
});

it("sends nothing and cancels the claim when the hook throws", async () => {
  const fetchImpl = bankrFetch();
  const result = await withdrawAllHermesTokensForUser({
    userId: "user_1",
    destination: "verified_wallet",
    fetchImpl: fetchImpl as never,
    beforeTransfer: async () => {
      throw new Error("hold not written");
    },
  });
  expect(result).toMatchObject({ status: "transfer_failed", errorMessage: "hold not written" });
  expect(fetchImpl.mock.calls.map(([url]) => url).filter((url) => !url.includes("/api-keys"))).toEqual([]);
  expect(mockClaimUpdates).toEqual([expect.objectContaining({ status: "cancelled", error_message: "hold not written" })]);
});
