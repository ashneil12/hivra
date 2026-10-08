// Spend gate for managed-Venice MEDIA requests (images, video, audio,
// embeddings, web augmentation and the paid passthrough paths).
//
// Every one of these requests is sent to Venice with HIVRA's upstream key, so
// Venice bills Hivra whether or not the user can pay. The chat routes have
// always held an estimate on the user's wallet first; media routes did not,
// which let a free account with a $0 wallet spend Hivra's Venice credits
// without limit. This module is the media equivalent of
// reserveManagedVeniceChatRequest:
//
//   1. price the request from the in-code catalog (multimodal-pricing.ts) as a
//      conservative ceiling. An operation the catalog cannot price is REFUSED —
//      never forwarded — because an unknown price is an unbounded one;
//   2. hold that amount on the key's wallet (same reservation table, balance
//      trigger and spend cap as chat). A wallet that can't cover it gets a 402
//      and Venice is never called;
//   3. after Venice answers, settle:
//        - error / no answer -> release the hold, charge nothing;
//        - 2xx               -> capture the settlement price (the catalog's
//          published floor) from the hold and write a 'recorded' usage row +
//          financial event, so the offline settlement pass skips it. That
//          includes a 2xx whose body could not be read: Venice ran it.
//   4. whatever this request could not settle, the stale-hold sweep
//      (reservation-sweep.ts) does: every hold expires after
//      MANAGED_VENICE_MEDIA_HOLD_TTL_MS and records what a success costs, a
//      failed capture or release files a reconciliation item, and the sweep
//      captures (or, for a refused request, releases) the hold.
//
// A 2xx is ALWAYS charged. MANAGED_VENICE_MULTIMODAL_BILLING_ENABLED does not
// apply here: it only switches the retroactive settlement of old
// 'reconciliation_required' rows (settleManagedVeniceMultimodalUsage). If a
// success released its hold instead, the gate would only prove the wallet was
// non-empty, and one small top-up would buy unlimited media on Hivra's key.

import { randomUUID } from "node:crypto";

import {
  ManagedVeniceInsufficientBalanceError,
  type ManagedVeniceWalletType,
  captureManagedVeniceReservation,
  createManagedVeniceReservation,
  ensureManagedVeniceWalletAccount,
  releaseManagedVeniceReservation,
} from "@/lib/billing/managed-venice-wallets";
import { appendManagedVeniceFinancialEvent } from "@/lib/billing/managed-venice-financial-events";
import {
  ManagedVeniceSpendCapError,
  assertManagedVeniceWithinSpendCap,
} from "@/lib/billing/managed-venice-spend-caps";
import { apiError } from "@/lib/api-response";
import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";
import {
  VENICE_MULTIMODAL_PRICING_CATALOG_UPDATED_AT,
  applyVeniceMultimodalMarkup,
  computeVeniceMultimodalCost,
  computeVeniceMultimodalHoldCost,
  describeVeniceMultimodalTiers,
  resolveVeniceMultimodalMarkup,
  resolveVeniceMultimodalPrice,
} from "./multimodal-pricing";
import {
  MANAGED_VENICE_MEDIA_HOLD_TTL_MS,
  MEDIA_CAPTURE_FAILED_RECONCILIATION_REASON,
  MEDIA_RELEASE_FAILED_RECONCILIATION_REASON,
  managedVeniceHoldExpiresAt,
} from "./hold-lifecycle";
import { managedVeniceTopUpUrl } from "./proxy-chat-core";
import { markManagedVeniceReconciliationRequired } from "./proxy-settlement";

type SupabaseLike = { from: (table: string) => unknown };
type InsertTable = { insert: (row: Record<string, unknown>) => PromiseLike<{ error: { message?: string } | null }> };

export interface ManagedVeniceMediaKey {
  id: string;
  userId: string;
  defaultWalletType?: ManagedVeniceWalletType | null;
}

export interface ManagedVeniceMediaOperation {
  /** Venice-native endpoint label and catalog key, e.g. "/api/v1/image/generate". */
  endpoint: string;
  /** Model id the catalog prices. */
  model: string;
  /**
   * Pricing inputs (variants, resolution, scale, inputLength) plus the audit
   * fields recorded on the usage row.
   */
  metadata?: Record<string, unknown>;
}

