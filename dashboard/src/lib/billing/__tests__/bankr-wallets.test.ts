import {
  buildBankrWalletIdempotencyKey,
  DEFAULT_BANKR_API_BASE_URL,
  getBankrWalletForUser,
  getBankrPartnerConfig,
  parseBankrWalletResponse,
  provisionBankrWalletForUser,
} from "@/lib/billing/bankr-wallets";

function buildThenableUpdateTable(error: unknown = null) {
  const filter: {
    eq: jest.Mock;
    then: Promise<{ error: unknown }>["then"];
  } = {} as {
    eq: jest.Mock;
    then: Promise<{ error: unknown }>["then"];
  };
  filter.eq = jest.fn(() => filter);
  filter.then = (resolve, reject) => Promise.resolve({ error }).then(resolve, reject);
  return {
    update: jest.fn(() => filter),
    filter,
  };
}

function buildUpsertTable(data: unknown, error: unknown = null) {
  const query: {
    upsert: jest.Mock;
    select: jest.Mock;
    single: jest.Mock;
  } = {} as {
    upsert: jest.Mock;
    select: jest.Mock;
    single: jest.Mock;
  };
  query.upsert = jest.fn(() => query);
  query.select = jest.fn(() => query);
  query.single = jest.fn().mockResolvedValue({ data, error });
  return query;
}

function buildSelectMaybeSingleTable(data: unknown, error: unknown = null) {
  const query: {
    select: jest.Mock;
    eq: jest.Mock;
    order: jest.Mock;
    limit: jest.Mock;
    maybeSingle: jest.Mock;
  } = {} as {
    select: jest.Mock;
    eq: jest.Mock;
    order: jest.Mock;
    limit: jest.Mock;
    maybeSingle: jest.Mock;
  };
  query.select = jest.fn(() => query);
  query.eq = jest.fn(() => query);
  query.order = jest.fn(() => query);
  query.limit = jest.fn(() => query);
  query.maybeSingle = jest.fn().mockResolvedValue({ data, error });
  return query;
}

const now = new Date("2026-04-24T12:00:00.000Z");
const bankrResponse = {
  id: "wlt_A1b2C3d4",
  evmAddress: "0x000000000000000000000000000000000000dEaD",
  solAddress: "ABC123xyz",
  status: "active",
  createdAt: "2026-04-24T11:59:00.000Z",
  apiKey: "bk_usr_should_not_be_stored",
};
const normalizedAddress = "0x000000000000000000000000000000000000dead";

