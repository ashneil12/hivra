import { requireDb } from "@/lib/billing/db-utils";
import { supabaseAdmin } from "@/lib/supabase";
import { PLANS, type PlanKey } from "@/lib/subscription";

// SCRIPTURE_ANCHOR: credits-measure | Luke 6:38 | Verse: Give, and it will be given to you: good measure, pressed down, shaken together, and running over.
export const CREDIT_UNIT_LABEL = "100 credits = $1";
const TOP_UP_PACKAGES = [500, 1000, 2500, 5000] as const;

export type TopUpPackageCredits = (typeof TOP_UP_PACKAGES)[number];
export type CreditLedgerReason =
  | "stripe_topup"
  | "subscription_grant"
  | "admin_adjustment"
  | "refund"
  | "bonus_credit"
  | "compute_debit"
  | "llm_debit"
  | "crypto_topup"
  | "marketplace_purchase"
  | "marketplace_earn"
  | "transfer";
type CreditLedgerSource = "stripe" | "bankr" | "admin" | "system" | "apple";
type LlmBillingSource = "hermes_credits" | "bankr_llm_credits" | "byo_key";

type QueryError = { code?: string; message?: string } | null;

type SupabaseLike = {
  from: (table: string) => unknown;
};

// `.rpc` is present on the real supabase client but absent on lightweight test
// doubles. Accessed via a cast (rather than widening SupabaseLike) so the real
// SupabaseClient stays assignable to SupabaseLike.
type RpcCapableClient = {
  rpc?: (
    fn: string,
    args?: Record<string, unknown>
  ) => PromiseLike<{ data: unknown; error: QueryError }>;
};

type DbChain = {
  select: (...args: unknown[]) => DbChain;
  single: () => Promise<{ data: unknown; error: QueryError }>;
  eq: (...args: unknown[]) => DbChain;
  then: Promise<{ data?: unknown; error: QueryError }>["then"];
};

type DbUpdateFilter = {
  eq: (...args: unknown[]) => DbUpdateFilter;
  then: Promise<{ error: QueryError }>["then"];
};

type DbTable = {
  upsert: (...args: unknown[]) => DbChain | Promise<{ error: QueryError }>;
  update: (...args: unknown[]) => DbUpdateFilter;
  insert: (...args: unknown[]) => Promise<{ error: QueryError }>;
  select: (...args: unknown[]) => DbChain;
};

interface CreditAccount {
  id: string;
  user_id: string;
  stripe_customer_id?: string | null;
  balance_cached_credits?: number | null;
}

interface AppendLedgerEntryParams {
  userId: string;
  amountCredits: number;
  source: CreditLedgerSource;
  actor: string;
  reason: CreditLedgerReason;
  referenceId: string;
  metadata?: Record<string, unknown>;
}

interface SubscriptionGrantParams {
  userId: string;
  planKey: string;
  subscriptionId: string;
  periodStart: number | string | null | undefined;
  periodEnd: number | string | null | undefined;
  /**
   * Ledger provenance for the cycle grant. Defaults preserve the original
   * hardcoded Stripe behavior byte-for-byte; the Apple IAP lane passes
   * source "apple" / actor "apple_webhook" / referencePrefix
   * "apple_subscription" with subscriptionId = originalTransactionId, giving
   * the idempotency ref
   * `apple_subscription:${originalTransactionId}:${periodStart}:${periodEnd}`.
   */
  source?: CreditLedgerSource;
  actor?: string;
  referencePrefix?: string;
}

interface StripeTopUpGrantParams {
  userId: string;
  sessionId: string;
  packageCredits: number;
  amountTotalCents: number;
  idempotencyReference?: string | null;
  metadata?: Record<string, unknown>;
}

interface CreditReservationParams {
  userId: string;
  amountCredits: number;
  reason: string;
  referenceId: string;
  metadata?: Record<string, unknown>;
  expiresAt?: string | null;
}

