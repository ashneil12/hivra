const mockGetWalletForOwner = jest.fn();
const mockGetWalletForInstance = jest.fn();
const mockDecryptApiKey = jest.fn();
const mockSummary = jest.fn();
const mockSetDestinationForOwner = jest.fn();
const mockUpsertWithdrawalRecipient = jest.fn();
const mockFetchHermesBalance = jest.fn();
const mockFetchTokenBalance = jest.fn();
const mockSubmitTransfer = jest.fn();
const mockLogWarn = jest.fn();

jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: null,
}));

jest.mock("@/lib/billing/bankr-instance-wallets", () => ({
  decryptInstanceBankrApiKey: (...args: unknown[]) => mockDecryptApiKey(...args),
  getBankrWalletForOwner: (...args: unknown[]) => mockGetWalletForOwner(...args),
  // If withdrawForOwner EVER calls the instance-locked resolver, that's a
  // money bug (it would target the wrong wallet). Wire it to throw so any such
  // call fails the test loudly.
  getBankrWalletForInstance: (...args: unknown[]) => {
    mockGetWalletForInstance(...args);
    throw new Error("withdrawForOwner must not call getBankrWalletForInstance");
  },
  instanceBankrWalletPublicSummary: (...args: unknown[]) => mockSummary(...args),
  setWithdrawalDestinationForOwner: (...args: unknown[]) => mockSetDestinationForOwner(...args),
  upsertWithdrawalRecipient: (...args: unknown[]) => mockUpsertWithdrawalRecipient(...args),
}));

jest.mock("@/lib/billing/token-holdings", () => {
  const actual = jest.requireActual("@/lib/billing/token-holdings");
  return {
    ...actual,
    fetchHermesTokenBalance: (...args: unknown[]) => mockFetchHermesBalance(...args),
    fetchTokenBalance: (...args: unknown[]) => mockFetchTokenBalance(...args),
    HERMESOS_TOKEN_ADDRESS: "0x95ccfd2b81a9667b0cc979992632f98fc853eba3",
  };
});

jest.mock("@/lib/billing/bankr-withdraw", () => ({
  submitBankrTransfer: (...args: unknown[]) => mockSubmitTransfer(...args),
}));

jest.mock("@/lib/logger", () => ({
  log: {
    warn: (...args: unknown[]) => mockLogWarn(...args),
  },
}));

import { withdrawForOwner } from "../bankr-instance-withdraw";

// A claim DB that records the ORDER of operations so we can assert the
// in-flight claim is inserted BEFORE the Bankr transfer is submitted.
function makeOrderedClaimDb(events: string[]) {
  const single = jest.fn(async () => {
    events.push("claim_insert");
    return { data: { id: "claim_owner_1" }, error: null };
  });
  const select = jest.fn(() => ({ single }));
  const insert = jest.fn(() => ({ select }));
  const eq = jest.fn(async () => {
    events.push("claim_finalize");
    return { data: null, error: null };
  });
  const update = jest.fn(() => ({ eq }));
  return { from: jest.fn(() => ({ insert, update })) } as never;
}

// A claim DB whose insert returns a unique-violation (23505) — the per-user
// in-flight lock is already held (e.g. by a concurrent Hermes withdraw).
function makeInFlightClaimDb() {
  const single = jest.fn(async () => ({
    data: null,
    error: { code: "23505", message: "duplicate key value violates unique constraint" },
  }));
  const select = jest.fn(() => ({ single }));
  const insert = jest.fn(() => ({ select }));
  const eq = jest.fn(async () => ({ data: null, error: null }));
  const update = jest.fn(() => ({ eq }));
  return { from: jest.fn(() => ({ insert, update })) } as never;
}

const HIVRA_WALLET = {
  id: "row_hivra_1",
  instanceId: null,
  hivraAgentId: "hivra_agent_42",
  userId: "user_777",
  bankrWalletId: "wlt_hivra",
  evmAddress: "0x000000000000000000000000000000000000c0de",
  normalizedEvmAddress: "0x000000000000000000000000000000000000c0de",
  apiKeyPreview: "bk_...hivra",
  apiKeyStatus: "active" as const,
  withdrawalDestinationEvm: "0x1111111111111111111111111111111111111111",
  withdrawalDestinationSetAt: "2026-06-13T00:00:00.000Z",
  status: "active" as const,
  metadata: {},
  createdAt: "2026-06-13T00:00:00.000Z",
  updatedAt: "2026-06-13T00:00:00.000Z",
};

