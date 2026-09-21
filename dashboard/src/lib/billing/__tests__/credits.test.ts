import type { CreditLedgerReason } from "@/lib/billing/credits";
import {
  CREDIT_UNIT_LABEL,
  appendCreditLedgerEntry,
  createCreditReservation,
  creditsToUsd,
  deriveCreditBalance,
  deriveReservedCreditBalance,
  getCachedCreditBalance,
  getCreditSummary,
  getPlanMonthlyCreditGrant,
  grantStripeTopUpCredits,
  grantSubscriptionCycleCredits,
  isTopUpPackageCredits,
  recordComputeUsageDebit,
  recordLlmUsageEvent,
  releaseCreditReservation,
} from "@/lib/billing/credits";

interface LedgerEntry {
  user_id: string;
  amount_credits: number;
  source: string;
  reason: string;
  reference_id: string;
}

function createMemoryDb() {
  const accounts = new Map<
    string,
    {
      id: string;
      user_id: string;
      balance_cached_credits: number;
      stripe_customer_id: string | null;
    }
  >();
  const ledger: LedgerEntry[] = [];
  const ledgerKeys = new Set<string>();
  const payments = new Map<string, unknown>();
  const reservations: Array<Record<string, unknown>> = [];
  const usageEvents: Array<Record<string, unknown>> = [];
  const usageEventKeys = new Set<string>();
  const llmUsageEvents: Array<Record<string, unknown>> = [];
  const llmUsageEventKeys = new Set<string>();

  function creditAccountsTable() {
    return {
      upsert: (row: { user_id: string }) => ({
        select: () => ({
          single: async () => {
            const existing = accounts.get(row.user_id);
            if (existing) return { data: existing, error: null };

            const created = {
              id: `acct_${accounts.size + 1}`,
              user_id: row.user_id,
              balance_cached_credits: 0,
              stripe_customer_id: null,
            };
            accounts.set(row.user_id, created);
            return { data: created, error: null };
          },
        }),
      }),
      update: (patch: { balance_cached_credits?: number; stripe_customer_id?: string }) => ({
        eq: async (_column: string, id: string) => {
          for (const account of accounts.values()) {
            if (account.id === id) {
              Object.assign(account, patch);
            }
          }
          return { error: null };
        },
      }),
    };
  }

  function ledgerTable() {
    return {
      insert: async (row: LedgerEntry) => {
        const key = `${row.source}:${row.reference_id}:${row.reason}`;
        if (ledgerKeys.has(key)) {
          return { error: { code: "23505", message: "duplicate key" } };
        }

        ledgerKeys.add(key);
        ledger.push(row);
        return { error: null };
      },
      select: () => ({
        eq: async (_column: string, userId: string) => ({
          data: ledger.filter((entry) => entry.user_id === userId),
          error: null,
        }),
      }),
    };
  }

  function paymentTransactionsTable() {
    return {
      upsert: async (row: { provider: string; provider_reference_id: string }) => {
        payments.set(`${row.provider}:${row.provider_reference_id}`, row);
        return { error: null };
      },
    };
  }

  function creditReservationsTable() {
    return {
      upsert: (row: Record<string, unknown>) => {
        const existingIndex = reservations.findIndex((reservation) =>
          reservation.user_id === row.user_id &&
          reservation.reason === row.reason &&
          reservation.reference_id === row.reference_id
        );
        const stored = {
          id: existingIndex >= 0 ? reservations[existingIndex].id : `reservation_${reservations.length + 1}`,
          ...row,
        };

        if (existingIndex >= 0) {
          reservations[existingIndex] = { ...reservations[existingIndex], ...stored };
        } else {
          reservations.push(stored);
        }

        return {
          select: () => ({
            single: async () => ({ data: stored, error: null }),
          }),
        };
      },
      select: () => {
        const filters: Record<string, unknown> = {};
        const query: {
          eq: jest.Mock;
          then: Promise<{ data: Array<Record<string, unknown>>; error: null }>["then"];
        } = {} as {
          eq: jest.Mock;
          then: Promise<{ data: Array<Record<string, unknown>>; error: null }>["then"];
        };

        query.eq = jest.fn((column: string, value: unknown) => {
          filters[column] = value;
          return query;
        });
        query.then = (resolve, reject) =>
          Promise.resolve({
            data: reservations.filter((reservation) =>
              Object.entries(filters).every(([column, value]) => reservation[column] === value)
            ),
            error: null,
          }).then(resolve, reject);

        return query;
      },
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
          for (const reservation of reservations) {
            if (Object.entries(filters).every(([column, value]) => reservation[column] === value)) {
              Object.assign(reservation, patch);
            }
          }

          return Promise.resolve({ error: null }).then(resolve, reject);
        };

        return query;
      },
    };
  }

  function computeUsageEventsTable() {
    return {
      insert: async (row: Record<string, unknown>) => {
        const key = `${row.usage_kind}:${row.reference_id}`;
        if (usageEventKeys.has(key)) {
          return { error: { code: "23505", message: "duplicate key" } };
        }

        usageEventKeys.add(key);
        usageEvents.push(row);
        return { error: null };
      },
    };
  }

  function llmUsageEventsTable() {
    return {
      insert: async (row: Record<string, unknown>) => {
        const key = `${row.billing_source}:${row.reference_id}`;
        if (llmUsageEventKeys.has(key)) {
          return { error: { code: "23505", message: "duplicate key" } };
        }

        llmUsageEventKeys.add(key);
        llmUsageEvents.push(row);
        return { error: null };
      },
    };
  }

  function table(name: string) {
    if (name === "credit_accounts") return creditAccountsTable();
    if (name === "credit_ledger_entries") return ledgerTable();
    if (name === "payment_transactions") return paymentTransactionsTable();
    if (name === "credit_reservations") return creditReservationsTable();
    if (name === "compute_usage_events") return computeUsageEventsTable();
    if (name === "llm_usage_events") return llmUsageEventsTable();

    throw new Error(`Unexpected table ${name}`);
  }

  return {
    db: { from: table },
    ledger,
    payments,
    reservations,
    usageEvents,
    llmUsageEvents,
  };
}

