/**
 * Yearly $HermesOS payment fixtures on top of the in-memory Supabase fake.
 *
 * Declares the production unique indexes the yearly flow relies on and models
 * the `settle_yearly_token_payment` plpgsql function's contract, so the
 * reconciler, sweep and cron routes run against realistic semantics. The SQL
 * itself is exercised against real PostgreSQL (PGlite) by
 * scripts/test-yearly-token-payment-settlement.cjs; keep the two in step.
 */

import {
  createSupabaseMemoryDb,
  type MemoryRow,
  type MemoryTables,
  type UniqueIndex,
} from "@/test-utils/supabase-memory-db";

export const TEST_USER_ID = "user_1";
export const TEST_DEPOSIT_ADDRESS = "0x000000000000000000000000000000000000ba5e";
export const TEST_TREASURY_ADDRESS = "0x0000000000000000000000000000000000007ea5";
export const TEST_BANKR_WALLET_ID = "bankr_wallet_1";

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export const YEARLY_TOKEN_TABLES = [
  "yearly_token_quotes",
  "yearly_token_subscriptions",
  "yearly_token_reconciliation_items",
  "managed_venice_token_quotes",
  "managed_venice_token_lots",
  "bankr_deposit_wallet_credentials",
  "hermes_subscriptions",
];

export const YEARLY_TOKEN_UNIQUE_INDEXES: Record<string, UniqueIndex[]> = {
  yearly_token_quotes: [
    {
      name: "yearly_token_quotes_user_tier_active_idx",
      columns: ["user_id", "tier"],
      where: (row) => row.status === "active",
    },
    {
      name: "uq_yearly_token_quotes_consumed_tx_hash",
      columns: ["consumed_tx_hash"],
      where: (row) => row.consumed_tx_hash != null,
    },
  ],
  yearly_token_subscriptions: [
    {
      name: "yearly_token_subscriptions_user_tier_active_idx",
      columns: ["user_id", "tier"],
      where: (row) => row.status === "active" || row.status === "grace",
    },
    {
      name: "uq_yearly_token_subscriptions_deposit_tx_hash",
      columns: ["deposit_tx_hash"],
      where: (row) => row.deposit_tx_hash != null,
    },
    {
      name: "uq_yearly_token_subscriptions_yearly_quote_id",
      columns: ["yearly_quote_id"],
      where: (row) => row.yearly_quote_id != null,
    },
  ],
  yearly_token_reconciliation_items: [
    {
      name: "uq_yearly_token_reconciliation_items_dedupe_key",
      columns: ["dedupe_key"],
      where: (row) => row.dedupe_key != null,
    },
  ],
  managed_venice_token_quotes: [
    {
      name: "managed_venice_token_quotes_tx_hash_idx",
      columns: ["transaction_hash"],
      where: (row) => row.transaction_hash != null,
    },
  ],
  bankr_deposit_wallet_credentials: [
    {
      name: "bankr_deposit_wallet_credentials_user_purpose_key",
      columns: ["user_id", "purpose"],
      where: () => true,
    },
  ],
};

function lower(value: unknown) {
  return typeof value === "string" ? value.toLowerCase() : null;
}

function iso(ms: number) {
  return new Date(ms).toISOString();
}

/**
 * Mirrors public.settle_yearly_token_payment (see the migration). The whole
 * call is one transaction: on a unique violation every write is rolled back
 * and the call reports transaction_already_claimed.
 */
