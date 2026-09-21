import {
  ERC20_TRANSFER_TOPIC,
  encodeErc20TransferToTopic,
  reconcilePendingCryptoTopUps,
} from "@/lib/billing/crypto-reconciliation";
import { USDC_BASE_TOKEN_ADDRESS } from "@/lib/billing/crypto-topups";

const now = new Date("2026-04-24T12:00:00.000Z");
const depositAddressOne = "0x000000000000000000000000000000000000dEaD";
const normalizedDepositAddressOne = "0x000000000000000000000000000000000000dead";
const normalizedDepositAddressTwo = "0x000000000000000000000000000000000000beef";

function uint256(value: bigint | number) {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

function makePayment(overrides: Record<string, unknown> = {}) {
  return {
    id: "payment_1",
    user_id: "user_123",
    provider: "bankr",
    provider_reference_id: "bankr_crypto_topup:test",
    status: "pending",
    asset: "usdc_base",
    amount_minor: 10_000_000,
    package_credits: 1000,
    metadata: {
      type: "crypto_topup_intent",
      depositAddress: normalizedDepositAddressOne,
    },
    created_at: "2026-04-24T11:00:00.000Z",
    ...overrides,
  };
}

function createDb(initialPayments: Array<Record<string, unknown>>) {
  const payments = initialPayments.map((payment) => ({ ...payment }));
  const receipts: Array<Record<string, unknown>> = [];

  function paymentTransactionsTable() {
    const filters: Record<string, unknown> = {};
    const query: {
      select: jest.Mock;
      eq: jest.Mock;
      order: jest.Mock;
      limit: jest.Mock;
    } = {} as {
      select: jest.Mock;
      eq: jest.Mock;
      order: jest.Mock;
      limit: jest.Mock;
    };

    query.select = jest.fn(() => query);
    query.eq = jest.fn((column: string, value: unknown) => {
        filters[column] = value;
        return query;
      });
    query.order = jest.fn(() => query);
    query.limit = jest.fn(async (limit: number) => ({
        data: payments
          .filter((payment) => Object.entries(filters).every(([column, value]) => payment[column] === value))
          .slice(0, limit),
        error: null,
      }));

    return query;
  }

  function cryptoDepositReceiptsTable() {
    return {
      // Models loadConsumedTransferKeys: .select().eq().eq().limit()
      // (reference_id is excluded in JS by the caller, not via .neq).
      select: (_cols: string) => {
        const eqFilters: Record<string, unknown> = {};
        const query: {
          eq: jest.Mock;
          limit: jest.Mock;
        } = {} as {
          eq: jest.Mock;
          limit: jest.Mock;
        };
        query.eq = jest.fn((column: string, value: unknown) => {
          eqFilters[column] = value;
          return query;
        });
        query.limit = jest.fn(async () => ({
          data: receipts.filter((receipt) =>
            Object.entries(eqFilters).every(([c, v]) => receipt[c] === v)
          ),
          error: null,
        }));
        return query;
      },
      upsert: jest.fn(async (row: Record<string, unknown>) => {
        const existing = receipts.findIndex((receipt) =>
          receipt.provider === row.provider && receipt.reference_id === row.reference_id
        );

        if (existing >= 0) {
          receipts[existing] = { ...receipts[existing], ...row };
        } else {
          receipts.push({ ...row });
        }

        return { error: null };
      }),
      update: (patch: Record<string, unknown>) => {
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
          for (const receipt of receipts) {
            if (Object.entries(filters).every(([column, value]) => receipt[column] === value)) {
              Object.assign(receipt, patch);
            }
          }

          return Promise.resolve({ error: null }).then(resolve, reject);
        };

        return query;
      },
    };
  }

  return {
    payments,
    receipts,
    db: {
      from: jest.fn((name: string) => {
        if (name === "payment_transactions") return paymentTransactionsTable();
        if (name === "crypto_deposit_receipts") return cryptoDepositReceiptsTable();
        throw new Error(`Unexpected table ${name}`);
      }),
    },
  };
}

function createRpcFetch(logsByDepositAddress: Record<string, unknown[]>) {
  return jest.fn(async (_input: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as {
      method: string;
      params?: Array<Record<string, unknown>>;
    };

    if (body.method === "eth_blockNumber") {
      return {
        ok: true,
        status: 200,
        json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x69" }),
      };
    }

    if (body.method === "eth_getLogs") {
      const filter = body.params?.[0] as { topics?: string[] };
      const transferToTopic = filter.topics?.[2] || "";
      return {
        ok: true,
        status: 200,
        json: async () => ({
          jsonrpc: "2.0",
          id: 1,
          result: logsByDepositAddress[transferToTopic] || [],
        }),
      };
    }

    throw new Error(`Unexpected RPC method ${body.method}`);
  });
}