describe("credits billing domain", () => {
  it("uses integer credits and plan packaging grants", () => {
    expect(CREDIT_UNIT_LABEL).toBe("100 credits = $1");
    expect(creditsToUsd(500)).toBe(5);
    // Plan monthly credit grant scales by plan price × tier multiplier:
    //   operator (Pro):   $9.99 × 1.10  = 1099 credits
    //   fleet    (Power): $19.99 × 1.20 = 2399 credits (rounded)
    //   command:          $49.00 × 1.30 = 6370 credits (unchanged)
    expect(getPlanMonthlyCreditGrant("operator")).toBe(1099);
    expect(getPlanMonthlyCreditGrant("fleet")).toBe(2399);
    expect(getPlanMonthlyCreditGrant("command")).toBe(6370);
    expect(getPlanMonthlyCreditGrant("unknown")).toBe(0);
  });

  it("validates allowed top-up packages", () => {
    expect(isTopUpPackageCredits(500)).toBe(true);
    expect(isTopUpPackageCredits(1000)).toBe(true);
    expect(isTopUpPackageCredits(2500)).toBe(true);
    expect(isTopUpPackageCredits(5000)).toBe(true);
    expect(isTopUpPackageCredits(750)).toBe(false);
  });

  it("derives balance from append-only ledger entries", async () => {
    const { db } = createMemoryDb();

    await appendCreditLedgerEntry(
      {
        userId: "user_1",
        amountCredits: 500,
        source: "stripe",
        actor: "stripe_webhook",
        reason: "stripe_topup",
        referenceId: "cs_1",
      },
      db
    );
    await appendCreditLedgerEntry(
      {
        userId: "user_1",
        amountCredits: -125,
        source: "system",
        actor: "billing_worker",
        reason: "compute_debit",
        referenceId: "usage_1",
      },
      db
    );

    await expect(deriveCreditBalance("user_1", db)).resolves.toBe(375);
  });

  it("uses the atomic recompute RPC for the cached balance when it is available", async () => {
    const { db } = createMemoryDb();
    // The real RPC recomputes + persists atomically and returns the balance.
    const rpc = jest.fn(async () => ({ data: 999, error: null }));
    const dbWithRpc = { ...db, rpc };

    const result = await appendCreditLedgerEntry(
      {
        userId: "user_1",
        amountCredits: 500,
        source: "stripe",
        actor: "stripe_webhook",
        reason: "stripe_topup",
        referenceId: "cs_rpc",
      },
      dbWithRpc
    );

    // Returned the RPC's value (proves the atomic path was taken, not the
    // derive-then-write fallback which would return the real ledger sum, 500).
    expect(result.balance).toBe(999);
    expect(rpc).toHaveBeenCalledWith("refresh_credit_account_cached_balance", {
      p_account_id: "acct_1",
    });
  });

  it("falls back to derive-then-write when the recompute RPC is unavailable", async () => {
    const { db } = createMemoryDb(); // no `.rpc` on this client

    await appendCreditLedgerEntry(
      {
        userId: "user_1",
        amountCredits: 500,
        source: "stripe",
        actor: "stripe_webhook",
        reason: "stripe_topup",
        referenceId: "cs_fb1",
      },
      db
    );
    const second = await appendCreditLedgerEntry(
      {
        userId: "user_1",
        amountCredits: -125,
        source: "system",
        actor: "billing_worker",
        reason: "compute_debit",
        referenceId: "usage_fb1",
      },
      db
    );

    // Fallback derives the real balance from the ledger.
    expect(second.balance).toBe(375);
  });

  it("does not double-credit duplicate references", async () => {
    const { db, ledger } = createMemoryDb();

    const first = await grantStripeTopUpCredits(
      {
        userId: "user_1",
        sessionId: "cs_duplicate",
        packageCredits: 1000,
        amountTotalCents: 1000,
      },
      db
    );
    const second = await grantStripeTopUpCredits(
      {
        userId: "user_1",
        sessionId: "cs_duplicate",
        packageCredits: 1000,
        amountTotalCents: 1000,
      },
      db
    );

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.balance).toBe(1000);
    expect(ledger).toHaveLength(1);
  });

  it("requires user, actor, reference, and a non-zero integer amount", async () => {
    const { db } = createMemoryDb();

    await expect(
      appendCreditLedgerEntry(
        {
          userId: "user_1",
          amountCredits: 0,
          source: "stripe",
          actor: "stripe_webhook",
          reason: "stripe_topup",
          referenceId: "cs_1",
        },
        db
      )
    ).rejects.toThrow(/non-zero integer/);

    await expect(
      appendCreditLedgerEntry(
        {
          userId: "user_1",
          amountCredits: 500,
          source: "stripe",
          actor: "",
          reason: "stripe_topup",
          referenceId: "cs_1",
        },
        db
      )
    ).rejects.toThrow(/actor is required/);

    await expect(
      appendCreditLedgerEntry(
        {
          userId: "",
          amountCredits: 500,
          source: "stripe",
          actor: "stripe_webhook",
          reason: "stripe_topup",
          referenceId: "cs_1",
        },
        db
      )
    ).rejects.toThrow(/user ID is required/);

    await expect(
      appendCreditLedgerEntry(
        {
          userId: "user_1",
          amountCredits: 500,
          source: "stripe",
          actor: "stripe_webhook",
          reason: "stripe_topup",
          referenceId: "",
        },
        db
      )
    ).rejects.toThrow(/reference ID is required/);
  });

  it("grants subscription-cycle credits idempotently per billing period", async () => {
    const { db, ledger } = createMemoryDb();

    await grantSubscriptionCycleCredits(
      {
        userId: "user_1",
        planKey: "fleet",
        subscriptionId: "sub_1",
        periodStart: 100,
        periodEnd: 200,
      },
      db
    );
    const duplicate = await grantSubscriptionCycleCredits(
      {
        userId: "user_1",
        planKey: "fleet",
        subscriptionId: "sub_1",
        periodStart: 100,
        periodEnd: 200,
      },
      db
    );

    expect(duplicate.inserted).toBe(false);
    // Fleet (Power) credit grant after launch-pricing drop = 2399.
    expect(duplicate.balance).toBe(2399);
    expect(ledger).toHaveLength(1);
  });

  // Characterization: with NO provenance params the grant writes exactly what
  // the pre-parameterization code hardcoded — Stripe callers see zero change.
  it("keeps the default subscription-grant provenance byte-identical (stripe)", async () => {
    const { db, ledger } = createMemoryDb();

    await grantSubscriptionCycleCredits(
      {
        userId: "user_default",
        planKey: "operator",
        subscriptionId: "sub_default",
        periodStart: 100,
        periodEnd: 200,
      },
      db
    );

    expect(ledger).toHaveLength(1);
    const entry = ledger[0] as LedgerEntry & { actor: string };
    expect(entry.source).toBe("stripe");
    expect(entry.actor).toBe("stripe_webhook");
    expect(entry.reason).toBe("subscription_grant");
    expect(entry.reference_id).toBe("stripe_subscription:sub_default:100:200");
    expect(entry.amount_credits).toBe(1099);
  });

  it("grants Apple-lane subscription credits with apple provenance and the apple idempotency ref", async () => {
    const { db, ledger } = createMemoryDb();

    await grantSubscriptionCycleCredits(
      {
        userId: "user_apple",
        planKey: "operator",
        subscriptionId: "2000000123456789", // originalTransactionId
        periodStart: 1_752_600_000_000,
        periodEnd: 1_755_278_400_000,
        source: "apple",
        actor: "apple_webhook",
        referencePrefix: "apple_subscription",
      },
      db
    );
    // Redelivery / reconciler convergence for the same period dedupes.
    const duplicate = await grantSubscriptionCycleCredits(
      {
        userId: "user_apple",
        planKey: "operator",
        subscriptionId: "2000000123456789",
        periodStart: 1_752_600_000_000,
        periodEnd: 1_755_278_400_000,
        source: "apple",
        actor: "apple_webhook",
        referencePrefix: "apple_subscription",
      },
      db
    );

    expect(duplicate.inserted).toBe(false);
    expect(ledger).toHaveLength(1);
    const entry = ledger[0] as LedgerEntry & { actor: string };
    expect(entry.source).toBe("apple");
    expect(entry.actor).toBe("apple_webhook");
    expect(entry.reference_id).toBe(
      "apple_subscription:2000000123456789:1752600000000:1755278400000"
    );
    expect(entry.amount_credits).toBe(1099);
  });

  it("tracks active credit reservations separately from ledger balance", async () => {
    const { db, reservations } = createMemoryDb();

    const reservation = await createCreditReservation(
      {
        userId: "user_1",
        amountCredits: 250,
        reason: "compute_hour_buffer",
        referenceId: "inst_1:2026-04-24T12",
        metadata: { instanceId: "inst_1" },
      },
      db
    );

    expect(reservation).toEqual({
      id: "reservation_1",
      amountCredits: 250,
      status: "active",
    });
    await expect(deriveReservedCreditBalance("user_1", db)).resolves.toBe(250);

    await releaseCreditReservation(
      {
        userId: "user_1",
        reason: "compute_hour_buffer",
        referenceId: "inst_1:2026-04-24T12",
      },
      db
    );

    await expect(deriveReservedCreditBalance("user_1", db)).resolves.toBe(0);
    expect(reservations[0]).toEqual(expect.objectContaining({
      status: "released",
    }));
  });

  it("records compute usage debits idempotently through usage events and ledger entries", async () => {
    const { db, ledger, usageEvents } = createMemoryDb();

    await grantStripeTopUpCredits(
      {
        userId: "user_1",
        sessionId: "cs_1",
        packageCredits: 500,
        amountTotalCents: 500,
      },
      db
    );

    const first = await recordComputeUsageDebit(
      {
        userId: "user_1",
        instanceId: "inst_1",
        amountCredits: 125,
        referenceId: "inst_1:2026-04-24T12",
        periodStart: "2026-04-24T12:00:00.000Z",
        periodEnd: "2026-04-24T13:00:00.000Z",
      },
      db
    );
    const duplicate = await recordComputeUsageDebit(
      {
        userId: "user_1",
        instanceId: "inst_1",
        amountCredits: 125,
        referenceId: "inst_1:2026-04-24T12",
        periodStart: "2026-04-24T12:00:00.000Z",
        periodEnd: "2026-04-24T13:00:00.000Z",
      },
      db
    );

    expect(first).toEqual({ inserted: true, balance: 375 });
    expect(duplicate).toEqual({ inserted: false, balance: 375 });
    expect(usageEvents).toEqual([
      expect.objectContaining({
        user_id: "user_1",
        instance_id: "inst_1",
        credits_delta: -125,
        usage_kind: "compute",
        reference_id: "inst_1:2026-04-24T12",
        status: "recorded",
      }),
    ]);
    expect(ledger).toEqual([
      expect.objectContaining({
        reason: "stripe_topup",
        amount_credits: 500,
      }),
      expect.objectContaining({
        reason: "compute_debit",
        source: "system",
        actor: "billing_worker",
        amount_credits: -125,
        reference_id: "inst_1:2026-04-24T12",
      }),
    ]);
  });

  it("records Hermes credit LLM usage separately from compute usage", async () => {
    const { db, ledger, llmUsageEvents, usageEvents } = createMemoryDb();

    await grantStripeTopUpCredits(
      {
        userId: "user_1",
        sessionId: "cs_llm",
        packageCredits: 1000,
        amountTotalCents: 1000,
      },
      db
    );

    const first = await recordLlmUsageEvent(
      {
        userId: "user_1",
        referenceId: "llm:chat_1:turn_1",
        provider: "bankr",
        model: "claude-opus-4.7",
        billingSource: "hermes_credits",
        amountCredits: 75,
        instanceId: "00000000-0000-4000-8000-000000000001",
        conversationId: "chat_1",
        promptTokens: 1000,
        completionTokens: 500,
      },
      db
    );
    const duplicate = await recordLlmUsageEvent(
      {
        userId: "user_1",
        referenceId: "llm:chat_1:turn_1",
        provider: "bankr",
        model: "claude-opus-4.7",
        billingSource: "hermes_credits",
        amountCredits: 75,
        instanceId: "00000000-0000-4000-8000-000000000001",
        conversationId: "chat_1",
      },
      db
    );

    expect(first).toEqual({ inserted: true, debited: true, balance: 925 });
    expect(duplicate).toEqual({ inserted: false, debited: false, balance: 925 });
    expect(usageEvents).toHaveLength(0);
    expect(llmUsageEvents).toEqual([
      expect.objectContaining({
        user_id: "user_1",
        provider: "bankr",
        model: "claude-opus-4.7",
        billing_source: "hermes_credits",
        credits_delta: -75,
        prompt_tokens: 1000,
        completion_tokens: 500,
        total_tokens: 1500,
        reference_id: "llm:chat_1:turn_1",
      }),
    ]);
    expect(ledger).toEqual([
      expect.objectContaining({
        reason: "stripe_topup",
        amount_credits: 1000,
      }),
      expect.objectContaining({
        reason: "llm_debit",
        source: "system",
        actor: "llm_gateway",
        amount_credits: -75,
        reference_id: "llm:chat_1:turn_1",
      }),
    ]);
  });

  it("tracks Bankr LLM credits without debiting Hermes credits", async () => {
    const { db, ledger, llmUsageEvents } = createMemoryDb();

    const result = await recordLlmUsageEvent(
      {
        userId: "user_1",
        referenceId: "bankr-llm-request-1",
        provider: "bankr",
        model: "gemini-3-flash",
        billingSource: "bankr_llm_credits",
        promptTokens: 250,
        completionTokens: 125,
      },
      db
    );

    expect(result).toEqual({ inserted: true, debited: false, balance: null });
    expect(ledger).toHaveLength(0);
    expect(llmUsageEvents).toEqual([
      expect.objectContaining({
        billing_source: "bankr_llm_credits",
        credits_delta: 0,
        total_tokens: 375,
      }),
    ]);
  });

  it("rejects non-Hermes LLM usage that tries to debit Hermes credits", async () => {
    const { db } = createMemoryDb();

    await expect(
      recordLlmUsageEvent(
        {
          userId: "user_1",
          referenceId: "byo-key-request-1",
          provider: "openrouter",
          model: "openai/gpt-5.4",
          billingSource: "byo_key",
          amountCredits: 25,
        },
        db
      )
    ).rejects.toThrow(/Only Hermes credit LLM usage/);
  });

  it("returns credit summary for the billing usage API", async () => {
    const { db } = createMemoryDb();

    await grantStripeTopUpCredits(
      {
        userId: "user_1",
        sessionId: "cs_1",
        packageCredits: 500,
        amountTotalCents: 500,
      },
      db
    );

    await expect(getCreditSummary("user_1", "operator", db)).resolves.toEqual({
      balance: 500,
      // Operator (Pro) grant = $9.99 × 1.10 = 1099.
      monthlyGrant: 1099,
      unit: "100 credits = $1",
    });
  });

  it("getCachedCreditBalance reads the cached column, not a full ledger scan", async () => {
    // Performance regression guard: the dashboard polls this on a timer.
    // The cached column is maintained synchronously by every
    // appendCreditLedgerEntry, so a read should NEVER hit the
    // credit_ledger_entries table when the cache is populated.
    //
    // Approach: build a minimal db where credit_ledger_entries throws on
    // any access. If getCachedCreditBalance returns successfully, we know
    // it didn't touch the ledger.
    const accounts = new Map<
      string,
      { id: string; user_id: string; balance_cached_credits: number | null }
    >();
    accounts.set("user_cached", {
      id: "acct_cached",
      user_id: "user_cached",
      balance_cached_credits: 500,
    });
    const db = {
      from: (name: string) => {
        if (name === "credit_accounts") {
          return {
            upsert: () => ({
              select: () => ({
                single: async () => ({
                  data: accounts.get("user_cached"),
                  error: null,
                }),
              }),
            }),
          };
        }
        if (name === "credit_ledger_entries") {
          throw new Error("BUG: read path should not hit credit_ledger_entries");
        }
        throw new Error(`Unexpected table: ${name}`);
      },
    };

    const balance = await getCachedCreditBalance(
      "user_cached",
      db as unknown as Parameters<typeof getCachedCreditBalance>[1]
    );
    expect(balance).toBe(500);
  });

  it("getCachedCreditBalance falls back to derive + write on a null cache", async () => {
    // Legacy account row whose balance_cached_credits has never been set.
    // The first read should derive once and backfill so subsequent reads
    // are fast.
    const accounts = new Map<
      string,
      { id: string; user_id: string; balance_cached_credits: number | null }
    >();
    accounts.set("user_legacy", {
      id: "acct_legacy",
      user_id: "user_legacy",
      balance_cached_credits: null,
    });
    const ledger: Array<{ user_id: string; amount_credits: number }> = [
      { user_id: "user_legacy", amount_credits: 200 },
      { user_id: "user_legacy", amount_credits: 50 },
    ];
    let updateWritten: number | null = null;

    const db = {
      from: (name: string) => {
        if (name === "credit_accounts") {
          return {
            upsert: () => ({
              select: () => ({
                single: async () => ({
                  data: accounts.get("user_legacy"),
                  error: null,
                }),
              }),
            }),
            update: (patch: { balance_cached_credits?: number }) => ({
              eq: async () => {
                if (typeof patch.balance_cached_credits === "number") {
                  updateWritten = patch.balance_cached_credits;
                  const a = accounts.get("user_legacy");
                  if (a) a.balance_cached_credits = patch.balance_cached_credits;
                }
                return { error: null };
              },
            }),
          };
        }
        if (name === "credit_ledger_entries") {
          return {
            select: () => ({
              eq: async () => ({ data: ledger, error: null }),
            }),
          };
        }
        throw new Error(`Unexpected table: ${name}`);
      },
    };

    const balance = await getCachedCreditBalance(
      "user_legacy",
      db as unknown as Parameters<typeof getCachedCreditBalance>[1]
    );

    expect(balance).toBe(250);
    // Critical: the cache was actually written so the next read is cheap.
    expect(updateWritten).toBe(250);
  });

  it("admits the Wave 6.1 marketplace/transfer ledger reasons (and keeps existing ones)", () => {
    // CreditLedgerReason gates every appendCreditLedgerEntry call site at the
    // type level; it must mirror the DB reason CHECK widened in migration
    // 20260613200000. If a value here stops type-checking, the union and the
    // CHECK have drifted apart.
    const existingReasons: CreditLedgerReason[] = [
      "stripe_topup",
      "subscription_grant",
      "admin_adjustment",
      "refund",
      "bonus_credit",
      "compute_debit",
      "llm_debit",
      "crypto_topup",
    ];
    const newReasons: CreditLedgerReason[] = [
      "marketplace_purchase",
      "marketplace_earn",
      "transfer",
    ];

    expect(existingReasons).toHaveLength(8);
    expect(newReasons).toEqual([
      "marketplace_purchase",
      "marketplace_earn",
      "transfer",
    ]);

    // The new reasons flow through appendCreditLedgerEntry unchanged — they are
    // valid `reason` values, not just standalone strings.
    const accepts = (reason: CreditLedgerReason): CreditLedgerReason => reason;
    expect(accepts("marketplace_purchase")).toBe("marketplace_purchase");
    expect(accepts("marketplace_earn")).toBe("marketplace_earn");
    expect(accepts("transfer")).toBe("transfer");
  });
});
