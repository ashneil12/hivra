import { requireDb } from "@/lib/billing/db-utils";
import { supabaseAdmin } from "@/lib/supabase";
import { appendManagedVeniceFinancialEvent } from "./managed-venice-financial-events";

// SCRIPTURE_ANCHOR: venice-wallet | Proverbs 3:9 | Verse: Honor Yahweh with your substance, with the first fruits of all your increase.
export type ManagedVeniceWalletType = "hermesos" | "card";

type QueryError = { code?: string; message?: string } | null;

type DbChain = {
  select: (...args: unknown[]) => DbChain;
  eq: (...args: unknown[]) => DbChain;
  order: (...args: unknown[]) => DbChain;
  single: () => Promise<{ data: unknown; error: QueryError }>;
  maybeSingle: () => Promise<{ data: unknown; error: QueryError }>;
  then: Promise<{ data?: unknown; error: QueryError }>["then"];
};

type DbUpdateFilter = {
  eq: (...args: unknown[]) => DbUpdateFilter;
  then: Promise<{ error: QueryError }>["then"];
};

type DbTable = {
  insert: (...args: unknown[]) => Promise<{ error: QueryError }>;
  select: (...args: unknown[]) => DbChain;
  update: (...args: unknown[]) => DbUpdateFilter;
  upsert: (...args: unknown[]) => DbChain;
};

type SupabaseLike = {
  from: (table: string) => unknown;
};

interface WalletAccountRow {
  id: string;
  user_id: string;
  default_payment_wallet?: ManagedVeniceWalletType | null;
}

interface TokenLotRow {
  id: string;
  user_id: string;
  status: string;
  remaining_value_micro_usd: number;
  remaining_token_amount_raw: string | number | bigint;
  created_at?: string | null;
}

interface CardLedgerRow {
  id?: string;
  user_id?: string;
  amount_micro_usd?: number | null;
  source?: string | null;
  reason?: string | null;
  reference_id?: string | null;
}

interface ReservationRow {
  id: string;
  user_id: string;
  wallet_type: ManagedVeniceWalletType;
  status: string;
  reference_id: string;
  reserved_micro_usd: number;
  captured_micro_usd?: number | null;
}

export class ManagedVeniceInsufficientBalanceError extends Error {
  constructor(message = "Insufficient managed Venice wallet balance") {
    super(message);
    this.name = "ManagedVeniceInsufficientBalanceError";
  }
}

// The DB-level balance-guard triggers (migration
// 20260606140000_managed_venice_reservation_balance_guard) raise this marker
// when a concurrent insert would overdraft. Map it back to the typed error so a
// race-loss surfaces identically to the application-level pre-check.
function isInsufficientBalanceDbError(error: QueryError): boolean {
  return Boolean(error?.message?.includes("managed_venice_insufficient_balance"));
}

function table(db: SupabaseLike, name: string): DbTable {
  return db.from(name) as DbTable;
}

function requireUserId(userId: string) {
  if (!userId.trim()) {
    throw new Error("Managed Venice wallet user ID is required");
  }
}

function requirePositiveMicroUsd(value: number, label: string) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer microdollar amount`);
  }
}

function requireNonNegativeMicroUsd(value: number, label: string) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer microdollar amount`);
  }
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asBigInt(value: string | number | bigint | null | undefined): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  return BigInt(value || "0");
}

async function selectUserRows<T>(
  db: SupabaseLike,
  tableName: string,
  userId: string,
  opts?: { status?: string }
): Promise<T[]> {
  // Push a status filter into the query when the caller only needs one status.
  // This table grows ~1 row per inference and is never pruned, so an
  // all-status `.eq(user_id)` read is O(lifetime-requests) on the hottest
  // (authorize/settle) path. Filtering to status='active' engages the existing
  // (user_id, status) partial indexes and reads ~the active rows only.
  let query = table(db, tableName).select("*").eq("user_id", userId);
  if (opts?.status) {
    query = query.eq("status", opts.status);
  }
  const { data, error } = await query;

  if (error) {
    throw new Error(error.message || `Failed to load ${tableName}`);
  }

  return Array.isArray(data) ? (data as T[]) : [];
}

async function loadCardLedgerEntry(
  db: SupabaseLike,
  params: { userId: string; source: string; reason: string; referenceId: string }
): Promise<CardLedgerRow | null> {
  const { data, error } = await table(db, "managed_venice_card_ledger_entries")
    .select("*")
    .eq("user_id", params.userId)
    .eq("source", params.source)
    .eq("reason", params.reason)
    .eq("reference_id", params.referenceId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message || "Failed to load managed Venice card ledger entry");
  }

  return (data as CardLedgerRow | null) ?? null;
}

