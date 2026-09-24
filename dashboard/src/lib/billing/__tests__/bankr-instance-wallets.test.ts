import { decryptApiKey, encryptApiKey } from "@/lib/crypto";
import {
  AGENT_WALLET_CONNECT_CONSENT_VERSION,
  buildInstanceBankrAgentConfig,
  connectUserBankrWalletForOwner,
  decryptInstanceBankrApiKey,
  decryptInstanceBankrRuntimeApiKey,
  disconnectUserBankrWalletForOwner,
  instanceBankrWalletPublicSummary,
  isUserConnectedBankrWallet,
  listWithdrawalRecipientsForInstance,
  provisionBankrWalletForHivraAgent,
  provisionBankrWalletForInstance,
  readInstanceBankrWalletBalances,
  upsertWithdrawalRecipient,
  setWithdrawalDestination,
} from "@/lib/billing/bankr-instance-wallets";

// Public Base token contracts, named so the secret scan reads them as addresses.
const USDC_CONTRACT = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const HERMESOS_CONTRACT = "0x95ccfd2b81a9667b0cc979992632f98fc853eba3";
const BNKR_CONTRACT = "0x22af33fe49fd1fa80c7149773dde5890d3c76f3b";
const VVV_CONTRACT = "0xacfE6019Ed1A7Dc6f7B508C02d1b04ec88cC21bf";
const DIEM_CONTRACT = "0xf4d97f2da56e8c3098f3a8d538db630a2606a024";

const now = new Date("2026-05-02T12:00:00.000Z");
const instanceId = "inst_123";
const userId = "user_123";
const walletAddress = "0x000000000000000000000000000000000000bA5e";
const normalizedWalletAddress = "0x000000000000000000000000000000000000ba5e";
const apiKey = "bk_agent_secret_for_instance_wallet";

type Row = Record<string, unknown>;

function createSelectQuery(rows: Row[]) {
  const filters: Record<string, unknown> = {};
  let resultLimit: number | null = null;
  type SelectQuery = {
    select: jest.Mock;
    eq: jest.Mock;
    order: jest.Mock;
    limit: jest.Mock;
    maybeSingle: jest.Mock;
    single: jest.Mock;
    then: Promise<{ data: Row[]; error: null }>["then"];
  };
  const query = {} as SelectQuery;

  // Supports PostgREST JSON paths such as metadata->a->>b.
  const valueAt = (row: Row, column: string): unknown => {
    const [head, ...path] = column.split(/->>?/);
    return path.reduce<unknown>(
      (value, key) => (value && typeof value === "object" ? (value as Row)[key] : undefined),
      row[head]
    );
  };
  const findRows = () => {
    const filtered = rows.filter((row) =>
      Object.entries(filters).every(([column, value]) => valueAt(row, column) === value)
    );
    return resultLimit ? filtered.slice(0, resultLimit) : filtered;
  };

  query.select = jest.fn(() => query);
  query.eq = jest.fn((column: string, value: unknown) => {
    filters[column] = value;
    return query;
  });
  query.order = jest.fn(() => query);
  query.limit = jest.fn((limit: number) => {
    resultLimit = limit;
    return query;
  });
  query.maybeSingle = jest.fn(async () => ({ data: findRows()[0] ?? null, error: null }));
  query.single = jest.fn(async () => ({ data: findRows()[0] ?? null, error: null }));
  query.then = (resolve, reject) => Promise.resolve({ data: findRows(), error: null }).then(resolve, reject);
  return query;
}

function createMutationQuery(rows: Row[], patch: Row) {
  const filters: Record<string, unknown> = {};
  type MutationQuery = {
    eq: jest.Mock;
    select: jest.Mock;
    single: jest.Mock;
    then: Promise<{ error: null }>["then"];
  };
  const query = {} as MutationQuery;

  const updateRows = () => {
    let updated: Row | null = null;
    for (const row of rows) {
      if (Object.entries(filters).every(([column, value]) => row[column] === value)) {
        Object.assign(row, patch);
        if (typeof patch.evm_address === "string") {
          row.normalized_evm_address = patch.evm_address.toLowerCase();
        }
        updated = row;
      }
    }
    return updated;
  };

  query.eq = jest.fn((column: string, value: unknown) => {
    filters[column] = value;
    return query;
  });
  query.select = jest.fn(() => query);
  query.single = jest.fn(async () => ({ data: updateRows(), error: null }));
  query.then = (resolve, reject) => {
    updateRows();
    return Promise.resolve({ error: null }).then(resolve, reject);
  };
  return query;
}

