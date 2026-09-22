/**
 * Which $HermesOS payment session owns an inbound transfer?
 *
 * The user's credit_deposit wallet is shared by every managed-Venice quote and
 * every yearly token quote the user makes. A transfer mined at block time t
 * belongs to a session only if
 *
 *     session.quotedAt <= t < (the user's NEXT $HermesOS session on that wallet)
 *
 * where the next session is the next managed-Venice quote on the same address
 * or the user's next yearly token quote (any status). Sessions never overlap
 * (crypto-payment-sessions allows one open session per user), so every
 * transfer has at most one owner. On top of that, a transfer any flow has
 * already bound to a quote, lot or subscription is never attributed again.
 *
 * Deposit quotes (hold tier) read the separate hermesos_lock wallet and USDC
 * top-ups are a different token, so neither produces $HermesOS transfers here.
 * The same rule is implemented by the managed-Venice reconciler on
 * claude/venice-settlement-fixes; keep the two in step.
 */

import { normalizeEvmAddress } from "@/lib/billing/token-holdings";

type QueryError = { code?: string; message?: string } | null;

type DbQuery = {
  select: (...args: unknown[]) => DbQuery;
  eq: (...args: unknown[]) => DbQuery;
  in: (...args: unknown[]) => DbQuery;
  gt: (...args: unknown[]) => DbQuery;
  order: (...args: unknown[]) => DbQuery;
  limit: (...args: unknown[]) => DbQuery;
  then: Promise<{ data?: unknown; error: QueryError }>["then"];
};

export type SupabaseLike = {
  from: (name: string) => unknown;
};

/** Block timestamps are whole seconds; compare sessions at that resolution. */
export function floorToSecondMs(ms: number) {
  return Math.floor(ms / 1000) * 1000;
}

/**
 * Start of the next $HermesOS payment session on this wallet after
 * `quotedAt`, in ms (floored to the second), or null if there is none yet.
 */
export async function loadNextHermesosPaymentSessionMs(
  db: SupabaseLike,
  session: { userId: string; depositAddress: string; quotedAt: string }
) {
  const [nextManaged, nextYearly] = await Promise.all([
    (db.from("managed_venice_token_quotes") as DbQuery)
      .select("id, quoted_at")
      .eq("deposit_address", normalizeEvmAddress(session.depositAddress))
      .gt("quoted_at", session.quotedAt)
      .order("quoted_at", { ascending: true })
      .limit(1),
    (db.from("yearly_token_quotes") as DbQuery)
      .select("id, quoted_at")
      .eq("user_id", session.userId)
      .gt("quoted_at", session.quotedAt)
      .order("quoted_at", { ascending: true })
      .limit(1),
  ]);
  for (const result of [nextManaged, nextYearly]) {
    if (result.error) {
      throw new Error(result.error.message || "Failed to load the next $HermesOS payment session");
    }
  }
  const boundaries = [nextManaged.data, nextYearly.data]
    .flatMap((rows) => (Array.isArray(rows) ? (rows as Array<{ quoted_at?: unknown }>) : []))
    .map((row) => Date.parse(String(row.quoted_at)))
    .filter((value) => Number.isFinite(value));
  return boundaries.length ? floorToSecondMs(Math.min(...boundaries)) : null;
}

// Tx hashes already accounted for by any flow that records $HermesOS
// transfers: managed-Venice quote claims and lots, consumed yearly quotes and
// yearly subscriptions.
const BOUND_TRANSACTION_COLUMNS: Array<[string, string]> = [
  ["managed_venice_token_quotes", "transaction_hash"],
  ["managed_venice_token_lots", "transaction_hash"],
  ["yearly_token_quotes", "consumed_tx_hash"],
  ["yearly_token_subscriptions", "deposit_tx_hash"],
];

/** The subset of `transactionHashes` (lowercased) any flow has already bound. */
export async function loadBoundHermesosTransactionHashes(db: SupabaseLike, transactionHashes: string[]) {
  const bound = new Set<string>();
  if (transactionHashes.length === 0) return bound;
  const variants = Array.from(new Set(transactionHashes.flatMap((hash) => [hash, hash.toLowerCase()])));
  const results = await Promise.all(
    BOUND_TRANSACTION_COLUMNS.map(([tableName, column]) =>
      (db.from(tableName) as DbQuery).select(column).in(column, variants)
    )
  );
  results.forEach((result, index) => {
    const [tableName, column] = BOUND_TRANSACTION_COLUMNS[index];
    if (result.error) {
      throw new Error(result.error.message || `Failed to check ${tableName} transaction hashes`);
    }
    for (const row of Array.isArray(result.data) ? (result.data as Array<Record<string, unknown>>) : []) {
      const value = row[column];
      if (typeof value === "string") bound.add(value.toLowerCase());
    }
  });
  return bound;
}
