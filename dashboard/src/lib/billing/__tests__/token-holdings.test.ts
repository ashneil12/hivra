import {
  BASE_CHAIN_ID,
  HERMESOS_BASE_TIER_MIN_RAW,
  HERMESOS_TOKEN_ADDRESS,
  decodeUint256RpcResult,
  encodeErc20BalanceOfCallData,
  fetchHermesTokenBalance,
  fetchStakedVvvBalanceRaw,
  formatRawTokenBalance,
  getLatestHermesTokenHoldingSnapshot,
  getTokenVerificationWallet,
  getVvvStakingContractAddress,
  normalizeEvmAddress,
  parseTokenAmountToRaw,
  qualifiesForHermesBaseTier,
  refreshPrimaryHermesTokenHolding,
  refreshPrimaryVerifiedTokenHoldings,
  refreshVerifiedHermesTokenHoldings,
  VVV_TOKEN_ADDRESS,
} from "@/lib/billing/token-holdings";

function buildSingleQuery(data: unknown, error: unknown = null) {
  type MockQuery = {
    select: jest.Mock;
    eq: jest.Mock;
    not: jest.Mock;
    order: jest.Mock;
    limit: jest.Mock;
    maybeSingle: jest.Mock;
  };
  const query = {} as MockQuery;
  query.select = jest.fn(() => query);
  query.eq = jest.fn(() => query);
  query.not = jest.fn(() => query);
  query.order = jest.fn(() => query);
  query.limit = jest.fn(() => query);
  query.maybeSingle = jest.fn().mockResolvedValue({ data, error });

  return query;
}

function buildListQuery(data: unknown, error: unknown = null) {
  type MockQuery = {
    select: jest.Mock;
    eq: jest.Mock;
    not: jest.Mock;
    order: jest.Mock;
    limit: jest.Mock;
    then: Promise<{ data: unknown; error: unknown }>["then"];
  };
  const query = {} as MockQuery;
  query.select = jest.fn(() => query);
  query.eq = jest.fn(() => query);
  query.not = jest.fn(() => query);
  query.order = jest.fn(() => query);
  query.limit = jest.fn(() => query);
  query.then = (resolve, reject) => Promise.resolve({ data, error }).then(resolve, reject);

  return query;
}

function buildInsertSnapshotTable(rows: unknown[], error: unknown = null) {
  type MockInsert = {
    insert: jest.Mock;
    select: jest.Mock;
    single: jest.Mock;
  };
  const query = {} as MockInsert;
  query.insert = jest.fn(() => query);
  query.select = jest.fn(() => query);
  query.single = jest.fn();
  for (const row of rows) {
    query.single.mockResolvedValueOnce({ data: row, error });
  }
  return query;
}

function snapshotRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "snapshot_1",
    user_id: "user_1",
    wallet_id: "wallet_1",
    wallet_address: "0x000000000000000000000000000000000000dEaD",
    normalized_wallet_address: "0x000000000000000000000000000000000000dead",
    chain_id: BASE_CHAIN_ID,
    token_address: HERMESOS_TOKEN_ADDRESS,
    token_symbol: "Hivra",
    token_decimals: 18,
    balance_raw: "1000000000000000000",
    balance_display: "1",
    qualifies_base_tier: true,
    block_number: 16,
    source: "base_rpc",
    checked_at: "2026-04-24T12:00:00.000Z",
    ...overrides,
  };
}

function balanceRpcFetch(...balances: string[]) {
  const responses = balances.flatMap((balance, index) => [
    {
      ok: true,
      status: 200,
      json: async () => ({ jsonrpc: "2.0", id: 1, result: balance }),
    },
    {
      ok: true,
      status: 200,
      json: async () => ({ jsonrpc: "2.0", id: 1, result: `0x${(16 + index).toString(16)}` }),
    },
  ]);
  return jest.fn().mockImplementation(async () => {
    const response = responses.shift();
    if (!response) throw new Error("unexpected rpc call");
    return response;
  });
}

