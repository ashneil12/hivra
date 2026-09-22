import {
  settleCryptoTopUpIntent,
  surfaceCryptoTopUpTransfer,
  type CryptoTopUpTransfer,
} from "@/lib/billing/crypto-topups";
import { reportOpsEvent } from "@/lib/ops-events";
import { createBillingMemoryDb, type MemoryRow } from "@/test-utils/billing-memory-db";

jest.mock("@/lib/ops-events", () => ({
  ...jest.requireActual("@/lib/ops-events"),
  reportOpsEvent: jest.fn(async () => null),
}));

const now = new Date("2026-04-24T12:00:00.000Z");
const ref = "bankr_crypto_topup:test";

function intent(overrides: MemoryRow = {}): MemoryRow {
  return {
    id: "payment_1",
    user_id: "user_123",
    provider: "bankr",
    provider_reference_id: ref,
    status: "pending",
    asset: "usdc_base",
    amount_minor: 10_000_000,
    package_credits: 1000,
    metadata: {
      type: "crypto_topup_intent",
      depositAddress: "0x000000000000000000000000000000000000dead",
      createdAt: "2026-04-24T11:50:00.000Z",
      sessionExpiresAt: "2026-04-24T12:10:00.000Z",
    },
    created_at: "2026-04-24T11:50:00.000Z",
    updated_at: "2026-04-24T11:50:00.000Z",
    ...overrides,
  };
}

function transfer(overrides: Partial<CryptoTopUpTransfer> = {}): CryptoTopUpTransfer {
  return {
    transactionHash: "0xABC123",
    logIndex: 4,
    blockNumber: 1000,
    blockHash: "0xblock",
    amountRaw: "10000000",
    confirmations: 5,
    observedAt: "2026-04-24T11:55:00.000Z",
    ...overrides,
  };
}

function settle(memory: ReturnType<typeof createBillingMemoryDb>, overrides: Partial<CryptoTopUpTransfer> = {}, referenceId = ref) {
  return settleCryptoTopUpIntent({ referenceId, transfer: transfer(overrides), db: memory.db, now });
}

