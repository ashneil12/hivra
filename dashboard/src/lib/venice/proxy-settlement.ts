import {
  ManagedVeniceInsufficientBalanceError,
  type ManagedVeniceWalletType,
  captureManagedVeniceReservation,
  createManagedVeniceReservation,
  debitManagedVeniceWallet,
  ensureManagedVeniceWalletAccount,
  loadManagedVeniceReservation,
  releaseManagedVeniceReservation,
} from "@/lib/billing/managed-venice-wallets";
import { supabaseAdmin } from "@/lib/supabase";
import { appendManagedVeniceFinancialEvent } from "@/lib/billing/managed-venice-financial-events";
import { assertManagedVeniceWithinSpendCap } from "@/lib/billing/managed-venice-spend-caps";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import { responsesUsageTokens, VENICE_RESPONSES_ENDPOINT } from "./responses-protocol";
import {
  CHAT_RELEASE_FAILED_RECONCILIATION_REASON,
  MANAGED_VENICE_CHAT_HOLD_TTL_MS,
  MANAGED_VENICE_OBSERVED_OUTPUT_CAPTURE_POLICY,
  MANAGED_VENICE_SWEEP_OUTPUT_TOKENS_PER_CHOICE,
  holdEstimateMicroUsd,
  managedVeniceHoldExpiresAt,
  observedOutputCostMicroUsd,
} from "./hold-lifecycle";
import {
  MissingVeniceUsageError,
  calculateActualChatCost,
  estimateChatCompletionCost,
} from "./cost-estimator";
import {
  VENICE_MULTIMODAL_PRICING_CATALOG_UPDATED_AT,
  applyVeniceMultimodalMarkup,
  computeVeniceMultimodalCost,
  resolveVeniceMultimodalMarkup,
  type VeniceMultimodalSkipReason,
} from "./multimodal-pricing";

type QueryError = { code?: string; message?: string } | null;

type DbMutationFilter = {
  eq: (...args: unknown[]) => DbMutationFilter;
  then: Promise<{ error: QueryError }>["then"];
};

type DbTable = {
  insert: (...args: unknown[]) => Promise<{ error: QueryError }> | { then: Promise<{ error: QueryError }>["then"] };
  update: (...args: unknown[]) => DbMutationFilter;
};

type SupabaseLike = {
  from: (table: string) => unknown;
};

export interface ManagedVeniceSubsidyState {
  userLaunchSubsidyUsedMicroUsd: number;
  weeklySubsidyUsedMicroUsd: number;
  killSwitchActive?: boolean;
}

const DEFAULT_SUBSIDY_STATE: ManagedVeniceSubsidyState = {
  userLaunchSubsidyUsedMicroUsd: 0,
  weeklySubsidyUsedMicroUsd: 0,
};

function table(db: SupabaseLike, name: string): DbTable {
  return db.from(name) as DbTable;
}

function requireDb(db: SupabaseLike | null | undefined): SupabaseLike {
  if (!db) throw new Error("Database not configured");
  return db;
}

function readNumericField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Venice is OpenAI-compatible, so cache token counts arrive in
// `prompt_tokens_details.cached_tokens` rather than the
// Anthropic-flavoured `cache_read_tokens`. Tolerate both shapes so
// pricing stays accurate whichever flavour the upstream returns.
function readCacheTokens(record: Record<string, unknown>) {
  const promptDetailsRaw = record.prompt_tokens_details;
  const completionDetailsRaw = record.completion_tokens_details;
  const promptDetails =
    promptDetailsRaw && typeof promptDetailsRaw === "object"
      ? (promptDetailsRaw as Record<string, unknown>)
      : null;
  const completionDetails =
    completionDetailsRaw && typeof completionDetailsRaw === "object"
      ? (completionDetailsRaw as Record<string, unknown>)
      : null;

  const cacheReadTokens =
    readNumericField(record, "cache_read_tokens") ??
    (promptDetails ? readNumericField(promptDetails, "cached_tokens") : null) ??
    0;
  const cacheWriteTokens =
    readNumericField(record, "cache_write_tokens") ??
    (promptDetails ? readNumericField(promptDetails, "cache_creation_input_tokens") : null) ??
    (completionDetails ? readNumericField(completionDetails, "cache_creation_input_tokens") : null) ??
    0;

  return { cacheReadTokens, cacheWriteTokens };
}

function readUsageTokens(usage: unknown) {
  if (!usage || typeof usage !== "object") {
    throw new MissingVeniceUsageError();
  }
  const record = usage as Record<string, unknown>;
  const { cacheReadTokens, cacheWriteTokens } = readCacheTokens(record);
  return {
    promptTokens: record.prompt_tokens,
    completionTokens: record.completion_tokens,
    cacheReadTokens,
    cacheWriteTokens,
  };
}