function createMemoryDb() {
  const rows: Row[] = [];
  const recipientRows: Row[] = [];
  const userWalletRows: Row[] = [];

  return {
    rows,
    recipientRows,
    userWalletRows,
    db: {
      from: jest.fn((table: string) => {
        if (table === "user_wallets") {
          return { select: () => createSelectQuery(userWalletRows) };
        }
        if (table === "instance_bankr_wallet_recipients") {
          return {
            select: () => createSelectQuery(recipientRows),
            insert: jest.fn((row: Row) => {
              recipientRows.push({
                id: `recipient_row_${recipientRows.length + 1}`,
                created_at: now.toISOString(),
                updated_at: now.toISOString(),
                use_count: 0,
                ...row,
              });
              return {
                select: () => ({
                  single: async () => ({ data: recipientRows[recipientRows.length - 1], error: null }),
                }),
              };
            }),
            update: jest.fn((patch: Row) => createMutationQuery(recipientRows, patch)),
            upsert: jest.fn((row: Row) => {
              const existingIndex = recipientRows.findIndex((candidate) =>
                candidate.wallet_id === row.wallet_id &&
                candidate.normalized_address === row.normalized_address
              );
              const stored = {
                id: existingIndex >= 0 ? recipientRows[existingIndex].id : `recipient_row_${recipientRows.length + 1}`,
                created_at: now.toISOString(),
                updated_at: now.toISOString(),
                use_count: 0,
                ...row,
              };
              if (existingIndex >= 0) {
                recipientRows[existingIndex] = { ...recipientRows[existingIndex], ...stored };
              } else {
                recipientRows.push(stored);
              }
              return {
                select: () => ({
                  single: async () => ({
                    data: existingIndex >= 0 ? recipientRows[existingIndex] : recipientRows[recipientRows.length - 1],
                    error: null,
                  }),
                }),
              };
            }),
          };
        }

        if (table !== "instance_bankr_wallets") {
          throw new Error(`Unexpected table ${table}`);
        }

        return {
          select: () => createSelectQuery(rows),
          insert: jest.fn((row: Row) => {
            rows.push({
              id: `wallet_row_${rows.length + 1}`,
              normalized_evm_address:
                typeof row.evm_address === "string" ? row.evm_address.toLowerCase() : "",
              created_at: now.toISOString(),
              updated_at: now.toISOString(),
              ...row,
            });
            const stored = rows[rows.length - 1];
            return {
              select: () => ({
                single: async () => ({ data: stored, error: null }),
              }),
            };
          }),
          upsert: jest.fn((row: Row) => {
            const existingIndex = rows.findIndex((candidate) => candidate.instance_id === row.instance_id);
            const stored = {
              id: existingIndex >= 0 ? rows[existingIndex].id : `wallet_row_${rows.length + 1}`,
              normalized_evm_address:
                typeof row.evm_address === "string" ? row.evm_address.toLowerCase() : "",
              created_at: now.toISOString(),
              updated_at: now.toISOString(),
              ...row,
            };
            if (existingIndex >= 0) {
              rows[existingIndex] = { ...rows[existingIndex], ...stored };
            } else {
              rows.push(stored);
            }
            type UpsertQuery = {
              select: jest.Mock;
              single: jest.Mock;
            };
            const query = {} as UpsertQuery;
            query.select = jest.fn(() => query);
            query.single = jest.fn(async () => ({
              data: existingIndex >= 0 ? rows[existingIndex] : rows[rows.length - 1],
              error: null,
            }));
            return query;
          }),
          update: jest.fn((patch: Row) => createMutationQuery(rows, patch)),
        };
      }),
    },
  };
}

/** A wallet Hivra created through its partner account whose API key went missing. */
function seedProvisionedWalletWithoutKey(rows: Row[]) {
  rows.push({
    id: "wallet_row_1",
    instance_id: instanceId,
    hivra_agent_id: null,
    user_id: userId,
    bankr_wallet_id: "wlt_instance_123",
    evm_address: normalizedWalletAddress,
    normalized_evm_address: normalizedWalletAddress,
    api_key_encrypted: null,
    api_key_preview: null,
    api_key_status: "missing",
    withdrawal_destination_evm: null,
    withdrawal_destination_set_at: null,
    status: "active",
    metadata: { custodyModel: "bankr_custodied_agent_wallet" },
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  });
}

