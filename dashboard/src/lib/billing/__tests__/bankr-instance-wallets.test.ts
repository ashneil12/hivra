import { decryptApiKey } from "@/lib/crypto";
import {
  decryptInstanceBankrApiKey,
  instanceBankrWalletPublicSummary,
  listWithdrawalRecipientsForInstance,
  provisionBankrWalletForInstance,
  readInstanceBankrWalletBalances,
  upsertWithdrawalRecipient,
  setWithdrawalDestination,
} from "@/lib/billing/bankr-instance-wallets";

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

  const findRows = () => {
    const filtered = rows.filter((row) =>
      Object.entries(filters).every(([column, value]) => row[column] === value)
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

  return {
    rows,
    recipientRows,
    db: {
      from: jest.fn((table: string) => {
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
          insert: jest.fn(async (row: Row) => {
            rows.push({
              id: `wallet_row_${rows.length + 1}`,
              normalized_evm_address:
                typeof row.evm_address === "string" ? row.evm_address.toLowerCase() : "",
              created_at: now.toISOString(),
              updated_at: now.toISOString(),
              ...row,
            });
            return { error: null };
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

describe("Bankr instance wallets", () => {
  const originalEncryptionKey = process.env.ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = "a".repeat(64);
  });

  afterEach(() => {
    process.env.ENCRYPTION_KEY = originalEncryptionKey;
  });

  it("creates a pending row and returns not_configured when the partner key is missing", async () => {
    const { db, rows } = createMemoryDb();
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

  it("provisions an unrestricted read-write wallet API key and returns existing on the second call", async () => {
    const { db } = createMemoryDb();
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
        tokenAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        tokenDecimals: 6,
        balanceDisplay: "2.5",
      },
      {
        chain: "Base",
        tokenSymbol: "HERMESOS",
        tokenAddress: "0x95ccfd2b81a9667b0cc979992632f98fc853eba3",
        tokenDecimals: 18,
        balanceDisplay: "1000",
      },
      {
        chain: "Base",
        tokenSymbol: "BNKR",
        tokenAddress: "0x22af33fe49fd1fa80c7149773dde5890d3c76f3b",
        tokenDecimals: 18,
        balanceDisplay: "1",
      },
      {
        chain: "Base",
        tokenSymbol: "VVV",
        tokenAddress: "0xacfE6019Ed1A7Dc6f7B508C02d1b04ec88cC21bf",
        tokenDecimals: 18,
        balanceDisplay: "0.5",
      },
      {
        chain: "Base",
        tokenSymbol: "DIEM",
        tokenAddress: "0xf4d97f2da56e8c3098f3a8d538db630a2606a024",
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
        tokenAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        tokenDecimals: 6,
        balanceDisplay: "0.0000",
      },
      {
        chain: "Base",
        tokenSymbol: "HERMESOS",
        tokenAddress: "0x95ccfd2b81a9667b0cc979992632f98fc853eba3",
        tokenDecimals: 18,
        balanceDisplay: "0.0000",
      },
      {
        chain: "Base",
        tokenSymbol: "BNKR",
        tokenAddress: "0x22af33fe49fd1fa80c7149773dde5890d3c76f3b",
        tokenDecimals: 18,
        balanceDisplay: "0.0000",
      },
      {
        chain: "Base",
        tokenSymbol: "VVV",
        tokenAddress: "0xacfE6019Ed1A7Dc6f7B508C02d1b04ec88cC21bf",
        tokenDecimals: 18,
        balanceDisplay: "0.0000",
      },
      {
        chain: "Base",
        tokenSymbol: "DIEM",
        tokenAddress: "0xf4d97f2da56e8c3098f3a8d538db630a2606a024",
        tokenDecimals: 18,
        balanceDisplay: "0.0000",
      },
    ]);
  });
});
