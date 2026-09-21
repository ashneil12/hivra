import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import { apiError } from "@/lib/api-response";
import { log } from "@/lib/logger";
import { verifyManagedVeniceProxyKey } from "@/lib/venice/proxy-keys";
import { resolveManagedVeniceUpstreamKey } from "@/lib/venice/upstream-keys";
import { recordManagedVeniceMultimodalUsage } from "@/lib/venice/proxy-settlement";

// SCRIPTURE_ANCHOR: venice-passthrough | John 14:6 | Verse: I am the way, the truth, and the life.
//
// Transparent passthrough for every Venice API path that doesn't have a
// bespoke route. The Hivra agent (and direct Venice) speak Venice's native
// API surface — singular paths like `POST /image/generate`, `POST /video/queue`,
// `POST /audio/retrieve`, `GET /image/styles`, `POST /crypto/rpc/{network}`.
// The earlier per-endpoint routes used OpenAI-style plural names (`images/...`,
// `videos/...`) and only covered a subset, so swapping VENICE_BASE_URL to the
// managed proxy 404'd the agent's calls (surfacing as "invalid JSON"). This
// catch-all forwards the exact path/method/body/query to Venice with the
// server key so `VENICE_BASE_URL=<managed proxy>` works "with no code change",
// as the agent plugins promise. The explicit routes (chat/completions,
// embeddings, models, audio/queue, audio/speech, audio/transcriptions) still
// win via Next's more-specific-route precedence and keep their bespoke metering.
const VENICE_API_BASE = "https://api.venice.ai/api/v1";

// Billing: most generation POSTs are attributed here (settled offline against
// Venice's invoice). These are NOT billed at this layer:
//   - audio/retrieve, audio/complete → music *polling/cleanup*; the generation
//     is already metered once at POST /audio/queue.
//   - audio/quote, video/quote → free price previews.
// All GET reads (models, image/styles, video|audio status polls,
// crypto/rpc/networks) are likewise never billed.
const NON_BILLABLE_POST_PATHS = new Set([
  "audio/retrieve",
  "audio/complete",
  "audio/quote",
  "video/quote",
]);

function readBearerKey(req: NextRequest) {
  const header = req.headers.get("authorization")?.trim() || "";
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

function unsupportedPath(message: string) {
  const response = apiError(message, 404);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

async function handle(req: NextRequest, segments: string[]) {
  const method = req.method.toUpperCase();

  // Path safety: the upstream host is fixed (no SSRF), but block traversal /
  // empty segments so a crafted path can't escape the /api/v1 namespace.
  if (!segments.length || segments.some((s) => !s || s === "." || s === ".." || /[/\\%]/.test(s))) {
    return unsupportedPath("Not found.");
  }
  const subPath = segments.join("/");
  // No alternate method, compaction or response-ID descendant may bypass the
  // dedicated Responses ownership/reservation/streaming contract.
  if (segments[0].toLowerCase() === "responses") return unsupportedPath("Responses operation not supported.");

  const plaintextKey = readBearerKey(req);
  if (!plaintextKey) return apiError("Unauthorized", 401);

  const verifiedKey = await verifyManagedVeniceProxyKey({ plaintextKey });
  if (!verifiedKey) return apiError("Unauthorized", 401);

  // Forward the raw body bytes so JSON *and* multipart/form-data (voice clone,
  // document parser) pass through with their boundaries intact. GET has none.
  const reqContentType = req.headers.get("content-type") || "";
  let bodyBuf: ArrayBuffer | undefined;
  let modelFromBody: string | null = null;
  if (method === "POST") {
    bodyBuf = await req.arrayBuffer();
    if (reqContentType.includes("application/json") && bodyBuf.byteLength) {
      const parsed = safeJsonParse(new TextDecoder().decode(bodyBuf));
      if (parsed && typeof parsed.model === "string") modelFromBody = parsed.model;
    }
  }

  const referenceId = randomUUID();
  const endpointLabel = `/api/v1/${subPath}`;
  const serverKey = resolveManagedVeniceUpstreamKey({
    referenceId,
    proxyKeyId: verifiedKey.id,
    model: modelFromBody,
    endpoint: endpointLabel,
  })?.key;
  if (!serverKey) {
    return apiError("Managed Venice is not configured.", 503, {
      failureType: "managed_venice_server_key_missing",
    });
  }

  let search = "";
  try {
    search = new URL(req.url).search;
  } catch {
    search = "";
  }
  const upstreamUrl = `${VENICE_API_BASE}/${subPath}${search}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${serverKey}`,
    Accept: req.headers.get("accept") || "application/json",
  };
  if (reqContentType) headers["Content-Type"] = reqContentType;

  const walletType = verifiedKey.defaultWalletType ?? "hermesos";

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method,
      headers,
      body: method === "POST" ? bodyBuf : undefined,
    });
  } catch (error) {
    return apiError(
      "Venice upstream request failed.",
      502,
      { failureType: "managed_venice_passthrough_upstream_fetch_failed" },
      undefined,
      { cause: error }
    );
  }

  const upstreamContentType =
    upstream.headers.get("content-type") || "application/json";
  // arrayBuffer keeps binary payloads (generated music/audio) byte-exact;
  // JSON is just bytes too, so this is safe for every response shape.
  const upstreamBuf = await upstream.arrayBuffer();

  const billable =
    method === "POST" && upstream.ok && !NON_BILLABLE_POST_PATHS.has(subPath);

  if (billable) {
    let upstreamRequestId: string | null = null;
    if (upstreamContentType.includes("application/json")) {
      const j = safeJsonParse(new TextDecoder().decode(upstreamBuf));
      if (j && typeof j.id === "string") upstreamRequestId = j.id;
      else if (j && typeof j.request_id === "string")
        upstreamRequestId = j.request_id as string;
    }
    try {
      await recordManagedVeniceMultimodalUsage({
        userId: verifiedKey.userId,
        proxyKeyId: verifiedKey.id,
        walletType,
        referenceId,
        endpoint: endpointLabel,
        model: modelFromBody || `passthrough:${subPath}`,
        upstreamStatus: upstream.status,
        upstreamRequestId,
        metadata: { method, path: subPath },
      });
    } catch (error) {
      // Never fail a successful generation on an audit-insert error — better to
      // under-bill one request than drop output we already paid Venice for.
      log.error("Managed Venice passthrough usage record failed", error, {
        source: "managed-venice-passthrough",
        route: endpointLabel,
        method,
        failureType: "managed_venice_passthrough_usage_record_failed",
        userId: verifiedKey.userId,
        proxyKeyId: verifiedKey.id,
        referenceId,
      });
    }
  } else if (!upstream.ok) {
    log.warn("Managed Venice passthrough upstream non-2xx", {
      source: "managed-venice-passthrough",
      route: endpointLabel,
      method,
      failureType: "managed_venice_passthrough_upstream_non_2xx",
      upstreamStatus: upstream.status,
      userId: verifiedKey.userId,
      proxyKeyId: verifiedKey.id,
    });
  }

  return new Response(upstreamBuf, {
    status: upstream.status,
    headers: { "Content-Type": upstreamContentType },
  });
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> }
) {
  const { path } = await ctx.params;
  return handle(req, path || []);
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> }
) {
  const { path } = await ctx.params;
  return handle(req, path || []);
}
