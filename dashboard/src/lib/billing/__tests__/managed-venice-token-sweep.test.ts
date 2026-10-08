import {
  HERMESOS_TOKEN_ADDRESS,
  HERMESOS_TOKEN_DECIMALS,
} from "@/lib/billing/token-holdings";
import {
  MANAGED_VENICE_SWEEP_CLAIM_STALE_MS,
  sweepManagedVeniceTokenQuote,
  sweepPendingManagedVeniceTokenQuotes,
} from "@/lib/billing/managed-venice-token-sweep";
import { BankrTransferHttpError } from "@/lib/billing/bankr-withdraw";
import { reportOpsEvent } from "@/lib/ops-events";
import { createBillingMemoryDb } from "@/test-utils/billing-memory-db";

jest.mock("@/lib/ops-events", () => ({
  ...jest.requireActual("@/lib/ops-events"),
  reportOpsEvent: jest.fn(async () => null),
}));

type Row = Record<string, unknown>;

const now = new Date("2026-05-16T12:00:00.000Z");
const treasuryAddress = "0x000000000000000000000000000000000000D00D";
const normalizedTreasuryAddress = "0x000000000000000000000000000000000000d00d";
const normalizedDepositAddress = "0x000000000000000000000000000000000000ba5e";
const normalizedSharedCreditDepositAddress = "0x000000000000000000000000000000000000c0de";
const tokenAmountRaw = "1000000000000000000000";

function createMemoryDb(initialQuotes: Row[] = [], initialLots: Row[] = []) {
  // Real filter/order/compare-and-set semantics (update().select() returns the
  // affected rows), so overlapping sweeps race the way they do in Postgres.
  return createBillingMemoryDb({
    managed_venice_token_quotes: initialQuotes,
    // Deposit lots hold the RECEIVED token amount the sweep moves. Quotes with
    // no lot row (legacy settlements) fall back to the quoted amount.
    managed_venice_token_lots: initialLots,
    managed_venice_financial_events: [],
    bankr_deposit_wallet_credentials: [
      {
        id: "credential_1",
        user_id: "user_1",
        purpose: "managed_venice_inference",
        wallet_id: "wallet_1",
        bankr_wallet_id: "wlt_venice_1",
        evm_address: normalizedDepositAddress,
        normalized_evm_address: normalizedDepositAddress,
        api_key_encrypted: "unused-because-sweeps-mint-scoped-key",
        api_key_status: "active",
        allowed_recipient_evm: normalizedTreasuryAddress,
        allowed_ips: [],
        permissions: {},
      },
      {
        id: "credential_credit",
        user_id: "user_1",
        purpose: "credit_deposit",
        wallet_id: "wallet_credit",
        bankr_wallet_id: "wlt_credit",
        evm_address: normalizedSharedCreditDepositAddress,
        normalized_evm_address: normalizedSharedCreditDepositAddress,
        api_key_status: "active",
        allowed_ips: [],
        permissions: {},
      },
    ],
  });
}

const baseQuote = {
  id: "quote_1",
  account_id: "account_1",
  user_id: "user_1",
  token_amount_raw: tokenAmountRaw,
  locked_value_micro_usd: 50_000_000,
  deposit_address: normalizedDepositAddress,
  status: "settled",
  sweep_status: "pending",
  settled_at: "2026-05-16T11:59:00.000Z",
};