export async function loadManagedVeniceReservation(
  userId: string,
  referenceId: string,
  db: SupabaseLike | null | undefined = supabaseAdmin
): Promise<ReservationRow | null> {
  return loadReservation(requireDb(db), userId, referenceId);
}

async function loadReservation(
  db: SupabaseLike,
  userId: string,
  referenceId: string
): Promise<ReservationRow | null> {
  const { data, error } = await table(db, "managed_venice_reservations")
    .select("*")
    .eq("user_id", userId)
    .eq("reference_id", referenceId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message || "Failed to load managed Venice reservation");
  }

  return (data as ReservationRow | null) ?? null;
}

export async function ensureManagedVeniceWalletAccount(
  userId: string,
  db: SupabaseLike | null | undefined = supabaseAdmin
) {
  requireUserId(userId);
  const client = requireDb(db);
  const now = new Date().toISOString();
  const { data, error } = await table(client, "managed_venice_wallet_accounts")
    .upsert(
      { user_id: userId, updated_at: now },
      { onConflict: "user_id" }
    )
    .select("id, user_id, default_payment_wallet")
    .single();

  if (error || !data) {
    throw new Error(error?.message || "Failed to ensure managed Venice wallet account");
  }

  const row = data as WalletAccountRow;
  return {
    id: row.id,
    userId: row.user_id,
    defaultPaymentWallet: row.default_payment_wallet || "hermesos",
  };
}

export async function getManagedVeniceWalletSummary(
  userId: string,
  db: SupabaseLike | null | undefined = supabaseAdmin
) {
  requireUserId(userId);
  const client = requireDb(db);
  await ensureManagedVeniceWalletAccount(userId, client);

  const [lots, cardEntries, reservations] = await Promise.all([
    // Only active lots/reservations feed the balance math below; the card
    // ledger is a running sum so it must NOT be status-filtered.
    selectUserRows<TokenLotRow>(client, "managed_venice_token_lots", userId, { status: "active" }),
    selectUserRows<CardLedgerRow>(client, "managed_venice_card_ledger_entries", userId),
    selectUserRows<ReservationRow>(client, "managed_venice_reservations", userId, { status: "active" }),
  ]);

  const activeLots = lots.filter((lot) => lot.status === "active");
  const hermesosTotal = activeLots.reduce(
    (sum, lot) => sum + asNumber(lot.remaining_value_micro_usd),
    0
  );
  const hermesosTokenRaw = activeLots.reduce(
    (sum, lot) => sum + asBigInt(lot.remaining_token_amount_raw),
    0n
  );
  const cardTotal = cardEntries.reduce(
    (sum, entry) => sum + asNumber(entry.amount_micro_usd),
    0
  );

  const activeReservations = reservations.filter(
    (reservation) => reservation.status === "active"
  );
  const hermesosReserved = activeReservations
    .filter((reservation) => reservation.wallet_type === "hermesos")
    .reduce((sum, reservation) => sum + asNumber(reservation.reserved_micro_usd), 0);
  const cardReserved = activeReservations
    .filter((reservation) => reservation.wallet_type === "card")
    .reduce((sum, reservation) => sum + asNumber(reservation.reserved_micro_usd), 0);

  return {
    hermesos: {
      totalValueMicroUsd: hermesosTotal,
      reservedMicroUsd: hermesosReserved,
      availableMicroUsd: Math.max(0, hermesosTotal - hermesosReserved),
      remainingTokenAmountRaw: hermesosTokenRaw.toString(),
    },
    card: {
      totalValueMicroUsd: cardTotal,
      reservedMicroUsd: cardReserved,
      availableMicroUsd: Math.max(0, cardTotal - cardReserved),
    },
  };
}

