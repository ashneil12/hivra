import "server-only";

import { requireDb } from "@/lib/billing/db-utils";
import { supabaseAdmin } from "@/lib/supabase";

// User-level read of the `bankr_withdrawals` claim table (RLS = service-role
// only, so this MUST run through the admin client). The table has no owner
// (instance / hivra_agent) column, so v0 history is scoped to the user. The
// same table is the cross-serverless in-flight lock + the audit record for
// every funds-out transfer across BOTH the Hermes and Hivra lanes.
//
// FOLLOW-UP: per-agent scoping needs a new column on `bankr_withdrawals`
// (instance_id / hivra_agent_id) + a migration; intentionally out of scope for
// this no-migration v0.

type QueryError = { message?: string } | null;

type DbSelectFilter = {
  eq: (...args: unknown[]) => DbSelectFilter;
  order: (...args: unknown[]) => DbSelectFilter;
  limit: (count: number) => Promise<{ data: unknown; error: QueryError }>;
};

type DbTable = {
  select: (...args: unknown[]) => DbSelectFilter;
};

export type SupabaseLike = {
  from: (table: string) => unknown;
};

type WithdrawalHistoryStatus =
  | "in_flight"
  | "submitted"
  | "failed"
  | "cancelled";

export interface WithdrawalHistoryEntry {
  id: string;
  status: WithdrawalHistoryStatus;
  amountRaw: string | null;
  recipient: string | null;
  txHash: string | null;
  chain: string | null;
  tokenSymbol: string | null;
  tokenAddress: string | null;
  tokenDecimals: number | null;
  errorMessage: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

interface BankrWithdrawalRow {
  id: string;
  status: string;
  amount_raw: string | number | null;
  recipient: string | null;
  tx_hash: string | null;
  chain: string | null;
  token_symbol: string | null;
  token_address: string | null;
  token_decimals: number | null;
  error_message: string | null;
  created_at: string | null;
  updated_at: string | null;
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

function readStatus(value: unknown): WithdrawalHistoryStatus {
  return value === "submitted" || value === "failed" || value === "cancelled"
    ? value
    : "in_flight";
}

function readNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.length ? text : null;
}

function readNullableInt(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  return Number.isFinite(num) ? Math.trunc(num) : null;
}

function asWithdrawalHistoryEntry(row: BankrWithdrawalRow): WithdrawalHistoryEntry {
  return {
    id: row.id,
    status: readStatus(row.status),
    amountRaw: readNullableString(row.amount_raw),
    recipient: row.recipient ?? null,
    txHash: row.tx_hash ?? null,
    chain: row.chain ?? null,
    tokenSymbol: row.token_symbol ?? null,
    tokenAddress: row.token_address ?? null,
    tokenDecimals: readNullableInt(row.token_decimals),
    errorMessage: row.error_message ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

export function normalizeWithdrawalHistoryLimit(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(num)));
}

/**
 * Read a user's Bankr withdrawal/earnings history, newest first. User-level
 * (the table has no owner column). Read-only — never writes.
 */
export async function getUserWithdrawalHistory(
  userId: string,
  options: { limit?: number; db?: SupabaseLike | null } = {}
): Promise<WithdrawalHistoryEntry[]> {
  const admin = requireDb(options.db ?? supabaseAdmin) as SupabaseLike;
  const limit = normalizeWithdrawalHistoryLimit(options.limit ?? DEFAULT_LIMIT);

  const { data, error } = await (admin.from("bankr_withdrawals") as DbTable)
    .select(
      "id,status,amount_raw,recipient,tx_hash,chain,token_symbol,token_address,token_decimals,error_message,created_at,updated_at"
    )
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    throw new Error(error.message || "Failed to load withdrawal history");
  }

  return Array.isArray(data)
    ? (data as BankrWithdrawalRow[]).map(asWithdrawalHistoryEntry)
    : [];
}
