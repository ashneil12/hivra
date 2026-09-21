const mockGetWallet = jest.fn();
const mockDecryptApiKey = jest.fn();
const mockSummary = jest.fn();
const mockFetchHermesBalance = jest.fn();
const mockFetchTokenBalance = jest.fn();
const mockSubmitTransfer = jest.fn();
const mockUpsertWithdrawalRecipient = jest.fn();
const mockLogWarn = jest.fn();
const mockLogError = jest.fn();

jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: null,
}));

jest.mock("@/lib/billing/bankr-instance-wallets", () => ({
  decryptInstanceBankrApiKey: (...args: unknown[]) => mockDecryptApiKey(...args),
  getBankrWalletForInstance: (...args: unknown[]) => mockGetWallet(...args),
  instanceBankrWalletPublicSummary: (...args: unknown[]) => mockSummary(...args),
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
    error: (...args: unknown[]) => mockLogError(...args),
  },
}));

import {
  withdrawBaseTokenForInstance,
  withdrawBaseEthForInstance,
  withdrawHermesTokensForInstance,
} from "../bankr-instance-withdraw";

// Minimal in-flight-claim DB: insert→select→single yields a claim id (no
// schema drift, no 23505), and update→eq finalizes. The withdrawal path now
// REQUIRES a DB client for its cross-process claim lock, so happy-path tests
// must supply one (a null client fails closed — see the dedicated test below).
function makeClaimDb() {
  const single = jest.fn(async () => ({ data: { id: "claim_1" }, error: null }));
  const select = jest.fn(() => ({ single }));
  const insert = jest.fn(() => ({ select }));
  const eq = jest.fn(async () => ({ data: null, error: null }));
  const update = jest.fn(() => ({ eq }));
  return { from: jest.fn(() => ({ insert, update })) } as never;
}

