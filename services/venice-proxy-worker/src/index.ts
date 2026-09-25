/**
 * Managed-Venice chat proxy — Cloudflare Worker.
 *
 * Off-loads the LLM streaming byte-pump from Vercel Fluid functions (which bill
 * 2 GB provisioned memory + active CPU + fast-origin-transfer for the ENTIRE
 * duration of every completion, fleet-wide) onto cheap Workers egress. ALL
 * wallet/billing logic stays on Vercel via two short calls:
 *
 *   1. POST {VERCEL_BASE_URL}/api/managed-venice/internal/authorize
 *        -> verify proxy key, reserve wallet funds, resolve upstream Venice key
 *   2. (Worker holds the long-lived stream itself, straight from Venice)
 *   3. POST {VERCEL_BASE_URL}/api/managed-venice/internal/settle
 *        -> capture actual usage against the reservation (or release on failure)
 *
 * The Worker chooses each hold's reference before authorizing, so it can
 * release the hold after ANY failure that follows authorize, even a lost
 * authorize response. Settle and release calls are retried until Vercel
 * answers 2xx: a hold nobody settles is charged an estimate a day later, and a
 * refused request must never be. A stream that ends without a usage frame
 * (the box disconnected, Venice left it out) is settled with the output that
 * was forwarded, counted as it streamed.
 *
 * Only POST /v1/chat/completions is intercepted. Every other /v1/* path
 * (embeddings, images, models, audio, augment, ...) is transparently reverse-
 * proxied back to Vercel — those are short request/response calls and cheap to
 * leave where they are. See docs/PRODUCT-ARCHITECTURE.md.
 */

export interface Env {
  /** Base URL of the dashboard/control-plane on Vercel, no trailing slash. */
  VERCEL_BASE_URL: string;
  /** Shared secret for /api/managed-venice/internal/* (set via wrangler secret). */
  MANAGED_VENICE_INTERNAL_SECRET: string;
}

const INTERNAL_SECRET_HEADER = "x-managed-venice-internal-secret";

interface AuthorizedChat {
  referenceId: string;
  upstreamKey: string;
  upstreamUrl: string;
  walletType: string;
  userId: string;
  proxyKeyId: string;
  model: string;
}

function jsonError(status: number, message: string, code: string, type = "server_error") {
  return new Response(
    JSON.stringify({ error: { message, type, param: null, code } }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}

function readBearer(request: Request): string | null {
  const header = request.headers.get("authorization")?.trim() || "";
  if (!header.toLowerCase().startsWith("bearer ")) return null;
  return header.slice(7).trim() || null;
}

function safeJsonParse(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// Mirror of dashboard/src/lib/venice/stream-output-meter.ts (chat parts):
// keep in lockstep. Estimates the output tokens forwarded as the larger of
// the frames that carried text and the text's UTF-8 size / 4.
const OBSERVED_OUTPUT_UTF8_BYTES_PER_TOKEN = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).join("");
  if (isRecord(value) && typeof value.text === "string") return value.text;
  return "";
}

function chatChoiceText(part: unknown): string {
  if (!isRecord(part)) return "";
  let text =
    textOf(part.content) + textOf(part.reasoning_content) + textOf(part.reasoning) + textOf(part.refusal);
  const calls = Array.isArray(part.tool_calls) ? part.tool_calls : [];
  for (const call of calls) {
    if (!isRecord(call) || !isRecord(call.function)) continue;
    text += textOf(call.function.name) + textOf(call.function.arguments);
  }
  if (isRecord(part.function_call)) {
    text += textOf(part.function_call.name) + textOf(part.function_call.arguments);
  }
  return text;
}

function createOutputMeter() {
  let textFrames = 0;
  let textBytes = 0;
  const observeChatChunk = (chunk: unknown) => {
    if (!isRecord(chunk) || !Array.isArray(chunk.choices)) return;
    for (const choice of chunk.choices) {
      if (!isRecord(choice)) continue;
      const text = chatChoiceText(choice.delta) + chatChoiceText(choice.message);
      if (!text) continue;
      textFrames += 1;
      textBytes += utf8Length(text);
    }
  };
  return {
    observeChatChunk,
    /** Counts one SSE frame's output and returns the usage block it carried, if any. */
    observeChatSseFrame(frame: string): unknown {
      let usage: unknown = null;
      for (const line of frame.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue; // non-JSON keep-alive / comment frame
        }
        observeChatChunk(parsed);
        if (isRecord(parsed) && parsed.usage) usage = parsed.usage;
      }
      return usage;
    },
    observeUnparsedText(text: string) {
      if (text) textBytes += utf8Length(text);
    },
    outputTokens(): number {
      return Math.max(textFrames, Math.ceil(textBytes / OBSERVED_OUTPUT_UTF8_BYTES_PER_TOKEN));
    },
  };
}

const SETTLE_ATTEMPTS = 5;
const SETTLE_RETRY_BASE_MS = 250;

