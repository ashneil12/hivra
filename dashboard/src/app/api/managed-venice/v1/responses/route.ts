import { NextRequest } from "next/server";
import { apiError } from "@/lib/api-response";
import { log } from "@/lib/logger";
import { authorizeManagedVeniceChat } from "@/lib/venice/proxy-chat-core";
import { captureManagedVeniceChatUsage, markManagedVeniceReconciliationRequired, releaseManagedVeniceChatReservation } from "@/lib/venice/proxy-settlement";
import { RESPONSES_MAX_REQUEST_BYTES, RESPONSES_RECONCILIATION_REASON, VENICE_RESPONSES_ENDPOINT, responsesEstimateRequest, responsesUsageObserver, responseTerminal } from "@/lib/venice/responses-protocol";

export const runtime = "nodejs";
export const maxDuration = 300;
const headers = { "Cache-Control": "no-store", "Content-Type": "application/json" };

async function boundedText(stream: ReadableStream<Uint8Array> | null, maxBytes: number) {
  if (!stream) throw new Error("Missing body");
  const reader = stream.getReader(), decoder = new TextDecoder();
  let text = "", bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) throw new Error("Body too large");
      text += decoder.decode(next.value, { stream: true });
    }
    return text + decoder.decode();
  } finally { void reader.cancel().catch(() => undefined); }
}

// Include early validation/auth/provider failures, not just successful streams.
// The shared apiError helper deliberately does not impose a global cache policy.
export async function POST(req: NextRequest) {
  const response = await handlePost(req);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

async function handlePost(req: NextRequest) {
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "")?.[1]?.trim();
  if (!bearer) return apiError("Unauthorized", 401);
  let text: string, body: Record<string, unknown>;
  try {
    text = await boundedText(req.body, RESPONSES_MAX_REQUEST_BYTES);
    body = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    responsesEstimateRequest(body);
  } catch { return apiError("Unsupported Responses request. Use stateless text and client-side tools (maximum 1 MiB).", 400); }
  const auth = await authorizeManagedVeniceChat({ plaintextKey: bearer, body, protocol: "responses" });
  if (!auth.ok) return auth.response;
  const context = auth.value;
  const identity = { userId: context.userId, proxyKeyId: context.proxyKeyId, referenceId: context.referenceId };
  let finalizing: Promise<void> | null = null;
  // Distinct reason intentionally excluded from the stale Chat hold sweep.
  // Ambiguous Responses usage needs operator resolution; do not invent charges
  // or promise that an invoice cron will recover absent provider telemetry.
  async function reconcile(cause: string) {
    try {
      await markManagedVeniceReconciliationRequired({ ...identity, reason: RESPONSES_RECONCILIATION_REASON,
        pauseKey: false, metadata: { endpoint: VENICE_RESPONSES_ENDPOINT, model: context.model, cause } });
    } catch {
      log.error("Responses usage requires manual reconciliation", undefined, { source: "managed-venice-responses", referenceId: context.referenceId, failureType: "responses_reconciliation_write_failed" });
    }
  }
  function finish(usage: unknown, cause: string): Promise<void> {
    if (!finalizing) finalizing = (async () => {
      if (!usage) { await reconcile(cause); return; }
      try {
        await captureManagedVeniceChatUsage({ ...identity, walletType: context.walletType, model: context.model,
          upstreamStatus: 200, usage, pricingMap: context.pricingMap, endpoint: VENICE_RESPONSES_ENDPOINT });
      } catch { await reconcile("settlement_failed"); }
    })();
    return finalizing;
  }
  if (req.signal.aborted) {
    await releaseManagedVeniceChatReservation(identity);
    return new Response(null, { status: 499, headers });
  }
  const abort = new AbortController();
  const signal = AbortSignal.any([req.signal, abort.signal, AbortSignal.timeout(270000)]);
  let upstream: Response;
  try {
    upstream = await fetch(context.upstreamUrl, { method: "POST", redirect: "error", signal,
      headers: { Authorization: `Bearer ${context.upstreamKey}`, "Content-Type": "application/json", Accept: body.stream === true ? "text/event-stream" : "application/json" }, body: text });
  } catch {
    await finish(null, "dispatch_outcome_unknown");
    return apiError("Model request could not be confirmed. Usage is awaiting reconciliation.", 502);
  }
  if (!upstream.ok) {
    void upstream.body?.cancel();
    // Explicit request rejection is non-billable. Server/transport failures
    // may follow generation, so their reservation is retained for review.
    if ([400, 401, 402, 403, 404, 413, 422, 429].includes(upstream.status)) await releaseManagedVeniceChatReservation(identity);
    else await finish(null, "upstream_outcome_unknown");
    return apiError("The model provider rejected this request. Check your model and connection.", upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502);
  }
  if (body.stream !== true) {
    try {
      const output = await boundedText(upstream.body, 8 * RESPONSES_MAX_REQUEST_BYTES);
      await finish(responseTerminal(JSON.parse(output))?.usage ?? null, "missing_terminal_usage");
      return new Response(output, { status: upstream.status, headers });
    } catch {
      await finish(null, "invalid_response");
      return apiError("The model response could not be confirmed.", 502);
    }
  }
  if (!upstream.body || !upstream.headers.get("content-type")?.includes("text/event-stream")) {
    void upstream.body?.cancel();
    await finish(null, "invalid_stream");
    return apiError("The model provider did not return a stream.", 502);
  }
  const reader = upstream.body.getReader(), observer = responsesUsageObserver();
  let cancelled = false, bytes = 0;
  const onAbort = () => { cancelled = true; void reader.cancel().catch(() => undefined); void finish(observer.usage(), "stream_aborted"); };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (cancelled) { await finish(observer.usage(), "stream_aborted"); controller.error(new Error("Model stream interrupted")); return; }
        const next = await reader.read();
        if (next.done) {
          observer.feed();
          await finish(observer.usage(), "missing_terminal_usage");
          signal.removeEventListener("abort", onAbort);
          controller.close();
          return;
        }
        bytes += next.value.byteLength;
        if (bytes > 8 * RESPONSES_MAX_REQUEST_BYTES) throw new Error("Stream too large");
        observer.feed(next.value);
        if (!cancelled) controller.enqueue(next.value);
      } catch {
        signal.removeEventListener("abort", onAbort);
        abort.abort();
        void reader.cancel().catch(() => undefined);
        await finish(null, "invalid_or_interrupted_stream");
        if (!cancelled) controller.error(new Error("Model stream interrupted"));
      }
    },
    async cancel() {
      cancelled = true;
      signal.removeEventListener("abort", onAbort);
      abort.abort();
      void reader.cancel().catch(() => undefined);
      await finish(observer.usage(), "client_cancelled");
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
}
