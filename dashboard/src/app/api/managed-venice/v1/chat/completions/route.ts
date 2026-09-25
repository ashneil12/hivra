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
  markManagedVeniceReconciliationRequired,
  releaseManagedVeniceChatReservation,
} from "@/lib/venice/proxy-settlement";
import { CHAT_STREAM_CANCELLED_RECONCILIATION_REASON } from "@/lib/venice/chat-stream-reconciliation";
// Shared authorize/settle core — keeps the in-Vercel route and the off-Vercel
// Cloudflare Worker (internal/{authorize,settle}) from drifting on billing
// semantics. See docs/PRODUCT-ARCHITECTURE.md.
import {
  authorizeManagedVeniceChat,
  readUsageFromSseFrame,
} from "@/lib/venice/proxy-chat-core";

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

type StreamOutcome = "completed" | "upstream_failed" | "client_cancelled";

function createSettlingStream(params: {
  upstream: ReadableStream<Uint8Array>;
  verifiedKey: { id: string; userId: string };
  walletType: ManagedVeniceWalletType;
  referenceId: string;
  model: string;
  upstreamStatus: number;
  pricingMap: VenicePricingMap;
}) {
  const decoder = new TextDecoder();
  const reader = params.upstream.getReader();
  const identity = {
    userId: params.verifiedKey.userId,
    proxyKeyId: params.verifiedKey.id,
    referenceId: params.referenceId,
  };
  let buffer = "";
  let finalUsage: unknown = null;
  let forwardedBytes = 0;
  let cancelled = false;
  let settlement: Promise<unknown> | null = null;

  function observe(chunk: Uint8Array) {
    buffer += decoder.decode(chunk, { stream: true });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      finalUsage = readUsageFromSseFrame(frame) ?? finalUsage;
    }
  }

  async function fileReconciliation(reason: string, metadata: Record<string, unknown> = {}) {
    try {
      await markManagedVeniceReconciliationRequired({
        ...identity,
        reason,
        metadata: { model: params.model, upstreamStatus: params.upstreamStatus, ...metadata },
        // Every item here follows a 200 whose reservation is still held, so
        // the spend is covered. Keep the key usable while it is reconciled.
        pauseKey: false,
      });
    } catch (error) {
      log.error("Managed Venice chat stream could not file its reconciliation item", error, {
        source: "managed-venice-chat",
        route: "/api/managed-venice/v1/chat/completions",
        failureType: "managed_venice_stream_reconciliation_write_failed",
        userId: identity.userId,
        proxyKeyId: identity.proxyKeyId,
        referenceId: identity.referenceId,
        reason,
      });
    }
  }

  // Venice answered 200 before this stream was built, so it is generating,
  // and billing Hivra, for this request. Settle exactly once, and never by
  // releasing the hold: a client that closed the connection before the final
  // usage frame used to get the whole hold back, which made every streamed
  // completion free (security review 2026-09). Resolves to the settlement
  // error, if any, so the completed path can still fail the stream.
  function settle(outcome: StreamOutcome): Promise<unknown> {
    settlement ??= (async () => {
      const byClient = outcome === "client_cancelled";
      if (finalUsage) {
        try {
          await captureManagedVeniceChatUsage({
            ...identity,
            walletType: params.walletType,
            model: params.model,
            upstreamStatus: params.upstreamStatus,
            usage: finalUsage,
            pricingMap: params.pricingMap,
          });
          return null;
        } catch (error) {
          // Our settlement code threw on an otherwise-successful stream. That
          // is ours to reconcile, not the user's to be denied service over.
          await (byClient
            ? fileReconciliation(CHAT_STREAM_CANCELLED_RECONCILIATION_REASON, {
                cause: "settlement_failed",
                forwardedBytes,
              })
            : fileReconciliation("managed_venice_stream_settlement_failed"));
          return error;
        }
      }
      if (byClient) {
        // No usage frame yet, so there is nothing exact to charge. Keep the
        // hold and leave an item the stale-hold sweep will not release.
        log.warn("Managed Venice chat stream closed by the client before usage arrived", {
          source: "managed-venice-chat",
          route: "/api/managed-venice/v1/chat/completions",
          failureType: "managed_venice_chat_stream_client_cancelled",
          userId: identity.userId,
          proxyKeyId: identity.proxyKeyId,
          referenceId: identity.referenceId,
          model: params.model,
          forwardedBytes,
        });
        await fileReconciliation(CHAT_STREAM_CANCELLED_RECONCILIATION_REASON, {
          cause: "client_cancelled",
          forwardedBytes,
        });
        return null;
      }
      // Upstream finished (or dropped) without a usage frame. The reservation
      // is still held and the invoice cron settles offline: don't brick the
      // key over a telemetry gap.
      await fileReconciliation(
        outcome === "completed"
          ? "managed_venice_missing_stream_usage"
          : "managed_venice_stream_settlement_failed"
      );
      return null;
    })();
    return settlement;
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let upstreamError: unknown = null;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done || cancelled) break;
          if (!value) continue;
          observe(value);
          controller.enqueue(value);
          forwardedBytes += value.byteLength;
        }
        buffer += decoder.decode();
        if (buffer) {
          finalUsage = readUsageFromSseFrame(buffer) ?? finalUsage;
        }
      } catch (error) {
        upstreamError = error;
      }

      // Once the client has gone, cancel() owns settlement; the controller is
      // already closed, so there is nothing left to close or error here.
      if (cancelled) {
        await settlement;
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
      finalUsage = readUsageFromSseFrame(buffer) ?? finalUsage;
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

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serverKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(upstreamBody),
    });
  } catch (error) {
    await releaseManagedVeniceChatReservation({
      userId,
      referenceId,
    });
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
      await releaseManagedVeniceChatReservation({
        userId,
        referenceId,
      });
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
      await releaseManagedVeniceChatReservation({
        userId,
        referenceId,
      });
      const upstreamText = await upstreamResponse.text();
      log.warn("Managed Venice upstream returned non-2xx on streaming request", {
        source: "managed-venice-chat",
        route: "/api/managed-venice/v1/chat/completions",
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
      }),
      {
        status: upstreamResponse.status,
        headers: { "Content-Type": "text/event-stream" },
      }
    );
  }

  const upstreamText = await upstreamResponse.text();
  const upstreamJson = safeJsonParse(upstreamText);
  const usage = upstreamJson?.usage;

  if (!upstreamResponse.ok && !usage) {
    await releaseManagedVeniceChatReservation({
      userId,
      referenceId,
    });
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
    if (error instanceof MissingVeniceUsageError) {
      await markManagedVeniceReconciliationRequired({
        userId,
        proxyKeyId,
        referenceId,
        reason: "managed_venice_missing_usage",
        metadata: { model, upstreamStatus: upstreamResponse.status },
        // Non-streaming response lacked a usage block. File for reconciliation
        // but keep the key live — the reservation already covers the spend.
        pauseKey: false,
      });
      return apiError("Venice response missing usage for settlement.", 502, {
        failureType: "managed_venice_missing_usage",
      });
    }
    throw error;
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