interface ReleaseCreditReservationParams {
  userId: string;
  reason: string;
  referenceId: string;
}

interface ComputeUsageDebitParams {
  userId: string;
  amountCredits: number;
  referenceId: string;
  instanceId?: string | null;
  usageKind?: string;
  periodStart?: string | null;
  periodEnd?: string | null;
  actor?: string;
  metadata?: Record<string, unknown>;
}

interface LlmUsageEventParams {
  userId: string;
  referenceId: string;
  provider: string;
  model: string;
  billingSource: LlmBillingSource;
  amountCredits?: number;
  instanceId?: string | null;
  conversationId?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  actor?: string;
  metadata?: Record<string, unknown>;
}

function table(db: SupabaseLike, name: string): DbTable {
  return db.from(name) as DbTable;
}

function normalizePeriodPart(value: number | string | null | undefined): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  return "unknown";
}

function isUniqueConflict(error: QueryError): boolean {
  return error?.code === "23505";
}

function normalizeOptionalNonNegativeInteger(value: number | null | undefined, label: string) {
  if (value === null || value === undefined) {
    return null;
  }

  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }

  return value;
}

export function isTopUpPackageCredits(value: number): value is TopUpPackageCredits {
  return TOP_UP_PACKAGES.includes(value as TopUpPackageCredits);
}

export function creditsToUsd(credits: number): number {
  return credits / 100;
}

export function getPlanMonthlyCreditGrant(planKey: string | null | undefined): number {
  if (!planKey || !(planKey in PLANS)) {
    return 0;
  }

  const typedPlanKey = planKey as PlanKey;
  const bonusMultiplier: Record<PlanKey, number> = {
    free: 0,
    operator: 1.1,
    fleet: 1.2,
    command: 1.3,
  };

  return Math.round(PLANS[typedPlanKey].price * bonusMultiplier[typedPlanKey]);
}

async function ensureCreditAccount(
  userId: string,
  db: SupabaseLike | null | undefined = supabaseAdmin
): Promise<CreditAccount> {
  const client = requireDb(db);
  const now = new Date().toISOString();
  const query = table(client, "credit_accounts").upsert(
    { user_id: userId, updated_at: now },
    { onConflict: "user_id" }
  ) as DbChain;

  const { data, error } = await query
    .select("id, user_id, stripe_customer_id, balance_cached_credits")
    .single();

  if (error || !data) {
    throw new Error(error?.message || "Failed to ensure credit account");
  }

  return data as CreditAccount;
}

