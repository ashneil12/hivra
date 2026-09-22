import {
  ERC20_TRANSFER_TOPIC,
  encodeErc20TransferToTopic,
  reconcilePendingCryptoTopUps,
} from "@/lib/billing/crypto-reconciliation";
import { USDC_BASE_TOKEN_ADDRESS } from "@/lib/billing/crypto-topups";
import {
  addressTopic,
  createBaseRpcFake,
  createBillingMemoryDb,
  type BaseRpcFake,
  type BillingMemoryDb,
  type MemoryRow,
} from "@/test-utils/billing-memory-db";

jest.mock("@/lib/ops-events", () => ({
  ...jest.requireActual("@/lib/ops-events"),
  reportOpsEvent: jest.fn(async () => null),
}));

const createdAt = "2026-04-24T11:50:00.000Z";
const now = "2026-04-24T12:00:00.000Z";
const depositAddressOne = "0x000000000000000000000000000000000000dEaD";
const normalizedDepositAddressOne = "0x000000000000000000000000000000000000dead";
const normalizedDepositAddressTwo = "0x000000000000000000000000000000000000beef";
const NO_SLEEP = { sleepImpl: async () => undefined };

function makePayment(overrides: MemoryRow = {}): MemoryRow {
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
      createdAt,
      sessionExpiresAt: "2026-04-24T12:10:00.000Z",
    },
    created_at: createdAt,
    updated_at: createdAt,
    ...overrides,
  };
}

function setup(payments: MemoryRow[]) {
  const memory = createBillingMemoryDb({ payment_transactions: payments });
  const rpc = createBaseRpcFake({ latestBlock: 1_000_000, latestTimestamp: now });
  return { memory, rpc };
}

function run(memory: BillingMemoryDb, rpc: BaseRpcFake, extra: Record<string, unknown> = {}) {
  return reconcilePendingCryptoTopUps({
    db: memory.db,
    fetchImpl: rpc.fetchImpl,
    now: new Date(now),
    minConfirmations: 3,
    rpcOptions: NO_SLEEP,
    ...extra,
  });
}

function transferAt(rpc: BaseRpcFake, overrides: Partial<Parameters<BaseRpcFake["addTransfer"]>[0]> & { at: string }) {
  const { at, ...rest } = overrides;
  rpc.addTransfer({
    txHash: "0xabc123",
    amountRaw: 10_000_000,
    block: rpc.blockAt(at),
    logIndex: 0,
    to: normalizedDepositAddressOne,
    ...rest,
  });
}

