import { decryptApiKey } from "@/lib/crypto";
import {
  bankrDepositWalletPublicSummary,
  buildBankrDepositWalletApiKeyRequest,
  ensureBankrDepositWalletForUser,
  getBankrTreasuryConfig,
} from "@/lib/billing/bankr-deposit-wallets";

const now = new Date("2026-04-24T12:00:00.000Z");
const treasuryAddress = "0x000000000000000000000000000000000000fEeD";
const normalizedTreasuryAddress = "0x000000000000000000000000000000000000feed";
const depositAddress = "0x000000000000000000000000000000000000bA5e";
const normalizedDepositAddress = "0x000000000000000000000000000000000000ba5e";

function createThenableUpdateTable(rows: Array<Record<string, unknown>>) {
  return (patch: Record<string, unknown>) => {
    const filters: Record<string, unknown> = {};
    const query: {
      eq: jest.Mock;
      then: Promise<{ error: null }>["then"];
    } = {} as {
      eq: jest.Mock;
      then: Promise<{ error: null }>["then"];
    };

    query.eq = jest.fn((column: string, value: unknown) => {
      filters[column] = value;
      return query;
    });
    query.then = (resolve, reject) => {
      for (const row of rows) {
        if (Object.entries(filters).every(([column, value]) => row[column] === value)) {
          Object.assign(row, patch);
        }
      }

      return Promise.resolve({ error: null }).then(resolve, reject);
    };

    return query;
  };
}

function createSelectQuery(rows: Array<Record<string, unknown>>) {
  const filters: Record<string, unknown> = {};
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
  query.eq = jest.fn((column: string, value: unknown) => {
    filters[column] = value;
    return query;
  });
  query.order = jest.fn(() => query);
  query.limit = jest.fn(() => query);
  query.maybeSingle = jest.fn(async () => ({
    data: rows.find((row) =>
      Object.entries(filters).every(([column, value]) => readColumn(row, column) === value)
    ) ?? null,
    error: null,
  }));

  return query;
}

// PostgREST JSON path filters (`metadata->bankr->>purpose`) read into the row.
function readColumn(row: Record<string, unknown>, column: string): unknown {
  if (!column.includes("->")) return row[column];
  const [base, ...path] = column.split(/->>?/);
  let value: unknown = row[base];
  for (const key of path) {
    value = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
  }
  return value;
}

function createUpsertQuery(
  rows: Array<Record<string, unknown>>,
  buildRow: (row: Record<string, unknown>) => Record<string, unknown>,
  conflictsWith?: (candidate: Record<string, unknown>, stored: Record<string, unknown>) => boolean
) {
  const query: {
    upsert: jest.Mock;
    select: jest.Mock;
    single: jest.Mock;
    row: Record<string, unknown> | null;
  } = {} as {
    upsert: jest.Mock;
    select: jest.Mock;
    single: jest.Mock;
    row: Record<string, unknown> | null;
  };

  query.row = null;
  query.upsert = jest.fn((row: Record<string, unknown>) => {
    const stored = buildRow(row);
    const existingIndex = rows.findIndex((candidate) => {
      if (conflictsWith) return conflictsWith(candidate, stored);
      if (stored.user_id && stored.purpose && candidate.user_id === stored.user_id && candidate.purpose === stored.purpose) return true;
      if (stored.user_id && !stored.purpose && candidate.user_id === stored.user_id) return true;
      return stored.normalized_address && candidate.normalized_address === stored.normalized_address;
    });

    if (existingIndex >= 0) {
      rows[existingIndex] = { ...rows[existingIndex], ...stored };
      query.row = rows[existingIndex];
    } else {
      rows.push(stored);
      query.row = stored;
    }

    return query;
  });
  query.select = jest.fn(() => query);
  query.single = jest.fn(async () => ({ data: query.row, error: null }));

  return query;
}

