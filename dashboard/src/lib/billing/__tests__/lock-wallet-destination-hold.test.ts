/** @jest-environment node */
/**
 * The lock-wallet withdraw sends the whole balance to the saved withdraw
 * address, or moves it to the verified primary wallet. Either destination is
 * held for the cooldown after it was set: a session that has just saved a new
 * address (or verified a new wallet) cannot empty the lock wallet into it at
 * once. Nothing is claimed and no Bankr key is minted while it is held.
 */
const mockClaimInserts: unknown[] = [];
const mockPrimaryWallet: { current: Record<string, unknown> | null } = { current: null };

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
        select: () => chain({ data: mockPrimaryWallet.current, error: null }),
        insert: (row: unknown) => {
          mockClaimInserts.push(row);
          return chain({ data: { id: "claim_1" }, error: null });
        },
        update: () => chain({ error: null }),
      }),
    },
  };
});

const mockGetUserWithdrawAddress = jest.fn();
jest.mock("../withdraw-address", () => ({
  getUserWithdrawAddress: (...args: unknown[]) => mockGetUserWithdrawAddress(...args),
}));
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

const HOUR = 60 * 60 * 1000;
const SAVED = "0x1111111111111111111111111111111111111111";
const OWN = "0x0000000000000000000000000000000000000abc";

function bankrFetch() {
  return jest.fn(async (url: string) => {
    if (url.includes("/api-keys")) return { ok: true, status: 200, json: async () => ({ apiKey: "k" }) };
    return { ok: true, status: 200, json: async () => ({ txHash: `0x${"ab".repeat(32)}` }), text: async () => "" };
  });
}

function savedAddress(setAt: string) {
  return {
    userId: "user_1",
    address: SAVED,
    normalizedAddress: SAVED,
    network: "base",
    acknowledgedResponsibility: true,
    setAt,
    updatedAt: setAt,
  };
}

beforeEach(() => {
  mockClaimInserts.length = 0;
  mockGetUserWithdrawAddress.mockReset();
  mockPrimaryWallet.current = null;
});

it("holds a withdraw to an address saved an hour ago: nothing is claimed or sent", async () => {
  mockGetUserWithdrawAddress.mockResolvedValue(savedAddress(new Date(Date.now() - HOUR).toISOString()));
  const fetchImpl = bankrFetch();

  const result = await withdrawAllHermesTokensForUser({ userId: "user_1", fetchImpl: fetchImpl as never });

  // A refusal the withdraw route already answers with 422 and this message.
  expect(result.status).toBe("no_withdraw_address");
  expect(Date.parse((result as { availableAt?: string }).availableAt ?? "")).toBeGreaterThan(Date.now());
  expect(result.errorMessage).toMatch(/withdraw address was saved less than 24 hours ago/);
  expect(mockClaimInserts).toEqual([]);
  expect(fetchImpl).not.toHaveBeenCalled();
});

it("withdraws to an address saved before the cooldown", async () => {
  mockGetUserWithdrawAddress.mockResolvedValue(savedAddress(new Date(Date.now() - 48 * HOUR).toISOString()));
  const fetchImpl = bankrFetch();

  const result = await withdrawAllHermesTokensForUser({ userId: "user_1", fetchImpl: fetchImpl as never });

  expect(result).toMatchObject({ status: "submitted", recipientAddress: SAVED });
});

it("holds a move to a wallet verified an hour ago", async () => {
  mockPrimaryWallet.current = {
    id: "own",
    address: OWN,
    normalized_address: OWN,
    verification_method: "signature",
    verified_at: new Date(Date.now() - HOUR).toISOString(),
  };
  const fetchImpl = bankrFetch();

  const result = await withdrawAllHermesTokensForUser({
    userId: "user_1",
    destination: "verified_wallet",
    fetchImpl: fetchImpl as never,
  });

  expect(result.status).toBe("no_verified_wallet");
  expect(result.errorMessage).toMatch(/Your wallet was verified less than 24 hours ago/);
  expect(mockClaimInserts).toEqual([]);
  expect(fetchImpl).not.toHaveBeenCalled();
});

it("moves to a wallet verified before the cooldown", async () => {
  mockPrimaryWallet.current = {
    id: "own",
    address: OWN,
    normalized_address: OWN,
    verification_method: "signature",
    verified_at: new Date(Date.now() - 48 * HOUR).toISOString(),
  };
  const fetchImpl = bankrFetch();

  const result = await withdrawAllHermesTokensForUser({
    userId: "user_1",
    destination: "verified_wallet",
    fetchImpl: fetchImpl as never,
  });

  expect(result).toMatchObject({ status: "submitted", recipientAddress: OWN });
});
