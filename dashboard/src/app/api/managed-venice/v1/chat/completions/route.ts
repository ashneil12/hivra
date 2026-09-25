import { NextRequest } from "next/server";

import { apiError } from "@/lib/api-response";
import { log } from "@/lib/logger";
import { type ManagedVeniceWalletType } from "@/lib/billing/managed-venice-wallets";
import {
  MissingVeniceUsageError,
  type VenicePricingMap,
} from "@/lib/venice/cost-estimator";
import {
  captureManagedVeniceChatUsage,
  captureManagedVeniceObservedOutput,
  releaseManagedVeniceChatReservationOrFile,
} from "@/lib/venice/proxy-settlement";
import { CHAT_STREAM_CANCELLED_RECONCILIATION_REASON } from "@/lib/venice/chat-stream-reconciliation";
import { MANAGED_VENICE_STREAM_DEADLINE_MS } from "@/lib/venice/hold-lifecycle";
import { createManagedVeniceOutputMeter } from "@/lib/venice/stream-output-meter";
import {
  createManagedVeniceStreamSettlement,
  managedVeniceStreamDeadline,
  type ManagedVeniceStreamOutcome,
} from "@/lib/venice/stream-settlement";
// Shared authorize/settle core — keeps the in-Vercel route and the off-Vercel
// Cloudflare Worker (internal/{authorize,settle}) from drifting on billing
// semantics. See docs/PRODUCT-ARCHITECTURE.md.
import { authorizeManagedVeniceChat } from "@/lib/venice/proxy-chat-core";

const ROUTE = "/api/managed-venice/v1/chat/completions";

// The stream stops at MANAGED_VENICE_STREAM_DEADLINE_MS (270 s) and settles
// what it forwarded, so the platform never kills a request with its hold
// unsettled (security review 2026-09).
export const maxDuration = 300;

function readBearerKey(req: NextRequest) {
  const header = req.headers.get("authorization")?.trim() || "";
  if (!header.toLowerCase().startsWith("bearer ")) return null;
  return header.slice(7).trim() || null;
}

