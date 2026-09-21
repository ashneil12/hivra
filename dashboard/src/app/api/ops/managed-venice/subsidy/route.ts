import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import { supabaseAdmin } from "@/lib/supabase";

const ROUTE = "/api/ops/managed-venice/subsidy";
const SOURCE = "ops/managed-venice/subsidy";
const DEFAULT_WEEKLY_SUBSIDY_LIMIT_MICRO_USD = 1_000_000_000;
const PER_USER_WEEKLY_ALERT_MICRO_USD = 150_000_000;
const QUERY_LIMIT = 10_000;

type QueryError = { message?: string } | null;

type DbSelectChain = {
  select: (...args: unknown[]) => DbSelectChain;
  gte: (...args: unknown[]) => DbSelectChain;
  eq: (...args: unknown[]) => DbSelectChain;
  order: (...args: unknown[]) => DbSelectChain;
  limit: (count: number) => Promise<{ data: unknown; error: QueryError }>;
  maybeSingle: () => Promise<{ data: unknown; error: QueryError }>;
};

type SupabaseLike = {
  from: (table: string) => unknown;
};

type FinancialRow = {
  user_id?: unknown;
  wallet_type?: unknown;
  event_type?: unknown;
  reference_id?: unknown;
  amount_micro_usd?: unknown;
  venice_cost_micro_usd?: unknown;
  discount_micro_usd?: unknown;
  metadata?: unknown;
  created_at?: unknown;
};

type UsageRow = {
  user_id?: unknown;
  model?: unknown;
  endpoint?: unknown;
  wallet_type?: unknown;
  reference_id?: unknown;
  actual_cost_micro_usd?: unknown;
  charged_micro_usd?: unknown;
  discount_micro_usd?: unknown;
  status?: unknown;
  created_at?: unknown;
};

type ReconciliationRow = {
  user_id?: unknown;
  status?: unknown;
  reason?: unknown;
  metadata?: unknown;
  created_at?: unknown;
};

function table(db: SupabaseLike, name: string): DbSelectChain {
  return db.from(name) as DbSelectChain;
}

function rowRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function createdAtMs(value: unknown) {
  if (typeof value !== "string") return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isSince(row: { created_at?: unknown }, sinceIso: string) {
  return createdAtMs(row.created_at) >= Date.parse(sinceIso);
}

function startOfUtcDay(now: Date) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

async function selectSince(db: SupabaseLike, params: {
  tableName: string;
  columns: string;
  sinceIso: string;
}) {
  const { data, error } = await table(db, params.tableName)
    .select(params.columns)
    .gte("created_at", params.sinceIso)
    .order("created_at", { ascending: false })
    .limit(QUERY_LIMIT);

  if (error) {
    throw new Error(error.message || `Failed to load ${params.tableName}`);
  }

  return Array.isArray(data) ? data : [];
}

async function loadPlatformState(db: SupabaseLike) {
  const { data, error } = await table(db, "managed_venice_platform_state")
    .select("weekly_kill_switch_active, weekly_subsidy_used_micro_usd, weekly_subsidy_limit_micro_usd")
    .eq("id", "global")
    .maybeSingle();

  if (error) {
    throw new Error(error.message || "Failed to load managed Venice platform state");
  }

  const state = rowRecord(data);
  return {
    active: Boolean(state.weekly_kill_switch_active),
    weeklySubsidyUsedMicroUsd: numberValue(state.weekly_subsidy_used_micro_usd),
    thresholdMicroUsd: numberValue(
      state.weekly_subsidy_limit_micro_usd,
      DEFAULT_WEEKLY_SUBSIDY_LIMIT_MICRO_USD
    ),
  };
}

async function loadOpenReconciliationItems(db: SupabaseLike) {
  const { data, error } = await table(db, "managed_venice_reconciliation_items")
    .select("user_id, status, reason, metadata, created_at")
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(QUERY_LIMIT);

  if (error) {
    throw new Error(error.message || "Failed to load managed Venice reconciliation items");
  }

  return Array.isArray(data) ? data : [];
}

function isSubsidy(row: FinancialRow) {
  return row.event_type === "subsidy_applied";
}

function isTokenDeposit(row: FinancialRow) {
  return row.event_type === "token_deposit";
}

function isUsageCapture(row: FinancialRow) {
  return row.event_type === "usage_capture";
}

function sumFinancial(rows: FinancialRow[], selector: (row: FinancialRow) => number) {
  return rows.reduce((total, row) => total + selector(row), 0);
}

function buildTopSubsidyUsers(rows: FinancialRow[]) {
  const totals = new Map<string, number>();
  for (const row of rows) {
    if (!isSubsidy(row)) continue;
    const userId = stringValue(row.user_id);
    if (!userId) continue;
    totals.set(userId, (totals.get(userId) || 0) + numberValue(row.discount_micro_usd));
  }

  return Array.from(totals.entries())
    .map(([userId, subsidyMicroUsd]) => ({ userId, subsidyMicroUsd }))
    .sort((a, b) => b.subsidyMicroUsd - a.subsidyMicroUsd)
    .slice(0, 10);
}

function buildModelSpend(rows: UsageRow[]) {
  const totals = new Map<string, {
    model: string;
    actualCostMicroUsd: number;
    chargedMicroUsd: number;
    discountMicroUsd: number;
    callCount: number;
  }>();

  for (const row of rows) {
    const model = stringValue(row.model, "unknown");
    const current = totals.get(model) || {
      model,
      actualCostMicroUsd: 0,
      chargedMicroUsd: 0,
      discountMicroUsd: 0,
      callCount: 0,
    };
    current.actualCostMicroUsd += numberValue(row.actual_cost_micro_usd);
    current.chargedMicroUsd += numberValue(row.charged_micro_usd);
    current.discountMicroUsd += numberValue(row.discount_micro_usd);
    current.callCount += 1;
    totals.set(model, current);
  }

  return Array.from(totals.values())
    .sort((a, b) => b.actualCostMicroUsd - a.actualCostMicroUsd);
}

function billableUsageRows(rows: UsageRow[]) {
  return rows.filter((row) => {
    const status = stringValue(row.status, "recorded");
    return status === "recorded";
  });
}

// Multi-modal (image/video/audio/embeddings/search) usage lands as
// status='reconciliation_required' with cost=0 (settled offline — see F176), so
// it never shows up in the cost-bearing 'recorded' aggregates. That made the
// entire multimodal stream INVISIBLE on this report — a media-only fleet looked
// like it had no usage at all. Surface it explicitly (counts only, no invented
// cost) so operators can see multimodal volume and how much usage is still
// awaiting settlement.
function buildMultimodalUsage(rows: UsageRow[]) {
  const reconciliationRequired = rows.filter(
    (row) => stringValue(row.status) === "reconciliation_required"
  );
  const byEndpoint = new Map<string, number>();
  const byModel = new Map<string, number>();
  for (const row of reconciliationRequired) {
    const endpoint = stringValue(row.endpoint, "unknown");
    const model = stringValue(row.model, "unknown");
    byEndpoint.set(endpoint, (byEndpoint.get(endpoint) || 0) + 1);
    byModel.set(model, (byModel.get(model) || 0) + 1);
  }
  return {
    awaitingSettlementCount: reconciliationRequired.length,
    byEndpoint: Array.from(byEndpoint.entries())
      .map(([endpoint, count]) => ({ endpoint, count }))
      .sort((a, b) => b.count - a.count),
    byModel: Array.from(byModel.entries())
      .map(([model, count]) => ({ model, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 25),
  };
}

function buildUsageReferenceMap(rows: UsageRow[]) {
  const totals = new Map<string, {
    referenceId: string;
    userId: string;
    model: string;
    walletType: string;
    actualCostMicroUsd: number;
    chargedMicroUsd: number;
    discountMicroUsd: number;
    count: number;
  }>();

  for (const row of rows) {
    const referenceId = stringValue(row.reference_id);
    if (!referenceId) continue;
    const current = totals.get(referenceId) || {
      referenceId,
      userId: stringValue(row.user_id),
      model: stringValue(row.model, "unknown"),
      walletType: stringValue(row.wallet_type),
      actualCostMicroUsd: 0,
      chargedMicroUsd: 0,
      discountMicroUsd: 0,
      count: 0,
    };
    current.actualCostMicroUsd += numberValue(row.actual_cost_micro_usd);
    current.chargedMicroUsd += numberValue(row.charged_micro_usd);
    current.discountMicroUsd += numberValue(row.discount_micro_usd);
    current.count += 1;
    totals.set(referenceId, current);
  }

  return totals;
}

function buildFinancialUsageReferenceMap(rows: FinancialRow[]) {
  const totals = new Map<string, {
    referenceId: string;
    userId: string;
    walletType: string;
    veniceCostMicroUsd: number;
    amountMicroUsd: number;
    discountMicroUsd: number;
    count: number;
  }>();

  for (const row of rows) {
    const referenceId = stringValue(row.reference_id);
    if (!referenceId) continue;
    const current = totals.get(referenceId) || {
      referenceId,
      userId: stringValue(row.user_id),
      walletType: stringValue(row.wallet_type),
      veniceCostMicroUsd: 0,
      amountMicroUsd: 0,
      discountMicroUsd: 0,
      count: 0,
    };
    current.veniceCostMicroUsd += numberValue(row.venice_cost_micro_usd);
    current.amountMicroUsd += numberValue(row.amount_micro_usd);
    current.discountMicroUsd += numberValue(row.discount_micro_usd);
    current.count += 1;
    totals.set(referenceId, current);
  }

  return totals;
}

function buildUsageLedgerReconciliation(params: {
  usageRows: UsageRow[];
  financialRows: FinancialRow[];
}) {
  const recordedUsageRows = billableUsageRows(params.usageRows);
  const usageCaptureRows = params.financialRows.filter(isUsageCapture);
  const usageByReference = buildUsageReferenceMap(recordedUsageRows);
  const financialByReference = buildFinancialUsageReferenceMap(usageCaptureRows);

  const usageActualCostMicroUsd = recordedUsageRows.reduce(
    (total, row) => total + numberValue(row.actual_cost_micro_usd),
    0
  );
  const usageChargedMicroUsd = recordedUsageRows.reduce(
    (total, row) => total + numberValue(row.charged_micro_usd),
    0
  );
  const usageDiscountMicroUsd = recordedUsageRows.reduce(
    (total, row) => total + numberValue(row.discount_micro_usd),
    0
  );
  const financialVeniceCostMicroUsd = usageCaptureRows.reduce(
    (total, row) => total + numberValue(row.venice_cost_micro_usd),
    0
  );
  const financialChargedMicroUsd = usageCaptureRows.reduce(
    (total, row) => total + numberValue(row.amount_micro_usd),
    0
  );
  const financialDiscountMicroUsd = usageCaptureRows.reduce(
    (total, row) => total + numberValue(row.discount_micro_usd),
    0
  );

  const allMissingFinancialEvents = Array.from(usageByReference.values())
    .filter((entry) => !financialByReference.has(entry.referenceId));
  const allMissingUsageEvents = Array.from(financialByReference.values())
    .filter((entry) => !usageByReference.has(entry.referenceId));
  const allMismatchedReferences = Array.from(usageByReference.values())
    .flatMap((usage) => {
      const financial = financialByReference.get(usage.referenceId);
      if (!financial) return [];
      const drift = {
        actualCostMicroUsd: usage.actualCostMicroUsd - financial.veniceCostMicroUsd,
        chargedMicroUsd: usage.chargedMicroUsd - financial.amountMicroUsd,
        discountMicroUsd: usage.discountMicroUsd - financial.discountMicroUsd,
      };
      if (
        drift.actualCostMicroUsd === 0 &&
        drift.chargedMicroUsd === 0 &&
        drift.discountMicroUsd === 0 &&
        usage.count === 1 &&
        financial.count === 1
      ) {
        return [];
      }
      return [{ referenceId: usage.referenceId, usage, financial, drift }];
    });
  const missingFinancialEvents = allMissingFinancialEvents.slice(0, 20);
  const missingUsageEvents = allMissingUsageEvents.slice(0, 20);
  const mismatchedReferences = allMismatchedReferences.slice(0, 20);

  const actualCostDriftMicroUsd =
    usageActualCostMicroUsd - financialVeniceCostMicroUsd;
  const chargedDriftMicroUsd = usageChargedMicroUsd - financialChargedMicroUsd;
  const discountDriftMicroUsd = usageDiscountMicroUsd - financialDiscountMicroUsd;

  return {
    usageEventCount: recordedUsageRows.length,
    financialUsageCaptureCount: usageCaptureRows.length,
    reconciliationRequiredUsageCount: params.usageRows.filter(
      (row) => stringValue(row.status) === "reconciliation_required"
    ).length,
    usageActualCostMicroUsd,
    financialVeniceCostMicroUsd,
    actualCostDriftMicroUsd,
    usageChargedMicroUsd,
    financialChargedMicroUsd,
    chargedDriftMicroUsd,
    usageDiscountMicroUsd,
    financialDiscountMicroUsd,
    discountDriftMicroUsd,
    missingFinancialEventCount: allMissingFinancialEvents.length,
    missingUsageEventCount: allMissingUsageEvents.length,
    mismatchedReferenceCount: allMismatchedReferences.length,
    missingFinancialEvents,
    missingUsageEvents,
    mismatchedReferences,
    ok:
      actualCostDriftMicroUsd === 0 &&
      chargedDriftMicroUsd === 0 &&
      discountDriftMicroUsd === 0 &&
      allMissingFinancialEvents.length === 0 &&
      allMissingUsageEvents.length === 0 &&
      allMismatchedReferences.length === 0,
  };
}

function summarizeOpenReconciliationItems(rows: ReconciliationRow[]) {
  return rows.slice(0, 20).map((row) => ({
    userId: stringValue(row.user_id),
    reason: stringValue(row.reason),
    createdAt: stringValue(row.created_at),
    metadata: rowRecord(row.metadata),
  }));
}

function killSwitchAlertLevel(params: {
  active: boolean;
  usedMicroUsd: number;
  thresholdMicroUsd: number;
}) {
  if (params.active) return "kill_switch_active";
  if (params.thresholdMicroUsd <= 0) return "unknown";
  const ratio = params.usedMicroUsd / params.thresholdMicroUsd;
  if (ratio >= 0.8) return "eighty_percent";
  if (ratio >= 0.5) return "fifty_percent";
  return "ok";
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error(
      "CRON_SECRET is not configured; refusing to run managed Venice subsidy report",
      new Error("CRON_SECRET missing"),
      {
        source: SOURCE,
        route: ROUTE,
        method: "GET",
        failureType: "managed_venice_subsidy_cron_secret_missing",
      }
    );
    return apiError("Cron secret is not configured", 500);
  }

  if (!verifyBearerHeader(req, cronSecret)) {
    return apiError("Unauthorized", 401);
  }

  if (!supabaseAdmin) {
    return apiError("Database not configured", 500);
  }

  try {
    const now = new Date();
    const dayStartIso = startOfUtcDay(now).toISOString();
    const weekStartIso = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const [financialRaw, usageRaw, openReconciliationRaw, platformState] = await Promise.all([
      selectSince(supabaseAdmin, {
        tableName: "managed_venice_financial_events",
        columns: [
          "user_id",
          "wallet_type",
          "event_type",
          "reference_id",
          "amount_micro_usd",
          "venice_cost_micro_usd",
          "discount_micro_usd",
          "metadata",
          "created_at",
        ].join(", "),
        sinceIso: weekStartIso,
      }),
      selectSince(supabaseAdmin, {
        tableName: "managed_venice_usage_events",
        columns: [
          "user_id",
          "model",
          "endpoint",
          "wallet_type",
          "reference_id",
          "actual_cost_micro_usd",
          "charged_micro_usd",
          "discount_micro_usd",
          "status",
          "created_at",
        ].join(", "),
        sinceIso: weekStartIso,
      }),
      loadOpenReconciliationItems(supabaseAdmin),
      loadPlatformState(supabaseAdmin),
    ]);

    const financialRows = financialRaw as FinancialRow[];
    const usageRows = usageRaw as UsageRow[];
    const openReconciliationRows = openReconciliationRaw as ReconciliationRow[];

    // The per-table QUERY_LIMIT has no pagination, so a high-volume week
    // silently truncates the report — under-counting subsidy burn and the
    // kill-switch "used" figure right when accuracy matters most. Detect the
    // truncation (a full page came back) and surface it instead of returning a
    // quietly-wrong report.
    const truncatedTables: string[] = [];
    if (financialRows.length >= QUERY_LIMIT) {
      truncatedTables.push("managed_venice_financial_events");
    }
    if (usageRows.length >= QUERY_LIMIT) {
      truncatedTables.push("managed_venice_usage_events");
    }
    if (openReconciliationRows.length >= QUERY_LIMIT) {
      truncatedTables.push("managed_venice_reconciliation_items");
    }
    if (truncatedTables.length > 0) {
      log.warn("managed Venice subsidy report truncated at QUERY_LIMIT", {
        source: SOURCE,
        route: ROUTE,
        method: "GET",
        failureType: "managed_venice_subsidy_report_truncated",
        queryLimit: QUERY_LIMIT,
        truncatedTables,
      });
      try {
        await reportOpsEvent({
          source: "ops.managed_venice_subsidy_truncated",
          severity: "warn",
          title: "Managed-Venice subsidy report truncated",
          message: `Subsidy report hit the ${QUERY_LIMIT}-row cap on ${truncatedTables.join(", ")}; figures under-count actual burn`,
          route: ROUTE,
          metadata: {
            query_limit: QUERY_LIMIT,
            truncated_tables: truncatedTables,
          },
        });
      } catch {
        // swallow — truncation is already logged + flagged in the response body.
      }
    }

    const dailyFinancialRows = financialRows.filter((row) => isSince(row, dayStartIso));
    const dailyUsageRows = usageRows.filter((row) => isSince(row, dayStartIso));
    const weeklySubsidyBurnMicroUsd = sumFinancial(
      financialRows.filter(isSubsidy),
      (row) => numberValue(row.discount_micro_usd)
    );
    const dailySubsidyBurnMicroUsd = sumFinancial(
      dailyFinancialRows.filter(isSubsidy),
      (row) => numberValue(row.discount_micro_usd)
    );
    const weeklyTokenInMicroUsd = sumFinancial(
      financialRows.filter(isTokenDeposit),
      (row) => numberValue(row.amount_micro_usd)
    );
    const dailyTokenInMicroUsd = sumFinancial(
      dailyFinancialRows.filter(isTokenDeposit),
      (row) => numberValue(row.amount_micro_usd)
    );
    const weeklyVeniceCostOutMicroUsd = usageRows.reduce(
      (total, row) => total + numberValue(row.actual_cost_micro_usd),
      0
    );
    const dailyVeniceCostOutMicroUsd = dailyUsageRows.reduce(
      (total, row) => total + numberValue(row.actual_cost_micro_usd),
      0
    );
    const weeklySubsidyUsedMicroUsd =
      platformState.weeklySubsidyUsedMicroUsd || weeklySubsidyBurnMicroUsd;
    const topSubsidyUsers = buildTopSubsidyUsers(financialRows);
    const usageLedger = buildUsageLedgerReconciliation({
      usageRows,
      financialRows,
    });

    if (!usageLedger.ok) {
      log.warn("managed Venice usage ledger drift detected", {
        source: SOURCE,
        route: ROUTE,
        method: "GET",
        failureType: "managed_venice_usage_ledger_drift_detected",
        actualCostDriftMicroUsd: usageLedger.actualCostDriftMicroUsd,
        chargedDriftMicroUsd: usageLedger.chargedDriftMicroUsd,
        discountDriftMicroUsd: usageLedger.discountDriftMicroUsd,
        missingFinancialEventCount: usageLedger.missingFinancialEventCount,
        missingUsageEventCount: usageLedger.missingUsageEventCount,
        mismatchedReferenceCount: usageLedger.mismatchedReferenceCount,
      });
      // Surface drift on the ops feed too — a financial reconciliation gap that
      // only emits a log.warn is invisible unless the operator polls this route.
      // Best-effort: never let the audit transport break the report response.
      try {
        await reportOpsEvent({
          source: "ops.managed_venice_ledger_drift",
          severity: "warn",
          title: "Managed-Venice usage/financial ledger drift",
          message:
            `Managed-Venice ledger drift: actualCost=${usageLedger.actualCostDriftMicroUsd}µ$, ` +
            `charged=${usageLedger.chargedDriftMicroUsd}µ$, discount=${usageLedger.discountDriftMicroUsd}µ$, ` +
            `missingFinancial=${usageLedger.missingFinancialEventCount}, missingUsage=${usageLedger.missingUsageEventCount}, ` +
            `mismatched=${usageLedger.mismatchedReferenceCount}`,
          route: ROUTE,
          metadata: {
            actual_cost_drift_micro_usd: usageLedger.actualCostDriftMicroUsd,
            charged_drift_micro_usd: usageLedger.chargedDriftMicroUsd,
            discount_drift_micro_usd: usageLedger.discountDriftMicroUsd,
            missing_financial_event_count: usageLedger.missingFinancialEventCount,
            missing_usage_event_count: usageLedger.missingUsageEventCount,
            mismatched_reference_count: usageLedger.mismatchedReferenceCount,
          },
        });
      } catch {
        // swallow — drift is already logged + present in the response body.
      }
    }

    return apiSuccess({
      generatedAt: now.toISOString(),
      window: {
        dayStart: dayStartIso,
        weekStart: weekStartIso,
      },
      truncation: {
        queryLimit: QUERY_LIMIT,
        truncated: truncatedTables.length > 0,
        truncatedTables,
      },
      dailySubsidyBurnMicroUsd,
      weeklySubsidyBurnMicroUsd,
      killSwitch: {
        active: platformState.active,
        weeklySubsidyUsedMicroUsd,
        thresholdMicroUsd: platformState.thresholdMicroUsd,
        alertLevel: killSwitchAlertLevel({
          active: platformState.active,
          usedMicroUsd: weeklySubsidyUsedMicroUsd,
          thresholdMicroUsd: platformState.thresholdMicroUsd,
        }),
      },
      volumeLoop: {
        dailyTokenInMicroUsd,
        weeklyTokenInMicroUsd,
        dailyVeniceCostOutMicroUsd,
        weeklyVeniceCostOutMicroUsd,
        dailyDiscountFundedMicroUsd: dailySubsidyBurnMicroUsd,
        weeklyDiscountFundedMicroUsd: weeklySubsidyBurnMicroUsd,
      },
      topSubsidyUsers,
      usersOverWeeklyAlert: topSubsidyUsers.filter(
        (entry) => entry.subsidyMicroUsd >= PER_USER_WEEKLY_ALERT_MICRO_USD
      ),
      modelSpend: buildModelSpend(usageRows),
      // Multimodal usage is cost=0 / reconciliation_required and therefore
      // absent from modelSpend; surface it so it's no longer invisible.
      multimodalUsage: buildMultimodalUsage(usageRows),
      reconciliation: {
        openItemCount: openReconciliationRows.length,
        openItems: summarizeOpenReconciliationItems(openReconciliationRows),
        usageLedger,
      },
    });
  } catch (error) {
    log.error("managed Venice subsidy report failed", error, {
      source: SOURCE,
      route: ROUTE,
      method: "GET",
      failureType: "managed_venice_subsidy_report_failed",
    });
    return apiError("Failed to load managed Venice subsidy report", 500, {
      failureType: "managed_venice_subsidy_report_failed",
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}