function createMemoryDb() {
  const wallets: Array<Record<string, unknown>> = [];
  const credentials: Array<Record<string, unknown>> = [];

  return {
    wallets,
    credentials,
    db: {
      from: jest.fn((name: string) => {
        if (name === "user_wallets") {
          return {
            select: () => createSelectQuery(wallets),
            update: createThenableUpdateTable(wallets),
            upsert: (...args: unknown[]) =>
              createUpsertQuery(
                wallets,
                (row) => ({
                  id: "wallet_1",
                  is_primary: false,
                  ...row,
                }),
                // onConflict: "user_id,chain_type,normalized_address"
                (candidate, stored) =>
                  candidate.user_id === stored.user_id &&
                  candidate.chain_type === stored.chain_type &&
                  candidate.normalized_address === stored.normalized_address
              ).upsert(...args),
          };
        }

        if (name === "bankr_deposit_wallet_credentials") {
          return {
            select: () => createSelectQuery(credentials),
            upsert: (...args: unknown[]) =>
              createUpsertQuery(credentials, (row) => ({
                id: "credential_1",
                created_at: now.toISOString(),
                ...row,
              })).upsert(...args),
          };
        }

        throw new Error(`Unexpected table ${name}`);
      }),
    },
  };
}

describe("Bankr deposit wallets", () => {
  const originalEncryptionKey = process.env.ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = "a".repeat(64);
  });

  afterEach(() => {
    process.env.ENCRYPTION_KEY = originalEncryptionKey;
  });

  it("builds a restricted Bankr wallet API key request for Hivra deposits", () => {
    const config = getBankrTreasuryConfig({
      HERMES_TREASURY_BASE_ADDRESS: treasuryAddress,
      BANKR_DEPOSIT_WALLET_ALLOWED_IPS: "203.0.113.10, 203.0.113.11",
      BANKR_DEPOSIT_SWEEP_ENABLED: "true",
    });

    expect(config).toEqual({
      treasuryAddress: normalizedTreasuryAddress,
      sweepEnabled: true,
      allowedIps: ["203.0.113.10", "203.0.113.11"],
    });
    expect(buildBankrDepositWalletApiKeyRequest(config)).toEqual({
      name: "Hivra deposit sweeper",
      permissions: {
        walletApiEnabled: true,
        agentApiEnabled: false,
        llmGatewayEnabled: false,
        tokenLaunchApiEnabled: false,
        readOnly: false,
      },
      allowedIps: ["203.0.113.10", "203.0.113.11"],
      allowedRecipients: {
        evm: [normalizedTreasuryAddress],
        solana: [],
      },
    });
  });

  it("accepts the production treasury env alias used by Vercel", () => {
    const config = getBankrTreasuryConfig({
      HERMES_TREASURY_ADDRESS: treasuryAddress,
      BANKR_DEPOSIT_WALLET_ALLOWED_IPS: "203.0.113.10",
    });

    expect(config.treasuryAddress).toBe(normalizedTreasuryAddress);
    expect(buildBankrDepositWalletApiKeyRequest(config)?.allowedRecipients?.evm).toEqual([
      normalizedTreasuryAddress,
    ]);
  });

  it("strips quoted Vercel env values before validating the treasury address", () => {
    const config = getBankrTreasuryConfig({
      HERMES_TREASURY_ADDRESS: `"${treasuryAddress}"`,
    });

    expect(config.treasuryAddress).toBe(normalizedTreasuryAddress);
  });

  it("provisions a platform deposit wallet and stores only encrypted Bankr API key material", async () => {
    const { db, credentials } = createMemoryDb();
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({
        id: "wlt_A1b2C3d4",
        evmAddress: depositAddress,
        solAddress: null,
        status: "active",
        createdAt: now.toISOString(),
        apiKey: "bk_usr_secret_for_sweeping",
      }),
    }));

    const result = await ensureBankrDepositWalletForUser({
      userId: "user_123",
      db,
      env: {
        BANKR_PARTNER_KEY: "bk_ptr_secret",
        BANKR_API_BASE_URL: "https://api.example.test",
        HERMES_TREASURY_BASE_ADDRESS: treasuryAddress,
        BANKR_DEPOSIT_WALLET_ALLOWED_IPS: "203.0.113.10",
      },
      fetchImpl,
      now,
      makePrimary: true,
    });

    expect(fetchImpl).toHaveBeenCalledWith("https://api.example.test/partner/wallets", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        idempotencyKey: "user_123:credit_deposit",
        apiKey: {
          name: "Hivra deposit sweeper",
          permissions: {
            walletApiEnabled: true,
            agentApiEnabled: false,
            llmGatewayEnabled: false,
            tokenLaunchApiEnabled: false,
            readOnly: false,
          },
          allowedIps: ["203.0.113.10"],
          allowedRecipients: {
            evm: [normalizedTreasuryAddress],
            solana: [],
          },
        },
      }),
    }));

    expect(result.status).toBe("provisioned");
    if (result.status === "not_configured") {
      throw new Error("Expected Bankr deposit wallet provisioning to be configured");
    }
    expect(result.bankrWallet.evmAddress).toBe(normalizedDepositAddress);
    expect(result.credential?.apiKeyStatus).toBe("active");
    expect(result.credential?.apiKeyPreview).toBe("bk_usr_sec...ping");
    expect(result.credential?.allowedRecipientEvm).toBe(normalizedTreasuryAddress);
    expect(result.credential?.allowedIps).toEqual(["203.0.113.10"]);
    expect(credentials).toHaveLength(1);
    expect(credentials[0].api_key_encrypted).not.toBe("bk_usr_secret_for_sweeping");
    expect(decryptApiKey(String(credentials[0].api_key_encrypted))).toBe("bk_usr_secret_for_sweeping");
    expect(JSON.stringify(bankrDepositWalletPublicSummary(result.credential))).not.toContain("bk_usr_secret_for_sweeping");
    expect(bankrDepositWalletPublicSummary(result.credential)).toEqual({
      custodyModel: "platform_deposit_address",
      purpose: "credit_deposit",
      address: normalizedDepositAddress,
      normalizedAddress: normalizedDepositAddress,
      bankrWalletId: "wlt_A1b2C3d4",
      sweepReady: true,
      allowedRecipientEvm: normalizedTreasuryAddress,
    });
  });

  it("provisions managed Venice deposit wallets against the managed Venice treasury", async () => {
    const { db } = createMemoryDb();
    const managedVeniceTreasury = "0x000000000000000000000000000000000000D00D";
    const normalizedManagedVeniceTreasury = "0x000000000000000000000000000000000000d00d";
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({
        id: "wlt_Venice",
        evmAddress: depositAddress,
        solAddress: null,
        status: "active",
        createdAt: now.toISOString(),
        apiKey: "bk_usr_secret_for_managed_venice_sweeping",
      }),
    }));

    const result = await ensureBankrDepositWalletForUser({
      userId: "user_123",
      purpose: "managed_venice_inference",
      db,
      env: {
        BANKR_PARTNER_KEY: "bk_ptr_secret",
        BANKR_API_BASE_URL: "https://api.example.test",
        HERMES_TREASURY_BASE_ADDRESS: treasuryAddress,
        MANAGED_VENICE_TREASURY_BASE_ADDRESS: managedVeniceTreasury,
        BANKR_DEPOSIT_WALLET_ALLOWED_IPS: "203.0.113.10",
      },
      fetchImpl,
      now,
      makePrimary: false,
    });

    expect(fetchImpl).toHaveBeenCalledWith("https://api.example.test/partner/wallets", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        idempotencyKey: "user_123:managed_venice_inference",
        apiKey: {
          name: "Hivra managed Venice treasury sweeper",
          permissions: {
            walletApiEnabled: true,
            agentApiEnabled: false,
            llmGatewayEnabled: false,
            tokenLaunchApiEnabled: false,
            readOnly: false,
          },
          allowedIps: ["203.0.113.10"],
          allowedRecipients: {
            evm: [normalizedManagedVeniceTreasury],
            solana: [],
          },
        },
      }),
    }));

    expect(result.status).toBe("provisioned");
    if (result.status === "not_configured") {
      throw new Error("Expected Bankr deposit wallet provisioning to be configured");
    }
    expect(result.credential?.purpose).toBe("managed_venice_inference");
    expect(result.credential?.allowedRecipientEvm).toBe(normalizedManagedVeniceTreasury);
    expect(result.credential?.apiKeyStatus).toBe("active");
  });

  // A platform deposit wallet can never back token-tier standing, so it must
  // never displace the wallet the user proved they own as their primary.
  // Demoting that wallet left tier eligibility without any wallet the
  // holdings cron could re-read.
  describe("never displaces the user's verified wallet as primary", () => {
    const signedAddress = "0x000000000000000000000000000000000000c0de";
    const signedWallet = () => ({
      id: "wallet_signed",
      user_id: "user_123",
      chain_type: "evm",
      chain_id: 8453,
      address: signedAddress,
      normalized_address: signedAddress,
      is_primary: true,
      verified_at: "2026-04-20T12:00:00.000Z",
      verification_method: "signature",
      metadata: {},
    });
    const env = {
      BANKR_PARTNER_KEY: "bk_ptr_secret",
      BANKR_API_BASE_URL: "https://api.example.test",
      HERMES_TREASURY_BASE_ADDRESS: treasuryAddress,
    };

    it("when a new deposit wallet is provisioned", async () => {
      const { db, wallets } = createMemoryDb();
      wallets.push(signedWallet());
      const fetchImpl = jest.fn(async () => ({
        ok: true,
        status: 201,
        json: async () => ({
          id: "wlt_New",
          evmAddress: depositAddress,
          solAddress: null,
          status: "active",
          createdAt: now.toISOString(),
          apiKey: "bk_usr_secret_for_sweeping",
        }),
      }));

      const result = await ensureBankrDepositWalletForUser({
        userId: "user_123",
        purpose: "credit_deposit",
        db,
        env,
        fetchImpl,
        now,
      });

      expect(result.status).toBe("provisioned");
      expect(wallets.find((row) => row.id === "wallet_signed")?.is_primary).toBe(true);
      const deposit = wallets.find((row) => row.normalized_address === normalizedDepositAddress);
      expect(deposit?.is_primary).toBe(false);
    });

    it("when an existing deposit wallet is re-used", async () => {
      const { db, wallets } = createMemoryDb();
      wallets.push(signedWallet(), {
        id: "wallet_deposit",
        user_id: "user_123",
        chain_type: "evm",
        chain_id: 8453,
        address: normalizedDepositAddress,
        normalized_address: normalizedDepositAddress,
        is_primary: false,
        verified_at: "2026-04-21T12:00:00.000Z",
        verification_method: "bankr",
        verification_reference: "wlt_Existing",
        metadata: { bankr: { walletId: "wlt_Existing", purpose: "credit_deposit" } },
      });
      const fetchImpl = jest.fn(async () => ({
        ok: true,
        status: 201,
        json: async () => ({ apiKey: "bk_usr_secret_for_sweeping" }),
      }));

      const result = await ensureBankrDepositWalletForUser({
        userId: "user_123",
        purpose: "credit_deposit",
        db,
        env,
        fetchImpl,
        now,
      });

      expect(result.status).toBe("existing");
      expect(wallets.find((row) => row.id === "wallet_signed")?.is_primary).toBe(true);
      expect(wallets.find((row) => row.id === "wallet_deposit")?.is_primary).toBe(false);
    });
  });
});
