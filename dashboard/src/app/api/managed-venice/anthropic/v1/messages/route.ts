// Anthropic Messages → Venice (OpenAI-compat) shim.
//
// Lets a Claude Code box run inference through the managed-Venice gateway: it
// speaks the Anthropic Messages API, this route translates to/from Venice's
// OpenAI-compatible chat/completions, and billing reuses the exact chat
// reservation/settlement pipeline (the shim IS chat for metering).
//
// LIVE-VALIDATION PENDING (managed-Venice translation acceptance): the translator is
// spec-accurate and unit-tested, but claude-code stays gated (providers:[]) in
// the catalog until this is validated against a real Claude Code session.

export const runtime = "nodejs";
// The stream stops at MANAGED_VENICE_STREAM_DEADLINE_MS (270 s) and settles
// what it forwarded, so the platform never kills a request with its hold
// unsettled (security review 2026-09).
export const maxDuration = 300;

import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import { log } from "@/lib/logger";
import { type ManagedVeniceWalletType } from "@/lib/billing/managed-venice-wallets";
import { estimateChatCompletionCost } from "@/lib/venice/cost-estimator";
import { UnsupportedVeniceModelError } from "@/lib/venice/pricing";
import { getVenicePricingMap } from "@/lib/venice/live-pricing";
import { getDashboardOrigin } from "@/lib/venice/managed-endpoints";
import { verifyManagedVeniceProxyKey } from "@/lib/venice/proxy-keys";
import { resolveManagedVeniceUpstreamKey } from "@/lib/venice/upstream-keys";
import {
  reserveManagedVeniceChatRequest,
  captureManagedVeniceChatUsage,
  captureManagedVeniceObservedOutput,
  managedVeniceUsageCostMicroUsd,
  markManagedVeniceReconciliationRequired,
  releaseManagedVeniceChatReservationOrFile,
} from "@/lib/venice/proxy-settlement";
import { MissingVeniceUsageError } from "@/lib/venice/cost-estimator";
import { MANAGED_VENICE_STREAM_DEADLINE_MS } from "@/lib/venice/hold-lifecycle";
import { createManagedVeniceOutputMeter } from "@/lib/venice/stream-output-meter";
import { createManagedVeniceStreamSettlement, managedVeniceStreamDeadline } from "@/lib/venice/stream-settlement";
import { ManagedVeniceInsufficientBalanceError } from "@/lib/billing/managed-venice-wallets";
import { ManagedVeniceSpendCapError } from "@/lib/billing/managed-venice-spend-caps";
import {
  anthropicRequestToOpenAi,
  openAiResponseToAnthropic,
  AnthropicStreamTranslator,
} from "@/lib/venice/anthropic-openai-translate";

const VENICE_CHAT_COMPLETIONS_URL = "https://api.venice.ai/api/v1/chat/completions";

// Claude Code authenticates with `x-api-key`; also accept Bearer for parity
// with the rest of the gateway.
function readProxyKey(req: NextRequest): string | null {
  const xApiKey = req.headers.get("x-api-key")?.trim();
  if (xApiKey) return xApiKey;
  const auth = req.headers.get("authorization")?.trim() || "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim() || null;
  return null;
}

function anthropicError(params: { status: number; type: string; message: string }) {
  return new Response(
    JSON.stringify({ type: "error", error: { type: params.type, message: params.message } }),
    { status: params.status, headers: { "Content-Type": "application/json" } }
  );
}

function managedVeniceTopUpUrl(walletType: ManagedVeniceWalletType) {
  return `${getDashboardOrigin()}/dashboard/billing?managedVenice=deposit&wallet=${walletType === "card" ? "card" : "hermesos"}`;
}