export async function createManagedVeniceReservation(
  params: {
    userId: string;
    walletType: ManagedVeniceWalletType;
    amountMicroUsd: number;
    referenceId: string;
    estimatedCostMicroUsd?: number;
    discountRateBps?: number;
    discountMicroUsd?: number;
    model?: string | null;
    endpoint?: string | null;
    metadata?: Record<string, unknown>;
    expiresAt?: string | null;
  },
  db: SupabaseLike | null | undefined = supabaseAdmin
) {
  requireUserId(params.userId);
  requirePositiveMicroUsd(params.amountMicroUsd, "reservation amount");
  if (!params.referenceId.trim()) {
    throw new Error("Managed Venice reservation reference ID is required");
  }

  const client = requireDb(db);
  const existing = await loadReservation(client, params.userId, params.referenceId);
  if (existing) {
    return {
      id: existing.id,
      status: existing.status,
      reservedMicroUsd: existing.reserved_micro_usd,
    };
  }

  const summary = await getManagedVeniceWalletSummary(params.userId, client);
  const available =
    params.walletType === "hermesos"
      ? summary.hermesos.availableMicroUsd
      : summary.card.availableMicroUsd;

  if (available < params.amountMicroUsd) {
    throw new ManagedVeniceInsufficientBalanceError();
  }

  const account = await ensureManagedVeniceWalletAccount(params.userId, client);
  const { data, error } = await table(client, "managed_venice_reservations")
    .upsert(
      {
        account_id: account.id,
        user_id: params.userId,
        wallet_type: params.walletType,
        status: "active",
        reference_id: params.referenceId,
        estimated_cost_micro_usd: params.estimatedCostMicroUsd ?? params.amountMicroUsd,
        reserved_micro_usd: params.amountMicroUsd,
        discount_rate_bps: params.discountRateBps ?? 0,
        discount_micro_usd: params.discountMicroUsd ?? 0,
        model: params.model ?? null,
        endpoint: params.endpoint ?? "/api/v1/chat/completions",
        expires_at: params.expiresAt || null,
        metadata: params.metadata || {},
        updated_at: new Date().toISOString(),
      },
      { onConflict: "reference_id" }
    )
    .select("id, status, reserved_micro_usd")
    .single();

  if (error || !data) {
    if (isInsufficientBalanceDbError(error)) {
      throw new ManagedVeniceInsufficientBalanceError();
    }
    throw new Error(error?.message || "Failed to create managed Venice reservation");
  }

  const row = data as ReservationRow;
  return {
    id: row.id,
    status: row.status,
    reservedMicroUsd: row.reserved_micro_usd,
  };
}