export interface ManagedVeniceMediaOutcome {
  ok: boolean;
  upstreamStatus: number;
  upstreamRequestId?: string | null;
  /** Extra usage-row metadata known only after Venice answered. */
  metadata?: Record<string, unknown>;
}

export interface ManagedVeniceMediaHold {
  referenceId: string;
  walletType: ManagedVeniceWalletType;
  heldMicroUsd: number;
  /** Settle (2xx) or release (anything else). Never throws. */
  complete(outcome: ManagedVeniceMediaOutcome): Promise<void>;
  /** Release without an upstream answer (fetch threw). Never throws. */
  release(reason: string, detail?: { upstreamStatus?: number }): Promise<void>;
}

export type ManagedVeniceMediaHoldResult =
  | { ok: true; hold: ManagedVeniceMediaHold }
  | { ok: false; response: Response };

function billingError(status: number, code: string, message: string) {
  return new Response(
    JSON.stringify({ error: { message, type: "billing_error", param: null, code } }),
    { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }
  );
}

function usd(microUsd: number) {
  return `$${(microUsd / 1_000_000).toFixed(microUsd < 10_000 ? 4 : 2)}`;
}

/**
 * Hold wallet funds for one media request, or return the refusal to send the
 * caller. Call this AFTER the request is validated and BEFORE any fetch to
 * Venice; only forward when `ok` is true.
 */