describe("managed Venice token treasury sweeps", () => {
  it("sweeps a settled Hivra quote into the managed Venice treasury", async () => {
    const { db, tables } = createMemoryDb([{ ...baseQuote }]);
    const mintApiKey = jest.fn(async () => "bk_scoped_to_venice_treasury");
    const submitTransfer = jest.fn(async () => "0xsweep");

    const result = await sweepManagedVeniceTokenQuote(baseQuote, {
      db,
      env: {
        MANAGED_VENICE_TREASURY_BASE_ADDRESS: treasuryAddress,
        BANKR_PARTNER_KEY: "bk_partner",
      },
      now,
      readHermesBalance: jest.fn(async () => ({ balanceRaw: tokenAmountRaw })),
      ensureGas: jest.fn(async () => ({ status: "already_funded" as const })),
      mintApiKey,
      submitTransfer,
    });

    expect(result).toEqual({
      quoteId: "quote_1",
      userId: "user_1",
      outcome: "swept",
      txHash: "0xsweep",
      amountSweptDisplay: "1000",
      destinationAddress: normalizedTreasuryAddress,
    });
    expect(mintApiKey).toHaveBeenCalledWith(expect.objectContaining({
      bankrWalletId: "wlt_venice_1",
      recipientAddress: normalizedTreasuryAddress,
    }));
    expect(submitTransfer).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: "bk_scoped_to_venice_treasury",
      tokenAddress: HERMESOS_TOKEN_ADDRESS,
      recipientAddress: normalizedTreasuryAddress,
      amountDisplay: "1000",
    }));
    expect(tables.managed_venice_token_quotes[0]).toMatchObject({
      sweep_status: "swept",
      sweep_tx_hash: "0xsweep",
      sweep_destination_address: normalizedTreasuryAddress,
      sweep_error: null,
      sweep_attempted_at: now.toISOString(),
    });
    expect(tables.managed_venice_financial_events).toContainEqual(
      expect.objectContaining({
        user_id: "user_1",
        account_id: "account_1",
        wallet_type: "hermesos",
        event_type: "treasury_sweep",
        reference_id: "quote_1",
        idempotency_key: "managed_venice_treasury_sweep:quote_1:0xsweep",
        token_amount_raw: tokenAmountRaw,
        amount_micro_usd: 50_000_000,
      })
    );
  });

  it("sweeps the RECEIVED amount from the deposit lot so an accepted over-send is not stranded", async () => {
    const receivedRaw = "1100000000000000000000"; // 1.1x the quoted 1000 tokens
    const { db, tables } = createMemoryDb(
      [{ ...baseQuote }],
      [
        {
          id: "lot_1",
          quote_id: "quote_1",
          source: "hermesos_deposit",
          token_amount_raw: receivedRaw,
          original_value_micro_usd: 55_000_000,
          transaction_hash: "0xdeposit",
          metadata: { observedAt: "2026-05-16T11:58:00.000Z" },
        },
      ]
    );
    const submitTransfer = jest.fn(async () => "0xsweep");

    const result = await sweepManagedVeniceTokenQuote(baseQuote, {
      db,
      env: { MANAGED_VENICE_TREASURY_BASE_ADDRESS: treasuryAddress },
      now,
      readHermesBalance: jest.fn(async () => ({ balanceRaw: receivedRaw })),
      ensureGas: jest.fn(async () => ({ status: "already_funded" as const })),
      mintApiKey: jest.fn(async () => "bk_scoped"),
      submitTransfer,
    });

    expect(result).toMatchObject({ outcome: "swept", amountSweptDisplay: "1100" });
    expect(submitTransfer).toHaveBeenCalledWith(expect.objectContaining({ amountDisplay: "1100" }));
    expect(tables.managed_venice_financial_events).toContainEqual(
      expect.objectContaining({
        event_type: "treasury_sweep",
        token_amount_raw: receivedRaw,
        amount_micro_usd: 55_000_000,
      })
    );
  });

  it("still skips when the wallet holds less than the received amount", async () => {
    const receivedRaw = "1100000000000000000000";
    const { db, tables } = createMemoryDb(
      [{ ...baseQuote }],
      [{ id: "lot_1", quote_id: "quote_1", source: "hermesos_deposit", token_amount_raw: receivedRaw, original_value_micro_usd: 55_000_000 }]
    );
    const submitTransfer = jest.fn();

    const result = await sweepManagedVeniceTokenQuote(baseQuote, {
      db,
      env: { MANAGED_VENICE_TREASURY_BASE_ADDRESS: treasuryAddress },
      now,
      readHermesBalance: jest.fn(async () => ({ balanceRaw: tokenAmountRaw })),
      ensureGas: jest.fn(),
      mintApiKey: jest.fn(),
      submitTransfer,
    });

    expect(result.outcome).toBe("no_balance");
    expect(submitTransfer).not.toHaveBeenCalled();
    expect(tables.managed_venice_token_quotes[0]).toMatchObject({
      sweep_status: "skipped",
      sweep_error: `live balance ${tokenAmountRaw} < expected ${receivedRaw}`,
    });
  });

  it("sweeps managed Venice deposits from the shared credit_deposit Bankr wallet", async () => {
    const { db } = createMemoryDb([
      { ...baseQuote, id: "quote_shared", deposit_address: normalizedSharedCreditDepositAddress },
    ]);
    const mintApiKey = jest.fn(async () => "bk_scoped_to_venice_treasury");

    const result = await sweepManagedVeniceTokenQuote(
      { ...baseQuote, id: "quote_shared", deposit_address: normalizedSharedCreditDepositAddress },
      {
        db,
        env: {
          MANAGED_VENICE_TREASURY_BASE_ADDRESS: treasuryAddress,
          BANKR_PARTNER_KEY: "bk_partner",
        },
        now,
        readHermesBalance: jest.fn(async () => ({ balanceRaw: tokenAmountRaw })),
        ensureGas: jest.fn(async () => ({ status: "already_funded" as const })),
        mintApiKey,
        submitTransfer: jest.fn(async () => "0xsweep"),
      }
    );

    expect(result.outcome).toBe("swept");
    expect(mintApiKey).toHaveBeenCalledWith(expect.objectContaining({
      bankrWalletId: "wlt_credit",
      recipientAddress: normalizedTreasuryAddress,
    }));
  });

  it("marks the quote failed when the managed Venice treasury is missing", async () => {
    const { db, tables } = createMemoryDb([{ ...baseQuote }]);

    const result = await sweepManagedVeniceTokenQuote(baseQuote, {
      db,
      env: {},
      now,
      readHermesBalance: jest.fn(),
      ensureGas: jest.fn(),
      mintApiKey: jest.fn(),
      submitTransfer: jest.fn(),
    });

    expect(result.outcome).toBe("no_treasury_configured");
    expect(tables.managed_venice_token_quotes[0]).toMatchObject({
      sweep_status: "failed",
      sweep_attempted_at: now.toISOString(),
    });
    expect(String(tables.managed_venice_token_quotes[0].sweep_error)).toContain(
      "MANAGED_VENICE_TREASURY_BASE_ADDRESS"
    );
  });

  it("skips instead of double-sweeping when the wallet no longer has the quoted balance", async () => {
    const { db, tables } = createMemoryDb([{ ...baseQuote }]);
    const submitTransfer = jest.fn();

    const result = await sweepManagedVeniceTokenQuote(baseQuote, {
      db,
      env: { MANAGED_VENICE_TREASURY_BASE_ADDRESS: treasuryAddress },
      now,
      readHermesBalance: jest.fn(async () => ({ balanceRaw: "0" })),
      ensureGas: jest.fn(),
      mintApiKey: jest.fn(),
      submitTransfer,
    });

    expect(result.outcome).toBe("no_balance");
    expect(submitTransfer).not.toHaveBeenCalled();
    expect(tables.managed_venice_token_quotes[0]).toMatchObject({
      sweep_status: "skipped",
      sweep_error: `live balance 0 < expected ${tokenAmountRaw}`,
    });
  });

  it("records a transfer Bankr refused so the cron can retry", async () => {
    const { db, tables } = createMemoryDb([{ ...baseQuote }]);

    const result = await sweepManagedVeniceTokenQuote(baseQuote, {
      db,
      env: { MANAGED_VENICE_TREASURY_BASE_ADDRESS: treasuryAddress },
      now,
      readHermesBalance: jest.fn(async () => ({ balanceRaw: tokenAmountRaw })),
      ensureGas: jest.fn(async () => ({ status: "already_funded" as const })),
      mintApiKey: jest.fn(async () => "bk_scoped"),
      submitTransfer: jest.fn(async () => {
        throw new BankrTransferHttpError(400, "bankr transfer rejected");
      }),
    });

    expect(result.outcome).toBe("transfer_failed");
    expect(tables.managed_venice_token_quotes[0]).toMatchObject({
      sweep_status: "failed",
      sweep_attempted_at: now.toISOString(),
      sweep_submitted_at: null,
    });
    expect(String(tables.managed_venice_token_quotes[0].sweep_error)).toContain(
      "bankr transfer rejected"
    );
  });

  it("loads only settled pending or failed quotes for retryable sweep", async () => {
    const { db } = createMemoryDb([
      { ...baseQuote, id: "quote_pending", sweep_status: "pending", settled_at: "2026-05-16T10:00:00.000Z" },
      { ...baseQuote, id: "quote_failed", sweep_status: "failed", settled_at: "2026-05-16T10:01:00.000Z" },
      { ...baseQuote, id: "quote_active", status: "active", sweep_status: "pending" },
      { ...baseQuote, id: "quote_swept", sweep_status: "swept" },
    ]);

    const result = await sweepPendingManagedVeniceTokenQuotes({
      db,
      env: { MANAGED_VENICE_TREASURY_BASE_ADDRESS: treasuryAddress },
      now,
      readHermesBalance: jest.fn(async () => ({ balanceRaw: tokenAmountRaw })),
      ensureGas: jest.fn(async () => ({ status: "already_funded" as const })),
      mintApiKey: jest.fn(async () => "bk_scoped"),
      submitTransfer: jest.fn(async () => "0xsweep"),
    });

    expect(result.checked).toBe(2);
    expect(result.swept).toBe(2);
    expect(result.results.map((item) => item.quoteId)).toEqual([
      "quote_pending",
      "quote_failed",
    ]);
    expect(HERMESOS_TOKEN_DECIMALS).toBe(18);
  });
});

