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

export interface TransferRef {
  transactionHash: string;
  logIndex: number;
}

export interface HermesosTransferOwnership {
  /** Another flow (or quote) already owns this Transfer log. */
  isBound(transfer: TransferRef): boolean;
  /**
   * A managed-Venice quote in 'manual_review_required' on this wallet
   * recorded this tx. The pre-attribution Venice flow wrote transfers it
   * REJECTED (e.g. outside its own window) there, so this is not ownership —
   * but an operator looking at that Venice review must know the transfer paid
   * for something else.
   */
  isContested(transfer: TransferRef): boolean;
}

interface YearlyBindingRow {
  tx: string;
  logIndex: number | null;
  address: string | null;
}

function lowerOrNull(value: unknown) {
  return typeof value === "string" ? value.toLowerCase() : null;
}

/**
 * Which of these Transfer logs into `depositAddress` does another flow own?
 *
 * Ownership is per Transfer LOG: one transaction (a multi-send, an exchange
 * batch withdrawal) can pay several users' wallets, and a binding of another
 * log of the same tx is a different transfer. Yearly rows record the log;
 * rows without one (pre-attribution) and managed-Venice quotes, which bind per
 * tx, only count on this same wallet; managed-Venice lots only for this user.
 */
export async function loadHermesosTransferOwnership(
  db: SupabaseLike,
  params: { transfers: TransferRef[]; depositAddress: string; userId: string }
): Promise<HermesosTransferOwnership> {
  const wallet = normalizeEvmAddress(params.depositAddress);
  const hashes = Array.from(new Set(params.transfers.map((transfer) => transfer.transactionHash.toLowerCase())));
  if (hashes.length === 0) return { isBound: () => false, isContested: () => false };
  const variants = Array.from(new Set(params.transfers.flatMap((transfer) => [transfer.transactionHash, transfer.transactionHash.toLowerCase()])));

  const [yearlyQuotes, yearlySubs, veniceQuotes, veniceLots] = await Promise.all([
    (db.from("yearly_token_quotes") as DbQuery)
      .select("consumed_tx_hash, consumed_log_index, deposit_address")
      .in("consumed_tx_hash", variants),
    (db.from("yearly_token_subscriptions") as DbQuery)
      .select("deposit_tx_hash, deposit_log_index, deposit_address")
      .in("deposit_tx_hash", variants),
    (db.from("managed_venice_token_quotes") as DbQuery)
      .select("transaction_hash, status, deposit_address")
      .in("transaction_hash", variants),
    (db.from("managed_venice_token_lots") as DbQuery).select("transaction_hash, user_id").in("transaction_hash", variants),
  ]);
  for (const [name, result] of [
    ["yearly_token_quotes", yearlyQuotes],
    ["yearly_token_subscriptions", yearlySubs],
    ["managed_venice_token_quotes", veniceQuotes],
    ["managed_venice_token_lots", veniceLots],
  ] as const) {
    if (result.error) throw new Error(result.error.message || `Failed to check ${name} transaction hashes`);
  }
  const rows = (result: { data?: unknown }) =>
    Array.isArray(result.data) ? (result.data as Array<Record<string, unknown>>) : [];

  const yearly: YearlyBindingRow[] = [
    ...rows(yearlyQuotes).map((row) => ({
      tx: lowerOrNull(row.consumed_tx_hash) ?? "",
      logIndex: typeof row.consumed_log_index === "number" ? row.consumed_log_index : null,
      address: lowerOrNull(row.deposit_address),
    })),
    ...rows(yearlySubs).map((row) => ({
      tx: lowerOrNull(row.deposit_tx_hash) ?? "",
      logIndex: typeof row.deposit_log_index === "number" ? row.deposit_log_index : null,
      address: lowerOrNull(row.deposit_address),
    })),
  ];
  const veniceOnWallet = rows(veniceQuotes).filter((row) => lowerOrNull(row.deposit_address) === wallet);
  const boundByVenice = new Set(
    veniceOnWallet
      .filter((row) => row.status !== "manual_review_required")
      .map((row) => lowerOrNull(row.transaction_hash))
  );
  const contestedByVenice = new Set(
    veniceOnWallet
      .filter((row) => row.status === "manual_review_required")
      .map((row) => lowerOrNull(row.transaction_hash))
  );
  const boundByLot = new Set(
    rows(veniceLots)
      .filter((row) => row.user_id === params.userId)
      .map((row) => lowerOrNull(row.transaction_hash))
  );

  return {
    isBound(transfer) {
      const tx = transfer.transactionHash.toLowerCase();
      return (
        boundByVenice.has(tx) ||
        boundByLot.has(tx) ||
        yearly.some(
          (row) =>
            row.tx === tx && (row.logIndex === transfer.logIndex || (row.logIndex === null && row.address === wallet))
        )
      );
    },
    isContested(transfer) {
      return contestedByVenice.has(transfer.transactionHash.toLowerCase());
    },
  };
}
