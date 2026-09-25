import { randomUUID } from "node:crypto";
import { VENICE_RESPONSES_ENDPOINT, VENICE_RESPONSES_URL } from "./responses-protocol";

import { apiError } from "@/lib/api-response";
import { log } from "@/lib/logger";
import {
  ManagedVeniceInsufficientBalanceError,
  type ManagedVeniceWalletType,
} from "@/lib/billing/managed-venice-wallets";
import { ManagedVeniceSpendCapError } from "@/lib/billing/managed-venice-spend-caps";
import {
  UnsupportedVeniceModelError,
  checkVeniceChatPricingCatalogStaleness,
} from "@/lib/venice/pricing";
import {
  InvalidVeniceChatRequestError,
  estimateChatCompletionCost,
  type VenicePricingMap,
} from "@/lib/venice/cost-estimator";
import {
  managedVeniceChatEstimateBody,
  reserveManagedVeniceChatWithinBalance,
  unbilledVeniceChatOption,
  type ManagedVeniceOutputCapPatch,
} from "@/lib/venice/chat-output-budget";
import { getVenicePricingMap } from "@/lib/venice/live-pricing";
import { getDashboardOrigin } from "@/lib/venice/managed-endpoints";
import { verifyManagedVeniceProxyKey } from "@/lib/venice/proxy-keys";
import { resolveManagedVeniceUpstreamKey } from "@/lib/venice/upstream-keys";
import {
  captureManagedVeniceChatUsage,
  captureManagedVeniceObservedOutput,
  loadManagedVeniceReservationOwner,
  managedVeniceUsageCostMicroUsd,
  markManagedVeniceReconciliationRequired,
} from "@/lib/venice/proxy-settlement";

// SCRIPTURE_ANCHOR: venice-stream | Proverbs 18:4 | Verse: The words of a man's mouth are like deep waters. The fountain of wisdom is like a flowing brook.
export const VENICE_CHAT_COMPLETIONS_URL =
  "https://api.venice.ai/api/v1/chat/completions";

// Single source of truth for the chat proxy's authorize + settle steps so the
// in-Vercel route (`/api/managed-venice/v1/chat/completions`) and the off-Vercel
// Cloudflare Worker path (`/api/managed-venice/internal/{authorize,settle}`)
// can NEVER drift on wallet/billing semantics. The Worker holds the long-lived
// streaming connection (cheap edge egress) while these two short calls keep all
// reservation/settlement logic on Vercel against Supabase. See
// docs/PRODUCT-ARCHITECTURE.md.

export function managedVeniceTopUpUrl(walletType: ManagedVeniceWalletType) {
  const wallet = walletType === "card" ? "card" : "hermesos";
  return `${getDashboardOrigin()}/dashboard/billing?managedVenice=deposit&wallet=${wallet}`;
}

function openAiCompatibleError(params: {
  message: string;
  status: number;
  code: string;
  type: string;
  param?: string | null;
}) {
  return new Response(
    JSON.stringify({
      error: {
        message: params.message,
        type: params.type,
        param: params.param ?? null,
        code: params.code,
      },
    }),
    {
      status: params.status,
      headers: { "Content-Type": "application/json" },
    }
  );
}

interface AuthorizedManagedVeniceChat {
  referenceId: string;
  reservationId: string;
  /** Resolved upstream Venice key for THIS request (pool selection stays centralized). */
  upstreamKey: string;
  upstreamUrl: string;
  walletType: ManagedVeniceWalletType;
  userId: string;
  proxyKeyId: string;
  model: string;
  pricingMap: VenicePricingMap;
  pricingSource: string;
  liveModelCount: number;
  /**
   * Output-cap fields to overwrite in the caller's body before it is sent to
   * Venice, so the forwarded request cannot generate more than was held. Empty
   * when the body goes out as sent. Always empty when `allowBodyRewrite` was
   * false. Every forwarder MUST apply it.
   */
  bodyPatch: ManagedVeniceOutputCapPatch;
}

export type AuthorizeManagedVeniceChatResult =
  | { ok: true; value: AuthorizedManagedVeniceChat }
  // `response` is the verbatim error (401/400/402/503) to relay to the caller
  // (and, through the Worker, to the box). OpenAI-compatible bodies preserved.
  | { ok: false; response: Response };

const REFERENCE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requestsStrippedThinking(body: Record<string, unknown>): boolean {
  const veniceParameters = body.venice_parameters;
  if (!veniceParameters || typeof veniceParameters !== "object" || Array.isArray(veniceParameters)) return false;
  const strip = (veniceParameters as Record<string, unknown>).strip_thinking_response;
  return strip !== undefined && strip !== null && strip !== false;
}