/**
 * POST to /internal/settle until it answers 2xx (at most SETTLE_ATTEMPTS
 * tries, backing off from SETTLE_RETRY_BASE_MS). Settle and release are both
 * safe to repeat: a hold that is already settled is never charged or released
 * again. A 4xx other than 408/429 is a request the route will never accept,
 * so it is not retried.
 */
async function callSettle(env: Env, payload: Record<string, unknown>): Promise<boolean> {
  for (let attempt = 1; attempt <= SETTLE_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(`${env.VERCEL_BASE_URL}/api/managed-venice/internal/settle`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [INTERNAL_SECRET_HEADER]: env.MANAGED_VENICE_INTERNAL_SECRET,
        },
        body: JSON.stringify(payload),
      });
      if (res.ok) return true;
      if (res.status < 500 && res.status !== 408 && res.status !== 429) {
        console.error("managed-venice settle call rejected", res.status, String(payload.outcome));
        return false;
      }
      console.error("managed-venice settle call failed", res.status, `attempt ${attempt}`);
    } catch (err) {
      console.error("managed-venice settle call failed", String(err), `attempt ${attempt}`);
    }
    if (attempt < SETTLE_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, SETTLE_RETRY_BASE_MS * 2 ** (attempt - 1)));
    }
  }
  // Retries exhausted. The hold is left to the stale-hold sweep.
  console.error("managed-venice settle call gave up", String(payload.outcome), String(payload.referenceId));
  return false;
}