describe("Bankr instance wallets", () => {
  const originalEncryptionKey = process.env.ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = "a".repeat(64);
  });

  afterEach(() => {
    process.env.ENCRYPTION_KEY = originalEncryptionKey;
  });

  it("never creates a Hivra wallet for an agent without one and makes no Bankr call", async () => {
    const { db, rows } = createMemoryDb();
    const fetchImpl = jest.fn();

    const result = await provisionBankrWalletForInstance({
      instanceId,
      userId,
      db,
      env: { BANKR_PARTNER_KEY: "bk_ptr_secret" },
      fetchImpl,
      now,
    });

    const hivraResult = await provisionBankrWalletForHivraAgent({
      hivraAgentId: "agent_1",
      userId,
      db,
      env: { BANKR_PARTNER_KEY: "bk_ptr_secret" },
      fetchImpl,
      now,
    });

    expect(result).toEqual({ status: "connect_required", record: null });
    expect(hivraResult).toEqual({ status: "connect_required", record: null });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(rows).toHaveLength(0);
  });

  it("sends a pending row that never got a Bankr wallet to the connect flow", async () => {
    const { db, rows } = createMemoryDb();
    seedProvisionedWalletWithoutKey(rows);
    Object.assign(rows[0], {
      bankr_wallet_id: `pending:instance:${instanceId}`,
      evm_address: "0x0000000000000000000000000000000000000000",
      normalized_evm_address: "0x0000000000000000000000000000000000000000",
      status: "pending",
    });
    const fetchImpl = jest.fn();

    const result = await provisionBankrWalletForInstance({
      instanceId,
      userId,
      db,
      env: { BANKR_PARTNER_KEY: "bk_ptr_secret" },
      fetchImpl,
      now,
    });

    expect(result.status).toBe("connect_required");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(rows[0].status).toBe("pending");
  });

  it("keeps an existing Hivra wallet: stores a pending row and returns not_configured when the partner key is missing", async () => {
    const { db, rows } = createMemoryDb();
    seedProvisionedWalletWithoutKey(rows);
    const fetchImpl = jest.fn();

    const result = await provisionBankrWalletForInstance({
      instanceId,
      userId,
      db,
      env: {},
      fetchImpl,
      now,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.status).toBe("not_configured");
    expect(result.record?.status).toBe("pending");
    expect(result.record?.bankrWalletId).toBe("wlt_instance_123");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      instance_id: instanceId,
      user_id: userId,
      status: "pending",
      api_key_encrypted: null,
      api_key_preview: null,
      api_key_status: "missing",
    });
  });

  it("treats quoted-empty partner keys as not_configured without calling Bankr", async () => {
    const { db, rows } = createMemoryDb();
    seedProvisionedWalletWithoutKey(rows);
    const fetchImpl = jest.fn();

    const result = await provisionBankrWalletForInstance({
      instanceId,
      userId,
      db,
      env: { BANKR_PARTNER_KEY: '""' },
      fetchImpl,
      now,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.status).toBe("not_configured");
    expect(result.record?.metadata).toMatchObject({
      lastProvisionReason: "not_configured",
      lastProvisionAttemptAt: now.toISOString(),
    });
    expect(rows[0]).toMatchObject({
      instance_id: instanceId,
      status: "pending",
      api_key_status: "missing",
    });
  });

  it("stores a sanitized Bankr error body when partner wallet provisioning is rejected", async () => {
    const { db, rows } = createMemoryDb();
    seedProvisionedWalletWithoutKey(rows);
    const leakedKey = "bk_ptr_secret_that_must_not_be_logged";
    const fetchImpl = jest.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({
        error: "forbidden",
        message: "partner scope does not allow wallet creation",
        apiKey: leakedKey,
      }),
    }));

    const result = await provisionBankrWalletForInstance({
      instanceId,
      userId,
      db,
      env: { BANKR_PARTNER_KEY: "bk_ptr_secret" },
      fetchImpl,
      now,
    });

    const metadata = rows[0].metadata as Record<string, unknown>;
    const storedError = String(metadata.lastProvisionError);

    expect(result.status).toBe("pending");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(metadata).toMatchObject({
      lastProvisionReason: "bankr_rejected",
      lastProvisionAttemptAt: now.toISOString(),
      lastProvisionHttpStatus: 403,
      lastProvisionOperation: "Bankr wallet provisioning",
    });
    expect(storedError).toContain("Bankr wallet provisioning failed with status 403");
    expect(storedError).toContain("partner scope does not allow wallet creation");
    expect(storedError).toContain("[REDACTED]");
    expect(storedError).not.toContain(leakedKey);
  });

  it("re-keys an existing Hivra wallet with an unrestricted read-write API key and returns existing on the second call", async () => {
    const { db, rows } = createMemoryDb();
    seedProvisionedWalletWithoutKey(rows);
    const fetchImpl = jest.fn(async (input: string) => ({
      ok: true,
      status: 201,
      json: async () =>
        input.endsWith("/api-keys")
          ? { apiKey, preview: "bk_agent_...llet" }
          : {
              id: "wlt_instance_123",
              evmAddress: walletAddress,
              solAddress: null,
              status: "active",
              createdAt: now.toISOString(),
            },
    }));

    const first = await provisionBankrWalletForInstance({
      instanceId,
      userId,
      db,
      env: {
        BANKR_PARTNER_KEY: "bk_ptr_secret",
        BANKR_API_BASE_URL: "https://api.example.test",
      },
      fetchImpl,
      now,
    });
    const second = await provisionBankrWalletForInstance({
      instanceId,
      userId,
      db,
      env: { BANKR_PARTNER_KEY: "bk_ptr_secret" },
      fetchImpl,
      now,
    });

    expect(fetchImpl).toHaveBeenNthCalledWith(1, "https://api.example.test/partner/wallets", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ idempotencyKey: `instance:${instanceId}` }),
    }));
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "https://api.example.test/partner/wallets/wlt_instance_123/api-keys",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          name: "Hivra agent instance wallet",
          permissions: {
            walletApiEnabled: true,
            agentApiEnabled: false,
            llmGatewayEnabled: false,
            tokenLaunchApiEnabled: false,
            readOnly: false,
          },
        }),
      })
    );
    expect(first.status).toBe("provisioned");
    expect(first.record?.status).toBe("active");
    expect(first.record?.evmAddress).toBe(normalizedWalletAddress);
    expect(second.status).toBe("existing");
  });

  it("stores only encrypted API key material and never exposes it in the public summary", async () => {
    const { db, rows } = createMemoryDb();
    seedProvisionedWalletWithoutKey(rows);
    const fetchImpl = jest.fn(async (input: string) => ({
      ok: true,
      status: 201,
      json: async () =>
        input.endsWith("/api-keys")
          ? { apiKey }
          : { id: "wlt_instance_123", evmAddress: walletAddress, status: "active" },
    }));

    const result = await provisionBankrWalletForInstance({
      instanceId,
      userId,
      db,
      env: { BANKR_PARTNER_KEY: "bk_ptr_secret" },
      fetchImpl,
      now,
    });

    expect(rows[0].api_key_encrypted).not.toBe(apiKey);
    expect(decryptApiKey(String(rows[0].api_key_encrypted))).toBe(apiKey);
    await expect(decryptInstanceBankrApiKey(result.record!)).resolves.toBe(apiKey);
    expect(JSON.stringify(instanceBankrWalletPublicSummary(result.record))).not.toContain(apiKey);
    expect(instanceBankrWalletPublicSummary(result.record)).toEqual({
      evmAddress: normalizedWalletAddress,
      bankrWalletId: "wlt_instance_123",
      status: "active",
      withdrawalDestinationEvm: null,
      apiKeyStatus: "active",
      custody: "hivra_provisioned",
      apiKeyPreview: null,
      connectedAt: null,
    });
  });

  it("rejects malformed withdrawal destinations", async () => {
    const { db } = createMemoryDb();

    await expect(
      setWithdrawalDestination({
        instanceId,
        userId,
        destinationEvm: "not-an-address",
        db,
      })
    ).rejects.toThrow(/invalid evm address/i);
  });

  it("tracks recent withdrawal recipients and mirrors the primary address on the wallet", async () => {
    const { db, rows, recipientRows } = createMemoryDb();
    rows.push({
      id: "wallet_row_1",
      instance_id: instanceId,
      user_id: userId,
      bankr_wallet_id: "wlt_instance_123",
      evm_address: normalizedWalletAddress,
      normalized_evm_address: normalizedWalletAddress,
      api_key_encrypted: "encrypted",
      api_key_preview: "bk_...",
      api_key_status: "active",
      withdrawal_destination_evm: null,
      withdrawal_destination_set_at: null,
      status: "active",
      metadata: {},
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    });

    const primary = await upsertWithdrawalRecipient({
      instanceId,
      userId,
      address: "0x1111111111111111111111111111111111111111",
      setPrimary: true,
      db,
      now,
    });
    const recent = await upsertWithdrawalRecipient({
      instanceId,
      userId,
      address: "0x2222222222222222222222222222222222222222",
      db,
      now: new Date("2026-05-02T12:05:00.000Z"),
    });

    const recipients = await listWithdrawalRecipientsForInstance({ instanceId, userId, db });

    expect(primary.isPrimary).toBe(true);
    expect(recent.isPrimary).toBe(false);
    expect(rows[0]).toMatchObject({
      withdrawal_destination_evm: "0x1111111111111111111111111111111111111111",
    });
    expect(recipientRows).toHaveLength(2);
    expect(recipients.map((recipient) => ({
      address: recipient.address,
      isPrimary: recipient.isPrimary,
    }))).toEqual([
      { address: "0x1111111111111111111111111111111111111111", isPrimary: true },
      { address: "0x2222222222222222222222222222222222222222", isPrimary: false },
    ]);
  });

  it("returns Base ETH, USDC, HERMESOS, BNKR, VVV, and DIEM balances for an instance wallet", async () => {
    const rawByToken: Record<string, string> = {
      "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": "0x00000000000000000000000000000000000000000000000000000000002625a0",
      "0x95ccfd2b81a9667b0cc979992632f98fc853eba3": "0x00000000000000000000000000000000000000000000003635c9adc5dea00000",
      "0x22af33fe49fd1fa80c7149773dde5890d3c76f3b": "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
      "0xacfe6019ed1a7dc6f7b508c02d1b04ec88cc21bf": "0x00000000000000000000000000000000000000000000000006f05b59d3b20000",
      "0xf4d97f2da56e8c3098f3a8d538db630a2606a024": "0x00000000000000000000000000000000000000000000000029a2241af62c0000",
    };
    const fetchImpl = jest.fn(async (_input: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as {
        method: string;
        params: [{ to?: string }?, string?];
      };
      if (body.method === "eth_getBalance") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ result: "0xde0b6b3a7640000" }),
        };
      }
      const tokenAddress = body.params[0]?.to?.toLowerCase() || "";
      return {
        ok: true,
        status: 200,
        json: async () => ({ result: rawByToken[tokenAddress] ?? "0x0" }),
      };
    });

    const balances = await readInstanceBankrWalletBalances({
      walletAddress,
      env: { HERMES_BASE_RPC_URL: "https://base.example.test" },
      fetchImpl,
    });

    expect(balances).toEqual([
      {
        chain: "Base",
        tokenSymbol: "ETH",
        tokenAddress: null,
        tokenDecimals: 18,
        balanceDisplay: "1.0000",
      },
      {
        chain: "Base",
        tokenSymbol: "USDC",
        tokenAddress: USDC_CONTRACT,
        tokenDecimals: 6,
        balanceDisplay: "2.5",
      },
      {
        chain: "Base",
        tokenSymbol: "HERMESOS",
        tokenAddress: HERMESOS_CONTRACT,
        tokenDecimals: 18,
        balanceDisplay: "1000",
      },
      {
        chain: "Base",
        tokenSymbol: "BNKR",
        tokenAddress: BNKR_CONTRACT,
        tokenDecimals: 18,
        balanceDisplay: "1",
      },
      {
        chain: "Base",
        tokenSymbol: "VVV",
        tokenAddress: VVV_CONTRACT,
        tokenDecimals: 18,
        balanceDisplay: "0.5",
      },
      {
        chain: "Base",
        tokenSymbol: "DIEM",
        tokenAddress: DIEM_CONTRACT,
        tokenDecimals: 18,
        balanceDisplay: "3",
      },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it("formats zero Base ERC-20 balances with four decimals for the wallet card", async () => {
    const fetchImpl = jest.fn(async (_input: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { method: string };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          result:
            body.method === "eth_getBalance"
              ? "0x0"
              : "0x0000000000000000000000000000000000000000000000000000000000000000",
        }),
      };
    });

    const balances = await readInstanceBankrWalletBalances({
      walletAddress: "0x000000000000000000000000000000000000bEEF",
      env: { HERMES_BASE_RPC_URL: "https://base.example.test" },
      fetchImpl,
    });

    expect(balances).toEqual([
      {
        chain: "Base",
        tokenSymbol: "ETH",
        tokenAddress: null,
        tokenDecimals: 18,
        balanceDisplay: "0.0000",
      },
      {
        chain: "Base",
        tokenSymbol: "USDC",
        tokenAddress: USDC_CONTRACT,
        tokenDecimals: 6,
        balanceDisplay: "0.0000",
      },
      {
        chain: "Base",
        tokenSymbol: "HERMESOS",
        tokenAddress: HERMESOS_CONTRACT,
        tokenDecimals: 18,
        balanceDisplay: "0.0000",
      },
      {
        chain: "Base",
        tokenSymbol: "BNKR",
        tokenAddress: BNKR_CONTRACT,
        tokenDecimals: 18,
        balanceDisplay: "0.0000",
      },
      {
        chain: "Base",
        tokenSymbol: "VVV",
        tokenAddress: VVV_CONTRACT,
        tokenDecimals: 18,
        balanceDisplay: "0.0000",
      },
      {
        chain: "Base",
        tokenSymbol: "DIEM",
        tokenAddress: DIEM_CONTRACT,
        tokenDecimals: 18,
        balanceDisplay: "0.0000",
      },
    ]);
  });
});

