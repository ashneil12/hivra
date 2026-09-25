import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { refundManagedVeniceOvercharge } from "@/lib/billing/managed-venice-wallets";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import { supabaseAdmin } from "@/lib/supabase";
import { calculateActualChatCost } from "@/lib/venice/cost-estimator";
import { getVenicePricingMap } from "@/lib/venice/live-pricing";
import { isManagedVeniceEstimatedCapture } from "@/lib/venice/hold-lifecycle";
import {
  pruneTerminalManagedVeniceReservations,
  type ReservationPruneSummary,
} from "@/lib/venice/reservation-sweep";

const ROUTE = "/api/cron/managed-venice-reconciliation";
const SOURCE = "managed-venice-reconciliation";

// Re-cost each settled chat in the lookback window against the current
// live Venice pricing map, refund any overcharges to the user's card
// wallet, and surface any undercharges (which we eat, not re-bill) plus
// any model-level pricing bugs in an ops alert when the aggregate breaks
// the threshold.
const LOOKBACK_HOURS = 26; // ~1 day + 2hr overlap to forgive cron skew
const PER_RUN_USAGE_EVENT_CAP = 5_000;

// Alert thresholds (microdollars). Tunable here — kept generous on the
// undercharge side because that's our own P&L, not the user's, but tight on
// the overcharge side because that's money we owe back.
const OVERCHARGE_ALERT_THRESHOLD_MICRO_USD = 1_000_000; // $1.00
const UNDERCHARGE_ALERT_THRESHOLD_MICRO_USD = 5_000_000; // $5.00

// Per-chat rounding tolerance: anything ≤1 µ-USD is rounding noise from the
// catalog → live re-cost. Don't bother writing a financial event for that.
const NEGLIGIBLE_DELTA_MICRO_USD = 1;

export const dynamic = "force-dynamic";

interface UsageRow {
  id: string;
  user_id: string;
  model: string;
  wallet_type: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  actual_cost_micro_usd: number;
  charged_micro_usd: number;
  reference_id: string;
  created_at: string | null;
  metadata?: Record<string, unknown> | null;
}

interface ChatReconciliation {
  usageEventId: string;
  userId: string;
  model: string;
  referenceId: string;
  chargedMicroUsd: number;
  shouldChargeMicroUsd: number;
  deltaMicroUsd: number; // positive = we overcharged, negative = we undercharged
  outcome: "refunded" | "undercharge_absorbed" | "noop_within_tolerance" | "unpriceable_model" | "refund_failed";
  errorMessage?: string;
}

function readNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return value;
}

function readMetadata(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object") return value as Record<string, unknown>;
  return {};
}

// Endpoint label written by the chat-completions route. The reconciliation
// recosts events against the chat pricing map (prompt+completion tokens), so
// scope the scan to chat events only — multi-modal events (image/video/audio/
// embeddings/web search) are intentionally unmetered at write time and would
// otherwise show up as "unpriceable" noise here. Separate reconciliation
// path for multi-modal is a follow-up.
const CHAT_COMPLETIONS_ENDPOINT = "/api/v1/chat/completions";