describe("withdrawForOwner (Hivra lane)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetWalletForOwner.mockResolvedValue(HIVRA_WALLET);
    mockDecryptApiKey.mockResolvedValue("bk_hivra_secret");
    mockSummary.mockReturnValue({
      evmAddress: HIVRA_WALLET.evmAddress,
      bankrWalletId: HIVRA_WALLET.bankrWalletId,
      status: "active",
      withdrawalDestinationEvm: HIVRA_WALLET.withdrawalDestinationEvm,
      apiKeyStatus: "active",
    });
    mockSetDestinationForOwner.mockResolvedValue(HIVRA_WALLET);
    mockFetchHermesBalance.mockResolvedValue({
      balanceRaw: "10000000000000000000000000",
      balanceDisplay: "10000000",
    });
    mockFetchTokenBalance.mockResolvedValue({
      balanceRaw: "12500000",
      balanceDisplay: "12.5",
    });
    mockSubmitTransfer.mockResolvedValue("0xhivrawithdraw");
  });

  it("resolves the HIVRA wallet by owner — never the instance-locked wallet", async () => {
    await withdrawForOwner({
      owner: { hivraAgentId: "hivra_agent_42" },
      userId: "user_777",
      expectedRecipient: "0x1111111111111111111111111111111111111111",
      amountDisplay: "2500000",
      asset: "HERMESOS",
      db: makeOrderedClaimDb([]),
    });

    expect(mockGetWalletForOwner).toHaveBeenCalledWith(
      expect.objectContaining({ owner: { hivraAgentId: "hivra_agent_42" } })
    );
    // The instance-locked resolver must never be touched on the owner path.
    expect(mockGetWalletForInstance).not.toHaveBeenCalled();
  });

  it("creates the in-flight claim BEFORE submitting the transfer (HERMESOS to saved destination)", async () => {
    const events: string[] = [];
    const db = makeOrderedClaimDb(events);
    mockSubmitTransfer.mockImplementationOnce(async () => {
      events.push("transfer");
      return "0xhivrawithdraw";
    });

    const result = await withdrawForOwner({
      owner: { hivraAgentId: "hivra_agent_42" },
      userId: "user_777",
      expectedRecipient: "0x1111111111111111111111111111111111111111",
      amountDisplay: "2500000",
      asset: "HERMESOS",
      db,
    });

    expect(result).toMatchObject({
      status: "submitted",
      txHash: "0xhivrawithdraw",
      amountRaw: "2500000000000000000000000",
      amountDisplay: "2500000",
      recipientAddress: "0x1111111111111111111111111111111111111111",
    });
    // claim must be recorded first, transfer second, finalize last.
    expect(events).toEqual(["claim_insert", "transfer", "claim_finalize"]);
    expect(mockSubmitTransfer).toHaveBeenCalledWith({
      apiKey: "bk_hivra_secret",
      tokenAddress: "0x95ccfd2b81a9667b0cc979992632f98fc853eba3",
      recipientAddress: "0x1111111111111111111111111111111111111111",
      amountDisplay: "2500000",
      env: undefined,
      fetchImpl: undefined,
    });
  });

  it("409s (already_in_flight) when the per-user in-flight claim is taken (e.g. concurrent Hermes withdraw)", async () => {
    const result = await withdrawForOwner({
      owner: { hivraAgentId: "hivra_agent_42" },
      userId: "user_777",
      expectedRecipient: "0x1111111111111111111111111111111111111111",
      amountDisplay: "2500000",
      asset: "HERMESOS",
      db: makeInFlightClaimDb(),
    });

    expect(result.status).toBe("already_in_flight");
    // Lock contention must short-circuit BEFORE any transfer is minted.
    expect(mockSubmitTransfer).not.toHaveBeenCalled();
  });

  it("fails closed when no DB client is available so the cross-process claim lock can't be skipped", async () => {
    const result = await withdrawForOwner({
      owner: { hivraAgentId: "hivra_agent_42" },
      userId: "user_777",
      expectedRecipient: "0x1111111111111111111111111111111111111111",
      amountDisplay: "2500000",
      asset: "HERMESOS",
    });

    expect(result.status).toBe("transfer_failed");
    expect(mockSubmitTransfer).not.toHaveBeenCalled();
  });

  it("returns no_withdrawal_destination when the Hivra wallet has no saved destination", async () => {
    mockGetWalletForOwner.mockResolvedValueOnce({ ...HIVRA_WALLET, withdrawalDestinationEvm: null });

    const result = await withdrawForOwner({
      owner: { hivraAgentId: "hivra_agent_42" },
      userId: "user_777",
      amountDisplay: "10",
      asset: "HERMESOS",
      db: makeOrderedClaimDb([]),
    });

    expect(result.status).toBe("no_withdrawal_destination");
    expect(mockSubmitTransfer).not.toHaveBeenCalled();
  });

  it("returns no_wallet when the wallet belongs to a different user", async () => {
    mockGetWalletForOwner.mockResolvedValueOnce({ ...HIVRA_WALLET, userId: "someone_else" });

    const result = await withdrawForOwner({
      owner: { hivraAgentId: "hivra_agent_42" },
      userId: "user_777",
      expectedRecipient: "0x1111111111111111111111111111111111111111",
      amountDisplay: "10",
      asset: "HERMESOS",
      db: makeOrderedClaimDb([]),
    });

    expect(result.status).toBe("no_wallet");
    expect(mockSubmitTransfer).not.toHaveBeenCalled();
  });

  it("rejects stale destination confirmations before submitting to Bankr", async () => {
    const result = await withdrawForOwner({
      owner: { hivraAgentId: "hivra_agent_42" },
      userId: "user_777",
      expectedRecipient: "0x2222222222222222222222222222222222222222",
      amountDisplay: "10",
      asset: "HERMESOS",
      db: makeOrderedClaimDb([]),
    });

    expect(result.status).toBe("no_withdrawal_destination");
    expect(result.errorMessage).toMatch(/does not match/i);
    expect(mockSubmitTransfer).not.toHaveBeenCalled();
  });

  it("rejects amounts larger than the live on-chain HERMESOS balance", async () => {
    const result = await withdrawForOwner({
      owner: { hivraAgentId: "hivra_agent_42" },
      userId: "user_777",
      expectedRecipient: "0x1111111111111111111111111111111111111111",
      amountDisplay: "10000000.000000000000000001",
      asset: "HERMESOS",
      db: makeOrderedClaimDb([]),
    });

    expect(result.status).toBe("insufficient_balance");
    expect(mockSubmitTransfer).not.toHaveBeenCalled();
  });

  it("withdraws an explicit Base ERC-20 token to the saved destination and never changes the destination or touches the recipients table", async () => {
    // HIVRA_WALLET's destination was saved long before the cooldown, so a
    // token withdrawal to it goes straight through.
    const db = makeOrderedClaimDb([]);
    const result = await withdrawForOwner({
      owner: { hivraAgentId: "hivra_agent_42" },
      userId: "user_777",
      recipientAddress: "0x1111111111111111111111111111111111111111",
      amountDisplay: "2.5",
      token: {
        symbol: "USDC",
        tokenAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        decimals: 6,
      },
      db,
    });

    expect(result).toMatchObject({
      status: "submitted",
      txHash: "0xhivrawithdraw",
      amountRaw: "2500000",
      amountDisplay: "2.5",
      recipientAddress: "0x1111111111111111111111111111111111111111",
    });
    expect(mockSubmitTransfer).toHaveBeenCalledWith({
      apiKey: "bk_hivra_secret",
      tokenAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      recipientAddress: "0x1111111111111111111111111111111111111111",
      amountDisplay: "2.5",
      env: undefined,
      fetchImpl: undefined,
    });
    // A withdrawal never changes the saved destination, and the Hivra lane
    // never writes the instance-only recipients table (its FK would reject a
    // Hivra box).
    expect(mockSetDestinationForOwner).not.toHaveBeenCalled();
    expect(mockUpsertWithdrawalRecipient).not.toHaveBeenCalled();

    // Nothing about the wallet changed, so it is loaded once and never
    // reloaded after the transfer.
    expect(mockGetWalletForOwner).toHaveBeenCalledTimes(1);
    expect(result.wallet).toEqual(mockSummary.mock.results[0]?.value);
  });

  it("returns invalid_token when a token withdraw is missing the recipient address", async () => {
    const result = await withdrawForOwner({
      owner: { hivraAgentId: "hivra_agent_42" },
      userId: "user_777",
      amountDisplay: "2.5",
      token: {
        symbol: "USDC",
        tokenAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        decimals: 6,
      },
      db: makeOrderedClaimDb([]),
    });

    expect(result.status).toBe("invalid_token");
    expect(mockSubmitTransfer).not.toHaveBeenCalled();
  });
});
