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
 * or the user's next yearly token quote (any status). Times are compared in
 * raw milliseconds, exactly as the managed-Venice reconciler on
 * claude/venice-settlement-fixes does, so the two flows partition the wallet's
 * transfers the same way. Sessions never overlap (crypto-payment-sessions
 * allows one open session per user), so every transfer has at most one owner.
 * On top of that, a transfer another flow already owns is never attributed.
 *
 * Deposit quotes (hold tier) read the separate hermesos_lock wallet and USDC
 * top-ups are a different token, so neither produces $HermesOS transfers here.
 * Keep this rule in step with the managed-Venice reconciler.
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

/**
 * Start of the next $HermesOS payment session on this wallet after
 * `quotedAt`, in ms, or null if there is none yet.
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
  return boundaries.length ? Math.min(...boundaries) : null;
}

export interface HermesosTransferOwnership {
  /** Lowercased tx hashes another flow (or quote) already owns. */
  bound: Set<string>;
  /**
   * Lowercased tx hashes a managed-Venice quote in 'manual_review_required'
   * recorded. The pre-attribution Venice flow wrote transfers it REJECTED
   * (e.g. outside its own window) there, so this is not ownership — but an
   * operator looking at that Venice review must know the transfer paid for
   * something else.
   */
  contested: Set<string>;
}

// Columns that record a transfer a flow owns: yearly quote claims and
// subscriptions, managed-Venice lots, and managed-Venice quote claims /
// settlements (see the review exception above).
const OWNING_COLUMNS: Array<[string, string]> = [
  ["managed_venice_token_lots", "transaction_hash"],
  ["yearly_token_quotes", "consumed_tx_hash"],
  ["yearly_token_subscriptions", "deposit_tx_hash"],
];

export async function loadHermesosTransferOwnership(
  db: SupabaseLike,
  transactionHashes: string[]
): Promise<HermesosTransferOwnership> {
  const ownership: HermesosTransferOwnership = { bound: new Set(), contested: new Set() };
  if (transactionHashes.length === 0) return ownership;
  const variants = Array.from(new Set(transactionHashes.flatMap((hash) => [hash, hash.toLowerCase()])));
  const [venice, ...owning] = await Promise.all([
    (db.from("managed_venice_token_quotes") as DbQuery).select("transaction_hash, status").in("transaction_hash", variants),
    ...OWNING_COLUMNS.map(([tableName, column]) =>
      (db.from(tableName) as DbQuery).select(column).in(column, variants)
    ),
  ]);
  if (venice.error) {
    throw new Error(venice.error.message || "Failed to check managed_venice_token_quotes transaction hashes");
  }
  for (const row of Array.isArray(venice.data) ? (venice.data as Array<Record<string, unknown>>) : []) {
    if (typeof row.transaction_hash !== "string") continue;
    const hash = row.transaction_hash.toLowerCase();
    if (row.status === "manual_review_required") ownership.contested.add(hash);
    else ownership.bound.add(hash);
  }
  owning.forEach((result, index) => {
    const [tableName, column] = OWNING_COLUMNS[index];
    if (result.error) {
      throw new Error(result.error.message || `Failed to check ${tableName} transaction hashes`);
    }
    for (const row of Array.isArray(result.data) ? (result.data as Array<Record<string, unknown>>) : []) {
      const value = row[column];
      if (typeof value === "string") ownership.bound.add(value.toLowerCase());
    }
  });
  return ownership;
}