describe("managed Venice token sweep claim", () => {
  const env = { MANAGED_VENICE_TREASURY_BASE_ADDRESS: treasuryAddress };
  const minutesAfter = (date: Date, minutes: number) => new Date(date.getTime() + minutes * 60_000);

  function sweepDeps(submitTransfer: jest.Mock) {
    return {
      env,
      readHermesBalance: jest.fn(async () => ({ balanceRaw: tokenAmountRaw })),
      ensureGas: jest.fn(async () => ({ status: "already_funded" as const })),
      mintApiKey: jest.fn(async () => "bk_scoped"),
      submitTransfer,
    };
  }

  beforeEach(() => (reportOpsEvent as jest.Mock).mockClear());

  it("lets only one of two overlapping runs transfer a quote", async () => {
    const { db, tables } = createMemoryDb([{ ...baseQuote }]);
    const submitTransfer = jest.fn(async () => "0xsweep");

    const [first, second] = await Promise.all([
      sweepPendingManagedVeniceTokenQuotes({ db, now, ...sweepDeps(submitTransfer) }),
      sweepPendingManagedVeniceTokenQuotes({ db, now, ...sweepDeps(submitTransfer) }),
    ]);

    expect(submitTransfer).toHaveBeenCalledTimes(1);
    expect(first.swept + second.swept).toBe(1);
    expect(first.claimedElsewhere + second.claimedElsewhere).toBe(1);
    expect(tables.managed_venice_token_quotes[0]).toMatchObject({ sweep_status: "swept", sweep_tx_hash: "0xsweep" });
    expect(tables.managed_venice_financial_events.filter((event) => event.event_type === "treasury_sweep")).toHaveLength(1);
  });

  it("parks a transfer whose outcome is unknown and never sends it again", async () => {
    const { db, tables } = createMemoryDb([{ ...baseQuote }]);
    // The request reached Bankr, then the response was lost.
    const submitTransfer = jest.fn(async () => {
      throw new TypeError("fetch failed");
    });

    const first = await sweepPendingManagedVeniceTokenQuotes({ db, now, ...sweepDeps(submitTransfer) });
    const later = await sweepPendingManagedVeniceTokenQuotes({ db, now: minutesAfter(now, 10), ...sweepDeps(submitTransfer) });

    expect(submitTransfer).toHaveBeenCalledTimes(1);
    expect(first.needsOperator).toBe(1);
    expect(later.checked).toBe(0);
    expect(tables.managed_venice_token_quotes[0]).toMatchObject({ sweep_status: "needs_operator" });
    expect(String(tables.managed_venice_token_quotes[0].sweep_error)).toContain("outcome unknown");
    expect(reportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ failureType: "managed_venice_sweep_needs_operator", quoteId: "quote_1" }) })
    );
  });

  it("retries a stale claim that never asked Bankr to transfer, and parks one that did", async () => {
    const staleAt = new Date(now.getTime() - MANAGED_VENICE_SWEEP_CLAIM_STALE_MS - 60_000).toISOString();
    const { db, tables } = createMemoryDb([
      { ...baseQuote, id: "quote_unsent", sweep_status: "sweeping", sweep_attempted_at: staleAt },
      { ...baseQuote, id: "quote_sent", sweep_status: "sweeping", sweep_attempted_at: staleAt, sweep_submitted_at: staleAt },
      // A live claim held by another run right now.
      { ...baseQuote, id: "quote_live", sweep_status: "sweeping", sweep_attempted_at: minutesAfter(now, -1).toISOString() },
    ]);
    const submitTransfer = jest.fn(async () => "0xretry");

    const result = await sweepPendingManagedVeniceTokenQuotes({ db, now, ...sweepDeps(submitTransfer) });

    expect(result).toMatchObject({ staleClaimsReleased: 1, staleClaimsParked: 1, swept: 1 });
    expect(submitTransfer).toHaveBeenCalledTimes(1);
    const byId = (id: string) => tables.managed_venice_token_quotes.find((row) => row.id === id);
    expect(byId("quote_unsent")).toMatchObject({ sweep_status: "swept", sweep_tx_hash: "0xretry" });
    expect(byId("quote_sent")).toMatchObject({ sweep_status: "needs_operator" });
    expect(byId("quote_live")).toMatchObject({ sweep_status: "sweeping" });
  });

  it("never retries a failed quote that carries a submitted transfer", async () => {
    const { db, tables } = createMemoryDb([
      { ...baseQuote, sweep_status: "failed", sweep_attempted_at: minutesAfter(now, -30).toISOString(), sweep_submitted_at: minutesAfter(now, -30).toISOString() },
    ]);
    const submitTransfer = jest.fn(async () => "0xsweep");

    const result = await sweepPendingManagedVeniceTokenQuotes({ db, now, ...sweepDeps(submitTransfer) });

    expect(submitTransfer).not.toHaveBeenCalled();
    expect(result.needsOperator).toBe(1);
    expect(tables.managed_venice_token_quotes[0]).toMatchObject({ sweep_status: "needs_operator" });
  });

  it("does not let persistently failing quotes starve a pending one", async () => {
    const { db, tables } = createMemoryDb([
      { ...baseQuote, id: "quote_failing_1", sweep_status: "failed", settled_at: "2026-05-16T09:00:00.000Z", sweep_attempted_at: "2026-05-16T11:50:00.000Z" },
      { ...baseQuote, id: "quote_failing_2", sweep_status: "failed", settled_at: "2026-05-16T09:01:00.000Z", sweep_attempted_at: "2026-05-16T11:50:00.000Z" },
      { ...baseQuote, id: "quote_new", sweep_status: "pending", settled_at: "2026-05-16T11:59:00.000Z" },
    ]);

    const result = await sweepPendingManagedVeniceTokenQuotes({ db, now, limit: 2, ...sweepDeps(jest.fn(async () => "0xsweep")) });

    expect(result.results.map((entry) => entry.quoteId)).toContain("quote_new");
    expect(tables.managed_venice_token_quotes.find((row) => row.id === "quote_new")).toMatchObject({ sweep_status: "swept" });
  });
});