// Staked-VVV crediting defaults ON; disable it for the liquid-balance refresh
// tests so their RPC mock sequences stay deterministic. The dedicated "staked
// VVV" suite exercises the staking reads via explicit env instead.
const ORIGINAL_STAKING_ENV = process.env.VVV_STAKING_CONTRACT_ADDRESS;
beforeAll(() => {
  process.env.VVV_STAKING_CONTRACT_ADDRESS = "0x0000000000000000000000000000000000000000";
});
afterAll(() => {
  if (ORIGINAL_STAKING_ENV === undefined) delete process.env.VVV_STAKING_CONTRACT_ADDRESS;
  else process.env.VVV_STAKING_CONTRACT_ADDRESS = ORIGINAL_STAKING_ENV;
});

describe("Hivra token holdings", () => {
  it("normalizes and validates EVM addresses", () => {
    expect(normalizeEvmAddress(" 0x95CCFD2b81A9667b0Cc979992632f98fC853eba3 ")).toBe(
      "0x95ccfd2b81a9667b0cc979992632f98fc853eba3"
    );
    expect(() => normalizeEvmAddress("0xnot-a-wallet")).toThrow("Invalid EVM address");
  });

  it("formats token amounts and checks the base tier threshold", () => {
    expect(parseTokenAmountToRaw("1.25", 18).toString()).toBe("1250000000000000000");
    expect(formatRawTokenBalance("1250000000000000000", 18)).toBe("1.25");
    expect(HERMESOS_BASE_TIER_MIN_RAW).toBe("1000000000000000000");
    expect(qualifiesForHermesBaseTier("999999999999999999")).toBe(false);
    expect(qualifiesForHermesBaseTier("1000000000000000000")).toBe(true);
  });

  it("encodes ERC-20 balanceOf calls", () => {
    expect(
      encodeErc20BalanceOfCallData("0x000000000000000000000000000000000000dEaD")
    ).toBe(
      "0x70a08231000000000000000000000000000000000000000000000000000000000000dead"
    );
  });

  it("decodes uint256 JSON-RPC results", () => {
    expect(decodeUint256RpcResult("0xde0b6b3a7640000")).toBe("1000000000000000000");
    expect(() => decodeUint256RpcResult("not-hex")).toThrow("Invalid uint256 RPC result");
  });

  it("fetches a Hivra balance from Base JSON-RPC", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ jsonrpc: "2.0", id: 1, result: "0xde0b6b3a7640000" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x10" }),
      });

    const balance = await fetchHermesTokenBalance({
      walletAddress: "0x000000000000000000000000000000000000dEaD",
      rpcUrl: "https://base.example",
      fetchImpl: fetchMock,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(balance).toMatchObject({
      chainId: BASE_CHAIN_ID,
      tokenAddress: HERMESOS_TOKEN_ADDRESS,
      balanceRaw: "1000000000000000000",
      balanceDisplay: "1",
      qualifiesBaseTier: true,
      blockNumber: 16,
    });
  });

  it("loads the latest stored token holding snapshot", async () => {
    const query = buildSingleQuery({
      id: "snapshot_1",
      user_id: "user_1",
      wallet_id: "wallet_1",
      wallet_address: "0x000000000000000000000000000000000000dEaD",
      normalized_wallet_address: "0x000000000000000000000000000000000000dead",
      chain_id: BASE_CHAIN_ID,
      token_address: HERMESOS_TOKEN_ADDRESS,
      token_symbol: "Hivra",
      token_decimals: 18,
      balance_raw: "1000000000000000000",
      balance_display: "1",
      qualifies_base_tier: true,
      block_number: 16,
      source: "base_rpc",
      checked_at: "2026-04-24T12:00:00.000Z",
    });
    const db = { from: jest.fn(() => query) };

    const snapshot = await getLatestHermesTokenHoldingSnapshot("user_1", db);

    expect(db.from).toHaveBeenCalledWith("token_holding_snapshots");
    expect(query.eq).toHaveBeenCalledWith("user_id", "user_1");
    expect(snapshot).toMatchObject({
      userId: "user_1",
      balance: 1,
      qualifiesBaseTier: true,
      checkedAt: "2026-04-24T12:00:00.000Z",
    });
  });

  it("refreshes verified primary wallet holdings and summarizes outcomes", async () => {
    const wallets = [
      {
        id: "wallet_1",
        user_id: "user_1",
        address: "0x000000000000000000000000000000000000dEaD",
        normalized_address: "0x000000000000000000000000000000000000dead",
        chain_type: "evm",
        chain_id: BASE_CHAIN_ID,
        is_primary: true,
        verified_at: "2026-04-24T12:00:00.000Z",
      },
      {
        id: "wallet_2",
        user_id: "user_2",
        address: "0x0000000000000000000000000000000000000001",
        normalized_address: "0x0000000000000000000000000000000000000001",
        chain_type: "evm",
        chain_id: BASE_CHAIN_ID,
        is_primary: true,
        verified_at: "2026-04-24T12:01:00.000Z",
      },
      {
        id: "wallet_3",
        user_id: "user_3",
        address: "0x0000000000000000000000000000000000000002",
        normalized_address: "0x0000000000000000000000000000000000000002",
        chain_type: "evm",
        chain_id: BASE_CHAIN_ID,
        is_primary: true,
        verified_at: "2026-04-24T12:02:00.000Z",
      },
    ];
    const query = buildListQuery(wallets);
    const db = { from: jest.fn(() => query) };
    const refreshUserHolding = jest.fn()
      .mockResolvedValueOnce({
        status: "refreshed",
        snapshot: {
          id: "snapshot_1",
          qualifiesBaseTier: true,
        },
      })
      .mockResolvedValueOnce({
        status: "no_verified_wallet",
        snapshot: null,
      })
      .mockRejectedValueOnce(new Error("rpc-secret-leak"));

    const result = await refreshVerifiedHermesTokenHoldings({
      db,
      limit: 3,
      refreshUserHolding,
    });

    expect(db.from).toHaveBeenCalledWith("user_wallets");
    expect(query.eq).toHaveBeenCalledWith("chain_type", "evm");
    expect(query.eq).toHaveBeenCalledWith("is_primary", true);
    expect(query.not).toHaveBeenCalledWith("verified_at", "is", null);
    expect(query.limit).toHaveBeenCalledWith(3);
    expect(refreshUserHolding).toHaveBeenCalledTimes(3);
    expect(result).toEqual({
      checked: 3,
      refreshed: 1,
      noVerifiedWallet: 1,
      failed: 1,
      results: [
        {
          userId: "user_1",
          walletId: "wallet_1",
          status: "refreshed",
          snapshotId: "snapshot_1",
          qualifiesBaseTier: true,
        },
        {
          userId: "user_2",
          walletId: "wallet_2",
          status: "no_verified_wallet",
        },
        {
          userId: "user_3",
          walletId: "wallet_3",
          status: "failed",
        },
      ],
    });
  });

  it("does not use a Bankr credit deposit wallet as the token verification wallet", async () => {
    const lockWalletQuery = buildSingleQuery(null);
    const primaryWalletQuery = buildSingleQuery({
      id: "wallet_credit",
      user_id: "user_1",
      address: "0x000000000000000000000000000000000000c0Fe",
      normalized_address: "0x000000000000000000000000000000000000c0fe",
      chain_type: "evm",
      chain_id: BASE_CHAIN_ID,
      is_primary: true,
      verified_at: "2026-04-24T12:00:00.000Z",
      verification_method: "bankr",
      metadata: { bankr: { purpose: "credit_deposit" } },
    });
    const insertSnapshots = buildInsertSnapshotTable([snapshotRow()]);
    const db = {
      from: jest.fn()
        .mockReturnValueOnce(lockWalletQuery)
        .mockReturnValueOnce(primaryWalletQuery)
        .mockReturnValueOnce(insertSnapshots),
    };
    const fetchMock = balanceRpcFetch("0xde0b6b3a7640000");

    const result = await refreshPrimaryHermesTokenHolding({
      userId: "user_1",
      db,
      fetchImpl: fetchMock,
    });

    expect(result).toEqual({ status: "no_verified_wallet", snapshot: null });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(insertSnapshots.insert).not.toHaveBeenCalled();
  });

  it("does not let an empty Bankr Hivra lock wallet override a signed wallet", async () => {
    const lockWalletQuery = buildSingleQuery({
      id: "wallet_lock",
      user_id: "user_1",
      address: "0x000000000000000000000000000000000000bA5e",
      normalized_address: "0x000000000000000000000000000000000000ba5e",
      chain_type: "evm",
      chain_id: BASE_CHAIN_ID,
      is_primary: false,
      verified_at: "2026-04-24T11:00:00.000Z",
      verification_method: "bankr",
      metadata: { bankr: { purpose: "hermesos_lock" } },
    });
    const emptyLockSnapshotQuery = buildSingleQuery(snapshotRow({
      wallet_id: "wallet_lock",
      wallet_address: "0x000000000000000000000000000000000000bA5e",
      normalized_wallet_address: "0x000000000000000000000000000000000000ba5e",
      balance_raw: "0",
      balance_display: "0",
      qualifies_base_tier: false,
    }));
    const signedWalletQuery = buildSingleQuery({
      id: "wallet_signed",
      user_id: "user_1",
      address: "0x000000000000000000000000000000000000dEaD",
      normalized_address: "0x000000000000000000000000000000000000dead",
      chain_type: "evm",
      chain_id: BASE_CHAIN_ID,
      is_primary: true,
      verified_at: "2026-04-24T12:00:00.000Z",
      verification_method: "signature",
      metadata: {},
    });
    const db = {
      from: jest.fn()
        .mockReturnValueOnce(lockWalletQuery)
        .mockReturnValueOnce(emptyLockSnapshotQuery)
        .mockReturnValueOnce(signedWalletQuery),
    };

    const wallet = await getTokenVerificationWallet("user_1", db);

    expect(wallet).toMatchObject({
      id: "wallet_signed",
      normalizedAddress: "0x000000000000000000000000000000000000dead",
      verificationMethod: "signature",
    });
    expect(emptyLockSnapshotQuery.eq).toHaveBeenCalledWith(
      "normalized_wallet_address",
      "0x000000000000000000000000000000000000ba5e"
    );
  });

  it("snapshots Hivra and VVV balances from the same signature verified wallet", async () => {
    const lockWalletQuery = buildSingleQuery(null);
    const primaryWalletQuery = buildSingleQuery({
      id: "wallet_1",
      user_id: "user_1",
      address: "0x000000000000000000000000000000000000dEaD",
      normalized_address: "0x000000000000000000000000000000000000dead",
      chain_type: "evm",
      chain_id: BASE_CHAIN_ID,
      is_primary: true,
      verified_at: "2026-04-24T12:00:00.000Z",
      verification_method: "signature",
      metadata: {},
    });
    const insertSnapshots = buildInsertSnapshotTable([
      snapshotRow(),
      snapshotRow({
        id: "snapshot_vvv",
        token_address: VVV_TOKEN_ADDRESS,
        token_symbol: "VVV",
        balance_raw: "2500000000000000000",
        balance_display: "2.5",
        qualifies_base_tier: false,
        block_number: 17,
      }),
    ]);
    const db = {
      from: jest.fn()
        .mockReturnValueOnce(lockWalletQuery)
        .mockReturnValueOnce(primaryWalletQuery)
        .mockReturnValueOnce(insertSnapshots)
        .mockReturnValueOnce(insertSnapshots),
    };
    const fetchMock = balanceRpcFetch("0xde0b6b3a7640000", "0x22b1c8c1227a0000");

    const result = await refreshPrimaryVerifiedTokenHoldings({
      userId: "user_1",
      db,
      fetchImpl: fetchMock,
    });

    expect(result.status).toBe("refreshed");
    expect(result.snapshot?.tokenAddress).toBe(HERMESOS_TOKEN_ADDRESS);
    expect(result.snapshots.map((snapshot) => snapshot.tokenAddress)).toEqual([
      HERMESOS_TOKEN_ADDRESS,
      VVV_TOKEN_ADDRESS,
    ]);
    expect(insertSnapshots.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        token_address: HERMESOS_TOKEN_ADDRESS,
        token_symbol: "HermesOS",
      })
    );
    expect(insertSnapshots.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        token_address: VVV_TOKEN_ADDRESS,
        token_symbol: "VVV",
      })
    );
  });
});

