import { supabaseAdmin } from "@/lib/supabase";
import { metadataRecord, requireDb } from "@/lib/billing/db-utils";

export const CRYPTO_PAYMENT_SESSION_TIMEOUT_MS = 20 * 60 * 1000;

type CryptoPaymentSessionKind =
  | "crypto_topup"
  | "deposit_quote"
  | "yearly_token_quote"
  | "managed_venice_token_quote";

export interface ActiveCryptoPaymentSession {
  kind: CryptoPaymentSessionKind;
  table:
    | "payment_transactions"
    | "deposit_quotes"
    | "yearly_token_quotes"
    | "managed_venice_token_quotes";
  id: string;
  userId: string;
  label: string;
  referenceId: string | null;
  tier: string | null;
  asset: string | null;
  amountDisplay: string | null;
  tokenSymbol: string | null;
  createdAt: string | null;
  expiresAt: string | null;
}

export class ActiveCryptoPaymentSessionError extends Error {
  readonly session: ActiveCryptoPaymentSession;

  constructor(session: ActiveCryptoPaymentSession) {
    super(`A ${session.label} payment is already active. Finish or let it expire before starting another crypto payment.`);
    this.name = "ActiveCryptoPaymentSessionError";
    this.session = session;
  }
}

type QueryError = { message?: string } | null;

type DbFilter<T = Record<string, unknown>> = {
  eq: (column: string, value: unknown) => DbFilter<T>;
  lt: (column: string, value: unknown) => DbFilter<T>;
  order: (...args: unknown[]) => DbFilter<T>;
  limit: (...args: unknown[]) => DbFilter<T>;
  then: Promise<{ data: T[] | null; error: QueryError }>["then"];
};

type DbUpdateFilter = {
  eq: (column: string, value: unknown) => DbUpdateFilter;
  lt: (column: string, value: unknown) => DbUpdateFilter;
  then: Promise<{ data?: unknown; error: QueryError }>["then"];
};

type DbTable = {
  select: (...args: unknown[]) => DbFilter;
  update: (...args: unknown[]) => DbUpdateFilter;
};

type SupabaseLike = {
  from: (name: string) => unknown;
};

interface PaymentTransactionRow {
  id: string;
  user_id: string;
  provider: string;
  provider_reference_id: string;
  status: string;
  asset: string | null;
  amount_minor?: number | null;
  package_credits?: number | null;
  metadata: unknown;
  created_at: string | null;
  updated_at: string | null;
}

interface QuoteSessionRow {
  id: string;
  user_id: string;
  tier?: string | null;
  status: string;
  quoted_at: string | null;
  expires_at: string | null;
  tokens_required_display?: string | null;
  token_symbol?: string | null;
  token_amount_raw?: string | null;
  metadata: unknown;
}

function table(db: SupabaseLike, name: ActiveCryptoPaymentSession["table"]): DbTable {
  return db.from(name) as DbTable;
}