export async function holdManagedVeniceMediaSpend(
  params: {
    key: ManagedVeniceMediaKey;
    operation: ManagedVeniceMediaOperation;
    referenceId?: string;
    /** Log source, e.g. "managed-venice-image". */
    source: string;
  },
  db: SupabaseLike | null | undefined = supabaseAdmin
): Promise<ManagedVeniceMediaHoldResult> {
  const { key, operation, source } = params;
  const referenceId = params.referenceId ?? randomUUID();
  const walletType: ManagedVeniceWalletType = key.defaultWalletType === "card" ? "card" : "hermesos";
  const metadata = operation.metadata ?? {};
  const logContext = {
    source,
    route: operation.endpoint,
    userId: key.userId,
    proxyKeyId: key.id,
    walletType,
    model: operation.model,
    referenceId,
  };

  const estimate = computeVeniceMultimodalHoldCost({
    endpoint: operation.endpoint,
    model: operation.model,
    metadata,
  });
  if (!estimate.priced && estimate.reason === "invalid_tier") {
    // Routes normalize tier fields before they get here
    // (media-request-fields.ts planMediaRequest), so this is the backstop.
    const price = resolveVeniceMultimodalPrice(operation.endpoint, operation.model);
    const field = price?.tierMetadataKey ?? "tier";
    log.warn("Managed Venice media request refused: tier value can't be priced", {
      ...logContext,
      failureType: "managed_venice_media_invalid_tier",
      field,
    });
    return {
      ok: false,
      response: new Response(
        JSON.stringify({
          error: {
            message:
              `"${field}" must be ${price ? describeVeniceMultimodalTiers(price) : "a published tier"} ` +
              `for ${operation.model.slice(0, 80)}. The request was not sent and nothing was charged.`,
            type: "invalid_request_error",
            param: field,
            code: "managed_venice_invalid_tier",
          },
        }),
        { status: 400, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }
      ),
    };
  }
  if (!estimate.priced) {
    log.warn("Managed Venice media request refused: no known price", {
      ...logContext,
      failureType: "managed_venice_media_unpriced",
      reason: estimate.reason,
    });
    return {
      ok: false,
      response: billingError(
        402,
        "managed_venice_operation_unpriced",
        `Hivra can't bill ${operation.endpoint.replace("/api/v1/", "")} with model ` +
          `"${operation.model.slice(0, 80)}" ` +
          "on Hivra credits yet, so the request was not sent and nothing was charged. " +
          "Use a supported model, or connect your own Venice API key for this operation."
      ),
    };
  }

  const markup = resolveVeniceMultimodalMarkup();
  const heldMicroUsd = Number.isSafeInteger(estimate.listCostMicroUsd)
    ? applyVeniceMultimodalMarkup(estimate.listCostMicroUsd, markup)
    : Number.POSITIVE_INFINITY;
  if (!Number.isSafeInteger(heldMicroUsd) || heldMicroUsd <= 0) {
    // An absurd quantity (e.g. a huge variant count) — no wallet can cover it.
    return {
      ok: false,
      response: billingError(
        402,
        "managed_venice_insufficient_balance",
        "This request is larger than any Hivra credit balance can cover, so it was not sent."
      ),
    };
  }

  // What a success is charged, fixed now so the stale-hold sweep can settle
  // this hold without re-pricing it: the catalog price of the tier sent
  // (Venice's default, the cheapest, when none was), bounded by the hold.
  const successCost = computeVeniceMultimodalCost({ endpoint: operation.endpoint, model: operation.model, metadata });
  const successListMicroUsd = successCost.priced ? successCost.listCostMicroUsd : estimate.listCostMicroUsd;
  const captureOnSuccessMicroUsd = Math.min(heldMicroUsd, applyVeniceMultimodalMarkup(successListMicroUsd, markup));

  try {
    await assertManagedVeniceWithinSpendCap({ userId: key.userId, addMicroUsd: heldMicroUsd }, db);
    await createManagedVeniceReservation(
      {
        userId: key.userId,
        walletType,
        amountMicroUsd: heldMicroUsd,
        estimatedCostMicroUsd: heldMicroUsd,
        referenceId,
        model: operation.model,
        endpoint: operation.endpoint,
        expiresAt: managedVeniceHoldExpiresAt(MANAGED_VENICE_MEDIA_HOLD_TTL_MS),
        metadata: {
          proxyKeyId: key.id,
          pricingPolicy: "multimodal_hold_before_forward",
          holdListCostMicroUsd: estimate.listCostMicroUsd,
          holdQuantity: estimate.quantity,
          holdTier: estimate.tier,
          captureOnSuccessMicroUsd,
          captureOnSuccessListMicroUsd: successListMicroUsd,
          markupFactor: markup,
          catalogUpdatedAt: VENICE_MULTIMODAL_PRICING_CATALOG_UPDATED_AT,
        },
      },
      db
    );
  } catch (error) {
    if (error instanceof ManagedVeniceInsufficientBalanceError) {
      log.warn("Managed Venice media request blocked by insufficient wallet balance", {
        ...logContext,
        failureType: "managed_venice_insufficient_balance",
        heldMicroUsd,
      });
      return {
        ok: false,
        response: billingError(
          402,
          "managed_venice_insufficient_balance",
          `Not enough Hivra LLM credits for this request (it needs up to ${usd(heldMicroUsd)}). ` +
            `Nothing was charged. Top up in Hivra: ${managedVeniceTopUpUrl(walletType)}`
        ),
      };
    }
    if (error instanceof ManagedVeniceSpendCapError) {
      log.warn("Managed Venice media request blocked by monthly spend cap", {
        ...logContext,
        failureType: "managed_venice_spend_cap_reached",
        capMicroUsd: error.capMicroUsd,
        spentMicroUsd: error.spentMicroUsd,
      });
      return {
        ok: false,
        response: billingError(
          402,
          "managed_venice_spend_cap_reached",
          `Monthly managed Venice spend cap reached. Manage your limit in Hivra: ${managedVeniceTopUpUrl(walletType)}`
        ),
      };
    }
    // Can't prove the wallet covers it -> fail closed; Venice is not called.
    log.error("Managed Venice media hold failed", error, {
      ...logContext,
      failureType: "managed_venice_media_hold_failed",
    });
    return {
      ok: false,
      response: billingError(
        503,
        "managed_venice_billing_unavailable",
        "Hivra couldn't check your credit balance, so the request was not sent. Please try again shortly."
      ),
    };
  }

  const release = async (reason: string, detail: { upstreamStatus?: number } = {}) => {
    try {
      await releaseManagedVeniceReservation({ userId: key.userId, referenceId }, db);
    } catch (error) {
      log.error("Managed Venice media hold release failed", error, {
        ...logContext,
        failureType: "managed_venice_media_release_failed",
        reason,
      });
      // The request failed upstream, so the hold must be released, not left
      // to expire (an expired hold with no item is captured). File it for the
      // stale-hold sweep, which releases it.
      try {
        await markManagedVeniceReconciliationRequired(
          {
            userId: key.userId,
            proxyKeyId: key.id,
            referenceId,
            reason: MEDIA_RELEASE_FAILED_RECONCILIATION_REASON,
            pauseKey: false,
            metadata: {
              endpoint: operation.endpoint,
              model: operation.model,
              heldMicroUsd,
              walletType,
              releaseReason: reason,
              upstreamStatus: detail.upstreamStatus ?? null,
            },
          },
          db
        );
      } catch (itemError) {
        log.error("Managed Venice media reconciliation item failed", itemError, {
          ...logContext,
          failureType: "managed_venice_media_reconciliation_item_failed",
          reason,
        });
      }
    }
  };

  const settle = async (outcome: ManagedVeniceMediaOutcome) => {
    const rowMetadata = { ...metadata, ...(outcome.metadata ?? {}) };

    // Settlement price = the catalog price of the tier that was sent (Venice's
    // default, the cheapest tier, when none was), the same number the offline
    // settlement would charge, bounded by the hold the wallet already covers.
    const cost = computeVeniceMultimodalCost({ endpoint: operation.endpoint, model: operation.model, metadata: rowMetadata });
    const listCostMicroUsd = cost.priced ? cost.listCostMicroUsd : estimate.listCostMicroUsd;
    const chargeMicroUsd = Math.min(heldMicroUsd, applyVeniceMultimodalMarkup(listCostMicroUsd, markup));

    try {
      await captureManagedVeniceReservation(
        { userId: key.userId, referenceId, captureMicroUsd: chargeMicroUsd },
        db
      );
    } catch (error) {
      // Keep the hold (it still backs the debt) and file it. The stale-hold
      // sweep captures it at this same price. The capture debits and closes
      // the hold in one transaction, so a retry can never charge twice.
      log.error("Managed Venice media capture failed", error, {
        ...logContext,
        failureType: "managed_venice_media_capture_failed",
        chargeMicroUsd,
      });
      try {
        await markManagedVeniceReconciliationRequired(
          {
            userId: key.userId,
            proxyKeyId: key.id,
            referenceId,
            reason: MEDIA_CAPTURE_FAILED_RECONCILIATION_REASON,
            pauseKey: false,
            metadata: {
              endpoint: operation.endpoint,
              model: operation.model,
              chargeMicroUsd,
              listCostMicroUsd,
              heldMicroUsd,
              walletType,
              upstreamStatus: outcome.upstreamStatus,
              upstreamRequestId: outcome.upstreamRequestId ?? null,
            },
          },
          db
        );
      } catch (itemError) {
        log.error("Managed Venice media reconciliation item failed", itemError, {
          ...logContext,
          failureType: "managed_venice_media_reconciliation_item_failed",
        });
      }
      return;
    }

    // Money has moved; the rest is the audit trail. A failure here must not
    // move money again, so it is logged, not retried.
    try {
      const client = db;
      if (!client) throw new Error("Database not configured");
      const account = await ensureManagedVeniceWalletAccount(key.userId, client);
      const { error: usageError } = await (client.from("managed_venice_usage_events") as InsertTable).insert({
        account_id: account.id,
        user_id: key.userId,
        proxy_key_id: key.id,
        wallet_type: walletType,
        endpoint: operation.endpoint,
        model: operation.model,
        estimated_cost_micro_usd: heldMicroUsd,
        actual_cost_micro_usd: listCostMicroUsd,
        charged_micro_usd: chargeMicroUsd,
        discount_micro_usd: 0,
        status: "recorded",
        upstream_status: outcome.upstreamStatus,
        upstream_request_id: outcome.upstreamRequestId ?? null,
        reference_id: referenceId,
        metadata: {
          ...rowMetadata,
          pricingPolicy: "multimodal_in_request_capture",
          settlement: {
            settledAt: new Date().toISOString(),
            catalogUpdatedAt: VENICE_MULTIMODAL_PRICING_CATALOG_UPDATED_AT,
            listCostMicroUsd,
            heldMicroUsd,
            markupFactor: markup,
            unit: cost.priced ? cost.unit : estimate.unit,
            quantity: cost.priced ? cost.quantity : estimate.quantity,
            tier: cost.priced ? cost.tier : estimate.tier,
          },
        },
      });
      if (usageError) throw new Error(usageError.message || "Failed to record managed Venice media usage");

      await appendManagedVeniceFinancialEvent(
        {
          userId: key.userId,
          accountId: account.id,
          walletType,
          eventType: "usage_capture",
          amountMicroUsd: chargeMicroUsd,
          veniceCostMicroUsd: listCostMicroUsd,
          discountMicroUsd: 0,
          referenceId,
          idempotencyKey: `managed_venice_multimodal_capture:${referenceId}`,
          metadata: {
            endpoint: operation.endpoint,
            model: operation.model,
            proxyKeyId: key.id,
            heldMicroUsd,
            markupFactor: markup,
            pricingPolicy: "multimodal_in_request_capture",
          },
        },
        client
      );
    } catch (error) {
      log.error("Managed Venice media audit write failed after capture", error, {
        ...logContext,
        failureType: "managed_venice_media_audit_write_failed",
        chargeMicroUsd,
      });
    }
  };

  return {
    ok: true,
    hold: {
      referenceId,
      walletType,
      heldMicroUsd,
      release,
      complete: async (outcome) => {
        if (outcome.ok) {
          await settle(outcome);
        } else {
          await release("upstream_non_2xx", { upstreamStatus: outcome.upstreamStatus });
        }
      },
    },
  };
}