function confirmedTransferLog(overrides: Record<string, unknown> = {}) {
  return {
    address: USDC_BASE_TOKEN_ADDRESS,
    data: uint256(10_000_000),
    topics: [
      ERC20_TRANSFER_TOPIC,
      encodeErc20TransferToTopic("0x0000000000000000000000000000000000000001"),
      encodeErc20TransferToTopic(normalizedDepositAddressOne),
    ],
    transactionHash: "0xabc123",
    logIndex: "0x0",
    blockNumber: "0x67",
    blockHash: "0xblockhash",
    ...overrides,
  };
}

describe("crypto top-up reconciliation", () => {
  it("encodes ERC-20 transfer recipient topics for Base log scans", () => {
    expect(encodeErc20TransferToTopic(depositAddressOne)).toBe(
      `0x${"0".repeat(24)}000000000000000000000000000000000000dead`
    );
  });

  it("settles a pending USDC/Base crypto top-up from a confirmed transfer log", async () => {
    const { db, receipts } = createDb([makePayment()]);
    const fetchImpl = createRpcFetch({
      [encodeErc20TransferToTopic(normalizedDepositAddressOne)]: [confirmedTransferLog()],
    });
    const settleIntent = jest.fn(async () => ({
      status: "settled" as const,
      inserted: true,
      balance: 1000,
    }));

    const result = await reconcilePendingCryptoTopUps({
      db,
      fetchImpl,
      settleIntent,
      now,
      lookbackBlocks: 10,
      minConfirmations: 3,
    });

    expect(result).toEqual({
      checked: 1,
      settled: 1,
      noMatch: 0,
      underconfirmed: 0,
      invalidIntent: 0,
      failed: 0,
      results: [
        {
          status: "settled",
          referenceId: "bankr_crypto_topup:test",
          transactionHash: "0xabc123",
          inserted: true,
          balance: 1000,
        },
      ],
    });
    expect(settleIntent).toHaveBeenCalledWith({
      referenceId: "bankr_crypto_topup:test",
      actor: "bankr_reconciler",
      transactionHash: "0xabc123",
      detectedAt: now.toISOString(),
      db,
      now,
    });
    expect(receipts).toEqual([
      expect.objectContaining({
        provider: "bankr",
        reference_id: "bankr_crypto_topup:test",
        chain_id: 8453,
        token_address: USDC_BASE_TOKEN_ADDRESS,
        deposit_address: normalizedDepositAddressOne,
        amount_minor: 10_000_000,
        tx_hash: "0xabc123",
        log_index: 0,
        block_number: 103,
        confirmations: 3,
        status: "settled",
      }),
    ]);

    const getLogsCall = fetchImpl.mock.calls.find((call) => {
      const body = JSON.parse(call[1].body);
      return body.method === "eth_getLogs";
    });
    const getLogsFilter = JSON.parse(getLogsCall?.[1].body || "{}").params[0];

    expect(getLogsFilter).toEqual({
      address: USDC_BASE_TOKEN_ADDRESS,
      fromBlock: "0x60",
      toBlock: "latest",
      topics: [
        ERC20_TRANSFER_TOPIC,
        null,
        encodeErc20TransferToTopic(normalizedDepositAddressOne),
      ],
    });
  });

  it("does not settle when the transfer amount does not match the pending package", async () => {
    const { db, receipts } = createDb([makePayment()]);
    const fetchImpl = createRpcFetch({
      [encodeErc20TransferToTopic(normalizedDepositAddressOne)]: [
        confirmedTransferLog({ data: uint256(9_000_000) }),
      ],
    });
    const settleIntent = jest.fn();

    const result = await reconcilePendingCryptoTopUps({
      db,
      fetchImpl,
      settleIntent,
      now,
    });

    expect(result.noMatch).toBe(1);
    expect(result.settled).toBe(0);
    expect(settleIntent).not.toHaveBeenCalled();
    expect(receipts).toHaveLength(0);
  });

  it("waits for enough confirmations before granting credits", async () => {
    const { db, receipts } = createDb([makePayment()]);
    const fetchImpl = createRpcFetch({
      [encodeErc20TransferToTopic(normalizedDepositAddressOne)]: [
        confirmedTransferLog({ blockNumber: "0x68" }),
      ],
    });
    const settleIntent = jest.fn();

    const result = await reconcilePendingCryptoTopUps({
      db,
      fetchImpl,
      settleIntent,
      now,
      minConfirmations: 3,
    });

    expect(result.underconfirmed).toBe(1);
    expect(result.results[0]).toEqual({
      status: "underconfirmed",
      referenceId: "bankr_crypto_topup:test",
      confirmations: 2,
    });
    expect(settleIntent).not.toHaveBeenCalled();
    expect(receipts).toHaveLength(0);
  });

  it("continues reconciling later payments when one scan fails", async () => {
    const firstPayment = makePayment();
    const secondPayment = makePayment({
      id: "payment_2",
      user_id: "user_456",
      provider_reference_id: "bankr_crypto_topup:second",
      metadata: {
        type: "crypto_topup_intent",
        depositAddress: normalizedDepositAddressTwo,
      },
    });
    const { db } = createDb([firstPayment, secondPayment]);
    const fetchImpl = jest.fn(async (_input: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as {
        method: string;
        params?: Array<{ topics?: string[] }>;
      };

      if (body.method === "eth_blockNumber") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x69" }),
        };
      }

      if (body.params?.[0]?.topics?.[2] === encodeErc20TransferToTopic(normalizedDepositAddressOne)) {
        throw new Error("RPC timeout");
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({
          jsonrpc: "2.0",
          id: 1,
          result: [
            confirmedTransferLog({
              topics: [
                ERC20_TRANSFER_TOPIC,
                encodeErc20TransferToTopic("0x0000000000000000000000000000000000000001"),
                encodeErc20TransferToTopic(normalizedDepositAddressTwo),
              ],
              transactionHash: "0xdef456",
            }),
          ],
        }),
      };
    });
    const settleIntent = jest.fn(async () => ({
      status: "settled" as const,
      inserted: true,
      balance: 1000,
    }));

    const result = await reconcilePendingCryptoTopUps({
      db,
      fetchImpl,
      settleIntent,
      now,
    });

    expect(result.checked).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.settled).toBe(1);
    expect(result.results).toEqual([
      {
        status: "failed",
        referenceId: "bankr_crypto_topup:test",
        errorName: "Error",
      },
      expect.objectContaining({
        status: "settled",
        referenceId: "bankr_crypto_topup:second",
        transactionHash: "0xdef456",
      }),
    ]);
  });

  it("credits a repeat same-amount top-up against its OWN new transfer, not an already-consumed one", async () => {
    // Intent B is pending; an earlier intent A already consumed txX (0xabc123)
    // at this reused deposit address. The reconciler must match B against its
    // fresh transfer (0xdef456) — not re-pick the consumed txX (which in prod
    // collides on the (chain_id, tx_hash, log_index) unique index and would
    // leave B's real payment uncredited forever).
    const paymentB = makePayment({
      id: "payment_2",
      provider_reference_id: "bankr_crypto_topup:second",
    });
    const { db, receipts } = createDb([paymentB]);

    // Earlier intent A's settled receipt (consumes txX at this address).
    receipts.push({
      provider: "bankr",
      reference_id: "bankr_crypto_topup:first",
      chain_id: 8453, // BASE_CHAIN_ID
      normalized_deposit_address: normalizedDepositAddressOne,
      tx_hash: "0xabc123",
      log_index: 0,
      status: "settled",
    });

    // The address shows BOTH the old consumed transfer and a fresh one.
    const fetchImpl = createRpcFetch({
      [encodeErc20TransferToTopic(normalizedDepositAddressOne)]: [
        confirmedTransferLog({ transactionHash: "0xabc123", logIndex: "0x0", blockNumber: "0x60" }),
        confirmedTransferLog({ transactionHash: "0xdef456", logIndex: "0x1", blockNumber: "0x66" }),
      ],
    });
    const settleIntent = jest.fn(async () => ({
      status: "settled" as const,
      inserted: true,
      balance: 2000,
    }));

    const result = await reconcilePendingCryptoTopUps({
      db,
      fetchImpl,
      settleIntent,
      now,
      lookbackBlocks: 100,
      minConfirmations: 3,
    });

    expect(result.settled).toBe(1);
    expect(result.failed).toBe(0);
    // Settled against the FRESH transfer, not the already-consumed txX.
    expect(settleIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        referenceId: "bankr_crypto_topup:second",
        transactionHash: "0xdef456",
      })
    );
    const bReceipt = receipts.find((r) => r.reference_id === "bankr_crypto_topup:second");
    expect(bReceipt?.tx_hash).toBe("0xdef456");
  });
});