function safeJsonParse(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  const plaintextKey = readProxyKey(req);
  if (!plaintextKey) return anthropicError({ status: 401, type: "authentication_error", message: "Missing API key" });

  const verifiedKey = await verifyManagedVeniceProxyKey({ plaintextKey });
  if (!verifiedKey) return anthropicError({ status: 401, type: "authentication_error", message: "Invalid API key" });

  let anthropicBody: Record<string, unknown>;
  try {
    anthropicBody = (await req.json()) as Record<string, unknown>;
  } catch {
    return anthropicError({ status: 400, type: "invalid_request_error", message: "Invalid JSON body" });
  }
  if (typeof anthropicBody.model !== "string" || !anthropicBody.model.trim()) {
    return anthropicError({ status: 400, type: "invalid_request_error", message: "model is required" });
  }
  if (anthropicBody.max_tokens == null) {
    return anthropicError({ status: 400, type: "invalid_request_error", message: "max_tokens is required" });
  }

  const isStream = anthropicBody.stream === true;
  const openAiBody = anthropicRequestToOpenAi(anthropicBody);
  const model = String(openAiBody.model);

  const livePricing = await getVenicePricingMap();
  const pricingMap = livePricing.map;
  try {
    estimateChatCompletionCost(openAiBody as { model: string; [key: string]: unknown }, pricingMap);
  } catch (error) {
    if (error instanceof UnsupportedVeniceModelError) {
      return anthropicError({
        status: 400,
        type: "invalid_request_error",
        message: `Unsupported Venice model "${model}". Pick a Venice model in the box's Inference settings.`,
      });
    }
    throw error;
  }

  const referenceId = randomUUID();
  const serverKey = resolveManagedVeniceUpstreamKey({
    referenceId,
    proxyKeyId: verifiedKey.id,
    model,
    endpoint: "/api/v1/chat/completions",
  })?.key;
  if (!serverKey) {
    return anthropicError({ status: 503, type: "api_error", message: "Managed Venice is not configured" });
  }

  const walletType = verifiedKey.defaultWalletType ?? "hermesos";

  try {
    await reserveManagedVeniceChatRequest({
      userId: verifiedKey.userId,
      proxyKeyId: verifiedKey.id,
      walletType,
      referenceId,
      requestBody: openAiBody as { model: string; [key: string]: unknown },
      pricingMap,
    });
  } catch (error) {
    if (error instanceof ManagedVeniceSpendCapError) {
      return anthropicError({
        status: 402,
        type: "billing_error",
        message: `Monthly managed Venice spend cap reached. Manage your limit in Hivra: ${managedVeniceTopUpUrl(walletType)}`,
      });
    }
    if (error instanceof ManagedVeniceInsufficientBalanceError) {
      return anthropicError({
        status: 402,
        type: "billing_error",
        message: `Insufficient managed Venice LLM credits. Top up in Hivra: ${managedVeniceTopUpUrl(walletType)}`,
      });
    }
    throw error;
  }

  const upstreamBody = isStream
    ? { ...openAiBody, stream: true, stream_options: { include_usage: true } }
    : { ...openAiBody, stream: false };

  // A refused request (or one that never reached Venice) gets its hold back.
  // If that release fails, an item is filed and the hourly sweep releases it:
  // the hold is never left to expire and be charged (security review 2026-09).
  const release = (cause: string, upstreamStatus: number | null = null) =>
    releaseManagedVeniceChatReservationOrFile({
      userId: verifiedKey.userId,
      proxyKeyId: verifiedKey.id,
      referenceId,
      cause,
      upstreamStatus,
      model,
      source: "managed-venice-anthropic",
    });
  // Venice answered 2xx but its usage never arrived: charge the input
  // estimate plus the output observed, never more than the hold.
  const chargeObserved = (observedOutputTokens: number, cause: string) =>
    captureManagedVeniceObservedOutput({
      userId: verifiedKey.userId,
      proxyKeyId: verifiedKey.id,
      referenceId,
      model,
      upstreamStatus: upstreamResponse.status,
      observedOutputTokens,
      cause,
      reconciliationReason: "managed_venice_anthropic_missing_usage",
      source: "managed-venice-anthropic",
    });
  const deadline = managedVeniceStreamDeadline(MANAGED_VENICE_STREAM_DEADLINE_MS);

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(VENICE_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${serverKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(upstreamBody),
      signal: deadline,
    });
  } catch (error) {
    await release(deadline.aborted ? "upstream_deadline" : "upstream_fetch_failed");
    return anthropicError({ status: 502, type: "api_error", message: `Venice upstream request failed: ${(error as Error).message}` });
  }

  // Upstream error: release the hold and surface a translated error. The user
  // isn't charged for a failed Venice call.
  if (!upstreamResponse.ok) {
    await release("upstream_non_2xx", upstreamResponse.status);
    const text = await upstreamResponse.text().catch(() => "");
    const parsed = safeJsonParse(text);
    const message =
      (parsed?.error && typeof parsed.error === "object" && "message" in (parsed.error as object)
        ? String((parsed.error as { message?: unknown }).message)
        : null) || `Venice returned ${upstreamResponse.status}`;
    return anthropicError({ status: upstreamResponse.status, type: "api_error", message });
  }

  // ---- non-streaming ----
  if (!isStream) {
    const text = await upstreamResponse.text().catch(() => null);
    const openAiJson = text === null ? null : safeJsonParse(text);
    if (!openAiJson) {
      // Venice answered 2xx, so it ran (and billed) the request, but the body
      // can't be read. Charge what was observed; never release a 2xx.
      const meter = createManagedVeniceOutputMeter();
      if (text) meter.observeUnparsedText(text);
      await chargeObserved(meter.outputTokens(), text === null ? "body_unreadable" : "unparseable_response");
      return anthropicError({ status: 502, type: "api_error", message: "Venice returned an unparseable response" });
    }
    try {
      await captureManagedVeniceChatUsage({
        userId: verifiedKey.userId,
        proxyKeyId: verifiedKey.id,
        walletType,
        referenceId,
        model,
        upstreamStatus: upstreamResponse.status,
        usage: openAiJson.usage,
        pricingMap,
      });
    } catch (error) {
      if (error instanceof MissingVeniceUsageError) {
        const meter = createManagedVeniceOutputMeter();
        meter.observeChatChunk(openAiJson);
        await chargeObserved(meter.outputTokens(), "missing_usage");
      } else {
        // 200 already paid for at Venice — file reconciliation with the
        // reported usage (the sweep charges it), keep the key live.
        await markManagedVeniceReconciliationRequired(
          {
            userId: verifiedKey.userId,
            proxyKeyId: verifiedKey.id,
            referenceId,
            reason: "managed_venice_anthropic_capture_failed",
            metadata: {
              model,
              error: (error as Error).message,
              usageCostMicroUsd: managedVeniceUsageCostMicroUsd({ model, usage: openAiJson.usage, pricingMap }),
            },
            pauseKey: false,
          }
        ).catch(() => {});
      }
    }
    const anthropicJson = openAiResponseToAnthropic(openAiJson, model);
    return new Response(JSON.stringify(anthropicJson), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // ---- streaming: transform OpenAI SSE → Anthropic SSE, capture at end ----
  const translator = new AnthropicStreamTranslator(model, `msg_${referenceId.replace(/-/g, "").slice(0, 24)}`);
  const upstream = upstreamResponse.body;
  if (!upstream) {
    // A 2xx with no body: nothing was generated that anyone can see.
    await chargeObserved(0, "stream_missing_body");
    return anthropicError({ status: 502, type: "api_error", message: "Venice returned an empty stream" });
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const reader = upstream.getReader();
  let buffer = "";
  let cancelled = false;
  // Venice answered 200, so the hold is never released. A stream without a
  // usage frame (the client disconnected, the deadline passed, Venice left
  // it out) is charged its input estimate plus the output forwarded so far
  // (stream-settlement.ts), not a flat estimate: a client that read a whole
  // answer and dropped the socket before the usage frame used to pay cents
  // for dollars of output (security review 2026-09).
  const settlement = createManagedVeniceStreamSettlement({
    userId: verifiedKey.userId,
    proxyKeyId: verifiedKey.id,
    referenceId,
    walletType,
    model,
    upstreamStatus: upstreamResponse.status,
    pricingMap,
    source: "managed-venice-anthropic",
    route: "/api/managed-venice/anthropic/v1/messages",
    reasons: {
      usageMissing: () => "managed_venice_anthropic_missing_usage",
      captureFailed: () => "managed_venice_anthropic_stream_capture_failed",
    },
  });

  const translate = (frame: string, controller: ReadableStreamDefaultController<Uint8Array>) => {
    for (const line of frame.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      const chunk = safeJsonParse(data);
      if (!chunk) continue;
      settlement.meter.observeChatChunk(chunk);
      if (chunk.usage) settlement.observeUsage(chunk.usage);
      const out = translator.chunk(chunk);
      if (out) controller.enqueue(encoder.encode(out));
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const onDeadline = () => void reader.cancel().catch(() => undefined);
      deadline.addEventListener("abort", onDeadline, { once: true });
      if (deadline.aborted) onDeadline();
      let failed = false;
      try {
        controller.enqueue(encoder.encode(translator.start()));
        while (true) {
          const { done, value } = await reader.read();
          if (done || cancelled || deadline.aborted) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split(/\r?\n\r?\n/);
          buffer = frames.pop() ?? "";
          for (const frame of frames) translate(frame, controller);
        }
        if (!cancelled && !deadline.aborted) {
          buffer += decoder.decode();
          if (buffer) translate(buffer, controller);
          buffer = "";
          controller.enqueue(encoder.encode(translator.finish()));
        }
      } catch (error) {
        failed = true;
        if (!cancelled) {
          log.warn("managed Venice anthropic stream transform failed mid-stream", {
            source: "managed-venice-anthropic",
            route: "/api/managed-venice/anthropic/v1/messages",
            failureType: "managed_venice_anthropic_stream_error",
            userId: verifiedKey.userId,
            proxyKeyId: verifiedKey.id,
            referenceId,
            errorMessage: error instanceof Error ? error.message : String(error),
          });
        }
      } finally {
        deadline.removeEventListener("abort", onDeadline);
      }
      // Once the client has gone, cancel() owns settlement and the
      // controller is already closed.
      if (cancelled) {
        await settlement.settle("client_cancelled");
        return;
      }
      await settlement.settle(deadline.aborted ? "deadline" : failed ? "upstream_failed" : "completed");
      try {
        controller.close();
      } catch {
        // The client went away while settlement ran.
      }
    },
    async cancel() {
      cancelled = true;
      const settled = settlement.settle("client_cancelled");
      // Stop reading so Venice stops generating for a reader that has gone.
      await reader.cancel().catch(() => undefined);
      await settled;
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    },
  });
}