describe("crypto top-up reconciliation", () => {
  it("encodes ERC-20 transfer recipient topics for Base log scans", () => {
    expect(encodeErc20TransferToTopic(depositAddressOne)).toBe(
      `0x${"0".repeat(24)}000000000000000000000000000000000000dead`
    );
  });

  it("settles a pending USDC/Base crypto top-up from a confirmed transfer log", async () => {
    const { memory, rpc } = setup([makePayment()]);
    transferAt(rpc, { at: "2026-04-24T11:55:00.000Z" });

    const result = await run(memory, rpc);

    expect(result).toEqual(
      expect.objectContaining({ checked: 1, settled: 1, noMatch: 0, underconfirmed: 0, invalidIntent: 0, failed: 0 })
    );
    expect(result.results).toEqual([
      {
        status: "settled",
        referenceId: "bankr_crypto_topup:test",
        transactionHash: "0xabc123",
        inserted: true,
        balance: 1000,
      },
    ]);
    expect(memory.tables.crypto_deposit_receipts).toEqual([
      expect.objectContaining({
        provider: "bankr",
        payment_transaction_id: "payment_1",
        reference_id: "bankr_crypto_topup:test",
        chain_id: 8453,
        token_address: USDC_BASE_TOKEN_ADDRESS,
        deposit_address: normalizedDepositAddressOne,
        amount_minor: 10_000_000,
        tx_hash: "0xabc123",
        log_index: 0,
        block_number: rpc.blockAt("2026-04-24T11:55:00.000Z"),
        status: "settled",
      }),
    ]);
    expect(memory.tables.payment_transactions[0]).toEqual(
      expect.objectContaining({
        status: "succeeded",
        metadata: expect.objectContaining({
          creditGrantStatus: "granted",
          settlement: expect.objectContaining({ actor: "bankr_reconciler", transactionHash: "0xabc123", logIndex: 0 }),
        }),
      })
    );
    expect(memory.tables.credit_ledger_entries).toEqual([
      expect.objectContaining({
        user_id: "user_123",
        amount_credits: 1000,
        source: "bankr",
        reason: "crypto_topup",
        reference_id: "bankr_crypto_topup:test",
      }),
    ]);

    const getLogs = rpc.requests.filter((request) => request.method === "eth_getLogs");
    expect(getLogs.length).toBeGreaterThan(0);
    for (const request of getLogs) {
      expect(request.params[0]).toEqual({
        address: USDC_BASE_TOKEN_ADDRESS,
        fromBlock: expect.stringMatching(/^0x[0-9a-f]+$/),
        toBlock: expect.stringMatching(/^0x[0-9a-f]+$/),
        topics: [ERC20_TRANSFER_TOPIC, null, encodeErc20TransferToTopic(normalizedDepositAddressOne)],
      });
    }
  });

  it("does not settle when the transfer amount does not match the pending package", async () => {
    const { memory, rpc } = setup([makePayment()]);
    transferAt(rpc, { at: "2026-04-24T11:55:00.000Z", amountRaw: 9_000_000 });
    const settleIntent = jest.fn();

    const result = await run(memory, rpc, { settleIntent });

    // The window is still open: the user can still send the right amount.
    expect(result.noMatch).toBe(1);
    expect(result.settled).toBe(0);
    expect(settleIntent).not.toHaveBeenCalled();
    expect(memory.tables.crypto_deposit_receipts).toHaveLength(0);
    expect(memory.tables.crypto_topup_reconciliation_items).toHaveLength(0);
  });

  it("waits for enough confirmations before granting credits", async () => {
    const { memory, rpc } = setup([makePayment()]);
    rpc.addTransfer({ txHash: "0xabc123", amountRaw: 10_000_000, block: 999_999, to: normalizedDepositAddressOne });
    const settleIntent = jest.fn();

    const result = await run(memory, rpc, { settleIntent });

    expect(result.underconfirmed).toBe(1);
    expect(result.results[0]).toEqual({
      status: "underconfirmed",
      referenceId: "bankr_crypto_topup:test",
      confirmations: 2,
    });
    expect(settleIntent).not.toHaveBeenCalled();
    expect(memory.tables.crypto_deposit_receipts).toHaveLength(0);
  });

  it("continues reconciling later payments when one scan fails", async () => {
    const second = makePayment({
      id: "payment_2",
      user_id: "user_456",
      provider_reference_id: "bankr_crypto_topup:second",
      metadata: { ...(makePayment().metadata as MemoryRow), depositAddress: normalizedDepositAddressTwo },
    });
    const { memory, rpc } = setup([makePayment(), second]);
    transferAt(rpc, { at: "2026-04-24T11:55:00.000Z", txHash: "0xdef456", to: normalizedDepositAddressTwo });
    const failingTopic = addressTopic(normalizedDepositAddressOne);
    const fetchImpl = jest.fn(async (url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { method: string; params: Array<{ topics?: string[] }> };
      if (body.method === "eth_getLogs" && body.params[0]?.topics?.[2] === failingTopic) {
        return { ok: false, status: 400, json: async () => ({ error: { message: "bad filter" } }) };
      }
      return rpc.fetchImpl(url, init);
    });

    const result = await run(memory, rpc, { fetchImpl });

    expect(result.checked).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.settled).toBe(1);
    expect(result.results).toEqual(
      expect.arrayContaining([
        {
          status: "failed",
          referenceId: "bankr_crypto_topup:test",
          errorName: "Error",
          errorMessage: "Base RPC eth_getLogs failed with status 400: bad filter",
        },
        expect.objectContaining({
          status: "settled",
          referenceId: "bankr_crypto_topup:second",
          transactionHash: "0xdef456",
        }),
      ])
    );
  });

  it("credits a repeat same-amount top-up against its OWN new transfer, not an already-claimed one", async () => {
    // Intent B is pending; an earlier intent A already claimed 0xabc123 at this
    // reused deposit address. B must settle against its fresh transfer, not
    // re-pick the claimed one (which collides on the receipt's unique
    // (chain_id, tx_hash, log_index) and would leave B's payment uncredited).
    const { memory, rpc } = setup([
      makePayment({ id: "payment_2", provider_reference_id: "bankr_crypto_topup:second" }),
    ]);
    memory.insertRow("crypto_deposit_receipts", {
      provider: "bankr",
      reference_id: "bankr_crypto_topup:first",
      chain_id: 8453,
      normalized_deposit_address: normalizedDepositAddressOne,
      tx_hash: "0xabc123",
      log_index: 0,
      status: "settled",
    });
    transferAt(rpc, { at: "2026-04-24T11:51:00.000Z", txHash: "0xabc123", logIndex: 0 });
    transferAt(rpc, { at: "2026-04-24T11:55:00.000Z", txHash: "0xdef456", logIndex: 1 });

    const result = await run(memory, rpc);

    expect(result.settled).toBe(1);
    expect(result.failed).toBe(0);
    const bReceipt = memory.tables.crypto_deposit_receipts.find(
      (receipt) => receipt.reference_id === "bankr_crypto_topup:second"
    );
    expect(bReceipt?.tx_hash).toBe("0xdef456");
    // A's claimed transfer is accounted for there, not surfaced as B's extra.
    expect(memory.tables.crypto_topup_reconciliation_items).toEqual([]);
  });

  it("skips malformed and zero-value transfer logs without dropping the real payment", async () => {
    const { memory, rpc } = setup([makePayment()]);
    transferAt(rpc, { at: "2026-04-24T11:52:00.000Z", txHash: "0xpoison", amountRaw: 0, logIndex: 1 });
    transferAt(rpc, { at: "2026-04-24T11:55:00.000Z", txHash: "0xreal", logIndex: 2 });
    const fetchImpl = jest.fn(async (url: string, init: { body: string }) => {
      const response = await rpc.fetchImpl(url, init);
      if (JSON.parse(init.body).method !== "eth_getLogs") return response;
      const payload = (await response.json()) as { result: unknown[] };
      return {
        ...response,
        json: async () => ({
          ...payload,
          result: [...payload.result, { address: USDC_BASE_TOKEN_ADDRESS, data: "0x1", blockNumber: null }],
        }),
      };
    });

    const result = await run(memory, rpc, { fetchImpl });

    expect(result.settled).toBe(1);
    expect(memory.tables.crypto_deposit_receipts).toEqual([expect.objectContaining({ tx_hash: "0xreal" })]);
  });

  it("finishes an unfinished claim without scanning the chain", async () => {
    const { memory, rpc } = setup([makePayment({ status: "succeeded" })]);
    memory.insertRow("crypto_deposit_receipts", {
      user_id: "user_123",
      provider: "bankr",
      reference_id: "bankr_crypto_topup:test",
      chain_id: 8453,
      token_address: USDC_BASE_TOKEN_ADDRESS,
      normalized_deposit_address: normalizedDepositAddressOne,
      amount_minor: 10_000_000,
      tx_hash: "0xabc123",
      log_index: 0,
      block_number: 999_000,
      confirmations: 3,
      status: "confirmed",
      metadata: {},
    });

    const result = await run(memory, rpc);

    expect(result.recovered).toBe(1);
    expect(rpc.methodCount("eth_getLogs")).toBe(0);
    expect(memory.tables.credit_ledger_entries).toEqual([
      expect.objectContaining({ amount_credits: 1000, reference_id: "bankr_crypto_topup:test" }),
    ]);
    expect(memory.tables.crypto_deposit_receipts[0].status).toBe("settled");
  });
});