async function handleChatCompletions(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const plaintextKey = readBearer(request);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonError(400, "Invalid JSON body.", "invalid_request_error", "invalid_request_error");
  }

  // The hold's reference, chosen here so the hold can be released after any
  // failure below, even when the authorize response itself is lost.
  const referenceId = crypto.randomUUID();
  const releaseByReference = (cause: string) =>
    ctx.waitUntil(callSettle(env, { outcome: "release", referenceId, cause }));

  // 1. Authorize on Vercel (verify key + reserve funds + resolve upstream key).
  let authRes: Response;
  try {
    authRes = await fetch(`${env.VERCEL_BASE_URL}/api/managed-venice/internal/authorize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [INTERNAL_SECRET_HEADER]: env.MANAGED_VENICE_INTERNAL_SECRET,
      },
      body: JSON.stringify({ plaintextKey, body, referenceId }),
    });
  } catch (err) {
    console.error("managed-venice authorize call failed", String(err));
    // Vercel may have reserved before the connection broke.
    releaseByReference("authorize_unreachable");
    return jsonError(502, "Proxy authorization upstream failed.", "proxy_upstream_error");
  }

  // 403 == our shared-secret is wrong (Worker misconfig), NOT the box's key.
  // Don't relay it as a key/billing error — surface a generic 502.
  if (authRes.status === 403) {
    console.error("managed-venice authorize rejected the internal secret (worker misconfigured)");
    return jsonError(502, "Proxy authorization misconfigured.", "proxy_misconfigured");
  }
  // A 5xx may follow a reservation (the function failed after reserving, or
  // the platform cut it off): release by reference and fail the request.
  if (authRes.status >= 500) {
    console.error("managed-venice authorize failed", authRes.status);
    releaseByReference("authorize_failed");
    return jsonError(502, "Proxy authorization upstream failed.", "proxy_upstream_error");
  }
  // Any other non-2xx is a relay-able client error (401 bad key, 402 no balance,
  // 400 bad model) — forward to the box verbatim. Nothing was reserved.
  if (!authRes.ok) {
    const text = await authRes.text();
    return new Response(text, {
      status: authRes.status,
      headers: {
        "Content-Type": authRes.headers.get("Content-Type") || "application/json",
      },
    });
  }

  let auth: AuthorizedChat;
  try {
    auth = (await authRes.json()) as AuthorizedChat;
    if (!auth || typeof auth.upstreamUrl !== "string" || typeof auth.upstreamKey !== "string") {
      throw new Error("authorize response is missing its upstream");
    }
  } catch (err) {
    console.error("managed-venice authorize response unreadable", String(err));
    releaseByReference("authorize_response_unreadable");
    return jsonError(502, "Proxy authorization upstream failed.", "proxy_upstream_error");
  }
  const streaming = body.stream === true;
  // An older control plane chooses its own reference and returns it.
  const holdReference = typeof auth.referenceId === "string" && auth.referenceId ? auth.referenceId : referenceId;
  const release = (cause: string, upstreamStatus: number | null = null) =>
    callSettle(env, {
      outcome: "release",
      userId: auth.userId,
      proxyKeyId: auth.proxyKeyId,
      referenceId: holdReference,
      cause,
      upstreamStatus,
    });
  const settle = (usage: unknown, upstreamStatus: number, cause: string, observedOutputTokens: number | null) =>
    callSettle(env, {
      outcome: "settle",
      userId: auth.userId,
      proxyKeyId: auth.proxyKeyId,
      walletType: auth.walletType,
      referenceId: holdReference,
      model: auth.model,
      upstreamStatus,
      usage,
      cause,
      // Only a usage-less response is charged by the output it delivered.
      ...(usage == null && observedOutputTokens !== null ? { observedOutputTokens } : {}),
    });

  const upstreamBody = streaming
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

  // 2. Hold the long-lived connection to Venice from the edge.
  let upstream: Response;
  try {
    upstream = await fetch(auth.upstreamUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth.upstreamKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(upstreamBody),
    });
  } catch (err) {
    console.error("managed-venice venice upstream fetch failed", String(err));
    await release("upstream_fetch_failed");
    return jsonError(502, "Venice upstream request failed.", "venice_upstream_error");
  }

  if (streaming) {
    if (!upstream.ok || !upstream.body) {
      // Upstream error before any billable stream — release the hold and relay
      // the error to the box so the agent can retry. Key stays live.
      await release(upstream.ok ? "stream_missing_body" : "upstream_non_2xx", upstream.status);
      const text = await upstream.text().catch(() => "");
      return new Response(text || JSON.stringify({ error: { message: "Venice stream unavailable." } }), {
        status: upstream.ok ? 502 : upstream.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Forward Venice's bytes as they arrive, counting the output and keeping
    // the usage frame. Settle once the stream ends, however it ends: if the
    // box disconnects, stop reading Venice (it stops generating) and charge
    // what was forwarded. waitUntil keeps the Worker alive to settle.
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    const meter = createOutputMeter();
    let buffer = "";
    let finalUsage: unknown = null;
    let cancelled = false;
    let settlement: Promise<void> | null = null;
    let settled!: () => void;
    ctx.waitUntil(new Promise<void>((resolve) => (settled = resolve)));
    const finish = (cause: string) => {
      settlement ??= settle(finalUsage, upstream.status, cause, meter.outputTokens())
        .then(() => undefined)
        .finally(() => settled());
      return settlement;
    };
    const observe = (text: string, flush: boolean) => {
      buffer += text;
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = flush ? "" : frames.pop() ?? "";
      for (const frame of frames) finalUsage = meter.observeChatSseFrame(frame) ?? finalUsage;
    };

    const toClient = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            observe(decoder.decode(), true);
            controller.close();
            void finish("completed");
            return;
          }
          if (!value) return;
          observe(decoder.decode(value, { stream: true }), false);
          controller.enqueue(value);
        } catch (err) {
          // After the box disconnects, cancel() has settled and stopped the read.
          if (cancelled) return;
          console.error("managed-venice upstream stream failed", String(err));
          controller.error(err);
          void finish("upstream_failed");
        }
      },
      cancel() {
        cancelled = true;
        void reader.cancel().catch(() => undefined);
        void finish("client_cancelled");
      },
    });

    return new Response(toClient, {
      status: upstream.status,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
      },
    });
  }

  // Non-streaming: read the full body, settle on usage, return JSON.
  let text: string;
  try {
    text = await upstream.text();
  } catch (err) {
    console.error("managed-venice venice response unreadable", String(err));
    if (upstream.ok) ctx.waitUntil(settle(null, upstream.status, "body_unreadable", 0));
    else await release("upstream_non_2xx", upstream.status);
    return jsonError(502, "Venice response could not be read.", "venice_upstream_error");
  }
  const json = safeJsonParse(text);
  const usage = json?.usage ?? null;

  if (!upstream.ok && !usage) {
    await release("upstream_non_2xx", upstream.status);
    return new Response(text, {
      status: upstream.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  const meter = createOutputMeter();
  if (json) meter.observeChatChunk(json);
  else meter.observeUnparsedText(text);
  // settle in the background so the box isn't blocked on the settle round-trip.
  ctx.waitUntil(settle(usage, upstream.status, usage ? "completed" : "missing_usage", meter.outputTokens()));

  return new Response(text, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("Content-Type") || "application/json",
    },
  });
}

async function reverseProxyToVercel(
  request: Request,
  env: Env,
  subpath: string
): Promise<Response> {
  const url = new URL(request.url);
  const target = `${env.VERCEL_BASE_URL}/api/managed-venice/v1/${subpath}${url.search}`;
  const headers = new Headers(request.headers);
  headers.delete("host");
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  return fetch(target, {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
    redirect: "manual",
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!env.VERCEL_BASE_URL || !env.MANAGED_VENICE_INTERNAL_SECRET) {
      return jsonError(500, "Worker is not configured.", "worker_misconfigured");
    }

    const url = new URL(request.url);

    // Health check.
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }

    // Extract everything after `/v1/` so we work regardless of the base prefix
    // the box was configured with (.../v1 or .../api/managed-venice/v1).
    const marker = "/v1/";
    const idx = url.pathname.indexOf(marker);
    const subpath = idx >= 0 ? url.pathname.slice(idx + marker.length) : "";

    if (request.method === "POST" && subpath === "chat/completions") {
      return handleChatCompletions(request, env, ctx);
    }

    // Everything else stays on Vercel (cheap, short request/response).
    return reverseProxyToVercel(request, env, subpath);
  },
};
