import { randomUUID } from "node:crypto";
import { responsesEstimateRequest, VENICE_RESPONSES_ENDPOINT, VENICE_RESPONSES_URL } from "./responses-protocol";

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
  estimateChatCompletionCost,
  type VenicePricingMap,
} from "@/lib/venice/cost-estimator";
import {
  planManagedChatSurcharges,
  type ManagedChatSurchargeEvidence,
  type ManagedChatSurchargePlan,
} from "@/lib/venice/chat-surcharges";
import { getVenicePricingMap } from "@/lib/venice/live-pricing";
import { getDashboardOrigin } from "@/lib/venice/managed-endpoints";
import { verifyManagedVeniceProxyKey } from "@/lib/venice/proxy-keys";
import { resolveManagedVeniceUpstreamKey } from "@/lib/venice/upstream-keys";
import {
  captureManagedVeniceChatUsage,
  markManagedVeniceReconciliationRequired,
  reserveManagedVeniceChatRequest,
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
}

export type AuthorizeManagedVeniceChatResult =
  | { ok: true; value: AuthorizedManagedVeniceChat }
  // `response` is the verbatim error (401/400/402/503) to relay to the caller
  // (and, through the Worker, to the box). OpenAI-compatible bodies preserved.
  | { ok: false; response: Response };

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
}): Promise<AuthorizeManagedVeniceChatResult> {
  const { plaintextKey, body } = params;

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
  // Options Venice bills on top of tokens (web search, scraping, X search) are
  // held here and charged at capture. One this can't price is refused before
  // any hold: the Worker forwards its own copy of the body, so refusing here
  // is the only control on that path. Responses has its own allowlist.
  let surcharge: ManagedChatSurchargePlan | null = null;
  if (params.protocol !== "responses") {
    const planned = planManagedChatSurcharges(body);
    if (!planned.ok) {
      return {
        ok: false,
        response: openAiCompatibleError({
          status: 400,
          code: "managed_venice_unpriced_option",
          type: "invalid_request_error",
          message: planned.error,
        }),
      };
    }
    surcharge = planned.plan;
  }
  const endpoint = params.protocol === "responses" ? VENICE_RESPONSES_ENDPOINT : "/api/v1/chat/completions";
  const estimateBody = params.protocol === "responses" ? responsesEstimateRequest(body) : body as { model: string; [key: string]: unknown };

  // Live Venice pricing — fetched + cached at module level for 5 minutes.
  // Cache hits cost ~6× less than full input on most models; without this
  // every cache-served token bills at the input rate and we over-bill users.
  // Static catalog is the fallback when /v1/models is unreachable.
  const livePricing = await getVenicePricingMap();
  const pricingMap = livePricing.map;

  try {
    estimateChatCompletionCost(
      estimateBody,
      pricingMap
    );
  } catch (error) {
    if (error instanceof UnsupportedVeniceModelError) {
      return {
        ok: false,
        response: apiError("Unsupported Venice model.", 400, {
          failureType: "managed_venice_unsupported_model",
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

  const referenceId = randomUUID();
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

  let reservation: Awaited<ReturnType<typeof reserveManagedVeniceChatRequest>>;
  try {
    reservation = await reserveManagedVeniceChatRequest({
      userId: verifiedKey.userId,
      proxyKeyId: verifiedKey.id,
      walletType,
      referenceId,
      requestBody: estimateBody,
      ...(params.protocol === "responses" ? { endpoint: VENICE_RESPONSES_ENDPOINT } : {}),
      pricingMap,
      surcharge,
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
      reservationId: reservation.reservationId,
      upstreamKey: serverKey,
      upstreamUrl: params.protocol === "responses" ? VENICE_RESPONSES_URL : VENICE_CHAT_COMPLETIONS_URL,
      walletType,
      userId: verifiedKey.userId,
      proxyKeyId: verifiedKey.id,
      model: body.model,
      pricingMap,
      pricingSource: livePricing.source,
      liveModelCount: livePricing.liveModelCount,
    },
  };
}

/**
 * Settle a streamed chat completion against its reservation, given the `usage`
 * frame the streamer extracted (or null if none was seen). Mirrors the inline
 * settlement semantics of `createSettlingStream`:
 *  - usage present  -> capture actual cost (closes the hold; overage debited)
 *  - usage missing  -> file reconciliation, KEEP key live (telemetry gap)
 *  - capture throws -> file reconciliation, KEEP key live (our bug, not theirs)
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
  pricingMap?: VenicePricingMap;
  surchargeEvidence?: ManagedChatSurchargeEvidence;
}): Promise<{ settled: boolean; reconciled: boolean }> {
  const pricingMap =
    params.pricingMap ?? (await getVenicePricingMap()).map;

  try {
    if (params.usage != null) {
      await captureManagedVeniceChatUsage({
        userId: params.userId,
        proxyKeyId: params.proxyKeyId,
        walletType: params.walletType,
        referenceId: params.referenceId,
        model: params.model,
        upstreamStatus: params.upstreamStatus,
        usage: params.usage,
        pricingMap,
        surchargeEvidence: params.surchargeEvidence,
      });
      return { settled: true, reconciled: false };
    }

    await markManagedVeniceReconciliationRequired({
      userId: params.userId,
      proxyKeyId: params.proxyKeyId,
      referenceId: params.referenceId,
      reason: "managed_venice_missing_stream_usage",
      metadata: { model: params.model, upstreamStatus: params.upstreamStatus },
      // Upstream succeeded; we just couldn't read a usage frame. The
      // reservation is still held and the invoice cron settles offline —
      // don't brick the key over a telemetry gap.
      pauseKey: false,
    });
    return { settled: false, reconciled: true };
  } catch (error) {
    await markManagedVeniceReconciliationRequired({
      userId: params.userId,
      proxyKeyId: params.proxyKeyId,
      referenceId: params.referenceId,
      reason: "managed_venice_stream_settlement_failed",
      metadata: {
        model: params.model,
        upstreamStatus: params.upstreamStatus,
        errorType: error instanceof Error ? error.name : typeof error,
      },
      // Our settlement code threw on an otherwise-successful stream. That's
      // our bug to reconcile, not the user's to be denied service over.
      pauseKey: false,
    });
    return { settled: false, reconciled: true };
  }
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