export function settleYearlyTokenPaymentModel(
  args: MemoryRow,
  context: { tables: MemoryTables; insertRow: (table: string, row: MemoryRow) => MemoryRow }
) {
  const { tables } = context;
  const tx = String(args.p_transaction_hash ?? "").trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(tx)) return { data: { status: "invalid_transaction" }, error: null };
  const amount = BigInt(String(args.p_amount_raw ?? "0"));
  if (amount <= 0n) return { data: { status: "invalid_amount" }, error: null };
  const nowMs = Date.parse(String(args.p_now));

  const quote = tables.yearly_token_quotes.find((row) => row.id === args.p_quote_id);
  if (!quote) return { data: { status: "not_found" }, error: null };

  if (quote.consumed_tx_hash != null) {
    if (lower(quote.consumed_tx_hash) === tx) {
      const sub = tables.yearly_token_subscriptions.find((row) => row.yearly_quote_id === quote.id);
      return {
        data: {
          status: "already_settled",
          subscription_id: sub?.id ?? null,
          expires_at: sub?.expires_at ?? null,
          transaction_hash: tx,
        },
        error: null,
      };
    }
    return {
      data: { status: "quote_settled_with_other_transaction", transaction_hash: lower(quote.consumed_tx_hash) },
      error: null,
    };
  }

  if (quote.status !== "active" && quote.status !== "expired") {
    return { data: { status: "not_settleable", quote_status: quote.status }, error: null };
  }

  if (tables.yearly_token_subscriptions.some((row) => row.yearly_quote_id === quote.id)) {
    return { data: { status: "legacy_subscription_exists" }, error: null };
  }

  const claimedElsewhere =
    tables.yearly_token_quotes.some((row) => lower(row.consumed_tx_hash) === tx) ||
    tables.yearly_token_subscriptions.some((row) => lower(row.deposit_tx_hash) === tx) ||
    tables.managed_venice_token_quotes.some((row) => lower(row.transaction_hash) === tx) ||
    tables.managed_venice_token_lots.some((row) => lower(row.transaction_hash) === tx);
  if (claimedElsewhere) return { data: { status: "transaction_already_claimed" }, error: null };

  const snapshot = {
    quotes: tables.yearly_token_quotes.map((row) => ({ ...row })),
    subs: tables.yearly_token_subscriptions.map((row) => ({ ...row })),
  };
  try {
    const current = tables.yearly_token_subscriptions.find(
      (row) =>
        row.user_id === quote.user_id &&
        row.tier === quote.tier &&
        (row.status === "active" || row.status === "grace")
    );
    const nowIso = iso(nowMs);
    let expiresAtMs = nowMs + YEAR_MS;
    if (current) {
      expiresAtMs = Math.max(Date.parse(String(current.expires_at)), nowMs) + YEAR_MS;
      Object.assign(current, {
        status: "renewed",
        updated_at: nowIso,
        metadata: { ...(current.metadata as MemoryRow), renewedAt: nowIso, renewedByQuoteId: quote.id },
      });
    }
    const inserted = context.insertRow("yearly_token_subscriptions", {
      user_id: quote.user_id,
      tier: quote.tier,
      yearly_quote_id: quote.id,
      paid_at: nowIso,
      expires_at: iso(expiresAtMs),
      deposit_tx_hash: tx,
      deposit_log_index: args.p_log_index ?? null,
      deposit_address: lower(quote.deposit_address),
      amount_received_raw: amount.toString(),
      sweep_status: "pending",
      sweep_tx_hash: null,
      sweep_attempted_at: null,
      sweep_submitted_at: null,
      sweep_error: null,
      expiry_warning_email_sent_at: null,
      expired_email_sent_at: null,
      status: "active",
      metadata: {
        priceUsdAtQuote: quote.price_usd_at_quote,
        usdTargetCents: quote.usd_target_cents,
        tokensRequiredRaw: String(quote.tokens_required_raw),
        depositAddress: lower(quote.deposit_address),
        blockTimestamp: args.p_block_timestamp ?? null,
        ...(current ? { renewsSubscriptionId: current.id } : {}),
      },
    });
    if (current) {
      current.metadata = { ...(current.metadata as MemoryRow), renewedBySubscriptionId: inserted.id };
    }
    if (tables.yearly_token_quotes.some((row) => row !== quote && lower(row.consumed_tx_hash) === tx)) {
      throw Object.assign(new Error("duplicate consumed_tx_hash"), { code: "23505" });
    }
    Object.assign(quote, {
      status: "consumed",
      consumed_tx_hash: tx,
      consumed_balance_raw: amount.toString(),
      consumed_at: nowIso,
      updated_at: nowIso,
      metadata: {
        ...(quote.metadata as MemoryRow),
        consumedLogIndex: args.p_log_index ?? null,
        consumedBlockTimestamp: args.p_block_timestamp ?? null,
      },
    });
    return {
      data: {
        status: current ? "renewed" : "activated",
        subscription_id: inserted.id,
        expires_at: iso(expiresAtMs),
        renewed_subscription_id: current?.id ?? null,
        transaction_hash: tx,
      },
      error: null,
    };
  } catch (error) {
    tables.yearly_token_quotes.splice(0, tables.yearly_token_quotes.length, ...snapshot.quotes);
    tables.yearly_token_subscriptions.splice(0, tables.yearly_token_subscriptions.length, ...snapshot.subs);
    if ((error as { code?: string }).code === "23505") {
      return { data: { status: "transaction_already_claimed" }, error: null };
    }
    throw error;
  }
}