function jsonResponseFromText(text: string, status: number) {
  return new Response(text, {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function safeJsonParse(text: string) {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function createSettlingStream(params: {
  upstream: ReadableStream<Uint8Array>;
  verifiedKey: { id: string; userId: string };
  walletType: ManagedVeniceWalletType;
  referenceId: string;
  model: string;
  upstreamStatus: number;
  pricingMap: VenicePricingMap;
  deadline: AbortSignal;
}) {
  const decoder = new TextDecoder();
  const reader = params.upstream.getReader();
  let buffer = "";
  let cancelled = false;
  // Venice answered 200 before this stream was built, so it is generating,
  // and billing Hivra, for this request. The hold is never released: a
  // stream without a usage frame is charged its input estimate plus the
  // output forwarded so far (stream-settlement.ts). Counting that output is
  // what stops a client reading a whole answer and closing the socket just
  // before the usage frame from paying a flat estimate instead
  // (security review 2026-09).
  const settlement = createManagedVeniceStreamSettlement({
    userId: params.verifiedKey.userId,
    proxyKeyId: params.verifiedKey.id,
    referenceId: params.referenceId,
    walletType: params.walletType,
    model: params.model,
    upstreamStatus: params.upstreamStatus,
    pricingMap: params.pricingMap,
    source: "managed-venice-chat",
    route: ROUTE,
    reasons: {
      usageMissing: (outcome) =>
        outcome === "client_cancelled"
          ? CHAT_STREAM_CANCELLED_RECONCILIATION_REASON
          : outcome === "completed"
            ? "managed_venice_missing_stream_usage"
            : "managed_venice_stream_settlement_failed",
      captureFailed: (outcome) =>
        outcome === "client_cancelled"
          ? CHAT_STREAM_CANCELLED_RECONCILIATION_REASON
          : "managed_venice_stream_settlement_failed",
    },
  });

  function observe(chunk: Uint8Array) {
    buffer += decoder.decode(chunk, { stream: true });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      settlement.observeUsage(settlement.meter.observeChatSseFrame(frame));
    }
  }

  function settle(outcome: ManagedVeniceStreamOutcome) {
    if (outcome !== "completed") {
      log.warn("Managed Venice chat stream ended before it completed", {
        source: "managed-venice-chat",
        route: ROUTE,
        failureType: `managed_venice_chat_stream_${outcome}`,
        userId: params.verifiedKey.userId,
        proxyKeyId: params.verifiedKey.id,
        referenceId: params.referenceId,
        model: params.model,
        observedOutputTokens: settlement.meter.outputTokens(),
      });
    }
    return settlement.settle(outcome);
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      // At the deadline stop reading Venice (which stops it generating) and
      // settle what was forwarded.
      const onDeadline = () => void reader.cancel().catch(() => undefined);
      params.deadline.addEventListener("abort", onDeadline, { once: true });
      if (params.deadline.aborted) onDeadline();
      let upstreamError: unknown = null;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done || cancelled || params.deadline.aborted) break;
          if (!value) continue;
          observe(value);
          controller.enqueue(value);
        }
        buffer += decoder.decode();
        // A usage frame that arrived without its trailing blank line still counts.
        if (buffer) settlement.observeUsage(settlement.meter.observeChatSseFrame(buffer));
        buffer = "";
      } catch (error) {
        upstreamError = error;
      } finally {
        params.deadline.removeEventListener("abort", onDeadline);
      }

      // Once the client has gone, cancel() owns settlement; the controller is
      // already closed, so there is nothing left to close or error here.
      if (cancelled) {
        await settlement.settle("client_cancelled");
        return;
      }
      if (params.deadline.aborted) {
        await settle("deadline");
        controller.error(new Error("Managed Venice stream reached its time limit"));
        return;
      }
      if (upstreamError) {
        await settle("upstream_failed");
        controller.error(upstreamError);
        return;
      }
      const settlementError = await settle("completed");
      if (settlementError) {
        controller.error(settlementError);
        return;
      }
      controller.close();
    },
    async cancel() {
      cancelled = true;
      // A usage frame that arrived without its trailing blank line still counts.
      if (buffer) settlement.observeUsage(settlement.meter.observeChatSseFrame(buffer));
      buffer = "";
      const settled = settle("client_cancelled");
      // Stop reading so Venice stops generating for a reader that has gone.
      await reader.cancel().catch(() => undefined);
      await settled;
    },
  });
}