export async function reserveManagedVeniceChatRequest(
  params: {
    userId: string;
    proxyKeyId: string;
    walletType: ManagedVeniceWalletType;
    referenceId: string;
    requestBody: { model: string; [key: string]: unknown };
    endpoint?: typeof VENICE_RESPONSES_ENDPOINT;
    subsidyState?: ManagedVeniceSubsidyState;
    pricingMap?: import("./cost-estimator").VenicePricingMap;
  },
  db: SupabaseLike | null | undefined = supabaseAdmin
) {
  const client = requireDb(db);
  const estimate = estimateChatCompletionCost(params.requestBody, params.pricingMap);
  // Protective monthly spend cap (off by default). Throws ManagedVeniceSpendCapError
  // before any reservation is held; the proxy route maps it to a 402. No-op when
  // caps are disabled or unconfigured, so existing behavior is unchanged.
  await assertManagedVeniceWithinSpendCap(
    { userId: params.userId, addMicroUsd: estimate.estimatedCostMicroUsd },
    client
  );
  const subsidyState = params.subsidyState ?? DEFAULT_SUBSIDY_STATE;
  // What the stale-hold sweep charges this hold if Venice answers but the
  // exact usage never arrives: the input estimate plus a bounded share of the
  // output, never more than the estimate itself (hold-lifecycle.ts).
  const sweepOutputTokens = Math.min(
    estimate.outputTokens,
    MANAGED_VENICE_SWEEP_OUTPUT_TOKENS_PER_CHOICE * estimate.outputChoices
  );
  const sweepEstimateMicroUsd = Math.min(
    estimate.estimatedCostMicroUsd,
    estimate.inputCostMicroUsd +
      (estimate.outputTokens > 0
        ? Math.ceil((estimate.outputCostMicroUsd * sweepOutputTokens) / estimate.outputTokens)
        : 0)
  );
  // The price of a million output tokens, as this estimate priced them. With
  // the input estimate it prices a stream whose usage never arrived at the
  // output it delivered (captureManagedVeniceObservedOutput), in the request
  // or later in the sweep, without a pricing lookup.
  const outputMicroUsdPerMillion = calculateActualChatCost(
    { model: params.requestBody.model, promptTokens: 0, completionTokens: 1_000_000 },
    params.pricingMap
  ).completionCostMicroUsd;
  const reservation = await createManagedVeniceReservation(
    {
      userId: params.userId,
      walletType: params.walletType,
      amountMicroUsd: estimate.reservedCostMicroUsd,
      referenceId: params.referenceId,
      estimatedCostMicroUsd: estimate.estimatedCostMicroUsd,
      discountRateBps: 0,
      discountMicroUsd: 0,
      model: params.requestBody.model,
      endpoint: params.endpoint ?? "/api/v1/chat/completions",
      // A hold whose settlement never arrives (the function died mid-stream,
      // the Worker never called back) is captured at its estimate once this
      // passes (reservation-sweep.ts).
      expiresAt: managedVeniceHoldExpiresAt(MANAGED_VENICE_CHAT_HOLD_TTL_MS),
      metadata: {
        proxyKeyId: params.proxyKeyId,
        estimatedCostMicroUsd: estimate.estimatedCostMicroUsd,
        reservedCostMicroUsd: estimate.reservedCostMicroUsd,
        inputEstimateMicroUsd: estimate.inputCostMicroUsd,
        outputMicroUsdPerMillion,
        sweepEstimateMicroUsd,
        subsidyState,
        pricingPolicy: "provider_rate_credits_no_usage_discount",
      },
    },
    client
  );

  return {
    referenceId: params.referenceId,
    reservationId: reservation.id,
    walletType: params.walletType,
    model: params.requestBody.model,
    estimatedCostMicroUsd: estimate.estimatedCostMicroUsd,
    reservedCostMicroUsd: estimate.reservedCostMicroUsd,
    reservedMicroUsd: estimate.reservedCostMicroUsd,
    discountMicroUsd: 0,
  };
}

/**
 * Debit what a request cost past its hold, as `<reference>:overage`. Call it
 * only after the capture that closed the hold reported captured=true: a hold
 * closes once, so its overage is debited once, whether the settlement is
 * retried or races the stale-hold sweep. "reconciliation_required" when the
 * wallet cannot cover it; any other failure throws.
 */
async function debitManagedVeniceOverage(
  params: { userId: string; walletType: ManagedVeniceWalletType; referenceId: string; overageMicroUsd: number },
  client: SupabaseLike
): Promise<"none" | "captured" | "reconciliation_required"> {
  if (params.overageMicroUsd <= 0) return "none";
  try {
    await debitManagedVeniceWallet(
      {
        userId: params.userId,
        walletType: params.walletType,
        amountMicroUsd: params.overageMicroUsd,
        referenceId: `${params.referenceId}:overage`,
      },
      client
    );
    return "captured";
  } catch (error) {
    if (error instanceof ManagedVeniceInsufficientBalanceError) return "reconciliation_required";
    throw error;
  }
}

/**
 * File an overage Hivra paid Venice for but could not collect. With
 * `pauseKey` (the wallet could not cover it) the key is paused until the
 * wallet is funded again (managed-venice-auto-recover.ts).
 */
async function fileManagedVeniceUncoveredOverage(
  params: {
    userId: string;
    proxyKeyId: string | null;
    referenceId: string;
    model: string | null;
    reservedMicroUsd: number | null;
    actualCostMicroUsd: number;
    overageMicroUsd: number;
    walletType: string;
    pauseKey: boolean;
    cause?: string;
  },
  client: SupabaseLike
) {
  await markManagedVeniceReconciliationRequired(
    {
      userId: params.userId,
      proxyKeyId: params.proxyKeyId,
      referenceId: params.referenceId,
      reason: "managed_venice_overage_uncovered",
      pauseKey: params.pauseKey,
      metadata: {
        model: params.model,
        reservedMicroUsd: params.reservedMicroUsd,
        actualCostMicroUsd: params.actualCostMicroUsd,
        overageMicroUsd: params.overageMicroUsd,
        walletType: params.walletType,
        ...(params.cause ? { cause: params.cause } : {}),
      },
    },
    client
  );
}

export type ManagedVeniceHoldCostCapture =
  | { captured: false }
  | {
      captured: true;
      /** What the hold paid: the cost, up to the hold. */
      capturedMicroUsd: number;
      /** The cost past the hold. */
      overageMicroUsd: number;
      overageStatus: "none" | "captured" | "reconciliation_required" | "debit_failed";
      /** What the wallet paid in all: the capture plus any overage debited. */
      chargedMicroUsd: number;
    };

/**
 * Charge a hold what its request cost when Venice's usage is not in hand to
 * capture with captureManagedVeniceChatUsage: the output a request observed,
 * a reported cost whose capture failed, or an estimate. The hold pays up to
 * the cost and anything past it is debited as an overage, exactly as a
 * capture of Venice's usage does. An overage the wallet cannot cover files
 * managed_venice_overage_uncovered and pauses the key; one whose debit failed
 * for another reason is filed without pausing it.
 *
 * Security review 2026-09 (#167 second review, HIGH): this charge used to
 * stop at the hold. A request with no output cap holds 4,096 output tokens,
 * so 120k tokens of Opus ($3.60 at Venice) were charged $0.135.
 *
 * The capture debits the wallet and closes the hold in one transaction, and
 * only the call whose capture closed the hold debits the overage, so a
 * retried settlement or a racing sweep never charges twice. Returns
 * captured=false, moving nothing, for a hold that is no longer active. Throws
 * only when the capture itself fails; once money has moved it never throws.
 */