export async function releaseManagedVeniceReservation(
  params: { userId: string; referenceId: string },
  db: SupabaseLike | null | undefined = supabaseAdmin
) {
  requireUserId(params.userId);
  const client = requireDb(db);
  const reservation = await loadReservation(client, params.userId, params.referenceId);
  if (!reservation || reservation.status !== "active") {
    return { released: false };
  }

  const captured = asNumber(reservation.captured_micro_usd);
  const released = Math.max(0, reservation.reserved_micro_usd - captured);
  const { error } = await table(client, "managed_venice_reservations")
    .update({
      status: "released",
      released_micro_usd: released,
      released_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", reservation.id);

  if (error) {
    throw new Error(error.message || "Failed to release managed Venice reservation");
  }

  return { released: true, releasedMicroUsd: released };
}

async function debitHermesosLots(
  userId: string,
  amountMicroUsd: number,
  db: SupabaseLike
) {
  let remainingDebit = amountMicroUsd;
  const lots = (await selectUserRows<TokenLotRow>(
    db,
    "managed_venice_token_lots",
    userId,
    { status: "active" }
  ))
    .filter((lot) => lot.status === "active" && lot.remaining_value_micro_usd > 0)
    .sort((left, right) => {
      const byCreatedAt = String(left.created_at || "").localeCompare(
        String(right.created_at || "")
      );
      return byCreatedAt || left.id.localeCompare(right.id);
    });

  const total = lots.reduce((sum, lot) => sum + lot.remaining_value_micro_usd, 0);
  if (total < amountMicroUsd) {
    throw new ManagedVeniceInsufficientBalanceError();
  }

  for (const lot of lots) {
    if (remainingDebit <= 0) break;

    const previousValue = lot.remaining_value_micro_usd;
    const consumed = Math.min(previousValue, remainingDebit);
    const nextValue = previousValue - consumed;
    const previousTokenRaw = asBigInt(lot.remaining_token_amount_raw);
    const nextTokenRaw =
      nextValue === 0
        ? 0n
        : (previousTokenRaw * BigInt(nextValue)) / BigInt(previousValue);

    const { error } = await table(db, "managed_venice_token_lots")
      .update({
        remaining_value_micro_usd: nextValue,
        remaining_token_amount_raw: nextTokenRaw.toString(),
        status: nextValue === 0 ? "depleted" : "active",
        updated_at: new Date().toISOString(),
      })
      .eq("id", lot.id);

    if (error) {
      throw new Error(error.message || "Failed to debit managed Venice token lot");
    }

    remainingDebit -= consumed;
  }
}

async function debitCardWallet(
  params: {
    userId: string;
    amountMicroUsd: number;
    referenceId: string;
    // A capture spends funds its OWN active reservation is holding, so that
    // hold must not count against it. Without this, a card user whose hold
    // covered most of the balance could never be charged: the capture saw
    // "available = total - (every hold, including this one)" and threw.
    capturingReservedMicroUsd?: number;
  },
  db: SupabaseLike
) {
  const summary = await getManagedVeniceWalletSummary(params.userId, db);
  const otherHoldsMicroUsd = Math.max(
    0,
    summary.card.reservedMicroUsd - (params.capturingReservedMicroUsd ?? 0)
  );
  if (summary.card.totalValueMicroUsd - otherHoldsMicroUsd < params.amountMicroUsd) {
    throw new ManagedVeniceInsufficientBalanceError();
  }

  const account = await ensureManagedVeniceWalletAccount(params.userId, db);
  const { error } = await table(db, "managed_venice_card_ledger_entries").insert({
    account_id: account.id,
    user_id: params.userId,
    amount_micro_usd: -params.amountMicroUsd,
    source: "system",
    actor: "managed_venice_proxy",
    reason: "managed_venice_debit",
    reference_id: params.referenceId,
    metadata: {},
  });

  if (error) {
    if (isInsufficientBalanceDbError(error)) {
      throw new ManagedVeniceInsufficientBalanceError();
    }
    throw new Error(error.message || "Failed to debit managed Venice card wallet");
  }
}

export async function debitManagedVeniceWallet(
  params: {
    userId: string;
    walletType: ManagedVeniceWalletType;
    amountMicroUsd: number;
    referenceId: string;
  },
  db: SupabaseLike | null | undefined = supabaseAdmin
) {
  requireUserId(params.userId);
  requirePositiveMicroUsd(params.amountMicroUsd, "debit amount");
  return debitWallet(params, requireDb(db));
}

async function debitWallet(
  params: {
    userId: string;
    walletType: ManagedVeniceWalletType;
    amountMicroUsd: number;
    referenceId: string;
    capturingReservedMicroUsd?: number;
  },
  client: SupabaseLike
) {
  requireUserId(params.userId);
  requirePositiveMicroUsd(params.amountMicroUsd, "debit amount");

  if (params.walletType === "hermesos") {
    await debitHermesosLots(params.userId, params.amountMicroUsd, client);
  } else {
    await debitCardWallet(params, client);
  }

  return getManagedVeniceWalletSummary(params.userId, client);
}

export async function grantManagedVeniceCardTopUpCredit(
  params: {
    userId: string;
    amountMicroUsd: number;
    sessionId: string;
    amountTotalCents?: number | null;
    metadata?: Record<string, unknown>;
  },
  db: SupabaseLike | null | undefined = supabaseAdmin
) {
  requireUserId(params.userId);
  requirePositiveMicroUsd(params.amountMicroUsd, "managed Venice card top-up amount");
  if (!params.sessionId.trim()) {
    throw new Error("Managed Venice card top-up session ID is required");
  }

  const client = requireDb(db);
  const account = await ensureManagedVeniceWalletAccount(params.userId, client);
  const existing = await loadCardLedgerEntry(client, {
    userId: params.userId,
    source: "stripe",
    reason: "stripe_topup",
    referenceId: params.sessionId,
  });

  if (!existing) {
    const { error } = await table(client, "managed_venice_card_ledger_entries").insert({
      account_id: account.id,
      user_id: params.userId,
      amount_micro_usd: params.amountMicroUsd,
      source: "stripe",
      actor: "stripe_webhook",
      reason: "stripe_topup",
      reference_id: params.sessionId,
      metadata: {
        amountTotalCents: params.amountTotalCents ?? null,
        ...(params.metadata || {}),
      },
    });

    if (error) {
      throw new Error(error.message || "Failed to credit managed Venice card wallet");
    }
  }

  await appendManagedVeniceFinancialEvent(
    {
      userId: params.userId,
      accountId: account.id,
      walletType: "card",
      eventType: "card_topup",
      referenceId: params.sessionId,
      idempotencyKey: `managed_venice_card_topup:${params.sessionId}`,
      amountMicroUsd: params.amountMicroUsd,
      metadata: {
        amountTotalCents: params.amountTotalCents ?? null,
        ...(params.metadata || {}),
      },
    },
    client
  );

  return getManagedVeniceWalletSummary(params.userId, client);
}

// Credit a user back for an overcharge surfaced by the daily reconciliation
// cron. The USD refund itself is always paid into the CARD ledger — refunds are
// stable USD amounts and the lots-based hermesos wallet can't take an arbitrary
// mid-stream USD credit without a token price + quote we don't have at refund
// time (inventing one would corrupt the lot ledger). The card credit is
// spendable from either wallet on future managed Venice usage, so the user is
// made whole regardless.
//
// What DID need fixing (F177): the financial-event row hardcoded
// walletType:'card', so a token-funded user's refund was attributed to the
// wrong wallet in the financial ledger — it looked like they paid from card
// when they paid from hermesos. We now thread the ORIGINAL walletType through
// and stamp the financial event + ledger metadata with it, so the ledger
// correctly reflects which wallet the user paid from while the refund still
// lands as a card credit. `creditedWallet` in metadata makes the card-credit
// settlement explicit for audit.
//
// Idempotent on (user_id, source="reconciliation", reason="overcharge_refund",
// reference_id) so re-running the reconciliation cron doesn't double-refund.
// The financial-event row is also gated on its idempotency key.
export async function refundManagedVeniceOvercharge(
  params: {
    userId: string;
    amountMicroUsd: number;
    referenceId: string;
    // The wallet the user ORIGINALLY paid from. Defaults to "card" to preserve
    // the historical attribution for callers that don't yet supply it.
    walletType?: ManagedVeniceWalletType;
    metadata?: Record<string, unknown>;
  },
  db: SupabaseLike | null | undefined = supabaseAdmin
) {
  requireUserId(params.userId);
  requirePositiveMicroUsd(params.amountMicroUsd, "reconciliation refund amount");
  if (!params.referenceId.trim()) {
    throw new Error("Managed Venice reconciliation refund reference ID is required");
  }

  const originalWalletType: ManagedVeniceWalletType = params.walletType ?? "card";
  const client = requireDb(db);
  const account = await ensureManagedVeniceWalletAccount(params.userId, client);

  const refundMetadata = {
    ...(params.metadata || {}),
    originalWalletType,
    creditedWallet: "card" as const,
  };

  const existingLedger = await loadCardLedgerEntry(client, {
    userId: params.userId,
    source: "reconciliation",
    reason: "overcharge_refund",
    referenceId: params.referenceId,
  });

  if (!existingLedger) {
    const { error } = await table(client, "managed_venice_card_ledger_entries").insert({
      account_id: account.id,
      user_id: params.userId,
      amount_micro_usd: params.amountMicroUsd,
      source: "reconciliation",
      actor: "managed_venice_reconciliation_cron",
      reason: "overcharge_refund",
      reference_id: params.referenceId,
      metadata: refundMetadata,
    });
    if (error) {
      throw new Error(
        error.message || "Failed to credit managed Venice card wallet for reconciliation refund",
      );
    }
  }

  const event = await appendManagedVeniceFinancialEvent(
    {
      userId: params.userId,
      accountId: account.id,
      // Attribute the refund to the wallet the user actually paid from.
      walletType: originalWalletType,
      eventType: "reconciliation_refund",
      referenceId: params.referenceId,
      idempotencyKey: `managed_venice_reconciliation_refund:${params.referenceId}`,
      amountMicroUsd: params.amountMicroUsd,
      metadata: refundMetadata,
    },
    client,
  );

  return { event, alreadyRefunded: Boolean(existingLedger) };
}

export async function captureManagedVeniceReservation(
  params: { userId: string; referenceId: string; captureMicroUsd: number },
  db: SupabaseLike | null | undefined = supabaseAdmin
) {
  requireUserId(params.userId);
  requireNonNegativeMicroUsd(params.captureMicroUsd, "capture amount");
  const client = requireDb(db);
  const reservation = await loadReservation(client, params.userId, params.referenceId);
  if (!reservation) {
    throw new Error("Managed Venice reservation not found");
  }
  if (reservation.status !== "active") {
    return {
      captured: false,
      capturedMicroUsd: asNumber(reservation.captured_micro_usd),
    };
  }
  if (params.captureMicroUsd > reservation.reserved_micro_usd) {
    throw new Error("Capture amount exceeds reservation");
  }

  if (params.captureMicroUsd > 0) {
    await debitWallet(
      {
        userId: params.userId,
        walletType: reservation.wallet_type,
        amountMicroUsd: params.captureMicroUsd,
        referenceId: params.referenceId,
        capturingReservedMicroUsd: asNumber(reservation.reserved_micro_usd),
      },
      client
    );
  }

  const released = Math.max(0, reservation.reserved_micro_usd - params.captureMicroUsd);
  const { error } = await table(client, "managed_venice_reservations")
    .update({
      status: "captured",
      captured_micro_usd: params.captureMicroUsd,
      released_micro_usd: released,
      captured_at: new Date().toISOString(),
      released_at: released > 0 ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", reservation.id);

  if (error) {
    throw new Error(error.message || "Failed to capture managed Venice reservation");
  }

  return {
    captured: true,
    capturedMicroUsd: params.captureMicroUsd,
    releasedMicroUsd: released,
  };
}
