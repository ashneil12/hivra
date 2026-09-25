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
      metadata: {
        proxyKeyId: params.proxyKeyId,
        estimatedCostMicroUsd: estimate.estimatedCostMicroUsd,
        reservedCostMicroUsd: estimate.reservedCostMicroUsd,
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

  await captureManagedVeniceReservation(
    {
      userId: params.userId,
      referenceId: params.referenceId,
      captureMicroUsd: cappedCaptureMicroUsd,
    },
    client
  );

  let overageStatus: "none" | "captured" | "reconciliation_required" = "none";
  if (overageMicroUsd > 0) {
    try {
      await debitManagedVeniceWallet(
        {
          userId: params.userId,
          walletType: params.walletType,
          amountMicroUsd: overageMicroUsd,
          referenceId: `${params.referenceId}:overage`,
        },
        client
      );
      overageStatus = "captured";
    } catch (error) {
      if (error instanceof ManagedVeniceInsufficientBalanceError) {
        overageStatus = "reconciliation_required";
      } else {
        throw error;
      }
    }
  }

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
    await markManagedVeniceReconciliationRequired(
      {
        userId: params.userId,
        proxyKeyId: params.proxyKeyId,
        referenceId: params.referenceId,
        reason: "managed_venice_overage_uncovered",
        metadata: {
          model: params.model,
          reservedMicroUsd,
          actualCostMicroUsd: actual.actualCostMicroUsd,
          overageMicroUsd,
          walletType: params.walletType,
        },
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
  };
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
    proxyKeyId: string;
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

  if (params.pauseKey === false) {
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