export async function captureManagedVeniceHoldCost(
  params: {
    hold: {
      user_id: string;
      reference_id: string;
      reserved_micro_usd: number | string;
      wallet_type: string;
      model?: string | null;
    };
    proxyKeyId: string | null;
    costMicroUsd: number;
    cause: string;
    source: string;
  },
  db: SupabaseLike | null | undefined = supabaseAdmin
): Promise<ManagedVeniceHoldCostCapture> {
  const client = requireDb(db);
  const { hold } = params;
  if (!Number.isFinite(params.costMicroUsd)) {
    throw new Error("Managed Venice hold cost must be a finite number of micro-USD");
  }
  const reservedMicroUsd = Number(hold.reserved_micro_usd);
  const costMicroUsd = Math.max(0, Math.ceil(params.costMicroUsd));
  const capturedMicroUsd = Math.min(reservedMicroUsd, costMicroUsd);
  const overageMicroUsd = costMicroUsd - capturedMicroUsd;
  const walletType = hold.wallet_type as ManagedVeniceWalletType;

  const capture = await captureManagedVeniceReservation(
    { userId: hold.user_id, referenceId: hold.reference_id, captureMicroUsd: capturedMicroUsd },
    client
  );
  if (!capture.captured) return { captured: false };

  let overageStatus: "none" | "captured" | "reconciliation_required" | "debit_failed";
  try {
    overageStatus = await debitManagedVeniceOverage(
      { userId: hold.user_id, walletType, referenceId: hold.reference_id, overageMicroUsd },
      client
    );
  } catch (error) {
    overageStatus = "debit_failed";
    log.error("Managed Venice could not debit the overage past a captured hold", error, {
      source: params.source,
      failureType: "managed_venice_overage_debit_failed",
      userId: hold.user_id,
      referenceId: hold.reference_id,
      overageMicroUsd,
    });
  }
  if (overageStatus === "reconciliation_required" || overageStatus === "debit_failed") {
    try {
      await fileManagedVeniceUncoveredOverage(
        {
          userId: hold.user_id,
          proxyKeyId: params.proxyKeyId,
          referenceId: hold.reference_id,
          model: hold.model ?? null,
          reservedMicroUsd,
          actualCostMicroUsd: costMicroUsd,
          overageMicroUsd,
          walletType,
          pauseKey: overageStatus === "reconciliation_required",
          cause: params.cause,
        },
        client
      );
    } catch (error) {
      log.error("Managed Venice could not file an uncovered overage", error, {
        source: params.source,
        failureType: "managed_venice_overage_reconciliation_write_failed",
        userId: hold.user_id,
        referenceId: hold.reference_id,
        overageMicroUsd,
      });
    }
  }

  return {
    captured: true,
    capturedMicroUsd,
    overageMicroUsd,
    overageStatus,
    chargedMicroUsd: capturedMicroUsd + (overageStatus === "captured" ? overageMicroUsd : 0),
  };
}

export async function captureManagedVeniceChatUsage(
  params: {
    userId: string;
    proxyKeyId: string;
    walletType: ManagedVeniceWalletType;
    referenceId: string;
    model: string;
    upstreamStatus: number;
    usage: unknown;
    endpoint?: typeof VENICE_RESPONSES_ENDPOINT;
    subsidyState?: ManagedVeniceSubsidyState;
    pricingMap?: import("./cost-estimator").VenicePricingMap;
  },
  db: SupabaseLike | null | undefined = supabaseAdmin
) {
  const client = requireDb(db);
  const responsesTokens = params.endpoint === VENICE_RESPONSES_ENDPOINT ? responsesUsageTokens(params.usage) : null;
  const tokens = responsesTokens ?? readUsageTokens(params.usage);
  const actual = calculateActualChatCost(
    {
      model: params.model,
      promptTokens: tokens.promptTokens as number | null | undefined,
      completionTokens: tokens.completionTokens as number | null | undefined,
      cacheReadTokens: tokens.cacheReadTokens as number | null | undefined,
      cacheWriteTokens: tokens.cacheWriteTokens as number | null | undefined,
    },
    params.pricingMap,
  );
  const subsidyState = params.subsidyState ?? DEFAULT_SUBSIDY_STATE;

  // The reservation may be smaller than the actual cost when the caller
  // did not declare an output ceiling and the response ran past our
  // defensive default. Capture exactly what's reserved (this closes the
  // hold) and then debit the overage against the wallet so what we
  // charge always equals what Venice charges us. If the wallet can't
  // cover the overage we flag it for reconciliation rather than letting
  // the imbalance silently shrink margin.
  const reservation = await loadManagedVeniceReservation(
    params.userId,
    params.referenceId,
    client
  );
  const reservedMicroUsd =
    reservation?.reserved_micro_usd != null
      ? Number(reservation.reserved_micro_usd)
      : null;

  const cappedCaptureMicroUsd =
    reservedMicroUsd === null
      ? actual.actualCostMicroUsd
      : Math.min(actual.actualCostMicroUsd, reservedMicroUsd);
  const overageMicroUsd = Math.max(
    0,
    actual.actualCostMicroUsd - cappedCaptureMicroUsd
  );

  const capture = await captureManagedVeniceReservation(
    {
      userId: params.userId,
      referenceId: params.referenceId,
      captureMicroUsd: cappedCaptureMicroUsd,
    },
    client
  );
  if (!capture.captured) {
    // The hold was already settled: a retried settle (the Worker retries
    // until it gets a 2xx), or the sweep got there first. Everything this
    // settlement would do moved money or wrote its record the first time, so
    // debiting the overage again would charge a token wallet twice.
    log.warn("Managed Venice chat usage arrived for a hold that is already settled", {
      source: "venice-proxy-settlement",
      failureType: "managed_venice_capture_hold_already_settled",
      userId: params.userId,
      referenceId: params.referenceId,
      actualCostMicroUsd: actual.actualCostMicroUsd,
      capturedMicroUsd: capture.capturedMicroUsd,
    });
    return {
      referenceId: params.referenceId,
      actualCostMicroUsd: actual.actualCostMicroUsd,
      chargedMicroUsd: 0,
      discountMicroUsd: 0,
      overageMicroUsd: 0,
      overageStatus: "none" as const,
      alreadySettled: true as const,
    };
  }

  const overageStatus = await debitManagedVeniceOverage(
    {
      userId: params.userId,
      walletType: params.walletType,
      referenceId: params.referenceId,
      overageMicroUsd,
    },
    client
  );

  const chargedMicroUsd =
    overageStatus === "reconciliation_required"
      ? cappedCaptureMicroUsd
      : cappedCaptureMicroUsd + overageMicroUsd;

  const account = await ensureManagedVeniceWalletAccount(params.userId, client);
  const { error: usageError } = await table(client, "managed_venice_usage_events").insert({
    account_id: account.id,
    user_id: params.userId,
    proxy_key_id: params.proxyKeyId,
    wallet_type: params.walletType,
    endpoint: params.endpoint ?? "/api/v1/chat/completions",
    model: params.model,
    prompt_tokens: responsesTokens?.totalInputTokens ?? actual.promptTokens,
    completion_tokens: actual.completionTokens,
    total_tokens: (responsesTokens?.totalInputTokens ?? actual.promptTokens) + actual.completionTokens,
    actual_cost_micro_usd: actual.actualCostMicroUsd,
    charged_micro_usd: chargedMicroUsd,
    discount_micro_usd: 0,
    upstream_status: params.upstreamStatus,
    reference_id: params.referenceId,
    metadata: {
      cacheReadTokens: actual.cacheReadTokens,
      cacheWriteTokens: actual.cacheWriteTokens,
      reservedMicroUsd,
      overageMicroUsd,
      overageStatus,
      subsidyState,
      pricingPolicy: "provider_rate_credits_no_usage_discount",
    },
  });
  if (usageError) {
    throw new Error(usageError.message || "Failed to record managed Venice usage");
  }

  await appendManagedVeniceFinancialEvent(
    {
      userId: params.userId,
      accountId: account.id,
      walletType: params.walletType,
      eventType: "usage_capture",
      amountMicroUsd: chargedMicroUsd,
      veniceCostMicroUsd: actual.actualCostMicroUsd,
      discountMicroUsd: 0,
      referenceId: params.referenceId,
      idempotencyKey: `managed_venice_usage_capture:${params.referenceId}`,
      metadata: {
        model: params.model,
        proxyKeyId: params.proxyKeyId,
        reservedMicroUsd,
        overageMicroUsd,
        overageStatus,
        subsidyState,
        pricingPolicy: "provider_rate_credits_no_usage_discount",
      },
    },
    client
  );

  if (overageStatus === "reconciliation_required") {
    await fileManagedVeniceUncoveredOverage(
      {
        userId: params.userId,
        proxyKeyId: params.proxyKeyId,
        referenceId: params.referenceId,
        model: params.model,
        reservedMicroUsd,
        actualCostMicroUsd: actual.actualCostMicroUsd,
        overageMicroUsd,
        walletType: params.walletType,
        pauseKey: true,
      },
      client
    );
  }

  return {
    referenceId: params.referenceId,
    actualCostMicroUsd: actual.actualCostMicroUsd,
    chargedMicroUsd,
    discountMicroUsd: 0,
    overageMicroUsd,
    overageStatus,
    alreadySettled: false as const,
  };
}