export async function setCreditAccountStripeCustomerId(
  userId: string,
  stripeCustomerId: string,
  db: SupabaseLike | null | undefined = supabaseAdmin
): Promise<void> {
  const client = requireDb(db);
  const account = await ensureCreditAccount(userId, client);
  const { error } = await table(client, "credit_accounts")
    .update({
      stripe_customer_id: stripeCustomerId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", account.id);

  if (error) {
    throw new Error(error.message || "Failed to update credit account customer");
  }
}

export async function getCreditAccountStripeCustomerId(
  userId: string,
  db: SupabaseLike | null | undefined = supabaseAdmin
): Promise<string | null> {
  const account = await ensureCreditAccount(userId, db);
  return account.stripe_customer_id?.trim() || null;
}

export async function deriveCreditBalance(
  userId: string,
  db: SupabaseLike | null | undefined = supabaseAdmin
): Promise<number> {
  const client = requireDb(db);
  const { data, error } = await table(client, "credit_ledger_entries")
    .select("amount_credits")
    .eq("user_id", userId);

  if (error) {
    throw new Error(error.message || "Failed to derive credit balance");
  }

  return ((data || []) as Array<{ amount_credits?: number | null }>).reduce(
    (sum, row) => sum + (row.amount_credits || 0),
    0
  );
}

/**
 * Cheap balance read for hot paths (dashboard polls, cron read-before-write).
 *
 * Returns the value from `credit_accounts.balance_cached_credits` — which is
 * maintained by `appendCreditLedgerEntry` after every ledger insert. If the
 * cached column is null (legacy rows that haven't been touched since the
 * cache was introduced, or a freshly-created account), falls back to a one-
 * shot derive + write so the next read is fast.
 *
 * Use this anywhere you only need to KNOW the current balance — not anywhere
 * you need to reason about ledger correctness. For ledger writes, keep
 * calling `appendCreditLedgerEntry`, which still derives-and-writes the cache
 * atomically with the insert (concurrency-safe under multiple writers).
 */
export async function getCachedCreditBalance(
  userId: string,
  db: SupabaseLike | null | undefined = supabaseAdmin
): Promise<number> {
  const client = requireDb(db);
  const account = await ensureCreditAccount(userId, client);
  if (
    account.balance_cached_credits !== null &&
    account.balance_cached_credits !== undefined
  ) {
    return account.balance_cached_credits;
  }
  // Backfill on first read.
  const fresh = await deriveCreditBalance(userId, client);
  const { error: updateError } = await table(client, "credit_accounts")
    .update({
      balance_cached_credits: fresh,
      updated_at: new Date().toISOString(),
    })
    .eq("id", account.id);
  if (updateError) {
    // Non-fatal — the next read will retry the backfill.
    return fresh;
  }
  return fresh;
}

export async function deriveReservedCreditBalance(
  userId: string,
  db: SupabaseLike | null | undefined = supabaseAdmin
): Promise<number> {
  const client = requireDb(db);
  const { data, error } = await table(client, "credit_reservations")
    .select("amount_credits")
    .eq("user_id", userId)
    .eq("status", "active");

  if (error) {
    throw new Error(error.message || "Failed to derive reserved credit balance");
  }

  return ((data || []) as Array<{ amount_credits?: number | null }>).reduce(
    (sum, row) => sum + (row.amount_credits || 0),
    0
  );
}

export async function appendCreditLedgerEntry(
  params: AppendLedgerEntryParams,
  db: SupabaseLike | null | undefined = supabaseAdmin
): Promise<{ inserted: boolean; balance: number }> {
  if (!params.userId.trim()) {
    throw new Error("Credit ledger user ID is required");
  }

  if (!params.actor.trim()) {
    throw new Error("Credit ledger actor is required");
  }

  if (!params.referenceId.trim()) {
    throw new Error("Credit ledger reference ID is required");
  }

  if (!Number.isInteger(params.amountCredits) || params.amountCredits === 0) {
    throw new Error("Credit ledger amount must be a non-zero integer");
  }

  const client = requireDb(db);
  const account = await ensureCreditAccount(params.userId, client);
  const { error } = await table(client, "credit_ledger_entries").insert({
    account_id: account.id,
    user_id: params.userId,
    amount_credits: params.amountCredits,
    source: params.source,
    actor: params.actor,
    reason: params.reason,
    reference_id: params.referenceId,
    metadata: params.metadata || {},
  });

  if (error && !isUniqueConflict(error)) {
    throw new Error(error.message || "Failed to append credit ledger entry");
  }

  // Prefer the atomic recompute RPC (single UPDATE … = (SELECT SUM(...))): two
  // concurrent appends each write a fresh, fully-committed sum, so neither
  // clobbers the other with a stale snapshot. Falls back to the (slightly racy)
  // derive-then-write path when the RPC is unavailable — e.g. before migration
  // 20260623130000_* is applied — so this is safe to deploy in any order.
  const rpcBalance = await refreshCachedBalanceViaRpc(client, account.id);
  if (rpcBalance !== null) {
    return { inserted: !error, balance: rpcBalance };
  }

  const balance = await deriveCreditBalance(params.userId, client);
  const { error: updateError } = await table(client, "credit_accounts")
    .update({
      balance_cached_credits: balance,
      updated_at: new Date().toISOString(),
    })
    .eq("id", account.id);

  if (updateError) {
    throw new Error(updateError.message || "Failed to update cached credit balance");
  }

  return { inserted: !error, balance };
}

/**
 * Atomically recompute + persist a credit account's cached balance via the
 * refresh_credit_account_cached_balance SQL function. Returns the new balance,
 * or null when the RPC is unavailable / errors (so the caller can fall back to
 * the derive-then-write path). Never throws.
 */
async function refreshCachedBalanceViaRpc(
  client: SupabaseLike,
  accountId: string
): Promise<number | null> {
  const rpc = (client as RpcCapableClient).rpc;
  if (typeof rpc !== "function") return null;
  try {
    const { data, error } = await rpc.call(
      client,
      "refresh_credit_account_cached_balance",
      { p_account_id: accountId }
    );
    if (error || typeof data !== "number") return null;
    return data;
  } catch {
    return null;
  }
}

export async function createCreditReservation(
  params: CreditReservationParams,
  db: SupabaseLike | null | undefined = supabaseAdmin
): Promise<{ id: string; amountCredits: number; status: string }> {
  if (!params.userId.trim()) {
    throw new Error("Credit reservation user ID is required");
  }

  if (!params.reason.trim()) {
    throw new Error("Credit reservation reason is required");
  }

  if (!params.referenceId.trim()) {
    throw new Error("Credit reservation reference ID is required");
  }

  if (!Number.isInteger(params.amountCredits) || params.amountCredits <= 0) {
    throw new Error("Credit reservation amount must be a positive integer");
  }

  const client = requireDb(db);
  const account = await ensureCreditAccount(params.userId, client);
  const now = new Date().toISOString();
  const query = table(client, "credit_reservations").upsert(
    {
      user_id: params.userId,
      account_id: account.id,
      amount_credits: params.amountCredits,
      status: "active",
      reason: params.reason,
      reference_id: params.referenceId,
      metadata: params.metadata || {},
      expires_at: params.expiresAt || null,
      updated_at: now,
    },
    { onConflict: "user_id,reason,reference_id" }
  ) as DbChain;

  const { data, error } = await query
    .select("id, amount_credits, status")
    .single();

  if (error || !data) {
    throw new Error(error?.message || "Failed to create credit reservation");
  }

  const row = data as { id: string; amount_credits: number; status: string };
  return {
    id: row.id,
    amountCredits: row.amount_credits,
    status: row.status,
  };
}

export async function releaseCreditReservation(
  params: ReleaseCreditReservationParams,
  db: SupabaseLike | null | undefined = supabaseAdmin
): Promise<void> {
  if (!params.userId.trim()) {
    throw new Error("Credit reservation user ID is required");
  }

  if (!params.reason.trim()) {
    throw new Error("Credit reservation reason is required");
  }

  if (!params.referenceId.trim()) {
    throw new Error("Credit reservation reference ID is required");
  }

  const client = requireDb(db);
  const { error } = await table(client, "credit_reservations")
    .update({
      status: "released",
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", params.userId)
    .eq("reason", params.reason)
    .eq("reference_id", params.referenceId)
    .eq("status", "active");

  if (error) {
    throw new Error(error.message || "Failed to release credit reservation");
  }
}

export async function recordComputeUsageDebit(
  params: ComputeUsageDebitParams,
  db: SupabaseLike | null | undefined = supabaseAdmin
): Promise<{ inserted: boolean; balance: number }> {
  if (!params.userId.trim()) {
    throw new Error("Compute usage user ID is required");
  }

  if (!params.referenceId.trim()) {
    throw new Error("Compute usage reference ID is required");
  }

  if (!Number.isInteger(params.amountCredits) || params.amountCredits <= 0) {
    throw new Error("Compute usage amount must be a positive integer");
  }

  const client = requireDb(db);
  const usageKind = params.usageKind?.trim() || "compute";
  const usageInsert = await table(client, "compute_usage_events").insert({
    user_id: params.userId,
    instance_id: params.instanceId || null,
    credits_delta: -params.amountCredits,
    usage_kind: usageKind,
    reference_id: params.referenceId,
    usage_period_start: params.periodStart || null,
    usage_period_end: params.periodEnd || null,
    status: "recorded",
    metadata: params.metadata || {},
  });

  if (usageInsert.error && !isUniqueConflict(usageInsert.error)) {
    throw new Error(usageInsert.error.message || "Failed to record compute usage event");
  }

  return appendCreditLedgerEntry(
    {
      userId: params.userId,
      amountCredits: -params.amountCredits,
      source: "system",
      actor: params.actor?.trim() || "billing_worker",
      reason: "compute_debit",
      referenceId: params.referenceId,
      metadata: {
        instanceId: params.instanceId || null,
        usageKind,
        periodStart: params.periodStart || null,
        periodEnd: params.periodEnd || null,
        ...params.metadata,
      },
    },
    client
  );
}

export async function recordLlmUsageEvent(
  params: LlmUsageEventParams,
  db: SupabaseLike | null | undefined = supabaseAdmin
): Promise<{ inserted: boolean; debited: boolean; balance: number | null }> {
  if (!params.userId.trim()) {
    throw new Error("LLM usage user ID is required");
  }

  if (!params.referenceId.trim()) {
    throw new Error("LLM usage reference ID is required");
  }

  if (!params.provider.trim()) {
    throw new Error("LLM usage provider is required");
  }

  if (!params.model.trim()) {
    throw new Error("LLM usage model is required");
  }

  const amountCredits = params.amountCredits ?? 0;
  if (params.billingSource === "hermes_credits") {
    if (!Number.isInteger(amountCredits) || amountCredits <= 0) {
      throw new Error("Hermes credit LLM usage amount must be a positive integer");
    }
  } else if (amountCredits !== 0) {
    throw new Error("Only Hermes credit LLM usage can create credit ledger debits");
  }

  const promptTokens = normalizeOptionalNonNegativeInteger(params.promptTokens, "LLM prompt tokens");
  const completionTokens = normalizeOptionalNonNegativeInteger(params.completionTokens, "LLM completion tokens");
  const totalTokens = normalizeOptionalNonNegativeInteger(
    params.totalTokens ?? ((promptTokens ?? 0) + (completionTokens ?? 0) || null),
    "LLM total tokens"
  );

  const client = requireDb(db);
  const usageInsert = await table(client, "llm_usage_events").insert({
    user_id: params.userId,
    instance_id: params.instanceId || null,
    conversation_id: params.conversationId || null,
    provider: params.provider.trim(),
    model: params.model.trim(),
    billing_source: params.billingSource,
    credits_delta: params.billingSource === "hermes_credits" ? -amountCredits : 0,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    reference_id: params.referenceId,
    usage_period_start: params.periodStart || null,
    usage_period_end: params.periodEnd || null,
    status: "recorded",
    metadata: params.metadata || {},
  });

  if (usageInsert.error && !isUniqueConflict(usageInsert.error)) {
    throw new Error(usageInsert.error.message || "Failed to record LLM usage event");
  }

  if (params.billingSource !== "hermes_credits") {
    return {
      inserted: !usageInsert.error,
      debited: false,
      balance: null,
    };
  }

  const ledgerResult = await appendCreditLedgerEntry(
    {
      userId: params.userId,
      amountCredits: -amountCredits,
      source: "system",
      actor: params.actor?.trim() || "llm_gateway",
      reason: "llm_debit",
      referenceId: params.referenceId,
      metadata: {
        instanceId: params.instanceId || null,
        conversationId: params.conversationId || null,
        provider: params.provider.trim(),
        model: params.model.trim(),
        billingSource: params.billingSource,
        promptTokens,
        completionTokens,
        totalTokens,
        periodStart: params.periodStart || null,
        periodEnd: params.periodEnd || null,
        ...params.metadata,
      },
    },
    client
  );

  return {
    inserted: !usageInsert.error,
    debited: ledgerResult.inserted,
    balance: ledgerResult.balance,
  };
}

export async function grantSubscriptionCycleCredits(
  params: SubscriptionGrantParams,
  db: SupabaseLike | null | undefined = supabaseAdmin
): Promise<{ inserted: boolean; balance: number }> {
  const amountCredits = getPlanMonthlyCreditGrant(params.planKey);
  if (amountCredits <= 0) {
    return { inserted: false, balance: await deriveCreditBalance(params.userId, db) };
  }

  const periodStart = normalizePeriodPart(params.periodStart);
  const periodEnd = normalizePeriodPart(params.periodEnd);
  const source = params.source ?? "stripe";
  const actor = params.actor ?? "stripe_webhook";
  const referencePrefix = params.referencePrefix ?? "stripe_subscription";

  return appendCreditLedgerEntry(
    {
      userId: params.userId,
      amountCredits,
      source,
      actor,
      reason: "subscription_grant",
      referenceId: `${referencePrefix}:${params.subscriptionId}:${periodStart}:${periodEnd}`,
      metadata: {
        plan: params.planKey,
        subscriptionId: params.subscriptionId,
        periodStart,
        periodEnd,
      },
    },
    db
  );
}

async function recordStripeTopUpTransaction(
  params: StripeTopUpGrantParams,
  db: SupabaseLike | null | undefined = supabaseAdmin
): Promise<void> {
  const client = requireDb(db);
  const result = await (table(client, "payment_transactions").upsert(
    {
      user_id: params.userId,
      provider: "stripe",
      provider_reference_id: params.sessionId,
      idempotency_reference: params.idempotencyReference || null,
      status: "succeeded",
      asset: "USD",
      amount_minor: params.amountTotalCents,
      package_credits: params.packageCredits,
      metadata: params.metadata || {},
      updated_at: new Date().toISOString(),
    },
    { onConflict: "provider,provider_reference_id" }
  ) as unknown as Promise<{ error: QueryError }>);

  if (result.error) {
    throw new Error(result.error.message || "Failed to record payment transaction");
  }
}

export async function grantStripeTopUpCredits(
  params: StripeTopUpGrantParams,
  db: SupabaseLike | null | undefined = supabaseAdmin
): Promise<{ inserted: boolean; balance: number }> {
  if (!isTopUpPackageCredits(params.packageCredits)) {
    throw new Error("Invalid credit top-up package");
  }

  await recordStripeTopUpTransaction(params, db);
  return appendCreditLedgerEntry(
    {
      userId: params.userId,
      amountCredits: params.packageCredits,
      source: "stripe",
      actor: "stripe_webhook",
      reason: "stripe_topup",
      referenceId: params.sessionId,
      metadata: {
        amountTotalCents: params.amountTotalCents,
        idempotencyReference: params.idempotencyReference || null,
        ...params.metadata,
      },
    },
    db
  );
}

export async function getCreditSummary(
  userId: string,
  planKey?: string | null,
  db: SupabaseLike | null | undefined = supabaseAdmin
): Promise<{ balance: number; monthlyGrant: number; unit: string }> {
  // Read the cached balance instead of summing the entire ledger on every
  // call. Dashboard polls this on a timer and the previous full-scan
  // implementation didn't scale. The cache is maintained synchronously
  // with each ledger write inside `appendCreditLedgerEntry`.
  return {
    balance: await getCachedCreditBalance(userId, db),
    monthlyGrant: getPlanMonthlyCreditGrant(planKey),
    unit: CREDIT_UNIT_LABEL,
  };
}