export function createYearlyTokenMemoryDb(seed: Record<string, MemoryRow[]> = {}) {
  return createSupabaseMemoryDb({
    tables: YEARLY_TOKEN_TABLES,
    seed,
    uniqueIndexes: YEARLY_TOKEN_UNIQUE_INDEXES,
    rpc: { settle_yearly_token_payment: settleYearlyTokenPaymentModel },
  });
}

export type YearlyTokenMemoryDb = ReturnType<typeof createYearlyTokenMemoryDb>;

export function txHash(n: number | string) {
  return `0x${n.toString(16).padStart(64, "0")}`;
}

export function yearlyQuoteRow(overrides: MemoryRow = {}): MemoryRow {
  return {
    id: "yq_1",
    user_id: TEST_USER_ID,
    tier: "pro",
    usd_target_cents: 4900,
    price_usd_at_quote: "0.000002582",
    tokens_required_raw: "1000000000000000000000",
    tokens_required_display: "1000",
    deposit_address: TEST_DEPOSIT_ADDRESS,
    quoted_at: "2026-09-22T10:00:00.000Z",
    expires_at: "2026-09-22T10:20:00.000Z",
    status: "active",
    consumed_balance_raw: null,
    consumed_at: null,
    consumed_tx_hash: null,
    source: "dexscreener",
    metadata: {},
    created_at: "2026-09-22T10:00:00.000Z",
    updated_at: "2026-09-22T10:00:00.000Z",
    ...overrides,
  };
}

export function yearlySubscriptionRow(overrides: MemoryRow = {}): MemoryRow {
  return {
    id: "ys_1",
    user_id: TEST_USER_ID,
    tier: "pro",
    yearly_quote_id: null,
    paid_at: "2025-09-30T10:00:00.000Z",
    expires_at: "2026-09-30T10:00:00.000Z",
    deposit_tx_hash: null,
    deposit_log_index: null,
    deposit_address: TEST_DEPOSIT_ADDRESS,
    amount_received_raw: "1000000000000000000000",
    sweep_status: "swept",
    sweep_tx_hash: null,
    sweep_attempted_at: null,
    sweep_submitted_at: null,
    sweep_error: null,
    expiry_warning_email_sent_at: null,
    expired_email_sent_at: null,
    status: "active",
    metadata: {},
    ...overrides,
  };
}

export function depositCredentialRow(overrides: MemoryRow = {}): MemoryRow {
  const address = String(overrides.evm_address ?? TEST_DEPOSIT_ADDRESS);
  return {
    id: "cred_1",
    user_id: TEST_USER_ID,
    wallet_id: "wallet_1",
    bankr_wallet_id: TEST_BANKR_WALLET_ID,
    evm_address: address,
    normalized_evm_address: address.toLowerCase(),
    api_key_encrypted: null,
    api_key_preview: null,
    api_key_status: "active",
    allowed_recipient_evm: null,
    allowed_ips: [],
    permissions: {},
    metadata: {},
    purpose: "credit_deposit",
    ...overrides,
  };
}

export function managedVeniceQuoteRow(overrides: MemoryRow = {}): MemoryRow {
  return {
    id: "mvq_1",
    user_id: TEST_USER_ID,
    deposit_address: TEST_DEPOSIT_ADDRESS,
    token_amount_raw: "1500000000000000000000",
    quoted_at: "2026-09-22T09:00:00.000Z",
    expires_at: "2026-09-22T09:20:00.000Z",
    status: "settled",
    transaction_hash: null,
    settled_at: null,
    sweep_status: "pending",
    metadata: {},
    ...overrides,
  };
}
