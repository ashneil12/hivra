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
 * refused request must never be. When the box disconnects mid-stream the
 * Worker stops forwarding but keeps reading Venice to its usage frame (within
 * DRAIN_AFTER_DISCONNECT_MS), so the exact usage is charged, hidden reasoning
 * included. A stream that ends without a usage frame is settled with the
 * output that was read, counted as it streamed. Everything after the hold is
 * made runs under waitUntil, so a box that disconnects cannot cut the Worker
 * off before the hold is settled.
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
// keep in lockstep. Estimates the output tokens read as the larger of the
// frames that carried text and a floor for batched frames: a token per 4
// ASCII characters plus a token per other character.
const OBSERVED_OUTPUT_ASCII_CHARS_PER_TOKEN = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

// The floor's weight of a text, in quarter tokens: 1 per ASCII character, 4
// (a whole token) per other character.
function quarterTokens(text: string): number {
  let units = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) {
      units += 1;
      continue;
    }
    units += OBSERVED_OUTPUT_ASCII_CHARS_PER_TOKEN;
    // A surrogate pair is one character.
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) index += 1;
  }
  return units;
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
  let textQuarterTokens = 0;
  const observeChatChunk = (chunk: unknown) => {
    if (!isRecord(chunk) || !Array.isArray(chunk.choices)) return;
    for (const choice of chunk.choices) {
      if (!isRecord(choice)) continue;
      const text = chatChoiceText(choice.delta) + chatChoiceText(choice.message);
      if (!text) continue;
      textFrames += 1;
      textQuarterTokens += quarterTokens(text);
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
      if (text) textQuarterTokens += quarterTokens(text);
    },
    outputTokens(): number {
      return Math.max(textFrames, Math.ceil(textQuarterTokens / OBSERVED_OUTPUT_ASCII_CHARS_PER_TOKEN));
    },
  };
}

const SETTLE_ATTEMPTS = 5;
const SETTLE_RETRY_BASE_MS = 250;

/**
 * How long the Worker keeps reading Venice after the box disconnects, waiting
 * for the usage frame. Cloudflare keeps a Worker alive for 30 s of waitUntil
 * work after its client leaves; this leaves the rest for the settle call and
 * its retries.
 */
const DRAIN_AFTER_DISCONNECT_MS = 20_000;

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

interface ProxiedChat {
  response: Response;
  /** Resolves once the request's hold is settled or released. */
  settled?: Promise<unknown>;
}

async function handleChatCompletions(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  // Everything after the hold is made, the wait for Venice's answer included,
  // runs under waitUntil, so a box that disconnects cannot cut the Worker off
  // before the hold is settled or released (#167 second review).
  let done!: () => void;
  ctx.waitUntil(new Promise<void>((resolve) => (done = resolve)));
  try {
    const { response, settled } = await proxyChatCompletion(request, env);
    if (settled) void settled.catch(() => undefined).finally(done);
    else done();
    return response;
  } catch (error) {
    done();
    throw error;
  }
}

async function proxyChatCompletion(request: Request, env: Env): Promise<ProxiedChat> {
  const plaintextKey = readBearer(request);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return { response: jsonError(400, "Invalid JSON body.", "invalid_request_error", "invalid_request_error") };
  }

  // The hold's reference, chosen here so the hold can be released after any
  // failure below, even when the authorize response itself is lost.
  const referenceId = crypto.randomUUID();
  const releaseByReference = (cause: string) => callSettle(env, { outcome: "release", referenceId, cause });

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
    return {
      response: jsonError(502, "Proxy authorization upstream failed.", "proxy_upstream_error"),
      settled: releaseByReference("authorize_unreachable"),
    };
  }

  // 403 == our shared-secret is wrong (Worker misconfig), NOT the box's key.
  // Don't relay it as a key/billing error — surface a generic 502.
  if (authRes.status === 403) {
    console.error("managed-venice authorize rejected the internal secret (worker misconfigured)");
    return { response: jsonError(502, "Proxy authorization misconfigured.", "proxy_misconfigured") };
  }
  // A 5xx may follow a reservation (the function failed after reserving, or
  // the platform cut it off): release by reference and fail the request.
  if (authRes.status >= 500) {
    console.error("managed-venice authorize failed", authRes.status);
    return {
      response: jsonError(502, "Proxy authorization upstream failed.", "proxy_upstream_error"),
      settled: releaseByReference("authorize_failed"),
    };
  }
  // Any other non-2xx is a relay-able client error (401 bad key, 402 no balance,
  // 400 bad model) — forward to the box verbatim. Nothing was reserved.
  if (!authRes.ok) {
    const text = await authRes.text();
    return {
      response: new Response(text, {
        status: authRes.status,
        headers: {
          "Content-Type": authRes.headers.get("Content-Type") || "application/json",
        },
      }),
    };
  }

  let auth: AuthorizedChat;
  try {
    auth = (await authRes.json()) as AuthorizedChat;
    if (!auth || typeof auth.upstreamUrl !== "string" || typeof auth.upstreamKey !== "string") {
      throw new Error("authorize response is missing its upstream");
    }
  } catch (err) {
    console.error("managed-venice authorize response unreadable", String(err));
    return {
      response: jsonError(502, "Proxy authorization upstream failed.", "proxy_upstream_error"),
      settled: releaseByReference("authorize_response_unreadable"),
    };
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
    return { response: jsonError(502, "Venice upstream request failed.", "venice_upstream_error") };
  }

  if (streaming) {
    if (!upstream.ok || !upstream.body) {
      // Upstream error before any billable stream — release the hold and relay
      // the error to the box so the agent can retry. Key stays live.
      await release(upstream.ok ? "stream_missing_body" : "upstream_non_2xx", upstream.status);
      const text = await upstream.text().catch(() => "");
      return {
        response: new Response(text || JSON.stringify({ error: { message: "Venice stream unavailable." } }), {
          status: upstream.ok ? 502 : upstream.status,
          headers: { "Content-Type": "application/json" },
        }),
      };
    }
    return streamToBox(upstream, upstream.body, settle);
  }

  // Non-streaming: read the full body, settle on usage, return JSON.
  let text: string;
  try {
    text = await upstream.text();
  } catch (err) {
    console.error("managed-venice venice response unreadable", String(err));
    const response = jsonError(502, "Venice response could not be read.", "venice_upstream_error");
    if (upstream.ok) return { response, settled: settle(null, upstream.status, "body_unreadable", 0) };
    await release("upstream_non_2xx", upstream.status);
    return { response };
  }
  const json = safeJsonParse(text);
  const usage = json?.usage ?? null;

  if (!upstream.ok && !usage) {
    await release("upstream_non_2xx", upstream.status);
    return {
      response: new Response(text, {
        status: upstream.status,
        headers: { "Content-Type": "application/json" },
      }),
    };
  }

  const meter = createOutputMeter();
  if (json) meter.observeChatChunk(json);
  else meter.observeUnparsedText(text);
  return {
    response: new Response(text, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("Content-Type") || "application/json",
      },
    }),
    // Settled after the response, so the box isn't blocked on the round-trip.
    settled: settle(usage, upstream.status, usage ? "completed" : "missing_usage", meter.outputTokens()),
  };
}