/**
 * Verify the proxy key, validate the model, fetch live pricing, reserve wallet
 * funds (enforcing balance + spend caps), and resolve the upstream Venice key.
 * Everything up to — but not including — the upstream fetch. Returns either an
 * authorized context or the exact error Response to relay.
 */
export async function authorizeManagedVeniceChat(params: {
  plaintextKey: string | null;
  body: Record<string, unknown>;
  protocol?: "responses";
  /**
   * Whether the caller forwards `{...body, ...bodyPatch}`. Default true. The
   * off-Vercel Worker sets it only once it applies the patch; until then its
   * requests hold their full worst case and are never given a lower cap.
   */
  allowBodyRewrite?: boolean;
  /**
   * The Cloudflare Worker chooses the hold's reference (a fresh UUID) before
   * it calls authorize, so it can release the hold even when the authorize
   * response never reaches it. Omitted, a reference is generated here.
   */
  referenceId?: string;
}): Promise<AuthorizeManagedVeniceChatResult> {
  if (params.referenceId !== undefined && !REFERENCE_ID_PATTERN.test(params.referenceId)) {
    return {
      ok: false,
      response: apiError("Invalid request reference.", 400, {
        failureType: "managed_venice_invalid_reference_id",
      }),
    };
  }
  const { plaintextKey, body } = params;
  const protocol = params.protocol === "responses" ? "responses" : "chat";

  if (!plaintextKey) {
    return { ok: false, response: apiError("Unauthorized", 401) };
  }

  const verifiedKey = await verifyManagedVeniceProxyKey({ plaintextKey });
  if (!verifiedKey) {
    return { ok: false, response: apiError("Unauthorized", 401) };
  }

  if (typeof body.model !== "string" || !body.model.trim()) {
    return { ok: false, response: apiError("Model is required.", 400) };
  }
  // Venice leaves a reasoning model's thinking out of the stream when asked
  // to strip it, so a stream whose usage frame never arrives could not be
  // charged for it (security review 2026-09, #167 second review).
  if (requestsStrippedThinking(body)) {
    return {
      ok: false,
      response: apiError(
        "venice_parameters.strip_thinking_response is not supported on managed Venice. Use disable_thinking to skip reasoning.",
        400,
        { failureType: "managed_venice_strip_thinking_unsupported" }
      ),
    };
  }
  const endpoint = protocol === "responses" ? VENICE_RESPONSES_ENDPOINT : "/api/v1/chat/completions";

  // Options Venice bills outside token usage cannot be covered by a token
  // hold. (The Responses allowlist already refuses every one of them.)
  const unbilled = protocol === "chat" ? unbilledVeniceChatOption(body) : null;
  if (unbilled) {
    return {
      ok: false,
      response: openAiCompatibleError({
        status: 400,
        code: "managed_venice_unsupported_option",
        type: "invalid_request_error",
        param: unbilled,
        message:
          `${unbilled} is not available on managed Venice: Venice bills it separately ` +
          `from tokens. Remove it or use your own Venice key.`,
      }),
    };
  }

  // Live Venice pricing — fetched + cached at module level for 5 minutes.
  // Cache hits cost ~6× less than full input on most models; without this
  // every cache-served token bills at the input rate and we over-bill users.
  // Static catalog is the fallback when /v1/models is unreachable.
  const livePricing = await getVenicePricingMap();
  const pricingMap = livePricing.map;

  try {
    estimateChatCompletionCost(managedVeniceChatEstimateBody(protocol, body), pricingMap);
  } catch (error) {
    if (error instanceof UnsupportedVeniceModelError) {
      return {
        ok: false,
        response: apiError("Unsupported Venice model.", 400, {
          failureType: "managed_venice_unsupported_model",
        }),
      };
    }
    if (error instanceof InvalidVeniceChatRequestError) {
      return {
        ok: false,
        response: openAiCompatibleError({
          status: 400,
          code: "invalid_request",
          type: "invalid_request_error",
          message: error.message,
        }),
      };
    }
    throw error;
  }

  // Catalog staleness check. We don't fail closed — Venice may have re-priced
  // models since our last snapshot and we'd rather charge the old rate than
  // 503 the user. But page hard so the operator can refresh the catalog
  // before the drift compounds across many requests.
  const staleness = checkVeniceChatPricingCatalogStaleness();
  if (staleness.stale) {
    log.warn(
      "Managed Venice pricing catalog is stale; settlements may drift from Venice's live prices",
      {
        source: "managed-venice-chat",
        route: "/api/managed-venice/v1/chat/completions",
        method: "POST",
        failureType: "managed_venice_pricing_catalog_stale",
        catalogUpdatedAt: staleness.updatedAt,
        catalogAgeDays: staleness.ageDays,
        catalogMaxAgeDays: staleness.maxAgeDays,
        model: body.model,
        userId: verifiedKey.userId,
        proxyKeyId: verifiedKey.id,
      }
    );
  }

  const referenceId = params.referenceId ?? randomUUID();
  // A caller-chosen reference must be new, for every user: reusing one would
  // find the old (possibly settled) hold and forward a request with nothing
  // held for it, or touch another user's hold (#167 second review).
  if (params.referenceId && (await loadManagedVeniceReservationOwner(params.referenceId))) {
    return {
      ok: false,
      response: apiError("Duplicate request reference.", 409, {
        failureType: "managed_venice_duplicate_reference_id",
      }),
    };
  }
  const serverKey = resolveManagedVeniceUpstreamKey({
    referenceId,
    proxyKeyId: verifiedKey.id,
    model: body.model,
    endpoint,
  })?.key;
  if (!serverKey) {
    return {
      ok: false,
      response: apiError("Managed Venice is not configured.", 503, {
        failureType: "managed_venice_server_key_missing",
      }),
    };
  }

  const walletType = verifiedKey.defaultWalletType ?? "hermesos";

  let budgeted: Awaited<ReturnType<typeof reserveManagedVeniceChatWithinBalance>>;
  try {
    budgeted = await reserveManagedVeniceChatWithinBalance({
      userId: verifiedKey.userId,
      proxyKeyId: verifiedKey.id,
      walletType,
      referenceId,
      protocol,
      body,
      pricingMap,
      allowBodyRewrite: params.allowBodyRewrite !== false,
      route: protocol === "responses" ? "/api/managed-venice/v1/responses" : "/api/managed-venice/v1/chat/completions",
    });
  } catch (error) {
    if (error instanceof ManagedVeniceSpendCapError) {
      // Protective cap, not an empty wallet — the key stays active; the user
      // (or ops) raises the cap or waits for the month to roll over.
      log.warn("Managed Venice request blocked by monthly spend cap", {
        source: "managed-venice-chat",
        route: "/api/managed-venice/v1/chat/completions",
        method: "POST",
        failureType: "managed_venice_spend_cap_reached",
        userId: verifiedKey.userId,
        proxyKeyId: verifiedKey.id,
        walletType,
        capMicroUsd: error.capMicroUsd,
        spentMicroUsd: error.spentMicroUsd,
      });
      return {
        ok: false,
        response: openAiCompatibleError({
          status: 402,
          code: "managed_venice_spend_cap_reached",
          type: "billing_error",
          message:
            `Monthly managed Venice spend cap reached. Manage your limit in Hivra: ` +
            `${managedVeniceTopUpUrl(walletType)}`,
        }),
      };
    }
    if (error instanceof ManagedVeniceInsufficientBalanceError) {
      const topUpUrl = managedVeniceTopUpUrl(walletType);
      log.warn("Managed Venice proxy key blocked by insufficient wallet balance", {
        source: "managed-venice-chat",
        route: "/api/managed-venice/v1/chat/completions",
        method: "POST",
        failureType: "managed_venice_insufficient_balance",
        userId: verifiedKey.userId,
        proxyKeyId: verifiedKey.id,
        walletType,
      });
      return {
        ok: false,
        response: openAiCompatibleError({
          status: 402,
          code: "managed_venice_insufficient_balance",
          type: "billing_error",
          message:
            `Insufficient managed Venice LLM credits. Top up LLM credits in Hivra ` +
            `to keep this proxy key active: ${topUpUrl}`,
        }),
      };
    }
    throw error;
  }

  return {
    ok: true,
    value: {
      referenceId,
      reservationId: budgeted.reservation.reservationId,
      upstreamKey: serverKey,
      upstreamUrl: protocol === "responses" ? VENICE_RESPONSES_URL : VENICE_CHAT_COMPLETIONS_URL,
      walletType,
      userId: verifiedKey.userId,
      proxyKeyId: verifiedKey.id,
      model: body.model,
      pricingMap,
      pricingSource: livePricing.source,
      liveModelCount: livePricing.liveModelCount,
      bodyPatch: budgeted.bodyPatch,
    },
  };
}

