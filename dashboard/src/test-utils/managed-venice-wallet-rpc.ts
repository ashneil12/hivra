/**
 * In-memory twin of the managed-Venice wallet debit functions in
 * supabase/migrations/20260925201500_managed_venice_atomic_wallet_debits.sql:
 * `capture_managed_venice_reservation` and `debit_managed_venice_wallet`.
 *
 * Each call runs synchronously inside one microtask, so, like the SQL
 * functions under the per-user wallet lock, it never interleaves with another
 * call: a debit lands whole or fails without changing anything. The SQL itself
 * is proven by scripts/test-managed-venice-atomic-wallet-debits.cjs (PGlite)
 * and scripts/test-managed-venice-wallet-debit-concurrency.cjs (real
 * PostgreSQL sessions); this twin lets route and library tests run the real
 * wallet code end to end without a database.
 */

type Row = Record<string, unknown>;

export interface WalletRpcError {
  code?: string;
  message: string;
}

export interface WalletRpcStore {
  /** The live rows of a table (mutated in place). */
  rows(table: string): Row[];
  /** Insert one row, applying the store's defaults and unique indexes. */
  insert(table: string, row: Row): { error: WalletRpcError | null };
}

export type WalletRpcResult = { data: unknown; error: WalletRpcError | null };

function numberOf(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function bigintOf(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  return BigInt(String(value ?? "0") || "0");
}

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { walletRpcError: { code, message } });
}

function isIntegerAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function debitLocked(
  store: WalletRpcStore,
  params: {
    userId: unknown;
    walletType: unknown;
    amount: unknown;
    referenceId: unknown;
    accountId: unknown;
    excludeReservationId: unknown;
  }
) {
  const { userId, walletType, amount, referenceId } = params;
  if (typeof userId !== "string" || !userId.trim()) {
    fail("22023", "managed_venice_debit_invalid: user id is required");
  }
  if (typeof referenceId !== "string" || !referenceId.trim()) {
    fail("22023", "managed_venice_debit_invalid: reference id is required");
  }
  if (!isIntegerAmount(amount) || amount <= 0) {
    fail("22023", "managed_venice_debit_invalid: amount must be a positive number of micro-USD");
  }

  if (walletType === "hermesos" || walletType === "hivra") {
    const lots = store
      .rows("managed_venice_token_lots")
      .filter((lot) => lot.user_id === userId && lot.status === "active" && numberOf(lot.remaining_value_micro_usd) > 0)
      .sort((left, right) => {
        const byCreatedAt = String(left.created_at ?? "").localeCompare(String(right.created_at ?? ""));
        return byCreatedAt || String(left.id ?? "").localeCompare(String(right.id ?? ""));
      });
    // Plan every write first, so a short wallet changes nothing.
    const writes: Array<{ lot: Row; patch: Row }> = [];
    let owed = amount;
    for (const lot of lots) {
      if (owed <= 0) break;
      const previous = numberOf(lot.remaining_value_micro_usd);
      const take = Math.min(previous, owed);
      const next = previous - take;
      const tokens = next === 0 ? 0n : (bigintOf(lot.remaining_token_amount_raw) * BigInt(next)) / BigInt(previous);
      writes.push({
        lot,
        patch: {
          remaining_value_micro_usd: next,
          remaining_token_amount_raw: tokens.toString(),
          status: next === 0 ? "depleted" : "active",
          updated_at: new Date().toISOString(),
        },
      });
      owed -= take;
    }
    if (owed > 0) {
      fail("P0001", `managed_venice_insufficient_balance: token lots short by ${owed} of ${amount}`);
    }
    for (const { lot, patch } of writes) Object.assign(lot, patch);
    return;
  }

  if (walletType !== "card") {
    fail("22023", `managed_venice_debit_invalid: unknown wallet type ${String(walletType)}`);
  }

  const accountId =
    params.accountId ??
    store.rows("managed_venice_wallet_accounts").find((account) => account.user_id === userId)?.id ??
    null;
  const ledger = store
    .rows("managed_venice_card_ledger_entries")
    .filter((entry) => entry.user_id === userId)
    .reduce((sum, entry) => sum + numberOf(entry.amount_micro_usd), 0);
  const otherHolds = store
    .rows("managed_venice_reservations")
    .filter(
      (hold) =>
        hold.user_id === userId &&
        hold.status === "active" &&
        hold.wallet_type === "card" &&
        (params.excludeReservationId == null || hold.id !== params.excludeReservationId)
    )
    .reduce((sum, hold) => sum + numberOf(hold.reserved_micro_usd), 0);
  const available = ledger - otherHolds;
  if (accountId == null || available < amount) {
    fail("P0001", `managed_venice_insufficient_balance: card available=${available} debit=${amount}`);
  }
  const { error } = store.insert("managed_venice_card_ledger_entries", {
    account_id: accountId,
    user_id: userId,
    amount_micro_usd: -amount,
    source: "system",
    actor: "managed_venice_proxy",
    reason: "managed_venice_debit",
    reference_id: referenceId,
    metadata: {},
  });
  if (error) fail(error.code ?? "XX000", error.message);
}