/**
 * Forward Venice's stream to the box, counting the output and keeping the
 * usage frame, and settle once, however the stream ends. When the box
 * disconnects, stop forwarding but keep reading Venice to its usage frame (or
 * the end of the stream, or DRAIN_AFTER_DISCONNECT_MS), so the exact usage is
 * charged: a reasoning model's hidden thinking never appears in the stream,
 * and a box that left after the first line used to pay for that line only
 * (security review 2026-09, #167 second review).
 */
function streamToBox(
  upstream: Response,
  body: ReadableStream<Uint8Array>,
  settle: (usage: unknown, upstreamStatus: number, cause: string, observedOutputTokens: number | null) => Promise<boolean>
): ProxiedChat {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const meter = createOutputMeter();
  let buffer = "";
  let finalUsage: unknown = null;
  let boxGone = false;
  // The pull in progress, which a drain after disconnect waits for.
  let reading: Promise<void> = Promise.resolve();
  let settlement: Promise<void> | null = null;
  let markSettled!: () => void;
  const settled = new Promise<void>((resolve) => (markSettled = resolve));
  const finish = (cause: string) => {
    settlement ??= settle(finalUsage, upstream.status, cause, meter.outputTokens())
      .then(() => undefined)
      .finally(() => markSettled());
    return settlement;
  };
  const observe = (text: string, flush: boolean) => {
    buffer += text;
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = flush ? "" : frames.pop() ?? "";
    for (const frame of frames) finalUsage = meter.observeChatSseFrame(frame) ?? finalUsage;
  };
  const drainAfterDisconnect = async () => {
    const stop = setTimeout(() => void reader.cancel().catch(() => undefined), DRAIN_AFTER_DISCONNECT_MS);
    try {
      await reading.catch(() => undefined);
      while (!finalUsage) {
        const { done, value } = await reader.read();
        if (done) {
          observe(decoder.decode(), true);
          break;
        }
        if (value) observe(decoder.decode(value, { stream: true }), false);
      }
    } catch (err) {
      console.error("managed-venice stream read after disconnect ended", String(err));
    } finally {
      clearTimeout(stop);
      void reader.cancel().catch(() => undefined);
    }
    await finish("client_cancelled");
  };

  const toClient = new ReadableStream<Uint8Array>({
    pull(controller) {
      reading = (async () => {
        try {
          const { done, value } = await reader.read();
          if (done) {
            observe(decoder.decode(), true);
            if (!boxGone) controller.close();
            void finish("completed");
            return;
          }
          if (!value) return;
          observe(decoder.decode(value, { stream: true }), false);
          if (!boxGone) controller.enqueue(value);
        } catch (err) {
          // Once the box has gone the drain owns the read and the settlement.
          if (boxGone) return;
          console.error("managed-venice upstream stream failed", String(err));
          controller.error(err);
          void finish("upstream_failed");
        }
      })();
      return reading;
    },
    cancel() {
      boxGone = true;
      void drainAfterDisconnect();
    },
  });

  return {
    response: new Response(toClient, {
      status: upstream.status,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
      },
    }),
    settled,
  };
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