describe("settleCryptoTopUpIntent", () => {
  beforeEach(() => (reportOpsEvent as jest.Mock).mockClear());

  it("claims the transfer, flips the intent, credits once, and is idempotent on redelivery", async () => {
    const memory = createBillingMemoryDb({ payment_transactions: [intent()] });

    const first = await settle(memory);
    const second = await settle(memory);

    expect(first).toEqual({ status: "settled", referenceId: ref, transactionHash: "0xabc123", inserted: true, balance: 1000 });
    expect(second).toEqual({ status: "settled", referenceId: ref, transactionHash: "0xabc123", inserted: false, balance: null });
    expect(memory.tables.credit_ledger_entries).toEqual([
      expect.objectContaining({
        user_id: "user_123",
        amount_credits: 1000,
        source: "bankr",
        actor: "bankr_reconciler",
        reason: "crypto_topup",
        reference_id: ref,
        metadata: expect.objectContaining({ paymentTransactionId: "payment_1", transactionHash: "0xabc123", logIndex: 4 }),
      }),
    ]);
    expect(memory.tables.crypto_deposit_receipts).toEqual([
      expect.objectContaining({ reference_id: ref, tx_hash: "0xabc123", log_index: 4, status: "settled" }),
    ]);
    expect(memory.tables.payment_transactions[0]).toEqual(
      expect.objectContaining({
        status: "succeeded",
        metadata: expect.objectContaining({
          creditGrantStatus: "granted",
          settlement: expect.objectContaining({ actor: "bankr_reconciler", transactionHash: "0xabc123", logIndex: 4 }),
        }),
      })
    );
  });

  it("credits nothing when the intent flip fails, and a retry settles exactly once", async () => {
    const memory = createBillingMemoryDb({ payment_transactions: [intent()] });
    memory.failNext({ table: "payment_transactions", op: "update", error: { message: "simulated DB blip" } });

    await expect(settle(memory)).rejects.toThrow(/simulated DB blip/);
    expect(memory.tables.credit_ledger_entries).toEqual([]);
    expect(memory.tables.payment_transactions[0].status).toBe("pending");
    expect(memory.tables.crypto_deposit_receipts[0].status).toBe("confirmed");

    const retry = await settle(memory);

    expect(retry).toEqual(expect.objectContaining({ status: "settled", inserted: true }));
    expect(memory.tables.credit_ledger_entries).toHaveLength(1);
  });

  it("refuses a transfer another intent already claimed", async () => {
    const memory = createBillingMemoryDb({
      payment_transactions: [intent(), intent({ id: "payment_2", provider_reference_id: "bankr_crypto_topup:other" })],
    });
    await settle(memory, {}, "bankr_crypto_topup:other");

    const result = await settle(memory);

    expect(result).toEqual({ status: "transaction_already_claimed", referenceId: ref, transactionHash: "0xabc123" });
    expect(memory.tables.payment_transactions[0].status).toBe("pending");
    expect(memory.tables.credit_ledger_entries).toHaveLength(1);
  });

  it("refuses a non-exact amount without claiming it", async () => {
    const memory = createBillingMemoryDb({ payment_transactions: [intent()] });

    await expect(settle(memory, { amountRaw: "9990000" })).resolves.toEqual({ status: "amount_mismatch", referenceId: ref });
    expect(memory.tables.crypto_deposit_receipts).toEqual([]);
  });

  it("does not settle missing, refunded, or reviewed intents", async () => {
    const memory = createBillingMemoryDb({
      payment_transactions: [
        intent({ status: "refunded" }),
        intent({
          id: "payment_2",
          provider_reference_id: "bankr_crypto_topup:review",
          status: "failed",
          metadata: { ...(intent().metadata as MemoryRow), failureType: "crypto_topup_manual_review" },
        }),
      ],
    });

    await expect(settle(memory, {}, "bankr_crypto_topup:missing")).resolves.toEqual({
      status: "not_found",
      referenceId: "bankr_crypto_topup:missing",
    });
    await expect(settle(memory)).resolves.toEqual({ status: "not_settleable", referenceId: ref, paymentStatus: "refunded" });
    await expect(settle(memory, {}, "bankr_crypto_topup:review")).resolves.toEqual({
      status: "not_settleable",
      referenceId: "bankr_crypto_topup:review",
      paymentStatus: "failed",
    });
    expect(memory.tables.credit_ledger_entries).toEqual([]);
  });

  it("recovers an intent expired by its session with a verified payment", async () => {
    const memory = createBillingMemoryDb({
      payment_transactions: [
        intent({
          status: "failed",
          metadata: {
            ...(intent().metadata as MemoryRow),
            creditGrantStatus: "expired",
            failureType: "crypto_payment_session_expired",
          },
        }),
      ],
    });

    const result = await settle(memory);

    expect(result.status).toBe("settled");
    expect(memory.tables.payment_transactions[0]).toEqual(
      expect.objectContaining({
        status: "succeeded",
        metadata: expect.objectContaining({
          creditGrantStatus: "granted",
          recoveredFromStatus: "failed",
          recoveredFailureType: "crypto_payment_session_expired",
        }),
      })
    );
    expect((memory.tables.payment_transactions[0].metadata as MemoryRow).failureType).toBeUndefined();
  });

  it("never rewrites a settled intent: a different transfer is surfaced for review", async () => {
    const memory = createBillingMemoryDb({ payment_transactions: [intent()] });
    await settle(memory);

    const replay = await settle(memory, { transactionHash: "0xdifferent", logIndex: 9 });

    expect(replay).toEqual(expect.objectContaining({ status: "settled", transactionHash: "0xabc123", inserted: false }));
    expect(
      ((memory.tables.payment_transactions[0].metadata as MemoryRow).settlement as MemoryRow).transactionHash
    ).toBe("0xabc123");
    expect(memory.tables.crypto_deposit_receipts).toHaveLength(1);
    expect(memory.tables.credit_ledger_entries).toHaveLength(1);
    expect(memory.tables.crypto_topup_reconciliation_items).toEqual([
      expect.objectContaining({ tx_hash: "0xdifferent", log_index: 9, reason: "replayed_after_settlement" }),
    ]);
  });

  it("surfaces a transfer for review once and reports it to ops once", async () => {
    const memory = createBillingMemoryDb({ payment_transactions: [intent()] });
    const payment = memory.tables.payment_transactions[0] as unknown as Parameters<
      typeof surfaceCryptoTopUpTransfer
    >[0]["payment"];

    await expect(
      surfaceCryptoTopUpTransfer({ payment, transfer: transfer({ amountRaw: "5000000" }), reason: "underpaid" }, memory.db)
    ).resolves.toBe("surfaced");
    await expect(
      surfaceCryptoTopUpTransfer({ payment, transfer: transfer({ amountRaw: "5000000" }), reason: "underpaid" }, memory.db)
    ).resolves.toBe("already_surfaced");

    expect(memory.tables.crypto_topup_reconciliation_items).toEqual([
      expect.objectContaining({
        dedupe_key: "crypto_topup_transfer:8453:0xabc123:4",
        observed_amount_minor: "5000000",
        expected_amount_minor: 10_000_000,
      }),
    ]);
    expect(reportOpsEvent).toHaveBeenCalledTimes(1);
  });
});