// A made-up string in the shape of a Bankr partner key, which connect must refuse.
const PARTNER_SHAPED_FIXTURE = "bk_ptr_abcd1234_partner";

describe("user-connected Bankr accounts", () => {
  const originalEncryptionKey = process.env.ENCRYPTION_KEY;
  const userKey = "bk_usr_abcd1234_usersecretvalue000";
  const userWallet = "0x00000000000000000000000000000000000C0fFE";
  const normalizedUserWallet = userWallet.toLowerCase();
  const env = { BANKR_API_BASE_URL: "https://api.example.test", BANKR_PARTNER_KEY: "bk_ptr_secret" };

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = "a".repeat(64);
  });

  afterEach(() => {
    process.env.ENCRYPTION_KEY = originalEncryptionKey;
  });

  const emptyPortfolio = {
    success: true,
    balances: {
      // 0.00005 ETH: leftover gas top-up from Hivra's treasury, not a user balance.
      base: { nativeBalance: "0.00005", tokenBalances: [{ network: "base", token: { balance: "0", baseToken: { symbol: "USDC" } } }] },
      mainnet: { nativeBalance: "0", tokenBalances: [] },
    },
    nfts: [],
  };

  function bankrFetch(
    overrides: { meStatus?: number; meBody?: unknown; revokeStatus?: number; portfolioStatus?: number; portfolio?: unknown } = {}
  ) {
    return jest.fn(async (input: string) => {
      if (input.includes("/wallet/portfolio")) {
        const status = overrides.portfolioStatus ?? 200;
        return { ok: status < 400, status, json: async () => overrides.portfolio ?? emptyPortfolio };
      }
      if (input.endsWith("/wallet/me")) {
        const status = overrides.meStatus ?? 200;
        return {
          ok: status < 400,
          status,
          json: async () =>
            overrides.meBody ?? {
              success: true,
              wallets: [
                { chain: "evm", address: userWallet },
                { chain: "solana", address: "5DcKexample" },
              ],
            },
        };
      }
      const status = overrides.revokeStatus ?? 200;
      return { ok: status < 400, status, json: async () => ({}) };
    });
  }

  it("stores the user's key encrypted with consent, labels it user-owned and delivers it to the runtime", async () => {
    const { db, rows } = createMemoryDb();
    const fetchImpl = bankrFetch();

    const { record, replacedProvisionedWallet } = await connectUserBankrWalletForOwner({
      owner: { instanceId },
      userId,
      apiKey: `  ${userKey}  `,
      db,
      env,
      fetchImpl,
      now,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.example.test/wallet/me",
      expect.objectContaining({ method: "GET", headers: { "X-API-Key": userKey } })
    );
    expect(replacedProvisionedWallet).toBe(false);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      instance_id: instanceId,
      user_id: userId,
      bankr_wallet_id: `user:${normalizedUserWallet}`,
      evm_address: normalizedUserWallet,
      api_key_status: "active",
      status: "active",
      metadata: {
        custodyModel: "user_owned_bankr_account",
        connectedAt: now.toISOString(),
        consent: { version: AGENT_WALLET_CONNECT_CONSENT_VERSION, acceptedAt: now.toISOString() },
      },
    });
    expect(rows[0].api_key_encrypted).not.toContain(userKey);
    expect(decryptApiKey(String(rows[0].api_key_encrypted))).toBe(userKey);

    const summary = instanceBankrWalletPublicSummary(record);
    expect(summary).toMatchObject({
      evmAddress: normalizedUserWallet,
      custody: "user_connected",
      connectedAt: now.toISOString(),
    });
    expect(JSON.stringify(summary)).not.toContain(userKey);
    await expect(buildInstanceBankrAgentConfig(record)).resolves.toMatchObject({
      apiKey: userKey,
      walletAddress: normalizedUserWallet,
    });
    await expect(isUserConnectedBankrWallet({ owner: { instanceId }, db })).resolves.toBe(true);
  });

  it("refuses a Bankr partner key and malformed keys without calling Bankr", async () => {
    const { db, rows } = createMemoryDb();
    const fetchImpl = bankrFetch();

    await expect(
      connectUserBankrWalletForOwner({ owner: { instanceId }, userId, apiKey: PARTNER_SHAPED_FIXTURE, db, env, fetchImpl })
    ).rejects.toMatchObject({ code: "partner_key", httpStatus: 400 });
    await expect(
      connectUserBankrWalletForOwner({ owner: { instanceId }, userId, apiKey: "sk-not-a-bankr-key", db, env, fetchImpl })
    ).rejects.toMatchObject({ code: "invalid_key", httpStatus: 400 });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(rows).toHaveLength(0);
  });

  it("refuses a key Bankr rejects", async () => {
    const { db, rows } = createMemoryDb();

    await expect(
      connectUserBankrWalletForOwner({
        owner: { instanceId },
        userId,
        apiKey: userKey,
        db,
        env,
        fetchImpl: bankrFetch({ meStatus: 401 }),
      })
    ).rejects.toMatchObject({ code: "bankr_rejected", httpStatus: 400 });
    expect(rows).toHaveLength(0);
  });

  it("refuses to relabel a wallet Hivra created as the user's own account", async () => {
    const agentWalletDb = createMemoryDb();
    agentWalletDb.rows.push({
      id: "other_agent_wallet",
      instance_id: "inst_other",
      user_id: userId,
      bankr_wallet_id: "wlt_other",
      evm_address: normalizedUserWallet,
      normalized_evm_address: normalizedUserWallet,
      status: "active",
      api_key_status: "active",
      metadata: { custodyModel: "bankr_custodied_agent_wallet" },
    });
    await expect(
      connectUserBankrWalletForOwner({ owner: { instanceId }, userId, apiKey: userKey, db: agentWalletDb.db, env, fetchImpl: bankrFetch() })
    ).rejects.toMatchObject({ code: "hivra_provisioned_address" });

    const depositDb = createMemoryDb();
    depositDb.userWalletRows.push({
      id: "deposit_wallet",
      user_id: userId,
      normalized_address: normalizedUserWallet,
      verification_method: "bankr",
    });
    await expect(
      connectUserBankrWalletForOwner({ owner: { instanceId }, userId, apiKey: userKey, db: depositDb.db, env, fetchImpl: bankrFetch() })
    ).rejects.toMatchObject({ code: "hivra_provisioned_address" });
    expect(depositDb.rows).toHaveLength(0);
  });

  function seedActiveHivraWallet(rows: Row[]) {
    seedProvisionedWalletWithoutKey(rows);
    Object.assign(rows[0], { api_key_encrypted: encryptApiKey("bk_usr_hivraagentkey_000000"), api_key_status: "active" });
  }

  it("only switches an existing Hivra wallet when asked and once Bankr reports it empty, then revokes its keys", async () => {
    const { db, rows } = createMemoryDb();
    seedActiveHivraWallet(rows);

    await expect(
      connectUserBankrWalletForOwner({ owner: { instanceId }, userId, apiKey: userKey, db, env, fetchImpl: bankrFetch() })
    ).rejects.toMatchObject({ code: "replace_not_confirmed", httpStatus: 409 });

    const fetchImpl = bankrFetch();
    const result = await connectUserBankrWalletForOwner({
      owner: { instanceId },
      userId,
      apiKey: userKey,
      replaceProvisionedWallet: true,
      db,
      env,
      fetchImpl,
      now,
    });

    // The emptiness check reads every chain, low-value tokens and NFTs with the old wallet's own key.
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.example.test/wallet/portfolio?showLowValueTokens=true&include=nfts",
      expect.objectContaining({ method: "GET", headers: { "X-API-Key": "bk_usr_hivraagentkey_000000" } })
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.example.test/partner/wallets/wlt_instance_123/api-keys",
      expect.objectContaining({ method: "DELETE", headers: { "X-Partner-Key": "bk_ptr_secret" } })
    );
    expect(result).toMatchObject({ replacedProvisionedWallet: true, oldKeysRevoked: true });
    expect(rows).toHaveLength(1);
    expect(result.record.metadata).toMatchObject({
      custodyModel: "user_owned_bankr_account",
      replacedProvisionedWallet: {
        bankrWalletId: "wlt_instance_123",
        evmAddress: normalizedWalletAddress,
        oldKeysRevoked: true,
      },
    });
    expect(instanceBankrWalletPublicSummary(result.record)?.custody).toBe("user_connected");
  });

  it("blocks a switch while the old wallet holds anything Bankr reports, on any chain", async () => {
    const { db, rows } = createMemoryDb();
    seedActiveHivraWallet(rows);
    const holding = {
      success: true,
      balances: {
        base: {
          nativeBalance: "0.00005",
          tokenBalances: [{ network: "base", token: { balance: "12.5", baseToken: { symbol: "XYZ" } } }],
        },
        arbitrum: { nativeBalance: "0.01", tokenBalances: [] },
      },
      nfts: [{ name: "Thing #1" }],
    };

    await expect(
      connectUserBankrWalletForOwner({
        owner: { instanceId },
        userId,
        apiKey: userKey,
        replaceProvisionedWallet: true,
        db,
        env,
        fetchImpl: bankrFetch({ portfolio: holding }),
      })
    ).rejects.toMatchObject({
      code: "balance_not_empty",
      httpStatus: 409,
      message: expect.stringMatching(/12\.5 XYZ on base.*0\.01 native on arbitrum.*1 NFT/),
    });
    expect(rows[0].bankr_wallet_id).toBe("wlt_instance_123");
  });

  it("leaves unwhitelisted $0 airdrops behind but still blocks anything Bankr values or whitelists", async () => {
    const { db, rows } = createMemoryDb();
    seedActiveHivraWallet(rows);
    const airdrops = {
      success: true,
      balances: {
        base: {
          nativeBalance: "0",
          tokenBalances: [
            { network: "base", token: { balance: "1000000", balanceUSD: 0, whitelisted: false, baseToken: { symbol: "SPAM" } } },
            { network: "base", token: { balance: "4", balanceUSD: 0, whitelisted: false, baseToken: { symbol: "JUNK" } } },
          ],
        },
      },
      nfts: [],
    };

    const { record } = await connectUserBankrWalletForOwner({
      owner: { instanceId },
      userId,
      apiKey: userKey,
      replaceProvisionedWallet: true,
      db,
      env,
      fetchImpl: bankrFetch({ portfolio: airdrops }),
      now,
    });
    expect(record.metadata.replacedProvisionedWallet).toMatchObject({ ignoredZeroValueTokens: 2 });

    for (const token of [
      { balance: "3", balanceUSD: 3, whitelisted: false, baseToken: { symbol: "PRICED" } },
      { balance: "3", balanceUSD: 0, whitelisted: true, baseToken: { symbol: "LISTED" } },
      { balance: "3", whitelisted: false, baseToken: { symbol: "UNPRICED" } },
    ]) {
      const again = createMemoryDb();
      seedActiveHivraWallet(again.rows);
      await expect(
        connectUserBankrWalletForOwner({
          owner: { instanceId },
          userId,
          apiKey: userKey,
          replaceProvisionedWallet: true,
          db: again.db,
          env,
          fetchImpl: bankrFetch({
            portfolio: { success: true, balances: { base: { nativeBalance: "0", tokenBalances: [{ token }] } }, nfts: [] },
          }),
        })
      ).rejects.toMatchObject({ code: "balance_not_empty" });
    }
  });

  it("fails closed when the old wallet's holdings can't be read", async () => {
    const { db, rows } = createMemoryDb();
    seedActiveHivraWallet(rows);

    const unreadable = [
      { success: true },
      // An empty balance map is not proof of an empty wallet on Base.
      { success: true, balances: {}, nfts: [] },
      // Fields missing or renamed must not read as zero.
      { success: true, balances: { base: { tokenBalances: [] } }, nfts: [] },
      { success: true, balances: { base: { nativeBalance: "0", tokens: [] } }, nfts: [] },
      { success: true, balances: { base: { nativeBalance: "0", tokenBalances: [{ token: { amount: "5" } }] } }, nfts: [] },
      { success: true, balances: { base: { nativeBalance: "0", tokenBalances: [] } } },
      { success: true, balances: { base: { nativeBalance: 0.5, tokenBalances: [] } }, nfts: [] },
    ];
    for (const fetchImpl of [bankrFetch({ portfolioStatus: 502 }), ...unreadable.map((portfolio) => bankrFetch({ portfolio }))]) {
      await expect(
        connectUserBankrWalletForOwner({ owner: { instanceId }, userId, apiKey: userKey, replaceProvisionedWallet: true, db, env, fetchImpl })
      ).rejects.toMatchObject({ code: "balance_unavailable", httpStatus: 503 });
    }
    expect(rows[0].bankr_wallet_id).toBe("wlt_instance_123");
  });

  it("updates the row a concurrent connect inserted instead of failing", async () => {
    const memory = createMemoryDb();
    const racingDb = {
      from: (tableName: string) => {
        const real = memory.db.from(tableName) as Record<string, unknown>;
        if (tableName !== "instance_bankr_wallets") return real;
        return {
          ...real,
          // The other request's row lands first; this insert then hits the unique index.
          insert: jest.fn(() => {
            memory.rows.push({
              id: "wallet_row_racer",
              instance_id: instanceId,
              user_id: userId,
              bankr_wallet_id: `user:${normalizedUserWallet}`,
              evm_address: normalizedUserWallet,
              normalized_evm_address: normalizedUserWallet,
              status: "active",
              api_key_status: "active",
              metadata: { custodyModel: "user_owned_bankr_account" },
            });
            return {
              select: () => ({
                single: async () => ({ data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } }),
              }),
            };
          }),
        };
      },
    };

    const { record } = await connectUserBankrWalletForOwner({ owner: { instanceId }, userId, apiKey: userKey, db: racingDb, env, fetchImpl: bankrFetch(), now });

    expect(memory.rows).toHaveLength(1);
    expect(record.id).toBe("wallet_row_racer");
    expect(decryptApiKey(String(memory.rows[0].api_key_encrypted))).toBe(userKey);
  });

  it("returns a failed revocation to the caller instead of hiding it", async () => {
    const { db, rows } = createMemoryDb();
    seedActiveHivraWallet(rows);

    const result = await connectUserBankrWalletForOwner({
      owner: { instanceId },
      userId,
      apiKey: userKey,
      replaceProvisionedWallet: true,
      db,
      env,
      fetchImpl: bankrFetch({ revokeStatus: 500 }),
      now,
    });

    expect(result.oldKeysRevoked).toBe(false);
    expect(result.record.metadata.replacedProvisionedWallet).toMatchObject({
      oldKeysRevoked: false,
      oldKeysRevokeError: "Bankr returned 500",
    });
  });

  it("keeps the replaced wallet on record across reconnects and never accepts its key as the user's own", async () => {
    const { db, rows } = createMemoryDb();
    seedActiveHivraWallet(rows);
    await connectUserBankrWalletForOwner({ owner: { instanceId }, userId, apiKey: userKey, replaceProvisionedWallet: true, db, env, fetchImpl: bankrFetch(), now });
    await disconnectUserBankrWalletForOwner({ owner: { instanceId }, userId, db, now });

    const { record } = await connectUserBankrWalletForOwner({ owner: { instanceId }, userId, apiKey: userKey, db, env, fetchImpl: bankrFetch(), now });
    expect(record.metadata.replacedProvisionedWallet).toMatchObject({
      bankrWalletId: "wlt_instance_123",
      evmAddress: normalizedWalletAddress,
    });

    // The old Hivra wallet's key, read off the box and pasted into another agent.
    await expect(
      connectUserBankrWalletForOwner({
        owner: { instanceId: "inst_other" },
        userId,
        apiKey: "bk_usr_hivraagentkey_000000",
        db,
        env,
        fetchImpl: bankrFetch({ meBody: { success: true, wallets: [{ chain: "evm", address: walletAddress }] } }),
      })
    ).rejects.toMatchObject({ code: "hivra_provisioned_address" });
  });

  it("never hands Hivra a user's own key for a transfer, only the runtime", async () => {
    const { db } = createMemoryDb();
    const { record } = await connectUserBankrWalletForOwner({ owner: { instanceId }, userId, apiKey: userKey, db, env, fetchImpl: bankrFetch(), now });

    await expect(decryptInstanceBankrApiKey(record)).resolves.toBeNull();
    await expect(decryptInstanceBankrRuntimeApiKey(record)).resolves.toBe(userKey);
  });

  it("disconnect deletes Hivra's copy of the key and the agent then needs a new connect", async () => {
    const { db, rows } = createMemoryDb();
    await connectUserBankrWalletForOwner({ owner: { instanceId }, userId, apiKey: userKey, db, env, fetchImpl: bankrFetch(), now });

    const record = await disconnectUserBankrWalletForOwner({ owner: { instanceId }, userId, db, now });

    expect(rows[0]).toMatchObject({
      api_key_encrypted: null,
      api_key_preview: null,
      api_key_status: "revoked",
      status: "revoked",
    });
    await expect(buildInstanceBankrAgentConfig(record)).resolves.toBeNull();
    expect(instanceBankrWalletPublicSummary(record)).toMatchObject({ evmAddress: null, custody: "user_connected", apiKeyPreview: null });

    const partnerFetch = jest.fn();
    await expect(
      provisionBankrWalletForInstance({ instanceId, userId, db, env, fetchImpl: partnerFetch, now })
    ).resolves.toMatchObject({ status: "connect_required" });
    expect(partnerFetch).not.toHaveBeenCalled();
    await expect(disconnectUserBankrWalletForOwner({ owner: { instanceId }, userId, db, now })).rejects.toMatchObject({
      code: "not_connected",
    });
  });

  it("will not disconnect a wallet Hivra created", async () => {
    const { db, rows } = createMemoryDb();
    seedProvisionedWalletWithoutKey(rows);

    await expect(disconnectUserBankrWalletForOwner({ owner: { instanceId }, userId, db })).rejects.toMatchObject({
      code: "not_connected",
    });
    await expect(isUserConnectedBankrWallet({ owner: { instanceId }, db })).resolves.toBe(false);
  });
});
