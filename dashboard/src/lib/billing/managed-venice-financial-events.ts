import { requireDb } from "@/lib/billing/db-utils";
import { supabaseAdmin } from "@/lib/supabase";
import type { ManagedVeniceWalletType } from "./managed-venice-wallets";

export type ManagedVeniceFinancialEventType =
  | "token_deposit"
  | "card_topup"
  | "reservation_created"
  | "reservation_captured"
  | "reservation_released"
  | "usage_capture"
  | "subsidy_applied"
  | "refund_exception"
  | "reconciliation_adjustment"
  | "reconciliation_refund"
  // One-time managed-Venice starter credit granted on a user's first managed
  // deploy (see grantManagedVeniceStarterCredit). The DB CHECK is widened to
  // accept this in 20260613150000_managed_venice_financial_events_starter_grant.
  | "starter_grant";

type QueryError = { code?: string; message?: string } | null;

type DbChain = {
  select: (...args: unknown[]) => DbChain;
  eq: (...args: unknown[]) => DbChain;
  maybeSingle: () => Promise<{ data: unknown; error: QueryError }>;
  single: () => Promise<{ data: unknown; error: QueryError }>;
  then: Promise<{ data?: unknown; error: QueryError }>["then"];
};

type DbInsertChain = {
  select: (...args: unknown[]) => {
    single: () => Promise<{ data: unknown; error: QueryError }>;
  };
  then: Promise<{ data?: unknown; error: QueryError }>["then"];
};

type DbTable = {
  insert: (...args: unknown[]) => DbInsertChain;
  select: (...args: unknown[]) => DbChain;
};

type SupabaseLike = {
  from: (table: string) => unknown;
};

interface FinancialEventRow {
  id: string;
  user_id: string;
  account_id?: string | null;
  wallet_type?: ManagedVeniceWalletType | null;
  event_type: ManagedVeniceFinancialEventType;
  reference_id: string;
  idempotency_key: string;
  token_amount_raw?: string | number | bigint | null;
  token_price_usd?: string | null;
  amount_micro_usd: number;
  venice_cost_micro_usd: number;
  discount_micro_usd: number;
  metadata?: Record<string, unknown> | null;
  created_at?: string;
}

const SELECT_COLUMNS =
  "id, user_id, account_id, wallet_type, event_type, reference_id, " +
  "idempotency_key, token_amount_raw::text, token_price_usd, amount_micro_usd, " +
  "venice_cost_micro_usd, discount_micro_usd, metadata, created_at";

function table(db: SupabaseLike, name: string): DbTable {
  return db.from(name) as DbTable;
}

function requireString(value: string | null | undefined, label: string) {
  if (!value || !value.trim()) {
    throw new Error(`${label} is required`);
  }
}

function requireNonNegativeMicroUsd(value: number, label: string) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer microdollar amount`);
  }
}

function asFinancialEvent(row: FinancialEventRow, inserted: boolean) {
  return {
    id: row.id,
    inserted,
    userId: row.user_id,
    accountId: row.account_id || null,
    walletType: row.wallet_type || null,
    eventType: row.event_type,
    referenceId: row.reference_id,
    idempotencyKey: row.idempotency_key,
    tokenAmountRaw:
      row.token_amount_raw === null || row.token_amount_raw === undefined
        ? null
        : String(row.token_amount_raw),
    tokenPriceUsd: row.token_price_usd || null,
    amountMicroUsd: row.amount_micro_usd,
    veniceCostMicroUsd: row.venice_cost_micro_usd,
    discountMicroUsd: row.discount_micro_usd,
    metadata: row.metadata || {},
    createdAt: row.created_at || null,
  };
}

async function loadByIdempotencyKey(db: SupabaseLike, idempotencyKey: string) {
  const { data, error } = await table(db, "managed_venice_financial_events")
    .select(SELECT_COLUMNS)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();

  if (error) {
    throw new Error(error.message || "Failed to load managed Venice financial event");
  }

  return data ? asFinancialEvent(data as FinancialEventRow, false) : null;
}

export async function appendManagedVeniceFinancialEvent(
  params: {
    userId: string;
    accountId?: string | null;
    walletType?: ManagedVeniceWalletType | null;
    eventType: ManagedVeniceFinancialEventType;
    referenceId: string;
    idempotencyKey: string;
    tokenAmountRaw?: string | bigint | null;
    tokenPriceUsd?: string | null;
    amountMicroUsd?: number;
    veniceCostMicroUsd?: number;
    discountMicroUsd?: number;
    metadata?: Record<string, unknown>;
  },
  db: SupabaseLike | null | undefined = supabaseAdmin
) {
  requireString(params.userId, "Managed Venice financial event user ID");
  requireString(params.referenceId, "Managed Venice financial event reference ID");
  requireString(params.idempotencyKey, "Managed Venice financial event idempotency key");
  const amountMicroUsd = params.amountMicroUsd ?? 0;
  const veniceCostMicroUsd = params.veniceCostMicroUsd ?? 0;
  const discountMicroUsd = params.discountMicroUsd ?? 0;
  requireNonNegativeMicroUsd(amountMicroUsd, "amountMicroUsd");
  requireNonNegativeMicroUsd(veniceCostMicroUsd, "veniceCostMicroUsd");
  requireNonNegativeMicroUsd(discountMicroUsd, "discountMicroUsd");

  const client = requireDb(db);
  const existing = await loadByIdempotencyKey(client, params.idempotencyKey);
  if (existing) return existing;

  const { data, error } = await table(client, "managed_venice_financial_events")
    .insert({
      user_id: params.userId,
      account_id: params.accountId || null,
      wallet_type: params.walletType || null,
      event_type: params.eventType,
      reference_id: params.referenceId,
      idempotency_key: params.idempotencyKey,
      token_amount_raw:
        params.tokenAmountRaw === null || params.tokenAmountRaw === undefined
          ? null
          : params.tokenAmountRaw.toString(),
      token_price_usd: params.tokenPriceUsd || null,
      amount_micro_usd: amountMicroUsd,
      venice_cost_micro_usd: veniceCostMicroUsd,
      discount_micro_usd: discountMicroUsd,
      metadata: params.metadata || {},
    })
    .select(SELECT_COLUMNS)
    .single();

  if (error || !data) {
    if (error?.code === "23505") {
      const racedExisting = await loadByIdempotencyKey(client, params.idempotencyKey);
      if (racedExisting) return racedExisting;
    }
    throw new Error(error?.message || "Failed to append managed Venice financial event");
  }

  return asFinancialEvent(data as FinancialEventRow, true);
}