async function fetchRecentUsageEvents(): Promise<{ rows: UsageRow[]; capHit: boolean }> {
  if (!supabaseAdmin) throw new Error("Supabase admin client not configured");
  const since = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1_000).toISOString();
  // Use the typed client's query builder directly (it returns a thenable) — no
  // hand-rolled `as unknown` cast over a money-moving query.
  const { data, error } = await supabaseAdmin
    .from("managed_venice_usage_events")
    .select(
      "id, user_id, model, wallet_type, prompt_tokens, completion_tokens, actual_cost_micro_usd, charged_micro_usd, reference_id, created_at, metadata",
    )
    .eq("endpoint", CHAT_COMPLETIONS_ENDPOINT)
    .gte("created_at", since)
    .order("created_at", { ascending: true })
    .limit(PER_RUN_USAGE_EVENT_CAP);

  if (error) {
    throw new Error(error.message || "Failed to read managed_venice_usage_events");
  }
  const rows = Array.isArray(data) ? (data as unknown as UsageRow[]) : [];
  // The cap is a deliberate safety bound, but silently dropping the surplus
  // means overcharges past row 5000 never get refunded with no signal. Flag it
  // so the caller can escalate (the cap being hit is itself an incident).
  return { rows, capHit: rows.length >= PER_RUN_USAGE_EVENT_CAP };
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error(
      "CRON_SECRET is not configured; refusing to run",
      new Error("CRON_SECRET missing"),
      {
        source: SOURCE,
        route: ROUTE,
        method: "GET",
        failureType: "cron_secret_missing",
      },
    );
    return apiError("Cron secret is not configured", 500);
  }
  if (!verifyBearerHeader(req, cronSecret)) {
    return apiError("Unauthorized", 401);
  }

  if (!supabaseAdmin) {
    return apiError("Database not configured", 500);
  }

  let usageEvents: UsageRow[];
  let usageEventCapHit: boolean;
  try {
    const fetched = await fetchRecentUsageEvents();
    usageEvents = fetched.rows;
    usageEventCapHit = fetched.capHit;
  } catch (error) {
    log.error("managed-venice-reconciliation failed to load usage events", error as Error, {
      source: SOURCE,
      route: ROUTE,
      failureType: "usage_events_query_failed",
    });
    return apiError("Failed to load managed Venice usage events", 500);
  }

  const livePricing = await getVenicePricingMap();
  const reconciliations: ChatReconciliation[] = [];
  let totalOverchargeMicroUsd = 0;
  let totalUnderchargeMicroUsd = 0;
  let unpriceableCount = 0;
  let refundedCount = 0;
  let refundFailedCount = 0;
  let sweepEstimateRowsSkipped = 0;
  const driftedModels = new Map<string, { overcharge: number; undercharge: number; count: number }>();

  for (const row of usageEvents) {
    // Venice never reported this chat's usage, so it was charged the output
    // the request observed, or the stale-hold sweep's estimate. There are no
    // token counts to re-cost, and re-costing zero tokens would refund the
    // whole charge.
    if (isManagedVeniceEstimatedCapture(row.metadata)) {
      sweepEstimateRowsSkipped += 1;
      continue;
    }
    const promptTokens = readNumber(row.prompt_tokens);
    const completionTokens = readNumber(row.completion_tokens);
    const meta = readMetadata(row.metadata);
    const cacheReadTokens = readNumber(meta.cacheReadTokens);
    const cacheWriteTokens = readNumber(meta.cacheWriteTokens);

    let recomputed: ReturnType<typeof calculateActualChatCost>;
    try {
      recomputed = calculateActualChatCost(
        {
          model: row.model,
          promptTokens,
          completionTokens,
          cacheReadTokens,
          cacheWriteTokens,
        },
        livePricing.map,
      );
    } catch (error) {
      unpriceableCount += 1;
      reconciliations.push({
        usageEventId: row.id,
        userId: row.user_id,
        model: row.model,
        referenceId: row.reference_id,
        chargedMicroUsd: row.charged_micro_usd,
        shouldChargeMicroUsd: 0,
        deltaMicroUsd: 0,
        outcome: "unpriceable_model",
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const shouldCharge = recomputed.actualCostMicroUsd;
    const charged = row.charged_micro_usd;
    const delta = charged - shouldCharge; // positive = overcharge

    if (Math.abs(delta) <= NEGLIGIBLE_DELTA_MICRO_USD) {
      reconciliations.push({
        usageEventId: row.id,
        userId: row.user_id,
        model: row.model,
        referenceId: row.reference_id,
        chargedMicroUsd: charged,
        shouldChargeMicroUsd: shouldCharge,
        deltaMicroUsd: delta,
        outcome: "noop_within_tolerance",
      });
      continue;
    }

    const modelDrift = driftedModels.get(row.model) || { overcharge: 0, undercharge: 0, count: 0 };
    modelDrift.count += 1;

    if (delta > 0) {
      // Overcharge — refund the user.
      totalOverchargeMicroUsd += delta;
      modelDrift.overcharge += delta;
      try {
        await refundManagedVeniceOvercharge({
          userId: row.user_id,
          amountMicroUsd: delta,
          // Attribute the refund to the wallet the user originally paid from
          // (F177) — fall back to "card" when the row predates wallet_type.
          walletType: row.wallet_type === "hermesos" ? "hermesos" : "card",
          referenceId: row.reference_id,
          metadata: {
            usageEventId: row.id,
            model: row.model,
            chargedMicroUsd: charged,
            shouldChargeMicroUsd: shouldCharge,
            walletType: row.wallet_type ?? "card",
            reason: "managed_venice_pricing_drift",
            settledAt: row.created_at,
          },
        });
        refundedCount += 1;
        reconciliations.push({
          usageEventId: row.id,
          userId: row.user_id,
          model: row.model,
          referenceId: row.reference_id,
          chargedMicroUsd: charged,
          shouldChargeMicroUsd: shouldCharge,
          deltaMicroUsd: delta,
          outcome: "refunded",
        });
      } catch (error) {
        refundFailedCount += 1;
        log.error(
          "managed-venice-reconciliation failed to refund overcharge",
          error as Error,
          {
            source: SOURCE,
            route: ROUTE,
            failureType: "reconciliation_refund_failed",
            usageEventId: row.id,
            userId: row.user_id,
            referenceId: row.reference_id,
            chargedMicroUsd: charged,
            shouldChargeMicroUsd: shouldCharge,
          },
        );
        reconciliations.push({
          usageEventId: row.id,
          userId: row.user_id,
          model: row.model,
          referenceId: row.reference_id,
          chargedMicroUsd: charged,
          shouldChargeMicroUsd: shouldCharge,
          deltaMicroUsd: delta,
          outcome: "refund_failed",
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
    } else {
      // Undercharge — we eat it, but log so the operator can fix the
      // root cause (usually a stale catalog entry or token-count bug).
      totalUnderchargeMicroUsd += -delta;
      modelDrift.undercharge += -delta;
      reconciliations.push({
        usageEventId: row.id,
        userId: row.user_id,
        model: row.model,
        referenceId: row.reference_id,
        chargedMicroUsd: charged,
        shouldChargeMicroUsd: shouldCharge,
        deltaMicroUsd: delta,
        outcome: "undercharge_absorbed",
      });
    }
    driftedModels.set(row.model, modelDrift);
  }

  const breachedOvercharge = totalOverchargeMicroUsd > OVERCHARGE_ALERT_THRESHOLD_MICRO_USD;
  const breachedUndercharge = totalUnderchargeMicroUsd > UNDERCHARGE_ALERT_THRESHOLD_MICRO_USD;
  const hadRefundFailures = refundFailedCount > 0;
  const hadUnpriceable = unpriceableCount > 0;

  if (breachedOvercharge || breachedUndercharge || hadRefundFailures || hadUnpriceable || usageEventCapHit) {
    const topDrifters = Array.from(driftedModels.entries())
      .sort((a, b) => b[1].overcharge + b[1].undercharge - (a[1].overcharge + a[1].undercharge))
      .slice(0, 10)
      .map(([modelId, totals]) => ({
        model: modelId,
        chats: totals.count,
        overchargeMicroUsd: totals.overcharge,
        underchargeMicroUsd: totals.undercharge,
      }));

    try {
      await reportOpsEvent({
        source: SOURCE,
        severity: breachedOvercharge || hadRefundFailures || usageEventCapHit ? "error" : "warn",
        title:
          `Managed Venice reconciliation drift: ` +
          `+$${(totalOverchargeMicroUsd / 1_000_000).toFixed(4)} overcharge / ` +
          `-$${(totalUnderchargeMicroUsd / 1_000_000).toFixed(4)} undercharge across ` +
          `${usageEvents.length} chat(s)`,
        message:
          `Refunded ${refundedCount} chat(s) on overcharge. Absorbed undercharges silently. ` +
          `${unpriceableCount} chat(s) had a model that wasn't in our live pricing map ` +
          `(was the model removed from Venice or has its id changed?). ` +
          `${refundFailedCount} refund(s) failed — see logs for the per-event errors. ` +
          `Top drifters: ${topDrifters
            .map(
              (d) =>
                `${d.model} (${d.chats}× chats, ` +
                `+$${(d.overchargeMicroUsd / 1_000_000).toFixed(4)} / ` +
                `-$${(d.underchargeMicroUsd / 1_000_000).toFixed(4)})`,
            )
            .join("; ")}. ` +
          `Action: resync pricing.ts from Venice's live /v1/models, investigate any ` +
          `models that consistently drift, and confirm refund_failed events were eventually settled.`,
        route: ROUTE,
        metadata: {
          failureType: usageEventCapHit
            ? "managed_venice_reconciliation_cap_hit"
            : "managed_venice_reconciliation_drift",
          recoveryAction: usageEventCapHit
            ? "raise_per_run_usage_event_cap_or_shorten_cron_interval"
            : "resync_venice_pricing_and_review_drift_report",
          lookbackHours: LOOKBACK_HOURS,
          usageEventsScanned: usageEvents.length,
          // True when the scan saturated PER_RUN_USAGE_EVENT_CAP: the surplus
          // events were NOT re-costed this run, so any overcharges past the cap
          // are unrefunded until the cap is raised or the window shrinks.
          usageEventCapHit,
          perRunUsageEventCap: PER_RUN_USAGE_EVENT_CAP,
          totalOverchargeMicroUsd,
          totalUnderchargeMicroUsd,
          refundedCount,
          refundFailedCount,
          unpriceableCount,
          pricingSource: livePricing.source,
          liveModelCount: livePricing.liveModelCount,
          topDrifters,
        },
      });
    } catch (error) {
      log.warn("managed-venice-reconciliation could not report ops event", {
        source: SOURCE,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Wallet holds the request path left active are settled hourly by
  // /api/cron/managed-venice-hold-sweep (lib/venice/reservation-sweep.ts), not
  // here: a daily run held a user's balance for up to two days.

  // Prune long-settled (released/captured) reservations so the table — and the
  // per-request balance reads that scan it — stay bounded. Own try/catch so a
  // prune failure can't break the sweep/reconciliation above.
  let reservationPrune: ReservationPruneSummary | { error: string };
  try {
    reservationPrune = await pruneTerminalManagedVeniceReservations();
    if (reservationPrune.pruned > 0) {
      log.info("managed-venice-reconciliation pruned terminal reservations", {
        source: SOURCE,
        route: ROUTE,
        pruned: reservationPrune.pruned,
      });
    }
  } catch (error) {
    reservationPrune = { error: error instanceof Error ? error.message : String(error) };
    log.error(
      "managed-venice-reconciliation reservation prune failed",
      error as Error,
      {
        source: SOURCE,
        route: ROUTE,
        failureType: "reservation_prune_failed",
      },
    );
  }

  return apiSuccess({
    reservationPrune,
    lookbackHours: LOOKBACK_HOURS,
    usageEventsScanned: usageEvents.length,
    usageEventCapHit,
    perRunUsageEventCap: PER_RUN_USAGE_EVENT_CAP,
    totalOverchargeMicroUsd,
    totalUnderchargeMicroUsd,
    refundedCount,
    refundFailedCount,
    unpriceableCount,
    sweepEstimateRowsSkipped,
    pricingSource: livePricing.source,
    liveModelCount: livePricing.liveModelCount,
    breachedAlertThreshold: breachedOvercharge || breachedUndercharge || hadRefundFailures || hadUnpriceable,
    // Trim per-chat detail in the response so the JSON stays small for ad-hoc
    // ops curls. The full per-chat report is reachable via the writeable
    // financial_events + ops alert metadata above.
    sampleReconciliations: reconciliations.slice(0, 25),
  });
}