export type ManagedVeniceMediaSendResult =
  | { ok: true; upstream: Response; body: ArrayBuffer | null; upstreamRequestId: string | null }
  | { ok: false; response: Response };

/**
 * Send one held request to Venice and settle the hold on the answer.
 *
 *   - Venice unreachable (fetch threw) -> release, 502.
 *   - otherwise `hold.complete` settles a 2xx and releases anything else. A
 *     2xx whose body can't be read is still settled (Venice ran and billed
 *     it); the caller gets a 502 because there is no body to hand back.
 *
 * `mode: "buffer"` reads the whole body (and Venice's request id from JSON);
 * `mode: "stream"` settles on the status alone and hands back the unread
 * upstream so binary/streamed audio and images pass through untouched.
 */
export async function sendManagedVeniceMediaRequest(params: {
  hold: ManagedVeniceMediaHold;
  send: () => Promise<Response>;
  mode: "buffer" | "stream";
  /** failureType for the 502 when Venice can't be reached. */
  fetchFailureType: string;
  outcomeMetadata?: (bodyText: string | null) => Record<string, unknown> | undefined;
}): Promise<ManagedVeniceMediaSendResult> {
  let upstream: Response;
  try {
    upstream = await params.send();
  } catch (error) {
    await params.hold.release("upstream_fetch_failed");
    return {
      ok: false,
      response: apiError(
        "Venice upstream request failed.",
        502,
        { failureType: params.fetchFailureType },
        undefined,
        { cause: error }
      ),
    };
  }

  let body: ArrayBuffer | null = null;
  let bodyText: string | null = null;
  if (params.mode === "buffer") {
    try {
      body = await upstream.arrayBuffer();
    } catch (error) {
      // Venice answered. A 2xx means it ran the request and billed Hivra even
      // though the body never reached us, so charge it like any success; only
      // a non-2xx is a failure to release (security review 2026-09).
      await params.hold.complete({
        ok: upstream.ok,
        upstreamStatus: upstream.status,
        upstreamRequestId: null,
        metadata: { upstreamBodyUnreadable: true },
      });
      return {
        ok: false,
        response: apiError(
          upstream.ok
            ? "Venice ran the request, but its response could not be read. The request was charged."
            : "Venice upstream response could not be read.",
          502,
          { failureType: `${params.fetchFailureType}_body` },
          undefined,
          { cause: error }
        ),
      };
    }
    if ((upstream.headers.get("content-type") || "").includes("json")) {
      bodyText = new TextDecoder().decode(body);
    }
  }

  const upstreamRequestId = bodyText ? readVeniceRequestId(bodyText) : null;
  await params.hold.complete({
    ok: upstream.ok,
    upstreamStatus: upstream.status,
    upstreamRequestId,
    metadata: params.outcomeMetadata?.(bodyText),
  });
  return { ok: true, upstream, body, upstreamRequestId };
}

/** Read Venice's request/queue id off a JSON body, when it has one. */
export function readVeniceRequestId(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    for (const field of ["queue_id", "id", "request_id"]) {
      if (typeof parsed?.[field] === "string") return parsed[field] as string;
    }
  } catch {
    // Binary or non-JSON body.
  }
  return null;
}

/** Normalize a numeric-or-string quantity field (Venice coerces strings). */
export function readNumericField(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value.trim()))) {
    return Number(value.trim());
  }
  return null;
}