describe("Bankr wallet provisioning", () => {
  it("reads partner config without requiring live secrets in tests", () => {
    expect(getBankrPartnerConfig({})).toEqual({
      configured: false,
      partnerKey: null,
      apiBaseUrl: DEFAULT_BANKR_API_BASE_URL,
    });

    expect(getBankrPartnerConfig({
      BANKR_PARTNER_KEY: " bk_ptr_test ",
      BANKR_API_BASE_URL: "https://api.example.test///",
    })).toEqual({
      configured: true,
      partnerKey: "bk_ptr_test",
      apiBaseUrl: "https://api.example.test",
    });

    expect(getBankrPartnerConfig({
      BANKR_PARTNER_KEY: ' "" ',
      BANKR_PARTNER_API_KEY: " bk_ptr_backup ",
      BANKR_API_BASE_URL: ' "https://api.backup.test///" ',
    })).toEqual({
      configured: true,
      partnerKey: "bk_ptr_backup",
      apiBaseUrl: "https://api.backup.test",
    });

    expect(getBankrPartnerConfig({
      BANKR_PARTNER_KEY: '""',
      BANKR_PARTNER_API_KEY: "''",
    })).toEqual({
      configured: false,
      partnerKey: null,
      apiBaseUrl: DEFAULT_BANKR_API_BASE_URL,
    });
  });

  it("uses the Clerk user ID as the Bankr idempotency key", () => {
    expect(buildBankrWalletIdempotencyKey(" user_123 ")).toBe("user_123");
    expect(() => buildBankrWalletIdempotencyKey("")).toThrow(/user ID is required/);
    expect(() => buildBankrWalletIdempotencyKey("x".repeat(129))).toThrow(/too long/);
  });

  it("normalizes Bankr wallet responses and never exposes API key material", () => {
    const parsed = parseBankrWalletResponse(bankrResponse);

    expect(parsed).toEqual({
      bankrWalletId: "wlt_A1b2C3d4",
      evmAddress: "0x000000000000000000000000000000000000dEaD",
      normalizedEvmAddress: normalizedAddress,
      solAddress: "ABC123xyz",
      status: "active",
      createdAt: "2026-04-24T11:59:00.000Z",
      apiKeyReturned: true,
    });
    expect(JSON.stringify(parsed)).not.toContain("bk_usr_should_not_be_stored");
  });

  it("returns a clean not_configured status without calling Bankr", async () => {
    const fetchImpl = jest.fn();

    await expect(
      provisionBankrWalletForUser({
        userId: "user_123",
        db: { from: jest.fn() },
        env: {},
        fetchImpl,
      })
    ).resolves.toEqual({ status: "not_configured" });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("provisions a Bankr wallet idempotently and stores a verified non-primary wallet", async () => {
    const existingWalletQuery = buildSelectMaybeSingleTable(null);
    const walletUpsert = buildUpsertTable({
      id: "wallet_1",
      user_id: "user_123",
      address: normalizedAddress,
      normalized_address: normalizedAddress,
      chain_type: "evm",
      chain_id: 8453,
      is_primary: false,
      verified_at: now.toISOString(),
      verification_reference: "wlt_A1b2C3d4",
    });
    const db = {
      from: jest.fn()
        .mockReturnValueOnce(existingWalletQuery)
        .mockReturnValueOnce(walletUpsert),
    };
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: jest.fn().mockResolvedValue(bankrResponse),
    });

    const result = await provisionBankrWalletForUser({
      userId: "user_123",
      db,
      env: {
        BANKR_PARTNER_KEY: "bk_ptr_secret",
        BANKR_API_BASE_URL: "https://api.example.test",
      },
      fetchImpl,
      now,
    });

    expect(fetchImpl).toHaveBeenCalledWith("https://api.example.test/partner/wallets", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Partner-Key": "bk_ptr_secret",
      },
      body: JSON.stringify({ idempotencyKey: "user_123" }),
    });
    expect(db.from).toHaveBeenCalledWith("user_wallets");
    expect(walletUpsert.upsert).toHaveBeenCalledWith(expect.objectContaining({
      user_id: "user_123",
      chain_id: 8453,
      address: normalizedAddress,
      normalized_address: normalizedAddress,
      verification_method: "bankr",
      verification_reference: "wlt_A1b2C3d4",
      metadata: {
        bankr: {
          walletId: "wlt_A1b2C3d4",
          status: "active",
          solAddress: "ABC123xyz",
          createdAt: "2026-04-24T11:59:00.000Z",
          provisionedAt: now.toISOString(),
          apiKeyReturned: true,
        },
      },
    }), { onConflict: "user_id,chain_type,normalized_address" });
    expect(walletUpsert.upsert.mock.calls[0][0]).not.toHaveProperty("is_primary");
    expect(JSON.stringify(walletUpsert.upsert.mock.calls)).not.toContain("bk_usr_should_not_be_stored");
    expect(result).toEqual({
      status: "provisioned",
      wallet: {
        id: "wallet_1",
        userId: "user_123",
        address: normalizedAddress,
        normalizedAddress,
        chainId: 8453,
        isPrimary: false,
        verifiedAt: now.toISOString(),
        bankrWalletId: "wlt_A1b2C3d4",
      },
      bankrWallet: {
        id: "wlt_A1b2C3d4",
        evmAddress: normalizedAddress,
        solAddress: "ABC123xyz",
        status: "active",
        createdAt: "2026-04-24T11:59:00.000Z",
      },
    });
  });

  it("can make a provisioned Bankr wallet primary only when explicitly requested", async () => {
    const existingWalletQuery = buildSelectMaybeSingleTable(null);
    const clearPrimary = buildThenableUpdateTable();
    const walletUpsert = buildUpsertTable({
      id: "wallet_1",
      user_id: "user_123",
      address: normalizedAddress,
      normalized_address: normalizedAddress,
      chain_type: "evm",
      chain_id: 8453,
      is_primary: true,
      verified_at: now.toISOString(),
      verification_reference: "wlt_A1b2C3d4",
    });
    const db = {
      from: jest.fn()
        .mockReturnValueOnce(existingWalletQuery)
        .mockReturnValueOnce(clearPrimary)
        .mockReturnValueOnce(walletUpsert),
    };
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue(bankrResponse),
    });

    const result = await provisionBankrWalletForUser({
      userId: "user_123",
      db,
      env: { BANKR_PARTNER_KEY: "bk_ptr_secret" },
      fetchImpl,
      now,
      makePrimary: true,
    });

    expect(clearPrimary.update).toHaveBeenCalledWith({ is_primary: false });
    expect(walletUpsert.upsert).toHaveBeenCalledWith(expect.objectContaining({
      is_primary: true,
    }), { onConflict: "user_id,chain_type,normalized_address" });
    expect(result.status).toBe("provisioned");
  });

  it("reuses an existing Bankr wallet without calling the Bankr API", async () => {
    const existingWalletQuery = buildSelectMaybeSingleTable({
      id: "wallet_1",
      user_id: "user_123",
      address: normalizedAddress,
      normalized_address: normalizedAddress,
      chain_type: "evm",
      chain_id: 8453,
      is_primary: false,
      verified_at: now.toISOString(),
      verification_reference: "wlt_A1b2C3d4",
    });
    const db = { from: jest.fn(() => existingWalletQuery) };
    const fetchImpl = jest.fn();

    const result = await provisionBankrWalletForUser({
      userId: "user_123",
      db,
      env: { BANKR_PARTNER_KEY: "bk_ptr_secret" },
      fetchImpl,
      now,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: "existing",
      wallet: {
        id: "wallet_1",
        userId: "user_123",
        address: normalizedAddress,
        normalizedAddress,
        chainId: 8453,
        isPrimary: false,
        verifiedAt: now.toISOString(),
        bankrWalletId: "wlt_A1b2C3d4",
      },
      bankrWallet: {
        id: "wlt_A1b2C3d4",
        evmAddress: normalizedAddress,
        solAddress: null,
        status: "active",
        createdAt: null,
      },
    });
  });

  it("promotes an existing Bankr wallet to primary without calling Bankr", async () => {
    const existingWalletQuery = buildSelectMaybeSingleTable({
      id: "wallet_1",
      user_id: "user_123",
      address: normalizedAddress,
      normalized_address: normalizedAddress,
      chain_type: "evm",
      chain_id: 8453,
      is_primary: false,
      verified_at: now.toISOString(),
      verification_reference: "wlt_A1b2C3d4",
    });
    const clearPrimary = buildThenableUpdateTable();
    const markPrimary = buildThenableUpdateTable();
    const db = {
      from: jest.fn()
        .mockReturnValueOnce(existingWalletQuery)
        .mockReturnValueOnce(clearPrimary)
        .mockReturnValueOnce(markPrimary),
    };
    const fetchImpl = jest.fn();

    const result = await provisionBankrWalletForUser({
      userId: "user_123",
      db,
      env: { BANKR_PARTNER_KEY: "bk_ptr_secret" },
      fetchImpl,
      now,
      makePrimary: true,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(clearPrimary.update).toHaveBeenCalledWith({ is_primary: false });
    expect(markPrimary.update).toHaveBeenCalledWith({ is_primary: true });
    expect(markPrimary.filter.eq).toHaveBeenCalledWith("id", "wallet_1");
    expect(markPrimary.filter.eq).toHaveBeenCalledWith("user_id", "user_123");
    expect(result).toMatchObject({
      status: "existing",
      wallet: {
        id: "wallet_1",
        isPrimary: true,
      },
      bankrWallet: {
        id: "wlt_A1b2C3d4",
        evmAddress: normalizedAddress,
      },
    });
  });

  it("loads the existing Bankr wallet without provisioning a new one", async () => {
    const walletQuery = buildSelectMaybeSingleTable({
      id: "wallet_1",
      user_id: "user_123",
      address: normalizedAddress,
      normalized_address: normalizedAddress,
      chain_type: "evm",
      chain_id: 8453,
      is_primary: false,
      verified_at: now.toISOString(),
      verification_reference: "wlt_A1b2C3d4",
    });
    const db = { from: jest.fn(() => walletQuery) };

    await expect(getBankrWalletForUser({ userId: "user_123", db })).resolves.toEqual({
      id: "wallet_1",
      userId: "user_123",
      address: normalizedAddress,
      normalizedAddress,
      chainId: 8453,
      isPrimary: false,
      verifiedAt: now.toISOString(),
      bankrWalletId: "wlt_A1b2C3d4",
    });

    expect(db.from).toHaveBeenCalledWith("user_wallets");
    expect(walletQuery.eq).toHaveBeenCalledWith("verification_method", "bankr");
    expect(walletQuery.order).toHaveBeenCalledWith("verified_at", { ascending: false });
    expect(walletQuery.limit).toHaveBeenCalledWith(1);
  });

  it("fails closed on Bankr API errors and invalid wallet responses", async () => {
    const existingWalletQuery = buildSelectMaybeSingleTable(null);
    await expect(
      provisionBankrWalletForUser({
        userId: "user_123",
        db: { from: jest.fn(() => existingWalletQuery) },
        env: { BANKR_PARTNER_KEY: "bk_ptr_secret" },
        fetchImpl: jest.fn().mockResolvedValue({
          ok: false,
          status: 403,
          json: jest.fn(),
        }),
      })
    ).rejects.toThrow(/status 403/);

    await expect(() => parseBankrWalletResponse({ id: "wlt_missing" })).toThrow(
      /missing required fields/
    );
  });
});