function capture(store: WalletRpcStore, args: Record<string, unknown>) {
  const userId = args.p_user_id;
  const referenceId = args.p_reference_id;
  const amount = args.p_capture_micro_usd;
  if (!isIntegerAmount(amount) || amount < 0) {
    fail("22023", "managed_venice_capture_invalid: capture must be a non-negative number of micro-USD");
  }
  const hold = store
    .rows("managed_venice_reservations")
    .find((row) => row.user_id === userId && row.reference_id === referenceId);
  if (!hold) fail("P0002", `managed_venice_reservation_not_found: ${String(referenceId)}`);

  const reserved = numberOf(hold.reserved_micro_usd);
  if (hold.status !== "active") {
    return {
      captured: false,
      status: hold.status,
      walletType: hold.wallet_type,
      reservedMicroUsd: reserved,
      capturedMicroUsd: numberOf(hold.captured_micro_usd),
      releasedMicroUsd: numberOf(hold.released_micro_usd),
    };
  }
  if (amount > reserved) {
    fail("22023", `managed_venice_capture_exceeds_reservation: reserved=${reserved} capture=${amount}`);
  }
  if (amount > 0) {
    debitLocked(store, {
      userId,
      walletType: hold.wallet_type,
      amount,
      referenceId,
      accountId: hold.account_id ?? null,
      excludeReservationId: hold.id ?? null,
    });
  }
  const released = reserved - amount;
  const now = new Date().toISOString();
  Object.assign(hold, {
    status: "captured",
    captured_micro_usd: amount,
    released_micro_usd: released,
    captured_at: now,
    released_at: released > 0 ? now : null,
    updated_at: now,
  });
  return {
    captured: true,
    status: "captured",
    walletType: hold.wallet_type,
    reservedMicroUsd: reserved,
    capturedMicroUsd: amount,
    releasedMicroUsd: released,
  };
}

/** Run one wallet function against `store`. Synchronous: call it inside one microtask. */
export function runManagedVeniceWalletRpc(
  store: WalletRpcStore,
  fn: string,
  args: Record<string, unknown>
): WalletRpcResult {
  try {
    if (fn === "capture_managed_venice_reservation") {
      return { data: capture(store, args), error: null };
    }
    if (fn === "debit_managed_venice_wallet") {
      debitLocked(store, {
        userId: args.p_user_id,
        walletType: args.p_wallet_type,
        amount: args.p_amount_micro_usd,
        referenceId: args.p_reference_id,
        accountId: null,
        excludeReservationId: null,
      });
      return {
        data: { debited: true, walletType: args.p_wallet_type, amountMicroUsd: args.p_amount_micro_usd },
        error: null,
      };
    }
    return { data: null, error: { code: "PGRST202", message: `Could not find the function public.${fn}` } };
  } catch (error) {
    const walletRpcError = (error as { walletRpcError?: WalletRpcError }).walletRpcError;
    if (walletRpcError) return { data: null, error: walletRpcError };
    throw error;
  }
}

/**
 * A `db.rpc` for hand-rolled table fakes: `rows` returns a table's live array
 * and inserted ledger rows get an id and created_at.
 */
export function createManagedVeniceWalletRpc(rows: (table: string) => Row[]) {
  let sequence = 0;
  const store: WalletRpcStore = {
    rows,
    insert(table, row) {
      sequence += 1;
      rows(table).push({ id: `${table}_rpc_${sequence}`, created_at: new Date().toISOString(), ...row });
      return { error: null };
    },
  };
  return (fn: string, args: Record<string, unknown>) =>
    Promise.resolve().then(() => runManagedVeniceWalletRpc(store, fn, args));
}
