import { requireDb } from "@/lib/billing/db-utils";
import { supabaseAdmin } from "@/lib/supabase";

type QueryError = { message?: string } | null;

type DbSelectFilter = {
  eq: (...args: unknown[]) => DbSelectFilter;
  order: (...args: unknown[]) => DbSelectFilter;
  limit: (count: number) => Promise<{ data: unknown; error: QueryError }>;
};

type DbTable = {
  select: (...args: unknown[]) => DbSelectFilter;
};

type SupabaseLike = {
  from: (table: string) => unknown;
};

interface CreditLedgerActivityEntry {
  id: string;
  amountCredits: number;
  source: string;
  actor: string;
  reason: string;
  referenceId: string;
  createdAt: string | null;
}

interface PaymentTransactionActivityEntry {
  id: string;
  provider: string;
  providerReferenceId: string;
  status: string;
  asset: string;
  amountMinor: number;
  packageCredits: number | null;
  createdAt: string | null;
}

interface ComputeUsageActivityEntry {
  id: string;
  instanceId: string | null;
  creditsDelta: number;
  usageKind: string;
  referenceId: string;
  usagePeriodStart: string | null;
  usagePeriodEnd: string | null;
  status: string;
  createdAt: string | null;
}

interface LlmUsageActivityEntry {
  id: string;
  instanceId: string | null;
  conversationId: string | null;
  provider: string;
  model: string;
  billingSource: string;
  creditsDelta: number;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  referenceId: string;
  status: string;
  createdAt: string | null;
}

interface ManagedVeniceUsageActivityEntry {
  id: string;
  walletType: string;
  endpoint: string;
  model: string;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  actualCostMicroUsd: number;
  chargedMicroUsd: number;
  discountMicroUsd: number;
  status: string;
  referenceId: string;
  createdAt: string | null;
}

interface ManagedVeniceFinancialActivityEntry {
  id: string;
  walletType: string | null;
  eventType: string;
  referenceId: string;
  amountMicroUsd: number;
  veniceCostMicroUsd: number;
  discountMicroUsd: number;
  createdAt: string | null;
}

export interface BillingActivity {
  creditLedgerEntries: CreditLedgerActivityEntry[];
  paymentTransactions: PaymentTransactionActivityEntry[];
  computeUsageEvents: ComputeUsageActivityEntry[];
  llmUsageEvents: LlmUsageActivityEntry[];
  managedVeniceUsageEvents: ManagedVeniceUsageActivityEntry[];
  managedVeniceFinancialEvents: ManagedVeniceFinancialActivityEntry[];
}

const DEFAULT_ACTIVITY_LIMIT = 10;
const MAX_ACTIVITY_LIMIT = 50;

function table(db: SupabaseLike, name: string): DbTable {
  return db.from(name) as DbTable;
}

function rowRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function nullableStringValue(value: unknown) {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nullableNumberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function normalizeBillingActivityLimit(value: string | number | null | undefined) {
  const parsed = typeof value === "number"
    ? value
    : Number.parseInt(value?.trim() || "", 10);

  if (!Number.isFinite(parsed)) {
    return DEFAULT_ACTIVITY_LIMIT;
  }

  return Math.max(1, Math.min(MAX_ACTIVITY_LIMIT, Math.floor(parsed)));
}

async function selectRecentUserRows(params: {
  db: SupabaseLike;
  table: string;
  columns: string;
  userId: string;
  limit: number;
}) {
  const { data, error } = await table(params.db, params.table)
    .select(params.columns)
    .eq("user_id", params.userId)
    .order("created_at", { ascending: false })
    .limit(params.limit);

  if (error) {
    throw new Error(error.message || `Failed to load ${params.table}`);
  }

  return Array.isArray(data) ? data : [];
}

export async function getBillingActivity(
  userId: string,
  options: { limit?: string | number | null } = {},
  db: SupabaseLike | null | undefined = supabaseAdmin
): Promise<BillingActivity> {
  if (!userId.trim()) {
    throw new Error("Billing activity user ID is required");
  }

  const client = requireDb(db);
  const limit = normalizeBillingActivityLimit(options.limit);

  const [
    ledgerRows,
    paymentRows,
    computeRows,
    llmRows,
    managedVeniceUsageRows,
    managedVeniceFinancialRows,
  ] = await Promise.all([
    selectRecentUserRows({
      db: client,
      table: "credit_ledger_entries",
      columns: "id, amount_credits, source, actor, reason, reference_id, created_at",
      userId,
      limit,
    }),
    selectRecentUserRows({
      db: client,
      table: "payment_transactions",
      columns: "id, provider, provider_reference_id, status, asset, amount_minor, package_credits, created_at",
      userId,
      limit,
    }),
    selectRecentUserRows({
      db: client,
      table: "compute_usage_events",
      columns: "id, instance_id, credits_delta, usage_kind, reference_id, usage_period_start, usage_period_end, status, created_at",
      userId,
      limit,
    }),
    selectRecentUserRows({
      db: client,
      table: "llm_usage_events",
      columns: [
        "id",
        "instance_id",
        "conversation_id",
        "provider",
        "model",
        "billing_source",
        "credits_delta",
        "prompt_tokens",
        "completion_tokens",
        "total_tokens",
        "reference_id",
        "status",
        "created_at",
      ].join(", "),
      userId,
      limit,
    }),
    selectRecentUserRows({
      db: client,
      table: "managed_venice_usage_events",
      columns: [
        "id",
        "wallet_type",
        "endpoint",
        "model",
        "prompt_tokens",
        "completion_tokens",
        "total_tokens",
        "actual_cost_micro_usd",
        "charged_micro_usd",
        "discount_micro_usd",
        "status",
        "reference_id",
        "created_at",
      ].join(", "),
      userId,
      limit,
    }),
    selectRecentUserRows({
      db: client,
      table: "managed_venice_financial_events",
      columns: [
        "id",
        "wallet_type",
        "event_type",
        "reference_id",
        "amount_micro_usd",
        "venice_cost_micro_usd",
        "discount_micro_usd",
        "created_at",
      ].join(", "),
      userId,
      limit,
    }),
  ]);

  return {
    creditLedgerEntries: ledgerRows.map((row) => {
      const record = rowRecord(row);
      return {
        id: stringValue(record.id),
        amountCredits: numberValue(record.amount_credits),
        source: stringValue(record.source),
        actor: stringValue(record.actor),
        reason: stringValue(record.reason),
        referenceId: stringValue(record.reference_id),
        createdAt: nullableStringValue(record.created_at),
      };
    }),
    paymentTransactions: paymentRows.map((row) => {
      const record = rowRecord(row);
      return {
        id: stringValue(record.id),
        provider: stringValue(record.provider),
        providerReferenceId: stringValue(record.provider_reference_id),
        status: stringValue(record.status),
        asset: stringValue(record.asset, "USD"),
        amountMinor: numberValue(record.amount_minor),
        packageCredits: nullableNumberValue(record.package_credits),
        createdAt: nullableStringValue(record.created_at),
      };
    }),
    computeUsageEvents: computeRows.map((row) => {
      const record = rowRecord(row);
      return {
        id: stringValue(record.id),
        instanceId: nullableStringValue(record.instance_id),
        creditsDelta: numberValue(record.credits_delta),
        usageKind: stringValue(record.usage_kind, "compute"),
        referenceId: stringValue(record.reference_id),
        usagePeriodStart: nullableStringValue(record.usage_period_start),
        usagePeriodEnd: nullableStringValue(record.usage_period_end),
        status: stringValue(record.status, "recorded"),
        createdAt: nullableStringValue(record.created_at),
      };
    }),
    llmUsageEvents: llmRows.map((row) => {
      const record = rowRecord(row);
      return {
        id: stringValue(record.id),
        instanceId: nullableStringValue(record.instance_id),
        conversationId: nullableStringValue(record.conversation_id),
        provider: stringValue(record.provider),
        model: stringValue(record.model),
        billingSource: stringValue(record.billing_source),
        creditsDelta: numberValue(record.credits_delta),
        promptTokens: nullableNumberValue(record.prompt_tokens),
        completionTokens: nullableNumberValue(record.completion_tokens),
        totalTokens: nullableNumberValue(record.total_tokens),
        referenceId: stringValue(record.reference_id),
        status: stringValue(record.status, "recorded"),
        createdAt: nullableStringValue(record.created_at),
      };
    }),
    managedVeniceUsageEvents: managedVeniceUsageRows.map((row) => {
      const record = rowRecord(row);
      return {
        id: stringValue(record.id),
        walletType: stringValue(record.wallet_type),
        endpoint: stringValue(record.endpoint),
        model: stringValue(record.model),
        promptTokens: nullableNumberValue(record.prompt_tokens),
        completionTokens: nullableNumberValue(record.completion_tokens),
        totalTokens: nullableNumberValue(record.total_tokens),
        actualCostMicroUsd: numberValue(record.actual_cost_micro_usd),
        chargedMicroUsd: numberValue(record.charged_micro_usd),
        discountMicroUsd: numberValue(record.discount_micro_usd),
        status: stringValue(record.status, "recorded"),
        referenceId: stringValue(record.reference_id),
        createdAt: nullableStringValue(record.created_at),
      };
    }),
    managedVeniceFinancialEvents: managedVeniceFinancialRows.map((row) => {
      const record = rowRecord(row);
      return {
        id: stringValue(record.id),
        walletType: nullableStringValue(record.wallet_type),
        eventType: stringValue(record.event_type),
        referenceId: stringValue(record.reference_id),
        amountMicroUsd: numberValue(record.amount_micro_usd),
        veniceCostMicroUsd: numberValue(record.venice_cost_micro_usd),
        discountMicroUsd: numberValue(record.discount_micro_usd),
        createdAt: nullableStringValue(record.created_at),
      };
    }),
  };
}
