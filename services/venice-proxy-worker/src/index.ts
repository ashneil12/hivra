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

interface SurchargeEvidence {
  veniceCostMicroUsd: number | null;
  webSearchCitations: number | null;
}

const NO_SURCHARGE_EVIDENCE: SurchargeEvidence = { veniceCostMicroUsd: null, webSearchCitations: null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/**
 * Mirror of dashboard readSurchargeEvidence (lib/venice/chat-surcharges.ts) —
 * keep in lockstep. Venice's per-request `cost` (usd + diem) and the web
 * search citation count, so settle can charge web search / scraping / X search
 * from Venice's own figure. Without it settle charges published rates.
 */
function readSurchargeEvidence(payload: unknown): SurchargeEvidence {
  if (!isRecord(payload)) return NO_SURCHARGE_EVIDENCE;
  const cost = payload.cost;
  let veniceCostMicroUsd: number | null = null;
  if (isRecord(cost) && (cost.usd !== undefined || cost.diem !== undefined)) {
    const usd = cost.usd ?? 0;
    const diem = cost.diem ?? 0;
    if (typeof usd === "number" && typeof diem === "number" && Number.isFinite(usd) && Number.isFinite(diem) && usd >= 0 && diem >= 0) {
      veniceCostMicroUsd = Math.round((usd + diem) * 1_000_000);
    }
  }
  const citations = isRecord(payload.venice_parameters) ? payload.venice_parameters.web_search_citations : undefined;
  return { veniceCostMicroUsd, webSearchCitations: Array.isArray(citations) ? citations.length : null };
}

function mergeSurchargeEvidence(seen: SurchargeEvidence, next: SurchargeEvidence): SurchargeEvidence {
  return {
    veniceCostMicroUsd: next.veniceCostMicroUsd ?? seen.veniceCostMicroUsd,
    webSearchCitations:
      seen.webSearchCitations === null && next.webSearchCitations === null
        ? null
        : Math.max(seen.webSearchCitations ?? 0, next.webSearchCitations ?? 0),
  };
}

function readSurchargeEvidenceFromSseFrame(frame: string): SurchargeEvidence {
  let evidence = NO_SURCHARGE_EVIDENCE;
  for (const line of frame.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      evidence = mergeSurchargeEvidence(evidence, readSurchargeEvidence(JSON.parse(data)));
    } catch {
      // non-JSON keep-alive / comment frame
    }
  }
  return evidence;
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
  let surchargeEvidence = NO_SURCHARGE_EVIDENCE;
  const readFrame = (frame: string) => {
    finalUsage = readUsageFromSseFrame(frame) ?? finalUsage;
    surchargeEvidence = mergeSurchargeEvidence(surchargeEvidence, readSurchargeEvidenceFromSseFrame(frame));
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() ?? "";
        for (const frame of frames) readFrame(frame);
      }
    }
    buffer += decoder.decode();
    if (buffer) readFrame(buffer);
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
    surchargeEvidence,
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
      body: JSON.stringify({ plaintextKey, body }),
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
      surchargeEvidence: readSurchargeEvidence(json),
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