describe("staked VVV (Venice boost)", () => {
  const STAKING = "0x000000000000000000000000000000000000bEEF";
  const WALLET = "0x000000000000000000000000000000000000dEaD";
  const ZERO = "0x0000000000000000000000000000000000000000";
  const SVVV = "0x321b7ff75154472B18EDb199033fF4D116F340Ff";
  const u256 = (n: bigint) => "0x" + n.toString(16);
  const rpcOk = (n: bigint) => ({
    ok: true,
    status: 200,
    json: async () => ({ jsonrpc: "2.0", id: 1, result: u256(n) }),
  });

  it("defaults staked-VVV crediting ON against the official sVVV contract", () => {
    expect(getVvvStakingContractAddress({})).toBe(normalizeEvmAddress(SVVV));
  });

  it("disables crediting when the staking address is set to the zero address", () => {
    expect(getVvvStakingContractAddress({ VVV_STAKING_CONTRACT_ADDRESS: ZERO })).toBeNull();
  });

  it("honors an explicit staking contract override", () => {
    expect(getVvvStakingContractAddress({ VVV_STAKING_CONTRACT_ADDRESS: STAKING })).toBe(
      normalizeEvmAddress(STAKING)
    );
    expect(
      getVvvStakingContractAddress({ HERMES_VVV_STAKING_CONTRACT_ADDRESS: STAKING })
    ).toBe(normalizeEvmAddress(STAKING));
  });

  it("returns 0 staked VVV without an RPC call when disabled", async () => {
    const fetchMock = jest.fn();
    const staked = await fetchStakedVvvBalanceRaw({
      walletAddress: WALLET,
      env: { VVV_STAKING_CONTRACT_ADDRESS: ZERO },
      fetchImpl: fetchMock as never,
    });
    expect(staked).toBe(0n);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("converts sVVV shares to VVV via the on-chain share price", async () => {
    // shares=1e18, totalSupply=2e18, VVV backing=2.1e18 → 1e18 * 2.1e18 / 2e18 = 1.05e18
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(rpcOk(10n ** 18n)) // sVVV.balanceOf(wallet) — shares
      .mockResolvedValueOnce(rpcOk(2n * 10n ** 18n)) // sVVV.totalSupply()
      .mockResolvedValueOnce(rpcOk(21n * 10n ** 17n)); // VVV.balanceOf(sVVV)

    const staked = await fetchStakedVvvBalanceRaw({
      walletAddress: WALLET,
      env: { VVV_STAKING_CONTRACT_ADDRESS: STAKING },
      fetchImpl: fetchMock as never,
    });

    expect(staked).toBe(1050000000000000000n);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const firstCall = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(firstCall.params[0].to).toBe(normalizeEvmAddress(STAKING));
    expect(firstCall.params[0].data).toBe(encodeErc20BalanceOfCallData(WALLET));
  });

  it("skips the share conversion when VVV_STAKING_RAW_BALANCE=true", async () => {
    const fetchMock = jest.fn().mockResolvedValueOnce(rpcOk(7n * 10n ** 18n));
    const staked = await fetchStakedVvvBalanceRaw({
      walletAddress: WALLET,
      env: { VVV_STAKING_CONTRACT_ADDRESS: STAKING, VVV_STAKING_RAW_BALANCE: "true" },
      fetchImpl: fetchMock as never,
    });
    expect(staked).toBe(7000000000000000000n);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("honors a custom staking balance selector for the share read", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(rpcOk(10n ** 18n))
      .mockResolvedValueOnce(rpcOk(10n ** 18n))
      .mockResolvedValueOnce(rpcOk(10n ** 18n));
    await fetchStakedVvvBalanceRaw({
      walletAddress: WALLET,
      env: { VVV_STAKING_CONTRACT_ADDRESS: STAKING, VVV_STAKING_BALANCE_SELECTOR: "0x12345678" },
      fetchImpl: fetchMock as never,
    });
    const firstCall = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(firstCall.params[0].data.startsWith("0x12345678")).toBe(true);
  });
});