export async function POST(req: NextRequest) {
  const plaintextKey = readBearerKey(req);
  if (!plaintextKey) return apiError("Unauthorized", 401);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return apiError("Invalid JSON body.", 400);
  }

  const auth = await authorizeManagedVeniceChat({ plaintextKey, body });
  if (!auth.ok) return auth.response;

  const {
    referenceId,
    reservationId,
    upstreamKey: serverKey,
    upstreamUrl,
    walletType,
    userId,
    proxyKeyId,
    model,
    pricingMap,
    pricingSource,
    liveModelCount,
  } = auth.value;
  const verifiedKey = { id: proxyKeyId, userId };

  const upstreamBody =
    body.stream === true
      ? {
          ...body,
          stream_options: {
            ...((body.stream_options && typeof body.stream_options === "object"
              ? body.stream_options
              : {}) as Record<string, unknown>),
            include_usage: true,
          },
        }
      : body;

  // A refused request (or one that never reached Venice) gets its hold back.
  // If that release fails, an item is filed and the hourly sweep releases it:
  // the hold is never left to expire and be charged (security review 2026-09).
  const release = (cause: string, upstreamStatus: number | null = null) =>
    releaseManagedVeniceChatReservationOrFile({
      userId,
      proxyKeyId,
      referenceId,
      cause,
      upstreamStatus,
      model,
      source: "managed-venice-chat",
    });
  const deadline = managedVeniceStreamDeadline(MANAGED_VENICE_STREAM_DEADLINE_MS);

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serverKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(upstreamBody),
      signal: deadline,
    });
  } catch (error) {
    await release(deadline.aborted ? "upstream_deadline" : "upstream_fetch_failed");
    return apiError(
      "Venice upstream request failed.",
      502,
      { failureType: "managed_venice_upstream_fetch_failed" },
      undefined,
      { cause: error }
    );
  }

  if (body.stream === true) {
    if (!upstreamResponse.body) {
      await release("stream_missing_body", upstreamResponse.status);
      return apiError("Venice stream response missing body.", 502, {
        failureType: "managed_venice_stream_missing_body",
      });
    }

    // Upstream returned an error (rate-limit, auth failure, model error,
    // overloaded, etc). The body is the error payload — NOT an SSE stream
    // with usage. If we hand it to createSettlingStream we'd fail to find
    // usage and pause the user's proxy key over a transient Venice error.
    // Release the reservation, surface the upstream status + body to the
    // caller, and leave the key alone so the agent can retry.
    if (!upstreamResponse.ok) {
      await release("upstream_non_2xx", upstreamResponse.status);
      const upstreamText = await upstreamResponse.text().catch(() => "");
      log.warn("Managed Venice upstream returned non-2xx on streaming request", {
        source: "managed-venice-chat",
        route: ROUTE,
        method: "POST",
        failureType: "managed_venice_upstream_non_2xx_streaming",
        upstreamStatus: upstreamResponse.status,
        userId,
        proxyKeyId,
        model,
      });
      return jsonResponseFromText(upstreamText, upstreamResponse.status);
    }

    return new Response(
      createSettlingStream({
        upstream: upstreamResponse.body,
        verifiedKey,
        walletType,
        referenceId,
        model,
        upstreamStatus: upstreamResponse.status,
        pricingMap,
        deadline,
      }),
      {
        status: upstreamResponse.status,
        headers: { "Content-Type": "text/event-stream" },
      }
    );
  }

  let upstreamText: string;
  try {
    upstreamText = await upstreamResponse.text();
  } catch (error) {
    // Venice answered but its body never fully arrived (or the deadline
    // passed while reading it). A 2xx is charged its input estimate, the
    // only part observed; a refusal is released.
    if (upstreamResponse.ok) {
      await captureManagedVeniceObservedOutput({
        userId,
        proxyKeyId,
        referenceId,
        model,
        upstreamStatus: upstreamResponse.status,
        observedOutputTokens: 0,
        cause: deadline.aborted ? "deadline" : "body_unreadable",
        reconciliationReason: "managed_venice_missing_usage",
        source: "managed-venice-chat",
      });
    } else {
      await release("upstream_non_2xx", upstreamResponse.status);
    }
    return apiError(
      "Venice response could not be read.",
      502,
      { failureType: "managed_venice_upstream_body_unreadable" },
      undefined,
      { cause: error }
    );
  }
  const upstreamJson = safeJsonParse(upstreamText);
  const usage = upstreamJson?.usage;

  if (!upstreamResponse.ok && !usage) {
    await release("upstream_non_2xx", upstreamResponse.status);
    return jsonResponseFromText(upstreamText, upstreamResponse.status);
  }

  try {
    await captureManagedVeniceChatUsage({
      userId,
      proxyKeyId,
      walletType,
      referenceId,
      model,
      upstreamStatus: upstreamResponse.status,
      usage,
      pricingMap,
    });
  } catch (error) {
    if (!(error instanceof MissingVeniceUsageError)) throw error;
    // Venice answered 2xx without a usable usage block. Charge the input
    // estimate plus the output in the body, and deliver the body: the user
    // pays for this answer, so they get it. The key stays live.
    const meter = createManagedVeniceOutputMeter();
    if (upstreamJson) meter.observeChatChunk(upstreamJson);
    else meter.observeUnparsedText(upstreamText);
    await captureManagedVeniceObservedOutput({
      userId,
      proxyKeyId,
      referenceId,
      model,
      upstreamStatus: upstreamResponse.status,
      observedOutputTokens: meter.outputTokens(),
      cause: "missing_usage",
      reconciliationReason: "managed_venice_missing_usage",
      source: "managed-venice-chat",
    });
    return jsonResponseFromText(upstreamText, upstreamResponse.status);
  }

  log.info("Managed Venice chat completion settled", {
    source: "managed-venice-chat",
    userId,
    proxyKeyId,
    walletType,
    model,
    referenceId,
    reservationId,
    upstreamStatus: upstreamResponse.status,
    pricingSource,
    liveModelCount,
  });

  return jsonResponseFromText(upstreamText, upstreamResponse.status);
}