/**
 * Settle a streamed chat completion against its reservation, given the `usage`
 * frame the streamer extracted (or null if none was seen). Mirrors the inline
 * settlement of the chat route (stream-settlement.ts):
 *  - usage present  -> capture actual cost (closes the hold; overage debited)
 *  - usage missing  -> capture the input estimate plus `observedOutputTokens`,
 *                      the output the Worker read from Venice (past the hold,
 *                      as an overage); key stays live
 *  - capture throws -> file reconciliation with the reported cost (the
 *                      stale-hold sweep charges it); key stays live
 * A Worker from before observed output was counted sends no
 * `observedOutputTokens`; its usage-less streams are filed for the sweep,
 * which charges the hold's estimate.
 *
 * Throws only when nothing could be written (not even the reconciliation
 * item), so the settle route answers 5xx and the Worker retries.
 *
 * Used by the off-Vercel Worker via /api/managed-venice/internal/settle. The
 * `pricingMap` defaults to the live (module-cached) map; within the 5-minute
 * cache window this is the same map authorize used, so the settled cost matches
 * what an inline settlement would have charged.
 */
export async function settleManagedVeniceChatUsage(params: {
  userId: string;
  proxyKeyId: string;
  walletType: ManagedVeniceWalletType;
  referenceId: string;
  model: string;
  upstreamStatus: number;
  usage: unknown;
  observedOutputTokens?: number | null;
  cause?: string | null;
  pricingMap?: VenicePricingMap;
}): Promise<{ settled: boolean; reconciled: boolean }> {
  const pricingMap =
    params.pricingMap ?? (await getVenicePricingMap()).map;
  const cause = params.cause || "completed";

  if (params.usage != null) {
    try {
      await captureManagedVeniceChatUsage({
        userId: params.userId,
        proxyKeyId: params.proxyKeyId,
        walletType: params.walletType,
        referenceId: params.referenceId,
        model: params.model,
        upstreamStatus: params.upstreamStatus,
        usage: params.usage,
        pricingMap,
      });
      return { settled: true, reconciled: false };
    } catch (error) {
      await markManagedVeniceReconciliationRequired({
        userId: params.userId,
        proxyKeyId: params.proxyKeyId,
        referenceId: params.referenceId,
        reason: "managed_venice_stream_settlement_failed",
        metadata: {
          model: params.model,
          upstreamStatus: params.upstreamStatus,
          cause,
          errorType: error instanceof Error ? error.name : typeof error,
          usageCostMicroUsd: managedVeniceUsageCostMicroUsd({ model: params.model, usage: params.usage, pricingMap }),
          observedOutputTokens: params.observedOutputTokens ?? null,
        },
        // Our settlement code threw on an otherwise-successful stream. That's
        // our bug to reconcile, not the user's to be denied service over.
        pauseKey: false,
      });
      return { settled: false, reconciled: true };
    }
  }

  const reconciliationReason =
    cause === "completed" ? "managed_venice_missing_stream_usage" : "managed_venice_stream_settlement_failed";
  if (typeof params.observedOutputTokens === "number") {
    const observed = await captureManagedVeniceObservedOutput({
      userId: params.userId,
      proxyKeyId: params.proxyKeyId,
      referenceId: params.referenceId,
      model: params.model,
      upstreamStatus: params.upstreamStatus,
      observedOutputTokens: params.observedOutputTokens,
      cause,
      reconciliationReason,
      source: "managed-venice-internal-settle",
    });
    if (observed.outcome === "unfiled") {
      throw new Error("Managed Venice could not charge or file a usage-less stream");
    }
    return {
      settled: observed.outcome === "captured" || observed.outcome === "already_settled",
      reconciled: observed.outcome === "filed_for_sweep",
    };
  }

  await markManagedVeniceReconciliationRequired({
    userId: params.userId,
    proxyKeyId: params.proxyKeyId,
    referenceId: params.referenceId,
    reason: reconciliationReason,
    metadata: { model: params.model, upstreamStatus: params.upstreamStatus, cause },
    // Upstream succeeded; we just couldn't read a usage frame. The hold is
    // still held and the stale-hold sweep charges its estimate. Don't brick
    // the key over a telemetry gap.
    pauseKey: false,
  });
  return { settled: false, reconciled: true };
}

/** Shared SSE usage-frame extraction (used by the in-Vercel streamer + Worker). */
export function readUsageFromSseFrame(frame: string) {
  const dataLines = frame
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());

  for (const data of dataLines) {
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data) as Record<string, unknown>;
      if (parsed?.usage) return parsed.usage;
    } catch {
      // non-JSON keep-alive / comment frame
    }
  }

  return null;
}