describe("withdrawHermesTokensForInstance", () => {
  const record = {
    id: "row_1",
    instanceId: "inst_123",
    userId: "user_123",
    bankrWalletId: "wlt_instance",
    evmAddress: "0x000000000000000000000000000000000000ba5e",
    normalizedEvmAddress: "0x000000000000000000000000000000000000ba5e",
    apiKeyPreview: "bk_...key",
    apiKeyStatus: "active" as const,
    withdrawalDestinationEvm: "0x1111111111111111111111111111111111111111",
    withdrawalDestinationSetAt: "2026-05-19T07:21:55.000Z",
    status: "active" as const,
    metadata: {},
    createdAt: "2026-05-19T07:21:55.000Z",
    updatedAt: "2026-05-19T07:21:55.000Z",
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetWallet.mockResolvedValue(record);
    mockDecryptApiKey.mockResolvedValue("bk_agent_secret");
    mockSummary.mockReturnValue({
      evmAddress: record.evmAddress,
      bankrWalletId: record.bankrWalletId,
      status: "active",
      withdrawalDestinationEvm: record.withdrawalDestinationEvm,
      apiKeyStatus: "active",
    });
    mockFetchHermesBalance.mockResolvedValue({
      balanceRaw: "10000000000000000000000000",
      balanceDisplay: "10000000",
    });
    mockFetchTokenBalance.mockResolvedValue({
      balanceRaw: "12500000",
      balanceDisplay: "12.5",
    });
    mockSubmitTransfer.mockResolvedValue("0xwithdraw");
    mockUpsertWithdrawalRecipient.mockResolvedValue({
      id: "recipient_1",
      address: "0x2222222222222222222222222222222222222222",
      normalizedAddress: "0x2222222222222222222222222222222222222222",
      label: null,
      isPrimary: true,
      useCount: 1,
      lastUsedAt: "2026-05-19T08:30:00.000Z",
    });
  });

  it("falls back to the legacy withdrawal claim shape when production schema cache is missing token columns", async () => {
    const insertPayloads: unknown[] = [];
    const updatePayloads: unknown[] = [];
    const insert = jest.fn((payload: unknown) => {
      insertPayloads.push(payload);
      const hasTokenColumns = typeof payload === "object" && payload !== null && "chain" in payload;
      return {
        select: jest.fn(() => ({
          single: jest.fn(async () => (
            hasTokenColumns
              ? {
                  data: null,
                  error: {
                    code: "PGRST204",
                    message: "Could not find the 'chain' column of 'bankr_withdrawals' in the schema cache",
                  },
                }
              : { data: { id: "claim_legacy" }, error: null }
          )),
        })),
      };
    });
    const eq = jest.fn(async () => ({ data: null, error: null }));
    const update = jest.fn((payload: unknown) => {
      updatePayloads.push(payload);
      return { eq };
    });
    const db = {
      from: jest.fn(() => ({ insert, update })),
    };

    const result = await withdrawHermesTokensForInstance({
      instanceId: "inst_123",
      userId: "user_123",
      expectedRecipient: "0x1111111111111111111111111111111111111111",
      amountDisplay: "2500000",
      db: db as never,
    });

    expect(result.status).toBe("submitted");
    expect(insertPayloads).toHaveLength(2);
    expect(insertPayloads[0]).toMatchObject({
      user_id: "user_123",
      chain: "base",
      token_symbol: "HERMESOS",
    });
    expect(insertPayloads[1]).toMatchObject({
      user_id: "user_123",
      status: "in_flight",
      amount_raw: "2500000000000000000000000",
      recipient: "0x1111111111111111111111111111111111111111",
    });
    expect(insertPayloads[1]).not.toHaveProperty("chain");
    expect(updatePayloads[0]).toMatchObject({
      status: "submitted",
      tx_hash: "0xwithdraw",
    });
    expect(mockLogWarn).toHaveBeenCalledWith(
      "withdrawal claim schema cache missing token columns; retrying legacy claim insert",
      expect.objectContaining({
        source: "agent-wallet-withdraw",
        failureType: "agent_wallet_withdraw_claim_schema_drift",
        userId: "user_123",
        tokenSymbol: "HERMESOS",
      })
    );
  });

  it("reads live HERMESOS balance and transfers the selected amount to the saved destination", async () => {
    const result = await withdrawHermesTokensForInstance({
      instanceId: "inst_123",
      userId: "user_123",
      expectedRecipient: "0x1111111111111111111111111111111111111111",
      amountDisplay: "2500000",
      env: { HERMES_BASE_RPC_URL: "https://base.example.test" },
      db: makeClaimDb(),
    });

    expect(result).toMatchObject({
      status: "submitted",
      txHash: "0xwithdraw",
      amountRaw: "2500000000000000000000000",
      amountDisplay: "2500000",
      recipientAddress: "0x1111111111111111111111111111111111111111",
    });
    expect(mockFetchHermesBalance).toHaveBeenCalledWith({
      walletAddress: record.evmAddress,
      env: { HERMES_BASE_RPC_URL: "https://base.example.test" },
      fetchImpl: undefined,
      rpcUrl: undefined,
    });
    expect(mockSubmitTransfer).toHaveBeenCalledWith({
      apiKey: "bk_agent_secret",
      tokenAddress: "0x95ccfd2b81a9667b0cc979992632f98fc853eba3",
      recipientAddress: "0x1111111111111111111111111111111111111111",
      amountDisplay: "2500000",
      env: { HERMES_BASE_RPC_URL: "https://base.example.test" },
      fetchImpl: undefined,
    });
  });

  it("logs the stuck in-flight lock (does not swallow it) when the claim release write errors, and still reports the completed transfer", async () => {
    // The on-chain transfer succeeds, but the finalize/release UPDATE fails.
    // Previously this error was discarded, silently wedging the user's withdraw
    // lock forever. It must now be surfaced — and the withdrawal must still
    // report success (the transfer already happened).
    const single = jest.fn(async () => ({ data: { id: "claim_1" }, error: null }));
    const releaseEq = jest.fn(async () => ({ data: null, error: { message: "release boom" } }));
    const db = {
      from: jest.fn(() => ({
        insert: jest.fn(() => ({ select: jest.fn(() => ({ single })) })),
        update: jest.fn(() => ({ eq: releaseEq })),
      })),
    } as never;

    const result = await withdrawHermesTokensForInstance({
      instanceId: "inst_123",
      userId: "user_123",
      expectedRecipient: "0x1111111111111111111111111111111111111111",
      amountDisplay: "2500000",
      env: { HERMES_BASE_RPC_URL: "https://base.example.test" },
      db,
    });

    // Transfer succeeded → success status despite the release failure.
    expect(result.status).toBe("submitted");
    expect(result.txHash).toBe("0xwithdraw");
    // The release failure is logged with an actionable failureType.
    expect(mockLogError).toHaveBeenCalledWith(
      "withdrawal claim release failed; in_flight lock may be stuck",
      expect.objectContaining({ message: "release boom" }),
      expect.objectContaining({
        failureType: "withdrawal_claim_release_failed",
        claimId: "claim_1",
        finalStatus: "submitted",
      })
    );
  });

  it("reads live Base ETH balance and submits a native transfer to the saved destination", async () => {
    const fetchImpl = jest.fn(async (_input: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as { method: string };
      if (request.method === "eth_getBalance") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            jsonrpc: "2.0",
            id: 1,
            result: "0x2386f26fc10000",
          }),
        };
      }
      throw new Error(`Unexpected RPC method ${request.method}`);
    });

    const result = await withdrawBaseEthForInstance({
      instanceId: "inst_123",
      userId: "user_123",
      expectedRecipient: "0x1111111111111111111111111111111111111111",
      amountDisplay: "0.005",
      env: { HERMES_BASE_RPC_URL: "https://base.example.test" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      db: makeClaimDb(),
    });

    expect(result).toMatchObject({
      status: "submitted",
      txHash: "0xwithdraw",
      amountRaw: "5000000000000000",
      amountDisplay: "0.005",
      recipientAddress: "0x1111111111111111111111111111111111111111",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://base.example.test",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("eth_getBalance"),
      })
    );
    expect(mockFetchHermesBalance).not.toHaveBeenCalled();
    expect(mockSubmitTransfer).toHaveBeenCalledWith({
      apiKey: "bk_agent_secret",
      tokenAddress: "0x0000000000000000000000000000000000000000",
      recipientAddress: "0x1111111111111111111111111111111111111111",
      amountDisplay: "0.005",
      isNativeToken: true,
      env: { HERMES_BASE_RPC_URL: "https://base.example.test" },
      fetchImpl,
    });
  });

  it("allows native Base ETH withdrawals up to the live balance because Bankr sponsors gas", async () => {
    const fetchImpl = jest.fn(async (_input: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as { method: string };
      if (request.method === "eth_getBalance") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            jsonrpc: "2.0",
            id: 1,
            result: "0x2386f26fc10000",
          }),
        };
      }
      throw new Error(`Unexpected RPC method ${request.method}`);
    });

    const result = await withdrawBaseTokenForInstance({
      instanceId: "inst_123",
      userId: "user_123",
      recipientAddress: "0x1111111111111111111111111111111111111111",
      amountDisplay: "0.0098",
      token: {
        symbol: "ETH",
        tokenAddress: null,
        decimals: 18,
      },
      env: { HERMES_BASE_RPC_URL: "https://base.example.test" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      db: makeClaimDb(),
    });

    expect(result).toMatchObject({
      status: "submitted",
      txHash: "0xwithdraw",
      amountRaw: "9800000000000000",
      amountDisplay: "0.0098",
      recipientAddress: "0x1111111111111111111111111111111111111111",
    });
    expect(mockSubmitTransfer).toHaveBeenCalledWith({
      apiKey: "bk_agent_secret",
      tokenAddress: "0x0000000000000000000000000000000000000000",
      recipientAddress: "0x1111111111111111111111111111111111111111",
      amountDisplay: "0.0098",
      isNativeToken: true,
      env: { HERMES_BASE_RPC_URL: "https://base.example.test" },
      fetchImpl,
    });
  });

  it("withdraws an explicit Base ERC-20 token to the requested recipient without a saved destination", async () => {
    mockGetWallet.mockResolvedValueOnce({ ...record, withdrawalDestinationEvm: null });

    const db = makeClaimDb();
    const result = await withdrawBaseTokenForInstance({
      instanceId: "inst_123",
      userId: "user_123",
      recipientAddress: "0x2222222222222222222222222222222222222222",
      amountDisplay: "2.5",
      token: {
        symbol: "USDC",
        tokenAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        decimals: 6,
      },
      env: { HERMES_BASE_RPC_URL: "https://base.example.test" },
      db,
    });

    expect(result).toMatchObject({
      status: "submitted",
      txHash: "0xwithdraw",
      amountRaw: "2500000",
      amountDisplay: "2.5",
      recipientAddress: "0x2222222222222222222222222222222222222222",
    });
    expect(mockFetchTokenBalance).toHaveBeenCalledWith({
      walletAddress: record.evmAddress,
      token: {
        chainId: 8453,
        tokenAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        tokenSymbol: "USDC",
        tokenDecimals: 6,
      },
      env: { HERMES_BASE_RPC_URL: "https://base.example.test" },
      fetchImpl: undefined,
      rpcUrl: undefined,
    });
    expect(mockSubmitTransfer).toHaveBeenCalledWith({
      apiKey: "bk_agent_secret",
      tokenAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      recipientAddress: "0x2222222222222222222222222222222222222222",
      amountDisplay: "2.5",
      env: { HERMES_BASE_RPC_URL: "https://base.example.test" },
      fetchImpl: undefined,
    });
    expect(mockUpsertWithdrawalRecipient).toHaveBeenCalledWith({
      instanceId: "inst_123",
      userId: "user_123",
      address: "0x2222222222222222222222222222222222222222",
      setPrimary: true,
      db,
    });
  });

  it("fails closed when no DB client is available so the cross-process claim lock can't be skipped", async () => {
    // No `db` and supabaseAdmin is mocked null → the in-flight claim can't be
    // recorded, so the withdrawal must refuse rather than mint a transfer with
    // no cross-process lock (mirrors the user-wallet withdraw path).
    const result = await withdrawHermesTokensForInstance({
      instanceId: "inst_123",
      userId: "user_123",
      expectedRecipient: "0x1111111111111111111111111111111111111111",
      amountDisplay: "2500000",
    });

    expect(result.status).toBe("transfer_failed");
    expect(mockSubmitTransfer).not.toHaveBeenCalled();
  });

  it("rejects amounts larger than the live on-chain HERMESOS balance", async () => {
    const result = await withdrawHermesTokensForInstance({
      instanceId: "inst_123",
      userId: "user_123",
      expectedRecipient: "0x1111111111111111111111111111111111111111",
      amountDisplay: "10000000.000000000000000001",
    });

    expect(result.status).toBe("insufficient_balance");
    expect(result.amountRaw).toBe("10000000000000000000000001");
    expect(result.amountDisplay).toBe("10000000.000000000000000001");
    expect(result.errorMessage).toMatch(/exceeds/i);
    expect(mockSubmitTransfer).not.toHaveBeenCalled();
  });

  it("rejects invalid withdrawal amounts before submitting to Bankr", async () => {
    const result = await withdrawHermesTokensForInstance({
      instanceId: "inst_123",
      userId: "user_123",
      expectedRecipient: "0x1111111111111111111111111111111111111111",
      amountDisplay: "0",
    });

    expect(result.status).toBe("invalid_amount");
    expect(mockFetchHermesBalance).not.toHaveBeenCalled();
    expect(mockSubmitTransfer).not.toHaveBeenCalled();
  });

  it("refuses to transfer when the agent wallet has no saved destination", async () => {
    mockGetWallet.mockResolvedValueOnce({ ...record, withdrawalDestinationEvm: null });

    const result = await withdrawHermesTokensForInstance({
      instanceId: "inst_123",
      userId: "user_123",
      amountDisplay: "10",
    });

    expect(result.status).toBe("no_withdrawal_destination");
    expect(mockDecryptApiKey).not.toHaveBeenCalled();
    expect(mockSubmitTransfer).not.toHaveBeenCalled();
  });

  it("rejects stale destination confirmations before submitting to Bankr", async () => {
    const result = await withdrawHermesTokensForInstance({
      instanceId: "inst_123",
      userId: "user_123",
      expectedRecipient: "0x2222222222222222222222222222222222222222",
      amountDisplay: "10",
    });

    expect(result.status).toBe("no_withdrawal_destination");
    expect(result.errorMessage).toMatch(/does not match/i);
    expect(mockSubmitTransfer).not.toHaveBeenCalled();
  });
});