/**
 * What Venice's reported usage costs, for a reconciliation item filed when
 * capturing it failed: the sweep then charges this, not an estimate. Null
 * when the usage block cannot be priced.
 */
export function managedVeniceUsageCostMicroUsd(params: {
  model: string;
  usage: unknown;
  endpoint?: string;
  pricingMap?: import("./cost-estimator").VenicePricingMap;
}): number | null {
  try {
    const tokens =
      params.endpoint === VENICE_RESPONSES_ENDPOINT ? responsesUsageTokens(params.usage) : readUsageTokens(params.usage);
    return calculateActualChatCost(
      {
        model: params.model,
        promptTokens: tokens.promptTokens as number | null | undefined,
        completionTokens: tokens.completionTokens as number | null | undefined,
        cacheReadTokens: tokens.cacheReadTokens as number | null | undefined,
        cacheWriteTokens: tokens.cacheWriteTokens as number | null | undefined,
      },
      params.pricingMap
    ).actualCostMicroUsd;
  } catch {
    return null;
  }
}

interface EstimatedCaptureHold {
  account_id?: string | null;
  user_id: string;
  wallet_type: string;
  reference_id: string;
  reserved_micro_usd: number;
  model?: string | null;
  endpoint?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Record a hold captured without Venice's token counts (the output the
 * request observed, or the sweep's estimate) like any other capture: a usage
 * row and an immutable usage_capture event, keyed to the hold, so the subsidy
 * report's ledger check and the user's usage history both see it. Money has
 * already moved; a failure here is logged, never retried (a retry could not
 * move money again anyway).
 */
export async function recordManagedVeniceEstimatedCapture(
  params: {
    hold: EstimatedCaptureHold;
    proxyKeyId: string | null;
    amountMicroUsd: number;
    listMicroUsd: number;
    pricingPolicy: string;
    upstreamStatus: number | null;
    idempotencyKey: string;
    detailKey: "sweep" | "observedOutput";
    detail: Record<string, unknown>;
  },
  db: SupabaseLike | null | undefined = supabaseAdmin
): Promise<void> {
  const { hold } = params;
  try {
    const client = requireDb(db);
    const { error } = await table(client, "managed_venice_usage_events").insert({
      account_id: hold.account_id,
      user_id: hold.user_id,
      proxy_key_id: params.proxyKeyId,
      wallet_type: hold.wallet_type,
      endpoint: hold.endpoint || "/api/v1/chat/completions",
      model: hold.model || "unknown",
      estimated_cost_micro_usd: hold.reserved_micro_usd,
      actual_cost_micro_usd: params.listMicroUsd,
      charged_micro_usd: params.amountMicroUsd,
      discount_micro_usd: 0,
      status: "recorded",
      upstream_status: params.upstreamStatus,
      reference_id: hold.reference_id,
      metadata: { pricingPolicy: params.pricingPolicy, [params.detailKey]: params.detail },
    });
    if (error) throw new Error(error.message || "Failed to record the estimated capture's usage");

    await appendManagedVeniceFinancialEvent(
      {
        userId: hold.user_id,
        accountId: hold.account_id ?? null,
        walletType: hold.wallet_type === "card" ? "card" : "hermesos",
        eventType: "usage_capture",
        amountMicroUsd: params.amountMicroUsd,
        veniceCostMicroUsd: params.listMicroUsd,
        discountMicroUsd: 0,
        referenceId: hold.reference_id,
        idempotencyKey: params.idempotencyKey,
        metadata: {
          pricingPolicy: params.pricingPolicy,
          model: hold.model ?? null,
          endpoint: hold.endpoint ?? null,
          proxyKeyId: params.proxyKeyId,
          [params.detailKey]: params.detail,
        },
      },
      client
    );
  } catch (error) {
    log.error("Managed Venice estimated capture could not be recorded", error, {
      source: "venice-proxy-settlement",
      failureType: "managed_venice_estimated_capture_record_failed",
      userId: hold.user_id,
      referenceId: hold.reference_id,
      pricingPolicy: params.pricingPolicy,
      capturedMicroUsd: params.amountMicroUsd,
    });
  }
}

export type ManagedVeniceObservedOutputOutcome =
  | "captured"
  | "already_settled"
  | "reservation_not_found"
  | "filed_for_sweep"
  | "unfiled";

/**
 * Settle a hold whose request Venice answered 2xx but whose exact usage never
 * arrived: the stream hit its deadline or broke, or Venice left the usage
 * out. The charge is the input estimate recorded on the hold plus the output
 * the request observed (stream-output-meter.ts), captured now so the rest of
 * the hold goes straight back to the user. A charge past the hold captures the
 * hold and debits the rest as an overage (captureManagedVeniceHoldCost).
 *
 * Security review 2026-09 (#166/#167): these holds used to wait a day and
 * then be charged a flat estimate, so a client that read a whole long answer
 * and closed the socket before the usage frame paid a few cents for dollars
 * of output, and one Stop press locked the whole hold for up to 48 hours.
 *
 * Never throws. When the charge cannot be written it files
 * `reconciliationReason` with the observed output, and the stale-hold sweep
 * captures the same amount.
 */
export async function captureManagedVeniceObservedOutput(
  params: {
    userId: string;
    proxyKeyId: string;
    referenceId: string;
    model: string;
    upstreamStatus: number;
    observedOutputTokens: number;
    cause: string;
    reconciliationReason: string;
    reconciliationMetadata?: Record<string, unknown>;
    source: string;
  },
  db: SupabaseLike | null | undefined = supabaseAdmin
): Promise<{ outcome: ManagedVeniceObservedOutputOutcome; chargedMicroUsd: number }> {
  const observedOutputTokens =
    Number.isSafeInteger(params.observedOutputTokens) && params.observedOutputTokens >= 0
      ? params.observedOutputTokens
      : 0;
  const context = {
    source: params.source,
    userId: params.userId,
    proxyKeyId: params.proxyKeyId,
    referenceId: params.referenceId,
    model: params.model,
    cause: params.cause,
    observedOutputTokens,
  };
  try {
    const client = requireDb(db);
    const hold = await loadManagedVeniceReservation(params.userId, params.referenceId, client);
    if (!hold) {
      log.error("Managed Venice usage-less response has no hold to charge", undefined, {
        ...context,
        failureType: "managed_venice_observed_output_hold_missing",
      });
      return { outcome: "reservation_not_found", chargedMicroUsd: 0 };
    }
    if (hold.status !== "active") return { outcome: "already_settled", chargedMicroUsd: 0 };

    const holdRow = hold as typeof hold & EstimatedCaptureHold;
    const observedCost = observedOutputCostMicroUsd(holdRow, observedOutputTokens);
    // A hold from before holds recorded their input estimate: its estimate.
    const costMicroUsd = observedCost ?? holdEstimateMicroUsd(holdRow);
    const basis = observedCost === null ? "pre_request_estimate" : "observed_output";
    // Past the hold, the rest is debited as an overage (#167 second review).
    const charge = await captureManagedVeniceHoldCost(
      { hold: holdRow, proxyKeyId: params.proxyKeyId, costMicroUsd, cause: params.cause, source: params.source },
      client
    );
    if (!charge.captured) return { outcome: "already_settled", chargedMicroUsd: 0 };

    log.warn("Managed Venice charged the observed output of a response whose usage never arrived", {
      ...context,
      failureType: "managed_venice_usage_missing_observed_output_charged",
      chargedMicroUsd: charge.chargedMicroUsd,
      costMicroUsd,
      heldMicroUsd: Number(hold.reserved_micro_usd),
      overageStatus: charge.overageStatus,
      basis,
    });
    await recordManagedVeniceEstimatedCapture(
      {
        hold: holdRow,
        proxyKeyId: params.proxyKeyId,
        amountMicroUsd: charge.chargedMicroUsd,
        listMicroUsd: costMicroUsd,
        pricingPolicy: MANAGED_VENICE_OBSERVED_OUTPUT_CAPTURE_POLICY,
        upstreamStatus: params.upstreamStatus,
        // The same key an exact capture writes: a hold is charged once.
        idempotencyKey: `managed_venice_usage_capture:${params.referenceId}`,
        detailKey: "observedOutput",
        detail: {
          cause: params.cause,
          basis,
          observedOutputTokens,
          inputEstimateMicroUsd: holdRow.metadata?.inputEstimateMicroUsd ?? null,
          outputMicroUsdPerMillion: holdRow.metadata?.outputMicroUsdPerMillion ?? null,
          heldMicroUsd: Number(hold.reserved_micro_usd),
          overageMicroUsd: charge.overageMicroUsd,
          overageStatus: charge.overageStatus,
        },
      },
      client
    );
    return { outcome: "captured", chargedMicroUsd: charge.chargedMicroUsd };
  } catch (error) {
    log.error("Managed Venice could not charge the observed output; filing it for the sweep", error, {
      ...context,
      failureType: "managed_venice_observed_output_capture_failed",
    });
    try {
      await markManagedVeniceReconciliationRequired(
        {
          userId: params.userId,
          proxyKeyId: params.proxyKeyId,
          referenceId: params.referenceId,
          reason: params.reconciliationReason,
          // Venice answered and the hold still covers the spend.
          pauseKey: false,
          metadata: {
            model: params.model,
            upstreamStatus: params.upstreamStatus,
            ...(params.reconciliationMetadata ?? {}),
            cause: params.cause,
            observedOutputTokens,
          },
        },
        db
      );
      return { outcome: "filed_for_sweep", chargedMicroUsd: 0 };
    } catch (fileError) {
      log.error("Managed Venice could not file the observed output for the sweep", fileError, {
        ...context,
        failureType: "managed_venice_observed_output_reconciliation_write_failed",
        reason: params.reconciliationReason,
      });
      return { outcome: "unfiled", chargedMicroUsd: 0 };
    }
  }
}

/**
 * Release the hold of a request Venice refused, or that never reached Venice.
 * Never throws: when the release fails it files
 * CHAT_RELEASE_FAILED_RECONCILIATION_REASON and the sweep releases the hold.
 *
 * Security review 2026-09 (#167): a failed release used to throw with no
 * item, so the hold expired a day later and the sweep charged the user for a
 * request Venice never ran.
 */
export async function releaseManagedVeniceChatReservationOrFile(
  params: {
    userId: string;
    proxyKeyId: string | null;
    referenceId: string;
    cause: string;
    source: string;
    upstreamStatus?: number | null;
    model?: string | null;
  },
  db: SupabaseLike | null | undefined = supabaseAdmin
): Promise<{ released: boolean; filed: boolean; failed: boolean }> {
  try {
    const result = await releaseManagedVeniceReservation(
      { userId: params.userId, referenceId: params.referenceId },
      requireDb(db)
    );
    return { released: result.released, filed: false, failed: false };
  } catch (error) {
    const context = {
      source: params.source,
      userId: params.userId,
      proxyKeyId: params.proxyKeyId,
      referenceId: params.referenceId,
      cause: params.cause,
      upstreamStatus: params.upstreamStatus ?? null,
    };
    log.error("Managed Venice could not release a refused request's hold; filing it for the sweep", error, {
      ...context,
      failureType: "managed_venice_chat_release_failed",
    });
    try {
      await markManagedVeniceReconciliationRequired(
        {
          userId: params.userId,
          proxyKeyId: params.proxyKeyId,
          referenceId: params.referenceId,
          reason: CHAT_RELEASE_FAILED_RECONCILIATION_REASON,
          pauseKey: false,
          metadata: {
            cause: params.cause,
            upstreamStatus: params.upstreamStatus ?? null,
            model: params.model ?? null,
          },
        },
        db
      );
      return { released: false, filed: true, failed: false };
    } catch (fileError) {
      log.error("Managed Venice could not file a failed release for the sweep", fileError, {
        ...context,
        failureType: "managed_venice_chat_release_reconciliation_write_failed",
      });
      return { released: false, filed: false, failed: true };
    }
  }
}

/**
 * Who a hold belongs to, from its reference alone. The Cloudflare Worker
 * chooses a request's reference before authorizing it, so when the authorize
 * response is lost it can still release the hold by that reference.
 */
export async function loadManagedVeniceReservationOwner(
  referenceId: string,
  db: SupabaseLike | null | undefined = supabaseAdmin
): Promise<{ userId: string; proxyKeyId: string | null } | null> {
  const client = requireDb(db);
  const { data, error } = await (client.from("managed_venice_reservations") as {
    select: (cols: string) => {
      eq: (col: string, val: string) => { maybeSingle: () => PromiseLike<{ data: unknown; error: QueryError }> };
    };
  })
    .select("user_id, metadata")
    .eq("reference_id", referenceId)
    .maybeSingle();
  if (error) throw new Error(error.message || "Failed to load managed Venice reservation");
  const row = data as { user_id?: unknown; metadata?: Record<string, unknown> | null } | null;
  if (!row || typeof row.user_id !== "string") return null;
  const proxyKeyId = row.metadata?.proxyKeyId;
  return { userId: row.user_id, proxyKeyId: typeof proxyKeyId === "string" ? proxyKeyId : null };
}

export async function releaseManagedVeniceChatReservation(
  params: { userId: string; referenceId: string },
  db: SupabaseLike | null | undefined = supabaseAdmin
) {
  return releaseManagedVeniceReservation(params, requireDb(db));
}

export async function markManagedVeniceReconciliationRequired(
  params: {
    userId: string;
    // Null only when the key is unknown (a release the Worker sends by
    // reference alone); such an item never pauses a key.
    proxyKeyId: string | null;
    referenceId: string;
    reason: string;
    metadata?: Record<string, unknown>;
    // Whether to ALSO pause the proxy key (default true). Pausing is a hard
    // service denial: a paused key 401s every subsequent request (chat AND
    // media). It's only justified when the user has genuinely unpaid usage we
    // can't collect (e.g. an uncovered overage). For transient telemetry /
    // settlement hiccups on an otherwise-successful 200 — a missing SSE usage
    // frame, a settlement insert that threw — pausing bricks a paying customer
    // mid-conversation while the reservation is already held and the invoice
    // reconciliation cron will settle the cost offline. Pass false there: file
    // the reconciliation item for follow-up, but leave the key usable.
    pauseKey?: boolean;
  },
  db: SupabaseLike | null | undefined = supabaseAdmin
) {
  const client = requireDb(db);
  const account = await ensureManagedVeniceWalletAccount(params.userId, client);
  const { error: reconciliationError } = await table(
    client,
    "managed_venice_reconciliation_items"
  ).insert({
    user_id: params.userId,
    account_id: account.id,
    proxy_key_id: params.proxyKeyId,
    status: "open",
    reason: params.reason,
    metadata: {
      referenceId: params.referenceId,
      ...(params.metadata || {}),
    },
  });
  if (reconciliationError) {
    throw new Error(
      reconciliationError.message || "Failed to create managed Venice reconciliation item"
    );
  }

  if (params.pauseKey === false || !params.proxyKeyId) {
    return { status: "open" as const, paused: false as const };
  }

  const { error: pauseError } = await table(client, "managed_venice_proxy_keys")
    .update({
      status: "paused",
      paused_reason: params.reason,
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.proxyKeyId)
    .eq("user_id", params.userId)
    // A late response may arrive after the owner revoked/replaced this key.
    // Never turn revocation (or a deliberate pause) into an overage pause that
    // a later top-up would reactivate. The usage record above still survives.
    .eq("status", "active");
  if (pauseError) {
    throw new Error(pauseError.message || "Failed to pause managed Venice proxy key");
  }

  return { status: "open" as const, paused: true as const };
}

/**
 * Settlement pass for the multi-modal (image/video/audio/embeddings/search)
 * BACKLOG: rows written with ``status='reconciliation_required'`` before the
 * media spend gate (media-spend-gate.ts) started charging in-request. New
 * media requests are held, captured and recorded as ``status='recorded'``
 * at request time whatever the flag below says, so this pass never sees them.
 *
 * Closes the F176 cost leak: multimodal rows were written with
 * ``actual_cost=0``, ``charged=0``, ``status='reconciliation_required'`` and
 * nothing settled them, so multi-modal was free to users. This
 * pass prices each pending row against the in-code catalog in
 * ``multimodal-pricing.ts`` and — only when billing is enabled — debits the
 * user's wallet through the SAME ledger primitives the chat path uses
 * (``debitManagedVeniceWallet`` + ``appendManagedVeniceFinancialEvent``),
 * then flips the row to ``status='recorded'`` with the real cost.
 *
 * SAFETY:
 *   * ``MANAGED_VENICE_MULTIMODAL_BILLING_ENABLED`` defaults OFF and only
 *     governs this retroactive pass. Flag off = a pure dry-run: rows are read
 *     and classified, the summary reports what WOULD be charged, and nothing
 *     is written anywhere.
 *   * Unknown (endpoint, model) pairs and priced operations with underivable
 *     quantities are NEVER guessed at: the row is skipped (stays
 *     ``reconciliation_required``), the skip is tallied in the summary, and —
 *     when billing is on — surfaced as a warn-level ops event so unpriced
 *     usage can't silently leak margin.
 *   * Double-charge protection: each row is CLAIMED (conditionally flipped to
 *     ``recorded`` while still ``reconciliation_required``) before the wallet
 *     is touched. A concurrent run claims zero rows; a crash between claim and
 *     debit under-charges (visible as a recorded row with ``charged=0`` and no
 *     financial event) but can never charge twice.
 *   * A wallet that can't cover a row files a reconciliation item with
 *     ``pauseKey: false`` — backlog settlement must not brick a live key the
 *     way an in-flight uncovered overage does.
 */
export function isManagedVeniceMultimodalBillingEnabled(): boolean {
  return process.env.MANAGED_VENICE_MULTIMODAL_BILLING_ENABLED === "true";
}

const CHAT_COMPLETIONS_ENDPOINT = "/api/v1/chat/completions";

interface ManagedVeniceMultimodalSettlementSkippedKey {
  endpoint: string;
  model: string;
  reason: VeniceMultimodalSkipReason;
  rowCount: number;
}

export interface ManagedVeniceMultimodalSettlementSummary {
  billingEnabled: boolean;
  markupFactor: number;
  catalogUpdatedAt: string;
  pendingRowCount: number;
  // Rows the catalog can price (settled when the flag is on).
  pricedRowCount: number;
  // Post-markup value of every priceable pending row — what a flag-on run
  // would (or did) attempt to charge. Populated in dry-runs too.
  wouldChargeMicroUsd: number;
  // Rows flipped to status='recorded' this run (0 when the flag is off).
  settledRowCount: number;
  // Wallet debits that actually succeeded (0 when the flag is off).
  chargedMicroUsd: number;
  // Settled rows whose wallet couldn't cover the charge; a reconciliation
  // item was filed (pauseKey=false) instead of a debit.
  uncoveredRowCount: number;
  skippedRowCount: number;
  skipped: ManagedVeniceMultimodalSettlementSkippedKey[];
  errorRowCount: number;
  note: string;
}

interface PendingMultimodalUsageRow {
  id: string;
  user_id: string;
  proxy_key_id: string | null;
  wallet_type: string | null;
  endpoint: string;
  model: string;
  reference_id: string | null;
  metadata: Record<string, unknown> | null;
}

type SettlementListChain = {
  select: (cols: string) => SettlementListChain;
  eq: (col: string, val: string) => SettlementListChain;
  neq: (col: string, val: string) => SettlementListChain;
  gte: (col: string, val: string) => SettlementListChain;
  lt: (col: string, val: string) => SettlementListChain;
  limit: (n: number) => Promise<{ data: unknown; error: QueryError }>;
};

type SettlementClaimChain = {
  update: (patch: Record<string, unknown>) => {
    eq: (col: string, val: unknown) => {
      eq: (col: string, val: unknown) => {
        select: (cols: string) => Promise<{ data: unknown; error: QueryError }>;
      };
    };
  };
};

export async function settleManagedVeniceMultimodalUsage(
  params: { sinceIso: string; untilIso?: string; limit?: number },
  db: SupabaseLike | null | undefined = supabaseAdmin
): Promise<ManagedVeniceMultimodalSettlementSummary> {
  const client = requireDb(db);
  const billingEnabled = isManagedVeniceMultimodalBillingEnabled();
  const markupFactor = resolveVeniceMultimodalMarkup();
  const limit = Math.min(Math.max(params.limit ?? 1_000, 1), 5_000);

  const query = (
    table(client, "managed_venice_usage_events") as unknown as SettlementListChain
  )
    .select(
      "id, user_id, proxy_key_id, wallet_type, endpoint, model, reference_id, metadata"
    )
    .eq("status", "reconciliation_required")
    // Chat rows are settled in-request; a chat row in reconciliation_required
    // belongs to the chat reconciliation path, not the multimodal catalog.
    .neq("endpoint", CHAT_COMPLETIONS_ENDPOINT)
    .neq("endpoint", VENICE_RESPONSES_ENDPOINT)
    .gte("created_at", params.sinceIso);
  const result = params.untilIso
    ? await query.lt("created_at", params.untilIso).limit(limit)
    : await query.limit(limit);
  if (result.error) {
    throw new Error(result.error.message || "Failed to load multi-modal usage for settlement");
  }
  const pendingRows = (Array.isArray(result.data) ? result.data : []) as PendingMultimodalUsageRow[];

  let pricedRowCount = 0;
  let wouldChargeMicroUsd = 0;
  let settledRowCount = 0;
  let chargedMicroUsd = 0;
  let uncoveredRowCount = 0;
  let errorRowCount = 0;
  const skippedByKey = new Map<string, ManagedVeniceMultimodalSettlementSkippedKey>();

  for (const row of pendingRows) {
    try {
      const cost = computeVeniceMultimodalCost({
        endpoint: row.endpoint,
        model: row.model,
        metadata: row.metadata,
      });

      if (!cost.priced) {
        const key = `${row.endpoint}${row.model}${cost.reason}`;
        const existing = skippedByKey.get(key);
        if (existing) {
          existing.rowCount += 1;
        } else {
          skippedByKey.set(key, {
            endpoint: row.endpoint,
            model: row.model,
            reason: cost.reason,
            rowCount: 1,
          });
        }
        continue;
      }

      const chargeMicroUsd = applyVeniceMultimodalMarkup(
        cost.listCostMicroUsd,
        markupFactor
      );
      pricedRowCount += 1;
      wouldChargeMicroUsd += chargeMicroUsd;

      if (!billingEnabled) continue; // Dry-run: classify only, never write.

      const referenceId = row.reference_id || row.id;
      const walletType: ManagedVeniceWalletType =
        row.wallet_type === "card" ? "card" : "hermesos";

      // Claim the row BEFORE touching the wallet: the conditional update only
      // succeeds while the row is still reconciliation_required, so a
      // concurrent settlement run (or a re-run over the same window) claims
      // nothing and never double-debits.
      const claim = await (
        table(client, "managed_venice_usage_events") as unknown as SettlementClaimChain
      )
        .update({
          status: "recorded",
          actual_cost_micro_usd: cost.listCostMicroUsd,
          charged_micro_usd: 0,
          metadata: {
            ...(row.metadata || {}),
            pricingPolicy: "multimodal_in_code_price_table",
            settlement: {
              settledAt: new Date().toISOString(),
              catalogUpdatedAt: VENICE_MULTIMODAL_PRICING_CATALOG_UPDATED_AT,
              unit: cost.unit,
              quantity: cost.quantity,
              tier: cost.tier,
              listMicroUsdPerUnit: cost.microUsdPerUnit,
              listCostMicroUsd: cost.listCostMicroUsd,
              markupFactor,
            },
          },
        })
        .eq("id", row.id)
        .eq("status", "reconciliation_required")
        .select("id");
      if (claim.error) {
        throw new Error(claim.error.message || "Failed to claim multi-modal usage row");
      }
      const claimedRows = Array.isArray(claim.data)
        ? claim.data
        : claim.data
          ? [claim.data]
          : [];
      if (!claimedRows.length) continue; // Raced with another run.
      settledRowCount += 1;

      try {
        await debitManagedVeniceWallet(
          {
            userId: row.user_id,
            walletType,
            amountMicroUsd: chargeMicroUsd,
            referenceId: `${referenceId}:multimodal`,
          },
          client
        );
      } catch (debitError) {
        if (debitError instanceof ManagedVeniceInsufficientBalanceError) {
          uncoveredRowCount += 1;
          if (row.proxy_key_id) {
            await markManagedVeniceReconciliationRequired(
              {
                userId: row.user_id,
                proxyKeyId: row.proxy_key_id,
                referenceId,
                reason: "managed_venice_multimodal_settlement_uncovered",
                // Backlog settlement of an already-delivered generation must
                // not brick the key mid-conversation; file the debt for
                // offline follow-up instead.
                pauseKey: false,
                metadata: {
                  endpoint: row.endpoint,
                  model: row.model,
                  listCostMicroUsd: cost.listCostMicroUsd,
                  chargeMicroUsd,
                  walletType,
                },
              },
              client
            );
          } else {
            log.error(
              "managed Venice multimodal settlement uncovered with no proxy key on row",
              debitError,
              {
                source: "venice-proxy-settlement",
                failureType: "managed_venice_multimodal_settlement_uncovered_keyless",
                userId: row.user_id,
                referenceId,
              }
            );
          }
          continue;
        }
        throw debitError;
      }

      const { error: chargedError } = await table(client, "managed_venice_usage_events")
        .update({ charged_micro_usd: chargeMicroUsd })
        .eq("id", row.id);
      if (chargedError) {
        throw new Error(
          chargedError.message || "Failed to record multi-modal charge on usage row"
        );
      }
      chargedMicroUsd += chargeMicroUsd;

      const account = await ensureManagedVeniceWalletAccount(row.user_id, client);
      await appendManagedVeniceFinancialEvent(
        {
          userId: row.user_id,
          accountId: account.id,
          walletType,
          eventType: "usage_capture",
          amountMicroUsd: chargeMicroUsd,
          veniceCostMicroUsd: cost.listCostMicroUsd,
          discountMicroUsd: 0,
          referenceId,
          idempotencyKey: `managed_venice_multimodal_settlement:${row.id}`,
          metadata: {
            endpoint: row.endpoint,
            model: row.model,
            unit: cost.unit,
            quantity: cost.quantity,
            tier: cost.tier,
            markupFactor,
            usageEventId: row.id,
            pricingPolicy: "multimodal_in_code_price_table",
          },
        },
        client
      );
    } catch (rowError) {
      errorRowCount += 1;
      log.error("managed Venice multimodal settlement row failed", rowError, {
        source: "venice-proxy-settlement",
        failureType: "managed_venice_multimodal_settlement_row_failed",
        usageEventId: row.id,
        endpoint: row.endpoint,
        model: row.model,
        userId: row.user_id,
      });
    }
  }

  const skipped = Array.from(skippedByKey.values()).sort(
    (a, b) => b.rowCount - a.rowCount
  );
  const skippedRowCount = skipped.reduce((sum, entry) => sum + entry.rowCount, 0);

  // Unpriced usage while billing is LIVE is margin walking out the door —
  // surface it where ops looks. Dry-runs stay quiet (the summary already
  // reports the same breakdown to the caller) so the flag-off cron doesn't
  // spam the events feed daily.
  if (billingEnabled && skipped.length > 0) {
    try {
      await reportOpsEvent({
        source: "venice-proxy-settlement",
        severity: "warn",
        title: "Managed Venice multimodal usage skipped: no in-code price",
        message:
          `${skippedRowCount} multimodal usage row(s) across ${skipped.length} operation key(s) ` +
          "were left unsettled because the price catalog can't price them. " +
          "Add entries to lib/venice/multimodal-pricing.ts or settle offline.",
        metadata: { skipped, catalogUpdatedAt: VENICE_MULTIMODAL_PRICING_CATALOG_UPDATED_AT },
      });
    } catch (opsError) {
      log.warn("failed to report multimodal settlement ops event", {
        source: "venice-proxy-settlement",
        failureType: "managed_venice_multimodal_settlement_ops_event_failed",
        errorMessage: opsError instanceof Error ? opsError.message : String(opsError),
      });
    }
  }

  return {
    billingEnabled,
    markupFactor,
    catalogUpdatedAt: VENICE_MULTIMODAL_PRICING_CATALOG_UPDATED_AT,
    pendingRowCount: pendingRows.length,
    pricedRowCount,
    wouldChargeMicroUsd,
    settledRowCount,
    chargedMicroUsd,
    uncoveredRowCount,
    skippedRowCount,
    skipped,
    errorRowCount,
    note: billingEnabled
      ? `Settled ${settledRowCount} row(s), charged ${chargedMicroUsd} µUSD ` +
        `(${uncoveredRowCount} uncovered); skipped ${skippedRowCount} row(s) with no in-code price.`
      : `Dry run: ${pricedRowCount} of ${pendingRows.length} pending row(s) are priceable ` +
        `(${wouldChargeMicroUsd} µUSD at markup ${markupFactor}); nothing was written or charged ` +
        "(MANAGED_VENICE_MULTIMODAL_BILLING_ENABLED defaults off).",
  };
}

export { ManagedVeniceInsufficientBalanceError };
export { ManagedVeniceSpendCapError } from "@/lib/billing/managed-venice-spend-caps";
