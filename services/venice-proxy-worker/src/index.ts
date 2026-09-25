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
  /**
   * Output-cap fields to overwrite before forwarding. The wallet hold covers
   * the request only as patched (a lower max_tokens when the wallet cannot
   * cover the model maximum), so it MUST be applied. Sent because this Worker
   * declares `acceptsBodyPatch: true`.
   */
  bodyPatch?: Record<string, unknown>;
}

const OUTPUT_CAP_FIELDS = ["max_completion_tokens", "max_tokens", "max_output_tokens"] as const;

/** Mirror of the dashboard's bodyPatch contract: only positive-integer output caps. */
function applyBodyPatch(
  body: Record<string, unknown>,
  patch: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!patch || typeof patch !== "object") return body;
  const patched = { ...body };
  for (const field of OUTPUT_CAP_FIELDS) {
    const value = patch[field];
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
      patched[field] = value;
    }
  }
  return patched;
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

/** Mirror of dashboard readUsageFromSseFrame — keep in lockstep. */
function readUsageFromSseFrame(frame: string): unknown {
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

async function callSettle(env: Env, payload: Record<string, unknown>): Promise<void> {
  try {
    await fetch(`${env.VERCEL_BASE_URL}/api/managed-venice/internal/settle`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [INTERNAL_SECRET_HEADER]: env.MANAGED_VENICE_INTERNAL_SECRET,
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    // Settle endpoint unreachable. The managed-venice-token-reconciliation cron
    // is the backstop: it settles/releases the orphaned referenceId offline.
    console.error("managed-venice settle call failed", String(err));
  }
}

async function sniffAndSettle(
  stream: ReadableStream<Uint8Array>,
  env: Env,
  auth: AuthorizedChat,
  upstreamStatus: number
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalUsage: unknown = null;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          finalUsage = readUsageFromSseFrame(frame) ?? finalUsage;
        }
      }
    }
    buffer += decoder.decode();
    if (buffer) finalUsage = readUsageFromSseFrame(buffer) ?? finalUsage;
  } catch (err) {
    console.error("managed-venice usage sniff failed", String(err));
  }
  // usage present -> capture; usage null -> settle endpoint files reconciliation
  // (keeps the key live; cron settles offline).
  await callSettle(env, {
    outcome: "settle",
    userId: auth.userId,
    proxyKeyId: auth.proxyKeyId,
    walletType: auth.walletType,
    referenceId: auth.referenceId,
    model: auth.model,
    upstreamStatus,
    usage: finalUsage,
  });
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

  // 1. Authorize on Vercel (verify key + reserve funds + resolve upstream key).
  let authRes: Response;
  try {
    authRes = await fetch(`${env.VERCEL_BASE_URL}/api/managed-venice/internal/authorize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [INTERNAL_SECRET_HEADER]: env.MANAGED_VENICE_INTERNAL_SECRET,
      },
      // acceptsBodyPatch: this Worker forwards `{ ...body, ...bodyPatch }`, so
      // authorize may lower the output cap to what the wallet covers instead
      // of refusing the request outright.
      body: JSON.stringify({ plaintextKey, body, acceptsBodyPatch: true }),
    });
  } catch (err) {
    console.error("managed-venice authorize call failed", String(err));
    return jsonError(502, "Proxy authorization upstream failed.", "proxy_upstream_error");
  }

  // 403 == our shared-secret is wrong (Worker misconfig), NOT the box's key.
  // Don't relay it as a key/billing error — surface a generic 502.
  if (authRes.status === 403) {
    console.error("managed-venice authorize rejected the internal secret (worker misconfigured)");
    return jsonError(502, "Proxy authorization misconfigured.", "proxy_misconfigured");
  }
  // Any other non-2xx is a relay-able client error (401 bad key, 402 no balance,
  // 400 bad model, 503 not configured) — forward to the box verbatim.
  if (!authRes.ok) {
    const text = await authRes.text();
    return new Response(text, {
      status: authRes.status,
      headers: {
        "Content-Type": authRes.headers.get("Content-Type") || "application/json",
      },
    });
  }

  const auth = (await authRes.json()) as AuthorizedChat;
  const streaming = body.stream === true;
  const cappedBody = applyBodyPatch(body, auth.bodyPatch);

  const upstreamBody = streaming
    ? {
        ...cappedBody,
        stream_options: {
          ...((body.stream_options && typeof body.stream_options === "object"
            ? body.stream_options
            : {}) as Record<string, unknown>),
          include_usage: true,
        },
      }
    : cappedBody;

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
    await callSettle(env, { outcome: "release", userId: auth.userId, referenceId: auth.referenceId });
    return jsonError(502, "Venice upstream request failed.", "venice_upstream_error");
  }

  if (streaming) {
    if (!upstream.ok || !upstream.body) {
      // Upstream error before any billable stream — release the hold and relay
      // the error to the box so the agent can retry. Key stays live.
      await callSettle(env, { outcome: "release", userId: auth.userId, referenceId: auth.referenceId });
      const text = await upstream.text().catch(() => "");
      return new Response(text || JSON.stringify({ error: { message: "Venice stream unavailable." } }), {
        status: upstream.ok ? 502 : upstream.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Tee the stream: one branch goes straight to the box, the other is drained
    // to sniff the final usage frame and settle. waitUntil keeps the Worker
    // alive to finish settling after the response is returned.
    const [toClient, toSniff] = upstream.body.tee();
    ctx.waitUntil(sniffAndSettle(toSniff, env, auth, upstream.status));

    return new Response(toClient, {
      status: upstream.status,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
      },
    });
  }

  // Non-streaming: read the full body, settle on usage, return JSON.
  const text = await upstream.text();
  const json = safeJsonParse(text);
  const usage = json?.usage ?? null;

  if (!upstream.ok && !usage) {
    await callSettle(env, { outcome: "release", userId: auth.userId, referenceId: auth.referenceId });
    return new Response(text, {
      status: upstream.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  // settle in the background so the box isn't blocked on the settle round-trip.
  ctx.waitUntil(
    callSettle(env, {
      outcome: "settle",
      userId: auth.userId,
      proxyKeyId: auth.proxyKeyId,
      walletType: auth.walletType,
      referenceId: auth.referenceId,
      model: auth.model,
      upstreamStatus: upstream.status,
      usage,
    })
  );

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