function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readDate(value: unknown): Date | null {
  const text = readString(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isFinite(date.getTime()) ? date : null;
}

function addMs(date: Date, ms: number) {
  return new Date(date.getTime() + ms);
}

function safeDbMessage(error: QueryError, fallback: string) {
  return error?.message?.trim() || fallback;
}

async function expireStaleQuoteSessions(params: {
  db: SupabaseLike;
  userId: string;
  now: Date;
  tableName: Exclude<ActiveCryptoPaymentSession["table"], "payment_transactions">;
}) {
  const result = await table(params.db, params.tableName)
    .update({
      status: "expired",
      updated_at: params.now.toISOString(),
    })
    .eq("user_id", params.userId)
    .eq("status", "active")
    .lt("expires_at", params.now.toISOString());

  if (result.error) {
    throw new Error(
      `Failed to expire stale ${params.tableName}: ${safeDbMessage(result.error, "unknown")}`
    );
  }
}

function paymentSessionExpiresAt(row: PaymentTransactionRow): Date {
  const metadata = metadataRecord(row.metadata);
  const explicitExpiry = readDate(metadata.sessionExpiresAt) || readDate(metadata.expiresAt);
  if (explicitExpiry) return explicitExpiry;

  const createdAt = readDate(metadata.createdAt) || readDate(row.created_at) || readDate(row.updated_at);
  return addMs(createdAt ?? new Date(0), CRYPTO_PAYMENT_SESSION_TIMEOUT_MS);
}

async function expirePendingPaymentTransaction(params: {
  db: SupabaseLike;
  row: PaymentTransactionRow;
  now: Date;
  expiresAt: Date;
}) {
  const metadata = {
    ...metadataRecord(params.row.metadata),
    creditGrantStatus: "expired",
    failureType: "crypto_payment_session_expired",
    expiredAt: params.now.toISOString(),
    sessionExpiresAt: params.expiresAt.toISOString(),
  };

  const result = await table(params.db, "payment_transactions")
    .update({
      status: "failed",
      metadata,
      updated_at: params.now.toISOString(),
    })
    .eq("provider", "bankr")
    .eq("provider_reference_id", params.row.provider_reference_id)
    .eq("status", "pending");

  if (result.error) {
    throw new Error(
      `Failed to expire stale crypto top-up session ${params.row.provider_reference_id}: ${safeDbMessage(result.error, "unknown")}`
    );
  }
}

function paymentSession(row: PaymentTransactionRow, expiresAt: Date): ActiveCryptoPaymentSession {
  const metadata = metadataRecord(row.metadata);
  return {
    kind: "crypto_topup",
    table: "payment_transactions",
    id: row.id,
    userId: row.user_id,
    label: "crypto top-up",
    referenceId: row.provider_reference_id || null,
    tier: null,
    asset: row.asset || null,
    amountDisplay: readString(metadata.amountDisplay),
    tokenSymbol: readString(metadata.tokenSymbol),
    createdAt: readString(metadata.createdAt) || row.created_at || null,
    expiresAt: expiresAt.toISOString(),
  };
}

function quoteSession(
  kind: Exclude<CryptoPaymentSessionKind, "crypto_topup">,
  tableName: Exclude<ActiveCryptoPaymentSession["table"], "payment_transactions">,
  row: QuoteSessionRow
): ActiveCryptoPaymentSession {
  const metadata = metadataRecord(row.metadata);
  return {
    kind,
    table: tableName,
    id: row.id,
    userId: row.user_id,
    label:
      kind === "deposit_quote"
        ? "token deposit quote"
        : kind === "yearly_token_quote"
          ? "yearly token payment"
          : "managed Venice token top-up",
    referenceId: row.id,
    tier: row.tier || null,
    asset: "hermesos_base",
    amountDisplay:
      row.tokens_required_display ||
      readString(metadata.amountDisplay) ||
      row.token_amount_raw ||
      null,
    tokenSymbol: row.token_symbol || "HERMESOS",
    createdAt: row.quoted_at,
    expiresAt: row.expires_at,
  };
}

async function findPendingPaymentSession(params: {
  db: SupabaseLike;
  userId: string;
  now: Date;
}): Promise<ActiveCryptoPaymentSession | null> {
  const result = await table(params.db, "payment_transactions")
    .select("id, user_id, provider, provider_reference_id, status, asset, amount_minor, package_credits, metadata, created_at, updated_at")
    .eq("user_id", params.userId)
    .eq("provider", "bankr")
    .eq("status", "pending")
    .order("created_at", { ascending: true });

  if (result.error) {
    throw new Error(`Failed to load pending crypto payments: ${safeDbMessage(result.error, "unknown")}`);
  }

  const rows = (result.data ?? []) as unknown as PaymentTransactionRow[];
  for (const row of rows) {
    const expiresAt = paymentSessionExpiresAt(row);
    if (expiresAt <= params.now) {
      await expirePendingPaymentTransaction({ db: params.db, row, now: params.now, expiresAt });
      continue;
    }
    return paymentSession(row, expiresAt);
  }

  return null;
}

async function findActiveQuoteSession(params: {
  db: SupabaseLike;
  userId: string;
  now: Date;
  tableName: "deposit_quotes" | "yearly_token_quotes";
  kind: Extract<CryptoPaymentSessionKind, "deposit_quote" | "yearly_token_quote">;
}) {
  await expireStaleQuoteSessions({
    db: params.db,
    userId: params.userId,
    now: params.now,
    tableName: params.tableName,
  });

  const result = await table(params.db, params.tableName)
    .select("id, user_id, tier, status, quoted_at, expires_at, tokens_required_display, metadata")
    .eq("user_id", params.userId)
    .eq("status", "active")
    .order("quoted_at", { ascending: true })
    .limit(1);

  if (result.error) {
    throw new Error(`Failed to load active ${params.tableName}: ${safeDbMessage(result.error, "unknown")}`);
  }

  const row = ((result.data ?? []) as unknown as QuoteSessionRow[])[0];
  return row ? quoteSession(params.kind, params.tableName, row) : null;
}

async function findActiveManagedVeniceQuoteSession(params: {
  db: SupabaseLike;
  userId: string;
  now: Date;
}) {
  await expireStaleQuoteSessions({
    db: params.db,
    userId: params.userId,
    now: params.now,
    tableName: "managed_venice_token_quotes",
  });

  const result = await table(params.db, "managed_venice_token_quotes")
    .select("id, user_id, status, quoted_at, expires_at, token_amount_raw::text, metadata")
    .eq("user_id", params.userId)
    .eq("status", "active")
    .order("quoted_at", { ascending: true })
    .limit(1);

  if (result.error) {
    throw new Error(`Failed to load active managed_venice_token_quotes: ${safeDbMessage(result.error, "unknown")}`);
  }

  const row = ((result.data ?? []) as unknown as QuoteSessionRow[])[0];
  return row ? quoteSession("managed_venice_token_quote", "managed_venice_token_quotes", row) : null;
}

async function findActiveCryptoPaymentSession(params: {
  userId: string;
  db?: SupabaseLike | null;
  now?: Date;
}): Promise<ActiveCryptoPaymentSession | null> {
  const userId = params.userId.trim();
  if (!userId) throw new Error("Crypto payment session user ID is required");

  const db = requireDb(params.db ?? supabaseAdmin);
  const now = params.now ?? new Date();

  return (
    (await findPendingPaymentSession({ db, userId, now })) ||
    (await findActiveQuoteSession({
      db,
      userId,
      now,
      tableName: "yearly_token_quotes",
      kind: "yearly_token_quote",
    })) ||
    (await findActiveManagedVeniceQuoteSession({
      db,
      userId,
      now,
    })) ||
    (await findActiveQuoteSession({
      db,
      userId,
      now,
      tableName: "deposit_quotes",
      kind: "deposit_quote",
    }))
  );
}

export async function assertNoActiveCryptoPaymentSession(params: {
  userId: string;
  db?: SupabaseLike | null;
  now?: Date;
}): Promise<null> {
  const active = await findActiveCryptoPaymentSession(params);
  if (active) throw new ActiveCryptoPaymentSessionError(active);
  return null;
}

export function activeCryptoPaymentSessionResponse(session: ActiveCryptoPaymentSession) {
  return {
    activePayment: {
      kind: session.kind,
      label: session.label,
      referenceId: session.referenceId,
      tier: session.tier,
      asset: session.asset,
      amountDisplay: session.amountDisplay,
      tokenSymbol: session.tokenSymbol,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
    },
  };
}
